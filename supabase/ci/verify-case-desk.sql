-- Behavioural regression suite for the case desk (migration 220).
--
-- Numbers: the check character and caption codes match the TS mirror
-- (src/lib/desk/case-number.test.ts pins the same vectors); application
-- numbers are gapless per account and never restart. Intake: complete
-- tags file at once (new case opens the company's lead, a caption code
-- files to its open case, the same bytes twice are a duplicate), anything
-- else waits untagged with a reason; a one-character typo never
-- resolves. Sorting: owners / admins / team leaders sort every queue, a
-- holder of a bank (133/161) only that bank's; the no-bank queue is team
-- leaders and up; only the uploader retags. Tables are closed to client
-- roles; the event log is append-only.
--
-- ONE statement on purpose: `supabase db query --file` sends the file as
-- a single prepared statement and rejects several. Fixtures are rolled
-- back by a sentinel exception; failures are named in the final one.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000220001';
  u_admin  UUID := '00000000-0000-4000-8000-000000220002';
  u_lead   UUID := '00000000-0000-4000-8000-000000220003';
  u_agent  UUID := '00000000-0000-4000-8000-000000220004';  -- uploader
  u_agent2 UUID := '00000000-0000-4000-8000-000000220005';  -- second uploader
  u_crak   UUID := '00000000-0000-4000-8000-000000220006';  -- holds RAK
  u_cenb   UUID := '00000000-0000-4000-8000-000000220007';  -- holds ENBD
  u_bown   UUID := '00000000-0000-4000-8000-000000220008';  -- owner of account B
  a_acct   UUID;
  b_acct   UUID;
  c1       UUID;
  c2       UUID;
  c3       UUID;
  i1 UUID := gen_random_uuid();
  i2 UUID := gen_random_uuid();
  i3 UUID := gen_random_uuid();
  i4 UUID := gen_random_uuid();
  i5 UUID := gen_random_uuid();
  i6 UUID := gen_random_uuid();
  i7 UUID := gen_random_uuid();
  i8 UUID := gen_random_uuid();
  i9 UUID := gen_random_uuid();
  i10 UUID := gen_random_uuid();
  i11 UUID := gen_random_uuid();
  i12 UUID := gen_random_uuid();
  k1       UUID;
  k2       UUID;
  code1    TEXT;
  bad      TEXT;
  sha1     TEXT := repeat('a', 64);
  sha2     TEXT := repeat('b', 64);
  yy       TEXT := lpad((extract(year FROM now() AT TIME ZONE 'Asia/Dubai')::int % 100)::text, 2, '0');
  r        RECORD;
  st       TEXT;
  v        TEXT;
  b1       BOOLEAN;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- A statement as p_role (NULL: the current user): a SELECT's value,
  -- 'ok', or 'ERROR <sqlstate> <hint>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cd_try(p_role text, p_sql text)
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
    CREATE FUNCTION pg_temp.cd_check(p_name text, p_role text, p_sql text, p_like text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := pg_temp.cd_try(p_role, p_sql);
    BEGIN
      RETURN CASE WHEN v LIKE p_like THEN NULL ELSE p_name || ' (' || v || ')' END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cd_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  -- intake_submit as SQL text; the result is 'state|queue_reason|case_number|replayed'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cd_sub(p_actor uuid, p_account uuid, p_item uuid, p_idem text, p_kind text,
      p_bank text, p_ref text, p_company text, p_licence text, p_product text, p_contact uuid, p_sha text,
      p_path text DEFAULT NULL)
    RETURNS text LANGUAGE sql AS $body$
      SELECT format('SELECT x.state || ''|'' || coalesce(x.queue_reason, ''-'') || ''|'' || coalesce(x.case_number, ''-'')'
                    ' || ''|'' || x.replayed FROM intake_submit(%L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L, NULL, NULL,'
                    ' %L, %L, %L, %s, %L) x',
                    p_actor, p_account, p_item, p_idem, p_kind, p_bank, p_ref, p_company, p_licence, p_product,
                    p_contact,
                    CASE WHEN p_sha IS NULL THEN NULL ELSE coalesce(p_path, 'intake/' || p_item || '/' || p_sha || '.pdf') END,
                    CASE WHEN p_sha IS NULL THEN NULL ELSE 'licence.pdf' END,
                    CASE WHEN p_sha IS NULL THEN NULL ELSE 'application/pdf' END,
                    CASE WHEN p_sha IS NULL THEN 'NULL' ELSE '1000' END,
                    p_sha)
    $body$
  $fn$;

  -- ---------- 1. numbering (the TS mirror pins the same vectors) ----------
  n := n + 1; failed := failed || pg_temp.cd_ok(
    desk_caption_code(1, 'RAK') = '1RAK1' AND desk_caption_code(4271, 'RAK') = '4271RAKD'
    AND desk_caption_code(4271, 'RAK2') = '4271RAK2K' AND desk_caption_code(1234567, 'ENB') = '1234567ENBV'
    AND desk_check_char('2600001RAK') = 'N' AND desk_case_number(26, 4271, 'RAK') = 'TC-26-04271-RAK'
    AND desk_case_number(26, 123456, 'RAK2') = 'TC-26-123456-RAK2' AND desk_check_char('ab') IS NULL,
    'numbering vectors differ from the TS mirror');
  -- Every single substitution of a payload character changes the check.
  SELECT bool_and(desk_check_char(overlay('04271RAK2' PLACING ch FROM pos FOR 1)) <> desk_check_char('04271RAK2'))
    INTO b1
    FROM generate_series(1, 9) pos,
         regexp_split_to_table('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', '') ch
   WHERE substr('04271RAK2', pos, 1) <> ch;
  n := n + 1; failed := failed || pg_temp.cd_ok(b1, 'a single substitution kept the check character');

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'cd-owner@example.invalid'), (u_admin, 'cd-admin@example.invalid'),
    (u_lead, 'cd-lead@example.invalid'), (u_agent, 'cd-agent@example.invalid'),
    (u_agent2, 'cd-agent2@example.invalid'), (u_crak, 'cd-crak@example.invalid'),
    (u_cenb, 'cd-cenb@example.invalid'), (u_bown, 'cd-bown@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_bown;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agent, u_agent2, u_crak, u_cenb);
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500220001', 'CD one')
    RETURNING id INTO c1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500220002', 'CD two')
    RETURNING id INTO c2;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent2, '971500220003', 'CD three')
    RETURNING id INTO c3;
  INSERT INTO case_banks (account_id, code, name) VALUES
    (a_acct, 'RAK', 'RAKBANK'), (a_acct, 'ENBD', 'Emirates NBD'), (a_acct, 'FAB', 'FAB')
  ON CONFLICT DO NOTHING;
  INSERT INTO coordinator_banks (account_id, user_id, bank_code) VALUES
    (a_acct, u_crak, 'RAK'), (a_acct, u_cenb, 'ENBD');

  -- ---------- 2. desk codes ----------
  n := n + 1; failed := failed || pg_temp.cd_check('an agent set a desk code', NULL,
    format('SELECT desk_bank_code_set(%L, %L, ''RAK'', ''RAK'')::text', u_agent, a_acct), 'ERROR % NOT_ALLOWED:%');
  n := n + 1; failed := failed || pg_temp.cd_check('a two-letter desk code was accepted', NULL,
    format('SELECT desk_bank_code_set(%L, %L, ''RAK'', ''RA'')::text', u_admin, a_acct), 'ERROR % INVALID:%');
  PERFORM desk_bank_code_set(u_admin, a_acct, 'RAK', 'rak');
  PERFORM desk_bank_code_set(u_owner, a_acct, 'ENBD', 'ENB');
  n := n + 1; failed := failed || pg_temp.cd_check('a desk code was given to two banks', NULL,
    format('SELECT desk_bank_code_set(%L, %L, ''FAB'', ''ENB'')::text', u_admin, a_acct), 'ERROR % CODE_TAKEN:%');
  n := n + 1; failed := failed || pg_temp.cd_ok(desk_bank_by_short(a_acct, ' enb ') = 'ENBD',
    'desk_bank_by_short did not map ENB to ENBD');

  -- ---------- 3. a new case files at once ----------
  v := pg_temp.cd_try(NULL, pg_temp.cd_sub(u_agent, a_acct, i1, 'idem-0001', 'new_case', 'RAK', NULL,
         'Kite General Trading', '12-34 567', 'Business account', c1, NULL));
  n := n + 1; failed := failed || pg_temp.cd_ok(v = 'filed|-|TC-' || yy || '-00001-RAK|false',
    format('a complete new case did not file as TC-%s-00001-RAK (%s)', yy, v));
  SELECT x.filed_case_id INTO k1 FROM intake_items x WHERE x.id = i1;
  SELECT (x.group_id IS NULL AND x.stage = 'Interested' AND x.agent_id = u_agent AND x.contact_id = c1
          AND x.lead_source = 'desk' AND x.desk_customer_id IS NOT NULL)
    INTO b1 FROM cases x WHERE x.id = k1;
  n := n + 1; failed := failed || pg_temp.cd_ok(b1, 'the desk case is not a lead of the uploader for c1');
  n := n + 1; failed := failed || pg_temp.cd_ok(
    (SELECT trade_licence_no FROM desk_customers WHERE account_id = a_acct) = '1234567',
    'the trade licence was not normalised');
  code1 := (SELECT x.caption_code FROM intake_result(i1, false) x);
  n := n + 1; failed := failed || pg_temp.cd_ok(code1 = desk_caption_code(1, 'RAK'), 'the caption code was not returned');

  -- Replay: same uploader and key -> the first result.
  v := pg_temp.cd_try(NULL, pg_temp.cd_sub(u_agent, a_acct, gen_random_uuid(), 'idem-0001', 'info', NULL, code1,
         NULL, NULL, NULL, NULL, NULL));
  n := n + 1; failed := failed || pg_temp.cd_ok(v LIKE 'filed|-|TC-%-00001-RAK|true', format('a replay was not idempotent (%s)', v));

  -- The same company, bank and product again joins the case.
  v := pg_temp.cd_try(NULL, pg_temp.cd_sub(u_agent, a_acct, i2, 'idem-0002', 'new_case', 'RAK', NULL,
         '  kite   general trading ', '1234567', 'Business account', c1, NULL));
  n := n + 1; failed := failed || pg_temp.cd_ok(v LIKE 'filed|-|TC-%-00001-RAK|false', format('the same company did not join its case (%s)', v));
  -- The licence under another legal name waits.
  v := pg_temp.cd_try(NULL, pg_temp.cd_sub(u_agent, a_acct, i3, 'idem-0003', 'new_case', 'RAK', NULL,
         'Other Name LLC', '1234567', 'Business account', c1, NULL));
  n := n + 1; failed := failed || pg_temp.cd_ok(v = 'untagged|CASE_EXISTS_NAME_MISMATCH|-|false', format('a name mismatch did not wait (%s)', v));
  -- No contact -> the bank's queue.
  v := pg_temp.cd_try(NULL, pg_temp.cd_sub(u_agent2, a_acct, i4, 'idem-0004', 'new_case', 'ENBD', NULL,
         'Maro Trading', 'CN-998877', 'Business account', NULL, NULL));
  n := n + 1; failed := failed || pg_temp.cd_ok(v = 'untagged|NO_CONTACT|-|false', format('a new case without a contact did not wait (%s)', v));
  n := n + 1; failed := failed || pg_temp.cd_ok((SELECT queue_bank_code FROM intake_items WHERE id = i4) = 'ENBD',
    'the waiting item is not in the ENBD queue');

  -- ---------- 4. caption codes ----------
  v := pg_temp.cd_try(NULL, pg_temp.cd_sub(u_agent2, a_acct, i5, 'idem-0005', 'pending_doc', NULL, lower(code1),
         NULL, NULL, NULL, NULL, NULL));
  n := n + 1; failed := failed || pg_temp.cd_ok(v = 'untagged|NO_FILE|-|false', format('a pending document without a file did not wait (%s)', v));
  bad := left(code1, length(code1) - 1) || CASE WHEN right(code1, 1) = 'Z' THEN 'Y' ELSE 'Z' END;
  v := pg_temp.cd_try(NULL, pg_temp.cd_sub(u_agent2, a_acct, i6, 'idem-0006', 'pending_doc', NULL, bad,
         NULL, NULL, NULL, NULL, sha1));
  n := n + 1; failed := failed || pg_temp.cd_ok(v = 'untagged|CASE_NOT_FOUND|-|false', format('a mistyped caption code resolved (%s)', v));
  -- An agent who is not the case's agent files by the code; the file is the uploader's.
  v := pg_temp.cd_try(NULL, pg_temp.cd_sub(u_agent2, a_acct, i7, 'idem-0007', 'pending_doc', NULL, code1,
         NULL, NULL, NULL, NULL, sha1));
  n := n + 1; failed := failed || pg_temp.cd_ok(v LIKE 'filed|-|TC-%-00001-RAK|false', format('a valid caption code did not file (%s)', v));
  SELECT (f.registered_by = u_agent2 AND d.source = 'staff_upload' AND d.uploaded_by = u_agent2
          AND d.contact_id = c1 AND d.storage_bucket = 'case-files' AND d.storage_path = 'intake/' || i7 || '/' || sha1 || '.pdf')
    INTO b1
    FROM intake_items i JOIN case_document_files f ON f.id = i.file_id
    JOIN customer_documents d ON d.id = f.customer_document_id
   WHERE i.id = i7;
  n := n + 1; failed := failed || pg_temp.cd_ok(b1, 'the filed file is not the uploader''s staff upload on the case');
  -- The same bytes again (another uploader) -> duplicate of i7, no file row.
  v := pg_temp.cd_try(NULL, pg_temp.cd_sub(u_agent, a_acct, i8, 'idem-0008', 'pending_doc', NULL,
         (SELECT case_number FROM cases WHERE id = k1), NULL, NULL, NULL, NULL, sha1));
  n := n + 1; failed := failed || pg_temp.cd_ok(v LIKE 'duplicate|-|TC-%|false', format('the same bytes twice were not a duplicate (%s)', v));
  n := n + 1; failed := failed || pg_temp.cd_ok((SELECT duplicate_of_item FROM intake_items WHERE id = i8) = i7,
    'the duplicate does not point at the first item');
  n := n + 1; failed := failed || pg_temp.cd_ok((SELECT count(*) FROM case_document_files WHERE case_id = k1) = 1,
    'a duplicate created a second file row');
  -- A storage path that is not the item's own.
  n := n + 1; failed := failed || pg_temp.cd_check('a foreign storage path was accepted', NULL,
    pg_temp.cd_sub(u_agent, a_acct, gen_random_uuid(), 'idem-0009', 'pending_doc', NULL, code1, NULL, NULL, NULL, NULL,
                   sha2, 'intake/other/' || sha2 || '.pdf'), 'ERROR % FILE_INVALID:%');
  -- Info without a kind and without a ref -> the team-lead queue.
  v := pg_temp.cd_try(NULL, pg_temp.cd_sub(u_agent, a_acct, i9, 'idem-0010', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL));
  n := n + 1; failed := failed || pg_temp.cd_ok(v = 'untagged|NO_KIND|-|false', format('an untagged upload did not wait (%s)', v));

  -- ---------- 5. gapless per account ----------
  v := pg_temp.cd_try(NULL, pg_temp.cd_sub(u_agent, a_acct, i10, 'idem-0011', 'new_case', 'ENBD', NULL,
         'Second Co', '7654321', 'Card', c2, NULL));
  n := n + 1; failed := failed || pg_temp.cd_ok(v = 'filed|-|TC-' || yy || '-00002-ENB|false', format('the second company is not 00002 (%s)', v));
  n := n + 1; failed := failed || pg_temp.cd_check('a refused open consumed a number', NULL,
    format('SELECT next_val::text FROM desk_number_seq WHERE account_id = %L', a_acct), '3');

  -- ---------- 6. sorting scope ----------
  n := n + 1; failed := failed || pg_temp.cd_check('an agent holding no bank listed the queue', NULL,
    format('SELECT count(*)::text FROM intake_queue_list(%L, %L)', u_agent, a_acct), 'ERROR % NOT_ALLOWED:%');
  n := n + 1; failed := failed || pg_temp.cd_check('the ENBD holder saw other queues', NULL,
    format('SELECT string_agg(item_id::text, '','') FROM intake_queue_list(%L, %L)', u_cenb, a_acct), i4::text);
  n := n + 1; failed := failed || pg_temp.cd_check('the team leader did not see every queue', NULL,
    format('SELECT count(*)::text FROM intake_queue_list(%L, %L)', u_lead, a_acct), '5');
  n := n + 1; failed := failed || pg_temp.cd_check('the ENBD holder sorted a RAK item', NULL,
    format('SELECT state FROM intake_reject(%L, %L, %L, ''not ours'')', u_cenb, a_acct, i5), 'ERROR % BANK_SCOPE:%');
  n := n + 1; failed := failed || pg_temp.cd_check('a bank holder sorted the no-bank queue', NULL,
    format('SELECT state FROM intake_reject(%L, %L, %L, ''x'')', u_crak, a_acct, i9), 'ERROR % BANK_SCOPE:%');
  n := n + 1; failed := failed || pg_temp.cd_check('another account''s owner reached an item', NULL,
    format('SELECT state FROM intake_reject(%L, %L, %L, ''x'')', u_bown, b_acct, i5), 'ERROR % ITEM_NOT_FOUND:%');
  n := n + 1; failed := failed || pg_temp.cd_check('the RAK holder filed onto an ENBD case', NULL,
    format('SELECT state FROM intake_file(%L, %L, %L, %L, ''info'', NULL)', u_crak, a_acct, i5,
           (SELECT filed_case_id FROM intake_items WHERE id = i10)), 'ERROR % BANK_SCOPE:%');
  -- c2 already has an open ENBD lead (i10's): one open lead per contact and bank.
  n := n + 1; failed := failed || pg_temp.cd_check('a second ENBD lead for c2 was opened', NULL,
    format('SELECT state FROM intake_file_new_case(%L, %L, %L, ''CN-998877'', ''Maro Trading'', ''ENBD'', ''Card'', %L)',
           u_cenb, a_acct, i4, c2), 'ERROR % CASE_CONFLICT:%');
  -- The case lookup answers only in scope.
  n := n + 1; failed := failed || pg_temp.cd_check('the RAK holder could not look up a RAK case by code', NULL,
    format('SELECT company_name FROM intake_case_lookup(%L, %L, %L)', u_crak, a_acct, code1), 'Kite General Trading');
  n := n + 1; failed := failed || pg_temp.cd_check('the ENBD holder looked up a RAK case', NULL,
    format('SELECT count(*)::text FROM intake_case_lookup(%L, %L, %L)', u_cenb, a_acct, code1), '0');
  n := n + 1; failed := failed || pg_temp.cd_check('a team leader looked up a case outside their team', NULL,
    format('SELECT count(*)::text FROM intake_case_lookup(%L, %L, %L)', u_lead, a_acct, code1), '0');
  n := n + 1; failed := failed || pg_temp.cd_check('a team leader filed onto a case outside their team', NULL,
    format('SELECT state FROM intake_file(%L, %L, %L, %L, ''info'', NULL)', u_lead, a_acct, i5, k1),
    'ERROR % CASE_NOT_FOUND:%');
  n := n + 1; failed := failed || pg_temp.cd_check('the admin could not look up a case', NULL,
    format('SELECT count(*)::text FROM intake_case_lookup(%L, %L, %L)', u_admin, a_acct, code1), '1');
  n := n + 1; failed := failed || pg_temp.cd_check('an agent looked up a case', NULL,
    format('SELECT count(*)::text FROM intake_case_lookup(%L, %L, %L)', u_agent, a_acct, code1), 'ERROR % NOT_ALLOWED:%');
  -- The ENBD holder opens i4's case with a contact: opened as the uploader, holder as coordinator.
  v := pg_temp.cd_try(NULL, format('SELECT state || ''|'' || case_number FROM intake_file_new_case(%L, %L, %L, %L, %L, ''ENBD'', ''Card'', %L)',
         u_cenb, a_acct, i4, 'CN-998877', 'Maro Trading', c3));
  n := n + 1; failed := failed || pg_temp.cd_ok(v = 'filed|TC-' || yy || '-00003-ENB', format('the sorter could not open the case (%s)', v));
  SELECT x.agent_id = u_agent2 AND x.coordinator_id = u_cenb INTO b1
    FROM cases x JOIN intake_items i ON i.filed_case_id = x.id WHERE i.id = i4;
  n := n + 1; failed := failed || pg_temp.cd_ok(b1, 'the sorted case is not the uploader''s with the holder as coordinator');
  -- Reject needs a reason; a decided item is closed.
  n := n + 1; failed := failed || pg_temp.cd_check('a reject without a reason was accepted', NULL,
    format('SELECT state FROM intake_reject(%L, %L, %L, E''\t'')', u_crak, a_acct, i5), 'ERROR % REASON_REQUIRED:%');
  n := n + 1; failed := failed || pg_temp.cd_check('the RAK holder could not reject a RAK item', NULL,
    format('SELECT state FROM intake_reject(%L, %L, %L, ''sent twice'')', u_crak, a_acct, i5), 'rejected');
  n := n + 1; failed := failed || pg_temp.cd_check('a rejected item was decided again', NULL,
    format('SELECT state FROM intake_reject(%L, %L, %L, ''again'')', u_lead, a_acct, i5), 'ERROR % ITEM_NOT_OPEN:%');

  -- ---------- 7. retag ----------
  n := n + 1; failed := failed || pg_temp.cd_check('someone else retagged an item', NULL,
    format('SELECT state FROM intake_retag(%L, %L, %L, ''info'', NULL, %L, NULL, NULL, NULL, NULL, NULL, NULL)',
           u_agent2, a_acct, i9, code1), 'ERROR % NOT_ALLOWED:%');
  n := n + 1; failed := failed || pg_temp.cd_check('the uploader''s retag did not file', NULL,
    format('SELECT state FROM intake_retag(%L, %L, %L, ''info'', NULL, %L, NULL, NULL, NULL, NULL, NULL, ''call back'')',
           u_agent, a_acct, i9, code1), 'filed');

  -- ---------- 8. my uploads and the overview ----------
  n := n + 1; failed := failed || pg_temp.cd_check('my uploads listed someone else''s', NULL,
    format('SELECT count(*)::text FROM intake_my_list(%L, %L)', u_agent2, a_acct), '4');
  n := n + 1; failed := failed || pg_temp.cd_check('an agent read the overview', NULL,
    format('SELECT count(*)::text FROM intake_desk_overview(%L, %L)', u_agent, a_acct), 'ERROR % NOT_ALLOWED:%');
  n := n + 1; failed := failed || pg_temp.cd_check('the overview misreports RAK', NULL,
    format('SELECT holders || ''/'' || to_sort || ''/'' || alert FROM intake_desk_overview(%L, %L) WHERE bank_code = ''RAK''',
           u_admin, a_acct), '1/1/none');
  n := n + 1; failed := failed || pg_temp.cd_check('an old untagged item raised no lead alert', NULL,
    format('SELECT alert FROM intake_desk_overview(%L, %L, now() + interval ''5 hours'') WHERE bank_code = ''RAK''',
           u_admin, a_acct), 'lead');

  -- ---------- 9. storage rules ----------
  n := n + 1; failed := failed || pg_temp.cd_check('the event log took an UPDATE', NULL,
    format('UPDATE intake_item_events SET state = ''filed'' WHERE item_id = %L', i9), 'ERROR %');
  n := n + 1; failed := failed || pg_temp.cd_ok((SELECT count(*) FROM intake_item_events WHERE item_id = i9) = 4,
    'the retagged item does not have four events (received, routed, retag, filed)');
  n := n + 1; failed := failed || pg_temp.cd_check('authenticated read intake_items', 'authenticated',
    'SELECT count(*)::text FROM public.intake_items', 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.cd_check('authenticated called intake_submit', 'authenticated',
    pg_temp.cd_sub(u_agent, a_acct, gen_random_uuid(), 'idem-0012', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
    'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.cd_check('a case number in a bad shape was stored', NULL,
    format('UPDATE cases SET case_number = ''TC-26-1-RAK'' WHERE id = %L', k1), 'ERROR 23514%');
  -- A numbered bank's desk code is fixed.
  n := n + 1; failed := failed || pg_temp.cd_check('a numbered bank changed its desk code', NULL,
    format('SELECT desk_bank_code_set(%L, %L, ''RAK'', ''RKB'')::text', u_admin, a_acct), 'ERROR % CODE_TAKEN:%');

  RAISE EXCEPTION USING ERRCODE = 'ZT220', MESSAGE = 'verify-case-desk rollback';
  EXCEPTION WHEN SQLSTATE 'ZT220' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'case desk verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'case desk verification passed (% checks)', n;
END
$verify$;
