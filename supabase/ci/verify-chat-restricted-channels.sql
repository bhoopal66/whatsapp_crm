-- Behavioural regression suite for team chat restricted channels
-- (migration 159).
--
-- A team channel may carry an audience: chat_channels.audience_min_role
-- (NULL or viewer|agent|team_leader|admin; only a team channel may set
-- it, two CHECKs) and the teams in chat_channel_teams. Workspace owners
-- and admins always see it; anyone else needs a raw role at least the
-- minimum (viewer < agent < team_leader < admin < owner) AND, when teams
-- are listed, membership or the leadership of one of them. Membership is
-- no override: a joined member outside the audience reads no messages,
-- members, attachments, typing rows, plays or storage objects, gets no
-- unread row, cannot post (and is not auto-joined), cannot type, cannot
-- be added; the member row stays and access returns when the audience
-- widens. An @mention of an excluded person makes no mention row and no
-- bell. The BEFORE triggers on chat_channel_members (the new member, and
-- the adder when auth.uid() is set), internal_messages (user posts only;
-- system posts pass) and chat_typing raise 42501 "outside this channel's
-- audience". chat_set_channel_audience: manager gate (42501), team
-- channels only, known roles, own-workspace teams (22023), a channel
-- admin below workspace admin cannot hide the channel from themselves
-- (22023, nothing changed), replaces the team set, audits 'set_audience'
-- with from/to. chat_channel_teams is RLS-forced, SELECT-only for
-- authenticated, readable by whoever can see the channel, and in the
-- realtime publication. The helpers are executable by nobody, the setter
-- by authenticated only.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.
-- A writing RPC's result is assigned first and its effect read in a
-- later statement.

