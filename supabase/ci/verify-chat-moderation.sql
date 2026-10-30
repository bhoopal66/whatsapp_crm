-- Behavioural regression suite for team chat moderation (migration 160).
--
-- internal_messages.deleted_by is written only by the update that sets
-- deleted_at from NULL, never on a live message and never changed
-- afterwards (42501). chat_delete_message(p_message, p_reason DEFAULT
-- NULL) replaced the (uuid) signature: removing someone else's message
-- is for a live workspace owner / admin, or a channel admin (not a bank
-- guest) of a team or private channel, never a DM; it needs a trimmed
-- reason of 5..500 characters (22023, nothing written), writes a
-- 'moderate_delete' audit row and stamps deleted_by with the moderator.
-- An author's own delete needs no reason, stamps the author and writes
-- no audit row. System posts are the workspace owner / admin's alone.
-- chat_restrict_member puts a posting timeout (post_blocked_until) on a
-- team or private channel member: reason required, future, at most 30
-- days, never a workspace admin, yourself, or (for a channel admin)
-- another channel admin, never by a plain member, never on an archived
-- channel or a DM; a team non-member gets a 'member' row to hold it, a
-- private non-member is P0002; clearing needs no reason and clearing
-- someone with no row is a no-op. A restricted member cannot post,
-- reply, react, pin, type, upload or edit (42501), still reads and
-- marks read, and is free again once the time passes.
-- chat_export_channel is a live owner / admin's audited export of any
-- channel of the workspace (members or not, chat switched off or not).
-- The three RPCs are executable by authenticated only; the reason
-- helper by nobody.
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
  u_own  UUID := '00000000-0000-4000-8000-000000160101';  -- owner
  u_adm  UUID := '00000000-0000-4000-8000-000000160102';  -- admin
  u_tl   UUID := '00000000-0000-4000-8000-000000160103';  -- team leader
  u_ag   UUID := '00000000-0000-4000-8000-000000160104';  -- agent, channel admin of ch and pv
  u_ag2  UUID := '00000000-0000-4000-8000-000000160105';  -- agent, plain member
  u_ag3  UUID := '00000000-0000-4000-8000-000000160106';  -- agent, the one restricted
  u_ag4  UUID := '00000000-0000-4000-8000-000000160107';  -- agent, not in ch until restricted
  u_x    UUID := '00000000-0000-4000-8000-000000160108';  -- agent, in nothing
  u_g    UUID := '00000000-0000-4000-8000-000000160109';  -- bank guest, admin row in pv
  a      UUID;
  ch     UUID;  -- team: own adm tl ag(admin) ag2 ag3
  pv     UUID;  -- private: ag(admin) ag2 g(admin row)
  pv2    UUID;  -- private, exported: ag ag2
  dm     UUID;  -- DM: ag ag2
  arc    UUID;  -- archived team channel: own ag3
  m      UUID;
  m2     UUID;
  m3     UUID;
  mv     UUID;
  ms     UUID;
  e3     UUID;  -- ag3's own message in ch
  mr     UUID;  -- react / pin target in ch
  own1   UUID;
  own2   UUID;
  j      JSONB;
  r      TEXT;
  pre    TEXT;
  vp     TEXT;
  ids    TEXT;
  post   TEXT := 'SELECT public.chat_post_message(%L, %L)::text';
  reply  TEXT := 'SELECT public.chat_post_message(%L, %L, %L::uuid)::text';
  del    TEXT := 'SELECT public.chat_delete_message(%L, %L)::text';
  rs     TEXT := 'SELECT public.chat_restrict_member(%L, %L, %s, %L)::text';
  ex     TEXT := 'SELECT public.chat_export_channel(%L, %s, %s, %L)::text';
  upl    TEXT := 'INSERT INTO storage.objects (bucket_id, name, owner) VALUES (''chat-files'', %L, %L) RETURNING ''ins''';
  hour   TEXT := 'now() + interval ''1 hour''';
  uuid_re TEXT := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  fns    TEXT[] := ARRAY[
    'public.chat_delete_message(uuid,text)',
    'public.chat_restrict_member(uuid,uuid,timestamptz,text)',
    'public.chat_export_channel(uuid,timestamptz,timestamptz,text)'];
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
  -- p_uid NULL runs p_sql as the current (superuser) role.
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
  -- An uploaded chat-files object under the channel's prefix: its path.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.tc_up(p_ws uuid, p_ch uuid, p_name text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := 'account-' || p_ws || '/channel-' || p_ch || '/' || gen_random_uuid() || '-' || p_name;
    BEGIN
      INSERT INTO storage.objects (bucket_id, name) VALUES ('chat-files', v);
      RETURN v;
    END $body$
  $fn$;

  -- ---------- fixture ----------
  -- (a UUID variable assigned an 'ERROR …' result raises, so a failed
  -- fixture RPC stops the run loudly)
  INSERT INTO auth.users (id, email) VALUES
    (u_own, 'ci-mod-own@example.invalid'), (u_adm, 'ci-mod-adm@example.invalid'),
    (u_tl, 'ci-mod-tl@example.invalid'), (u_ag, 'ci-mod-ag@example.invalid'),
    (u_ag2, 'ci-mod-ag2@example.invalid'), (u_ag3, 'ci-mod-ag3@example.invalid'),
    (u_ag4, 'ci-mod-ag4@example.invalid'), (u_x, 'ci-mod-x@example.invalid'),
    (u_g, 'ci-mod-g@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a FROM profiles WHERE user_id = u_own;
  IF a IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE accounts SET internal_chat_enabled = true WHERE id = a;
  UPDATE profiles SET account_id = a, account_role = 'admin' WHERE user_id = u_adm;
  UPDATE profiles SET account_id = a, account_role = 'team_leader' WHERE user_id = u_tl;
  UPDATE profiles SET account_id = a, account_role = 'agent' WHERE user_id IN (u_ag, u_ag2, u_ag3, u_ag4, u_x);
  UPDATE profiles SET full_name = 'Mod Two' WHERE user_id = u_ag2;
  INSERT INTO case_banks (account_id, code, name) VALUES (a, 'ADCB', 'ADCB Bank') ON CONFLICT DO NOTHING;
  UPDATE profiles SET account_id = a, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_g;

  ch := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_create_channel(%L, %L, %L, NULL, %L::uuid[])::text', a, 'team', 'Mod team', ARRAY[u_adm, u_tl, u_ag, u_ag2, u_ag3]));
  pv := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_create_channel(%L, %L, %L, NULL, %L::uuid[])::text', a, 'private', 'Mod private', ARRAY[u_ag, u_ag2]));
  arc := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_create_channel(%L, %L, %L, NULL, %L::uuid[])::text', a, 'team', 'Mod archived', ARRAY[u_ag3]));
  pv2 := pg_temp.tc_try('authenticated', u_ag, format('SELECT public.chat_create_channel(%L, %L, %L, %L, %L::uuid[])::text', a, 'private', 'Mod secret', 'the topic', ARRAY[u_ag2]));
  dm := pg_temp.tc_try('authenticated', u_ag, format('SELECT public.chat_open_dm(%L, %L::uuid[])::text', a, ARRAY[u_ag2]));
  r := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_set_member_role(%L, %L, %L)::text', ch, u_ag, 'admin'));
  r := r || pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_set_member_role(%L, %L, %L)::text', pv, u_ag, 'admin'));
  IF r LIKE '%ERROR%' THEN RAISE EXCEPTION 'fixture: channel admin roles (%)', r; END IF;
  -- a bank guest holding an admin row in a private channel (written directly)
  INSERT INTO chat_channel_members (channel_id, user_id, role) VALUES (pv, u_g, 'admin');
  -- a DM member holding an admin row (written directly)
  UPDATE chat_channel_members SET role = 'admin' WHERE channel_id = dm AND user_id = u_ag;
  pre := 'account-' || a || '/channel-' || ch || '/';

  -- ---------- A. chat_delete_message signature ----------
  n := n + 1; failed := failed || pg_temp.tc_ok(to_regprocedure('public.chat_delete_message(uuid)') IS NULL,
    'chat_delete_message(uuid) still exists');
  n := n + 1; failed := failed || pg_temp.tc_ok(to_regprocedure('public.chat_delete_message(uuid,text)') IS NOT NULL,
    'chat_delete_message(uuid,text) is missing');

  -- ---------- A. moderator deletes need a reason ----------
  m := pg_temp.tc_try('authenticated', u_ag2, format(post, ch, 'spam one'));
  n := n + 1; failed := failed || pg_temp.tc_check('admin moderate delete without a reason is refused', u_adm,
    format('SELECT public.chat_delete_message(%L)::text', m), 'ERROR 22023:%a reason is required%');
  n := n + 1; failed := failed || pg_temp.tc_check('admin moderate delete with a blank reason is refused', u_adm,
    format(del, m, E' \t\n '), 'ERROR 22023:%a reason is required%');
  n := n + 1; failed := failed || pg_temp.tc_check('admin moderate delete with 4 non-blank characters is refused', u_adm,
    format(del, m, 'a b  c d'), 'ERROR 22023:%a reason is required%');
  n := n + 1; failed := failed || pg_temp.tc_check('admin moderate delete with a 501-character reason is refused', u_adm,
    format(del, m, repeat('x', 501)), 'ERROR 22023:%a reason is required%');
  n := n + 1; failed := failed || pg_temp.tc_check('a refused moderate delete wrote something', NULL,
    format('SELECT (deleted_at IS NULL AND deleted_by IS NULL)::text || (SELECT count(*) FROM chat_audit_log WHERE action = ''moderate_delete'' AND account_id = %L) FROM internal_messages WHERE id = %L', a, m),
    'true0');
  r := pg_temp.tc_try('authenticated', u_adm, format(del, m, '  off-topic spam  '));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = '{}', 'admin moderate delete with a reason failed (' || r || ')');
  n := n + 1; failed := failed || pg_temp.tc_check('moderate delete: deleted_by is not the admin', NULL,
    format('SELECT deleted_by::text || ''/'' || body || ''/'' || (deleted_at IS NOT NULL) FROM internal_messages WHERE id = %L', m),
    u_adm || '//true');
  n := n + 1; failed := failed || pg_temp.tc_check('moderate_delete audit row is wrong', NULL,
    format('SELECT string_agg(actor_id || ''|'' || channel_id || ''|'' || (detail->>''message_id'') || ''|'' || (detail->>''author_id'') || ''|'' || (detail->>''reason''), '';'') FROM chat_audit_log WHERE action = ''moderate_delete'' AND account_id = %L', a),
    u_adm || '|' || ch || '|' || m || '|' || u_ag2 || '|off-topic spam');
  m2 := pg_temp.tc_try('authenticated', u_ag2, format(post, ch, 'spam two'));
  r := pg_temp.tc_try('authenticated', u_adm, format(del, m2, repeat('y', 500)));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = '{}', 'admin moderate delete with a 500-character reason failed (' || r || ')');

  -- ---------- A. deleted_by is written once, with deleted_at ----------
  n := n + 1; failed := failed || pg_temp.tc_check('deleted_by changed after the delete', NULL,
    format('UPDATE internal_messages SET deleted_by = %L WHERE id = %L RETURNING ''updated''', u_own, m), 'ERROR 42501:%deleted_by%');
  m3 := pg_temp.tc_try('authenticated', u_ag2, format(post, ch, 'live'));
  n := n + 1; failed := failed || pg_temp.tc_check('deleted_by set on a live message', NULL,
    format('UPDATE internal_messages SET deleted_by = %L WHERE id = %L RETURNING ''updated''', u_own, m3), 'ERROR 42501:%deleted_by%');
  n := n + 1; failed := failed || pg_temp.tc_check('deleted_by refused in the update that deletes', NULL,
    format('UPDATE internal_messages SET body = '''', deleted_at = now(), deleted_by = %L WHERE id = %L RETURNING ''updated''', u_own, m3), 'updated');

  -- ---------- A. who may remove someone else's message ----------
  m := pg_temp.tc_try('authenticated', u_ag2, format(post, ch, 'not yours'));
  n := n + 1; failed := failed || pg_temp.tc_check('a plain agent removed another''s message', u_ag3,
    format(del, m, 'not my call'), 'ERROR 42501:%only the author%');
  n := n + 1; failed := failed || pg_temp.tc_check('channel admin moderate delete without a reason is refused', u_ag,
    format('SELECT public.chat_delete_message(%L)::text', m), 'ERROR 22023:%a reason is required%');
  r := pg_temp.tc_try('authenticated', u_ag, format(del, m, 'channel moderation'));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = '{}', 'channel admin moderate delete in a team channel failed (' || r || ')');
  n := n + 1; failed := failed || pg_temp.tc_check('team channel moderate delete: deleted_by / audit', NULL,
    format('SELECT (SELECT deleted_by::text FROM internal_messages WHERE id = %L) || ''|'' || (SELECT count(*) FROM chat_audit_log WHERE action = ''moderate_delete'' AND actor_id = %L AND detail->>''message_id'' = %L)', m, u_ag, m),
    u_ag || '|1');
  m := pg_temp.tc_try('authenticated', u_ag2, format(post, pv, 'private post'));
  n := n + 1; failed := failed || pg_temp.tc_check('a bank guest with an admin row moderated a private channel', u_g,
    format(del, m, 'guest moderation'), 'ERROR 42501:%only the author%');
  r := pg_temp.tc_try('authenticated', u_ag, format(del, m, 'channel moderation'));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = '{}', 'channel admin moderate delete in a private channel failed (' || r || ')');
  m := pg_temp.tc_try('authenticated', u_ag2, format(post, dm, 'dm post'));
  n := n + 1; failed := failed || pg_temp.tc_check('a channel admin row moderated a DM', u_ag,
    format(del, m, 'channel moderation'), 'ERROR 42501:%only the author%');

  -- ---------- A. own deletes ----------
  own1 := m;
  r := pg_temp.tc_try('authenticated', u_ag2, format('SELECT public.chat_delete_message(%L)::text', own1));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = '{}', 'own delete (1 argument, no reason) failed (' || r || ')');
  own2 := pg_temp.tc_try('authenticated', u_ag2, format(post, ch, 'mine'));
  r := pg_temp.tc_try('authenticated', u_ag2, format('SELECT public.chat_delete_message(p_message => %L)::text', own2));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = '{}', 'own delete (named p_message) failed (' || r || ')');
  n := n + 1; failed := failed || pg_temp.tc_check('own delete: deleted_by is not the author, or an audit row was written', NULL,
    format('SELECT string_agg(deleted_by::text, '','') || ''|'' || (SELECT count(*) FROM chat_audit_log WHERE action = ''moderate_delete'' AND detail->>''message_id'' IN (%L, %L)) FROM internal_messages WHERE id IN (%L, %L)', own1, own2, own1, own2),
    u_ag2 || ',' || u_ag2 || '|0');

  -- ---------- A. system posts ----------
  INSERT INTO internal_messages (channel_id, account_id, author_kind, author_id, body)
  VALUES (ch, a, 'system', NULL, 'system note') RETURNING id INTO ms;
  n := n + 1; failed := failed || pg_temp.tc_check('a channel admin removed a system post', u_ag,
    format(del, ms, 'channel moderation'), 'ERROR 42501:%only the author%');
  n := n + 1; failed := failed || pg_temp.tc_check('system post removed without a reason', u_adm,
    format('SELECT public.chat_delete_message(%L)::text', ms), 'ERROR 22023:%a reason is required%');
  r := pg_temp.tc_try('authenticated', u_adm, format(del, ms, 'stale notice'));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = '{}', 'admin removing a system post with a reason failed (' || r || ')');
  n := n + 1; failed := failed || pg_temp.tc_check('system post delete: deleted_by / audit', NULL,
    format('SELECT (SELECT deleted_by::text FROM internal_messages WHERE id = %L) || ''|'' || (SELECT count(*) FROM chat_audit_log WHERE action = ''moderate_delete'' AND detail->>''message_id'' = %L AND detail->''author_id'' = ''null''::jsonb)', ms, ms),
    u_adm || '|1');

  -- ---------- B. chat_restrict_member refusals ----------
  e3 := pg_temp.tc_try('authenticated', u_ag3, format(post, ch, 'ag3 wrote this'));
  mr := pg_temp.tc_try('authenticated', u_ag2, format(post, ch, 'react to me'));
  n := n + 1; failed := failed || pg_temp.tc_check('restrict without a reason', u_ag,
    format(rs, ch, u_ag3, hour, NULL), 'ERROR 22023:%a reason is required%');
  n := n + 1; failed := failed || pg_temp.tc_check('restrict for more than 30 days', u_ag,
    format(rs, ch, u_ag3, 'now() + interval ''31 days''', 'cool down'), 'ERROR 22023:%30 days%');
  n := n + 1; failed := failed || pg_temp.tc_check('restrict until a past time', u_ag,
    format(rs, ch, u_ag3, 'now() - interval ''1 minute''', 'cool down'), 'ERROR 22023:%future%');
  n := n + 1; failed := failed || pg_temp.tc_check('restrict in a DM', u_ag,
    format(rs, dm, u_ag2, hour, 'cool down'), 'ERROR 22023:%');
  n := n + 1; failed := failed || pg_temp.tc_check('restrict a workspace admin', u_ag,
    format(rs, ch, u_adm, hour, 'cool down'), 'ERROR 42501:%owner or admin cannot be restricted%');
  r := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_set_member_role(%L, %L, %L)::text', ch, u_tl, 'admin'));
  n := n + 1; failed := failed || pg_temp.tc_check('a channel admin restricted another channel admin', u_ag,
    format(rs, ch, u_tl, hour, 'cool down'), 'ERROR 42501:%channel admin%');
  n := n + 1; failed := failed || pg_temp.tc_check('the owner could not restrict a channel admin', u_own,
    format(rs, ch, u_tl, hour, 'cool down'), 'ok');
  n := n + 1; failed := failed || pg_temp.tc_check('the owner could not clear a restriction without a reason', u_own,
    format(rs, ch, u_tl, 'NULL', NULL), 'ok');
  n := n + 1; failed := failed || pg_temp.tc_check('a plain member restricted someone', u_ag2,
    format(rs, ch, u_ag3, hour, 'cool down'), 'ERROR 42501:%');
  n := n + 1; failed := failed || pg_temp.tc_check('restrict yourself', u_ag,
    format(rs, ch, u_ag, hour, 'cool down'), 'ERROR 22023:%yourself%');
  r := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_archive_channel(%L, true)::text', arc));
  n := n + 1; failed := failed || pg_temp.tc_check('restrict on an archived channel', u_own,
    format(rs, arc, u_ag3, hour, 'cool down'), 'ERROR %');
  n := n + 1; failed := failed || pg_temp.tc_check('a refused restrict on an archived channel wrote the row', NULL,
    format('SELECT (post_blocked_until IS NULL)::text FROM chat_channel_members WHERE channel_id = %L AND user_id = %L', arc, u_ag3), 'true');
  n := n + 1; failed := failed || pg_temp.tc_check('a private channel non-member was restricted', u_ag,
    format(rs, pv, u_ag4, hour, 'not here yet'), 'ERROR P0002:%not a member of this channel%');
  -- clearing someone with no row is a no-op
  n := n + 1; failed := failed || pg_temp.tc_check('clearing someone with no row failed', u_own,
    format(rs, ch, u_x, 'NULL', NULL), 'ok');
  n := n + 1; failed := failed || pg_temp.tc_check('clearing someone with no row wrote a row or an audit row', NULL,
    format('SELECT (SELECT count(*) FROM chat_channel_members WHERE channel_id = %L AND user_id = %L) || ''|'' || (SELECT count(*) FROM chat_audit_log WHERE action = ''restrict_member'' AND detail->>''user_id'' = %L)', ch, u_x, u_x),
    '0|0');

  -- ---------- B. a restricted member ----------
  n := n + 1; failed := failed || pg_temp.tc_check('a channel admin could not restrict a member', u_ag,
    format(rs, ch, u_ag3, hour, ' too many pings '), 'ok');
  n := n + 1; failed := failed || pg_temp.tc_check('restrict_member audit row is wrong', NULL,
    format('SELECT string_agg((detail->>''user_id'') || ''|'' || (detail->>''reason'') || ''|'' || ((detail->>''until'')::timestamptz > now()), '';'') FROM chat_audit_log WHERE action = ''restrict_member'' AND channel_id = %L AND actor_id = %L', ch, u_ag),
    u_ag3 || '|too many pings|true');
  n := n + 1; failed := failed || pg_temp.tc_check('restricted member posted', u_ag3,
    format(post, ch, 'hi'), 'ERROR 42501:%restricted from posting%');
  n := n + 1; failed := failed || pg_temp.tc_check('restricted member replied', u_ag3,
    format(reply, ch, 'hi', mr), 'ERROR 42501:%restricted from posting%');
  n := n + 1; failed := failed || pg_temp.tc_check('restricted member reacted', u_ag3,
    format('SELECT public.chat_toggle_reaction(%L, %L)::text', mr, 'ok'), 'ERROR 42501:%restricted from posting%');
  n := n + 1; failed := failed || pg_temp.tc_check('restricted member pinned', u_ag3,
    format('SELECT public.chat_set_pin(%L, true)::text', mr), 'ERROR 42501:%restricted from posting%');
  n := n + 1; failed := failed || pg_temp.tc_check('restricted member typed', u_ag3,
    format('SELECT public.chat_set_typing(%L)::text', ch), 'ERROR 42501:%restricted from posting%');
  n := n + 1; failed := failed || pg_temp.tc_check('restricted member edited', u_ag3,
    format('SELECT public.chat_edit_message(%L, %L)::text', e3, 'edited'), 'ERROR 42501:%restricted from posting%');
  vp := pre || gen_random_uuid() || '-d.pdf';
  n := n + 1; failed := failed || pg_temp.tc_check('restricted member: chat_storage_can_write is not false', u_ag3,
    format('SELECT public.chat_storage_can_write(%L)::text', vp), 'false');
  n := n + 1; failed := failed || pg_temp.tc_check('restricted member uploaded', u_ag3,
    format(upl, vp, u_ag3), 'ERROR %');
  n := n + 1; failed := failed || pg_temp.tc_check('restricted member cannot read', u_ag3,
    format('SELECT count(*)::text FROM public.internal_messages WHERE id = %L', mr), '1');
  n := n + 1; failed := failed || pg_temp.tc_check('restricted member cannot mark read', u_ag3,
    format('SELECT public.chat_mark_read(%L)::text', ch), 'ok%');
  -- controls: an unrestricted member does all of it
  r := pg_temp.tc_try('authenticated', u_ag2, format(post, ch, 'hi'));
  n := n + 1; failed := failed || pg_temp.tc_ok(r ~ uuid_re, 'unrestricted member could not post (' || r || ')');
  r := pg_temp.tc_try('authenticated', u_ag2, format(reply, ch, 'hi', mr));
  n := n + 1; failed := failed || pg_temp.tc_ok(r ~ uuid_re, 'unrestricted member could not reply (' || r || ')');
  n := n + 1; failed := failed || pg_temp.tc_check('unrestricted member could not react', u_ag2,
    format('SELECT public.chat_toggle_reaction(%L, %L)::text', mr, 'ok'), 'true');
  n := n + 1; failed := failed || pg_temp.tc_check('unrestricted member could not pin', u_ag2,
    format('SELECT public.chat_set_pin(%L, true)::text', mr), 'ok%');
  n := n + 1; failed := failed || pg_temp.tc_check('unrestricted member could not type', u_ag2,
    format('SELECT public.chat_set_typing(%L)::text', ch), 'ok%');
  vp := pre || gen_random_uuid() || '-d.pdf';
  n := n + 1; failed := failed || pg_temp.tc_check('unrestricted member: chat_storage_can_write is not true', u_ag2,
    format('SELECT public.chat_storage_can_write(%L)::text', vp), 'true');
  n := n + 1; failed := failed || pg_temp.tc_check('unrestricted member could not upload', u_ag2,
    format(upl, vp, u_ag2), 'ins');
  -- the timeout ends by itself
  UPDATE chat_channel_members SET post_blocked_until = now() - interval '1 second' WHERE channel_id = ch AND user_id = u_ag3;
  r := pg_temp.tc_try('authenticated', u_ag3, format(post, ch, 'back'));
  n := n + 1; failed := failed || pg_temp.tc_ok(r ~ uuid_re, 'an expired restriction still blocks posting (' || r || ')');
  n := n + 1; failed := failed || pg_temp.tc_check('an expired restriction still blocks editing', u_ag3,
    format('SELECT public.chat_edit_message(%L, %L)::text', e3, 'edited'), 'ok%');
  -- re-restrict, then clear
  n := n + 1; failed := failed || pg_temp.tc_check('re-restrict failed', u_ag,
    format(rs, ch, u_ag3, 'now() + interval ''2 days''', 'again please'), 'ok');
  n := n + 1; failed := failed || pg_temp.tc_check('re-restricted member posted', u_ag3,
    format(post, ch, 'hi'), 'ERROR 42501:%restricted from posting%');
  n := n + 1; failed := failed || pg_temp.tc_check('clearing a restriction failed', u_ag,
    format(rs, ch, u_ag3, 'NULL', NULL), 'ok');
  r := pg_temp.tc_try('authenticated', u_ag3, format(post, ch, 'hi again'));
  n := n + 1; failed := failed || pg_temp.tc_ok(r ~ uuid_re, 'a cleared member could not post (' || r || ')');
  -- a team channel non-member gets a 'member' row to hold it
  n := n + 1; failed := failed || pg_temp.tc_check('restricting a team channel non-member failed', u_own,
    format(rs, ch, u_ag4, 'now() + interval ''1 day''', 'not here yet'), 'ok');
  n := n + 1; failed := failed || pg_temp.tc_check('team non-member: no member row holds the restriction', NULL,
    format('SELECT role || ''/'' || (post_blocked_until > now()) FROM chat_channel_members WHERE channel_id = %L AND user_id = %L', ch, u_ag4),
    'member/true');
  n := n + 1; failed := failed || pg_temp.tc_check('restricted team non-member posted', u_ag4,
    format(post, ch, 'hi'), 'ERROR 42501:%restricted from posting%');

  -- ---------- C. chat_export_channel ----------
  m := pg_temp.tc_try('authenticated', u_ag, format(post, pv2, format('hello <@%s>', u_ag2)));
  m2 := pg_temp.tc_try('authenticated', u_ag2, format(post, pv2, 'to be removed'));
  m3 := pg_temp.tc_try('authenticated', u_ag2, format(reply, pv2, 'a reply', m));
  vp := pg_temp.tc_up(a, pv2, 'v.ogg');
  mv := pg_temp.tc_try('authenticated', u_ag2, format('SELECT public.chat_post_message(%L, %L, NULL, NULL, %L::jsonb)::text', pv2, 'voice',
        format('[{"storage_path":%s,"name":"v.ogg","mime":"audio/ogg","bytes":100,"kind":"voice","duration_ms":4200}]', to_json(vp))));
  r := pg_temp.tc_try('authenticated', u_ag2, format('SELECT public.chat_delete_message(%L)::text', m2));
  IF r <> '{}' THEN
    RAISE EXCEPTION 'fixture: export own delete (%)', r;
  END IF;
  n := n + 1; failed := failed || pg_temp.tc_check('a team leader exported', u_tl,
    format(ex, pv2, 'NULL', 'NULL', 'audit request'), 'ERROR 42501:%owner or admin%');
  n := n + 1; failed := failed || pg_temp.tc_check('export without a reason', u_adm,
    format(ex, pv2, 'NULL', 'NULL', NULL), 'ERROR 22023:%a reason is required%');
  n := n + 1; failed := failed || pg_temp.tc_check('export with from after to', u_adm,
    format(ex, pv2, 'now()', 'now() - interval ''1 day''', 'audit request'), 'ERROR 22023:%');
  n := n + 1; failed := failed || pg_temp.tc_check('a refused export wrote an audit row', NULL,
    format('SELECT count(*)::text FROM chat_audit_log WHERE action = ''export_channel'' AND channel_id = %L', pv2), '0');
  n := n + 1; failed := failed || pg_temp.tc_check('fixture: the admin is a member of the exported channel', NULL,
    format('SELECT count(*)::text FROM chat_channel_members WHERE channel_id = %L AND user_id = %L', pv2, u_adm), '0');
  r := pg_temp.tc_try('authenticated', u_adm, format(ex, pv2, 'NULL', 'now() + interval ''1 day''', ' audit request '));
  IF r LIKE 'ERROR%' THEN
    n := n + 1; failed := failed || ('an admin outside a private channel could not export it (' || r || ')');
  ELSE
    j := r::jsonb;
    n := n + 1; failed := failed || pg_temp.tc_ok(j->'channel' = jsonb_build_object('id', pv2, 'kind', 'private', 'name', 'Mod secret', 'topic', 'the topic'),
      'export: channel object is wrong (' || (j->'channel')::text || ')');
    n := n + 1; failed := failed || pg_temp.tc_ok((SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(j) k) = 'channel,messages,truncated'
      AND j->'truncated' = 'false'::jsonb, 'export: top-level keys or truncated are wrong');
    SELECT string_agg(id::text, ',' ORDER BY created_at, id) INTO ids FROM internal_messages WHERE channel_id = pv2;
    n := n + 1; failed := failed || pg_temp.tc_ok((SELECT string_agg(e->>'id', ',' ORDER BY o) FROM jsonb_array_elements(j->'messages') WITH ORDINALITY x(e, o)) = ids
      AND jsonb_array_length(j->'messages') = 4, 'export: messages are not every message ordered by created_at, id');
    n := n + 1; failed := failed || pg_temp.tc_ok((SELECT bool_and((SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(e) k)
        = 'attachments,author_id,author_kind,author_name,body,created_at,deleted_at,deleted_by,edited_at,erased_at,id,reply_to_id,thread_root_id')
      FROM jsonb_array_elements(j->'messages') e), 'export: message keys are wrong');
    n := n + 1; failed := failed || pg_temp.tc_ok((SELECT e->>'body' FROM jsonb_array_elements(j->'messages') e WHERE e->>'id' = m::text) = 'hello @Mod Two',
      'export: a mention is not rendered as @Name');
    n := n + 1; failed := failed || pg_temp.tc_ok((SELECT e->>'body' = '' AND e->>'deleted_by' = u_ag2::text AND e->>'deleted_at' IS NOT NULL
      FROM jsonb_array_elements(j->'messages') e WHERE e->>'id' = m2::text), 'export: a deleted message is not empty with its deleted_by');
    n := n + 1; failed := failed || pg_temp.tc_ok((SELECT e->>'thread_root_id' = m::text AND e->>'author_name' = 'Mod Two' AND e->>'author_kind' = 'user'
      AND e->>'author_id' = u_ag2::text AND e->'attachments' = '[]'::jsonb FROM jsonb_array_elements(j->'messages') e WHERE e->>'id' = m3::text),
      'export: a reply''s fields are wrong');
    n := n + 1; failed := failed || pg_temp.tc_ok((SELECT e->'attachments' FROM jsonb_array_elements(j->'messages') e WHERE e->>'id' = mv::text)
      = '[{"name":"v.ogg","mime":"audio/ogg","bytes":100,"kind":"voice","duration_ms":4200}]'::jsonb,
      'export: attachments are wrong');
  END IF;
  n := n + 1; failed := failed || pg_temp.tc_check('export_channel audit row is wrong', NULL,
    format('SELECT string_agg(actor_id || ''|'' || (detail->>''reason'') || ''|'' || (detail->>''count'') || ''|'' || (detail->>''truncated'') || ''|'' || (detail->''from'' = ''null''::jsonb) || ''|'' || ((detail->>''to'')::timestamptz > now()), '';'') FROM chat_audit_log WHERE action = ''export_channel'' AND channel_id = %L', pv2),
    u_adm || '|audit request|4|false|true|true');
  n := n + 1; failed := failed || pg_temp.tc_check('export: a range after every message is not empty', u_adm,
    format('SELECT jsonb_array_length((%s)::jsonb->''messages'')::text', format(ex, pv2, 'now() + interval ''1 day''', 'NULL', 'audit request')), '0');
  n := n + 1; failed := failed || pg_temp.tc_check('the owner could not export a DM they are not in', u_own,
    format('SELECT ((%s)::jsonb->''channel''->>''kind'')', format(ex, dm, 'NULL', 'NULL', 'dm audit')), 'dm');
  UPDATE accounts SET internal_chat_enabled = false WHERE id = a;
  n := n + 1; failed := failed || pg_temp.tc_check('export with team chat switched off failed', u_adm,
    format('SELECT ((%s)::jsonb->''channel''->>''id'')', format(ex, pv2, 'NULL', 'NULL', 'chat is off')), pv2::text);
  UPDATE accounts SET internal_chat_enabled = true WHERE id = a;

  -- ---------- D. grants ----------
  FOREACH f IN ARRAY fns LOOP
    n := n + 1; failed := failed || pg_temp.tc_ok(NOT has_function_privilege('anon', f, 'EXECUTE')
                                                 AND NOT has_function_privilege('public', f, 'EXECUTE')
                                                 AND NOT has_function_privilege('service_role', f, 'EXECUTE'),
      f || ' is executable by anon, PUBLIC or service_role');
    n := n + 1; failed := failed || pg_temp.tc_ok(has_function_privilege('authenticated', f, 'EXECUTE'),
      f || ' is not executable by authenticated');
  END LOOP;
  f := 'public.chat_assert_reason(text,text)';
  n := n + 1; failed := failed || pg_temp.tc_ok(NOT has_function_privilege('anon', f, 'EXECUTE')
                                               AND NOT has_function_privilege('public', f, 'EXECUTE')
                                               AND NOT has_function_privilege('authenticated', f, 'EXECUTE')
                                               AND NOT has_function_privilege('service_role', f, 'EXECUTE'),
    f || ' is executable by a client role');

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT160', MESSAGE = 'verify-chat-moderation rollback';
  EXCEPTION WHEN SQLSTATE 'ZT160' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'chat moderation verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'chat moderation verification passed (% checks)', n;
END
$verify$;
