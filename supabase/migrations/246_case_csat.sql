-- ============================================================
-- 246_case_csat.sql — customer satisfaction (CSAT) for cases: one
-- rating request (1-5, optional comment) when a case is submitted and
-- one when it is approved, sent from the customer's company chat's own
-- number, and the reply captured from the inbound pipeline.
--
-- OFF BY DEFAULT (case_csat_settings, no row = off). docs/case-csat.md is
-- the contract.
--
--  * When (case_csat_on_stage_history, AFTER INSERT on 122's
--    case_stage_history, like 124's case_stage_history_sla): a history
--    row that takes the case out of the pre-submission stages (130) to a
--    stage that is not final is 'submitted' (the first stage after the
--    pre-submission ones in any bank's list); a row to 'Approved', or
--    with outcome 'Approved', is 'approved' (case_csat_trigger_for). One
--    request per case per trigger (UNIQUE (case_id, trigger)); only
--    while the workspace has CSAT on and that trigger switched on. The
--    trigger NEVER fails the stage write: any error is a WARNING.
--  * Recipient: the case's contact (cases.contact_id) and their newest
--    company chat (never a personal one, 191). No contact or chat, or a
--    contact opted out (076) or do-not-contact (086): the row is written
--    'skipped' with a reason, so the case is not asked later either.
--  * Claim (case_csat_claim, automations cron): re-checks the switch,
--    the trigger's switch, opt-out and do-not-contact, the chat; sends
--    only between the workspace's send hours (default 09:00-20:00
--    Dubai), at most one CSAT request per person per 24 hours (an
--    advisory lock per contact serialises claimers), and gives up on a
--    request not sent within 3 days ('cancelled' / 'expired'). A claim
--    with no result for 10 minutes is 'unconfirmed' and never resent.
--  * Held: the sender (TypeScript) marks 'held' a request it did not
--    send because the Meta number is outside the customer's 24-hour
--    window and the workspace has no approved utility template for it
--    (one per trigger; {{1}} = first name, {{2}} = bank and product)
--    (reason 'awaiting_template'). Retried hourly until it expires.
--    Nothing reached the gateway, so this is not a failure.
--  * Reply (case_csat_capture, inbound pipeline): the newest request
--    sent (or unconfirmed) to the contact within reply_window_days
--    (default 7) and not yet answered takes the score; a request is
--    answered at most once (UNIQUE request_id).
--  * Reads: case_csat_for_case (a reader of the case, 122's
--    case_can_read) and case_csat_scores (rows of cases the actor can
--    read, for the per-agent / per-bank averages).
--  * The Compass lock (134, case_managed_externally) is not consulted:
--    it refuses PEOPLE changing a case; CSAT changes nothing on the case.
--  * Not counted in the shared daily cap of HR automated messages (203)
--    and desk digests (234), whose claims are not restated here.
--
-- Refusals (HINT): INVALID, NOT_ALLOWED, STALE.
--
-- PRIVILEGES: SECURITY DEFINER, search_path '', service_role only; the
-- tables force RLS with no policy and no grants. Apply as a superuser or
-- BYPASSRLS role after 234. Re-runnable. Asserted by
-- supabase/ci/verify-case-csat.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '246 must be applied by a superuser or BYPASSRLS role (the CSAT functions read RLS-forced tables)';
  END IF;
  IF to_regprocedure('public.case_stage_is_presub(text)') IS NULL THEN
    RAISE EXCEPTION '246: apply 130_case_leads.sql first';
  END IF;
  IF to_regclass('public.privacy_extensions') IS NULL THEN
    RAISE EXCEPTION '246: apply 229_desk_customer_contacts.sql first';
  END IF;
END $$;

-- ---------- 1. Tables ----------

CREATE TABLE IF NOT EXISTS public.case_csat_settings (
  account_id         uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  enabled            boolean NOT NULL DEFAULT false,
  ask_on_submitted   boolean NOT NULL DEFAULT true,
  ask_on_approved    boolean NOT NULL DEFAULT true,
  template_submitted text NOT NULL DEFAULT 'case_csat_submitted',
  template_approved  text NOT NULL DEFAULT 'case_csat_approved',
  language           text NOT NULL DEFAULT 'en',
  reply_window_days  integer NOT NULL DEFAULT 7,
  send_start_hour    integer NOT NULL DEFAULT 9,
  send_end_hour      integer NOT NULL DEFAULT 20,
  updated_by         uuid NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_csat_settings_template_check
    CHECK (template_submitted ~ '^[a-z0-9_]{1,100}$' AND template_approved ~ '^[a-z0-9_]{1,100}$'),
  CONSTRAINT case_csat_settings_language_check CHECK (language ~ '^[a-z]{2}(_[A-Z]{2})?$'),
  CONSTRAINT case_csat_settings_window_check CHECK (reply_window_days BETWEEN 1 AND 30),
  CONSTRAINT case_csat_settings_hours_check
    CHECK (send_start_hour BETWEEN 8 AND 20 AND send_end_hour BETWEEN 9 AND 21 AND send_start_hour < send_end_hour)
);
ALTER TABLE public.case_csat_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_csat_settings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.case_csat_settings FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON TABLE public.case_csat_settings IS
  'Case CSAT per workspace: off by default; which triggers ask; the Meta template per trigger; reply window; send hours (Dubai). Migration 246.';

CREATE TABLE IF NOT EXISTS public.case_csat_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL,
  case_id              uuid NOT NULL,
  trigger              text NOT NULL,
  contact_id           uuid NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  conversation_id      uuid NULL REFERENCES public.conversations(id) ON DELETE SET NULL,
  agent_id             uuid NULL,
  bank_code            text NULL,
  stage                text NOT NULL,
  status               text NOT NULL DEFAULT 'queued',
  status_reason        text NULL,
  attempts             integer NOT NULL DEFAULT 0,
  next_attempt_at      timestamptz NULL,
  claimed_at           timestamptz NULL,
  sent_at              timestamptz NULL,
  sent_via             text NULL,
  provider_message_id  text NULL,
  message_id           uuid NULL,
  answered_at          timestamptz NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_csat_requests_case_fkey FOREIGN KEY (case_id, account_id)
    REFERENCES public.cases (id, account_id) ON DELETE CASCADE,
  CONSTRAINT case_csat_requests_once UNIQUE (case_id, trigger),
  CONSTRAINT case_csat_requests_trigger_check CHECK (trigger IN ('submitted', 'approved')),
  CONSTRAINT case_csat_requests_status_check
    CHECK (status IN ('queued', 'held', 'sending', 'sent', 'failed', 'cancelled', 'unconfirmed', 'skipped')),
  CONSTRAINT case_csat_requests_via_check CHECK (sent_via IS NULL OR sent_via IN ('template', 'text')),
  CONSTRAINT case_csat_requests_reason_check CHECK (status_reason IS NULL OR char_length(status_reason) <= 200)
);
CREATE INDEX IF NOT EXISTS case_csat_requests_queue_idx ON public.case_csat_requests (status, created_at)
  WHERE status IN ('queued', 'held', 'sending');
