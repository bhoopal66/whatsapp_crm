-- Behavioural regression suite for Team activity for team leaders
-- (migration 074).
--
-- `verify-team-activity.sql` asserts the account-wide report owners
-- and admins see. This file asserts the team scope: who a leader sees,
-- that every figure counts only their team's messages, the one
-- whole-number figure (number_today_started) and the helper behind it,
-- the drill-down's refusal outside the team, and the leaders' copies of
-- the bell alerts with their once-a-day dedup.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. Every fixture is rolled back at the end (the body raises a
-- sentinel the outer block catches; the verdict lives in variables), so
-- the file can be run again on the same database.
--
-- Fixture, all today (UTC), limits 2 a person and 5 a number:
--   team LT Alpha (leader la): a1, a2.  team LT Beta (leader lb): b1.
--   team LT Gamma (leader: the admin): x.
--   w1 allocated to Alpha and Beta, w2 to Beta, w3 to nobody.
--   starts on w1: a1 x2, la, x x2, the API, a bot (7)
--   starts on w3: x, a2 (2).  starts on w2: b1 (1).
--   customers write back in a1's and x's first chats (both assigned),
--   and open an unassigned chat on w2 owned by b1.
--   Then, rolled back on their own: a2 in x's chat, and a1's name on a
--   message in another account (the definer-rights checks).

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-0000000fd000';
  u_admin  UUID := '00000000-0000-4000-8000-0000000fd001';
  u_la     UUID := '00000000-0000-4000-8000-0000000fd002';
  u_lb     UUID := '00000000-0000-4000-8000-0000000fd003';
  u_a1     UUID := '00000000-0000-4000-8000-0000000fd004';
  u_a2     UUID := '00000000-0000-4000-8000-0000000fd005';
  u_b1     UUID := '00000000-0000-4000-8000-0000000fd006';
  u_x      UUID := '00000000-0000-4000-8000-0000000fd007';
  a_acct   UUID;
  w1       UUID;
  w2       UUID;
  w3       UUID;
  ta       UUID;
  tb       UUID;
  tc       UUID;
  cv       UUID;
  o_acct   UUID;
  o_w      UUID;
  today0   TIMESTAMPTZ := date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  step     INTERVAL;
  r_from   TIMESTAMPTZ;
  r_to     TIMESTAMPTZ;
  q        TEXT;
  adm      JSONB;
  lead     JSONB;
  rep      JSONB;
  r        TEXT;
  r2       TEXT;
  k        INT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  -- Everything below is undone by the sentinel at the end of this block.
  BEGIN
  -- ---------------------------------------------------------------
  -- Helpers
  -- ---------------------------------------------------------------
  -- Run a query as a role (and signed-in user): its value, or
  -- 'ERROR <sqlstate>: <message>'. The inner block is a subtransaction,
  -- so the role switch rolls back with an error.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.lt_val(p_role text, p_uid uuid, p_sql text)
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
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;
  -- A sender's row of a report.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.lt_sender(p_rep jsonb, p_kind text, p_uid uuid)
    RETURNS jsonb LANGUAGE sql AS $body$
      SELECT e FROM jsonb_array_elements(p_rep -> 'senders') e
      WHERE e ->> 'kind' = p_kind
        AND (e ->> 'user_id') IS NOT DISTINCT FROM p_uid::text
    $body$
  $fn$;
  -- A number's row of a report.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.lt_number(p_rep jsonb, p_channel uuid)
    RETURNS jsonb LANGUAGE sql AS $body$
      SELECT e FROM jsonb_array_elements(p_rep -> 'numbers') e
      WHERE e ->> 'channel_id' = p_channel::text
    $body$
  $fn$;
  -- The sorted ids of a report's rows: senders (kind:user_id) or numbers.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.lt_ids(p_rep jsonb, p_key text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT coalesce(string_agg(x, ',' ORDER BY x), '')
      FROM (
        SELECT CASE WHEN p_key = 'senders'
                    THEN (e ->> 'kind') || ':' || coalesce(e ->> 'user_id', '-')
                    ELSE e ->> 'channel_id' END AS x
        FROM jsonb_array_elements(p_rep -> p_key) e
      ) s
    $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.lt_conv(p_acct uuid, p_owner uuid, p_channel uuid,
                                    p_name text, p_agent uuid DEFAULT NULL)
    RETURNS uuid LANGUAGE plpgsql AS $body$
    DECLARE v_ct uuid; v_cv uuid;
    BEGIN
      INSERT INTO contacts (account_id, user_id, phone, name)
      VALUES (p_acct, p_owner,
              '97157' || lpad((SELECT count(*) + 1 FROM contacts WHERE account_id = p_acct)::text, 7, '0'),
              p_name)
      RETURNING id INTO v_ct;
      INSERT INTO conversations (account_id, user_id, contact_id, channel_id, assigned_agent_id)
      VALUES (p_acct, p_owner, v_ct, p_channel, p_agent)
      RETURNING id INTO v_cv;
      RETURN v_cv;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.lt_msg(p_conv uuid, p_type text, p_sender uuid, p_text text,
                                   p_at timestamptz, p_channel uuid)
    RETURNS void LANGUAGE plpgsql AS $body$
    BEGIN
      INSERT INTO messages (conversation_id, sender_type, sender_id, content_text,
                            created_at, channel_id, provider, status)
      VALUES (p_conv, p_type, p_sender, p_text, p_at, p_channel, 'whapi', 'sent');
      UPDATE conversations SET last_message_at = greatest(coalesce(last_message_at, p_at), p_at)
       WHERE id = p_conv;
    END $body$
  $fn$;

  -- ---------------------------------------------------------------
  -- Fixture
  -- ---------------------------------------------------------------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'lt-owner@example.invalid'), (u_admin, 'lt-admin@example.invalid'),
    (u_la, 'lt-la@example.invalid'), (u_lb, 'lt-lb@example.invalid'),
    (u_a1, 'lt-a1@example.invalid'), (u_a2, 'lt-a2@example.invalid'),
    (u_b1, 'lt-b1@example.invalid'), (u_x, 'lt-x@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin', full_name = 'LT Admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader', full_name = 'LT Lead A' WHERE user_id = u_la;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader', full_name = 'LT Lead B' WHERE user_id = u_lb;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent', full_name = 'LT Agent A1' WHERE user_id = u_a1;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent', full_name = 'LT Agent A2' WHERE user_id = u_a2;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent', full_name = 'LT Agent B1' WHERE user_id = u_b1;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent', full_name = 'LT Agent X' WHERE user_id = u_x;

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, waba_id, label, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'LT-074-W1', 'x', '971500074001', 'LT Number One', 'connected', true)
  RETURNING id INTO w1;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, waba_id, label, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'LT-074-W2', 'x', '971500074002', 'LT Number Two', 'connected', false)
  RETURNING id INTO w2;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, waba_id, label, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'LT-074-W3', 'x', '971500074003', 'LT Number Three', 'connected', false)
  RETURNING id INTO w3;

  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'LT Alpha', u_la) RETURNING id INTO ta;
  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'LT Beta', u_lb) RETURNING id INTO tb;
  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'LT Gamma', u_admin) RETURNING id INTO tc;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES
    (ta, u_a1, a_acct), (ta, u_a2, a_acct), (tb, u_b1, a_acct), (tc, u_x, a_acct);
  INSERT INTO whatsapp_channel_teams (config_id, team_id, account_id) VALUES
    (w1, ta, a_acct), (w1, tb, a_acct), (w2, tb, a_acct);

  INSERT INTO team_activity_settings (account_id, timezone, daily_new_chats_per_user, daily_new_chats_per_number)
  VALUES (a_acct, 'UTC', 2, 5);

  step := (now() - today0) / 40;
  cv := pg_temp.lt_conv(a_acct, u_a1, w1, 'LT c1', u_a1);
  PERFORM pg_temp.lt_msg(cv, 'agent', u_a1, 'Hello from A1, first', today0 + 1 * step, w1);
  PERFORM pg_temp.lt_msg(cv, 'customer', NULL, 'Hi A1', today0 + 3 * step, w1);
  cv := pg_temp.lt_conv(a_acct, u_a1, w1, 'LT c2');
  PERFORM pg_temp.lt_msg(cv, 'agent', u_a1, 'Hello from A1, second', today0 + 2 * step, w1);
  cv := pg_temp.lt_conv(a_acct, u_la, w1, 'LT c3');
  PERFORM pg_temp.lt_msg(cv, 'agent', u_la, 'Hello from the leader', today0 + 4 * step, w1);
  cv := pg_temp.lt_conv(a_acct, u_x, w1, 'LT c4', u_x);
  PERFORM pg_temp.lt_msg(cv, 'agent', u_x, 'Hello from X, first', today0 + 5 * step, w1);
  PERFORM pg_temp.lt_msg(cv, 'customer', NULL, 'Hi X', today0 + 6 * step, w1);
  cv := pg_temp.lt_conv(a_acct, u_x, w1, 'LT c5');
  PERFORM pg_temp.lt_msg(cv, 'agent', u_x, 'Hello from X, second', today0 + 7 * step, w1);
  cv := pg_temp.lt_conv(a_acct, u_x, w3, 'LT c6');
  PERFORM pg_temp.lt_msg(cv, 'agent', u_x, 'Hello from X, third', today0 + 8 * step, w3);
  cv := pg_temp.lt_conv(a_acct, u_owner, w1, 'LT c7');
  PERFORM pg_temp.lt_msg(cv, 'agent', NULL, 'Your order is ready', today0 + 9 * step, w1);
  cv := pg_temp.lt_conv(a_acct, u_owner, w1, 'LT c8');
  PERFORM pg_temp.lt_msg(cv, 'bot', NULL, 'Automated reminder', today0 + 10 * step, w1);
  cv := pg_temp.lt_conv(a_acct, u_a2, w3, 'LT c9');
  PERFORM pg_temp.lt_msg(cv, 'agent', u_a2, 'Hello from A2', today0 + 11 * step, w3);
  cv := pg_temp.lt_conv(a_acct, u_b1, w2, 'LT c10');
  PERFORM pg_temp.lt_msg(cv, 'agent', u_b1, 'Hello from B1', today0 + 12 * step, w2);
  cv := pg_temp.lt_conv(a_acct, u_b1, w2, 'LT c11');
  PERFORM pg_temp.lt_msg(cv, 'customer', NULL, 'Is anyone there?', today0 + 13 * step, w2);

  r_from := today0 - interval '1 day';
  r_to   := today0 + interval '1 day';
  q := format('SELECT team_activity_report(%L, %L, %L, NULL)::text', r_from, r_to, 'UTC');

  -- ---------------------------------------------------------------
  -- Owners and admins: the whole account, as 073
  -- ---------------------------------------------------------------
  r := pg_temp.lt_val('authenticated', u_admin, q);
  IF r IS NULL OR r LIKE 'ERROR%' THEN
    RAISE EXCEPTION 'admin report failed: %', r;
  END IF;
  adm := r::jsonb;

  n := n + 1;
  IF adm ->> 'scope' IS DISTINCT FROM 'account' OR adm -> 'team_names' IS DISTINCT FROM '[]'::jsonb THEN
    failed := array_append(failed, ('admin scope: ' || coalesce(adm ->> 'scope', 'null') || ' ' || coalesce(adm ->> 'team_names', 'null'))::text);
  END IF;
  n := n + 1;
  IF coalesce((pg_temp.lt_sender(adm, 'api', NULL) ->> 'chats_started')::int, -1) <> 1
     OR coalesce((pg_temp.lt_sender(adm, 'bot', NULL) ->> 'chats_started')::int, -1) <> 1
     OR coalesce((pg_temp.lt_sender(adm, 'person', u_x) ->> 'chats_started')::int, -1) <> 3 THEN
    failed := array_append(failed, 'admin api / bot / outsider rows'::text);
  END IF;
  n := n + 1;
  IF coalesce((pg_temp.lt_number(adm, w1) ->> 'chats_started')::int, -1) <> 7
     OR coalesce((pg_temp.lt_number(adm, w1) ->> 'today_starts')::int, -1) <> 7
     OR coalesce((pg_temp.lt_number(adm, w1) ->> 'received')::int, -1) <> 2
     OR pg_temp.lt_ids(adm, 'numbers') <> (SELECT string_agg(x::text, ',' ORDER BY x::text) FROM unnest(ARRAY[w1, w2, w3]) x)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(adm -> 'numbers') e WHERE e ? 'number_today_started') THEN
    failed := array_append(failed, ('admin numbers: ' || (adm -> 'numbers')::text)::text);
  END IF;
  n := n + 1;
  IF (adm ->> 'waiting_recent')::int IS DISTINCT FROM 3
     OR (adm ->> 'waiting_unassigned')::int IS DISTINCT FROM 1
     OR (SELECT sum((e ->> 'started')::int) FROM jsonb_array_elements(adm -> 'daily') e) <> 10 THEN
    failed := array_append(failed, ('admin waiting / daily: ' || jsonb_build_object(
      'waiting_recent', adm -> 'waiting_recent', 'unassigned', adm -> 'waiting_unassigned',
      'daily', adm -> 'daily')::text)::text);
  END IF;
  -- The owner sees what the admin sees.
  rep := pg_temp.lt_val('authenticated', u_owner, q)::jsonb;
  n := n + 1;
  IF rep - 'generated_at' IS DISTINCT FROM adm - 'generated_at' THEN
    failed := array_append(failed, 'owner and admin reports differ'::text);
  END IF;

  -- ---------------------------------------------------------------
  -- A team leader: their team only
  -- ---------------------------------------------------------------
  r := pg_temp.lt_val('authenticated', u_la, q);
  IF r IS NULL OR r LIKE 'ERROR%' THEN
    RAISE EXCEPTION 'leader report failed: %', r;
  END IF;
  lead := r::jsonb;

  n := n + 1;
  IF lead ->> 'scope' IS DISTINCT FROM 'team' OR lead -> 'team_names' IS DISTINCT FROM '["LT Alpha"]'::jsonb THEN
    failed := array_append(failed, ('leader scope: ' || coalesce(lead ->> 'scope', 'null') || ' ' || coalesce(lead ->> 'team_names', 'null'))::text);
  END IF;
  -- The team's members and the leader; not x, the other team, the owner or admin, the API or bots.
  n := n + 1;
  IF pg_temp.lt_ids(lead, 'senders')
     <> (SELECT string_agg('person:' || x::text, ',' ORDER BY 'person:' || x::text)
           FROM unnest(ARRAY[u_la, u_a1, u_a2]) x) THEN
    failed := array_append(failed, ('leader senders: ' || pg_temp.lt_ids(lead, 'senders'))::text);
  END IF;
  -- A member's own figures are the same in either view.
  n := n + 1;
  IF pg_temp.lt_sender(lead, 'person', u_a1) IS DISTINCT FROM pg_temp.lt_sender(adm, 'person', u_a1)
     OR pg_temp.lt_sender(lead, 'person', u_a2) IS DISTINCT FROM pg_temp.lt_sender(adm, 'person', u_a2)
     OR pg_temp.lt_sender(lead, 'person', u_la) IS DISTINCT FROM pg_temp.lt_sender(adm, 'person', u_la) THEN
    failed := array_append(failed, ('member rows differ: ' || coalesce(pg_temp.lt_sender(lead, 'person', u_a1)::text, 'null'))::text);
  END IF;
  n := n + 1;
  IF coalesce((pg_temp.lt_sender(lead, 'person', u_a1) ->> 'chats_started')::int, -1) <> 2
     OR coalesce((pg_temp.lt_sender(lead, 'person', u_a1) ->> 'waiting')::int, -1) <> 1 THEN
    failed := array_append(failed, ('leader a1 row: ' || coalesce(pg_temp.lt_sender(lead, 'person', u_a1)::text, 'null'))::text);
  END IF;
  -- Numbers: allocated to the team (w1) or used by it (w3); not w2.
  n := n + 1;
  IF pg_temp.lt_ids(lead, 'numbers') <> (SELECT string_agg(x::text, ',' ORDER BY x::text) FROM unnest(ARRAY[w1, w3]) x) THEN
    failed := array_append(failed, ('leader numbers: ' || pg_temp.lt_ids(lead, 'numbers'))::text);
  END IF;
  -- The team's own figures on each number...
  n := n + 1;
  IF coalesce((pg_temp.lt_number(lead, w1) ->> 'chats_started')::int, -1) <> 3
     OR coalesce((pg_temp.lt_number(lead, w1) ->> 'today_starts')::int, -1) <> 3
     OR coalesce((pg_temp.lt_number(lead, w1) ->> 'messages_sent')::int, -1) <> 3
     OR coalesce((pg_temp.lt_number(lead, w1) ->> 'received')::int, -1) <> 1
     OR coalesce((pg_temp.lt_number(lead, w3) ->> 'chats_started')::int, -1) <> 1 THEN
    failed := array_append(failed, ('leader number figures: ' || (lead -> 'numbers')::text)::text);
  END IF;
  -- ...and today's new chats on the whole number.
  n := n + 1;
  IF coalesce((pg_temp.lt_number(lead, w1) ->> 'number_today_started')::int, -1) <> 7
     OR coalesce((pg_temp.lt_number(lead, w3) ->> 'number_today_started')::int, -1) <> 2
     OR (pg_temp.lt_number(lead, w1) ->> 'number_today_started')
        IS DISTINCT FROM (pg_temp.lt_number(adm, w1) ->> 'today_starts') THEN
    failed := array_append(failed, ('number_today_started: ' || (lead -> 'numbers')::text)::text);
  END IF;
  -- Totals: the team's starts and waits only.
  n := n + 1;
  IF (SELECT sum((e ->> 'started')::int) FROM jsonb_array_elements(lead -> 'daily') e) <> 4
     OR (SELECT sum((e ->> 'started')::int) FROM jsonb_array_elements(lead -> 'hourly') e) <> 4
     OR (lead ->> 'waiting_recent')::int IS DISTINCT FROM 1
     OR (lead ->> 'waiting_unassigned')::int IS DISTINCT FROM 0
     OR (SELECT sum((e ->> 'received')::int) FROM jsonb_array_elements(lead -> 'daily') e) <> 1 THEN
    failed := array_append(failed, ('leader totals: ' || jsonb_build_object(
      'waiting_recent', lead -> 'waiting_recent', 'unassigned', lead -> 'waiting_unassigned',
      'daily', lead -> 'daily')::text)::text);
  END IF;
  -- The limits arrive read-only.
  n := n + 1;
  IF (lead -> 'limits' ->> 'daily_new_chats_per_user')::int IS DISTINCT FROM 2
     OR pg_temp.lt_val('authenticated', u_la,
          'WITH u AS (UPDATE team_activity_settings SET daily_new_chats_per_user = 99 RETURNING 1) SELECT count(*)::text FROM u')
        IS DISTINCT FROM '0' THEN
    failed := array_append(failed, 'leader limits'::text);
  END IF;

  -- The other leader: their own team, and the number shared with Alpha.
  rep := pg_temp.lt_val('authenticated', u_lb, q)::jsonb;
  n := n + 1;
  IF rep -> 'team_names' IS DISTINCT FROM '["LT Beta"]'::jsonb
     OR pg_temp.lt_ids(rep, 'senders')
        <> (SELECT string_agg('person:' || x::text, ',' ORDER BY 'person:' || x::text) FROM unnest(ARRAY[u_lb, u_b1]) x)
     OR pg_temp.lt_ids(rep, 'numbers') <> (SELECT string_agg(x::text, ',' ORDER BY x::text) FROM unnest(ARRAY[w1, w2]) x)
     OR coalesce((pg_temp.lt_number(rep, w1) ->> 'chats_started')::int, -1) <> 0
     OR coalesce((pg_temp.lt_number(rep, w1) ->> 'number_today_started')::int, -1) <> 7
     OR (rep ->> 'waiting_unassigned')::int IS DISTINCT FROM 1 THEN
    failed := array_append(failed, ('leader B report: ' || left(rep::text, 300))::text);
  END IF;

  -- An agent is refused.
  r := pg_temp.lt_val('authenticated', u_x, q);
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN
    failed := array_append(failed, ('agent read the report: ' || left(coalesce(r, 'null'), 120))::text);
  END IF;

  -- ---------------------------------------------------------------
  -- The whole-number helper
  -- ---------------------------------------------------------------
  r := pg_temp.lt_val('authenticated', u_x, format(
         'SELECT count(*)::text FROM team_activity_team_number_counts(%L, %L, %L)', r_from, r_to, 'UTC'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN
    failed := array_append(failed, ('agent read the number counts: ' || coalesce(r, 'null'))::text);
  END IF;
  r := pg_temp.lt_val('authenticated', u_la, format(
         $q$SELECT string_agg(x, ',' ORDER BY x)
              FROM (SELECT CASE channel_id WHEN %L::uuid THEN 'w1' WHEN %L::uuid THEN 'w2'
                                           WHEN %L::uuid THEN 'w3' ELSE 'other' END
                           || ':' || today_started AS x
                      FROM team_activity_team_number_counts(%L, %L, %L)) c$q$,
         w1, w2, w3, r_from, r_to, 'UTC'));
  n := n + 1;
  IF r IS DISTINCT FROM 'w1:7,w3:2' THEN
    failed := array_append(failed, ('leader number counts: ' || coalesce(r, 'null'))::text);
  END IF;
  n := n + 1;
  IF has_function_privilege('anon', 'public.team_activity_team_number_counts(timestamptz, timestamptz, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.team_activity_my_team()', 'EXECUTE') THEN
    failed := array_append(failed, 'anon may call the 074 helpers'::text);
  END IF;

  -- ---------------------------------------------------------------
  -- Drill-down
  -- ---------------------------------------------------------------
  r := pg_temp.lt_val('authenticated', u_la, format(
         $q$SELECT count(*)::text FROM team_activity_chats(%L, %L, 'person', %L, NULL, 'all', 50)$q$,
         r_from, r_to, u_b1));
  n := n + 1;
  IF r NOT LIKE 'ERROR 22023: Unknown sender%' THEN
    failed := array_append(failed, ('leader opened another team''s member: ' || coalesce(r, 'null'))::text);
  END IF;
  r := pg_temp.lt_val('authenticated', u_la, format(
         $q$SELECT count(*)::text FROM team_activity_chats(%L, %L, 'api', NULL, NULL, 'all', 50)$q$,
         r_from, r_to));
  n := n + 1;
  IF r NOT LIKE 'ERROR 22023: Unknown sender%' THEN
    failed := array_append(failed, ('leader opened the API: ' || coalesce(r, 'null'))::text);
  END IF;
  r := pg_temp.lt_val('authenticated', u_la, format(
         $q$SELECT string_agg(contact_name, ',' ORDER BY contact_name)
              FROM team_activity_chats(%L, %L, 'person', %L, NULL, 'all', 50)$q$,
         r_from, r_to, u_a1));
  r2 := pg_temp.lt_val('authenticated', u_admin, format(
         $q$SELECT string_agg(contact_name, ',' ORDER BY contact_name)
              FROM team_activity_chats(%L, %L, 'person', %L, NULL, 'all', 50)$q$,
         r_from, r_to, u_a1));
  n := n + 1;
  IF r IS NULL OR r LIKE 'ERROR%' OR r IS DISTINCT FROM r2 THEN
    failed := array_append(failed, ('leader drill-down of a member: ' || coalesce(r, 'null') || ' vs ' || coalesce(r2, 'null'))::text);
  END IF;
  r := pg_temp.lt_val('authenticated', u_x, format(
         $q$SELECT count(*)::text FROM team_activity_chats(%L, %L, 'person', %L, NULL, 'all', 50)$q$,
         r_from, r_to, u_x));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN
    failed := array_append(failed, ('agent read the drill-down: ' || coalesce(r, 'null'))::text);
  END IF;

  -- ---------------------------------------------------------------
  -- Bell alerts: a1 (2) and x (3) reach the person limit, w1 (7) the
  -- number limit.
  -- ---------------------------------------------------------------
  r := pg_temp.lt_val('service_role', NULL, 'SELECT team_activity_alert_sweep()::text');
  n := n + 1;
  IF r IS NULL OR r LIKE 'ERROR%' THEN
    failed := array_append(failed, ('sweep failed: ' || coalesce(r, 'null'))::text);
  END IF;
  -- The leader of a1's team, for a1 and for w1; nothing about x.
  n := n + 1;
  IF (SELECT count(*) FROM notifications WHERE account_id = a_acct AND type = 'team_activity_alert'
        AND user_id = u_la AND body LIKE 'LT Agent A1 %' AND title = 'Daily new-chat limit reached') <> 1
     OR (SELECT count(*) FROM notifications WHERE account_id = a_acct AND type = 'team_activity_alert'
           AND user_id = u_la AND body LIKE 'LT Number One %') <> 1
     OR (SELECT count(*) FROM notifications WHERE account_id = a_acct AND type = 'team_activity_alert'
           AND user_id = u_la) <> 2 THEN
    failed := array_append(failed, 'leader A alerts'::text);
  END IF;
  -- The other leader: only the number allocated to their team too.
  n := n + 1;
  IF (SELECT count(*) FROM notifications WHERE account_id = a_acct AND type = 'team_activity_alert'
        AND user_id = u_lb AND body LIKE 'LT Number One %') <> 1
     OR (SELECT count(*) FROM notifications WHERE account_id = a_acct AND type = 'team_activity_alert'
           AND user_id = u_lb) <> 1 THEN
    failed := array_append(failed, 'leader B alerts'::text);
  END IF;
  -- Owners and admins as in 073, once each: the admin who leads x's
  -- team gets no leader's copy on top.
  n := n + 1;
  IF (SELECT count(*) FROM notifications WHERE account_id = a_acct AND type = 'team_activity_alert'
        AND user_id = u_admin) <> 3
     OR (SELECT count(*) FROM notifications WHERE account_id = a_acct AND type = 'team_activity_alert'
           AND user_id = u_owner) <> 3
     OR (SELECT count(*) FROM notifications WHERE account_id = a_acct AND type = 'team_activity_alert'
           AND user_id = u_a1 AND title LIKE 'You have reached%') <> 1
     OR (SELECT count(*) FROM notifications WHERE account_id = a_acct AND type = 'team_activity_alert'
           AND user_id IN (u_a2, u_b1)) <> 0 THEN
    failed := array_append(failed, 'owner / admin / member alerts'::text);
  END IF;
  n := n + 1;
  IF (SELECT count(*) FROM team_activity_alerts WHERE account_id = a_acct
        AND recipient_id = '00000000-0000-0000-0000-000000000000') <> 3
     OR (SELECT count(*) FROM team_activity_alerts WHERE account_id = a_acct AND recipient_id = u_la) <> 2
     OR (SELECT count(*) FROM team_activity_alerts WHERE account_id = a_acct AND recipient_id = u_lb) <> 1
     OR (SELECT count(*) FROM team_activity_alerts WHERE account_id = a_acct) <> 6 THEN
    failed := array_append(failed, ('alert rows: ' || (SELECT count(*) FROM team_activity_alerts WHERE account_id = a_acct))::text);
  END IF;

  -- Once a day: a second sweep sends nothing.
  SELECT count(*) INTO k FROM notifications WHERE account_id = a_acct AND type = 'team_activity_alert';
  r := pg_temp.lt_val('service_role', NULL, 'SELECT team_activity_alert_sweep()::text');
  n := n + 1;
  IF (SELECT count(*) FROM notifications WHERE account_id = a_acct AND type = 'team_activity_alert') <> k
     OR k <> 11 OR (r::jsonb ->> 'notifications')::int IS DISTINCT FROM 0 THEN
    failed := array_append(failed, ('the second sweep alerted again: ' || k || ' ' || coalesce(r, 'null'))::text);
  END IF;

  -- ---------------------------------------------------------------
  -- Definer rights: the explicit scope stands in for RLS. In a block
  -- of its own, rolled back, so the alert counts above are untouched.
  --   c12: x's chat on w3 (nobody allocated), so the leader's RLS does
  --   not show it; a2 opens it and the customer answers.
  --   c13: another account's chat, with a message signed by a1.
  -- The leader's report and drill-down must not change (but for the
  -- whole-number count); the admin's shows c12.
  -- ---------------------------------------------------------------
  BEGIN
    cv := pg_temp.lt_conv(a_acct, u_x, w3, 'LT c12', u_x);
    PERFORM pg_temp.lt_msg(cv, 'agent', u_a2, 'Hello from A2, in X''s chat', today0 + 14 * step, w3);
    PERFORM pg_temp.lt_msg(cv, 'customer', NULL, 'Hi A2', today0 + 15 * step, w3);
    INSERT INTO auth.users (id, email)
    VALUES ('00000000-0000-4000-8000-0000000fd008', 'lt-other@example.invalid')
    ON CONFLICT DO NOTHING;
    SELECT account_id INTO o_acct FROM profiles WHERE user_id = '00000000-0000-4000-8000-0000000fd008';
    INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, waba_id, label, status, is_primary)
    VALUES ('00000000-0000-4000-8000-0000000fd008', o_acct, 'whapi', 'LT-074-W9', 'x', '971500074009', 'LT Other', 'connected', true)
    RETURNING id INTO o_w;
    cv := pg_temp.lt_conv(o_acct, '00000000-0000-4000-8000-0000000fd008', o_w, 'LT c13');
    PERFORM pg_temp.lt_msg(cv, 'agent', u_a1, 'Hello from A1, other account', today0 + 16 * step, o_w);
    PERFORM pg_temp.lt_msg(cv, 'customer', NULL, 'Hi other account', today0 + 17 * step, o_w);

    rep := pg_temp.lt_val('authenticated', u_admin, q)::jsonb;
    n := n + 1;
    IF coalesce((pg_temp.lt_sender(rep, 'person', u_a2) ->> 'chats_started')::int, -1) <> 2 THEN
      failed := array_append(failed, ('fixture: the admin does not see c12: '
        || coalesce(pg_temp.lt_sender(rep, 'person', u_a2)::text, 'null'))::text);
    END IF;
    -- Everything but number_today_started, which counts the whole
    -- number by design: a2's start in c12 makes w3's 3.
    r := pg_temp.lt_val('authenticated', u_la, q);
    n := n + 1;
    IF r IS NULL OR r LIKE 'ERROR%'
       OR r::jsonb - 'generated_at' - 'numbers' IS DISTINCT FROM lead - 'generated_at' - 'numbers'
       OR (SELECT jsonb_agg(e - 'number_today_started') FROM jsonb_array_elements(r::jsonb -> 'numbers') e)
          IS DISTINCT FROM (SELECT jsonb_agg(e - 'number_today_started') FROM jsonb_array_elements(lead -> 'numbers') e)
       OR coalesce((pg_temp.lt_number(r::jsonb, w3) ->> 'number_today_started')::int, -1) <> 3 THEN
      failed := array_append(failed, ('leader report shows a chat outside their RLS or account: '
        || left(coalesce(r, 'null'), 300))::text);
    END IF;
    r := pg_temp.lt_val('authenticated', u_la, format(
           $q$SELECT coalesce(string_agg(contact_name, ',' ORDER BY contact_name), '')
                FROM team_activity_chats(%L, %L, 'person', %L, NULL, 'all', 50)$q$,
           r_from, r_to, u_a2));
    r2 := pg_temp.lt_val('authenticated', u_la, format(
           $q$SELECT coalesce(string_agg(contact_name, ',' ORDER BY contact_name), '')
                FROM team_activity_chats(%L, %L, 'person', %L, NULL, 'all', 50)$q$,
           r_from, r_to, u_a1));
    n := n + 1;
    IF r IS DISTINCT FROM 'LT c9' OR r2 IS DISTINCT FROM 'LT c1,LT c2' THEN
      failed := array_append(failed, ('leader drill-down outside their RLS or account: '
        || coalesce(r, 'null') || ' / ' || coalesce(r2, 'null'))::text);
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'ZT075', MESSAGE = 'verify-team-activity-leaders definer rollback';
  EXCEPTION WHEN SQLSTATE 'ZT075' THEN
    NULL;
  END;
  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT074', MESSAGE = 'verify-team-activity-leaders rollback';
  EXCEPTION WHEN SQLSTATE 'ZT074' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'team activity (team leaders) verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'team activity (team leaders) verification passed (% checks)', n;
END
$verify$;
