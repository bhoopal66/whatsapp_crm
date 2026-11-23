-- Behavioural regression suite for migration 269 (waiting automation
-- runs). ONE statement on purpose (the pinned CLI rejects several);
-- fixtures are rolled back through a sentinel.

DO $verify$
DECLARE
  u UUID := '00000000-0000-4000-8000-000000269001';
  a UUID; m UUID; m2 UUID;
  c UUID := gen_random_uuid(); w UUID := gen_random_uuid(); s UUID := gen_random_uuid();
  x UUID := gen_random_uuid(); foreign_step UUID; p UUID;
  t0 timestamptz; t1 timestamptz; r jsonb; e text; n INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  INSERT INTO auth.users (id, email) VALUES (u, 'ar269-owner@example.test');
  INSERT INTO public.accounts (name, owner_user_id) VALUES ('ar269', u) RETURNING id INTO a;
  INSERT INTO public.automations (account_id, user_id, name, trigger_type, updated_at)
    VALUES (a, u, 'one', 'keyword_match', now() - interval '1 day') RETURNING id, updated_at INTO m, t0;
  INSERT INTO public.automations (account_id, user_id, name, trigger_type)
    VALUES (a, u, 'two', 'keyword_match') RETURNING id INTO m2;
  INSERT INTO public.automation_steps (automation_id, step_type, position)
    VALUES (m2, 'wait', 0) RETURNING id INTO foreign_step;

  -- Counting a run does not move updated_at.
  PERFORM public.increment_automation_execution_count(m);
  SELECT updated_at INTO t1 FROM public.automations WHERE id = m;
  IF t1 <> t0 THEN failed := failed || 'a counted run moved updated_at'; END IF; n := n + 1;

  -- A condition with a wait inside it, from the version that was loaded.
  r := public.automation_save(a, m, t0, '{"name": "saved"}', jsonb_build_array(
    jsonb_build_object('id', c, 'parent_step_id', null, 'branch', null, 'step_type', 'condition', 'step_config', '{}'::jsonb, 'position', 0),
    jsonb_build_object('id', w, 'parent_step_id', c, 'branch', 'yes', 'step_type', 'wait', 'step_config', '{"amount":1}'::jsonb, 'position', 0),
    jsonb_build_object('id', s, 'parent_step_id', c, 'branch', 'yes', 'step_type', 'send_message', 'step_config', '{}'::jsonb, 'position', 1)));
  IF r->>'status' <> 'saved' OR (r->>'updated_at')::timestamptz <= t0 THEN failed := failed || ('save: ' || r); END IF; n := n + 1;
  t1 := (r->>'updated_at')::timestamptz;
  IF (SELECT name || is_active FROM public.automations WHERE id = m) <> 'savedfalse' THEN failed := failed || 'patch'::text; END IF; n := n + 1;

  INSERT INTO public.automation_pending_executions
    (automation_id, account_id, user_id, parent_step_id, branch, next_step_position, wait_step_id, run_at)
    VALUES (m, a, u, c, 'yes', 1, w, now()) RETURNING id INTO p;
  IF (SELECT attempts FROM public.automation_pending_executions WHERE id = p) <> 0 THEN failed := failed || 'attempts'::text; END IF; n := n + 1;

  -- The loser of two saves changes nothing.
  r := public.automation_save(a, m, t0, '{"name": "lost"}', '[]');
  IF r->>'status' <> 'conflict'
     OR (SELECT name FROM public.automations WHERE id = m) <> 'saved'
     OR (SELECT count(*) FROM public.automation_steps WHERE automation_id = m) <> 3 THEN
    failed := failed || ('conflict: ' || r); END IF; n := n + 1;

  -- Kept in place: a step added first, the send removed, the rest by id.
  r := public.automation_save(a, m, t1, '{}', jsonb_build_array(
    jsonb_build_object('id', x, 'step_type', 'send_message', 'position', 0),
    jsonb_build_object('id', c, 'step_type', 'condition', 'position', 1),
    jsonb_build_object('id', w, 'parent_step_id', c, 'branch', 'no', 'step_type', 'wait', 'position', 0)));
  IF r->>'status' <> 'saved'
     OR (SELECT count(*) FROM public.automation_steps WHERE automation_id = m) <> 3
     OR EXISTS (SELECT 1 FROM public.automation_steps WHERE id = s)
     OR (SELECT branch FROM public.automation_steps WHERE id = w) <> 'no'
     OR (SELECT parent_step_id FROM public.automation_pending_executions WHERE id = p) IS DISTINCT FROM c THEN
    failed := failed || ('in place: ' || r); END IF; n := n + 1;

  -- A step moved out of a removed condition stays; the parked row still
  -- names its wait.
  r := public.automation_save(a, m, NULL, '{}', jsonb_build_array(
    jsonb_build_object('id', w, 'step_type', 'wait', 'position', 0)));
  IF (SELECT count(*) FROM public.automation_steps WHERE automation_id = m AND id = w) <> 1
     OR (SELECT wait_step_id FROM public.automation_pending_executions WHERE id = p) <> w THEN
    failed := failed || ('moved out: ' || r); END IF; n := n + 1;

  -- No steps named: they stay. Another account's automation: not found.
  r := public.automation_save(a, m, NULL, '{"is_active": true}', NULL);
  IF (SELECT count(*) FROM public.automation_steps WHERE automation_id = m) <> 1
     OR NOT (SELECT is_active FROM public.automations WHERE id = m) THEN failed := failed || 'switch'::text; END IF; n := n + 1;
  r := public.automation_save(gen_random_uuid(), m, NULL, '{"name": "stolen"}', '[]');
  IF r->>'status' <> 'not_found' THEN failed := failed || ('account: ' || r); END IF; n := n + 1;

  -- A step of another automation is refused and untouched.
  e := NULL;
  BEGIN
    PERFORM public.automation_save(a, m, NULL, '{}', jsonb_build_array(
      jsonb_build_object('id', foreign_step, 'step_type', 'send_message', 'position', 0)));
  EXCEPTION WHEN OTHERS THEN e := SQLERRM;
  END;
  IF e IS NULL OR (SELECT automation_id FROM public.automation_steps WHERE id = foreign_step) <> m2 THEN
    failed := failed || 'foreign step'::text; END IF; n := n + 1;

  IF has_function_privilege('authenticated', 'public.automation_save(uuid,uuid,timestamptz,jsonb,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.automation_save(uuid,uuid,timestamptz,jsonb,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.automation_save(uuid,uuid,timestamptz,jsonb,jsonb)', 'EXECUTE') THEN
    failed := failed || 'grants'::text; END IF; n := n + 1;

  RAISE EXCEPTION 'AR_ROLLBACK';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'AR_ROLLBACK' THEN RAISE; END IF;
  END;

  IF n <> 11 THEN RAISE EXCEPTION 'verify-automation-runs: only % checks ran', n; END IF;
  IF cardinality(failed) > 0 THEN
    RAISE EXCEPTION 'verify-automation-runs: % failed: %', cardinality(failed), array_to_string(failed, '; ');
  END IF;
  RAISE NOTICE 'verify-automation-runs: % checks passed', n;
END $verify$;
