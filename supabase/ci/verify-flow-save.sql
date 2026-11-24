-- Behavioural suite for migration 300: a flow is saved at once or not at
-- all, in place by node_key, by an admin of the account only, and never
-- over somebody else's save; a counted run or a status change is no edit.
--
-- ONE statement on purpose (the pinned CLI rejects several). Fixtures
-- are rolled back by a sentinel exception; the results survive.

DO $verify$
DECLARE
  u_ow UUID := '00000000-0000-4000-8000-000000300001';
  u_ad UUID := '00000000-0000-4000-8000-000000300002';
  u_ag UUID := '00000000-0000-4000-8000-000000300003';
  u_gu UUID := '00000000-0000-4000-8000-000000300004';
  u_ot UUID := '00000000-0000-4000-8000-000000300005';
  a UUID; f UUID; ct UUID; run UUID; menu UUID;
  t0 TIMESTAMPTZ; t1 TIMESTAMPTZ; t2 TIMESTAMPTZ; tx TIMESTAMPTZ;
  r TEXT;
  u UUID;
  full_set JSONB := '[
    {"node_key":"start","node_type":"start","config":{"next_node_key":"menu"},"position_x":1,"position_y":2},
    {"node_key":"menu","node_type":"send_buttons","config":{"text":"Hi"}},
    {"node_key":"bye","node_type":"end","config":{}}]';
  n INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.fls(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; h text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
        PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        EXECUTE p_sql INTO v;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN v;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ' ' || coalesce(h, '');
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.fls_save(p_uid uuid, p_flow uuid, p_patch jsonb, p_nodes jsonb, p_expected timestamptz)
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.fls(p_uid, format('SELECT public.flow_save(%L, %L, %L, %L)', p_flow, p_patch, p_nodes, p_expected))
    $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_ow, 'fls-owner@example.invalid'), (u_ad, 'fls-admin@example.invalid'),
    (u_ag, 'fls-agent@example.invalid'), (u_gu, 'fls-guest@example.invalid'),
    (u_ot, 'fls-other@example.invalid') ON CONFLICT DO NOTHING;
  SELECT id INTO a FROM public.accounts WHERE owner_user_id = u_ow;
  IF a IS NULL THEN RAISE EXCEPTION 'fixture: no account'; END IF;
  UPDATE public.profiles SET account_id = a, account_role = 'admin' WHERE user_id = u_ad;
  UPDATE public.profiles SET account_id = a, account_role = 'agent' WHERE user_id = u_ag;
  UPDATE public.profiles SET account_id = a, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_gu;
  INSERT INTO public.flows (account_id, user_id, name, status, trigger_type, entry_node_id, created_at, updated_at)
    VALUES (a, u_ow, 'one', 'active', 'manual', 'start', now() - interval '1 day', now() - interval '1 day')
    RETURNING id, created_at INTO f, t0;

  -- An admin's first save: the columns, the nodes in the order sent, who.
  r := pg_temp.fls_save(u_ad, f, '{"name":"two","description":null,"trigger_config":{"k":1}}', full_set, t0);
  n := n + 1;
  IF r LIKE 'ERROR%' THEN RAISE EXCEPTION 'verify-flow-save: first save: %', r; END IF;
  t1 := (r::jsonb->>'edited_at')::timestamptz;
  IF t1 <= t0 OR (r::jsonb->>'updated_at')::timestamptz <= t0
     OR NOT EXISTS (SELECT 1 FROM public.flows WHERE id = f AND name = 'two' AND edited_at = t1 AND edited_by = u_ad
                      AND updated_at > t0 AND status = 'active' AND entry_node_id = 'start' AND trigger_config = '{"k":1}')
     OR (SELECT string_agg(node_key || position_y, ',' ORDER BY created_at) FROM public.flow_nodes WHERE flow_id = f)
        IS DISTINCT FROM 'start2,menu0,bye0' THEN
    failed := failed || ('first save: ' || r); END IF;
  SELECT id INTO menu FROM public.flow_nodes WHERE flow_id = f AND node_key = 'menu';

  -- A customer waits at the menu. Counting a run, a status change: no edit.
  INSERT INTO public.contacts (account_id, user_id, phone, name) VALUES (a, u_ow, '971500300001', 'fls') RETURNING id INTO ct;
  INSERT INTO public.flow_runs (flow_id, account_id, user_id, contact_id, status, current_node_key)
    VALUES (f, a, u_ow, ct, 'active', 'menu') RETURNING id INTO run;
  PERFORM public.increment_flow_execution_count(f);
  UPDATE public.flows SET status = 'draft', updated_at = now() WHERE id = f;

  -- An unrelated edit: one node moved to the front, one removed, one added.
  r := pg_temp.fls_save(u_ow, f, '{}', '[
    {"node_key":"hand","node_type":"handoff","config":{"note":"x"}},
    {"node_key":"start","node_type":"start","config":{"next_node_key":"menu"},"position_x":9},
    {"node_key":"menu","node_type":"send_buttons","config":{"text":"Hi"}}]', t1);
  n := n + 1;
  IF r LIKE 'ERROR%' THEN RAISE EXCEPTION 'verify-flow-save: second save: %', r; END IF;
  t2 := (r::jsonb->>'edited_at')::timestamptz;
  IF t2 <= t1
     OR (SELECT string_agg(node_key || position_x, ',' ORDER BY created_at) FROM public.flow_nodes WHERE flow_id = f)
        IS DISTINCT FROM 'hand0,start9,menu0' THEN failed := failed || ('second save: ' || r); END IF;
  n := n + 1;
  IF (SELECT s.id FROM public.flow_runs x JOIN public.flow_nodes s ON s.flow_id = x.flow_id AND s.node_key = x.current_node_key
       WHERE x.id = run AND x.status = 'active') IS DISTINCT FROM menu THEN failed := failed || 'the run lost its node'::text; END IF;

  -- The loser of two saves changes nothing, whatever version it names.
  FOREACH tx IN ARRAY ARRAY[t0, t1, t2 + interval '1 second'] LOOP
    r := pg_temp.fls_save(u_ad, f, '{"name":"lost"}', '[]', tx); n := n + 1;
    IF r <> 'ERROR 23514 FLOW_CHANGED' THEN failed := failed || ('expected: ' || r); END IF;
  END LOOP;

  -- A duplicate key and an unknown type are refused whole.
  r := pg_temp.fls_save(u_ad, f, '{"name":"lost"}', full_set || '[{"node_key":"menu","node_type":"end","config":{}}]', t2); n := n + 1;
  IF r <> 'ERROR 23505 FLOW_DUPLICATE_KEY' THEN failed := failed || ('duplicate: ' || r); END IF;
  r := pg_temp.fls_save(u_ad, f, '{"name":"lost"}', '[{"node_key":"n","node_type":"nonsense","config":{}}]', t2); n := n + 1;
  IF r NOT LIKE 'ERROR 23514%' THEN failed := failed || ('type: ' || r); END IF;

  -- An agent, a bank guest, another account: no such flow.
  FOREACH u IN ARRAY ARRAY[u_ag, u_gu, u_ot] LOOP
    r := pg_temp.fls_save(u, f, '{"name":"lost"}', '[]', NULL); n := n + 1;
    IF r <> 'ERROR P0002 FLOW_NOT_FOUND' THEN failed := failed || ('caller: ' || u || ' ' || r); END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.flow_save(uuid,jsonb,jsonb,timestamptz)', 'EXECUTE')
     OR (SELECT prosecdef FROM pg_proc WHERE oid = 'public.flow_save(uuid,jsonb,jsonb,timestamptz)'::regprocedure) THEN
    failed := failed || 'grants'::text; END IF;

  -- After every refusal: the flow and its nodes as they were.
  n := n + 1;
  IF (SELECT name FROM public.flows WHERE id = f AND edited_at = t2) IS DISTINCT FROM 'two'
     OR (SELECT string_agg(node_key, ',' ORDER BY created_at) FROM public.flow_nodes WHERE flow_id = f)
        IS DISTINCT FROM 'hand,start,menu' THEN failed := failed || 'a refused save changed something'::text; END IF;

  -- No nodes named: they stay. No version named: not checked.
  r := pg_temp.fls_save(u_ad, f, '{"name":"three"}', NULL, NULL); n := n + 1;
  IF r LIKE 'ERROR%' OR (SELECT count(*) FROM public.flow_nodes WHERE flow_id = f) <> 3
     OR (SELECT name FROM public.flows WHERE id = f) <> 'three' THEN failed := failed || ('header only: ' || r); END IF;

  -- The previous build's separate writes still work.
  DELETE FROM public.flow_nodes WHERE flow_id = f;
  INSERT INTO public.flow_nodes (flow_id, node_key, node_type) VALUES (f, 'start', 'start');
  r := pg_temp.fls_save(u_ad, f, '{}', full_set, NULL); n := n + 1;
  IF r LIKE 'ERROR%' OR (SELECT count(*) FROM public.flow_nodes WHERE flow_id = f) <> 3 THEN failed := failed || ('old build: ' || r); END IF;

  RAISE EXCEPTION 'FLS_ROLLBACK';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'FLS_ROLLBACK' THEN RAISE; END IF;
  END;

  IF n <> 14 THEN RAISE EXCEPTION 'verify-flow-save: only % checks ran', n; END IF;
  IF cardinality(failed) > 0 THEN
    RAISE EXCEPTION 'verify-flow-save: % failed: %', cardinality(failed), array_to_string(failed, '; ');
  END IF;
  RAISE NOTICE 'verify-flow-save: % checks passed', n;
END $verify$;
