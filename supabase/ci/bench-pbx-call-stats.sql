-- Manual timing for pbx_call_stats (migration 119); NOT run in CI.
-- Seeds 20,000 calls over 62 days in one workspace (an owner, a team
-- leader with a team of 5, 20 agents; 5% with no person, 5% internal)
-- and times the function for the owner, the leader and an agent over
-- 31 days in Asia/Dubai, three runs each (NOTICE lines, in ms). Target:
-- under 300 ms. Everything is rolled back.
--   docker exec -i <db container> psql -U postgres -d <db> -q -X < supabase/ci/bench-pbx-call-stats.sql
DO $bench$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000119101';
  u_lead  UUID := '00000000-0000-4000-8000-000000119102';
  agents  UUID[];
  a_acct  UUID;
  conn    UUID;
  t_team  UUID;
  t0      TIMESTAMPTZ;
  who     RECORD;
  i       INT;
  ms      TEXT;
BEGIN
  BEGIN
  SELECT array_agg(format('00000000-0000-4000-8000-0000001192%s', lpad(g::text, 2, '0'))::uuid ORDER BY g)
    INTO agents FROM generate_series(1, 20) g;
  INSERT INTO auth.users (id, email)
  SELECT u, 'cs-bench-' || u || '@example.invalid' FROM unnest(agents || u_owner || u_lead) u;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = ANY (agents);
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'bench', u_lead) RETURNING id INTO t_team;
  INSERT INTO team_members (team_id, user_id, account_id) SELECT t_team, u, a_acct FROM unnest(agents[1:5]) u;
  INSERT INTO pbx_connections (account_id, label, edition, base_url)
  VALUES (a_acct, 'bench', 'cloud', 'https://bench.example.invalid') RETURNING id INTO conn;
  INSERT INTO pbx_extensions (connection_id, extension, account_id, user_id)
  SELECT conn, (100 + o)::text, a_acct, u FROM unnest(agents) WITH ORDINALITY x(u, o);
  INSERT INTO calls (account_id, connection_id, pbx_call_id, direction, user_id, status, started_at,
                     answered_at, talk_seconds, ring_seconds, disposition, remote_number)
  SELECT a_acct, conn, 'bench-' || g,
         CASE WHEN g % 20 = 0 THEN 'internal' WHEN g % 3 = 0 THEN 'outbound' ELSE 'inbound' END,
         CASE WHEN g % 20 = 1 THEN NULL ELSE agents[1 + g % 20] END,
         CASE WHEN g % 4 = 0 THEN 'no_answer' WHEN g % 11 = 0 THEN 'busy' ELSE 'answered' END,
         now() - (g * interval '268 seconds'),
         now() - (g * interval '268 seconds') + interval '5 seconds',
         (g * 37) % 1200, g % 40,
         (ARRAY['interested', 'docs_requested', 'call_back', 'not_eligible', 'wrong_number', NULL, NULL])[1 + g % 7],
         '9715' || lpad((g % 3000)::text, 8, '0')
    FROM generate_series(1, 20000) g;
  ANALYZE calls;
  FOR who IN SELECT * FROM (VALUES ('owner', u_owner), ('leader', u_lead), ('agent', agents[2])) v(k, u) LOOP
    ms := '';
    FOR i IN 1..3 LOOP
      PERFORM set_config('request.jwt.claim.sub', who.u::text, true);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', who.u, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      t0 := clock_timestamp();
      PERFORM pbx_call_stats(date_trunc('day', now()) - interval '31 days', date_trunc('day', now()), 'Asia/Dubai');
      ms := ms || ' ' || round(extract(epoch FROM clock_timestamp() - t0) * 1000, 1);
      RESET ROLE;
    END LOOP;
    RAISE NOTICE 'pbx_call_stats % (ms):%', who.k, ms;
  END LOOP;
  RAISE EXCEPTION USING ERRCODE = 'ZT119', MESSAGE = 'bench rollback';
  EXCEPTION WHEN SQLSTATE 'ZT119' THEN NULL;
  END;
END
$bench$;
