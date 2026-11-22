-- Behavioural regression suite for the file preview while sorting
-- (migration 248).
--
-- intake_file_for_preview hands out an intake item's stored file to its
-- uploader always, and to anyone else only while the item waits
-- 'untagged' in a queue they sort (220's intake_scope_ok); everyone else,
-- another workspace and a non-staff actor get ITEM_NOT_FOUND, and an
-- item without a file FILE_NOT_FOUND. desk_tray_file_for_preview hands
-- out an OPEN tray item's document to the people who may sort it (230's
-- desk_tray_can_sort), else TRAY_NOT_FOUND. Each answer writes one
-- append-only desk_file_previews row first; a refusal writes none. The
-- table and both functions are closed to the API roles.
--
-- ONE statement on purpose: `supabase db query --file` sends the file as
-- a single prepared statement and rejects several. Fixtures are rolled
-- back by a sentinel exception; failures are named in the final one.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000248001';
  u_lead  UUID := '00000000-0000-4000-8000-000000248002';
  u_agent UUID := '00000000-0000-4000-8000-000000248003';
  u_crak  UUID := '00000000-0000-4000-8000-000000248004';
  u_cenb  UUID := '00000000-0000-4000-8000-000000248005';
  u_away  UUID := '00000000-0000-4000-8000-000000248006';
  a_acct  UUID;
  a_away  UUID;
  c_own   UUID;
  cv_own  UUID;
  i_file  UUID := '00000000-0000-4000-8000-000000248101';
  i_bare  UUID := '00000000-0000-4000-8000-000000248102';
  sha     TEXT := repeat('c', 64);
  m       UUID;
  d       UUID;
  t       UUID;
  v       TEXT;
  k       BIGINT;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.fp_try(p_sql text)
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
    CREATE FUNCTION pg_temp.fp_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.fp_as(p_role text, p_sql text)
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
  -- The intake preview as SQL text: 'path|mime|name', or the refusal.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.fp_item(p_actor uuid, p_account uuid, p_item uuid)
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.fp_try(format(
        'SELECT x.storage_path || ''|'' || x.mime || ''|'' || x.original_name FROM intake_file_for_preview(%L, %L, %L) x',
        p_actor, p_account, p_item))
    $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.fp_tray(p_actor uuid, p_account uuid, p_tray uuid)
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.fp_try(format(
        'SELECT coalesce(x.storage_bucket, ''-'') || ''|'' || x.media_url || ''|'' || x.mime
           FROM desk_tray_file_for_preview(%L, %L, %L) x',
        p_actor, p_account, p_tray))
    $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'dfp-owner@example.invalid'), (u_lead, 'dfp-lead@example.invalid'),
    (u_agent, 'dfp-agent@example.invalid'), (u_crak, 'dfp-crak@example.invalid'),
    (u_cenb, 'dfp-cenb@example.invalid'), (u_away, 'dfp-away@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO a_away FROM profiles WHERE user_id = u_away;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agent, u_crak, u_cenb);
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500248001', 'FP kite')
    RETURNING id INTO c_own;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_agent, c_own) RETURNING id INTO cv_own;
  INSERT INTO case_banks (account_id, code, name) VALUES
    (a_acct, 'RAK', 'RAKBANK'), (a_acct, 'ENBD', 'Emirates NBD')
  ON CONFLICT DO NOTHING;
  INSERT INTO coordinator_banks (account_id, user_id, bank_code) VALUES
    (a_acct, u_crak, 'RAK'), (a_acct, u_cenb, 'ENBD');
  PERFORM desk_bank_code_set(u_owner, a_acct, 'RAK', 'RAK');
  PERFORM desk_bank_code_set(u_owner, a_acct, 'ENBD', 'ENB');
  -- An upload with a file and one without, both waiting in the RAK queue.
  PERFORM intake_submit(u_agent, a_acct, i_file, 'dfp-00001', NULL, 'RAK', NULL, NULL, NULL, NULL, NULL,
                        NULL, 'to sort', 'intake/' || i_file || '/' || sha || '.pdf', 'licence.pdf',
                        'application/pdf', 1000, sha, now());
  PERFORM intake_submit(u_agent, a_acct, i_bare, 'dfp-00002', NULL, 'RAK', NULL, NULL, NULL, NULL, NULL,
                        NULL, 'no file', NULL, NULL, NULL, NULL, NULL, now());

  -- ---------- 1. intake: who sees the file ----------
  v := pg_temp.fp_item(u_agent, a_acct, i_file);
  n := n + 1; failed := failed || pg_temp.fp_ok(v = 'intake/' || i_file || '/' || sha || '.pdf|application/pdf|licence.pdf',
    format('the uploader did not get their file (%s)', v));
  v := pg_temp.fp_item(u_crak, a_acct, i_file);
  n := n + 1; failed := failed || pg_temp.fp_ok(v LIKE 'intake/%',
    format('the RAK holder could not preview a RAK queue upload (%s)', v));
  v := pg_temp.fp_item(u_lead, a_acct, i_file);
  n := n + 1; failed := failed || pg_temp.fp_ok(v LIKE 'intake/%',
    format('a team leader could not preview a queued upload (%s)', v));
  SELECT count(*) INTO k FROM desk_file_previews WHERE intake_item_id = i_file;
  n := n + 1; failed := failed || pg_temp.fp_ok(k = 3, format('expected 3 audit rows, found %s', k));
  v := pg_temp.fp_item(u_cenb, a_acct, i_file);
  n := n + 1; failed := failed || pg_temp.fp_ok(v LIKE 'ERROR % ITEM_NOT_FOUND:%',
    format('another bank''s holder previewed a RAK upload (%s)', v));
  v := pg_temp.fp_item(u_away, a_away, i_file);
  n := n + 1; failed := failed || pg_temp.fp_ok(v LIKE 'ERROR % ITEM_NOT_FOUND:%',
    format('another workspace previewed the upload (%s)', v));
  v := pg_temp.fp_item(u_away, a_acct, i_file);
  n := n + 1; failed := failed || pg_temp.fp_ok(v LIKE 'ERROR % ITEM_NOT_FOUND:%',
    format('a non-member named the workspace and previewed (%s)', v));
  SELECT count(*) INTO k FROM desk_file_previews WHERE intake_item_id = i_file;
  n := n + 1; failed := failed || pg_temp.fp_ok(k = 3, format('a refusal wrote an audit row (%s rows)', k));
  v := pg_temp.fp_item(u_agent, a_acct, i_bare);
  n := n + 1; failed := failed || pg_temp.fp_ok(v LIKE 'ERROR % FILE_NOT_FOUND:%',
    format('an upload without a file was not FILE_NOT_FOUND (%s)', v));

  -- Once sorted, it is no longer a sorter's to preview; the uploader keeps it.
  PERFORM intake_reject(u_lead, a_acct, i_file, 'not a bank document', now());
  v := pg_temp.fp_item(u_crak, a_acct, i_file);
  n := n + 1; failed := failed || pg_temp.fp_ok(v LIKE 'ERROR % ITEM_NOT_FOUND:%',
    format('a sorter previewed an upload that was already sorted (%s)', v));
  v := pg_temp.fp_item(u_agent, a_acct, i_file);
  n := n + 1; failed := failed || pg_temp.fp_ok(v LIKE 'intake/%',
    format('the uploader lost their own sorted upload (%s)', v));

  -- ---------- 2. the tray ----------
  SELECT x.case_id INTO STRICT v
    FROM desk_case_open(a_acct, 'FP-1', 'Kite General Trading', 'RAK', 'Business account', c_own, u_agent, NULL, now()) x;
  PERFORM desk_case_open(a_acct, 'FP-1', NULL, 'ENBD', 'Business account', c_own, u_agent, NULL, now());
  PERFORM desk_settings_set(u_owner, a_acct, true, '{}', 120);
  INSERT INTO messages (conversation_id, sender_type, content_type, media_url, content_text)
  VALUES (cv_own, 'customer', 'document', 'https://x.invalid/fp.pdf', 'licence copy') RETURNING id INTO m;
  PERFORM customer_documents_record(a_acct, c_own, 'chat', 'document', 'https://x.invalid/fp.pdf', now(), cv_own, m,
                                    NULL, 'application/pdf', 'licence.pdf', 'licence copy');
  SELECT x.id INTO d FROM customer_documents x WHERE x.message_id = m;
  SELECT x.tray_id INTO t FROM desk_route_customer_document(a_acct, d, NULL, now()) x;
  n := n + 1; failed := failed || pg_temp.fp_ok(t IS NOT NULL, 'the fixture document did not land in the tray');
  v := pg_temp.fp_tray(u_crak, a_acct, t);
  n := n + 1; failed := failed || pg_temp.fp_ok(v = '-|https://x.invalid/fp.pdf|application/pdf',
    format('a candidate bank''s holder did not get the tray document (%s)', v));
  v := pg_temp.fp_tray(u_lead, a_acct, t);
  n := n + 1; failed := failed || pg_temp.fp_ok(v LIKE '-|%', format('a team leader could not preview the tray item (%s)', v));
  v := pg_temp.fp_tray(u_agent, a_acct, t);
  n := n + 1; failed := failed || pg_temp.fp_ok(v LIKE 'ERROR % TRAY_NOT_FOUND:%',
    format('someone who may not sort the item previewed it (%s)', v));
  v := pg_temp.fp_tray(u_away, a_away, t);
  n := n + 1; failed := failed || pg_temp.fp_ok(v LIKE 'ERROR % TRAY_NOT_FOUND:%',
    format('another workspace previewed the tray item (%s)', v));
  SELECT count(*) INTO k FROM desk_file_previews WHERE tray_id = t;
  n := n + 1; failed := failed || pg_temp.fp_ok(k = 2, format('expected 2 tray audit rows, found %s', k));
  PERFORM desk_tray_dismiss(u_lead, a_acct, t, 'not a case document', now());
  v := pg_temp.fp_tray(u_lead, a_acct, t);
  n := n + 1; failed := failed || pg_temp.fp_ok(v LIKE 'ERROR % TRAY_NOT_FOUND:%',
    format('a dismissed tray item was still previewable (%s)', v));

  -- ---------- 3. the audit log and the API roles ----------
  n := n + 1; failed := failed || pg_temp.fp_ok(pg_temp.fp_try(format(
    'UPDATE desk_file_previews SET at = now() WHERE tray_id = %L RETURNING 1', t)) LIKE 'ERROR %',
    'the preview audit log is not append-only');
  n := n + 1; failed := failed || pg_temp.fp_ok(NOT EXISTS (
      SELECT 1 FROM desk_file_previews WHERE account_id = a_acct AND (intake_item_id IS NULL) = (tray_id IS NULL)),
    'an audit row names both or neither target');
  n := n + 1; failed := failed || pg_temp.fp_ok(pg_temp.fp_as('authenticated', format(
    'SELECT x.storage_path FROM intake_file_for_preview(%L, %L, %L) x', u_agent, a_acct, i_file)) LIKE 'ERROR 42501',
    'authenticated called intake_file_for_preview');
  n := n + 1; failed := failed || pg_temp.fp_ok(pg_temp.fp_as('authenticated', format(
    'SELECT x.media_url FROM desk_tray_file_for_preview(%L, %L, %L) x', u_lead, a_acct, t)) LIKE 'ERROR 42501',
    'authenticated called desk_tray_file_for_preview');
  n := n + 1; failed := failed || pg_temp.fp_ok(pg_temp.fp_as('service_role',
    'SELECT count(*)::text FROM desk_file_previews') LIKE 'ERROR 42501',
    'the service role read desk_file_previews directly');

  RAISE EXCEPTION USING ERRCODE = 'ZT248', MESSAGE = 'verify-intake-file-preview rollback';
  EXCEPTION WHEN SQLSTATE 'ZT248' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'intake file preview verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'intake file preview verification passed (% checks)', n;
END
$verify$;
