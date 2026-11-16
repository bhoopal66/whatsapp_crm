-- ============================================================
-- 203_hr_automsg.sql — HR automated messages (database half).
--
-- Port of the outside package's automated candidate messages (025a/b
-- base, 026d F7 consent, 026e concurrency: claim / settle / review_stuck
-- / sent_today, 027a template category) onto 200's HR workflows. The
-- package's text workspace ids and actor arguments are gone: the account
-- is the caller's active one (current_account_id()) and the actor is
-- auth.uid().
--
-- What it is: TEMPLATE-ONLY WhatsApp messages to job candidates on
-- recruiting events (CV received, invited to an interview stage, a
-- reminder, a nudge when the candidate has gone quiet). Nothing here
-- sends: SQL triggers enqueue rows in hr_automsg_outbox and a TypeScript
-- cron drain decides and sends them through the service-role functions
-- of section 5 (due → row_state → claim → send → mark / settle).
--
--   1. Tables: hr_automsg_settings (one row per account; no row = the
--      defaults), hr_automsg_triggers (account × trigger; no row = off,
--      default kind), hr_automsg_templates (account × kind × language),
--      hr_automsg_consent (account × contact), hr_automsg_outbox,
--      hr_automsg_audit (append-only). RLS enabled AND forced on all six,
--      no policies, no grants: every access is a function below.
--   2. OFF BY DEFAULT. The kill switch defaults ON and every trigger
--      defaults OFF; while a trigger is off its events write nothing.
--   3. Personal chats (conversations.personal_owner_id NOT NULL) never
--      get an outbox row, and neither does a chat with no contact.
--   4. Enqueue: AFTER INSERT ON hr_stage_history (open into the recruiter
--      inbox → cv_received; a stage / move into ai_interview,
--      hr_interview or manager_interview → stage_<stage>), deduplicated
--      on 'hist:<history id>'. It can never fail the HR write: errors
--      become WARNINGs. hr_automsg_enqueue_nudges (cron) adds
--      reply_overdue_nudge rows, once per waiting period.
--   5. At most one send in flight per row: hr_automsg_claim takes a
--      per-(account, contact) advisory lock, re-counts today's sends
--      against daily_cap in the account's time zone, and claims with ONE
--      conditional UPDATE. A claim with no outcome after 15 minutes is
--      parked as needs_review (hr_automsg_review_stuck), never resent.
--   6. Template bodies are checked here for length, control characters
--      and braces ('{name}' / '{slot}' only); promotional wording and
--      required placeholders are checked in TypeScript. Only Utility
--      templates may be saved.
--
-- Refusals: RAISE … USING HINT = NOT_ALLOWED (42501) | NOT_FOUND (P0002)
-- | INVALID | LIMIT | ALREADY_DECIDED (22023), through 200's hr_refuse.
-- Apply after 200. Re-runnable. No BEGIN/COMMIT.
-- ============================================================

SET lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. Tables
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.hr_automsg_settings (
  account_id       uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  kill_switch      boolean NOT NULL DEFAULT true,
  quiet_start      time NOT NULL DEFAULT '21:00',
  quiet_end        time NOT NULL DEFAULT '08:00',
  tz               text NOT NULL DEFAULT 'Asia/Dubai',
  requires_consent boolean NOT NULL DEFAULT true,
  daily_cap        integer NOT NULL DEFAULT 3,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT hr_automsg_settings_cap_check CHECK (daily_cap BETWEEN 1 AND 20)
);

CREATE TABLE IF NOT EXISTS public.hr_automsg_triggers (
  account_id    uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  trigger       text NOT NULL,
  enabled       boolean NOT NULL DEFAULT false,
  template_kind text NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT hr_automsg_triggers_pkey PRIMARY KEY (account_id, trigger),
  CONSTRAINT hr_automsg_triggers_trigger_check CHECK (trigger IN (
    'cv_received', 'stage_ai_interview', 'stage_hr_interview', 'stage_manager_interview',
    'interview_reminder', 'reply_overdue_nudge')),
  CONSTRAINT hr_automsg_triggers_kind_check CHECK (template_kind IS NULL OR template_kind IN (
    'cv_ack', 'ai_interview_invite', 'hr_interview_invite', 'manager_interview_invite',
    'interview_reminder', 'reply_nudge'))
);

CREATE TABLE IF NOT EXISTS public.hr_automsg_templates (
  account_id         uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  kind               text NOT NULL,
  language           text NOT NULL,
  body               text NOT NULL,
  meta_template_name text NOT NULL DEFAULT '',
  approval_status    text NOT NULL DEFAULT 'draft',
  category           text NOT NULL DEFAULT 'utility',
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT hr_automsg_templates_pkey PRIMARY KEY (account_id, kind, language),
  CONSTRAINT hr_automsg_templates_kind_check CHECK (kind IN (
    'cv_ack', 'ai_interview_invite', 'hr_interview_invite', 'manager_interview_invite',
    'interview_reminder', 'reply_nudge')),
  CONSTRAINT hr_automsg_templates_language_check CHECK (language IN ('en', 'ar')),
  CONSTRAINT hr_automsg_templates_body_check CHECK (char_length(body) BETWEEN 1 AND 1024),
  CONSTRAINT hr_automsg_templates_name_check CHECK (meta_template_name ~ '^[a-z0-9_]{0,512}$'),
  CONSTRAINT hr_automsg_templates_status_check CHECK (approval_status IN ('draft', 'approved')),
  CONSTRAINT hr_automsg_templates_category_check CHECK (
    category IN ('utility', 'marketing', 'authentication')),
  CONSTRAINT hr_automsg_templates_approved_named CHECK (
    approval_status = 'draft' OR meta_template_name <> '')
);

