-- Behavioural regression suite for the Taamul sales-app (OpenDesk)
-- webhook (migration 139).
--
-- taamul_sales_record_interested() records an event id once (a replay
-- is 'duplicate' and writes nothing), counts every event into the
-- sales-app contact, and lets only an event at least as new rewrite its
-- snapshot (delivery is unordered). It never writes the CRM's
-- `contacts`. Admins and owners of the workspace read both tables, an
-- agent reads nothing, another workspace's admin reads nothing, and no
-- session can write them or run the function.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The fixtures are
-- rolled back by a sentinel exception; the results survive in plpgsql
-- variables.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000139001';
  u_agent UUID := '00000000-0000-4000-8000-000000139002';
  u_other UUID := '00000000-0000-4000-8000-000000139003';
  a_acct  UUID;
  a_other UUID;
  v_cont  BIGINT;
  r       TEXT;
  t       RECORD;
  n       INT := 0;
  failed  TEXT[] := '{}';
  f_new   JSONB := jsonb_build_object(
    'customer_name', 'Ahmed Ali', 'company_name', 'Infinity Development',
    'phone', '971501390001', 'phone_raw', '0501390001',
    'additional_phones', jsonb_build_array('971551390001'),
    'trade_license_number', 'CN-139', 'is_existing_customer', false,
    'agent_username', 'meet', 'agent_email', 'meet@example.invalid',
    'called_at', '2026-10-26T09:05:00Z', 'call_notes', 'second call',
    'lead_id', 'lead-1', 'lead_status', 'new');
