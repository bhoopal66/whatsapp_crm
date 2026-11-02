-- Behavioural regression suite for Compass's finished statuses
-- (migration 166).
--
-- case_final_stage_for_status reads a status through case_status_key and
-- names the final stage it closes a case at: the four original words,
-- plus "Customer Withdrawn" and "Agency Withdrawn" as Withdrawn; any
-- open status is NULL. case_apply_submission_status closes an open case
-- on either new label as the API (stage and outcome Withdrawn, closed_at
-- set, a history row with actor NULL and role 'api'), leaves an open
-- status's case where it is, and never touches a closed case. The
-- migration's repair loop closes an open case whose group already holds
-- a new label, and a second pass closes nothing more. The function is
-- the service role's alone.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000166001';
  u_agent  UUID := '00000000-0000-4000-8000-000000166002';
  a_acct   UUID;
  w1       UUID;
  ct       UUID;
  g        UUID[] := '{}';
  k        UUID[] := '{}';
  r        RECORD;
  b1       BOOLEAN;
  i        INT;
  v_closed INT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cf_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  -- The migration's repair loop, as written in 166 section 4: the number
  -- of open cases it closed.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cf_repair()
    RETURNS int LANGUAGE plpgsql AS $body$
    DECLARE g record; v_closed int := 0;
    BEGIN
      FOR g IN
        SELECT s.id, s.submission_status
          FROM public.cases c
          JOIN public.submission_groups s ON s.id = c.group_id
         WHERE c.closed_at IS NULL
           AND public.case_final_stage_for_status(s.submission_status) IS NOT NULL
         ORDER BY c.id
      LOOP
        IF public.case_apply_submission_status(g.id, g.submission_status) THEN
          v_closed := v_closed + 1;
        END IF;
      END LOOP;
      RETURN v_closed;
    END $body$
  $fn$;

  -- ---------- 1. the mapping ----------
  FOR r IN
    SELECT * FROM (VALUES
      ('APPROVED', 'Approved'), ('Approved', 'Approved'),
      ('DECLINED', 'Declined'), ('withdrawn', 'Withdrawn'),
      ('CLOSED', 'Closed'),
      ('Customer Withdrawn', 'Withdrawn'), ('customer_withdrawn', 'Withdrawn'),
      ('Agency Withdrawn', 'Withdrawn'), (' AGENCY  WITHDRAWN ', 'Withdrawn'),
      ('Agency_Withdrawn', 'Withdrawn'),
      ('Bank Review', NULL), ('Awaiting Fulfillment', NULL),
      ('Withdrawn by bank', NULL), ('', NULL), (NULL, NULL)
    ) AS t(status, stage)
  LOOP
    n := n + 1;
    failed := failed || pg_temp.cf_ok(
      public.case_final_stage_for_status(r.status) IS NOT DISTINCT FROM r.stage,
      format('case_final_stage_for_status(%L) is %L, not %L',
        r.status, public.case_final_stage_for_status(r.status), r.stage));
  END LOOP;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'cfs-owner@example.invalid'),
    (u_agent, 'cfs-agent@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent;

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'CFS-166-A1', 'x', 'connected', true) RETURNING id INTO w1;
  INSERT INTO case_banks (account_id, code, name) VALUES (a_acct, 'ENBD', 'Emirates NBD')
  ON CONFLICT DO NOTHING;

  FOR i IN 1 .. 5 LOOP
    INSERT INTO contacts (account_id, user_id, phone, name)
    VALUES (a_acct, u_agent, '97150016600' || i, 'CFS ' || i) RETURNING id INTO ct;
    g := g || (SELECT x.group_id FROM sg_open(a_acct, 'CFS-166-' || i, ct, w1, 'case ' || i, NULL,
                 jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL) x);
    k := k || (SELECT x.case_id FROM case_open(g[i], 'ENBD', NULL, 'Card', NULL, NULL) x);
  END LOOP;
  IF array_length(k, 1) IS DISTINCT FROM 5 OR array_position(k, NULL) IS NOT NULL
     OR EXISTS (SELECT 1 FROM cases WHERE id = ANY (k) AND (stage <> 'Submitted' OR closed_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'fixture: five open cases at Submitted were not opened';
  END IF;

  -- ---------- 2. the new labels close a case as Withdrawn ----------
  b1 := case_apply_submission_status(g[1], 'Customer Withdrawn');
  n := n + 1; failed := failed || pg_temp.cf_ok(b1 AND EXISTS (
      SELECT 1 FROM cases WHERE id = k[1] AND stage = 'Withdrawn' AND outcome = 'Withdrawn'
         AND closed_at IS NOT NULL),
    'Customer Withdrawn did not close the case as Withdrawn');
  n := n + 1; failed := failed || pg_temp.cf_ok(EXISTS (
      SELECT 1 FROM case_stage_history WHERE case_id = k[1] AND from_stage = 'Submitted'
         AND to_stage = 'Withdrawn' AND outcome = 'Withdrawn' AND actor_id IS NULL AND actor_role = 'api'),
    'Customer Withdrawn left no api history row');

  b1 := case_apply_submission_status(g[2], 'Agency_Withdrawn');
  n := n + 1; failed := failed || pg_temp.cf_ok(b1 AND EXISTS (
      SELECT 1 FROM cases WHERE id = k[2] AND stage = 'Withdrawn' AND outcome = 'Withdrawn'
         AND closed_at IS NOT NULL),
    'Agency_Withdrawn did not close the case as Withdrawn');
  n := n + 1; failed := failed || pg_temp.cf_ok(EXISTS (
      SELECT 1 FROM case_stage_history WHERE case_id = k[2] AND to_stage = 'Withdrawn'
         AND actor_id IS NULL AND actor_role = 'api'),
    'Agency_Withdrawn left no api history row');

  -- ---------- 3. an open status stays open ----------
  b1 := case_apply_submission_status(g[3], 'Bank Review');
  n := n + 1; failed := failed || pg_temp.cf_ok(NOT b1 AND EXISTS (
      SELECT 1 FROM cases WHERE id = k[3] AND stage = 'Submitted' AND closed_at IS NULL),
    'Bank Review moved or closed the case');
  b1 := case_apply_submission_status(g[3], 'Awaiting Fulfillment');
  n := n + 1; failed := failed || pg_temp.cf_ok(NOT b1 AND EXISTS (
      SELECT 1 FROM cases WHERE id = k[3] AND stage = 'Submitted' AND closed_at IS NULL),
    'Awaiting Fulfillment moved or closed the case');

  -- ---------- 4. a closed case is untouched ----------
  b1 := case_apply_submission_status(g[4], 'DECLINED');
  SELECT count(*) INTO i FROM case_stage_history WHERE case_id = k[4];
  b1 := case_apply_submission_status(g[4], 'Customer Withdrawn');
  n := n + 1; failed := failed || pg_temp.cf_ok(NOT b1 AND EXISTS (
      SELECT 1 FROM cases WHERE id = k[4] AND stage = 'Declined' AND outcome = 'Declined')
      AND (SELECT count(*) FROM case_stage_history WHERE case_id = k[4]) = i,
    'Customer Withdrawn changed a case already closed as Declined');

  -- ---------- 5. the repair ----------
  b1 := sg_note_submission_status(g[5], 'Customer Withdrawn');
  b1 := sg_note_submission_status(g[3], 'Bank Review');
  v_closed := pg_temp.cf_repair();
  n := n + 1; failed := failed || pg_temp.cf_ok(v_closed >= 1 AND EXISTS (
      SELECT 1 FROM cases WHERE id = k[5] AND stage = 'Withdrawn' AND outcome = 'Withdrawn'
         AND closed_at IS NOT NULL)
      AND EXISTS (SELECT 1 FROM case_stage_history WHERE case_id = k[5] AND to_stage = 'Withdrawn'
         AND actor_role = 'api'),
    format('the repair did not close an open case holding Customer Withdrawn (closed %s)', v_closed));
  n := n + 1; failed := failed || pg_temp.cf_ok(EXISTS (
      SELECT 1 FROM cases WHERE id = k[3] AND stage = 'Submitted' AND closed_at IS NULL),
    'the repair closed a case holding an open status');
  v_closed := pg_temp.cf_repair();
  n := n + 1; failed := failed || pg_temp.cf_ok(v_closed = 0,
    format('a second repair pass closed %s more case(s)', v_closed));

  -- ---------- 6. privileges ----------
  n := n + 1; failed := failed || pg_temp.cf_ok(
    NOT has_function_privilege('authenticated', 'public.case_final_stage_for_status(text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.case_final_stage_for_status(text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.case_apply_submission_status(uuid, text)', 'EXECUTE')
    AND has_function_privilege('service_role', 'public.case_apply_submission_status(uuid, text)', 'EXECUTE'),
    'case_final_stage_for_status / case_apply_submission_status are not the service role''s alone');

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT166', MESSAGE = 'verify-compass-finished-statuses rollback';
  EXCEPTION WHEN SQLSTATE 'ZT166' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'compass finished statuses verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'compass finished statuses verification passed (% checks)', n;
END
$verify$;