CREATE TABLE IF NOT EXISTS public.hr_automsg_consent (
  account_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  granted    boolean NOT NULL,
  source     text NOT NULL,
  noted_at   timestamptz NOT NULL DEFAULT now(),
  noted_by   uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT hr_automsg_consent_pkey PRIMARY KEY (account_id, contact_id),
  CONSTRAINT hr_automsg_consent_contact_fkey FOREIGN KEY (contact_id, account_id)
    REFERENCES public.contacts(id, account_id) ON DELETE CASCADE,
  CONSTRAINT hr_automsg_consent_source_check CHECK (
    source IN ('recruiter_confirmed', 'candidate_wrote', 'form'))
);

CREATE TABLE IF NOT EXISTS public.hr_automsg_outbox (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  conversation_id     uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  contact_id          uuid NOT NULL,
  trigger             text NOT NULL,
  template_kind       text NOT NULL,
  language            text NOT NULL DEFAULT 'en',
  params              jsonb NOT NULL DEFAULT '{}',
  body_rendered       text NOT NULL DEFAULT '',
  dedupe_key          text NOT NULL,
  status              text NOT NULL DEFAULT 'queued',
  hold_reason         text NULL,
  attempts            integer NOT NULL DEFAULT 0,
  claim_state         text NULL,
  claimed_at          timestamptz NULL,
  provider_message_id text NULL,
  message_id          uuid NULL,
  last_error          text NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz NULL,
  CONSTRAINT hr_automsg_outbox_trigger_check CHECK (trigger IN (
    'cv_received', 'stage_ai_interview', 'stage_hr_interview', 'stage_manager_interview',
    'interview_reminder', 'reply_overdue_nudge')),
  CONSTRAINT hr_automsg_outbox_kind_check CHECK (template_kind IN (
    'cv_ack', 'ai_interview_invite', 'hr_interview_invite', 'manager_interview_invite',
    'interview_reminder', 'reply_nudge')),
  CONSTRAINT hr_automsg_outbox_language_check CHECK (language IN ('en', 'ar')),
  CONSTRAINT hr_automsg_outbox_dedupe_check CHECK (dedupe_key !~ '^[[:space:]]*$'),
  CONSTRAINT hr_automsg_outbox_status_check CHECK (
    status IN ('queued', 'held', 'sent', 'failed', 'cancelled')),
  CONSTRAINT hr_automsg_outbox_hold_reason_check CHECK (hold_reason IS NULL OR hold_reason IN (
    'kill_switch', 'disabled', 'closed', 'opted_out', 'no_consent', 'quiet_hours',
    'outside_window_no_template', 'daily_cap', 'duplicate')),
  CONSTRAINT hr_automsg_outbox_attempts_check CHECK (attempts BETWEEN 0 AND 3),
  CONSTRAINT hr_automsg_outbox_claim_check CHECK (
    claim_state IS NULL OR claim_state IN ('sending', 'unconfirmed', 'needs_review')),
  CONSTRAINT hr_automsg_outbox_error_check CHECK (
    last_error IS NULL OR char_length(last_error) <= 500),
  CONSTRAINT hr_automsg_outbox_dedupe UNIQUE (account_id, dedupe_key),
  CONSTRAINT hr_automsg_outbox_hold_shape CHECK ((status = 'held') = (hold_reason IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS hr_automsg_outbox_open_idx
  ON public.hr_automsg_outbox (created_at)
  WHERE status IN ('queued', 'held', 'failed');
CREATE INDEX IF NOT EXISTS hr_automsg_outbox_contact_idx
  ON public.hr_automsg_outbox (account_id, contact_id, created_at);

CREATE TABLE IF NOT EXISTS public.hr_automsg_audit (
  id         bigserial PRIMARY KEY,
  account_id uuid NOT NULL,
  actor      uuid NULL,
  action     text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}',
  at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hr_automsg_audit_account_idx
  ON public.hr_automsg_audit (account_id, at);

COMMENT ON TABLE public.hr_automsg_outbox IS
  'HR automated candidate messages (template only), enqueued by SQL triggers and drained by the TS cron through the service-role hr_automsg_* functions. Migration 203.';
COMMENT ON TABLE public.hr_automsg_audit IS
  'Append-only log of HR automated-message settings, triggers, templates, consent and cancels. Migration 203.';

-- ------------------------------------------------------------
-- 2. RLS, grants (every access is a function)
-- ------------------------------------------------------------

ALTER TABLE public.hr_automsg_settings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_automsg_triggers  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_automsg_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_automsg_consent   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_automsg_outbox    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_automsg_audit     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_automsg_settings  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.hr_automsg_triggers  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.hr_automsg_templates FORCE ROW LEVEL SECURITY;
ALTER TABLE public.hr_automsg_consent   FORCE ROW LEVEL SECURITY;
ALTER TABLE public.hr_automsg_outbox    FORCE ROW LEVEL SECURITY;
ALTER TABLE public.hr_automsg_audit     FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.hr_automsg_settings, public.hr_automsg_triggers,
              public.hr_automsg_templates, public.hr_automsg_consent,
              public.hr_automsg_outbox, public.hr_automsg_audit
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.hr_automsg_audit_id_seq
  FROM PUBLIC, anon, authenticated, service_role;

-- Append-only: no writer may change or remove an audit row.
CREATE OR REPLACE FUNCTION public.hr_automsg_audit_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'hr_automsg_audit is append-only'
    USING ERRCODE = '42501', HINT = 'NOT_ALLOWED';
END;
$$;

DROP TRIGGER IF EXISTS hr_automsg_audit_guard ON public.hr_automsg_audit;
CREATE TRIGGER hr_automsg_audit_guard
  BEFORE UPDATE OR DELETE ON public.hr_automsg_audit
  FOR EACH ROW EXECUTE FUNCTION public.hr_automsg_audit_guard();

-- ------------------------------------------------------------
-- 3. Internal helpers (not granted)
-- ------------------------------------------------------------

-- The template kind a trigger uses when its row names none.
CREATE OR REPLACE FUNCTION public.hr_automsg_default_kind(p_trigger text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE p_trigger
    WHEN 'cv_received' THEN 'cv_ack'
    WHEN 'stage_ai_interview' THEN 'ai_interview_invite'
    WHEN 'stage_hr_interview' THEN 'hr_interview_invite'
    WHEN 'stage_manager_interview' THEN 'manager_interview_invite'
    WHEN 'interview_reminder' THEN 'interview_reminder'
    WHEN 'reply_overdue_nudge' THEN 'reply_nudge'
  END
$$;

-- The effective settings row of an account (the defaults when none).
CREATE OR REPLACE FUNCTION public.hr_automsg_settings_of(p_account uuid)
RETURNS public.hr_automsg_settings
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  s hr_automsg_settings;
BEGIN
  SELECT * INTO s FROM hr_automsg_settings x WHERE x.account_id = p_account;
  IF NOT FOUND THEN
    s.account_id := p_account;
    s.kill_switch := true;
    s.quiet_start := '21:00';
    s.quiet_end := '08:00';
    s.tz := 'Asia/Dubai';
    s.requires_consent := true;
    s.daily_cap := 3;
    s.updated_at := NULL;
    s.updated_by := NULL;
  END IF;
  RETURN s;
END;
$$;

-- The settings object of hr_automsg_config / hr_automsg_row_state.
CREATE OR REPLACE FUNCTION public.hr_automsg_settings_json(p_account uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'kill_switch', s.kill_switch,
    'quiet_start', to_char(s.quiet_start, 'HH24:MI'),
    'quiet_end', to_char(s.quiet_end, 'HH24:MI'),
    'tz', s.tz,
    'requires_consent', s.requires_consent,
    'daily_cap', s.daily_cap,
    'updated_at', s.updated_at)
  FROM hr_automsg_settings_of(p_account) s
$$;

-- Messages sent (or in flight) to a contact on p_now's day in the
-- account's time zone. A claim that never settled counts: it may have
-- gone out.
CREATE OR REPLACE FUNCTION public.hr_automsg_sent_today(
  p_account uuid, p_contact uuid, p_now timestamptz)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT count(*)::integer
    FROM hr_automsg_outbox o, hr_automsg_settings_of(p_account) s
   WHERE o.account_id = p_account AND o.contact_id = p_contact
     AND (o.status = 'sent' OR o.claim_state IN ('sending', 'needs_review'))
     AND (COALESCE(o.sent_at, o.claimed_at) AT TIME ZONE s.tz)::date
         = (p_now AT TIME ZONE s.tz)::date
$$;

CREATE OR REPLACE FUNCTION public.hr_automsg_log(p_account uuid, p_action text, p_detail jsonb)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO hr_automsg_audit (account_id, actor, action, detail)
  VALUES (p_account, auth.uid(), p_action, COALESCE(p_detail, '{}'::jsonb))
$$;

-- The caller's account and recruiter-inbox role; NOT_ALLOWED without an
-- active account.
CREATE OR REPLACE FUNCTION public.hr_automsg_caller(OUT o_account uuid, OUT o_role text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  o_account := current_account_id();
  IF o_account IS NULL THEN
    PERFORM hr_refuse('NOT_ALLOWED', 'no active workspace');
  END IF;
  o_role := hr_role(o_account, auth.uid(), 'recruiter');
END;
$$;

-- ------------------------------------------------------------
-- 4. Enqueue trigger on hr_stage_history
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.hr_automsg_on_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_trigger text;
  v_kind text;
  v_contact uuid;
BEGIN
  IF NEW.to_inbox IS DISTINCT FROM 'recruiter' THEN RETURN NULL; END IF;
  v_trigger := CASE
    WHEN NEW.event = 'open' THEN 'cv_received'
    WHEN NEW.event IN ('stage', 'move')
         AND NEW.to_stage IN ('ai_interview', 'hr_interview', 'manager_interview')
      THEN 'stage_' || NEW.to_stage
  END;
  IF v_trigger IS NULL THEN RETURN NULL; END IF;
  BEGIN
    SELECT COALESCE(t.template_kind, hr_automsg_default_kind(t.trigger)) INTO v_kind
      FROM hr_automsg_triggers t
     WHERE t.account_id = NEW.account_id AND t.trigger = v_trigger AND t.enabled;
    IF v_kind IS NULL THEN RETURN NULL; END IF;
    -- Company chats with a contact only; a personal chat never gets a row.
    SELECT c.contact_id INTO v_contact
      FROM conversations c
     WHERE c.id = NEW.conversation_id AND c.account_id = NEW.account_id
       AND c.personal_owner_id IS NULL;
    IF v_contact IS NULL THEN RETURN NULL; END IF;
    INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger,
                                   template_kind, language, params, status, dedupe_key)
    VALUES (NEW.account_id, NEW.conversation_id, v_contact, v_trigger,
            v_kind, 'en', '{}'::jsonb, 'queued', 'hist:' || NEW.id)
    ON CONFLICT ON CONSTRAINT hr_automsg_outbox_dedupe DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'hr_automsg_on_history: % (%)', SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS hr_automsg_on_history ON public.hr_stage_history;
CREATE TRIGGER hr_automsg_on_history
  AFTER INSERT ON public.hr_stage_history
  FOR EACH ROW EXECUTE FUNCTION public.hr_automsg_on_history();

-- ------------------------------------------------------------
-- 5. Caller-facing RPCs (authenticated)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.hr_automsg_config()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid;
  v_role text;
BEGIN
  SELECT o_account, o_role INTO v_account, v_role FROM hr_automsg_caller();
  IF COALESCE(v_role, '') NOT IN ('lead', 'admin') THEN
    PERFORM hr_refuse('NOT_ALLOWED', 'automated messages need a recruiter lead or an admin');
  END IF;
  RETURN jsonb_build_object(
    'settings', hr_automsg_settings_json(v_account),
    'triggers', (
      SELECT jsonb_agg(jsonb_build_object(
               'trigger', k.trigger,
               'enabled', COALESCE(t.enabled, false),
               'template_kind', COALESCE(t.template_kind, hr_automsg_default_kind(k.trigger)))
             ORDER BY k.ord)
        FROM unnest(ARRAY['cv_received', 'stage_ai_interview', 'stage_hr_interview',
                          'stage_manager_interview', 'interview_reminder',
                          'reply_overdue_nudge']::text[]) WITH ORDINALITY AS k(trigger, ord)
        LEFT JOIN hr_automsg_triggers t
          ON t.account_id = v_account AND t.trigger = k.trigger),
    'templates', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'kind', x.kind, 'language', x.language, 'body', x.body,
               'meta_template_name', x.meta_template_name,
               'approval_status', x.approval_status, 'category', x.category,
               'updated_at', x.updated_at)
             ORDER BY x.kind, x.language)
        FROM hr_automsg_templates x WHERE x.account_id = v_account), '[]'::jsonb),
    'role', v_role);
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_automsg_settings_set(
  p_kill_switch boolean, p_quiet_start text, p_quiet_end text, p_tz text,
  p_requires_consent boolean, p_daily_cap integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid;
  v_role text;
  s hr_automsg_settings;
  v_changed jsonb := '{}'::jsonb;
BEGIN
  SELECT o_account, o_role INTO v_account, v_role FROM hr_automsg_caller();
  IF v_role IS DISTINCT FROM 'admin' THEN
    PERFORM hr_refuse('NOT_ALLOWED', 'only an admin may change automated-message settings');
  END IF;
  IF p_quiet_start IS NOT NULL AND p_quiet_start !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
    PERFORM hr_refuse('INVALID', 'quiet hours start must be HH:MM (24 h)');
  END IF;
  IF p_quiet_end IS NOT NULL AND p_quiet_end !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
    PERFORM hr_refuse('INVALID', 'quiet hours end must be HH:MM (24 h)');
  END IF;
  IF p_tz IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = p_tz) THEN
    PERFORM hr_refuse('INVALID', 'unknown time zone');
  END IF;
  IF p_daily_cap IS NOT NULL AND p_daily_cap NOT BETWEEN 1 AND 20 THEN
    PERFORM hr_refuse('LIMIT', 'the daily cap must be between 1 and 20');
  END IF;

  s := hr_automsg_settings_of(v_account);
  IF p_kill_switch IS NOT NULL AND p_kill_switch IS DISTINCT FROM s.kill_switch THEN
    s.kill_switch := p_kill_switch;
    v_changed := v_changed || jsonb_build_object('kill_switch', p_kill_switch);
  END IF;
  IF p_quiet_start IS NOT NULL AND p_quiet_start::time IS DISTINCT FROM s.quiet_start THEN
    s.quiet_start := p_quiet_start::time;
    v_changed := v_changed || jsonb_build_object('quiet_start', p_quiet_start);
  END IF;
  IF p_quiet_end IS NOT NULL AND p_quiet_end::time IS DISTINCT FROM s.quiet_end THEN
    s.quiet_end := p_quiet_end::time;
    v_changed := v_changed || jsonb_build_object('quiet_end', p_quiet_end);
  END IF;
  IF p_tz IS NOT NULL AND p_tz IS DISTINCT FROM s.tz THEN
    s.tz := p_tz;
    v_changed := v_changed || jsonb_build_object('tz', p_tz);
  END IF;
  IF p_requires_consent IS NOT NULL AND p_requires_consent IS DISTINCT FROM s.requires_consent THEN
    s.requires_consent := p_requires_consent;
    v_changed := v_changed || jsonb_build_object('requires_consent', p_requires_consent);
  END IF;
  IF p_daily_cap IS NOT NULL AND p_daily_cap IS DISTINCT FROM s.daily_cap THEN
    s.daily_cap := p_daily_cap;
    v_changed := v_changed || jsonb_build_object('daily_cap', p_daily_cap);
  END IF;

  INSERT INTO hr_automsg_settings (account_id, kill_switch, quiet_start, quiet_end, tz,
                                   requires_consent, daily_cap, updated_at, updated_by)
  VALUES (v_account, s.kill_switch, s.quiet_start, s.quiet_end, s.tz,
          s.requires_consent, s.daily_cap, now(), auth.uid())
  ON CONFLICT (account_id) DO UPDATE
    SET kill_switch = EXCLUDED.kill_switch, quiet_start = EXCLUDED.quiet_start,
        quiet_end = EXCLUDED.quiet_end, tz = EXCLUDED.tz,
        requires_consent = EXCLUDED.requires_consent, daily_cap = EXCLUDED.daily_cap,
        updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;
  PERFORM hr_automsg_log(v_account, 'settings', jsonb_build_object('changed', v_changed));
  RETURN hr_automsg_config();
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_automsg_trigger_set(
  p_trigger text, p_enabled boolean, p_template_kind text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid;
  v_role text;
BEGIN
  SELECT o_account, o_role INTO v_account, v_role FROM hr_automsg_caller();
  IF COALESCE(v_role, '') NOT IN ('lead', 'admin') THEN
    PERFORM hr_refuse('NOT_ALLOWED', 'automated messages need a recruiter lead or an admin');
  END IF;
  IF hr_automsg_default_kind(p_trigger) IS NULL THEN
    PERFORM hr_refuse('NOT_FOUND', 'unknown trigger');
  END IF;
  IF p_enabled IS NULL THEN
    PERFORM hr_refuse('INVALID', 'enabled is required');
  END IF;
  IF p_template_kind IS NOT NULL AND p_template_kind NOT IN (
       'cv_ack', 'ai_interview_invite', 'hr_interview_invite', 'manager_interview_invite',
       'interview_reminder', 'reply_nudge') THEN
    PERFORM hr_refuse('INVALID', 'unknown template kind');
  END IF;
  INSERT INTO hr_automsg_triggers (account_id, trigger, enabled, template_kind, updated_at, updated_by)
  VALUES (v_account, p_trigger, p_enabled, p_template_kind, now(), auth.uid())
  ON CONFLICT (account_id, trigger) DO UPDATE
    SET enabled = EXCLUDED.enabled, template_kind = EXCLUDED.template_kind,
        updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;
  PERFORM hr_automsg_log(v_account, 'trigger', jsonb_build_object(
    'trigger', p_trigger, 'enabled', p_enabled, 'template_kind', p_template_kind));
  RETURN hr_automsg_config();
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_automsg_template_set(
  p_kind text, p_language text, p_body text, p_meta_template_name text,
  p_approval_status text, p_category text DEFAULT 'utility')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid;
  v_role text;
  v_name text := COALESCE(p_meta_template_name, '');
BEGIN
  SELECT o_account, o_role INTO v_account, v_role FROM hr_automsg_caller();
  IF v_role IS DISTINCT FROM 'admin' THEN
    PERFORM hr_refuse('NOT_ALLOWED', 'only an admin may change automated-message templates');
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN (
       'cv_ack', 'ai_interview_invite', 'hr_interview_invite', 'manager_interview_invite',
       'interview_reminder', 'reply_nudge') THEN
    PERFORM hr_refuse('INVALID', 'unknown template kind');
  END IF;
  IF p_language IS NULL OR p_language NOT IN ('en', 'ar') THEN
    PERFORM hr_refuse('INVALID', 'unknown language');
  END IF;
  IF p_approval_status IS NULL OR p_approval_status NOT IN ('draft', 'approved') THEN
    PERFORM hr_refuse('INVALID', 'unknown approval status');
  END IF;
  IF p_category IS DISTINCT FROM 'utility' THEN
    PERFORM hr_refuse('INVALID', 'automated templates must be Utility templates');
  END IF;
  IF p_body IS NULL OR char_length(p_body) NOT BETWEEN 1 AND 1024 THEN
    PERFORM hr_refuse('INVALID', 'the body must be 1 to 1024 characters');
  END IF;
  -- Control characters other than a newline.
  IF p_body ~ '[\x01-\x09\x0B-\x1F\x7F]' THEN
    PERFORM hr_refuse('INVALID', 'the body may not contain control characters');
  END IF;
  -- Braces only as the exact tokens {name} and {slot}.
  IF replace(replace(p_body, '{name}', ''), '{slot}', '') ~ '[{}]' THEN
    PERFORM hr_refuse('INVALID', 'the only placeholders allowed are {name} and {slot}');
  END IF;
  IF p_approval_status = 'approved' AND v_name !~ '^[a-z0-9_]{1,512}$' THEN
    PERFORM hr_refuse('INVALID', 'an approved template needs its Meta template name');
  END IF;
  IF v_name !~ '^[a-z0-9_]{0,512}$' THEN
    PERFORM hr_refuse('INVALID', 'a Meta template name is lower-case letters, digits and _');
  END IF;

  INSERT INTO hr_automsg_templates (account_id, kind, language, body, meta_template_name,
                                    approval_status, category, updated_at, updated_by)
  VALUES (v_account, p_kind, p_language, p_body, v_name, p_approval_status, p_category,
          now(), auth.uid())
  ON CONFLICT (account_id, kind, language) DO UPDATE
    SET body = EXCLUDED.body, meta_template_name = EXCLUDED.meta_template_name,
        approval_status = EXCLUDED.approval_status, category = EXCLUDED.category,
        updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;
  PERFORM hr_automsg_log(v_account, 'template', jsonb_build_object(
    'kind', p_kind, 'language', p_language, 'meta_template_name', v_name,
    'approval_status', p_approval_status, 'category', p_category));
  RETURN hr_automsg_config();
END;
$$;

-- Consent of the chat's contact. Any recruiter role (member and up) on a
-- recruiter or dept HR chat the caller can see.
CREATE OR REPLACE FUNCTION public.hr_automsg_consent_get(p_conversation_id uuid)
RETURNS TABLE (granted boolean, source text, noted_at timestamptz,
               opted_out boolean, personal boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid;
  v_role text;
BEGIN
  SELECT o_account, o_role INTO v_account, v_role FROM hr_automsg_caller();
  IF p_conversation_id IS NULL OR NOT hr_can_see(p_conversation_id)
     OR NOT EXISTS (SELECT 1 FROM hr_conversations x
                     WHERE x.conversation_id = p_conversation_id AND x.account_id = v_account) THEN
    PERFORM hr_refuse('NOT_FOUND', 'conversation not found');
  END IF;
  IF COALESCE(v_role, '') NOT IN ('member', 'lead', 'admin') THEN
    PERFORM hr_refuse('NOT_ALLOWED', 'consent needs a recruiter role');
  END IF;
  RETURN QUERY
    SELECT k.granted, k.source, k.noted_at,
           COALESCE(ct.opted_out_at IS NOT NULL, false),
           c.personal_owner_id IS NOT NULL
      FROM conversations c
      LEFT JOIN contacts ct ON ct.id = c.contact_id AND ct.account_id = c.account_id
      LEFT JOIN hr_automsg_consent k ON k.account_id = c.account_id AND k.contact_id = c.contact_id
     WHERE c.id = p_conversation_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_automsg_consent_set(
  p_conversation_id uuid, p_granted boolean, p_source text DEFAULT 'recruiter_confirmed')
RETURNS TABLE (granted boolean, source text, noted_at timestamptz,
               opted_out boolean, personal boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid;
  v_role text;
  v_contact uuid;
BEGIN
  SELECT o_account, o_role INTO v_account, v_role FROM hr_automsg_caller();
  IF p_conversation_id IS NULL OR NOT hr_can_see(p_conversation_id)
     OR NOT EXISTS (SELECT 1 FROM hr_conversations x
                     WHERE x.conversation_id = p_conversation_id AND x.account_id = v_account) THEN
    PERFORM hr_refuse('NOT_FOUND', 'conversation not found');
  END IF;
  IF COALESCE(v_role, '') NOT IN ('member', 'lead', 'admin') THEN
    PERFORM hr_refuse('NOT_ALLOWED', 'consent needs a recruiter role');
  END IF;
  SELECT c.contact_id INTO v_contact FROM conversations c WHERE c.id = p_conversation_id;
  IF v_contact IS NULL THEN
    PERFORM hr_refuse('NOT_FOUND', 'the conversation has no contact');
  END IF;
  IF p_granted IS NULL THEN
    PERFORM hr_refuse('INVALID', 'granted is required');
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('recruiter_confirmed', 'candidate_wrote', 'form') THEN
    PERFORM hr_refuse('INVALID', 'unknown consent source');
  END IF;
  INSERT INTO hr_automsg_consent AS k (account_id, contact_id, granted, source, noted_at, noted_by)
  VALUES (v_account, v_contact, p_granted, p_source, now(), auth.uid())
  ON CONFLICT (account_id, contact_id) DO UPDATE
    SET granted = EXCLUDED.granted, source = EXCLUDED.source,
        noted_at = EXCLUDED.noted_at, noted_by = EXCLUDED.noted_by;
  PERFORM hr_automsg_log(v_account, 'consent', jsonb_build_object(
    'conversation_id', p_conversation_id, 'contact_id', v_contact,
    'granted', p_granted, 'source', p_source));
  RETURN QUERY SELECT * FROM hr_automsg_consent_get(p_conversation_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_automsg_outbox_list(
  p_status text DEFAULT NULL, p_limit integer DEFAULT 100)
RETURNS TABLE (id uuid, conversation_id uuid, contact_id uuid, contact_name text,
               trigger text, template_kind text, language text, status text,
               hold_reason text, attempts integer, claim_state text, last_error text,
               created_at timestamptz, sent_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid;
  v_role text;
BEGIN
  SELECT o_account, o_role INTO v_account, v_role FROM hr_automsg_caller();
  IF COALESCE(v_role, '') NOT IN ('lead', 'admin') THEN
    PERFORM hr_refuse('NOT_ALLOWED', 'automated messages need a recruiter lead or an admin');
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('queued', 'held', 'sent', 'failed', 'cancelled') THEN
    PERFORM hr_refuse('INVALID', 'unknown status');
  END IF;
  RETURN QUERY
    SELECT o.id, o.conversation_id, o.contact_id, ct.name, o.trigger, o.template_kind,
           o.language, o.status, o.hold_reason, o.attempts, o.claim_state, o.last_error,
           o.created_at, o.sent_at
      FROM hr_automsg_outbox o
      LEFT JOIN contacts ct ON ct.id = o.contact_id AND ct.account_id = o.account_id
     WHERE o.account_id = v_account
       AND (p_status IS NULL OR o.status = p_status)
       AND hr_can_see(o.conversation_id)
     ORDER BY o.created_at DESC, o.id
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_automsg_cancel(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid;
  v_role text;
  o hr_automsg_outbox;
BEGIN
  SELECT o_account, o_role INTO v_account, v_role FROM hr_automsg_caller();
  SELECT * INTO o FROM hr_automsg_outbox x
   WHERE x.id = p_id AND x.account_id = v_account FOR UPDATE;
  IF NOT FOUND OR NOT hr_can_see(o.conversation_id) THEN
    PERFORM hr_refuse('NOT_FOUND', 'message not found');
  END IF;
  IF COALESCE(v_role, '') NOT IN ('lead', 'admin') THEN
    PERFORM hr_refuse('NOT_ALLOWED', 'cancelling needs a recruiter lead or an admin');
  END IF;
  IF o.status NOT IN ('queued', 'held', 'failed') OR o.claim_state IS NOT NULL THEN
    PERFORM hr_refuse('ALREADY_DECIDED', 'this message can no longer be cancelled');
  END IF;
  UPDATE hr_automsg_outbox x
     SET status = 'cancelled', hold_reason = NULL, updated_at = now()
   WHERE x.id = p_id;
  PERFORM hr_automsg_log(v_account, 'cancel', jsonb_build_object(
    'outbox_id', p_id, 'conversation_id', o.conversation_id, 'from_status', o.status));
END;
$$;

-- ------------------------------------------------------------
-- 6. Drain functions (service role)
-- ------------------------------------------------------------

-- One signature only: an earlier draft took (integer) alone.
DROP FUNCTION IF EXISTS public.hr_automsg_due(integer);

CREATE OR REPLACE FUNCTION public.hr_automsg_due(
  p_limit integer DEFAULT 100, p_account_id uuid DEFAULT NULL)
RETURNS SETOF public.hr_automsg_outbox
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT * FROM hr_automsg_outbox o
   WHERE o.status IN ('queued', 'held', 'failed') AND o.claim_state IS NULL AND o.attempts < 3
     AND (p_account_id IS NULL OR o.account_id = p_account_id)
   ORDER BY o.created_at, o.id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
$$;

-- Whether an account uses automated messages at all: the kill switch
-- turned off, or any trigger on. The inbound hook asks this before
-- honouring a candidate's STOP.
CREATE OR REPLACE FUNCTION public.hr_automsg_active(p_account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM hr_automsg_settings s
                  WHERE s.account_id = p_account_id AND NOT s.kill_switch)
      OR EXISTS (SELECT 1 FROM hr_automsg_triggers t
                  WHERE t.account_id = p_account_id AND t.enabled)
$$;

CREATE OR REPLACE FUNCTION public.hr_automsg_row_state(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  o hr_automsg_outbox;
  h hr_conversations;
  c conversations;
  v_name text;
  v_opted boolean;
BEGIN
  SELECT * INTO o FROM hr_automsg_outbox x WHERE x.id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO h FROM hr_conversations x WHERE x.conversation_id = o.conversation_id;
  SELECT * INTO c FROM conversations x WHERE x.id = o.conversation_id;
  SELECT ct.name, ct.opted_out_at IS NOT NULL INTO v_name, v_opted
    FROM contacts ct WHERE ct.id = o.contact_id AND ct.account_id = o.account_id;
  RETURN jsonb_build_object(
    'row', to_jsonb(o),
    'closed', h.conversation_id IS NULL OR h.closed_at IS NOT NULL,
    'inbox', h.inbox,
    'personal', c.personal_owner_id IS NOT NULL,
    'opted_out', COALESCE(v_opted, false),
    'consent', EXISTS (SELECT 1 FROM hr_automsg_consent k
                        WHERE k.account_id = o.account_id AND k.contact_id = o.contact_id
                          AND k.granted),
    'last_inbound_at', h.last_inbound_at,
    'contact_name', v_name,
    'settings', hr_automsg_settings_json(o.account_id),
    'trigger_enabled', COALESCE((SELECT t.enabled FROM hr_automsg_triggers t
                                  WHERE t.account_id = o.account_id AND t.trigger = o.trigger), false),
    'template', (SELECT jsonb_build_object(
                   'kind', x.kind, 'language', x.language, 'body', x.body,
                   'meta_template_name', x.meta_template_name,
                   'approval_status', x.approval_status, 'category', x.category,
                   'updated_at', x.updated_at)
                   FROM hr_automsg_templates x
                  WHERE x.account_id = o.account_id AND x.kind = o.template_kind
                    AND x.language = o.language),
    'sent_today', hr_automsg_sent_today(o.account_id, o.contact_id, now()));
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_automsg_claim(p_id uuid, p_now timestamptz DEFAULT now())
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid;
  v_contact uuid;
  v_now timestamptz := COALESCE(p_now, now());
BEGIN
  SELECT x.account_id, x.contact_id INTO v_account, v_contact
    FROM hr_automsg_outbox x WHERE x.id = p_id;
  IF NOT FOUND THEN RETURN 'lost'; END IF;
  -- One claim at a time per contact, so two drains cannot both pass the cap.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_account::text || ':' || v_contact::text, 0));
  IF hr_automsg_sent_today(v_account, v_contact, v_now)
     >= (hr_automsg_settings_of(v_account)).daily_cap THEN
    UPDATE hr_automsg_outbox x
       SET status = 'held', hold_reason = 'daily_cap', updated_at = now()
     WHERE x.id = p_id AND x.status IN ('queued', 'held', 'failed') AND x.claim_state IS NULL;
    RETURN 'capped';
  END IF;
  UPDATE hr_automsg_outbox x
     SET status = 'queued', hold_reason = NULL, claim_state = 'sending',
         claimed_at = v_now, attempts = x.attempts + 1, updated_at = now()
   WHERE x.id = p_id AND x.status IN ('queued', 'held', 'failed')
     AND x.claim_state IS NULL AND x.attempts < 3;
  RETURN CASE WHEN FOUND THEN 'claimed' ELSE 'lost' END;
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_automsg_mark(
  p_id uuid, p_status text, p_hold_reason text DEFAULT NULL,
  p_provider_message_id text DEFAULT NULL, p_message_id uuid DEFAULT NULL,
  p_error text DEFAULT NULL, p_body_rendered text DEFAULT NULL)
RETURNS public.hr_automsg_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  o hr_automsg_outbox;
  v_releasable boolean;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('queued', 'held', 'sent', 'failed', 'cancelled') THEN
    PERFORM hr_refuse('INVALID', 'unknown status');
  END IF;
  IF p_hold_reason IS NOT NULL AND p_hold_reason NOT IN (
       'kill_switch', 'disabled', 'closed', 'opted_out', 'no_consent', 'quiet_hours',
       'outside_window_no_template', 'daily_cap', 'duplicate') THEN
    PERFORM hr_refuse('INVALID', 'unknown hold reason');
  END IF;
  SELECT * INTO o FROM hr_automsg_outbox x WHERE x.id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM hr_refuse('NOT_FOUND', 'message not found'); END IF;
  v_releasable := o.status IN ('queued', 'held', 'failed') AND o.claim_state IS NULL;

  IF v_releasable AND p_status = 'held' THEN
    IF p_hold_reason IS NULL THEN
      PERFORM hr_refuse('INVALID', 'holding a message needs a reason');
    END IF;
    UPDATE hr_automsg_outbox x SET status = 'held', hold_reason = p_hold_reason, updated_at = now()
     WHERE x.id = p_id RETURNING * INTO o;
  ELSIF v_releasable AND p_status = 'cancelled' THEN
    UPDATE hr_automsg_outbox x SET status = 'cancelled', hold_reason = NULL, updated_at = now()
     WHERE x.id = p_id RETURNING * INTO o;
  ELSIF o.claim_state = 'sending' AND p_status = 'sent' THEN
    UPDATE hr_automsg_outbox x
       SET status = 'sent', hold_reason = NULL, claim_state = NULL, sent_at = now(),
           provider_message_id = COALESCE(p_provider_message_id, x.provider_message_id),
           message_id = COALESCE(p_message_id, x.message_id),
           body_rendered = COALESCE(p_body_rendered, x.body_rendered),
           updated_at = now()
     WHERE x.id = p_id RETURNING * INTO o;
  ELSIF o.claim_state = 'sending' AND p_status = 'failed' THEN
    UPDATE hr_automsg_outbox x
       SET status = 'failed', hold_reason = NULL, claim_state = NULL,
           last_error = left(p_error, 500), updated_at = now()
     WHERE x.id = p_id RETURNING * INTO o;
  ELSE
    PERFORM hr_refuse('ALREADY_DECIDED',
      format('cannot mark a %s message (claim %s) as %s',
             o.status, COALESCE(o.claim_state, 'none'), p_status));
  END IF;
  RETURN o;
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_automsg_settle_unconfirmed(p_id uuid, p_provider_message_id text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE hr_automsg_outbox x
     SET status = 'sent', hold_reason = NULL, claim_state = 'unconfirmed', sent_at = now(),
         provider_message_id = COALESCE(p_provider_message_id, x.provider_message_id),
         updated_at = now()
   WHERE x.id = p_id AND x.claim_state = 'sending'
$$;

CREATE OR REPLACE FUNCTION public.hr_automsg_review_stuck(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  UPDATE hr_automsg_outbox x
     SET claim_state = 'needs_review', updated_at = now()
   WHERE x.claim_state = 'sending'
     AND x.claimed_at < COALESCE(p_now, now()) - interval '15 minutes';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

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
     AND x.created_at < COALESCE(p_now, now()) - interval '24 hours';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- One nudge per waiting period: the dedupe key carries the outbound
-- timestamp the candidate has not answered.
CREATE OR REPLACE FUNCTION public.hr_automsg_enqueue_nudges(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger,
                                 template_kind, language, params, status, dedupe_key)
  SELECT h.account_id, h.conversation_id, c.contact_id, 'reply_overdue_nudge',
         COALESCE(t.template_kind, 'reply_nudge'), 'en', '{}'::jsonb, 'queued',
         'nudge:' || h.conversation_id || ':'
           || floor(extract(epoch FROM h.last_outbound_at))::bigint
    FROM hr_automsg_triggers t
    JOIN hr_conversations h ON h.account_id = t.account_id
    JOIN conversations c ON c.id = h.conversation_id AND c.account_id = h.account_id
    LEFT JOIN hr_workflow_rules r
      ON r.account_id = h.account_id AND r.key = 'no_activity_recruiter'
   WHERE t.trigger = 'reply_overdue_nudge' AND t.enabled
     AND h.inbox = 'recruiter' AND h.closed_at IS NULL
     AND h.reply_state = 'waiting'
     AND h.last_outbound_at <= COALESCE(p_now, now())
                               - make_interval(hours => COALESCE(r.after_hours, 72))
     AND c.personal_owner_id IS NULL AND c.contact_id IS NOT NULL
  ON CONFLICT ON CONSTRAINT hr_automsg_outbox_dedupe DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- ------------------------------------------------------------
-- 7. Function privileges
-- ------------------------------------------------------------

REVOKE ALL ON FUNCTION
  public.hr_automsg_audit_guard(),
  public.hr_automsg_default_kind(text),
  public.hr_automsg_settings_of(uuid),
  public.hr_automsg_settings_json(uuid),
  public.hr_automsg_sent_today(uuid, uuid, timestamptz),
  public.hr_automsg_log(uuid, text, jsonb),
  public.hr_automsg_caller(),
  public.hr_automsg_on_history(),
  public.hr_automsg_config(),
  public.hr_automsg_settings_set(boolean, text, text, text, boolean, integer),
  public.hr_automsg_trigger_set(text, boolean, text),
  public.hr_automsg_template_set(text, text, text, text, text, text),
  public.hr_automsg_consent_get(uuid),
  public.hr_automsg_consent_set(uuid, boolean, text),
  public.hr_automsg_outbox_list(text, integer),
  public.hr_automsg_cancel(uuid),
  public.hr_automsg_due(integer, uuid),
  public.hr_automsg_active(uuid),
  public.hr_automsg_row_state(uuid),
  public.hr_automsg_claim(uuid, timestamptz),
  public.hr_automsg_mark(uuid, text, text, text, uuid, text, text),
  public.hr_automsg_settle_unconfirmed(uuid, text),
  public.hr_automsg_review_stuck(timestamptz),
  public.hr_automsg_expire(timestamptz),
  public.hr_automsg_enqueue_nudges(timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.hr_automsg_config(),
  public.hr_automsg_settings_set(boolean, text, text, text, boolean, integer),
  public.hr_automsg_trigger_set(text, boolean, text),
  public.hr_automsg_template_set(text, text, text, text, text, text),
  public.hr_automsg_consent_get(uuid),
  public.hr_automsg_consent_set(uuid, boolean, text),
  public.hr_automsg_outbox_list(text, integer),
  public.hr_automsg_cancel(uuid)
  TO authenticated;

GRANT EXECUTE ON FUNCTION
  public.hr_automsg_due(integer, uuid),
  public.hr_automsg_active(uuid),
  public.hr_automsg_row_state(uuid),
  public.hr_automsg_claim(uuid, timestamptz),
  public.hr_automsg_mark(uuid, text, text, text, uuid, text, text),
  public.hr_automsg_settle_unconfirmed(uuid, text),
  public.hr_automsg_review_stuck(timestamptz),
  public.hr_automsg_expire(timestamptz),
  public.hr_automsg_enqueue_nudges(timestamptz)
  TO service_role;
