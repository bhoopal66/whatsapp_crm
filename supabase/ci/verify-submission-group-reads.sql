-- Behavioural regression suite for migration 173: read markers and
-- unread counts of submission groups, the case agent's team leader in
-- the group, the customer-message bell, WhatsApp group tombstones,
-- mirrored rows leaving the Groups count, and group access following a
-- reassigned case.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The fixtures are
-- rolled back by a sentinel exception; the results survive in plpgsql
-- variables. now() is fixed for the whole transaction, so messages name
-- their created_at and markers are set in the past where it matters.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000173001';
  u_agent  UUID := '00000000-0000-4000-8000-000000173002';
  u_coord  UUID := '00000000-0000-4000-8000-000000173003';
  u_both   UUID := '00000000-0000-4000-8000-000000173004'; -- leader, with a real 'agent' row
  u_tlrow  UUID := '00000000-0000-4000-8000-000000173005'; -- open 'team_lead' row
  u_lead   UUID := '00000000-0000-4000-8000-000000173006'; -- leads u_agent, on no list
  u_lead2  UUID := '00000000-0000-4000-8000-000000173007'; -- leads u_other only
  u_lh     UUID := '00000000-0000-4000-8000-000000173008'; -- leads u_agent and holds the bank
  u_holder UUID := '00000000-0000-4000-8000-000000173009';
  u_other  UUID := '00000000-0000-4000-8000-000000173010'; -- a stranger, an agent
  u_gonel  UUID := '00000000-0000-4000-8000-000000173011'; -- deactivated leader of u_agent
  u_goneh  UUID := '00000000-0000-4000-8000-000000173012'; -- deactivated holder
  u_view   UUID := '00000000-0000-4000-8000-000000173013'; -- viewer holding the bank
  u_far    UUID := '00000000-0000-4000-8000-000000173014'; -- owner of another account
  a_acct   UUID;
  w1       UUID;
  c1       UUID;
  ga       UUID;
  gb       UUID;
  gn       UUID;
  ge       UUID;
  gr       UUID;
  gq       UUID;
  gm       UUID;
  gx       UUID;
  gy       UUID;
  gz       UUID;
  gw       UUID;
  gv       UUID;
  gu       UUID;
  kx       UUID;
  ky       UUID;
  kz       UUID;
  kw       UUID;
  kv       UUID;
  tok      UUID;
  t1       UUID;
  t_lead   UUID;
  acc      JSONB;
  r        TEXT;
  b        BOOLEAN;
  x        TIMESTAMPTZ;
  i        INT;
  was      INT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a SELECT as p_role (NULL: as the current user) signed in as
  -- p_uid: its value, or 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sr_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        IF p_role IS NOT NULL THEN
          PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
          PERFORM set_config('request.jwt.claims',
            json_build_object('sub', p_uid, 'role', p_role)::text, true);
          EXECUTE format('SET LOCAL ROLE %I', p_role);
        END IF;
        EXECUTE p_sql INTO v;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(v, 'NULL');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sr_ok(p_ok boolean, p_msg text)
    RETURNS text[] LANGUAGE sql AS $body$
      SELECT CASE WHEN coalesce(p_ok, false) THEN '{}'::text[] ELSE ARRAY[p_msg] END
    $body$
  $fn$;
  -- The caller's unread count of one group, as text.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sr_unread(p_uid uuid, p_group uuid)
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.sr_try('authenticated', p_uid, format(
        'SELECT coalesce((SELECT u.unread FROM sg_unread_by_group() u WHERE u.group_id = %L), 0)::text', p_group))
    $body$
  $fn$;
  -- Bells of this type for one person on one group.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sr_bells(p_uid uuid, p_group uuid)
    RETURNS int LANGUAGE sql AS $body$
      SELECT count(*)::int FROM notifications nn
       WHERE nn.user_id = p_uid AND nn.type = 'submission_group_message'
         AND nn.meta ->> 'group_id' = p_group::text
    $body$
  $fn$;
  -- One person's open labels on one group: 'none', or comma separated.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sr_open(p_group uuid, p_uid uuid)
    RETURNS text LANGUAGE sql AS $body$
      SELECT coalesce(string_agg(a.label, ',' ORDER BY a.label), 'none')
        FROM submission_group_access a
       WHERE a.group_id = p_group AND a.user_id = p_uid AND a.removed_at IS NULL
    $body$
  $fn$;
  -- Whether a signed-in person's RLS shows the group, as '1' or '0'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sr_sees(p_uid uuid, p_group uuid)
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.sr_try('authenticated', p_uid, format(
        'SELECT count(*)::text FROM submission_groups WHERE id = %L', p_group))
    $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'sr-owner@example.invalid'),  (u_agent,  'sr-agent@example.invalid'),
    (u_coord,  'sr-coord@example.invalid'),  (u_both,   'sr-both@example.invalid'),
    (u_tlrow,  'sr-tlrow@example.invalid'),  (u_lead,   'sr-lead@example.invalid'),
    (u_lead2,  'sr-lead2@example.invalid'),  (u_lh,     'sr-lh@example.invalid'),
    (u_holder, 'sr-holder@example.invalid'), (u_other,  'sr-other@example.invalid'),
    (u_gonel,  'sr-gonel@example.invalid'),  (u_goneh,  'sr-goneh@example.invalid'),
    (u_view,   'sr-view@example.invalid'),   (u_far,    'sr-far@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent'
   WHERE user_id IN (u_agent, u_coord, u_holder, u_other, u_goneh);
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader'
   WHERE user_id IN (u_both, u_tlrow, u_lead, u_lead2, u_lh, u_gonel);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_view;
  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'SR lead', u_lead) RETURNING id INTO t1;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (t1, u_agent, a_acct);
  t_lead := t1;
  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'SR elsewhere', u_lead2) RETURNING id INTO t1;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (t1, u_other, a_acct);
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'SR-173-A1', 'x', 'connected', true) RETURNING id INTO w1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500173001', 'SR one')
    RETURNING id INTO c1;

  acc := jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent'),
                           jsonb_build_object('user_id', u_coord, 'label', 'coordinator'),
                           jsonb_build_object('user_id', u_tlrow, 'label', 'team_lead'));
  ga := (SELECT o.group_id FROM sg_open(a_acct, 'SR-173-A', c1, w1, 'a', NULL, acc, NULL, 'group') o);
  gb := (SELECT o.group_id FROM sg_open(a_acct, 'SR-173-B', c1, w1, 'b', NULL, acc, NULL, 'group') o);
  gn := (SELECT o.group_id FROM sg_open(a_acct, 'SR-173-N', c1, NULL, 'n', NULL, acc, NULL, 'none') o);
  ge := (SELECT o.group_id FROM sg_open(a_acct, 'SR-173-E', c1, w1, 'e', NULL, acc, NULL, 'group') o);
  gr := (SELECT o.group_id FROM sg_open(a_acct, 'SR-173-R', c1, w1, 'r', NULL, acc, NULL, 'group',
                                        p_customer_name => 'Acme LLC') o);
  gq := (SELECT o.group_id FROM sg_open(a_acct, 'SR-173-Q', c1, w1, 'q', NULL, acc, NULL, 'group') o);
  gm := (SELECT o.group_id FROM sg_open(a_acct, 'SR-173-M', c1, w1, 'm', NULL, acc, NULL, 'group') o);
  IF ga IS NULL OR gb IS NULL OR gn IS NULL OR ge IS NULL OR gr IS NULL OR gq IS NULL OR gm IS NULL THEN
    RAISE EXCEPTION 'fixture: sg_open returned no group';
  END IF;
  PERFORM case_open(ga, 'SRB', 'Bank SR', NULL, NULL, NULL);
  PERFORM case_open(gb, 'SRB', 'Bank SR', NULL, NULL, NULL);
  PERFORM case_open(gn, 'SRB', 'Bank SR', NULL, NULL, NULL);
  PERFORM case_open(ge, 'SRB', 'Bank SR', NULL, NULL, NULL);
  PERFORM case_open(gr, 'SRB', 'Bank SR', NULL, NULL, NULL);
  PERFORM case_open(gq, 'SRB', 'Bank SR', NULL, NULL, NULL);
  PERFORM case_open(gm, 'SRB', 'Bank SR', NULL, NULL, NULL);
  IF (SELECT count(*) FROM cases WHERE group_id IN (ga, gb, gn, ge, gr, gq, gm) AND agent_id = u_agent) <> 7 THEN
    RAISE EXCEPTION 'fixture: the cases do not all name u_agent as their agent';
  END IF;
  -- A second 'agent' row, added once the cases exist: case_open takes the
  -- oldest and rows of one transaction tie on added_at.
  PERFORM sg_access_set(ga, u_both, 'agent', NULL);
  PERFORM sg_access_set(gr, u_both, 'agent', NULL);
  INSERT INTO coordinator_banks (account_id, user_id, bank_code) VALUES
    (a_acct, u_holder, 'SRB'), (a_acct, u_lh, 'SRB'), (a_acct, u_goneh, 'SRB'), (a_acct, u_view, 'SRB');
  UPDATE profiles SET deactivated_at = now() WHERE user_id IN (u_gonel, u_goneh);

  -- ---------- (a) the team leader rule, ACTIVE ----------
  n := n + 1; failed := failed || pg_temp.sr_ok(
    NOT EXISTS (SELECT 1 FROM submission_group_access WHERE group_id = ga AND user_id = u_lead),
    'fixture: the leader is on the access list');
  n := n + 1; failed := failed || pg_temp.sr_ok(sg_leads_group_agent(ga, u_lead), 'sg_leads_group_agent is false for the agent''s leader');
  n := n + 1; failed := failed || pg_temp.sr_ok(sg_can_read(ga, u_lead), 'the agent''s leader cannot read an ACTIVE group');
  n := n + 1; failed := failed || pg_temp.sr_ok(sg_can_send(ga, u_lead), 'the agent''s leader cannot send in an ACTIVE group');
  n := n + 1; failed := failed || pg_temp.sr_ok(sg_read_role(ga, u_lead, NULL, 60) IS NOT DISTINCT FROM 'team_lead', 'sg_read_role of the agent''s leader is not team_lead');
  n := n + 1; failed := failed || pg_temp.sr_ok(sg_resolve_role(ga, u_lead) IS NOT DISTINCT FROM 'team_lead', 'sg_resolve_role of the agent''s leader is not team_lead');
  n := n + 1; r := pg_temp.sr_try('authenticated', u_lead, format('SELECT (%L::uuid IN (SELECT sg_visible_ids()))::text', ga));
  failed := failed || pg_temp.sr_ok(r = 'true', format('ga is not in the leader''s sg_visible_ids (%s)', r));
  n := n + 1; r := pg_temp.sr_try('authenticated', u_lead, format('SELECT count(*)::text FROM submission_groups WHERE id = %L', ga));
  failed := failed || pg_temp.sr_ok(r = '1', format('the leader cannot SELECT ga through RLS (%s)', r));
  n := n + 1; r := pg_temp.sr_try('service_role', NULL, format('SELECT sg_send_begin(%L, %L, ''hi'', ''Lead: hi'')::text', ga, u_lead));
  failed := failed || pg_temp.sr_ok(r NOT LIKE 'ERROR%' AND r <> 'NULL', format('sg_send_begin refused the agent''s leader (%s)', r));

  -- A leader of someone else, and a deactivated leader, get nothing.
  n := n + 1; failed := failed || pg_temp.sr_ok(
    NOT sg_leads_group_agent(ga, u_lead2) AND NOT sg_can_read(ga, u_lead2) AND NOT sg_can_send(ga, u_lead2)
    AND sg_read_role(ga, u_lead2, NULL, 60) IS NULL AND sg_resolve_role(ga, u_lead2) IS NULL,
    'a leader of someone else reached the group');
  n := n + 1; r := pg_temp.sr_try('authenticated', u_lead2, format('SELECT (%L::uuid IN (SELECT sg_visible_ids()))::text', ga));
  failed := failed || pg_temp.sr_ok(r = 'false', format('ga is in another leader''s sg_visible_ids (%s)', r));
  -- A person is in one team, so u_agent's team changes leader for these.
  UPDATE teams SET leader_user_id = u_gonel WHERE id = t_lead;
  n := n + 1; failed := failed || pg_temp.sr_ok(
    NOT sg_leads_group_agent(ga, u_gonel) AND NOT sg_can_read(ga, u_gonel) AND NOT sg_can_send(ga, u_gonel)
    AND sg_resolve_role(ga, u_gonel) IS NULL,
    'a deactivated leader reached the group');

  -- The order: a real row, then the leader, then the bank.
  UPDATE teams SET leader_user_id = u_both WHERE id = t_lead;
  n := n + 1; failed := failed || pg_temp.sr_ok(
    sg_read_role(ga, u_both, NULL, 60) IS NOT DISTINCT FROM 'agent' AND sg_resolve_role(ga, u_both) IS NOT DISTINCT FROM 'agent',
    'a leader with a real open row lost its label');
  UPDATE teams SET leader_user_id = u_lh WHERE id = t_lead;
  n := n + 1; failed := failed || pg_temp.sr_ok(
    sg_read_role(ga, u_lh, NULL, 60) IS NOT DISTINCT FROM 'team_lead' AND sg_resolve_role(ga, u_lh) IS NOT DISTINCT FROM 'team_lead',
    'a leader who also holds the bank is not team_lead');
  UPDATE teams SET leader_user_id = u_lead WHERE id = t_lead;
  n := n + 1; failed := failed || pg_temp.sr_ok(
    sg_read_role(ga, u_holder, NULL, 60) IS NOT DISTINCT FROM 'coordinator' AND sg_resolve_role(ga, u_holder) IS NOT DISTINCT FROM 'coordinator',
    'a bank holder is no longer coordinator');
  n := n + 1; failed := failed || pg_temp.sr_ok(
    has_function_privilege('service_role', 'public.sg_leads_group_agent(uuid, uuid)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.sg_leads_group_agent(uuid, uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.sg_leads_group_agent(uuid, uuid)', 'EXECUTE'),
    'sg_leads_group_agent is not service-role only');

  -- ---------- (b) mark read ----------
  n := n + 1; r := pg_temp.sr_try('authenticated', u_agent, format('SELECT sg_mark_read(%L)::text', ga));
  failed := failed || pg_temp.sr_ok(r NOT LIKE 'ERROR%', format('sg_mark_read refused the agent (%s)', r));
  n := n + 1; failed := failed || pg_temp.sr_ok(
    (SELECT last_read_at FROM submission_group_reads WHERE group_id = ga AND user_id = u_agent) = now()
    AND (SELECT account_id FROM submission_group_reads WHERE group_id = ga AND user_id = u_agent) = a_acct,
    'sg_mark_read did not write the marker');
  x := now() + interval '1 hour';
  UPDATE submission_group_reads SET last_read_at = x WHERE group_id = ga AND user_id = u_agent;
  r := pg_temp.sr_try('authenticated', u_agent, format('SELECT sg_mark_read(%L)::text', ga));
  n := n + 1; failed := failed || pg_temp.sr_ok(
    (SELECT last_read_at FROM submission_group_reads WHERE group_id = ga AND user_id = u_agent) = x,
    'sg_mark_read moved a marker back');
  UPDATE submission_group_reads SET last_read_at = now() - interval '2 hours' WHERE group_id = ga AND user_id = u_agent;
  r := pg_temp.sr_try('authenticated', u_agent, format('SELECT sg_mark_read(%L)::text', ga));
  n := n + 1; failed := failed || pg_temp.sr_ok(
    (SELECT last_read_at FROM submission_group_reads WHERE group_id = ga AND user_id = u_agent) = now(),
    'sg_mark_read did not move an older marker forward');
  n := n + 1; r := pg_temp.sr_try('authenticated', u_other, format('SELECT sg_mark_read(%L)::text', ga));
  failed := failed || pg_temp.sr_ok(r LIKE 'ERROR 42501%', format('a stranger marked a group read (%s)', r));
  n := n + 1; failed := failed || pg_temp.sr_ok(
    NOT EXISTS (SELECT 1 FROM submission_group_reads WHERE user_id = u_other),
    'a refused sg_mark_read left a marker');
  n := n + 1; r := pg_temp.sr_try('authenticated', u_coord, format('SELECT count(*)::text FROM submission_group_reads WHERE group_id = %L', ga));
  failed := failed || pg_temp.sr_ok(r = '0', format('a person read someone else''s marker (%s)', r));
  n := n + 1; r := pg_temp.sr_try('authenticated', u_agent, format('SELECT count(*)::text FROM submission_group_reads WHERE group_id = %L', ga));
  failed := failed || pg_temp.sr_ok(r = '1', format('a person cannot read their own marker (%s)', r));
  n := n + 1; r := pg_temp.sr_try('authenticated', u_agent, format(
    'UPDATE submission_group_reads SET last_read_at = now() WHERE group_id = %L RETURNING 1', ga));
  failed := failed || pg_temp.sr_ok(r LIKE 'ERROR 42501%', format('a client updated a marker (%s)', r));
  n := n + 1; r := pg_temp.sr_try('authenticated', u_coord, format(
    'INSERT INTO submission_group_reads (group_id, account_id, user_id, last_read_at) VALUES (%L, %L, %L, now()) RETURNING 1', ga, a_acct, u_coord));
  failed := failed || pg_temp.sr_ok(r LIKE 'ERROR 42501%', format('a client inserted a marker (%s)', r));
  DELETE FROM submission_group_reads WHERE group_id = ga;

  -- ---------- (c) unread ----------
  -- 'other' senders, so these rows ring nobody.
  INSERT INTO submission_group_messages (group_id, account_id, direction, sender_wa_id, sender_kind, body, wa_message_id, created_at) VALUES
    (ga, a_acct, 'in', '971500173009', 'other', 'old',  'sr-a0', now() - interval '10 days'),
    (ga, a_acct, 'in', '971500173009', 'other', 'one',  'sr-a1', now() - interval '1 hour'),
    (ga, a_acct, 'in', '971500173009', 'other', 'two',  'sr-a2', now() - interval '30 minutes'),
    (gb, a_acct, 'in', '971500173009', 'other', 'b1',   'sr-b1', now() - interval '3 hours'),
    (gb, a_acct, 'in', '971500173009', 'other', 'b2',   'sr-b2', now() - interval '2 hours'),
    (gb, a_acct, 'in', '971500173009', 'other', 'b3',   'sr-b3', now() - interval '1 hour'),
    (gn, a_acct, 'in', '971500173009', 'other', 'none', 'sr-n1', now() - interval '1 hour');
  n := n + 1; r := pg_temp.sr_unread(u_coord, ga);
  failed := failed || pg_temp.sr_ok(r = '2', format('no marker: want 2 unread (7-day rule), got %s', r));
  n := n + 1; r := pg_temp.sr_try('authenticated', u_coord, 'SELECT sg_unread_count()::text');
  failed := failed || pg_temp.sr_ok(r = '5', format('sg_unread_count is not the sum (want 5, got %s)', r));
  n := n + 1; r := pg_temp.sr_unread(u_coord, gn);
  failed := failed || pg_temp.sr_ok(r = '0', format('a wa_mode none group counted (%s)', r));
  INSERT INTO submission_group_reads (group_id, account_id, user_id, last_read_at)
  VALUES (ga, a_acct, u_coord, now() - interval '45 minutes');
  n := n + 1; r := pg_temp.sr_unread(u_coord, ga);
  failed := failed || pg_temp.sr_ok(r = '1', format('marker at -45m: want 1 unread, got %s', r));
  UPDATE submission_group_reads SET last_read_at = now() - interval '20 days' WHERE group_id = ga AND user_id = u_coord;
  n := n + 1; r := pg_temp.sr_unread(u_coord, ga);
  failed := failed || pg_temp.sr_ok(r = '3', format('a marker older than 7 days must win over the 7-day rule (want 3, got %s)', r));
  r := pg_temp.sr_try('authenticated', u_coord, format('SELECT sg_mark_read(%L)::text', ga));
  n := n + 1; r := pg_temp.sr_try('authenticated', u_coord, format(
    'SELECT count(*)::text FROM sg_unread_by_group() WHERE group_id = %L', ga));
  failed := failed || pg_temp.sr_ok(r = '0', format('a read group is still listed (%s)', r));
  n := n + 1; r := pg_temp.sr_try('authenticated', u_coord, 'SELECT sg_unread_count()::text');
  failed := failed || pg_temp.sr_ok(r = '3', format('after reading ga want 3 left, got %s', r));
  n := n + 1; r := pg_temp.sr_try('authenticated', u_other, 'SELECT sg_unread_count()::text');
  failed := failed || pg_temp.sr_ok(r = '0', format('a stranger has unread messages (%s)', r));
  n := n + 1; r := pg_temp.sr_try('authenticated', u_far, 'SELECT sg_unread_count()::text');
  failed := failed || pg_temp.sr_ok(r = '0', format('another account has unread messages here (%s)', r));
  n := n + 1; r := pg_temp.sr_unread(u_lead, ga);
  failed := failed || pg_temp.sr_ok(r = '2', format('the leader of the agent has no unread (%s)', r));
  n := n + 1; failed := failed || pg_temp.sr_ok(
    has_function_privilege('authenticated', 'public.sg_unread_count()', 'EXECUTE')
    AND has_function_privilege('service_role', 'public.sg_unread_by_group()', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.sg_mark_read(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.sg_unread_count()', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.sg_unread_by_group()', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.sg_mark_read(uuid)', 'EXECUTE'),
    'grants of the read functions');

  -- ---------- (d) the bell ----------
  b := sg_record_inbound(gr, 'sr-r1', '971500173009', 'coordinator', 'text', 'from a coordinator', NULL, NULL);
  b := sg_record_inbound(gr, 'sr-r2', '971500173009', 'other', 'text', 'from someone', NULL, NULL);
  n := n + 1; failed := failed || pg_temp.sr_ok(
    NOT EXISTS (SELECT 1 FROM notifications WHERE type = 'submission_group_message' AND meta ->> 'group_id' = gr::text),
    'a coordinator or other sender rang the bell');

  b := sg_record_inbound(gr, 'sr-r3', '971500173001', 'customer', 'text', 'SECRET-TEXT-173', NULL, NULL);
  n := n + 1; failed := failed || pg_temp.sr_ok(
    pg_temp.sr_bells(u_agent, gr) = 1 AND pg_temp.sr_bells(u_coord, gr) = 1 AND pg_temp.sr_bells(u_both, gr) = 1,
    'an open agent / coordinator row got no bell');
  n := n + 1; failed := failed || pg_temp.sr_ok(
    pg_temp.sr_bells(u_holder, gr) = 1 AND pg_temp.sr_bells(u_lh, gr) = 1,
    'a live holder of the bank got no bell');
  n := n + 1; failed := failed || pg_temp.sr_ok(
    pg_temp.sr_bells(u_tlrow, gr) = 0 AND pg_temp.sr_bells(u_lead, gr) = 0,
    'a team lead got a bell');
  n := n + 1; failed := failed || pg_temp.sr_ok(
    pg_temp.sr_bells(u_owner, gr) = 0 AND pg_temp.sr_bells(u_other, gr) = 0
    AND pg_temp.sr_bells(u_goneh, gr) = 0 AND pg_temp.sr_bells(u_view, gr) = 0,
    'an admin, a stranger, a deactivated or a viewer holder got a bell');
  n := n + 1; failed := failed || pg_temp.sr_ok(
    NOT EXISTS (SELECT 1 FROM notifications WHERE type = 'submission_group_message'
                 AND (title LIKE '%SECRET%' OR coalesce(body, '') LIKE '%SECRET%' OR meta::text LIKE '%SECRET%')),
    'the bell carries the customer''s message');
  n := n + 1; failed := failed || pg_temp.sr_ok(
    (SELECT title FROM notifications WHERE user_id = u_agent AND meta ->> 'group_id' = gr::text) LIKE '%Acme LLC%'
    AND (SELECT account_id FROM notifications WHERE user_id = u_agent AND meta ->> 'group_id' = gr::text) = a_acct,
    'the bell does not name the customer');
  n := n + 1; failed := failed || pg_temp.sr_ok(
    (SELECT push_bell_url(nn) FROM notifications nn WHERE nn.user_id = u_agent AND nn.meta ->> 'group_id' = gr::text)
      = '/submission-groups/' || gr,
    'push_bell_url does not open the group');

  b := sg_record_inbound(gr, 'sr-r4', '971500173001', 'customer', 'text', 'again', NULL, NULL);
  n := n + 1; failed := failed || pg_temp.sr_ok(pg_temp.sr_bells(u_agent, gr) = 1, 'a busy group rang twice');
  b := sg_record_inbound(gr, 'sr-r4', '971500173001', 'customer', 'text', 'again', NULL, NULL);
  n := n + 1; failed := failed || pg_temp.sr_ok(NOT b AND pg_temp.sr_bells(u_coord, gr) = 1, 'a redelivery was recorded or rang');
  UPDATE notifications SET read_at = now() WHERE user_id = u_agent AND type = 'submission_group_message';
  b := sg_record_inbound(gr, 'sr-r5', '971500173001', 'customer', 'text', 'after reading', NULL, NULL);
  n := n + 1; failed := failed || pg_temp.sr_ok(
    pg_temp.sr_bells(u_agent, gr) = 2 AND pg_temp.sr_bells(u_coord, gr) = 1,
    'a read bell did not let the next message ring only that person');
  b := sg_record_inbound(gq, 'sr-q1', '971500173001', 'customer', 'text', 'other group', NULL, NULL);
  n := n + 1; failed := failed || pg_temp.sr_ok(
    pg_temp.sr_bells(u_coord, gq) = 1
    AND (SELECT title FROM notifications WHERE user_id = u_coord AND meta ->> 'group_id' = gq::text) LIKE '%SR-173-Q%',
    'a second group did not ring, or its bell does not fall back to the submission_ref');

  -- Opening the group without clicking the bell. A bell another account
  -- holds for this group and another type of bell stay unread.
  INSERT INTO notifications (account_id, user_id, type, title, meta) VALUES
    ((SELECT account_id FROM profiles WHERE user_id = u_far), u_coord, 'submission_group_message', 'SR elsewhere',
     jsonb_build_object('group_id', gr)),
    (a_acct, u_coord, 'task_assigned', 'SR other type', jsonb_build_object('group_id', gr));
  b := sg_record_inbound(gr, 'sr-r5b', '971500173001', 'customer', 'text', 'before marking read', NULL, NULL);
  n := n + 1; failed := failed || pg_temp.sr_ok(
    (SELECT count(*) FROM notifications WHERE user_id = u_coord AND account_id = a_acct
      AND type = 'submission_group_message' AND meta ->> 'group_id' = gr::text) = 1,
    'a message rang someone who has not read the group or the bell');
  n := n + 1; r := pg_temp.sr_try('authenticated', u_coord, format('SELECT sg_mark_read(%L)::text', gr));
  failed := failed || pg_temp.sr_ok(r NOT LIKE 'ERROR%', format('sg_mark_read refused the coordinator (%s)', r));
  n := n + 1; failed := failed || pg_temp.sr_ok(
    NOT EXISTS (SELECT 1 FROM notifications WHERE user_id = u_coord AND account_id = a_acct AND read_at IS NULL
                 AND type = 'submission_group_message' AND meta ->> 'group_id' = gr::text),
    'sg_mark_read left the group''s bell unread');
  n := n + 1; failed := failed || pg_temp.sr_ok(
    (SELECT count(*) FROM notifications WHERE user_id = u_coord AND read_at IS NULL AND title LIKE 'SR %') = 2,
    'sg_mark_read read another account''s bell or another type of bell');
  n := n + 1; failed := failed || pg_temp.sr_ok(
    EXISTS (SELECT 1 FROM notifications WHERE user_id = u_coord AND read_at IS NULL AND meta ->> 'group_id' = gq::text),
    'sg_mark_read read the bell of another group');
  n := n + 1; failed := failed || pg_temp.sr_ok(
    EXISTS (SELECT 1 FROM notifications WHERE user_id = u_holder AND read_at IS NULL AND meta ->> 'group_id' = gr::text),
    'sg_mark_read read someone else''s bell');
  DELETE FROM notifications WHERE user_id = u_coord AND title LIKE 'SR %';
  b := sg_record_inbound(gr, 'sr-r5c', '971500173001', 'customer', 'text', 'after marking read', NULL, NULL);
  n := n + 1; failed := failed || pg_temp.sr_ok(
    pg_temp.sr_bells(u_coord, gr) = 2 AND pg_temp.sr_bells(u_holder, gr) = 1,
    'marking the group read did not let the next message ring only that person');

  -- ---------- (e) ENDED groups ----------
  INSERT INTO submission_group_messages (group_id, account_id, direction, sender_wa_id, sender_kind, body, wa_message_id, created_at)
  VALUES (ge, a_acct, 'in', '971500173009', 'other', 'e1', 'sr-e1', now() - interval '1 hour');
  n := n + 1; r := pg_temp.sr_unread(u_coord, ge);
  failed := failed || pg_temp.sr_ok(r = '1', format('ge should be unread while ACTIVE (%s)', r));
  n := n + 1; failed := failed || pg_temp.sr_ok(sg_can_read(ge, u_lead), 'fixture: the leader should read ge while ACTIVE');
  b := sg_end(ge, 'test');
  n := n + 1; failed := failed || pg_temp.sr_ok(
    NOT sg_can_read(ge, u_lead) AND NOT sg_can_send(ge, u_lead)
    AND sg_read_role(ge, u_lead, NULL, 60) IS NULL AND sg_resolve_role(ge, u_lead) IS NULL,
    'the agent''s leader reached an ENDED group');
  n := n + 1; r := pg_temp.sr_try('authenticated', u_lead, format('SELECT (%L::uuid IN (SELECT sg_visible_ids()))::text', ge));
  failed := failed || pg_temp.sr_ok(r = 'false', format('an ENDED group is in the leader''s sg_visible_ids (%s)', r));
  n := n + 1; failed := failed || pg_temp.sr_ok(sg_can_read(ge, u_tlrow) AND NOT sg_can_send(ge, u_tlrow),
    'a team_lead on the list at the end lost the archive window, or may send');
  n := n + 1; r := pg_temp.sr_unread(u_coord, ge);
  failed := failed || pg_temp.sr_ok(r = '0', format('an ENDED group counted as unread (%s)', r));
  n := n + 1; r := pg_temp.sr_try('authenticated', u_coord, format('SELECT sg_mark_read(%L)::text', ge));
  failed := failed || pg_temp.sr_ok(r LIKE 'ERROR 42501%', format('an ENDED group was marked read (%s)', r));
  b := sg_record_inbound(ge, 'sr-e2', '971500173001', 'customer', 'text', 'too late', NULL, NULL);
  n := n + 1; failed := failed || pg_temp.sr_ok(b AND pg_temp.sr_bells(u_agent, ge) = 1
    AND pg_temp.sr_bells(u_lead, ge) = 0 AND pg_temp.sr_bells(u_tlrow, ge) = 0,
    'a post-end message rings the agent whose access was open when it ended, and nobody else (267)');

  -- ---------- (f) tombstones ----------
  n := n + 1; failed := failed || pg_temp.sr_ok(
    (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'public.whatsapp_group_tombstones'::regclass)
    AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'whatsapp_group_tombstones')
    AND NOT has_table_privilege('authenticated', 'public.whatsapp_group_tombstones', 'SELECT')
    AND NOT has_table_privilege('anon', 'public.whatsapp_group_tombstones', 'SELECT'),
    'whatsapp_group_tombstones is not closed to clients');
  n := n + 1; r := pg_temp.sr_try('authenticated', u_owner, 'SELECT count(*)::text FROM whatsapp_group_tombstones');
  failed := failed || pg_temp.sr_ok(r LIKE 'ERROR 42501%', format('an owner read the tombstones (%s)', r));
  n := n + 1; r := pg_temp.sr_try('authenticated', u_owner, format(
    'INSERT INTO whatsapp_group_tombstones (account_id, channel_id, wa_group_id) VALUES (%L, %L, ''x'') RETURNING 1', a_acct, w1));
  failed := failed || pg_temp.sr_ok(r LIKE 'ERROR 42501%', format('an owner wrote a tombstone (%s)', r));
  n := n + 1; r := pg_temp.sr_try('service_role', NULL, format(
    'INSERT INTO whatsapp_group_tombstones (account_id, channel_id, wa_group_id, deleted_by) VALUES (%L, %L, ''120363000000173009@g.us'', %L) RETURNING deleted_at IS NOT NULL', a_acct, w1, u_owner));
  failed := failed || pg_temp.sr_ok(r = 'true', format('the service role cannot write a tombstone (%s)', r));

  -- ---------- (g) mirrored rows leave the Groups count ----------
  -- All created by u_other, who sees none of the submission groups: the
  -- exclusion must not depend on the caller seeing them. gm ends, so
  -- ENDED ones go too.
  tok := sg_claim_create(ga, 60000);
  b := sg_attach_wa_group(ga, '120363000000173001@g.us', NULL, tok);
  tok := sg_claim_create(gm, 60000);
  b := sg_attach_wa_group(gm, '120363000000173002@g.us', NULL, tok);
  b := sg_end(gm, 'test');
  INSERT INTO whatsapp_groups (account_id, channel_id, wa_group_id, name, created_by, our_role) VALUES
    (a_acct, w1, '120363000000173001@g.us', 'SR mirror active', u_other, 'admin'),
    (a_acct, w1, '120363000000173002@g.us', 'SR mirror ended',  u_other, 'admin'),
    (a_acct, w1, '120363000000173003@g.us', 'SR plain',         u_other, 'admin');
  INSERT INTO whatsapp_group_messages (account_id, group_id, wa_message_id, direction, body, created_at)
  SELECT a_acct, g.id, 'sr-w-' || g.wa_group_id, 'in', 'x', now() - interval '1 hour'
    FROM whatsapp_groups g WHERE g.account_id = a_acct AND g.name LIKE 'SR %';
  n := n + 1; r := pg_temp.sr_try('authenticated', u_other, 'SELECT whatsapp_group_unread_count()::text');
  failed := failed || pg_temp.sr_ok(r = '1', format('a caller who sees no submission group counts mirrors (want 1, got %s)', r));
  n := n + 1; r := pg_temp.sr_try('authenticated', u_owner, 'SELECT whatsapp_group_unread_count()::text');
  failed := failed || pg_temp.sr_ok(r = '1', format('an owner counts mirrors (want 1, got %s)', r));
  n := n + 1; r := pg_temp.sr_try('authenticated', u_far, 'SELECT whatsapp_group_unread_count()::text');
  failed := failed || pg_temp.sr_ok(r = '0', format('another account counts these groups (%s)', r));

  -- ---------- (i) group access follows the case ----------
  gx := (SELECT o.group_id FROM sg_open(a_acct, 'SR-173-X', c1, w1, 'x', NULL, acc, NULL, 'group') o);
  gy := (SELECT o.group_id FROM sg_open(a_acct, 'SR-173-Y', c1, w1, 'y', NULL, acc, NULL, 'group') o);
  gz := (SELECT o.group_id FROM sg_open(a_acct, 'SR-173-Z', c1, w1, 'z', NULL, acc, NULL, 'group') o);
  gw := (SELECT o.group_id FROM sg_open(a_acct, 'SR-173-W', c1, w1, 'w', NULL, acc, NULL, 'group') o);
  gv := (SELECT o.group_id FROM sg_open(a_acct, 'SR-173-V', c1, w1, 'v', NULL, acc, NULL, 'group') o);
  gu := (SELECT o.group_id FROM sg_open(a_acct, 'SR-173-U', c1, w1, 'u', NULL, acc, NULL, 'group') o);
  PERFORM case_open(gx, 'SRB', 'Bank SR', NULL, NULL, NULL);
  PERFORM case_open(gy, 'SRB', 'Bank SR', NULL, NULL, NULL);
  PERFORM case_open(gz, 'SRB', 'Bank SR', NULL, NULL, NULL);
  PERFORM case_open(gw, 'SRB', 'Bank SR', NULL, NULL, NULL);
  PERFORM case_open(gv, 'SRB', 'Bank SR', NULL, NULL, NULL);
  PERFORM case_open(gu, 'SRB', 'Bank SR', NULL, NULL, NULL);
  SELECT id INTO kx FROM cases WHERE group_id = gx;
  SELECT id INTO ky FROM cases WHERE group_id = gy;
  SELECT id INTO kz FROM cases WHERE group_id = gz;
  SELECT id INTO kw FROM cases WHERE group_id = gw;
  SELECT id INTO kv FROM cases WHERE group_id = gv;
  IF (SELECT count(*) FROM cases WHERE id IN (kx, ky, kz, kw, kv)
       AND agent_id = u_agent AND coordinator_id = u_coord) <> 5 THEN
    RAISE EXCEPTION 'fixture: the reassign cases do not name u_agent and u_coord';
  END IF;

  -- The agent, A to B: A out, B in, the bell follows.
  n := n + 1; failed := failed || pg_temp.sr_ok(
    pg_temp.sr_sees(u_agent, gx) = '1' AND pg_temp.sr_sees(u_other, gx) = '0',
    'fixture: before the reassign the agent should see gx and the stranger not');
  b := (SELECT f.changed FROM case_reassign(kx, u_owner, 'agent', u_other) f);
  r := pg_temp.sr_open(gx, u_agent);
  n := n + 1; failed := failed || pg_temp.sr_ok(b AND r = 'none', format('the old agent''s row stayed open (%s)', r));
  r := pg_temp.sr_open(gx, u_other);
  n := n + 1; failed := failed || pg_temp.sr_ok(r = 'agent', format('the new agent has no agent row (%s)', r));
  n := n + 1; failed := failed || pg_temp.sr_ok(
    NOT sg_can_read(gx, u_agent) AND sg_can_read(gx, u_other)
    AND pg_temp.sr_sees(u_agent, gx) = '0' AND pg_temp.sr_sees(u_other, gx) = '1',
    'after the reassign the old agent still reads gx, or the new one does not');
  n := n + 1; failed := failed || pg_temp.sr_ok(
    (SELECT a.added_by FROM submission_group_access a
      WHERE a.group_id = gx AND a.user_id = u_other AND a.removed_at IS NULL) = u_other,
    'with no signed-in user, added_by should fall back to the new person');
  b := sg_record_inbound(gx, 'sr-x1', '971500173001', 'customer', 'text', 'to the new agent', NULL, NULL);
  n := n + 1; i := pg_temp.sr_bells(u_other, gx);
  failed := failed || pg_temp.sr_ok(b AND i = 1, format('the new agent was not rung (%s)', i));
  n := n + 1; i := pg_temp.sr_bells(u_agent, gx);
  failed := failed || pg_temp.sr_ok(i = 0, format('the old agent was rung (%s)', i));

  -- The coordinator, by a signed-in admin; a team_lead row is not touched.
  PERFORM set_config('request.jwt.claim.sub', u_owner::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  b := (SELECT f.changed FROM case_reassign(kx, u_owner, 'coordinator', u_both) f);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  r := pg_temp.sr_open(gx, u_coord);
  n := n + 1; failed := failed || pg_temp.sr_ok(b AND r = 'none', format('the old coordinator''s row stayed open (%s)', r));
  r := pg_temp.sr_open(gx, u_both);
  n := n + 1; failed := failed || pg_temp.sr_ok(r = 'coordinator', format('the new coordinator has no row (%s)', r));
  n := n + 1; failed := failed || pg_temp.sr_ok(
    NOT sg_can_read(gx, u_coord) AND sg_can_read(gx, u_both),
    'the coordinator reassign did not move the read');
  n := n + 1; failed := failed || pg_temp.sr_ok(
    (SELECT a.added_by FROM submission_group_access a
      WHERE a.group_id = gx AND a.user_id = u_both AND a.removed_at IS NULL) = u_owner,
    'added_by should be the signed-in user');
  r := pg_temp.sr_open(gx, u_tlrow);
  n := n + 1; failed := failed || pg_temp.sr_ok(r = 'team_lead', format('a reassign touched the team_lead row (%s)', r));
  -- sr-x1 rang the coordinator while they held the seat: read that one,
  -- or the unread rule would hide a second bell.
  UPDATE notifications SET read_at = now()
   WHERE type = 'submission_group_message' AND meta ->> 'group_id' = gx::text AND read_at IS NULL;
  was := pg_temp.sr_bells(u_coord, gx);
  b := sg_record_inbound(gx, 'sr-x2', '971500173001', 'customer', 'text', 'to the new coordinator', NULL, NULL);
  n := n + 1; i := pg_temp.sr_bells(u_both, gx);
  failed := failed || pg_temp.sr_ok(b AND i = 1, format('the new coordinator was not rung (%s)', i));
  n := n + 1; i := pg_temp.sr_bells(u_coord, gx);
  failed := failed || pg_temp.sr_ok(i = was, format('the old coordinator was rung (%s to %s)', was, i));

  -- The old coordinator becomes the agent: one open row, the new label.
  b := (SELECT f.changed FROM case_reassign(ky, u_owner, 'agent', u_coord) f);
  r := pg_temp.sr_open(gy, u_coord);
  n := n + 1; failed := failed || pg_temp.sr_ok(b AND r = 'agent', format('old coordinator as agent: want one agent row, got %s', r));
  r := pg_temp.sr_open(gy, u_agent);
  n := n + 1; failed := failed || pg_temp.sr_ok(r = 'none', format('swap: the old agent''s row stayed open (%s)', r));
  -- Their coordinator seat goes: the 'agent' row is not that seat's.
  b := (SELECT f.changed FROM case_reassign(ky, u_owner, 'coordinator', u_other) f);
  r := pg_temp.sr_open(gy, u_coord) || '/' || pg_temp.sr_open(gy, u_other);
  n := n + 1; failed := failed || pg_temp.sr_ok(b AND r = 'agent/coordinator', format('leaving the coordinator seat: want agent/coordinator, got %s', r));
  -- A true swap in one statement.
  UPDATE cases SET agent_id = u_other, coordinator_id = u_coord WHERE id = ky;
  r := pg_temp.sr_open(gy, u_other) || '/' || pg_temp.sr_open(gy, u_coord);
  n := n + 1; failed := failed || pg_temp.sr_ok(r = 'agent/coordinator', format('one-statement swap: want agent/coordinator, got %s', r));
  -- Named in both, then out of the seat their row is labelled for: they
  -- are still the coordinator, so they keep a row as that.
  b := (SELECT f.changed FROM case_reassign(ky, u_owner, 'agent', u_coord) f);
  r := pg_temp.sr_open(gy, u_coord);
  n := n + 1; failed := failed || pg_temp.sr_ok(b AND r = 'agent', format('named in both: want agent, got %s', r));
  b := (SELECT f.changed FROM case_reassign(ky, u_owner, 'agent', u_agent) f);
  r := pg_temp.sr_open(gy, u_coord) || '/' || pg_temp.sr_open(gy, u_agent);
  n := n + 1; failed := failed || pg_temp.sr_ok(b AND r = 'coordinator/agent', format('still the coordinator: want coordinator/agent, got %s', r));

  -- Another label on the old person stays.
  PERFORM sg_access_set(gv, u_agent, 'team_lead', NULL);
  b := (SELECT f.changed FROM case_reassign(kv, u_owner, 'agent', u_other) f);
  r := pg_temp.sr_open(gv, u_agent) || '/' || pg_temp.sr_open(gv, u_other);
  n := n + 1; failed := failed || pg_temp.sr_ok(b AND r = 'team_lead/agent', format('another label should stay: want team_lead/agent, got %s', r));

  -- An ENDED group: the case moves, no access row does.
  b := sg_end(gz, 'test');
  r := (SELECT string_agg(a.id::text || ':' || coalesce(a.removed_at::text, 'open'), ',' ORDER BY a.id)
          FROM submission_group_access a WHERE a.group_id = gz);
  b := (SELECT f.changed FROM case_reassign(kz, u_owner, 'agent', u_other) f);
  n := n + 1; failed := failed || pg_temp.sr_ok(
    b AND (SELECT agent_id FROM cases WHERE id = kz) = u_other
    AND r = (SELECT string_agg(a.id::text || ':' || coalesce(a.removed_at::text, 'open'), ',' ORDER BY a.id)
               FROM submission_group_access a WHERE a.group_id = gz),
    'a reassign on an ENDED group changed an access row, or did not reassign');

  -- A failure inside the trigger: a viewer cannot be on the list, so
  -- sg_access_set refuses. case_reassign refuses a viewer itself; a
  -- direct write is what reaches the trigger.
  r := pg_temp.sr_try(NULL, NULL, format(
    'UPDATE cases SET agent_id = %L WHERE id = %L RETURNING agent_id::text', u_view, kw));
  n := n + 1; failed := failed || pg_temp.sr_ok(r = u_view::text, format('a failing trigger failed the reassign (%s)', r));
  r := pg_temp.sr_open(gw, u_view) || '/' || pg_temp.sr_open(gw, u_agent);
  n := n + 1; failed := failed || pg_temp.sr_ok(r = 'none/agent', format('a failing trigger should move nothing: want none/agent, got %s', r));

  -- The backfill: gu's coordinator lost their row, its agent holds
  -- another label, a stranger holds an open row.
  b := sg_access_remove(gu, u_coord);
  PERFORM sg_access_set(gu, u_agent, 'team_lead', NULL);
  PERFORM sg_access_set(gu, u_other, 'coordinator', NULL);
  was := (SELECT count(*) FROM submission_group_access WHERE removed_at IS NOT NULL);
  i := case_backfill_group_access();
  r := pg_temp.sr_open(gu, u_coord);
  n := n + 1; failed := failed || pg_temp.sr_ok(i >= 1 AND r = 'coordinator', format('the backfill did not add the coordinator (added %s, %s)', i, r));
  r := pg_temp.sr_open(gu, u_agent) || '/' || pg_temp.sr_open(gu, u_other);
  n := n + 1; failed := failed || pg_temp.sr_ok(r = 'team_lead/coordinator', format('the backfill changed another row: want team_lead/coordinator, got %s', r));
  r := pg_temp.sr_open(gw, u_view) || '/' || pg_temp.sr_open(gz, u_other);
  n := n + 1; failed := failed || pg_temp.sr_ok(r = 'none/none', format('the backfill added a viewer or touched an ENDED group (%s)', r));
  n := n + 1; i := (SELECT count(*) FROM submission_group_access WHERE removed_at IS NOT NULL);
  failed := failed || pg_temp.sr_ok(i = was, format('the backfill closed rows (%s to %s)', was, i));
  i := case_backfill_group_access();
  n := n + 1; failed := failed || pg_temp.sr_ok(i = 0, format('a second backfill added %s rows', i));

  -- The bell's lock limit, and a constraint validated after the swap.
  n := n + 1; failed := failed || pg_temp.sr_ok(
    (SELECT 'lock_timeout=1s' = ANY (p.proconfig) FROM pg_proc p WHERE p.oid = 'public.sg_ring_customer_message()'::regprocedure)
    AND (SELECT 'lock_timeout=1s' = ANY (p.proconfig) FROM pg_proc p WHERE p.oid = 'public.case_move_group_access()'::regprocedure),
    'a trigger function has no lock_timeout');
  n := n + 1; failed := failed || pg_temp.sr_ok(
    (SELECT c.convalidated FROM pg_constraint c
      WHERE c.conname = 'notifications_type_check' AND c.conrelid = 'public.notifications'::regclass),
    'notifications_type_check is not validated');

  -- ---------- (h) a failing bell never loses the message ----------
  -- Read first: NOT VALID spares existing rows only until they are updated.
  UPDATE notifications SET read_at = now() WHERE type = 'submission_group_message' AND read_at IS NULL;
  ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
  ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
    CHECK (type <> 'submission_group_message') NOT VALID;
  b := sg_record_inbound(gr, 'sr-r6', '971500173001', 'customer', 'text', 'bell fails', NULL, NULL);
  n := n + 1; failed := failed || pg_temp.sr_ok(
    b AND EXISTS (SELECT 1 FROM submission_group_messages WHERE group_id = gr AND wa_message_id = 'sr-r6')
    AND NOT EXISTS (SELECT 1 FROM notifications WHERE type = 'submission_group_message' AND read_at IS NULL),
    'a failing bell lost the message, or the bell did not fail');

  RAISE EXCEPTION USING ERRCODE = 'ZT173', MESSAGE = 'verify-submission-group-reads rollback';
  EXCEPTION WHEN SQLSTATE 'ZT173' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'submission group reads verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'submission group reads verification passed (% checks)', n;
END
$verify$;
