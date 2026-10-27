-- Behavioural regression suite for member password changes (migration 140).
--
-- authorize_member_password_change() is the whole authorisation of
-- POST /api/account/members/[userId]/password: the route asks GoTrue for
-- the change only after it returns. This asserts who may set whose
-- password: a live owner or admin of their active workspace, never their
-- own, for someone they strictly outrank there (deactivated or not) and,
-- because one login opens every workspace it belongs to, in every other
-- workspace the person has a row in, where the caller needs a live
-- owner/admin row that outranks them. Also that the check writes
-- nothing, and that log_member_password_change() writes one
-- password_changed row in every workspace the person belongs to and is
-- the service role's alone. The GoTrue call is the route's, covered by
-- vitest.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_own   UUID := '00000000-0000-4000-8000-000000140001';  -- owner of A
  u_adm   UUID := '00000000-0000-4000-8000-000000140002';  -- admin of A: the caller
  u_adm2  UUID := '00000000-0000-4000-8000-000000140003';  -- another admin of A
  u_tl    UUID := '00000000-0000-4000-8000-000000140004';  -- team leader of A
  u_agt   UUID := '00000000-0000-4000-8000-000000140005';  -- agent of A
  u_vwr   UUID := '00000000-0000-4000-8000-000000140006';  -- viewer of A
  u_gst   UUID := '00000000-0000-4000-8000-000000140007';  -- bank guest of A
  u_mul   UUID := '00000000-0000-4000-8000-000000140008';  -- agent of A, also a member of B
  u_ob    UUID := '00000000-0000-4000-8000-000000140009';  -- owner of B
  u_oc    UUID := '00000000-0000-4000-8000-000000140012';  -- owner of C
  u_out   UUID := '00000000-0000-4000-8000-000000140010';  -- a login with no row in A
  u_dadm  UUID := '00000000-0000-4000-8000-000000140011';  -- admin of A, deactivated
  u_none  UUID := '00000000-0000-4000-8000-000000140099';  -- no login at all
  a_acct  UUID;
  b_acct  UUID;
  c_acct  UUID;
  snap    TEXT;
  r       TEXT;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (a signed-in user when p_uid is given);
  -- 'ok', or the error as 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.mp_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', p_role)::text, true);
        EXECUTE format('SET LOCAL ROLE %I', p_role);
        EXECUTE p_sql;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ok';
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;

  -- authorize_member_password_change(p_target) as p_caller.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.mp_auth(p_caller uuid, p_target uuid)
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.mp_try('authenticated', p_caller,
        format('SELECT public.authorize_member_password_change(%L)', p_target))
    $body$
  $fn$;

  -- Fixture: each auth user gets a personal account and its owner row;
  -- the rows are then moved into A with their roles.
  INSERT INTO auth.users (id, email) VALUES
    (u_own,  'mp-owner@example.invalid'),
    (u_adm,  'mp-admin@example.invalid'),
    (u_adm2, 'mp-admin2@example.invalid'),
    (u_tl,   'mp-leader@example.invalid'),
    (u_agt,  'mp-agent@example.invalid'),
    (u_vwr,  'mp-viewer@example.invalid'),
    (u_gst,  'mp-guest@example.invalid'),
    (u_mul,  'mp-multi@example.invalid'),
    (u_ob,   'mp-owner-b@example.invalid'),
    (u_oc,   'mp-owner-c@example.invalid'),
    (u_out,  'mp-outsider@example.invalid'),
    (u_dadm, 'mp-admin-off@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_own;
  SELECT id INTO b_acct FROM accounts WHERE owner_user_id = u_ob;
  SELECT id INTO c_acct FROM accounts WHERE owner_user_id = u_oc;
  IF a_acct IS NULL OR b_acct IS NULL OR c_acct IS NULL
     OR a_acct = b_acct OR b_acct = c_acct OR a_acct = c_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id IN (u_adm, u_adm2, u_dadm);
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_tl;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agt, u_mul);
  UPDATE profiles SET full_name = 'MP Agent' WHERE user_id = u_agt;
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_vwr;
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB'
   WHERE user_id = u_gst;
  -- The multi-workspace person's second membership: an agent of B.
  INSERT INTO profiles (user_id, full_name, email, account_id, account_role, is_active)
  VALUES (u_mul, '', 'mp-multi@example.invalid', b_acct, 'agent', false);
  -- The deactivated admin, the 069 way.
  r := pg_temp.mp_try('authenticated', u_own, format('SELECT public.set_member_active(%L, false)', u_dadm));
  IF r <> 'ok' THEN
    RAISE EXCEPTION 'fixture: could not deactivate the second admin: %', r;
  END IF;

  -- ---------- 1. who may ask at all ----------
  r := pg_temp.mp_auth(u_agt, u_vwr) || ' | ' || pg_temp.mp_auth(u_tl, u_agt);
  n := n + 1;
  IF r <> 'ERROR 42501: This action requires the admin role or higher | ERROR 42501: This action requires the admin role or higher' THEN
    failed := array_append(failed, ('an agent or a team leader as the caller (want 42501 twice): ' || r)::text);
  END IF;
  r := pg_temp.mp_auth(u_dadm, u_agt);
  n := n + 1;
  IF r <> 'ERROR 42501: Your access to this account has been deactivated' THEN
    failed := array_append(failed, ('a deactivated admin as the caller: ' || r)::text);
  END IF;
  r := pg_temp.mp_auth(NULL, u_agt);
  n := n + 1;
  IF r <> 'ERROR 42501: Unauthorized' THEN
    failed := array_append(failed, ('no session as the caller: ' || r)::text);
  END IF;

  -- ---------- 2-4. in the active workspace ----------
  -- Everything from here to the snapshot comparison only reads: the
  -- check must write nothing, allowed or refused.
  SELECT md5(coalesce((SELECT string_agg(p::text, ',' ORDER BY p.id) FROM profiles p), '')
             || coalesce((SELECT string_agg(w::text, ',' ORDER BY w.id) FROM workspace_audit w), ''))
    INTO snap;

  r := pg_temp.mp_auth(u_adm, u_agt) || ' | ' || pg_temp.mp_auth(u_adm, u_tl)
    || ' | ' || pg_temp.mp_auth(u_adm, u_vwr) || ' | ' || pg_temp.mp_auth(u_adm, u_gst);
  n := n + 1;
  IF r <> 'ok | ok | ok | ok' THEN
    failed := array_append(failed, ('an admin for an agent, team leader, viewer and bank guest (want ok x4): ' || r)::text);
  END IF;
  r := pg_temp.mp_auth(u_own, u_adm2);
  n := n + 1;
  IF r <> 'ok' THEN
    failed := array_append(failed, ('the owner for an admin: ' || r)::text);
  END IF;
  r := pg_temp.mp_auth(u_adm, u_adm) || ' | ' || pg_temp.mp_auth(u_own, u_own);
  n := n + 1;
  IF r <> 'ERROR 22023: Change your own password in Settings → Login & security. | ERROR 22023: Change your own password in Settings → Login & security.' THEN
    failed := array_append(failed, ('an admin or the owner for themselves (want 22023 twice): ' || r)::text);
  END IF;
  r := pg_temp.mp_auth(u_adm, u_own) || ' | ' || pg_temp.mp_auth(u_adm, u_adm2);
  n := n + 1;
  IF r <> 'ERROR 42501: You can change the password only of people below your own role. | ERROR 42501: You can change the password only of people below your own role.' THEN
    failed := array_append(failed, ('an admin for the owner or another admin (want 42501 twice): ' || r)::text);
  END IF;
  r := pg_temp.mp_auth(u_adm, u_out) || ' | ' || pg_temp.mp_auth(u_adm, u_none);
  n := n + 1;
  IF r <> 'ERROR 42501: Target user is not a member of your account | ERROR 22023: Target user not found' THEN
    failed := array_append(failed, ('an admin for a login outside A, and for no login: ' || r)::text);
  END IF;

  n := n + 1;
  IF md5(coalesce((SELECT string_agg(p::text, ',' ORDER BY p.id) FROM profiles p), '')
         || coalesce((SELECT string_agg(w::text, ',' ORDER BY w.id) FROM workspace_audit w), ''))
     IS DISTINCT FROM snap THEN
    failed := array_append(failed, 'authorize_member_password_change wrote to profiles or workspace_audit'::text);
  END IF;

  -- A deactivated member's password can be set before reactivating them.
  r := pg_temp.mp_try('authenticated', u_own, format('SELECT public.set_member_active(%L, false)', u_vwr));
  IF r <> 'ok' THEN
    RAISE EXCEPTION 'fixture: could not deactivate the viewer: %', r;
  END IF;
  r := pg_temp.mp_auth(u_adm, u_vwr);
  n := n + 1;
  IF r <> 'ok' THEN
    failed := array_append(failed, ('an admin for a deactivated viewer: ' || r)::text);
  END IF;

  -- ---------- 5. every other workspace the login opens ----------
  -- The multi-workspace agent is also in B, where the caller is first
  -- nobody, then an agent, then a deactivated admin.
  r := pg_temp.mp_auth(u_adm, u_mul);
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501: This person also belongs to a workspace you don''t manage, so you can''t change their password.%' THEN
    failed := array_append(failed, ('caller with no row in B, for a member of A and B: ' || r)::text);
  END IF;
  INSERT INTO profiles (user_id, full_name, email, account_id, account_role, is_active)
  VALUES (u_adm, '', 'mp-admin@example.invalid', b_acct, 'agent', false);
  r := pg_temp.mp_auth(u_adm, u_mul);
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501: This person also belongs to a workspace you don''t manage%' THEN
    failed := array_append(failed, ('caller an agent of B, for an agent of B: ' || r)::text);
  END IF;
  UPDATE profiles SET account_role = 'admin', deactivated_at = now()
   WHERE user_id = u_adm AND account_id = b_acct;
  r := pg_temp.mp_auth(u_adm, u_mul);
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501: This person also belongs to a workspace you don''t manage%' THEN
    failed := array_append(failed, ('caller a deactivated admin of B, for an agent of B: ' || r)::text);
  END IF;

  -- A live admin of B, but the person is an admin there too.
  UPDATE profiles SET deactivated_at = NULL WHERE user_id = u_adm AND account_id = b_acct;
  UPDATE profiles SET account_role = 'admin' WHERE user_id = u_mul AND account_id = b_acct;
  r := pg_temp.mp_auth(u_adm, u_mul);
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501: This person also belongs to a workspace you don''t manage%' THEN
    failed := array_append(failed, ('caller an admin of B, for an admin of B: ' || r)::text);
  END IF;

  -- Outranking them in B as well: allowed.
  UPDATE profiles SET account_role = 'agent' WHERE user_id = u_mul AND account_id = b_acct;
  r := pg_temp.mp_auth(u_adm, u_mul);
  n := n + 1;
  IF r <> 'ok' THEN
    failed := array_append(failed, ('caller an admin of B, for an agent of A and B (want ok): ' || r)::text);
  END IF;

  -- The person's deactivated row in B still counts: the login opens it
  -- again on reactivation.
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_mul AND account_id = b_acct;
  UPDATE profiles SET account_role = 'agent' WHERE user_id = u_adm AND account_id = b_acct;
  r := pg_temp.mp_auth(u_adm, u_mul);
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501: This person also belongs to a workspace you don''t manage%' THEN
    failed := array_append(failed, ('caller an agent of B, for a deactivated agent of B: ' || r)::text);
  END IF;
  UPDATE profiles SET account_role = 'admin' WHERE user_id = u_adm AND account_id = b_acct;
  r := pg_temp.mp_auth(u_adm, u_mul);
  n := n + 1;
  IF r <> 'ok' THEN
    failed := array_append(failed, ('caller an admin of B, for a deactivated agent of B (want ok): ' || r)::text);
  END IF;

  -- EVERY other workspace, not any: the person is also an agent of C,
  -- where the caller is first nobody, then a live team leader (who
  -- outranks an agent but administers nothing), then an admin.
  INSERT INTO profiles (user_id, full_name, email, account_id, account_role, is_active)
  VALUES (u_mul, '', 'mp-multi@example.invalid', c_acct, 'agent', false);
  SELECT md5(coalesce((SELECT string_agg(p::text, ',' ORDER BY p.id) FROM profiles p), '')
             || coalesce((SELECT string_agg(w::text, ',' ORDER BY w.id) FROM workspace_audit w), ''))
    INTO snap;
  r := pg_temp.mp_auth(u_adm, u_mul);
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501: This person also belongs to a workspace you don''t manage%' THEN
    failed := array_append(failed, ('caller an admin of A and B but not C, for a member of A, B and C: ' || r)::text);
  END IF;
  n := n + 1;
  IF md5(coalesce((SELECT string_agg(p::text, ',' ORDER BY p.id) FROM profiles p), '')
         || coalesce((SELECT string_agg(w::text, ',' ORDER BY w.id) FROM workspace_audit w), ''))
     IS DISTINCT FROM snap THEN
    failed := array_append(failed, 'a refusal for another workspace wrote to profiles or workspace_audit'::text);
  END IF;
  INSERT INTO profiles (user_id, full_name, email, account_id, account_role, is_active)
  VALUES (u_adm, '', 'mp-admin@example.invalid', c_acct, 'team_leader', false);
  r := pg_temp.mp_auth(u_adm, u_mul);
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501: This person also belongs to a workspace you don''t manage%' THEN
    failed := array_append(failed, ('caller a team leader of C, for an agent of C: ' || r)::text);
  END IF;
  UPDATE profiles SET account_role = 'admin' WHERE user_id = u_adm AND account_id = c_acct;
  SELECT md5(coalesce((SELECT string_agg(p::text, ',' ORDER BY p.id) FROM profiles p), '')
             || coalesce((SELECT string_agg(w::text, ',' ORDER BY w.id) FROM workspace_audit w), ''))
    INTO snap;
  r := pg_temp.mp_auth(u_adm, u_mul);
  n := n + 1;
  IF r <> 'ok' THEN
    failed := array_append(failed, ('caller an admin of A, B and C, for an agent of all three (want ok): ' || r)::text);
  END IF;
  n := n + 1;
  IF md5(coalesce((SELECT string_agg(p::text, ',' ORDER BY p.id) FROM profiles p), '')
         || coalesce((SELECT string_agg(w::text, ',' ORDER BY w.id) FROM workspace_audit w), ''))
     IS DISTINCT FROM snap THEN
    failed := array_append(failed, 'an allowed check across workspaces wrote to profiles or workspace_audit'::text);
  END IF;

  -- ---------- 6. privileges ----------
  n := n + 1;
  IF has_function_privilege('anon', 'public.authorize_member_password_change(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.authorize_member_password_change(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.log_member_password_change(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.log_member_password_change(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.log_member_password_change(uuid,uuid)', 'EXECUTE') THEN
    failed := array_append(failed, 'want: authorize for authenticated (not anon), log for service_role only'::text);
  END IF;

  -- ---------- 7. the audit row ----------
  n := n + 1;
  IF EXISTS (SELECT 1 FROM workspace_audit WHERE action = 'password_changed') THEN
    failed := array_append(failed, 'a password_changed row exists before anything logged one'::text);
  END IF;
  r := pg_temp.mp_try('authenticated', u_adm,
         format('SELECT public.log_member_password_change(%L, %L)', u_adm, u_agt));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501: permission denied for function log_member_password_change' THEN
    failed := array_append(failed, ('a signed-in admin called log_member_password_change: ' || r)::text);
  END IF;
  r := pg_temp.mp_try('service_role', NULL,
         format('SELECT public.log_member_password_change(%L, %L)', u_adm, u_agt));
  n := n + 1;
  IF r <> 'ok' THEN
    failed := array_append(failed, ('the service role could not log a change: ' || r)::text);
  END IF;
  SELECT string_agg(w.account_id || ' ' || coalesce(w.actor_id::text, 'null') || ' '
                    || coalesce(w.target_user_id::text, 'null') || ' ' || w.detail::text, ' / ')
    INTO r
    FROM workspace_audit w
   WHERE w.action = 'password_changed';
  n := n + 1;
  IF r IS DISTINCT FROM a_acct || ' ' || u_adm || ' ' || u_agt || ' {"name": "MP Agent"}' THEN
    failed := array_append(failed, ('want one password_changed row in A, by the admin, for the agent, named: ' || coalesce(r, 'none'))::text);
  END IF;

  -- Someone in A, B and C: a row in each of their workspaces' logs.
  r := pg_temp.mp_try('service_role', NULL,
         format('SELECT public.log_member_password_change(%L, %L)', u_adm, u_mul));
  n := n + 1;
  IF r <> 'ok' THEN
    failed := array_append(failed, ('the service role could not log a change for the multi-workspace agent: ' || r)::text);
  END IF;
  n := n + 1;
  IF (SELECT array_agg(w.account_id ORDER BY w.account_id) FROM workspace_audit w
       WHERE w.action = 'password_changed' AND w.target_user_id = u_mul AND w.actor_id = u_adm)
     IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[a_acct, b_acct, c_acct]) x) THEN
    failed := array_append(failed, 'want one password_changed row in each of A, B and C for the multi-workspace agent'::text);
  END IF;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT140', MESSAGE = 'verify-member-password rollback';
  EXCEPTION WHEN SQLSTATE 'ZT140' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'member password verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'member password verification passed (% checks)', n;
END
$verify$;
