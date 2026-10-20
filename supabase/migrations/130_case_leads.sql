-- ============================================================
-- 130_case_leads.sql — a case starts at the LEAD, before any
-- submission. Port of module 018c_presub (SPEC_018c v3, owner decision
-- 20 Oct). Replaces functions of 122, 124, 125 and 127.
--
--  * Stages: Interested, Data collection, Review are the pre-submission
--    stages (case_presub_stages(), case_stage_is_presub). Every list
--    starts with exactly those three, in that order, and does not reuse
--    their names (PRESUB_STAGES_REQUIRED, checked at commit). Existing
--    case_bank_stages lists are prepended in place; a list that already
--    uses one of the names elsewhere refuses the migration
--    (PRESUB_STAGES_CONFLICT) and nothing changes. case_submitted_stage
--    is the first stage after them.
--  * cases: group_id is NULL for a lead; contact_id (the customer,
--    backfilled from the group, set by case_open) and lead_source added.
--    cases_presub_group: a case with no group is at a pre-submission
--    stage, Withdrawn or Closed; a case with one is never at a
--    pre-submission stage. cases_one_open_lead: one open lead per
--    (account, contact, bank).
--  * case_open_lead opens a lead at Interested (LEAD_EXISTS,
--    CASE_EXISTS, LEAD_INVALID, BANK_UNKNOWN, ASSIGNEE_INVALID,
--    NOT_ALLOWED). Idempotent for the same agent and a reader of it.
--  * case_open attaches a submission group to the open lead of its
--    (account, contact, bank): one case from lead to outcome, moved to
--    case_submitted_stage with one history row; that history row is the
--    stage_change SLA event (124's trigger), so every timer is reset for
--    the new stage on the server clock. A fresh case starts at
--    case_submitted_stage, no longer at position 1.
--  * case_set_stage: PRESUB_REENTRY, SUBMISSION_REQUIRED; a lead never
--    takes the group-end claim, case_claim_group_end(_system) answers
--    NO_GROUP and case_pending_group_end skips it.
--  * NO_RESPONSE is an outcome reason of a Withdrawn case only
--    (OUTCOME_REASON otherwise). Data collection runs customer_reply for
--    5 days when the (account, bank) has no SLA config row at all.
--  * case_inbox lists leads (no group: LEFT JOIN, the contact from
--    cases.contact_id); 125's body otherwise unchanged).
--
-- Who: the case_* functions stay SECURITY DEFINER on the service role,
-- p_actor = the signed-in user. As 122, this must be applied by a
-- superuser or BYPASSRLS role.
--
-- Re-runnable: IF NOT EXISTS, CREATE OR REPLACE, DROP … IF EXISTS, and
-- the stage-list prepend skips lists that already start with the three.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '130 must be applied by a superuser or BYPASSRLS role (the case_* functions read RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. Stage helpers ----------

CREATE OR REPLACE FUNCTION public.case_presub_stages()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$ SELECT ARRAY['Interested', 'Data collection', 'Review']::text[] $$;

CREATE OR REPLACE FUNCTION public.case_stage_is_presub(p_stage text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$ SELECT coalesce(p_stage = ANY (ARRAY['Interested', 'Data collection', 'Review']::text[]), false) $$;

CREATE OR REPLACE FUNCTION public.case_default_stages()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$ SELECT ARRAY['Interested', 'Data collection', 'Review', 'Submitted', 'Bank acknowledged',
  'Documents requested', 'Documents received', 'Under review', 'Query raised', 'Query answered',
  'Approved', 'Declined', 'Withdrawn', 'Closed']::text[] $$;

-- The stage a submission opens (or a lead is attached) at: the first
-- stage of the (account, bank) list after the pre-submission stages.
CREATE OR REPLACE FUNCTION public.case_submitted_stage(p_account uuid, p_bank_code text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT x.s FROM unnest(public.case_stages_for_bank(p_account, p_bank_code)) WITH ORDINALITY x(s, o)
   WHERE NOT public.case_stage_is_presub(x.s) ORDER BY x.o LIMIT 1
$$;

-- ---------- 2. cases ----------

ALTER TABLE public.cases ALTER COLUMN group_id DROP NOT NULL;
ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS contact_id uuid NULL;
ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS lead_source text NULL;

ALTER TABLE public.cases DROP CONSTRAINT IF EXISTS cases_contact_fkey;
ALTER TABLE public.cases ADD CONSTRAINT cases_contact_fkey FOREIGN KEY (contact_id, account_id)
  REFERENCES public.contacts (id, account_id) ON DELETE SET NULL (contact_id);
ALTER TABLE public.cases DROP CONSTRAINT IF EXISTS cases_lead_source_check;
ALTER TABLE public.cases ADD CONSTRAINT cases_lead_source_check
  CHECK (lead_source IS NULL OR (lead_source !~ '^[[:space:]]*$' AND char_length(lead_source) <= 200));
ALTER TABLE public.cases DROP CONSTRAINT IF EXISTS cases_amount_check;
ALTER TABLE public.cases ADD CONSTRAINT cases_amount_check
  CHECK (amount IS NULL OR (amount >= 0 AND amount <> 'NaN'::numeric));
ALTER TABLE public.cases DROP CONSTRAINT IF EXISTS cases_presub_group;
ALTER TABLE public.cases ADD CONSTRAINT cases_presub_group CHECK (
  (group_id IS NULL AND (public.case_stage_is_presub(stage) OR stage IN ('Withdrawn', 'Closed')))
  OR (group_id IS NOT NULL AND NOT public.case_stage_is_presub(stage)));

-- Backfill: the customer of each existing case is its group's contact.
UPDATE public.cases c SET contact_id = g.contact_id
  FROM public.submission_groups g
 WHERE g.id = c.group_id AND g.account_id = c.account_id
   AND c.contact_id IS NULL AND g.contact_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS cases_one_open_lead ON public.cases (account_id, contact_id, bank_code)
  WHERE group_id IS NULL AND closed_at IS NULL;
CREATE INDEX IF NOT EXISTS cases_account_contact_idx ON public.cases (account_id, contact_id, bank_code)
  WHERE closed_at IS NULL;

COMMENT ON COLUMN public.cases.group_id IS
  'The submission group; NULL while the case is a lead (attached by case_open). Migration 130.';
COMMENT ON COLUMN public.cases.contact_id IS
  'The customer: set by case_open_lead, or from the group by case_open. Migration 130.';

-- ---------- 3. Stage lists ----------

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
    -- 130: the three pre-submission stages first, in order, and only there.
    IF v_stages[1:3] IS DISTINCT FROM public.case_presub_stages()
       OR EXISTS (SELECT 1 FROM unnest(v_stages[4:]) x WHERE lower(x) IN ('interested', 'data collection', 'review')) THEN
      RAISE EXCEPTION 'bank %: the list must start with Interested, Data collection, Review (in that order, once)', v_bank
        USING ERRCODE = 'check_violation', HINT = 'PRESUB_STAGES_REQUIRED';
    END IF;
    IF lower(v_stages[4]) IN ('approved', 'declined', 'withdrawn', 'closed') THEN
      RAISE EXCEPTION 'bank %: the first submission stage % is a final stage', v_bank, v_stages[4]
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

-- Data migration: prepend the three to every existing list, in place.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT s.account_id, s.bank_code, array_agg(s.stage ORDER BY s.position) AS st
             FROM public.case_bank_stages s GROUP BY s.account_id, s.bank_code LOOP
    CONTINUE WHEN r.st[1:3] IS NOT DISTINCT FROM public.case_presub_stages();  -- already migrated
    IF EXISTS (SELECT 1 FROM unnest(r.st) x WHERE lower(x) IN ('interested', 'data collection', 'review')) THEN
      RAISE EXCEPTION 'bank % of account %: the stage list already uses a pre-submission stage name; rename it, then re-run 130',
        r.bank_code, r.account_id USING ERRCODE = 'object_not_in_prerequisite_state', HINT = 'PRESUB_STAGES_CONFLICT';
    END IF;
    -- Two steps: case_bank_stages_position_uq is checked per row.
    UPDATE public.case_bank_stages s SET position = s.position + 1000000
     WHERE s.account_id = r.account_id AND s.bank_code = r.bank_code;
    UPDATE public.case_bank_stages s SET position = s.position - 1000000 + 3
     WHERE s.account_id = r.account_id AND s.bank_code = r.bank_code;
    INSERT INTO public.case_bank_stages (account_id, bank_code, position, stage)
    SELECT r.account_id, r.bank_code, p.o::integer, p.s FROM unnest(public.case_presub_stages()) WITH ORDINALITY p(s, o);
  END LOOP;
END $$;

-- ---------- 4. Open ----------

-- 122's case_open, plus: the customer is copied to cases.contact_id; an
-- open lead of the group's (account, contact, bank) takes the group
-- (group_id; product / amount when given; the group's coordinator when
-- it names one; the lead's agent is kept) and moves to
-- case_submitted_stage with one history row (the SLA stage_change);
-- created = false. A new case starts at case_submitted_stage.
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
  v_contact uuid;
  v_role    text := 'api';
  v_agent   uuid;
  v_coord   uuid;
  v_stage   text;
  v_id      uuid;
  l         public.cases%ROWTYPE;
BEGIN
  SELECT g.account_id, g.contact_id INTO v_account, v_contact FROM public.submission_groups g WHERE g.id = p_group;
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
    SELECT a.user_id INTO v_coord FROM public.submission_group_access a
     WHERE a.group_id = p_group AND a.label = 'coordinator' AND a.removed_at IS NULL
     ORDER BY a.added_at, a.id LIMIT 1;
    IF p_bank_code IS NOT NULL THEN
      PERFORM 1 FROM public.case_banks b WHERE b.account_id = v_account AND b.code = p_bank_code FOR SHARE;
    END IF;
    v_stage := public.case_submitted_stage(v_account, p_bank_code);
    -- 130: the open lead of the (account, contact, bank) takes the group.
    IF v_contact IS NOT NULL AND p_bank_code IS NOT NULL THEN
      SELECT * INTO l FROM public.cases x
       WHERE x.account_id = v_account AND x.contact_id = v_contact AND x.bank_code = p_bank_code
         AND x.group_id IS NULL AND x.closed_at IS NULL
       FOR NO KEY UPDATE;
      IF FOUND THEN
        UPDATE public.cases x
           SET group_id = p_group,
               product = coalesce(p_product, x.product),
               amount = coalesce(p_amount, x.amount),
               coordinator_id = coalesce(v_coord, x.coordinator_id),
               stage = v_stage
         WHERE x.id = l.id;
        -- The history row is the stage_change SLA event (124's
        -- case_stage_history_sla trigger): every timer is reset for the
        -- new stage at the row's changed_at, the server clock.
        INSERT INTO public.case_stage_history (case_id, account_id, from_stage, to_stage, actor_id, actor_role)
        VALUES (l.id, v_account, l.stage, v_stage, p_actor, v_role);
        RETURN QUERY SELECT l.id, false;
        RETURN;
      END IF;
    END IF;
    SELECT a.user_id INTO v_agent FROM public.submission_group_access a
     WHERE a.group_id = p_group AND a.label = 'agent' AND a.removed_at IS NULL
     ORDER BY a.added_at, a.id LIMIT 1;
    IF v_agent IS NULL THEN
      RAISE EXCEPTION 'submission group % has no agent on its access list', p_group
        USING ERRCODE = 'object_not_in_prerequisite_state', HINT = 'NO_AGENT';
    END IF;
    INSERT INTO public.cases AS c (account_id, group_id, contact_id, bank_code, product, amount, agent_id,
                                   coordinator_id, stage)
    VALUES (v_account, p_group, v_contact, p_bank_code, p_product, p_amount, v_agent, v_coord, v_stage)
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

-- Opens a lead at Interested for p_agent. The actor is the agent, an
-- owner/admin of the account, or the leader of a team the agent is in.
-- The agent (and the coordinator, when given) must be live staff, agent
-- and up (ASSIGNEE_INVALID); the bank a bank of the account
-- (BANK_UNKNOWN); the contact a contact of the account and the product
-- not blank, the amount finite and >= 0 (LEAD_INVALID). An OPEN
-- submission case of the (account, contact, bank) refuses it
-- (CASE_EXISTS). Idempotent: the open lead of the triple is returned
-- for the same agent when the actor may read it; otherwise LEAD_EXISTS,
-- with nothing about that lead. The contact must be visible to the
-- agent (129's memory_can_read contact branch, the explicit-user mirror
-- of 072's can_view_contact; owners and admins see every contact); a
-- contact they cannot see is LEAD_INVALID, as one of another workspace.
CREATE OR REPLACE FUNCTION public.case_open_lead(p_actor uuid, p_account uuid, p_contact uuid, p_bank_code text,
  p_product text, p_agent uuid, p_amount numeric DEFAULT NULL, p_coordinator uuid DEFAULT NULL,
  p_lead_source text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role   text;
  v_source text;
  v_id     uuid;
  e        public.cases%ROWTYPE;
BEGIN
  v_role := public.case_account_role(p_account, p_actor);
  IF v_role IS NULL OR NOT (
       p_actor = p_agent
       OR v_role IN ('super_admin', 'admin')
       OR (v_role = 'team_lead' AND EXISTS (
             SELECT 1 FROM public.teams t JOIN public.team_members m ON m.team_id = t.id
              WHERE t.account_id = p_account AND m.account_id = p_account
                AND m.user_id = p_agent AND t.leader_user_id = p_actor))) THEN
    RAISE EXCEPTION '% may not open a lead for % in workspace %', p_actor, p_agent, p_account
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  IF p_agent IS NULL OR public.case_account_role(p_account, p_agent) IS NULL
     OR (p_coordinator IS NOT NULL AND public.case_account_role(p_account, p_coordinator) IS NULL) THEN
    RAISE EXCEPTION 'agent % / coordinator % is not live staff of workspace %', p_agent, p_coordinator, p_account
      USING ERRCODE = 'check_violation', HINT = 'ASSIGNEE_INVALID';
  END IF;
  IF p_contact IS NULL OR p_product IS NULL OR p_product ~ '^[[:space:]]*$' OR char_length(p_product) > 200
     OR p_amount < 0 OR p_amount = 'NaN'::numeric OR p_amount IN ('Infinity'::numeric, '-Infinity'::numeric)
     OR NOT EXISTS (SELECT 1 FROM public.contacts ct WHERE ct.id = p_contact AND ct.account_id = p_account)
     -- The agent must see the customer (129's explicit-user mirror of
     -- 072's can_view_contact); refused as an unknown contact, no oracle.
     OR NOT public.memory_can_read(p_agent, p_account, 'contact', p_contact) THEN
    RAISE EXCEPTION 'a lead needs a contact of the workspace, a product and a finite non-negative amount'
      USING ERRCODE = 'check_violation', HINT = 'LEAD_INVALID';
  END IF;
  v_source := CASE WHEN p_lead_source ~ '^[[:space:]]*$' THEN NULL ELSE p_lead_source END;
  IF char_length(v_source) > 200 THEN
    RAISE EXCEPTION 'lead source over 200 characters' USING ERRCODE = 'check_violation', HINT = 'LEAD_INVALID';
  END IF;
  PERFORM 1 FROM public.case_banks b WHERE b.account_id = p_account AND b.code = p_bank_code FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank % is not a bank of this workspace', p_bank_code
      USING ERRCODE = 'check_violation', HINT = 'BANK_UNKNOWN';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cases x
              WHERE x.account_id = p_account AND x.contact_id = p_contact AND x.bank_code = p_bank_code
                AND x.group_id IS NOT NULL AND x.closed_at IS NULL) THEN
    RAISE EXCEPTION 'an open case already exists for this contact and bank'
      USING ERRCODE = 'unique_violation', HINT = 'CASE_EXISTS';
  END IF;
  INSERT INTO public.cases AS c (account_id, group_id, contact_id, bank_code, product, amount, agent_id,
                                 coordinator_id, stage, lead_source)
  VALUES (p_account, NULL, p_contact, p_bank_code, p_product, p_amount, p_agent, p_coordinator, 'Interested', v_source)
  ON CONFLICT (account_id, contact_id, bank_code) WHERE group_id IS NULL AND closed_at IS NULL DO NOTHING
  RETURNING c.id INTO v_id;
  IF v_id IS NOT NULL THEN
    INSERT INTO public.case_stage_history (case_id, account_id, from_stage, to_stage, actor_id, actor_role)
    VALUES (v_id, p_account, NULL, 'Interested', p_actor, v_role);
    RETURN v_id;
  END IF;
  SELECT * INTO e FROM public.cases x
   WHERE x.account_id = p_account AND x.contact_id = p_contact AND x.bank_code = p_bank_code
     AND x.group_id IS NULL AND x.closed_at IS NULL;
  -- Idempotent only for the same agent and a reader of the lead; else
  -- LEAD_EXISTS with no id (the code is the only signal).
  IF e.agent_id IS DISTINCT FROM p_agent OR NOT public.case_rule_can_read(public.case_role(e.id, p_actor)) THEN
    RAISE EXCEPTION 'an open lead already exists for this contact and bank'
      USING ERRCODE = 'unique_violation', HINT = 'LEAD_EXISTS';
  END IF;
  RETURN e.id;
END;
$$;

-- ---------- 5. Stage moves and the group end ----------

-- 122's case_set_stage, plus PRESUB_REENTRY / SUBMISSION_REQUIRED, and
-- a lead (no group) never takes the group-end claim.
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
  -- 130: pre-submission stages move freely among themselves and are
  -- never re-entered once submitted; a lead leaves them only to
  -- Withdrawn (the submission is attached by case_open).
  IF public.case_stage_is_presub(p_to_stage) AND NOT public.case_stage_is_presub(c.stage) THEN
    RAISE EXCEPTION 'case %: pre-submission stage % cannot be re-entered after submission', p_case, p_to_stage
      USING ERRCODE = 'check_violation', HINT = 'PRESUB_REENTRY';
  END IF;
  IF c.group_id IS NULL AND NOT public.case_stage_is_presub(p_to_stage) AND p_to_stage <> 'Withdrawn' THEN
    RAISE EXCEPTION 'case %: stage % needs a submission', p_case, p_to_stage
      USING ERRCODE = 'check_violation', HINT = 'SUBMISSION_REQUIRED';
  END IF;
  v_final := p_to_stage IN ('Approved', 'Declined', 'Withdrawn', 'Closed');
  v_outcome := CASE WHEN p_to_stage IN ('Approved', 'Declined', 'Withdrawn') THEN p_to_stage ELSE c.outcome END;
  v_claim := v_final AND coalesce(p_claim, true) AND c.group_end_claimed_at IS NULL AND c.group_ended_at IS NULL
             AND c.group_id IS NOT NULL;  -- 130: a lead has no group to end
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

-- 122's, plus NO_GROUP for a lead (no claim taken). case_claim_group_end
-- (the person's path) delegates here, so it answers NO_GROUP too.
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
  IF c.group_id IS NULL THEN
    RETURN QUERY SELECT false, c.stage, 'NO_GROUP'::text, NULL::timestamptz;
    RETURN;
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

-- 122's, minus leads: a closed lead has no group to end.
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
   WHERE c.closed_at IS NOT NULL AND c.group_ended_at IS NULL AND c.group_id IS NOT NULL
     AND (c.group_end_claimed_at IS NULL
          OR c.group_end_claimed_at < now() - coalesce(p_stale_after, interval '15 minutes'))
   ORDER BY c.closed_at, c.id
   LIMIT greatest(coalesce(p_limit, 100), 0)
$$;

-- ---------- 6. Outcome reason NO_RESPONSE ----------

ALTER TABLE public.case_outcome_reasons DROP CONSTRAINT IF EXISTS case_outcome_reasons_code_check;
ALTER TABLE public.case_outcome_reasons ADD CONSTRAINT case_outcome_reasons_code_check
  CHECK (reason_code IN ('INCOMPLETE_DOCS', 'CREDIT_POLICY', 'INCOME_INSUFFICIENT', 'KYC_AML',
                         'CUSTOMER_WITHDREW', 'OTHER', 'NO_RESPONSE'));

-- 127's, plus NO_RESPONSE (a lead gone cold), on a Withdrawn case only.
CREATE OR REPLACE FUNCTION public.case_outcome_reason_set(p_actor uuid, p_case uuid, p_code text, p_text text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c      public.cases%ROWTYPE;
  v_role text;
  v_text text;
BEGIN
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case FOR UPDATE;
  -- An unknown case and a case the actor may not write answer alike, so the
  -- error is no oracle for which case ids exist.
  IF FOUND THEN
    v_role := public.case_role(p_case, p_actor);
  END IF;
  IF NOT FOUND OR NOT coalesce(public.case_rule_can_write(v_role), false) THEN
    RAISE EXCEPTION 'case %: % may not set the outcome reason', p_case, p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  IF p_code IS NULL OR p_code NOT IN ('INCOMPLETE_DOCS', 'CREDIT_POLICY', 'INCOME_INSUFFICIENT', 'KYC_AML',
                                      'CUSTOMER_WITHDREW', 'OTHER', 'NO_RESPONSE') THEN
    RAISE EXCEPTION 'reason % is not a reason code', p_code USING ERRCODE = 'check_violation', HINT = 'REASON_INVALID';
  END IF;
  v_text := CASE WHEN p_text ~ '^[[:space:]]*$' THEN NULL ELSE p_text END;
  IF char_length(v_text) > 500 THEN
    RAISE EXCEPTION 'reason text over 500 characters' USING ERRCODE = 'check_violation', HINT = 'REASON_TEXT_TOO_LONG';
  END IF;
  IF c.outcome IS NULL OR c.outcome NOT IN ('Declined', 'Withdrawn') THEN
    RAISE EXCEPTION 'case %: outcome % takes no reason', p_case, coalesce(c.outcome, '(none)')
      USING ERRCODE = 'check_violation', HINT = 'OUTCOME_NOT_DECLINED';
  END IF;
  IF p_code = 'NO_RESPONSE' AND c.outcome <> 'Withdrawn' THEN
    RAISE EXCEPTION 'case %: NO_RESPONSE is a Withdrawn reason only', p_case
      USING ERRCODE = 'check_violation', HINT = 'OUTCOME_REASON';
  END IF;
  INSERT INTO public.case_outcome_reasons (case_id, account_id, reason_code, reason_text, outcome, actor_id, actor_role)
  VALUES (p_case, c.account_id, p_code, v_text, c.outcome, p_actor, v_role)
  ON CONFLICT (case_id) DO NOTHING;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case %: reason already set', p_case USING ERRCODE = 'unique_violation', HINT = 'REASON_ALREADY_SET';
  END IF;
END;
$$;

-- ---------- 7. SLA default at Data collection ----------

-- 124's, plus: an (account, bank) with no SLA config row at all runs
-- customer_reply for 5 days at Data collection; any row replaces it.
CREATE OR REPLACE FUNCTION public.case_sla_start_one(p_case uuid, p_timer text, p_now timestamptz,
  p_actor uuid, p_actor_role text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c      public.cases%ROWTYPE;
  k      public.case_sla_config%ROWTYPE;
  t      public.case_sla_timers%ROWTYPE;
  v_len  interval;
  v_soon interval;
  v_due  timestamptz;
BEGIN
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case;
  SELECT * INTO k FROM public.case_sla_config x
   WHERE x.account_id = c.account_id AND x.bank_code = c.bank_code AND x.stage = c.stage AND x.timer = p_timer;
  IF NOT FOUND AND c.stage = 'Data collection' AND p_timer = 'customer_reply'
     AND NOT EXISTS (SELECT 1 FROM public.case_sla_config y
                      WHERE y.account_id = c.account_id AND y.bank_code IS NOT DISTINCT FROM c.bank_code) THEN
    k.amount := 5; k.unit := 'days'; k.due_soon_pct := 20; k.due_soon_minutes := NULL;
  ELSIF NOT FOUND THEN
    RETURN false;
  END IF;
  v_len := CASE k.unit WHEN 'days' THEN make_interval(days => k.amount) ELSE make_interval(mins => k.amount) END;
  v_soon := coalesce(make_interval(mins => k.due_soon_minutes),
                     (extract(epoch FROM v_len) * k.due_soon_pct / 100.0) * interval '1 second');
  IF v_soon > v_len THEN
    v_soon := v_len;
  END IF;
  v_due := p_now + v_len;
  SELECT * INTO t FROM public.case_sla_timers x WHERE x.case_id = p_case AND x.timer = p_timer FOR UPDATE;
  INSERT INTO public.case_sla_timers AS s (case_id, account_id, timer, stage, started_at, due_soon_at, due_at,
                                           stopped_at, state)
  VALUES (p_case, c.account_id, p_timer, c.stage, p_now, v_due - v_soon, v_due, NULL, 'on_track')
  ON CONFLICT ON CONSTRAINT case_sla_timers_pkey DO UPDATE
    SET stage = EXCLUDED.stage, started_at = EXCLUDED.started_at, due_soon_at = EXCLUDED.due_soon_at,
        due_at = EXCLUDED.due_at, stopped_at = NULL, state = 'on_track';
  INSERT INTO public.case_sla_state_log (case_id, account_id, timer, from_state, to_state, actor_id, actor_role, changed_at)
  VALUES (p_case, c.account_id, p_timer,
          CASE WHEN t.case_id IS NULL THEN NULL WHEN t.stopped_at IS NULL THEN t.state ELSE 'stopped' END,
          'on_track', p_actor, p_actor_role, p_now);
  RETURN true;
END;
$$;

-- ---------- 8. Inbox lists leads ----------

-- 125's case_inbox, with three changes so it lists leads: LEFT JOIN
-- submission_groups (a lead has no group, so submission_ref is NULL),
-- and the contact read from cases.contact_id instead of the group's.
CREATE OR REPLACE FUNCTION public.case_inbox(p_actor uuid, p_account uuid, p_filters jsonb, p_now timestamptz,
  p_limit int DEFAULT 50, p_after text DEFAULT NULL)
RETURNS TABLE (case_id uuid, bank_code text, stage text, agent_id uuid, coordinator_id uuid, priority text,
  due_at timestamptz, sla_state text, overdue_rank integer[], customer_waiting boolean, documents_missing integer,
  bank_query_open boolean, last_activity_at timestamptz, last_touched_by uuid, open_task_overdue_count integer,
  submission_ref text, contact_id uuid, contact_name text, bank_name text, product text, amount numeric,
  opened_at timestamptz, closed_at timestamptz, cursor text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_filters     jsonb := coalesce(p_filters, '{}'::jsonb);
  v_role        text;
  v_all         boolean;
  v_team_agents uuid[] := '{}';
  v_key         text;
  v_bank        text;
  v_stage       text;
  v_agent_txt   text;
  v_agent       uuid;
  v_priority    text;
  v_sla         text;
  v_waiting     boolean;
  v_docs        boolean;
  v_query       boolean;
  v_closed      boolean;
  v_sort        text;
  v_days        numeric;
  v_idle_before timestamptz;
  v_limit       integer;
  v_after       jsonb;
  a_k1          timestamptz;
  a_k2          integer[];
  a_k3          timestamptz;
  a_id          uuid;
BEGIN
  IF p_actor IS NULL OR p_account IS NULL THEN
    RAISE EXCEPTION 'case_inbox: no actor or account' USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  IF p_now IS NULL OR NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'case_inbox needs a finite clock' USING ERRCODE = 'invalid_parameter_value', HINT = 'NOW_REQUIRED';
  END IF;
  IF p_limit IS NOT NULL AND p_limit < 1 THEN
    RAISE EXCEPTION 'case_inbox: limit % is below 1', p_limit
      USING ERRCODE = 'invalid_parameter_value', HINT = 'LIMIT_INVALID';
  END IF;
  v_limit := least(coalesce(p_limit, 50), 200);

  -- filters: a fixed allowlist of keys, each type-checked
  IF jsonb_typeof(v_filters) <> 'object' THEN
    RAISE EXCEPTION 'inbox filters must be an object' USING ERRCODE = 'invalid_parameter_value', HINT = 'FILTER_INVALID';
  END IF;
  SELECT k INTO v_key FROM jsonb_object_keys(v_filters) k
   WHERE k <> ALL (ARRAY['bank', 'stage', 'agent', 'priority', 'sla_state', 'customer_waiting', 'documents_missing',
                         'bank_query_open', 'no_activity_days', 'include_closed', 'sort'])
   LIMIT 1;
  IF v_key IS NOT NULL THEN
    RAISE EXCEPTION 'inbox filter % is not a filter', left(v_key, 64)
      USING ERRCODE = 'invalid_parameter_value', HINT = 'FILTER_INVALID';
  END IF;
  v_bank      := public.case_inbox_text_filter(v_filters, 'bank');
  v_stage     := public.case_inbox_text_filter(v_filters, 'stage');
  v_agent_txt := public.case_inbox_text_filter(v_filters, 'agent');
  IF v_agent_txt IS NOT NULL THEN
    IF v_agent_txt !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'inbox filter agent must be a uuid' USING ERRCODE = 'invalid_parameter_value', HINT = 'FILTER_INVALID';
    END IF;
    v_agent := v_agent_txt::uuid;
  END IF;
  v_priority := public.case_inbox_text_filter(v_filters, 'priority', ARRAY['low', 'normal', 'high', 'urgent']);
  v_sla      := public.case_inbox_text_filter(v_filters, 'sla_state', ARRAY['on_track', 'due_soon', 'overdue']);
  v_sort     := coalesce(public.case_inbox_text_filter(v_filters, 'sort', ARRAY['most_overdue', 'due_soonest', 'stalest']),
                         'most_overdue');
  v_waiting  := public.case_inbox_bool_filter(v_filters, 'customer_waiting');
  v_docs     := public.case_inbox_bool_filter(v_filters, 'documents_missing');
  v_query    := public.case_inbox_bool_filter(v_filters, 'bank_query_open');
  v_closed   := coalesce(public.case_inbox_bool_filter(v_filters, 'include_closed'), false);
  IF v_filters ? 'no_activity_days' THEN
    IF jsonb_typeof(v_filters -> 'no_activity_days') <> 'number' THEN
      RAISE EXCEPTION 'inbox filter no_activity_days must be a number'
        USING ERRCODE = 'invalid_parameter_value', HINT = 'FILTER_INVALID';
    END IF;
    v_days := (v_filters -> 'no_activity_days')::numeric;
    IF v_days <> trunc(v_days) OR v_days < 1 OR v_days > 3650 THEN
      RAISE EXCEPTION 'inbox filter no_activity_days must be a whole number of days 1..3650'
        USING ERRCODE = 'invalid_parameter_value', HINT = 'FILTER_INVALID';
    END IF;
    v_idle_before := p_now - make_interval(days => v_days::integer);
  END IF;

  -- cursor: JSON text with exactly the keys this function emits, the
  -- same sort and the same clock
  IF p_after IS NOT NULL THEN
    BEGIN
      v_after := p_after::jsonb;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'inbox cursor is not valid' USING ERRCODE = 'invalid_parameter_value', HINT = 'CURSOR_INVALID';
    END;
    IF jsonb_typeof(v_after) <> 'object'
       OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_after) k)
          IS DISTINCT FROM ARRAY['case_id', 'due_at', 'last_activity_at', 'now', 'overdue_rank', 'sort']
       OR jsonb_typeof(v_after -> 'sort') <> 'string' OR v_after ->> 'sort' <> v_sort
       OR jsonb_typeof(v_after -> 'now') <> 'string'
       OR jsonb_typeof(v_after -> 'case_id') <> 'string'
       OR jsonb_typeof(v_after -> 'last_activity_at') <> 'string'
       OR jsonb_typeof(v_after -> 'due_at') NOT IN ('string', 'null')
       OR jsonb_typeof(v_after -> 'overdue_rank') <> 'array' OR jsonb_array_length(v_after -> 'overdue_rank') <> 2
       OR jsonb_typeof(v_after -> 'overdue_rank' -> 0) <> 'number'
       OR jsonb_typeof(v_after -> 'overdue_rank' -> 1) <> 'number' THEN
      RAISE EXCEPTION 'inbox cursor is not valid' USING ERRCODE = 'invalid_parameter_value', HINT = 'CURSOR_INVALID';
    END IF;
    BEGIN
      IF (v_after ->> 'now')::timestamptz <> p_now THEN
        RAISE EXCEPTION 'clock';
      END IF;
      a_id := (v_after ->> 'case_id')::uuid;
      a_k1 := public.case_inbox_k1(v_sort, (v_after ->> 'due_at')::timestamptz, (v_after ->> 'last_activity_at')::timestamptz);
      a_k2 := ARRAY[-((v_after -> 'overdue_rank' ->> 0)::integer), -((v_after -> 'overdue_rank' ->> 1)::integer)];
      a_k3 := public.case_inbox_k3(v_sort, (v_after ->> 'due_at')::timestamptz);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'inbox cursor is not valid' USING ERRCODE = 'invalid_parameter_value', HINT = 'CURSOR_INVALID';
    END;
  END IF;

  -- visibility, once per call; mirrors case_role (122) exactly: a live,
  -- non-guest owner / admin / team_leader / agent profile in p_account
  v_role := public.case_account_role(p_account, p_actor);
  IF v_role IS NULL THEN
    RETURN;
  END IF;
  v_all := v_role IN ('super_admin', 'admin');
  IF v_role = 'team_lead' THEN
    SELECT coalesce(array_agg(DISTINCT m.user_id), '{}') INTO v_team_agents
      FROM public.teams t
      JOIN public.team_members m ON m.team_id = t.id
     WHERE t.account_id = p_account AND m.account_id = p_account AND t.leader_user_id = p_actor;
  END IF;

  RETURN QUERY
    WITH base AS (
      SELECT c.id AS case_id, c.bank_code, c.stage, c.agent_id, c.coordinator_id, c.priority, c.due_at,
             s.sla_state, ARRAY[s.sla_overdue_minutes, t.n] AS overdue_rank, s.customer_waiting,
             d.n AS documents_missing, c.stage = 'Query raised' AS bank_query_open,
             coalesce(lt.last_activity_at, c.opened_at) AS last_activity_at, lt.last_touched_by,
             t.n AS open_task_overdue_count,
             g.submission_ref, c.contact_id, ct.name AS contact_name, bk.name AS bank_name,
             c.product, c.amount, c.opened_at, c.closed_at
        FROM public.cases c
        CROSS JOIN LATERAL (
          SELECT CASE max(CASE public.case_sla_state_at(x.due_soon_at, x.due_at, p_now)
                            WHEN 'overdue' THEN 3 WHEN 'due_soon' THEN 2 ELSE 1 END)
                   WHEN 3 THEN 'overdue' WHEN 2 THEN 'due_soon' WHEN 1 THEN 'on_track' END AS sla_state,
                 coalesce(max(floor(extract(epoch FROM (p_now - x.due_at)) / 60)) FILTER (WHERE p_now >= x.due_at), 0)::integer
                   AS sla_overdue_minutes,
                 coalesce(bool_or(x.timer = 'customer_reply'), false) AS customer_waiting
            FROM public.case_sla_timers x
           WHERE x.case_id = c.id AND x.stopped_at IS NULL) s
        CROSS JOIN LATERAL (
          SELECT count(*)::integer AS n FROM public.case_tasks k
           WHERE k.case_id = c.id AND k.status <> 'done' AND k.due_at IS NOT NULL AND k.due_at < p_now) t
        CROSS JOIN LATERAL (
          SELECT count(*)::integer AS n FROM public.case_doc_requirements r
           WHERE r.account_id = c.account_id AND r.bank_code = c.bank_code
             AND lower(btrim(r.product)) = lower(btrim(c.product))
             AND NOT EXISTS (SELECT 1 FROM public.case_documents y
                              WHERE y.case_id = c.id AND y.doc_key = r.doc_key AND y.status = 'received')) d
        -- last touch: the latest activity row of this case (ties: the
        -- later source in this list, then the larger ref). Each branch is
        -- filtered on the case, so each reads only that case's rows (a
        -- DISTINCT ON view joined to cases scanned every case's rows).
        LEFT JOIN LATERAL (
          SELECT e.at AS last_activity_at, e.actor AS last_touched_by
            FROM (
              SELECT h.changed_at AS at, h.actor_id AS actor, 1 AS src, lpad(h.id::text, 20, '0') AS ref
                FROM public.case_stage_history h WHERE h.case_id = c.id
              UNION ALL
              SELECT r2.changed_at, r2.actor_id, 2, lpad(r2.id::text, 20, '0')
                FROM public.case_reassign_history r2 WHERE r2.case_id = c.id
              UNION ALL
              SELECT d2.changed_at, d2.actor_id, 3, lpad(d2.id::text, 20, '0')
                FROM public.case_detail_log d2 WHERE d2.case_id = c.id
              UNION ALL
              SELECT l.changed_at, l.actor_id, 4, lpad(l.id::text, 20, '0')
                FROM public.case_task_status_log l WHERE l.case_id = c.id
              UNION ALL
              SELECT n.created_at, n.author_id, 5, n.id::text FROM public.case_notes n WHERE n.case_id = c.id
              UNION ALL
              SELECT o.updated_at, o.updated_by, 6, o.doc_key FROM public.case_documents o WHERE o.case_id = c.id
              UNION ALL
              SELECT b2.created_at, b2.author_id, 7, b2.id::text FROM public.case_bank_contacts b2 WHERE b2.case_id = c.id
              UNION ALL
              -- the SLA job's and the inbound pipeline's rows are not a touch
              SELECT s2.changed_at, s2.actor_id, 8, lpad(s2.id::text, 20, '0')
                FROM public.case_sla_state_log s2 WHERE s2.case_id = c.id AND s2.actor_role <> 'system'
            ) e
           ORDER BY e.at DESC, e.src DESC, e.ref DESC
           LIMIT 1) lt ON true
        -- 130: LEFT JOIN, a lead has no group
        LEFT JOIN public.submission_groups g ON g.id = c.group_id AND g.account_id = c.account_id
        LEFT JOIN public.contacts ct ON ct.id = c.contact_id AND ct.account_id = c.account_id
        LEFT JOIN public.case_banks bk ON bk.account_id = c.account_id AND bk.code = c.bank_code
       WHERE c.account_id = p_account
         AND (v_closed OR c.closed_at IS NULL)
         AND (v_all
              OR c.agent_id = p_actor
              OR c.coordinator_id = p_actor
              OR c.agent_id = ANY (v_team_agents))
    ), keyed AS (
      SELECT b.*,
             public.case_inbox_k1(v_sort, b.due_at, b.last_activity_at) AS k1,
             ARRAY[-b.overdue_rank[1], -b.overdue_rank[2]] AS k2,
             public.case_inbox_k3(v_sort, b.due_at) AS k3
        FROM base b
       WHERE (v_bank IS NULL OR b.bank_code = v_bank)
         AND (v_stage IS NULL OR b.stage = v_stage)
         AND (v_agent IS NULL OR b.agent_id = v_agent)
         AND (v_priority IS NULL OR b.priority = v_priority)
         AND (v_sla IS NULL OR b.sla_state = v_sla)
         AND (v_waiting IS NULL OR b.customer_waiting = v_waiting)
         AND (v_docs IS NULL OR (b.documents_missing > 0) = v_docs)
         AND (v_query IS NULL OR b.bank_query_open = v_query)
         AND (v_idle_before IS NULL OR b.last_activity_at < v_idle_before)
    )
    SELECT k.case_id, k.bank_code, k.stage, k.agent_id, k.coordinator_id, k.priority, k.due_at, k.sla_state,
           k.overdue_rank, k.customer_waiting, k.documents_missing, k.bank_query_open, k.last_activity_at,
           k.last_touched_by, k.open_task_overdue_count, k.submission_ref, k.contact_id, k.contact_name, k.bank_name,
           k.product, k.amount, k.opened_at, k.closed_at,
           jsonb_build_object('sort', v_sort, 'now', p_now, 'case_id', k.case_id, 'overdue_rank', to_jsonb(k.overdue_rank),
                              'due_at', k.due_at, 'last_activity_at', k.last_activity_at)::text
      FROM keyed k
     WHERE p_after IS NULL OR (k.k1, k.k2, k.k3, k.case_id) > (a_k1, a_k2, a_k3, a_id)
     ORDER BY k.k1, k.k2, k.k3, k.case_id
     LIMIT v_limit;
END;
$$;

-- ---------- 9. Privileges ----------

REVOKE ALL ON FUNCTION public.case_presub_stages(), public.case_stage_is_presub(text),
  public.case_submitted_stage(uuid, text),
  public.case_open_lead(uuid, uuid, uuid, text, text, uuid, numeric, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.case_presub_stages(), public.case_stage_is_presub(text),
  public.case_submitted_stage(uuid, text),
  public.case_open_lead(uuid, uuid, uuid, text, text, uuid, numeric, uuid, text)
  TO service_role;
