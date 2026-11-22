-- Behavioural regression suite for in-chat notes (migration 241).
--
-- A note is read by whoever can see its chat and by nobody else; it is
-- written by agent-and-up staff who can see the chat, as themselves.
-- Only its author edits (body only, `edited_at` stamped) or deletes it.
-- Viewers read but never write. An @mention rings exactly one
-- chat_note_mention bell for a live staff person who can see the chat,
-- and nothing for someone who cannot, a bank guest or the author. The
-- mention list offers exactly those people, at most 20 a note. Editing
-- a note rewrites its bells' quote (and their queued pushes); deleting
-- it removes them. A note is never a message.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back by a sentinel exception; the
-- collected results (plpgsql variables) survive it. A writing
-- statement's result is read in a later statement.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000241001';
  u_admin  UUID := '00000000-0000-4000-8000-000000241002';
  u_agent  UUID := '00000000-0000-4000-8000-000000241003';  -- owns c1; the author
  u_other  UUID := '00000000-0000-4000-8000-000000241004';  -- agent with no tie to c1
  u_viewer UUID := '00000000-0000-4000-8000-000000241005';  -- owns c2
  u_guest  UUID := '00000000-0000-4000-8000-000000241006';
  a_acct   UUID;
  ca       UUID;
  ca2      UUID;
  c1       UUID;
  c2       UUID;
  note1    TEXT;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (NULL: as the current user) signed in as
  -- p_uid: a SELECT's value, 'ok', or 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cn_try(p_role text, p_uid uuid, p_sql text)
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
    CREATE FUNCTION pg_temp.cn_check(p_name text, p_role text, p_uid uuid, p_sql text, p_like text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := pg_temp.cn_try(p_role, p_uid, p_sql);
    BEGIN
      RETURN CASE WHEN v LIKE p_like THEN NULL ELSE p_name || ' (' || v || ')' END;
    END $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'notes241-owner@example.invalid'),
    (u_admin,  'notes241-admin@example.invalid'),
    (u_agent,  'notes241-agent@example.invalid'),
    (u_other,  'notes241-other@example.invalid'),
    (u_viewer, 'notes241-viewer@example.invalid'),
    (u_guest,  'notes241-guest@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin', full_name = 'Notes Admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent', full_name = 'Notes Agent' WHERE user_id = u_agent;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_other;
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_viewer;
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_guest;

  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500241001', 'Notes one')
    RETURNING id INTO ca;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_viewer, '971500241002', 'Notes two')
    RETURNING id INTO ca2;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_agent, ca) RETURNING id INTO c1;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_viewer, ca2) RETURNING id INTO c2;

  -- ---------- 1. writing and reading ----------
  note1 := pg_temp.cn_try('authenticated', u_agent, format(
    'WITH x AS (INSERT INTO conversation_notes (conversation_id, body, mention_ids) VALUES (%L, %L, %L::uuid[]) RETURNING id)'
    || ' SELECT id::text FROM x',
    c1, '@Notes Admin please call him', ARRAY[u_admin, u_other, u_agent, u_guest, u_admin]));
  n := n + 1; failed := failed || CASE WHEN note1 LIKE 'ERROR%' THEN 'the chat''s agent could not add a note (' || note1 || ')' END;
  n := n + 1; failed := failed || pg_temp.cn_check('the author or account was not stamped', NULL, NULL,
    format('SELECT (author_id = %L AND account_id = %L)::text FROM conversation_notes WHERE id::text = %L', u_agent, a_acct, note1),
    'true');
  n := n + 1; failed := failed || pg_temp.cn_check('the chat''s agent cannot read the note', 'authenticated', u_agent,
    format('SELECT count(*)::text FROM conversation_notes WHERE conversation_id = %L', c1), '1');
  n := n + 1; failed := failed || pg_temp.cn_check('an admin cannot read the note', 'authenticated', u_admin,
    format('SELECT count(*)::text FROM conversation_notes WHERE conversation_id = %L', c1), '1');
  n := n + 1; failed := failed || pg_temp.cn_check('an agent who cannot see the chat reads its note', 'authenticated', u_other,
    format('SELECT count(*)::text FROM conversation_notes WHERE conversation_id = %L', c1), '0');
  n := n + 1; failed := failed || pg_temp.cn_check('a bank guest reads a note', 'authenticated', u_guest,
    format('SELECT count(*)::text FROM conversation_notes WHERE conversation_id = %L', c1), '0');
  n := n + 1; failed := failed || pg_temp.cn_check('an agent who cannot see the chat added a note', 'authenticated', u_other,
    format('INSERT INTO conversation_notes (conversation_id, body) VALUES (%L, ''sneaky'')', c1), 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.cn_check('a blank note was stored', 'authenticated', u_agent,
    format('INSERT INTO conversation_notes (conversation_id, body) VALUES (%L, E'' \t\n'')', c1), 'ERROR 23514%');
  n := n + 1; failed := failed || pg_temp.cn_check('a client chose the author', 'authenticated', u_agent,
    format('INSERT INTO conversation_notes (conversation_id, body, author_id) VALUES (%L, ''x'', %L)', c1, u_admin),
    'ERROR 42501%');

  -- ---------- 2. viewers ----------
  r := pg_temp.cn_try('authenticated', u_owner, format(
    'INSERT INTO conversation_notes (conversation_id, body) VALUES (%L, ''owner note'')', c2));
  n := n + 1; failed := failed || pg_temp.cn_check('a viewer cannot read a note in their own chat', 'authenticated', u_viewer,
    format('SELECT count(*)::text FROM conversation_notes WHERE conversation_id = %L', c2), '1');
  n := n + 1; failed := failed || pg_temp.cn_check('a viewer added a note', 'authenticated', u_viewer,
    format('INSERT INTO conversation_notes (conversation_id, body) VALUES (%L, ''viewer note'')', c2), 'ERROR 42501%');

  -- ---------- 3. mentions ----------
  n := n + 1; failed := failed || pg_temp.cn_check('a mention that can see the chat did not ring exactly once', NULL, NULL,
    format('SELECT count(*)::text FROM notifications WHERE user_id = %L AND type = ''chat_note_mention'' AND conversation_id = %L'
           || ' AND meta->>''note_id'' = %L AND title = ''Notes Agent mentioned you in a note''', u_admin, c1, note1), '1');
  n := n + 1; failed := failed || pg_temp.cn_check('a mention that cannot see the chat rang', NULL, NULL,
    format('SELECT count(*)::text FROM notifications WHERE user_id IN (%L, %L, %L) AND type = ''chat_note_mention''',
           u_other, u_guest, u_agent), '0');
  n := n + 1; failed := failed || pg_temp.cn_check('mention_ids kept someone it should not', NULL, NULL,
    format('SELECT mention_ids::text FROM conversation_notes WHERE id::text = %L', note1), '{' || u_admin || '}');
  n := n + 1; failed := failed || pg_temp.cn_check('the mention list is wrong for the chat''s agent', 'authenticated', u_agent,
    format('SELECT string_agg(user_id::text, '','' ORDER BY user_id) FROM conversation_note_mention_candidates(%L)', c1),
    u_owner || ',' || u_admin);
  n := n + 1; failed := failed || pg_temp.cn_check('the mention list answered someone who cannot see the chat', 'authenticated', u_other,
    format('SELECT count(*)::text FROM conversation_note_mention_candidates(%L)', c1), '0');

  n := n + 1; failed := failed || pg_temp.cn_check('more than 20 mentions were accepted', 'authenticated', u_agent,
    format('INSERT INTO conversation_notes (conversation_id, body, mention_ids) VALUES (%L, ''many'', %L::uuid[])',
           c1, (SELECT array_agg(gen_random_uuid()) FROM generate_series(1, 21))), 'ERROR 22023%');
  n := n + 1; failed := failed || pg_temp.cn_check('the stored mention list has no cap', NULL, NULL,
    'SELECT count(*)::text FROM pg_constraint WHERE conname = ''conversation_notes_mentions_check''', '1');

  -- A queued push of the admin's bell (109 queues one only for a person
  -- with a device; the fixture has none, so it is added by hand).
  r := pg_temp.cn_try(NULL, NULL, format(
    'INSERT INTO push_outbox (user_id, account_id, kind, title, body, url, tag)'
    || ' SELECT user_id, account_id, type, title, body, ''/notifications'', ''bell:'' || id FROM notifications'
    || ' WHERE type = ''chat_note_mention'' AND meta->>''note_id'' = %L', note1));
  n := n + 1; failed := failed || CASE WHEN r LIKE 'ERROR%' THEN 'push fixture (' || r || ')' END;

  -- ---------- 4. editing and deleting ----------
  n := n + 1; failed := failed || pg_temp.cn_check('another agent edited the note', 'authenticated', u_other,
    format('WITH x AS (UPDATE conversation_notes SET body = ''hijack'' WHERE id::text = %L RETURNING 1) SELECT count(*)::text FROM x', note1),
    '0');
  n := n + 1; failed := failed || pg_temp.cn_check('an admin edited someone else''s note', 'authenticated', u_admin,
    format('WITH x AS (UPDATE conversation_notes SET body = ''hijack'' WHERE id::text = %L RETURNING 1) SELECT count(*)::text FROM x', note1),
    '0');
  n := n + 1; failed := failed || pg_temp.cn_check('an admin deleted someone else''s note', 'authenticated', u_admin,
    format('WITH x AS (DELETE FROM conversation_notes WHERE id::text = %L RETURNING 1) SELECT count(*)::text FROM x', note1), '0');
  n := n + 1; failed := failed || pg_temp.cn_check('the author could not edit the note', 'authenticated', u_agent,
    format('WITH x AS (UPDATE conversation_notes SET body = ''called, no answer'' WHERE id::text = %L RETURNING 1) SELECT count(*)::text FROM x', note1),
    '1');
  n := n + 1; failed := failed || pg_temp.cn_check('an edit was not stamped or changed more than the body', NULL, NULL,
    format('SELECT (body = ''called, no answer'' AND edited_at IS NOT NULL AND author_id = %L AND conversation_id = %L)::text'
           || ' FROM conversation_notes WHERE id::text = %L', u_agent, c1, note1), 'true');
  n := n + 1; failed := failed || pg_temp.cn_check('the author moved the note to another chat', 'authenticated', u_agent,
    format('UPDATE conversation_notes SET conversation_id = %L WHERE id::text = %L', c2, note1), 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.cn_check('an edit rang again', NULL, NULL,
    format('SELECT count(*)::text FROM notifications WHERE type = ''chat_note_mention'' AND conversation_id = %L', c1), '1');
  n := n + 1; failed := failed || pg_temp.cn_check('an edit left the old text in the bell', NULL, NULL,
    format('SELECT body FROM notifications WHERE type = ''chat_note_mention'' AND meta->>''note_id'' = %L', note1),
    'called, no answer');
  n := n + 1; failed := failed || pg_temp.cn_check('an edit left the old text in the queued push', NULL, NULL,
    format('SELECT string_agg(o.body, ''|'') FROM push_outbox o JOIN notifications b ON o.tag = ''bell:'' || b.id'
           || ' WHERE b.meta->>''note_id'' = %L', note1),
    'called, no answer');

  -- ---------- 5. never a message ----------
  n := n + 1; failed := failed || pg_temp.cn_check('a note reached messages', NULL, NULL,
    format('SELECT count(*)::text FROM messages WHERE conversation_id IN (%L, %L)', c1, c2), '0');
  n := n + 1; failed := failed || pg_temp.cn_check('a note changed the chat''s unread count or preview', NULL, NULL,
    format('SELECT (coalesce(unread_count, 0) = 0 AND last_message_text IS NULL)::text FROM conversations WHERE id = %L', c1),
    'true');

  n := n + 1; failed := failed || pg_temp.cn_check('the author could not delete the note', 'authenticated', u_agent,
    format('WITH x AS (DELETE FROM conversation_notes WHERE id::text = %L RETURNING 1) SELECT count(*)::text FROM x', note1), '1');
  n := n + 1; failed := failed || pg_temp.cn_check('a deleted note kept its bell', NULL, NULL,
    format('SELECT count(*)::text FROM notifications WHERE type = ''chat_note_mention'' AND meta->>''note_id'' = %L', note1), '0');
  n := n + 1; failed := failed || pg_temp.cn_check('a deleted note kept its queued push', NULL, NULL,
    format('SELECT count(*)::text FROM push_outbox WHERE account_id = %L AND kind = ''chat_note_mention''', a_acct), '0');

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT241', MESSAGE = 'verify-conversation-notes rollback';
  EXCEPTION WHEN SQLSTATE 'ZT241' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'conversation notes verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'conversation notes verification passed (% checks)', n;
END
$verify$;
