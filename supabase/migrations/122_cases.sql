-- ============================================================
-- 122_cases.sql — case management: one case per submission group,
-- configurable stages, append-only history, live access, group-end
-- claims. Port of module 018c (018c_case.sql + 018c_audit_lock.sql).
--
--  * One case per submission group (cases.group_id UNIQUE, composite
--    FK to 115's submission_groups). case_open is idempotent, also
--    under concurrency: ON CONFLICT DO NOTHING, then a fresh read.
--    Customer, submission ref and number are read from the group by
--    JOIN, never copied. bank_code / product / amount may be NULL (the
--    submission application may not send them).
--  * Banks are per account (case_banks, code ^[A-Z0-9_]{2,32}$).
--    Stages are configurable per (account, bank) in case_bank_stages;
--    a case with no bank, or a bank with no rows, uses
--    case_default_stages(): Submitted, Bank acknowledged, Documents
--    requested, Documents received, Under review, Query raised, Query
--    answered, Approved, Declined, Withdrawn, Closed. Final stages:
--    Approved, Declined, Withdrawn, Closed. Outcome stages: Approved,
--    Declined, Withdrawn. An outcome is set only by a move to (or while
--    at) its matching outcome stage. Unconfigured stages are refused.
--    A list is validated at commit (deferred constraint trigger): the
--    first stage is not final and the four final stages are present,
--    spelled as the defaults.
--  * Roles are resolved LIVE by case_role(case, user) from profiles and
--    teams (never from the caller, never stored on the case):
--      super_admin  live owner of the case's account     read + act + reassign
--      admin        live admin                            read + act + reassign
--      team_lead    live team_leader who leads the team
--                   the case's agent is a member of       read + act + reassign
--      coordinator  cases.coordinator_id, live staff      read + act
--      agent        cases.agent_id, live staff            read + act
--    Rights are the pure rule functions case_rule_can_read / _write /
--    _reassign (a TS mirror is pinned to them — change one, change both).
--  * History: case_stage_history (every stage change, the initial one
--    included), case_reassign_history (one row per reassign, in the
--    same statement), case_detail_log (bank / product / amount changes)
--    and case_view_audit refuse UPDATE / DELETE / TRUNCATE by trigger,
--    the table owner included; cases refuses TRUNCATE. Actor columns
--    hold auth user ids with no FK (history outlives a person); a NULL
--    actor with role 'api' is the v1 API.
--  * Group end exactly once: the first move of a case to a final stage
--    takes the claim (group_end_claimed_at) in the same locked
--    statement and only that call reports end_group = true. The claim
--    value is the token; release / finish act only while the column
--    still equals it. A finished end (group_ended_at) is never released.
--    case_claim_group_end(_system) re-takes a free or stale claim of a
--    case already at a final stage; case_pending_group_end lists them.
--  * case_view_audit is readable by no API role (service_role
--    included), only through case_audit_list (admin / super_admin).
--  * Writes: no role writes any case table, the service role neither;
--    every write is a SECURITY DEFINER case_* function (search_path ''),
--    called by the app on the service role with p_actor = the signed-in
--    user. authenticated reads cases of its active workspace it has a
--    case role on, and the bank lists of its active workspace.
--
-- The SECURITY DEFINER functions read RLS-forced tables, so, as 115,
-- this must be applied by a superuser or BYPASSRLS role.
--
-- Re-runnable: CREATE … IF NOT EXISTS, CREATE OR REPLACE,
-- DROP … IF EXISTS.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '122 must be applied by a superuser or BYPASSRLS role (the case_* functions read RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. Tables ----------

CREATE TABLE IF NOT EXISTS public.case_banks (
  account_id uuid NOT NULL REFERENCES public.accounts(id),
  code       text NOT NULL,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_banks_pkey PRIMARY KEY (account_id, code),
  CONSTRAINT case_banks_code_check CHECK (code ~ '^[A-Z0-9_]{2,32}$'),
  CONSTRAINT case_banks_name_check CHECK (char_length(name) BETWEEN 1 AND 100 AND btrim(name) <> '')
);

COMMENT ON TABLE public.case_banks IS
  'The banks an account files cases with. Written only through case_open / case_bank_upsert. Migration 122.';

CREATE TABLE IF NOT EXISTS public.case_bank_stages (
  account_id uuid    NOT NULL,
  bank_code  text    NOT NULL,
  position   integer NOT NULL,
  stage      text    NOT NULL,
  CONSTRAINT case_bank_stages_pkey PRIMARY KEY (account_id, bank_code, stage),
  CONSTRAINT case_bank_stages_position_uq UNIQUE (account_id, bank_code, position),
  CONSTRAINT case_bank_stages_position_check CHECK (position > 0),
  CONSTRAINT case_bank_stages_stage_check CHECK (btrim(stage) <> '' AND char_length(stage) <= 100),
  CONSTRAINT case_bank_stages_bank_fkey FOREIGN KEY (account_id, bank_code)
    REFERENCES public.case_banks (account_id, code)
);

COMMENT ON TABLE public.case_bank_stages IS
  'An (account, bank) stage list, positions 1..n; no rows = case_default_stages(). Validated at commit. Written only through case_bank_stages_set. Migration 122.';

CREATE TABLE IF NOT EXISTS public.cases (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES public.accounts(id),
  group_id             uuid NOT NULL,
  bank_code            text NULL,
  product              text NULL,
  amount               numeric(18, 2) NULL,  -- AED
  agent_id             uuid NOT NULL,
  coordinator_id       uuid NULL,
  stage                text NOT NULL,
  priority             text NOT NULL DEFAULT 'normal',
  due_at               timestamptz NULL,
  sla_state            text NULL,            -- set by the SLA job (later)
  opened_at            timestamptz NOT NULL DEFAULT now(),
  closed_at            timestamptz NULL,
  outcome              text NULL,
  group_end_claimed_at timestamptz NULL,
  group_ended_at       timestamptz NULL,
  CONSTRAINT cases_one_per_group UNIQUE (group_id),
  CONSTRAINT cases_id_account_key UNIQUE (id, account_id),
  CONSTRAINT cases_group_fkey FOREIGN KEY (group_id, account_id)
    REFERENCES public.submission_groups (id, account_id),
  CONSTRAINT cases_bank_fkey FOREIGN KEY (account_id, bank_code)
    REFERENCES public.case_banks (account_id, code),
  CONSTRAINT cases_product_check CHECK (product IS NULL OR char_length(product) BETWEEN 1 AND 200),
  CONSTRAINT cases_amount_check CHECK (amount IS NULL OR amount >= 0),
  CONSTRAINT cases_priority_check CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  CONSTRAINT cases_outcome_valid CHECK (outcome IS NULL OR outcome IN ('Approved', 'Declined', 'Withdrawn')),
  CONSTRAINT cases_outcome_at_stage CHECK (outcome IS NULL OR stage = outcome OR stage = 'Closed'),
  CONSTRAINT cases_closed_when_final
    CHECK ((closed_at IS NOT NULL) = (stage IN ('Approved', 'Declined', 'Withdrawn', 'Closed')))
);

CREATE INDEX IF NOT EXISTS cases_account_agent_idx ON public.cases (account_id, agent_id);
CREATE INDEX IF NOT EXISTS cases_account_coordinator_idx ON public.cases (account_id, coordinator_id)
  WHERE coordinator_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cases_account_bank_idx ON public.cases (account_id, bank_code)
  WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS cases_pending_group_end_idx ON public.cases (closed_at)
  WHERE closed_at IS NOT NULL AND group_ended_at IS NULL;

COMMENT ON TABLE public.cases IS
  'One case per submission group. Roles are computed live (case_role); written only through the case_* functions. Migration 122.';
COMMENT ON COLUMN public.cases.group_end_claimed_at IS
  'The group-end claim; its value is the claim token. Release / finish act only while it equals the token.';
COMMENT ON COLUMN public.cases.group_ended_at IS
  'When the submission group was ended for this case; the claim is never released afterwards.';

CREATE TABLE IF NOT EXISTS public.case_stage_history (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id    uuid NOT NULL,
  account_id uuid NOT NULL,
  from_stage text NULL,
  to_stage   text NOT NULL,
  outcome    text NULL,
  actor_id   uuid NULL,   -- auth user id; NULL = the v1 API
  actor_role text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_stage_history_case_fkey FOREIGN KEY (case_id, account_id)
    REFERENCES public.cases (id, account_id)
);
CREATE INDEX IF NOT EXISTS case_stage_history_case_idx ON public.case_stage_history (case_id, id);

CREATE TABLE IF NOT EXISTS public.case_reassign_history (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id    uuid NOT NULL,
  account_id uuid NOT NULL,
  field      text NOT NULL,
  from_user  uuid NULL,
  to_user    uuid NOT NULL,
  actor_id   uuid NOT NULL,
  actor_role text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_reassign_history_field_check CHECK (field IN ('agent', 'coordinator')),
  CONSTRAINT case_reassign_history_case_fkey FOREIGN KEY (case_id, account_id)
    REFERENCES public.cases (id, account_id)
);
CREATE INDEX IF NOT EXISTS case_reassign_history_case_idx ON public.case_reassign_history (case_id, id);

CREATE TABLE IF NOT EXISTS public.case_detail_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id    uuid NOT NULL,
  account_id uuid NOT NULL,
  field      text NOT NULL,
  from_value text NULL,
  to_value   text NULL,
  actor_id   uuid NULL,   -- NULL = the v1 API
  actor_role text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_detail_log_case_fkey FOREIGN KEY (case_id, account_id)
    REFERENCES public.cases (id, account_id)
);
CREATE INDEX IF NOT EXISTS case_detail_log_case_idx ON public.case_detail_log (case_id, id);
-- Dropped and re-added by name so a re-run widens a table made with the shorter list.
ALTER TABLE public.case_detail_log DROP CONSTRAINT IF EXISTS case_detail_log_field_check;
ALTER TABLE public.case_detail_log ADD CONSTRAINT case_detail_log_field_check
  CHECK (field IN ('bank_code', 'product', 'amount', 'priority', 'due_at'));

