-- ============================================================
-- 063_typesafe_decision_layer
--
-- Module 013: the TypeSafe (Jev) decision layer in front of the AI
-- auto-reply bot (lib/typesafe, hooked from lib/ai/auto-reply.ts).
-- docs/typesafe.md is the operator-facing description.
--
-- Ported from the standalone module-013 package (its
-- 013_typesafe_decision_layer.sql). The package assumed one tenant, an
-- `admin/supervisor/rm` role table and a `contacts.assigned_rm_id`
-- column, reached through two adapter functions (ts_user_role,
-- ts_owns_contact). Here instead:
--
--   * every table carries account_id, and a policy is per account: one
--     active policy per (account, check), four-eyes within the account;
--   * "admin or supervisor" is an account owner or admin — thresholds
--     are account settings, and settings are admin-only in this app;
--   * "the RM who owns the contact" is whoever contact RLS
--     (can_view_contact, migrations 043/060/061) already lets see it,
--     so the log never shows a decision about a contact the reader
--     could not open.
--
-- Hardened after a production review (2026-09-29):
--   * four-eyes holds on every path: a trigger checks each proposal —
--     including an operator's INSERT, which bypasses RLS — and approval
--     re-checks the proposer; thresholds are validated in SQL
--     (ts_validate_thresholds mirrors THRESHOLD_BOUNDS in
--     lib/typesafe/policy.ts — change one, change both);
--   * ts_retire_policy is a per-account emergency stop that needs one
--     admin (it can only move a check toward shadow);
--   * policies can't be edited or deleted after the fact;
--   * deleting a contact erases its identifiers from the log, and the
--     retention purge drops message and state hashes with the answers;
--   * a label can only point at a decision in its own account;
--   * RLS is enabled and default grants revoked immediately after each
--     CREATE TABLE, so a partial apply never leaves a table open;
--   * SELECT policies use migration 059's initPlan form;
--   * claim_ai_reply_slot refuses a thread that was handed off or
--     assigned while a reply was being drafted.
--
-- Everything else — the four-eyes CHECK, append-only log, TRUNCATE
-- block, minimum grants — is the package's, unchanged in intent.
-- supabase/ci/verify-typesafe.sql asserts all of it against a real
-- database. Apply with `psql -1 -v ON_ERROR_STOP=1 -f …` (one
-- transaction).
--
-- Idempotent — safe to re-run.
-- ============================================================

-- Every lock this file takes gives up after 5 s rather than queue live
-- traffic behind a long transaction; under `psql -1` a lock is held to
-- the end of the file. On existing tables it takes only two: a
-- write-blocking lock on contacts (its erase trigger) and a brief ACCESS
-- EXCLUSIVE on conversations (the CHECK swap). Reset at the end.
SET lock_timeout = '5s';

-- ============================================================
-- 1. Threshold validation (mirrors lib/typesafe/policy.ts)
-- ============================================================

-- Allowed range of each threshold key: [min, max, integer].
-- Score thresholds are bounded by their own Score's level count
-- (urgency has 3 levels → 0..2; lead temperature and severity 4 → 0..3).
CREATE OR REPLACE FUNCTION public.ts_threshold_bounds(p_check text)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE p_check
    WHEN 'triage' THEN '{
      "intentConfidenceMin":    [0, 1, false],
      "possibleComplaintMin":   [0, 1, false],
      "wantsHumanMin":          [0, 1, false],
      "complaintConfidenceMin": [0, 1, false],
      "instructsAssistantMin":  [0, 1, false],
      "nonPartnerBankMin":      [0, 1, false],
      "dissatisfiedMin":        [0, 1, false],
      "leadTemperatureMin":     [0, 3, false],
      "leadTemperatureConfMin": [0, 1, false],
      "urgencyHighMin":         [0, 2, false],
      "urgencyUrgentMin":       [0, 2, false],
      "optOutRecordMin":        [0, 1, false],
      "optOutReviewMin":        [0, 1, false]
    }'::jsonb
    WHEN 'guardrail' THEN '{
      "actionMin":     [0, 1, false],
      "reviewMin":     [0, 1, false],
      "severityBlock": [0, 3, false]
    }'::jsonb
    WHEN 'passages' THEN '{
      "injectionMax":   [0, 1, false],
      "contradictsMin": [0, 1, false],
      "relevantMin":    [0, 1, false],
      "evidenceMin":    [0, 1, false],
      "fallbackTopK":   [0, 20, true]
    }'::jsonb
    WHEN 'eligibility' THEN '{
      "choiceConfidenceMin": [0, 1, false]
    }'::jsonb
  END
