-- Behavioural regression suite for migration 270: a superseded case file
-- staff use again, and a submission status older than the case's last
-- update. ONE statement; the fixtures are rolled back by a sentinel.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000270001';
  u_agent  UUID := '00000000-0000-4000-8000-000000270002';
  u_agent2 UUID := '00000000-0000-4000-8000-000000270003'; -- not on the case
  u_coord  UUID := '00000000-0000-4000-8000-000000270004';
  a_acct   UUID;
  wa       UUID;
  ca       UUID;
  ga       UUID;
  k1       UUID;
  f1       UUID;
  f2       UUID;
  q        RECORD;
  t0       TIMESTAMPTZ := now() - interval '1 hour';
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cff_ok(p_ok boolean, p_msg text) RETURNS text LANGUAGE sql AS
    $body$ SELECT CASE WHEN p_ok IS TRUE THEN NULL ELSE p_msg END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cff_try(p_sql text) RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE h text;
    BEGIN
      EXECUTE p_sql;
      RETURN 'ok';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
      RETURN coalesce(nullif(h, ''), SQLSTATE);
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cff_classify(p_actor uuid, p_file uuid, p_key text) RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v record; h text;
    BEGIN
      SELECT * INTO v FROM public.case_document_file_classify(p_actor, p_file, p_key);
      RETURN v.classify_seq || ':v' || v.version;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
      RETURN coalesce(nullif(h, ''), SQLSTATE);
    END $body$
  $fn$;
  -- The file's checks, under its present classification.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cff_check(p_file uuid, p_ok boolean) RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE f public.case_document_files%ROWTYPE; h text;
    BEGIN
      SELECT * INTO f FROM public.case_document_files WHERE id = p_file;
      RETURN public.case_document_file_check_result(f.id, f.doc_key, f.classify_seq,
        jsonb_build_array(jsonb_build_object('name', 'size', 'ok', p_ok)), 1, NULL);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
      RETURN coalesce(nullif(h, ''), SQLSTATE);
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cff_state(p_file uuid) RETURNS text LANGUAGE sql AS
    $body$ SELECT doc_key || ':v' || version || ':' || status FROM public.case_document_files WHERE id = p_file $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cff_file(p_actor uuid, p_case uuid) RETURNS uuid LANGUAGE sql AS $body$
      SELECT public.case_document_file_register(p_actor, p_case,
        (SELECT x.document_id FROM public.customer_documents_record_internal(c.account_id, c.contact_id, 'staff_upload',
          'document', 'case-files', 'v270/' || gen_random_uuid()::text || '.pdf', now(), 'application/pdf',
          'scan.pdf', NULL, k.user_id) x))
        FROM public.cases c JOIN public.contacts k ON k.id = c.contact_id WHERE c.id = p_case
    $body$
  $fn$;

  -- A function, so a check sees what its own calls wrote.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cff_status(p_group uuid) RETURNS text LANGUAGE sql VOLATILE AS
    $body$ SELECT submission_status FROM public.submission_groups WHERE id = p_group $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'cff-owner@example.invalid'), (u_agent, 'cff-agent@example.invalid'),
    (u_agent2, 'cff-agent2@example.invalid'), (u_coord, 'cff-coord@example.invalid');
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agent, u_agent2, u_coord);
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'CFF-1', 'x', 'connected', true) RETURNING id INTO wa;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500270001', 'CFF one')
    RETURNING id INTO ca;
  ga := (SELECT o.group_id FROM sg_open(a_acct, 'CFF-A', ca, wa, 'a', NULL,
    jsonb_build_array(jsonb_build_object('user_id', u_coord, 'label', 'coordinator'),
                      jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL) o);
  k1 := (SELECT x.case_id FROM case_open(ga, 'CFFB', 'Bank CFF', 'Loan', 1000, NULL) x);
  INSERT INTO case_doc_requirements (account_id, bank_code, product, doc_key, label, position) VALUES
    (a_acct, 'CFFB', 'Loan', 'passport', 'Passport', 1), (a_acct, 'CFFB', 'Loan', 'visa', 'Visa', 2);

  -- ---------- 1. A superseded file, used again ----------
  f1 := pg_temp.cff_file(u_agent, k1);
  PERFORM pg_temp.cff_classify(u_agent, f1, 'passport');
  PERFORM pg_temp.cff_check(f1, true);
  f2 := pg_temp.cff_file(u_agent, k1);
  PERFORM pg_temp.cff_classify(u_agent, f2, 'passport');
  PERFORM pg_temp.cff_check(f2, true);
  failed := array_append(failed, pg_temp.cff_ok(pg_temp.cff_state(f1) = 'passport:v1:superseded'
    AND pg_temp.cff_state(f2) = 'passport:v2:passed', 'fixture: the second file replaced the first')); n := n + 1;

  failed := array_append(failed, pg_temp.cff_ok(pg_temp.cff_classify(NULL, f1, 'passport') = 'NOT_ALLOWED',
    'reuse: the system actor is refused as before')); n := n + 1;
  failed := array_append(failed, pg_temp.cff_ok(pg_temp.cff_classify(u_agent2, f1, 'passport') = 'NOT_ALLOWED',
    'reuse: an agent of no part in the case is refused')); n := n + 1;
  failed := array_append(failed, pg_temp.cff_ok(pg_temp.cff_classify(u_agent, f1, 'nothing') = 'DOC_NOT_REQUIRED',
    'reuse: only a document of the list')); n := n + 1;
  failed := array_append(failed, pg_temp.cff_ok(
    pg_temp.cff_try(format('UPDATE public.case_document_files SET pages = 9 WHERE id = %L', f1)) = 'FILE_STATE'
    AND pg_temp.cff_try(format('UPDATE public.case_document_files SET status = ''passed'' WHERE id = %L', f1)) = 'FILE_STATE'
    AND pg_temp.cff_try(format('UPDATE public.case_document_files SET status = ''pending_checks'' WHERE id = %L', f1)) = 'FILE_STATE'
    AND pg_temp.cff_try(format('UPDATE public.case_document_files SET status = ''pending_checks'', version = 9,
      classify_seq = classify_seq + 1, classified_by = NULL WHERE id = %L', f1)) = 'FILE_STATE',
    'reuse: no other write changes a superseded row')); n := n + 1;
  failed := array_append(failed, pg_temp.cff_ok(pg_temp.cff_state(f1) = 'passport:v1:superseded',
    'reuse: a refusal leaves the file superseded')); n := n + 1;

  failed := array_append(failed, pg_temp.cff_ok(pg_temp.cff_classify(u_agent, f1, 'passport') = '2:v3',
    'reuse: the highest version + 1, next seq')); n := n + 1;
  failed := array_append(failed, pg_temp.cff_ok(pg_temp.cff_state(f1) = 'passport:v3:pending_checks'
    AND pg_temp.cff_state(f2) = 'passport:v2:passed', 'reuse: pending, the current file untouched')); n := n + 1;
  failed := array_append(failed, pg_temp.cff_ok(pg_temp.cff_check(f1, true) = 'passed'
    AND pg_temp.cff_state(f1) = 'passport:v3:passed' AND pg_temp.cff_state(f2) = 'passport:v2:superseded',
    'reuse: a pass replaces the current file')); n := n + 1;

  -- Back once more, failing: the passed one stays.
  failed := array_append(failed, pg_temp.cff_ok(pg_temp.cff_classify(u_agent, f2, 'passport') = '2:v4'
    AND pg_temp.cff_check(f2, false) = 'failed' AND pg_temp.cff_state(f1) = 'passport:v3:passed',
    'reuse: a failed check replaces nothing')); n := n + 1;
  failed := array_append(failed, pg_temp.cff_ok(pg_temp.cff_classify(u_agent, f2, 'passport') = '3:v4',
    'a failed file keeps its version, as before')); n := n + 1;
  failed := array_append(failed, pg_temp.cff_ok(pg_temp.cff_check(f2, true) = 'passed'
    AND pg_temp.cff_state(f1) = 'passport:v3:superseded', 'fixture: f1 replaced again')); n := n + 1;

  -- The type's highest version is its own: still a new one.
  PERFORM pg_temp.cff_classify(u_agent, f2, 'visa');
  failed := array_append(failed, pg_temp.cff_ok(pg_temp.cff_state(f2) = 'visa:v1:pending_checks'
    AND pg_temp.cff_classify(u_agent, f1, 'passport') = '3:v4', 'reuse: never its own number again')); n := n + 1;
  failed := array_append(failed, pg_temp.cff_ok(pg_temp.cff_check(f1, true) = 'passed'
    AND pg_temp.cff_check(f2, true) = 'passed', 'reuse: both types have their file')); n := n + 1;

  -- A superseded file under another type; a closed case.
  PERFORM pg_temp.cff_classify(u_agent, f2, 'passport');
  PERFORM pg_temp.cff_check(f2, true);
  failed := array_append(failed, pg_temp.cff_ok(pg_temp.cff_state(f1) = 'passport:v4:superseded'
    AND pg_temp.cff_classify(u_agent, f1, 'visa') = '4:v1', 'reuse: under another type')); n := n + 1;
  PERFORM pg_temp.cff_check(f1, true);
  UPDATE case_document_files SET status = 'superseded' WHERE id = f1;

  -- ---------- 2. A status older than the case's last update ----------
  failed := array_append(failed, pg_temp.cff_ok(
    sg_note_submission_status(ga, 'UNDER_REVIEW', t0), 'status: a case no update has touched takes any')); n := n + 1;
  PERFORM case_sync_from_submission(ga, t0, '{}'::jsonb);
  PERFORM case_sync_from_submission(ga, t0 + interval '2 seconds', '{}'::jsonb);
  failed := array_append(failed, pg_temp.cff_ok(
    sg_note_submission_status(ga, 'BANK_REVIEW', t0 + interval '2 seconds'), 'status: the newest update''s is stored')); n := n + 1;
  failed := array_append(failed, pg_temp.cff_ok(NOT sg_note_submission_status(ga, 'DOCS_PENDING', t0)
    AND pg_temp.cff_status(ga) = 'BANK_REVIEW',
    'status: an older update''s is ignored')); n := n + 1;
  failed := array_append(failed, pg_temp.cff_ok(
    sg_note_submission_status(ga, 'BANK_REVIEW', t0 + interval '2 seconds')
    AND sg_note_submission_status(ga, 'QUERY', t0 + interval '2 seconds')
    AND sg_note_submission_status(ga, 'QUERY_2', t0 + interval '3 seconds')
    AND pg_temp.cff_status(ga) = 'QUERY_2',
    'status: the same time or a later one is stored')); n := n + 1;
  failed := array_append(failed, pg_temp.cff_ok(sg_note_submission_status(ga, 'NO_TIME')
    AND sg_note_submission_status(ga, 'NULL_TIME', NULL)
    AND pg_temp.cff_status(ga) = 'NULL_TIME',
    'status: without a time it is stored, as before')); n := n + 1;
  failed := array_append(failed, pg_temp.cff_ok(NOT sg_note_submission_status(gen_random_uuid(), 'X', t0),
    'status: an unknown group')); n := n + 1;
  failed := array_append(failed, pg_temp.cff_ok(
    (SELECT count(*) = 1 FROM pg_proc WHERE proname = 'sg_note_submission_status' AND pronamespace = 'public'::regnamespace)
    AND (SELECT bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE')
           AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
           AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'))
           FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
            AND p.proname IN ('sg_note_submission_status', 'case_document_file_classify')),
    'grants: one signature, service role only')); n := n + 1;

  -- Last: the case is closed.
  PERFORM case_sync_from_submission(ga, t0 + interval '5 seconds', '{"stage":"Withdrawn"}'::jsonb);
  failed := array_append(failed, pg_temp.cff_ok((SELECT closed_at IS NOT NULL FROM cases WHERE id = k1)
    AND pg_temp.cff_classify(u_agent, f1, 'passport') = 'CASE_CLOSED'
    AND pg_temp.cff_state(f1) = 'visa:v1:superseded', 'reuse: never on a closed case')); n := n + 1;

  RAISE EXCEPTION 'CFF_ROLLBACK';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'CFF_ROLLBACK' THEN RAISE; END IF;
  END;

  failed := array_remove(failed, NULL);
  IF n < 23 THEN RAISE EXCEPTION 'verify-case-file-fixes: only % checks ran', n; END IF;
  IF cardinality(failed) > 0 THEN
    RAISE EXCEPTION 'verify-case-file-fixes: % of % failed: %', cardinality(failed), n, array_to_string(failed, '; ');
  END IF;
  RAISE NOTICE 'verify-case-file-fixes: % checks passed', n;
END $verify$;
