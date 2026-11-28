-- Behavioural regression suite for note tombstones (migration 332).
--
-- Deleting an in-chat note is an UPDATE that sets deleted_at and clears
-- the text and mentions at once, so Realtime delivers it through the
-- chat's filtered subscription. The tombstone stays readable to whoever
-- sees the chat (Realtime checks it against conversation_notes_select)
-- and to nobody else; the list and the PDPL export leave it out; only
-- the author makes one; hard DELETE is not granted; a tombstone is final;
-- the note's bells and pushes go; the erase still removes the row.
--
-- ONE statement on purpose (see verify-conversation-notes.sql); the
-- fixtures are rolled back by a sentinel exception.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000332001';
  u_admin  UUID := '00000000-0000-4000-8000-000000332002';
  u_agent  UUID := '00000000-0000-4000-8000-000000332003';  -- owns c1; the author
  u_other  UUID := '00000000-0000-4000-8000-000000332004';  -- agent with no tie to c1
  a_acct   UUID;
  ca       UUID;
  c1       UUID;
  note1    TEXT;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.nt_try(p_role text, p_uid uuid, p_sql text)
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
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.nt_check(p_name text, p_role text, p_uid uuid, p_sql text, p_like text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := pg_temp.nt_try(p_role, p_uid, p_sql);
    BEGIN
      RETURN CASE WHEN v LIKE p_like THEN NULL ELSE p_name || ' (' || v || ')' END;
    END $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'nt332-owner@example.invalid'),
    (u_admin, 'nt332-admin@example.invalid'),
    (u_agent, 'nt332-agent@example.invalid'),
    (u_other, 'nt332-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin', full_name = 'Tomb Admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent', full_name = 'Tomb Agent' WHERE user_id = u_agent;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_other;

  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500332001', 'Tomb one')
    RETURNING id INTO ca;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_agent, ca) RETURNING id INTO c1;

  note1 := pg_temp.nt_try('authenticated', u_agent, format(
    'WITH x AS (INSERT INTO conversation_notes (conversation_id, body, mention_ids) VALUES (%L, %L, %L::uuid[]) RETURNING id)'
    || ' SELECT id::text FROM x',
    c1, '@Tomb Admin secret account number 1234', ARRAY[u_admin]));
  n := n + 1; failed := failed || CASE WHEN note1 LIKE 'ERROR%' THEN 'the author could not add a note (' || note1 || ')' END;
  r := pg_temp.nt_try(NULL, NULL, format(
    'INSERT INTO push_outbox (user_id, account_id, kind, title, body, url, tag)'
    || ' SELECT user_id, account_id, type, title, body, ''/notifications'', ''bell:'' || id FROM notifications'
    || ' WHERE type = ''chat_note_mention'' AND meta->>''note_id'' = %L', note1));
  n := n + 1; failed := failed || CASE WHEN r LIKE 'ERROR%' THEN 'push fixture (' || r || ')' END;
  n := n + 1; failed := failed || pg_temp.nt_check('the mention did not ring before the delete', NULL, NULL,
    format('SELECT count(*)::text FROM notifications WHERE type = ''chat_note_mention'' AND meta->>''note_id'' = %L', note1), '1');
  n := n + 1; failed := failed || pg_temp.nt_check('the export missed a live note', NULL, NULL,
    format('SELECT jsonb_array_length(privacy_conversation_notes_export(%L, %L))::text', a_acct, ca), '1');

  -- ---------- 1. who deletes ----------
  n := n + 1; failed := failed || pg_temp.nt_check('an admin tombstoned someone else''s note', 'authenticated', u_admin,
    format('WITH x AS (UPDATE conversation_notes SET deleted_at = now() WHERE id::text = %L RETURNING 1) SELECT count(*)::text FROM x', note1),
    '0');
  n := n + 1; failed := failed || pg_temp.nt_check('an agent who cannot see the chat tombstoned the note', 'authenticated', u_other,
    format('WITH x AS (UPDATE conversation_notes SET deleted_at = now() WHERE id::text = %L RETURNING 1) SELECT count(*)::text FROM x', note1),
    '0');
  n := n + 1; failed := failed || pg_temp.nt_check('an admin could still hard-delete a note', 'authenticated', u_admin,
    format('DELETE FROM conversation_notes WHERE id::text = %L', note1), 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.nt_check('the author could still hard-delete (no tombstone for Realtime)', 'authenticated', u_agent,
    format('DELETE FROM conversation_notes WHERE id::text = %L', note1), 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.nt_check('the author could not delete the note', 'authenticated', u_agent,
    format('WITH x AS (UPDATE conversation_notes SET deleted_at = now() WHERE id::text = %L RETURNING 1) SELECT count(*)::text FROM x', note1),
    '1');

  -- ---------- 2. the tombstone ----------
  n := n + 1; failed := failed || pg_temp.nt_check('the deleted note kept its text, its mentions or no deleted_at', NULL, NULL,
    format('SELECT (body = '''' AND mention_ids = ''{}''::uuid[] AND deleted_at IS NOT NULL AND author_id = %L AND conversation_id = %L)::text'
           || ' FROM conversation_notes WHERE id::text = %L', u_agent, c1, note1), 'true');
  n := n + 1; failed := failed || pg_temp.nt_check('a chat member cannot select the tombstone (Realtime would not deliver it)', 'authenticated', u_admin,
    format('SELECT count(*)::text FROM conversation_notes WHERE id::text = %L AND deleted_at IS NOT NULL', note1), '1');
  n := n + 1; failed := failed || pg_temp.nt_check('the author cannot select the tombstone', 'authenticated', u_agent,
    format('SELECT count(*)::text FROM conversation_notes WHERE id::text = %L', note1), '1');
  n := n + 1; failed := failed || pg_temp.nt_check('the thread''s list still shows the deleted note', 'authenticated', u_agent,
    format('SELECT count(*)::text FROM conversation_notes WHERE conversation_id = %L AND deleted_at IS NULL', c1), '0');
  n := n + 1; failed := failed || pg_temp.nt_check('someone who cannot see the chat selects the tombstone', 'authenticated', u_other,
    format('SELECT count(*)::text FROM conversation_notes WHERE id::text = %L', note1), '0');
  n := n + 1; failed := failed || pg_temp.nt_check('the PDPL export includes a tombstone', NULL, NULL,
    format('SELECT privacy_conversation_notes_export(%L, %L)::text', a_acct, ca), '[]');

  -- ---------- 3. a tombstone is final ----------
  n := n + 1; failed := failed || pg_temp.nt_check('the author edited a tombstone', 'authenticated', u_agent,
    format('UPDATE conversation_notes SET body = ''back again'' WHERE id::text = %L', note1), 'ERROR 22023%');
  n := n + 1; failed := failed || pg_temp.nt_check('the author restored a tombstone', 'authenticated', u_agent,
    format('UPDATE conversation_notes SET deleted_at = NULL WHERE id::text = %L', note1), 'ERROR 22023%');
  n := n + 1; failed := failed || pg_temp.nt_check('a live note with a blank body was accepted', 'authenticated', u_agent,
    format('INSERT INTO conversation_notes (conversation_id, body) VALUES (%L, '''')', c1), 'ERROR 23514%');

  -- ---------- 4. bells and pushes ----------
  n := n + 1; failed := failed || pg_temp.nt_check('a deleted note kept its bell', NULL, NULL,
    format('SELECT count(*)::text FROM notifications WHERE type = ''chat_note_mention'' AND meta->>''note_id'' = %L', note1), '0');
  n := n + 1; failed := failed || pg_temp.nt_check('a deleted note kept its queued push', NULL, NULL,
    format('SELECT count(*)::text FROM push_outbox WHERE account_id = %L AND kind = ''chat_note_mention''', a_acct), '0');

  -- ---------- 5. the erase still removes the row ----------
  r := pg_temp.nt_try(NULL, NULL, format('SELECT privacy_conversation_notes_erase(%L, %L)::text', a_acct, ca));
  n := n + 1; failed := failed || CASE WHEN r LIKE 'ERROR%' THEN 'the erase failed (' || r || ')' END;
  n := n + 1; failed := failed || pg_temp.nt_check('the erase left the tombstone', NULL, NULL,
    format('SELECT count(*)::text FROM conversation_notes WHERE id::text = %L', note1), '0');

  RAISE EXCEPTION USING ERRCODE = 'ZT332', MESSAGE = 'verify-note-tombstones rollback';
  EXCEPTION WHEN SQLSTATE 'ZT332' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'note tombstones verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'note tombstones verification passed (% checks)', n;
END
$verify$;