CREATE TABLE IF NOT EXISTS public.case_view_audit (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id     uuid NOT NULL,
  account_id  uuid NOT NULL,
  viewer_id   uuid NOT NULL,
  viewer_role text NOT NULL,
  viewed_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_view_audit_case_fkey FOREIGN KEY (case_id, account_id)
    REFERENCES public.cases (id, account_id)
);
CREATE INDEX IF NOT EXISTS case_view_audit_case_idx ON public.case_view_audit (case_id, id);

COMMENT ON TABLE public.case_view_audit IS
  'One row per supervisor / admin view of a case (view_case). Readable by no API role; only through case_audit_list. Append-only. Migration 122.';

-- ---------- 2. Roles and rules ----------

-- The account-level case role of a live, non-guest profile: owner ->
-- super_admin, admin, team_leader -> team_lead, agent; else NULL
-- (viewer, bank_guest, deactivated, unknown, NULL user).
CREATE OR REPLACE FUNCTION public.case_account_role(p_account uuid, p_user uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE p.account_role::text
           WHEN 'owner'       THEN 'super_admin'
           WHEN 'admin'       THEN 'admin'
           WHEN 'team_leader' THEN 'team_lead'
           WHEN 'agent'       THEN 'agent'
         END
    FROM public.profiles p
   WHERE p.user_id = p_user AND p.account_id = p_account
     AND p.deactivated_at IS NULL
     AND p.account_role <> 'bank_guest'
$$;

-- THE role resolver: p_user's role on the case, live, or NULL. A
-- profile holds a role only in the case's own account; owner/admin
-- outrank a team lead, who outranks coordinator / agent.
CREATE OR REPLACE FUNCTION public.case_role(p_case uuid, p_user uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
           WHEN p.account_role = 'owner' THEN 'super_admin'
           WHEN p.account_role = 'admin' THEN 'admin'
           WHEN p.account_role = 'team_leader'
                AND EXISTS (SELECT 1 FROM public.teams t
                              JOIN public.team_members m ON m.team_id = t.id
                             WHERE t.account_id = c.account_id AND m.account_id = c.account_id
                               AND m.user_id = c.agent_id AND t.leader_user_id = p_user)
             THEN 'team_lead'
           WHEN p.account_role IN ('agent', 'team_leader') AND c.coordinator_id = p_user THEN 'coordinator'
           WHEN p.account_role IN ('agent', 'team_leader') AND c.agent_id = p_user THEN 'agent'
         END
    FROM public.cases c
    JOIN public.profiles p
      ON p.user_id = p_user AND p.account_id = c.account_id
     AND p.deactivated_at IS NULL AND p.account_role <> 'bank_guest'
   WHERE c.id = p_case
$$;

-- Pure rules of a case role (TS mirror pinned to these).
CREATE OR REPLACE FUNCTION public.case_rule_can_read(p_role text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$ SELECT p_role IS NOT NULL $$;

CREATE OR REPLACE FUNCTION public.case_rule_can_write(p_role text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$ SELECT coalesce(p_role IN ('super_admin', 'admin', 'team_lead', 'coordinator', 'agent'), false) $$;

CREATE OR REPLACE FUNCTION public.case_rule_can_reassign(p_role text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$ SELECT coalesce(p_role IN ('super_admin', 'admin', 'team_lead'), false) $$;

CREATE OR REPLACE FUNCTION public.case_can_read(p_case uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT public.case_rule_can_read(public.case_role(p_case, p_user)) $$;

CREATE OR REPLACE FUNCTION public.case_can_write(p_case uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT public.case_rule_can_write(public.case_role(p_case, p_user)) $$;

-- The RLS row check: the caller's own role on the case. Takes no user
-- argument, so authenticated learns nothing about anyone else.
CREATE OR REPLACE FUNCTION public.case_rls_can_read(p_case uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT public.case_role(p_case, auth.uid()) IS NOT NULL $$;

-- ---------- 3. Stages ----------

CREATE OR REPLACE FUNCTION public.case_default_stages()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$ SELECT ARRAY['Submitted', 'Bank acknowledged', 'Documents requested', 'Documents received', 'Under review',
  'Query raised', 'Query answered', 'Approved', 'Declined', 'Withdrawn', 'Closed']::text[] $$;

-- The (account, bank) list; the default list for a NULL bank or a bank
-- with no rows.
CREATE OR REPLACE FUNCTION public.case_stages_for_bank(p_account uuid, p_bank_code text)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce((SELECT array_agg(s.stage ORDER BY s.position) FROM public.case_bank_stages s
                    WHERE s.account_id = p_account AND s.bank_code = p_bank_code),
                  public.case_default_stages())
$$;

-- ---------- 4. Integrity (every writer) ----------

CREATE OR REPLACE FUNCTION public.case_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'public.% is append-only (% refused)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE OR REPLACE FUNCTION public.case_view_audit_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.viewer_role IS DISTINCT FROM public.case_role(NEW.case_id, NEW.viewer_id)
     OR NEW.viewer_role NOT IN ('coordinator', 'team_lead', 'admin', 'super_admin') THEN
    RAISE EXCEPTION 'case view of % by % (%) not allowed', NEW.case_id, NEW.viewer_id, NEW.viewer_role
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- Deferred (commit-time) check of one (account, bank) stage list: the
-- first stage is not final; the four final stages are all present,
-- spelled exactly as the defaults.
CREATE OR REPLACE FUNCTION public.case_bank_stages_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account uuid;
  v_bank    text;
  v_stages  text[];
  f         text;
  i         integer;
BEGIN
  FOR i IN 1 .. 2 LOOP
    IF i = 1 THEN
      CONTINUE WHEN TG_OP = 'INSERT';
      v_account := OLD.account_id; v_bank := OLD.bank_code;
    ELSE
      CONTINUE WHEN TG_OP = 'DELETE';
      v_account := NEW.account_id; v_bank := NEW.bank_code;
    END IF;
    SELECT array_agg(s.stage ORDER BY s.position) INTO v_stages FROM public.case_bank_stages s
     WHERE s.account_id = v_account AND s.bank_code = v_bank;
    CONTINUE WHEN v_stages IS NULL;  -- no rows: the default list
    IF lower(v_stages[1]) IN ('approved', 'declined', 'withdrawn', 'closed') THEN
      RAISE EXCEPTION 'bank %: the first stage % is a final stage', v_bank, v_stages[1]
        USING ERRCODE = 'check_violation', HINT = 'BANK_STAGES_FIRST_FINAL';
    END IF;
    FOREACH f IN ARRAY ARRAY['Approved', 'Declined', 'Withdrawn', 'Closed'] LOOP
      IF NOT (f = ANY (v_stages)) THEN
        IF EXISTS (SELECT 1 FROM unnest(v_stages) x WHERE lower(x) = lower(f)) THEN
          RAISE EXCEPTION 'bank %: final stage % must be spelled %', v_bank, f, f
            USING ERRCODE = 'check_violation', HINT = 'BANK_STAGES_FINAL_SPELLING';
        END IF;
        RAISE EXCEPTION 'bank %: final stage % is missing', v_bank, f
          USING ERRCODE = 'check_violation', HINT = 'BANK_STAGES_MISSING_FINAL';
      END IF;
    END LOOP;
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS case_bank_stages_valid ON public.case_bank_stages;
CREATE CONSTRAINT TRIGGER case_bank_stages_valid
  AFTER INSERT OR UPDATE OR DELETE ON public.case_bank_stages
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.case_bank_stages_check();

DROP TRIGGER IF EXISTS case_stage_history_append_only ON public.case_stage_history;
CREATE TRIGGER case_stage_history_append_only
  BEFORE UPDATE OR DELETE ON public.case_stage_history
  FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS case_stage_history_no_truncate ON public.case_stage_history;
CREATE TRIGGER case_stage_history_no_truncate
  BEFORE TRUNCATE ON public.case_stage_history
  FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();

DROP TRIGGER IF EXISTS case_reassign_history_append_only ON public.case_reassign_history;
CREATE TRIGGER case_reassign_history_append_only
  BEFORE UPDATE OR DELETE ON public.case_reassign_history
  FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS case_reassign_history_no_truncate ON public.case_reassign_history;
CREATE TRIGGER case_reassign_history_no_truncate
  BEFORE TRUNCATE ON public.case_reassign_history
  FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();

DROP TRIGGER IF EXISTS case_detail_log_append_only ON public.case_detail_log;
CREATE TRIGGER case_detail_log_append_only
  BEFORE UPDATE OR DELETE ON public.case_detail_log
  FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS case_detail_log_no_truncate ON public.case_detail_log;
CREATE TRIGGER case_detail_log_no_truncate
  BEFORE TRUNCATE ON public.case_detail_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();

DROP TRIGGER IF EXISTS case_view_audit_check ON public.case_view_audit;
CREATE TRIGGER case_view_audit_check
  BEFORE INSERT ON public.case_view_audit
  FOR EACH ROW EXECUTE FUNCTION public.case_view_audit_check();
DROP TRIGGER IF EXISTS case_view_audit_append_only ON public.case_view_audit;
CREATE TRIGGER case_view_audit_append_only
  BEFORE UPDATE OR DELETE ON public.case_view_audit
  FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS case_view_audit_no_truncate ON public.case_view_audit;
CREATE TRIGGER case_view_audit_no_truncate
  BEFORE TRUNCATE ON public.case_view_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();

DROP TRIGGER IF EXISTS cases_no_truncate ON public.cases;
CREATE TRIGGER cases_no_truncate
  BEFORE TRUNCATE ON public.cases
  FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();

-- ---------- 5. Writes (the only write paths; service role) ----------

-- Fills the NULL bank_code / product / amount of a locked case from the
-- given values (never overwrites), one case_detail_log row per filled
-- field. Internal to case_open's repeat call, which comes from the v1
-- API and must never fail over a gap it cannot fill: a bank whose stage
-- list lacks the case's current stage is simply not filled (bank_code
-- stays NULL, nothing logged), while product / amount still are. Staff
-- set such a bank through case_set_details, which refuses it with
-- STAGE_NOT_IN_LIST.
CREATE OR REPLACE FUNCTION public.case_fill_details(p_case uuid, p_bank_code text, p_product text,
  p_amount numeric, p_actor uuid, p_role text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c public.cases%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.cases WHERE id = p_case FOR UPDATE;
  IF c.bank_code IS NULL AND p_bank_code IS NOT NULL THEN
    PERFORM 1 FROM public.case_banks b WHERE b.account_id = c.account_id AND b.code = p_bank_code FOR SHARE;
    IF c.stage = ANY (public.case_stages_for_bank(c.account_id, p_bank_code)) THEN
      UPDATE public.cases SET bank_code = p_bank_code WHERE id = p_case;
      INSERT INTO public.case_detail_log (case_id, account_id, field, from_value, to_value, actor_id, actor_role)
      VALUES (p_case, c.account_id, 'bank_code', NULL, p_bank_code, p_actor, p_role);
    END IF;
  END IF;
  IF c.product IS NULL AND p_product IS NOT NULL THEN
    UPDATE public.cases SET product = p_product WHERE id = p_case;
    INSERT INTO public.case_detail_log (case_id, account_id, field, from_value, to_value, actor_id, actor_role)
    VALUES (p_case, c.account_id, 'product', NULL, p_product, p_actor, p_role);
  END IF;
  IF c.amount IS NULL AND p_amount IS NOT NULL THEN
    UPDATE public.cases SET amount = p_amount WHERE id = p_case;
    INSERT INTO public.case_detail_log (case_id, account_id, field, from_value, to_value, actor_id, actor_role)
    VALUES (p_case, c.account_id, 'amount', NULL, round(p_amount, 2)::text, p_actor, p_role);
  END IF;
END;
$$;

-- Opens the case of a submission group, idempotent per group. Returns
-- (case_id, created): created is true only for the call that inserted
-- the case. A repeat call fills only a NULL bank_code / product /
-- amount (case_detail_log), never overwrites, and never fails over a
-- fill: a bank whose list lacks the case's stage is left unfilled. p_bank_code unknown in
-- the group's account is added to case_banks (name = p_bank_name, else
-- the code). agent_id = the group's open 'agent' access row (NO_AGENT
-- if none), coordinator_id = the open 'coordinator' row or NULL.
-- Initial stage = the first stage of the (account, bank) list. p_actor
-- NULL = the v1 API (history actor NULL, role 'api'); otherwise an
-- owner/admin of the account (NOT_ALLOWED).
CREATE OR REPLACE FUNCTION public.case_open(p_group uuid, p_bank_code text, p_bank_name text,
  p_product text, p_amount numeric, p_actor uuid)
RETURNS TABLE (case_id uuid, created boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account uuid;
  v_role    text := 'api';
  v_agent   uuid;
  v_coord   uuid;
  v_stage   text;
  v_id      uuid;
BEGIN
  SELECT g.account_id INTO v_account FROM public.submission_groups g WHERE g.id = p_group;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'submission group % not found', p_group USING ERRCODE = 'no_data_found', HINT = 'GROUP_NOT_FOUND';
  END IF;
  IF p_actor IS NOT NULL THEN
    v_role := public.case_account_role(v_account, p_actor);
    IF v_role IS NULL OR v_role NOT IN ('super_admin', 'admin') THEN
      RAISE EXCEPTION 'group %: % may not open its case', p_group, p_actor
        USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
    END IF;
  END IF;
  IF p_bank_code IS NOT NULL THEN
    INSERT INTO public.case_banks (account_id, code, name)
    VALUES (v_account, p_bank_code, coalesce(nullif(btrim(p_bank_name), ''), p_bank_code))
    ON CONFLICT ON CONSTRAINT case_banks_pkey DO NOTHING;
  END IF;

  SELECT x.id INTO v_id FROM public.cases x WHERE x.group_id = p_group;
  IF v_id IS NULL THEN
    SELECT a.user_id INTO v_agent FROM public.submission_group_access a
     WHERE a.group_id = p_group AND a.label = 'agent' AND a.removed_at IS NULL
     ORDER BY a.added_at, a.id LIMIT 1;
    IF v_agent IS NULL THEN
      RAISE EXCEPTION 'submission group % has no agent on its access list', p_group
        USING ERRCODE = 'object_not_in_prerequisite_state', HINT = 'NO_AGENT';
    END IF;
    SELECT a.user_id INTO v_coord FROM public.submission_group_access a
     WHERE a.group_id = p_group AND a.label = 'coordinator' AND a.removed_at IS NULL
     ORDER BY a.added_at, a.id LIMIT 1;
    IF p_bank_code IS NOT NULL THEN
      PERFORM 1 FROM public.case_banks b WHERE b.account_id = v_account AND b.code = p_bank_code FOR SHARE;
    END IF;
    v_stage := (public.case_stages_for_bank(v_account, p_bank_code))[1];
    INSERT INTO public.cases AS c (account_id, group_id, bank_code, product, amount, agent_id, coordinator_id, stage)
    VALUES (v_account, p_group, p_bank_code, p_product, p_amount, v_agent, v_coord, v_stage)
    ON CONFLICT ON CONSTRAINT cases_one_per_group DO NOTHING
    RETURNING c.id INTO v_id;
    IF v_id IS NOT NULL THEN
      INSERT INTO public.case_stage_history (case_id, account_id, from_stage, to_stage, actor_id, actor_role)
      VALUES (v_id, v_account, NULL, v_stage, p_actor, v_role);
      RETURN QUERY SELECT v_id, true;
      RETURN;
    END IF;
    -- Lost a concurrent open: the other call's row, read fresh.
    SELECT x.id INTO v_id FROM public.cases x WHERE x.group_id = p_group;
  END IF;
  PERFORM public.case_fill_details(v_id, p_bank_code, p_product, p_amount, p_actor, v_role);
  RETURN QUERY SELECT v_id, false;
END;
$$;

-- Sets the given details (NULL = leave unchanged) for anyone who may act
-- on the case. A bank must exist in case_banks (BANK_UNKNOWN) and hold
-- the case's current stage (STAGE_NOT_IN_LIST). One case_detail_log row
-- per changed field. Returns the changed field names (empty: nothing
-- changed).
CREATE OR REPLACE FUNCTION public.case_set_details(p_case uuid, p_actor uuid, p_bank_code text,
  p_product text, p_amount numeric)
RETURNS text[]
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c         public.cases%ROWTYPE;
  v_role    text;
  v_changed text[] := '{}';
BEGIN
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case USING ERRCODE = 'no_data_found', HINT = 'CASE_NOT_FOUND';
  END IF;
  v_role := public.case_role(p_case, p_actor);
  IF NOT public.case_rule_can_write(v_role) THEN
    RAISE EXCEPTION 'case %: % may not change its details', p_case, p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  IF p_bank_code IS NOT NULL AND p_bank_code IS DISTINCT FROM c.bank_code THEN
    PERFORM 1 FROM public.case_banks b WHERE b.account_id = c.account_id AND b.code = p_bank_code FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'bank % is not a bank of this workspace', p_bank_code
        USING ERRCODE = 'check_violation', HINT = 'BANK_UNKNOWN';
    END IF;
    IF NOT (c.stage = ANY (public.case_stages_for_bank(c.account_id, p_bank_code))) THEN
      RAISE EXCEPTION 'case %: stage % is not in bank %''s list', p_case, c.stage, p_bank_code
        USING ERRCODE = 'check_violation', HINT = 'STAGE_NOT_IN_LIST';
    END IF;
    UPDATE public.cases SET bank_code = p_bank_code WHERE id = p_case;
    INSERT INTO public.case_detail_log (case_id, account_id, field, from_value, to_value, actor_id, actor_role)
    VALUES (p_case, c.account_id, 'bank_code', c.bank_code, p_bank_code, p_actor, v_role);
    v_changed := v_changed || 'bank_code'::text;
  END IF;
  IF p_product IS NOT NULL AND p_product IS DISTINCT FROM c.product THEN
    UPDATE public.cases SET product = p_product WHERE id = p_case;
    INSERT INTO public.case_detail_log (case_id, account_id, field, from_value, to_value, actor_id, actor_role)
    VALUES (p_case, c.account_id, 'product', c.product, p_product, p_actor, v_role);
    v_changed := v_changed || 'product'::text;
  END IF;
  IF p_amount IS NOT NULL AND round(p_amount, 2) IS DISTINCT FROM c.amount THEN
    UPDATE public.cases SET amount = p_amount WHERE id = p_case;
    INSERT INTO public.case_detail_log (case_id, account_id, field, from_value, to_value, actor_id, actor_role)
    VALUES (p_case, c.account_id, 'amount', c.amount::text, round(p_amount, 2)::text, p_actor, v_role);
    v_changed := v_changed || 'amount'::text;
  END IF;
  RETURN v_changed;
END;
$$;

-- Sets the case's priority (low | normal | high | urgent) for anyone who
-- may act on the case, closed cases included. Returns true when it
-- changed (one case_detail_log row), false for the same value.
CREATE OR REPLACE FUNCTION public.case_set_priority(p_case uuid, p_actor uuid, p_priority text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c      public.cases%ROWTYPE;
  v_role text;
BEGIN
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case USING ERRCODE = 'no_data_found', HINT = 'CASE_NOT_FOUND';
  END IF;
  v_role := public.case_role(p_case, p_actor);
  IF NOT public.case_rule_can_write(v_role) THEN
    RAISE EXCEPTION 'case %: % may not change its priority', p_case, p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  IF p_priority IS NULL OR p_priority NOT IN ('low', 'normal', 'high', 'urgent') THEN
    RAISE EXCEPTION 'priority % is not low, normal, high or urgent', p_priority
      USING ERRCODE = 'check_violation', HINT = 'PRIORITY_INVALID';
  END IF;
  IF p_priority = c.priority THEN
    RETURN false;
  END IF;
  UPDATE public.cases SET priority = p_priority WHERE id = p_case;
  INSERT INTO public.case_detail_log (case_id, account_id, field, from_value, to_value, actor_id, actor_role)
  VALUES (p_case, c.account_id, 'priority', c.priority, p_priority, p_actor, v_role);
  RETURN true;
END;
$$;

-- Sets or clears (NULL) the case's due date for anyone who may act on the
-- case, closed cases included. Returns true when it changed (one
-- case_detail_log row, from / to as ISO text in UTC), false otherwise.
CREATE OR REPLACE FUNCTION public.case_set_due(p_case uuid, p_actor uuid, p_due_at timestamptz)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c      public.cases%ROWTYPE;
  v_role text;
BEGIN
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case USING ERRCODE = 'no_data_found', HINT = 'CASE_NOT_FOUND';
  END IF;
  v_role := public.case_role(p_case, p_actor);
  IF NOT public.case_rule_can_write(v_role) THEN
    RAISE EXCEPTION 'case %: % may not change its due date', p_case, p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  IF p_due_at IN ('infinity'::timestamptz, '-infinity'::timestamptz) THEN
    RAISE EXCEPTION 'due date % is not a date', p_due_at
      USING ERRCODE = 'check_violation', HINT = 'DUE_INVALID';
  END IF;
  IF p_due_at IS NOT DISTINCT FROM c.due_at THEN
    RETURN false;
  END IF;
  UPDATE public.cases SET due_at = p_due_at WHERE id = p_case;
  INSERT INTO public.case_detail_log (case_id, account_id, field, from_value, to_value, actor_id, actor_role)
  VALUES (p_case, c.account_id, 'due_at',
    to_char(c.due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    to_char(p_due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), p_actor, v_role);
  RETURN true;
END;
$$;

-- Moves a case to p_to_stage as p_actor. Same stage: no-op (moved =
-- false). end_group is true only for the call that moved the case to a
-- final stage while the group-end claim was free and p_claim is true;
-- claim_token is the group_end_claimed_at it set (NULL otherwise).
CREATE OR REPLACE FUNCTION public.case_set_stage(p_case uuid, p_actor uuid, p_to_stage text,
  p_outcome text DEFAULT NULL, p_claim boolean DEFAULT true)
RETURNS TABLE (moved boolean, from_stage text, to_stage text, outcome text, end_group boolean, claim_token timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c         public.cases%ROWTYPE;
  v_role    text;
  v_final   boolean;
  v_outcome text;
  v_claim   boolean;
  v_token   timestamptz;
BEGIN
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case USING ERRCODE = 'no_data_found', HINT = 'CASE_NOT_FOUND';
  END IF;
  v_role := public.case_role(p_case, p_actor);
  IF NOT public.case_rule_can_write(v_role) THEN
    RAISE EXCEPTION 'case %: % may not change the stage', p_case, p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  IF c.bank_code IS NOT NULL THEN
    -- Holds off case_bank_stages_set until this move commits.
    PERFORM 1 FROM public.case_banks b WHERE b.account_id = c.account_id AND b.code = c.bank_code FOR SHARE;
  END IF;
  IF p_to_stage IS NULL OR NOT (p_to_stage = ANY (public.case_stages_for_bank(c.account_id, c.bank_code))) THEN
    RAISE EXCEPTION 'stage % is not configured for bank %', p_to_stage, coalesce(c.bank_code, '(default)')
      USING ERRCODE = 'check_violation', HINT = 'STAGE_NOT_CONFIGURED';
  END IF;
  IF p_outcome IS NOT NULL AND p_outcome NOT IN ('Approved', 'Declined', 'Withdrawn') THEN
    RAISE EXCEPTION 'outcome % is not an outcome', p_outcome USING ERRCODE = 'check_violation', HINT = 'OUTCOME_INVALID';
  END IF;
  IF p_outcome IS NOT NULL AND p_outcome <> p_to_stage THEN
    RAISE EXCEPTION 'outcome % requires stage %', p_outcome, p_outcome
      USING ERRCODE = 'check_violation', HINT = 'OUTCOME_STAGE_MISMATCH';
  END IF;
  IF p_to_stage = c.stage THEN
    RETURN QUERY SELECT false, c.stage, c.stage, c.outcome, false, NULL::timestamptz;
    RETURN;
  END IF;
  IF c.stage = 'Closed' THEN
    RAISE EXCEPTION 'case % is closed', p_case USING ERRCODE = 'check_violation', HINT = 'CASE_CLOSED';
  END IF;
  IF c.stage IN ('Approved', 'Declined', 'Withdrawn') AND p_to_stage <> 'Closed' THEN
    RAISE EXCEPTION 'case % is at final stage %', p_case, c.stage USING ERRCODE = 'check_violation', HINT = 'FINAL_STAGE';
  END IF;
  v_final := p_to_stage IN ('Approved', 'Declined', 'Withdrawn', 'Closed');
  v_outcome := CASE WHEN p_to_stage IN ('Approved', 'Declined', 'Withdrawn') THEN p_to_stage ELSE c.outcome END;
  v_claim := v_final AND coalesce(p_claim, true) AND c.group_end_claimed_at IS NULL AND c.group_ended_at IS NULL;
  v_token := CASE WHEN v_claim THEN now() END;
  UPDATE public.cases x
     SET stage = p_to_stage,
         outcome = v_outcome,
         closed_at = CASE WHEN v_final THEN coalesce(x.closed_at, now()) ELSE NULL END,
         group_end_claimed_at = CASE WHEN v_claim THEN v_token ELSE x.group_end_claimed_at END
   WHERE x.id = p_case;
  INSERT INTO public.case_stage_history (case_id, account_id, from_stage, to_stage, outcome, actor_id, actor_role)
  VALUES (p_case, c.account_id, c.stage, p_to_stage, v_outcome, p_actor, v_role);
  RETURN QUERY SELECT true, c.stage, p_to_stage, v_outcome, v_claim, v_token;
END;
$$;

-- The submission application reported a final status (v1 PATCH, which
-- already ended the group through 115): APPROVED / DECLINED / WITHDRAWN
-- / CLOSED move the group's case, if any and not at a final stage, to
-- Approved / Declined / Withdrawn / Closed (outcome for the first
-- three), history actor NULL / 'api', without taking a claim.
-- group_ended_at is recorded only when the linked submission group is
-- actually ENDED (115); while it is still ACTIVE (the PATCH's endIfDue
-- lost a race) it stays NULL, so case_pending_group_end lists the case
-- and the sweeper ends the group later. Anything else is a no-op. True
-- if it moved the case.
CREATE OR REPLACE FUNCTION public.case_apply_submission_status(p_group uuid, p_status text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c       public.cases%ROWTYPE;
  v_stage text;
BEGIN
  v_stage := CASE upper(btrim(coalesce(p_status, '')))
               WHEN 'APPROVED'  THEN 'Approved'
               WHEN 'DECLINED'  THEN 'Declined'
               WHEN 'WITHDRAWN' THEN 'Withdrawn'
               WHEN 'CLOSED'    THEN 'Closed'
             END;
  IF v_stage IS NULL THEN
    RETURN false;
  END IF;
  SELECT * INTO c FROM public.cases x WHERE x.group_id = p_group FOR UPDATE;
  IF NOT FOUND OR c.closed_at IS NOT NULL THEN
    RETURN false;
  END IF;
  UPDATE public.cases x
     SET stage = v_stage,
         outcome = CASE WHEN v_stage = 'Closed' THEN x.outcome ELSE v_stage END,
         closed_at = now(),
         group_ended_at = coalesce(x.group_ended_at,
           (SELECT g.ended_at FROM public.submission_groups g
             WHERE g.id = c.group_id AND g.status = 'ENDED'))
   WHERE x.id = c.id;
  INSERT INTO public.case_stage_history (case_id, account_id, from_stage, to_stage, outcome, actor_id, actor_role)
  VALUES (c.id, c.account_id, c.stage, v_stage,
          CASE WHEN v_stage = 'Closed' THEN c.outcome ELSE v_stage END, NULL, 'api');
  RETURN true;
END;
$$;

-- Gives the claim back after a failed end. No-op unless the column still
-- equals p_token and the end has not completed; a NULL token releases
-- nothing.
CREATE OR REPLACE FUNCTION public.case_release_group_end(p_case uuid, p_token timestamptz)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH u AS (UPDATE public.cases x SET group_end_claimed_at = NULL
              WHERE x.id = p_case AND x.group_end_claimed_at = p_token AND x.group_ended_at IS NULL
             RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u)
$$;

-- Records a successful end for the claim holder; the claim stays set
-- for good. No-op unless the column still equals p_token.
CREATE OR REPLACE FUNCTION public.case_finish_group_end(p_case uuid, p_token timestamptz)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH u AS (UPDATE public.cases x SET group_ended_at = now()
              WHERE x.id = p_case AND x.group_end_claimed_at = p_token AND x.group_ended_at IS NULL
             RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u)
$$;

-- Takes the claim of a case already at a final stage (Closed included)
-- when the end has not completed and the claim is free or older than
-- p_stale_after. The cron sweeper's path (no actor). state: CLAIMED,
-- NOT_FINAL, ALREADY_ENDED, CLAIM_HELD; claim_token set when CLAIMED.
CREATE OR REPLACE FUNCTION public.case_claim_group_end_system(p_case uuid,
  p_stale_after interval DEFAULT interval '15 minutes')
RETURNS TABLE (claimed boolean, stage text, state text, claim_token timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c public.cases%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case USING ERRCODE = 'no_data_found', HINT = 'CASE_NOT_FOUND';
  END IF;
  IF c.stage NOT IN ('Approved', 'Declined', 'Withdrawn', 'Closed') THEN
    RETURN QUERY SELECT false, c.stage, 'NOT_FINAL'::text, NULL::timestamptz;
    RETURN;
  END IF;
  IF c.group_ended_at IS NOT NULL THEN
    RETURN QUERY SELECT false, c.stage, 'ALREADY_ENDED'::text, NULL::timestamptz;
    RETURN;
  END IF;
  IF c.group_end_claimed_at IS NOT NULL
     AND c.group_end_claimed_at >= now() - coalesce(p_stale_after, interval '15 minutes') THEN
    RETURN QUERY SELECT false, c.stage, 'CLAIM_HELD'::text, NULL::timestamptz;
    RETURN;
  END IF;
  UPDATE public.cases x SET group_end_claimed_at = now() WHERE x.id = p_case;
  RETURN QUERY SELECT true, c.stage, 'CLAIMED'::text, now();
END;
$$;

-- The retry path of a person: the same claim, for someone who may act
-- on the case (NOT_ALLOWED otherwise).
CREATE OR REPLACE FUNCTION public.case_claim_group_end(p_case uuid, p_actor uuid,
  p_stale_after interval DEFAULT interval '15 minutes')
RETURNS TABLE (claimed boolean, stage text, state text, claim_token timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM 1 FROM public.cases x WHERE x.id = p_case FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case USING ERRCODE = 'no_data_found', HINT = 'CASE_NOT_FOUND';
  END IF;
  IF NOT public.case_rule_can_write(public.case_role(p_case, p_actor)) THEN
    RAISE EXCEPTION 'case %: % may not end the group', p_case, p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  RETURN QUERY SELECT * FROM public.case_claim_group_end_system(p_case, p_stale_after);
END;
$$;

-- Final-stage cases whose group end has not completed and whose claim
-- is free or older than p_stale_after, across all accounts, oldest
-- close first.
CREATE OR REPLACE FUNCTION public.case_pending_group_end(
  p_stale_after interval DEFAULT interval '15 minutes', p_limit int DEFAULT 100)
RETURNS TABLE (case_id uuid, account_id uuid, group_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT c.id, c.account_id, c.group_id
    FROM public.cases c
   WHERE c.closed_at IS NOT NULL AND c.group_ended_at IS NULL
     AND (c.group_end_claimed_at IS NULL
          OR c.group_end_claimed_at < now() - coalesce(p_stale_after, interval '15 minutes'))
   ORDER BY c.closed_at, c.id
   LIMIT greatest(coalesce(p_limit, 100), 0)
$$;

-- Reassigns the agent or coordinator in one logged statement. Allowed
-- for case_rule_can_reassign. The new user must be live staff (agent and
-- up) of the account; a team_lead may only make agent someone in a team
-- they lead. The submission group's access list is not touched.
CREATE OR REPLACE FUNCTION public.case_reassign(p_case uuid, p_actor uuid, p_field text, p_to_user uuid)
RETURNS TABLE (changed boolean, from_user uuid, to_user uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c      public.cases%ROWTYPE;
  v_role text;
  v_from uuid;
BEGIN
  IF p_field IS NULL OR p_field NOT IN ('agent', 'coordinator') THEN
    RAISE EXCEPTION 'reassign field % is not agent or coordinator', p_field
      USING ERRCODE = 'check_violation', HINT = 'ASSIGNEE_INVALID';
  END IF;
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case USING ERRCODE = 'no_data_found', HINT = 'CASE_NOT_FOUND';
  END IF;
  v_role := public.case_role(p_case, p_actor);
  IF NOT public.case_rule_can_reassign(v_role) THEN
    RAISE EXCEPTION 'case %: % may not reassign', p_case, p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  IF p_to_user IS NULL OR public.case_account_role(c.account_id, p_to_user) IS NULL THEN
    RAISE EXCEPTION 'user % is not live staff of this workspace', p_to_user
      USING ERRCODE = 'check_violation', HINT = 'ASSIGNEE_INVALID';
  END IF;
  IF v_role = 'team_lead' AND p_field = 'agent'
     AND NOT EXISTS (SELECT 1 FROM public.teams t JOIN public.team_members m ON m.team_id = t.id
                      WHERE t.account_id = c.account_id AND m.account_id = c.account_id
                        AND m.user_id = p_to_user AND t.leader_user_id = p_actor) THEN
    RAISE EXCEPTION 'user % is not in a team % leads', p_to_user, p_actor
      USING ERRCODE = 'check_violation', HINT = 'ASSIGNEE_INVALID';
  END IF;
  v_from := CASE p_field WHEN 'agent' THEN c.agent_id ELSE c.coordinator_id END;
  IF v_from IS NOT DISTINCT FROM p_to_user THEN
    RETURN QUERY SELECT false, v_from, p_to_user;
    RETURN;
  END IF;
  WITH u AS (
    UPDATE public.cases x
       SET agent_id = CASE WHEN p_field = 'agent' THEN p_to_user ELSE x.agent_id END,
           coordinator_id = CASE WHEN p_field = 'coordinator' THEN p_to_user ELSE x.coordinator_id END
     WHERE x.id = p_case
    RETURNING x.id, x.account_id
  )
  INSERT INTO public.case_reassign_history (case_id, account_id, field, from_user, to_user, actor_id, actor_role)
  SELECT u.id, u.account_id, p_field, v_from, p_to_user, p_actor, v_role FROM u;
  RETURN QUERY SELECT true, v_from, p_to_user;
END;
$$;

-- Records views of cases: returns the ids p_actor may read. One audit
-- row per readable case (duplicates collapsed) for a coordinator,
-- team lead, admin or super admin; an agent's view is not audited;
-- unreadable cases leave no row.
CREATE OR REPLACE FUNCTION public.view_case(p_actor uuid, p_case_ids uuid[])
RETURNS SETOF uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_actor IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
    WITH ok AS (
      SELECT c.id, c.account_id, public.case_role(c.id, p_actor) AS viewer_role
        FROM public.cases c WHERE c.id = ANY (p_case_ids)
    ), ins AS (
      INSERT INTO public.case_view_audit (case_id, account_id, viewer_id, viewer_role)
      SELECT ok.id, ok.account_id, p_actor, ok.viewer_role FROM ok
       WHERE ok.viewer_role IS NOT NULL AND ok.viewer_role <> 'agent'
      RETURNING case_view_audit.case_id
    )
    SELECT ins.case_id FROM ins
    UNION ALL
    SELECT ok.id FROM ok WHERE ok.viewer_role = 'agent';
END;
$$;

-- The only reader of case_view_audit: the case's rows, newest first,
-- for an admin / super_admin of the case's account (NOT_ALLOWED
-- otherwise, an unknown case included). limit NULL -> 100, above 500 -> 500, below 1 ->
-- LIMIT_INVALID. Reading the audit is not itself audited.
CREATE OR REPLACE FUNCTION public.case_audit_list(p_actor uuid, p_case uuid, p_limit int DEFAULT NULL)
RETURNS TABLE (id bigint, case_id uuid, viewer_id uuid, viewer_role text, viewed_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role  text;
  v_limit int := coalesce(p_limit, 100);
BEGIN
  IF v_limit < 1 THEN
    RAISE EXCEPTION 'limit % is below 1', v_limit USING ERRCODE = 'check_violation', HINT = 'LIMIT_INVALID';
  END IF;
  v_limit := least(v_limit, 500);
  -- One answer for an unknown case and another account's: NOT_ALLOWED
  -- (CASE_NOT_FOUND first would tell whether the id exists elsewhere).
  v_role := public.case_role(p_case, p_actor);
  IF v_role IS NULL OR v_role NOT IN ('admin', 'super_admin') THEN
    RAISE EXCEPTION 'case %: % may not read its view audit', p_case, p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  RETURN QUERY
    SELECT a.id, a.case_id, a.viewer_id, a.viewer_role, a.viewed_at
      FROM public.case_view_audit a
     WHERE a.case_id = p_case
     ORDER BY a.viewed_at DESC, a.id DESC
     LIMIT v_limit;
END;
$$;

-- ---------- 6. Configuration (owner/admin of the account) ----------

-- Adds a bank or renames it.
CREATE OR REPLACE FUNCTION public.case_bank_upsert(p_actor uuid, p_account uuid, p_code text, p_name text)
RETURNS public.case_banks
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.case_banks%ROWTYPE;
BEGIN
  IF coalesce(public.case_account_role(p_account, p_actor) IN ('super_admin', 'admin'), false) IS NOT TRUE THEN
    RAISE EXCEPTION '% may not configure banks of workspace %', p_actor, p_account
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  INSERT INTO public.case_banks AS b (account_id, code, name)
  VALUES (p_account, p_code, p_name)
  ON CONFLICT ON CONSTRAINT case_banks_pkey
  DO UPDATE SET name = EXCLUDED.name, updated_at = now()
  RETURNING b.* INTO v_row;
  RETURN v_row;
END;
$$;

-- Replaces an (account, bank) stage list atomically, positions 1..n; an
-- empty or NULL array removes the list (back to the defaults). Refused
-- (STAGE_IN_USE) while an open case of the bank is at a stage the new
-- list drops. The deferred case_bank_stages_valid checks the result at
-- commit. Returns the number of stages stored.
CREATE OR REPLACE FUNCTION public.case_bank_stages_set(p_actor uuid, p_account uuid, p_bank_code text, p_stages text[])
RETURNS int
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_list  text[] := CASE WHEN coalesce(cardinality(p_stages), 0) = 0 THEN public.case_default_stages() ELSE p_stages END;
  v_stage text;
BEGIN
  IF coalesce(public.case_account_role(p_account, p_actor) IN ('super_admin', 'admin'), false) IS NOT TRUE THEN
    RAISE EXCEPTION '% may not configure stages of workspace %', p_actor, p_account
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  -- FOR UPDATE: waits for stage moves and bank changes in flight.
  PERFORM 1 FROM public.case_banks b WHERE b.account_id = p_account AND b.code = p_bank_code FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank % is not a bank of this workspace', p_bank_code
      USING ERRCODE = 'check_violation', HINT = 'BANK_UNKNOWN';
  END IF;
  SELECT c.stage INTO v_stage FROM public.cases c
   WHERE c.account_id = p_account AND c.bank_code = p_bank_code AND c.closed_at IS NULL
     AND NOT (c.stage = ANY (v_list))
   LIMIT 1;
  IF v_stage IS NOT NULL THEN
    RAISE EXCEPTION 'bank %: an open case is at stage %, which the new list drops', p_bank_code, v_stage
      USING ERRCODE = 'check_violation', HINT = 'STAGE_IN_USE';
  END IF;
  DELETE FROM public.case_bank_stages s WHERE s.account_id = p_account AND s.bank_code = p_bank_code;
  IF coalesce(cardinality(p_stages), 0) = 0 THEN
    RETURN 0;
  END IF;
  INSERT INTO public.case_bank_stages (account_id, bank_code, position, stage)
  SELECT p_account, p_bank_code, x.ord, x.stage
    FROM unnest(p_stages) WITH ORDINALITY AS x(stage, ord);
  RETURN cardinality(p_stages);
END;
$$;

-- ---------- 7. Row-level security ----------

ALTER TABLE public.case_banks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_banks FORCE ROW LEVEL SECURITY;
ALTER TABLE public.case_bank_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_bank_stages FORCE ROW LEVEL SECURITY;
ALTER TABLE public.cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cases FORCE ROW LEVEL SECURITY;
ALTER TABLE public.case_stage_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_stage_history FORCE ROW LEVEL SECURITY;
ALTER TABLE public.case_reassign_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_reassign_history FORCE ROW LEVEL SECURITY;
ALTER TABLE public.case_detail_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_detail_log FORCE ROW LEVEL SECURITY;
ALTER TABLE public.case_view_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_view_audit FORCE ROW LEVEL SECURITY;

-- SELECT only; case_view_audit has no policy at all.
DROP POLICY IF EXISTS case_banks_select ON public.case_banks;
CREATE POLICY case_banks_select ON public.case_banks FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND public.is_account_member(account_id));

DROP POLICY IF EXISTS case_bank_stages_select ON public.case_bank_stages;
CREATE POLICY case_bank_stages_select ON public.case_bank_stages FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND public.is_account_member(account_id));

DROP POLICY IF EXISTS cases_select ON public.cases;
CREATE POLICY cases_select ON public.cases FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND public.case_rls_can_read(id));

DROP POLICY IF EXISTS case_stage_history_select ON public.case_stage_history;
CREATE POLICY case_stage_history_select ON public.case_stage_history FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND public.case_rls_can_read(case_id));

DROP POLICY IF EXISTS case_reassign_history_select ON public.case_reassign_history;
CREATE POLICY case_reassign_history_select ON public.case_reassign_history FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND public.case_rls_can_read(case_id));

DROP POLICY IF EXISTS case_detail_log_select ON public.case_detail_log;
CREATE POLICY case_detail_log_select ON public.case_detail_log FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND public.case_rls_can_read(case_id));

-- ---------- 8. Privileges ----------

-- Start from nothing, then the minimum: reads to authenticated and the
-- service role, case_view_audit to nobody, writes to nobody.
REVOKE ALL ON public.case_banks, public.case_bank_stages, public.cases, public.case_stage_history,
  public.case_reassign_history, public.case_detail_log, public.case_view_audit
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.case_stage_history_id_seq, public.case_reassign_history_id_seq,
  public.case_detail_log_id_seq, public.case_view_audit_id_seq
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.case_banks, public.case_bank_stages, public.cases, public.case_stage_history,
  public.case_reassign_history, public.case_detail_log
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION
  public.case_account_role(uuid, uuid),
  public.case_role(uuid, uuid),
  public.case_rule_can_read(text),
  public.case_rule_can_write(text),
  public.case_rule_can_reassign(text),
  public.case_can_read(uuid, uuid),
  public.case_can_write(uuid, uuid),
  public.case_rls_can_read(uuid),
  public.case_default_stages(),
  public.case_stages_for_bank(uuid, text),
  public.case_append_only(),
  public.case_view_audit_check(),
  public.case_bank_stages_check(),
  public.case_fill_details(uuid, text, text, numeric, uuid, text),
  public.case_open(uuid, text, text, text, numeric, uuid),
  public.case_set_details(uuid, uuid, text, text, numeric),
  public.case_set_priority(uuid, uuid, text),
  public.case_set_due(uuid, uuid, timestamptz),
  public.case_set_stage(uuid, uuid, text, text, boolean),
  public.case_apply_submission_status(uuid, text),
  public.case_release_group_end(uuid, timestamptz),
  public.case_finish_group_end(uuid, timestamptz),
  public.case_claim_group_end_system(uuid, interval),
  public.case_claim_group_end(uuid, uuid, interval),
  public.case_pending_group_end(interval, int),
  public.case_reassign(uuid, uuid, text, uuid),
  public.view_case(uuid, uuid[]),
  public.case_audit_list(uuid, uuid, int),
  public.case_bank_upsert(uuid, uuid, text, text),
  public.case_bank_stages_set(uuid, uuid, text, text[])
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.case_account_role(uuid, uuid),
  public.case_role(uuid, uuid),
  public.case_rule_can_read(text),
  public.case_rule_can_write(text),
  public.case_rule_can_reassign(text),
  public.case_can_read(uuid, uuid),
  public.case_can_write(uuid, uuid),
  public.case_default_stages(),
  public.case_stages_for_bank(uuid, text),
  public.case_open(uuid, text, text, text, numeric, uuid),
  public.case_set_details(uuid, uuid, text, text, numeric),
  public.case_set_priority(uuid, uuid, text),
  public.case_set_due(uuid, uuid, timestamptz),
  public.case_set_stage(uuid, uuid, text, text, boolean),
  public.case_apply_submission_status(uuid, text),
  public.case_release_group_end(uuid, timestamptz),
  public.case_finish_group_end(uuid, timestamptz),
  public.case_claim_group_end_system(uuid, interval),
  public.case_claim_group_end(uuid, uuid, interval),
  public.case_pending_group_end(interval, int),
  public.case_reassign(uuid, uuid, text, uuid),
  public.view_case(uuid, uuid[]),
  public.case_audit_list(uuid, uuid, int),
  public.case_bank_upsert(uuid, uuid, text, text),
  public.case_bank_stages_set(uuid, uuid, text, text[])
  TO service_role;
-- The RLS policies call these as the reader.
GRANT EXECUTE ON FUNCTION
  public.case_rule_can_read(text),
  public.case_rule_can_write(text),
  public.case_rule_can_reassign(text),
  public.case_default_stages(),
  public.case_rls_can_read(uuid)
  TO authenticated;

RESET lock_timeout;