$$;

-- Raises unless p_t is exactly the check's key set, every value a number
-- in range, and the ordering rules hold.
CREATE OR REPLACE FUNCTION public.ts_validate_thresholds(p_check text, p_t jsonb)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_bounds jsonb := public.ts_threshold_bounds(p_check);
  v_key    text;
  v_b      jsonb;
  v_n      numeric;
BEGIN
  IF v_bounds IS NULL THEN
    RAISE EXCEPTION 'ts thresholds: unknown check %', p_check USING errcode = '22023';
  END IF;
  IF p_t IS NULL OR jsonb_typeof(p_t) <> 'object' THEN
    RAISE EXCEPTION 'ts thresholds: % thresholds must be an object', p_check USING errcode = '22023';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_t) LOOP
    IF NOT v_bounds ? v_key THEN
      RAISE EXCEPTION 'ts thresholds: unknown key %.%', p_check, v_key USING errcode = '22023';
    END IF;
  END LOOP;
  FOR v_key, v_b IN SELECT key, value FROM jsonb_each(v_bounds) LOOP
    IF NOT p_t ? v_key OR jsonb_typeof(p_t -> v_key) <> 'number' THEN
      RAISE EXCEPTION 'ts thresholds: %.% missing or not a number', p_check, v_key USING errcode = '22023';
    END IF;
    v_n := (p_t ->> v_key)::numeric;
    IF v_n < (v_b ->> 0)::numeric OR v_n > (v_b ->> 1)::numeric
       OR ((v_b ->> 2)::boolean AND v_n <> trunc(v_n)) THEN
      RAISE EXCEPTION 'ts thresholds: %.% = % out of range', p_check, v_key, v_n USING errcode = '22023';
    END IF;
  END LOOP;
  IF p_check = 'triage' AND (p_t ->> 'optOutReviewMin')::numeric > (p_t ->> 'optOutRecordMin')::numeric THEN
    RAISE EXCEPTION 'ts thresholds: triage optOutReviewMin > optOutRecordMin' USING errcode = '22023';
  END IF;
  IF p_check = 'triage' AND (p_t ->> 'urgencyHighMin')::numeric > (p_t ->> 'urgencyUrgentMin')::numeric THEN
    RAISE EXCEPTION 'ts thresholds: triage urgencyHighMin > urgencyUrgentMin' USING errcode = '22023';
  END IF;
  IF p_check = 'guardrail' AND (p_t ->> 'reviewMin')::numeric > (p_t ->> 'actionMin')::numeric THEN
    RAISE EXCEPTION 'ts thresholds: guardrail reviewMin > actionMin' USING errcode = '22023';
  END IF;
END
$$;


-- ============================================================
-- 2. Policy (versioned thresholds, four-eyes activation)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.ts_policy (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  check_name            text NOT NULL
                        CHECK (check_name IN ('triage','guardrail','passages','eligibility')),
  version               integer NOT NULL CHECK (version > 0),
  model_id              text NOT NULL,
  question_set_version  text NOT NULL,
  thresholds            jsonb NOT NULL CHECK (jsonb_typeof(thresholds) = 'object'),
  shadow                boolean NOT NULL DEFAULT true,
  status                text NOT NULL DEFAULT 'proposed'
                        CHECK (status IN ('proposed','active','retired')),
  proposed_by           uuid NOT NULL,
  proposed_at           timestamptz NOT NULL DEFAULT now(),
  approved_by           uuid,
  approved_at           timestamptz,
  retired_by            uuid,               -- who retired it (ts_retire_policy, or the approver of its successor)
  retired_at            timestamptz,
  note                  text,
  UNIQUE (account_id, check_name, version),
  -- Four-eyes: an active or retired policy must have been approved by someone else
  CONSTRAINT ts_policy_four_eyes CHECK (
    status = 'proposed'
    OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND approved_by <> proposed_by)
  )
);
-- Closed at once: Supabase's default grants would otherwise expose the
-- table to the anon key until the privileges section below runs.
ALTER TABLE public.ts_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ts_policy FROM PUBLIC, anon, authenticated, service_role;

-- At most one active policy per check per account
CREATE UNIQUE INDEX IF NOT EXISTS ts_policy_one_active
  ON public.ts_policy (account_id, check_name) WHERE status = 'active';

