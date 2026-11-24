-- Migration 316, the rest of the case desk findings: document tasks reach
-- someone who is here, settings cards cannot overwrite a newer row, the
-- checklist agrees with File ready, documents on one position build, a
-- failed read does not use up the digest gap, unlinking asks what linking
-- asks, a copy that never answers fails and is counted.
--
-- ONE statement; fixtures are rolled back by a sentinel.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000316001';
  u_agent  UUID := '00000000-0000-4000-8000-000000316002';
  u_agent2 UUID := '00000000-0000-4000-8000-000000316003';
  u_crak   UUID := '00000000-0000-4000-8000-000000316004';
  u_cenb   UUID := '00000000-0000-4000-8000-000000316005';
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
  t10      TIMESTAMPTZ := ((now() AT TIME ZONE 'Asia/Dubai')::date + time '11:00') AT TIME ZONE 'Asia/Dubai';
  c_hid    UUID;
  rid      UUID;
  mrg      BOOLEAN;
  txt      TEXT;
  cnt      INT;
  mine     INT;
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
    DECLARE m uuid; u text := 'https://x.invalid/dkr-' || gen_random_uuid() || '.pdf'; d uuid;
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
    (u_owner, 'dkr-owner@example.invalid'), (u_agent, 'dkr-agent@example.invalid'),
    (u_agent2, 'dkr-agent2@example.invalid'), (u_crak, 'dkr-crak@example.invalid'),
    (u_cenb, 'dkr-cenb@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agent, u_agent2, u_crak, u_cenb);
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500316001', 'DKR kite')
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
    FROM desk_case_open(a_acct, 'DKR-1', 'Kite General Trading', 'RAK', 'Business account', c_own, u_agent, NULL, now()) x;
  SELECT x.case_id INTO k_e
    FROM desk_case_open(a_acct, 'DKR-1', NULL, 'ENBD', 'Business account', c_own, u_agent, NULL, now()) x;
  d1 := pg_temp.av_doc(a_acct, c_own, cv_own);
  f_r1 := case_document_file_register(NULL, k_r, d1);
  f_e1 := case_document_file_register(NULL, k_e, d1);
  PERFORM pg_temp.av_pass(f_r1, 'trade_licence', 1, today + 10);
  PERFORM pg_temp.av_pass(f_e1, 'trade_licence', 1, today + 10);

  -- ---------- 3. the cell is File ready's answer ----------
  UPDATE case_file_specs SET required = false WHERE account_id = a_acct AND bank_code = 'RAK' AND doc_key = 'moa';
  j := desk_case_doc_cell(k_r, 'trade_licence');
  n := n + 1; failed := failed || pg_temp.av_ok(j->>'status' = 'passed' AND case_file_ready(k_r), '3: a passed file does not read passed');
  d2 := pg_temp.av_doc(a_acct, c_own, cv_own);
  BEGIN
  f_r2 := case_document_file_register(NULL, k_r, d2);
  UPDATE case_document_files SET status = 'failed', doc_key = 'trade_licence', version = 2,
         renamed_name = 'trade_licence.pdf', classified_at = now() WHERE id = f_r2;
  n := n + 1; failed := failed || pg_temp.av_ok(NOT case_file_ready(k_r) AND desk_case_doc_cell(k_r, 'trade_licence')->>'status' = 'failed',
    format('3: a newer failed version reads %s while the case is not ready', desk_case_doc_cell(k_r, 'trade_licence')->>'status'));
  n := n + 1; failed := failed || pg_temp.av_ok(EXISTS (SELECT 1 FROM desk_digest_pending(a_acct, cu_kite) p
    WHERE p.doc_key = 'trade_licence' AND p.banks = ARRAY['RAK']), '3: the digest does not ask for the failed document');
  RAISE EXCEPTION USING ERRCODE = 'ZD316', MESSAGE = 'undo';
  EXCEPTION WHEN SQLSTATE 'ZD316' THEN NULL;
  END;

  -- ---------- 4. documents sharing a position build ----------
  INSERT INTO case_file_specs (account_id, bank_code, product, doc_key, position, name_pattern, required) VALUES
    (a_acct, 'RAK', 'Business account', 'partner_passport', 5, '{{doc}}', true),
    (a_acct, 'RAK', 'Business account', 'partner2_passport', 5, '{{doc}}', true);
  f_r2 := case_document_file_register(NULL, k_r, pg_temp.av_doc(a_acct, c_own, cv_own));
  PERFORM pg_temp.av_pass(f_r2, 'partner_passport', 1, NULL);
  f_r2 := case_document_file_register(NULL, k_r, pg_temp.av_doc(a_acct, c_own, cv_own));
  PERFORM pg_temp.av_pass(f_r2, 'partner2_passport', 1, NULL);
  UPDATE case_document_files SET pages = 1 WHERE case_id = k_r;
  UPDATE cases SET coordinator_id = u_crak WHERE id = k_r;
  SELECT x.reservation_id INTO rid FROM case_file_build_reserve(u_crak, k_r, now()) x;
  -- The builder's order: position, then doc_key by code point.
  SELECT jsonb_agg(jsonb_build_object('position', s.position, 'doc_key', f.doc_key, 'file_id', f.id,
           'renamed_name', f.renamed_name, 'pages', f.pages, 'sha256', repeat('b', 64))
           ORDER BY s.position, f.doc_key COLLATE "C"), bool_or(s.merged) INTO j, mrg
    FROM case_file_spec_rows(k_r) s
    JOIN case_document_files f ON f.case_id = k_r AND f.doc_key = s.doc_key AND f.status = 'passed'
   WHERE s.required;
  SELECT coalesce(bool_or(s.merged), false) INTO mrg FROM case_file_spec_rows(k_r) s;
  txt := pg_temp.av_try(format('SELECT version::text FROM case_file_build_record(%L, %L, %L, %L, %L, %L, %L, now())',
    u_crak, k_r, rid, j, mrg, 'cases/' || k_r || (CASE WHEN mrg THEN '/bundle-' ELSE '/index-' END) || repeat('a', 64) || '.pdf', repeat('a', 64)));
  n := n + 1; failed := failed || pg_temp.av_ok(jsonb_array_length(j) = 3 AND txt = '1', format('4: documents on one position do not build (%s)', txt));

  -- ---------- 2. settings saved against what the card showed ----------
  txt := pg_temp.av_try(format('SELECT desk_settings_set(%L, %L, true, %L, 60, NULL::timestamptz, now())', u_owner, a_acct, '{}'));
  n := n + 1; failed := failed || pg_temp.av_ok(txt NOT LIKE 'ERROR%', '2: the first routing save was refused: ' || txt);
  txt := pg_temp.av_try(format('SELECT desk_settings_set(%L, %L, false, %L, 60, NULL::timestamptz, now())', u_owner, a_acct, '{}'));
  n := n + 1; failed := failed || pg_temp.av_ok(txt LIKE 'ERROR % SETTINGS_CHANGED:%', '2: a routing card shown nothing overwrote a stored row: ' || txt);
  txt := pg_temp.av_try(format('SELECT desk_settings_set(%L, %L, false, %L, 60, %L::timestamptz, now())', u_owner, a_acct, '{}',
    (SELECT s.updated_at FROM desk_settings_get(u_owner, a_acct) s)));
  n := n + 1; failed := failed || pg_temp.av_ok(txt NOT LIKE 'ERROR%'
    AND NOT (SELECT s.routing_enabled FROM desk_settings_get(u_owner, a_acct) s), '2: a current routing save was refused: ' || txt);
  txt := pg_temp.av_try(format('SELECT desk_settings_set(%L, %L, true, %L, 60, NULL::timestamptz, now())', u_agent, a_acct, '{}'));
  n := n + 1; failed := failed || pg_temp.av_ok(txt LIKE 'ERROR % NOT_ALLOWED:%', '2: an agent was told the version: ' || txt);
  -- The old build's call (230's argument names) still finds one function.
  txt := pg_temp.av_try(format('SELECT desk_settings_set(p_actor => %L, p_account => %L, p_routing_enabled => true, '
    || 'p_desk_channel_ids => %L, p_escalate_minutes => 60, p_now => now())', u_owner, a_acct, '{}'));
  n := n + 1; failed := failed || pg_temp.av_ok(txt NOT LIKE 'ERROR%', '2: the old build''s routing call fails: ' || txt);
  txt := pg_temp.av_try(format('SELECT desk_digest_settings_set(%L, %L, false, NULL, %L, 10, 2, NULL::timestamptz, now())', u_owner, a_acct, 'en'));
  n := n + 1; failed := failed || pg_temp.av_ok(txt NOT LIKE 'ERROR%', '2: the first digest save was refused: ' || txt);
  txt := pg_temp.av_try(format('SELECT desk_digest_settings_set(%L, %L, false, NULL, %L, 11, 2, %L::timestamptz, now())', u_owner, a_acct, 'en',
    now() - interval '1 hour'));
  n := n + 1; failed := failed || pg_temp.av_ok(txt LIKE 'ERROR % SETTINGS_CHANGED:%', '2: a stale digest card overwrote the row: ' || txt);
  txt := pg_temp.av_try(format('SELECT desk_digest_settings_set(%L, %L, false, NULL, %L, 11, 2, %L::timestamptz, now())', u_owner, a_acct, 'en',
    (SELECT s.updated_at FROM desk_digest_settings_read(u_owner, a_acct) s)));
  n := n + 1; failed := failed || pg_temp.av_ok(txt NOT LIKE 'ERROR%'
    AND (SELECT s.send_hour FROM desk_digest_settings_read(u_owner, a_acct) s) = 11, '2: a current digest save was refused: ' || txt);

  -- ---------- 5. a read of ours that failed does not use up the gap ----------
  INSERT INTO message_templates (account_id, user_id, name, category, language, body_text, status) VALUES
    (a_acct, u_owner, 'dkr_digest', 'Utility', 'en', 'Application {{1}}: still needed: {{2}}.', 'APPROVED');
  PERFORM desk_digest_settings_set(u_owner, a_acct, true, 'dkr_digest', 'en', 10, 3);
  UPDATE customer_documents SET received_at = t10 - interval '30 days' WHERE account_id = a_acct;
  PERFORM desk_digest_enqueue(t10);
  n := n + 1; failed := failed || pg_temp.av_ok((SELECT count(*) FROM desk_digest_outbox o WHERE o.customer_id = cu_kite) = 1, '5: no digest was queued');
  UPDATE desk_digest_outbox SET status = 'failed', status_reason = 'invalid_number' WHERE customer_id = cu_kite;
  PERFORM desk_digest_enqueue(t10 + interval '1 day');
  n := n + 1; failed := failed || pg_temp.av_ok((SELECT count(*) FROM desk_digest_outbox o WHERE o.customer_id = cu_kite) = 1, '5: a bad number was asked again inside the gap');
  UPDATE desk_digest_outbox SET status_reason = 'read_failed' WHERE customer_id = cu_kite;
  PERFORM desk_digest_enqueue(t10 + interval '1 day');
  n := n + 1; failed := failed || pg_temp.av_ok((SELECT count(*) FROM desk_digest_outbox o WHERE o.customer_id = cu_kite) = 2, '5: a failed read used up the gap');

  -- ---------- 6. unlinking asks what linking asks ----------
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500316009', 'DKR hidden') RETURNING id INTO c_hid;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id) VALUES (a_acct, u_owner, c_hid, u_owner);
  INSERT INTO desk_customer_contacts (account_id, customer_id, contact_id, role, authorised, added_by, updated_by)
    VALUES (a_acct, cu_kite, c_hid, 'owner', true, u_owner, u_owner);
  n := n + 1; failed := failed || pg_temp.av_ok(NOT memory_can_read(u_agent, a_acct, 'contact', c_hid), '6: fixture: the agent sees the contact');
  txt := pg_temp.av_try(format('SELECT desk_customer_contact_remove(%L, %L, %L, %L)::text', u_agent, a_acct, cu_kite, c_hid));
  n := n + 1; failed := failed || pg_temp.av_ok(txt LIKE 'ERROR % CONTACT_INVALID:%', '6: a contact the actor cannot see was unlinked: ' || txt);
  txt := pg_temp.av_try(format('SELECT desk_customer_contact_remove(%L, %L, %L, %L)::text', u_owner, a_acct, cu_kite, c_hid));
  n := n + 1; failed := failed || pg_temp.av_ok(txt = 'true', '6: the owner could not unlink: ' || txt);

  -- ---------- 7. a copy that never answers fails ----------
  UPDATE customer_documents SET status = 'pending', attempts = 10, claimed_at = clock_timestamp() - interval '5 minutes',
         next_attempt_at = now() - interval '1 hour' WHERE id = d2;
  PERFORM customer_documents_claim(50);
  n := n + 1; failed := failed || pg_temp.av_ok((SELECT d.status FROM customer_documents d WHERE d.id = d2) = 'pending', '7: a copy still held by its claim was failed');
  cnt := (customer_documents_stats()->>'failed')::int;
  UPDATE customer_documents SET claimed_at = clock_timestamp() - interval '20 minutes' WHERE id = d2;
  -- Apart: a statement does not see what a function it calls changed.
  SELECT count(*) INTO mine FROM customer_documents_claim(50) x WHERE x.id = d2;
  n := n + 1; failed := failed || pg_temp.av_ok(mine = 0
    AND (SELECT d.status = 'failed' AND d.claimed_at IS NULL AND d.last_error IS NOT NULL FROM customer_documents d WHERE d.id = d2),
    '7: a copy claimed 10 times is claimed again');
  n := n + 1; failed := failed || pg_temp.av_ok((customer_documents_stats()->>'failed')::int = cnt + 1
    AND customer_documents_stats() ? 'oldest_pending_age_seconds', '7: the counts do not show the failed copy');

  -- ---------- 1. a task for somebody who is here ----------
  UPDATE case_document_files SET expires_on = today + 5 WHERE id = f_e1;
  n := n + 1; failed := failed || pg_temp.av_ok((SELECT x.assignee FROM desk_doc_tasks_due(now()) x WHERE x.file_id = f_e1) = u_agent, '1: a live agent lost the task');
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_agent;
  UPDATE cases SET agent_id = u_agent, coordinator_id = NULL WHERE id = k_e;
  n := n + 1; failed := failed || pg_temp.av_ok((SELECT x.assignee FROM desk_doc_tasks_due(now()) x WHERE x.file_id = f_e1) = u_owner,
    '1: the task of an agent who left is for nobody who can have it');

  RAISE EXCEPTION USING ERRCODE = 'ZT316', MESSAGE = 'verify-desk-rest rollback';
  EXCEPTION WHEN SQLSTATE 'ZT316' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'desk rest verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'desk rest verification passed (% checks)', n;
END
$verify$;