BEGIN
  BEGIN
  -- Run a SELECT as `authenticated` signed in as p_uid: its value, or
  -- 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ts_as(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        EXECUTE p_sql INTO v;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(v, 'ok');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'ts-owner@example.invalid'),
    (u_agent, 'ts-agent@example.invalid'),
    (u_other, 'ts-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO a_other FROM profiles WHERE user_id = u_other;
  IF a_acct IS NULL OR a_other IS NULL OR a_acct = a_other THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision two accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent;
  SELECT count(*) INTO v_cont FROM contacts;

  -- ---------- first event, then its replay ----------
  r := taamul_sales_record_interested(a_acct, 'evt-139-b', 'contact.interested',
    '2026-10-26T09:06:46Z', 'tc-139-1', f_new, '{"event_id":"evt-139-b"}', 'dlv-1');
  n := n + 1;
  IF r IS DISTINCT FROM 'recorded' THEN
    failed := failed || format('a new event returned %s, not recorded', r);
  END IF;
  r := taamul_sales_record_interested(a_acct, 'evt-139-b', 'contact.interested',
    '2026-10-26T09:06:46Z', 'tc-139-1', f_new || '{"call_notes":"replayed"}', '{}', 'dlv-2');
  n := n + 1;
  IF r IS DISTINCT FROM 'duplicate' THEN
    failed := failed || format('a replayed event returned %s, not duplicate', r);
  END IF;
  n := n + 1;
  IF (SELECT count(*) FROM taamul_sales_events WHERE event_id = 'evt-139-b') <> 1
     OR (SELECT delivery_id FROM taamul_sales_events WHERE event_id = 'evt-139-b') <> 'dlv-1' THEN
    failed := failed || 'the replay wrote a second event row or rewrote the first'::text;
  END IF;
  SELECT * INTO t FROM taamul_sales_contacts WHERE account_id = a_acct AND taamul_contact_id = 'tc-139-1';
  n := n + 1;
  IF t.interested_count <> 1 OR t.call_notes <> 'second call' OR t.customer_name <> 'Ahmed Ali'
     OR t.additional_phones <> ARRAY['971551390001'] OR t.is_existing_customer IS DISTINCT FROM false
     OR t.called_at <> '2026-10-26T09:05:00Z'::timestamptz OR t.lead_status <> 'new' THEN
    failed := failed || format('the snapshot after one event is wrong: %s', row_to_json(t));
  END IF;

  -- ---------- an older event arriving late ----------
  r := taamul_sales_record_interested(a_acct, 'evt-139-a', 'contact.interested',
    '2026-10-25T08:00:00Z', 'tc-139-1', f_new || '{"call_notes":"first call"}', '{}', NULL);
  SELECT * INTO t FROM taamul_sales_contacts WHERE account_id = a_acct AND taamul_contact_id = 'tc-139-1';
  n := n + 1;
  IF r <> 'recorded' OR t.interested_count <> 2 OR t.call_notes <> 'second call'
     OR t.last_event_id <> 'evt-139-b' OR t.first_interested_at <> '2026-10-25T08:00:00Z'::timestamptz THEN
    failed := failed || format('an older event rewrote the snapshot or was not counted: %s', row_to_json(t));
  END IF;

  -- ---------- a newer one does rewrite it ----------
  r := taamul_sales_record_interested(a_acct, 'evt-139-d', 'contact.interested',
    '2026-10-27T10:00:00Z', 'tc-139-1', f_new || '{"call_notes":"third call","lead_status":"won"}', '{}', NULL);
  SELECT * INTO t FROM taamul_sales_contacts WHERE account_id = a_acct AND taamul_contact_id = 'tc-139-1';
  n := n + 1;
  IF t.interested_count <> 3 OR t.call_notes <> 'third call' OR t.lead_status <> 'won'
     OR t.last_interested_at <> '2026-10-27T10:00:00Z'::timestamptz THEN
    failed := failed || format('a newer event did not rewrite the snapshot: %s', row_to_json(t));
  END IF;

  -- ---------- kept apart from the CRM's contacts ----------
  n := n + 1;
  IF (SELECT count(*) FROM contacts) <> v_cont THEN
    failed := failed || 'recording an event wrote the CRM''s contacts'::text;
  END IF;

  -- ---------- who reads ----------
  n := n + 1;
  r := pg_temp.ts_as(u_owner, 'SELECT count(*)::text FROM taamul_sales_contacts')
       || '/' || pg_temp.ts_as(u_owner, 'SELECT count(*)::text FROM taamul_sales_events');
  IF r <> '1/3' THEN
    failed := failed || format('the workspace owner read %s rows (contacts/events), not 1/3', r);
  END IF;
  n := n + 1;
  r := pg_temp.ts_as(u_agent, 'SELECT count(*)::text FROM taamul_sales_contacts')
       || '/' || pg_temp.ts_as(u_agent, 'SELECT count(*)::text FROM taamul_sales_events');
  IF r <> '0/0' THEN
    failed := failed || format('an agent read %s rows (contacts/events)', r);
  END IF;
  n := n + 1;
  r := pg_temp.ts_as(u_other, 'SELECT count(*)::text FROM taamul_sales_contacts');
  IF r <> '0' THEN
    failed := failed || format('another workspace''s owner read %s rows', r);
  END IF;

  -- ---------- nobody but the service role writes ----------
  n := n + 1;
  r := pg_temp.ts_as(u_owner, format(
    'INSERT INTO taamul_sales_contacts (account_id, taamul_contact_id) VALUES (%L, ''x'') RETURNING 1', a_acct));
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := failed || format('the owner could insert a row (%s)', r);
  END IF;
  n := n + 1;
  IF has_function_privilege('authenticated',
       'public.taamul_sales_record_interested(uuid, text, text, timestamptz, text, jsonb, jsonb, text)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.taamul_sales_record_interested(uuid, text, text, timestamptz, text, jsonb, jsonb, text)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.taamul_sales_events', 'UPDATE')
     OR has_table_privilege('anon', 'public.taamul_sales_contacts', 'SELECT') THEN
    failed := failed || 'a session role can write the tables, run the function, or read as anon'::text;
  END IF;
  n := n + 1;
  IF NOT has_function_privilege('service_role',
       'public.taamul_sales_record_interested(uuid, text, text, timestamptz, text, jsonb, jsonb, text)', 'EXECUTE') THEN
    failed := failed || 'the service role cannot run the function'::text;
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZT139', MESSAGE = 'verify-taamul-sales rollback';
  EXCEPTION WHEN SQLSTATE 'ZT139' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'Taamul sales webhook verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'Taamul sales webhook verification passed (% checks)', n;
END
$verify$;