-- True when p_user is an owner or admin of p_account.
CREATE OR REPLACE FUNCTION public.ts_is_account_admin(p_account uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = p_user
      AND p.account_id = p_account
      AND p.account_role IN ('owner', 'admin')
  )
$$;

-- Every proposal, however it arrives (an admin through RLS, or the
-- operator's psql, which bypasses RLS): proposed only, by an owner or
-- admin of that account, with valid thresholds for a pinned model.
-- Afterwards a row changes only through ts_approve_policy /
-- ts_retire_policy, and is deleted only with its account.
CREATE OR REPLACE FUNCTION public.ts_policy_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF tg_op = 'INSERT' THEN
    IF new.status <> 'proposed' OR new.approved_by IS NOT NULL OR new.approved_at IS NOT NULL THEN
      RAISE EXCEPTION 'ts_policy: a policy is inserted as proposed; approve it with ts_approve_policy' USING errcode = '42501';
    END IF;
    IF new.retired_by IS NOT NULL OR new.retired_at IS NOT NULL THEN
      RAISE EXCEPTION 'ts_policy: retired_by / retired_at are set by ts_retire_policy and ts_approve_policy' USING errcode = '42501';
    END IF;
    -- The audit trail's clock is the database's, not the proposer's.
    new.proposed_at := now();
    -- Inline rather than through ts_is_account_admin: this trigger runs as
    -- the inserting user. An admin proposing through RLS can always see
    -- their own profile; the operator's psql bypasses RLS.
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = new.proposed_by
        AND p.account_id = new.account_id
        AND p.account_role IN ('owner', 'admin')
    ) THEN
      RAISE EXCEPTION 'ts_policy: proposed_by must be an owner or admin of the account' USING errcode = '42501';
    END IF;
    IF new.model_id !~ '^jev-[0-9]+\.[0-9]+\.[0-9]+$' THEN
      RAISE EXCEPTION 'ts_policy: model_id must be a pinned version like jev-1.13.0' USING errcode = '22023';
    END IF;
    PERFORM public.ts_validate_thresholds(new.check_name, new.thresholds);
    RETURN new;
  END IF;
  IF tg_op = 'UPDATE'
     AND current_setting('ts.policy_write', true) = 'on'
     AND current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = tg_relid)
     AND (to_jsonb(new) - 'status' - 'approved_by' - 'approved_at' - 'retired_by' - 'retired_at')
       = (to_jsonb(old) - 'status' - 'approved_by' - 'approved_at' - 'retired_by' - 'retired_at')
  THEN
    RETURN new;
  END IF;
  IF tg_op = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = old.account_id)
  THEN
    RETURN old;
  END IF;
  RAISE EXCEPTION 'ts_policy % blocked: use ts_approve_policy or ts_retire_policy', tg_op USING errcode = '42501';
END
$$;

DROP TRIGGER IF EXISTS ts_policy_guard ON public.ts_policy;
CREATE TRIGGER ts_policy_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.ts_policy
  FOR EACH ROW EXECUTE FUNCTION public.ts_policy_guard();

-- Approval = activation. Retires the previous active version atomically.
CREATE OR REPLACE FUNCTION public.ts_approve_policy(p_policy_id uuid)
RETURNS public.ts_policy
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row  public.ts_policy;
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'ts_approve_policy: no authenticated user' USING errcode = '42501';
  END IF;

  SELECT * INTO v_row FROM public.ts_policy WHERE id = p_policy_id FOR UPDATE;
  -- Not found and "not your account" read the same, so an id from
  -- another account reveals nothing.
  IF NOT FOUND OR NOT public.ts_is_account_admin(v_row.account_id, v_user) THEN
    RAISE EXCEPTION 'ts_approve_policy: policy % not found, or admin role required', p_policy_id
      USING errcode = '42501';
  END IF;
  IF v_row.status <> 'proposed' THEN
    RAISE EXCEPTION 'ts_approve_policy: policy % is %, not proposed', p_policy_id, v_row.status;
  END IF;
  IF v_row.proposed_by = v_user THEN
    RAISE EXCEPTION 'ts_approve_policy: proposer cannot approve own policy (four-eyes)' USING errcode = '42501';
  END IF;
  -- The first pair of eyes must still be an admin of this account.
  IF NOT public.ts_is_account_admin(v_row.account_id, v_row.proposed_by) THEN
    RAISE EXCEPTION 'ts_approve_policy: the proposer is no longer an owner or admin of the account (four-eyes)' USING errcode = '42501';
  END IF;
  PERFORM public.ts_validate_thresholds(v_row.check_name, v_row.thresholds);

  PERFORM set_config('ts.policy_write', 'on', true);
  UPDATE public.ts_policy
     SET status = 'retired', retired_by = v_user, retired_at = now()
   WHERE account_id = v_row.account_id AND check_name = v_row.check_name AND status = 'active';

  UPDATE public.ts_policy
     SET status = 'active', approved_by = v_user, approved_at = now()
   WHERE id = p_policy_id
  RETURNING * INTO v_row;
  PERFORM set_config('ts.policy_write', 'off', true);

  RETURN v_row;
