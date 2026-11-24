-- Migration 303: the case desk and case cron fixes. Everything is rolled
-- back; run as a superuser. A failed check raises.
BEGIN;
DO $verify$
DECLARE
  u_owner uuid := '00000000-0000-4000-8000-000000303001';
  u_lead  uuid := '00000000-0000-4000-8000-000000303002';  -- leads no team
  u_agent uuid := '00000000-0000-4000-8000-000000303003';
  u_staff uuid := '00000000-0000-4000-8000-000000303004';
  acct uuid; ch uuid; c_own uuid; c_pro uuid; c_stf uuid; c_str uuid;
  k uuid; k2 uuid; cust uuid; d uuid; m uuid; t uuid; t2 uuid; r1 uuid; r2 uuid;
  j jsonb; h text; v text; at0 timestamptz;
  ids uuid[];
BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.dkf_doc(p_acct uuid, p_contact uuid, OUT doc uuid, OUT msg uuid)
    LANGUAGE plpgsql AS $b$
    DECLARE cv uuid; u text := 'https://x.invalid/dkf-' || gen_random_uuid() || '.pdf';
    BEGIN
      SELECT id INTO cv FROM conversations WHERE contact_id = p_contact LIMIT 1;
      IF cv IS NULL THEN
        INSERT INTO conversations (account_id, user_id, contact_id)
        SELECT p_acct, user_id, id FROM contacts WHERE id = p_contact RETURNING id INTO cv;
      END IF;
      INSERT INTO messages (conversation_id, sender_type, content_type, media_url)
      VALUES (cv, 'customer', 'document', u) RETURNING id INTO msg;
      PERFORM customer_documents_record(p_acct, p_contact, 'chat', 'document', u, now(), cv, msg, NULL,
                                        'application/pdf', 'dkf.pdf', NULL);
      SELECT id INTO doc FROM customer_documents WHERE message_id = msg;
    END $b$ $fn$;
  INSERT INTO auth.users (id, email) VALUES (u_owner, 'dkf-owner@example.invalid'), (u_lead, 'dkf-lead@example.invalid'),
    (u_agent, 'dkf-agent@example.invalid'), (u_staff, 'dkf-staff@example.invalid');
  SELECT account_id INTO acct FROM profiles WHERE user_id = u_owner;
  UPDATE profiles SET account_id = acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = acct, account_role = 'agent' WHERE user_id IN (u_agent, u_staff);
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, acct, 'whapi', 'dkf-1', 'x', 'connected', true) RETURNING id INTO ch;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (acct, u_agent, '971503030001', 'dkf own') RETURNING id INTO c_own;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (acct, u_agent, '971503030002', 'dkf pro') RETURNING id INTO c_pro;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (acct, u_agent, '971503030003', 'dkf staff') RETURNING id INTO c_stf;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (acct, u_agent, '971503030004', 'dkf str') RETURNING id INTO c_str;
  INSERT INTO coordinator_phones (account_id, user_id, phone) VALUES (acct, u_staff, '971503030003');
  INSERT INTO case_banks (account_id, code, name) VALUES (acct, 'RAK', 'RAK'), (acct, 'ENBD', 'ENBD') ON CONFLICT DO NOTHING;
  PERFORM desk_bank_code_set(u_owner, acct, 'RAK', 'RAK');
  PERFORM desk_bank_code_set(u_owner, acct, 'ENBD', 'ENB');
  SELECT x.case_id INTO k FROM desk_case_open(acct, 'DKF-1', 'Dkf Trading', 'RAK', 'Business account', c_own, u_agent, NULL, now()) x;
  SELECT x.case_id INTO k2 FROM desk_case_open(acct, 'DKF-1', NULL, 'ENBD', 'Business account', c_own, u_agent, NULL, now()) x;
  SELECT desk_customer_id INTO cust FROM cases WHERE id = k;
  PERFORM desk_customer_contact_set(u_owner, acct, cust, c_pro, 'pro', true);
  PERFORM desk_settings_set(u_owner, acct, true, '{}', 120);

  -- 2. A failure becomes one row, only for the desk's own documents.
  SELECT x.doc, x.msg INTO d, m FROM pg_temp.dkf_doc(acct, c_stf) x;
  ASSERT desk_tray_copy_failed(acct, m, ch) = 'tray', desk_tray_copy_failed(acct, m, ch) || coalesce(desk_staff_for_contact(acct, c_stf)::text, ' nostaff') || coalesce(d::text, ' nodoc');
  ASSERT desk_tray_copy_failed(acct, m, ch) = 'tray'
    AND (SELECT count(*) FROM desk_tray x WHERE x.customer_document_id = d AND x.reason = 'copy_failed'
          AND x.contact_id = c_stf AND x.conversation_id IS NOT NULL) = 1, 'staff copy_failed row';
  SELECT x.doc, x.msg INTO d, m FROM pg_temp.dkf_doc(acct, c_str) x;
  ASSERT desk_tray_copy_failed(acct, m, ch) = 'ignored', 'a sales chat is not the desk''s';
  ASSERT desk_tray_copy_failed(acct, gen_random_uuid(), ch) = 'missing', 'missing';
  SELECT x.doc, x.msg INTO d, m FROM pg_temp.dkf_doc(acct, c_own) x;
  INSERT INTO case_document_files (account_id, case_id, customer_document_id) VALUES (acct, k, d);
  ASSERT desk_tray_copy_failed(acct, m, ch) = 'done', 'a filed document is not doubled';
  SELECT x.doc, x.msg INTO d, m FROM pg_temp.dkf_doc(acct, c_stf) x;
  PERFORM * FROM desk_whatsapp_intake(u_staff, acct, d, 'wa:' || d, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    'intake/' || d || '/' || repeat('a', 64) || '.pdf', 'a.pdf', 'application/pdf', 10, repeat('a', 64), now());
  ASSERT desk_tray_copy_failed(acct, m, ch) = 'done', 'a copied document is not doubled';
  SELECT x.doc, x.msg INTO d, m FROM pg_temp.dkf_doc(acct, c_pro) x;
  ASSERT desk_tray_copy_failed(acct, m, ch) = 'tray', 'a linked sender''s';
  SELECT id INTO t FROM desk_tray WHERE customer_document_id = d;
  ASSERT (SELECT jsonb_array_length(candidates) FROM desk_tray WHERE id = t) = 2, 'with its candidates';

  -- 1. Filing needs the case, as the queue's.
  BEGIN
    PERFORM * FROM desk_tray_file(u_lead, acct, t, k, NULL);
    ASSERT false, 'a lead filed into a case they cannot write';
  EXCEPTION WHEN no_data_found OR insufficient_privilege OR check_violation THEN
    GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
    ASSERT h = 'CASE_NOT_FOUND', 'file hint ' || h;
  END;
  BEGIN
    PERFORM desk_tray_resolve(u_lead, acct, t, k, gen_random_uuid());
    ASSERT false, 'resolved';
  EXCEPTION WHEN no_data_found OR insufficient_privilege OR check_violation THEN
    GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
    ASSERT h = 'CASE_NOT_FOUND', 'resolve hint ' || h;
  END;

  -- 3. The page: first items and the total.
  j := desk_tray_page(u_owner, acct, 'open', 1);
  ASSERT (j->>'total')::int = 2 AND jsonb_array_length(j->'items') = 1
    AND j->'items'->0 ? 'conversation_id', 'page ' || j::text;

  -- 4. A copy waiting in the queue says so; a filed one resolves there.
  INSERT INTO intake_items (id, account_id, uploaded_by, idem_key, channel, received_at, storage_path, original_name,
                            mime, size_bytes, sha256)
  VALUES (t, acct, u_owner, 'tray:' || t, 'whatsapp', now(), 'intake/' || t || '/' || repeat('b', 64) || '.pdf',
          'b.pdf', 'application/pdf', 10, repeat('b', 64));
  SELECT x.outcome INTO v FROM desk_tray_file(u_owner, acct, t, k, NULL) x;
  ASSERT v = 'waiting', 'untagged copy: ' || v;
  PERFORM * FROM intake_file(u_owner, acct, t, k2, 'pending_doc', NULL, now());
  SELECT x.outcome || ' ' || x.case_number INTO v FROM desk_tray_file(u_owner, acct, t, k, NULL) x;
  ASSERT v = 'filed ' || (SELECT case_number FROM cases WHERE id = k2), 'half-done copy: ' || v;
  ASSERT (SELECT state = 'filed' AND resolved_case_id = k2 AND resolved_item_id = t FROM desk_tray WHERE id = t), 'resolved there';

  -- 5. A file is activity.
  SELECT x.doc INTO d FROM pg_temp.dkf_doc(acct, c_own) x;
  INSERT INTO case_document_files (account_id, case_id, customer_document_id, registered_at)
  VALUES (acct, k, d, now() + interval '3 days');
  ASSERT case_rule_last_activity(k) = now() + interval '3 days', 'a file is activity';

  -- 6. One failing rule: the other runs, its own claim stays free.
  INSERT INTO case_rules (account_id, name, trigger, conditions, actions, created_by, enabled)
  VALUES (acct, 'dkf bad', 'no_activity', '{"days":1}', '[{"kind":"add_note","body":"dkf bad"}]', u_owner, true)
  RETURNING rule_id INTO r1;
  INSERT INTO case_rules (account_id, name, trigger, conditions, actions, created_by, enabled)
  VALUES (acct, 'dkf good', 'no_activity', '{"days":1}', '[{"kind":"add_note","body":"dkf good"}]', u_owner, true)
  RETURNING rule_id INTO r2;
  EXECUTE format($f$CREATE FUNCTION pg_temp.dkf_fail() RETURNS trigger LANGUAGE plpgsql AS $b$
    BEGIN IF NEW.rule_id = %L THEN RAISE EXCEPTION 'dkf'; END IF; RETURN NEW; END $b$ $f$, r1);
  CREATE TRIGGER dkf_fail BEFORE INSERT ON case_rule_runs FOR EACH ROW EXECUTE FUNCTION pg_temp.dkf_fail();
  PERFORM case_rules_sweep(now() + interval '30 days');
  ASSERT EXISTS (SELECT 1 FROM case_rule_runs WHERE rule_id = r2 AND case_id = k AND matched), 'the good rule ran';
  ASSERT NOT EXISTS (SELECT 1 FROM case_rule_runs WHERE rule_id = r1), 'the bad rule''s claim is free';
  DROP TRIGGER dkf_fail ON case_rule_runs;
  PERFORM case_rules_sweep(now() + interval '30 days');
  ASSERT EXISTS (SELECT 1 FROM case_rule_runs WHERE rule_id = r1 AND case_id = k), 'and is tried again';

  -- 7. The sweep takes turns.
  SET LOCAL session_replication_role = replica;
  UPDATE cases SET group_id = gen_random_uuid(), stage = 'Withdrawn', outcome = 'Withdrawn', closed_at = now() - interval '9 days' WHERE id = k;
  UPDATE cases SET group_id = gen_random_uuid(), stage = 'Withdrawn', outcome = 'Withdrawn', closed_at = now() - interval '1 day' WHERE id = k2;
  SELECT array_agg(x.case_id ORDER BY x.n) INTO ids FROM (SELECT y.case_id, row_number() OVER () n FROM case_pending_group_end('15 minutes', 1000) y) x WHERE x.case_id IN (k, k2);
  ASSERT ids = ARRAY[k, k2], 'oldest first';
  PERFORM case_release_group_end(k, (SELECT x.claim_token FROM case_claim_group_end_system(k) x));
  ASSERT (SELECT group_end_tried_at = now() FROM cases WHERE id = k), 'stamped';
  SELECT array_agg(x.case_id) INTO ids FROM case_pending_group_end('15 minutes', 1000) x WHERE x.case_id IN (k, k2);
  ASSERT ids = ARRAY[k2], 'backs off';
  UPDATE cases SET group_end_tried_at = now() - interval '31 minutes' WHERE id = k;
  SELECT array_agg(x.case_id ORDER BY x.n) INTO ids FROM (SELECT y.case_id, row_number() OVER () n FROM case_pending_group_end('15 minutes', 1000) y) x WHERE x.case_id IN (k, k2);
  ASSERT ids = ARRAY[k2, k], 'never tried first';
  RAISE NOTICE 'desk fixes verification passed';
END
$verify$;
ROLLBACK;
