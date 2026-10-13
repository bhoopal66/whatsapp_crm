-- Behavioural regression suite for team-chat channel administration
-- (migration 091): chat_update_channel, chat_archive_channel and
-- chat_remove_member (who may: D-B1), chat_set_muted, the mute rules of
-- the bell, chat_unread_counts' `muted` column, chat_workspace_badges,
-- the new audit actions, CH001 and the grants.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. Failing checks
-- are named in the final exception; every fixture is rolled back by
-- the sentinel raised at the end of the inner block.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000091201';
  u_admin UUID := '00000000-0000-4000-8000-000000091202';
  u_sup   UUID := '00000000-0000-4000-8000-000000091203';  -- team_leader -> supervisor
  u_rm    UUID := '00000000-0000-4000-8000-000000091204';  -- agent
  u_rm2   UUID := '00000000-0000-4000-8000-000000091205';  -- agent
  u_ag    UUID := '00000000-0000-4000-8000-000000091206';  -- viewer -> chat agent
  u_guest UUID := '00000000-0000-4000-8000-000000091207';  -- bank_guest
  a UUID;
  tc UUID; tc2 UUID; pc UUID; dm UUID; deal UUID; mc UUID; m UUID; root UUID;
  r TEXT;
  n INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run p_sql as p_role (NULL: stay the migration role) signed in as
  -- p_uid; the first column as text when p_val, else 'ok'; or the error
  -- as 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ic_go(p_role text, p_uid uuid, p_sql text, p_val boolean)
    RETURNS text LANGUAGE plpgsql AS $b$
    DECLARE v text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', coalesce(p_role, 'postgres'))::text, true);
        IF p_role IS NOT NULL THEN EXECUTE format('SET LOCAL ROLE %I', p_role); END IF;
        IF p_val THEN EXECUTE p_sql INTO v; v := coalesce(v, '<null>');
        ELSE EXECUTE p_sql; v := 'ok'; END IF;
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
    END $b$
  $fn$;
  -- A signed-in user's SELECT.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.u(p_uid uuid, p_sql text) RETURNS text LANGUAGE sql AS $b$
      SELECT pg_temp.ic_go('authenticated', p_uid, p_sql, true)
    $b$
  $fn$;
  -- NULL when the check holds, else its label.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ck(p_ok boolean, p_label text) RETURNS text LANGUAGE sql AS $b$
      SELECT CASE WHEN coalesce(p_ok, false) THEN NULL ELSE coalesce(p_label, '(unlabelled, result NULL)') END
    $b$
  $fn$;
  -- Fixture call: the id it returns, or the whole file fails.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.id(p_uid uuid, p_sql text) RETURNS uuid LANGUAGE plpgsql AS $b$
    DECLARE v text := pg_temp.u(p_uid, p_sql);
    BEGIN
      IF v LIKE 'ERROR%' THEN RAISE EXCEPTION 'fixture: % -> %', p_sql, v; END IF;
      RETURN v::uuid;
    END $b$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.q_ch(p_ws uuid, p_kind text, p_name text, p_members uuid[]) RETURNS text LANGUAGE sql AS $b$
      SELECT format('SELECT public.chat_create_channel(%L, %L, %L, NULL, %L::uuid[])', p_ws, p_kind, p_name, coalesce(p_members, '{}'))
    $b$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.q_post(p_ch uuid, p_body text, p_root uuid DEFAULT NULL) RETURNS text LANGUAGE sql AS $b$
      SELECT format('SELECT public.chat_post_message(%L, %L, %L::uuid)', p_ch, p_body, p_root)
    $b$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.q_upd(p_ch uuid, p_name text, p_topic text) RETURNS text LANGUAGE sql AS $b$
      SELECT format('SELECT public.chat_update_channel(%L, %L, %L)', p_ch, p_name, p_topic)
    $b$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.q_arch(p_ch uuid, p_archived boolean) RETURNS text LANGUAGE sql AS $b$
      SELECT format('SELECT public.chat_archive_channel(%L, %L::boolean)', p_ch, p_archived)
    $b$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.q_rm(p_ch uuid, p_user uuid) RETURNS text LANGUAGE sql AS $b$
      SELECT format('SELECT public.chat_remove_member(%L, %L)', p_ch, p_user)
    $b$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.q_mute(p_ch uuid, p_muted boolean) RETURNS text LANGUAGE sql AS $b$
      SELECT format('SELECT public.chat_set_muted(%L, %L::boolean)', p_ch, p_muted)
    $b$
  $fn$;

  -- ---------- fixture: account A, every role ----------
  INSERT INTO auth.users (id, email)
  SELECT x, 'cca-' || x || '@example.invalid'
    FROM unnest(ARRAY[u_owner, u_admin, u_sup, u_rm, u_rm2, u_ag, u_guest]) x
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a FROM profiles WHERE user_id = u_owner;
  IF a IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a, account_role = 'team_leader' WHERE user_id = u_sup;
  UPDATE profiles SET account_id = a, account_role = 'agent' WHERE user_id IN (u_rm, u_rm2);
  UPDATE profiles SET account_id = a, account_role = 'viewer' WHERE user_id = u_ag;
  UPDATE profiles SET account_id = a, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_guest;

  -- tc: team, channel admin u_rm. pc: private, channel admin u_sup (a
  -- supervisor may add a guest); u_admin is a plain member. The owner is
  -- in neither.
  tc := pg_temp.id(u_rm, pg_temp.q_ch(a, 'team', 'cca-team', ARRAY[u_rm2, u_ag]));
  tc2 := pg_temp.id(u_rm, pg_temp.q_ch(a, 'team', 'cca-other', NULL));
  pc := pg_temp.id(u_sup, pg_temp.q_ch(a, 'private', 'cca-private', ARRAY[u_rm, u_admin, u_guest]));
  dm := pg_temp.id(u_rm, format('SELECT public.chat_open_dm(%L, %L::uuid[])', a, ARRAY[u_rm2, u_ag]));
  -- A deal room (opened by 088's functions): staff + a guest.
  INSERT INTO chat_channels (account_id, kind, name, created_by)
  VALUES (a, 'deal_room', 'cca deal', u_owner) RETURNING id INTO deal;
  INSERT INTO chat_channel_members (channel_id, user_id, role)
  VALUES (deal, u_owner, 'admin'), (deal, u_rm, 'member'), (deal, u_guest, 'guest');

  -- ---------- chat_update_channel ----------
  r := pg_temp.u(u_rm2, pg_temp.q_upd(tc, 'cca-hijack', NULL));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 42501%only channel admins%', 'rename: a plain member renamed a team channel: ' || r);
  r := pg_temp.u(u_rm, pg_temp.q_upd(tc, '  cca-renamed  ', 'the topic'));
  n := n+1; failed := failed || pg_temp.ck(r NOT LIKE 'ERROR%'
    AND (SELECT name = 'cca-renamed' AND topic = 'the topic' FROM chat_channels WHERE id = tc)
    AND EXISTS (SELECT 1 FROM chat_audit_log WHERE channel_id = tc AND action = 'update_channel' AND actor_id = u_rm
                 AND detail->>'from' = 'cca-team' AND detail->>'to' = 'cca-renamed' AND detail->>'topic_to' = 'the topic'),
    'rename: the channel admin renames (trimmed, topic set, audited): ' || r);
  r := pg_temp.u(u_rm, pg_temp.q_upd(tc, NULL, NULL));
  n := n+1; failed := failed || pg_temp.ck(r NOT LIKE 'ERROR%'
    AND (SELECT name = 'cca-renamed' AND topic = 'the topic' FROM chat_channels WHERE id = tc)
    AND (SELECT count(*) FROM chat_audit_log WHERE channel_id = tc AND action = 'update_channel') = 1,
    'rename: NULL name and topic changed something or were audited: ' || r);
  r := pg_temp.u(u_owner, pg_temp.q_upd(tc, NULL, ''));
  n := n+1; failed := failed || pg_temp.ck(r NOT LIKE 'ERROR%'
    AND (SELECT name = 'cca-renamed' AND topic IS NULL FROM chat_channels WHERE id = tc),
    'rename: a non-member workspace owner could not clear a team channel''s topic (NULL name keeps it): ' || r);
  r := pg_temp.u(u_owner, pg_temp.q_upd(pc, 'cca-owner', NULL));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 42501%not a member of this channel%', 'rename: a non-member owner renamed a private channel: ' || r);
  r := pg_temp.u(u_rm, pg_temp.q_upd(pc, 'cca-agent', NULL));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 42501%only channel admins%', 'rename: a plain member renamed a private channel: ' || r);
  r := pg_temp.u(u_guest, pg_temp.q_upd(pc, 'cca-guest', NULL));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 42501%bank guests%', 'rename: a bank guest renamed: ' || r);
  r := pg_temp.u(u_admin, pg_temp.q_upd(pc, 'cca-private-2', NULL));
  n := n+1; failed := failed || pg_temp.ck(r NOT LIKE 'ERROR%' AND (SELECT name FROM chat_channels WHERE id = pc) = 'cca-private-2',
    'rename: a workspace admin who is a member could not rename a private channel: ' || r);
  r := pg_temp.u(u_sup, pg_temp.q_upd(pc, 'cca-private', 'kept'));
  n := n+1; failed := failed || pg_temp.ck(r NOT LIKE 'ERROR%' AND (SELECT name = 'cca-private' AND topic = 'kept' FROM chat_channels WHERE id = pc),
    'rename: the private channel''s admin could not rename it: ' || r);
  r := pg_temp.u(u_rm, pg_temp.q_upd(tc2, 'CCA-Renamed', NULL));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 23505%chat_channels_name_uq%', 'rename: a live name was taken twice (ignoring case): ' || r);
  r := pg_temp.u(u_rm, pg_temp.q_upd(tc2, '   ', NULL));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 23514%', 'rename: a blank name: ' || r);
  r := pg_temp.u(u_rm, pg_temp.q_upd(tc2, repeat('x', 81), NULL));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 23514%', 'rename: an 81-character name: ' || r);
  r := pg_temp.u(u_rm, pg_temp.q_upd(tc2, NULL, repeat('t', 251)));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 23514%', 'rename: a 251-character topic: ' || r);
  r := pg_temp.u(u_rm, pg_temp.q_upd(dm, 'cca-dm', NULL));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 22023%only team and private%', 'rename: a DM: ' || r);
  r := pg_temp.u(u_owner, pg_temp.q_upd(deal, 'cca-deal', NULL));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 22023%only team and private%', 'rename: a deal room: ' || r);
  r := pg_temp.u(u_rm, pg_temp.q_upd(gen_random_uuid(), 'cca-none', NULL));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR P0002%', 'rename: an unknown channel: ' || r);

  -- ---------- chat_archive_channel ----------
  r := pg_temp.u(u_rm2, pg_temp.q_arch(tc, true));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 42501%only channel admins%', 'archive: a plain member archived: ' || r);
  r := pg_temp.u(u_owner, pg_temp.q_arch(pc, true));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 42501%not a member of this channel%', 'archive: a non-member owner archived a private channel: ' || r);
  r := pg_temp.u(u_guest, pg_temp.q_arch(pc, true));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 42501%bank guests%', 'archive: a bank guest archived: ' || r);
  r := pg_temp.u(u_rm, pg_temp.q_arch(tc, NULL));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 22023%', 'archive: NULL accepted: ' || r);
  r := pg_temp.u(u_rm, pg_temp.q_arch(dm, true));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 22023%only team and private%', 'archive: a DM: ' || r);
  r := pg_temp.u(u_sup, pg_temp.q_arch(pc, true));
  n := n+1; failed := failed || pg_temp.ck(r NOT LIKE 'ERROR%' AND (SELECT archived_at IS NOT NULL FROM chat_channels WHERE id = pc),
    'archive: the private channel''s admin could not archive it: ' || r);
  -- A separate statement: one expression reads one snapshot.
  r := pg_temp.u(u_sup, pg_temp.q_arch(pc, false));
  n := n+1; failed := failed || pg_temp.ck(r NOT LIKE 'ERROR%' AND (SELECT archived_at IS NULL FROM chat_channels WHERE id = pc),
    'archive: the private channel''s admin could not unarchive it: ' || r);
  r := pg_temp.u(u_rm, pg_temp.q_arch(tc, true));
  n := n+1; failed := failed || pg_temp.ck(r NOT LIKE 'ERROR%' AND (SELECT archived_at IS NOT NULL FROM chat_channels WHERE id = tc)
    AND EXISTS (SELECT 1 FROM chat_audit_log WHERE channel_id = tc AND action = 'archive_channel' AND actor_id = u_rm
                 AND detail->>'name' = 'cca-renamed'),
    'archive: the channel admin archives (audited): ' || r);
  r := pg_temp.u(u_rm, pg_temp.q_arch(tc, true));
  n := n+1; failed := failed || pg_temp.ck(r NOT LIKE 'ERROR%'
    AND (SELECT count(*) FROM chat_audit_log WHERE channel_id = tc AND action = 'archive_channel') = 1,
    'archive: archiving twice failed or was audited twice: ' || r);
  -- 087's guards: an archived channel takes no post, system post, add,
  -- and no 091 write but its unarchive.
  r := pg_temp.u(u_rm, pg_temp.q_post(tc, 'into the archive'));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 42501%channel is archived%', 'archived: a post was accepted: ' || r);
  r := pg_temp.ic_go(NULL, NULL, format('SELECT public.chat_post_system_message(%L, %L)', tc, 'bot'), true);
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 42501%channel is archived%', 'archived: a system post was accepted: ' || r);
  r := pg_temp.u(u_rm, format('SELECT public.chat_add_members(%L, %L::uuid[])', tc, ARRAY[u_sup]));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 42501%channel is archived%', 'archived: members were added: ' || r);
  r := pg_temp.u(u_rm, pg_temp.q_upd(tc, 'cca-x', NULL));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 42501%channel is archived%', 'archived: renamed: ' || r);
  r := pg_temp.u(u_rm, pg_temp.q_rm(tc, u_ag));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 42501%channel is archived%', 'archived: a member was removed: ' || r);
  -- The archived name is free for a live channel; unarchiving then clashes.
  r := pg_temp.u(u_rm, pg_temp.q_upd(tc2, 'CCA-RENAMED', NULL));
  n := n+1; failed := failed || pg_temp.ck(r NOT LIKE 'ERROR%', 'archived: its name was not free for a live channel: ' || r);
  r := pg_temp.u(u_rm, pg_temp.q_arch(tc, false));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 23505%chat_channels_name_uq%'
    AND (SELECT archived_at IS NOT NULL FROM chat_channels WHERE id = tc)
    AND NOT EXISTS (SELECT 1 FROM chat_audit_log WHERE channel_id = tc AND action = 'unarchive_channel'),
    'unarchive: a name clash did not fail cleanly: ' || r);
  r := pg_temp.u(u_rm, pg_temp.q_upd(tc2, 'cca-other', NULL));
  r := r || pg_temp.u(u_rm, pg_temp.q_arch(tc, false));
  n := n+1; failed := failed || pg_temp.ck(r NOT LIKE '%ERROR%' AND (SELECT archived_at IS NULL FROM chat_channels WHERE id = tc)
    AND EXISTS (SELECT 1 FROM chat_audit_log WHERE channel_id = tc AND action = 'unarchive_channel' AND actor_id = u_rm)
    AND pg_temp.u(u_rm, pg_temp.q_post(tc, 'back')) NOT LIKE 'ERROR%',
    'unarchive: once the name was free, unarchive (audited) and a post failed: ' || r);

  -- ---------- chat_remove_member ----------
  r := pg_temp.u(u_rm2, pg_temp.q_rm(tc, u_ag));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 42501%only channel admins%', 'remove: a plain member removed someone: ' || r);
  r := pg_temp.u(u_rm, pg_temp.q_rm(tc, u_rm));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 22023%chat_leave_channel%', 'remove: removed oneself: ' || r);
  r := pg_temp.u(u_owner, pg_temp.q_rm(tc, u_rm));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 22023%last admin%'
    AND EXISTS (SELECT 1 FROM chat_channel_members WHERE channel_id = tc AND user_id = u_rm),
    'remove: the last channel admin was removed: ' || r);
  r := pg_temp.u(u_rm, pg_temp.q_rm(tc, u_sup));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR P0002%not a member%', 'remove: a non-member: ' || r);
  r := pg_temp.u(u_rm, pg_temp.q_rm(dm, u_rm2));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 22023%only team and private%', 'remove: from a DM: ' || r);
  r := pg_temp.u(u_owner, pg_temp.q_rm(deal, u_rm));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 22023%only team and private%', 'remove: from a deal room: ' || r);
  r := pg_temp.u(u_rm, pg_temp.q_rm(tc, u_ag));
  n := n+1; failed := failed || pg_temp.ck(r NOT LIKE 'ERROR%'
    AND NOT EXISTS (SELECT 1 FROM chat_channel_members WHERE channel_id = tc AND user_id = u_ag)
    AND EXISTS (SELECT 1 FROM chat_audit_log WHERE channel_id = tc AND action = 'remove_member' AND actor_id = u_rm
                 AND detail->>'user_id' = u_ag::text AND detail->>'role' = 'member'),
    'remove: the channel admin removes a member (audited): ' || r);
  -- Private: read access and the channel's bells end at once.
  m := pg_temp.id(u_sup, pg_temp.q_post(pc, format('<@%s> for your eyes', u_rm)));
  n := n+1; failed := failed || pg_temp.ck(pg_temp.u(u_rm, format('SELECT count(*) FROM public.internal_messages WHERE channel_id = %L', pc)) = '1'
    AND EXISTS (SELECT 1 FROM notifications WHERE user_id = u_rm AND meta->>'channel_id' = pc::text),
    'remove: fixture: the member does not read the private channel or has no bell for it');
  r := pg_temp.u(u_owner, pg_temp.q_rm(pc, u_rm));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 42501%not a member of this channel%', 'remove: a non-member owner removed from a private channel: ' || r);
  r := pg_temp.u(u_guest, pg_temp.q_rm(pc, u_rm));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 42501%bank guests%', 'remove: a bank guest removed someone: ' || r);
  r := pg_temp.u(u_sup, pg_temp.q_rm(pc, u_rm));
  n := n+1; failed := failed || pg_temp.ck(r NOT LIKE 'ERROR%'
    AND pg_temp.u(u_rm, format('SELECT count(*) FROM public.internal_messages WHERE channel_id = %L', pc)) = '0'
    AND pg_temp.u(u_rm, format('SELECT count(*) FROM public.chat_channels WHERE id = %L', pc)) = '0'
    AND NOT EXISTS (SELECT 1 FROM notifications WHERE user_id = u_rm AND meta->>'channel_id' = pc::text)
    AND NOT EXISTS (SELECT 1 FROM chat_notifications WHERE user_id = u_rm AND message_id = m),
    'remove: a removed private-channel member still reads it or keeps its bells: ' || r);
  r := pg_temp.u(u_rm, pg_temp.q_post(pc, 'still here?'));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 42501%not a member of this channel%', 'remove: the removed member still posts: ' || r);
  r := pg_temp.u(u_admin, pg_temp.q_rm(pc, u_guest));
  n := n+1; failed := failed || pg_temp.ck(r NOT LIKE 'ERROR%' AND NOT EXISTS (SELECT 1 FROM chat_channel_members WHERE channel_id = pc AND user_id = u_guest),
    'remove: a workspace admin who is a member could not remove a guest: ' || r);
  r := pg_temp.u(u_admin, pg_temp.q_rm(pc, u_sup));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 22023%last admin%', 'remove: the last admin of a private channel was removed: ' || r);
  r := pg_temp.u(u_sup, format('SELECT public.chat_set_member_role(%L, %L, %L)', pc, u_admin, 'admin'));
  r := r || pg_temp.u(u_admin, pg_temp.q_rm(pc, u_sup));
  n := n+1; failed := failed || pg_temp.ck(r NOT LIKE '%ERROR%' AND NOT EXISTS (SELECT 1 FROM chat_channel_members WHERE channel_id = pc AND user_id = u_sup),
    'remove: with a second admin, an admin could not be removed: ' || r);

  -- ---------- chat_set_muted and the bell ----------
  -- mc: team, channel admin u_rm; u_rm2 starts a thread, then mutes.
  mc := pg_temp.id(u_rm, pg_temp.q_ch(a, 'team', 'cca-mute', ARRAY[u_rm2, u_ag]));
  root := pg_temp.id(u_rm2, pg_temp.q_post(mc, 'my thread'));
  r := pg_temp.u(u_rm2, pg_temp.q_mute(mc, true));
  n := n+1; failed := failed || pg_temp.ck(r NOT LIKE 'ERROR%'
    AND (SELECT muted FROM chat_channel_members WHERE channel_id = mc AND user_id = u_rm2)
    AND NOT (SELECT muted FROM chat_channel_members WHERE channel_id = mc AND user_id = u_ag)
    AND NOT EXISTS (SELECT 1 FROM chat_audit_log WHERE channel_id = mc),
    'mute: a member could not mute their own membership (or it touched others, or was audited): ' || r);
  m := pg_temp.id(u_rm, pg_temp.q_post(mc, '@channel standup'));
  n := n+1; failed := failed || pg_temp.ck(NOT EXISTS (SELECT 1 FROM chat_notifications WHERE message_id = m AND user_id = u_rm2)
    AND NOT EXISTS (SELECT 1 FROM notifications WHERE user_id = u_rm2 AND meta->>'message_id' = m::text)
    AND EXISTS (SELECT 1 FROM notifications WHERE user_id = u_ag AND type = 'chat_broadcast' AND meta->>'message_id' = m::text),
    'mute: @channel rang a muted member, or not the unmuted one');
  m := pg_temp.id(u_rm, pg_temp.q_post(mc, 'a reply', root));
  n := n+1; failed := failed || pg_temp.ck(NOT EXISTS (SELECT 1 FROM chat_notifications WHERE message_id = m AND user_id = u_rm2)
    AND NOT EXISTS (SELECT 1 FROM notifications WHERE user_id = u_rm2 AND meta->>'message_id' = m::text),
    'mute: a thread reply rang the muted thread author');
  m := pg_temp.id(u_rm, pg_temp.q_post(mc, format('<@%s> look @here', u_rm2)));
  n := n+1; failed := failed || pg_temp.ck(EXISTS (SELECT 1 FROM chat_notifications WHERE message_id = m AND user_id = u_rm2 AND kind = 'mention')
    AND EXISTS (SELECT 1 FROM notifications WHERE user_id = u_rm2 AND type = 'chat_mention' AND meta->>'message_id' = m::text),
    'mute: a direct mention did not ring a muted member');
  -- now() is one instant in this transaction: backdate the joins, or
  -- nothing posted here is newer than them and every count is 0.
  UPDATE chat_channel_members SET joined_at = now() - interval '1 hour' WHERE user_id = u_rm2;
  -- Unread: the muted channel keeps its counts and says so; the rail
  -- leaves its plain unread out and keeps its mentions.
  r := pg_temp.u(u_rm2, format('SELECT muted AND unread = 2 AND mentions = 1 FROM public.chat_unread_counts(%L) WHERE channel_id = %L', a, mc));
  n := n+1; failed := failed || pg_temp.ck(r = 'true', 'unread: the muted channel''s row (muted, unread 2, mentions 1): ' || r);
  r := pg_temp.u(u_rm2, format('SELECT NOT muted AND unread = 1 FROM public.chat_unread_counts(%L) WHERE channel_id = %L', a, tc));
  n := n+1; failed := failed || pg_temp.ck(r = 'true', 'unread: an unmuted channel''s row: ' || r);
  r := pg_temp.u(u_rm2, format(
    'SELECT b.unread = (SELECT sum(unread) FILTER (WHERE NOT muted) FROM public.chat_unread_counts(%1$L))
        AND b.mentions = (SELECT sum(mentions) FROM public.chat_unread_counts(%1$L))
        AND (SELECT sum(unread) FILTER (WHERE muted) FROM public.chat_unread_counts(%1$L)) > 0
        AND (SELECT sum(mentions) FILTER (WHERE muted) FROM public.chat_unread_counts(%1$L)) > 0
       FROM public.chat_workspace_badges() b WHERE b.account_id = %1$L', a));
  n := n+1; failed := failed || pg_temp.ck(r = 'true', 'badges: a muted channel''s plain unread counted, or its mentions dropped: ' || r);
  r := pg_temp.u(u_rm2, pg_temp.q_mute(mc, false));
  m := pg_temp.id(u_rm, pg_temp.q_post(mc, 'another reply', root));
  n := n+1; failed := failed || pg_temp.ck(r NOT LIKE 'ERROR%'
    AND EXISTS (SELECT 1 FROM chat_notifications WHERE message_id = m AND user_id = u_rm2 AND kind = 'thread_reply'),
    'mute: unmuted, a thread reply did not ring the thread author: ' || r);
  r := pg_temp.u(u_rm2, pg_temp.q_mute(dm, true));
  m := pg_temp.id(u_rm, pg_temp.q_post(dm, 'psst'));
  n := n+1; failed := failed || pg_temp.ck(r NOT LIKE 'ERROR%'
    AND NOT EXISTS (SELECT 1 FROM chat_notifications WHERE message_id = m AND user_id = u_rm2)
    AND EXISTS (SELECT 1 FROM chat_notifications WHERE message_id = m AND user_id = u_ag AND kind = 'dm'),
    'mute: a muted DM rang, or the unmuted member got nothing: ' || r);
  r := pg_temp.u(u_guest, pg_temp.q_mute(deal, true));
  n := n+1; failed := failed || pg_temp.ck(r NOT LIKE 'ERROR%'
    AND (SELECT muted FROM chat_channel_members WHERE channel_id = deal AND user_id = u_guest),
    'mute: a bank guest could not mute a deal room they belong to: ' || r);
  r := pg_temp.u(u_sup, pg_temp.q_mute(mc, true));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 42501%not a member of this channel%', 'mute: a non-member muted: ' || r);
  r := pg_temp.u(u_guest, pg_temp.q_mute(tc, true));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 42501%not a member of this channel%', 'mute: a bank guest muted a team channel: ' || r);
  r := pg_temp.u(u_rm2, pg_temp.q_mute(mc, NULL));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 22023%', 'mute: NULL accepted: ' || r);
  r := pg_temp.ic_go('authenticated', u_rm2,
    format('UPDATE public.chat_channel_members SET muted = false WHERE channel_id = %L AND user_id = %L', dm, u_rm2), false);
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 42501%', 'direct: a member UPDATEd muted: ' || r);
  r := pg_temp.ic_go('authenticated', u_rm,
    format('UPDATE public.chat_channels SET name = %L, archived_at = now() WHERE id = %L', 'cca-direct', mc), false);
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 42501%', 'direct: a channel admin UPDATEd the channel row: ' || r);

  -- ---------- internal chat off: CH001 ----------
  UPDATE accounts SET internal_chat_enabled = false WHERE id = a;
  r := pg_temp.u(u_rm, pg_temp.q_upd(mc, 'cca-off', NULL)) || ' / ' || pg_temp.u(u_rm, pg_temp.q_arch(mc, true))
    || ' / ' || pg_temp.u(u_rm, pg_temp.q_rm(mc, u_ag)) || ' / ' || pg_temp.u(u_rm2, pg_temp.q_mute(mc, true));
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR CH001% / ERROR CH001% / ERROR CH001% / ERROR CH001%',
    'disabled: a channel-admin function ran with internal chat off: ' || r);
  UPDATE accounts SET internal_chat_enabled = true WHERE id = a;

  -- ---------- audit actions and grants ----------
  n := n+1; failed := failed || pg_temp.ck((SELECT count(DISTINCT action) FROM chat_audit_log WHERE account_id = a
      AND action IN ('update_channel','archive_channel','unarchive_channel','remove_member')) = 4,
    'audit: the four new actions were not all recorded');
  r := pg_temp.ic_go(NULL, NULL, format('INSERT INTO public.chat_audit_log (account_id, actor_id, action) VALUES (%L, %L, %L)',
    a, u_owner, 'bogus'), false);
  n := n+1; failed := failed || pg_temp.ck(r LIKE 'ERROR 23514%', 'audit: the action CHECK let an unknown action in: ' || r);
  n := n+1; failed := failed || pg_temp.ck(
    has_function_privilege('authenticated', 'public.chat_update_channel(uuid,text,text)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.chat_archive_channel(uuid,boolean)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.chat_remove_member(uuid,uuid)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.chat_set_muted(uuid,boolean)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.chat_unread_counts(uuid)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.chat_workspace_badges()', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.chat_update_channel(uuid,text,text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.chat_set_muted(uuid,boolean)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.chat_unread_counts(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.chat_assert_can_manage_channel(text,uuid,boolean)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.chat_notification_mute_filter()', 'EXECUTE'),
    'grants: wrong EXECUTE privileges on the 091 functions');

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT911', MESSAGE = 'verify-chat-channel-admin rollback';
  EXCEPTION WHEN SQLSTATE 'ZT911' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'chat channel admin verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'chat channel admin verification passed (% checks)', n;
END
$verify$;
