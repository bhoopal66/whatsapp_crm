-- Behavioural regression suite for migration 306 (a member who leaves
-- loses their extension; a removed member can be added back). ONE
-- statement on purpose (the pinned CLI rejects several); fixtures are
-- rolled back through a sentinel.

DO $verify$
DECLARE
  u_own UUID := '00000000-0000-4000-8000-000000306001';  -- owner of A
  u_adm UUID := '00000000-0000-4000-8000-000000306002';  -- admin of A
  u_mov UUID := '00000000-0000-4000-8000-000000306003';  -- agent, only in A: moved out
  u_two UUID := '00000000-0000-4000-8000-000000306004';  -- agent in A and B: row deleted
  u_gon UUID := '00000000-0000-4000-8000-000000306005';  -- agent whose login is deleted
  u_oad UUID := '00000000-0000-4000-8000-000000306006';  -- admin the owner removes
  u_str UUID := '00000000-0000-4000-8000-000000306007';  -- own private account, never in A
  u_dat UUID := '00000000-0000-4000-8000-000000306008';  -- removed, has data since
  u_bow UUID := '00000000-0000-4000-8000-000000306009';  -- owner of B
  u_gst UUID := '00000000-0000-4000-8000-000000306010';  -- a guest A removed
  a UUID; b UUID; pc_a UUID; pc_b UUID; v_priv UUID;
  t TEXT; n INT;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  -- A statement as a signed-in user: its first value, or 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.mlv(p_uid uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
        PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        EXECUTE p_sql INTO v;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(v, 'NULL');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_own, 'mlv-owner@example.test'), (u_adm, 'mlv-admin@example.test'),
    (u_mov, 'mlv-moved@example.test'), (u_two, 'mlv-two@example.test'),
    (u_gon, 'mlv-gone@example.test'), (u_oad, 'mlv-oldadmin@example.test'),
    (u_str, 'mlv-stranger@example.test'), (u_dat, 'mlv-data@example.test'),
    (u_bow, 'mlv-bowner@example.test'), (u_gst, 'mlv-guest@example.test');
  INSERT INTO public.accounts (name, owner_user_id) VALUES ('mlv-a', u_own) RETURNING id INTO a;
  INSERT INTO public.accounts (name, owner_user_id) VALUES ('mlv-b', u_bow) RETURNING id INTO b;
  UPDATE public.profiles p SET account_id = x.acc, is_active = true,
         account_role = x.role::public.account_role_enum, bank_code = x.code
    FROM (VALUES (u_own, a, 'owner', NULL), (u_adm, a, 'admin', NULL), (u_mov, a, 'agent', NULL),
                 (u_two, a, 'agent', NULL), (u_gon, a, 'agent', NULL), (u_oad, a, 'admin', NULL),
                 (u_dat, a, 'agent', NULL), (u_bow, b, 'owner', NULL),
                 (u_gst, a, 'bank_guest', 'MSHQ')) AS x(id, acc, role, code)
   WHERE p.user_id = x.id;
  -- The private accounts the signups made, as provisioning drops them.
  DELETE FROM public.accounts ac
   WHERE ac.owner_user_id IN (u_own, u_adm, u_mov, u_two, u_gon, u_oad, u_dat, u_bow, u_gst)
     AND ac.id NOT IN (a, b);
  INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role, is_active)
  VALUES (u_two, 'Two', 'mlv-two@example.test', b, 'agent', false);

  INSERT INTO public.pbx_connections (account_id, label, edition, base_url)
  VALUES (a, 'mlv A', 'cloud', 'https://mlv-a.example.test') RETURNING id INTO pc_a;
  INSERT INTO public.pbx_connections (account_id, label, edition, base_url)
  VALUES (b, 'mlv B', 'cloud', 'https://mlv-b.example.test') RETURNING id INTO pc_b;
  INSERT INTO public.pbx_extensions (connection_id, extension, account_id, user_id, softphone_enabled)
  VALUES (pc_a, '601', a, u_mov, true), (pc_a, '602', a, u_two, true),
         (pc_a, '603', a, u_gon, true), (pc_a, '604', a, u_adm, true),
         (pc_b, '605', b, u_two, true);
  INSERT INTO public.pbx_presence (connection_id, extension, account_id, user_id)
  VALUES (pc_a, '601', a, u_mov);

  -- ---------- 1. Leaving takes the extension ----------
  -- 1a: the row moves to a private account.
  t := pg_temp.mlv(u_adm, format('SELECT public.remove_account_member(%L)', u_mov));
  IF t LIKE 'ERROR%' OR t = 'NULL' THEN failed := failed || ('1a removal: ' || t); END IF;
  -- 1b: the row is deleted (they keep B).
  t := pg_temp.mlv(u_adm, format('SELECT public.remove_account_member(%L)', u_two));
  IF t <> 'NULL' THEN failed := failed || ('1b removal: ' || t); END IF;
  -- 1c: the login is deleted.
  DELETE FROM auth.users WHERE id = u_gon;

  SELECT string_agg(e.extension || coalesce(':' || e.user_id::text, ''), ',' ORDER BY e.extension) INTO t
    FROM public.pbx_extensions e
   WHERE e.connection_id = pc_a AND (e.user_id IS NOT NULL
          -- 603: the foreign key unmaps it, before any trigger here.
          OR (e.softphone_enabled AND e.extension <> '603'));
  IF t IS DISTINCT FROM '604:' || u_adm THEN failed := failed || ('1 extensions still held in A: ' || coalesce(t, 'none')); END IF;
  IF EXISTS (SELECT 1 FROM public.pbx_presence WHERE connection_id = pc_a AND extension = '601' AND user_id IS NOT NULL) THEN
    failed := failed || '1a the presence still names the leaver'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pbx_extensions WHERE connection_id = pc_b AND user_id = u_two AND softphone_enabled) THEN
    failed := failed || '1b the other workspace''s extension was taken too'::text;
  END IF;
  -- 1d: a workspace deleted with its people and extensions.
  INSERT INTO auth.users (id, email) VALUES (u_gon, 'mlv-gone2@example.test');
  INSERT INTO public.accounts (name, owner_user_id) VALUES ('mlv-c', u_gon) RETURNING id INTO v_priv;
  UPDATE public.profiles SET account_id = v_priv, account_role = 'owner' WHERE user_id = u_gon;
  INSERT INTO public.pbx_connections (account_id, label, edition, base_url)
  VALUES (v_priv, 'mlv C', 'cloud', 'https://mlv-c.example.test') RETURNING id INTO pc_b;
  INSERT INTO public.pbx_extensions (connection_id, extension, account_id, user_id, softphone_enabled)
  VALUES (pc_b, '606', v_priv, u_gon, true);
  DELETE FROM public.accounts WHERE id = v_priv;
  IF EXISTS (SELECT 1 FROM public.pbx_extensions WHERE account_id = v_priv) THEN
    failed := failed || '1d an extension outlived its workspace'::text;
  END IF;

  -- ---------- 2. Taking a removed person back ----------
  -- 2a: removed, then added again.
  SELECT account_id INTO v_priv FROM public.profiles WHERE user_id = u_mov;
  -- Nobody elsewhere may: B's owner never removed them.
  t := pg_temp.mlv(u_bow, 'SELECT public.add_workspace_member(''mlv-moved@example.test'', ''agent'')');
  IF t NOT LIKE 'ERROR P0002: no_such_user%' THEN failed := failed || ('2a another workspace added them: ' || t); END IF;
  -- Nor an agent of A (and the person themselves).
  t := pg_temp.mlv(u_mov, 'SELECT public.add_workspace_member(''mlv-moved@example.test'', ''agent'')');
  IF t NOT LIKE 'ERROR 42501%' THEN failed := failed || ('2a the removed person added themselves: ' || t); END IF;
  t := pg_temp.mlv(u_adm, 'SELECT public.add_workspace_member('' MLV-moved@example.test '', ''team_leader'')');
  IF t <> u_mov::text THEN failed := failed || ('2a adding them back: ' || t); END IF;
  SELECT count(*) INTO n FROM public.profiles
   WHERE user_id = u_mov AND account_id = a AND account_role = 'team_leader'
     AND is_active AND deactivated_at IS NULL AND department = 'sales';
  IF n <> 1 OR (SELECT count(*) FROM public.profiles WHERE user_id = u_mov) <> 1 THEN
    failed := failed || '2a they do not hold one live row in A'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM public.accounts WHERE id = v_priv) THEN
    failed := failed || '2a the private account was left behind'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_audit WHERE account_id = a AND action = 'member_added'
                    AND target_user_id = u_mov AND actor_id = u_adm) THEN
    failed := failed || '2a no audit row names who added them back'::text;
  END IF;
  t := pg_temp.mlv(u_adm, 'SELECT public.add_workspace_member(''mlv-moved@example.test'', ''agent'')');
  IF t NOT LIKE 'ERROR 23505%' THEN failed := failed || ('2a added twice: ' || t); END IF;

  -- 2b: a login with its own private account that A never removed.
  t := pg_temp.mlv(u_adm, 'SELECT public.add_workspace_member(''mlv-stranger@example.test'', ''agent'')');
  IF t NOT LIKE 'ERROR P0002: no_such_user%' THEN failed := failed || ('2b a stranger: ' || t); END IF;

  -- 2c: removed from A, still in B: not the caller's to add.
  t := pg_temp.mlv(u_adm, 'SELECT public.add_workspace_member(''mlv-two@example.test'', ''agent'')');
  IF t NOT LIKE 'ERROR P0002: no_such_user%' THEN failed := failed || ('2c someone who works elsewhere: ' || t); END IF;

  -- 2d: removed, and their private account holds something now.
  t := pg_temp.mlv(u_adm, format('SELECT public.remove_account_member(%L)', u_dat));
  INSERT INTO public.contacts (account_id, user_id, phone, name)
  SELECT account_id, u_dat, '971500030601', 'mlv' FROM public.profiles WHERE user_id = u_dat;
  t := pg_temp.mlv(u_adm, 'SELECT public.add_workspace_member(''mlv-data@example.test'', ''agent'')');
  IF t NOT LIKE 'ERROR P0002: no_such_user%' THEN failed := failed || ('2d a private account with data: ' || t); END IF;

  -- 2e: an admin the owner removed is the owner's to take back, in any
  -- role.
  t := pg_temp.mlv(u_own, format('SELECT public.remove_account_member(%L)', u_oad));
  IF t LIKE 'ERROR%' THEN failed := failed || ('2e removal: ' || t); END IF;
  t := pg_temp.mlv(u_adm, 'SELECT public.add_workspace_member(''mlv-oldadmin@example.test'', ''viewer'')');
  IF t NOT LIKE 'ERROR 42501: Only the owner can add back%' THEN failed := failed || ('2e by an admin: ' || t); END IF;
  t := pg_temp.mlv(u_own, 'SELECT public.add_workspace_member(''mlv-oldadmin@example.test'', ''agent'')');
  IF t <> u_oad::text THEN failed := failed || ('2e by the owner: ' || t); END IF;

  -- 2f: a removed guest comes back as a guest with a bank, or as staff
  -- with none.
  t := pg_temp.mlv(u_adm, format('SELECT public.remove_account_member(%L)', u_gst));
  t := pg_temp.mlv(u_adm, 'SELECT public.add_workspace_member(''mlv-guest@example.test'', ''bank_guest'', ''ENBD'')');
  IF t <> u_gst::text OR NOT EXISTS (SELECT 1 FROM public.profiles
       WHERE user_id = u_gst AND account_id = a AND account_role = 'bank_guest' AND bank_code = 'ENBD') THEN
    failed := failed || ('2f a guest: ' || t);
  END IF;

  -- ---------- 3. Grants and search_path as before ----------
  IF has_function_privilege('anon', 'public.add_workspace_member(text,account_role_enum,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.add_workspace_member(text,account_role_enum,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.profiles_leave_account_teams()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.profiles_leave_account_teams()', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                   AND proname IN ('add_workspace_member', 'profiles_leave_account_teams')
                   AND (NOT prosecdef OR proconfig IS NULL)) THEN
    failed := failed || '3 grants, SECURITY DEFINER or search_path changed'::text;
  END IF;

  IF cardinality(failed) > 0 THEN
    RAISE EXCEPTION E'verify-member-leaving FAILED:\n%', array_to_string(failed, E'\n');
  END IF;
  RAISE EXCEPTION 'verify-member-leaving rollback' USING ERRCODE = 'VML00';
  EXCEPTION WHEN SQLSTATE 'VML00' THEN
    RAISE NOTICE 'verify-member-leaving: ok';
  END;
END $verify$;
