-- Behavioural regression suite for the voice-note library (migration 242).
--
-- Every member of a workspace reads its library, entries are written
-- by the service role only (no client INSERT, so no foreign media_url or
-- colleague's storage_path), the author or an admin deletes, another
-- workspace sees nothing, and the fixed language and subject lists hold
-- in SQL. Library audio in chat-media/account-<id>/voice-library/ is
-- out of every client's reach for insert, update and delete, while a
-- staged composer upload still works. voice_library_audio_in_use()
-- finds a sent message by URL path, whatever the origin.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The fixtures are
-- rolled back by a sentinel exception; the collected results survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000242001';
  u_admin  UUID := '00000000-0000-4000-8000-000000242002';
  u_agent  UUID := '00000000-0000-4000-8000-000000242003';
  u_agent2 UUID := '00000000-0000-4000-8000-000000242004';
  u_view   UUID := '00000000-0000-4000-8000-000000242005';
  u_other  UUID := '00000000-0000-4000-8000-000000242006';
  a_acct   UUID;
  b_acct   UUID;
  e_agent  UUID := '00000000-0000-4000-8000-000000242101';
  e_agent2 UUID := '00000000-0000-4000-8000-000000242102';
  s_custom UUID := '00000000-0000-4000-8000-000000242201';
  e_stray  UUID := '00000000-0000-4000-8000-000000242103';
  e_lib1   UUID := '00000000-0000-4000-8000-000000242104';
  k_contact UUID := '00000000-0000-4000-8000-000000242301';
  k_conv   UUID := '00000000-0000-4000-8000-000000242302';
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.vn_try(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; c bigint;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        IF p_sql ILIKE 'select%' THEN
          EXECUTE p_sql INTO v;
        ELSE
          EXECUTE p_sql;
          GET DIAGNOSTICS c = ROW_COUNT;
          v := c::text;
        END IF;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(v, 'null');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR: ' || SQLERRM;
      END;
    END $body$
  $fn$;

  EXECUTE $fn$
    CREATE FUNCTION pg_temp.vn_raw(p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE c bigint;
    BEGIN
      EXECUTE p_sql;
      GET DIAGNOSTICS c = ROW_COUNT;
      RETURN c::text;
    EXCEPTION WHEN OTHERS THEN
      RETURN 'ERROR: ' || SQLERRM;
    END $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'voice242-owner@example.invalid'),
    (u_admin,  'voice242-admin@example.invalid'),
    (u_agent,  'voice242-agent@example.invalid'),
    (u_agent2, 'voice242-agent2@example.invalid'),
    (u_view,   'voice242-view@example.invalid'),
    (u_other,  'voice242-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  SELECT id INTO b_acct FROM accounts WHERE owner_user_id = u_other;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin'  WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent'  WHERE user_id IN (u_agent, u_agent2);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_view;

  -- No client inserts an entry, not even an agent with a sound row:
  -- media_url would be whatever the client says.
  r := pg_temp.vn_try(u_agent, format(
    'INSERT INTO voice_note_entries (id, account_id, builtin_subject, language, title, source, storage_path, media_url)
     VALUES (%L, %L, ''welcome'', ''en'', ''Hello'', ''recording'', %L, ''https://attacker.invalid/a.ogg'')',
    e_agent, a_acct, 'account-' || a_acct || '/voice-library/' || e_agent || '.ogg'));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN failed := array_append(failed, 'agent inserted an entry directly: ' || r); END IF;

  -- The route's service-role writes (fixtures).
  INSERT INTO voice_note_entries (id, account_id, builtin_subject, language, title, source, storage_path, media_url, created_by)
  VALUES (e_agent, a_acct, 'welcome', 'en', 'Hello', 'recording',
          'account-' || a_acct || '/voice-library/' || e_agent || '.ogg',
          'https://old-tunnel.invalid/storage/v1/object/public/chat-media/account-' || a_acct || '/voice-library/' || e_agent || '.ogg',
          u_agent);

  -- A second agent adds a subject (clients still may), stamped as them.
  r := pg_temp.vn_try(u_agent2, format(
    'INSERT INTO voice_note_subjects (id, account_id, label) VALUES (%L, %L, ''Bank visit'')',
    s_custom, a_acct));
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, 'agent cannot add a subject: ' || r); END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM voice_note_subjects WHERE id = s_custom AND created_by = u_agent2) THEN
    failed := array_append(failed, 'subject author not stamped'::text);
  END IF;
  r := pg_temp.vn_try(u_agent, format(
    'INSERT INTO voice_note_subjects (account_id, label, created_by) VALUES (%L, ''Spoof'', %L)', a_acct, u_agent2));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN failed := array_append(failed, 'agent added a subject as another person: ' || r); END IF;
  r := pg_temp.vn_try(u_view, format(
    'INSERT INTO voice_note_subjects (account_id, label) VALUES (%L, ''Viewer'')', a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN failed := array_append(failed, 'viewer added a subject: ' || r); END IF;

  INSERT INTO voice_note_entries (id, account_id, subject_id, language, title, source, script, personalised, created_by)
  VALUES (e_agent2, a_acct, s_custom, 'ar', 'Visit', 'tts', 'Hello {name}', true, u_agent2);

  -- Every member reads.
  r := pg_temp.vn_try(u_view, 'SELECT count(*) FROM voice_note_entries');
  n := n + 1;
  IF r <> '2' THEN failed := array_append(failed, 'viewer reads ' || r || ' entries, expected 2'); END IF;
  r := pg_temp.vn_try(u_view, 'SELECT count(*) FROM voice_note_subjects');
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, 'viewer reads ' || r || ' subjects, expected 1'); END IF;

  -- Viewer cannot insert.
  r := pg_temp.vn_try(u_view, format(
    'INSERT INTO voice_note_entries (account_id, builtin_subject, language, title, source, script, personalised)
     VALUES (%L, ''welcome'', ''en'', ''V'', ''tts'', ''Hi'', true)', a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN failed := array_append(failed, 'viewer inserted: ' || r); END IF;

  -- Nobody inserts in someone else's name.
  r := pg_temp.vn_try(u_agent, format(
    'INSERT INTO voice_note_entries (account_id, builtin_subject, language, title, source, script, personalised, created_by)
     VALUES (%L, ''welcome'', ''en'', ''Spoof'', ''tts'', ''Hi'', true, %L)', a_acct, u_agent2));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN failed := array_append(failed, 'agent inserted as another person: ' || r); END IF;

  -- Entries are never edited.
  r := pg_temp.vn_try(u_agent, format(
    'UPDATE voice_note_entries SET title = ''Changed'' WHERE id = %L', e_agent));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN failed := array_append(failed, 'author updated an entry: ' || r); END IF;

  -- The other workspace sees nothing and cannot insert into A.
  r := pg_temp.vn_try(u_other, 'SELECT count(*) FROM voice_note_entries');
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, 'other account reads ' || r || ' entries'); END IF;
  r := pg_temp.vn_try(u_other, 'SELECT count(*) FROM voice_note_subjects');
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, 'other account reads ' || r || ' subjects'); END IF;
  r := pg_temp.vn_try(u_other, format(
    'INSERT INTO voice_note_entries (account_id, builtin_subject, language, title, source, script, personalised)
     VALUES (%L, ''welcome'', ''en'', ''X'', ''tts'', ''Hi'', true)', a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN failed := array_append(failed, 'other account inserted into A: ' || r); END IF;
  r := pg_temp.vn_try(u_other, format('DELETE FROM voice_note_entries WHERE id = %L', e_agent));
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, 'other account deleted: ' || r); END IF;

  -- Another agent cannot delete it; the viewer neither.
  r := pg_temp.vn_try(u_agent2, format('DELETE FROM voice_note_entries WHERE id = %L', e_agent));
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, 'another agent deleted: ' || r); END IF;
  r := pg_temp.vn_try(u_view, format('DELETE FROM voice_note_entries WHERE id = %L', e_agent));
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, 'viewer deleted: ' || r); END IF;

  -- A used subject cannot be deleted.
  r := pg_temp.vn_try(u_admin, format('DELETE FROM voice_note_subjects WHERE id = %L', s_custom));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN failed := array_append(failed, 'a used subject was deleted: ' || r); END IF;

  -- The author deletes their own; an admin deletes anyone's.
  r := pg_temp.vn_try(u_agent2, format('DELETE FROM voice_note_entries WHERE id = %L', e_agent2));
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, 'author cannot delete own entry: ' || r); END IF;
  r := pg_temp.vn_try(u_admin, format('DELETE FROM voice_note_entries WHERE id = %L', e_agent));
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, 'admin cannot delete any entry: ' || r); END IF;

  -- Fixed lists and shapes (as the service role writes them).
  r := pg_temp.vn_raw(format(
    'INSERT INTO voice_note_entries (account_id, builtin_subject, language, title, source, script, personalised)
     VALUES (%L, ''welcome'', ''fr'', ''Fr'', ''tts'', ''Bonjour'', true)', a_acct));
  n := n + 1;
  IF r NOT LIKE '%voice_note_entries_language_check%' THEN
    failed := array_append(failed, 'unknown language accepted: ' || r);
  END IF;
  r := pg_temp.vn_raw(format(
    'INSERT INTO voice_note_entries (account_id, builtin_subject, language, title, source, script, personalised)
     VALUES (%L, ''pricing'', ''en'', ''P'', ''tts'', ''Hi'', true)', a_acct));
  n := n + 1;
  IF r NOT LIKE '%voice_note_entries_builtin_subject_check%' THEN
    failed := array_append(failed, 'unknown built-in subject accepted: ' || r);
  END IF;
  r := pg_temp.vn_raw(format(
    'INSERT INTO voice_note_entries (account_id, builtin_subject, language, title, source, storage_path, media_url)
     VALUES (%L, ''welcome'', ''en'', ''Path'', ''recording'', %L, ''https://x.invalid/b.ogg'')',
    a_acct, 'account-' || b_acct || '/voice-library/x.ogg'));
  n := n + 1;
  IF r NOT LIKE '%voice_note_entries_audio_check%' THEN
    failed := array_append(failed, 'another account''s storage path accepted: ' || r);
  END IF;
  -- Another entry's object, in the right account, is not this entry's.
  r := pg_temp.vn_raw(format(
    'INSERT INTO voice_note_entries (account_id, builtin_subject, language, title, source, storage_path, media_url)
     VALUES (%L, ''welcome'', ''en'', ''Steal'', ''recording'', %L, %L)',
    a_acct, 'account-' || a_acct || '/voice-library/' || e_agent || '.ogg',
    'https://x.invalid/storage/v1/object/public/chat-media/account-' || a_acct || '/voice-library/' || e_agent || '.ogg'));
  n := n + 1;
  IF r NOT LIKE '%voice_note_entries_own_audio_check%' THEN
    failed := array_append(failed, 'an entry pointing at another entry''s object was accepted: ' || r);
  END IF;
  -- Its own path, but a URL to somewhere else.
  r := pg_temp.vn_raw(format(
    'INSERT INTO voice_note_entries (id, account_id, builtin_subject, language, title, source, storage_path, media_url)
     VALUES (%L, %L, ''welcome'', ''en'', ''Url'', ''recording'', %L, ''https://attacker.invalid/a.ogg'')',
    e_stray, a_acct, 'account-' || a_acct || '/voice-library/' || e_stray || '.ogg'));
  n := n + 1;
  IF r NOT LIKE '%voice_note_entries_own_audio_check%' THEN
    failed := array_append(failed, 'a media_url not pointing at the entry''s path was accepted: ' || r);
  END IF;

  -- ---------- library audio in chat-media ----------
  INSERT INTO storage.objects (bucket_id, name) VALUES
    ('chat-media', 'account-' || a_acct || '/voice-library/' || e_lib1 || '.ogg'),
    ('chat-media', 'account-' || a_acct || '/staged/1-voice242.ogg');

  r := pg_temp.vn_try(u_view, format(
    'DELETE FROM storage.objects WHERE bucket_id = ''chat-media'' AND name = %L',
    'account-' || a_acct || '/voice-library/' || e_lib1 || '.ogg'));
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, 'viewer deleted library audio: ' || r); END IF;
  r := pg_temp.vn_try(u_agent2, format(
    'DELETE FROM storage.objects WHERE bucket_id = ''chat-media'' AND name = %L',
    'account-' || a_acct || '/voice-library/' || e_lib1 || '.ogg'));
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, 'non-author agent deleted library audio: ' || r); END IF;
  r := pg_temp.vn_try(u_admin, format(
    'DELETE FROM storage.objects WHERE bucket_id = ''chat-media'' AND name = %L',
    'account-' || a_acct || '/voice-library/' || e_lib1 || '.ogg'));
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, 'an admin''s client deleted library audio (the route does that): ' || r); END IF;
  r := pg_temp.vn_try(u_agent2, format(
    'UPDATE storage.objects SET metadata = ''{"x":1}'' WHERE bucket_id = ''chat-media'' AND name = %L',
    'account-' || a_acct || '/voice-library/' || e_lib1 || '.ogg'));
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, 'agent overwrote library audio: ' || r); END IF;
  r := pg_temp.vn_try(u_view, format(
    'UPDATE storage.objects SET name = %L WHERE bucket_id = ''chat-media'' AND name = %L',
    'account-' || a_acct || '/voice-library/moved.ogg', 'account-' || a_acct || '/staged/1-voice242.ogg'));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' AND r <> '0' THEN
    failed := array_append(failed, 'viewer moved an object into the library: ' || r);
  END IF;
  r := pg_temp.vn_try(u_agent, format(
    'INSERT INTO storage.objects (bucket_id, name) VALUES (''chat-media'', %L)',
    'account-' || a_acct || '/voice-library/' || e_stray || '.ogg'));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN failed := array_append(failed, 'agent uploaded into the library: ' || r); END IF;
  r := pg_temp.vn_try(u_view, format(
    'INSERT INTO storage.objects (bucket_id, name) VALUES (''chat-media'', %L)',
    'account-' || a_acct || '/voice-library/' || e_stray || '.ogg'));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN failed := array_append(failed, 'viewer uploaded into the library: ' || r); END IF;
  n := n + 1;
  IF (SELECT count(*) FROM storage.objects
       WHERE bucket_id = 'chat-media' AND name = 'account-' || a_acct || '/voice-library/' || e_lib1 || '.ogg'
         AND metadata IS NULL) <> 1 THEN
    failed := array_append(failed, 'library audio changed or went'::text);
  END IF;
  -- A normal composer upload still works.
  r := pg_temp.vn_try(u_agent, format(
    'INSERT INTO storage.objects (bucket_id, name) VALUES (''chat-media'', %L)',
    'account-' || a_acct || '/staged/2-voice242.ogg'));
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, 'agent cannot stage an upload: ' || r); END IF;
  r := pg_temp.vn_try(u_agent, format(
    'DELETE FROM storage.objects WHERE bucket_id = ''chat-media'' AND name = %L',
    'account-' || a_acct || '/staged/2-voice242.ogg'));
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, 'agent cannot delete a staged upload: ' || r); END IF;

  -- ---------- is a library object still in a sent message? ----------
  INSERT INTO contacts (id, account_id, user_id, phone, name)
  VALUES (k_contact, a_acct, u_agent, '971500242001', 'Voice one');
  INSERT INTO conversations (id, account_id, user_id, contact_id)
  VALUES (k_conv, a_acct, u_agent, k_contact);
  INSERT INTO messages (conversation_id, sender_type, content_type, media_url)
  VALUES (k_conv, 'agent', 'audio',
          'https://new-tunnel.invalid/storage/v1/object/public/chat-media/account-' || a_acct
          || '/voice-library/' || e_agent || '.ogg?t=1');
  n := n + 1;
  IF NOT voice_library_audio_in_use(a_acct, 'account-' || a_acct || '/voice-library/' || e_agent || '.ogg') THEN
    failed := array_append(failed, 'a sent library voice note (other origin) was not found'::text);
  END IF;
  n := n + 1;
  IF voice_library_audio_in_use(a_acct, 'account-' || a_acct || '/voice-library/' || e_lib1 || '.ogg') THEN
    failed := array_append(failed, 'an unsent library object reads as in use'::text);
  END IF;
  n := n + 1;
  IF voice_library_audio_in_use(b_acct, 'account-' || b_acct || '/voice-library/' || e_agent || '.ogg') THEN
    failed := array_append(failed, 'another account''s message counted'::text);
  END IF;
  n := n + 1;
  IF NOT voice_library_audio_in_use(a_acct, 'account-' || a_acct || '/voice-library/%.ogg') THEN
    failed := array_append(failed, 'an odd path was not kept as in use'::text);
  END IF;
  n := n + 1;
  IF has_function_privilege('authenticated', 'public.voice_library_audio_in_use(uuid, text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.voice_library_audio_in_use(uuid, text)', 'EXECUTE') THEN
    failed := array_append(failed, 'voice_library_audio_in_use grants wrong'::text);
  END IF;

  -- Bank guests and anon get nothing.
  n := n + 1;
  IF has_table_privilege('anon', 'public.voice_note_entries', 'SELECT')
     OR has_table_privilege('anon', 'public.voice_note_subjects', 'SELECT')
     OR has_table_privilege('authenticated', 'public.voice_note_entries', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.voice_note_entries', 'INSERT') THEN
    failed := array_append(failed, 'grants too wide'::text);
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZT242', MESSAGE = 'verify-voice-note-library rollback';
  EXCEPTION WHEN SQLSTATE 'ZT242' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'voice-note library verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'voice-note library verification passed (% checks)', n;
END
$verify$;
