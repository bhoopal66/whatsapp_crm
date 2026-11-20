-- ============================================================
-- 212_hr_automsg_delivery.sql — HR automated messages: terminal send
-- failures and delivery state.
--
-- Ported from package 029a/029b onto 203's outbox. The package's text
-- workspace ids, provider_id column, actor argument ('system:hr') and
-- hr_automsg_audit_write are gone: rows are matched by account_id and
-- provider_message_id, the caller is the service role (the grants are
-- the actor check), and the audit row goes through 203's hr_automsg_log.
--
--   1. hr_automsg_fail_terminal(id, reason): a non-retryable provider
--      failure (invalid number, unapproved template, an undeliverable
--      status) marks the row failed with attempts = 3. That is 203's
--      cap: hr_automsg_due and hr_automsg_claim need attempts < 3, so no
--      drain ever retries it. It writes an 'outbox_failed_terminal'
--      audit row carrying the reason (a short code, never a secret) and
--      the attempts before. A cancelled row is final, and so is a row
--      the provider may already hold (status 'sent', or a claim parked
--      'unconfirmed' / 'needs_review'): ALREADY_DECIDED, unless its
--      delivery_state is 'failed', which is the provider telling us it
--      accepted the send but could not deliver it.
--   2. hr_automsg_outbox.delivery_state (NULL = no status seen | sent |
--      delivered | read | failed) and delivery_at, written only by
--      hr_automsg_delivery_record: one WhatsApp statuses[] item, matched
--      by provider_message_id within the account (newest row wins).
--      Forward-only: sent < delivered < read, a lower or equal rank
--      never overwrites a higher one, nothing overwrites 'failed', and
--      'failed' applies only while the state is NULL or 'sent'. An
--      applied 'failed' marks the row terminal through (1), reason
--      'delivery_failed:<code>', unless it already is.
--
--   3. A receipt that beats the stamp: send.ts inserts the chat's
--      messages row before hr_automsg_mark stamps provider_message_id on
--      the outbox row, so a status landing in between finds no row
--      ('unknown_message') while messages.status still takes it (the
--      broadcast race 066 fixed). The hr_automsg_outbox_catch_receipt
--      trigger replays it: when a row moves to 'sent' carrying both ids,
--      a delivered / read / failed messages row is recorded through (2).
--      It never raises. It cannot recurse: (1) and (2) never move status
--      to 'sent'.
--   4. hr_automsg_fail_terminal on a row already failed with attempts
--      >= 3 returns it unchanged (no second audit row, reason kept), and
--      delivery_at is clamped to at most now() + 1 minute.
--   5. hr_automsg_expire (203) is restated so it no longer cancels a
--      terminal failure (failed, attempts >= 3), which would lose its
--      reason. Re-running 203 after 212 reverts it: apply in order, once.
--
-- Refusals through 200's hr_refuse: INVALID | ALREADY_DECIDED (22023),
-- NOT_FOUND (P0002). Service role only. Apply after 203. Re-runnable.
-- No BEGIN/COMMIT. Must be applied by a superuser or BYPASSRLS role
-- (the refusal below runs before any DDL).
-- ============================================================

-- hr_automsg_outbox is RLS-forced with no policies, so the SECURITY
-- DEFINER functions below read and write it only when owned by a role
-- that bypasses RLS.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '212 must be applied by a superuser or BYPASSRLS role (the automated-message functions read RLS-forced tables)';
  END IF;
END $$;

SET lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. Columns and index
-- ------------------------------------------------------------

ALTER TABLE public.hr_automsg_outbox ADD COLUMN IF NOT EXISTS delivery_state text NULL;
ALTER TABLE public.hr_automsg_outbox ADD COLUMN IF NOT EXISTS delivery_at timestamptz NULL;
ALTER TABLE public.hr_automsg_outbox DROP CONSTRAINT IF EXISTS hr_automsg_outbox_delivery_state_check;
ALTER TABLE public.hr_automsg_outbox ADD CONSTRAINT hr_automsg_outbox_delivery_state_check
  CHECK (delivery_state IS NULL OR delivery_state IN ('sent', 'delivered', 'read', 'failed'));

