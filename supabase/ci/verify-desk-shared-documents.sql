-- Behavioural regression suite for shared documents and reuse consent
-- (migration 231).
--
-- The database refuses a cross-customer link on every insert (design
-- test 1); desk_doc_link links one stored document into another case of
-- the same company only, with the company's live consent for the
-- target's bank (test 6), and each case keeps its own status (test 7).
-- The company overview shows every case's stage to anyone who can read
-- one of its cases, files only for the cases they can read (D11).
-- Consents are revoked with a reason, never deleted or rewritten.
--
-- ONE statement on purpose: `supabase db query --file` sends the file as
-- a single prepared statement and rejects several. Fixtures are rolled
-- back by a sentinel exception; failures are named in the final one.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000231001';
  u_agent  UUID := '00000000-0000-4000-8000-000000231002';  -- agent of the Kite cases
  u_agent2 UUID := '00000000-0000-4000-8000-000000231003';  -- agent of Maro only
  u_crak   UUID := '00000000-0000-4000-8000-000000231004';  -- holds RAK
  u_cenb   UUID := '00000000-0000-4000-8000-000000231005';  -- holds ENBD
  a_acct   UUID;
  c_own    UUID;
  c_maro   UUID;
  cv_own   UUID;
  cv_maro  UUID;
  k_r      UUID;
  k_e      UUID;
  k_m      UUID;
  cu_kite  UUID;
  d1       UUID;
  d2       UUID;
  dm       UUID;
  f_r1     UUID;
  f_r2     UUID;
  f_m      UUID;
  f_e1     UUID;
  r        RECORD;
  j        JSONB;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ds_try(p_role text, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; h text;
    BEGIN
      BEGIN
        IF p_role IS NOT NULL THEN
          EXECUTE format('SET LOCAL ROLE %I', p_role);
        END IF;
        IF p_sql ILIKE 'select%' THEN
          EXECUTE p_sql INTO v;
        ELSE
          EXECUTE p_sql;
        END IF;
        RESET ROLE;
        RETURN coalesce(v, 'ok');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
        RESET ROLE;
        RETURN 'ERROR ' || SQLSTATE || ' ' || coalesce(nullif(h, ''), '-') || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ds_check(p_name text, p_role text, p_sql text, p_like text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := pg_temp.ds_try(p_role, p_sql);
    BEGIN
      RETURN CASE WHEN v LIKE p_like THEN NULL ELSE p_name || ' (' || v || ')' END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ds_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ds_doc(p_account uuid, p_contact uuid, p_conv uuid)
    RETURNS uuid LANGUAGE plpgsql AS $body$
    DECLARE m uuid; u text := 'https://x.invalid/ds-' || gen_random_uuid() || '.pdf'; d uuid;
    BEGIN
      INSERT INTO messages (conversation_id, sender_type, content_type, media_url)
      VALUES (p_conv, 'customer', 'document', u) RETURNING id INTO m;
      PERFORM customer_documents_record(p_account, p_contact, 'chat', 'document', u, now(), p_conv, m, NULL,
                                        'application/pdf', 'doc.pdf', NULL);
      SELECT x.id INTO d FROM customer_documents x WHERE x.message_id = m;
      RETURN d;
    END $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'dsd-owner@example.invalid'), (u_agent, 'dsd-agent@example.invalid'),
    (u_agent2, 'dsd-agent2@example.invalid'), (u_crak, 'dsd-crak@example.invalid'),
    (u_cenb, 'dsd-cenb@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agent, u_agent2, u_crak, u_cenb);
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500231001', 'DS kite')
    RETURNING id INTO c_own;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent2, '971500231002', 'DS maro')
    RETURNING id INTO c_maro;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_agent, c_own) RETURNING id INTO cv_own;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_agent2, c_maro) RETURNING id INTO cv_maro;
  INSERT INTO case_banks (account_id, code, name) VALUES
    (a_acct, 'RAK', 'RAKBANK'), (a_acct, 'ENBD', 'Emirates NBD')
  ON CONFLICT DO NOTHING;
  INSERT INTO coordinator_banks (account_id, user_id, bank_code) VALUES (a_acct, u_crak, 'RAK'), (a_acct, u_cenb, 'ENBD');
  PERFORM desk_bank_code_set(u_owner, a_acct, 'RAK', 'RAK');
  PERFORM desk_bank_code_set(u_owner, a_acct, 'ENBD', 'ENB');
  SELECT x.case_id, x.customer_id INTO k_r, cu_kite
    FROM desk_case_open(a_acct, 'DS-1', 'Kite General Trading', 'RAK', 'Business account', c_own, u_agent, NULL, now()) x;
  SELECT x.case_id INTO k_e
    FROM desk_case_open(a_acct, 'DS-1', NULL, 'ENBD', 'Business account', c_own, u_agent, NULL, now()) x;
  SELECT x.case_id INTO k_m
    FROM desk_case_open(a_acct, 'DS-2', 'Maro Trading', 'RAK', 'Business account', c_maro, u_agent2, NULL, now()) x;
  d1 := pg_temp.ds_doc(a_acct, c_own, cv_own);
  d2 := pg_temp.ds_doc(a_acct, c_own, cv_own);
  dm := pg_temp.ds_doc(a_acct, c_maro, cv_maro);
  f_r1 := case_document_file_register(NULL, k_r, d1);
  f_r2 := case_document_file_register(NULL, k_r, d2);
  f_m := case_document_file_register(NULL, k_m, dm);

  -- ---------- 1. the database refuses a cross-customer link ----------
  n := n + 1; failed := failed || pg_temp.ds_check('another company''s document was inserted onto a case', NULL,
    format('INSERT INTO case_document_files (account_id, case_id, customer_document_id) VALUES (%L, %L, %L)',
           a_acct, k_r, dm), 'ERROR 23514 CROSS_CUSTOMER:%');
  n := n + 1; failed := failed || pg_temp.ds_check('a document was linked into another company''s case', NULL,
    format('SELECT x.created::text FROM desk_doc_link(%L, %L, %L, %L) x', u_owner, a_acct, f_r1, k_m),
    'ERROR % CROSS_CUSTOMER:%');

  -- ---------- 2. consent per bank ----------
  n := n + 1; failed := failed || pg_temp.ds_check('a document was reused at a bank without consent', NULL,
    format('SELECT x.created::text FROM desk_doc_link(%L, %L, %L, %L) x', u_agent, a_acct, f_r1, k_e),
    'ERROR % CONSENT_MISSING:%');
  n := n + 1; failed := failed || pg_temp.ds_check('consent was recorded without evidence', NULL,
    format('SELECT desk_consent_grant(%L, %L, %L, ''ENBD'', '' a '')::text', u_agent, a_acct, cu_kite),
    'ERROR % REASON_REQUIRED:%');
  n := n + 1; failed := failed || pg_temp.ds_check('an agent with no case of the company recorded consent', NULL,
    format('SELECT desk_consent_grant(%L, %L, %L, ''ENBD'', ''customer said yes'')::text', u_agent2, a_acct, cu_kite),
    'ERROR % CUSTOMER_NOT_FOUND:%');
  PERFORM desk_consent_grant(u_agent, a_acct, cu_kite, 'ENBD', 'WhatsApp reply 21 Nov: yes, use for ENBD');

  -- ---------- 3. link: one document, its own status per case ----------
  SELECT x.file_id, x.created INTO r FROM desk_doc_link(u_agent, a_acct, f_r1, k_e) x;
  f_e1 := r.file_id;
  n := n + 1; failed := failed || pg_temp.ds_ok(r.created AND (SELECT f.status = 'unclassified'
    AND f.customer_document_id = d1 AND f.registered_by = u_agent FROM case_document_files f WHERE f.id = f_e1),
    'the link did not create an unclassified row of the same document in the actor''s name');
  n := n + 1; failed := failed || pg_temp.ds_check('a second link created another row', NULL,
    format('SELECT x.created::text FROM desk_doc_link(%L, %L, %L, %L) x', u_agent, a_acct, f_r1, k_e), 'false');
  n := n + 1; failed := failed || pg_temp.ds_ok(
    (SELECT count(*) FROM customer_documents d WHERE d.contact_id = c_own) = 2,
    'linking copied the document');
  UPDATE case_document_files SET status = 'failed', doc_key = 'trade_licence', version = 1,
         renamed_name = 'licence.pdf', classified_at = now() WHERE id = f_e1;
  n := n + 1; failed := failed || pg_temp.ds_ok(
    (SELECT f.status FROM case_document_files f WHERE f.id = f_r1) = 'unclassified',
    'a status change at one bank changed the other bank''s row');
  n := n + 1; failed := failed || pg_temp.ds_check('the ENBD holder linked from a RAK file they cannot read', NULL,
    format('SELECT x.created::text FROM desk_doc_link(%L, %L, %L, %L) x', u_cenb, a_acct, f_r2, k_e),
    'ERROR % FILE_NOT_FOUND:%');
  n := n + 1; failed := failed || pg_temp.ds_check('the RAK holder linked into the ENBD case', NULL,
    format('SELECT x.created::text FROM desk_doc_link(%L, %L, %L, %L) x', u_crak, a_acct, f_r2, k_e),
    'ERROR % CASE_NOT_FOUND:%');

  -- ---------- 4. the company across banks (D11) ----------
  j := desk_company_overview(u_cenb, a_acct, cu_kite);
  n := n + 1; failed := failed || pg_temp.ds_ok(jsonb_array_length(j->'cases') = 2
    AND (SELECT bool_and(e ? 'stage') FROM jsonb_array_elements(j->'cases') e),
    'another bank''s coordinator did not see both cases with their stage');
  n := n + 1; failed := failed || pg_temp.ds_ok(
    NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'files') e WHERE (e->>'case_id')::uuid = k_r)
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(j->'files') e
                 WHERE (e->>'file_id')::uuid = f_e1 AND (e->>'shared')::boolean),
    'the ENBD holder saw RAK''s files, or not their own shared one');
  n := n + 1; failed := failed || pg_temp.ds_check('an agent with no case of the company read its overview', NULL,
    format('SELECT desk_company_overview(%L, %L, %L)::text', u_agent2, a_acct, cu_kite), 'ERROR % CUSTOMER_NOT_FOUND:%');

  -- ---------- 5. revoke: with a reason, once; the register is append-only ----------
  n := n + 1; failed := failed || pg_temp.ds_check('consent was revoked without a reason', NULL,
    format('SELECT desk_consent_revoke(%L, %L, %L, ''ENBD'', '''')::text', u_agent, a_acct, cu_kite),
    'ERROR % REASON_REQUIRED:%');
  PERFORM desk_consent_revoke(u_agent, a_acct, cu_kite, 'ENBD', 'customer withdrew on the phone');
  n := n + 1; failed := failed || pg_temp.ds_check('a revoked consent was revoked again', NULL,
    format('SELECT desk_consent_revoke(%L, %L, %L, ''ENBD'', ''again'')::text', u_agent, a_acct, cu_kite),
    'ERROR % CONSENT_NOT_FOUND:%');
  n := n + 1; failed := failed || pg_temp.ds_check('a document was reused after consent was revoked', NULL,
    format('SELECT x.created::text FROM desk_doc_link(%L, %L, %L, %L) x', u_agent, a_acct, f_r2, k_e),
    'ERROR % CONSENT_MISSING:%');
  n := n + 1; failed := failed || pg_temp.ds_check('a consent row was deleted', NULL,
    format('DELETE FROM desk_doc_consents WHERE customer_id = %L', cu_kite), 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.ds_check('a revoked consent was rewritten', NULL,
    format('UPDATE desk_doc_consents SET revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL WHERE customer_id = %L', cu_kite),
    'ERROR 42501%');
  PERFORM desk_consent_grant(u_owner, a_acct, cu_kite, 'ENBD', 'signed reuse form');
  n := n + 1; failed := failed || pg_temp.ds_ok(
    (SELECT count(*) FROM desk_doc_consents c WHERE c.customer_id = cu_kite) = 2
    AND (SELECT count(*) FROM desk_doc_consents c WHERE c.customer_id = cu_kite AND c.revoked_at IS NULL) = 1,
    'granting again did not keep the revoked row beside one live row');

  -- ---------- 6. privacy and closed tables ----------
  j := privacy_subject_export(u_owner, a_acct, c_own);
  n := n + 1; failed := failed || pg_temp.ds_ok(jsonb_array_length(j->'data'->'desk_reuse_consents') = 2,
    'the export did not carry the company''s consents');
  n := n + 1; failed := failed || pg_temp.ds_check('authenticated read desk_doc_consents', 'authenticated',
    'SELECT count(*)::text FROM public.desk_doc_consents', 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.ds_check('service_role read desk_doc_consents directly', 'service_role',
    'SELECT count(*)::text FROM public.desk_doc_consents', 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.ds_check('authenticated called desk_doc_link', 'authenticated',
    format('SELECT x.created::text FROM desk_doc_link(%L, %L, %L, %L) x', u_owner, a_acct, f_r1, k_e), 'ERROR 42501%');

  RAISE EXCEPTION USING ERRCODE = 'ZT231', MESSAGE = 'verify-desk-shared-documents rollback';
  EXCEPTION WHEN SQLSTATE 'ZT231' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'desk shared documents verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'desk shared documents verification passed (% checks)', n;
END
$verify$;
