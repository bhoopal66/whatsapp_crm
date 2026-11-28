-- ============================================================
-- 334_send_protection.sql — the stores the send guard (188's module,
-- src/lib/whatsapp/meta-health/guard.ts) needs before any send path
-- consults it. Still WATCH-ONLY: nothing here blocks a send; no
-- existing object is restated and no trigger is added to an existing
-- table.
--
--   1. send_protection_decisions  append-only log of guard decisions
--      (what was decided, why, and whether enforce was on). Owners and
--      admins read it; only send_protection_decision_record (service
--      role) inserts; UPDATE / DELETE / TRUNCATE are refused.
--   2. send_protection_spend      spend ledger per (account, UTC day,
--      scope), integer micros. send_protection_spend_add adds only if
--      the new total stays within the cap, in ONE conditional UPDATE
--      (concurrent callers serialise on the row lock and re-check);
--      send_protection_spend_refund gives a reservation back.
--   3. send_protection_caps       daily marketing spend cap and daily AI
--      spend cap (micros; NULL = no cap). Owners and admins read and
--      set them (p_actor, 188's shape).
--   4. send_protection_recipient_signals  opted out, marketing template
--      sends since the contact's last inbound message, failed deliveries
--      in 30 days. Source: contacts.opted_out_at (076); messages
--      (sender_type 'customer' = inbound, content_type 'template' +
--      template_name, status 'failed') joined to message_templates.category
--      ('Marketing') of the same account. Our category, not Meta's
--      (051 holds Meta's only for receipted Meta sends; this also has to
--      count Whapi/OpenWA template sends and failures).
--
-- Re-runnable: IF NOT EXISTS, guarded constraints, CREATE OR REPLACE,
-- DROP POLICY IF EXISTS. Functions write RLS-forced tables, so (as 188)
-- this must be applied by a superuser or BYPASSRLS role.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '334 must be applied by a superuser or BYPASSRLS role (its functions write RLS-forced tables)';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 1. Decision log (append-only)
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.send_protection_decisions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  -- The number the send went out on; kept after the number is removed.
  config_id   uuid NULL,
  template    text NULL,
  contact_id  uuid NULL,
  kind        text NOT NULL,
  decision    text NOT NULL,
  reason      text NOT NULL,
  enforced    boolean NOT NULL
);

ALTER TABLE public.send_protection_decisions DROP CONSTRAINT IF EXISTS send_protection_decisions_kind_check;
ALTER TABLE public.send_protection_decisions ADD CONSTRAINT send_protection_decisions_kind_check
  CHECK (kind IN ('SESSION', 'MARKETING', 'UTILITY', 'AUTHENTICATION'));
ALTER TABLE public.send_protection_decisions DROP CONSTRAINT IF EXISTS send_protection_decisions_decision_check;
ALTER TABLE public.send_protection_decisions ADD CONSTRAINT send_protection_decisions_decision_check
  CHECK (decision IN ('ALLOW', 'DENY', 'DEFER'));
ALTER TABLE public.send_protection_decisions DROP CONSTRAINT IF EXISTS send_protection_decisions_reason_check;
ALTER TABLE public.send_protection_decisions ADD CONSTRAINT send_protection_decisions_reason_check
  CHECK (reason ~ '^[A-Z_]{1,64}$');
ALTER TABLE public.send_protection_decisions DROP CONSTRAINT IF EXISTS send_protection_decisions_template_check;
ALTER TABLE public.send_protection_decisions ADD CONSTRAINT send_protection_decisions_template_check
  CHECK (template IS NULL OR char_length(template) <= 512);

CREATE INDEX IF NOT EXISTS send_protection_decisions_account_at_idx
  ON public.send_protection_decisions (account_id, at DESC);

-- Append-only, except the cascade from deleting the account (188's rule).
CREATE OR REPLACE FUNCTION public.send_protection_decisions_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1
     AND NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = OLD.account_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'send_protection_decisions is append-only (% refused)', TG_OP
    USING ERRCODE = 'insufficient_privilege', HINT = 'APPEND_ONLY';
END;
$$;

CREATE OR REPLACE TRIGGER send_protection_decisions_append_only
  BEFORE UPDATE OR DELETE ON public.send_protection_decisions
  FOR EACH ROW EXECUTE FUNCTION public.send_protection_decisions_append_only();
CREATE OR REPLACE TRIGGER send_protection_decisions_no_truncate
  BEFORE TRUNCATE ON public.send_protection_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION public.send_protection_decisions_append_only();

-- ------------------------------------------------------------
-- 2. Spend ledger and 3. caps
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.send_protection_spend (
  account_id    uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  day           date NOT NULL,
  scope         text NOT NULL,
  amount_micros bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, day, scope)
);

ALTER TABLE public.send_protection_spend DROP CONSTRAINT IF EXISTS send_protection_spend_scope_check;
ALTER TABLE public.send_protection_spend ADD CONSTRAINT send_protection_spend_scope_check
  CHECK (scope IN ('wa.marketing.daily', 'ai.daily'));
