-- Behavioural regression suite for the live view and the worklist's
-- waiting customers (migration 238).
--
-- live_team_view(): an owner or admin sees every live staff member and
-- the unassigned waiting count, a team leader only the members of the
-- teams they lead plus themselves (no unassigned count), an agent or a
-- viewer is refused. Per person: presence derived after 75 s, open
-- company chats, customers waiting and the oldest wait, replies today
-- (agent messages that did not fail, company chats, since local
-- midnight). worklist_waiting_chats(): oldest first, as RLS shows the
-- chats (an agent never sees another agent's waiting customer), closed
-- and personal chats never listed, the unassigned flag and business
-- minutes right.
--
-- ONE statement on purpose: `supabase db query --file` sends the file as
-- a single prepared statement and rejects several. Fixtures are rolled
-- back by a sentinel exception; failures are named in the final one.
-- now() is fixed for the whole block, so "waited 20 minutes" is exact.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000238001';
  u_admin  UUID := '00000000-0000-4000-8000-000000238002';
  u_lead   UUID := '00000000-0000-4000-8000-000000238003';
  u_g1     UUID := '00000000-0000-4000-8000-000000238004';  -- in the lead's team
  u_g2     UUID := '00000000-0000-4000-8000-000000238005';  -- in no team
  u_viewer UUID := '00000000-0000-4000-8000-000000238006';
  a_acct   UUID;
  t_team   UUID;
  k        UUID[] := '{}';
  ct       UUID;
  cv_a     UUID;  -- G1, waiting 20 min
  cv_b     UUID;  -- G1, open, answered
  cv_c     UUID;  -- G1, closed (forced waiting value)
  cv_d     UUID;  -- G2, waiting 40 min
  cv_e     UUID;  -- unassigned, waiting 30 min
  cv_p     UUID;  -- G1's personal chat (forced waiting value)
  all_day  JSONB := '{"mon":[["00:00","24:00"]],"tue":[["00:00","24:00"]],"wed":[["00:00","24:00"]],"thu":[["00:00","24:00"]],"fri":[["00:00","24:00"]],"sat":[["00:00","24:00"]],"sun":[["00:00","24:00"]]}';
  j        JSONB;
  p        JSONB;
  v        TEXT;
  i        INT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as a signed-in user: the value / 'ok', or
  -- 'ERROR <sqlstate> <hint>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.lv_as(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; st text; h text; m text;
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
        RETURN coalesce(nullif(v, ''), 'ok');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, h = PG_EXCEPTION_HINT,
                                m = MESSAGE_TEXT;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN format('ERROR %s %s: %s', st, coalesce(h, ''), m);
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.lv_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.lv_chk(p_name text, p_got text, p_want text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT CASE WHEN p_got LIKE p_want THEN NULL
                  ELSE p_name || ' (got ' || left(coalesce(p_got, '<null>'), 300) || ')' END
    $body$
  $fn$;
  -- One person's entry of a live_team_view() result.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.lv_person(p_view jsonb, p_uid uuid)
    RETURNS jsonb LANGUAGE sql AS $body$
      SELECT x FROM jsonb_array_elements(p_view -> 'people') x
       WHERE x ->> 'user_id' = p_uid::text
    $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.lv_ids(p_view jsonb)
    RETURNS text LANGUAGE sql AS $body$
      SELECT coalesce(string_agg(x ->> 'user_id', ',' ORDER BY x ->> 'user_id'), '')
        FROM jsonb_array_elements(p_view -> 'people') x
    $body$
  $fn$;
  -- The waiting list as a caller sees it: conversation ids in order.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.lv_waiting(p_uid uuid)
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.lv_as(p_uid,
        'SELECT coalesce(string_agg(conversation_id::text, '','' ORDER BY waiting_since), '''') FROM public.worklist_waiting_chats(50)')
    $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'tb238-owner@example.invalid'), (u_admin, 'tb238-admin@example.invalid'),
    (u_lead, 'tb238-lead@example.invalid'), (u_g1, 'tb238-g1@example.invalid'),
    (u_g2, 'tb238-g2@example.invalid'), (u_viewer, 'tb238-viewer@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_g1, u_g2);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_viewer;
  UPDATE profiles SET full_name = 'TB238 ' || email WHERE user_id IN
    (u_owner, u_admin, u_lead, u_g1, u_g2, u_viewer);
  INSERT INTO teams (account_id, name, leader_user_id)
    VALUES (a_acct, 'tb238 team', u_lead) RETURNING id INTO t_team;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (t_team, u_g1, a_acct);
  -- Every hour is a business hour, so business minutes = wall minutes.
  INSERT INTO response_settings (account_id, timezone, hours)
    VALUES (a_acct, 'Asia/Dubai', all_day)
  ON CONFLICT (account_id) DO UPDATE SET timezone = 'Asia/Dubai', hours = all_day;

  FOR i IN 1..6 LOOP
    INSERT INTO contacts (account_id, user_id, phone, name)
    VALUES (a_acct, u_owner, '97150238' || lpad(i::text, 4, '0'), 'TB238 customer ' || i)
    RETURNING id INTO ct;
    k := k || ct;
  END LOOP;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
    VALUES (a_acct, u_owner, k[1], u_g1) RETURNING id INTO cv_a;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
    VALUES (a_acct, u_owner, k[2], u_g1) RETURNING id INTO cv_b;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
    VALUES (a_acct, u_owner, k[3], u_g1) RETURNING id INTO cv_c;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
    VALUES (a_acct, u_owner, k[4], u_g2) RETURNING id INTO cv_d;
  INSERT INTO conversations (account_id, user_id, contact_id)
    VALUES (a_acct, u_owner, k[5]) RETURNING id INTO cv_e;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id, personal_owner_id)
    VALUES (a_acct, u_g1, k[6], u_g1, u_g1) RETURNING id INTO cv_p;

  -- Waiting customers, through the 237 trigger.
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at) VALUES
    (cv_a, 'customer', 'hello', now() - interval '20 minutes'),
    (cv_b, 'customer', 'hello', now() - interval '60 minutes'),
    (cv_d, 'customer', 'hello', now() - interval '40 minutes'),
    (cv_e, 'customer', 'hello', now() - interval '30 minutes');
  -- G1's replies: one today that went out (ends cv_b's wait), one that
  -- failed, one two days ago, one in their personal chat.
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text, status, created_at) VALUES
    (cv_b, 'agent', u_g1, 'on it', 'sent', now()),
    (cv_b, 'agent', u_g1, 'did not go out', 'failed', now()),
    (cv_b, 'agent', u_g1, 'old reply', 'sent', now() - interval '2 days'),
    (cv_p, 'agent', u_g1, 'personal reply', 'sent', now());
  -- A closed chat and a personal chat with a stored value never count.
  UPDATE conversations SET status = 'closed' WHERE id = cv_c;
  UPDATE conversations SET customer_waiting_since = now() - interval '90 minutes'
   WHERE id IN (cv_c, cv_p);

  -- Presence: G1 online now, the lead away now, G2 seen 5 minutes ago.
  INSERT INTO member_presence (user_id, account_id, status, last_seen_at) VALUES
    (u_g1, a_acct, 'online', now()),
    (u_lead, a_acct, 'away', now() - interval '30 seconds'),
    (u_g2, a_acct, 'online', now() - interval '5 minutes')
  ON CONFLICT (user_id, account_id) DO UPDATE
    SET status = EXCLUDED.status, last_seen_at = EXCLUDED.last_seen_at;

  -- ---------- 1. who may open the live view ----------
  n := n + 1; failed := failed || pg_temp.lv_chk('an agent opened the live view',
    pg_temp.lv_as(u_g1, 'SELECT public.live_team_view()::text'), 'ERROR 42501 not_allowed%');
  n := n + 1; failed := failed || pg_temp.lv_chk('a viewer opened the live view',
    pg_temp.lv_as(u_viewer, 'SELECT public.live_team_view()::text'), 'ERROR 42501 not_allowed%');
  n := n + 1; failed := failed || pg_temp.lv_chk('anon may execute live_team_view',
    (SELECT CASE WHEN has_function_privilege('anon', 'public.live_team_view()', 'EXECUTE')
                 THEN 'yes' ELSE 'no' END), 'no');

  -- ---------- 2. the team leader's view ----------
  v := pg_temp.lv_as(u_lead, 'SELECT public.live_team_view()::text');
  IF v LIKE 'ERROR%' THEN
    n := n + 1; failed := failed || ('the lead''s live view failed: ' || v);
  ELSE
    j := v::jsonb;
    n := n + 1; failed := failed || pg_temp.lv_chk('the lead sees someone outside their team',
      pg_temp.lv_ids(j), (SELECT string_agg(x::text, ',' ORDER BY x::text) FROM unnest(ARRAY[u_lead, u_g1]) x));
    n := n + 1; failed := failed || pg_temp.lv_ok(j -> 'unassigned_waiting' = 'null'::jsonb,
      'the lead got the unassigned waiting count');
    n := n + 1; failed := failed || pg_temp.lv_chk('the lead''s scope', j ->> 'scope', 'team');
    p := pg_temp.lv_person(j, u_lead);
    n := n + 1; failed := failed || pg_temp.lv_chk('the lead is not away', p ->> 'presence', 'away');
  END IF;

  -- ---------- 3. the admin's view and the counts ----------
  v := pg_temp.lv_as(u_admin, 'SELECT public.live_team_view()::text');
  IF v LIKE 'ERROR%' THEN
    n := n + 1; failed := failed || ('the admin''s live view failed: ' || v);
  ELSE
    j := v::jsonb;
    n := n + 1; failed := failed || pg_temp.lv_chk('the admin does not see every live staff member',
      pg_temp.lv_ids(j),
      (SELECT string_agg(x::text, ',' ORDER BY x::text)
         FROM unnest(ARRAY[u_owner, u_admin, u_lead, u_g1, u_g2, u_viewer]) x));
    n := n + 1; failed := failed || pg_temp.lv_chk('unassigned waiting count',
      j ->> 'unassigned_waiting', '1');
    n := n + 1; failed := failed || pg_temp.lv_chk('the admin''s scope', j ->> 'scope', 'all');
    n := n + 1; failed := failed || pg_temp.lv_chk('the default time zone', j ->> 'timezone', 'Asia/Dubai');
    p := pg_temp.lv_person(j, u_g1);
    n := n + 1; failed := failed || pg_temp.lv_chk('G1 open chats (closed and personal left out)',
      p ->> 'open_chats', '2');
    n := n + 1; failed := failed || pg_temp.lv_chk('G1 customers waiting', p ->> 'waiting_chats', '1');
    n := n + 1; failed := failed || pg_temp.lv_ok(
      (p ->> 'oldest_waiting_since')::timestamptz = now() - interval '20 minutes',
      'G1 oldest wait is not the 20 minute one');
    n := n + 1; failed := failed || pg_temp.lv_chk('G1 oldest wait in business minutes',
      p ->> 'oldest_waiting_business_minutes', '20');
    n := n + 1; failed := failed || pg_temp.lv_chk(
      'G1 replies today (failed, old and personal left out)', p ->> 'replies_today', '1');
    n := n + 1; failed := failed || pg_temp.lv_chk('G1 presence', p ->> 'presence', 'online');
    p := pg_temp.lv_person(j, u_g2);
    n := n + 1; failed := failed || pg_temp.lv_chk('G2 presence after 5 minutes', p ->> 'presence', 'offline');
    n := n + 1; failed := failed || pg_temp.lv_chk('G2 customers waiting', p ->> 'waiting_chats', '1');
    n := n + 1; failed := failed || pg_temp.lv_chk('G2 replies today', p ->> 'replies_today', '0');
    p := pg_temp.lv_person(j, u_viewer);
    n := n + 1; failed := failed || pg_temp.lv_chk('a person with no row is offline', p ->> 'presence', 'offline');
    n := n + 1; failed := failed || pg_temp.lv_ok(p -> 'oldest_waiting_since' = 'null'::jsonb
      AND p ->> 'open_chats' = '0', 'a person with no chats has figures');
  END IF;
  -- A deactivated person leaves the view.
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_viewer;
  n := n + 1; failed := failed || pg_temp.lv_ok(
    pg_temp.lv_person(pg_temp.lv_as(u_admin, 'SELECT public.live_team_view()::text')::jsonb, u_viewer) IS NULL,
    'a deactivated person is still in the live view');

  -- ---------- 4. the worklist's waiting customers ----------
  n := n + 1; failed := failed || pg_temp.lv_chk('the admin''s waiting list (oldest first)',
    pg_temp.lv_waiting(u_admin), cv_d || ',' || cv_e || ',' || cv_a);
  n := n + 1; failed := failed || pg_temp.lv_chk('G1 sees another agent''s waiting chat',
    pg_temp.lv_waiting(u_g1), cv_a::text);
  n := n + 1; failed := failed || pg_temp.lv_chk('G2 sees another agent''s waiting chat',
    pg_temp.lv_waiting(u_g2), cv_d::text);
  n := n + 1; failed := failed || pg_temp.lv_chk('the lead''s waiting list',
    pg_temp.lv_waiting(u_lead), cv_a::text);
  n := n + 1; failed := failed || pg_temp.lv_chk('the unassigned flag and business minutes',
    pg_temp.lv_as(u_admin, format(
      'SELECT unassigned::text || '':'' || business_minutes || '':'' || contact_name FROM public.worklist_waiting_chats(50) WHERE conversation_id = %L', cv_e)),
    'true:30:TB238 customer 5');
  n := n + 1; failed := failed || pg_temp.lv_chk('an assigned chat flagged unassigned',
    pg_temp.lv_as(u_admin, format(
      'SELECT unassigned::text || '':'' || assigned_agent_id FROM public.worklist_waiting_chats(50) WHERE conversation_id = %L', cv_d)),
    'false:' || u_g2);
  n := n + 1; failed := failed || pg_temp.lv_chk('the limit',
    pg_temp.lv_as(u_admin, 'SELECT count(*)::text FROM public.worklist_waiting_chats(2)'), '2');
  n := n + 1; failed := failed || pg_temp.lv_chk('anon may execute worklist_waiting_chats',
    (SELECT CASE WHEN has_function_privilege('anon', 'public.worklist_waiting_chats(integer)', 'EXECUTE')
                 THEN 'yes' ELSE 'no' END), 'no');

  RAISE EXCEPTION USING ERRCODE = 'ZT238', MESSAGE = 'verify-live-view rollback';
  EXCEPTION WHEN SQLSTATE 'ZT238' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'live view verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'live view verification passed (% checks)', n;
END
$verify$;
