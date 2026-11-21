-- Behavioural regression suite for the desk worklist counts and the
-- suggestion input (migration 235).
--
-- desk_worklist counts what waits for this person: tray documents they
-- may sort, sorting-queue uploads in their scope, their own untagged
-- uploads, their open desk follow-up tasks. desk_tray_suggest_input
-- gives a sorter only what a suggestion may see of an open tray item: no
-- company or person names, each candidate's bank, product and missing
-- documents, in the tray's order. Closed to API roles.
--
-- ONE statement on purpose: `supabase db query --file` sends the file as
-- a single prepared statement and rejects several. Fixtures are rolled
-- back by a sentinel exception; failures are named in the final one.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000235001';
  u_lead  UUID := '00000000-0000-4000-8000-000000235002';
  u_agent UUID := '00000000-0000-4000-8000-000000235003';
  u_crak  UUID := '00000000-0000-4000-8000-000000235004';
  a_acct  UUID;
  c_own   UUID;
  cv_own  UUID;
  k_r     UUID;
  m       UUID;
  d       UUID;
  t       UUID;
  j       JSONB;
  v       TEXT;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ws_try(p_sql text)
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
    CREATE FUNCTION pg_temp.ws_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ws_as(p_role text, p_sql text)
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
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'dws-owner@example.invalid'), (u_lead, 'dws-lead@example.invalid'),
    (u_agent, 'dws-agent@example.invalid'), (u_crak, 'dws-crak@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agent, u_crak);
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500235001', 'WS kite')
    RETURNING id INTO c_own;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_agent, c_own) RETURNING id INTO cv_own;
  INSERT INTO case_banks (account_id, code, name) VALUES
    (a_acct, 'RAK', 'RAKBANK'), (a_acct, 'ENBD', 'Emirates NBD')
  ON CONFLICT DO NOTHING;
  INSERT INTO coordinator_banks (account_id, user_id, bank_code) VALUES (a_acct, u_crak, 'RAK');
  INSERT INTO case_file_specs (account_id, bank_code, product, doc_key, position, name_pattern, required) VALUES
    (a_acct, 'RAK', 'Business account', 'ejari', 1, '{{doc}}', true),
    (a_acct, 'ENBD', 'Business account', 'kyc_form', 1, '{{doc}}', true);
  PERFORM desk_bank_code_set(u_owner, a_acct, 'RAK', 'RAK');
  PERFORM desk_bank_code_set(u_owner, a_acct, 'ENBD', 'ENB');
  SELECT x.case_id INTO k_r
    FROM desk_case_open(a_acct, 'WS-1', 'Kite General Trading', 'RAK', 'Business account', c_own, u_agent, NULL, now()) x;
  PERFORM desk_case_open(a_acct, 'WS-1', NULL, 'ENBD', 'Business account', c_own, u_agent, NULL, now());
  PERFORM desk_settings_set(u_owner, a_acct, true, '{}', 120);
  INSERT INTO messages (conversation_id, sender_type, content_type, media_url, content_text)
  VALUES (cv_own, 'customer', 'document', 'https://x.invalid/ws.pdf', 'ejari copy') RETURNING id INTO m;
  PERFORM customer_documents_record(a_acct, c_own, 'chat', 'document', 'https://x.invalid/ws.pdf', now(), cv_own, m,
                                    NULL, 'application/pdf', 'ejari.pdf', 'ejari copy');
  SELECT x.id INTO d FROM customer_documents x WHERE x.message_id = m;
  SELECT x.tray_id INTO t FROM desk_route_customer_document(a_acct, d, NULL, now()) x;
  PERFORM intake_submit(u_agent, a_acct, gen_random_uuid(), 'dws-00001', NULL, 'RAK', NULL, NULL, NULL, NULL, NULL,
                        NULL, 'to sort', NULL, NULL, NULL, NULL, NULL, now());
  INSERT INTO tasks (account_id, kind, title, assigned_to, source, source_ref)
  VALUES (a_acct, 'follow_up', 'Uploads are waiting', u_crak, 'automation', 'desk_queue:x:second');

  -- ---------- 1. worklist counts ----------
  j := desk_worklist(u_lead, a_acct, now());
  n := n + 1; failed := failed || pg_temp.ws_ok(t IS NOT NULL AND (j->'tray'->>'count')::int = 1
    AND (j->'queue'->>'count')::int = 1 AND (j->'mine'->>'count')::int = 0,
    format('a team leader''s desk counts are wrong (%s)', j));
  j := desk_worklist(u_agent, a_acct, now());
  n := n + 1; failed := failed || pg_temp.ws_ok((j->'tray'->>'count')::int = 0
    AND (j->'queue'->>'count')::int = 0 AND (j->'mine'->>'count')::int = 1,
    format('an uploader''s desk counts are wrong (%s)', j));
  j := desk_worklist(u_crak, a_acct, now());
  n := n + 1; failed := failed || pg_temp.ws_ok((j->'tray'->>'count')::int = 1
    AND (j->'queue'->>'count')::int = 1 AND (j->'tasks'->>'count')::int = 1,
    format('a bank holder''s desk counts are wrong (%s)', j));

  -- ---------- 2. what a suggestion may see ----------
  j := desk_tray_suggest_input(u_lead, a_acct, t);
  n := n + 1; failed := failed || pg_temp.ws_ok(jsonb_array_length(j->'candidates') = 2
    AND (j->'candidates'->0->>'bank_code') IN ('RAK', 'ENBD')
    AND j->>'caption' = 'ejari copy'
    AND (SELECT bool_and(jsonb_array_length(e->'missing') = 1) FROM jsonb_array_elements(j->'candidates') e),
    format('the suggestion input lacks candidates, caption or missing documents (%s)', j));
  n := n + 1; failed := failed || pg_temp.ws_ok(position('Kite' IN j::text) = 0 AND position('WS kite' IN j::text) = 0,
    'the suggestion input carried a company or person name');
  n := n + 1; failed := failed || pg_temp.ws_ok(pg_temp.ws_try(format(
    'SELECT desk_tray_suggest_input(%L, %L, %L)::text', u_agent, a_acct, t)) LIKE 'ERROR % TRAY_NOT_FOUND:%',
    'someone who may not sort the item read its suggestion input');
  PERFORM desk_tray_dismiss(u_lead, a_acct, t, 'not a case document');
  n := n + 1; failed := failed || pg_temp.ws_ok(pg_temp.ws_try(format(
    'SELECT desk_tray_suggest_input(%L, %L, %L)::text', u_lead, a_acct, t)) LIKE 'ERROR % TRAY_NOT_OPEN:%',
    'a sorted item still offered a suggestion');

  -- ---------- 3. closed to API roles ----------
  n := n + 1; failed := failed || pg_temp.ws_ok(pg_temp.ws_as('authenticated', format(
    'SELECT desk_worklist(%L, %L)::text', u_lead, a_acct)) LIKE 'ERROR 42501', 'authenticated called desk_worklist');

  RAISE EXCEPTION USING ERRCODE = 'ZT235', MESSAGE = 'verify-desk-worklist-suggest rollback';
  EXCEPTION WHEN SQLSTATE 'ZT235' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'desk worklist and suggestion verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'desk worklist and suggestion verification passed (% checks)', n;
END
$verify$;
