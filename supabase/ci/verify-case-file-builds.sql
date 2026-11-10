-- Behavioural regression suite for case file builds and the download
-- audit (migration 182).
--
-- The gate (next version, who builds, CASE_CLOSED, FILE_NOT_READY); the
-- reserve -> record path; every BUILD_INVALID refusal of the record
-- (manifest not the current passed files, merged flag, path not
-- content-addressed, reservation expired / used / of another actor or
-- case / not newer than a recorded build), each writing nothing; one
-- ready build per case; stale builds (a reclassified file, a newer
-- failed version, a file spec change but not a re-save); downloads (audit
-- row, url_issued flip, FILE_NOT_FOUND
-- without an existence oracle, BUILD_STALE, append-only for the table
-- owner too); privileges and the builds RLS.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The fixtures are
-- rolled back on success too (a sentinel exception ends the block).

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000182001';
  u_admin  UUID := '00000000-0000-4000-8000-000000182002';
  u_coord  UUID := '00000000-0000-4000-8000-000000182003';  -- coordinator on every case
  u_agent  UUID := '00000000-0000-4000-8000-000000182004';  -- agent of every case
  u_other  UUID := '00000000-0000-4000-8000-000000182006';  -- owner of another workspace
  sha      TEXT := repeat('a', 64);
  a_acct   UUID;
  o_acct   UUID;
  wa       UUID;
  ca       UUID;
  k1 UUID; k2 UUID; k3 UUID; k4 UUID; kx UUID;
  fp UUID; fe UUID; fs UUID; fold UUID; fx UUID;
  r1 UUID; r2 UUID; r3 UUID; r4 UUID; r5 UUID; r6 UUID;
  b1 UUID; b3 UUID; b4 UUID; b5 UUID; b6 UUID; r7 UUID;
  v1 INT; v3 INT; v5 INT;
  m1       JSONB;
  m4       JSONB;
  p1       TEXT;
  dl       UUID;
  ok       BOOLEAN;
  spec     JSONB := '[{"doc_key": "passport", "name_pattern": "{{doc}}", "position": 1, "merged": false},
                      {"doc_key": "emirates_id", "name_pattern": "{{doc}}", "position": 2, "merged": false},
                      {"doc_key": "salary_cert", "name_pattern": "{{doc}}", "position": 3, "required": false,
                       "merged": false}]';
  q        RECORD;
  r        TEXT;
  rl       TEXT;
  fn       TEXT;
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
        'document', 'case-files', 'v182/' || gen_random_uuid()::text || '.pdf', now(), 'application/pdf',
        'scan.pdf', NULL, (SELECT k.user_id FROM public.contacts k WHERE k.id = p_contact)) x
    $body$
  $fn$;
  -- A fresh document of the case's customer, registered, classified as
  -- p_key and given a result; returns the file id.
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
  -- REQUIRED spec row, in spec position order (read from the tables, not
  -- through 182's own query).
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
  -- A record call that must be refused BUILD_INVALID.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cfb_bad(p_name text, p_actor uuid, p_case uuid, p_res uuid, p_man jsonb,
                                    p_merged boolean, p_path text, p_sha text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.cf_check(p_name, NULL, NULL,
        format('SELECT version::text FROM case_file_build_record(%L, %L, %L, %L, %L, %L, %L, now())',
               p_actor, p_case, p_res, p_man, p_merged, p_path, p_sha), 'ERROR 23514 BUILD_INVALID:%')
    $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'cfb-owner@example.invalid'),
    (u_admin, 'cfb-admin@example.invalid'),
    (u_coord, 'cfb-coord@example.invalid'),
    (u_agent, 'cfb-agent@example.invalid'),
    (u_other, 'cfb-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO o_acct FROM profiles WHERE user_id = u_other;
  IF a_acct IS NULL OR o_acct IS NULL OR a_acct = o_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision two accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_coord, u_agent);

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'CFB-182-A1', 'x', 'connected', true) RETURNING id INTO wa;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500182001', 'CFB one')
    RETURNING id INTO ca;

  FOR q IN SELECT * FROM (VALUES (1, 'CFB-182-1'), (2, 'CFB-182-2'), (3, 'CFB-182-3'), (4, 'CFB-182-4')) v(i, ref) LOOP
    kx := (SELECT x.case_id FROM case_open(
      (SELECT x.group_id FROM sg_open(a_acct, q.ref, ca, wa, 'case file builds', NULL,
         jsonb_build_array(jsonb_build_object('user_id', u_coord, 'label', 'coordinator'),
                           jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL) x),
      'ADCB', 'ADCB Bank', 'Loan', 1000, NULL) x);
    IF kx IS NULL THEN
      RAISE EXCEPTION 'fixture: sg_open / case_open returned nothing for %', q.ref;
    END IF;
    CASE q.i WHEN 1 THEN k1 := kx; WHEN 2 THEN k2 := kx; WHEN 3 THEN k3 := kx; ELSE k4 := kx; END CASE;
  END LOOP;
  INSERT INTO case_doc_requirements (account_id, bank_code, product, doc_key, label, position) VALUES
    (a_acct, 'ADCB', 'Loan', 'passport', 'Passport', 1),
    (a_acct, 'ADCB', 'Loan', 'emirates_id', 'Emirates ID', 2),
    (a_acct, 'ADCB', 'Loan', 'salary_cert', 'Salary certificate', 3);
  PERFORM case_file_spec_set(u_owner, 'ADCB', 'Loan', spec);

  -- k1: file ready (an older passport superseded, an optional salary_cert passed)
  fold := pg_temp.cf_file(u_agent, k1, 'passport', true);
  fp := pg_temp.cf_file(u_agent, k1, 'passport', true);
  fe := pg_temp.cf_file(u_agent, k1, 'emirates_id', true);
  fs := pg_temp.cf_file(u_agent, k1, 'salary_cert', true);
  -- k2: closed; k3: not file ready; k4: file ready
  UPDATE cases SET stage = 'Approved', closed_at = now() WHERE id = k2;
  fx := pg_temp.cf_file(u_agent, k3, 'passport', true);
  fx := pg_temp.cf_file(u_agent, k4, 'passport', true);
  fx := pg_temp.cf_file(u_agent, k4, 'emirates_id', true);
  IF NOT case_file_ready(k1) OR NOT case_file_ready(k4) OR case_file_ready(k3)
     OR (SELECT status FROM case_document_files WHERE id = fold) <> 'superseded' THEN
    RAISE EXCEPTION 'fixture: k1/k4 not file ready, k3 file ready, or the older passport not superseded';
  END IF;
  m1 := pg_temp.cfb_man(k1);
  IF jsonb_array_length(m1) <> 2 THEN
    RAISE EXCEPTION 'fixture: the k1 manifest is not two entries (%)', m1;
  END IF;
  p1 := 'cases/' || k1::text || '/index-' || sha || '.pdf';

  -- ---------- 1. gate ----------
  n := n + 1; failed := failed || pg_temp.cf_ok(
    case_file_build_gate(u_coord, k1) = 1 AND case_file_build_gate(u_admin, k1) = 1
    AND case_file_build_gate(u_owner, k1) = 1 AND case_file_build_gate(NULL, k1) = 1,
    'the gate of a never-built case is not version 1 for the coordinator, an admin, the owner and the job');
  n := n + 1; failed := failed || pg_temp.cf_check('an agent passed the build gate', NULL, NULL,
    format('SELECT case_file_build_gate(%L, %L)::text', u_agent, k1), 'ERROR 42501 NOT_ALLOWED:%');
  n := n + 1; failed := failed || pg_temp.cf_check('another workspace''s owner passed the build gate', NULL, NULL,
    format('SELECT case_file_build_gate(%L, %L)::text', u_other, k1), 'ERROR 42501 NOT_ALLOWED:%');
  n := n + 1; failed := failed || pg_temp.cf_check('an agent reserved a build', NULL, NULL,
    format('SELECT version::text FROM case_file_build_reserve(%L, %L, now())', u_agent, k1), 'ERROR 42501 NOT_ALLOWED:%');
  n := n + 1; failed := failed || pg_temp.cf_check('a closed case passed the build gate', NULL, NULL,
    format('SELECT case_file_build_gate(%L, %L)::text', u_coord, k2), 'ERROR 23514 CASE_CLOSED:%');
  n := n + 1; failed := failed || pg_temp.cf_check('a case that is not File ready passed the build gate', NULL, NULL,
    format('SELECT case_file_build_gate(%L, %L)::text', u_coord, k3), 'ERROR 23514 FILE_NOT_READY:%');
  n := n + 1; failed := failed || pg_temp.cf_check('an unknown case passed the build gate', NULL, NULL,
    format('SELECT case_file_build_gate(%L, %L)::text', u_coord, gen_random_uuid()), 'ERROR P0002 CASE_NOT_FOUND:%');

  -- ---------- 2. reserve -> record ----------
  SELECT x.version, x.reservation_id INTO v1, r1 FROM case_file_build_reserve(u_coord, k1, now()) x;
  SELECT x.build_id INTO b1 FROM case_file_build_record(u_coord, k1, r1, m1, false, p1, sha, now()) x;
  n := n + 1; failed := failed || pg_temp.cf_ok(
    v1 = 1 AND b1 IS NOT NULL
    AND (SELECT count(*) FROM case_file_build_current(u_agent, k1) c
          WHERE c.build_id = b1 AND c.status = 'ready' AND c.version = 1 AND c.built_by = u_coord
            AND c.built_system IS NULL AND NOT c.merged AND c.manifest = m1 AND c.object_path = p1
            AND c.sha256 = sha) = 1
    AND (SELECT used_at IS NOT NULL FROM case_file_build_reservations WHERE reservation_id = r1),
    'reserve -> record did not give version 1, ready and current, with the manifest, or did not use the reservation');
  n := n + 1; failed := failed || pg_temp.cf_ok(case_file_build_gate(u_coord, k1) = 2,
    'the gate after one build is not version 2');
  n := n + 1; failed := failed || pg_temp.cf_check('a stranger read the current build', NULL, NULL,
    format('SELECT count(*)::text FROM case_file_build_current(%L, %L)', u_other, k1), 'ERROR 42501 NOT_ALLOWED:%');

  -- ---------- 3. record refusals ----------
  SELECT x.reservation_id INTO r2 FROM case_file_build_reserve(u_coord, k1, now()) x;      -- version 2
  n := n + 1; failed := failed || pg_temp.cfb_bad('a manifest with a superseded file id was recorded',
    u_coord, k1, r2, jsonb_set(m1, '{0,file_id}', to_jsonb(fold::text)), false, p1, sha);
  n := n + 1; failed := failed || pg_temp.cfb_bad('a manifest in the wrong order was recorded',
    u_coord, k1, r2, jsonb_build_array(m1 -> 1, m1 -> 0), false, p1, sha);
  n := n + 1; failed := failed || pg_temp.cfb_bad('a manifest missing an entry was recorded',
    u_coord, k1, r2, m1 - 1, false, p1, sha);
  n := n + 1; failed := failed || pg_temp.cfb_bad('a manifest entry with an extra key was recorded',
    u_coord, k1, r2, jsonb_set(m1, '{0,extra}', '1'), false, p1, sha);
  n := n + 1; failed := failed || pg_temp.cfb_bad('a manifest entry without its sha256 was recorded',
    u_coord, k1, r2, jsonb_set(m1, '{0}', (m1 -> 0) - 'sha256'), false, p1, sha);
  n := n + 1; failed := failed || pg_temp.cfb_bad('a manifest with the optional document was recorded',
    u_coord, k1, r2, m1 || jsonb_build_array(jsonb_build_object('position', 3, 'doc_key', 'salary_cert',
      'file_id', fs, 'renamed_name', (SELECT renamed_name FROM case_document_files WHERE id = fs),
      'pages', 1, 'sha256', repeat('b', 64))), false, p1, sha);
  n := n + 1; failed := failed || pg_temp.cfb_bad('a merged flag other than the spec''s was recorded',
    u_coord, k1, r2, m1, true, 'cases/' || k1::text || '/bundle-' || sha || '.pdf', sha);
  n := n + 1; failed := failed || pg_temp.cfb_bad('a path for another sha256 was recorded',
    u_coord, k1, r2, m1, false, 'cases/' || k1::text || '/index-' || repeat('c', 64) || '.pdf', sha);
  n := n + 1; failed := failed || pg_temp.cfb_bad('a path of another case was recorded',
    u_coord, k1, r2, m1, false, 'cases/' || k4::text || '/index-' || sha || '.pdf', sha);
  n := n + 1; failed := failed || pg_temp.cfb_bad('a used reservation was recorded',
    u_coord, k1, r1, m1, false, p1, sha);
  n := n + 1; failed := failed || pg_temp.cfb_bad('another actor''s reservation was recorded',
    u_admin, k1, r2, m1, false, p1, sha);
  n := n + 1; failed := failed || pg_temp.cfb_bad('the job recorded a person''s reservation',
    NULL, k1, r2, m1, false, p1, sha);
  n := n + 1; failed := failed || pg_temp.cfb_bad('an unknown reservation was recorded',
    u_coord, k1, gen_random_uuid(), m1, false, p1, sha);
  SELECT x.reservation_id INTO r4 FROM case_file_build_reserve(u_coord, k4, now()) x;
  n := n + 1; failed := failed || pg_temp.cfb_bad('another case''s reservation was recorded',
    u_coord, k1, r4, m1, false, p1, sha);
  SELECT x.reservation_id INTO r3 FROM case_file_build_reserve(u_coord, k1, now()) x;      -- version 3
  UPDATE case_file_build_reservations SET created_at = created_at - interval '11 minutes',
                                          expires_at = expires_at - interval '11 minutes'
   WHERE reservation_id = r3;
  n := n + 1; failed := failed || pg_temp.cfb_bad('an expired reservation was recorded',
    u_coord, k1, r3, m1, false, p1, sha);
  n := n + 1; failed := failed || pg_temp.cf_ok(
    (SELECT count(*) FROM case_file_builds WHERE case_id = k1) = 1
    AND (SELECT status FROM case_file_builds WHERE build_id = b1) = 'ready'
    AND (SELECT used_at IS NULL FROM case_file_build_reservations WHERE reservation_id = r2),
    'a refused record wrote a build, superseded the ready one or used the reservation');

  -- ---------- 3b/4. a reservation not newer than a recorded build; supersede ----------
  SELECT x.version, x.reservation_id INTO v3, r5 FROM case_file_build_reserve(u_coord, k1, now()) x;
  SELECT x.build_id INTO b3 FROM case_file_build_record(u_coord, k1, r5, m1, false, p1, sha, now()) x;
  n := n + 1; failed := failed || pg_temp.cfb_bad('a reservation older than a recorded build was recorded',
    u_coord, k1, r2, m1, false, p1, sha);
  n := n + 1; failed := failed || pg_temp.cf_ok(
    v3 > 2 AND (SELECT version FROM case_file_builds WHERE build_id = b3) = v3
    AND (SELECT status FROM case_file_builds WHERE build_id = b1) = 'superseded'
    AND (SELECT count(*) FROM case_file_builds WHERE case_id = k1 AND status = 'ready') = 1
    AND (SELECT build_id FROM case_file_build_current(u_coord, k1)) = b3,
    format('a second build (version %s) did not supersede the first, or is not the one ready build', v3));
  SELECT x.version, x.reservation_id INTO v5, r6 FROM case_file_build_reserve(NULL, k1, now()) x;
  SELECT x.build_id INTO b5 FROM case_file_build_record(NULL, k1, r6, m1, false, p1, sha, now()) x;
  n := n + 1; failed := failed || pg_temp.cf_ok(
    v5 > v3 AND (SELECT built_by IS NULL AND built_system = 'system:files' AND status = 'ready'
                   FROM case_file_builds WHERE build_id = b5)
    AND (SELECT status FROM case_file_builds WHERE build_id = b3) = 'superseded'
    AND (SELECT count(*) FROM case_file_builds WHERE case_id = k1 AND status = 'ready') = 1,
    'the job''s build is not a newer system:files ready build superseding the previous');

  -- ---------- 6. downloads ----------
  SELECT x.download_id INTO dl FROM case_file_download_record(u_agent, fp, now()) x;
  n := n + 1; failed := failed || pg_temp.cf_ok(
    (SELECT NOT d.url_issued AND d.actor = u_agent AND d.case_id = k1 AND d.account_id = a_acct
            AND d.build_id IS NULL AND d.file_id = fp FROM case_file_downloads d WHERE d.id = dl),
    'a file download did not write one audit row with url_issued false');
  n := n + 1; failed := failed || pg_temp.cf_ok(
    (SELECT x.customer_document_id FROM case_file_download_record(u_coord, fp, now()) x)
      = (SELECT customer_document_id FROM case_document_files WHERE id = fp),
    'a file download did not return the file''s customer document');
  PERFORM case_file_download_issued(dl);
  n := n + 1; failed := failed || pg_temp.cf_ok((SELECT url_issued FROM case_file_downloads WHERE id = dl),
    'case_file_download_issued did not flip url_issued');
  n := n + 1; failed := failed || pg_temp.cf_check('a stranger downloaded a file', NULL, NULL,
    format('SELECT download_id::text FROM case_file_download_record(%L, %L, now())', u_other, fp),
    'ERROR P0002 FILE_NOT_FOUND:%');
  n := n + 1; failed := failed || pg_temp.cf_check('an unknown file id was not FILE_NOT_FOUND', NULL, NULL,
    format('SELECT download_id::text FROM case_file_download_record(%L, %L, now())', u_agent, gen_random_uuid()),
    'ERROR P0002 FILE_NOT_FOUND:%');
  n := n + 1; failed := failed || pg_temp.cf_check('the job recorded a file download', NULL, NULL,
    format('SELECT download_id::text FROM case_file_download_record(NULL, %L, now())', fp),
    'ERROR P0002 FILE_NOT_FOUND:%');
  SELECT * INTO q FROM case_build_download_record(u_agent, k1, now()) x;
  n := n + 1; failed := failed || pg_temp.cf_ok(
    q.object_path = p1 AND q.sha256 = sha AND q.version = v5
    AND (SELECT d.build_id = b5 AND d.file_id IS NULL AND NOT d.url_issued AND d.actor = u_agent
           FROM case_file_downloads d WHERE d.id = q.download_id),
    format('a build download did not return the ready build or write its audit row (%s)', q));
  n := n + 1; failed := failed || pg_temp.cf_check('a stranger downloaded the build', NULL, NULL,
    format('SELECT download_id::text FROM case_build_download_record(%L, %L, now())', u_other, k1),
    'ERROR P0002 FILE_NOT_FOUND:%');
  n := n + 1; failed := failed || pg_temp.cf_check('an unknown case was not FILE_NOT_FOUND', NULL, NULL,
    format('SELECT download_id::text FROM case_build_download_record(%L, %L, now())', u_agent, gen_random_uuid()),
    'ERROR P0002 FILE_NOT_FOUND:%');
  n := n + 1; failed := failed || pg_temp.cf_check('the job recorded a build download', NULL, NULL,
    format('SELECT download_id::text FROM case_build_download_record(NULL, %L, now())', k1),
    'ERROR P0002 FILE_NOT_FOUND:%');
  n := n + 1; failed := failed || pg_temp.cf_check('a case with no ready build gave a build download', NULL, NULL,
    format('SELECT download_id::text FROM case_build_download_record(%L, %L, now())', u_coord, k3),
    'ERROR 23514 BUILD_STALE:%');
  -- append-only, the table owner included
  n := n + 1; failed := failed || pg_temp.cf_check('a download row was changed', NULL, NULL,
    format('UPDATE case_file_downloads SET actor = %L WHERE id = %L', u_admin, dl), 'ERROR 42501 %');
  n := n + 1; failed := failed || pg_temp.cf_check('url_issued went back to false', NULL, NULL,
    format('UPDATE case_file_downloads SET url_issued = false WHERE id = %L', dl), 'ERROR 42501 %');
  n := n + 1; failed := failed || pg_temp.cf_check('a download row was deleted', NULL, NULL,
    format('DELETE FROM case_file_downloads WHERE id = %L', dl), 'ERROR 42501 %');
  n := n + 1; failed := failed || pg_temp.cf_check('case_file_downloads was truncated', NULL, NULL,
    'TRUNCATE case_file_downloads', 'ERROR 42501 %');
  n := n + 1; failed := failed || pg_temp.cf_check('a superseded build went back to ready', NULL, NULL,
    format('UPDATE case_file_builds SET status = %L WHERE build_id = %L', 'ready', b1), 'ERROR 42501 %');
  n := n + 1; failed := failed || pg_temp.cf_check('a ready build''s manifest was changed', NULL, NULL,
    format('UPDATE case_file_builds SET manifest = %L WHERE build_id = %L', '[{}]', b5), 'ERROR 42501 %');
  n := n + 1; failed := failed || pg_temp.cf_check('a build was deleted', NULL, NULL,
    format('DELETE FROM case_file_builds WHERE build_id = %L', b1), 'ERROR 42501 %');
  n := n + 1; failed := failed || pg_temp.cf_check('case_file_builds was truncated', NULL, NULL,
    'TRUNCATE case_file_builds CASCADE', 'ERROR 42501 %');

  -- ---------- 5. stale ----------
  -- a reclassified file in the ready build's manifest
  PERFORM 1 FROM case_document_file_classify(u_agent, fe, 'emirates_id');
  n := n + 1; failed := failed || pg_temp.cf_ok(
    (SELECT status FROM case_file_builds WHERE build_id = b5) = 'superseded'
    AND NOT EXISTS (SELECT 1 FROM case_file_build_current(u_coord, k1)),
    'reclassifying a file of the ready build left it ready');
  n := n + 1; failed := failed || pg_temp.cf_check('a stale build was downloadable', NULL, NULL,
    format('SELECT download_id::text FROM case_build_download_record(%L, %L, now())', u_agent, k1),
    'ERROR 23514 BUILD_STALE:%');
  -- a newer failed version of a file in the ready build's manifest
  m4 := pg_temp.cfb_man(k4);
  SELECT x.build_id INTO b4
    FROM case_file_build_record(u_coord, k4, r4, m4, false, 'cases/' || k4::text || '/index-' || sha || '.pdf', sha, now()) x;
  ok := (SELECT status FROM case_file_builds WHERE build_id = b4) = 'ready';
  fx := pg_temp.cf_file(u_agent, k4, 'passport', false);
  n := n + 1; failed := failed || pg_temp.cf_ok(
    ok AND NOT case_file_ready(k4)
    AND (SELECT status FROM case_file_builds WHERE build_id = b4) = 'superseded'
    AND NOT EXISTS (SELECT 1 FROM case_file_build_current(u_coord, k4)),
    'a newer failed version of a file in the ready build left it ready');
  -- a spec change for the case's bank and product (a re-save of the same
  -- rows changes nothing)
  fx := pg_temp.cf_file(u_agent, k4, 'passport', true);
  SELECT x.reservation_id INTO r7 FROM case_file_build_reserve(u_coord, k4, now()) x;
  SELECT x.build_id INTO b6
    FROM case_file_build_record(u_coord, k4, r7, pg_temp.cfb_man(k4), false,
                                'cases/' || k4::text || '/index-' || repeat('c', 64) || '.pdf', repeat('c', 64), now()) x;
  ok := case_file_ready(k4) AND (SELECT status FROM case_file_builds WHERE build_id = b6) = 'ready';
  PERFORM case_file_spec_set(u_owner, 'ADCB', 'Loan', spec);
  n := n + 1; failed := failed || pg_temp.cf_ok(
    ok AND (SELECT status FROM case_file_builds WHERE build_id = b6) = 'ready',
    're-saving an unchanged file spec superseded the ready build');
  PERFORM case_file_spec_set(u_owner, 'ADCB', 'Loan', jsonb_set(spec, '{2,required}', 'true'::jsonb));
  n := n + 1; failed := failed || pg_temp.cf_ok(
    (SELECT status FROM case_file_builds WHERE build_id = b6) = 'superseded'
    AND NOT EXISTS (SELECT 1 FROM case_file_build_current(u_coord, k4)),
    'a file spec change left the ready build current');
  n := n + 1; failed := failed || pg_temp.cf_check('a build stale by a spec change was downloadable', NULL, NULL,
    format('SELECT download_id::text FROM case_build_download_record(%L, %L, now())', u_agent, k4),
    'ERROR 23514 BUILD_STALE:%');

  -- ---------- 7. privileges and RLS ----------
  FOREACH fn IN ARRAY ARRAY['case_file_build_gate(uuid, uuid)', 'case_file_build_reserve(uuid, uuid, timestamptz)',
    'case_file_build_record(uuid, uuid, uuid, jsonb, boolean, text, text, timestamptz)',
    'case_file_build_current(uuid, uuid)', 'case_file_download_record(uuid, uuid, timestamptz)',
    'case_build_download_record(uuid, uuid, timestamptz)', 'case_file_download_issued(uuid)'] LOOP
    SELECT string_agg(rl2, ',' ORDER BY rl2) INTO r
      FROM unnest(ARRAY['anon', 'authenticated']) rl2
     WHERE has_function_privilege(rl2, 'public.' || fn, 'EXECUTE');
    n := n + 1; failed := failed || pg_temp.cf_ok(r IS NULL AND has_function_privilege('service_role', 'public.' || fn, 'EXECUTE'),
      format('%s may execute %s, or the service role may not', coalesce(r, 'nobody else'), fn));
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cf_check('authenticated ran the build gate', 'authenticated', u_coord,
    format('SELECT case_file_build_gate(%L, %L)::text', u_coord, k1), 'ERROR 42501 %');
  FOREACH rl IN ARRAY ARRAY['case_file_builds', 'case_file_build_reservations', 'case_file_downloads'] LOOP
    n := n + 1; failed := failed || pg_temp.cf_ok(
      NOT has_table_privilege('authenticated', 'public.' || rl, 'INSERT, UPDATE, DELETE, TRUNCATE')
      AND NOT has_table_privilege('anon', 'public.' || rl, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE'),
      'authenticated may write, or anon may touch, ' || rl);
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cf_ok(
    NOT has_table_privilege('authenticated', 'public.case_file_build_reservations', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.case_file_downloads', 'SELECT'),
    'authenticated may read the reservations or the download audit');
  n := n + 1; failed := failed || pg_temp.cf_check('authenticated inserted a build', 'authenticated', u_owner,
    format('INSERT INTO case_file_builds (account_id, case_id, version, merged, manifest, object_path, sha256, built_by)
            VALUES (%L, %L, 99, false, %L, %L, %L, %L)', a_acct, k1, m1, p1, sha, u_owner), 'ERROR 42501 %');
  n := n + 1; failed := failed || pg_temp.cf_check('a case reader could not read its builds through RLS',
    'authenticated', u_agent, format('SELECT count(*)::text FROM case_file_builds WHERE case_id = %L', k1),
    (SELECT count(*)::text FROM case_file_builds WHERE case_id = k1));
  n := n + 1; failed := failed || pg_temp.cf_ok(
    (SELECT count(*) FROM case_file_builds WHERE case_id = k1) = 3,
    'k1 does not have its three builds');
  n := n + 1; failed := failed || pg_temp.cf_check('an outsider read builds through RLS',
    'authenticated', u_other, format('SELECT count(*)::text FROM case_file_builds WHERE case_id IN (%L, %L)', k1, k4),
    '0');

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT182', MESSAGE = 'verify-case-file-builds rollback';
  EXCEPTION WHEN SQLSTATE 'ZT182' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'case file builds verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'case file builds verification passed (% checks)', n;
END
$verify$;
