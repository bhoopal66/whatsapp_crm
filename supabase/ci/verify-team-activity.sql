-- Behavioural regression suite for Team activity (migration 068).
--
-- `verify-schema.sql` asserts the objects EXIST. This file asserts what
-- they compute and who may ask: the chat-start, reply, new-contact,
-- unanswered-run, burst, night, link and identical-opener rules of the
-- admin report; the drill-down; the employee's own day; the optional
-- block on new chats; the alert sweep and its once-a-day dedup; and
-- that every function refuses the callers it should.
--
-- ONE statement on purpose: `supabase db query --file` (CLI 2.113.0)
-- sends the file as a single prepared statement and rejects several.
-- The CLI drops NOTICE output, so failing assertions are named in the
-- final exception.
--
-- Runs against the clean database `supabase db reset` builds. Every
-- fixture is rolled back at the end (the body raises a sentinel that
-- the outer block catches; the verdict lives in variables), so the
-- file can be run again on the same database.
--
-- Account A covers the 068 rules; account C the 073 ones (number
-- attribution and backfill, runs from their real start, pending
-- starts, limits at >=, warm-up, grouped follow-ups, similar first
-- messages, failures by kind of number, waiting split).

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-0000000fa001';
  u_admin  UUID := '00000000-0000-4000-8000-0000000fa002';
  u_ag1    UUID := '00000000-0000-4000-8000-0000000fa003';
  u_ag2    UUID := '00000000-0000-4000-8000-0000000fa004';
  u_other  UUID := '00000000-0000-4000-8000-0000000fa005';
  a_acct   UUID;
  b_acct   UUID;
  w1       UUID;
  m1       UUID;
  conv     UUID[] := '{}';
  ct       UUID;
  cv       UUID;
  i        INT;
  t0       TIMESTAMPTZ := date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                          - interval '5 days' + interval '10 hours';
  today0   TIMESTAMPTZ := date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  step     INTERVAL;
  r_from   TIMESTAMPTZ;
  r_to     TIMESTAMPTZ;
  rep      JSONB;
  s1       JSONB;
  s2       JSONB;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
  -- Account C (073).
  u_c0     UUID := '00000000-0000-4000-8000-0000000fc000';
  u_c1     UUID := '00000000-0000-4000-8000-0000000fc001';
  u_c2     UUID := '00000000-0000-4000-8000-0000000fc002';
  u_c3     UUID := '00000000-0000-4000-8000-0000000fc003';
  u_c4     UUID := '00000000-0000-4000-8000-0000000fc004';
  u_c5     UUID := '00000000-0000-4000-8000-0000000fc005';
  u_c6     UUID := '00000000-0000-4000-8000-0000000fc006';
  u_c7     UUID := '00000000-0000-4000-8000-0000000fc007';
  u_c8     UUID := '00000000-0000-4000-8000-0000000fc008';
  u_c9     UUID := '00000000-0000-4000-8000-0000000fc009';
  u_c10    UUID := '00000000-0000-4000-8000-0000000fc010';
  c_acct   UUID;
  wa       UUID;
  wb       UUID;
  mc       UUID;
  wd       UUID;
  c_del    UUID;
  m_del    UUID;
  c_old    UUID;
  c_new    UUID;
  m_old    UUID;
  m_new    UUID;
  m_meta   UUID;
  mid      UUID;
  tt       TIMESTAMPTZ;
  tstep    INTERVAL;
  cfrom    TIMESTAMPTZ;
  cto      TIMESTAMPTZ;
  nb       JSONB;
