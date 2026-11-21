-- Behavioural regression suite for the PDPL work (migrations 221-223).
--
-- 221: privacy_subject_export is owners and admins only, confined to the
-- account, strips staff ids and storage locations, and logs one
-- privacy_requests row with a hash, never the contact id.
--
-- 222: erase is owners and admins only; a dry run changes nothing and
-- counts exactly; executing needs 'ERASE <id>'; a legal hold blocks it;
-- messages, notes and tasks go, the contact is anonymised with its
-- opt-out kept, and a bank case (KYC) stays.
--
-- 223: only owners and admins set a retention policy, and only
-- allow-listed keys, 30+ days and an allowed action; the sweep is a dry
-- run until applied, deletes only what is old enough, and skips a
-- customer under a legal hold.
--
-- 224: the AI transfer basis is owners and admins only; each check is
-- logged with no text; a call is refused only while the basis is
-- required and incomplete.
--
-- ONE statement on purpose: `supabase db query --file` sends the file as
-- a single prepared statement and rejects several. Fixtures are rolled
-- back by a sentinel exception; failures are named in the final one.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000221001';
  u_admin  UUID := '00000000-0000-4000-8000-000000221002';
  u_agent  UUID := '00000000-0000-4000-8000-000000221003';
  u_bown   UUID := '00000000-0000-4000-8000-000000221004';
  a_acct   UUID;
  b_acct   UUID;
  c1       UUID;
  c_b      UUID;
  v1       UUID;
  k1       UUID;
  c2       UUID;
  c3       UUID;
  v2       UUID;
  v3       UUID;
  pol      JSONB;
  j        JSONB;
  v        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.pv_try(p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; h text;
    BEGIN
      BEGIN
        IF p_sql ILIKE 'select%' THEN EXECUTE p_sql INTO v; ELSE EXECUTE p_sql; END IF;
        RETURN coalesce(v, 'ok');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
        RETURN 'ERROR ' || SQLSTATE || ' ' || coalesce(nullif(h, ''), '-') || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.pv_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'pv-owner@example.invalid'), (u_admin, 'pv-admin@example.invalid'),
    (u_agent, 'pv-agent@example.invalid'), (u_bown, 'pv-bown@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_bown;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent;
  INSERT INTO contacts (account_id, user_id, phone, name, email) VALUES (a_acct, u_agent, '971500221001', 'PV one', 'pv@example.invalid')
    RETURNING id INTO c1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (b_acct, u_bown, '971500221002', 'PV other')
    RETURNING id INTO c_b;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_agent, c1) RETURNING id INTO v1;
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_type, content_text, media_url)
  VALUES (v1, 'customer', NULL, 'text', 'hello, my passport is attached', NULL),
         (v1, 'agent', u_agent, 'image', 'here you go', 'https://x.invalid/chat-media/a.jpg');
  INSERT INTO contact_notes (contact_id, user_id, account_id, note_text) VALUES (c1, u_agent, a_acct, 'prefers Arabic');

  -- ---------- 221: export ----------
  n := n + 1; failed := failed || pg_temp.pv_ok(
    pg_temp.pv_try(format('SELECT privacy_subject_export(%L, %L, %L)::text', u_agent, a_acct, c1)) LIKE 'ERROR % NOT_ALLOWED:%',
    'an agent exported a customer');
  n := n + 1; failed := failed || pg_temp.pv_ok(
    privacy_subject_export(u_owner, a_acct, c_b) IS NULL, 'another account''s contact was exported');
  j := privacy_subject_export(u_admin, a_acct, c1);
  n := n + 1; failed := failed || pg_temp.pv_ok(j->'data'->'contact'->>'name' = 'PV one'
    AND j->'data'->'contact'->>'email' = 'pv@example.invalid', 'the export lacks the contact');
  n := n + 1; failed := failed || pg_temp.pv_ok(
    jsonb_array_length(j->'data'->'conversations'->0->'messages') = 2
    AND jsonb_path_exists(j->'data'->'conversations'->0->'messages', '$[*] ? (@.content_text starts with "hello")'),
    'the export lacks the messages');
  n := n + 1; failed := failed || pg_temp.pv_ok(
    j->'data'->'notes'->0->>'note_text' = 'prefers Arabic', 'the export lacks the notes');
  v := j::text;
  n := n + 1; failed := failed || pg_temp.pv_ok(
    position(u_agent::text IN v) = 0 AND position('chat-media' IN v) = 0 AND position(a_acct::text IN v) = 0,
    'the export carries a staff id, a storage URL or the account id');
  n := n + 1; failed := failed || pg_temp.pv_ok(
    (SELECT count(*) FROM privacy_requests r WHERE r.account_id = a_acct AND r.kind = 'export'
      AND r.contact_hash = privacy_contact_hash(a_acct, c1) AND r.actor_id = u_admin
      AND position(c1::text IN r.detail::text) = 0) = 1,
    'the export was not logged once, by hash');
  n := n + 1; failed := failed || pg_temp.pv_ok(
    pg_temp.pv_try('UPDATE privacy_requests SET kind = ''erase''') LIKE 'ERROR %',
    'the request log took an UPDATE');
  n := n + 1; failed := failed || pg_temp.pv_ok(
    pg_temp.pv_try('SET LOCAL ROLE authenticated; SELECT count(*)::text FROM privacy_requests') LIKE 'ERROR 42501%',
    'authenticated read the request log');
  RESET ROLE;

  -- ---------- 222: erase and legal hold ----------
  UPDATE contacts SET opted_out_at = now() WHERE id = c1;
  INSERT INTO tasks (account_id, created_by, title, contact_id, kind, source)
  VALUES (a_acct, u_agent, 'call back', c1, 'manual', 'manual');
  INSERT INTO case_banks (account_id, code, name) VALUES (a_acct, 'PVB', 'PV Bank') ON CONFLICT DO NOTHING;
  k1 := case_open_lead(u_agent, a_acct, c1, 'PVB', 'Card', u_agent);

  n := n + 1; failed := failed || pg_temp.pv_ok(
    pg_temp.pv_try(format('SELECT privacy_subject_erase(%L, %L, %L, true)::text', u_agent, a_acct, c1)) LIKE 'ERROR % NOT_ALLOWED:%',
    'an agent erased a customer');
  n := n + 1; failed := failed || pg_temp.pv_ok(
    privacy_subject_erase(u_owner, a_acct, c_b, true) IS NULL, 'another account''s contact was erased');
  j := privacy_subject_erase(u_admin, a_acct, c1, true);
  n := n + 1; failed := failed || pg_temp.pv_ok(j->>'mode' = 'dry_run' AND (j->'counts'->>'messages')::int = 2
    AND (j->'counts'->>'tasks')::int = 1 AND (j->>'objects_count')::int = 1 AND j->'objects' = '[]'::jsonb,
    format('the dry run counts are wrong (%s)', j::text));
  n := n + 1; failed := failed || pg_temp.pv_ok(
    (SELECT count(*) FROM messages WHERE conversation_id = v1) = 2
    AND (SELECT name FROM contacts WHERE id = c1) = 'PV one', 'the dry run changed data');
  n := n + 1; failed := failed || pg_temp.pv_ok(
    pg_temp.pv_try(format('SELECT privacy_subject_erase(%L, %L, %L, false, ''erase'')::text', u_admin, a_acct, c1))
      LIKE 'ERROR % CONFIRM_REQUIRED:%', 'an erase ran without the typed confirmation');
  n := n + 1; failed := failed || pg_temp.pv_ok(
    pg_temp.pv_try(format('SELECT privacy_legal_hold_set(%L, %L, %L, true, E''\t'')::text', u_admin, a_acct, c1))
      LIKE 'ERROR % REASON_REQUIRED:%', 'a hold was placed without a reason');
  PERFORM privacy_legal_hold_set(u_admin, a_acct, c1, true, 'court order 12/2026');
  j := privacy_subject_erase(u_admin, a_acct, c1, false, 'ERASE ' || c1);
  n := n + 1; failed := failed || pg_temp.pv_ok(j->>'blocked' = 'legal_hold'
    AND (SELECT count(*) FROM messages WHERE conversation_id = v1) = 2, 'a legal hold did not block the erase');
  PERFORM privacy_legal_hold_set(u_owner, a_acct, c1, false);
  j := privacy_subject_erase(u_admin, a_acct, c1, false, 'ERASE ' || c1);
  n := n + 1; failed := failed || pg_temp.pv_ok(j->>'mode' = 'erase' AND jsonb_array_length(j->'objects') = 1
    AND j->'objects'->0->>'url' LIKE '%chat-media%', format('the erase result is wrong (%s)', j::text));
  n := n + 1; failed := failed || pg_temp.pv_ok(
    (SELECT count(*) FROM messages WHERE conversation_id = v1) = 0
    AND (SELECT count(*) FROM contact_notes WHERE contact_id = c1) = 0
    AND (SELECT count(*) FROM tasks WHERE contact_id = c1) = 0, 'messages, notes or tasks survived the erase');
  n := n + 1; failed := failed || pg_temp.pv_ok(
    (SELECT name = 'Erased customer' AND email IS NULL AND phone LIKE 'erased-%' AND opted_out_at IS NOT NULL
       FROM contacts WHERE id = c1), 'the contact was not anonymised with its opt-out kept');
  n := n + 1; failed := failed || pg_temp.pv_ok(
    (SELECT contact_id FROM cases WHERE id = k1) = c1, 'the bank case was not kept');
  n := n + 1; failed := failed || pg_temp.pv_ok(
    (SELECT count(*) FROM privacy_requests WHERE account_id = a_acct AND contact_hash = privacy_contact_hash(a_acct, c1)
       AND kind IN ('erase', 'erase_dry_run', 'legal_hold_placed', 'legal_hold_released')) = 5,
    'the erase requests were not all logged');

  -- ---------- 223: retention ----------
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500221003', 'PV two') RETURNING id INTO c2;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500221004', 'PV held') RETURNING id INTO c3;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_agent, c2) RETURNING id INTO v2;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_agent, c3) RETURNING id INTO v3;
  INSERT INTO hr_conversations (conversation_id, account_id, inbox, stage_key) VALUES (v2, a_acct, 'recruiter', 'cv_review'),
    (v3, a_acct, 'recruiter', 'cv_review');
  INSERT INTO hr_agent_drafts (account_id, conversation_id, agent_kind, intent, status, body, created_at) VALUES
    (a_acct, v2, 'orchestrator', 'cv_received', 'rejected', 'old decided', now() - interval '100 days'),
    (a_acct, v2, 'orchestrator', 'cv_received', 'pending', 'old pending', now() - interval '100 days'),
    (a_acct, v2, 'orchestrator', 'cv_received', 'rejected', 'recent decided', now() - interval '5 days'),
    (a_acct, v3, 'orchestrator', 'cv_received', 'rejected', 'held decided', now() - interval '100 days');
  PERFORM privacy_legal_hold_set(u_admin, a_acct, c3, true, 'dispute');
  pol := '{"tables": {"hr_agent_drafts": {"days": 90, "action": "delete"}, "hr_outbox_bodies": {"days": 365, "action": "anonymise"},
           "deal_room_messages": {"days": 365, "action": "anonymise"}, "whatsapp_group_messages": {"days": 365, "action": "delete"},
           "call_records": {"days": 730, "action": "anonymise"}}}';
  n := n + 1; failed := failed || pg_temp.pv_ok(
    pg_temp.pv_try(format('SELECT privacy_retention_set(%L, %L, %L, false)::text', u_agent, a_acct, pol)) LIKE 'ERROR % NOT_ALLOWED:%',
    'an agent set a retention policy');
  n := n + 1; failed := failed || pg_temp.pv_ok(
    pg_temp.pv_try(format('SELECT privacy_retention_set(%L, %L, %L, false)::text', u_admin, a_acct,
      '{"tables": {"cases": {"days": 90, "action": "delete"}}}')) LIKE 'ERROR % INVALID:%'
    AND pg_temp.pv_try(format('SELECT privacy_retention_set(%L, %L, %L, false)::text', u_admin, a_acct,
      '{"tables": {"hr_agent_drafts": {"days": 10, "action": "delete"}}}')) LIKE 'ERROR % INVALID:%'
    AND pg_temp.pv_try(format('SELECT privacy_retention_set(%L, %L, %L, false)::text', u_admin, a_acct,
      '{"tables": {"hr_outbox_bodies": {"days": 90, "action": "delete"}}}')) LIKE 'ERROR % INVALID:%',
    'a retention policy outside the allow-list, under 30 days or with a disallowed action was accepted');
  PERFORM privacy_retention_set(u_admin, a_acct, pol, false);
  j := privacy_retention_sweep(a_acct);
  n := n + 1; failed := failed || pg_temp.pv_ok(j->>'mode' = 'dry_run'
    AND (j->'tables'->'hr_agent_drafts'->>'rows')::int = 1 AND (j->'tables'->'hr_agent_drafts'->>'held_skipped')::int = 1
    AND (SELECT count(*) FROM hr_agent_drafts WHERE account_id = a_acct) = 4,
    format('the retention dry run is wrong (%s)', j::text));
  PERFORM privacy_retention_set(u_owner, a_acct, pol, true);
  j := privacy_retention_sweep(a_acct);
  n := n + 1; failed := failed || pg_temp.pv_ok(j->>'mode' = 'apply'
    AND (SELECT string_agg(body, ',' ORDER BY body) FROM hr_agent_drafts WHERE account_id = a_acct)
        = 'held decided,old pending,recent decided',
    format('the sweep removed the wrong drafts (%s)', j::text));
  n := n + 1; failed := failed || pg_temp.pv_ok(
    (SELECT count(*) FROM privacy_requests WHERE account_id = a_acct AND kind IN ('retention', 'retention_dry_run')
       AND actor_label = 'system:retention') = 2, 'the sweeps were not logged');
  n := n + 1; failed := failed || pg_temp.pv_ok(
    a_acct IN (SELECT privacy_retention_accounts()), 'the account is not on the sweep list');

  -- ---------- 224: AI transfer register ----------
  n := n + 1; failed := failed || pg_temp.pv_ok(ai_transfer_check(a_acct, 'openai', 'reply', 'gpt-x', 1200),
    'an AI call was refused with no basis required');
  n := n + 1; failed := failed || pg_temp.pv_ok(
    pg_temp.pv_try(format('SELECT ai_transfer_basis_set(%L, %L, ''contract'', ''short'', ''Counsel'', ''US'', false)::text',
      u_agent, a_acct)) LIKE 'ERROR % NOT_ALLOWED:%', 'an agent set the AI transfer basis');
  PERFORM ai_transfer_basis_set(u_admin, a_acct, 'contract', NULL, NULL, NULL, true);
  n := n + 1; failed := failed || pg_temp.pv_ok(NOT ai_transfer_check(a_acct, 'openai', 'reply', 'gpt-x', 900),
    'an AI call went with the basis required and incomplete');
  n := n + 1; failed := failed || pg_temp.pv_ok(
    pg_temp.pv_try(format('SELECT ai_transfer_basis_set(%L, %L, ''contract'', ''too short'', ''Counsel'', ''US'', false)::text',
      u_admin, a_acct)) LIKE 'ERROR % INVALID:%', 'a basis note under 20 characters was accepted');
  -- Required with a complete basis: allowed.
  PERFORM ai_transfer_basis_set(u_admin, a_acct, 'contract', 'DPA with the provider, signed 2026-11', 'Legal counsel', 'US', true);
  n := n + 1; failed := failed || pg_temp.pv_ok(ai_transfer_check(a_acct, 'typesafe', 'triage', NULL, 300),
    'an AI call was refused with a complete basis on record');
  -- Account B requires nothing: allowed; logged with allowed = true.
  n := n + 1; failed := failed || pg_temp.pv_ok(ai_transfer_check(b_acct, 'anthropic', 'draft', 'claude-x', 10),
    'account B''s call was refused');
  n := n + 1; failed := failed || pg_temp.pv_ok(
    (SELECT count(*) FROM ai_transfer_log WHERE account_id = a_acct AND allowed) = 2
    AND (SELECT count(*) FROM ai_transfer_log WHERE account_id = a_acct AND NOT allowed) = 1
    AND (SELECT basis FROM ai_transfer_log WHERE account_id = a_acct ORDER BY id DESC LIMIT 1) = 'contract',
    'the AI calls were not logged with their basis');
  n := n + 1; failed := failed || pg_temp.pv_ok(
    pg_temp.pv_try('DELETE FROM ai_transfer_log') LIKE 'ERROR %', 'the AI transfer log took a DELETE');
  n := n + 1; failed := failed || pg_temp.pv_ok(
    (ai_transfer_basis_get(u_admin, a_acct) -> 'basis' ->> 'require_basis')::boolean
    AND (ai_transfer_basis_get(u_admin, a_acct) ->> 'refused_30_days')::int = 1,
    'ai_transfer_basis_get does not report the requirement');

  RAISE EXCEPTION USING ERRCODE = 'ZT221', MESSAGE = 'verify-privacy rollback';
  EXCEPTION WHEN SQLSTATE 'ZT221' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'privacy verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'privacy verification passed (% checks)', n;
END
$verify$;