DO $verify$
DECLARE
  u_own  UUID := '00000000-0000-4000-8000-000000159101';  -- owner of A, member of ch
  u_adm  UUID := '00000000-0000-4000-8000-000000159102';  -- admin, member of ch
  u_adm2 UUID := '00000000-0000-4000-8000-000000159103';  -- admin, member of nothing
  u_tl   UUID := '00000000-0000-4000-8000-000000159104';  -- team leader, leads T1 (not a T1 member row), member of ch
  u_ag   UUID := '00000000-0000-4000-8000-000000159105';  -- agent in T1, member of ch
  u_ag2  UUID := '00000000-0000-4000-8000-000000159106';  -- agent in T2, member of ch
  u_ag3  UUID := '00000000-0000-4000-8000-000000159107';  -- agent in T1, member of nothing
  u_vw   UUID := '00000000-0000-4000-8000-000000159108';  -- viewer, member of ch
  u_out  UUID := '00000000-0000-4000-8000-000000159109';  -- owner of B
  a      UUID;
  b      UUID;
  ch     UUID;  -- A team: own, adm, tl, ag, ag2, vw
  ch2    UUID;  -- A team created by tl: tl, ag
  pv     UUID;  -- A private: own, ag
  dm     UUID;  -- A DM: own, ag
  t1     UUID;  -- A team, leader tl, member ag (and ag3)
  t2     UUID;  -- A team, member ag2
  tb     UUID;  -- B team
  ch3    UUID;  -- A team, the manage checks: ag2 (channel admin, T2), ag and ag3 (T1); audience T1
  ch4    UUID;  -- A team, the deleted-team checks; audience T3
  t3     UUID;  -- A team, member vw; deleted
  mg     TEXT := 'ERROR 42501:%outside this channel''s audience%';
  mv     UUID;  -- tl's voice note in ch
  m      UUID;
  pre    TEXT;  -- ch's storage prefix
  fp     TEXT;
  vp     TEXT;
  full_q TEXT := '2/6/2/1/1/2';
  r      TEXT;
  sets_ch INT := 0;  -- successful audience saves on ch
  aud    TEXT := 'SELECT public.chat_set_channel_audience(%L, %L, %L::uuid[])::text';
  post   TEXT := 'SELECT public.chat_post_message(%L, %L)::text';
  typing TEXT := 'SELECT public.chat_set_typing(%L)::text';
  unread TEXT := 'SELECT count(*)::text FROM public.chat_unread_counts(%L) WHERE channel_id = %L';
  teams_q TEXT := 'SELECT count(*)::text FROM chat_channel_teams WHERE channel_id = %L';
  refused TEXT := 'ERROR 42501: chat: outside this channel''s audience%';
  uuid_re TEXT := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  internal_fns TEXT[] := ARRAY[
    'public.chat_audience_rank(text)',
    'public.chat_user_in_channel_audience(uuid,uuid)',
    'public.chat_audience_guard()'];
  setter TEXT := 'public.chat_set_channel_audience(uuid,text,uuid[])';
  f      TEXT;
  n      INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (NULL: as the current user) signed in as
  -- p_uid: a SELECT's value, 'ok', or 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.tc_try(p_role text, p_uid uuid, p_sql text)
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
        RETURN coalesce(nullif(v, ''), 'ok');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.tc_check(p_name text, p_uid uuid, p_sql text, p_like text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := pg_temp.tc_try(CASE WHEN p_uid IS NULL THEN NULL ELSE 'authenticated' END, p_uid, p_sql);
    BEGIN
      RETURN CASE WHEN v LIKE p_like THEN NULL ELSE p_name || ' (' || v || ')' END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.tc_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  -- Superuser statement run with auth.uid() = p_uid (no role switch).
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.tc_as_uid(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    BEGIN
      PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
      RETURN pg_temp.tc_try(NULL, NULL, p_sql);
    END $body$
  $fn$;
  -- What the signed-in p_uid reads of a channel, as
  -- messages/members/attachments/typing/plays/storage objects.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.tc_reads(p_uid uuid, p_ch uuid, p_voice uuid, p_prefix text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.tc_try('authenticated', p_uid, format(
        'SELECT (SELECT count(*) FROM internal_messages WHERE channel_id = %1$L) || ''/'' || '
        || '(SELECT count(*) FROM chat_channel_members WHERE channel_id = %1$L) || ''/'' || '
        || '(SELECT count(*) FROM message_attachments ma JOIN internal_messages im ON im.id = ma.message_id WHERE im.channel_id = %1$L) || ''/'' || '
        || '(SELECT count(*) FROM chat_typing WHERE channel_id = %1$L) || ''/'' || '
        || '(SELECT count(*) FROM chat_voice_plays WHERE message_id = %2$L) || ''/'' || '
        || '(SELECT count(*) FROM storage.objects WHERE bucket_id = ''chat-files'' AND name LIKE %3$L)',
        p_ch, p_voice, p_prefix || '%'))
    $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.tc_sees(p_uid uuid, p_ch uuid)
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.tc_try('authenticated', p_uid,
        format('SELECT count(*)::text FROM chat_channels WHERE id = %L', p_ch))
    $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_own, 'ci-tc159-own@example.invalid'), (u_adm, 'ci-tc159-adm@example.invalid'),
    (u_adm2, 'ci-tc159-adm2@example.invalid'), (u_tl, 'ci-tc159-tl@example.invalid'),
    (u_ag, 'ci-tc159-ag@example.invalid'), (u_ag2, 'ci-tc159-ag2@example.invalid'),
    (u_ag3, 'ci-tc159-ag3@example.invalid'), (u_vw, 'ci-tc159-vw@example.invalid'),
    (u_out, 'ci-tc159-out@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a FROM profiles WHERE user_id = u_own;
  SELECT account_id INTO b FROM profiles WHERE user_id = u_out;
  IF a IS NULL OR b IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE accounts SET internal_chat_enabled = true WHERE id IN (a, b);
  UPDATE profiles SET account_id = a, account_role = 'admin' WHERE user_id IN (u_adm, u_adm2);
  UPDATE profiles SET account_id = a, account_role = 'team_leader' WHERE user_id = u_tl;
  UPDATE profiles SET account_id = a, account_role = 'agent' WHERE user_id IN (u_ag, u_ag2, u_ag3);
  UPDATE profiles SET account_id = a, account_role = 'viewer' WHERE user_id = u_vw;
  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a, 'TC159 T1', u_tl) RETURNING id INTO t1;
  INSERT INTO teams (account_id, name) VALUES (a, 'TC159 T2') RETURNING id INTO t2;
  INSERT INTO teams (account_id, name) VALUES (b, 'TC159 B') RETURNING id INTO tb;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (t1, u_ag, a), (t1, u_ag3, a), (t2, u_ag2, a);

  ch := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_create_channel(%L, %L, %L, NULL, %L::uuid[])::text',
          a, 'team', 'TC159 team', ARRAY[u_adm, u_tl, u_ag, u_ag2, u_vw]));
  ch2 := pg_temp.tc_try('authenticated', u_tl, format('SELECT public.chat_create_channel(%L, %L, %L, NULL, %L::uuid[])::text',
          a, 'team', 'TC159 tl', ARRAY[u_ag]));
  pv := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_create_channel(%L, %L, %L, NULL, %L::uuid[])::text',
          a, 'private', 'TC159 private', ARRAY[u_ag]));
  dm := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_open_dm(%L, %L::uuid[])::text', a, ARRAY[u_ag]));
  pre := 'account-' || a || '/channel-' || ch || '/';
  fp := pre || gen_random_uuid() || '-d.pdf';
  vp := pre || gen_random_uuid() || '-v.ogg';
  INSERT INTO storage.objects (bucket_id, name) VALUES ('chat-files', fp), ('chat-files', vp);
  r := pg_temp.tc_try('authenticated', u_tl, format('SELECT public.chat_post_message(%L, %L, p_attachments => %L::jsonb)::text',
         ch, 'file', jsonb_build_array(jsonb_build_object('storage_path', fp, 'name', 'd.pdf', 'mime', 'application/pdf', 'bytes', 10))));
  IF r !~ uuid_re THEN RAISE EXCEPTION 'fixture: file post failed (%)', r; END IF;
  r := pg_temp.tc_try('authenticated', u_tl, format('SELECT public.chat_post_message(%L, %L, p_attachments => %L::jsonb)::text',
         ch, 'voice', jsonb_build_array(jsonb_build_object('storage_path', vp, 'name', 'v.ogg', 'mime', 'audio/ogg',
                                                           'bytes', 10, 'kind', 'voice', 'duration_ms', 900))));
  IF r !~ uuid_re THEN RAISE EXCEPTION 'fixture: voice post failed (%)', r; END IF;
  mv := r::uuid;
  r := pg_temp.tc_try('authenticated', u_ag, format('SELECT public.chat_mark_voice_played(%L)::text', mv));
  IF r <> 'ok' THEN RAISE EXCEPTION 'fixture: voice play failed (%)', r; END IF;
  r := pg_temp.tc_try('authenticated', u_tl, format(typing, ch));
  IF r <> 'ok' THEN RAISE EXCEPTION 'fixture: typing failed (%)', r; END IF;

  -- ---------- A. default NULL audience, no teams: every staff member ----------
  n := n + 1; failed := failed || pg_temp.tc_ok(pg_temp.tc_sees(u_vw, ch) = '1', 'default: a viewer does not see the team channel');
  n := n + 1; failed := failed || pg_temp.tc_ok(pg_temp.tc_sees(u_adm2, ch) = '1', 'default: a non-member admin does not see the team channel');
  r := pg_temp.tc_reads(u_ag2, ch, mv, pre);
  n := n + 1; failed := failed || pg_temp.tc_ok(r = full_q, 'default: a member does not read the whole channel (' || r || ')');
  n := n + 1; failed := failed || pg_temp.tc_check('default: no unread row for a member', u_vw, format(unread, a, ch), '1');

  -- ---------- B. minimum role 'agent' ----------
  r := pg_temp.tc_try('authenticated', u_own, format(aud, ch, 'agent', NULL));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = 'ok', 'the owner could not set min role agent (' || r || ')');
  IF r = 'ok' THEN sets_ch := sets_ch + 1; END IF;
  n := n + 1; failed := failed || pg_temp.tc_ok(pg_temp.tc_sees(u_vw, ch) = '0', 'min agent: the viewer still sees the channel');
  r := pg_temp.tc_reads(u_vw, ch, mv, pre);
  n := n + 1; failed := failed || pg_temp.tc_ok(r = '0/0/0/0/0/0', 'min agent: the joined viewer still reads the channel (' || r || ')');
  n := n + 1; failed := failed || pg_temp.tc_check('min agent: the joined viewer still has an unread row', u_vw, format(unread, a, ch), '0');
  n := n + 1; failed := failed || pg_temp.tc_check('min agent: the joined viewer could post', u_vw, format(post, ch, 'x'), 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.tc_check('min agent: the joined viewer could type', u_vw, format(typing, ch), 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.tc_ok(pg_temp.tc_sees(u_ag, ch) = '1', 'min agent: an agent does not see the channel');
  n := n + 1; failed := failed || pg_temp.tc_ok(pg_temp.tc_sees(u_tl, ch) = '1', 'min agent: a team leader does not see the channel');
  n := n + 1; failed := failed || pg_temp.tc_check('min agent: an agent member cannot post', u_ag, format(post, ch, 'agent ok'), '________-%');
  full_q := '3/6/2/1/1/2';
  -- widening to 'viewer' gives the viewer everything back
  r := pg_temp.tc_try('authenticated', u_own, format(aud, ch, 'viewer', NULL));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = 'ok', 'the owner could not set min role viewer (' || r || ')');
  IF r = 'ok' THEN sets_ch := sets_ch + 1; END IF;
  r := pg_temp.tc_reads(u_vw, ch, mv, pre);
  n := n + 1; failed := failed || pg_temp.tc_ok(r = full_q, 'widened to viewer: the viewer does not read the channel again (' || r || ')');
  n := n + 1; failed := failed || pg_temp.tc_check('widened to viewer: the viewer has no unread row', u_vw, format(unread, a, ch), '1');

  -- ---------- C. minimum role 'team_leader', then 'admin' ----------
  r := pg_temp.tc_try('authenticated', u_own, format(aud, ch, 'team_leader', NULL));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = 'ok', 'the owner could not set min role team_leader (' || r || ')');
  IF r = 'ok' THEN sets_ch := sets_ch + 1; END IF;
  n := n + 1; failed := failed || pg_temp.tc_ok(pg_temp.tc_sees(u_ag, ch) = '0', 'min team_leader: an agent still sees the channel');
  n := n + 1; failed := failed || pg_temp.tc_ok(pg_temp.tc_sees(u_tl, ch) = '1', 'min team_leader: the team leader does not see the channel');
  r := pg_temp.tc_try('authenticated', u_own, format(aud, ch, 'admin', NULL));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = 'ok', 'the owner could not set min role admin (' || r || ')');
  IF r = 'ok' THEN sets_ch := sets_ch + 1; END IF;
  n := n + 1; failed := failed || pg_temp.tc_ok(pg_temp.tc_sees(u_tl, ch) = '0', 'min admin: the team leader still sees the channel');
  n := n + 1; failed := failed || pg_temp.tc_ok(pg_temp.tc_sees(u_adm, ch) = '1', 'min admin: an admin does not see the channel');
  n := n + 1; failed := failed || pg_temp.tc_ok(pg_temp.tc_sees(u_adm2, ch) = '1', 'min admin: a non-member admin does not see the channel');
  n := n + 1; failed := failed || pg_temp.tc_ok(pg_temp.tc_sees(u_own, ch) = '1', 'min admin: the owner does not see the channel');

  -- ---------- D. teams: T1 only ----------
  r := pg_temp.tc_try('authenticated', u_own, format(aud, ch, NULL, ARRAY[t1]));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = 'ok', 'the owner could not restrict to T1 (' || r || ')');
  IF r = 'ok' THEN sets_ch := sets_ch + 1; END IF;
  n := n + 1; failed := failed || pg_temp.tc_ok((SELECT audience_min_role FROM chat_channels WHERE id = ch) IS NULL,
    'T1: the team save did not clear the min role');
  n := n + 1; failed := failed || pg_temp.tc_ok(pg_temp.tc_sees(u_ag2, ch) = '0', 'T1: a T2 member still sees the channel');
  r := pg_temp.tc_reads(u_ag2, ch, mv, pre);
  n := n + 1; failed := failed || pg_temp.tc_ok(r = '0/0/0/0/0/0', 'T1: the joined T2 member still reads the channel (' || r || ')');
  r := pg_temp.tc_reads(u_ag, ch, mv, pre);
  n := n + 1; failed := failed || pg_temp.tc_ok(r = full_q, 'T1: a T1 member does not read the channel (' || r || ')');
  n := n + 1; failed := failed || pg_temp.tc_ok(pg_temp.tc_sees(u_tl, ch) = '1', 'T1: the leader of T1 does not see the channel');
  n := n + 1; failed := failed || pg_temp.tc_ok(pg_temp.tc_sees(u_adm2, ch) = '1', 'T1: a non-member admin does not see the channel');
  n := n + 1; failed := failed || pg_temp.tc_check('T1: an admin cannot read the team rows', u_adm, format(teams_q, ch), '1');
  n := n + 1; failed := failed || pg_temp.tc_check('T1: a T1 member cannot read the team rows', u_ag, format(teams_q, ch), '1');
  n := n + 1; failed := failed || pg_temp.tc_check('T1: the excluded member reads the team rows', u_ag2, format(teams_q, ch), '0');
  n := n + 1; failed := failed || pg_temp.tc_check('T1: another workspace reads the team rows', u_out, format(teams_q, ch), '0');
  n := n + 1; failed := failed || pg_temp.tc_ok((SELECT count(*) FROM chat_channel_members WHERE channel_id = ch AND user_id = u_ag2) = 1,
    'T1: the excluded member''s row was removed');
  n := n + 1; failed := failed || pg_temp.tc_check('T1: the excluded member could post', u_ag2, format(post, ch, 'x'), 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.tc_check('T1: the excluded member could type', u_ag2, format(typing, ch), 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.tc_check('T1: the excluded member has an unread row', u_ag2, format(unread, a, ch), '0');
  n := n + 1; failed := failed || pg_temp.tc_check('T1: a T1 member has no unread row', u_ag, format(unread, a, ch), '1');
  -- a non-member outside the audience: no post, no auto-join, not addable
  DELETE FROM chat_channel_members WHERE channel_id = ch AND user_id = u_vw;
  full_q := '3/5/2/1/1/2';
  r := pg_temp.tc_try('authenticated', u_vw, format(post, ch, 'x'));
  n := n + 1; failed := failed || pg_temp.tc_ok(r LIKE 'ERROR 42501%', 'T1: an outsider could post (' || r || ')');
  n := n + 1; failed := failed || pg_temp.tc_ok((SELECT count(*) FROM chat_channel_members WHERE channel_id = ch AND user_id = u_vw) = 0,
    'T1: an outsider''s refused post left a member row');
  n := n + 1; failed := failed || pg_temp.tc_check('T1: the leader could add an outsider', u_tl,
    format('SELECT public.chat_add_members(%L, %L::uuid[])::text', ch, ARRAY[u_vw]), 'ERROR 42501%');
  -- the triggers themselves, below every RPC
  n := n + 1; failed := failed || pg_temp.tc_check('member guard: an outsider''s member row was inserted', NULL,
    format('INSERT INTO chat_channel_members (channel_id, user_id, role) VALUES (%L, %L, ''member'') RETURNING ''inserted''', ch, u_vw), refused);
  n := n + 1; failed := failed || pg_temp.tc_ok(pg_temp.tc_as_uid(u_ag2,
    format('INSERT INTO chat_channel_members (channel_id, user_id, role) VALUES (%L, %L, ''member'') RETURNING ''inserted''', ch, u_ag3))
    LIKE refused, 'member guard: an adder outside the audience added someone inside it');
  n := n + 1; failed := failed || pg_temp.tc_check('message guard: an outsider''s user post was inserted', NULL,
    format('INSERT INTO internal_messages (channel_id, account_id, author_kind, author_id, body) VALUES (%L, %L, ''user'', %L, ''x'') RETURNING ''inserted''', ch, a, u_ag2), refused);
  n := n + 1; failed := failed || pg_temp.tc_check('message guard: a system post was refused', NULL,
    format('INSERT INTO internal_messages (channel_id, account_id, author_kind, author_id, body) VALUES (%L, %L, ''system'', NULL, ''sys'') RETURNING ''inserted''', ch, a), 'inserted');
  full_q := '4/5/2/1/1/2';
  n := n + 1; failed := failed || pg_temp.tc_check('typing guard: an outsider''s typing row was inserted', NULL,
    format('INSERT INTO chat_typing (channel_id, account_id, user_id) VALUES (%L, %L, %L) RETURNING ''inserted''', ch, a, u_ag2), refused);
  n := n + 1; failed := failed || pg_temp.tc_check('typing guard: an outsider''s typing row was moved in', NULL,
    format('UPDATE chat_typing SET user_id = %L WHERE channel_id = %L AND user_id = %L RETURNING ''updated''', u_ag2, ch, u_tl), refused);
  -- positive controls: someone inside the audience is added and can write
  r := pg_temp.tc_try('authenticated', u_tl, format('SELECT public.chat_add_members(%L, %L::uuid[])::text', ch, ARRAY[u_ag3]));
  n := n + 1; failed := failed || pg_temp.tc_ok(r NOT LIKE 'ERROR%', 'T1: the leader could not add a T1 agent (' || r || ')');
  n := n + 1; failed := failed || pg_temp.tc_ok((SELECT count(*) FROM chat_channel_members WHERE channel_id = ch AND user_id = u_ag3) = 1,
    'T1: the added T1 agent has no member row');
  full_q := '4/6/2/1/1/2';
  n := n + 1; failed := failed || pg_temp.tc_check('T1: a T1 member cannot type', u_ag, format(typing, ch), 'ok');
  full_q := '4/6/2/2/1/2';
  -- mentions: the excluded member gets no row and no bell
  r := pg_temp.tc_try('authenticated', u_own, format(post, ch, 'hi <@' || u_ag2 || '> and <@' || u_ag || '>'));
  n := n + 1; failed := failed || pg_temp.tc_ok(r ~ uuid_re, 'T1: the owner could not post a mention (' || r || ')');
  IF r ~ uuid_re THEN
    m := r::uuid;
    full_q := '5/6/2/2/1/2';
    n := n + 1; failed := failed || pg_temp.tc_ok((SELECT count(*) FROM message_mentions WHERE message_id = m AND user_id = u_ag2) = 0,
      'T1: the excluded member got a mention row');
    n := n + 1; failed := failed || pg_temp.tc_ok((SELECT count(*) FROM notifications WHERE user_id = u_ag2 AND meta->>'message_id' = m::text) = 0,
      'T1: the excluded member got a bell');
    n := n + 1; failed := failed || pg_temp.tc_ok((SELECT count(*) FROM message_mentions WHERE message_id = m AND user_id = u_ag) = 1,
      'T1: the T1 member got no mention row');
    n := n + 1; failed := failed || pg_temp.tc_ok((SELECT count(*) FROM notifications WHERE user_id = u_ag AND meta->>'message_id' = m::text) = 1,
      'T1: the T1 member got no bell');
  END IF;

  -- ---------- E. role AND teams ----------
  r := pg_temp.tc_try('authenticated', u_own, format(aud, ch, 'team_leader', ARRAY[t1]));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = 'ok', 'the owner could not set team_leader + T1 (' || r || ')');
  IF r = 'ok' THEN sets_ch := sets_ch + 1; END IF;
  n := n + 1; failed := failed || pg_temp.tc_ok(pg_temp.tc_sees(u_ag, ch) = '0', 'team_leader + T1: a T1 agent still sees the channel');
  n := n + 1; failed := failed || pg_temp.tc_ok(pg_temp.tc_sees(u_tl, ch) = '1', 'team_leader + T1: T1''s leader does not see the channel');
  -- the team set is replaced, not added to
  r := pg_temp.tc_try('authenticated', u_own, format(aud, ch, NULL, ARRAY[t2]));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = 'ok', 'the owner could not restrict to T2 (' || r || ')');
  IF r = 'ok' THEN sets_ch := sets_ch + 1; END IF;
  n := n + 1; failed := failed || pg_temp.tc_ok((SELECT array_agg(team_id) FROM chat_channel_teams WHERE channel_id = ch) = ARRAY[t2],
    'T2: the team set was not replaced');
  n := n + 1; failed := failed || pg_temp.tc_ok(pg_temp.tc_sees(u_ag, ch) = '0', 'T2: a T1 agent still sees the channel');
  n := n + 1; failed := failed || pg_temp.tc_ok(pg_temp.tc_sees(u_ag2, ch) = '1', 'T2: the T2 member does not see the channel');

  -- ---------- F. widening back to everyone restores access ----------
  r := pg_temp.tc_try('authenticated', u_adm, format(aud, ch, NULL, '{}'::uuid[]));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = 'ok', 'an admin could not clear the audience (' || r || ')');
  IF r = 'ok' THEN sets_ch := sets_ch + 1; END IF;
  n := n + 1; failed := failed || pg_temp.tc_ok(NOT EXISTS (SELECT 1 FROM chat_channel_teams WHERE channel_id = ch),
    'cleared: team rows are left');
  r := pg_temp.tc_reads(u_ag, ch, mv, pre);
  n := n + 1; failed := failed || pg_temp.tc_ok(r = full_q, 'cleared: the T1 agent does not read the channel again (' || r || ')');
  n := n + 1; failed := failed || pg_temp.tc_check('cleared: the T1 agent has no unread row again', u_ag, format(unread, a, ch), '1');
  n := n + 1; failed := failed || pg_temp.tc_ok(pg_temp.tc_sees(u_vw, ch) = '1', 'cleared: the viewer does not see the channel again');
  n := n + 1; failed := failed || pg_temp.tc_check('cleared: the agent cannot post again', u_ag, format(post, ch, 'back'), '________-%');

  -- ---------- G. the setter ----------
  n := n + 1; failed := failed || pg_temp.tc_check('setter: a non-manager set an audience', u_ag, format(aud, ch, 'agent', NULL), 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.tc_check('setter: a private channel took an audience', u_own, format(aud, pv, 'agent', NULL), 'ERROR 22023%');
  n := n + 1; failed := failed || pg_temp.tc_check('setter: a DM took an audience', u_own, format(aud, dm, 'agent', NULL), 'ERROR 22023%');
  n := n + 1; failed := failed || pg_temp.tc_check('setter: min role owner accepted', u_own, format(aud, ch, 'owner', NULL), 'ERROR 22023%');
  n := n + 1; failed := failed || pg_temp.tc_check('setter: an unknown role accepted', u_own, format(aud, ch, 'bogus', NULL), 'ERROR 22023%');
  n := n + 1; failed := failed || pg_temp.tc_check('setter: another workspace''s team accepted', u_own, format(aud, ch, NULL, ARRAY[tb]), 'ERROR 22023%');
  n := n + 1; failed := failed || pg_temp.tc_ok((SELECT audience_min_role FROM chat_channels WHERE id = ch) IS NULL
                                                 AND NOT EXISTS (SELECT 1 FROM chat_channel_teams WHERE channel_id = ch),
    'setter: a refused save changed the channel');
  -- self-hide: tl is the channel admin of ch2 but below workspace admin
  n := n + 1; failed := failed || pg_temp.tc_check('setter: a channel admin hid the channel from themselves by role', u_tl,
    format(aud, ch2, 'admin', NULL), 'ERROR 22023: %would hide this channel from you%');
  n := n + 1; failed := failed || pg_temp.tc_check('setter: a channel admin hid the channel from themselves by team', u_tl,
    format(aud, ch2, NULL, ARRAY[t2]), 'ERROR 22023: %would hide this channel from you%');
  n := n + 1; failed := failed || pg_temp.tc_ok((SELECT audience_min_role FROM chat_channels WHERE id = ch2) IS NULL
                                                 AND NOT EXISTS (SELECT 1 FROM chat_channel_teams WHERE channel_id = ch2),
    'setter: a refused self-hide left a change behind');
  n := n + 1; failed := failed || pg_temp.tc_ok(NOT EXISTS (SELECT 1 FROM chat_audit_log WHERE action = 'set_audience' AND channel_id = ch2),
    'setter: a refused self-hide wrote an audit row');
  r := pg_temp.tc_try('authenticated', u_tl, format(aud, ch2, 'team_leader', ARRAY[t1]));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = 'ok', 'setter: a channel admin could not keep their own team and role (' || r || ')');
  n := n + 1; failed := failed || pg_temp.tc_ok(
    (SELECT audience_min_role FROM chat_channels WHERE id = ch2) = 'team_leader'
    AND (SELECT array_agg(team_id) FROM chat_channel_teams WHERE channel_id = ch2) = ARRAY[t1],
    'setter: the channel admin''s save was not stored');
  n := n + 1; failed := failed || pg_temp.tc_ok(
    (SELECT count(*) FROM chat_audit_log WHERE action = 'set_audience' AND channel_id = ch2
        AND actor_id = u_tl AND account_id = a
        AND detail->'from'->>'min_role' IS NULL AND detail->'from'->'team_ids' = '[]'::jsonb
        AND detail->'to'->>'min_role' = 'team_leader' AND detail->'to'->'team_ids' = jsonb_build_array(t1)) = 1,
    'setter: the audit row does not carry from/to');
  -- a workspace admin may restrict below themselves (they always see it)
  n := n + 1; failed := failed || pg_temp.tc_check('setter: a workspace admin could not restrict to a team they are not in', u_adm,
    format(aud, ch2, 'admin', ARRAY[t2]), 'ok');
  n := n + 1; failed := failed || pg_temp.tc_ok(
    (SELECT count(*) FROM chat_audit_log WHERE action = 'set_audience' AND channel_id = ch) = sets_ch,
    'setter: not one audit row per save on the team channel');

  -- ---------- H. the CHECKs ----------
  n := n + 1; failed := failed || pg_temp.tc_check('CHECK: min role owner stored', NULL,
    format('UPDATE chat_channels SET audience_min_role = ''owner'' WHERE id = %L RETURNING ''updated''', ch), 'ERROR 23514%audience_min_role_check%');
  n := n + 1; failed := failed || pg_temp.tc_check('CHECK: a private channel stored an audience', NULL,
    format('UPDATE chat_channels SET audience_min_role = ''agent'' WHERE id = %L RETURNING ''updated''', pv), 'ERROR 23514%audience_team_only%');
  n := n + 1; failed := failed || pg_temp.tc_check('CHECK: a team channel cannot store min role agent', NULL,
    format('UPDATE chat_channels SET audience_min_role = ''agent'' WHERE id = %L RETURNING ''updated''', ch), 'updated');

  -- ---------- I. managing a team channel needs its audience ----------
  ch3 := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_create_channel(%L, %L, %L, NULL, %L::uuid[])::text',
          a, 'team', 'TC159 manage', ARRAY[u_ag, u_ag2, u_ag3]));
  r := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_set_member_role(%L, %L, %L)::text', ch3, u_ag2, 'admin'));
  IF r <> 'ok' THEN RAISE EXCEPTION 'fixture: ch3 channel admin (%)', r; END IF;
  r := pg_temp.tc_try('authenticated', u_own, format(aud, ch3, NULL, ARRAY[t1]));
  IF r <> 'ok' THEN RAISE EXCEPTION 'fixture: ch3 audience T1 (%)', r; END IF;
  -- u_ag2 (T2) is a channel admin the audience now excludes
  n := n + 1; failed := failed || pg_temp.tc_check('manage: an out-of-audience channel admin renamed the channel', u_ag2,
    format('SELECT public.chat_update_channel(%L, %L, NULL)::text', ch3, 'renamed'), mg);
  n := n + 1; failed := failed || pg_temp.tc_check('manage: an out-of-audience channel admin set a member role', u_ag2,
    format('SELECT public.chat_set_member_role(%L, %L, %L)::text', ch3, u_ag, 'admin'), mg);
  n := n + 1; failed := failed || pg_temp.tc_check('manage: an out-of-audience channel admin set the channel policy', u_ag2,
    format('SELECT public.chat_set_channel_policy(%L, %L, %L, %L)::text', ch3, 'admins', 'everyone', 'admins'), mg);
  n := n + 1; failed := failed || pg_temp.tc_check('manage: an out-of-audience channel admin restricted a member', u_ag2,
    format('SELECT public.chat_restrict_member(%L, %L, now() + interval ''1 hour'', %L)::text', ch3, u_ag3, 'cool down'), mg);
  n := n + 1; failed := failed || pg_temp.tc_check('manage: an out-of-audience channel admin removed a member', u_ag2,
    format('SELECT public.chat_remove_member(%L, %L)::text', ch3, u_ag3), mg);
  n := n + 1; failed := failed || pg_temp.tc_check('manage: an out-of-audience channel admin reopened the audience', u_ag2,
    format(aud, ch3, NULL, '{}'::uuid[]), mg);
  n := n + 1; failed := failed || pg_temp.tc_check('manage: an out-of-audience channel admin archived the channel', u_ag2,
    format('SELECT public.chat_archive_channel(%L, true)::text', ch3), mg);
  n := n + 1; failed := failed || pg_temp.tc_check('manage: a refused manager changed the channel', NULL,
    format('SELECT c.name || ''/'' || (c.archived_at IS NULL) || ''/'' || c.audience_team_restricted || ''/'' || (SELECT string_agg(user_id::text || '':'' || role, '','' ORDER BY role, user_id) FROM chat_channel_members WHERE channel_id = c.id AND user_id IN (%L, %L, %L)) || ''/'' || (SELECT count(*) FROM chat_channel_restrictions WHERE channel_id = c.id) FROM chat_channels c WHERE c.id = %L', u_ag, u_ag2, u_ag3, ch3),
    'TC159 manage/true/true/' || u_ag2 || ':admin,' || u_ag || ':member,' || u_ag3 || ':member/0');
  -- (only a broken gate archives it; un-archive so the controls below stand alone)
  UPDATE chat_channels SET archived_at = NULL WHERE id = ch3;
  -- a workspace admin (not a member) still manages it
  n := n + 1; failed := failed || pg_temp.tc_check('manage: a workspace admin could not rename the channel', u_adm2,
    format('SELECT public.chat_update_channel(%L, %L, NULL)::text', ch3, 'TC159 manage 2'), 'ok');
  n := n + 1; failed := failed || pg_temp.tc_check('manage: a workspace admin could not set a member role', u_adm2,
    format('SELECT public.chat_set_member_role(%L, %L, %L)::text', ch3, u_ag, 'admin'), 'ok');
  -- an in-audience channel admin (u_ag, T1) still manages it
  n := n + 1; failed := failed || pg_temp.tc_check('manage: an in-audience channel admin could not rename the channel', u_ag,
    format('SELECT public.chat_update_channel(%L, %L, NULL)::text', ch3, 'TC159 manage 3'), 'ok');
  n := n + 1; failed := failed || pg_temp.tc_check('manage: an in-audience channel admin could not set the channel policy', u_ag,
    format('SELECT public.chat_set_channel_policy(%L, %L, %L, %L)::text', ch3, 'admins', 'everyone', 'admins'), 'ok');
  -- (165: a co-admin's role needs a workspace owner/admin, so the
  -- channel admin promotes a plain member here)
  n := n + 1; failed := failed || pg_temp.tc_check('manage: an in-audience channel admin could not set a member role', u_ag,
    format('SELECT public.chat_set_member_role(%L, %L, %L)::text', ch3, u_ag3, 'admin'), 'ok');
  n := n + 1; failed := failed || pg_temp.tc_check('manage: the controls did not take effect', NULL,
    format('SELECT c.name || ''/'' || (SELECT string_agg(user_id::text || '':'' || role, '','' ORDER BY role, user_id) FROM chat_channel_members WHERE channel_id = c.id AND user_id IN (%L, %L, %L)) FROM chat_channels c WHERE c.id = %L', u_ag, u_ag2, u_ag3, ch3),
    'TC159 manage 3/' || u_ag || ':admin,' || u_ag2 || ':admin,' || u_ag3 || ':admin');

  -- ---------- J. a deleted team leaves the channel closed, not open ----------
  INSERT INTO teams (account_id, name) VALUES (a, 'TC159 T3') RETURNING id INTO t3;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (t3, u_vw, a);
  ch4 := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_create_channel(%L, %L, %L, NULL, %L::uuid[])::text',
          a, 'team', 'TC159 deleted team', ARRAY[u_vw]));
  r := pg_temp.tc_try('authenticated', u_own, format(aud, ch4, NULL, ARRAY[t3]));
  IF r <> 'ok' THEN RAISE EXCEPTION 'fixture: ch4 audience T3 (%)', r; END IF;
  n := n + 1; failed := failed || pg_temp.tc_ok(pg_temp.tc_sees(u_vw, ch4) = '1' AND pg_temp.tc_sees(u_ag, ch4) = '0',
    'deleted team: before the delete, T3''s member does not see the channel or an outsider does');
  DELETE FROM teams WHERE id = t3;
  n := n + 1; failed := failed || pg_temp.tc_check('deleted team: the flag was cleared or the rows survived', NULL,
    format('SELECT c.audience_team_restricted::text || ''/'' || (SELECT count(*) FROM chat_channel_teams WHERE channel_id = c.id) FROM chat_channels c WHERE c.id = %L', ch4),
    'true/0');
  n := n + 1; failed := failed || pg_temp.tc_ok(pg_temp.tc_sees(u_vw, ch4) = '0',
    'deleted team: the deleted team''s former member still reads the channel');
  n := n + 1; failed := failed || pg_temp.tc_ok(pg_temp.tc_sees(u_ag, ch4) = '0',
    'deleted team: a staff member outside the deleted team reads the channel');
  n := n + 1; failed := failed || pg_temp.tc_ok(pg_temp.tc_sees(u_tl, ch4) = '0',
    'deleted team: a team leader reads the channel');
  n := n + 1; failed := failed || pg_temp.tc_ok(pg_temp.tc_sees(u_adm2, ch4) = '1',
    'deleted team: a workspace admin does not read the channel');
  r := pg_temp.tc_try('authenticated', u_own, format(aud, ch4, NULL, '{}'::uuid[]));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = 'ok', 'deleted team: saving the audience with no teams failed (' || r || ')');
  n := n + 1; failed := failed || pg_temp.tc_check('deleted team: saving no teams left the flag on', NULL,
    format('SELECT audience_team_restricted::text FROM chat_channels WHERE id = %L', ch4), 'false');
  n := n + 1; failed := failed || pg_temp.tc_ok(pg_temp.tc_sees(u_ag, ch4) = '1' AND pg_temp.tc_sees(u_vw, ch4) = '1',
    'deleted team: saving no teams did not reopen the channel to staff');

  -- ---------- privileges ----------
  n := n + 1; failed := failed || pg_temp.tc_ok(
    has_table_privilege('authenticated', 'public.chat_channel_teams', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.chat_channel_teams', 'INSERT,UPDATE,DELETE,TRUNCATE')
    AND NOT has_table_privilege('anon', 'public.chat_channel_teams', 'SELECT,INSERT,UPDATE,DELETE')
    AND NOT has_table_privilege('service_role', 'public.chat_channel_teams', 'SELECT,INSERT,UPDATE,DELETE'),
    'chat_channel_teams is writable, or readable beyond authenticated SELECT');
  n := n + 1; failed := failed || pg_temp.tc_ok(
    (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'public.chat_channel_teams'::regclass),
    'RLS is not forced on chat_channel_teams');
  n := n + 1; failed := failed || pg_temp.tc_ok(EXISTS (SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'chat_channel_teams'),
    'chat_channel_teams is not in the realtime publication');
  FOREACH f IN ARRAY internal_fns LOOP
    n := n + 1; failed := failed || pg_temp.tc_ok(NOT has_function_privilege('anon', f, 'EXECUTE')
                                                 AND NOT has_function_privilege('public', f, 'EXECUTE')
                                                 AND NOT has_function_privilege('service_role', f, 'EXECUTE')
                                                 AND NOT has_function_privilege('authenticated', f, 'EXECUTE'),
      f || ' is executable by a client role');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.tc_ok(NOT has_function_privilege('anon', setter, 'EXECUTE')
                                               AND NOT has_function_privilege('public', setter, 'EXECUTE')
                                               AND NOT has_function_privilege('service_role', setter, 'EXECUTE'),
    setter || ' is executable by anon, PUBLIC or service_role');
  n := n + 1; failed := failed || pg_temp.tc_ok(has_function_privilege('authenticated', setter, 'EXECUTE'),
    setter || ' is not executable by authenticated');

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT159', MESSAGE = 'verify-chat-restricted-channels rollback';
  EXCEPTION WHEN SQLSTATE 'ZT159' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'chat restricted channels verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'chat restricted channels verification passed (% checks)', n;
END
$verify$;
