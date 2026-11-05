-- Behavioural regression suite for the meeting host tools (migration 176).
--
-- locked_at, locked_by, recording_started_at and recording_by on
-- meetings are written by the service role only: a client (the host and
-- an admin alike) can neither change them nor create a meeting already
-- stamped, while a manager's ordinary edit keeps working. Once a meeting
-- is not scheduled the two recording columns are empty, for every
-- writer. meeting_notes is read as the meeting is and written only
-- through meeting_save_notes: anyone who can view while it is scheduled,
-- a manager afterwards, compare-and-set on version (MN001 STALE writes
-- nothing), at most 20000 characters. Deleting a host's login that
-- locked and is recording their own meeting and last edited its notes
-- succeeds in the transaction that made them (the two-path delete of
-- 117), which is why those uuid columns have no foreign key.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner   UUID := '00000000-0000-4000-8000-000000176001';
  u_admin   UUID := '00000000-0000-4000-8000-000000176002';
  u_host    UUID := '00000000-0000-4000-8000-000000176003';
  u_inv     UUID := '00000000-0000-4000-8000-000000176004';
  u_out     UUID := '00000000-0000-4000-8000-000000176005';
  u_removed UUID := '00000000-0000-4000-8000-000000176006';
  u_guest   UUID := '00000000-0000-4000-8000-000000176007';
  u_other   UUID := '00000000-0000-4000-8000-000000176008';
  u_lead2   UUID := '00000000-0000-4000-8000-000000176009';   -- the host whose login is deleted
  u_gone    UUID := '00000000-0000-4000-8000-000000176010';   -- an invitee whose login is deleted
  a_acct    UUID;
  b_acct    UUID;
  m_main    UUID;   -- u_host's, invite-only; u_inv invited, u_removed removed
  m_open    UUID;   -- u_host's, open to the workspace
  m_ended   UUID;   -- u_host's, ended by the host while recording
  m_cancel  UUID;   -- u_host's, cancelled by an admin while recording
  m_svc     UUID;   -- u_host's, ended by the service role while recording
  m_b       UUID;   -- account B's
  m_lead2   UUID;   -- u_lead2's: the 117 fixture
  m_keep    UUID;   -- u_host's: stamped and last edited by u_gone
  col       TEXT;
  who       UUID;
  val       TEXT;
  t_stamp   TIMESTAMPTZ := '2026-11-05 09:00+00';
  body_now  TEXT;
  ver_now   INT;
  r         TEXT;
  n         INT := 0;
  failed    TEXT[] := '{}';
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

  -- Fixture: account A (owner, admin, two team leaders, four agents, a
  -- bank guest), account B (owner).
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,   'mh-owner@example.invalid'),
    (u_admin,   'mh-admin@example.invalid'),
    (u_host,    'mh-host@example.invalid'),
    (u_inv,     'mh-inv@example.invalid'),
    (u_out,     'mh-out@example.invalid'),
    (u_removed, 'mh-removed@example.invalid'),
    (u_guest,   'mh-guest@example.invalid'),
    (u_other,   'mh-other@example.invalid'),
    (u_lead2,   'mh-lead2@example.invalid'),
    (u_gone,    'mh-gone@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_other;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id IN (u_host, u_lead2);
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_inv, u_out, u_removed, u_gone);
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_guest;

  INSERT INTO meetings (account_id, title, host_user_id) VALUES (a_acct, 'MH main', u_host) RETURNING id INTO m_main;
  INSERT INTO meetings (account_id, title, host_user_id, open_to_workspace) VALUES (a_acct, 'MH open', u_host, true) RETURNING id INTO m_open;
  INSERT INTO meetings (account_id, title, host_user_id) VALUES (a_acct, 'MH ended', u_host) RETURNING id INTO m_ended;
  INSERT INTO meetings (account_id, title, host_user_id) VALUES (a_acct, 'MH cancel', u_host) RETURNING id INTO m_cancel;
  INSERT INTO meetings (account_id, title, host_user_id) VALUES (a_acct, 'MH svc', u_host) RETURNING id INTO m_svc;
  INSERT INTO meetings (account_id, title, host_user_id) VALUES (a_acct, 'MH keep', u_host) RETURNING id INTO m_keep;
  INSERT INTO meetings (account_id, title, host_user_id) VALUES (a_acct, 'MH lead2', u_lead2) RETURNING id INTO m_lead2;
  INSERT INTO meetings (account_id, title, host_user_id, open_to_workspace) VALUES (b_acct, 'MH B', u_other, true) RETURNING id INTO m_b;
  INSERT INTO meeting_invitees (meeting_id, account_id, user_id) VALUES
    (m_main, a_acct, u_inv), (m_main, a_acct, u_removed),
    (m_ended, a_acct, u_inv), (m_cancel, a_acct, u_inv), (m_keep, a_acct, u_gone);
  INSERT INTO meeting_removed_users (meeting_id, account_id, user_id, removed_by)
  VALUES (m_main, a_acct, u_removed, u_host);

  -- ---------- catalog ----------
  n := n + 1;
  IF (SELECT count(*) FROM pg_attribute
       WHERE attrelid = 'public.meetings'::regclass AND NOT attisdropped AND NOT attnotnull
         AND attname IN ('locked_at', 'locked_by', 'recording_started_at', 'recording_by')) <> 4 THEN
    failed := array_append(failed, 'the four nullable meetings columns are not all there'::text);
  END IF;
  -- The 117 trap, in a form a migration replay can see: the replay
  -- creates the triggers in the order that hides the failure.
  n := n + 1;
  IF EXISTS (SELECT 1 FROM pg_constraint c
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
             WHERE c.contype = 'f' AND c.conrelid = 'public.meetings'::regclass
               AND a.attname IN ('locked_by', 'recording_by')) THEN
    failed := array_append(failed, 'meetings.locked_by or recording_by has a foreign key (117)'::text);
  END IF;
  n := n + 1;
  IF (SELECT count(*) FROM pg_constraint c
       WHERE c.contype = 'f' AND c.conrelid = 'public.meeting_notes'::regclass) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                     WHERE c.conname = 'meeting_notes_meeting_fkey'
                       AND c.conrelid = 'public.meeting_notes'::regclass
                       AND c.confrelid = 'public.meetings'::regclass
                       AND c.confdeltype = 'c' AND NOT c.condeferrable
                       AND array_length(c.conkey, 1) = 2) THEN
    failed := array_append(failed, 'meeting_notes must have exactly the plain composite cascade foreign key'::text);
  END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM pg_class
                  WHERE oid = 'public.meeting_notes'::regclass
                    AND relrowsecurity AND relforcerowsecurity) THEN
    failed := array_append(failed, 'meeting_notes RLS is not enabled and forced'::text);
  END IF;
  n := n + 1;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.meeting_notes'::regclass) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policy
                     WHERE polrelid = 'public.meeting_notes'::regclass AND polcmd = 'r') THEN
    failed := array_append(failed, 'meeting_notes must have one policy, a SELECT'::text);
  END IF;
  n := n + 1;
  IF NOT has_table_privilege('authenticated', 'public.meeting_notes', 'SELECT')
     OR has_table_privilege('authenticated', 'public.meeting_notes', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('anon', 'public.meeting_notes', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR NOT has_table_privilege('service_role', 'public.meeting_notes', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.meeting_notes', 'UPDATE') THEN
    failed := array_append(failed, 'meeting_notes table grants are wrong'::text);
  END IF;
  n := n + 1;
  IF NOT has_function_privilege('authenticated', 'public.meeting_save_notes(uuid, text, integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.meeting_save_notes(uuid, text, integer)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.meeting_save_notes(uuid, text, integer)', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                 WHERE p.oid = 'public.meeting_save_notes(uuid, text, integer)'::regprocedure
                   AND a.grantee = 0) THEN
    failed := array_append(failed, 'meeting_save_notes must be executable by authenticated only'::text);
  END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE oid = 'public.meeting_save_notes(uuid, text, integer)'::regprocedure
                    AND prosecdef
                    AND proconfig @> ARRAY['search_path=public, pg_temp']) THEN
    failed := array_append(failed, 'meeting_save_notes must be SECURITY DEFINER with a pinned search_path'::text);
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                      WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
                        AND tablename = 'meeting_notes') THEN
    failed := array_append(failed, 'meeting_notes is not in supabase_realtime'::text);
  END IF;

  -- ---------- only the service role writes the four columns ----------
  FOREACH who IN ARRAY ARRAY[u_host, u_admin] LOOP
    FOREACH col IN ARRAY ARRAY['locked_at', 'locked_by', 'recording_started_at', 'recording_by'] LOOP
      val := CASE WHEN col LIKE '%\_by' THEN format('%L::uuid', who) ELSE 'now()' END;
      r := pg_temp.mt_try('authenticated', who, format(
        'UPDATE meetings SET %I = %s WHERE id = %L', col, val, m_main));
      n := n + 1;
      IF r NOT LIKE 'ERROR 42501:%' THEN
        failed := array_append(failed, format('client %s wrote meetings.%s: %s',
          CASE who WHEN u_host THEN 'host' ELSE 'admin' END, col, r));
      END IF;
    END LOOP;
  END LOOP;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM meetings WHERE id = m_main
              AND (locked_at IS NOT NULL OR locked_by IS NOT NULL
                   OR recording_started_at IS NOT NULL OR recording_by IS NOT NULL)) THEN
    failed := array_append(failed, 'a refused client write left a stamp behind'::text);
  END IF;
  FOREACH col IN ARRAY ARRAY['locked_at', 'locked_by', 'recording_started_at', 'recording_by'] LOOP
    val := CASE WHEN col LIKE '%\_by' THEN format('%L::uuid', u_host) ELSE 'now()' END;
    r := pg_temp.mt_try('authenticated', u_host, format(
      'INSERT INTO meetings (account_id, title, host_user_id, %I) VALUES (%L, %L, %L, %s)',
      col, a_acct, 'MH stamped', u_host, val));
    n := n + 1;
    IF r NOT LIKE 'ERROR 42501:%' THEN
      failed := array_append(failed, format('client created a meeting with %s set: %s', col, r));
    END IF;
  END LOOP;
  r := pg_temp.mt_try('authenticated', u_host, format(
    'INSERT INTO meetings (account_id, title, host_user_id) VALUES (%L, %L, %L)', a_acct, 'MH plain', u_host));
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('host could not create a plain meeting: ' || r)::text); END IF;

  r := pg_temp.mt_try('service_role', NULL, format(
    'UPDATE meetings SET locked_at = %L, locked_by = %L, recording_started_at = %L, recording_by = %L WHERE id = %L',
    t_stamp, u_host, t_stamp, u_host, m_main));
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('service role could not stamp: ' || r)::text); END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM meetings WHERE id = m_main
                  AND locked_at = t_stamp AND locked_by = u_host
                  AND recording_started_at = t_stamp AND recording_by = u_host) THEN
    failed := array_append(failed, 'the service role''s stamp did not land'::text);
  END IF;

  -- A client cannot clear them either.
  r := pg_temp.mt_try('authenticated', u_host, format('UPDATE meetings SET locked_at = NULL WHERE id = %L', m_main));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN failed := array_append(failed, ('host cleared the lock: ' || r)::text); END IF;
  r := pg_temp.mt_try('authenticated', u_admin, format('UPDATE meetings SET recording_started_at = NULL, recording_by = NULL WHERE id = %L', m_main));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN failed := array_append(failed, ('admin cleared the recording: ' || r)::text); END IF;

  -- A manager's ordinary edit is unchanged, stamped or not; 110 still
  -- keeps an admin who is not the host out of the details.
  r := pg_temp.mt_try('authenticated', u_host, format(
    'UPDATE meetings SET title = %L, description = %L WHERE id = %L', '  MH renamed  ', 'Agenda', m_main));
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('host could not edit the title: ' || r)::text); END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM meetings WHERE id = m_main AND title = 'MH renamed' AND description = 'Agenda'
                  AND locked_at = t_stamp AND recording_by = u_host) THEN
    failed := array_append(failed, 'the host''s edit did not land, or touched the stamps'::text);
  END IF;
  r := pg_temp.mt_try('authenticated', u_admin, format('UPDATE meetings SET title = %L WHERE id = %L', 'MH admin', m_main));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%Only the host%' THEN failed := array_append(failed, ('110''s host-only edit changed: ' || r)::text); END IF;

  r := pg_temp.mt_try('service_role', NULL, format('UPDATE meetings SET locked_at = NULL, locked_by = NULL WHERE id = %L', m_main));
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('service role could not unlock: ' || r)::text); END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM meetings WHERE id = m_main AND (locked_at IS NOT NULL OR locked_by IS NOT NULL)) THEN
    failed := array_append(failed, 'the service role''s unlock did not land'::text);
  END IF;

  -- ---------- ending clears the recording, for every writer ----------
  r := pg_temp.mt_try('service_role', NULL, format(
    'UPDATE meetings SET locked_at = %L, locked_by = %L, recording_started_at = %L, recording_by = %L WHERE id IN (%L, %L, %L)',
    t_stamp, u_host, t_stamp, u_host, m_ended, m_cancel, m_svc));
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('fixture stamp: ' || r)::text); END IF;

  -- Notes that exist before the end, for the checks further down.
  r := pg_temp.mt_try('authenticated', u_inv, format(
    'SELECT meeting_save_notes(%L, %L, 0)::text', m_ended, 'Before the end'));
  n := n + 1;
  IF r NOT LIKE '%"version": 1,%' THEN failed := array_append(failed, ('invitee saves before the end: ' || r)::text); END IF;

  -- A stamp smuggled into the ending UPDATE is refused, not swallowed.
  r := pg_temp.mt_try('authenticated', u_host, format(
    'UPDATE meetings SET status = %L, locked_at = NULL WHERE id = %L', 'ended', m_ended));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN failed := array_append(failed, ('host ended and unlocked in one write: ' || r)::text); END IF;

  r := pg_temp.mt_try('authenticated', u_host, format('UPDATE meetings SET status = %L WHERE id = %L', 'ended', m_ended));
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('host could not end a recording meeting: ' || r)::text); END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM meetings WHERE id = m_ended AND status = 'ended'
                  AND recording_started_at IS NULL AND recording_by IS NULL) THEN
    failed := array_append(failed, 'the host ending a meeting did not clear the recording'::text);
  END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM meetings WHERE id = m_ended AND locked_at = t_stamp AND locked_by = u_host) THEN
    failed := array_append(failed, 'ending a meeting must leave the lock as it was'::text);
  END IF;

  r := pg_temp.mt_try('authenticated', u_admin, format('UPDATE meetings SET status = %L WHERE id = %L', 'cancelled', m_cancel));
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('admin could not cancel a recording meeting: ' || r)::text); END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM meetings WHERE id = m_cancel AND status = 'cancelled'
                  AND recording_started_at IS NULL AND recording_by IS NULL) THEN
    failed := array_append(failed, 'an admin cancelling a meeting did not clear the recording'::text);
  END IF;

  r := pg_temp.mt_try('service_role', NULL, format('UPDATE meetings SET status = %L WHERE id = %L', 'ended', m_svc));
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('service role could not end: ' || r)::text); END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM meetings WHERE id = m_svc AND status = 'ended'
                  AND recording_started_at IS NULL AND recording_by IS NULL) THEN
    failed := array_append(failed, 'the service role ending a meeting did not clear the recording'::text);
  END IF;

  -- An ended meeting cannot start recording again.
  r := pg_temp.mt_try('service_role', NULL, format(
    'UPDATE meetings SET recording_started_at = %L, recording_by = %L WHERE id = %L', t_stamp, u_host, m_svc));
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('service role stamp on an ended meeting: ' || r)::text); END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM meetings WHERE id = m_svc AND (recording_started_at IS NOT NULL OR recording_by IS NOT NULL)) THEN
    failed := array_append(failed, 'an ended meeting shows a recording'::text);
  END IF;

  -- ---------- notes: reading and saving ----------
  r := pg_temp.mt_try('authenticated', u_inv, format('SELECT meeting_save_notes(%L, %L, 0)::text', m_main, 'First'));
  n := n + 1;
  IF r NOT LIKE '%"version": 1,%' OR r NOT LIKE '%"updated_by": "' || u_inv || '"%' OR r NOT LIKE '%"updated_at": "%' THEN
    failed := array_append(failed, ('invitee''s first save: ' || r)::text);
  END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM meeting_notes WHERE meeting_id = m_main AND account_id = a_acct
                  AND body = 'First' AND version = 1 AND updated_by = u_inv) THEN
    failed := array_append(failed, 'the first save did not write the row, in the meeting''s account'::text);
  END IF;

  FOREACH who IN ARRAY ARRAY[u_inv, u_host, u_admin, u_owner] LOOP
    r := pg_temp.mt_try('authenticated', who, format('SELECT count(*)::text FROM meeting_notes WHERE meeting_id = %L', m_main));
    n := n + 1;
    IF r <> '1' THEN failed := array_append(failed, format('%s could not read the notes: %s', who, r)); END IF;
  END LOOP;

  -- A person outside the meeting reads nothing and saves nothing.
  FOREACH who IN ARRAY ARRAY[u_out, u_removed, u_guest, u_other] LOOP
    r := pg_temp.mt_try('authenticated', who, format('SELECT count(*)::text FROM meeting_notes WHERE meeting_id = %L', m_main));
    n := n + 1;
    IF r <> '0' THEN failed := array_append(failed, format('%s read the notes: %s', who, r)); END IF;
    r := pg_temp.mt_try('authenticated', who, format('SELECT meeting_save_notes(%L, %L, 1)::text', m_main, 'Intruder'));
    n := n + 1;
    IF r NOT LIKE 'ERROR 42501: meeting_not_visible%' THEN failed := array_append(failed, format('%s saved the notes: %s', who, r)); END IF;
    r := pg_temp.mt_try('authenticated', who, format('SELECT meeting_save_notes(%L, %L, 0)::text', m_cancel, 'Intruder'));
    n := n + 1;
    IF r NOT LIKE 'ERROR 42501: meeting_not_visible%' THEN failed := array_append(failed, format('%s created notes: %s', who, r)); END IF;
  END LOOP;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM meeting_notes WHERE meeting_id = m_main AND body = 'First' AND version = 1)
     OR EXISTS (SELECT 1 FROM meeting_notes WHERE meeting_id = m_cancel) THEN
    failed := array_append(failed, 'a refused save wrote something'::text);
  END IF;
  r := pg_temp.mt_try('authenticated', u_host, format('SELECT meeting_save_notes(%L, %L, 0)::text', m_b, 'Across'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501: meeting_not_visible%' THEN failed := array_append(failed, ('saved into another workspace: ' || r)::text); END IF;

  -- An open meeting: any staff member there may write.
  r := pg_temp.mt_try('authenticated', u_out, format('SELECT meeting_save_notes(%L, %L, 0)::text', m_open, 'Open'));
  n := n + 1;
  IF r NOT LIKE '%"version": 1,%' THEN failed := array_append(failed, ('agent could not save on an open meeting: ' || r)::text); END IF;

  -- ---------- notes: compare-and-set ----------
  r := pg_temp.mt_try('authenticated', u_host, format('SELECT meeting_save_notes(%L, %L, 0)::text', m_main, 'Stale insert'));
  n := n + 1;
  IF r NOT LIKE 'ERROR MN001: STALE%' THEN failed := array_append(failed, ('version 0 over an existing row: ' || r)::text); END IF;
  r := pg_temp.mt_try('authenticated', u_host, format('SELECT meeting_save_notes(%L, %L, 7)::text', m_main, 'Stale update'));
  n := n + 1;
  IF r NOT LIKE 'ERROR MN001: STALE%' THEN failed := array_append(failed, ('a wrong version: ' || r)::text); END IF;
  r := pg_temp.mt_try('authenticated', u_host, format('SELECT meeting_save_notes(%L, %L, 3)::text', m_keep, 'No row yet'));
  n := n + 1;
  IF r NOT LIKE 'ERROR MN001: STALE%' THEN failed := array_append(failed, ('a version with no row: ' || r)::text); END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM meeting_notes WHERE meeting_id = m_main AND body = 'First' AND version = 1 AND updated_by = u_inv)
     OR EXISTS (SELECT 1 FROM meeting_notes WHERE meeting_id = m_keep) THEN
    failed := array_append(failed, 'a STALE save wrote something'::text);
  END IF;

  r := pg_temp.mt_try('authenticated', u_host, format('SELECT meeting_save_notes(%L, %L, 1)::text', m_main, 'Second'));
  n := n + 1;
  IF r NOT LIKE '%"version": 2,%' OR r NOT LIKE '%"updated_by": "' || u_host || '"%' THEN
    failed := array_append(failed, ('the version did not increment: ' || r)::text);
  END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM meeting_notes WHERE meeting_id = m_main AND body = 'Second' AND version = 2 AND updated_by = u_host) THEN
    failed := array_append(failed, 'the second save did not land'::text);
  END IF;

  -- Blank clears them.
  r := pg_temp.mt_try('authenticated', u_inv, format('SELECT meeting_save_notes(%L, %L, 2)::text', m_main, ''));
  n := n + 1;
  IF r NOT LIKE '%"version": 3,%' THEN failed := array_append(failed, ('a blank save: ' || r)::text); END IF;

  -- ---------- notes: length, in characters ----------
  r := pg_temp.mt_try('authenticated', u_inv, format('SELECT meeting_save_notes(%L, %L, 3)::text', m_main, repeat('ع', 20000)));
  n := n + 1;
  IF r NOT LIKE '%"version": 4,%' THEN failed := array_append(failed, ('20000 characters refused: ' || left(r, 200))::text); END IF;
  r := pg_temp.mt_try('authenticated', u_inv, format('SELECT meeting_save_notes(%L, %L, 4)::text', m_main, repeat('a', 20001)));
  n := n + 1;
  IF r NOT LIKE 'ERROR 22023: invalid_body%' THEN failed := array_append(failed, ('20001 characters accepted: ' || left(r, 200))::text); END IF;
  r := pg_temp.mt_try('authenticated', u_inv, format('SELECT meeting_save_notes(%L, NULL, 4)::text', m_main));
  n := n + 1;
  IF r NOT LIKE 'ERROR 22023: invalid_body%' THEN failed := array_append(failed, ('a NULL body: ' || r)::text); END IF;
  SELECT body, version INTO body_now, ver_now FROM meeting_notes WHERE meeting_id = m_main;
  n := n + 1;
  IF ver_now <> 4 OR char_length(body_now) <> 20000 THEN
    failed := array_append(failed, 'an over-length save wrote something'::text);
  END IF;
  r := pg_temp.mt_try('service_role', NULL, format('UPDATE meeting_notes SET body = repeat(%L, 20001) WHERE meeting_id = %L', 'a', m_main));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('the table CHECK let 20001 characters in: ' || left(r, 200))::text); END IF;

  -- ---------- notes: after the end ----------
  r := pg_temp.mt_try('authenticated', u_inv, format('SELECT count(*)::text FROM meeting_notes WHERE meeting_id = %L', m_ended));
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, ('invitee could not read notes after the end: ' || r)::text); END IF;
  r := pg_temp.mt_try('authenticated', u_inv, format('SELECT meeting_save_notes(%L, %L, 1)::text', m_ended, 'After'));
  n := n + 1;
  IF r NOT LIKE 'ERROR P0001: meeting_closed%' THEN failed := array_append(failed, ('invitee saved after the end: ' || r)::text); END IF;
  r := pg_temp.mt_try('authenticated', u_inv, format('SELECT meeting_save_notes(%L, %L, 0)::text', m_cancel, 'After'));
  n := n + 1;
  IF r NOT LIKE 'ERROR P0001: meeting_closed%' THEN failed := array_append(failed, ('invitee saved after a cancel: ' || r)::text); END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM meeting_notes WHERE meeting_id = m_ended AND body = 'Before the end' AND version = 1)
     OR EXISTS (SELECT 1 FROM meeting_notes WHERE meeting_id = m_cancel) THEN
    failed := array_append(failed, 'a closed meeting took an invitee''s save'::text);
  END IF;
  r := pg_temp.mt_try('authenticated', u_host, format('SELECT meeting_save_notes(%L, %L, 1)::text', m_ended, 'Host finishes'));
  n := n + 1;
  IF r NOT LIKE '%"version": 2,%' THEN failed := array_append(failed, ('host could not finish the minutes: ' || r)::text); END IF;
  r := pg_temp.mt_try('authenticated', u_admin, format('SELECT meeting_save_notes(%L, %L, 2)::text', m_ended, 'Admin finishes'));
  n := n + 1;
  IF r NOT LIKE '%"version": 3,%' THEN failed := array_append(failed, ('admin could not finish the minutes: ' || r)::text); END IF;
  r := pg_temp.mt_try('authenticated', u_host, format('SELECT meeting_save_notes(%L, %L, 0)::text', m_cancel, 'Host first'));
  n := n + 1;
  IF r NOT LIKE '%"version": 1,%' THEN failed := array_append(failed, ('host could not write notes after a cancel: ' || r)::text); END IF;

  -- ---------- no client write on the table ----------
  FOREACH who IN ARRAY ARRAY[u_host, u_admin] LOOP
    r := pg_temp.mt_try('authenticated', who, format(
      'INSERT INTO meeting_notes (meeting_id, account_id, body) VALUES (%L, %L, %L)', m_svc, a_acct, 'Direct'));
    n := n + 1;
    IF r NOT LIKE 'ERROR 42501:%' THEN failed := array_append(failed, ('client INSERT on meeting_notes: ' || r)::text); END IF;
    r := pg_temp.mt_try('authenticated', who, format('UPDATE meeting_notes SET body = %L WHERE meeting_id = %L', 'Direct', m_open));
    n := n + 1;
    IF r NOT LIKE 'ERROR 42501:%' THEN failed := array_append(failed, ('client UPDATE on meeting_notes: ' || r)::text); END IF;
    r := pg_temp.mt_try('authenticated', who, format('DELETE FROM meeting_notes WHERE meeting_id = %L', m_open));
    n := n + 1;
    IF r NOT LIKE 'ERROR 42501:%' THEN failed := array_append(failed, ('client DELETE on meeting_notes: ' || r)::text); END IF;
  END LOOP;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM meeting_notes WHERE meeting_id = m_open AND body = 'Open')
     OR EXISTS (SELECT 1 FROM meeting_notes WHERE meeting_id = m_svc) THEN
    failed := array_append(failed, 'a client write reached meeting_notes'::text);
  END IF;
  r := pg_temp.mt_try('service_role', NULL, format('SELECT count(*)::text FROM meeting_notes WHERE meeting_id = %L', m_open));
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, ('service role could not read meeting_notes: ' || r)::text); END IF;

  -- ---------- deleting a login (the 117 trap) ----------
  -- All inside the transaction that made the rows, the harshest case.
  -- (The workspaces the sign-up trigger made for them change owner first.)
  UPDATE accounts SET owner_user_id = u_owner WHERE owner_user_id IN (u_lead2, u_gone);
  r := pg_temp.mt_try('service_role', NULL, format(
    'UPDATE meetings SET locked_at = now(), locked_by = %L, recording_started_at = now(), recording_by = %L WHERE id = %L',
    u_lead2, u_lead2, m_lead2));
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('fixture stamp for the host delete: ' || r)::text); END IF;
  r := pg_temp.mt_try('authenticated', u_lead2, format('SELECT meeting_save_notes(%L, %L, 0)::text', m_lead2, 'Mine'));
  n := n + 1;
  IF r NOT LIKE '%"version": 1,%' THEN failed := array_append(failed, ('fixture notes for the host delete: ' || r)::text); END IF;
  BEGIN
    DELETE FROM auth.users WHERE id = u_lead2;
    r := 'ok';
  EXCEPTION WHEN OTHERS THEN
    r := 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
  END;
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('deleting the host''s login: ' || r)::text); END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM meetings WHERE id = m_lead2) OR EXISTS (SELECT 1 FROM meeting_notes WHERE meeting_id = m_lead2) THEN
    failed := array_append(failed, 'the host''s meeting or its notes outlived the login'::text);
  END IF;

  -- Someone else's login: their uuids stay behind as labels.
  r := pg_temp.mt_try('service_role', NULL, format(
    'UPDATE meetings SET locked_at = now(), locked_by = %L, recording_started_at = now(), recording_by = %L WHERE id = %L',
    u_gone, u_gone, m_keep));
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('fixture stamp for the invitee delete: ' || r)::text); END IF;
  r := pg_temp.mt_try('authenticated', u_gone, format('SELECT meeting_save_notes(%L, %L, 0)::text', m_keep, 'Theirs'));
  n := n + 1;
  IF r NOT LIKE '%"version": 1,%' THEN failed := array_append(failed, ('fixture notes for the invitee delete: ' || r)::text); END IF;
  BEGIN
    DELETE FROM auth.users WHERE id = u_gone;
    r := 'ok';
  EXCEPTION WHEN OTHERS THEN
    r := 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
  END;
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('deleting an invitee''s login: ' || r)::text); END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM meetings WHERE id = m_keep AND locked_by = u_gone AND recording_by = u_gone)
     OR NOT EXISTS (SELECT 1 FROM meeting_notes WHERE meeting_id = m_keep AND updated_by = u_gone) THEN
    failed := array_append(failed, 'the meeting or its notes did not outlive a login that is not the host'::text);
  END IF;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT176', MESSAGE = 'verify-meeting-host-tools rollback';
  EXCEPTION WHEN SQLSTATE 'ZT176' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'meeting host tools verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'meeting host tools verification passed (% checks)', n;
END
$verify$;