ALTER TABLE public.send_protection_spend DROP CONSTRAINT IF EXISTS send_protection_spend_amount_check;
ALTER TABLE public.send_protection_spend ADD CONSTRAINT send_protection_spend_amount_check
  CHECK (amount_micros >= 0);

CREATE TABLE IF NOT EXISTS public.send_protection_caps (
  account_id                     uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  daily_marketing_spend_micros   bigint NULL,
  daily_ai_spend_micros          bigint NULL,
  updated_by                     uuid NULL,
  updated_at                     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.send_protection_caps DROP CONSTRAINT IF EXISTS send_protection_caps_check;
ALTER TABLE public.send_protection_caps ADD CONSTRAINT send_protection_caps_check
  CHECK ((daily_marketing_spend_micros IS NULL OR daily_marketing_spend_micros >= 0)
         AND (daily_ai_spend_micros IS NULL OR daily_ai_spend_micros >= 0));

-- ------------------------------------------------------------
-- RLS: forced; owners/admins read decisions, spend and caps; no client writes
-- ------------------------------------------------------------

ALTER TABLE public.send_protection_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.send_protection_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.send_protection_spend ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.send_protection_spend FORCE ROW LEVEL SECURITY;
ALTER TABLE public.send_protection_caps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.send_protection_caps FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS send_protection_decisions_select ON public.send_protection_decisions;
CREATE POLICY send_protection_decisions_select ON public.send_protection_decisions FOR SELECT
  USING (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS send_protection_spend_select ON public.send_protection_spend;
CREATE POLICY send_protection_spend_select ON public.send_protection_spend FOR SELECT
  USING (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS send_protection_caps_select ON public.send_protection_caps;
CREATE POLICY send_protection_caps_select ON public.send_protection_caps FOR SELECT
  USING (public.is_account_member(account_id, 'admin'));

REVOKE ALL ON public.send_protection_decisions, public.send_protection_spend, public.send_protection_caps
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.send_protection_decisions, public.send_protection_spend, public.send_protection_caps
  TO authenticated, service_role;
REVOKE ALL ON SEQUENCE public.send_protection_decisions_id_seq FROM PUBLIC, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- Functions (service role only)
-- ------------------------------------------------------------

-- Append one decision; returns its id.
CREATE OR REPLACE FUNCTION public.send_protection_decision_record(p_account uuid, p_config uuid,
  p_template text, p_contact uuid, p_kind text, p_decision text, p_reason text, p_enforced boolean)
RETURNS bigint
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  INSERT INTO public.send_protection_decisions
    (account_id, config_id, template, contact_id, kind, decision, reason, enforced)
  VALUES (p_account, p_config, p_template, p_contact, p_kind, p_decision, p_reason, p_enforced)
  RETURNING id
$$;

-- Add p_micros to today's (UTC) p_scope only if the total stays within
-- p_hard_cap (NULL = no cap). One conditional UPDATE does check-and-add.
-- Returns whether it was recorded, the total after (unchanged when refused)
-- and the UTC day it used: a refund passes that day back, so a reservation
-- made just before midnight is not refunded against the next day.
-- use_column: the OUT column "day" would make ON CONFLICT (…, day, …)
-- ambiguous.
CREATE OR REPLACE FUNCTION public.send_protection_spend_add(p_account uuid, p_scope text,
  p_micros bigint, p_hard_cap bigint)
RETURNS TABLE (allowed boolean, total_micros bigint, day date)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_day date := (now() AT TIME ZONE 'UTC')::date;
  v_total bigint;
BEGIN
  IF p_account IS NULL OR p_micros IS NULL OR p_micros < 0 OR (p_hard_cap IS NOT NULL AND p_hard_cap < 0) THEN
    RAISE EXCEPTION 'SPEND_INVALID: an account, micros >= 0 and a cap >= 0 or NULL are required'
      USING ERRCODE = 'check_violation', HINT = 'SPEND_INVALID';
  END IF;
  INSERT INTO public.send_protection_spend (account_id, day, scope, amount_micros)
  VALUES (p_account, v_day, p_scope, 0)
  ON CONFLICT (account_id, day, scope) DO NOTHING;
  UPDATE public.send_protection_spend s SET amount_micros = s.amount_micros + p_micros
   WHERE s.account_id = p_account AND s.day = v_day AND s.scope = p_scope
     AND (p_hard_cap IS NULL OR s.amount_micros + p_micros <= p_hard_cap)
  RETURNING s.amount_micros INTO v_total;
  IF FOUND THEN
    RETURN QUERY SELECT true, v_total, v_day;
    RETURN;
  END IF;
  SELECT s.amount_micros INTO v_total FROM public.send_protection_spend s
   WHERE s.account_id = p_account AND s.day = v_day AND s.scope = p_scope;
  RETURN QUERY SELECT false, v_total, v_day;
END;
$$;

-- Give back p_micros on p_day's p_scope (the reservation's day), floored
-- at 0. Returns the total after (0 with no row).
CREATE OR REPLACE FUNCTION public.send_protection_spend_refund(p_account uuid, p_scope text,
  p_day date, p_micros bigint)
RETURNS bigint
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH u AS (
    UPDATE public.send_protection_spend s
       SET amount_micros = greatest(0, s.amount_micros - greatest(coalesce(p_micros, 0), 0))
     WHERE s.account_id = p_account AND s.day = p_day AND s.scope = p_scope
    RETURNING s.amount_micros
  )
  SELECT coalesce((SELECT amount_micros FROM u), 0)
$$;

-- The account's caps; both NULL (no cap) with no row.
CREATE OR REPLACE FUNCTION public.send_protection_caps_get(p_account uuid)
RETURNS TABLE (daily_marketing_spend_micros bigint, daily_ai_spend_micros bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT c.daily_marketing_spend_micros, c.daily_ai_spend_micros
    FROM (SELECT 1) one
    LEFT JOIN public.send_protection_caps c ON c.account_id = p_account
$$;

-- Set both caps (NULL = no cap): owners and admins (188's actor rule).
CREATE OR REPLACE FUNCTION public.send_protection_set_caps(p_actor uuid, p_account uuid,
  p_marketing_micros bigint, p_ai_micros bigint)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
BEGIN
  v_role := public.meta_protection_actor_role(p_account, p_actor);
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'NOT_ALLOWED: % may not change the spend caps of %', p_actor, p_account
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  IF (p_marketing_micros IS NOT NULL AND p_marketing_micros < 0) OR (p_ai_micros IS NOT NULL AND p_ai_micros < 0) THEN
    RAISE EXCEPTION 'SETTING_INVALID: a cap must be 0 or more, or NULL'
      USING ERRCODE = 'check_violation', HINT = 'SETTING_INVALID';
  END IF;
  INSERT INTO public.send_protection_caps AS c
    (account_id, daily_marketing_spend_micros, daily_ai_spend_micros, updated_by, updated_at)
  VALUES (p_account, p_marketing_micros, p_ai_micros, p_actor, now())
  ON CONFLICT (account_id) DO UPDATE
    SET daily_marketing_spend_micros = EXCLUDED.daily_marketing_spend_micros,
        daily_ai_spend_micros = EXCLUDED.daily_ai_spend_micros,
        updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
END;
$$;

-- ------------------------------------------------------------
-- 4. Recipient signals (the guard's recipientSignals loader)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.send_protection_recipient_signals(p_account uuid, p_contact uuid)
RETURNS TABLE (opted_out boolean, sent_without_reply integer, failed_deliveries integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH m AS (
    SELECT msg.sender_type, msg.content_type, msg.template_name, msg.status, msg.created_at
      FROM public.messages msg
      JOIN public.conversations v ON v.id = msg.conversation_id
     WHERE v.account_id = p_account AND v.contact_id = p_contact
  ), last_in AS (
    SELECT max(m.created_at) AS at FROM m WHERE m.sender_type = 'customer'
  )
  SELECT
    coalesce((SELECT ct.opted_out_at IS NOT NULL FROM public.contacts ct
               WHERE ct.id = p_contact AND ct.account_id = p_account), false),
    (SELECT count(*)::integer FROM m, last_in
      WHERE m.sender_type <> 'customer' AND m.content_type = 'template'
        AND m.status <> 'failed'
        AND (last_in.at IS NULL OR m.created_at > last_in.at)
        AND EXISTS (SELECT 1 FROM public.message_templates t
                     WHERE t.account_id = p_account AND t.name = m.template_name
                       AND t.category = 'Marketing')),
    (SELECT count(*)::integer FROM m
      WHERE m.sender_type <> 'customer' AND m.status = 'failed'
        AND m.created_at >= now() - interval '30 days')
$$;

-- ------------------------------------------------------------
-- Function privileges: service role only
-- ------------------------------------------------------------

REVOKE ALL ON FUNCTION public.send_protection_decisions_append_only()
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION
  public.send_protection_decision_record(uuid, uuid, text, uuid, text, text, text, boolean),
  public.send_protection_spend_add(uuid, text, bigint, bigint),
  public.send_protection_spend_refund(uuid, text, date, bigint),
  public.send_protection_caps_get(uuid),
  public.send_protection_set_caps(uuid, uuid, bigint, bigint),
  public.send_protection_recipient_signals(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.send_protection_decision_record(uuid, uuid, text, uuid, text, text, text, boolean),
  public.send_protection_spend_add(uuid, text, bigint, bigint),
  public.send_protection_spend_refund(uuid, text, date, bigint),
  public.send_protection_caps_get(uuid),
  public.send_protection_set_caps(uuid, uuid, bigint, bigint),
  public.send_protection_recipient_signals(uuid, uuid)
  TO service_role;