-- The inbound capture's one read: an open request for this contact.
CREATE INDEX IF NOT EXISTS case_csat_requests_open_idx ON public.case_csat_requests (contact_id, sent_at)
  WHERE answered_at IS NULL AND status IN ('sent', 'unconfirmed');
CREATE INDEX IF NOT EXISTS case_csat_requests_case_idx ON public.case_csat_requests (case_id);
ALTER TABLE public.case_csat_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_csat_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.case_csat_requests FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON TABLE public.case_csat_requests IS
  'Case CSAT rating requests: one per case per trigger; guarded again at claim; never resent once unconfirmed. Migration 246.';

CREATE TABLE IF NOT EXISTS public.case_csat_responses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL,
  case_id       uuid NOT NULL,
  request_id    uuid NOT NULL REFERENCES public.case_csat_requests(id) ON DELETE CASCADE,
  trigger       text NOT NULL,
  contact_id    uuid NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  agent_id      uuid NULL,
  bank_code     text NULL,
  score         smallint NOT NULL,
  comment       text NULL,
  message_id    uuid NULL,
  responded_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_csat_responses_case_fkey FOREIGN KEY (case_id, account_id)
    REFERENCES public.cases (id, account_id) ON DELETE CASCADE,
  CONSTRAINT case_csat_responses_once UNIQUE (request_id),
  CONSTRAINT case_csat_responses_trigger_check CHECK (trigger IN ('submitted', 'approved')),
  CONSTRAINT case_csat_responses_score_check CHECK (score BETWEEN 1 AND 5),
  CONSTRAINT case_csat_responses_comment_check
    CHECK (comment IS NULL OR (char_length(comment) BETWEEN 1 AND 1000 AND comment !~ '^[[:space:]]*$'))
);
CREATE INDEX IF NOT EXISTS case_csat_responses_account_idx ON public.case_csat_responses (account_id, responded_at);
CREATE INDEX IF NOT EXISTS case_csat_responses_case_idx ON public.case_csat_responses (case_id);
ALTER TABLE public.case_csat_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_csat_responses FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.case_csat_responses FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON TABLE public.case_csat_responses IS
  'Case CSAT ratings: a 1-5 score and optional comment, at most one per request. Migration 246.';

