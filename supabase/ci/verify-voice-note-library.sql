-- Behavioural regression suite for the voice-note library (migration 242).
--
-- Every member of a workspace reads its library, agents and up add to
-- it, the author or an admin deletes, another workspace sees nothing,
-- and the fixed language and subject lists hold in SQL.
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

  -- Agent adds a recording entry.
  r := pg_temp.vn_try(u_agent, format(
    'INSERT INTO voice_note_entries (id, account_id, builtin_subject, language, title, source, storage_path, media_url)
     VALUES (%L, %L, ''welcome'', ''en'', ''Hello'', ''recording'', %L, ''https://x.invalid/a.ogg'')',
    e_agent, a_acct, 'account-' || a_acct || '/voice-library/' || e_agent || '.ogg'));
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, 'agent cannot insert: ' || r); END IF;

  -- A second agent adds a personalised TTS entry under a new subject.
  r := pg_temp.vn_try(u_agent2, format(
    'INSERT INTO voice_note_subjects (id, account_id, label) VALUES (%L, %L, ''Bank visit'')',
    s_custom, a_acct));
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, 'agent cannot add a subject: ' || r); END IF;
  r := pg_temp.vn_try(u_agent2, format(
    'INSERT INTO voice_note_entries (id, account_id, subject_id, language, title, source, script, personalised)
     VALUES (%L, %L, %L, ''ar'', ''Visit'', ''tts'', ''Hello {name}'', true)',
    e_agent2, a_acct, s_custom));
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, 'agent cannot insert a personalised entry: ' || r); END IF;

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

  -- Fixed lists and shapes.
  r := pg_temp.vn_try(u_agent, format(
    'INSERT INTO voice_note_entries (account_id, builtin_subject, language, title, source, script, personalised)
     VALUES (%L, ''welcome'', ''fr'', ''Fr'', ''tts'', ''Bonjour'', true)', a_acct));
  n := n + 1;
  IF r NOT LIKE '%voice_note_entries_language_check%' THEN
    failed := array_append(failed, 'unknown language accepted: ' || r);
  END IF;
  r := pg_temp.vn_try(u_agent, format(
    'INSERT INTO voice_note_entries (account_id, builtin_subject, language, title, source, script, personalised)
     VALUES (%L, ''pricing'', ''en'', ''P'', ''tts'', ''Hi'', true)', a_acct));
  n := n + 1;
  IF r NOT LIKE '%voice_note_entries_builtin_subject_check%' THEN
    failed := array_append(failed, 'unknown built-in subject accepted: ' || r);
  END IF;
  r := pg_temp.vn_try(u_agent, format(
    'INSERT INTO voice_note_entries (account_id, builtin_subject, language, title, source, storage_path, media_url)
     VALUES (%L, ''welcome'', ''en'', ''Path'', ''recording'', %L, ''https://x.invalid/b.ogg'')',
    a_acct, 'account-' || b_acct || '/voice-library/x.ogg'));
  n := n + 1;
  IF r NOT LIKE '%voice_note_entries_audio_check%' THEN
    failed := array_append(failed, 'another account''s storage path accepted: ' || r);
  END IF;

  -- Bank guests and anon get nothing.
  n := n + 1;
  IF has_table_privilege('anon', 'public.voice_note_entries', 'SELECT')
     OR has_table_privilege('anon', 'public.voice_note_subjects', 'SELECT')
     OR has_table_privilege('authenticated', 'public.voice_note_entries', 'UPDATE') THEN
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
