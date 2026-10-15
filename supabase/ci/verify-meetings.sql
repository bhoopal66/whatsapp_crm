-- Behavioural regression suite for video meetings (migration 106).
--
-- Who sees a meeting is meeting_can_view: a live, non-guest member
-- active in the meeting's workspace who is owner/admin, the host, an
-- invitee, or anyone there when the meeting is open_to_workspace. Who
-- manages it (edits, invites, ends) is meeting_can_manage: owner/admin
-- or the host. This asserts those rules for every kind of reader (a
-- bank guest, a deactivated member and another workspace see nothing),
-- that the meetings policy accepts INSERT … RETURNING, that
-- meetings_guard holds for every writer (workspace and host frozen,
-- ended/cancelled terminal, ended_at stamped, open participant rows
-- closed), that no client writes meeting_participants, that a person holds at
-- most one open seat per meeting, that an invitee
-- must be a live staff member of the meeting's workspace, the
-- meeting_invite bell and its meta, the table and function grants, and
-- the realtime publication.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000106001';
  u_admin  UUID := '00000000-0000-4000-8000-000000106002';
  u_host   UUID := '00000000-0000-4000-8000-000000106003';
  u_inv    UUID := '00000000-0000-4000-8000-000000106004';
  u_out    UUID := '00000000-0000-4000-8000-000000106005';
  u_viewer UUID := '00000000-0000-4000-8000-000000106006';
  u_guest  UUID := '00000000-0000-4000-8000-000000106007';
  u_gone   UUID := '00000000-0000-4000-8000-000000106008';
  u_other  UUID := '00000000-0000-4000-8000-000000106009';
  a_acct   UUID;
  b_acct   UUID;
  m_closed UUID;   -- the host's, invite-only, u_inv invited
  m_open   UUID;   -- the host's, open to the workspace
  m_b      UUID;   -- account B's
  p_one    UUID;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (a signed-in user when p_uid is given):
  -- a SELECT's (or WITH's) value, 'ok', or the error as
  -- 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.mt_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', p_role)::text, true);
        EXECUTE format('SET LOCAL ROLE %I', p_role);
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

  -- Fixture: account A (owner, admin, three agents, a viewer, a bank
  -- guest, an agent deactivated below), account B (owner).
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'mt-owner@example.invalid'),
    (u_admin,  'mt-admin@example.invalid'),
    (u_host,   'mt-host@example.invalid'),
    (u_inv,    'mt-inv@example.invalid'),
    (u_out,    'mt-out@example.invalid'),
    (u_viewer, 'mt-viewer@example.invalid'),
    (u_guest,  'mt-guest@example.invalid'),
    (u_gone,   'mt-gone@example.invalid'),
    (u_other,  'mt-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_other;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_host, u_inv, u_out, u_gone);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_viewer;
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_guest;

  -- ---------- creating ----------
  -- INSERT … RETURNING (PostgREST's return=representation) passes the
  -- SELECT policy on the row being written.
  r := pg_temp.mt_try('authenticated', u_host, format(
    'WITH x AS (INSERT INTO meetings (account_id, title, host_user_id) VALUES (%L, %L, %L) RETURNING id) SELECT id::text FROM x',
    a_acct, '  MT closed  ', u_host));
  n := n + 1;
  IF r NOT SIMILAR TO '[0-9a-f-]{36}' THEN
    failed := array_append(failed, ('host creates a meeting with RETURNING: ' || r)::text);
  ELSE
    m_closed := r::uuid;
  END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM meetings WHERE id = m_closed AND title = 'MT closed' AND status = 'scheduled') THEN
    failed := array_append(failed, 'a new meeting''s title is trimmed and its status scheduled'::text);
  END IF;
  r := pg_temp.mt_try('authenticated', u_host, format(
    'WITH x AS (INSERT INTO meetings (account_id, title, host_user_id, open_to_workspace, scheduled_start, scheduled_end) VALUES (%L, %L, %L, true, %L, %L) RETURNING id) SELECT id::text FROM x',
    a_acct, 'MT open', u_host, '2026-11-01 09:00+00', '2026-11-01 10:00+00'));
  n := n + 1;
  IF r NOT SIMILAR TO '[0-9a-f-]{36}' THEN
    failed := array_append(failed, ('host creates an open meeting: ' || r)::text);
  ELSE
    m_open := r::uuid;
  END IF;
  IF m_closed IS NULL OR m_open IS NULL THEN
    RAISE EXCEPTION 'fixture: meetings were not created: %', array_to_string(failed, ' | ');
  END IF;
  INSERT INTO meetings (account_id, title, host_user_id, open_to_workspace)
  VALUES (b_acct, 'MT B', u_other, true) RETURNING id INTO m_b;

  r := pg_temp.mt_try('authenticated', u_guest, format(
    'INSERT INTO meetings (account_id, title, host_user_id) VALUES (%L, %L, %L)', a_acct, 'MT guest', u_guest));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN failed := array_append(failed, ('bank guest created a meeting: ' || r)::text); END IF;
  r := pg_temp.mt_try('authenticated', u_out, format(
    'INSERT INTO meetings (account_id, title, host_user_id) VALUES (%L, %L, %L)', a_acct, 'MT forged host', u_host));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN failed := array_append(failed, ('agent created a meeting hosted by someone else: ' || r)::text); END IF;
  r := pg_temp.mt_try('authenticated', u_out, format(
    'INSERT INTO meetings (account_id, title, host_user_id) VALUES (%L, %L, %L)', b_acct, 'MT other workspace', u_out));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN failed := array_append(failed, ('agent created a meeting in another workspace: ' || r)::text); END IF;
  r := pg_temp.mt_try('service_role', NULL, format(
    'INSERT INTO meetings (account_id, title, host_user_id, status) VALUES (%L, %L, %L, %L)', a_acct, 'MT born ended', u_host, 'ended'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('a meeting was created already ended: ' || r)::text); END IF;

  -- ---------- inviting, and the bell ----------
  r := pg_temp.mt_try('authenticated', u_host, format(
    'INSERT INTO meeting_invitees (meeting_id, user_id, account_id) VALUES (%L, %L, %L)', m_closed, u_inv, a_acct));
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('host invites a colleague: ' || r)::text); END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM notifications
                  WHERE user_id = u_inv AND account_id = a_acct AND type = 'meeting_invite'
                    AND actor_user_id = u_host AND title = 'MT closed'
                    AND meta = jsonb_build_object('meeting_id', m_closed)) THEN
    failed := array_append(failed, 'an invitation rings the invitee''s bell with meta {meeting_id}'::text);
  END IF;
  r := pg_temp.mt_try('authenticated', u_host, format(
    'INSERT INTO meeting_invitees (meeting_id, user_id, account_id) VALUES (%L, %L, %L)', m_closed, u_host, a_acct));
  n := n + 1;
  IF r <> 'ok' OR EXISTS (SELECT 1 FROM notifications WHERE user_id = u_host AND type = 'meeting_invite') THEN
    failed := array_append(failed, ('inviting yourself rings nothing: ' || r)::text);
  END IF;
  r := pg_temp.mt_try('authenticated', u_host, format(
    'INSERT INTO meeting_invitees (meeting_id, user_id, account_id) VALUES (%L, %L, %L)', m_closed, u_other, a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('host invited someone from another workspace: ' || r)::text); END IF;
  r := pg_temp.mt_try('service_role', NULL, format(
    'INSERT INTO meeting_invitees (meeting_id, user_id, account_id) VALUES (%L, %L, %L)', m_closed, u_other, a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('service role invited someone from another workspace: ' || r)::text); END IF;
  r := pg_temp.mt_try('service_role', NULL, format(
    'INSERT INTO meeting_invitees (meeting_id, user_id, account_id) VALUES (%L, %L, %L)', m_closed, u_other, b_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23503:%' THEN failed := array_append(failed, ('an invitee row named another account than its meeting''s: ' || r)::text); END IF;
  r := pg_temp.mt_try('authenticated', u_host, format(
    'INSERT INTO meeting_invitees (meeting_id, user_id, account_id) VALUES (%L, %L, %L)', m_closed, u_guest, a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('host invited a bank guest: ' || r)::text); END IF;
  r := pg_temp.mt_try('authenticated', u_out, format(
    'INSERT INTO meeting_invitees (meeting_id, user_id, account_id) VALUES (%L, %L, %L)', m_open, u_viewer, a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN failed := array_append(failed, ('agent invited people to someone else''s meeting: ' || r)::text); END IF;
  r := pg_temp.mt_try('authenticated', u_admin, format(
    'INSERT INTO meeting_invitees (meeting_id, user_id, account_id) VALUES (%L, %L, %L)', m_open, u_viewer, a_acct));
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('admin invites people to any meeting: ' || r)::text); END IF;

  -- Deactivated after the invitations: they see nothing now, and cannot be invited.
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_gone;
  r := pg_temp.mt_try('authenticated', u_host, format(
    'INSERT INTO meeting_invitees (meeting_id, user_id, account_id) VALUES (%L, %L, %L)', m_closed, u_gone, a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('host invited a deactivated member: ' || r)::text); END IF;

  -- ---------- who sees a meeting ----------
  r := pg_temp.mt_try('authenticated', u_guest, format('SELECT count(*)::text FROM meetings WHERE id IN (%L, %L)', m_closed, m_open));
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, ('bank guest sees a meeting, even an open one: ' || r)::text); END IF;
  r := pg_temp.mt_try('authenticated', u_guest, format('SELECT (meeting_can_view(%L) OR meeting_can_manage(%L))::text', m_open, m_open));
  n := n + 1;
  IF r <> 'false' THEN failed := array_append(failed, ('meeting_can_view is true for a bank guest: ' || r)::text); END IF;
  r := pg_temp.mt_try('authenticated', u_out, format('SELECT count(*)::text FROM meetings WHERE id = %L', m_closed));
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, ('agent not invited sees an invite-only meeting: ' || r)::text); END IF;
  r := pg_temp.mt_try('authenticated', u_out, format('SELECT count(*)::text FROM meetings WHERE id = %L', m_open));
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, ('agent sees a meeting open to the workspace: ' || r)::text); END IF;
  r := pg_temp.mt_try('authenticated', u_inv, format('SELECT count(*)::text FROM meetings WHERE id = %L', m_closed));
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, ('invitee sees the meeting: ' || r)::text); END IF;
  r := pg_temp.mt_try('authenticated', u_inv, format('SELECT count(*)::text FROM meeting_invitees WHERE meeting_id = %L', m_closed));
  n := n + 1;
  IF r <> '2' THEN failed := array_append(failed, ('invitee sees the invitation list: ' || r)::text); END IF;
  r := pg_temp.mt_try('authenticated', u_out, format('SELECT count(*)::text FROM meeting_invitees WHERE meeting_id = %L', m_closed));
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, ('agent not invited sees an invite-only meeting''s invitees: ' || r)::text); END IF;
  r := pg_temp.mt_try('authenticated', u_admin, 'SELECT count(*)::text FROM meetings');
  n := n + 1;
  IF r IS DISTINCT FROM (SELECT count(*)::text FROM meetings WHERE account_id = a_acct) OR r = '0' THEN
    failed := array_append(failed, ('admin sees every meeting of the workspace and no other: ' || r)::text);
  END IF;
  r := pg_temp.mt_try('authenticated', u_owner, format('SELECT count(*)::text FROM meetings WHERE id = %L', m_closed));
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, ('owner sees an invite-only meeting: ' || r)::text); END IF;
  r := pg_temp.mt_try('authenticated', u_other, format('SELECT count(*)::text FROM meetings WHERE account_id = %L', a_acct));
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, ('another workspace sees A''s meetings: ' || r)::text); END IF;
  r := pg_temp.mt_try('authenticated', u_out, format('SELECT count(*)::text FROM meetings WHERE id = %L', m_b));
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, ('an open meeting of another workspace is visible: ' || r)::text); END IF;
  r := pg_temp.mt_try('authenticated', u_gone, format('SELECT count(*)::text FROM meetings WHERE id = %L', m_open));
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, ('a deactivated member sees an open meeting: ' || r)::text); END IF;
  r := pg_temp.mt_try('authenticated', u_out, format('SELECT meeting_can_manage(%L)::text', m_open));
  n := n + 1;
  IF r <> 'false' THEN failed := array_append(failed, ('agent manages someone else''s open meeting: ' || r)::text); END IF;
  r := pg_temp.mt_try('authenticated', u_admin, format('SELECT (meeting_can_manage(%L) AND meeting_can_view(%L))::text', m_closed, m_closed));
  n := n + 1;
  IF r <> 'true' THEN failed := array_append(failed, ('admin manages any meeting: ' || r)::text); END IF;

  -- ---------- editing ----------
  r := pg_temp.mt_try('authenticated', u_out, format('UPDATE meetings SET title = %L WHERE id = %L', 'MT hijacked', m_open));
  n := n + 1;
  IF r LIKE 'ERROR%' AND r NOT LIKE 'ERROR 42501:%' OR EXISTS (SELECT 1 FROM meetings WHERE id = m_open AND title = 'MT hijacked') THEN
    failed := array_append(failed, ('agent renamed someone else''s meeting: ' || r)::text);
  END IF;
  r := pg_temp.mt_try('authenticated', u_inv, format('UPDATE meetings SET status = %L WHERE id = %L', 'cancelled', m_closed));
  n := n + 1;
  IF EXISTS (SELECT 1 FROM meetings WHERE id = m_closed AND status <> 'scheduled') THEN
    failed := array_append(failed, ('invitee cancelled the meeting: ' || r)::text);
  END IF;
  r := pg_temp.mt_try('authenticated', u_out, format('DELETE FROM meetings WHERE id = %L', m_open));
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM meetings WHERE id = m_open) THEN
    failed := array_append(failed, ('agent deleted someone else''s meeting: ' || r)::text);
  END IF;
  r := pg_temp.mt_try('authenticated', u_host, format('UPDATE meetings SET title = %L WHERE id = %L', 'MT closed, renamed', m_closed));
  n := n + 1;
  IF r <> 'ok' OR NOT EXISTS (SELECT 1 FROM meetings WHERE id = m_closed AND title = 'MT closed, renamed') THEN
    failed := array_append(failed, ('host renames their meeting: ' || r)::text);
  END IF;
  r := pg_temp.mt_try('authenticated', u_host, format('UPDATE meetings SET host_user_id = %L WHERE id = %L', u_out, m_closed));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('host handed the meeting to someone else: ' || r)::text); END IF;
  r := pg_temp.mt_try('service_role', NULL, format('UPDATE meetings SET account_id = %L WHERE id = %L', b_acct, m_closed));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('service role moved a meeting to another workspace: ' || r)::text); END IF;

  -- ---------- participants: service role only ----------
  r := pg_temp.mt_try('service_role', NULL, format(
    'WITH x AS (INSERT INTO meeting_participants (meeting_id, account_id, user_id, cf_session_id) VALUES (%L, %L, %L, %L) RETURNING id) SELECT id::text FROM x',
    m_closed, a_acct, u_host, 'mt-session-1'));
  n := n + 1;
  IF r NOT SIMILAR TO '[0-9a-f-]{36}' THEN
    failed := array_append(failed, ('service role records a participant: ' || r)::text);
  ELSE
    p_one := r::uuid;
  END IF;
  r := pg_temp.mt_try('service_role', NULL, format(
    'INSERT INTO meeting_participants (meeting_id, account_id, user_id, cf_session_id) VALUES (%L, %L, %L, %L)',
    m_closed, a_acct, u_inv, 'mt-session-2'));
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('service role records a second participant: ' || r)::text); END IF;
  r := pg_temp.mt_try('authenticated', u_host, format(
    'INSERT INTO meeting_participants (meeting_id, account_id, user_id, cf_session_id) VALUES (%L, %L, %L, %L)',
    m_closed, a_acct, u_host, 'mt-session-forged'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN failed := array_append(failed, ('a client inserted a participant row: ' || r)::text); END IF;
  r := pg_temp.mt_try('authenticated', u_host, format('UPDATE meeting_participants SET last_seen_at = now() WHERE id = %L', p_one));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN failed := array_append(failed, ('a client updated a participant row: ' || r)::text); END IF;
  r := pg_temp.mt_try('authenticated', u_admin, format('DELETE FROM meeting_participants WHERE id = %L', p_one));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN failed := array_append(failed, ('a client deleted a participant row: ' || r)::text); END IF;
  r := pg_temp.mt_try('authenticated', u_inv, format('SELECT count(*)::text FROM meeting_participants WHERE meeting_id = %L', m_closed));
  n := n + 1;
  IF r <> '2' THEN failed := array_append(failed, ('invitee sees who is in the room: ' || r)::text); END IF;
  r := pg_temp.mt_try('authenticated', u_out, format('SELECT count(*)::text FROM meeting_participants WHERE meeting_id = %L', m_closed));
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, ('agent not invited sees who is in an invite-only room: ' || r)::text); END IF;
  r := pg_temp.mt_try('service_role', NULL, format(
    'INSERT INTO meeting_participants (meeting_id, account_id, user_id, cf_session_id) VALUES (%L, %L, %L, %L)',
    m_open, a_acct, u_out, 'mt-session-1'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23505:%' THEN failed := array_append(failed, ('a Cloudflare session id was recorded twice: ' || r)::text); END IF;
  r := pg_temp.mt_try('service_role', NULL, format(
    'INSERT INTO meeting_participants (meeting_id, account_id, user_id, cf_session_id) VALUES (%L, %L, %L, %L)',
    m_closed, a_acct, u_host, 'mt-session-second-tab'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23505:%' THEN failed := array_append(failed, ('a second open seat for the same person in one meeting: ' || r)::text); END IF;

  -- ---------- terminal statuses ----------
  r := pg_temp.mt_try('authenticated', u_host, format('UPDATE meetings SET status = %L, ended_at = %L WHERE id = %L', 'ended', '2000-01-01', m_closed));
  n := n + 1;
  IF r <> 'ok' OR NOT EXISTS (SELECT 1 FROM meetings WHERE id = m_closed AND status = 'ended'
                                AND ended_at > now() - interval '1 minute') THEN
    failed := array_append(failed, ('ending a meeting stamps ended_at itself: ' || r)::text);
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM meeting_participants WHERE meeting_id = m_closed AND left_at IS NULL) THEN
    failed := array_append(failed, 'ending a meeting closes every open participant row'::text);
  END IF;
  r := pg_temp.mt_try('authenticated', u_host, format('UPDATE meetings SET status = %L WHERE id = %L', 'scheduled', m_closed));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('host reopened an ended meeting: ' || r)::text); END IF;
  r := pg_temp.mt_try('service_role', NULL, format('UPDATE meetings SET status = %L WHERE id = %L', 'cancelled', m_closed));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('service role moved an ended meeting to cancelled: ' || r)::text); END IF;
  r := pg_temp.mt_try('authenticated', u_admin, format('UPDATE meetings SET status = %L WHERE id = %L', 'cancelled', m_open));
  n := n + 1;
  IF r <> 'ok' OR NOT EXISTS (SELECT 1 FROM meetings WHERE id = m_open AND status = 'cancelled' AND ended_at IS NULL) THEN
    failed := array_append(failed, ('admin cancels any meeting: ' || r)::text);
  END IF;
  r := pg_temp.mt_try('service_role', NULL, format('UPDATE meetings SET status = %L WHERE id = %L', 'scheduled', m_open));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('service role reopened a cancelled meeting: ' || r)::text); END IF;

  -- ---------- grants, helpers, publication ----------
  n := n + 1;
  IF has_table_privilege('anon', 'public.meetings', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR has_table_privilege('anon', 'public.meeting_invitees', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR has_table_privilege('anon', 'public.meeting_participants', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
    failed := array_append(failed, 'anon holds a privilege on a meetings table'::text);
  END IF;
  n := n + 1;
  IF has_table_privilege('authenticated', 'public.meeting_participants', 'INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('authenticated', 'public.meeting_invitees', 'UPDATE,TRUNCATE')
     OR has_table_privilege('authenticated', 'public.meetings', 'TRUNCATE,REFERENCES,TRIGGER') THEN
    failed := array_append(failed, 'authenticated holds a write the policies do not govern'::text);
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM pg_proc
              WHERE oid IN ('public.meeting_can_view(uuid)'::regprocedure, 'public.meeting_can_manage(uuid)'::regprocedure)
                AND NOT (prosecdef AND proconfig @> ARRAY['search_path=public, pg_temp']))
     OR has_function_privilege('anon', 'public.meeting_can_view(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.meeting_can_view(uuid)', 'EXECUTE') THEN
    failed := array_append(failed, 'meeting_can_view / meeting_can_manage are not SECURITY DEFINER with a pinned search_path and explicit grants'::text);
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM pg_class
              WHERE oid IN ('public.meetings'::regclass, 'public.meeting_invitees'::regclass, 'public.meeting_participants'::regclass)
                AND NOT (relrowsecurity AND relforcerowsecurity)) THEN
    failed := array_append(failed, 'row-level security is not forced on every meetings table'::text);
  END IF;
  n := n + 1;
  IF NOT coalesce(pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'notifications_type_check'
                                         AND conrelid = 'public.notifications'::regclass))
                  LIKE ALL (ARRAY['%''meeting_invite''%', '%''pbx_connection_restored''%', '%''conversation_assigned''%']), false) THEN
    failed := array_append(failed, 'notifications_type_check lost a type or lacks meeting_invite'::text);
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND (SELECT count(*) FROM pg_publication_tables
           WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
             AND tablename IN ('meetings', 'meeting_participants')) <> 2 THEN
    failed := array_append(failed, 'meetings and meeting_participants are not in supabase_realtime'::text);
  END IF;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT106', MESSAGE = 'verify-meetings rollback';
  EXCEPTION WHEN SQLSTATE 'ZT106' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'meetings verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'meetings verification passed (% checks)', n;
END
$verify$;
