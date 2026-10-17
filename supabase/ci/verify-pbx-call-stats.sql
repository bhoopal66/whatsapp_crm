-- Behavioural regression suite for the Call report page's figures
-- (migration 119, pbx_call_stats).
--
-- Whose calls: an owner/admin the whole workspace (and a 'none' row for
-- the calls with no person), a team leader themselves and the people of
-- the teams they lead, anyone else their own; p_user outside that scope
-- raises 42501, and another workspace's calls never count. The figures
-- are checked against a hand-computed fixture: counts, the missed rule
-- (no_answer, busy, abandoned, voicemail on an incoming call), internal
-- calls left out, talk and ring time, the answer rate, the talk buckets
-- (lower bound inclusive), outcomes with none, the previous period, the
-- zero-filled day series and the weekday x hour grid in the caller's
-- time zone (21:30 UTC is the next day, hour 1, in Asia/Dubai), and an
-- unknown time zone raising.
--
-- The period is 2025-03-03 .. 2025-03-06 in Asia/Dubai (UTC+4, no DST):
-- [2025-03-02 20:00Z, 2025-03-06 20:00Z); the previous period is
-- [2025-02-26 20:00Z, 2025-03-02 20:00Z).
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000119001';
  u_lead   UUID := '00000000-0000-4000-8000-000000119002';
  u_member UUID := '00000000-0000-4000-8000-000000119003';   -- in the leader's team
  u_agent  UUID := '00000000-0000-4000-8000-000000119004';   -- in no team of the leader
  u_other  UUID := '00000000-0000-4000-8000-000000119005';   -- owner of another workspace
  a_acct   UUID;
  b_acct   UUID;
  conn     UUID;
  t_team   UUID;
  c_cust   UUID;
  p_from   TEXT := '2025-03-02 20:00:00+00';
  p_to     TEXT := '2025-03-06 20:00:00+00';
  q_stats  TEXT := 'SELECT pbx_call_stats(%L, %L, %L, %L)::text';
  r        TEXT;
  j        JSONB;
  s        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (a signed-in user when p_uid is given): a
  -- SELECT's value ('ok' when it is void), 'ok', or the error as
  -- 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.px_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', p_role)::text, true);
        EXECUTE format('SET LOCAL ROLE %I', p_role);
        IF p_sql ILIKE 'select%' THEN
          EXECUTE p_sql INTO v;
        ELSE
          EXECUTE p_sql;
        END IF;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(NULLIF(v, ''), 'ok');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;
  -- A figures object as calls/inbound_total/inbound_answered/
  -- outbound_total/outbound_answered/missed/answer_rate/talk_total/
  -- talk_calls/avg_talk/longest_talk/ring_total/ring_calls/avg_ring/
  -- max_ring/unique_numbers/with_outcome ('null' for a JSON null).
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cs_fig(f jsonb) RETURNS text LANGUAGE sql AS $body$
      SELECT CASE WHEN f IS NULL THEN 'NULL' ELSE
        array_to_string(ARRAY(
          SELECT coalesce(f->>k, 'null')
            FROM unnest(ARRAY['calls', 'inbound_total', 'inbound_answered', 'outbound_total',
                              'outbound_answered', 'missed', 'answer_rate', 'talk_seconds_total',
                              'talk_calls', 'avg_talk_seconds', 'longest_talk_seconds',
                              'ring_seconds_total', 'ring_calls', 'avg_ring_seconds',
                              'max_ring_seconds', 'unique_numbers', 'with_outcome'])
                 WITH ORDINALITY u(k, o) ORDER BY o), '/') END
    $body$
  $fn$;
  -- people as 'kind:name:extension:calls/inbound_answered/outbound_answered/missed/talk ...'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cs_people(p jsonb) RETURNS text LANGUAGE sql AS $body$
      SELECT CASE WHEN jsonb_typeof(p) IS DISTINCT FROM 'array' THEN coalesce(jsonb_typeof(p), 'NULL') ELSE
        coalesce((SELECT string_agg(format('%s:%s:%s:%s/%s/%s/%s/%s', e->>'kind',
                                           coalesce(e->>'full_name', '-'), coalesce(e->>'extension', '-'),
                                           e->>'calls', e->>'inbound_answered', e->>'outbound_answered',
                                           e->>'missed', e->>'talk_seconds_total'), ' ' ORDER BY o)
                    FROM jsonb_array_elements(p) WITH ORDINALITY x(e, o)), '') END
    $body$
  $fn$;

  -- Fixture: workspace A (owner, team leader, a member of their team,
  -- an agent outside it), workspace B (its owner).
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'cs-owner@example.invalid'),
    (u_lead,   'cs-lead@example.invalid'),
    (u_member, 'cs-member@example.invalid'),
    (u_agent,  'cs-agent@example.invalid'),
    (u_other,  'cs-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_other;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET full_name = 'CS Owner' WHERE user_id = u_owner;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader', full_name = 'CS Lead' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent', full_name = 'CS Member' WHERE user_id = u_member;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent', full_name = 'CS Agent' WHERE user_id = u_agent;

  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'CS team', u_lead)
  RETURNING id INTO t_team;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (t_team, u_member, a_acct);

  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_member, '971500119001', 'CS customer') RETURNING id INTO c_cust;

  INSERT INTO pbx_connections (account_id, label, edition, base_url)
  VALUES (a_acct, 'CS PBX', 'cloud', 'https://cs.example.invalid') RETURNING id INTO conn;
  INSERT INTO pbx_extensions (connection_id, extension, account_id, user_id) VALUES
    (conn, '101', a_acct, u_member),
    (conn, '102', a_acct, u_agent);

  -- Local (Dubai) times in the comments.
  INSERT INTO calls (account_id, connection_id, pbx_call_id, direction, extension, user_id, status,
                     started_at, answered_at, talk_seconds, ring_seconds, disposition, remote_number, contact_id) VALUES
    -- the member
    (a_acct, conn, 'cs-m1', 'inbound', '101', u_member, 'answered',      -- Mon 09:00
     '2025-03-03 05:00+00', '2025-03-03 05:00:04+00', 20, 4, 'interested', '971500119001', c_cust),
    (a_acct, conn, 'cs-m2', 'inbound', '101', u_member, 'answered',      -- Mon 10:00
     '2025-03-03 06:00+00', '2025-03-03 06:00:08+00', 100, 8, NULL, '971500119002', NULL),
    (a_acct, conn, 'cs-m3', 'outbound', '101', u_member, 'answered',     -- Tue 11:00
     '2025-03-04 07:00+00', '2025-03-04 07:00:02+00', 400, 2, 'call_back', '971500119001', c_cust),
    (a_acct, conn, 'cs-m4', 'inbound', '101', u_member, 'no_answer',     -- Tue 12:00, missed
     '2025-03-04 08:00+00', NULL, 0, 30, NULL, '971500119003', NULL),
    -- outgoing, final no_answer but carrying talk time: connected, not answered
    (a_acct, conn, 'cs-m5', 'outbound', '101', u_member, 'no_answer',    -- Tue 13:00
     '2025-03-04 09:00+00', NULL, 15, 10, NULL, '971500119004', NULL),
    -- internal: left out everywhere
    (a_acct, conn, 'cs-m6', 'internal', '101', u_member, 'answered',
     '2025-03-04 10:00+00', '2025-03-04 10:00:01+00', 500, 1, NULL, NULL, NULL),
    -- 21:30 UTC Monday is Tuesday 01:30 in Dubai; missed
    (a_acct, conn, 'cs-m7', 'inbound', '101', u_member, 'voicemail',
     '2025-03-03 21:30+00', NULL, 0, 25, NULL, '971500119005', NULL),
    -- still in progress, answered_at set: answered
    (a_acct, conn, 'cs-m8', 'inbound', '101', u_member, 'in_progress',   -- Wed 10:00
     '2025-03-05 06:00+00', '2025-03-05 06:00:05+00', 200, 5, NULL, '971500119002', NULL),
    -- on the period's end: left out
    (a_acct, conn, 'cs-m9', 'inbound', '101', u_member, 'answered',
     '2025-03-06 20:00+00', '2025-03-06 20:00:01+00', 90, 1, NULL, '971500119099', NULL),
    -- the agent
    (a_acct, conn, 'cs-a1', 'inbound', '102', u_agent, 'answered',       -- Mon 11:00
     '2025-03-03 07:00+00', '2025-03-03 07:00:06+00', 1000, 6, 'wrong_number', '971500119006', NULL),
    (a_acct, conn, 'cs-a2', 'inbound', '102', u_agent, 'busy',           -- Wed 11:00, missed
     '2025-03-05 07:00+00', NULL, 0, 10, NULL, '971500119009', NULL),
    (a_acct, conn, 'cs-a3', 'outbound', '102', u_agent, 'failed',        -- Wed 12:00
     '2025-03-05 08:00+00', NULL, 0, 12, NULL, '971500119010', NULL),
    -- on the period's start: counted; 30 s is the 30s_2m bucket
    (a_acct, conn, 'cs-a4', 'outbound', '102', u_agent, 'answered',      -- Mon 00:00
     '2025-03-02 20:00+00', '2025-03-02 20:00:01+00', 30, 1, NULL, '971500119011', NULL),
    -- the leader, no extension
    (a_acct, conn, 'cs-l1', 'outbound', NULL, u_lead, 'answered',        -- Mon 12:00
     '2025-03-03 08:00+00', '2025-03-03 08:00:03+00', 60, 3, 'docs_requested', '971500119007', NULL),
    -- a ring group nobody answered: no person; missed
    (a_acct, conn, 'cs-n1', 'inbound', '6300', NULL, 'abandoned',        -- Tue 15:00
     '2025-03-04 11:00+00', NULL, 0, 40, NULL, '971500119008', NULL),
    -- the previous period
    (a_acct, conn, 'cs-p1', 'inbound', '101', u_member, 'answered',
     '2025-03-01 05:00+00', '2025-03-01 05:00:05+00', 50, 5, NULL, '971500119012', NULL),
    (a_acct, conn, 'cs-p2', 'inbound', '102', u_agent, 'no_answer',
     '2025-03-01 06:00+00', NULL, 0, 20, NULL, '971500119013', NULL),
    (a_acct, conn, 'cs-p3', 'inbound', '6300', NULL, 'abandoned',
     '2025-03-02 19:59:59+00', NULL, 0, 15, NULL, '971500119014', NULL),
    -- before the previous period: left out
    (a_acct, conn, 'cs-p4', 'inbound', '101', u_member, 'answered',
     '2025-02-26 19:59:59+00', '2025-02-26 20:00:00+00', 70, 1, NULL, '971500119015', NULL);
  -- workspace B's call in the same hour as the member's first
  INSERT INTO calls (account_id, pbx_call_id, direction, user_id, status, started_at, answered_at,
                     talk_seconds, ring_seconds, remote_number)
  VALUES (b_acct, 'cs-b1', 'inbound', u_other, 'answered', '2025-03-03 05:00+00', '2025-03-03 05:00:02+00',
          77, 2, '971500119001');

  -- ---------- the owner: the whole workspace ----------
  r := pg_temp.px_try('authenticated', u_owner, format(q_stats, p_from, p_to, 'Asia/Dubai', NULL));
  j := CASE WHEN r LIKE 'ERROR%' THEN NULL ELSE r::jsonb END;
  n := n + 1;
  IF j IS NULL THEN
    failed := array_append(failed, ('pbx_call_stats for the owner: ' || left(r, 300))::text);
  ELSE
    n := n + 1;
    IF pg_temp.cs_fig(j->'summary') IS DISTINCT FROM '13/8/4/5/4/4/0.5000/1810/7/259/1000/23/4/6/8/11/4' THEN
      failed := array_append(failed, ('owner summary: ' || pg_temp.cs_fig(j->'summary'))::text);
    END IF;
    n := n + 1;
    IF pg_temp.cs_fig(j->'previous') IS DISTINCT FROM '3/3/1/0/0/2/0.3333/50/1/50/50/5/1/5/5/3/0' THEN
      failed := array_append(failed, ('owner previous period: ' || pg_temp.cs_fig(j->'previous'))::text);
    END IF;
    n := n + 1;
    IF j->>'scope' IS DISTINCT FROM 'workspace' OR jsonb_typeof(j->'user_id') IS DISTINCT FROM 'null' THEN
      failed := array_append(failed, ('owner scope: ' || coalesce(j->>'scope', 'NULL'))::text);
    END IF;
    n := n + 1;
    IF pg_temp.cs_people(j->'people') IS DISTINCT FROM
       'person:CS Agent:102:4/1/1/1/1030 person:CS Lead:-:1/0/1/0/60 '
       'person:CS Member:101:7/3/2/2/720 none:-:-:1/0/0/1/0' THEN
      failed := array_append(failed, ('owner people: ' || pg_temp.cs_people(j->'people'))::text);
    END IF;
    -- Every local day of the period, the empty one included.
    SELECT string_agg(format('%s:%s/%s/%s/%s/%s/%s', e->>'day', e->>'calls', e->>'inbound_answered',
                             e->>'outbound', e->>'outbound_answered', e->>'missed', e->>'talk_seconds'),
                      ' ' ORDER BY o)
      INTO s FROM jsonb_array_elements(j->'by_day') WITH ORDINALITY x(e, o);
    n := n + 1;
    IF s IS DISTINCT FROM
       '2025-03-03:5/3/2/2/0/1210 2025-03-04:5/0/2/2/3/400 '
       '2025-03-05:3/1/1/0/1/200 2025-03-06:0/0/0/0/0/0' THEN
      failed := array_append(failed, ('owner by_day (Dubai days, zero-filled): ' || coalesce(s, 'NULL'))::text);
    END IF;
    SELECT string_agg(format('%s:%s:%s/%s/%s/%s', e->>'dow', e->>'hour', e->>'calls', e->>'answered',
                             e->>'missed', e->>'talk_seconds'), ' ' ORDER BY o)
      INTO s FROM jsonb_array_elements(j->'by_hour') WITH ORDINALITY x(e, o);
    n := n + 1;
    IF s IS DISTINCT FROM
       '1:0:1/1/0/30 1:9:1/1/0/20 1:10:1/1/0/100 1:11:1/1/0/1000 1:12:1/1/0/60 '
       '2:1:1/0/1/0 2:11:1/1/0/400 2:12:1/0/1/0 2:13:1/1/0/0 2:15:1/0/1/0 '
       '3:10:1/1/0/200 3:11:1/0/1/0 3:12:1/0/0/0' THEN
      failed := array_append(failed, ('owner by_hour (ISO weekday, Dubai hour): ' || coalesce(s, 'NULL'))::text);
    END IF;
    SELECT string_agg(format('%s:%s', e->>'key', e->>'calls'), ' ' ORDER BY o)
      INTO s FROM jsonb_array_elements(j->'talk_buckets') WITH ORDINALITY x(e, o);
    n := n + 1;
    IF s IS DISTINCT FROM 'under_30s:1 30s_2m:3 2m_5m:1 5m_15m:1 15m_plus:1' THEN
      failed := array_append(failed, ('owner talk buckets: ' || coalesce(s, 'NULL'))::text);
    END IF;
    s := format('%s/%s/%s/%s/%s/%s', j->'outcomes'->>'interested', j->'outcomes'->>'docs_requested',
                j->'outcomes'->>'call_back', j->'outcomes'->>'not_eligible',
                j->'outcomes'->>'wrong_number', j->'outcomes'->>'none');
    n := n + 1;
    IF s IS DISTINCT FROM '1/1/1/0/1/3' THEN
      failed := array_append(failed, ('owner outcomes (interested/docs/call back/not eligible/wrong/none): ' || s)::text);
    END IF;
    -- Grouped by contact, else number: 002 twice (latest Wed), the contact twice (latest Tue).
    s := format('%s:%s:%s %s:%s:%s', j->'top_numbers'->0->>'remote_number', j->'top_numbers'->0->>'calls',
                coalesce(j->'top_numbers'->0->>'contact_name', '-'),
                j->'top_numbers'->1->>'remote_number', j->'top_numbers'->1->>'calls',
                coalesce(j->'top_numbers'->1->>'contact_name', '-'));
    n := n + 1;
    IF s IS DISTINCT FROM '971500119002:2:- 971500119001:2:CS customer'
       OR jsonb_array_length(j->'top_numbers') <> 10 THEN  -- 11 customers, the ten most called
      failed := array_append(failed, ('owner top numbers: ' || s)::text);
    END IF;
    n := n + 1;
    IF j->'longest'->0->>'talk_seconds' IS DISTINCT FROM '1000'
       OR j->'longest'->0->>'user_name' IS DISTINCT FROM 'CS Agent'
       OR jsonb_array_length(j->'longest') <> 7 THEN
      failed := array_append(failed, ('owner longest calls: ' || left(coalesce(j->>'longest', 'NULL'), 300))::text);
    END IF;
    n := n + 1;
    IF (j->'range'->>'previous_from')::timestamptz IS DISTINCT FROM '2025-02-26 20:00+00'::timestamptz
       OR (j->'range'->>'previous_to')::timestamptz IS DISTINCT FROM p_from::timestamptz
       OR j->'range'->>'tz' IS DISTINCT FROM 'Asia/Dubai' THEN
      failed := array_append(failed, ('owner range: ' || coalesce(j->>'range', 'NULL'))::text);
    END IF;
  END IF;

  -- The owner may name anyone, but another workspace's calls never count.
  r := pg_temp.px_try('authenticated', u_owner, format(q_stats, p_from, p_to, 'Asia/Dubai', u_other));
  j := CASE WHEN r LIKE 'ERROR%' THEN NULL ELSE r::jsonb END;
  n := n + 1;
  IF pg_temp.cs_fig(j->'summary') IS DISTINCT FROM '0/0/0/0/0/0/null/0/0/null/null/0/0/null/null/0/0'
     OR j->>'scope' IS DISTINCT FROM 'person' OR jsonb_typeof(j->'people') IS DISTINCT FROM 'null' THEN
    failed := array_append(failed, ('owner naming another workspace''s person counts their calls: ' || left(r, 300))::text);
  END IF;
  r := pg_temp.px_try('authenticated', u_other, format(q_stats, p_from, p_to, 'Asia/Dubai', NULL));
  j := CASE WHEN r LIKE 'ERROR%' THEN NULL ELSE r::jsonb END;
  n := n + 1;
  IF j->'summary'->>'calls' IS DISTINCT FROM '1' OR j->'summary'->>'talk_seconds_total' IS DISTINCT FROM '77' THEN
    failed := array_append(failed, ('workspace B''s owner does not see exactly their one call: ' || left(r, 300))::text);
  END IF;

  -- ---------- the team leader: themselves and their team ----------
  r := pg_temp.px_try('authenticated', u_lead, format(q_stats, p_from, p_to, 'Asia/Dubai', NULL));
  j := CASE WHEN r LIKE 'ERROR%' THEN NULL ELSE r::jsonb END;
  n := n + 1;
  IF pg_temp.cs_fig(j->'summary') IS DISTINCT FROM '8/5/3/3/3/2/0.6000/780/5/156/400/17/3/6/8/6/3'
     OR pg_temp.cs_fig(j->'previous') IS DISTINCT FROM '1/1/1/0/0/0/1.0000/50/1/50/50/5/1/5/5/1/0' THEN
    failed := array_append(failed, ('leader figures are not themselves plus their team: '
                                     || coalesce(pg_temp.cs_fig(j->'summary'), r) || ' prev '
                                     || coalesce(pg_temp.cs_fig(j->'previous'), '-'))::text);
  END IF;
  n := n + 1;
  IF j->>'scope' IS DISTINCT FROM 'team'
     OR pg_temp.cs_people(j->'people') IS DISTINCT FROM
        'person:CS Lead:-:1/0/1/0/60 person:CS Member:101:7/3/2/2/720' THEN
    failed := array_append(failed, ('leader scope/people (no other agent, no none row): '
                                    || coalesce(j->>'scope', 'NULL') || ' ' || pg_temp.cs_people(j->'people'))::text);
  END IF;
  n := n + 1;
  IF j->'longest'->0->>'talk_seconds' IS DISTINCT FROM '400' THEN
    failed := array_append(failed, ('leader longest includes a call outside their scope: '
                                    || left(coalesce(j->>'longest', 'NULL'), 300))::text);
  END IF;
  r := pg_temp.px_try('authenticated', u_lead, format(q_stats, p_from, p_to, 'Asia/Dubai', u_member));
  j := CASE WHEN r LIKE 'ERROR%' THEN NULL ELSE r::jsonb END;
  n := n + 1;
  IF j->'summary'->>'calls' IS DISTINCT FROM '7' OR j->>'scope' IS DISTINCT FROM 'person'
     OR j->>'user_id' IS DISTINCT FROM u_member::text OR jsonb_typeof(j->'people') IS DISTINCT FROM 'null' THEN
    failed := array_append(failed, ('leader naming their team member: ' || left(r, 300))::text);
  END IF;
  r := pg_temp.px_try('authenticated', u_lead, format(q_stats, p_from, p_to, 'Asia/Dubai', u_agent));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN
    failed := array_append(failed, ('leader naming an agent outside their teams is not 42501: ' || left(r, 300))::text);
  END IF;

  -- ---------- the agent: their own calls ----------
  r := pg_temp.px_try('authenticated', u_agent, format(q_stats, p_from, p_to, 'Asia/Dubai', NULL));
  j := CASE WHEN r LIKE 'ERROR%' THEN NULL ELSE r::jsonb END;
  n := n + 1;
  IF pg_temp.cs_fig(j->'summary') IS DISTINCT FROM '4/2/1/2/1/1/0.5000/1030/2/515/1000/6/1/6/6/4/1'
     OR pg_temp.cs_fig(j->'previous') IS DISTINCT FROM '1/1/0/0/0/1/0.0000/0/0/null/null/0/0/null/null/1/0' THEN
    failed := array_append(failed, ('agent figures are not their own calls: '
                                     || coalesce(pg_temp.cs_fig(j->'summary'), r) || ' prev '
                                     || coalesce(pg_temp.cs_fig(j->'previous'), '-'))::text);
  END IF;
  n := n + 1;
  IF j->>'scope' IS DISTINCT FROM 'self' OR jsonb_typeof(j->'people') IS DISTINCT FROM 'null' THEN
    failed := array_append(failed, ('agent scope is not self with no people: '
                                    || coalesce(j->>'scope', 'NULL') || ' ' || coalesce(j->>'people', 'NULL'))::text);
  END IF;
  r := pg_temp.px_try('authenticated', u_agent, format(q_stats, p_from, p_to, 'Asia/Dubai', u_agent));
  j := CASE WHEN r LIKE 'ERROR%' THEN NULL ELSE r::jsonb END;
  n := n + 1;
  IF j->'summary'->>'calls' IS DISTINCT FROM '4' OR j->>'scope' IS DISTINCT FROM 'person' THEN
    failed := array_append(failed, ('agent naming themselves: ' || left(r, 300))::text);
  END IF;
  r := pg_temp.px_try('authenticated', u_agent, format(q_stats, p_from, p_to, 'Asia/Dubai', u_member));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN
    failed := array_append(failed, ('agent naming another person is not 42501: ' || left(r, 300))::text);
  END IF;
  r := pg_temp.px_try('authenticated', u_member, format(q_stats, p_from, p_to, 'Asia/Dubai', u_lead));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN
    failed := array_append(failed, ('a team member naming their leader is not 42501: ' || left(r, 300))::text);
  END IF;

  -- ---------- time zones ----------
  -- The same moment in UTC: the 21:30 call is Monday, hour 21.
  r := pg_temp.px_try('authenticated', u_owner, format(q_stats, '2025-03-03 00:00+00', '2025-03-04 00:00+00', 'UTC', u_member));
  j := CASE WHEN r LIKE 'ERROR%' THEN NULL ELSE r::jsonb END;
  n := n + 1;
  IF NOT coalesce(j->'by_hour' @> '[{"dow": 1, "hour": 21, "calls": 1, "missed": 1}]', false)
     OR jsonb_array_length(j->'by_day') <> 1 OR j->'by_day'->0->>'calls' IS DISTINCT FROM '3' THEN
    failed := array_append(failed, ('the 21:30 UTC call in UTC: ' || coalesce(j->>'by_hour', r))::text);
  END IF;
  r := pg_temp.px_try('authenticated', u_owner, format(q_stats, p_from, p_to, 'Mars/Olympus_Mons', NULL));
  n := n + 1;
  IF r NOT LIKE 'ERROR 22023: Unknown time zone%' THEN
    failed := array_append(failed, ('an unknown time zone does not raise: ' || left(r, 300))::text);
  END IF;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT119', MESSAGE = 'verify-pbx-call-stats rollback';
  EXCEPTION WHEN SQLSTATE 'ZT119' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'pbx call stats verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'pbx call stats verification passed (% checks)', n;
END
$verify$;