CREATE INDEX IF NOT EXISTS hr_automsg_outbox_provider_idx
  ON public.hr_automsg_outbox (account_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- ------------------------------------------------------------
-- 2. Terminal failure
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.hr_automsg_fail_terminal(p_id uuid, p_reason text)
RETURNS public.hr_automsg_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  o hr_automsg_outbox;
BEGIN
  IF p_reason IS NULL OR p_reason ~ '^[[:space:]]*$' OR char_length(p_reason) > 200 THEN
    PERFORM hr_refuse('INVALID', 'a reason of 1 to 200 characters is required');
  END IF;
  SELECT * INTO o FROM hr_automsg_outbox x WHERE x.id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM hr_refuse('NOT_FOUND', 'message not found'); END IF;
  -- Already terminal: idempotent, the first reason stands.
  IF o.status = 'failed' AND o.attempts >= 3 THEN RETURN o; END IF;
  IF o.status = 'cancelled'
     OR ((o.status = 'sent' OR o.claim_state IN ('unconfirmed', 'needs_review'))
         AND o.delivery_state IS DISTINCT FROM 'failed') THEN
    PERFORM hr_refuse('ALREADY_DECIDED',
      format('cannot fail a %s message (claim %s)', o.status, COALESCE(o.claim_state, 'none')));
  END IF;
  PERFORM hr_automsg_log(o.account_id, 'outbox_failed_terminal',
    jsonb_build_object('id', o.id, 'reason', p_reason, 'attempts', o.attempts));
  UPDATE hr_automsg_outbox x
     SET status = 'failed', hold_reason = NULL, attempts = 3, claim_state = NULL,
         last_error = p_reason, updated_at = now()
   WHERE x.id = o.id RETURNING * INTO o;
  RETURN o;
END;
$$;

-- ------------------------------------------------------------
-- 3. Delivery state
-- ------------------------------------------------------------

-- 'recorded' | 'unchanged' | 'failed_terminal' | 'unknown_message' (no
-- row of the account has that provider id; not an error). p_reason is
-- the provider's error code of a failed status, NULL otherwise.
CREATE OR REPLACE FUNCTION public.hr_automsg_delivery_record(
  p_account_id uuid, p_provider_message_id text, p_state text,
  p_at timestamptz, p_reason text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  o hr_automsg_outbox;
  v_code text;
  v_rank_new integer;
  v_rank_old integer;
BEGIN
  IF p_state IS NULL OR p_state NOT IN ('sent', 'delivered', 'read', 'failed') THEN
    PERFORM hr_refuse('INVALID', 'unknown delivery state');
  END IF;
  IF p_provider_message_id IS NULL OR p_provider_message_id ~ '^[[:space:]]*$' THEN
    PERFORM hr_refuse('INVALID', 'a provider message id is required');
  END IF;
  SELECT * INTO o FROM hr_automsg_outbox x
   WHERE x.account_id = p_account_id AND x.provider_message_id = p_provider_message_id
   ORDER BY x.created_at DESC, x.id DESC
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN RETURN 'unknown_message'; END IF;

  -- Nothing overwrites 'failed'.
  IF o.delivery_state = 'failed' THEN RETURN 'unchanged'; END IF;

  IF p_state = 'failed' THEN
    IF o.delivery_state IS NOT NULL AND o.delivery_state <> 'sent' THEN RETURN 'unchanged'; END IF;
    UPDATE hr_automsg_outbox x SET delivery_state = 'failed', delivery_at = LEAST(COALESCE(p_at, now()), now() + interval '1 minute')
     WHERE x.id = o.id;
    IF o.status = 'cancelled' OR (o.status = 'failed' AND o.attempts >= 3) THEN
      RETURN 'recorded';
    END IF;
    v_code := left(regexp_replace(COALESCE(p_reason, ''), '[^A-Za-z0-9_.:-]', '', 'g'), 60);
    PERFORM hr_automsg_fail_terminal(o.id,
      'delivery_failed:' || CASE WHEN v_code = '' THEN 'unknown' ELSE v_code END);
    RETURN 'failed_terminal';
  END IF;

  v_rank_new := CASE p_state WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 ELSE 3 END;
  v_rank_old := CASE o.delivery_state WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 0 END;
  IF v_rank_new <= v_rank_old THEN RETURN 'unchanged'; END IF;
  UPDATE hr_automsg_outbox x SET delivery_state = p_state, delivery_at = LEAST(COALESCE(p_at, now()), now() + interval '1 minute')
   WHERE x.id = o.id;
  RETURN 'recorded';
END;
$$;

-- ------------------------------------------------------------
-- 4. A receipt that beat the stamp
-- ------------------------------------------------------------

-- Only receipts move a messages row to delivered / read / failed
-- (001's CHECK: sending | sent | delivered | read | failed), so one of
-- those on the row the send wrote is a status the outbox row missed.
CREATE OR REPLACE FUNCTION public.hr_automsg_outbox_catch_receipt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status text;
BEGIN
  BEGIN
    SELECT m.status INTO v_status FROM messages m WHERE m.id = NEW.message_id;
    IF v_status IN ('delivered', 'read', 'failed') THEN
      PERFORM hr_automsg_delivery_record(NEW.account_id, NEW.provider_message_id,
                                         v_status, now(), NULL);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'hr_automsg_outbox_catch_receipt(%): % %', NEW.id, SQLSTATE, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS hr_automsg_outbox_catch_receipt ON public.hr_automsg_outbox;
CREATE TRIGGER hr_automsg_outbox_catch_receipt
  AFTER UPDATE OF status ON public.hr_automsg_outbox
  FOR EACH ROW
  WHEN (NEW.status = 'sent' AND OLD.status IS DISTINCT FROM 'sent'
        AND NEW.message_id IS NOT NULL AND NEW.provider_message_id IS NOT NULL)
  EXECUTE FUNCTION public.hr_automsg_outbox_catch_receipt();

REVOKE ALL ON FUNCTION public.hr_automsg_outbox_catch_receipt()
  FROM PUBLIC, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 5. Expiry keeps terminal failures (restates 203's function)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.hr_automsg_expire(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  UPDATE hr_automsg_outbox x
     SET status = 'cancelled', hold_reason = NULL, updated_at = now()
   WHERE x.status IN ('queued', 'held', 'failed') AND x.claim_state IS NULL
     AND (x.status <> 'failed' OR x.attempts < 3)
     AND x.created_at < COALESCE(p_now, now()) - interval '24 hours';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- ------------------------------------------------------------
-- 6. Grants: the service-role sender only
-- ------------------------------------------------------------

REVOKE ALL ON FUNCTION
  public.hr_automsg_fail_terminal(uuid, text),
  public.hr_automsg_delivery_record(uuid, text, text, timestamptz, text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.hr_automsg_fail_terminal(uuid, text),
  public.hr_automsg_delivery_record(uuid, text, text, timestamptz, text)
  TO service_role;
