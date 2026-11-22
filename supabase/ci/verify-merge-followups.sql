-- Behavioural regression suite for migration 253: phone-push links for the
-- notes @mention (241) and response-time (237) bells, and the lead source
-- (249) in PDPL export and erase through 229's privacy_extensions.
--
-- ONE statement on purpose: `supabase db query --file` sends the file as
-- a single prepared statement and rejects several. Fixtures are rolled
-- back by a sentinel exception; failures are named in the final one.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000253001';
  a_acct  UUID;
  c_id    UUID;
  cv_id   UUID;
  t       TEXT;
  j       JSONB;
  v       TEXT;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.mf_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.mf_as(p_role text, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        EXECUTE format('SET LOCAL ROLE %I', p_role);
        EXECUTE p_sql INTO v;
        RESET ROLE;
        RETURN coalesce(v, 'ok');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        RETURN 'ERROR ' || SQLSTATE;
      END;
    END $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES (u_owner, 'mfu-owner@example.invalid') ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  INSERT INTO contacts (account_id, user_id, phone, name, lead_source, lead_source_detail)
  VALUES (a_acct, u_owner, '971500253001', 'MF lead', 'ad', '{"source_id":"ad-253","headline":"Open an account"}')
  RETURNING id INTO c_id;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_owner, c_id) RETURNING id INTO cv_id;

  -- ---------- 1. push links ----------
  FOREACH t IN ARRAY ARRAY['chat_note_mention', 'response_target_missed', 'response_escalated', 'response_unassigned'] LOOP
    INSERT INTO notifications (account_id, user_id, type, title, conversation_id)
    VALUES (a_acct, u_owner, t, 'MF ' || t, cv_id);
    INSERT INTO notifications (account_id, user_id, type, title)
    VALUES (a_acct, u_owner, t, 'MF bare ' || t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['chat_note_mention', 'response_target_missed', 'response_escalated', 'response_unassigned'] LOOP
    n := n + 1; failed := failed || pg_temp.mf_ok(
      (SELECT push_bell_url(nn) FROM notifications nn
        WHERE nn.user_id = u_owner AND nn.type = t AND nn.conversation_id = cv_id) = '/inbox?c=' || cv_id,
      format('push_bell_url does not open the chat for %s', t));
    n := n + 1; failed := failed || pg_temp.mf_ok(
      (SELECT push_bell_url(nn) FROM notifications nn
        WHERE nn.user_id = u_owner AND nn.type = t AND nn.conversation_id IS NULL) = '/notifications',
      format('push_bell_url without a chat does not fall back to /notifications for %s', t));
  END LOOP;

  -- ---------- 2. PDPL export and erase ----------
  n := n + 1; failed := failed || pg_temp.mf_ok(
    EXISTS (SELECT 1 FROM privacy_extensions x WHERE x.name = 'lead_source'
              AND x.export_fn = 'privacy_lead_source_export' AND x.erase_fn = 'privacy_lead_source_erase'),
    'the lead source is not registered in privacy_extensions');
  j := privacy_lead_source_export(a_acct, c_id);
  n := n + 1; failed := failed || pg_temp.mf_ok(
    j->>'lead_source' = 'ad' AND j->'lead_source_detail'->>'source_id' = 'ad-253',
    format('the export lacks the lead source (%s)', j));
  j := privacy_lead_source_erase(a_acct, c_id);
  n := n + 1; failed := failed || pg_temp.mf_ok(
    (j->'counts'->>'contacts_lead_source_detail')::int = 1 AND j->'objects' = '[]'::jsonb,
    format('the erase did not report one emptied detail (%s)', j));
  n := n + 1; failed := failed || pg_temp.mf_ok(
    (SELECT lead_source_detail = '{}'::jsonb AND lead_source = 'ad' FROM contacts WHERE id = c_id),
    'the erase did not empty lead_source_detail, or dropped lead_source');
  n := n + 1; failed := failed || pg_temp.mf_ok(
    privacy_lead_source_export(gen_random_uuid(), c_id) = '{}'::jsonb,
    'the export answered for another workspace');

  -- ---------- 3. closed to API roles ----------
  n := n + 1; failed := failed || pg_temp.mf_ok(pg_temp.mf_as('authenticated', format(
    'SELECT privacy_lead_source_export(%L, %L)::text', a_acct, c_id)) LIKE 'ERROR 42501',
    'authenticated called privacy_lead_source_export');
  n := n + 1; failed := failed || pg_temp.mf_ok(pg_temp.mf_as('service_role', format(
    'SELECT privacy_lead_source_erase(%L, %L)::text', a_acct, c_id)) LIKE 'ERROR 42501',
    'service_role called privacy_lead_source_erase');

  RAISE EXCEPTION USING ERRCODE = 'ZT253', MESSAGE = 'verify-merge-followups rollback';
  EXCEPTION WHEN SQLSTATE 'ZT253' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'merge follow-ups verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'merge follow-ups verification passed (% checks)', n;
END
$verify$;
