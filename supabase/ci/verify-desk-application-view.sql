-- Behavioural regression suite for the application view (migration 233).
--
-- The merged checklist is the union of the required documents of the
-- company's open cases the viewer can read, each asked once against the
-- strictest validity, with each readable case's own status; a case the
-- viewer cannot read is not a column (stage only, D11). Document tasks:
-- a passed file expiring within 14 days or expired, or replaced at a
-- sibling, on an open case not yet submitted; closed cases never.
--
-- ONE statement on purpose: `supabase db query --file` sends the file as
-- a single prepared statement and rejects several. Fixtures are rolled
-- back by a sentinel exception; failures are named in the final one.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000233001';
  u_agent  UUID := '00000000-0000-4000-8000-000000233002';
  u_agent2 UUID := '00000000-0000-4000-8000-000000233003';
  u_crak   UUID := '00000000-0000-4000-8000-000000233004';
  u_cenb   UUID := '00000000-0000-4000-8000-000000233005';
  a_acct   UUID;
  c_own    UUID;
  cv_own   UUID;
  k_r      UUID;
  k_e      UUID;
  cu_kite  UUID;
  d1       UUID;
  d2       UUID;
  f_r1     UUID;
  f_r2     UUID;
  f_e1     UUID;
  today    DATE := (now() AT TIME ZONE 'Asia/Dubai')::date;
  j        JSONB;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.av_try(p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; h text;
    BEGIN
      EXECUTE p_sql INTO v;
      RETURN coalesce(v, 'ok');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
      RETURN 'ERROR ' || SQLSTATE || ' ' || coalesce(nullif(h, ''), '-') || ': ' || SQLERRM;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.av_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.av_doc(p_account uuid, p_contact uuid, p_conv uuid)
    RETURNS uuid LANGUAGE plpgsql AS $body$
    DECLARE m uuid; u text := 'https://x.invalid/av-' || gen_random_uuid() || '.pdf'; d uuid;
    BEGIN
      INSERT INTO messages (conversation_id, sender_type, content_type, media_url)
      VALUES (p_conv, 'customer', 'document', u) RETURNING id INTO m;
      PERFORM customer_documents_record(p_account, p_contact, 'chat', 'document', u, now(), p_conv, m, NULL,
                                        'application/pdf', 'doc.pdf', NULL);
      SELECT x.id INTO d FROM customer_documents x WHERE x.message_id = m;
      RETURN d;
    END $body$
  $fn$;
  -- A file classified and passed (the fixture bypasses the checker).
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.av_pass(p_file uuid, p_key text, p_version int, p_expires date)
    RETURNS void LANGUAGE sql AS $body$
      UPDATE case_document_files SET status = 'passed', doc_key = p_key, version = p_version,
             renamed_name = p_key || '.pdf', classified_at = now(), expires_on = p_expires
       WHERE id = p_file
    $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'dav-owner@example.invalid'), (u_agent, 'dav-agent@example.invalid'),
    (u_agent2, 'dav-agent2@example.invalid'), (u_crak, 'dav-crak@example.invalid'),
    (u_cenb, 'dav-cenb@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agent, u_agent2, u_crak, u_cenb);
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500233001', 'AV kite')
    RETURNING id INTO c_own;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_agent, c_own) RETURNING id INTO cv_own;
  INSERT INTO case_banks (account_id, code, name) VALUES
    (a_acct, 'RAK', 'RAKBANK'), (a_acct, 'ENBD', 'Emirates NBD')
  ON CONFLICT DO NOTHING;
  INSERT INTO coordinator_banks (account_id, user_id, bank_code) VALUES (a_acct, u_crak, 'RAK'), (a_acct, u_cenb, 'ENBD');
  INSERT INTO case_file_specs (account_id, bank_code, product, doc_key, position, name_pattern, required, min_valid_days) VALUES
    (a_acct, 'RAK', 'Business account', 'trade_licence', 1, '{{doc}}', true, 30),
    (a_acct, 'RAK', 'Business account', 'moa', 2, '{{doc}}', true, NULL),
    (a_acct, 'RAK', 'Business account', 'brochure', 9, '{{doc}}', false, NULL),
    (a_acct, 'ENBD', 'Business account', 'trade_licence', 1, '{{doc}}', true, 90),
    (a_acct, 'ENBD', 'Business account', 'kyc_form', 3, '{{doc}}', true, NULL);
  PERFORM desk_bank_code_set(u_owner, a_acct, 'RAK', 'RAK');
  PERFORM desk_bank_code_set(u_owner, a_acct, 'ENBD', 'ENB');
  SELECT x.case_id, x.customer_id INTO k_r, cu_kite
    FROM desk_case_open(a_acct, 'AV-1', 'Kite General Trading', 'RAK', 'Business account', c_own, u_agent, NULL, now()) x;
  SELECT x.case_id INTO k_e
    FROM desk_case_open(a_acct, 'AV-1', NULL, 'ENBD', 'Business account', c_own, u_agent, NULL, now()) x;
  d1 := pg_temp.av_doc(a_acct, c_own, cv_own);
  f_r1 := case_document_file_register(NULL, k_r, d1);
  f_e1 := case_document_file_register(NULL, k_e, d1);
  PERFORM pg_temp.av_pass(f_r1, 'trade_licence', 1, today + 10);
  PERFORM pg_temp.av_pass(f_e1, 'trade_licence', 1, today + 10);

  -- ---------- 1. the merged checklist ----------
  j := desk_application_checklist(u_agent, a_acct, cu_kite);
  n := n + 1; failed := failed || pg_temp.av_ok(jsonb_array_length(j->'cases') = 2
    AND (SELECT array_agg(e->>'doc_key' ORDER BY o) FROM jsonb_array_elements(j->'items') WITH ORDINALITY x(e, o))
        = ARRAY['trade_licence', 'moa', 'kyc_form'],
    format('the checklist is not the union of required documents in spec order (%s)', j->'items'));
  n := n + 1; failed := failed || pg_temp.av_ok(
    (SELECT (e->>'min_valid_days')::int FROM jsonb_array_elements(j->'items') e WHERE e->>'doc_key' = 'trade_licence') = 90
    AND (SELECT jsonb_array_length(e->'required_by') FROM jsonb_array_elements(j->'items') e WHERE e->>'doc_key' = 'trade_licence') = 2,
    'a document both banks need was not asked once against the strictest validity');
  n := n + 1; failed := failed || pg_temp.av_ok(
    (SELECT e->'cells'->k_r::text->>'status' FROM jsonb_array_elements(j->'items') e WHERE e->>'doc_key' = 'trade_licence') = 'passed'
    AND (SELECT e->'cells'->k_e::text->>'status' FROM jsonb_array_elements(j->'items') e WHERE e->>'doc_key' = 'kyc_form') = 'missing'
    AND NOT (SELECT e->'cells' ? k_e::text FROM jsonb_array_elements(j->'items') e WHERE e->>'doc_key' = 'moa'),
    'a cell does not show its own case''s status, or a bank shows a document it does not need');
  j := desk_application_checklist(u_cenb, a_acct, cu_kite);
  n := n + 1; failed := failed || pg_temp.av_ok(jsonb_array_length(j->'cases') = 1
    AND (j->'cases'->0->>'case_id')::uuid = k_e
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'items') e WHERE e->>'doc_key' = 'moa'),
    'another bank''s coordinator saw a checklist column of a case they cannot read');
  n := n + 1; failed := failed || pg_temp.av_ok(pg_temp.av_try(format(
    'SELECT desk_application_checklist(%L, %L, %L)::text', u_agent2, a_acct, cu_kite)) LIKE 'ERROR % CUSTOMER_NOT_FOUND:%',
    'someone with no case of the company read its checklist');

  -- ---------- 2. document tasks ----------
  n := n + 1; failed := failed || pg_temp.av_ok(
    (SELECT count(*) FROM desk_doc_tasks_due(now()) x WHERE x.account_id = a_acct AND x.kind = 'expiring') = 2
    AND (SELECT x.assignee FROM desk_doc_tasks_due(now()) x WHERE x.file_id = f_r1 AND x.kind = 'expiring') = u_agent,
    'a document expiring within 14 days did not raise a task on each case, for its agent');
  -- 263: a file already tasked for that reason leaves the list.
  INSERT INTO tasks (account_id, kind, source, source_ref, title)
    VALUES (a_acct, 'follow_up', 'automation', 'desk_doc:' || f_r1 || ':expiring', 'T263');
  n := n + 1;
  IF (NOT EXISTS (SELECT 1 FROM desk_doc_tasks_due(now()) x WHERE x.file_id = f_r1 AND x.kind = 'expiring') AND EXISTS (SELECT 1 FROM desk_doc_tasks_due(now()) x WHERE x.file_id = f_e1 AND x.kind = 'expiring')) IS NOT TRUE THEN failed := array_append(failed, '263: a file already tasked still held a place'::text); END IF;
  UPDATE case_document_files SET expires_on = today - 1 WHERE id = f_r1;
  n := n + 1; failed := failed || pg_temp.av_ok(EXISTS (SELECT 1 FROM desk_doc_tasks_due(now()) x
    WHERE x.file_id = f_r1 AND x.kind = 'expired'), 'an expired document was not reported expired');
  UPDATE case_document_files SET expires_on = today + 200 WHERE id IN (f_r1, f_e1);
  n := n + 1; failed := failed || pg_temp.av_ok(NOT EXISTS (SELECT 1 FROM desk_doc_tasks_due(now()) x
    WHERE x.account_id = a_acct), 'a document valid for months raised a task');
  -- RAK accepts a newer licence: ENBD's copy of the old one is flagged.
  d2 := pg_temp.av_doc(a_acct, c_own, cv_own);
  f_r2 := case_document_file_register(NULL, k_r, d2);
  UPDATE case_document_files SET status = 'superseded' WHERE id = f_r1;
  PERFORM pg_temp.av_pass(f_r2, 'trade_licence', 2, today + 300);
  n := n + 1; failed := failed || pg_temp.av_ok(
    EXISTS (SELECT 1 FROM desk_doc_tasks_due(now()) x WHERE x.file_id = f_e1 AND x.kind = 'replaced' AND x.case_id = k_e)
    AND NOT EXISTS (SELECT 1 FROM desk_doc_tasks_due(now()) x WHERE x.case_id = k_r),
    'a document replaced at a sibling bank did not flag the other case (or flagged its own)');
  UPDATE cases SET closed_at = now(), stage = 'Withdrawn' WHERE id = k_e;
  n := n + 1; failed := failed || pg_temp.av_ok(NOT EXISTS (SELECT 1 FROM desk_doc_tasks_due(now()) x
    WHERE x.case_id = k_e), 'a closed case got a document task');
  n := n + 1; failed := failed || pg_temp.av_ok(
    (SELECT f.status FROM case_document_files f WHERE f.id = f_e1) = 'passed',
    'listing tasks changed a file');

  RAISE EXCEPTION USING ERRCODE = 'ZT233', MESSAGE = 'verify-desk-application-view rollback';
  EXCEPTION WHEN SQLSTATE 'ZT233' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'desk application view verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'desk application view verification passed (% checks)', n;
END
$verify$;