BEGIN
  -- Everything below is undone by the sentinel at the end of this block.
  BEGIN
  -- ---------------------------------------------------------------
  -- Helpers: run a statement as a role (and signed-in user) and report
  -- 'ok' / its value, or the error text. The inner block is a
  -- subtransaction, so the role switch rolls back with an error.
  -- ---------------------------------------------------------------
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ta_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', p_role)::text, true);
        EXECUTE format('SET LOCAL ROLE %I', p_role);
        EXECUTE p_sql;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ok';
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        RETURN SQLERRM;
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ta_val(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', p_role)::text, true);
        EXECUTE format('SET LOCAL ROLE %I', p_role);
        EXECUTE p_sql INTO v;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN v;
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        RETURN 'ERROR: ' || SQLERRM;
      END;
    END $body$
  $fn$;
  -- A sender's row of a report.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ta_sender(p_rep jsonb, p_kind text, p_uid uuid)
    RETURNS jsonb LANGUAGE sql AS $body$
      SELECT e FROM jsonb_array_elements(p_rep -> 'senders') e
      WHERE e ->> 'kind' = p_kind
        AND (e ->> 'user_id') IS NOT DISTINCT FROM p_uid::text
    $body$
  $fn$;

  -- ---------------------------------------------------------------
  -- Fixture: account A (owner, admin, two agents), account B (owner).
  -- ---------------------------------------------------------------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'ta-owner@example.invalid'),
    (u_admin, 'ta-admin@example.invalid'),
    (u_ag1,   'ta-agent1@example.invalid'),
    (u_ag2,   'ta-agent2@example.invalid'),
    (u_other, 'ta-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_other;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin', full_name = 'Ada Admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent', full_name = 'Agent One' WHERE user_id = u_ag1;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent', full_name = 'Agent Two' WHERE user_id = u_ag2;

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, waba_id, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'TA-WHAPI-1', 'x', '971500000099', 'connected', true)
  RETURNING id INTO w1;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, waba_id, status, is_primary)
  VALUES (u_owner, a_acct, 'meta', 'TA-META-1', 'x', 'TA-WABA', 'connected', false)
  RETURNING id INTO m1;

  -- Twenty conversations, one contact each (index 1..20).
  FOR i IN 1..20 LOOP
    INSERT INTO contacts (account_id, user_id, phone, name)
    VALUES (a_acct, u_owner, '9715000010' || lpad(i::text, 2, '0'), 'TA contact ' || i)
    RETURNING id INTO ct;
    INSERT INTO conversations (account_id, user_id, contact_id, channel_id)
    VALUES (a_acct, u_owner, ct, w1)
    RETURNING id INTO cv;
    conv := conv || cv;
  END LOOP;

  INSERT INTO team_activity_settings (account_id, timezone) VALUES (a_acct, 'UTC');

  -- conv1: ag1 opens a new contact at t0, the customer answers an hour
  -- later, ag1 replies an hour after that (60-minute response).
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text, created_at, channel_id) VALUES
    (conv[1], 'agent', u_ag1, 'Good morning, following up on your enquiry', t0, w1),
    (conv[1], 'customer', NULL, 'Hi, yes please', t0 + interval '1 hour', w1),
    (conv[1], 'agent', u_ag1, 'Great, here are the details', t0 + interval '2 hours', w1);
  -- conv2: ag1 sends four in a row to a new contact, no answer, then a
  -- fifth that WhatsApp refused (a failure, not part of the run).
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text, created_at, channel_id, status) VALUES
    (conv[2], 'agent', u_ag1, 'Hello, are you interested in our offer?', t0 + interval '5 minutes', w1, 'read'),
    (conv[2], 'agent', u_ag1, 'Just checking in', t0 + interval '10 minutes', w1, 'delivered'),
    (conv[2], 'agent', u_ag1, 'Any thoughts?', t0 + interval '15 minutes', w1, 'sent'),
    (conv[2], 'agent', u_ag1, 'Last reminder', t0 + interval '20 minutes', w1, 'sent'),
    (conv[2], 'agent', u_ag1, 'Really the last one', t0 + interval '25 minutes', w1, 'failed');
  -- conv3: a customer wrote three days before; ag2 answers late. The
  -- customer wrote last, so it is a reply, not a start.
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text, created_at, channel_id) VALUES
    (conv[3], 'customer', NULL, 'Do you deliver?', t0 - interval '3 days', w1),
    (conv[3], 'agent', u_ag2, 'Sorry for the delay, yes we do', t0, w1),
    (conv[3], 'customer', NULL, 'Thanks', t0 + interval '30 minutes', w1);
  -- conv4: ag1 opens a new contact with a link; no answer.
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text, created_at, channel_id) VALUES
    (conv[4], 'agent', u_ag1, 'See our catalogue https://example.com/catalogue', t0 + interval '1 minute', w1);
  -- conv5..conv9: ag2 sends the same opener to five new contacts
  -- inside four minutes; nobody answers.
  FOR i IN 5..9 LOOP
    INSERT INTO messages (conversation_id, sender_type, sender_id, content_text, created_at, channel_id)
    VALUES (conv[i], 'agent', u_ag2, 'Hello  this is ACME   offering great deals today',
            t0 + interval '30 minutes' + (i - 5) * interval '1 minute', w1);
  END LOOP;
  -- conv10: a bot opens a chat. conv11: an API send on the Meta number.
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text, created_at, channel_id) VALUES
    (conv[10], 'bot', NULL, 'Automated reminder for your appointment', t0, w1),
    (conv[11], 'agent', NULL, 'Your document is ready for collection', t0, m1);
  -- conv12: ag1 opens a new contact at 03:00 (quiet hours 22-8); answered.
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text, created_at, channel_id) VALUES
    (conv[12], 'agent', u_ag1, 'Hello from the night shift team', t0 - interval '7 hours', w1),
    (conv[12], 'customer', NULL, 'Hi', t0 - interval '6 hours', w1);
  -- conv13: ag2 writes once a day for three days; only the last is answered.
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text, created_at, channel_id) VALUES
    (conv[13], 'agent', u_ag2, 'Day one: special price for you', t0 - interval '2 days' + interval '2 hours', w1),
    (conv[13], 'agent', u_ag2, 'Day two: special price still on', t0 - interval '1 day' + interval '2 hours', w1),
    (conv[13], 'agent', u_ag2, 'Day three: last day of the price', t0 + interval '2 hours', w1),
    (conv[13], 'customer', NULL, 'OK tell me more', t0 + interval '3 hours', w1);

  -- conv20: an older row that recorded only its provider, in a thread
  -- with no number, sent before the account's Whapi number existed:
  -- no number can be named for it, so it is unattributed (073).
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_owner, '971500002001', 'TA contact 20')
  RETURNING id INTO ct;
  INSERT INTO conversations (account_id, user_id, contact_id)
  VALUES (a_acct, u_owner, ct)
  RETURNING id INTO cv;
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text, created_at, provider)
  VALUES (cv, 'agent', u_ag2, 'An opener from before numbers were recorded', t0 + interval '3 hours', 'whapi');

  -- conv18: ag2's opener to a new contact that WhatsApp refused: a
  -- failure, not a start.
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text, created_at, channel_id, status) VALUES
    (conv[18], 'agent', u_ag2, 'Hello, a message that never arrived', t0 + interval '4 hours', w1, 'failed');

  -- Today: ag1 opens conv14..16 on w1 (spaced inside today so far), and
  -- ag2 opens conv19 on the Meta number, which the per-person limit
  -- does not count.
  step := (now() - today0) / 10;
  FOR i IN 14..16 LOOP
    INSERT INTO messages (conversation_id, sender_type, sender_id, content_text, created_at, channel_id)
    VALUES (conv[i], 'agent', u_ag1, 'Hello, today opener number ' || i, today0 + (i - 13) * step, w1);
  END LOOP;
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text, created_at, channel_id)
  VALUES (conv[19], 'agent', u_ag2, 'Your template-started chat on Meta', today0 + 5 * step, m1);

  r_from := t0 - interval '3 days';
  r_to   := t0 + interval '1 day';

  -- ---------------------------------------------------------------
  -- The report
  -- ---------------------------------------------------------------
  r := pg_temp.ta_val('authenticated', u_ag1,
         format('SELECT team_activity_report(%L, %L, %L, NULL)::text', r_from, r_to, 'UTC'));
  n := n + 1;
  IF r NOT LIKE '%Only owners and admins%' THEN
    failed := array_append(failed, ('agent read the report: ' || left(r, 120))::text);
  END IF;

  r := pg_temp.ta_val('authenticated', u_admin,
         format('SELECT team_activity_report(%L, %L, %L, NULL)::text', r_from, r_to, 'UTC'));
  IF r LIKE 'ERROR:%' THEN
    RAISE EXCEPTION 'admin report failed: %', r;
  END IF;
  rep := r::jsonb;

  s1 := pg_temp.ta_sender(rep, 'person', u_ag1);
  s2 := pg_temp.ta_sender(rep, 'person', u_ag2);

  n := n + 1;
  IF s1 IS NULL OR s2 IS NULL THEN
    failed := array_append(failed, 'report lacks a row for an agent'::text);
  ELSE
    n := n + 1;
    IF (s1 ->> 'chats_started')::int <> 4 OR (s1 ->> 'new_contacts')::int <> 4
       OR (s1 ->> 'no_reply')::int <> 2 THEN
      failed := array_append(failed, ('ag1 starts/new/no_reply: ' || s1::text)::text);
    END IF;
    n := n + 1;
    IF (s1 ->> 'links_first')::int <> 1 OR (s1 ->> 'night_starts')::int <> 1 THEN
      failed := array_append(failed, ('ag1 links/night: ' || s1::text)::text);
    END IF;
    n := n + 1;
    IF (s1 ->> 'unanswered_over_limit')::int <> 1 OR (s1 ->> 'unanswered_chats')::int <> 1
       OR (s1 ->> 'max_unanswered_run')::int <> 4 THEN
      failed := array_append(failed, ('ag1 unanswered run: ' || s1::text)::text);
    END IF;
    n := n + 1;
    IF (s1 ->> 'messages_sent')::int <> 9 OR (s1 ->> 'failed')::int <> 1
       OR (s1 ->> 'delivered')::int <> 2 OR (s1 ->> 'read')::int <> 1 THEN
      failed := array_append(failed, ('ag1 messages/status: ' || s1::text)::text);
    END IF;
    n := n + 1;
    IF (s1 ->> 'replies')::int <> 1 OR (s1 ->> 'response_median_min')::numeric <> 60 THEN
      failed := array_append(failed, ('ag1 response time: ' || s1::text)::text);
    END IF;
    n := n + 1;
    IF (s1 ->> 'burst_10min')::int <> 3 OR (s1 ->> 'peak_day')::int <> 4
       OR (s1 ->> 'days_over_limit')::int <> 0 THEN
      failed := array_append(failed, ('ag1 burst/peak: ' || s1::text)::text);
    END IF;
    n := n + 1;
    IF (s1 ->> 'today_starts')::int <> 3 THEN
      failed := array_append(failed, ('ag1 today: ' || s1::text)::text);
    END IF;

    -- conv3 (a late answer to the customer) and conv18 (refused) are
    -- not starts; conv20 (no number recorded) is.
    n := n + 1;
    IF (s2 ->> 'chats_started')::int <> 9 OR (s2 ->> 'new_contacts')::int <> 9
       OR (s2 ->> 'no_reply')::int <> 8 OR (s2 ->> 'failed')::int <> 1 THEN
      failed := array_append(failed, ('ag2 starts/new/no_reply/failed: ' || s2::text)::text);
    END IF;
    n := n + 1;
    IF (s2 ->> 'identical_openers')::int <> 5 OR (s2 ->> 'burst_10min')::int <> 5
       OR (s2 ->> 'peak_day')::int <> 7 THEN
      failed := array_append(failed, ('ag2 identical/burst/peak: ' || s2::text)::text);
    END IF;
    -- The Meta start today is not in the per-person count.
    n := n + 1;
    IF (s2 ->> 'today_starts')::int <> 0 THEN
      failed := array_append(failed, ('ag2 today counts a Meta start: ' || s2::text)::text);
    END IF;
    n := n + 1;
    IF (s2 ->> 'unanswered_over_limit')::int <> 0 THEN
      failed := array_append(failed, ('ag2 has no run past 3: ' || s2::text)::text);
    END IF;
  END IF;

  n := n + 1;
  IF coalesce((pg_temp.ta_sender(rep, 'bot', NULL) ->> 'chats_started')::int, -1) <> 1
     OR coalesce((pg_temp.ta_sender(rep, 'api', NULL) ->> 'chats_started')::int, -1) <> 1 THEN
    failed := array_append(failed, 'bot / api rows'::text);
  END IF;

  n := n + 1;
  IF (SELECT (e ->> 'chats_started')::int FROM jsonb_array_elements(rep -> 'numbers') e
       WHERE e ->> 'channel_id' = w1::text) <> 13
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(rep -> 'numbers') e
                 WHERE e ->> 'channel_id' IS NULL)
     OR (SELECT (e ->> 'chats_started')::int FROM jsonb_array_elements(rep -> 'numbers') e
          WHERE e ->> 'channel_id' = m1::text) <> 1
     OR (SELECT (e ->> 'today_starts')::int FROM jsonb_array_elements(rep -> 'numbers') e
          WHERE e ->> 'channel_id' = w1::text) <> 3
     OR (SELECT (e ->> 'today_starts')::int FROM jsonb_array_elements(rep -> 'numbers') e
          WHERE e ->> 'channel_id' = m1::text) <> 1 THEN
    failed := array_append(failed, ('per-number starts: ' || (rep -> 'numbers')::text)::text);
  END IF;
  -- conv20 recorded no number and none was unambiguous when it was
  -- sent (w1 is newer): it is counted once, as unattributed.
  n := n + 1;
  IF (rep ->> 'unattributed_starts')::int IS DISTINCT FROM 1 THEN
    failed := array_append(failed, ('unattributed starts: ' || coalesce(rep ->> 'unattributed_starts', 'null'))::text);
  END IF;

  n := n + 1;
  IF jsonb_array_length(rep -> 'hourly') <> 24
     OR (SELECT sum((e ->> 'started')::int) FROM jsonb_array_elements(rep -> 'daily') e) <> 15 THEN
    failed := array_append(failed, ('daily/hourly totals: ' || (rep -> 'daily')::text)::text);
  END IF;

  -- Narrowed to the Meta number: only the API start remains.
  rep := pg_temp.ta_val('authenticated', u_admin,
           format('SELECT team_activity_report(%L, %L, %L, %L)::text', r_from, r_to, 'UTC', m1))::jsonb;
  n := n + 1;
  IF coalesce((pg_temp.ta_sender(rep, 'person', u_ag1) ->> 'chats_started')::int, 0) <> 0
     OR coalesce((pg_temp.ta_sender(rep, 'api', NULL) ->> 'chats_started')::int, 0) <> 1 THEN
    failed := array_append(failed, 'channel filter'::text);
  END IF;

  -- Another account's owner sees none of A.
  rep := pg_temp.ta_val('authenticated', u_other,
           format('SELECT team_activity_report(%L, %L, %L, NULL)::text', r_from, r_to, 'UTC'))::jsonb;
  n := n + 1;
  IF pg_temp.ta_sender(rep, 'person', u_ag1) IS NOT NULL
     OR jsonb_array_length(rep -> 'numbers') <> 0 THEN
    failed := array_append(failed, 'cross-account report leak'::text);
  END IF;

  r := pg_temp.ta_val('authenticated', u_admin,
         format('SELECT team_activity_report(%L, %L, %L, NULL)::text', r_from, r_from + interval '200 days', 'UTC'));
  n := n + 1;
  IF r NOT LIKE '%shorter than 100 days%' THEN
    failed := array_append(failed, ('over-long range accepted: ' || left(r, 120))::text);
  END IF;

  -- ---------------------------------------------------------------
  -- Drill-down
  -- ---------------------------------------------------------------
  r := pg_temp.ta_val('authenticated', u_admin, format(
         $q$SELECT string_agg(contact_name || ':' || in_a_row, ',' ORDER BY contact_name)
              FROM team_activity_chats(%L, %L, 'person', %L, NULL, 'no_reply', 50)$q$,
         r_from, r_to, u_ag1));
  n := n + 1;
  IF r IS DISTINCT FROM 'TA contact 2:4,TA contact 4:1' THEN
    failed := array_append(failed, ('drill-down no_reply: ' || coalesce(r, 'null'))::text);
  END IF;

  r := pg_temp.ta_val('authenticated', u_admin, format(
         $q$SELECT string_agg(contact_name || ':' || in_a_row, ',')
              FROM team_activity_chats(%L, %L, 'person', %L, NULL, 'unanswered', 50)$q$,
         r_from, r_to, u_ag1));
  n := n + 1;
  IF r IS DISTINCT FROM 'TA contact 2:4' THEN
    failed := array_append(failed, ('drill-down unanswered: ' || coalesce(r, 'null'))::text);
  END IF;

  r := pg_temp.ta_val('authenticated', u_ag1, format(
         $q$SELECT count(*)::text FROM team_activity_chats(%L, %L, 'person', %L, NULL, 'all', 50)$q$,
         r_from, r_to, u_ag1));
  n := n + 1;
  IF r NOT LIKE '%Only owners and admins%' THEN
    failed := array_append(failed, ('agent read the drill-down: ' || coalesce(r, 'null'))::text);
  END IF;

  -- ---------------------------------------------------------------
  -- The employee's own day
  -- ---------------------------------------------------------------
  r := pg_temp.ta_val('authenticated', u_ag1, $q$SELECT team_activity_my_day('UTC')::text$q$);
  n := n + 1;
  IF r LIKE 'ERROR:%' OR (r::jsonb ->> 'started')::int <> 3
     OR (r::jsonb -> 'limits' ->> 'daily_new_chats_per_user')::int <> 20 THEN
    failed := array_append(failed, ('my_day ag1: ' || r)::text);
  END IF;
  -- ag2's only start today is on the Meta number: not counted.
  r := pg_temp.ta_val('authenticated', u_ag2, $q$SELECT team_activity_my_day('UTC')::text$q$);
  n := n + 1;
  IF r LIKE 'ERROR:%' OR (r::jsonb ->> 'started')::int <> 0 THEN
    failed := array_append(failed, ('my_day ag2: ' || r)::text);
  END IF;

  -- ---------------------------------------------------------------
  -- The block on new chats
  -- ---------------------------------------------------------------
  UPDATE team_activity_settings
     SET block_over_limit = true, daily_new_chats_per_user = 3, daily_new_chats_per_number = 50
   WHERE account_id = a_acct;

  r := pg_temp.ta_val('authenticated', u_ag1,
         format('SELECT team_activity_start_check(%L, %L)::text', conv[17], w1));
  n := n + 1;
  IF r NOT LIKE '%"blocked": true%' OR r NOT LIKE '%"reason": "user"%' THEN
    failed := array_append(failed, ('ag1 at the limit not blocked: ' || r)::text);
  END IF;
  r := pg_temp.ta_val('authenticated', u_ag1,
         format('SELECT team_activity_start_check(%L, %L)::text', conv[14], w1));
  n := n + 1;
  IF r NOT LIKE '%"blocked": false%' THEN
    failed := array_append(failed, ('a reply was blocked: ' || r)::text);
  END IF;
  -- conv3's customer wrote last, five days ago: answering is a reply.
  r := pg_temp.ta_val('authenticated', u_ag1,
         format('SELECT team_activity_start_check(%L, %L)::text', conv[3], w1));
  n := n + 1;
  IF r NOT LIKE '%"blocked": false%' THEN
    failed := array_append(failed, ('a late reply to the customer was blocked: ' || r)::text);
  END IF;
  -- conv2's last word was ours, days ago (the refused send aside): a start.
  r := pg_temp.ta_val('authenticated', u_ag1,
         format('SELECT team_activity_start_check(%L, %L)::text', conv[2], w1));
  n := n + 1;
  IF r NOT LIKE '%"blocked": true%' THEN
    failed := array_append(failed, ('a new start after silence was let through: ' || r)::text);
  END IF;
  r := pg_temp.ta_val('authenticated', u_ag2,
         format('SELECT team_activity_start_check(%L, %L)::text', conv[17], w1));
  n := n + 1;
  IF r NOT LIKE '%"blocked": false%' THEN
    failed := array_append(failed, ('ag2 under the limit blocked: ' || r)::text);
  END IF;
  -- A limit of 1: ag2's Meta start today must not count against it.
  UPDATE team_activity_settings SET daily_new_chats_per_user = 1 WHERE account_id = a_acct;
  r := pg_temp.ta_val('authenticated', u_ag2,
         format('SELECT team_activity_start_check(%L, %L)::text', conv[17], w1));
  n := n + 1;
  IF r NOT LIKE '%"blocked": false%' THEN
    failed := array_append(failed, ('a Meta start counted against the Whapi limit: ' || r)::text);
  END IF;
  UPDATE team_activity_settings SET daily_new_chats_per_user = 3 WHERE account_id = a_acct;
  r := pg_temp.ta_val('authenticated', u_other,
         format('SELECT team_activity_start_check(%L, %L)::text', conv[17], w1));
  n := n + 1;
  IF r NOT LIKE '%"blocked": false%' THEN
    failed := array_append(failed, ('cross-account check: ' || r)::text);
  END IF;

  UPDATE team_activity_settings
     SET daily_new_chats_per_user = 100, daily_new_chats_per_number = 3
   WHERE account_id = a_acct;
  r := pg_temp.ta_val('authenticated', u_ag2,
         format('SELECT team_activity_start_check(%L, %L)::text', conv[17], w1));
  n := n + 1;
  IF r NOT LIKE '%"reason": "number"%' THEN
    failed := array_append(failed, ('number at its limit not blocked: ' || r)::text);
  END IF;
  r := pg_temp.ta_val('authenticated', u_ag2,
         format('SELECT team_activity_start_check(%L, %L)::text', conv[17], m1));
  n := n + 1;
  IF r NOT LIKE '%"blocked": false%' THEN
    failed := array_append(failed, ('another number blocked: ' || r)::text);
  END IF;
  -- Owners and admins are never refused, even on a number at its limit.
  r := pg_temp.ta_val('authenticated', u_admin,
         format('SELECT team_activity_start_check(%L, %L)::text', conv[17], w1));
  n := n + 1;
  IF r NOT LIKE '%"blocked": false%' THEN
    failed := array_append(failed, ('an admin was blocked: ' || r)::text);
  END IF;

  UPDATE team_activity_settings SET block_over_limit = false WHERE account_id = a_acct;
  r := pg_temp.ta_val('authenticated', u_ag2,
         format('SELECT team_activity_start_check(%L, %L)::text', conv[17], w1));
  n := n + 1;
  IF r NOT LIKE '%"blocked": false%' THEN
    failed := array_append(failed, ('blocked with the switch off: ' || r)::text);
  END IF;

  -- ---------------------------------------------------------------
  -- The alert sweep: once per person / number per day
  -- ---------------------------------------------------------------
  -- Nothing until an admin has saved the limits, even far past the
  -- defaults: 21 chats today for ag2 with no settings row. Undone by
  -- the subtransaction (the variables keep the verdict).
  BEGIN
    DELETE FROM team_activity_settings WHERE account_id = a_acct;
    FOR i IN 1..21 LOOP
      INSERT INTO contacts (account_id, user_id, phone, name)
      VALUES (a_acct, u_owner, '9715000030' || lpad(i::text, 2, '0'), 'TA extra ' || i)
      RETURNING id INTO ct;
      INSERT INTO conversations (account_id, user_id, contact_id, channel_id)
      VALUES (a_acct, u_owner, ct, w1)
      RETURNING id INTO cv;
      INSERT INTO messages (conversation_id, sender_type, sender_id, content_text, created_at, channel_id)
      VALUES (cv, 'agent', u_ag2, 'Hello there, opener ' || i, today0 + (6 + i * 0.1) * step, w1);
    END LOOP;
    r := pg_temp.ta_val('service_role', NULL, 'SELECT team_activity_alert_sweep()::text');
    n := n + 1;
    IF r LIKE 'ERROR:%' OR (SELECT count(*) FROM team_activity_alerts WHERE account_id = a_acct) <> 0 THEN
      failed := array_append(failed, ('alerted before the limits were saved: ' || r)::text);
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'TA001';
  EXCEPTION WHEN SQLSTATE 'TA001' THEN
    NULL;
  END;
  UPDATE team_activity_settings
     SET daily_new_chats_per_user = 2, daily_new_chats_per_number = 3
   WHERE account_id = a_acct;

  r := pg_temp.ta_try('authenticated', u_admin, 'SELECT team_activity_alert_sweep()');
  n := n + 1;
  IF r NOT LIKE '%permission denied%' THEN
    failed := array_append(failed, ('an admin ran the sweep: ' || r)::text);
  END IF;

  r := pg_temp.ta_val('service_role', NULL, 'SELECT team_activity_alert_sweep()::text');
  n := n + 1;
  IF r LIKE 'ERROR:%' THEN
    failed := array_append(failed, ('sweep failed: ' || r)::text);
  END IF;
  n := n + 1;
  IF (SELECT count(*) FROM team_activity_alerts WHERE account_id = a_acct) <> 2 THEN
    failed := array_append(failed, ('alerts recorded: ' || (SELECT count(*) FROM team_activity_alerts WHERE account_id = a_acct))::text);
  END IF;
  n := n + 1;
  IF (SELECT count(*) FROM notifications
       WHERE account_id = a_acct AND type = 'team_activity_alert' AND user_id = u_ag1
         AND title LIKE 'You have reached%') <> 1
     OR (SELECT count(*) FROM notifications
          WHERE account_id = a_acct AND type = 'team_activity_alert' AND user_id = u_admin) <> 2
     OR (SELECT count(*) FROM notifications
          WHERE account_id = a_acct AND type = 'team_activity_alert' AND user_id = u_ag2) <> 0 THEN
    failed := array_append(failed, 'alert recipients'::text);
  END IF;

  PERFORM pg_temp.ta_val('service_role', NULL, 'SELECT team_activity_alert_sweep()::text');
  n := n + 1;
  IF (SELECT count(*) FROM notifications WHERE account_id = a_acct AND type = 'team_activity_alert') <> 5 THEN
    failed := array_append(failed, 'the second sweep alerted again'::text);
  END IF;

  -- ---------------------------------------------------------------
  -- Settings: admins only, a real time zone, own account only
  -- ---------------------------------------------------------------
  r := pg_temp.ta_try('authenticated', u_ag1,
         format('UPDATE team_activity_settings SET min_reply_rate = 5 WHERE account_id = %L', a_acct));
  n := n + 1;
  IF (SELECT min_reply_rate FROM team_activity_settings WHERE account_id = a_acct) = 5 THEN
    failed := array_append(failed, 'an agent changed the limits'::text);
  END IF;
  r := pg_temp.ta_try('authenticated', u_admin,
         format('UPDATE team_activity_settings SET timezone = %L WHERE account_id = %L', 'Mars/Olympus', a_acct));
  n := n + 1;
  IF r NOT LIKE '%time zone%' THEN
    failed := array_append(failed, ('unknown time zone accepted: ' || r)::text);
  END IF;
  -- A POSIX offset is not a named zone: Postgres would read its sign
  -- the opposite way to the browser.
  r := pg_temp.ta_try('authenticated', u_admin,
         format('UPDATE team_activity_settings SET timezone = %L WHERE account_id = %L', '+04', a_acct));
  n := n + 1;
  IF r NOT LIKE '%time zone%' THEN
    failed := array_append(failed, ('offset time zone accepted: ' || r)::text);
  END IF;
  n := n + 1;
  IF team_activity_valid_zone('+04') IS NOT NULL
     OR team_activity_valid_zone('Asia/Dubai') IS DISTINCT FROM 'Asia/Dubai' THEN
    failed := array_append(failed, 'team_activity_valid_zone'::text);
  END IF;
  r := pg_temp.ta_try('authenticated', u_admin,
         format('UPDATE team_activity_settings SET timezone = %L WHERE account_id = %L', 'Asia/Dubai', a_acct));
  n := n + 1;
  IF r <> 'ok' OR (SELECT updated_by FROM team_activity_settings WHERE account_id = a_acct) IS DISTINCT FROM u_admin THEN
    failed := array_append(failed, ('admin could not save: ' || r)::text);
  END IF;
  r := pg_temp.ta_try('authenticated', u_other,
         format('INSERT INTO team_activity_settings (account_id) VALUES (%L)', a_acct));
  n := n + 1;
  IF r = 'ok' THEN
    failed := array_append(failed, 'another account wrote A''s limits'::text);
  END IF;
  r := pg_temp.ta_val('authenticated', u_other,
         format('SELECT count(*)::text FROM team_activity_limits(%L)', a_acct));
  n := n + 1;
  IF r <> '0' THEN
    failed := array_append(failed, ('limits of another account: ' || r)::text);
  END IF;

  n := n + 1;
  IF has_function_privilege('anon', 'public.team_activity_report(timestamptz, timestamptz, text, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.team_activity_my_day(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.team_activity_alert_sweep()', 'EXECUTE') THEN
    failed := array_append(failed, 'function grants too wide'::text);
  END IF;

  -- ===============================================================
  -- Account C: the 073 rules. Owner c0, agents c1..c10 (one per case,
  -- so the cases do not share figures), zone UTC, 2 new chats a person
  -- and 12 a number a day, 3 in a row. Numbers: wa (phone, 40 days
  -- old), wb (phone, 3 days old: warming up), mc (official, 40 days).
  -- ===============================================================
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ta_conv(p_acct uuid, p_owner uuid, p_channel uuid,
                                    p_name text, p_agent uuid DEFAULT NULL)
    RETURNS uuid LANGUAGE plpgsql AS $body$
    DECLARE v_ct uuid; v_cv uuid;
    BEGIN
      INSERT INTO contacts (account_id, user_id, phone, name)
      VALUES (p_acct, p_owner,
              '97156' || lpad((SELECT count(*) + 1 FROM contacts WHERE account_id = p_acct)::text, 7, '0'),
              p_name)
      RETURNING id INTO v_ct;
      INSERT INTO conversations (account_id, user_id, contact_id, channel_id, assigned_agent_id)
      VALUES (p_acct, p_owner, v_ct, p_channel, p_agent)
      RETURNING id INTO v_cv;
      RETURN v_cv;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ta_msg(p_conv uuid, p_type text, p_sender uuid, p_text text,
                                   p_at timestamptz, p_channel uuid,
                                   p_provider text DEFAULT 'whapi', p_status text DEFAULT 'sent')
    RETURNS uuid LANGUAGE plpgsql AS $body$
    DECLARE v_id uuid;
    BEGIN
      INSERT INTO messages (conversation_id, sender_type, sender_id, content_text,
                            created_at, channel_id, provider, status)
      VALUES (p_conv, p_type, p_sender, p_text, p_at, p_channel, p_provider, p_status)
      RETURNING id INTO v_id;
      UPDATE conversations SET last_message_at = greatest(coalesce(last_message_at, p_at), p_at)
       WHERE id = p_conv;
      RETURN v_id;
    END $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_c0, 'tc-owner@example.invalid'), (u_c1, 'tc-1@example.invalid'),
    (u_c2, 'tc-2@example.invalid'), (u_c3, 'tc-3@example.invalid'),
    (u_c4, 'tc-4@example.invalid'), (u_c5, 'tc-5@example.invalid'),
    (u_c6, 'tc-6@example.invalid'), (u_c7, 'tc-7@example.invalid'),
    (u_c8, 'tc-8@example.invalid'), (u_c9, 'tc-9@example.invalid'),
    (u_c10, 'tc-10@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO c_acct FROM profiles WHERE user_id = u_c0;
  IF c_acct IS NULL OR c_acct IN (a_acct, b_acct) THEN
    RAISE EXCEPTION 'fixture: account C was not provisioned';
  END IF;
  UPDATE profiles
     SET account_id = c_acct, account_role = 'agent', full_name = 'C agent ' || right(user_id::text, 2)
   WHERE user_id IN (u_c1, u_c2, u_c3, u_c4, u_c5, u_c6, u_c7, u_c8, u_c9, u_c10);

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, waba_id, status, is_primary, created_at)
  VALUES (u_c0, c_acct, 'whapi', 'TC-WHAPI-A', 'x', '971500000201', 'connected', true, now() - interval '40 days')
  RETURNING id INTO wa;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, waba_id, status, is_primary, created_at)
  VALUES (u_c0, c_acct, 'whapi', 'TC-WHAPI-B', 'x', '971500000202', 'connected', false, now() - interval '3 days')
  RETURNING id INTO wb;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, waba_id, status, is_primary, created_at)
  VALUES (u_c0, c_acct, 'meta', 'TC-META', 'x', 'TC-WABA', 'connected', false, now() - interval '40 days')
  RETURNING id INTO mc;
  INSERT INTO team_activity_settings
    (account_id, timezone, daily_new_chats_per_user, daily_new_chats_per_number, max_unanswered_in_row)
  VALUES (c_acct, 'UTC', 2, 12, 3);

  cfrom := today0 - interval '8 days';
  cto   := today0 + interval '1 day';
  -- Today's events are spread inside today so far.
  tstep := (now() - today0) / 20;

  -- D1. c1: a phone message with no number 30 days ago, when wa was the
  -- only phone number; two more yesterday, after wb was connected
  -- (ambiguous); and an official-number message with no number in a
  -- thread that is on wa now. The two old rows are older than every
  -- stamped message of their provider in this account (D2's first is 19
  -- days back, D10's official one 2): the backfill only fills rows from
  -- before the first stamp.
  c_old := pg_temp.ta_conv(c_acct, u_c0, NULL, 'C d1 old');
  m_old := pg_temp.ta_msg(c_old, 'agent', u_c1, 'Good morning, about your order',
                          today0 - interval '30 days' + interval '10 hours', NULL, 'whapi');
  FOR i IN 1..2 LOOP
    cv := pg_temp.ta_conv(c_acct, u_c0, NULL, 'C d1 new ' || i);
    mid := pg_temp.ta_msg(cv, 'agent', u_c1, 'Checking in about delivery ' || i,
                          today0 - interval '1 day' + interval '10 hours' + i * interval '1 minute', NULL, 'whapi');
    IF i = 1 THEN c_new := cv; m_new := mid; END IF;
  END LOOP;
  cv := pg_temp.ta_conv(c_acct, u_c0, wa, 'C d1 official');
  m_meta := pg_temp.ta_msg(cv, 'agent', u_c1, 'Your appointment is confirmed',
                           today0 - interval '30 days' + interval '10 hours', NULL, 'meta');

  -- D1 (deleted number). wd was a phone number from 20 days ago to
  -- before the range; its chat and messages were stamped, then the
  -- number was deleted (ON DELETE SET NULL on the three channel
  -- columns). Only wa existed when they were sent, but they come after
  -- the account's first stamped phone message, so they stay NULL.
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, waba_id, status, is_primary, created_at)
  VALUES (u_c0, c_acct, 'whapi', 'TC-WHAPI-D', 'x', '971500000203', 'connected', false, now() - interval '20 days')
  RETURNING id INTO wd;
  c_del := pg_temp.ta_conv(c_acct, u_c0, wd, 'C d1 deleted');
  PERFORM pg_temp.ta_msg(c_del, 'agent', u_c1, 'Hello, a note about your account',
                         today0 - interval '18 days' + interval '10 hours', wd, 'whapi');
  m_del := pg_temp.ta_msg(c_del, 'agent', u_c1, 'Following up on your account',
                          today0 - interval '15 days' + interval '10 hours', wd, 'whapi');
  DELETE FROM whatsapp_config WHERE id = wd;

  -- D2. c2: the customer wrote 11 days before the range; c2 then wrote
  -- three times before the range and once inside it: 4 in a row.
  cv := pg_temp.ta_conv(c_acct, u_c0, wa, 'C d2 run');
  PERFORM pg_temp.ta_msg(cv, 'customer', NULL, 'I would like to order', cfrom - interval '11 days', wa);
  PERFORM pg_temp.ta_msg(cv, 'agent', u_c2, 'Here is the price list', cfrom - interval '10 days', wa);
  PERFORM pg_temp.ta_msg(cv, 'agent', u_c2, 'Did you see the price list?', cfrom - interval '9 days', wa);
  PERFORM pg_temp.ta_msg(cv, 'agent', u_c2, 'Still interested?', cfrom - interval '8 days', wa);
  PERFORM pg_temp.ta_msg(cv, 'agent', u_c2, 'One more reminder about the price list', cfrom + interval '1 day', wa);

  -- D3. c3: an unanswered start 3 days ago (mature) and one today
  -- (pending).
  cv := pg_temp.ta_conv(c_acct, u_c0, wa, 'C d3 mature');
  PERFORM pg_temp.ta_msg(cv, 'agent', u_c3, 'Hello, a question about your visit',
                         today0 - interval '3 days' + interval '10 hours', wa);
  cv := pg_temp.ta_conv(c_acct, u_c0, wa, 'C d3 pending');
  PERFORM pg_temp.ta_msg(cv, 'agent', u_c3, 'Hello, a question about your booking',
                         today0 + 2 * tstep, wa);

  -- D9. The API answers a customer.
  cv := pg_temp.ta_conv(c_acct, u_c0, wa, 'C d9 api');
  PERFORM pg_temp.ta_msg(cv, 'customer', NULL, 'Is my document ready?',
                         today0 - interval '2 days' + interval '9 hours', wa);
  PERFORM pg_temp.ta_msg(cv, 'agent', NULL, 'Your document is ready for collection',
                         today0 - interval '2 days' + interval '9 hours 5 minutes', wa);

  -- D5. c4: exactly 2 new chats in a day (the limit). wa: exactly 12 in
  -- a day (its limit), opened by the API.
  FOR i IN 1..2 LOOP
    cv := pg_temp.ta_conv(c_acct, u_c0, wa, 'C d5 person ' || i);
    PERFORM pg_temp.ta_msg(cv, 'agent', u_c4, 'Hello, our new branch opened ' || i,
                           today0 - interval '4 days' + interval '10 hours' + i * interval '30 minutes', wa);
  END LOOP;
  FOR i IN 1..12 LOOP
    cv := pg_temp.ta_conv(c_acct, u_c0, wa, 'C d5 number ' || i);
    PERFORM pg_temp.ta_msg(cv, 'agent', NULL, 'Your delivery is scheduled ' || i,
                           today0 - interval '6 days' + interval '11 hours' + i * interval '1 minute', wa);
  END LOOP;

  -- D6. Today: the API opens 10 chats on wb (warming up: limit 10);
  -- c5 opens exactly 2 on wa (the person limit).
  FOR i IN 1..10 LOOP
    cv := pg_temp.ta_conv(c_acct, u_c0, wb, 'C d6 api ' || i);
    PERFORM pg_temp.ta_msg(cv, 'agent', NULL, 'Your reminder for today ' || i,
                           today0 + (3 + i * 0.5) * tstep, wb);
  END LOOP;
  FOR i IN 1..2 LOOP
    cv := pg_temp.ta_conv(c_acct, u_c0, wa, 'C d6 person ' || i);
    PERFORM pg_temp.ta_msg(cv, 'agent', u_c5, 'Hello, welcome offer ' || i,
                           today0 + (8 + i) * tstep, wa);
  END LOOP;

  -- D7. c7, 3 in a row allowed. A new chat with 6 messages in 4 groups
  -- (follow-ups within 10 minutes are one); an existing chat with 4 an
  -- hour apart; a new chat with 4 inside 3 minutes (one group).
  tt := today0 - interval '2 days' + interval '8 hours';
  cv := pg_temp.ta_conv(c_acct, u_c0, wa, 'C d7 new chase');
  PERFORM pg_temp.ta_msg(cv, 'agent', u_c7, 'Hello, we have an offer for you', tt, wa);
  PERFORM pg_temp.ta_msg(cv, 'agent', u_c7, 'It ends this week', tt + interval '3 minutes', wa);
  PERFORM pg_temp.ta_msg(cv, 'agent', u_c7, 'Are you there?', tt + interval '1 hour', wa);
  PERFORM pg_temp.ta_msg(cv, 'agent', u_c7, 'Just checking', tt + interval '2 hours', wa);
  PERFORM pg_temp.ta_msg(cv, 'agent', u_c7, 'Please reply', tt + interval '2 hours 3 minutes', wa);
  PERFORM pg_temp.ta_msg(cv, 'agent', u_c7, 'Last message', tt + interval '3 hours', wa);
  cv := pg_temp.ta_conv(c_acct, u_c0, wa, 'C d7 existing chase');
  PERFORM pg_temp.ta_msg(cv, 'customer', NULL, 'Send me the details', tt - interval '1 day', wa);
  FOR i IN 0..3 LOOP
    PERFORM pg_temp.ta_msg(cv, 'agent', u_c7, 'Details part ' || i, tt + i * interval '1 hour', wa);
  END LOOP;
  cv := pg_temp.ta_conv(c_acct, u_c0, wa, 'C d7 one group');
  FOR i IN 0..3 LOOP
    PERFORM pg_temp.ta_msg(cv, 'agent', u_c7, 'Brochure page ' || i, tt + i * interval '1 minute', wa);
  END LOOP;

  -- D8. c8: two first messages that differ only in a name and numbers,
  -- and one that is different.
  tt := today0 - interval '1 day' + interval '14 hours';
  cv := pg_temp.ta_conv(c_acct, u_c0, wa, 'C d8 one');
  PERFORM pg_temp.ta_msg(cv, 'agent', u_c8, 'Hello Rahul, your order 1234 is ready for pickup', tt, wa);
  cv := pg_temp.ta_conv(c_acct, u_c0, wa, 'C d8 two');
  PERFORM pg_temp.ta_msg(cv, 'agent', u_c8, 'Hello Priya, your order 5678 is ready for pickup', tt + interval '5 minutes', wa);
  cv := pg_temp.ta_conv(c_acct, u_c0, wa, 'C d8 three');
  PERFORM pg_temp.ta_msg(cv, 'agent', u_c8, 'Good afternoon, we have a new catalogue for you', tt + interval '10 minutes', wa);

  -- D10. c9: one refused send on each kind of number.
  tt := today0 - interval '2 days' + interval '12 hours';
  cv := pg_temp.ta_conv(c_acct, u_c0, wa, 'C d10 phone');
  PERFORM pg_temp.ta_msg(cv, 'agent', u_c9, 'Hello, this did not arrive', tt, wa, 'whapi', 'failed');
  cv := pg_temp.ta_conv(c_acct, u_c0, mc, 'C d10 official');
  PERFORM pg_temp.ta_msg(cv, 'agent', u_c9, 'Hello, this did not arrive either', tt, mc, 'meta', 'failed');

  -- D11. Customers waiting on c10 for 2 hours, 3 days and 10 days, and
  -- one unassigned chat waiting for an hour.
  cv := pg_temp.ta_conv(c_acct, u_c0, wa, 'C d11 recent', u_c10);
  PERFORM pg_temp.ta_msg(cv, 'customer', NULL, 'Hello?', now() - interval '2 hours', wa);
  cv := pg_temp.ta_conv(c_acct, u_c0, wa, 'C d11 older', u_c10);
  PERFORM pg_temp.ta_msg(cv, 'customer', NULL, 'Hello?', now() - interval '3 days', wa);
  cv := pg_temp.ta_conv(c_acct, u_c0, wa, 'C d11 ignored', u_c10);
  PERFORM pg_temp.ta_msg(cv, 'customer', NULL, 'Hello?', now() - interval '10 days', wa);
  cv := pg_temp.ta_conv(c_acct, u_c0, wa, 'C d11 unassigned');
  PERFORM pg_temp.ta_msg(cv, 'customer', NULL, 'Hello?', now() - interval '1 hour', wa);

  -- ---------------------------------------------------------------
  -- D1: the backfill names a number only where one was unambiguous
  -- when the message was sent, and only fills NULLs.
  -- ---------------------------------------------------------------
  PERFORM team_activity_backfill_channels();
  n := n + 1;
  IF (SELECT channel_id FROM messages WHERE id = m_old) IS DISTINCT FROM wa
     OR (SELECT channel_id FROM conversations WHERE id = c_old) IS DISTINCT FROM wa THEN
    failed := array_append(failed, 'D1 backfill: an unambiguous old row was not given wa'::text);
  END IF;
  n := n + 1;
  IF (SELECT channel_id FROM messages WHERE id = m_new) IS NOT NULL
     OR (SELECT channel_id FROM conversations WHERE id = c_new) IS NOT NULL THEN
    failed := array_append(failed, 'D1 backfill: an ambiguous row was given a number'::text);
  END IF;
  n := n + 1;
  IF (SELECT channel_id FROM messages WHERE id = m_meta) IS DISTINCT FROM mc THEN
    failed := array_append(failed, 'D1 backfill: an official-number message took its thread''s phone number'::text);
  END IF;
  n := n + 1;
  IF (SELECT channel_id FROM messages WHERE id = m_del) IS NOT NULL
     OR EXISTS (SELECT 1 FROM messages WHERE conversation_id = c_del AND channel_id IS NOT NULL)
     OR (SELECT channel_id FROM conversations WHERE id = c_del) IS NOT NULL THEN
    failed := array_append(failed, 'D1 backfill: a deleted number''s message was given the surviving number'::text);
  END IF;
  n := n + 1;
  IF team_activity_backfill_channels() <> '{"messages": 0, "conversations": 0}'::jsonb THEN
    failed := array_append(failed, 'D1 backfill: a second run changed rows'::text);
  END IF;
  n := n + 1;
  IF team_activity_opener_key('Hello Rahul, your order 1234 https://x.example/y is ready!')
       IS DISTINCT FROM 'hello your order is ready' THEN
    failed := array_append(failed, ('D8 opener key: ' || coalesce(team_activity_opener_key(
      'Hello Rahul, your order 1234 https://x.example/y is ready!'), 'null'))::text);
  END IF;

  -- ---------------------------------------------------------------
  -- Account C report
  -- ---------------------------------------------------------------
  r := pg_temp.ta_val('authenticated', u_c0,
         format('SELECT team_activity_report(%L, %L, %L, NULL)::text', cfrom, cto, 'UTC'));
  IF r LIKE 'ERROR:%' THEN
    RAISE EXCEPTION 'account C report failed: %', r;
  END IF;
  rep := r::jsonb;

  -- D1: unattributed starts are counted once, outside the numbers, and
  -- still count against the person's daily limit (phone, by provider).
  n := n + 1;
  IF (rep ->> 'unattributed_starts')::int IS DISTINCT FROM 2
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(rep -> 'numbers') e WHERE e ->> 'channel_id' IS NULL) THEN
    failed := array_append(failed, ('D1 unattributed: ' || coalesce(rep ->> 'unattributed_starts', 'null'))::text);
  END IF;
  s1 := pg_temp.ta_sender(rep, 'person', u_c1);
  n := n + 1;
  IF (s1 ->> 'peak_day')::int IS DISTINCT FROM 2 OR (s1 ->> 'days_at_limit')::int IS DISTINCT FROM 1
     OR (s1 ->> 'days_over_limit')::int IS DISTINCT FROM 0 THEN
    failed := array_append(failed, ('D1/D5 c1 peak/at limit: ' || coalesce(s1::text, 'null'))::text);
  END IF;

  -- D2: the run that began before the range is counted whole.
  s1 := pg_temp.ta_sender(rep, 'person', u_c2);
  n := n + 1;
  IF (s1 ->> 'max_unanswered_run')::int IS DISTINCT FROM 4 THEN
    failed := array_append(failed, ('D2 run from its real start: ' || coalesce(s1::text, 'null'))::text);
  END IF;
  r := pg_temp.ta_val('authenticated', u_c0, format(
         $q$SELECT string_agg(contact_name || ':' || in_a_row, ',')
              FROM team_activity_chats(%L, %L, 'person', %L, NULL, 'unanswered', 50)$q$,
         cfrom, cto, u_c2));
  n := n + 1;
  IF r IS DISTINCT FROM 'C d2 run:4' THEN
    failed := array_append(failed, ('D2 drill-down: ' || coalesce(r, 'null'))::text);
  END IF;

  -- D3: a start younger than a day without a reply is pending.
  s1 := pg_temp.ta_sender(rep, 'person', u_c3);
  n := n + 1;
  IF (s1 ->> 'chats_started')::int IS DISTINCT FROM 2
     OR (s1 ->> 'mature_started')::int IS DISTINCT FROM 1
     OR (s1 ->> 'mature_no_reply')::int IS DISTINCT FROM 1
     OR (s1 ->> 'pending_reply')::int IS DISTINCT FROM 1 THEN
    failed := array_append(failed, ('D3 pending: ' || coalesce(s1::text, 'null'))::text);
  END IF;

  -- D9: the API gets no reply figures.
  s1 := pg_temp.ta_sender(rep, 'api', NULL);
  n := n + 1;
  IF s1 IS NULL OR jsonb_typeof(s1 -> 'replies') <> 'null'
     OR jsonb_typeof(s1 -> 'response_median_min') <> 'null' THEN
    failed := array_append(failed, ('D9 api replies: ' || coalesce(s1::text, 'null'))::text);
  END IF;

  -- D5: exactly at the limit counts as at the limit.
  s1 := pg_temp.ta_sender(rep, 'person', u_c4);
  n := n + 1;
  IF (s1 ->> 'days_at_limit')::int IS DISTINCT FROM 1 OR (s1 ->> 'days_over_limit')::int IS DISTINCT FROM 0 THEN
    failed := array_append(failed, ('D5 person at limit: ' || coalesce(s1::text, 'null'))::text);
  END IF;
  nb := (SELECT e FROM jsonb_array_elements(rep -> 'numbers') e WHERE e ->> 'channel_id' = wa::text);
  n := n + 1;
  IF (nb ->> 'kind') IS DISTINCT FROM 'phone' OR (nb ->> 'warming_up')::boolean IS DISTINCT FROM false
     OR (nb ->> 'effective_daily_limit')::int IS DISTINCT FROM 12
     OR (nb ->> 'peak_day')::int IS DISTINCT FROM 12
     OR (nb ->> 'days_at_limit')::int IS DISTINCT FROM 1
     OR (nb ->> 'days_over_limit')::int IS DISTINCT FROM 0 THEN
    failed := array_append(failed, ('D5 wa at limit: ' || coalesce(nb::text, 'null'))::text);
  END IF;

  -- D6: a 3-day-old phone number is warming up, limit 10.
  nb := (SELECT e FROM jsonb_array_elements(rep -> 'numbers') e WHERE e ->> 'channel_id' = wb::text);
  n := n + 1;
  IF (nb ->> 'warming_up')::boolean IS DISTINCT FROM true
     OR (nb ->> 'effective_daily_limit')::int IS DISTINCT FROM 10
     OR (nb ->> 'age_days')::int IS DISTINCT FROM 3
     OR (nb ->> 'today_started')::int IS DISTINCT FROM 10 THEN
    failed := array_append(failed, ('D6 wb warm-up: ' || coalesce(nb::text, 'null'))::text);
  END IF;
  -- Official numbers have no new-chat limit.
  nb := (SELECT e FROM jsonb_array_elements(rep -> 'numbers') e WHERE e ->> 'channel_id' = mc::text);
  n := n + 1;
  IF (nb ->> 'kind') IS DISTINCT FROM 'official'
     OR jsonb_typeof(nb -> 'effective_daily_limit') <> 'null'
     OR jsonb_typeof(nb -> 'days_at_limit') <> 'null' THEN
    failed := array_append(failed, ('D6 official number limit: ' || coalesce(nb::text, 'null'))::text);
  END IF;

  -- D7: follow-ups within 10 minutes are one step of a chase.
  s1 := pg_temp.ta_sender(rep, 'person', u_c7);
  n := n + 1;
  IF (s1 ->> 'chase_new')::int IS DISTINCT FROM 1
     OR (s1 ->> 'chase_existing')::int IS DISTINCT FROM 1
     OR (s1 ->> 'longest_chase')::int IS DISTINCT FROM 4
     OR (s1 ->> 'unanswered_chats')::int IS DISTINCT FROM 3
     OR (s1 ->> 'max_unanswered_run')::int IS DISTINCT FROM 6 THEN
    failed := array_append(failed, ('D7 chase: ' || coalesce(s1::text, 'null'))::text);
  END IF;

  -- D8: first messages that differ only in names and numbers are similar.
  s1 := pg_temp.ta_sender(rep, 'person', u_c8);
  n := n + 1;
  IF (s1 ->> 'similar_openers')::int IS DISTINCT FROM 2
     OR (s1 ->> 'identical_openers')::int IS DISTINCT FROM 0 THEN
    failed := array_append(failed, ('D8 similar: ' || coalesce(s1::text, 'null'))::text);
  END IF;

  -- D10: failures split by kind of number.
  s1 := pg_temp.ta_sender(rep, 'person', u_c9);
  n := n + 1;
  IF (s1 ->> 'failed')::int IS DISTINCT FROM 2
     OR (s1 ->> 'failed_phone')::int IS DISTINCT FROM 1
     OR (s1 ->> 'failed_official')::int IS DISTINCT FROM 1 THEN
    failed := array_append(failed, ('D10 failed split: ' || coalesce(s1::text, 'null'))::text);
  END IF;

  -- D11: waiting under a day, up to 7 days, older ignored.
  s1 := pg_temp.ta_sender(rep, 'person', u_c10);
  n := n + 1;
  IF (s1 ->> 'waiting_recent')::int IS DISTINCT FROM 1
     OR (s1 ->> 'waiting_older')::int IS DISTINCT FROM 1
     OR (s1 ->> 'waiting')::int IS DISTINCT FROM 2 THEN
    failed := array_append(failed, ('D11 person waiting: ' || coalesce(s1::text, 'null'))::text);
  END IF;
  n := n + 1;
  IF (rep ->> 'waiting_recent')::int IS DISTINCT FROM 2
     OR (rep ->> 'waiting_older')::int IS DISTINCT FROM 1
     OR (rep ->> 'waiting_unassigned_recent')::int IS DISTINCT FROM 1
     OR (rep ->> 'waiting_unassigned')::int IS DISTINCT FROM 1 THEN
    failed := array_append(failed, ('D11 waiting totals: ' || jsonb_build_object(
      'recent', rep -> 'waiting_recent', 'older', rep -> 'waiting_older',
      'unassigned', rep -> 'waiting_unassigned',
      'unassigned_recent', rep -> 'waiting_unassigned_recent')::text)::text);
  END IF;

  -- ---------------------------------------------------------------
  -- D5/D6: the block at the limit and at the warm-up limit
  -- ---------------------------------------------------------------
  UPDATE team_activity_settings SET block_over_limit = true WHERE account_id = c_acct;
  cv := pg_temp.ta_conv(c_acct, u_c0, NULL, 'C check');
  r := pg_temp.ta_val('authenticated', u_c6,
         format('SELECT team_activity_start_check(%L, %L)::text', cv, wb));
  n := n + 1;
  IF r NOT LIKE '%"blocked": true%' OR r NOT LIKE '%"reason": "number"%' OR r NOT LIKE '%"limit": 10%' THEN
    failed := array_append(failed, ('D6 warming-up number not blocked at 10: ' || r)::text);
  END IF;
  r := pg_temp.ta_val('authenticated', u_c6,
         format('SELECT team_activity_start_check(%L, %L)::text', cv, wa));
  n := n + 1;
  IF r NOT LIKE '%"blocked": false%' THEN
    failed := array_append(failed, ('D6 wa under its limit blocked: ' || r)::text);
  END IF;
  r := pg_temp.ta_val('authenticated', u_c5,
         format('SELECT team_activity_start_check(%L, %L)::text', cv, wa));
  n := n + 1;
  IF r NOT LIKE '%"blocked": true%' OR r NOT LIKE '%"reason": "user"%' THEN
    failed := array_append(failed, ('D5 person at exactly the limit not blocked: ' || r)::text);
  END IF;
  UPDATE team_activity_settings SET block_over_limit = false WHERE account_id = c_acct;

  -- ---------------------------------------------------------------
  -- D5/D6: bell alerts at the limit and at the warm-up limit
  -- ---------------------------------------------------------------
  r := pg_temp.ta_val('service_role', NULL, 'SELECT team_activity_alert_sweep()::text');
  n := n + 1;
  IF r LIKE 'ERROR:%'
     OR (SELECT count(*) FROM team_activity_alerts WHERE account_id = c_acct) <> 2
     OR NOT EXISTS (SELECT 1 FROM team_activity_alerts
                     WHERE account_id = c_acct AND kind = 'number_daily_limit'
                       AND subject_id = wb AND value = 10 AND threshold = 10)
     OR NOT EXISTS (SELECT 1 FROM team_activity_alerts
                     WHERE account_id = c_acct AND kind = 'user_daily_limit'
                       AND subject_id = u_c5 AND value = 2 AND threshold = 2) THEN
    failed := array_append(failed, ('D5/D6 sweep alerts: ' || coalesce((
      SELECT string_agg(kind || '/' || value || '/' || threshold, ',')
      FROM team_activity_alerts WHERE account_id = c_acct), 'none'))::text);
  END IF;
  n := n + 1;
  IF (SELECT count(*) FROM notifications
       WHERE account_id = c_acct AND type = 'team_activity_alert' AND user_id = u_c5
         AND title = 'You have reached today''s new-chat limit') <> 1
     OR (SELECT count(*) FROM notifications
          WHERE account_id = c_acct AND type = 'team_activity_alert' AND user_id = u_c0) <> 2 THEN
    failed := array_append(failed, 'D5/D6 alert notifications'::text);
  END IF;

    RAISE EXCEPTION USING ERRCODE = 'TA999';
  EXCEPTION WHEN SQLSTATE 'TA999' THEN
    NULL;  -- fixtures rolled back; n and failed keep the verdict
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'team activity verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'team activity verification passed (% checks)', n;
END
$verify$;