END
$$;

-- Per-account emergency stop: any owner or admin retires the account's
-- active policy for a check. No second pair of eyes — without an active
-- policy the check can only run in shadow. For the guardrail that means
-- screening stops acting for the account: this is the switch for a
-- policy that is holding good replies, and it is recorded (retired_by,
-- retired_at). Takes effect within the policy cache TTL (60 s), with no
-- restart.
CREATE OR REPLACE FUNCTION public.ts_retire_policy(p_policy_id uuid)
RETURNS public.ts_policy
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row  public.ts_policy;
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'ts_retire_policy: no authenticated user' USING errcode = '42501';
  END IF;
  SELECT * INTO v_row FROM public.ts_policy WHERE id = p_policy_id FOR UPDATE;
  IF NOT FOUND OR NOT public.ts_is_account_admin(v_row.account_id, v_user) THEN
    RAISE EXCEPTION 'ts_retire_policy: policy % not found, or admin role required', p_policy_id
      USING errcode = '42501';
  END IF;
  IF v_row.status <> 'active' THEN
    RAISE EXCEPTION 'ts_retire_policy: policy % is %, not active', p_policy_id, v_row.status;
  END IF;
  PERFORM set_config('ts.policy_write', 'on', true);
  UPDATE public.ts_policy
     SET status = 'retired', retired_by = v_user, retired_at = now()
   WHERE id = p_policy_id
  RETURNING * INTO v_row;
  PERFORM set_config('ts.policy_write', 'off', true);
  RETURN v_row;
END
$$;


-- ============================================================
-- 3. Decision log (append-only) and labels
-- ============================================================

CREATE TABLE IF NOT EXISTS public.ts_decision_log (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- No FK: the log outlives a deleted contact, like any audit trail —
  -- but the contact's identifiers are erased with it (section 4).
  contact_id            uuid,
  conversation_id       text,
  message_id            text,               -- keyed hash of the gateway id, never the id itself
  check_name            text NOT NULL
                        CHECK (check_name IN ('triage','guardrail','passages','eligibility')),
  policy_version        integer,            -- null = built-in defaults
  model_id              text,               -- versioned ID reported by TypeSafe
  question_set_version  text NOT NULL,
  language              text,               -- 'en' | 'ar' | 'mixed' | 'other' | 'unknown'
  state_hash            text,               -- HMAC of the redacted state; raw text is never stored
  answers               jsonb,              -- purged after the retention period
  decision              text NOT NULL,
  reason_codes          text[] NOT NULL DEFAULT '{}',
  acted                 boolean NOT NULL,   -- false in shadow mode or when forced to shadow
  shadow                boolean NOT NULL,
  fallback_used         boolean NOT NULL DEFAULT false,
  latency_ms            integer,
  input_tokens          integer,
  error_code            text,
  answers_purged_at     timestamptz,
  -- Target of ts_label's composite FK: a label stays in its account.
  CONSTRAINT ts_decision_log_id_account_key UNIQUE (id, account_id)
);
ALTER TABLE public.ts_decision_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ts_decision_log FROM PUBLIC, anon, authenticated, service_role;