-- ---------- 2. Settings ----------

CREATE OR REPLACE FUNCTION public.case_csat_settings_get(p_actor uuid, p_account uuid)
RETURNS TABLE (enabled boolean, ask_on_submitted boolean, ask_on_approved boolean, template_submitted text,
               template_approved text, language text, reply_window_days integer, send_start_hour integer, send_end_hour integer,
               updated_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF public.case_account_role(p_account, p_actor) IS NULL THEN
    RAISE EXCEPTION 'case_csat_settings_get: staff only' USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  RETURN QUERY
  SELECT coalesce(s.enabled, false), coalesce(s.ask_on_submitted, true), coalesce(s.ask_on_approved, true),
         coalesce(s.template_submitted, 'case_csat_submitted'), coalesce(s.template_approved, 'case_csat_approved'),
         coalesce(s.language, 'en'),
         coalesce(s.reply_window_days, 7), coalesce(s.send_start_hour, 9), coalesce(s.send_end_hour, 20),
         s.updated_at
    FROM (SELECT 1) one LEFT JOIN public.case_csat_settings s ON s.account_id = p_account;
END;
$$;

-- Version-checked: p_expected is the updated_at the editor read (NULL for
-- a workspace that never saved); a different stored value is STALE.
CREATE OR REPLACE FUNCTION public.case_csat_settings_set(p_actor uuid, p_account uuid, p_enabled boolean,
  p_ask_on_submitted boolean, p_ask_on_approved boolean, p_template_submitted text, p_template_approved text,
  p_language text,
  p_reply_window_days integer, p_send_start_hour integer, p_send_end_hour integer,
  p_expected timestamptz, p_now timestamptz DEFAULT NULL)
RETURNS timestamptz
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_sub   text := lower(btrim(coalesce(p_template_submitted, '')));
  v_app   text := lower(btrim(coalesce(p_template_approved, '')));
  v_now   timestamptz := coalesce(p_now, clock_timestamp());
  v_cur   timestamptz;
BEGIN
  IF coalesce(public.case_account_role(p_account, p_actor) IN ('admin', 'super_admin'), false) IS NOT TRUE THEN
    RAISE EXCEPTION 'case_csat_settings_set: owners and admins only'
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  IF p_enabled IS NULL OR p_ask_on_submitted IS NULL OR p_ask_on_approved IS NULL
     OR v_sub !~ '^[a-z0-9_]{1,100}$' OR v_app !~ '^[a-z0-9_]{1,100}$'
     OR coalesce(p_language, '') !~ '^[a-z]{2}(_[A-Z]{2})?$'
     OR p_reply_window_days IS NULL OR p_reply_window_days NOT BETWEEN 1 AND 30
     OR p_send_start_hour IS NULL OR p_send_start_hour NOT BETWEEN 8 AND 20
     OR p_send_end_hour IS NULL OR p_send_end_hour NOT BETWEEN 9 AND 21
     OR p_send_start_hour >= p_send_end_hour THEN
    RAISE EXCEPTION 'case_csat_settings_set: template name a-z 0-9 _, a language code, window 1-30 days, hours 8-21'
      USING ERRCODE = 'check_violation', HINT = 'INVALID';
  END IF;
  SELECT s.updated_at INTO v_cur FROM public.case_csat_settings s WHERE s.account_id = p_account FOR UPDATE;
  IF v_cur IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'case_csat_settings_set: the settings changed since they were read'
      USING ERRCODE = 'serialization_failure', HINT = 'STALE';
  END IF;
  INSERT INTO public.case_csat_settings AS s (account_id, enabled, ask_on_submitted, ask_on_approved, template_submitted,
                                             template_approved, language, reply_window_days, send_start_hour, send_end_hour,
                                             updated_by, updated_at)
  VALUES (p_account, p_enabled, p_ask_on_submitted, p_ask_on_approved, v_sub, v_app, p_language, p_reply_window_days,
          p_send_start_hour, p_send_end_hour, p_actor, v_now)
  ON CONFLICT (account_id) DO UPDATE
     SET enabled = excluded.enabled, ask_on_submitted = excluded.ask_on_submitted,
         ask_on_approved = excluded.ask_on_approved, template_submitted = excluded.template_submitted,
         template_approved = excluded.template_approved,
         language = excluded.language, reply_window_days = excluded.reply_window_days,
         send_start_hour = excluded.send_start_hour, send_end_hour = excluded.send_end_hour,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  -- Switching off (or a trigger off) cancels what is still waiting.
  UPDATE public.case_csat_requests r SET status = 'cancelled', status_reason = 'switched_off'
   WHERE r.account_id = p_account AND r.status IN ('queued', 'held')
     AND (NOT p_enabled
          OR (r.trigger = 'submitted' AND NOT p_ask_on_submitted)
          OR (r.trigger = 'approved' AND NOT p_ask_on_approved));
  RETURN v_now;
END;
$$;

-- ---------- 3. When to ask ----------

-- 'submitted' when a stage write takes a case out of the pre-submission
-- stages to a stage that is not final; 'approved' on Approved. Mirrored
-- by csatTriggerFor (src/lib/cases/csat.ts).
CREATE OR REPLACE FUNCTION public.case_csat_trigger_for(p_from text, p_to text, p_outcome text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
           WHEN p_to = 'Approved' OR p_outcome = 'Approved' THEN 'approved'
           WHEN p_to IS NOT NULL AND NOT public.case_stage_is_presub(p_to)
                AND p_to NOT IN ('Approved', 'Declined', 'Withdrawn', 'Closed')
                AND (p_from IS NULL OR public.case_stage_is_presub(p_from)) THEN 'submitted'
         END
$$;

CREATE OR REPLACE FUNCTION public.case_csat_on_stage_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  s       public.case_csat_settings%ROWTYPE;
  k       public.cases%ROWTYPE;
  v_kind  text;
  v_conv  uuid;
  v_why   text;
BEGIN
  -- The one read for a workspace with CSAT off.
  SELECT * INTO s FROM public.case_csat_settings x WHERE x.account_id = NEW.account_id AND x.enabled;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  BEGIN
    v_kind := public.case_csat_trigger_for(NEW.from_stage, NEW.to_stage, NEW.outcome);
    IF v_kind IS NULL
       OR (v_kind = 'submitted' AND NOT s.ask_on_submitted)
       OR (v_kind = 'approved' AND NOT s.ask_on_approved) THEN
      RETURN NULL;
    END IF;
    SELECT * INTO k FROM public.cases x WHERE x.id = NEW.case_id AND x.account_id = NEW.account_id;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    IF k.contact_id IS NULL THEN
      v_why := 'no_contact';
    ELSIF EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = k.contact_id
                     AND (c.opted_out_at IS NOT NULL OR c.do_not_contact_at IS NOT NULL)) THEN
      v_why := 'opted_out';
    ELSE
      SELECT v.id INTO v_conv FROM public.conversations v
       WHERE v.account_id = k.account_id AND v.contact_id = k.contact_id AND v.personal_owner_id IS NULL
       ORDER BY v.last_message_at DESC NULLS LAST, v.created_at DESC
       LIMIT 1;
      IF v_conv IS NULL THEN
        v_why := 'no_chat';
      END IF;
    END IF;
    INSERT INTO public.case_csat_requests AS r (account_id, case_id, trigger, contact_id, conversation_id, agent_id,
                                                bank_code, stage, status, status_reason, created_at)
    VALUES (k.account_id, k.id, v_kind, k.contact_id, v_conv, k.agent_id, k.bank_code, NEW.to_stage,
            CASE WHEN v_why IS NULL THEN 'queued' ELSE 'skipped' END, v_why, NEW.changed_at)
    ON CONFLICT ON CONSTRAINT case_csat_requests_once DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    -- Never fail the stage write over a rating request.
    RAISE WARNING 'case_csat_on_stage_history: % (%)', SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS case_stage_history_csat ON public.case_stage_history;
CREATE TRIGGER case_stage_history_csat
  AFTER INSERT ON public.case_stage_history
  FOR EACH ROW EXECUTE FUNCTION public.case_csat_on_stage_history();

-- ---------- 4. Claim, guarded again; mark ----------

CREATE OR REPLACE FUNCTION public.case_csat_claim(p_now timestamptz DEFAULT NULL, p_limit integer DEFAULT 50)
RETURNS TABLE (id uuid, account_id uuid, case_id uuid, trigger text, contact_id uuid, conversation_id uuid,
               contact_name text, bank_name text, product text, template_name text, language text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_now   timestamptz := coalesce(p_now, now());
  v_hour  integer := extract(hour FROM v_now AT TIME ZONE 'Asia/Dubai')::integer;
  o       public.case_csat_requests%ROWTYPE;
  s       public.case_csat_settings%ROWTYPE;
  ct      public.contacts%ROWTYPE;
  v_bank  text;
  v_prod  text;
  v_n     integer := 0;
  v_max   integer := least(greatest(coalesce(p_limit, 50), 1), 200);
BEGIN
  -- A claim with no result for 10 minutes may have reached the gateway:
  -- never resent.
  UPDATE public.case_csat_requests x SET status = 'unconfirmed'
   WHERE x.status = 'sending' AND x.claimed_at < v_now - interval '10 minutes';
  -- Not sent within 3 days: too late to ask.
  UPDATE public.case_csat_requests x SET status = 'cancelled', status_reason = 'expired'
   WHERE x.status IN ('queued', 'held') AND x.created_at < v_now - interval '3 days';

  IF v_hour < 8 OR v_hour >= 21 THEN
    RETURN;  -- quiet hours everywhere: nothing leaves, the rows wait
  END IF;

  FOR o IN SELECT * FROM public.case_csat_requests x
            WHERE x.status = 'queued' OR (x.status = 'held' AND coalesce(x.next_attempt_at, x.created_at) <= v_now)
            ORDER BY x.created_at
            LIMIT 500
            FOR UPDATE SKIP LOCKED LOOP
    EXIT WHEN v_n >= v_max;
    SELECT * INTO s FROM public.case_csat_settings x WHERE x.account_id = o.account_id;
    IF NOT coalesce(s.enabled, false)
       OR (o.trigger = 'submitted' AND NOT s.ask_on_submitted)
       OR (o.trigger = 'approved' AND NOT s.ask_on_approved) THEN
      UPDATE public.case_csat_requests x SET status = 'cancelled', status_reason = 'switched_off' WHERE x.id = o.id;
      CONTINUE;
    END IF;
    -- The workspace's own send hours (Dubai): the row waits.
    CONTINUE WHEN v_hour < s.send_start_hour OR v_hour >= s.send_end_hour;
    IF o.contact_id IS NULL OR o.conversation_id IS NULL THEN
      UPDATE public.case_csat_requests x SET status = 'cancelled', status_reason = 'no_chat' WHERE x.id = o.id;
      CONTINUE;
    END IF;
    -- One claimer per person at a time: the per-person count below holds.
    PERFORM pg_advisory_xact_lock(hashtextextended('case_csat:' || o.contact_id::text, 0));
    SELECT * INTO ct FROM public.contacts x WHERE x.id = o.contact_id;
    IF NOT FOUND OR ct.opted_out_at IS NOT NULL OR ct.do_not_contact_at IS NOT NULL THEN
      UPDATE public.case_csat_requests x SET status = 'cancelled', status_reason = 'opted_out' WHERE x.id = o.id;
      CONTINUE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.conversations v
                    WHERE v.id = o.conversation_id AND v.account_id = o.account_id
                      AND v.contact_id = o.contact_id AND v.personal_owner_id IS NULL) THEN
      UPDATE public.case_csat_requests x SET status = 'cancelled', status_reason = 'no_chat' WHERE x.id = o.id;
      CONTINUE;
    END IF;
    -- At most one rating request per person per 24 hours: the row waits.
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.case_csat_requests d
                           WHERE d.contact_id = o.contact_id AND d.id <> o.id
                             AND d.status IN ('sending', 'sent', 'unconfirmed')
                             AND d.claimed_at > v_now - interval '24 hours');
    SELECT b.name INTO v_bank FROM public.case_banks b WHERE b.account_id = o.account_id AND b.code = o.bank_code;
    SELECT k.product INTO v_prod FROM public.cases k WHERE k.id = o.case_id;
    UPDATE public.case_csat_requests x
       SET status = 'sending', attempts = x.attempts + 1, claimed_at = v_now, status_reason = NULL
     WHERE x.id = o.id;
    v_n := v_n + 1;
    RETURN QUERY SELECT o.id, o.account_id, o.case_id, o.trigger, o.contact_id, o.conversation_id,
                        ct.name, coalesce(v_bank, o.bank_code), v_prod,
                        CASE o.trigger WHEN 'approved' THEN s.template_approved ELSE s.template_submitted END,
                        s.language;
  END LOOP;
