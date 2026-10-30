-- Behavioural regression suite for team chat role permissions (migration 157).
--
-- A chat_role_permissions row DENIES one of 12 capabilities to a role
-- class (admin, team_leader, agent, viewer, bank_guest); owners are
-- exempt, and a bank guest can only be denied the capabilities a guest
-- has at all. No rows, no settings and 'everyone' channels change
-- nothing. The setters are the workspace's live owners and admins
-- (chat_set_permissions replaces the whole set, chat_set_workspace_settings
-- takes windows of 1..10080 minutes or NULL), and a channel's admins for
-- chat_set_channel_policy (team and private channels only; a no-op save
-- writes no audit row). Each enforcement point refuses with 42501 and a
-- stable phrase: the capability in chat_create_channel, chat_open_dm (3+
-- people, reopening included), chat_post_message (@channel/@here, files,
-- voice notes, shared conversations), chat_share_call, chat_forward_message
-- (a forwarded file needs no upload_files), chat_set_pin (both ways),
-- chat_add_members (not a new channel's initial members), chat_edit_message
-- and chat_delete_message (the author's own only); the channel's posting
-- and thread rules in posting, sharing, forwarding, typing (stopping is
-- never refused) and uploads (chat_storage_can_write: upload_files or
-- send_voice, and the caller may post at the top level or in a thread);
-- the edit and delete windows for everyone below admin. A channel admin
-- is a member with role 'admin' or a workspace owner/admin, never a bank
-- guest. The matrix is read by live staff only, the settings by any live
-- member. The four API functions are executable by authenticated only;
-- the six helpers by nobody. Migration 158 adds a key to
-- chat_my_permissions and an audit action, so neither list is asserted
-- exactly.
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
  u_own  UUID := '00000000-0000-4000-8000-000000157101';  -- owner of A
  u_adm  UUID := '00000000-0000-4000-8000-000000157102';  -- admin
  u_tl   UUID := '00000000-0000-4000-8000-000000157103';  -- team leader
  u_ag   UUID := '00000000-0000-4000-8000-000000157104';  -- agent
  u_ag2  UUID := '00000000-0000-4000-8000-000000157105';  -- agent
  u_ag3  UUID := '00000000-0000-4000-8000-000000157106';  -- agent
  u_vw   UUID := '00000000-0000-4000-8000-000000157107';  -- viewer
  u_g    UUID := '00000000-0000-4000-8000-000000157108';  -- bank guest
  u_out  UUID := '00000000-0000-4000-8000-000000157109';  -- owner of another workspace
  a      UUID;
  ch     UUID;  -- team (own): adm, tl, ag, ag2
  pv     UUID;  -- private (own): g, ag
  ct     UUID;  -- team (tl, its channel admin): ag
  dm     UUID;  -- DM ag + ag2
  dr     UUID;  -- deal room
  k      UUID;
  cv     UUID;
  cl     UUID;  -- a call ag was on
  m      UUID;
  m_own  UUID;  -- own, text in ch
  m_ag   UUID;
  m_adm  UUID;
  m_pf   UUID;  -- own, file in pv
  m_old  UUID;
  m_adm_old UUID;
  m_own_old UUID;
  pre    TEXT;  -- ch's storage prefix
  prect  TEXT;  -- ct's
  f1     TEXT;
  f2     TEXT;
  v1     TEXT;
  r      TEXT;
  j      JSONB;
  denied JSONB;
  cnt    INT;
  caps   TEXT[] := ARRAY['create_team_channel','create_private_channel','open_group_dm','mention_everyone',
    'upload_files','send_voice','pin_messages','forward_messages','share_cards','add_members','edit_own','delete_own'];
  uuidp  TEXT := '________-____-____-____-____________';
  my     TEXT := 'SELECT public.chat_my_permissions(%L)::text';
  setp   TEXT := 'SELECT public.chat_set_permissions(%L, %L::jsonb)::text';
  sets   TEXT := 'SELECT public.chat_set_workspace_settings(%L, %s, %s)::text';
  setc   TEXT := 'SELECT public.chat_set_channel_policy(%L, %L, %L, %L)::text';
  post   TEXT := 'SELECT public.chat_post_message(%L, %L)::text';
  reply  TEXT := 'SELECT public.chat_post_message(%L, %L, %L::uuid)::text';
  card   TEXT := 'SELECT public.chat_post_message(%L, %L, NULL, %L::uuid)::text';
  postf  TEXT := 'SELECT public.chat_post_message(%L, %L, p_attachments => %L::jsonb)::text';
  fwd    TEXT := 'SELECT public.chat_forward_message(%L, %L)::text';
  shcall TEXT := 'SELECT public.chat_share_call(%L, %L, %L)::text';
  pin    TEXT := 'SELECT public.chat_set_pin(%L, %s)::text';
  addm   TEXT := 'SELECT public.chat_add_members(%L, %L::uuid[])::text';
  mk     TEXT := 'SELECT public.chat_create_channel(%L, %L, %L, NULL, %L::uuid[])::text';
  opdm   TEXT := 'SELECT public.chat_open_dm(%L, %L::uuid[])::text';
  edit   TEXT := 'SELECT public.chat_edit_message(%L, %L)::text';
  del    TEXT := 'SELECT public.chat_delete_message(%L)::text';
  typing TEXT := 'SELECT public.chat_set_typing(%L, %L::uuid, %s)::text';
  upl    TEXT := 'INSERT INTO storage.objects (bucket_id, name, owner) VALUES (%L, %L, %L) RETURNING %L';
  api_fns TEXT[] := ARRAY[
    'public.chat_set_permissions(uuid,jsonb)',
    'public.chat_set_workspace_settings(uuid,integer,integer)',
    'public.chat_set_channel_policy(uuid,text,text,text)',
    'public.chat_my_permissions(uuid)'];
  internal_fns TEXT[] := ARRAY[
    'public.chat_role_class(uuid,uuid)',
    'public.chat_has_permission(uuid,uuid,text)',
    'public.chat_assert_permission(uuid,text)',
    'public.chat_is_channel_admin(uuid,uuid,uuid)',
    'public.chat_assert_post_rules(public.chat_channels,uuid)',
    'public.chat_assert_window(public.internal_messages,text)'];
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
  -- An attachment list of one file or one voice note at p_path.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.tc_att(p_path text, p_kind text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT CASE p_kind WHEN 'voice'
        THEN jsonb_build_array(jsonb_build_object('storage_path', p_path, 'name', 'v.ogg', 'mime', 'audio/ogg',
               'bytes', 10, 'kind', 'voice', 'duration_ms', 900))
        ELSE jsonb_build_array(jsonb_build_object('storage_path', p_path, 'name', 'd.pdf',
               'mime', 'application/pdf', 'bytes', 10)) END::text
    $body$
  $fn$;
  -- An already-uploaded chat-files object under a prefix: its path.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.tc_up(p_prefix text, p_name text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := p_prefix || gen_random_uuid() || '-' || p_name;
    BEGIN
      INSERT INTO storage.objects (bucket_id, name) VALUES ('chat-files', v);
      RETURN v;
    END $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_own, 'ci-tc157-own@example.invalid'), (u_adm, 'ci-tc157-adm@example.invalid'),
    (u_tl, 'ci-tc157-tl@example.invalid'), (u_ag, 'ci-tc157-ag@example.invalid'),
    (u_ag2, 'ci-tc157-ag2@example.invalid'), (u_ag3, 'ci-tc157-ag3@example.invalid'),
    (u_vw, 'ci-tc157-vw@example.invalid'), (u_g, 'ci-tc157-g@example.invalid'),
    (u_out, 'ci-tc157-out@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a FROM profiles WHERE user_id = u_own;
  IF a IS NULL OR NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = u_out) THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE accounts SET internal_chat_enabled = true WHERE id = a;
  UPDATE profiles SET account_id = a, account_role = 'admin' WHERE user_id = u_adm;
  UPDATE profiles SET account_id = a, account_role = 'team_leader' WHERE user_id = u_tl;
  UPDATE profiles SET account_id = a, account_role = 'agent' WHERE user_id IN (u_ag, u_ag2, u_ag3);
  UPDATE profiles SET account_id = a, account_role = 'viewer' WHERE user_id = u_vw;
  INSERT INTO case_banks (account_id, code, name) VALUES (a, 'ADCB', 'ADCB Bank') ON CONFLICT DO NOTHING;
  UPDATE profiles SET account_id = a, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_g;

  ch := pg_temp.tc_try('authenticated', u_own, format(mk, a, 'team', 'TC157 team', ARRAY[u_adm, u_tl, u_ag, u_ag2]));
  pv := pg_temp.tc_try('authenticated', u_own, format(mk, a, 'private', 'TC157 private', ARRAY[u_g, u_ag]));
  ct := pg_temp.tc_try('authenticated', u_tl, format(mk, a, 'team', 'TC157 leader team', ARRAY[u_ag]));
  dm := pg_temp.tc_try('authenticated', u_ag, format(opdm, a, ARRAY[u_ag2]));
  INSERT INTO chat_channels (account_id, kind, name, created_by) VALUES (a, 'deal_room', 'TC157 deal', u_own) RETURNING id INTO dr;
  INSERT INTO chat_channel_members (channel_id, user_id, role) VALUES (dr, u_own, 'admin');
  pre := 'account-' || a || '/channel-' || ch || '/';
  prect := 'account-' || a || '/channel-' || ct || '/';
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a, u_own, '971500157101', 'TC157 customer') RETURNING id INTO k;
  INSERT INTO conversations (account_id, contact_id, user_id) VALUES (a, k, u_own) RETURNING id INTO cv;
  INSERT INTO calls (account_id, pbx_call_id, direction, remote_number, user_id, contact_id, status)
  VALUES (a, 'tc157-call-1', 'inbound', '971500157101', u_ag, k, 'answered') RETURNING id INTO cl;
  m_own := pg_temp.tc_try('authenticated', u_own, format(post, ch, 'owner text'));
  f1 := pg_temp.tc_up('account-' || a || '/channel-' || pv || '/', 'p.pdf');
  m_pf := pg_temp.tc_try('authenticated', u_own, format(postf, pv, 'owner file', pg_temp.tc_att(f1, 'file')));

  -- ---------- A. defaults: chat_my_permissions ----------
  j := pg_temp.tc_try('authenticated', u_ag, format(my, a))::jsonb;
  n := n + 1; failed := failed || pg_temp.tc_ok(j->>'role_class' = 'agent', 'agent role_class (' || j::text || ')');
  n := n + 1; failed := failed || pg_temp.tc_ok(
    (SELECT count(*) FILTER (WHERE j->'capabilities'->>c = 'true') FROM unnest(caps) c) = 12
    AND (SELECT count(*) FROM jsonb_object_keys(j->'capabilities')) = 12,
    'agent defaults: not 12 capabilities all true (' || j::text || ')');
  n := n + 1; failed := failed || pg_temp.tc_ok(j ? 'edit_window_minutes' AND j ? 'delete_window_minutes'
    AND jsonb_typeof(j->'edit_window_minutes') = 'null' AND jsonb_typeof(j->'delete_window_minutes') = 'null'
    AND j->>'windows_apply' = 'true', 'agent defaults: windows not null/null/apply (' || j::text || ')');
  j := pg_temp.tc_try('authenticated', u_own, format(my, a))::jsonb;
  n := n + 1; failed := failed || pg_temp.tc_ok((j->>'role_class') || (j->>'windows_apply') = 'ownerfalse', 'owner class/windows (' || j::text || ')');
  j := pg_temp.tc_try('authenticated', u_adm, format(my, a))::jsonb;
  n := n + 1; failed := failed || pg_temp.tc_ok((j->>'role_class') || (j->>'windows_apply') = 'adminfalse', 'admin class/windows (' || j::text || ')');
  j := pg_temp.tc_try('authenticated', u_tl, format(my, a))::jsonb;
  n := n + 1; failed := failed || pg_temp.tc_ok((j->>'role_class') || (j->>'windows_apply') = 'team_leadertrue', 'team leader class/windows (' || j::text || ')');
  j := pg_temp.tc_try('authenticated', u_vw, format(my, a))::jsonb;
  n := n + 1; failed := failed || pg_temp.tc_ok(j->>'role_class' = 'viewer', 'viewer class (' || j::text || ')');
  j := pg_temp.tc_try('authenticated', u_g, format(my, a))::jsonb;
  n := n + 1; failed := failed || pg_temp.tc_ok(j->>'role_class' = 'bank_guest'
    AND (j->'capabilities'->>'add_members') || (j->'capabilities'->>'share_cards') || (j->'capabilities'->>'open_group_dm')
        || (j->'capabilities'->>'create_team_channel') || (j->'capabilities'->>'upload_files') || (j->'capabilities'->>'pin_messages')
      = 'falsefalsefalsefalsetruetrue', 'guest capabilities (' || j::text || ')');
  n := n + 1; failed := failed || pg_temp.tc_check('my_permissions without a live profile', u_out, format(my, a), 'ERROR P0002:%');

  -- ---------- B. defaults: an agent may do everything ----------
  n := n + 1; failed := failed || pg_temp.tc_check('default: agent creates a team channel', u_ag, format(mk, a, 'team', 'TC157 ag team', ARRAY[u_ag3]), uuidp);
  n := n + 1; failed := failed || pg_temp.tc_check('default: agent creates a private channel', u_ag, format(mk, a, 'private', 'TC157 ag priv', '{}'), uuidp);
  n := n + 1; failed := failed || pg_temp.tc_check('default: agent opens a group DM', u_ag, format(opdm, a, ARRAY[u_ag2, u_ag3]), uuidp);
  n := n + 1; failed := failed || pg_temp.tc_check('default: agent @channel', u_ag, format(post, ch, '@channel hello'), uuidp);
  n := n + 1; failed := failed || pg_temp.tc_check('default: agent storage write', u_ag, format(upl, 'chat-files', pre || gen_random_uuid() || '-a.pdf', u_ag, 'ins'), 'ins');
  f2 := pg_temp.tc_up(pre, 'a.pdf');
  n := n + 1; failed := failed || pg_temp.tc_check('default: agent posts a file', u_ag, format(postf, ch, 'file', pg_temp.tc_att(f2, 'file')), uuidp);
  v1 := pg_temp.tc_up(pre, 'v.ogg');
  n := n + 1; failed := failed || pg_temp.tc_check('default: agent posts a voice note', u_ag, format(postf, ch, 'voice', pg_temp.tc_att(v1, 'voice')), uuidp);
  n := n + 1; failed := failed || pg_temp.tc_check('default: agent pins', u_ag, format(pin, m_own, 'true'), 'ok');
  n := n + 1; failed := failed || pg_temp.tc_check('default: agent unpins', u_ag, format(pin, m_own, 'false'), 'ok');
  n := n + 1; failed := failed || pg_temp.tc_check('default: agent forwards', u_ag, format(fwd, m_own, dm), uuidp);
  n := n + 1; failed := failed || pg_temp.tc_check('default: agent adds members', u_ag, format(addm, ct, ARRAY[u_ag3]), '1');
  n := n + 1; failed := failed || pg_temp.tc_check('default: agent shares a call', u_ag, format(shcall, ch, cl, 'a call'), uuidp);
  n := n + 1; failed := failed || pg_temp.tc_check('default: admin shares a conversation card', u_adm, format(card, ch, 'card', cv), uuidp);
  n := n + 1; failed := failed || pg_temp.tc_check('default: agent typing', u_ag, format(typing, ch, NULL, 'true'), 'ok');
  m := pg_temp.tc_try('authenticated', u_ag, format(post, ch, 'mine'));
  n := n + 1; failed := failed || pg_temp.tc_check('default: agent edits own', u_ag, format(edit, m, 'mine!'), 'ok');
  n := n + 1; failed := failed || pg_temp.tc_check('default: agent deletes own', u_ag, format(del, m), '{}');

  -- ---------- C. setters: who, and validation ----------
  n := n + 1; failed := failed || pg_temp.tc_check('set_permissions by agent', u_ag, format(setp, a, '[]'), 'ERROR 42501:%');
  n := n + 1; failed := failed || pg_temp.tc_check('set_permissions by team leader', u_tl, format(setp, a, '[]'), 'ERROR 42501:%');
  n := n + 1; failed := failed || pg_temp.tc_check('set_permissions by guest', u_g, format(setp, a, '[]'), 'ERROR 42501:%');
  n := n + 1; failed := failed || pg_temp.tc_check('set_workspace_settings by agent', u_ag, format(sets, a, 5, 5), 'ERROR 42501:%');
  n := n + 1; failed := failed || pg_temp.tc_check('set_workspace_settings by team leader', u_tl, format(sets, a, 5, 5), 'ERROR 42501:%');
  n := n + 1; failed := failed || pg_temp.tc_check('set_workspace_settings by guest', u_g, format(sets, a, 5, 5), 'ERROR 42501:%');
  n := n + 1; failed := failed || pg_temp.tc_check('set_channel_policy by plain member', u_ag, format(setc, ch, 'admins', NULL, NULL), 'ERROR 42501:%');
  n := n + 1; failed := failed || pg_temp.tc_check('set_channel_policy by guest', u_g, format(setc, pv, 'admins', NULL, NULL), 'ERROR 42501:%');
  n := n + 1; failed := failed || pg_temp.tc_check('guest-impossible pair', u_own, format(setp, a, '[{"role_class":"bank_guest","capability":"add_members"}]'), 'ERROR 22023:%');
  n := n + 1; failed := failed || pg_temp.tc_check('owner class', u_own, format(setp, a, '[{"role_class":"owner","capability":"upload_files"}]'), 'ERROR 22023:%');
  n := n + 1; failed := failed || pg_temp.tc_check('unknown capability', u_own, format(setp, a, '[{"role_class":"agent","capability":"fly"}]'), 'ERROR 22023:%');
  n := n + 1; failed := failed || pg_temp.tc_check('unknown role class', u_own, format(setp, a, '[{"role_class":"intern","capability":"upload_files"}]'), 'ERROR 22023:%');
  n := n + 1; failed := failed || pg_temp.tc_check('window 10081', u_adm, format(sets, a, 10081, 'NULL'), 'ERROR 22023:%');
  n := n + 1; failed := failed || pg_temp.tc_check('window 0', u_adm, format(sets, a, 'NULL', 0), 'ERROR 22023:%');
  n := n + 1; failed := failed || pg_temp.tc_check('window 10080 by admin', u_adm, format(sets, a, 10080, 'NULL'), 'ok');
  n := n + 1; failed := failed || pg_temp.tc_check('policy on a DM', u_ag, format(setc, dm, 'admins', NULL, NULL), 'ERROR 22023:%');
  n := n + 1; failed := failed || pg_temp.tc_check('policy on a deal room', u_own, format(setc, dr, 'admins', NULL, NULL), 'ERROR 22023:%');
  n := n + 1; failed := failed || pg_temp.tc_check('bad policy value', u_tl, format(setc, ct, 'admins', 'bogus', NULL), 'ERROR 22023:%');

  -- ---------- D. the denied matrix ----------
  SELECT jsonb_agg(jsonb_build_object('role_class', 'agent', 'capability', c)) INTO denied FROM unnest(caps) c;
  denied := denied || '[{"role_class":"agent","capability":"edit_own"},
     {"role_class":"admin","capability":"share_cards"},{"role_class":"admin","capability":"edit_own"},
     {"role_class":"admin","capability":"delete_own"},{"role_class":"admin","capability":"add_members"},
     {"role_class":"viewer","capability":"pin_messages"},
     {"role_class":"bank_guest","capability":"upload_files"},{"role_class":"bank_guest","capability":"send_voice"}]'::jsonb;
  r := pg_temp.tc_try('authenticated', u_adm, format(setp, a, denied));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = 'ok', 'admin saves the matrix (' || r || ')');
  SELECT count(*) INTO cnt FROM chat_role_permissions WHERE account_id = a;
  n := n + 1; failed := failed || pg_temp.tc_ok(cnt = 19, 'matrix rows not 19, de-duplicated (' || cnt || ')');
  n := n + 1; failed := failed || pg_temp.tc_ok((SELECT jsonb_array_length(detail->'denied') FROM chat_audit_log
    WHERE account_id = a AND action = 'set_permissions' ORDER BY at DESC LIMIT 1) = 19, 'set_permissions not audited');
  -- reads
  n := n + 1; failed := failed || pg_temp.tc_check('agent reads the matrix', u_ag, format('SELECT count(*)::text FROM public.chat_role_permissions WHERE account_id = %L', a), '19');
  n := n + 1; failed := failed || pg_temp.tc_check('viewer reads the matrix', u_vw, format('SELECT count(*)::text FROM public.chat_role_permissions WHERE account_id = %L', a), '19');
  n := n + 1; failed := failed || pg_temp.tc_check('guest reads no matrix', u_g, format('SELECT count(*)::text FROM public.chat_role_permissions WHERE account_id = %L', a), '0');
  n := n + 1; failed := failed || pg_temp.tc_check('outsider reads no matrix', u_out, format('SELECT count(*)::text FROM public.chat_role_permissions WHERE account_id = %L', a), '0');
  j := pg_temp.tc_try('authenticated', u_ag, format(my, a))::jsonb;
  n := n + 1; failed := failed || pg_temp.tc_ok((SELECT count(*) FILTER (WHERE j->'capabilities'->>c = 'false') FROM unnest(caps) c) = 12,
    'agent capabilities not all false (' || j::text || ')');
  j := pg_temp.tc_try('authenticated', u_vw, format(my, a))::jsonb;
  n := n + 1; failed := failed || pg_temp.tc_ok(j->'capabilities'->>'pin_messages' = 'false', 'viewer pin_messages not false');
  j := pg_temp.tc_try('authenticated', u_tl, format(my, a))::jsonb;
  n := n + 1; failed := failed || pg_temp.tc_ok((SELECT count(*) FILTER (WHERE j->'capabilities'->>c = 'true') FROM unnest(caps) c) = 12,
    'team leader caught a viewer or agent row (' || j::text || ')');
  -- create_team_channel / create_private_channel
  n := n + 1; failed := failed || pg_temp.tc_check('agent creates a team channel', u_ag, format(mk, a, 'team', 'x', '{}'), 'ERROR 42501: chat: your role may not%');
  n := n + 1; failed := failed || pg_temp.tc_check('agent creates a private channel', u_ag, format(mk, a, 'private', 'x', '{}'), 'ERROR 42501: chat: your role may not%');
  n := n + 1; failed := failed || pg_temp.tc_check('team leader creates a private channel', u_tl, format(mk, a, 'private', 'TC157 tl priv', '{}'), uuidp);
  -- add_members (initial members are not an add)
  n := n + 1; failed := failed || pg_temp.tc_check('admin creates with initial members (add_members denied)', u_adm, format(mk, a, 'team', 'TC157 adm team', ARRAY[u_ag3]), uuidp);
  n := n + 1; failed := failed || pg_temp.tc_check('admin adds members', u_adm, format(addm, ch, ARRAY[u_ag3]), 'ERROR 42501: chat: your role may not%');
  n := n + 1; failed := failed || pg_temp.tc_check('agent adds members', u_ag, format(addm, ct, ARRAY[u_ag2]), 'ERROR 42501: chat: your role may not%');
  n := n + 1; failed := failed || pg_temp.tc_check('team leader adds members', u_tl, format(addm, ct, ARRAY[u_ag2]), '1');
  -- open_group_dm
  n := n + 1; failed := failed || pg_temp.tc_check('agent opens a group DM', u_ag, format(opdm, a, ARRAY[u_ag2, u_tl]), 'ERROR 42501: chat: your role may not%');
  n := n + 1; failed := failed || pg_temp.tc_check('agent reopens a group DM', u_ag, format(opdm, a, ARRAY[u_ag2, u_ag3]), 'ERROR 42501: chat: your role may not%');
  n := n + 1; failed := failed || pg_temp.tc_check('agent opens a 1:1 DM', u_ag, format(opdm, a, ARRAY[u_ag3]), uuidp);
  n := n + 1; failed := failed || pg_temp.tc_check('team leader opens a group DM', u_tl, format(opdm, a, ARRAY[u_ag, u_ag2]), uuidp);
  -- mention_everyone
  n := n + 1; failed := failed || pg_temp.tc_check('agent @channel', u_ag, format(post, ch, 'hey @channel'), 'ERROR 42501: chat: your role may not%');
  n := n + 1; failed := failed || pg_temp.tc_check('agent @here', u_ag, format(post, ch, '@here now'), 'ERROR 42501: chat: your role may not%');
  m_ag := pg_temp.tc_try('authenticated', u_ag, format(post, ch, 'mail x@here.com'));
  n := n + 1; failed := failed || pg_temp.tc_ok(m_ag::text LIKE uuidp, 'agent plain post (an email is not @here) (' || m_ag || ')');
  n := n + 1; failed := failed || pg_temp.tc_check('team leader @here', u_tl, format(post, ch, '@here standup'), uuidp);
  -- upload_files / send_voice, and the storage write
  n := n + 1; failed := failed || pg_temp.tc_check('agent storage write (both denied)', u_ag, format(upl, 'chat-files', pre || gen_random_uuid() || '-b.pdf', u_ag, 'ins'), 'ERROR%');
  n := n + 1; failed := failed || pg_temp.tc_check('team leader storage write', u_tl, format(upl, 'chat-files', pre || gen_random_uuid() || '-b.pdf', u_tl, 'ins'), 'ins');
  f2 := pg_temp.tc_up(pre, 'b.pdf');
  v1 := pg_temp.tc_up(pre, 'w.ogg');
  n := n + 1; failed := failed || pg_temp.tc_check('agent posts a file', u_ag, format(postf, ch, 'file', pg_temp.tc_att(f2, 'file')), 'ERROR 42501: chat: your role may not%');
  n := n + 1; failed := failed || pg_temp.tc_check('agent posts a voice note', u_ag, format(postf, ch, 'voice', pg_temp.tc_att(v1, 'voice')), 'ERROR 42501: chat: your role may not%');
  n := n + 1; failed := failed || pg_temp.tc_check('guest posts a file', u_g, format(postf, pv, 'g', pg_temp.tc_att(f2, 'file')), 'ERROR 42501: chat: your role may not%');
  n := n + 1; failed := failed || pg_temp.tc_check('team leader posts a file', u_tl, format(postf, ch, 'file', pg_temp.tc_att(f2, 'file')), uuidp);
  n := n + 1; failed := failed || pg_temp.tc_check('team leader posts a voice note', u_tl, format(postf, ch, 'voice', pg_temp.tc_att(v1, 'voice')), uuidp);
  n := n + 1; failed := failed || pg_temp.tc_check('guest posts text', u_g, format(post, pv, 'guest text'), uuidp);
  -- pin_messages
  n := n + 1; failed := failed || pg_temp.tc_check('agent pins', u_ag, format(pin, m_own, 'true'), 'ERROR 42501: chat: your role may not%');
  n := n + 1; failed := failed || pg_temp.tc_check('team leader pins', u_tl, format(pin, m_own, 'true'), 'ok');
  n := n + 1; failed := failed || pg_temp.tc_check('agent unpins', u_ag, format(pin, m_own, 'false'), 'ERROR 42501: chat: your role may not%');
  -- forward_messages (a forwarded file is not an upload)
  n := n + 1; failed := failed || pg_temp.tc_check('agent forwards', u_ag, format(fwd, m_own, dm), 'ERROR 42501: chat: your role may not%');
  n := n + 1; failed := failed || pg_temp.tc_check('team leader forwards', u_tl, format(fwd, m_own, ct), uuidp);
  n := n + 1; failed := failed || pg_temp.tc_check('guest forwards a file (upload_files denied)', u_g, format(fwd, m_pf, pv), uuidp);
  -- share_cards
  n := n + 1; failed := failed || pg_temp.tc_check('admin shares a card', u_adm, format(card, ch, 'card', cv), 'ERROR 42501: chat: your role may not%');
  n := n + 1; failed := failed || pg_temp.tc_check('owner shares a card (exempt)', u_own, format(card, ch, 'card', cv), uuidp);
  n := n + 1; failed := failed || pg_temp.tc_check('agent shares a call', u_ag, format(shcall, ch, cl, 'a call'), 'ERROR 42501: chat: your role may not%');
  n := n + 1; failed := failed || pg_temp.tc_check('owner shares a call (exempt)', u_own, format(shcall, ch, cl, 'a call'), uuidp);
  -- edit_own / delete_own
  m_adm := pg_temp.tc_try('authenticated', u_adm, format(post, ch, 'admin text'));
  n := n + 1; failed := failed || pg_temp.tc_check('agent edits own', u_ag, format(edit, m_ag, 'edited'), 'ERROR 42501: chat: your role may not%');
  n := n + 1; failed := failed || pg_temp.tc_check('admin edits own (edit_own denied)', u_adm, format(edit, m_adm, 'edited'), 'ERROR 42501: chat: your role may not%');
  n := n + 1; failed := failed || pg_temp.tc_check('team leader edits own', u_tl, format(edit,
    pg_temp.tc_try('authenticated', u_tl, format(post, ch, 'tl text')), 'tl edited'), 'ok');
  n := n + 1; failed := failed || pg_temp.tc_check('agent deletes own', u_ag, format(del, m_ag), 'ERROR 42501: chat: your role may not%');
  n := n + 1; failed := failed || pg_temp.tc_check('admin deletes own (delete_own denied)', u_adm, format(del, m_adm), 'ERROR 42501: chat: your role may not%');
  n := n + 1; failed := failed || pg_temp.tc_check('admin deletes the agent''s message (delete_own denied)', u_adm, format('SELECT public.chat_delete_message(%L, %L)::text', m_ag, 'moderation test'), '{}');
  -- owners are exempt
  n := n + 1; failed := failed || pg_temp.tc_check('owner @channel', u_own, format(post, ch, '@channel owner'), uuidp);
  n := n + 1; failed := failed || pg_temp.tc_check('owner creates a team channel', u_own, format(mk, a, 'team', 'TC157 own 2', '{}'), uuidp);
  n := n + 1; failed := failed || pg_temp.tc_check('owner edits own', u_own, format(edit, m_own, 'owner edited'), 'ok');

  -- ---------- E. the set is replaced; send_voice alone allows an upload ----------
  r := pg_temp.tc_try('authenticated', u_own, format(setp, a, '[{"role_class":"agent","capability":"upload_files"}]'));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = 'ok', 'owner saves a smaller set (' || r || ')');
  SELECT count(*) INTO cnt FROM chat_role_permissions WHERE account_id = a;
  n := n + 1; failed := failed || pg_temp.tc_ok(cnt = 1, 'set not replaced (' || cnt || ' rows)');
  n := n + 1; failed := failed || pg_temp.tc_check('agent storage write (send_voice only)', u_ag, format(upl, 'chat-files', pre || gen_random_uuid() || '-c.ogg', u_ag, 'ins'), 'ins');
  n := n + 1; failed := failed || pg_temp.tc_check('agent posts a file (upload_files denied)', u_ag, format(postf, ch, 'file', pg_temp.tc_att(pg_temp.tc_up(pre, 'c.pdf'), 'file')), 'ERROR 42501: chat: your role may not%');
  n := n + 1; failed := failed || pg_temp.tc_check('agent posts a voice note (send_voice allowed)', u_ag, format(postf, ch, 'voice', pg_temp.tc_att(pg_temp.tc_up(pre, 'c.ogg'), 'voice')), uuidp);
  r := pg_temp.tc_try('authenticated', u_own, format(setp, a, '[]'));
  SELECT count(*) INTO cnt FROM chat_role_permissions WHERE account_id = a;
  n := n + 1; failed := failed || pg_temp.tc_ok(cnt = 0, 'matrix not cleared (' || r || ')');

  -- ---------- F. edit / delete windows ----------
  r := pg_temp.tc_try('authenticated', u_adm, format(sets, a, 5, 5));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = 'ok', 'admin sets windows (' || r || ')');
  -- Every audit row of this transaction has the same `at`: match by content.
  n := n + 1; failed := failed || pg_temp.tc_ok((SELECT bool_or((detail->'new'->>'edit_window_minutes') || '/' || (detail->'old'->>'edit_window_minutes') = '5/10080')
    FROM chat_audit_log WHERE account_id = a AND action = 'update_settings'), 'update_settings not audited');
  j := pg_temp.tc_try('authenticated', u_ag, format(my, a))::jsonb;
  n := n + 1; failed := failed || pg_temp.tc_ok((j->>'edit_window_minutes') || '/' || (j->>'delete_window_minutes') = '5/5', 'my_permissions windows (' || j::text || ')');
  n := n + 1; failed := failed || pg_temp.tc_check('guest reads settings', u_g, format('SELECT edit_window_minutes::text FROM public.chat_workspace_settings WHERE account_id = %L', a), '5');
  n := n + 1; failed := failed || pg_temp.tc_check('outsider reads no settings', u_out, format('SELECT count(*)::text FROM public.chat_workspace_settings WHERE account_id = %L', a), '0');
  INSERT INTO internal_messages (channel_id, account_id, author_kind, author_id, body, created_at)
  VALUES (ch, a, 'user', u_ag, 'old agent', now() - interval '10 minutes') RETURNING id INTO m_old;
  INSERT INTO internal_messages (channel_id, account_id, author_kind, author_id, body, created_at)
  VALUES (ch, a, 'user', u_adm, 'old admin', now() - interval '10 minutes') RETURNING id INTO m_adm_old;
  INSERT INTO internal_messages (channel_id, account_id, author_kind, author_id, body, created_at)
  VALUES (ch, a, 'user', u_own, 'old owner', now() - interval '10 minutes') RETURNING id INTO m_own_old;
  n := n + 1; failed := failed || pg_temp.tc_check('agent late edit', u_ag, format(edit, m_old, 'late'), 'ERROR 42501: chat: the edit window has passed%');
  n := n + 1; failed := failed || pg_temp.tc_check('agent late delete', u_ag, format(del, m_old), 'ERROR 42501: chat: the delete window has passed%');
  m := pg_temp.tc_try('authenticated', u_ag, format(post, ch, 'fresh'));
  n := n + 1; failed := failed || pg_temp.tc_check('agent edit in window', u_ag, format(edit, m, 'fresh!'), 'ok');
  n := n + 1; failed := failed || pg_temp.tc_check('agent delete in window', u_ag, format(del, m), '{}');
  n := n + 1; failed := failed || pg_temp.tc_check('admin late edit (exempt)', u_adm, format(edit, m_adm_old, 'late ok'), 'ok');
  n := n + 1; failed := failed || pg_temp.tc_check('owner late edit (exempt)', u_own, format(edit, m_own_old, 'late ok'), 'ok');
  n := n + 1; failed := failed || pg_temp.tc_check('admin late delete own (exempt)', u_adm, format(del, m_adm_old), '{}');
  r := pg_temp.tc_try('authenticated', u_own, format(sets, a, 'NULL', 'NULL'));
  n := n + 1; failed := failed || pg_temp.tc_ok((SELECT edit_window_minutes IS NULL AND delete_window_minutes IS NULL
    FROM chat_workspace_settings WHERE account_id = a), 'windows not cleared (' || r || ')');
  n := n + 1; failed := failed || pg_temp.tc_check('agent late edit, no window', u_ag, format(edit, m_old, 'late now ok'), 'ok');

  -- ---------- G. channel rules (ct: tl its channel admin, ag a member) ----------
  r := pg_temp.tc_try('authenticated', u_tl, format(setc, ct, 'admins', 'admins', NULL));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = 'ok', 'channel admin sets policy (' || r || ')');
  n := n + 1; failed := failed || pg_temp.tc_ok((SELECT (detail->'old'->>'posting') || '>' || (detail->'new'->>'posting') || '/' || (detail->'new'->>'mention_everyone')
    FROM chat_audit_log WHERE channel_id = ct AND action = 'update_policy' ORDER BY at DESC LIMIT 1) = 'everyone>admins/everyone', 'update_policy not audited');
  SELECT count(*) INTO cnt FROM chat_audit_log WHERE channel_id = ct AND action = 'update_policy';
  r := pg_temp.tc_try('authenticated', u_tl, format(setc, ct, 'admins', NULL, NULL));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = 'ok' AND (SELECT count(*) FROM chat_audit_log WHERE channel_id = ct AND action = 'update_policy') = cnt,
    'a no-op policy save wrote an audit row (' || r || ')');
  n := n + 1; failed := failed || pg_temp.tc_ok((SELECT posting || thread_replies || mention_everyone FROM chat_channels WHERE id = ct) = 'adminsadminseveryone',
    'NULL did not keep the policy');
  n := n + 1; failed := failed || pg_temp.tc_check('member posts (admins only)', u_ag, format(post, ct, 'agent top'), 'ERROR 42501: chat: only channel admins can post here%');
  m := pg_temp.tc_try('authenticated', u_tl, format(post, ct, 'leader top'));
  n := n + 1; failed := failed || pg_temp.tc_ok(m::text LIKE uuidp, 'channel admin posts (' || m || ')');
  n := n + 1; failed := failed || pg_temp.tc_check('workspace admin posts (not a member role admin)', u_adm, format(post, ct, 'admin top'), uuidp);
  n := n + 1; failed := failed || pg_temp.tc_check('member replies (admins only)', u_ag, format(reply, ct, 'agent reply', m), 'ERROR 42501: chat: only channel admins can reply in threads here%');
  n := n + 1; failed := failed || pg_temp.tc_check('channel admin replies', u_tl, format(reply, ct, 'leader reply', m), uuidp);
  n := n + 1; failed := failed || pg_temp.tc_check('member typing (admins only)', u_ag, format(typing, ct, NULL, 'true'), 'ERROR 42501: chat: only channel admins can post here%');
  n := n + 1; failed := failed || pg_temp.tc_check('member thread typing (admins only)', u_ag, format(typing, ct, m, 'true'), 'ERROR 42501: chat: only channel admins can reply in threads here%');
  n := n + 1; failed := failed || pg_temp.tc_check('member stops typing (never refused)', u_ag, format(typing, ct, NULL, 'false'), 'ok');
  n := n + 1; failed := failed || pg_temp.tc_check('channel admin typing', u_tl, format(typing, ct, NULL, 'true'), 'ok');
  n := n + 1; failed := failed || pg_temp.tc_check('member forwards into admins-only', u_ag, format(fwd, m_own, ct), 'ERROR 42501: chat: only channel admins can post here%');
  n := n + 1; failed := failed || pg_temp.tc_check('member forwards out of it', u_ag, format(fwd, m, dm), uuidp);
  n := n + 1; failed := failed || pg_temp.tc_check('member shares a call into admins-only', u_ag, format(shcall, ct, cl, 'a call'), 'ERROR 42501: chat: only channel admins can post here%');
  n := n + 1; failed := failed || pg_temp.tc_check('member storage write (posting and threads admins)', u_ag, format(upl, 'chat-files', prect || gen_random_uuid() || '-x.pdf', u_ag, 'ins'), 'ERROR%');
  n := n + 1; failed := failed || pg_temp.tc_check('channel admin storage write', u_tl, format(upl, 'chat-files', prect || gen_random_uuid() || '-x.pdf', u_tl, 'ins'), 'ins');
  r := pg_temp.tc_try('authenticated', u_tl, format(setc, ct, NULL, 'everyone', NULL));
  n := n + 1; failed := failed || pg_temp.tc_check('member storage write (threads open)', u_ag, format(upl, 'chat-files', prect || gen_random_uuid() || '-y.pdf', u_ag, 'ins'), 'ins');
  n := n + 1; failed := failed || pg_temp.tc_check('member replies (threads open)', u_ag, format(reply, ct, 'agent reply', m), uuidp);
  -- top level open, @channel for admins only
  r := pg_temp.tc_try('authenticated', u_tl, format(setc, ct, 'everyone', NULL, 'admins'));
  n := n + 1; failed := failed || pg_temp.tc_check('member posts after reopening', u_ag, format(post, ct, 'agent top'), uuidp);
  n := n + 1; failed := failed || pg_temp.tc_check('member @channel (admins only)', u_ag, format(post, ct, '@channel look'), 'ERROR 42501: chat: you may not notify everyone%');
  n := n + 1; failed := failed || pg_temp.tc_check('channel admin @channel', u_tl, format(post, ct, '@channel look'), uuidp);
  -- a bank guest with member role 'admin' is no channel admin
  r := pg_temp.tc_try('authenticated', u_own, format(setc, pv, 'admins', NULL, NULL));
  UPDATE chat_channel_members SET role = 'admin' WHERE channel_id = pv AND user_id = u_g;
  n := n + 1; failed := failed || pg_temp.tc_check('guest with member role admin posts (admins only)', u_g, format(post, pv, 'guest top'), 'ERROR 42501: chat: only channel admins can post here%');
  n := n + 1; failed := failed || pg_temp.tc_check('owner posts in private (admins only)', u_own, format(post, pv, 'owner top'), uuidp);
  -- DMs keep 'everyone'
  BEGIN
    UPDATE chat_channels SET posting = 'admins' WHERE id = dm;
    n := n + 1; failed := failed || 'a DM accepted posting = admins'::text;
  EXCEPTION WHEN check_violation THEN
    n := n + 1;
  END;

  -- ---------- H. grants ----------
  FOREACH f IN ARRAY api_fns LOOP
    n := n + 1; failed := failed || pg_temp.tc_ok(has_function_privilege('authenticated', f, 'EXECUTE'),
      f || ' is not executable by authenticated');
    n := n + 1; failed := failed || pg_temp.tc_ok(NOT has_function_privilege('anon', f, 'EXECUTE')
      AND NOT has_function_privilege('public', f, 'EXECUTE') AND NOT has_function_privilege('service_role', f, 'EXECUTE'),
      f || ' is executable by anon, PUBLIC or service_role');
  END LOOP;
  FOREACH f IN ARRAY internal_fns LOOP
    n := n + 1; failed := failed || pg_temp.tc_ok(NOT has_function_privilege('authenticated', f, 'EXECUTE')
      AND NOT has_function_privilege('anon', f, 'EXECUTE') AND NOT has_function_privilege('public', f, 'EXECUTE')
      AND NOT has_function_privilege('service_role', f, 'EXECUTE'),
      f || ' is executable by someone');
  END LOOP;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT157', MESSAGE = 'verify-chat-permissions rollback';
  EXCEPTION WHEN SQLSTATE 'ZT157' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'chat permissions verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'chat permissions verification passed (% checks)', n;
END
$verify$;