CREATE INDEX IF NOT EXISTS ts_decision_log_account_created_idx
  ON public.ts_decision_log (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ts_decision_log_created_idx
  ON public.ts_decision_log (created_at);
CREATE INDEX IF NOT EXISTS ts_decision_log_contact_idx
  ON public.ts_decision_log (contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ts_decision_log_check_idx
  ON public.ts_decision_log (account_id, check_name, created_at DESC);

-- Append-only. Three exceptions, each only for the table owner (i.e.
-- inside a SECURITY DEFINER function below) with a transaction-local
-- flag set — the flag alone is NOT sufficient:
--   * the retention purge (ts.purge): may only null answers, message_id
--     and state_hash, and stamp answers_purged_at;
--   * a contact's erasure (ts.erase): may only null that contact's
--     identifiers and answers;
--   * deleting an account: the FK cascade removes its rows. It is told
--     apart from a direct DELETE by the account row being gone already.
--
-- Columns are compared one by one rather than through to_jsonb: this
-- runs once per row when a contact is deleted (erasure), and the JSON
-- round trip made bulk deletes ~16x slower. A new column must be added to
-- the lists below — verify-typesafe.sql counts the table's columns so it
-- cannot be forgotten. No `SET search_path`: every name is qualified or
-- in pg_catalog, and the setting would be saved and restored per row.
CREATE OR REPLACE FUNCTION public.ts_decision_log_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_mode text;
BEGIN
  IF tg_op = 'UPDATE' THEN
    -- Cheapest test first: without one of the flags nothing may change.
    v_mode := CASE
      WHEN current_setting('ts.erase', true) = 'on' THEN 'erase'
      WHEN current_setting('ts.purge', true) = 'on' THEN 'purge'
    END;
    IF v_mode IS NOT NULL
       -- Fields no exception may touch.
       AND (new.id, new.account_id, new.created_at, new.check_name,
            new.policy_version, new.model_id, new.question_set_version,
            new.language, new.decision, new.reason_codes, new.acted, new.shadow,
            new.fallback_used, new.latency_ms, new.input_tokens, new.error_code)
           IS NOT DISTINCT FROM
           (old.id, old.account_id, old.created_at, old.check_name,
            old.policy_version, old.model_id, old.question_set_version,
            old.language, old.decision, old.reason_codes, old.acted, old.shadow,
            old.fallback_used, old.latency_ms, old.input_tokens, old.error_code)
       AND new.message_id IS NULL AND new.state_hash IS NULL AND new.answers IS NULL
       AND (
         (v_mode = 'erase'
            AND new.contact_id IS NULL AND new.conversation_id IS NULL)
         OR (v_mode = 'purge'
            AND old.answers_purged_at IS NULL AND new.answers_purged_at IS NOT NULL
            AND (new.contact_id, new.conversation_id)
                IS NOT DISTINCT FROM (old.contact_id, old.conversation_id))
       )
       -- Only the owner, i.e. inside the SECURITY DEFINER purge/erase
       -- functions: the flags alone are session-settable.
       AND current_user = (SELECT pg_catalog.pg_get_userbyid(c.relowner)
                             FROM pg_catalog.pg_class c WHERE c.oid = tg_relid)
    THEN
      RETURN new;
    END IF;
  END IF;
  IF tg_op = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = old.account_id)
  THEN
    RETURN old;
  END IF;
  RAISE EXCEPTION 'ts_decision_log is append-only (% blocked)', tg_op USING errcode = '42501';
END
$$;

DROP TRIGGER IF EXISTS ts_decision_log_append_only ON public.ts_decision_log;
CREATE TRIGGER ts_decision_log_append_only
  BEFORE UPDATE OR DELETE ON public.ts_decision_log
  FOR EACH ROW EXECUTE FUNCTION public.ts_decision_log_guard();

-- A decision logged for a contact that no longer exists — deleted while
-- its reply was still being drafted — arrives already erased: erasure
-- (section 4) only rewrites rows that exist at delete time.
CREATE OR REPLACE FUNCTION public.ts_decision_log_scrub()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF new.contact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.contacts c
    WHERE c.id = new.contact_id AND c.account_id = new.account_id
  ) THEN
    new.contact_id := NULL;
    new.conversation_id := NULL;
    new.message_id := NULL;
    new.state_hash := NULL;
    new.answers := NULL;
    new.answers_purged_at := now();
  END IF;
  RETURN new;
END
$$;

DROP TRIGGER IF EXISTS ts_decision_log_scrub ON public.ts_decision_log;
CREATE TRIGGER ts_decision_log_scrub
  BEFORE INSERT ON public.ts_decision_log
  FOR EACH ROW EXECUTE FUNCTION public.ts_decision_log_scrub();

-- TRUNCATE bypasses RLS and row triggers: block it on every module-013 table.
CREATE OR REPLACE FUNCTION public.ts_block_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% cannot be truncated', tg_table_name USING errcode = '42501';
END
$$;

