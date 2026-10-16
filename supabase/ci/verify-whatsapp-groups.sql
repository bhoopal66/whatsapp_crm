-- Behavioural regression suite for WhatsApp groups (migration 114).
--
-- Who sees a group is whatsapp_group_can_view (the policies read it as
-- the set whatsapp_group_visible_ids): in the caller's active
-- workspace, owner/admin every group; else the creator, a manager, or a
-- team leader of a team the creator or a manager is in. Who manages it
-- is whatsapp_group_can_manage: owner/admin, or an agent/leader who
-- created or manages it on a number can_use_channel allows. This
-- asserts those rules for every kind of reader (another agent, a
-- viewer, a bank guest and another workspace see nothing they should
-- not), that the invite link reads only for managers, that no client
-- writes any of the five tables, whatsapp_group_can_create, the
-- channel guard (a Meta row and another workspace's row are refused, a
-- removed number leaves the group as history), the archived-workspace
-- trigger, the last_message_at bump, grants, forced RLS and the
-- realtime publication.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000114001';
  u_admin  UUID := '00000000-0000-4000-8000-000000114002';
  u_lead   UUID := '00000000-0000-4000-8000-000000114003';
  u_maker  UUID := '00000000-0000-4000-8000-000000114004';  -- agent in u_lead's team, creates g1
  u_mgr    UUID := '00000000-0000-4000-8000-000000114005';  -- agent, manages g2
  u_out    UUID := '00000000-0000-4000-8000-000000114006';  -- agent, nothing to do with any group
  u_viewer UUID := '00000000-0000-4000-8000-000000114007';  -- viewer, manages g3
  u_guest  UUID := '00000000-0000-4000-8000-000000114008';
  u_unal   UUID := '00000000-0000-4000-8000-000000114009';  -- agent, creates g4 on a number not allocated to them
  u_other  UUID := '00000000-0000-4000-8000-000000114010';  -- owner of account B
  a_acct   UUID;
  b_acct   UUID;
  w1       UUID;  -- A, Whapi, shared
  w2       UUID;  -- A, Whapi, allocated to u_admin only
  w3       UUID;  -- A, Whapi, removed below
  wm       UUID;  -- A, Meta
  wb       UUID;  -- B, Whapi
  t1       UUID;
  g1       UUID;
  g2       UUID;
  g3       UUID;
  g4       UUID;
  g5       UUID;
  gb       UUID;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as a signed-in user: a SELECT's value, 'ok', or the
  -- error as 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.wg_try(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        IF p_sql ILIKE 'select%' OR p_sql ILIKE 'with%' THEN
          EXECUTE p_sql INTO v;
        ELSE
          EXECUTE p_sql;
        END IF;
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

  -- Fixture: account A (owner, admin, a team leader, four agents, a
  -- viewer, a bank guest), account B (owner).
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'wg-owner@example.invalid'),
    (u_admin,  'wg-admin@example.invalid'),
    (u_lead,   'wg-lead@example.invalid'),
    (u_maker,  'wg-maker@example.invalid'),
    (u_mgr,    'wg-mgr@example.invalid'),
    (u_out,    'wg-out@example.invalid'),
    (u_viewer, 'wg-viewer@example.invalid'),
    (u_guest,  'wg-guest@example.invalid'),
    (u_unal,   'wg-unal@example.invalid'),
    (u_other,  'wg-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_other;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_maker, u_mgr, u_out, u_unal);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_viewer;
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_guest;

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'WG-114-A1', 'x', 'connected', true) RETURNING id INTO w1;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'WG-114-A2', 'x', 'connected', false) RETURNING id INTO w2;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'WG-114-A3', 'x', 'connected', false) RETURNING id INTO w3;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'meta', 'WG-114-AM', 'x', 'connected', false) RETURNING id INTO wm;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_other, b_acct, 'whapi', 'WG-114-B1', 'x', 'connected', true) RETURNING id INTO wb;
  INSERT INTO whatsapp_channel_members (config_id, user_id, account_id) VALUES (w2, u_admin, a_acct);

  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'WG team', u_lead) RETURNING id INTO t1;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (t1, u_maker, a_acct);

  INSERT INTO whatsapp_groups (account_id, channel_id, wa_group_id, name, created_by, our_role)
  VALUES (a_acct, w1, '120363000000114001@g.us', 'WG one', u_maker, 'admin') RETURNING id INTO g1;
  INSERT INTO whatsapp_groups (account_id, channel_id, wa_group_id, name, created_by, our_role)
  VALUES (a_acct, w1, '120363000000114002@g.us', 'WG two (synced)', NULL, 'admin') RETURNING id INTO g2;
  INSERT INTO whatsapp_groups (account_id, channel_id, wa_group_id, name, created_by, our_role)
  VALUES (a_acct, w1, '120363000000114003@g.us', 'WG three', u_admin, 'admin') RETURNING id INTO g3;
  INSERT INTO whatsapp_groups (account_id, channel_id, wa_group_id, name, created_by, our_role)
  VALUES (a_acct, w2, '120363000000114004@g.us', 'WG four', u_unal, 'admin') RETURNING id INTO g4;
  INSERT INTO whatsapp_groups (account_id, channel_id, wa_group_id, name, created_by, our_role)
  VALUES (a_acct, w3, '120363000000114005@g.us', 'WG five', u_maker, 'admin') RETURNING id INTO g5;
  INSERT INTO whatsapp_groups (account_id, channel_id, wa_group_id, name, created_by, our_role)
  VALUES (b_acct, wb, '120363000000114006@g.us', 'WG B', u_other, 'admin') RETURNING id INTO gb;

  INSERT INTO whatsapp_group_managers (group_id, account_id, user_id) VALUES
    (g2, a_acct, u_mgr), (g3, a_acct, u_viewer);
  INSERT INTO whatsapp_group_participants (group_id, account_id, wa_id, role) VALUES
    (g1, a_acct, '971500000001', 'superadmin'), (g2, a_acct, '971500000002', 'member'),
    (g3, a_acct, '971500000003', 'member'), (gb, b_acct, '971500000004', 'member');
  INSERT INTO whatsapp_group_invites (group_id, account_id, invite_code, invite_link) VALUES
    (g1, a_acct, 'AbCdEf114one', 'https://chat.whatsapp.com/AbCdEf114one'),
    (g3, a_acct, 'AbCdEf114three', 'https://chat.whatsapp.com/AbCdEf114three'),
    (gb, b_acct, 'AbCdEf114bee', 'https://chat.whatsapp.com/AbCdEf114bee');
  INSERT INTO whatsapp_group_messages (account_id, group_id, wa_message_id, direction, body, created_at) VALUES
    (a_acct, g1, 'wg-m1', 'in', 'one', now() - interval '1 hour'),
    (a_acct, g2, 'wg-m2', 'in', 'two', now()),
    (a_acct, g3, 'wg-m3', 'out', 'three', now()),
    (a_acct, g4, 'wg-m4', 'out', 'four', now()),
    (b_acct, gb, 'wg-mb', 'in', 'bee', now());

  -- ---------- who sees ----------
  r := pg_temp.wg_try(u_owner, format('SELECT string_agg(name, '','' ORDER BY name) FROM whatsapp_groups WHERE id <> %L', g5));
  n := n + 1;
  IF r <> 'WG four,WG one,WG three,WG two (synced)' THEN
    failed := array_append(failed, ('owner does not see exactly A''s groups: ' || r)::text);
  END IF;
  r := pg_temp.wg_try(u_admin, 'SELECT count(*)::text FROM whatsapp_groups');
  n := n + 1;
  IF r <> '5' THEN failed := array_append(failed, ('admin does not see all 5 of A''s groups: ' || r)::text); END IF;
  r := pg_temp.wg_try(u_admin, 'SELECT count(*)::text FROM whatsapp_group_messages');
  n := n + 1;
  IF r <> '4' THEN failed := array_append(failed, ('admin does not read A''s 4 group messages: ' || r)::text); END IF;

  r := pg_temp.wg_try(u_maker, 'SELECT string_agg(name, '','' ORDER BY name) FROM whatsapp_groups');
  n := n + 1;
  IF r <> 'WG five,WG one' THEN failed := array_append(failed, ('creator sees other than their groups: ' || r)::text); END IF;
  r := pg_temp.wg_try(u_mgr, 'SELECT string_agg(name, '','' ORDER BY name) FROM whatsapp_groups');
  n := n + 1;
  IF r <> 'WG two (synced)' THEN failed := array_append(failed, ('manager sees other than their group: ' || r)::text); END IF;
  r := pg_temp.wg_try(u_mgr, 'SELECT (SELECT count(*) FROM whatsapp_group_messages) || ''/'' || (SELECT count(*) FROM whatsapp_group_participants) || ''/'' || (SELECT count(*) FROM whatsapp_group_managers)');
  n := n + 1;
  IF r <> '1/1/1' THEN failed := array_append(failed, ('manager does not read exactly their group''s messages/participants/managers: ' || r)::text); END IF;

  -- A leader: the groups of a person in a team they lead (u_maker),
  -- not the synced one u_mgr manages nor the admin's.
  r := pg_temp.wg_try(u_lead, 'SELECT string_agg(name, '','' ORDER BY name) FROM whatsapp_groups');
  n := n + 1;
  IF r <> 'WG five,WG one' THEN failed := array_append(failed, ('leader does not see exactly their team''s groups: ' || r)::text); END IF;
  r := pg_temp.wg_try(u_lead, format('SELECT whatsapp_group_can_view(%L)::text || ''/'' || whatsapp_group_can_manage(%L)::text', g1, g1));
  n := n + 1;
  IF r <> 'true/false' THEN failed := array_append(failed, ('leader on a team member''s group should view, not manage: ' || r)::text); END IF;

  r := pg_temp.wg_try(u_out, 'SELECT (SELECT count(*) FROM whatsapp_groups) || ''/'' || (SELECT count(*) FROM whatsapp_group_messages) || ''/'' || (SELECT count(*) FROM whatsapp_group_participants) || ''/'' || (SELECT count(*) FROM whatsapp_group_managers) || ''/'' || (SELECT count(*) FROM whatsapp_group_invites)');
  n := n + 1;
  IF r <> '0/0/0/0/0' THEN failed := array_append(failed, ('another agent reads something: ' || r)::text); END IF;
  r := pg_temp.wg_try(u_out, format('SELECT whatsapp_group_can_view(%L)::text', g1));
  n := n + 1;
  IF r <> 'false' THEN failed := array_append(failed, ('another agent can view a group: ' || r)::text); END IF;

  r := pg_temp.wg_try(u_viewer, 'SELECT string_agg(name, '','' ORDER BY name) FROM whatsapp_groups');
  n := n + 1;
  IF r <> 'WG three' THEN failed := array_append(failed, ('viewer-manager does not see exactly their group: ' || r)::text); END IF;
  r := pg_temp.wg_try(u_viewer, format('SELECT whatsapp_group_can_manage(%L)::text || ''/'' || whatsapp_group_can_create(%L)::text', g3, w1));
  n := n + 1;
  IF r <> 'false/false' THEN failed := array_append(failed, ('a viewer can manage or create a group: ' || r)::text); END IF;

  r := pg_temp.wg_try(u_guest, 'SELECT (SELECT count(*) FROM whatsapp_groups) || ''/'' || (SELECT count(*) FROM whatsapp_group_messages) || ''/'' || (SELECT count(*) FROM whatsapp_group_participants) || ''/'' || (SELECT count(*) FROM whatsapp_group_managers) || ''/'' || (SELECT count(*) FROM whatsapp_group_invites)');
  n := n + 1;
  IF r <> '0/0/0/0/0' THEN failed := array_append(failed, ('a bank guest reads something: ' || r)::text); END IF;
  r := pg_temp.wg_try(u_guest, format('SELECT whatsapp_group_can_view(%L)::text || ''/'' || whatsapp_group_can_create(%L)::text', g1, w1));
  n := n + 1;
  IF r <> 'false/false' THEN failed := array_append(failed, ('a bank guest can view or create: ' || r)::text); END IF;

  r := pg_temp.wg_try(u_other, 'SELECT string_agg(name, '','' ORDER BY name) FROM whatsapp_groups');
  n := n + 1;
  IF r <> 'WG B' THEN failed := array_append(failed, ('another workspace''s owner sees other than their group: ' || r)::text); END IF;

  -- ---------- who manages ----------
  r := pg_temp.wg_try(u_maker, format('SELECT whatsapp_group_can_manage(%L)::text', g1));
  n := n + 1;
  IF r <> 'true' THEN failed := array_append(failed, ('creator cannot manage their group: ' || r)::text); END IF;
  r := pg_temp.wg_try(u_mgr, format('SELECT whatsapp_group_can_manage(%L)::text', g2));
  n := n + 1;
  IF r <> 'true' THEN failed := array_append(failed, ('manager cannot manage their group: ' || r)::text); END IF;
  -- On a number allocated to someone else: sees it, cannot manage it.
  r := pg_temp.wg_try(u_unal, format('SELECT whatsapp_group_can_view(%L)::text || ''/'' || whatsapp_group_can_manage(%L)::text', g4, g4));
  n := n + 1;
  IF r <> 'true/false' THEN failed := array_append(failed, ('creator off the number should view, not manage: ' || r)::text); END IF;
  r := pg_temp.wg_try(u_admin, format('SELECT whatsapp_group_can_manage(%L)::text || ''/'' || whatsapp_group_can_manage(%L)::text', g4, gb));
  n := n + 1;
  IF r <> 'true/false' THEN failed := array_append(failed, ('admin should manage A''s groups only: ' || r)::text); END IF;

  -- ---------- the invite link ----------
  r := pg_temp.wg_try(u_maker, 'SELECT string_agg(invite_code, '','' ORDER BY invite_code) FROM whatsapp_group_invites');
  n := n + 1;
  IF r <> 'AbCdEf114one' THEN failed := array_append(failed, ('creator does not read exactly their invite link: ' || r)::text); END IF;
  r := pg_temp.wg_try(u_lead, 'SELECT count(*)::text FROM whatsapp_group_invites');
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, ('a leader who only views reads an invite link: ' || r)::text); END IF;
  r := pg_temp.wg_try(u_viewer, 'SELECT count(*)::text FROM whatsapp_group_invites');
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, ('a viewer reads an invite link: ' || r)::text); END IF;
  r := pg_temp.wg_try(u_admin, 'SELECT count(*)::text FROM whatsapp_group_invites');
  n := n + 1;
  IF r <> '2' THEN failed := array_append(failed, ('admin does not read A''s invite links: ' || r)::text); END IF;

  -- ---------- who creates ----------
  r := pg_temp.wg_try(u_out, format('SELECT whatsapp_group_can_create(%L)::text || ''/'' || whatsapp_group_can_create(%L)::text || ''/'' || whatsapp_group_can_create(%L)::text || ''/'' || whatsapp_group_can_create(%L)::text',
    w1, w2, wm, wb));
  n := n + 1;
  IF r <> 'true/false/false/false' THEN
    failed := array_append(failed, ('agent create on shared/allocated-elsewhere/Meta/other workspace: ' || r)::text);
  END IF;
  r := pg_temp.wg_try(u_admin, format('SELECT whatsapp_group_can_create(%L)::text || ''/'' || whatsapp_group_can_create(%L)::text', w2, wm));
  n := n + 1;
  IF r <> 'true/false' THEN failed := array_append(failed, ('admin create on any Whapi number, never Meta: ' || r)::text); END IF;

  -- ---------- no client writes ----------
  r := pg_temp.wg_try(u_owner, format(
    'INSERT INTO whatsapp_groups (account_id, channel_id, wa_group_id, name) VALUES (%L, %L, %L, %L)',
    a_acct, w1, '120363000000114099@g.us', 'WG client'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN failed := array_append(failed, ('owner inserted a group directly: ' || r)::text); END IF;
  r := pg_temp.wg_try(u_maker, format('UPDATE whatsapp_groups SET name = %L WHERE id = %L', 'renamed', g1));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN failed := array_append(failed, ('creator updated a group directly: ' || r)::text); END IF;
  r := pg_temp.wg_try(u_owner, format('DELETE FROM whatsapp_group_messages WHERE group_id = %L', g1));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN failed := array_append(failed, ('owner deleted group messages directly: ' || r)::text); END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['whatsapp_groups', 'whatsapp_group_participants', 'whatsapp_group_managers',
                                        'whatsapp_group_invites', 'whatsapp_group_messages']) t
              WHERE has_table_privilege('authenticated', 'public.' || t, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                 OR has_table_privilege('anon', 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                 OR NOT has_table_privilege('authenticated', 'public.' || t, 'SELECT')
                 OR NOT has_table_privilege('service_role', 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE')) THEN
    failed := array_append(failed, 'a group table grants a client more than SELECT (or the service role cannot write it)'::text);
  END IF;

  -- ---------- the channel guard ----------
  BEGIN
    INSERT INTO whatsapp_groups (account_id, channel_id, wa_group_id, name)
    VALUES (a_acct, wm, '120363000000114097@g.us', 'WG on Meta');
    r := 'inserted';
  EXCEPTION WHEN OTHERS THEN r := SQLSTATE || ': ' || SQLERRM; END;
  n := n + 1;
  IF r NOT LIKE '23514: Groups are only supported on a Whapi number%' THEN
    failed := array_append(failed, ('a group on a Meta number was not refused: ' || r)::text);
  END IF;
  BEGIN
    INSERT INTO whatsapp_groups (account_id, channel_id, wa_group_id, name)
    VALUES (a_acct, wb, '120363000000114098@g.us', 'WG on B''s number');
    r := 'inserted';
  EXCEPTION WHEN OTHERS THEN r := SQLSTATE || ': ' || SQLERRM; END;
  n := n + 1;
  IF r NOT LIKE '23514: That number is not in the group''s workspace%' THEN
    failed := array_append(failed, ('a group on another workspace''s number was not refused: ' || r)::text);
  END IF;
  BEGIN
    UPDATE whatsapp_groups SET channel_id = w2 WHERE id = g1;
    r := 'moved';
  EXCEPTION WHEN OTHERS THEN r := SQLSTATE; END;
  n := n + 1;
  IF r <> '23514' THEN failed := array_append(failed, ('a group moved to another number: ' || r)::text); END IF;
  BEGIN
    INSERT INTO whatsapp_group_managers (group_id, account_id, user_id) VALUES (g1, a_acct, u_guest);
    r := 'inserted';
  EXCEPTION WHEN OTHERS THEN r := SQLSTATE; END;
  n := n + 1;
  IF r <> '23514' THEN failed := array_append(failed, ('a bank guest became a group manager: ' || r)::text); END IF;
  BEGIN
    INSERT INTO whatsapp_group_managers (group_id, account_id, user_id) VALUES (g1, a_acct, u_other);
    r := 'inserted';
  EXCEPTION WHEN OTHERS THEN r := SQLSTATE; END;
  n := n + 1;
  IF r <> '23514' THEN failed := array_append(failed, ('another workspace''s person became a group manager: ' || r)::text); END IF;

  -- Removing a number keeps its groups as history, read-only below admin.
  DELETE FROM whatsapp_config WHERE id = w3;
  n := n + 1;
  IF (SELECT channel_id FROM whatsapp_groups WHERE id = g5) IS NOT NULL THEN
    failed := array_append(failed, 'a removed number''s group lost or kept its channel'::text);
  END IF;
  r := pg_temp.wg_try(u_maker, format('SELECT whatsapp_group_can_view(%L)::text || ''/'' || whatsapp_group_can_manage(%L)::text', g5, g5));
  n := n + 1;
  IF r <> 'true/false' THEN failed := array_append(failed, ('a group whose number was removed should be view-only: ' || r)::text); END IF;

  -- left_at follows our_role.
  UPDATE whatsapp_groups SET our_role = 'left' WHERE id = g2;
  n := n + 1;
  IF (SELECT left_at FROM whatsapp_groups WHERE id = g2) IS NULL THEN
    failed := array_append(failed, 'left_at was not stamped on leaving'::text);
  END IF;

  -- last_message_at moves forward on a new message, never back, and a
  -- replayed message is a no-op.
  n := n + 1;
  IF (SELECT last_message_at FROM whatsapp_groups WHERE id = g1) IS DISTINCT FROM
     (SELECT created_at FROM whatsapp_group_messages WHERE wa_message_id = 'wg-m1') THEN
    failed := array_append(failed, 'a message did not move last_message_at'::text);
  END IF;
  INSERT INTO whatsapp_group_messages (account_id, group_id, wa_message_id, direction, body, created_at)
  VALUES (a_acct, g1, 'wg-m1-old', 'in', 'older', now() - interval '2 hours');
  INSERT INTO whatsapp_group_messages (account_id, group_id, wa_message_id, direction, body, created_at)
  VALUES (a_acct, g1, 'wg-m1', 'in', 'replay', now() + interval '1 hour')
  ON CONFLICT (group_id, wa_message_id) DO NOTHING;
  n := n + 1;
  IF (SELECT last_message_at FROM whatsapp_groups WHERE id = g1) IS DISTINCT FROM
     (SELECT created_at FROM whatsapp_group_messages WHERE wa_message_id = 'wg-m1') THEN
    failed := array_append(failed, 'an older or replayed message moved last_message_at'::text);
  END IF;

  -- ---------- structure ----------
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.whatsapp_groups'::regclass
                    AND tgfoid = 'public.archived_workspace_connect_guard()'::regprocedure
                    AND NOT tgisinternal) THEN
    failed := array_append(failed, 'whatsapp_groups lacks the archived-workspace guard'::text);
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM pg_proc
              WHERE oid IN ('public.whatsapp_group_visible_ids()'::regprocedure,
                            'public.whatsapp_group_manageable_ids()'::regprocedure,
                            'public.whatsapp_group_can_view(uuid)'::regprocedure,
                            'public.whatsapp_group_can_manage(uuid)'::regprocedure,
                            'public.whatsapp_group_can_create(uuid)'::regprocedure)
                AND NOT (prosecdef AND proconfig @> ARRAY['search_path=public, pg_temp']))
     OR has_function_privilege('anon', 'public.whatsapp_group_can_view(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.whatsapp_group_visible_ids()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.whatsapp_group_can_manage(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.whatsapp_groups_guard()', 'EXECUTE') THEN
    failed := array_append(failed, 'the group functions are not SECURITY DEFINER with a pinned search_path and explicit grants'::text);
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM pg_class
              WHERE oid IN ('public.whatsapp_groups'::regclass, 'public.whatsapp_group_participants'::regclass,
                            'public.whatsapp_group_managers'::regclass, 'public.whatsapp_group_invites'::regclass,
                            'public.whatsapp_group_messages'::regclass)
                AND NOT (relrowsecurity AND relforcerowsecurity)) THEN
    failed := array_append(failed, 'row-level security is not forced on every group table'::text);
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND (SELECT count(*) FROM pg_publication_tables
           WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
             AND tablename IN ('whatsapp_groups', 'whatsapp_group_messages')) <> 2 THEN
    failed := array_append(failed, 'whatsapp_groups and whatsapp_group_messages are not both in supabase_realtime'::text);
  END IF;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT114', MESSAGE = 'verify-whatsapp-groups rollback';
  EXCEPTION WHEN SQLSTATE 'ZT114' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'whatsapp groups verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'whatsapp groups verification passed (% checks)', n;
END
$verify$;
