-- ============================================================
-- Migration 311: erasing one customer takes their own calls and calls
-- linked to nobody, never a call linked to another customer (a candidate,
-- the number, its last 8 digits), in pbx_erase_contact_calls and in
-- privacy_subject_erase; a hold on another customer's recording refuses
-- nothing; the retention sweep's held calls follow the same match. Both
-- erases delete the erased calls' deal_files references on any deal. A
-- call is on a deal once. Linking drops the candidates and never points
-- the call at a personal chat. Leaves nothing behind (everything in one
-- rolled-back block).
-- ============================================================
DO $verify$
DECLARE
  u_own uuid := gen_random_uuid();
  a uuid; c_a uuid; c_b uuid; c_d uuid; c_p uuid;
  p uuid; s uuid; d_b uuid; d_none uuid;
  k_own uuid; k_cand_b uuid; k_num_b uuid; k_r8_b uuid;
  k_free uuid; k_free_num uuid; k_free_r8 uuid; k_link uuid; k_pers uuid;
  v_co uuid; v_me uuid;
  fn text; st text; want text[]; got text[]; j jsonb; paths text[];
  failed text[] := '{}'; n int := 0;
BEGIN
  BEGIN
  INSERT INTO auth.users (id, email) VALUES (u_own, 'eoc-own@example.invalid');
  SELECT id INTO a FROM accounts WHERE owner_user_id = u_own;
  IF a IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a, u_own, '971501112233', 'eoc A') RETURNING id INTO c_a;
  -- B: the same line with a trunk 0, so a call from it matched both.
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a, u_own, '9710501112233', 'eoc B') RETURNING id INTO c_b;
  -- D: national form, found by the last 8 digits only.
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a, u_own, '047654399', 'eoc D') RETURNING id INTO c_d;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a, u_own, '971501119999', 'eoc P') RETURNING id INTO c_p;

  INSERT INTO calls (account_id, pbx_call_id, direction, status, contact_id, remote_number, meta, notes, recording_state, disposition, started_at)
  SELECT a, 'eoc-' || x.k, 'inbound', 'answered', x.c, x.num,
         CASE WHEN x.cand THEN jsonb_build_object('contact_candidates', jsonb_build_array(c_a, c_b), 'kept', 1) ELSE '{}' END,
         'eoc note', 'fetched', 'interested', now() - interval '400 days'
    FROM (VALUES
      ('own', c_a, '971501112233', false), ('cand-b', c_b, '971509990001', true),
      ('num-b', c_b, '971501112233', false), ('r8-b', c_b, '97147654399', false),
      ('free', NULL, '971509990002', true), ('free-num', NULL, '971501112233', false),
      ('free-r8', NULL, '97147654399', false), ('link', NULL, '971509990003', true),
      ('pers', NULL, '971509990004', false)) x(k, c, num, cand);
  SELECT id INTO k_own FROM calls WHERE account_id = a AND pbx_call_id = 'eoc-own';
  SELECT id INTO k_cand_b FROM calls WHERE account_id = a AND pbx_call_id = 'eoc-cand-b';
  SELECT id INTO k_num_b FROM calls WHERE account_id = a AND pbx_call_id = 'eoc-num-b';
  SELECT id INTO k_r8_b FROM calls WHERE account_id = a AND pbx_call_id = 'eoc-r8-b';
  SELECT id INTO k_free FROM calls WHERE account_id = a AND pbx_call_id = 'eoc-free';
  SELECT id INTO k_free_num FROM calls WHERE account_id = a AND pbx_call_id = 'eoc-free-num';
  SELECT id INTO k_free_r8 FROM calls WHERE account_id = a AND pbx_call_id = 'eoc-free-r8';
  SELECT id INTO k_link FROM calls WHERE account_id = a AND pbx_call_id = 'eoc-link';
  SELECT id INTO k_pers FROM calls WHERE account_id = a AND pbx_call_id = 'eoc-pers';
  INSERT INTO call_recordings (call_id, account_id, storage_path, announcement_played)
  SELECT c.id, a, format('account-%s/calls/%s.wav', a, c.id), true FROM calls c
   WHERE c.account_id = a AND c.id NOT IN (k_link, k_pers);

  INSERT INTO pipelines (account_id, user_id, name) VALUES (a, u_own, 'eoc') RETURNING id INTO p;
  INSERT INTO pipeline_stages (pipeline_id, name, position) VALUES (p, 'eoc', 0) RETURNING id INTO s;
  INSERT INTO deals (account_id, user_id, pipeline_id, stage_id, title, contact_id)
  VALUES (a, u_own, p, s, 'eoc B deal', c_b) RETURNING id INTO d_b;
  INSERT INTO deals (account_id, user_id, pipeline_id, stage_id, title)
  VALUES (a, u_own, p, s, 'eoc no one''s deal') RETURNING id INTO d_none;
  INSERT INTO deal_files (account_id, deal_id, name, source, ref_type, ref_id) VALUES
    (a, d_b, 'Call recording eoc A', 'call_recording', 'call', k_own::text),
    (a, d_none, 'Call recording eoc A', 'call_recording', 'call', k_free::text),
    (a, d_b, 'Call recording eoc B', 'call_recording', 'call', k_cand_b::text),
    (a, d_b, 'other reference', 'upload', 'group_message', k_own::text);
  -- None is written with a file of its own; one that had it is listed too.
  INSERT INTO deal_files (account_id, deal_id, storage_path, name, source, ref_type, ref_id)
  VALUES (a, d_none, format('account-%s/eoc/own.wav', a), 'Call recording eoc A', 'call_recording', 'call', k_own::text);

  PERFORM set_config('request.jwt.claim.sub', u_own::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u_own, 'role', 'authenticated')::text, true);

  -- 1 and 2. Another customer's recordings are on hold throughout.
  UPDATE call_recordings SET legal_hold = true WHERE call_id IN (k_cand_b, k_num_b, k_r8_b);
  FOREACH fn IN ARRAY ARRAY['pbx', 'privacy'] LOOP
    FOR i IN 1..2 LOOP
      st := NULL; j := NULL; paths := NULL; got := NULL;
      BEGIN
        IF fn = 'pbx' THEN
          paths := pbx_erase_contact_calls(CASE i WHEN 1 THEN c_a ELSE c_d END, 'eoc');
        ELSE
          j := privacy_subject_erase(u_own, a, CASE i WHEN 1 THEN c_a ELSE c_d END, false,
                                     'ERASE ' || CASE i WHEN 1 THEN c_a ELSE c_d END);
          st := j ->> 'blocked';
        END IF;
        SELECT array_agg(pbx_call_id ORDER BY pbx_call_id) INTO got FROM calls WHERE account_id = a AND erased_at IS NOT NULL;
        want := CASE i WHEN 1 THEN ARRAY['eoc-free', 'eoc-free-num', 'eoc-link', 'eoc-own'] ELSE ARRAY['eoc-free-r8'] END;
        n := n + 1;
        IF st IS NOT NULL OR got IS DISTINCT FROM want THEN
          failed := array_append(failed, format('%s %s: erased %s (%s), not %s', fn, i, got, st, want));
        END IF;
        n := n + 1;
        IF (SELECT count(*) FROM calls c JOIN call_recordings r ON r.call_id = c.id
             WHERE c.id IN (k_cand_b, k_num_b, k_r8_b) AND c.notes = 'eoc note'
               AND c.disposition = 'interested' AND r.storage_path IS NOT NULL) <> 3 THEN
          failed := array_append(failed, format('%s %s: another customer''s recording, notes or outcome went', fn, i));
        END IF;
        IF i = 1 THEN
          SELECT array_agg(name ORDER BY name) INTO got FROM deal_files WHERE account_id = a;
          n := n + 1;
          IF got IS DISTINCT FROM ARRAY['Call recording eoc B', 'other reference'] THEN
            failed := array_append(failed, format('%s: deal files left: %s', fn, got));
          END IF;
          n := n + 1;
          IF fn = 'privacy' AND position('eoc/own.wav' IN j::text) = 0 THEN
            failed := array_append(failed, 'privacy: a call reference''s own file is not listed'::text);
          END IF;
        END IF;
        RAISE EXCEPTION USING ERRCODE = 'ZT312', MESSAGE = 'undo';
      EXCEPTION
        WHEN SQLSTATE 'ZT312' THEN NULL;
        WHEN OTHERS THEN
          n := n + 1;
          failed := array_append(failed, format('%s %s: %s', fn, i, SQLERRM));
      END;
    END LOOP;
    -- A hold on a call the erase does take still refuses it.
    BEGIN
      UPDATE call_recordings SET legal_hold = true WHERE call_id = k_free;
      st := 'erased';
      IF fn = 'pbx' THEN
        PERFORM pbx_erase_contact_calls(c_a, 'eoc');
      ELSE
        st := coalesce(privacy_subject_erase(u_own, a, c_a, false, 'ERASE ' || c_a) ->> 'blocked', st);
      END IF;
      RAISE EXCEPTION USING ERRCODE = 'ZT312', MESSAGE = 'undo';
    EXCEPTION
      WHEN SQLSTATE 'ZT312' THEN NULL;
      WHEN SQLSTATE '55000' THEN st := 'legal_hold';
    END;
    n := n + 1;
    IF st <> 'legal_hold' THEN
      failed := array_append(failed, format('%s: a held call linked to nobody did not refuse: %s', fn, st));
    END IF;
  END LOOP;

  -- The sweep keeps a held customer's calls by the same match.
  BEGIN
    -- The sweep leaves a call whose recording is still there.
    DELETE FROM call_recordings WHERE account_id = a;
    PERFORM privacy_legal_hold_set(u_own, a, c_a, true, 'eoc');
    PERFORM privacy_retention_set(u_own, a, '{"tables": {"call_records": {"days": 30, "action": "anonymise"}}}', true);
    PERFORM privacy_retention_sweep(a);
    SELECT array_agg(pbx_call_id ORDER BY pbx_call_id) INTO got FROM calls WHERE account_id = a AND erased_at IS NULL;
    RAISE EXCEPTION USING ERRCODE = 'ZT312', MESSAGE = 'undo';
  EXCEPTION WHEN SQLSTATE 'ZT312' THEN NULL;
  END;
  n := n + 1;
  IF got IS DISTINCT FROM ARRAY['eoc-free', 'eoc-free-num', 'eoc-link', 'eoc-own'] THEN
    failed := array_append(failed, format('the sweep kept for a held customer: %s', got));
  END IF;

  -- 3. One reference per call and deal; other references are not its business.
  n := n + 1;
  BEGIN
    INSERT INTO deal_files (account_id, deal_id, name, source, ref_type, ref_id)
    VALUES (a, d_b, 'again', 'call_recording', 'call', k_own::text);
    failed := array_append(failed, 'a second reference of a call on a deal was stored'::text);
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  n := n + 1;
  BEGIN
    INSERT INTO deal_files (account_id, deal_id, name, source, ref_type, ref_id)
    VALUES (a, d_b, 'again', 'upload', 'group_message', k_own::text);
  EXCEPTION WHEN unique_violation THEN
    failed := array_append(failed, 'another kind of reference was refused'::text);
  END;

  -- 4. Linking: the company chat, never the newer personal one; none when
  -- there is only a personal one. The candidates go, the rest of meta stays.
  INSERT INTO conversations (account_id, user_id, contact_id, created_at)
  VALUES (a, u_own, c_b, now() - interval '2 days') RETURNING id INTO v_co;
  INSERT INTO conversations (account_id, user_id, contact_id, personal_owner_id, created_at)
  VALUES (a, u_own, c_b, u_own, now()) RETURNING id INTO v_me;
  INSERT INTO conversations (account_id, user_id, contact_id, personal_owner_id)
  VALUES (a, u_own, c_p, u_own);
  PERFORM pbx_link_call_contact(k_link, c_b);
  PERFORM pbx_link_call_contact(k_pers, c_p);
  n := n + 1;
  IF (SELECT conversation_id IS DISTINCT FROM v_co FROM calls WHERE id = k_link)
     OR (SELECT conversation_id IS NOT NULL FROM calls WHERE id = k_pers) THEN
    failed := array_append(failed, 'a call was linked to a personal chat'::text);
  END IF;
  n := n + 1;
  IF (SELECT meta IS DISTINCT FROM '{"kept": 1}' FROM calls WHERE id = k_link) THEN
    failed := array_append(failed, 'linking did not drop the candidates (and only them)'::text);
  END IF;

  n := n + 1;
  IF has_function_privilege('anon', 'public.pbx_erase_contact_calls(uuid, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.pbx_link_call_contact(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.privacy_subject_erase(uuid, uuid, uuid, boolean, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.privacy_retention_sweep(uuid, boolean, integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.pbx_erase_contact_calls(uuid, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.pbx_link_call_contact(uuid, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.privacy_subject_erase(uuid, uuid, uuid, boolean, text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.privacy_retention_sweep(uuid, boolean, integer)', 'EXECUTE') THEN
    failed := array_append(failed, 'function grants'::text);
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZT311', MESSAGE = 'verify-erase-own-calls rollback';
  EXCEPTION WHEN SQLSTATE 'ZT311' THEN
    NULL;
  END;
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'erase own calls verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'erase own calls verification passed (% checks)', n;
END
$verify$;