DROP TRIGGER IF EXISTS ts_decision_log_no_truncate ON public.ts_decision_log;
CREATE TRIGGER ts_decision_log_no_truncate
  BEFORE TRUNCATE ON public.ts_decision_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.ts_block_truncate();

DROP TRIGGER IF EXISTS ts_policy_no_truncate ON public.ts_policy;
CREATE TRIGGER ts_policy_no_truncate
  BEFORE TRUNCATE ON public.ts_policy
  FOR EACH STATEMENT EXECUTE FUNCTION public.ts_block_truncate();

CREATE TABLE IF NOT EXISTS public.ts_label (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  decision_id       uuid NOT NULL,
  labeled_by        uuid NOT NULL DEFAULT auth.uid(),
  correct_decision  text NOT NULL,
  note              text,
  labeled_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (decision_id, labeled_by),
  -- The decision must be in the label's own account (migration 062's
  -- convention: impossible, not merely filtered).
  CONSTRAINT ts_label_decision_fkey FOREIGN KEY (decision_id, account_id)
    REFERENCES public.ts_decision_log (id, account_id) ON DELETE CASCADE
);
ALTER TABLE public.ts_label ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ts_label FROM PUBLIC, anon, authenticated, service_role;

CREATE INDEX IF NOT EXISTS ts_label_account_idx ON public.ts_label (account_id);
CREATE INDEX IF NOT EXISTS ts_label_decision_idx ON public.ts_label (decision_id, account_id);

DROP TRIGGER IF EXISTS ts_label_no_truncate ON public.ts_label;
CREATE TRIGGER ts_label_no_truncate
  BEFORE TRUNCATE ON public.ts_label
  FOR EACH STATEMENT EXECUTE FUNCTION public.ts_block_truncate();


-- ============================================================
-- 4. Retention and erasure
-- ============================================================