END;
$$;

-- sent | failed | held (not sent: retried in an hour, reason e.g.
-- 'awaiting_template'). Only a row still 'sending' is marked.
CREATE OR REPLACE FUNCTION public.case_csat_mark(p_id uuid, p_outcome text, p_via text, p_provider_message_id text,
  p_message_id uuid, p_reason text, p_now timestamptz DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := coalesce(p_now, now());
  v_n   integer;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('sent', 'failed', 'held')
     OR (p_outcome = 'sent' AND coalesce(p_via, '') NOT IN ('template', 'text')) THEN
    RAISE EXCEPTION 'case_csat_mark: outcome is sent (with a via), failed or held'
      USING ERRCODE = 'check_violation', HINT = 'INVALID';
  END IF;
  UPDATE public.case_csat_requests x
     SET status = p_outcome,
         sent_at = CASE WHEN p_outcome = 'sent' THEN v_now END,
         sent_via = CASE WHEN p_outcome = 'sent' THEN p_via END,
         next_attempt_at = CASE WHEN p_outcome = 'held' THEN v_now + interval '1 hour' END,
         provider_message_id = p_provider_message_id, message_id = p_message_id,
         status_reason = left(nullif(btrim(regexp_replace(coalesce(p_reason, ''), '[^a-z0-9_]', '', 'g')), ''), 200)
   WHERE x.id = p_id AND x.status = 'sending';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$$;

-- ---------- 5. Reply ----------

-- The inbound pipeline has already parsed a 1-5 reply. The newest
-- request sent to this contact within the reply window and not yet
-- answered takes it; at most once per request. False when CSAT is off
-- or no request is open.
CREATE OR REPLACE FUNCTION public.case_csat_capture(p_account uuid, p_contact uuid, p_message uuid, p_score integer,
  p_comment text, p_now timestamptz DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now     timestamptz := coalesce(p_now, now());
  v_window  integer;
  q         public.case_csat_requests%ROWTYPE;
  v_comment text := nullif(btrim(left(coalesce(p_comment, ''), 1000)), '');
  v_id      uuid;
BEGIN
  IF p_score IS NULL OR p_score NOT BETWEEN 1 AND 5 OR p_account IS NULL OR p_contact IS NULL THEN
    RETURN false;
  END IF;
  SELECT s.reply_window_days INTO v_window FROM public.case_csat_settings s
   WHERE s.account_id = p_account AND s.enabled;
  IF v_window IS NULL THEN
    RETURN false;
  END IF;
  IF v_comment ~ '^[[:space:]]*$' THEN
    v_comment := NULL;
  END IF;
  SELECT * INTO q FROM public.case_csat_requests r
   WHERE r.contact_id = p_contact AND r.account_id = p_account
     AND r.answered_at IS NULL AND r.status IN ('sent', 'unconfirmed')
     AND coalesce(r.sent_at, r.claimed_at) <= v_now
     AND coalesce(r.sent_at, r.claimed_at) > v_now - make_interval(days => v_window)
   ORDER BY coalesce(r.sent_at, r.claimed_at) DESC
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO public.case_csat_responses AS x (account_id, case_id, request_id, trigger, contact_id, agent_id,
                                               bank_code, score, comment, message_id, responded_at)
  VALUES (q.account_id, q.case_id, q.id, q.trigger, q.contact_id, q.agent_id, q.bank_code, p_score::smallint,
          v_comment, p_message, v_now)
  ON CONFLICT ON CONSTRAINT case_csat_responses_once DO NOTHING
  RETURNING x.id INTO v_id;
  UPDATE public.case_csat_requests r SET answered_at = v_now WHERE r.id = q.id AND r.answered_at IS NULL;
  RETURN v_id IS NOT NULL;
END;
$$;

-- ---------- 6. Reads ----------

-- A reader of the case: its requests and any rating.
CREATE OR REPLACE FUNCTION public.case_csat_for_case(p_actor uuid, p_case uuid)
RETURNS TABLE (trigger text, status text, sent_at timestamptz, score smallint, comment text,
               responded_at timestamptz, created_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF NOT coalesce(public.case_can_read(p_case, p_actor), false) THEN
    RAISE EXCEPTION 'case_csat_for_case: not a reader of this case'
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  RETURN QUERY
  SELECT r.trigger, r.status, r.sent_at, x.score, x.comment, x.responded_at, r.created_at
    FROM public.case_csat_requests r
    LEFT JOIN public.case_csat_responses x ON x.request_id = r.id
   WHERE r.case_id = p_case
   ORDER BY r.created_at;
END;
$$;

-- Ratings since p_since on cases the actor can read (asked once per
-- distinct case), for the per-agent and per-bank averages.
CREATE OR REPLACE FUNCTION public.case_csat_scores(p_actor uuid, p_account uuid, p_since timestamptz)
RETURNS TABLE (case_id uuid, trigger text, agent_id uuid, bank_code text, bank_name text, score smallint,
               responded_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF public.case_account_role(p_account, p_actor) IS NULL THEN
    RAISE EXCEPTION 'case_csat_scores: staff only' USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  RETURN QUERY
  WITH rs AS (
    SELECT x.* FROM public.case_csat_responses x
     WHERE x.account_id = p_account AND x.responded_at >= coalesce(p_since, '-infinity'::timestamptz)
  ), readable AS (
    SELECT d.case_id FROM (SELECT DISTINCT rs.case_id FROM rs) d
     WHERE coalesce(public.case_can_read(d.case_id, p_actor), false)
  )
  SELECT rs.case_id, rs.trigger, rs.agent_id, rs.bank_code, b.name, rs.score, rs.responded_at
    FROM rs
    JOIN readable USING (case_id)
    LEFT JOIN public.case_banks b ON b.account_id = rs.account_id AND b.code = rs.bank_code
   ORDER BY rs.responded_at DESC
   LIMIT 5000;
END;
$$;

-- ---------- 7. Privacy ----------

CREATE OR REPLACE FUNCTION public.privacy_case_csat_export(p_account uuid, p_contact uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'requests', coalesce((SELECT jsonb_agg(jsonb_build_object(
                  'trigger', r.trigger, 'status', r.status, 'sent_at', r.sent_at, 'created_at', r.created_at)
                  ORDER BY r.created_at)
                  FROM public.case_csat_requests r
                 WHERE r.account_id = p_account AND r.contact_id = p_contact), '[]'::jsonb),
    'ratings', coalesce((SELECT jsonb_agg(jsonb_build_object(
                  'trigger', x.trigger, 'score', x.score, 'comment', x.comment, 'responded_at', x.responded_at)
                  ORDER BY x.responded_at)
                  FROM public.case_csat_responses x
                 WHERE x.account_id = p_account AND x.contact_id = p_contact), '[]'::jsonb))
$$;

CREATE OR REPLACE FUNCTION public.privacy_case_csat_erase(p_account uuid, p_contact uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_x integer;
  v_r integer;
BEGIN
  DELETE FROM public.case_csat_responses x WHERE x.account_id = p_account AND x.contact_id = p_contact;
  GET DIAGNOSTICS v_x = ROW_COUNT;
  DELETE FROM public.case_csat_requests r WHERE r.account_id = p_account AND r.contact_id = p_contact;
  GET DIAGNOSTICS v_r = ROW_COUNT;
  RETURN jsonb_build_object('counts', jsonb_build_object('case_csat_responses', v_x, 'case_csat_requests', v_r),
                            'objects', '[]'::jsonb);
END;
$$;

INSERT INTO public.privacy_extensions (name, export_fn, erase_fn, added_in)
VALUES ('case_csat', 'privacy_case_csat_export', 'privacy_case_csat_erase', '246')
ON CONFLICT (name) DO UPDATE SET export_fn = excluded.export_fn, erase_fn = excluded.erase_fn;

-- ---------- 8. Privileges ----------

REVOKE ALL ON FUNCTION
  public.case_csat_settings_get(uuid, uuid),
  public.case_csat_settings_set(uuid, uuid, boolean, boolean, boolean, text, text, text, integer, integer, integer,
                                timestamptz, timestamptz),
  public.case_csat_trigger_for(text, text, text),
  public.case_csat_on_stage_history(),
  public.case_csat_claim(timestamptz, integer),
  public.case_csat_mark(uuid, text, text, text, uuid, text, timestamptz),
  public.case_csat_capture(uuid, uuid, uuid, integer, text, timestamptz),
  public.case_csat_for_case(uuid, uuid),
  public.case_csat_scores(uuid, uuid, timestamptz),
  public.privacy_case_csat_export(uuid, uuid), public.privacy_case_csat_erase(uuid, uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.case_csat_settings_get(uuid, uuid),
  public.case_csat_settings_set(uuid, uuid, boolean, boolean, boolean, text, text, text, integer, integer, integer,
                                timestamptz, timestamptz),
  public.case_csat_claim(timestamptz, integer),
  public.case_csat_mark(uuid, text, text, text, uuid, text, timestamptz),
  public.case_csat_capture(uuid, uuid, uuid, integer, text, timestamptz),
  public.case_csat_for_case(uuid, uuid),
  public.case_csat_scores(uuid, uuid, timestamptz)
TO service_role;
