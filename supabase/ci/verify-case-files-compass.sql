-- Behavioural regression suite for case files for Compass (migration 184).
--
-- The API download (audit row with api_key_id; FILE_NOT_FOUND for another
-- account's key, a revoked or expired key, an unknown ref or a ref of
-- another account; BUILD_STALE without a ready build); the who-CHECK
-- (exactly one of actor and api_key_id); a key that has downloaded cannot
-- be deleted (ON DELETE RESTRICT); the status JSON for missing, checking,
-- passed, failed and ready, with and without a build; the case.file_ready
-- latch (no event without a subscriber, one when a case becomes ready,
-- none on a re-upload of a ready case, a second after a newer failure and
-- a pass, none for a lead); privileges.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The fixtures are
-- rolled back on success too (a sentinel exception ends the block).

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000184001';
  u_admin  UUID := '00000000-0000-4000-8000-000000184002';
  u_coord  UUID := '00000000-0000-4000-8000-000000184003';  -- coordinator on every case
  u_agent  UUID := '00000000-0000-4000-8000-000000184004';  -- agent of every case
  u_other  UUID := '00000000-0000-4000-8000-000000184006';  -- owner of another workspace
  sha      TEXT := repeat('a', 64);
  a_acct   UUID;
  o_acct   UUID;
  wa       UUID;
  ca       UUID;
  cl       UUID;
  k1 UUID; k2 UUID; kl UUID; kx UUID;
  key_live UUID; key_rev UUID; key_exp UUID; key_oth UUID;
  fx       UUID;
  res      UUID;
  b1       UUID;
  v1       INT;
  st       JSONB;
  q        RECORD;
  r        TEXT;
  fn       TEXT;
  spec     JSONB := '[{"doc_key": "passport", "name_pattern": "{{doc}}", "position": 1, "merged": false},
                      {"doc_key": "emirates_id", "name_pattern": "{{doc}}", "position": 2, "merged": false},
                      {"doc_key": "salary_cert", "name_pattern": "{{doc}}", "position": 3, "required": false,
                       "merged": false}]';
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cf_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; h text;
    BEGIN
      BEGIN
        IF p_role IS NOT NULL THEN
          PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
          PERFORM set_config('request.jwt.claims',
            json_build_object('sub', p_uid, 'role', p_role)::text, true);
          EXECUTE format('SET LOCAL ROLE %I', p_role);
        END IF;
        IF p_sql ILIKE 'select%' OR p_sql ILIKE 'with%' THEN
          EXECUTE p_sql INTO v;
        ELSE
          EXECUTE p_sql;
        END IF;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(v, 'ok');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ' ' || coalesce(nullif(h, ''), '-') || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cf_check(p_name text, p_role text, p_uid uuid, p_sql text, p_like text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := pg_temp.cf_try(p_role, p_uid, p_sql);
    BEGIN
      RETURN CASE WHEN v LIKE p_like THEN NULL ELSE p_name || ' (' || v || ')' END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cf_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  -- A staff-uploaded PDF of a contact.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cf_doc(p_account uuid, p_contact uuid)
    RETURNS uuid LANGUAGE sql AS $body$
      SELECT x.document_id FROM public.customer_documents_record_internal(p_account, p_contact, 'staff_upload',
        'document', 'case-files', 'v184/' || gen_random_uuid()::text || '.pdf', now(), 'application/pdf',
        'scan.pdf', NULL, (SELECT k.user_id FROM public.contacts k WHERE k.id = p_contact)) x
    $body$
  $fn$;
  -- A fresh document of the case's customer, registered, classified as
  -- p_key and given a result (none when p_ok is NULL); returns the file id.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cf_file(p_actor uuid, p_case uuid, p_key text, p_ok boolean)
    RETURNS uuid LANGUAGE plpgsql AS $body$
    DECLARE v_c public.cases%ROWTYPE; v_f uuid; v_seq int;
    BEGIN
      SELECT * INTO v_c FROM public.cases WHERE id = p_case;
      v_f := public.case_document_file_register(p_actor, p_case, pg_temp.cf_doc(v_c.account_id, v_c.contact_id));
      SELECT x.classify_seq INTO v_seq FROM public.case_document_file_classify(p_actor, v_f, p_key) x;
      IF p_ok IS NOT NULL THEN
        PERFORM public.case_document_file_check_result(v_f, p_key, v_seq,
          jsonb_build_array(jsonb_build_object('name', 'size', 'ok', p_ok, 'detail', 'too big')), 1, NULL);
      END IF;
      RETURN v_f;
    END $body$
  $fn$;
  -- The manifest a builder sends: the case's current passed file per
  -- REQUIRED spec row, in spec position order.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cfb_man(p_case uuid)
    RETURNS jsonb LANGUAGE sql AS $body$
      SELECT jsonb_agg(jsonb_build_object('position', s.position, 'doc_key', f.doc_key, 'file_id', f.id,
                                          'renamed_name', f.renamed_name, 'pages', f.pages,
                                          'sha256', repeat('b', 64)) ORDER BY s.position)
        FROM public.case_document_files f
        JOIN public.cases c ON c.id = f.case_id
        JOIN public.case_file_specs s ON s.account_id = c.account_id AND s.bank_code = c.bank_code
                                     AND s.product = c.product AND s.doc_key = f.doc_key
       WHERE f.case_id = p_case AND f.status = 'passed' AND s.required
    $body$
  $fn$;
  -- case.file_ready events queued for a case.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cf_events(p_case uuid)
    RETURNS bigint LANGUAGE sql AS $body$
      SELECT count(*) FROM public.webhook_event_outbox o
       WHERE o.event = 'case.file_ready' AND o.payload ->> 'case_id' = p_case::text
    $body$
  $fn$;
  -- The status of every document of a status JSON, in order.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cf_st(p_status jsonb)
    RETURNS text LANGUAGE sql AS $body$
      SELECT string_agg((d ->> 'doc_key') || '=' || (d ->> 'status') || '/' || (d ->> 'required'), ',' ORDER BY o)
        FROM jsonb_array_elements(p_status -> 'documents') WITH ORDINALITY AS t(d, o)
    $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'cfc-owner@example.invalid'),
    (u_admin, 'cfc-admin@example.invalid'),
    (u_coord, 'cfc-coord@example.invalid'),
    (u_agent, 'cfc-agent@example.invalid'),
    (u_other, 'cfc-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO o_acct FROM profiles WHERE user_id = u_other;
  IF a_acct IS NULL OR o_acct IS NULL OR a_acct = o_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision two accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_coord, u_agent);

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'CFC-184-A1', 'x', 'connected', true) RETURNING id INTO wa;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500184001', 'CFC one')
    RETURNING id INTO ca;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500184002', 'CFC lead')
    RETURNING id INTO cl;

  FOR q IN SELECT * FROM (VALUES (1, 'CFC-184-1'), (2, 'CFC-184-2')) v(i, ref) LOOP
    kx := (SELECT x.case_id FROM case_open(
      (SELECT x.group_id FROM sg_open(a_acct, q.ref, ca, wa, 'case files for compass', NULL,
         jsonb_build_array(jsonb_build_object('user_id', u_coord, 'label', 'coordinator'),
                           jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL) x),
      'ADCB', 'ADCB Bank', 'Loan', 1000, NULL) x);
    IF kx IS NULL THEN
      RAISE EXCEPTION 'fixture: sg_open / case_open returned nothing for %', q.ref;
    END IF;
    CASE q.i WHEN 1 THEN k1 := kx; ELSE k2 := kx; END CASE;
  END LOOP;
  kl := case_open_lead(u_owner, a_acct, cl, 'ADCB', 'Loan', u_agent, 1000, u_coord);
  IF kl IS NULL OR (SELECT group_id FROM cases WHERE id = kl) IS NOT NULL THEN
    RAISE EXCEPTION 'fixture: case_open_lead did not open a lead without a group';
  END IF;
  INSERT INTO case_doc_requirements (account_id, bank_code, product, doc_key, label, position) VALUES
    (a_acct, 'ADCB', 'Loan', 'passport', 'Passport', 1),
    (a_acct, 'ADCB', 'Loan', 'emirates_id', 'Emirates ID', 2),
    (a_acct, 'ADCB', 'Loan', 'salary_cert', 'Salary certificate', 3);
  PERFORM case_file_spec_set(u_owner, 'ADCB', 'Loan', spec);

  INSERT INTO api_keys (account_id, name, key_prefix, key_hash)
  VALUES (a_acct, 'compass', 'v184_live', 'v184-' || gen_random_uuid()::text) RETURNING id INTO key_live;
  INSERT INTO api_keys (account_id, name, key_prefix, key_hash, revoked_at)
  VALUES (a_acct, 'revoked', 'v184_rev', 'v184-' || gen_random_uuid()::text, now()) RETURNING id INTO key_rev;
  INSERT INTO api_keys (account_id, name, key_prefix, key_hash, expires_at)
  VALUES (a_acct, 'expired', 'v184_exp', 'v184-' || gen_random_uuid()::text, now() - interval '1 day')
  RETURNING id INTO key_exp;
  INSERT INTO api_keys (account_id, name, key_prefix, key_hash)
  VALUES (o_acct, 'other', 'v184_oth', 'v184-' || gen_random_uuid()::text) RETURNING id INTO key_oth;

  -- ---------- 1. no subscriber: k2 becomes ready, nothing is queued ----------
  fx := pg_temp.cf_file(u_agent, k2, 'passport', true);
  fx := pg_temp.cf_file(u_agent, k2, 'emirates_id', true);
  n := n + 1; failed := failed || pg_temp.cf_ok(
    case_file_ready(k2) AND pg_temp.cf_events(k2) = 0
    AND EXISTS (SELECT 1 FROM case_file_ready_marks WHERE case_id = k2),
    'a case that became ready with no subscriber queued case.file_ready, or was not latched');

  INSERT INTO webhook_endpoints (account_id, url, secret, events, is_active)
  VALUES (a_acct, 'https://example.invalid/v184', 'whsec_v184', ARRAY['case.file_ready'], true);

  -- ---------- 2. status: missing, checking, failed ----------
  st := case_file_status_api(a_acct, 'CFC-184-1');
  n := n + 1; failed := failed || pg_temp.cf_ok(
    st = jsonb_build_object('ready', false, 'build', 'null'::jsonb, 'documents', '[
          {"doc_key": "passport", "required": true, "status": "missing"},
          {"doc_key": "emirates_id", "required": true, "status": "missing"},
          {"doc_key": "salary_cert", "required": false, "status": "missing"}]'::jsonb),
    format('the status of a case with no files is not all missing (%s)', st));
  fx := pg_temp.cf_file(u_agent, k1, 'passport', NULL);
  fx := pg_temp.cf_file(u_agent, k1, 'emirates_id', false);
  st := case_file_status_api(a_acct, 'CFC-184-1');
  n := n + 1; failed := failed || pg_temp.cf_ok(
    st ->> 'ready' = 'false' AND st -> 'build' = 'null'::jsonb
    AND pg_temp.cf_st(st) = 'passport=checking/true,emirates_id=failed/true,salary_cert=missing/false',
    format('the status with a file pending checks and a failed file is wrong (%s)', st));
  n := n + 1; failed := failed || pg_temp.cf_ok(pg_temp.cf_events(k1) = 0,
    'a case that is not ready queued case.file_ready');

  -- ---------- 3. ready with a subscriber: exactly one event ----------
  fx := pg_temp.cf_file(u_agent, k1, 'passport', true);
  n := n + 1; failed := failed || pg_temp.cf_ok(pg_temp.cf_events(k1) = 0,
    'a pass that left the case not ready queued case.file_ready');
  fx := pg_temp.cf_file(u_agent, k1, 'emirates_id', true);
  n := n + 1; failed := failed || pg_temp.cf_ok(
    case_file_ready(k1) AND pg_temp.cf_events(k1) = 1
    AND (SELECT o.payload ->> 'submission_ref' = 'CFC-184-1' AND o.payload ->> 'ready' = 'true'
                AND o.account_id = a_acct
           FROM webhook_event_outbox o
          WHERE o.event = 'case.file_ready' AND o.payload ->> 'case_id' = k1::text),
    format('a case becoming ready queued %s case.file_ready events, or the payload is wrong', pg_temp.cf_events(k1)));
  st := case_file_status_api(a_acct, 'CFC-184-1');
  n := n + 1; failed := failed || pg_temp.cf_ok(
    st ->> 'ready' = 'true' AND st -> 'build' = 'null'::jsonb
    AND pg_temp.cf_st(st) = 'passport=passed/true,emirates_id=passed/true,salary_cert=missing/false',
    format('the status of a ready case is wrong (%s)', st));

  -- ---------- 4. re-upload of a ready case: no second event ----------
  fx := pg_temp.cf_file(u_agent, k1, 'passport', true);
  n := n + 1; failed := failed || pg_temp.cf_ok(case_file_ready(k1) AND pg_temp.cf_events(k1) = 1,
    format('a re-upload of an already-ready case left %s case.file_ready events, not 1', pg_temp.cf_events(k1)));

  -- ---------- 5. a newer failure, then a pass: a second event ----------
  fx := pg_temp.cf_file(u_agent, k1, 'emirates_id', false);
  n := n + 1; failed := failed || pg_temp.cf_ok(
    NOT case_file_ready(k1) AND pg_temp.cf_events(k1) = 1
    AND NOT EXISTS (SELECT 1 FROM case_file_ready_marks WHERE case_id = k1)
    AND case_file_status_api(a_acct, 'CFC-184-1') ->> 'ready' = 'false',
    'a newer failed version did not clear the latch, or queued an event');
  fx := pg_temp.cf_file(u_agent, k1, 'emirates_id', true);
  n := n + 1; failed := failed || pg_temp.cf_ok(case_file_ready(k1) AND pg_temp.cf_events(k1) = 2,
    format('a pass after a newer failure left %s case.file_ready events, not 2', pg_temp.cf_events(k1)));

  -- ---------- 6. a lead: latched, no event ----------
  fx := pg_temp.cf_file(u_agent, kl, 'passport', true);
  fx := pg_temp.cf_file(u_agent, kl, 'emirates_id', true);
  n := n + 1; failed := failed || pg_temp.cf_ok(
    case_file_ready(kl) AND pg_temp.cf_events(kl) = 0
    AND EXISTS (SELECT 1 FROM case_file_ready_marks WHERE case_id = kl),
    'a lead that became ready queued case.file_ready, or was not latched');

  -- ---------- 7. API download ----------
  n := n + 1; failed := failed || pg_temp.cf_check('a ready case with no build gave an API download', NULL, NULL,
    format('SELECT download_id::text FROM case_build_download_record_api(%L, %L, %L, now())', key_live, a_acct, 'CFC-184-2'),
    'ERROR 23514 BUILD_STALE:%');
  SELECT x.version, x.reservation_id INTO v1, res FROM case_file_build_reserve(u_coord, k1, now()) x;
  SELECT x.build_id INTO b1 FROM case_file_build_record(u_coord, k1, res, pg_temp.cfb_man(k1), false,
    'cases/' || k1::text || '/index-' || sha || '.pdf', sha, now()) x;
  SELECT * INTO q FROM case_build_download_record_api(key_live, a_acct, 'CFC-184-1', now()) x;
  n := n + 1; failed := failed || pg_temp.cf_ok(
    q.object_path = 'cases/' || k1::text || '/index-' || sha || '.pdf' AND q.sha256 = sha AND q.version = v1
    AND (SELECT d.api_key_id = key_live AND d.actor IS NULL AND d.build_id = b1 AND d.file_id IS NULL
                AND d.case_id = k1 AND d.account_id = a_acct AND NOT d.url_issued
           FROM case_file_downloads d WHERE d.id = q.download_id),
    format('an API download did not return the ready build or write its audit row with the key (%s)', q));
  st := case_file_status_api(a_acct, 'CFC-184-1');
  n := n + 1; failed := failed || pg_temp.cf_ok(
    (st -> 'build' ->> 'version')::int = v1 AND st -> 'build' ->> 'sha256' = sha
    AND st -> 'build' -> 'merged' = 'false'::jsonb AND st -> 'build' ? 'built_at'
    AND jsonb_array_length(st -> 'build' -> 'manifest') = 2
    AND st -> 'build' -> 'manifest' -> 0 ->> 'doc_key' = 'passport'
    AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(st -> 'build' -> 'manifest' -> 0) k)
        = ARRAY['doc_key', 'pages', 'renamed_name', 'sha256'],
    format('the status of a built case does not carry its build (%s)', st));
  n := n + 1; failed := failed || pg_temp.cf_check('another account''s key downloaded', NULL, NULL,
    format('SELECT download_id::text FROM case_build_download_record_api(%L, %L, %L, now())', key_oth, a_acct, 'CFC-184-1'),
    'ERROR P0002 FILE_NOT_FOUND:%');
  n := n + 1; failed := failed || pg_temp.cf_check('a revoked key downloaded', NULL, NULL,
    format('SELECT download_id::text FROM case_build_download_record_api(%L, %L, %L, now())', key_rev, a_acct, 'CFC-184-1'),
    'ERROR P0002 FILE_NOT_FOUND:%');
  n := n + 1; failed := failed || pg_temp.cf_check('an expired key downloaded', NULL, NULL,
    format('SELECT download_id::text FROM case_build_download_record_api(%L, %L, %L, now())', key_exp, a_acct, 'CFC-184-1'),
    'ERROR P0002 FILE_NOT_FOUND:%');
  n := n + 1; failed := failed || pg_temp.cf_check('an unknown ref was not FILE_NOT_FOUND', NULL, NULL,
    format('SELECT download_id::text FROM case_build_download_record_api(%L, %L, %L, now())', key_live, a_acct, 'CFC-184-404'),
    'ERROR P0002 FILE_NOT_FOUND:%');
  n := n + 1; failed := failed || pg_temp.cf_check('a ref of another account was downloaded', NULL, NULL,
    format('SELECT download_id::text FROM case_build_download_record_api(%L, %L, %L, now())', key_oth, o_acct, 'CFC-184-1'),
    'ERROR P0002 FILE_NOT_FOUND:%');
  n := n + 1; failed := failed || pg_temp.cf_check('the status of an unknown ref was not FILE_NOT_FOUND', NULL, NULL,
    format('SELECT case_file_status_api(%L, %L)::text', a_acct, 'CFC-184-404'), 'ERROR P0002 FILE_NOT_FOUND:%');
  n := n + 1; failed := failed || pg_temp.cf_check('the status of another account''s ref was read', NULL, NULL,
    format('SELECT case_file_status_api(%L, %L)::text', o_acct, 'CFC-184-1'), 'ERROR P0002 FILE_NOT_FOUND:%');
  n := n + 1; failed := failed || pg_temp.cf_ok(
    (SELECT count(*) FROM case_file_downloads WHERE api_key_id IS NOT NULL) = 1,
    'a refused API download wrote an audit row');

  -- ---------- 8. who: exactly one of actor and api_key_id; RESTRICT ----------
  n := n + 1; failed := failed || pg_temp.cf_check('a download with both an actor and a key was written', NULL, NULL,
    format('INSERT INTO case_file_downloads (account_id, case_id, actor, api_key_id, build_id, at) VALUES (%L, %L, %L, %L, %L, now())',
           a_acct, k1, u_agent, key_live, b1), 'ERROR 23514 %case_file_downloads_one_who%');
  n := n + 1; failed := failed || pg_temp.cf_check('a download with neither an actor nor a key was written', NULL, NULL,
    format('INSERT INTO case_file_downloads (account_id, case_id, actor, api_key_id, build_id, at) VALUES (%L, %L, NULL, NULL, %L, now())',
           a_acct, k1, b1), 'ERROR 23514 %case_file_downloads_one_who%');
  n := n + 1; failed := failed || pg_temp.cf_check('a key that has downloaded was deleted', NULL, NULL,
    format('DELETE FROM api_keys WHERE id = %L', key_live), 'ERROR 23503 %case_file_downloads_api_key_fkey%');
  n := n + 1; failed := failed || pg_temp.cf_ok(
    (SELECT confdeltype FROM pg_constraint WHERE conname = 'case_file_downloads_api_key_fkey'
        AND conrelid = 'public.case_file_downloads'::regclass) = 'r',
    'case_file_downloads_api_key_fkey is not ON DELETE RESTRICT');

  -- ---------- 9. privileges ----------
  FOREACH fn IN ARRAY ARRAY['case_build_download_record_api(uuid, uuid, text, timestamptz)',
                            'case_file_status_api(uuid, text)'] LOOP
    SELECT string_agg(rl2, ',' ORDER BY rl2) INTO r
      FROM unnest(ARRAY['anon', 'authenticated']) rl2
     WHERE has_function_privilege(rl2, 'public.' || fn, 'EXECUTE');
    n := n + 1; failed := failed || pg_temp.cf_ok(r IS NULL AND has_function_privilege('service_role', 'public.' || fn, 'EXECUTE'),
      format('%s may execute %s, or the service role may not', coalesce(r, 'nobody else'), fn));
  END LOOP;
  FOREACH fn IN ARRAY ARRAY['case_by_submission_ref(uuid, text)', 'case_document_files_ready_webhook_hook()'] LOOP
    SELECT string_agg(rl2, ',' ORDER BY rl2) INTO r
      FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) rl2
     WHERE has_function_privilege(rl2, 'public.' || fn, 'EXECUTE');
    n := n + 1; failed := failed || pg_temp.cf_ok(r IS NULL, format('%s may execute %s', r, fn));
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cf_check('authenticated read a case file status', 'authenticated', u_owner,
    format('SELECT case_file_status_api(%L, %L)::text', a_acct, 'CFC-184-1'), 'ERROR 42501 %');
  n := n + 1; failed := failed || pg_temp.cf_check('anon recorded an API download', 'anon', NULL,
    format('SELECT download_id::text FROM case_build_download_record_api(%L, %L, %L, now())', key_live, a_acct, 'CFC-184-1'),
    'ERROR 42501 %');
  n := n + 1; failed := failed || pg_temp.cf_ok(
    NOT has_table_privilege('anon', 'public.case_file_ready_marks', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
    AND NOT has_table_privilege('authenticated', 'public.case_file_ready_marks', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
    AND NOT has_table_privilege('service_role', 'public.case_file_ready_marks', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE'),
    'an API role has a privilege on case_file_ready_marks');

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT184', MESSAGE = 'verify-case-files-compass rollback';
  EXCEPTION WHEN SQLSTATE 'ZT184' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'case files for Compass verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'case files for Compass verification passed (% checks)', n;
END
$verify$;