-- Nulls answers, message hashes and state hashes older than p_days,
-- across all accounts; keeps decision, codes, tokens and latency for
-- aggregates. Service role (or the operator's scheduler) only.
CREATE OR REPLACE FUNCTION public.ts_purge_answers(p_days integer DEFAULT 180)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_count integer;
BEGIN
  IF p_days IS NULL OR p_days < 30 THEN
    RAISE EXCEPTION 'ts_purge_answers: p_days must be >= 30';
  END IF;
  PERFORM set_config('ts.purge', 'on', true);
  UPDATE public.ts_decision_log
     SET answers = NULL, message_id = NULL, state_hash = NULL,
         answers_purged_at = now()
   WHERE answers_purged_at IS NULL
     AND created_at < now() - make_interval(days => p_days);
  GET DIAGNOSTICS v_count = row_count;
  PERFORM set_config('ts.purge', 'off', true);
  RETURN v_count;
END
$$;

-- A deleted contact takes its identifiers out of the log with it: the
-- decision row stays for aggregates, with no way back to the person.
-- Runs on every delete path (inbox, API, cascades) because it is a
-- trigger, not a call site.
CREATE OR REPLACE FUNCTION public.ts_erase_contact_decisions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM set_config('ts.erase', 'on', true);
  UPDATE public.ts_decision_log
     SET contact_id = NULL, conversation_id = NULL, message_id = NULL,
         state_hash = NULL, answers = NULL,
         answers_purged_at = coalesce(answers_purged_at, now())
   WHERE contact_id = old.id
     AND account_id = old.account_id;
  PERFORM set_config('ts.erase', 'off', true);
  RETURN old;
END
$$;

-- CREATE OR REPLACE, not DROP + CREATE: DROP TRIGGER takes an ACCESS
-- EXCLUSIVE lock on contacts (even IF EXISTS finds nothing), which would
-- block every inbox read until this file commits. REPLACE takes a lock
-- that only blocks contact writes.
CREATE OR REPLACE TRIGGER ts_erase_contact_decisions
  AFTER DELETE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.ts_erase_contact_decisions();


-- ============================================================
-- 5. Views (security_invoker: the log's RLS applies through them)
-- ============================================================

-- USD per million input tokens (jev-1.13.0 list price, 2026-09-27). Update on price change.
CREATE OR REPLACE FUNCTION public.ts_usd_per_mtok()
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$ SELECT 0.042::numeric $$;

CREATE OR REPLACE VIEW public.v_ts_daily_usage
WITH (security_invoker = true) AS
SELECT
  account_id,
  date_trunc('day', created_at)::date                         AS day,
  check_name,
  count(*)                                                    AS decisions,
  count(*) FILTER (WHERE acted)                               AS acted,
  count(*) FILTER (WHERE fallback_used)                       AS fallbacks,
  round(100.0 * count(*) FILTER (WHERE fallback_used) / nullif(count(*),0), 2) AS fallback_pct,
  coalesce(sum(input_tokens),0)                               AS input_tokens,
  coalesce(sum(input_tokens),0) * public.ts_usd_per_mtok() / 1000000 AS est_usd,  -- unrounded: sums across days stay exact
  percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)    AS p95_latency_ms
FROM public.ts_decision_log
GROUP BY 1, 2, 3;

CREATE OR REPLACE VIEW public.v_ts_label_agreement
WITH (security_invoker = true) AS
SELECT
  d.account_id,
  d.check_name,
  d.policy_version,
  coalesce(d.language,'unknown')                              AS language,
  count(*)                                                    AS labelled,
  count(*) FILTER (WHERE d.decision = l.correct_decision)     AS agreed,
  round(100.0 * count(*) FILTER (WHERE d.decision = l.correct_decision) / nullif(count(*),0), 2) AS agreement_pct
FROM public.ts_decision_log d
JOIN public.ts_label l ON l.decision_id = d.id AND l.account_id = d.account_id
GROUP BY 1, 2, 3, 4;


-- ============================================================
-- 6. Row-level security (059's initPlan form: the account and role
--    lookups run once per statement, not once per row)
-- ============================================================

-- ts_policy: admins read and propose (as themselves); approval and
-- retirement only via the functions above
DROP POLICY IF EXISTS ts_policy_read    ON public.ts_policy;
DROP POLICY IF EXISTS ts_policy_propose ON public.ts_policy;
CREATE POLICY ts_policy_read ON public.ts_policy
  FOR SELECT TO authenticated
  USING (
    account_id = (SELECT public.current_account_id())
    AND (SELECT public.current_role_rank()) >= 4
  );
CREATE POLICY ts_policy_propose ON public.ts_policy
  FOR INSERT TO authenticated
  WITH CHECK (
    account_id = (SELECT public.current_account_id())
    AND (SELECT public.current_role_rank()) >= 4
    AND status = 'proposed'
    AND proposed_by = (SELECT auth.uid())
    AND approved_by IS NULL
    AND approved_at IS NULL
  );

-- ts_decision_log: admins read the account's log; other members read
-- decisions about contacts they can see (contacts RLS applies inside
-- the EXISTS). Writes via service_role only.
DROP POLICY IF EXISTS ts_log_read ON public.ts_decision_log;
CREATE POLICY ts_log_read ON public.ts_decision_log
  FOR SELECT TO authenticated
  USING (
    account_id = (SELECT public.current_account_id())
    AND (
      (SELECT public.current_role_rank()) >= 4
      OR (
        contact_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.contacts c
          WHERE c.id = ts_decision_log.contact_id
            AND c.account_id = ts_decision_log.account_id
        )
      )
    )
  );

-- ts_label: agents and up may label any decision they can see, as themselves
DROP POLICY IF EXISTS ts_label_read  ON public.ts_label;
DROP POLICY IF EXISTS ts_label_write ON public.ts_label;
CREATE POLICY ts_label_read ON public.ts_label
  FOR SELECT TO authenticated
  USING (
    account_id = (SELECT public.current_account_id())
    AND (
      (SELECT public.current_role_rank()) >= 4
      OR labeled_by = (SELECT auth.uid())
    )
  );
CREATE POLICY ts_label_write ON public.ts_label
  FOR INSERT TO authenticated
  WITH CHECK (
    labeled_by = (SELECT auth.uid())
    AND account_id = (SELECT public.current_account_id())
    AND (SELECT public.current_role_rank()) >= 2
    AND EXISTS (  -- RLS on the log applies here
      SELECT 1 FROM public.ts_decision_log d
      WHERE d.id = decision_id AND d.account_id = ts_label.account_id
    )
  );


-- ============================================================
-- 7. Privileges
--
-- Supabase grants ALL on new public tables/functions to anon and
-- authenticated by default. Tables were closed as they were created;
-- views and functions are closed here, then the minimum is granted.
-- ============================================================

