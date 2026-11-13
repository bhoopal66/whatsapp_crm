-- Behavioural regression suite for member deactivation (migrations 069,
-- 199: off the team and the PBX extension).
--
-- Asserts what a deactivated member can still do with an access token
-- issued before the deactivation (nothing), who may deactivate whom,
-- and that reactivation gives access back. The Supabase Auth ban that
-- refuses the sign-in itself lives in the API route and is covered by
-- vitest; this is the half that lives in SQL.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-0000000de001';
  u_admin  UUID := '00000000-0000-4000-8000-0000000de002';
  u_admin2 UUID := '00000000-0000-4000-8000-0000000de003';
  u_agent  UUID := '00000000-0000-4000-8000-0000000de004';
  u_other  UUID := '00000000-0000-4000-8000-0000000de005';
  a_acct   UUID;
  b_acct   UUID;
  ct       UUID;
  tm_id    UUID;  -- 199: a team in A, led by admin2, with the agent on it
  pc_a     UUID;  -- 199: a PBX connection in A, and one in B
  pc_b     UUID;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  -- Run a statement as a signed-in user; 'ok' / the value, or the error.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.md_try(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
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
        END IF;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(nullif(v, ''), 'ok');  -- a void RPC casts to ''
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR: ' || SQLERRM;
      END;
    END $body$
  $fn$;

  -- Fixture: account A (owner, two admins, an agent), account B (owner).
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'md-owner@example.invalid'),
    (u_admin,  'md-admin@example.invalid'),
    (u_admin2, 'md-admin2@example.invalid'),
    (u_agent,  'md-agent@example.invalid'),
    (u_other,  'md-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_other;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id IN (u_admin, u_admin2);
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent;

  -- One contact + conversation the agent owns, so RLS lets them see it.
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_agent, '971500009901', 'MD contact')
  RETURNING id INTO ct;
  INSERT INTO conversations (account_id, user_id, contact_id)
  VALUES (a_acct, u_agent, ct);

  -- 199 fixture: the agent is on a team admin2 leads and holds an
  -- extension; B's owner holds one in B (another workspace, untouched).
  INSERT INTO teams (account_id, name, leader_user_id)
  VALUES (a_acct, 'MD team', u_admin2) RETURNING id INTO tm_id;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (tm_id, u_agent, a_acct);
  INSERT INTO pbx_connections (account_id, label, edition, base_url)
  VALUES (a_acct, 'MD pbx A', 'cloud', 'https://md-a.example.invalid') RETURNING id INTO pc_a;
  INSERT INTO pbx_connections (account_id, label, edition, base_url)
  VALUES (b_acct, 'MD pbx B', 'cloud', 'https://md-b.example.invalid') RETURNING id INTO pc_b;
  INSERT INTO pbx_extensions (connection_id, extension, account_id, user_id, softphone_enabled)
  VALUES (pc_a, '9101', a_acct, u_agent, true),
         (pc_a, '9102', a_acct, u_admin, true),
         (pc_b, '9201', b_acct, u_other, true);

  -- Baseline: the active agent sees their chat.
  r := pg_temp.md_try(u_agent, 'SELECT count(*)::text FROM conversations');
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, ('active agent sees ' || r || ' chats')::text); END IF;

  -- Who may NOT deactivate.
  r := pg_temp.md_try(u_agent, format('SELECT set_member_active(%L, false)::text', u_admin));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN failed := array_append(failed, 'an agent deactivated an admin'::text); END IF;

  r := pg_temp.md_try(u_admin, format('SELECT set_member_active(%L, false)::text', u_owner));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN failed := array_append(failed, 'the owner was deactivated'::text); END IF;

  r := pg_temp.md_try(u_admin, format('SELECT set_member_active(%L, false)::text', u_admin));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN failed := array_append(failed, 'an admin deactivated themselves'::text); END IF;

  r := pg_temp.md_try(u_other, format('SELECT set_member_active(%L, false)::text', u_agent));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN failed := array_append(failed, 'another account deactivated A''s agent'::text); END IF;

  -- Nobody writes the flag directly, not even on their own row.
  r := pg_temp.md_try(u_agent, format(
         'UPDATE profiles SET deactivated_at = NULL, full_name = full_name WHERE user_id = %L', u_agent));
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('own-profile no-op update refused: ' || r)::text); END IF;
  r := pg_temp.md_try(u_agent, format(
         'UPDATE profiles SET deactivated_at = now() WHERE user_id = %L', u_agent));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN failed := array_append(failed, 'a member set deactivated_at directly'::text); END IF;

  -- Deactivate the agent.
  r := pg_temp.md_try(u_admin, format('SELECT set_member_active(%L, false)::text', u_agent));
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('admin could not deactivate the agent: ' || r)::text); END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = u_agent
                 AND deactivated_at IS NOT NULL AND deactivated_by = u_admin) THEN
    failed := array_append(failed, 'deactivated_at / deactivated_by not stamped'::text);
  END IF;

  -- 199: off the team, extension unmapped; the team, its leader and
  -- everyone else's extensions stay.
  n := n + 1;
  IF EXISTS (SELECT 1 FROM team_members WHERE user_id = u_agent) THEN
    failed := array_append(failed, '199: deactivated agent still on their team'::text);
  END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM teams WHERE id = tm_id AND leader_user_id = u_admin2) THEN
    failed := array_append(failed, '199: deactivating a member changed the team or its leader'::text);
  END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM pbx_extensions WHERE connection_id = pc_a AND extension = '9101'
                 AND user_id IS NULL AND NOT softphone_enabled) THEN
    failed := array_append(failed, '199: deactivated agent''s extension still mapped'::text);
  END IF;
  n := n + 1;
  IF (SELECT count(*) FROM pbx_extensions
       WHERE (extension = '9102' AND user_id = u_admin AND softphone_enabled)
          OR (extension = '9201' AND user_id = u_other AND softphone_enabled)) <> 2 THEN
    failed := array_append(failed, '199: another person''s extension was unmapped'::text);
  END IF;

  -- A leftover token now reads nothing and writes nothing.
  r := pg_temp.md_try(u_agent, 'SELECT count(*)::text FROM conversations');
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, ('deactivated agent still sees ' || r || ' chats')::text); END IF;
  r := pg_temp.md_try(u_agent, 'SELECT count(*)::text FROM contacts');
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, ('deactivated agent still sees ' || r || ' contacts')::text); END IF;
  r := pg_temp.md_try(u_agent, format('SELECT is_account_member(%L)::text', a_acct));
  n := n + 1;
  IF r <> 'false' THEN failed := array_append(failed, 'is_account_member still true for a deactivated agent'::text); END IF;
  r := pg_temp.md_try(u_agent, 'SELECT coalesce(current_account_id()::text, ''null'') || '':'' || current_role_rank()::text');
  n := n + 1;
  IF r <> 'null:0' THEN failed := array_append(failed, ('current_account_id/role_rank for a deactivated agent: ' || r)::text); END IF;
  r := pg_temp.md_try(u_agent, format(
         'UPDATE profiles SET full_name = ''x'' WHERE user_id = %L', u_agent));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN failed := array_append(failed, 'a deactivated member edited their profile'::text); END IF;
  -- They can still read their own profile, which is how the app tells
  -- them why they were signed out.
  r := pg_temp.md_try(u_agent, format(
         'SELECT (deactivated_at IS NOT NULL)::text FROM profiles WHERE user_id = %L', u_agent));
  n := n + 1;
  IF r <> 'true' THEN failed := array_append(failed, ('deactivated member cannot read own profile: ' || r)::text); END IF;

  -- The rest of the account is unaffected.
  r := pg_temp.md_try(u_admin, 'SELECT count(*)::text FROM conversations');
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, ('admin sees ' || r || ' chats after deactivating the agent')::text); END IF;

  -- A deactivated ADMIN's leftover token cannot manage members: the
  -- 018 RPCs read the caller's role from profiles directly, and the
  -- profile guard is what stops them.
  r := pg_temp.md_try(u_admin, format('SELECT set_member_active(%L, false)::text', u_admin2));
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('admin could not deactivate admin2: ' || r)::text); END IF;
  -- Matched on the message, not just "an error": a refusal for some
  -- other reason would pass vacuously.
  r := pg_temp.md_try(u_admin2, format('SELECT set_member_role(%L, ''viewer'')::text', u_admin));
  n := n + 1;
  IF r NOT LIKE '%has been deactivated%' THEN
    failed := array_append(failed, ('deactivated admin changing a role: ' || r)::text);
  END IF;
  r := pg_temp.md_try(u_admin2, format('SELECT set_member_active(%L, true)::text', u_agent));
  n := n + 1;
  IF r NOT LIKE '%has been deactivated%' THEN
    failed := array_append(failed, ('deactivated admin reactivating someone: ' || r)::text);
  END IF;

  -- 199: a deactivated leader leaves the team leaderless; the team stays.
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM teams WHERE id = tm_id AND leader_user_id IS NULL) THEN
    failed := array_append(failed, '199: deactivated admin2 still leads the team'::text);
  END IF;

  -- Idempotent: deactivating again keeps the original author.
  r := pg_temp.md_try(u_owner, format('SELECT set_member_active(%L, false)::text', u_agent));
  n := n + 1;
  IF r <> 'ok' OR NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = u_agent AND deactivated_by = u_admin) THEN
    failed := array_append(failed, ('repeat deactivation rewrote the author: ' || r)::text);
  END IF;

  -- Reactivation gives access back.
  r := pg_temp.md_try(u_admin, format('SELECT set_member_active(%L, true)::text', u_agent));
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('admin could not reactivate the agent: ' || r)::text); END IF;
  r := pg_temp.md_try(u_agent, 'SELECT count(*)::text FROM conversations');
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, ('reactivated agent sees ' || r || ' chats')::text); END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM profiles WHERE user_id = u_agent
             AND (deactivated_at IS NOT NULL OR deactivated_by IS NOT NULL)) THEN
    failed := array_append(failed, 'reactivation left deactivated_at / deactivated_by set'::text);
  END IF;

  -- 199: reactivation restores neither the team nor the extension.
  n := n + 1;
  IF EXISTS (SELECT 1 FROM team_members WHERE user_id = u_agent)
     OR EXISTS (SELECT 1 FROM pbx_extensions WHERE user_id = u_agent) THEN
    failed := array_append(failed, '199: reactivation put the agent back on a team or extension'::text);
  END IF;
  n := n + 1;
  IF has_function_privilege('authenticated', 'public.deactivated_member_cleanup(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.deactivated_member_cleanup(uuid, uuid)', 'EXECUTE') THEN
    failed := array_append(failed, '199: a client role may call deactivated_member_cleanup'::text);
  END IF;

  n := n + 1;
  IF has_function_privilege('anon', 'public.set_member_active(uuid, boolean)', 'EXECUTE') THEN
    failed := array_append(failed, 'anon may call set_member_active'::text);
  END IF;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'member deactivation verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'member deactivation verification passed (% checks)', n;
END
$verify$;
