-- Behavioural regression suite for desk WhatsApp routing and the tray
-- (migration 230).
--
-- Off by default. With it on: the only open case of a one-company sender
-- files at once (E4); a quoted message of ours naming a case (E1) or a
-- caption code (E2) picks among several; E1 and E2 disagreeing, several
-- open cases or several companies without either go to the tray with
-- every candidate and none chosen; another person's document (a PRO)
-- never files automatically; an unknown sender is the desk's only on a
-- desk number; a staff phone is handed to the staff upload. Tray: bank
-- scope, typed company confirmation, the intake path for another
-- person's document, dismissal with a reason, one escalation. Privacy:
-- exported and erased through the 229 registry. Closed to API roles.
--
-- ONE statement on purpose: `supabase db query --file` sends the file as
-- a single prepared statement and rejects several. Fixtures are rolled
-- back by a sentinel exception; failures are named in the final one.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000230001';
  u_lead   UUID := '00000000-0000-4000-8000-000000230002';
  u_agent  UUID := '00000000-0000-4000-8000-000000230003';
  u_staff  UUID := '00000000-0000-4000-8000-000000230004';  -- has a saved WhatsApp number
  u_crak   UUID := '00000000-0000-4000-8000-000000230005';  -- holds RAK, on duty
  a_acct   UUID;
  w_desk   UUID;
  w_sales  UUID;
  c_own    UUID;  -- Kite's case contact
  c_pro    UUID;  -- acts for Kite (and later Maro)
  c_maro   UUID;  -- Maro's case contact
  c_str    UUID;  -- nobody's
  c_stf    UUID;  -- the staff member's own phone
  cv_own   UUID;
  cv_pro   UUID;
  cv_str   UUID;
  cv_stf   UUID;
  k_r      UUID;  -- Kite at RAK
  k_e      UUID;  -- Kite at ENBD
  k_m      UUID;  -- Maro at ENBD
  cu_kite  UUID;
  cu_maro  UUID;
  m_ask    UUID;
  doc      UUID;
  t_many   UUID;
  t_pro    UUID;
  t_unk    UUID;
  t_conf   UUID;
  item     UUID := gen_random_uuid();
  code_e   TEXT;
  r        RECORD;
  j        JSONB;
  v        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.dw_try(p_role text, p_sql text)
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
    CREATE FUNCTION pg_temp.dw_check(p_name text, p_role text, p_sql text, p_like text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := pg_temp.dw_try(p_role, p_sql);
    BEGIN
      RETURN CASE WHEN v LIKE p_like THEN NULL ELSE p_name || ' (' || v || ')' END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.dw_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  -- A customer's 1:1 document (178), optionally quoting a message: its id.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.dw_doc(p_account uuid, p_contact uuid, p_conv uuid, p_caption text, p_reply uuid)
    RETURNS uuid LANGUAGE plpgsql AS $body$
    DECLARE m uuid; u text := 'https://x.invalid/dw-' || gen_random_uuid() || '.pdf'; d uuid;
    BEGIN
      INSERT INTO messages (conversation_id, sender_type, content_type, media_url, content_text, reply_to_message_id)
      VALUES (p_conv, 'customer', 'document', u, p_caption, p_reply) RETURNING id INTO m;
      PERFORM customer_documents_record(p_account, p_contact, 'chat', 'document', u, now(), p_conv, m, NULL,
                                        'application/pdf', 'doc.pdf', p_caption);
      SELECT x.id INTO d FROM customer_documents x WHERE x.message_id = m;
      RETURN d;
    END $body$
  $fn$;
  -- desk_route_customer_document as 'action|reason|case id'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.dw_route(p_account uuid, p_doc uuid, p_channel uuid)
    RETURNS text LANGUAGE sql AS $body$
      SELECT x.action || '|' || coalesce(x.reason, '-') || '|' || coalesce(x.case_id::text, '-')
        FROM desk_route_customer_document(p_account, p_doc, p_channel, now()) x
    $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'dwr-owner@example.invalid'), (u_lead, 'dwr-lead@example.invalid'),
    (u_agent, 'dwr-agent@example.invalid'), (u_staff, 'dwr-staff@example.invalid'),
    (u_crak, 'dwr-crak@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agent, u_staff, u_crak);
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'DW-230-A1', 'x', 'connected', true) RETURNING id INTO w_sales;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'DW-230-A2', 'x', 'connected', false) RETURNING id INTO w_desk;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500230001', 'DW own')
    RETURNING id INTO c_own;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500230002', 'DW pro')
    RETURNING id INTO c_pro;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500230003', 'DW maro')
    RETURNING id INTO c_maro;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500230004', 'DW stranger')
    RETURNING id INTO c_str;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500230005', 'DW staff phone')
    RETURNING id INTO c_stf;
  INSERT INTO coordinator_phones (account_id, user_id, phone) VALUES (a_acct, u_staff, '971500230005');
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_agent, c_own) RETURNING id INTO cv_own;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_agent, c_pro) RETURNING id INTO cv_pro;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_agent, c_str) RETURNING id INTO cv_str;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_agent, c_stf) RETURNING id INTO cv_stf;
  INSERT INTO case_banks (account_id, code, name) VALUES
    (a_acct, 'RAK', 'RAKBANK'), (a_acct, 'ENBD', 'Emirates NBD')
  ON CONFLICT DO NOTHING;
  INSERT INTO coordinator_banks (account_id, user_id, bank_code) VALUES (a_acct, u_crak, 'RAK');
  PERFORM desk_bank_code_set(u_owner, a_acct, 'RAK', 'RAK');
  PERFORM desk_bank_code_set(u_owner, a_acct, 'ENBD', 'ENB');
  SELECT x.case_id, x.customer_id INTO k_r, cu_kite
    FROM desk_case_open(a_acct, 'DW-1', 'Kite General Trading', 'RAK', 'Business account', c_own, u_agent, NULL, now()) x;
  PERFORM desk_customer_contact_set(u_owner, a_acct, cu_kite, c_pro, 'pro', true);

  -- ---------- 1. off by default; settings ----------
  doc := pg_temp.dw_doc(a_acct, c_own, cv_own, NULL, NULL);
  n := n + 1; failed := failed || pg_temp.dw_ok(pg_temp.dw_route(a_acct, doc, w_sales) = 'off|-|-',
    'routing ran while switched off');
  n := n + 1; failed := failed || pg_temp.dw_check('an agent switched routing on', NULL,
    format('SELECT desk_settings_set(%L, %L, true, ''{}'', 120)::text', u_agent, a_acct), 'ERROR % NOT_ALLOWED:%');
  n := n + 1; failed := failed || pg_temp.dw_check('a number of no workspace was taken as a desk number', NULL,
    format('SELECT desk_settings_set(%L, %L, true, ARRAY[%L]::uuid[], 120)::text', u_owner, a_acct, gen_random_uuid()),
    'ERROR % INVALID:%');
  PERFORM desk_settings_set(u_owner, a_acct, true, ARRAY[w_desk], 120);
  n := n + 1; failed := failed || pg_temp.dw_check('an agent set the duty owner', NULL,
    format('SELECT desk_duty_set(%L, %L, %L)::text', u_agent, a_acct, u_agent), 'ERROR % NOT_ALLOWED:%');
  PERFORM desk_duty_set(u_lead, a_acct, u_crak);

  -- ---------- 2. E4: the only open case of a one-company sender ----------
  v := pg_temp.dw_route(a_acct, doc, w_sales);
  n := n + 1; failed := failed || pg_temp.dw_ok(v = 'filed|-|' || k_r,
    format('the only open case did not take its contact''s document (%s)', v));
  n := n + 1; failed := failed || pg_temp.dw_ok(EXISTS (SELECT 1 FROM case_document_files f
    WHERE f.case_id = k_r AND f.customer_document_id = doc AND f.registered_by IS NULL),
    'the automatic file is not 181''s system intake (registered_by NULL)');
  n := n + 1; failed := failed || pg_temp.dw_ok(pg_temp.dw_route(a_acct, doc, w_sales) = 'filed|-|' || k_r,
    'a replay did not answer the first decision');

  -- ---------- 3. two open cases: nothing chosen without evidence ----------
  SELECT x.case_id INTO k_e
    FROM desk_case_open(a_acct, 'DW-1', NULL, 'ENBD', 'Business account', c_own, u_agent, NULL, now()) x;
  SELECT desk_caption_code(split_part(k.case_number, '-', 3)::int, split_part(k.case_number, '-', 4))
    INTO code_e FROM cases k WHERE k.id = k_e;
  doc := pg_temp.dw_doc(a_acct, c_own, cv_own, 'licence copy', NULL);
  v := pg_temp.dw_route(a_acct, doc, w_sales);
  SELECT t.id INTO t_many FROM desk_tray t WHERE t.customer_document_id = doc;
  n := n + 1; failed := failed || pg_temp.dw_ok(v LIKE 'tray|many_cases|-'
    AND (SELECT jsonb_array_length(t.candidates) FROM desk_tray t WHERE t.id = t_many) = 2
    AND NOT EXISTS (SELECT 1 FROM case_document_files f WHERE f.customer_document_id = doc),
    format('two open cases without evidence did not go to the tray with both, unfiled (%s)', v));
  -- E2: the caption code picks one.
  doc := pg_temp.dw_doc(a_acct, c_own, cv_own, code_e || ' ejari', NULL);
  n := n + 1; failed := failed || pg_temp.dw_ok(pg_temp.dw_route(a_acct, doc, w_sales) = 'filed|-|' || k_e,
    'a caption code did not file to its case');
  -- A one-character typo in the code resolves to nothing.
  doc := pg_temp.dw_doc(a_acct, c_own, cv_own,
    overlay(code_e PLACING CASE WHEN right(code_e, 1) = 'A' THEN 'B' ELSE 'A' END FROM char_length(code_e) FOR 1), NULL);
  n := n + 1; failed := failed || pg_temp.dw_ok(pg_temp.dw_route(a_acct, doc, w_sales) LIKE 'tray|many_cases|%',
    'a mistyped caption code filed a document');
  -- E1: replying to our message that names the RAK case.
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_type, content_text)
  VALUES (cv_own, 'agent', u_agent, 'text',
          'Please send the Ejari for ' || (SELECT k.case_number FROM cases k WHERE k.id = k_r))
  RETURNING id INTO m_ask;
  doc := pg_temp.dw_doc(a_acct, c_own, cv_own, NULL, m_ask);
  n := n + 1; failed := failed || pg_temp.dw_ok(pg_temp.dw_route(a_acct, doc, w_sales) = 'filed|-|' || k_r,
    'a reply to our message naming a case did not file to it');
  -- E1 and E2 disagree.
  doc := pg_temp.dw_doc(a_acct, c_own, cv_own, code_e, m_ask);
  v := pg_temp.dw_route(a_acct, doc, w_sales);
  SELECT t.id INTO t_conf FROM desk_tray t WHERE t.customer_document_id = doc;
  n := n + 1; failed := failed || pg_temp.dw_ok(v LIKE 'tray|evidence_conflict|-'
    AND (SELECT count(*) FROM desk_tray t, jsonb_array_elements(t.candidates) e
          WHERE t.id = t_conf AND (e->'why') ?| ARRAY['quoted', 'code']) = 2,
    format('a quoted case and a different caption code did not go to the tray as a conflict (%s)', v));

  -- ---------- 4. another person, several companies, strangers, staff ----------
  doc := pg_temp.dw_doc(a_acct, c_pro, cv_pro, (SELECT k.case_number FROM cases k WHERE k.id = k_r), NULL);
  v := pg_temp.dw_route(a_acct, doc, w_sales);
  SELECT t.id INTO t_pro FROM desk_tray t WHERE t.customer_document_id = doc;
  n := n + 1; failed := failed || pg_temp.dw_ok(v LIKE 'tray|other_person|-',
    format('a PRO''s document filed itself onto the owner''s case (%s)', v));
  SELECT x.case_id, x.customer_id INTO k_m, cu_maro
    FROM desk_case_open(a_acct, 'DW-2', 'Maro Trading', 'ENBD', 'Business account', c_maro, u_agent, NULL, now()) x;
  PERFORM desk_customer_contact_set(u_owner, a_acct, cu_maro, c_pro, 'pro', true);
  doc := pg_temp.dw_doc(a_acct, c_pro, cv_pro, NULL, NULL);
  n := n + 1; failed := failed || pg_temp.dw_ok(pg_temp.dw_route(a_acct, doc, w_sales) LIKE 'tray|many_companies|-',
    'a phone acting for two companies was routed without evidence');
  doc := pg_temp.dw_doc(a_acct, c_str, cv_str, NULL, NULL);
  n := n + 1; failed := failed || pg_temp.dw_ok(pg_temp.dw_route(a_acct, doc, w_sales) = 'ignored|-|-',
    'an unknown sender on a sales number was taken by the desk');
  v := pg_temp.dw_route(a_acct, doc, w_desk);
  SELECT t.id INTO t_unk FROM desk_tray t WHERE t.customer_document_id = doc;
  n := n + 1; failed := failed || pg_temp.dw_ok(v LIKE 'tray|unknown_sender|-'
    AND (SELECT t.duty_user_id FROM desk_tray t WHERE t.id = t_unk) = u_crak,
    format('an unknown sender on a desk number did not reach the tray with the duty owner (%s)', v));
  doc := pg_temp.dw_doc(a_acct, c_stf, cv_stf, 'NEW RAK Some Co 12345', NULL);
  SELECT x.action || '|' || coalesce(x.staff_user_id::text, '-') INTO v
    FROM desk_route_customer_document(a_acct, doc, w_sales, now()) x;
  n := n + 1; failed := failed || pg_temp.dw_ok(v = 'staff|' || u_staff,
    format('a staff member''s phone was not handed to the staff upload (%s)', v));

  -- ---------- 5. the tray ----------
  n := n + 1; failed := failed || pg_temp.dw_check('the RAK holder saw an item with no RAK candidate', NULL,
    format('SELECT count(*)::text FROM desk_tray_list(%L, %L) x WHERE x.tray_id = %L', u_crak, a_acct, t_unk), '0');
  n := n + 1; failed := failed || pg_temp.dw_check('the RAK holder did not see an item with a RAK candidate', NULL,
    format('SELECT count(*)::text FROM desk_tray_list(%L, %L) x WHERE x.tray_id = %L', u_crak, a_acct, t_many), '1');
  n := n + 1; failed := failed || pg_temp.dw_check('an agent with no bank saw the tray', NULL,
    format('SELECT count(*)::text FROM desk_tray_list(%L, %L) x', u_agent, a_acct), '0');
  n := n + 1; failed := failed || pg_temp.dw_check('a team leader did not see every open item', NULL,
    format('SELECT (count(*) >= 5)::text FROM desk_tray_list(%L, %L) x', u_lead, a_acct), 'true');
  n := n + 1; failed := failed || pg_temp.dw_check('the RAK holder filed to the ENBD case', NULL,
    format('SELECT x.outcome FROM desk_tray_file(%L, %L, %L, %L, NULL) x', u_crak, a_acct, t_many, k_e),
    'ERROR % BANK_SCOPE:%');
  n := n + 1; failed := failed || pg_temp.dw_check('the RAK holder could not file the sender''s own document', NULL,
    format('SELECT x.outcome FROM desk_tray_file(%L, %L, %L, %L, NULL) x', u_crak, a_acct, t_many, k_r), 'filed');
  n := n + 1; failed := failed || pg_temp.dw_ok(EXISTS (SELECT 1 FROM case_document_files f JOIN desk_tray t
      ON t.customer_document_id = f.customer_document_id
    WHERE t.id = t_many AND f.case_id = k_r AND f.registered_by = u_crak)
    AND (SELECT t.state FROM desk_tray t WHERE t.id = t_many) = 'filed',
    'the filed tray item is not on the case in the sorter''s name');
  n := n + 1; failed := failed || pg_temp.dw_check('a sorted item was filed again', NULL,
    format('SELECT x.outcome FROM desk_tray_file(%L, %L, %L, %L, NULL) x', u_lead, a_acct, t_many, k_r),
    'ERROR % TRAY_NOT_OPEN:%');
  n := n + 1; failed := failed || pg_temp.dw_check('a stranger''s document was filed without typing the company', NULL,
    format('SELECT x.outcome FROM desk_tray_file(%L, %L, %L, %L, ''Kite'') x', u_lead, a_acct, t_unk, k_r),
    'ERROR % CONFIRM_COMPANY:%');
  n := n + 1; failed := failed || pg_temp.dw_check('the typed company name was not accepted', NULL,
    format('SELECT x.outcome FROM desk_tray_file(%L, %L, %L, %L, ''  kite general  trading '') x', u_lead, a_acct, t_unk, k_r),
    'needs_copy');
  n := n + 1; failed := failed || pg_temp.dw_check('a PRO''s document did not need the intake copy', NULL,
    format('SELECT x.outcome FROM desk_tray_file(%L, %L, %L, %L, NULL) x', u_lead, a_acct, t_pro, k_r), 'needs_copy');
  n := n + 1; failed := failed || pg_temp.dw_check('a tray item resolved without a filed upload', NULL,
    format('SELECT desk_tray_resolve(%L, %L, %L, %L, %L)::text', u_lead, a_acct, t_pro, k_r, gen_random_uuid()),
    'ERROR % ITEM_NOT_FOUND:%');
  SELECT x.* INTO r FROM desk_whatsapp_intake(u_lead, a_acct, item, 'dw-0000001', 'pending_doc', NULL,
    (SELECT k.case_number FROM cases k WHERE k.id = k_r), NULL, NULL, NULL, NULL, NULL,
    'intake/' || item || '/' || repeat('c', 64) || '.pdf', 'doc.pdf', 'application/pdf', 1000, repeat('c', 64), now()) x;
  n := n + 1; failed := failed || pg_temp.dw_ok(r.state = 'filed' AND r.case_id = k_r
    AND (SELECT i.channel FROM intake_items i WHERE i.id = item) = 'whatsapp',
    format('the WhatsApp intake did not file to the case as channel whatsapp (%s)', r.state));
  PERFORM desk_tray_resolve(u_lead, a_acct, t_pro, k_r, item);
  n := n + 1; failed := failed || pg_temp.dw_ok((SELECT t.state = 'filed' AND t.resolved_item_id = item
    FROM desk_tray t WHERE t.id = t_pro), 'the PRO''s tray item was not resolved by its intake upload');
  n := n + 1; failed := failed || pg_temp.dw_check('a dismissal without a reason was accepted', NULL,
    format('SELECT desk_tray_dismiss(%L, %L, %L, '' x '')::text', u_lead, a_acct, t_conf), 'ERROR % REASON_REQUIRED:%');
  n := n + 1; failed := failed || pg_temp.dw_check('a dismissal with a reason was refused', NULL,
    format('SELECT desk_tray_dismiss(%L, %L, %L, ''a selfie, not a document'')::text', u_lead, a_acct, t_conf), '');
  n := n + 1; failed := failed || pg_temp.dw_ok((SELECT t.state FROM desk_tray t WHERE t.id = t_conf) = 'dismissed',
    'the dismissal did not close the item');

  -- ---------- 6. escalation ----------
  UPDATE desk_tray t SET received_at = now() - interval '3 hours' WHERE t.id = t_unk;
  SELECT x.* INTO r FROM desk_tray_due_escalation(now()) x WHERE x.tray_id = t_unk;
  n := n + 1; failed := failed || pg_temp.dw_ok(r.assignee = u_crak AND r.age_minutes >= 179,
    'an item open past the delay was not due to its duty owner');
  n := n + 1; failed := failed || pg_temp.dw_ok(NOT EXISTS (SELECT 1 FROM desk_tray_due_escalation(now()) x
    JOIN desk_tray t ON t.id = x.tray_id WHERE t.received_at > now() - interval '1 hour'),
    'an item younger than the delay was due');
  -- Each write in its own statement, its effect read in the next.
  n := n + 1; failed := failed || pg_temp.dw_ok(desk_tray_mark_escalated(t_unk, now()),
    'marking a due item escalated reported nothing');
  n := n + 1; failed := failed || pg_temp.dw_ok(NOT desk_tray_mark_escalated(t_unk, now()),
    'an item was marked escalated twice');
  n := n + 1; failed := failed || pg_temp.dw_ok(
    NOT EXISTS (SELECT 1 FROM desk_tray_due_escalation(now()) x WHERE x.tray_id = t_unk),
    'an escalated item was still due');

  -- ---------- 7. privacy ----------
  j := privacy_subject_export(u_owner, a_acct, c_pro);
  n := n + 1; failed := failed || pg_temp.dw_ok(jsonb_array_length(j->'data'->'desk_tray') >= 1,
    'the export did not carry the sender''s tray items');
  j := privacy_subject_erase(u_owner, a_acct, c_str, false, 'ERASE ' || c_str::text);
  n := n + 1; failed := failed || pg_temp.dw_ok((j->'counts'->>'desk_tray')::int >= 1
    AND NOT EXISTS (SELECT 1 FROM desk_tray t WHERE t.contact_id = c_str),
    'an erasure left the sender''s tray items');

  -- ---------- 8. closed to API roles ----------
  n := n + 1; failed := failed || pg_temp.dw_check('authenticated read desk_tray', 'authenticated',
    'SELECT count(*)::text FROM public.desk_tray', 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.dw_check('service_role read desk_tray directly', 'service_role',
    'SELECT count(*)::text FROM public.desk_tray', 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.dw_check('service_role read desk_settings directly', 'service_role',
    'SELECT count(*)::text FROM public.desk_settings', 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.dw_check('authenticated called the router', 'authenticated',
    format('SELECT x.action FROM desk_route_customer_document(%L, %L, NULL) x', a_acct, doc), 'ERROR 42501%');

  RAISE EXCEPTION USING ERRCODE = 'ZT230', MESSAGE = 'verify-desk-whatsapp-routing rollback';
  EXCEPTION WHEN SQLSTATE 'ZT230' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'desk WhatsApp routing verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'desk WhatsApp routing verification passed (% checks)', n;
END
$verify$;