REVOKE ALL ON public.ts_policy, public.ts_decision_log, public.ts_label FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.v_ts_daily_usage, public.v_ts_label_agreement FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ts_threshold_bounds(text)            FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ts_validate_thresholds(text, jsonb)  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ts_is_account_admin(uuid, uuid)      FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ts_policy_guard()                    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ts_approve_policy(uuid)              FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ts_retire_policy(uuid)               FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ts_purge_answers(integer)            FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ts_erase_contact_decisions()         FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ts_decision_log_scrub()              FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ts_decision_log_guard()              FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ts_block_truncate()                  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ts_usd_per_mtok()                    FROM PUBLIC, anon, authenticated, service_role;

-- The threshold validators are pure; the insert trigger calls them as
-- the inserting user.
GRANT EXECUTE ON FUNCTION public.ts_threshold_bounds(text),
                          public.ts_validate_thresholds(text, jsonb)
  TO authenticated, service_role;

-- authenticated (RLS applies)
GRANT SELECT, INSERT ON public.ts_policy       TO authenticated;
GRANT SELECT         ON public.ts_decision_log TO authenticated;
GRANT SELECT, INSERT ON public.ts_label        TO authenticated;
GRANT SELECT ON public.v_ts_daily_usage, public.v_ts_label_agreement TO authenticated;
GRANT EXECUTE ON FUNCTION public.ts_approve_policy(uuid), public.ts_retire_policy(uuid),
                          public.ts_usd_per_mtok() TO authenticated;

-- service_role (the application writer; no TRUNCATE, no DELETE, no UPDATE on the log)
GRANT SELECT                 ON public.ts_policy TO service_role;   -- policies change only via propose + the functions above
GRANT SELECT, INSERT         ON public.ts_decision_log TO service_role;
GRANT SELECT, INSERT         ON public.ts_label TO service_role;
GRANT SELECT ON public.v_ts_daily_usage, public.v_ts_label_agreement TO service_role;
GRANT EXECUTE ON FUNCTION public.ts_purge_answers(integer), public.ts_usd_per_mtok() TO service_role;


-- ============================================================
-- 8. The AI reply slot re-checks who owns the thread
-- ============================================================

-- 029's claim only counted replies. A reply drafted while a second
-- inbound handed the thread off (a triage opt-out, an escalation
-- keyword) or while an agent took it could still claim a slot and go
-- out. The claim is the last step before the send, so it re-checks.
CREATE OR REPLACE FUNCTION public.claim_ai_reply_slot(
  conversation_id uuid,
  max_replies integer
)
RETURNS boolean AS $$
  WITH claimed AS (
    UPDATE conversations
    SET ai_reply_count = ai_reply_count + 1
    WHERE id = conversation_id
      AND ai_reply_count < max_replies
      AND NOT coalesce(ai_autoreply_disabled, false)
      AND assigned_agent_id IS NULL
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.claim_ai_reply_slot(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_reply_slot(uuid, integer) TO service_role;


-- ============================================================
-- 9. Hand-off reasons the layer can cause
-- ============================================================

-- Widen the handoff-reason CHECK (052, 054). Both statements are
-- guarded so a re-run is a no-op once the new definition is in place.
-- The swap takes a brief ACCESS EXCLUSIVE lock on conversations
-- (bounded by the lock_timeout set at the top of the file).
DO $$
DECLARE
  current_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO current_def
    FROM pg_constraint
   WHERE conname = 'conversations_ai_handoff_reason_check';
  IF current_def IS NOT NULL AND current_def NOT LIKE '%''guardrail''%' THEN
    ALTER TABLE conversations
      DROP CONSTRAINT conversations_ai_handoff_reason_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_ai_handoff_reason_check'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_ai_handoff_reason_check
      CHECK (ai_handoff_reason IS NULL OR ai_handoff_reason IN (
        'keyword', 'no_knowledge', 'model', 'error', 'cap', 'triage', 'guardrail'
      ));
  END IF;
END $$;

COMMENT ON COLUMN conversations.ai_handoff_reason IS
  'Which AI gate handed this thread to a human: keyword (escalation list), no_knowledge (retrieval below threshold), model (the LLM asked), error (provider failure), cap (per-conversation reply cap reached), triage (TypeSafe triage routed it to a person, 063), guardrail (TypeSafe held or blocked the draft reply, 063). Mirrors AiHandoffReason in lib/ai/handoff.ts.';

RESET lock_timeout;
