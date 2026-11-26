-- Behavioural regression suite for case document files (migration 181).
--
-- The spec setter (owner/admin, bank known, doc_keys from 123's
-- requirements, positions unique, MIME within pdf/jpeg/png) and the
-- fallback to the requirements; register (the case customer's document
-- of the case's own account, idempotent, a case with no contact, a
-- stranger); classify (versions per doc_key, classify_seq, who may);
-- check results (CHECK_MISMATCH, CASE_CLOSED, CHECKS_INVALID, a pass
-- supersedes an older pass but never a newer one, File ready); every automatic behaviour off by default;
-- the checklist sync, its coordinator note and the managed-externally
-- lock; the File ready stage move and its setter; the render-name
-- vectors shared with src/lib/case-files/render-name.vectors.json
-- (render-name-parity.test.ts keeps them equal); privileges.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The fixtures are
-- rolled back on success too (a sentinel exception ends the block).

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000181001';
  u_admin  UUID := '00000000-0000-4000-8000-000000181002';
  u_coord  UUID := '00000000-0000-4000-8000-000000181003';  -- coordinator on every case
  u_agent  UUID := '00000000-0000-4000-8000-000000181004';  -- agent of every case but k2
  u_agent2 UUID := '00000000-0000-4000-8000-000000181005';  -- agent of k2 only
  u_other  UUID := '00000000-0000-4000-8000-000000181006';  -- owner of another workspace
  a_acct   UUID;
  o_acct   UUID;
  wa       UUID;
  ca       UUID;
  cb       UUID;
  co       UUID;
  k1 UUID; k2 UUID; k3 UUID; k4 UUID; k5 UUID; k6 UUID; k7 UUID;
  f1 UUID; f2 UUID; f3 UUID; f4 UUID; f5 UUID; fx UUID; fa UUID; fb UUID;
  d_other  UUID;
  d_cb     UUID;
  spec     JSONB := '[{"doc_key": "passport", "name_pattern": "{{case}}_{{doc}}", "position": 1},
                      {"doc_key": "emirates_id", "name_pattern": "{{company}}_{{doc}}", "position": 2},
                      {"doc_key": "salary_cert", "name_pattern": "{{doc}}", "position": 3, "required": false}]';
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
        'document', 'case-files', 'v181/' || gen_random_uuid()::text || '.pdf', now(), 'application/pdf',
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

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'cf-owner@example.invalid'),
    (u_admin,  'cf-admin@example.invalid'),
    (u_coord,  'cf-coord@example.invalid'),
    (u_agent,  'cf-agent@example.invalid'),
    (u_agent2, 'cf-agent2@example.invalid'),
    (u_other,  'cf-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO o_acct FROM profiles WHERE user_id = u_other;
  IF a_acct IS NULL OR o_acct IS NULL OR a_acct = o_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision two accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_coord, u_agent, u_agent2);

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'CF-181-A1', 'x', 'connected', true) RETURNING id INTO wa;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500181001', 'CF one')
    RETURNING id INTO ca;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500181002', 'CF two')
    RETURNING id INTO cb;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (o_acct, u_other, '971500181003', 'CF other')
    RETURNING id INTO co;

  FOR q IN SELECT * FROM (VALUES (1, 'CF-181-1', u_agent), (2, 'CF-181-2', u_agent2), (3, 'CF-181-3', u_agent),
                                 (4, 'CF-181-4', u_agent), (5, 'CF-181-5', u_agent), (6, 'CF-181-6', u_agent),
                                 (7, 'CF-181-7', u_agent)) v(i, ref, agent) LOOP
    k7 := (SELECT x.case_id FROM case_open(
      (SELECT x.group_id FROM sg_open(a_acct, q.ref, CASE WHEN q.i = 2 THEN cb ELSE ca END, wa, 'case files', NULL,
         jsonb_build_array(jsonb_build_object('user_id', u_coord, 'label', 'coordinator'),
                           jsonb_build_object('user_id', q.agent, 'label', 'agent')), NULL) x),
      'ADCB', 'ADCB Bank', 'Loan', 1000, NULL) x);
    IF k7 IS NULL THEN
      RAISE EXCEPTION 'fixture: sg_open / case_open returned nothing for %', q.ref;
    END IF;
    CASE q.i WHEN 1 THEN k1 := k7; WHEN 2 THEN k2 := k7; WHEN 3 THEN k3 := k7; WHEN 4 THEN k4 := k7;
             WHEN 5 THEN k5 := k7; WHEN 6 THEN k6 := k7; ELSE NULL; END CASE;
  END LOOP;
  UPDATE cases SET contact_id = NULL WHERE id = k3;
  -- case_open registered the bank
  INSERT INTO case_doc_requirements (account_id, bank_code, product, doc_key, label, position) VALUES
    (a_acct, 'ADCB', 'Loan', 'passport', 'Passport', 1),
    (a_acct, 'ADCB', 'Loan', 'emirates_id', 'Emirates ID', 2),
    (a_acct, 'ADCB', 'Loan', 'salary_cert', 'Salary certificate', 3);

  -- ---------- 1. spec ----------
  n := n + 1; failed := failed || pg_temp.cf_ok(
    (SELECT array_agg(doc_key ORDER BY "position") = ARRAY['passport', 'emirates_id', 'salary_cert']
            AND bool_and(required) AND bool_and(NOT from_spec)
            AND bool_and(name_pattern = '{{case}}_{{doc}}_{{yyyymmdd}}')
       FROM case_file_spec_rows(k1)),
    'with no spec rows case_file_spec_rows is not the requirements, all required');
  n := n + 1; failed := failed || pg_temp.cf_check('an agent set a file spec', NULL, NULL,
    format('SELECT case_file_spec_set(%L, %L, %L, %L)::text', u_agent, 'ADCB', 'Loan', spec), 'ERROR 42501 NOT_ALLOWED:%');
  n := n + 1; failed := failed || pg_temp.cf_check('a spec for an unknown bank was accepted', NULL, NULL,
    format('SELECT case_file_spec_set(%L, %L, %L, %L)::text', u_owner, 'NOPE', 'Loan', spec), 'ERROR 23514 BANK_UNKNOWN:%');
  n := n + 1; failed := failed || pg_temp.cf_check('a doc_key outside the requirements was accepted', NULL, NULL,
    format('SELECT case_file_spec_set(%L, %L, %L, %L)::text', u_owner, 'ADCB', 'Loan',
           '[{"doc_key": "visa", "name_pattern": "{{doc}}"}]'), 'ERROR 23514 DOCS_INVALID:%');
  n := n + 1; failed := failed || pg_temp.cf_check('duplicate positions were accepted', NULL, NULL,
    format('SELECT case_file_spec_set(%L, %L, %L, %L)::text', u_owner, 'ADCB', 'Loan',
           '[{"doc_key": "passport", "name_pattern": "{{doc}}", "position": 2},
             {"doc_key": "emirates_id", "name_pattern": "{{doc}}", "position": 2}]'), 'ERROR 23514 SPEC_INVALID:%');
  n := n + 1; failed := failed || pg_temp.cf_check('a MIME outside pdf/jpeg/png was accepted', NULL, NULL,
    format('SELECT case_file_spec_set(%L, %L, %L, %L)::text', u_owner, 'ADCB', 'Loan',
           '[{"doc_key": "passport", "name_pattern": "{{doc}}", "allowed_mime": ["image/gif"]}]'),
    'ERROR 23514 SPEC_INVALID:%');
  n := n + 1; failed := failed || pg_temp.cf_check('an admin could not set a file spec', NULL, NULL,
    format('SELECT case_file_spec_set(%L, %L, %L, %L)::text', u_admin, 'ADCB', ' loan ', '[]'), '________-%');
  n := n + 1; failed := failed || pg_temp.cf_check('the owner could not set a file spec', NULL, NULL,
    format('SELECT case_file_spec_set(%L, %L, %L, %L)::text', u_owner, 'ADCB', 'Loan', spec), '________-%');
  n := n + 1; failed := failed || pg_temp.cf_ok(
    (SELECT array_agg(doc_key || ':' || required ORDER BY "position")
            = ARRAY['passport:true', 'emirates_id:true', 'salary_cert:false'] AND bool_and(from_spec)
       FROM case_file_spec_rows(k1))
    AND (SELECT count(*) FROM case_file_spec_audit WHERE account_id = a_acct) = 2,
    'case_file_spec_rows does not return the stored spec, or the audit is not one row per set');

  -- ---------- 2. register ----------
  d_cb := pg_temp.cf_doc(a_acct, cb);
  d_other := pg_temp.cf_doc(o_acct, co);
  n := n + 1; failed := failed || pg_temp.cf_check('another contact''s document was registered', NULL, NULL,
    format('SELECT case_document_file_register(%L, %L, %L)::text', u_agent, k1, d_cb), 'ERROR 23514 FILE_INVALID:%');
  n := n + 1; failed := failed || pg_temp.cf_check('another account''s document was registered', NULL, NULL,
    format('SELECT case_document_file_register(%L, %L, %L)::text', u_agent, k1, d_other), 'ERROR P0002 FILE_NOT_FOUND:%');
  n := n + 1; failed := failed || pg_temp.cf_check('a case with no contact registered a file', NULL, NULL,
    format('SELECT case_document_file_register(%L, %L, %L)::text', u_agent, k3, d_cb), 'ERROR 23514 NO_CONTACT:%');
  n := n + 1; failed := failed || pg_temp.cf_check('a stranger registered a file', NULL, NULL,
    format('SELECT case_document_file_register(%L, %L, %L)::text', u_other, k1, pg_temp.cf_doc(a_acct, ca)),
    'ERROR 42501 NOT_ALLOWED:%');
  d_cb := pg_temp.cf_doc(a_acct, ca);
  f1 := case_document_file_register(u_agent, k1, d_cb);
  n := n + 1; failed := failed || pg_temp.cf_ok(
    f1 IS NOT NULL AND case_document_file_register(u_agent, k1, d_cb) = f1
    AND (SELECT count(*) FROM case_document_files WHERE case_id = k1) = 1
    AND (SELECT status = 'unclassified' AND registered_by = u_agent FROM case_document_files WHERE id = f1),
    'register is not idempotent, or did not store one unclassified file');
  -- A 1:1 chat document is the contact's: an actor who cannot see the
  -- contact (u_agent: ca is u_owner's, no chat of theirs) is refused as
  -- if it did not exist; one who can (an admin) registers it.
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_owner, ca) RETURNING id INTO fx;
  INSERT INTO messages (conversation_id, sender_type, content_type, media_url)
    VALUES (fx, 'customer', 'document', 'https://x.invalid/cf-chat.pdf') RETURNING id INTO fa;
  PERFORM customer_documents_record(a_acct, ca, 'chat', 'document', 'https://x.invalid/cf-chat.pdf', now(), fx, fa);
  SELECT id INTO fb FROM customer_documents WHERE message_id = fa AND source = 'chat';
  n := n + 1; failed := failed || pg_temp.cf_ok(fb IS NOT NULL AND NOT memory_can_read(u_agent, a_acct, 'contact', ca),
    'fixture: no chat document was recorded, or the agent can see the contact');
  n := n + 1; failed := failed || pg_temp.cf_check('an agent who cannot see the contact registered its chat document',
    NULL, NULL, format('SELECT case_document_file_register(%L, %L, %L)::text', u_agent, k1, fb),
    'ERROR P0002 FILE_NOT_FOUND:%');
  n := n + 1; failed := failed || pg_temp.cf_ok(
    NOT EXISTS (SELECT 1 FROM case_document_files WHERE customer_document_id = fb),
    'a refused chat document left a file row');
  fx := case_document_file_register(u_admin, k1, fb);
  n := n + 1; failed := failed || pg_temp.cf_ok(
    (SELECT registered_by = u_admin AND status = 'unclassified' FROM case_document_files WHERE id = fx),
    'an admin who can see the contact could not register its chat document');

  -- ---------- 3. classify ----------
  n := n + 1; failed := failed || pg_temp.cf_check('a doc_key outside the spec was classified', NULL, NULL,
    format('SELECT version::text FROM case_document_file_classify(%L, %L, %L)', u_agent, f1, 'visa'),
    'ERROR 23514 DOC_NOT_REQUIRED:%');
  n := n + 1; failed := failed || pg_temp.cf_check('an agent of another case classified a file', NULL, NULL,
    format('SELECT version::text FROM case_document_file_classify(%L, %L, %L)', u_agent2, f1, 'passport'),
    'ERROR 42501 NOT_ALLOWED:%');
  SELECT x.classify_seq, x.version, x.renamed_name INTO q FROM case_document_file_classify(u_agent, f1, 'passport') x;
  n := n + 1; failed := failed || pg_temp.cf_ok(q.classify_seq = 1 AND q.version = 1
    AND q.renamed_name = 'CF-181-1_passport.pdf'
    AND (SELECT status = 'pending_checks' AND classified_by = u_agent FROM case_document_files WHERE id = f1),
    format('first classify is not seq 1, version 1, CF-181-1_passport.pdf (%s)', q));
  SELECT x.classify_seq, x.version INTO q FROM case_document_file_classify(u_agent, f1, 'passport') x;
  n := n + 1; failed := failed || pg_temp.cf_ok(q.classify_seq = 2 AND q.version = 1,
    format('reclassifying to the same doc_key did not bump classify_seq and keep the version (%s)', q));
  f2 := pg_temp.cf_file(u_agent, k1, 'passport', NULL);
  n := n + 1; failed := failed || pg_temp.cf_ok(
    (SELECT version = 2 AND classify_seq = 1 FROM case_document_files WHERE id = f2),
    'a second file of the same doc_key is not version 2');

  -- ---------- 4/5. check results, everything off ----------
  n := n + 1; failed := failed || pg_temp.cf_check('a result for an older classification was accepted', NULL, NULL,
    format('SELECT case_document_file_check_result(%L, %L, 1, %L, 1, NULL)', f1, 'passport',
           '[{"name": "size", "ok": true}]'), 'ERROR 23514 CHECK_MISMATCH:%');
  n := n + 1; failed := failed || pg_temp.cf_check('an empty check list was accepted', NULL, NULL,
    format('SELECT case_document_file_check_result(%L, %L, 2, %L, 1, NULL)', f1, 'passport', '[]'),
    'ERROR 23514 CHECKS_INVALID:%');
  n := n + 1; failed := failed || pg_temp.cf_check('a check without ok was accepted', NULL, NULL,
    format('SELECT case_document_file_check_result(%L, %L, 2, %L, 1, NULL)', f1, 'passport', '[{"name": "size"}]'),
    'ERROR 23514 CHECKS_INVALID:%');
  r := case_document_file_check_result(f1, 'passport', 2, '[{"name": "size", "ok": true}]', 1, NULL);
  n := n + 1; failed := failed || pg_temp.cf_ok(r = 'passed' AND NOT case_file_ready(k1),
    format('a passed passport alone made the case file ready, or did not pass (%s)', r));
  f3 := pg_temp.cf_file(u_agent, k1, 'emirates_id', true);
  n := n + 1; failed := failed || pg_temp.cf_ok(case_file_ready(k1),
    'every required doc_key passed but the case is not file ready');
  r := case_document_file_check_result(f2, 'passport', 1, '[{"name": "size", "ok": true}]', 1, NULL);
  n := n + 1; failed := failed || pg_temp.cf_ok(
    (SELECT status FROM case_document_files WHERE id = f1) = 'superseded'
    AND (SELECT status FROM case_document_files WHERE id = f2) = 'passed' AND case_file_ready(k1),
    'a passed version 2 did not supersede the passed version 1');
  f4 := pg_temp.cf_file(u_agent, k1, 'passport', false);
  n := n + 1; failed := failed || pg_temp.cf_ok(
    (SELECT status FROM case_document_files WHERE id = f4) = 'failed' AND NOT case_file_ready(k1),
    'a newer failed version left the case file ready');
  -- all off by default: nothing outside the file rows was written
  n := n + 1; failed := failed || pg_temp.cf_ok(
    NOT EXISTS (SELECT 1 FROM case_documents WHERE case_id = k1)
    AND NOT EXISTS (SELECT 1 FROM case_notes WHERE case_id = k1 AND system_author = 'system:files')
    AND (SELECT stage FROM cases WHERE id = k1) = 'Submitted'
    AND NOT EXISTS (SELECT 1 FROM case_stage_history WHERE case_id = k1 AND actor_role = 'system:files'),
    'with every switch off a result touched case_documents, case_notes or the stage');
  -- an older version passing after a newer one never displaces it
  fa := pg_temp.cf_file(u_agent, k1, 'emirates_id', NULL);
  fb := pg_temp.cf_file(u_agent, k1, 'emirates_id', NULL);
  r := case_document_file_check_result(fb, 'emirates_id', 1, '[{"name": "size", "ok": true}]', 1, NULL);
  r := case_document_file_check_result(fa, 'emirates_id', 1, '[{"name": "size", "ok": true}]', 1, NULL);
  n := n + 1; failed := failed || pg_temp.cf_ok(
    r = 'passed'
    AND (SELECT status FROM case_document_files WHERE id = fb) = 'passed'
    AND (SELECT status FROM case_document_files WHERE id = fa) = 'superseded'
    AND (SELECT version FROM case_document_files WHERE id = fa) < (SELECT version FROM case_document_files WHERE id = fb),
    'an older version passing after a newer one superseded the newer pass');
  -- a closed case refuses a result
  f5 := pg_temp.cf_file(u_agent2, k2, 'passport', NULL);
  UPDATE cases SET stage = 'Approved', closed_at = now() WHERE id = k2;
  n := n + 1; failed := failed || pg_temp.cf_check('a result on a closed case was accepted', NULL, NULL,
    format('SELECT case_document_file_check_result(%L, %L, 1, %L, 1, NULL)', f5, 'passport',
           '[{"name": "size", "ok": true}]'), 'ERROR 23514 CASE_CLOSED:%');

  -- ---------- 6. checklist sync ----------
  PERFORM case_settings_set_files_switch(u_owner, a_acct, 'files_checklist_sync', true);
  f1 := pg_temp.cf_file(u_agent, k4, 'passport', true);
  n := n + 1; failed := failed || pg_temp.cf_ok(
    (SELECT status = 'received' AND file_ref = f1::text FROM case_documents WHERE case_id = k4 AND doc_key = 'passport'),
    'with the checklist sync on a pass did not mark case_documents received with the file id');
  f2 := pg_temp.cf_file(u_agent, k4, 'passport', false);
  n := n + 1; failed := failed || pg_temp.cf_ok(
    (SELECT count(*) FROM case_notes WHERE case_id = k4 AND system_author = 'system:files') = 1
    AND (SELECT body LIKE '%@' || u_coord::text || '%' FROM case_notes WHERE case_id = k4 AND system_author = 'system:files'),
    'a newer failed version did not add exactly one system note mentioning the coordinator');
  PERFORM case_settings_set(u_owner, a_acct, true);
  f3 := pg_temp.cf_file(u_agent, k4, 'emirates_id', true);
  f3 := pg_temp.cf_file(u_agent, k4, 'emirates_id', false);
  n := n + 1; failed := failed || pg_temp.cf_ok(
    NOT EXISTS (SELECT 1 FROM case_documents WHERE case_id = k4 AND doc_key = 'emirates_id')
    AND (SELECT count(*) FROM case_notes WHERE case_id = k4 AND system_author = 'system:files') = 1,
    'managed externally, the checklist sync still wrote case_documents or a note');
  PERFORM case_settings_set(u_owner, a_acct, false);

  -- ---------- 7. File ready stage move ----------
  n := n + 1; failed := failed || pg_temp.cf_check('a pre-submission File ready stage was accepted', NULL, NULL,
    format('SELECT case_settings_set_files_ready_stages(%L, %L, %L, %L)::text', u_owner, a_acct, 'Review', 'Submitted'),
    'ERROR 23514 SETTING_INVALID:%');
  n := n + 1; failed := failed || pg_temp.cf_check('a final File ready stage was accepted', NULL, NULL,
    format('SELECT case_settings_set_files_ready_stages(%L, %L, %L, %L)::text', u_owner, a_acct, 'Under review', 'Approved'),
    'ERROR 23514 SETTING_INVALID:%');
  n := n + 1; failed := failed || pg_temp.cf_check('equal File ready stages were accepted', NULL, NULL,
    format('SELECT case_settings_set_files_ready_stages(%L, %L, %L, %L)::text', u_owner, a_acct, 'Under review', 'Under review'),
    'ERROR 23514 SETTING_INVALID:%');
  n := n + 1; failed := failed || pg_temp.cf_check('an agent set the File ready stages', NULL, NULL,
    format('SELECT case_settings_set_files_ready_stages(%L, %L, %L, %L)::text', u_agent, a_acct, 'Documents requested', 'Documents received'),
    'ERROR 42501 NOT_ALLOWED:%');
  PERFORM case_settings_set_files_ready_stages(u_owner, a_acct, 'Documents requested', 'Documents received');
  PERFORM case_settings_set_files_switch(u_owner, a_acct, 'files_ready_move', true);
  n := n + 1; failed := failed || pg_temp.cf_ok(
    (SELECT files_checklist_sync AND files_ready_move AND NOT files_intake_prompts
            AND files_ready_from_stage = 'Documents requested' AND files_ready_to_stage = 'Documents received'
       FROM case_files_settings(a_acct)),
    'case_files_settings does not return the switches and stages just set');
  UPDATE cases SET stage = 'Documents requested' WHERE id IN (k5, k7);
  UPDATE cases SET stage = 'Under review' WHERE id = k6;
  fx := pg_temp.cf_file(u_agent, k5, 'passport', true);
  n := n + 1; failed := failed || pg_temp.cf_ok((SELECT stage FROM cases WHERE id = k5) = 'Documents requested',
    'a case that is not file ready moved');
  fx := pg_temp.cf_file(u_agent, k5, 'emirates_id', true);
  fx := pg_temp.cf_file(u_agent, k5, 'salary_cert', true);
  n := n + 1; failed := failed || pg_temp.cf_ok(
    (SELECT stage FROM cases WHERE id = k5) = 'Documents received'
    AND (SELECT count(*) FROM case_stage_history WHERE case_id = k5 AND to_stage = 'Documents received') = 1
    AND (SELECT actor_id IS NULL AND actor_role = 'system:files' AND from_stage = 'Documents requested'
           FROM case_stage_history WHERE case_id = k5 AND to_stage = 'Documents received')
    AND (SELECT count(*) FROM case_notes WHERE case_id = k5 AND system_author = 'system:files' AND body LIKE '%File ready%') = 1,
    'a file-ready case at the from-stage did not move once with one system:files history row and one note');
  fx := pg_temp.cf_file(u_agent, k6, 'passport', true);
  fx := pg_temp.cf_file(u_agent, k6, 'emirates_id', true);
  n := n + 1; failed := failed || pg_temp.cf_ok(
    case_file_ready(k6) AND (SELECT stage FROM cases WHERE id = k6) = 'Under review'
    AND NOT EXISTS (SELECT 1 FROM case_stage_history WHERE case_id = k6 AND actor_role = 'system:files'),
    'a file-ready case at another stage moved');
  PERFORM case_settings_set(u_owner, a_acct, true);
  fx := pg_temp.cf_file(u_agent, k7, 'passport', true);
  fx := pg_temp.cf_file(u_agent, k7, 'emirates_id', true);
  n := n + 1; failed := failed || pg_temp.cf_ok(
    case_file_ready(k7) AND (SELECT stage FROM cases WHERE id = k7) = 'Documents requested'
    AND NOT EXISTS (SELECT 1 FROM case_stage_history WHERE case_id = k7 AND actor_role = 'system:files'),
    'managed externally, the File ready move still moved the case');
  PERFORM case_settings_set(u_owner, a_acct, false);

  -- ---------- 8. render-name vectors (render-name.vectors.json) ----------
  FOR q IN
    SELECT v.id, case_file_render_name(v.pat, v.cs, v.co, v.doc, v.dt::date, v.mime) AS got, v.want
      FROM (VALUES
      ('plain-default-pattern', '{{case}}_{{doc}}_{{yyyymmdd}}', 'TC-1234abcd', 'ACME', 'passport', '2026-11-10', 'application/pdf', 'TC-1234abcd_passport_20261110.pdf'),
      ('arabic-company-only', '{{company}}_{{doc}}', NULL, 'شركة الأمل', 'trade_license', '2026-11-10', 'image/jpeg', 'trade_license.jpg'),
      ('arabic-mixed', '{{case}}-{{company}}', 'S-77', 'Al Amal شركة 2', NULL, '2026-11-10', 'image/png', 'S-77-Al_Amal_2.png'),
      ('emoji', '{{doc}} 😀 {{yyyymmdd}}', NULL, NULL, 'salary🎉cert', '2026-01-05', 'application/pdf', 'salary_cert_20260105.pdf'),
      ('slash-traversal', '{{company}}/{{doc}}', NULL, '../../etc', 'passwd', '2026-11-10', 'application/pdf', 'etc_passwd.pdf'),
      ('leading-dot', '.{{doc}}', NULL, NULL, 'hidden', '2026-11-10', 'image/png', 'hidden.png'),
      ('company-200-chars', '{{company}}_{{doc}}', NULL, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'id', '2026-11-10', 'application/pdf', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.pdf'),
      ('cut-lands-on-separator', '{{company}}', NULL, 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB___CCCC', NULL, '2026-11-10', 'application/pdf', 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB.pdf'),
      ('unknown-placeholder', '{{case}}_{{bank}}_{{doc}}', 'C1', NULL, 'kyc', '2026-11-10', 'application/pdf', 'C1__bank__kyc.pdf'),
      ('empty-pattern', '', 'C1', 'ACME', 'kyc', '2026-11-10', 'application/pdf', 'file.pdf'),
      ('null-pattern-unknown-mime', NULL, 'C1', NULL, NULL, '2026-11-10', 'application/zip', 'file'),
      ('mime-exact-match-only', '{{doc}}', NULL, NULL, 'scan', '2026-11-10', 'IMAGE/PNG', 'scan'),
      ('null-mime-keeps-dots', '{{doc}}', NULL, NULL, 'scan.final', '2026-11-10', NULL, 'scan.final'),
      ('null-vars', '{{case}}_{{company}}_{{doc}}', NULL, NULL, 'x', '2026-11-10', 'application/pdf', 'x.pdf'),
      ('only-separators', '{{company}}', NULL, '...---___', NULL, '2026-11-10', 'image/jpeg', 'file.jpg'),
      ('value-holds-later-placeholder', '{{case}}', 'X{{doc}}Y', NULL, 'Z', '2026-11-10', 'application/pdf', 'XZY.pdf'),
      ('replacement-pattern-chars-literal', 'p{{case}}', '$&$1', NULL, NULL, '2026-11-10', 'application/pdf', 'p_1.pdf'),
      ('date-twice-leap-day', '{{yyyymmdd}}-{{yyyymmdd}}', NULL, NULL, NULL, '2028-02-29', 'image/png', '20280229-20280229.png'),
      ('spaces-and-trailing-dot', '  {{doc}} . ', NULL, NULL, 'bank statement', '2026-11-10', 'application/pdf', 'bank_statement.pdf'),
      ('backslash-tab-newline', '{{company}}', NULL, E'C:\\Users\\a\tb\nc', NULL, '2026-11-10', 'image/jpeg', 'C_Users_a_b_c.jpg')
      ) v(id, pat, cs, co, doc, dt, mime, want)
  LOOP
    n := n + 1; failed := failed || pg_temp.cf_ok(q.got IS NOT DISTINCT FROM q.want,
      format('render-name vector %s gave %s', q.id, q.got));
  END LOOP;

  -- ---------- 9. privileges ----------
  FOREACH fn IN ARRAY ARRAY['case_files_settings(uuid)', 'case_settings_set_files_switch(uuid, uuid, text, boolean)',
    'case_settings_set_files_ready_stages(uuid, uuid, text, text)', 'case_file_render_name(text, text, text, text, date, text)',
    'case_file_spec_rows(uuid)', 'case_file_spec_set(uuid, text, text, jsonb)', 'case_document_file_can_register(uuid, uuid)',
    'case_document_file_register(uuid, uuid, uuid)', 'case_document_file_classify(uuid, uuid, text, integer, text)', 'case_file_ready(uuid)',
    'case_document_file_check_result(uuid, text, integer, jsonb, integer, date)', 'case_files_ready_move(uuid)'] LOOP
    SELECT string_agg(rl2, ',' ORDER BY rl2) INTO r
      FROM unnest(CASE WHEN fn = 'case_files_ready_move(uuid)' THEN ARRAY['anon', 'authenticated', 'service_role']
                       ELSE ARRAY['anon', 'authenticated'] END) rl2
     WHERE has_function_privilege(rl2, 'public.' || fn, 'EXECUTE');
    n := n + 1; failed := failed || pg_temp.cf_ok(r IS NULL, format('%s may execute %s', r, fn));
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cf_ok(
    has_function_privilege('service_role', 'public.case_document_file_check_result(uuid, text, integer, jsonb, integer, date)', 'EXECUTE'),
    'the service role may not execute case_document_file_check_result');
  n := n + 1; failed := failed || pg_temp.cf_check('the service role ran case_files_ready_move', 'service_role', NULL,
    format('SELECT case_files_ready_move(%L)::text', k5), 'ERROR 42501 %');
  FOREACH rl IN ARRAY ARRAY['case_file_specs', 'case_document_files', 'case_file_spec_audit'] LOOP
    n := n + 1; failed := failed || pg_temp.cf_ok(
      NOT has_table_privilege('authenticated', 'public.' || rl, 'INSERT, UPDATE, DELETE, TRUNCATE'),
      'authenticated may write ' || rl);
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cf_check('authenticated updated a file row', 'authenticated', u_owner,
    format('UPDATE case_document_files SET status = %L WHERE id = %L', 'passed', f4), 'ERROR 42501 %');
  n := n + 1; failed := failed || pg_temp.cf_check('authenticated inserted a spec row', 'authenticated', u_owner,
    format('INSERT INTO case_file_specs (account_id, bank_code, product, doc_key, name_pattern) VALUES (%L, %L, %L, %L, %L)',
           a_acct, 'ADCB', 'Card', 'passport', '{{doc}}'), 'ERROR 42501 %');

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT181', MESSAGE = 'verify-case-files rollback';
  EXCEPTION WHEN SQLSTATE 'ZT181' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'case files verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'case files verification passed (% checks)', n;
END
$verify$;
