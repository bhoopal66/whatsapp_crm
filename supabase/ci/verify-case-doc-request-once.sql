-- A case's document request goes out once (migration 297).
--
-- A claim is one row; a second one within 10 minutes is refused with who
-- and when, whoever asks; p_force sends again; a released claim and one
-- older than 10 minutes refuse nothing. Without p_claim (the macro
-- preview, a build from before 297) nothing is refused and nothing is
-- claimed, and the two-argument call resolves. Marking records a request
-- only when the actor has none in the last 10 minutes. Reads as
-- case_documents; only the service role executes the functions.
--
-- ONE statement on purpose (see verify-case-tools.sql); rolled back.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000297001';
  u_agent  UUID := '00000000-0000-4000-8000-000000297002';  -- agent of k1, k2
  u_coord  UUID := '00000000-0000-4000-8000-000000297003';  -- coordinator on k1's group
  u_other  UUID := '00000000-0000-4000-8000-000000297004';  -- an agent on neither
  u_bown   UUID := '00000000-0000-4000-8000-000000297005';  -- owner of account B
  u_guest  UUID := '00000000-0000-4000-8000-000000297006';  -- a bank guest in A
  a_acct   UUID;
  b_acct   UUID;
  wa       UUID;
  ca       UUID;
  g1       UUID;
  g2       UUID;
  k1       UUID;
  k2       UUID;
  r1       UUID;
  r2       UUID;
  rec      RECORD;
  h        TEXT;
  d        TEXT;
  fn       TEXT;
  ro       TEXT;
  pv       TEXT;
  b1       BOOLEAN;
  i        INT;
  u        UUID;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cdr_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cdr_sees(p_uid uuid, p_case uuid)
    RETURNS int LANGUAGE plpgsql AS $body$
    DECLARE v int;
    BEGIN
      PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
      PERFORM set_config('request.jwt.claims',
        json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      SELECT count(*) INTO v FROM public.case_doc_requests q WHERE q.case_id = p_case;
      RESET ROLE;
      PERFORM set_config('request.jwt.claim.sub', '', true);
      PERFORM set_config('request.jwt.claims', '', true);
      RETURN v;
    END $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'cdr-owner@example.invalid'),
    (u_agent, 'cdr-agent@example.invalid'),
    (u_coord, 'cdr-coord@example.invalid'),
    (u_other, 'cdr-other@example.invalid'),
    (u_bown,  'cdr-bown@example.invalid'),
    (u_guest, 'cdr-guest@example.invalid');
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_bown;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agent, u_coord, u_other);
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'CDRB' WHERE user_id = u_guest;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'CDR-297-A1', 'x', 'connected', true) RETURNING id INTO wa;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500297001', 'CDR one')
    RETURNING id INTO ca;
  g1 := (SELECT x.group_id FROM sg_open(a_acct, 'CDR-297-1', ca, wa, 'cdr 1', NULL,
    jsonb_build_array(jsonb_build_object('user_id', u_coord, 'label', 'coordinator'),
                      jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL) x);
  g2 := (SELECT x.group_id FROM sg_open(a_acct, 'CDR-297-2', ca, wa, 'cdr 2', NULL,
    jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL) x);
  k1 := (SELECT x.case_id FROM case_open(g1, 'CDRB', 'CDR Bank', 'Loan', 1000, NULL) x);
  k2 := (SELECT x.case_id FROM case_open(g2, 'CDRB', NULL, NULL, NULL, NULL) x);
  IF k1 IS NULL OR k2 IS NULL THEN RAISE EXCEPTION 'fixture: case_open returned no case'; END IF;
  INSERT INTO case_doc_requirements (account_id, bank_code, product, doc_key, label, position)
  VALUES (a_acct, 'CDRB', 'Loan', 'eid', 'Emirates ID', 1), (a_acct, 'CDRB', 'Loan', 'salary', 'Salary', 2);

  -- ---------- without p_claim: as before 297 ----------
  SELECT * INTO rec FROM case_doc_request_begin(k1, u_agent);
  n := n + 1; failed := failed || pg_temp.cdr_ok(
    rec.account_id = a_acct AND rec.group_id = g1 AND rec.submission_ref = 'CDR-297-1'
    AND rec.bank_name = 'CDR Bank' AND rec.doc_keys = ARRAY['eid', 'salary']
    AND rec.doc_labels = ARRAY['Emirates ID', 'Salary'] AND rec.request_id IS NULL,
    'the two-argument call does not answer as before');
  n := n + 1; failed := failed || pg_temp.cdr_ok(NOT EXISTS (SELECT 1 FROM case_doc_requests WHERE case_id = k1),
    'a call without p_claim claimed');

  -- ---------- claim ----------
  SELECT x.request_id INTO r1 FROM case_doc_request_begin(p_case => k1, p_actor => u_agent, p_claim => true) x;
  n := n + 1; failed := failed || pg_temp.cdr_ok(
    (SELECT count(*) FROM case_doc_requests WHERE case_id = k1) = 1
    AND EXISTS (SELECT 1 FROM case_doc_requests WHERE id = r1 AND case_id = k1 AND account_id = a_acct
                 AND requested_by = u_agent AND requested_at = now()),
    'a claim did not write exactly its row');

  -- ---------- refusal: anyone, the claimer included ----------
  UPDATE case_doc_requests SET requested_at = now() - interval '9 minutes' WHERE id = r1;
  FOREACH u IN ARRAY ARRAY[u_coord, u_agent] LOOP
    h := NULL; d := NULL;
    BEGIN
      PERFORM * FROM case_doc_request_begin(k1, u, false, true);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT, d = PG_EXCEPTION_DETAIL;
    END;
    n := n + 1; failed := failed || pg_temp.cdr_ok(h = 'REQUESTED_RECENTLY'
      AND d::jsonb ->> 'by' = u_agent::text
      AND (d::jsonb ->> 'at')::timestamptz = now() - interval '9 minutes',
      format('a second claim was not refused with who and when (%s / %s)', h, d));
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cdr_ok((SELECT count(*) FROM case_doc_requests WHERE case_id = k1) = 1,
    'a refused claim wrote a row');

  -- ---------- no p_claim: not refused either ----------
  h := NULL;
  BEGIN
    SELECT * INTO rec FROM case_doc_request_begin(k1, u_coord);
    n := n + 1; failed := failed || pg_temp.cdr_ok(rec.doc_keys = ARRAY['eid', 'salary'] AND rec.request_id IS NULL,
      'a preview inside the 10 minutes does not answer as before');
    PERFORM * FROM case_doc_request_begin(k1, u_coord, true, false);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
  END;
  n := n + 1; failed := failed || pg_temp.cdr_ok(h IS NULL
    AND (SELECT count(*) FROM case_doc_requests WHERE case_id = k1) = 1,
    format('a call without p_claim was refused, or claimed (%s)', h));

  -- ---------- force ----------
  SELECT x.request_id INTO r2 FROM case_doc_request_begin(k1, u_coord, true, true) x;
  n := n + 1; failed := failed || pg_temp.cdr_ok(r2 IS NOT NULL
    AND (SELECT count(*) FROM case_doc_requests WHERE case_id = k1) = 2, 'p_force did not claim again');

  -- ---------- release ----------
  b1 := case_doc_request_release(k1, u_agent, r2);
  n := n + 1; failed := failed || pg_temp.cdr_ok(NOT b1 AND EXISTS (SELECT 1 FROM case_doc_requests WHERE id = r2),
    'someone released another person''s claim');
  b1 := case_doc_request_release(k2, u_coord, r2);
  n := n + 1; failed := failed || pg_temp.cdr_ok(NOT b1 AND EXISTS (SELECT 1 FROM case_doc_requests WHERE id = r2),
    'a claim was released through another case');
  b1 := case_doc_request_release(k1, u_coord, r2);
  n := n + 1; failed := failed || pg_temp.cdr_ok(b1
    AND (SELECT array_agg(id) FROM case_doc_requests WHERE case_id = k1) = ARRAY[r1],
    'a release did not delete exactly its claim');
  b1 := case_doc_request_release(k1, u_agent, r1);
  r1 := NULL; h := NULL;
  BEGIN
    SELECT x.request_id INTO r1 FROM case_doc_request_begin(k1, u_coord, false, true) x;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
  END;
  n := n + 1; failed := failed || pg_temp.cdr_ok(r1 IS NOT NULL,
    format('a released claim still refused the next one (%s)', h));

  -- ---------- 10 minutes ----------
  UPDATE case_doc_requests SET requested_at = now() - interval '10 minutes' WHERE case_id = k1;
  r2 := NULL; h := NULL;
  BEGIN
    SELECT x.request_id INTO r2 FROM case_doc_request_begin(k1, u_agent, false, true) x;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
  END;
  n := n + 1; failed := failed || pg_temp.cdr_ok(r2 IS NOT NULL, format('a claim 10 minutes old still refused (%s)', h));

  -- ---------- mark ----------
  -- u_agent's claim is there: none added. u_coord's is too old (as a
  -- build from before 297 has none): one added, once.
  i := case_doc_mark_requested(k1, u_agent, ARRAY['eid', 'salary'], now());
  n := n + 1; failed := failed || pg_temp.cdr_ok(i = 2
    AND (SELECT count(*) FROM case_doc_requests WHERE case_id = k1 AND requested_by = u_agent) = 1,
    'marking after a claim recorded the request twice');
  i := case_doc_mark_requested(k1, u_coord, ARRAY['eid'], '2026-01-01 00:00:00+00');
  i := case_doc_mark_requested(k1, u_coord, ARRAY['eid'], NULL);
  n := n + 1; failed := failed || pg_temp.cdr_ok(i = 1
    AND (SELECT count(*) FROM case_doc_requests WHERE case_id = k1 AND requested_by = u_coord
          AND requested_at = now()) = 1,
    'marking without a recent claim did not record exactly one request, now');

  -- ---------- nothing missing: as before, no claim, no refusal ----------
  SELECT * INTO rec FROM case_doc_request_begin(k2, u_agent, false, true);
  n := n + 1; failed := failed || pg_temp.cdr_ok(rec.doc_keys = '{}'::text[] AND rec.request_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM case_doc_requests WHERE case_id = k2), 'a claim with nothing missing claimed');
  UPDATE case_documents SET status = 'received', file_ref = 'f1' WHERE case_id = k1;
  h := NULL;
  BEGIN
    SELECT * INTO rec FROM case_doc_request_begin(k1, u_agent, false, true);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
  END;
  n := n + 1; failed := failed || pg_temp.cdr_ok(h IS NULL AND rec.doc_keys = '{}'::text[],
    'nothing missing was refused as requested recently');

  -- ---------- who may claim ----------
  FOREACH u IN ARRAY ARRAY[u_other, u_bown, u_guest] LOOP
    h := NULL;
    BEGIN
      PERFORM * FROM case_doc_request_begin(k1, u, true, true);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
    END;
    n := n + 1; failed := failed || pg_temp.cdr_ok(h = 'NOT_ALLOWED', format('%s claimed (%s)', u, h));
  END LOOP;

  -- ---------- RLS ----------
  i := (SELECT count(*) FROM case_doc_requests WHERE case_id = k1);
  FOREACH u IN ARRAY ARRAY[u_agent, u_coord, u_owner] LOOP
    n := n + 1; failed := failed || pg_temp.cdr_ok(i > 0 AND pg_temp.cdr_sees(u, k1) = i,
      format('%s cannot read the requests of their case', u));
  END LOOP;
  FOREACH u IN ARRAY ARRAY[u_other, u_bown, u_guest] LOOP
    n := n + 1; failed := failed || pg_temp.cdr_ok(pg_temp.cdr_sees(u, k1) = 0,
      format('%s reads the requests of a case they cannot see', u));
  END LOOP;

  -- ---------- grants ----------
  n := n + 1; failed := failed || pg_temp.cdr_ok(
    (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'public.case_doc_requests'::regclass),
    'case_doc_requests has no forced RLS');
  FOREACH ro IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    FOREACH pv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
      n := n + 1; failed := failed || pg_temp.cdr_ok(
        NOT has_table_privilege(ro, 'public.case_doc_requests', pv),
        format('%s may %s case_doc_requests', ro, pv));
    END LOOP;
    n := n + 1; failed := failed || pg_temp.cdr_ok(
      has_table_privilege(ro, 'public.case_doc_requests', 'SELECT') = (ro <> 'anon'),
      format('%s: wrong SELECT on case_doc_requests', ro));
    FOREACH fn IN ARRAY ARRAY['public.case_doc_request_begin(uuid, uuid, boolean, boolean)',
      'public.case_doc_mark_requested(uuid, uuid, text[], timestamptz)',
      'public.case_doc_request_release(uuid, uuid, uuid)'] LOOP
      n := n + 1; failed := failed || pg_temp.cdr_ok(
        has_function_privilege(ro, fn, 'EXECUTE') = (ro = 'service_role'), format('%s: wrong EXECUTE on %s', ro, fn));
    END LOOP;
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cdr_ok(
    (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = 'case_doc_request_begin') = 1
    AND (SELECT bool_and(p.prosecdef AND p.proconfig = ARRAY['search_path=""']) FROM pg_proc p
          WHERE p.pronamespace = 'public'::regnamespace
            AND p.proname IN ('case_doc_request_begin', 'case_doc_mark_requested', 'case_doc_request_release')),
    'case_doc_request_begin has two overloads, or a function has no pinned search_path');

  RAISE EXCEPTION USING ERRCODE = 'ZT297', MESSAGE = 'verify-case-doc-request-once rollback';
  EXCEPTION WHEN SQLSTATE 'ZT297' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'case document request verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'case document request verification passed (% checks)', n;
END
$verify$;
