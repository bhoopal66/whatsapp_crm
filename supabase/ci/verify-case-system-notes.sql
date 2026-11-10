-- Behavioural regression suite for system-authored case notes
-- (migration 179).
--
-- case_note_add_system stores a note with author_id NULL and
-- system_author set, resolves @<uuid> mentions exactly as case_note_add
-- (only people who may act on the case), and refuses an unknown system
-- writer, an unknown case and a blank or overlong body with
-- case_note_add's hints. No API role (anon, authenticated, the service
-- role) may execute it. A direct INSERT must carry exactly one of
-- author_id / system_author. Staff notes behave as before, and nobody
-- edits or deletes a system note (append-only, no write grant).
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The fixtures are
-- rolled back on success too (a sentinel exception ends the block).

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000179001';
  u_coord  UUID := '00000000-0000-4000-8000-000000179002';  -- agent, coordinator on the case
  u_agent  UUID := '00000000-0000-4000-8000-000000179003';  -- agent of the case
  u_viewer UUID := '00000000-0000-4000-8000-000000179004';
  a_acct   UUID;
  wa       UUID;
  ca       UUID;
  g1       UUID;
  k1       UUID;
  ns       UUID;
  nt       UUID;
  t0       TIMESTAMPTZ := '2026-01-01 00:00:00+00';
  r        TEXT;
  rl       TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sn_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; h text;
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
        GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ' ' || coalesce(nullif(h, ''), '-') || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sn_check(p_name text, p_role text, p_uid uuid, p_sql text, p_like text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := pg_temp.sn_try(p_role, p_uid, p_sql);
    BEGIN
      RETURN CASE WHEN v LIKE p_like THEN NULL ELSE p_name || ' (' || v || ')' END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sn_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'sn-owner@example.invalid'),
    (u_coord,  'sn-coord@example.invalid'),
    (u_agent,  'sn-agent@example.invalid'),
    (u_viewer, 'sn-viewer@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_coord, u_agent);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_viewer;

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'SN-179-A1', 'x', 'connected', true) RETURNING id INTO wa;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500179001', 'SN one')
    RETURNING id INTO ca;
  g1 := (SELECT x.group_id FROM sg_open(a_acct, 'SN-179-1', ca, wa, 'system notes', NULL,
    jsonb_build_array(jsonb_build_object('user_id', u_coord, 'label', 'coordinator'),
                      jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL) x);
  k1 := (SELECT x.case_id FROM case_open(g1, 'ADCB', 'ADCB Bank', 'Loan', 1000, NULL) x);
  IF g1 IS NULL OR k1 IS NULL THEN
    RAISE EXCEPTION 'fixture: sg_open / case_open returned nothing';
  END IF;

  -- ---------- a system note, as the table owner ----------
  ns := case_note_add_system(k1, 'system:files',
    'cc @' || u_coord::text || '. and @' || u_viewer::text || ' and @junk: trade licence failed its checks', t0);
  n := n + 1; failed := failed || pg_temp.sn_ok(
    ns IS NOT NULL
    AND (SELECT author_id IS NULL AND system_author = 'system:files' AND case_id = k1 AND account_id = a_acct
                AND created_at = t0
           FROM case_notes WHERE id = ns),
    'case_note_add_system did not store a note with author_id NULL and system_author system:files');
  n := n + 1; failed := failed || pg_temp.sn_ok(
    (SELECT array_agg(user_id ORDER BY user_id) FROM case_note_mentions WHERE note_id = ns) = ARRAY[u_coord],
    'case_note_add_system mentions are not exactly the coordinator (the viewer and junk must be ignored)');
  -- assigned first: a subquery in the same expression reads the snapshot
  -- taken before the call
  nt := case_note_add_system(k1, 'system:rules', 'rule fired', NULL);
  n := n + 1; failed := failed || pg_temp.sn_ok(
    (SELECT system_author FROM case_notes WHERE id = nt) = 'system:rules',
    'case_note_add_system refused system:rules');

  -- refusals, with case_note_add's hints
  n := n + 1; failed := failed || pg_temp.sn_check('unknown system writer is accepted', NULL, NULL,
    format('SELECT case_note_add_system(%L, %L, %L, NULL)::text', k1, 'system:other', 'x'), 'ERROR 23514 SYSTEM_AUTHOR_INVALID:%');
  n := n + 1; failed := failed || pg_temp.sn_check('NULL system writer is accepted', NULL, NULL,
    format('SELECT case_note_add_system(%L, NULL, %L, NULL)::text', k1, 'x'), 'ERROR 23514 SYSTEM_AUTHOR_INVALID:%');
  n := n + 1; failed := failed || pg_temp.sn_check('unknown case is accepted', NULL, NULL,
    format('SELECT case_note_add_system(%L, %L, %L, NULL)::text', gen_random_uuid(), 'system:files', 'x'),
    'ERROR P0002 CASE_NOT_FOUND:%');
  n := n + 1; failed := failed || pg_temp.sn_check('blank system note is accepted', NULL, NULL,
    format('SELECT case_note_add_system(%L, %L, %L, NULL)::text', k1, 'system:files', E' \n\t '), 'ERROR 23514 NOTE_EMPTY:%');
  n := n + 1; failed := failed || pg_temp.sn_check('overlong system note is accepted', NULL, NULL,
    format('SELECT case_note_add_system(%L, %L, %L, NULL)::text', k1, 'system:files', repeat('x', 10001)),
    'ERROR 23514 NOTE_TOO_LONG:%');

  -- no API role executes it
  SELECT string_agg(rl2, ',' ORDER BY rl2) INTO r FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) rl2
   WHERE has_function_privilege(rl2, 'public.case_note_add_system(uuid, text, text, timestamptz)', 'EXECUTE');
  n := n + 1; failed := failed || pg_temp.sn_ok(r IS NULL,
    format('an API role may execute case_note_add_system (%s)', r));
  FOREACH rl IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    n := n + 1; failed := failed || pg_temp.sn_check(rl || ' ran case_note_add_system', rl, u_agent,
      format('SELECT case_note_add_system(%L, %L, %L, NULL)::text', k1, 'system:files', 'x'), 'ERROR 42501 %');
  END LOOP;

  -- ---------- exactly one author on a direct INSERT ----------
  n := n + 1; failed := failed || pg_temp.sn_check(
    'a note with both a person and a system author was accepted', NULL, NULL,
    format('INSERT INTO case_notes (case_id, account_id, author_id, system_author, body) VALUES (%L, %L, %L, %L, %L)',
           k1, a_acct, u_agent, 'system:files', 'both'),
    'ERROR 23514 %case_notes_one_author_check%');
  n := n + 1; failed := failed || pg_temp.sn_check(
    'a note with neither a person nor a system author was accepted', NULL, NULL,
    format('INSERT INTO case_notes (case_id, account_id, author_id, system_author, body) VALUES (%L, %L, NULL, NULL, %L)',
           k1, a_acct, 'neither'),
    'ERROR 23514 %case_notes_one_author_check%');
  n := n + 1; failed := failed || pg_temp.sn_check(
    'a note with an unknown system author was accepted', NULL, NULL,
    format('INSERT INTO case_notes (case_id, account_id, system_author, body) VALUES (%L, %L, %L, %L)',
           k1, a_acct, 'system:other', 'other'),
    'ERROR 23514 %case_notes_system_author_check%');

  -- ---------- staff notes as before ----------
  nt := (SELECT x.note_id FROM case_note_add(k1, u_agent, 'thanks @' || u_coord::text, t0) x);
  n := n + 1; failed := failed || pg_temp.sn_ok(
    (SELECT author_id = u_agent AND system_author IS NULL FROM case_notes WHERE id = nt)
    AND (SELECT array_agg(user_id) FROM case_note_mentions WHERE note_id = nt) = ARRAY[u_coord],
    'case_note_add no longer stores the person as author with system_author NULL');
  n := n + 1; failed := failed || pg_temp.sn_check('a viewer added a staff note', NULL, NULL,
    format('SELECT note_id::text FROM case_note_add(%L, %L, %L, NULL)', k1, u_viewer, 'x'), 'ERROR 42501 NOT_ALLOWED:%');
  n := n + 1; failed := failed || pg_temp.sn_ok(
    (SELECT count(*) FROM case_timeline(u_agent, k1) e WHERE e.kind = 'note' AND e.actor IS NULL) = 2
    AND (SELECT count(*) FROM case_timeline(u_agent, k1) e WHERE e.kind = 'note' AND e.actor = u_agent) = 1,
    'case_timeline does not list the system notes with actor NULL beside the staff note');

  -- ---------- reading, and nobody edits or deletes a system note ----------
  n := n + 1; failed := failed || pg_temp.sn_check('the case agent cannot read the system note', 'authenticated', u_agent,
    format('SELECT system_author FROM case_notes WHERE id = %L', ns), 'system:files');
  n := n + 1; failed := failed || pg_temp.sn_check('a viewer reads the system note', 'authenticated', u_viewer,
    format('SELECT count(*)::text FROM case_notes WHERE id = %L', ns), '0');
  FOREACH rl IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
    n := n + 1; failed := failed || pg_temp.sn_check(rl || ' edited a system note', rl, u_agent,
      format('UPDATE case_notes SET body = %L, author_id = %L, system_author = NULL WHERE id = %L', 'mine', u_agent, ns),
      'ERROR 42501 %');
    n := n + 1; failed := failed || pg_temp.sn_check(rl || ' deleted a system note', rl, u_agent,
      format('DELETE FROM case_notes WHERE id = %L', ns), 'ERROR 42501 %');
  END LOOP;
  -- the append-only trigger binds the owner too
  n := n + 1; failed := failed || pg_temp.sn_check('the table owner edited a system note', NULL, NULL,
    format('UPDATE case_notes SET author_id = %L, system_author = NULL WHERE id = %L', u_agent, ns), 'ERROR %');
  n := n + 1; failed := failed || pg_temp.sn_check('the table owner deleted a system note', NULL, NULL,
    format('DELETE FROM case_notes WHERE id = %L', ns), 'ERROR %');
  n := n + 1; failed := failed || pg_temp.sn_ok(
    (SELECT author_id IS NULL AND system_author = 'system:files' FROM case_notes WHERE id = ns),
    'the system note changed');

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT179', MESSAGE = 'verify-case-system-notes rollback';
  EXCEPTION WHEN SQLSTATE 'ZT179' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'case system notes verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'case system notes verification passed (% checks)', n;
END
$verify$;
