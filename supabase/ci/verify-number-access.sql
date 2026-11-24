-- verify-number-access.sql — migration 314, by role. Everything is rolled
-- back. Fixture prefix: nac-.

DO $verify$
DECLARE
  u_own UUID := '00000000-0000-4000-8000-000000314001';
  u_a   UUID := '00000000-0000-4000-8000-000000314002'; -- allocated
  u_b   UUID := '00000000-0000-4000-8000-000000314003'; -- in a team
  u_out UUID := '00000000-0000-4000-8000-000000314004'; -- never allocated
  u_adm UUID := '00000000-0000-4000-8000-000000314005';
  acct UUID; t1 UUID; t2 UUID; w UUID; r TEXT; b BOOLEAN; cnt INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.nac_try(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; h text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
        PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        EXECUTE p_sql INTO v;
        RESET ROLE;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
        RESET ROLE; v := SQLSTATE || coalesce(' ' || nullif(h, ''), '');
      END;
      PERFORM set_config('request.jwt.claim.sub', '', true);
      PERFORM set_config('request.jwt.claims', '', true);
      RETURN coalesce(v, 'null');
    END $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_own, 'nac-own@example.invalid'), (u_a, 'nac-a@example.invalid'),
    (u_b, 'nac-b@example.invalid'), (u_out, 'nac-out@example.invalid'),
    (u_adm, 'nac-adm@example.invalid');
  SELECT id INTO acct FROM accounts WHERE owner_user_id = u_own;
  UPDATE profiles SET account_id = acct, account_role = 'agent' WHERE user_id IN (u_a, u_b, u_out);
  UPDATE profiles SET account_id = acct, account_role = 'admin' WHERE user_id = u_adm;
  INSERT INTO whatsapp_config (user_id, account_id, phone_number_id, access_token, provider, is_primary)
  VALUES (u_own, acct, 'nac-w', 'x', 'whapi', true) RETURNING id INTO w;
  INSERT INTO teams (account_id, name) VALUES (acct, 'nac-t1') RETURNING id INTO t1;
  INSERT INTO teams (account_id, name) VALUES (acct, 'nac-t2') RETURNING id INTO t2;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (t1, u_b, acct);

  -- A number nobody ever limited: everyone, as before.
  cnt := cnt + 1;
  r := pg_temp.nac_try(u_out, format('SELECT can_use_channel(%L,%L)::text', acct, w));
  IF r <> 'true' THEN failed := array_append(failed, 'unlimited number: ' || r); END IF;
  -- The browser may read the flag.
  cnt := cnt + 1;
  r := pg_temp.nac_try(u_out, format('SELECT access_restricted::text FROM whatsapp_config WHERE id=%L', w));
  IF r <> 'false' THEN failed := array_append(failed, 'flag not readable: ' || r); END IF;

  -- The only allocated person leaves the account.
  r := pg_temp.nac_try(u_adm, format('SELECT set_channel_access(%L, ARRAY[%L]::uuid[], ARRAY[]::uuid[], ''{}'', ''{}'')::text', w, u_a));
  cnt := cnt + 1;
  SELECT access_restricted INTO b FROM whatsapp_config WHERE id = w;
  IF NOT b THEN failed := array_append(failed, 'allocating a person did not restrict: ' || r); END IF;
  cnt := cnt + 1;
  r := pg_temp.nac_try(u_a, format('SELECT can_use_channel(%L,%L)::text', acct, w));
  IF r <> 'true' THEN failed := array_append(failed, 'allocated person refused: ' || r); END IF;
  DELETE FROM profiles WHERE user_id = u_a AND account_id = acct;
  cnt := cnt + 1;
  r := (SELECT count(*)::text FROM whatsapp_channel_members WHERE config_id = w)
    || pg_temp.nac_try(u_out, format('SELECT can_use_channel(%L,%L)::text', acct, w))
    || pg_temp.nac_try(u_adm, format('SELECT can_use_channel(%L,%L)::text', acct, w));
  IF r <> '0falsetrue' THEN failed := array_append(failed, 'last person left: ' || r); END IF;

  -- One empty list is not "everyone"; both are.
  PERFORM pg_temp.nac_try(u_adm, format('SELECT set_channel_access(%L, ''{}'', NULL)::text', w));
  cnt := cnt + 1;
  r := pg_temp.nac_try(u_out, format('SELECT can_use_channel(%L,%L)::text', acct, w));
  IF r <> 'false' THEN failed := array_append(failed, 'one empty list opened the number: ' || r); END IF;
  cnt := cnt + 1;
  r := pg_temp.nac_try(u_out, format('SELECT set_channel_access(%L, ''{}'', ''{}'')::text', w));
  IF r <> 'P0002' THEN failed := array_append(failed, 'an agent opened the number: ' || r); END IF;
  r := pg_temp.nac_try(u_adm, format('SELECT set_channel_access(%L, ''{}'', ''{}'')::text', w));
  cnt := cnt + 1;
  r := pg_temp.nac_try(u_out, format('SELECT can_use_channel(%L,%L)::text', acct, w));
  IF r <> 'true' THEN failed := array_append(failed, 'both lists empty did not open the number: ' || r); END IF;

  -- The only member of its only team is deactivated (through update_team).
  r := pg_temp.nac_try(u_adm, format('SELECT update_team(p_team_id => %L, p_config_ids => ARRAY[%L]::uuid[])::text', t1, w));
  cnt := cnt + 1;
  r := pg_temp.nac_try(u_b, format('SELECT can_use_channel(%L,%L)::text', acct, w))
    || pg_temp.nac_try(u_out, format('SELECT can_use_channel(%L,%L)::text', acct, w));
  IF r <> 'truefalse' THEN failed := array_append(failed, 'team number: ' || r); END IF;
  PERFORM deactivated_member_cleanup(u_b, acct);
  cnt := cnt + 1;
  r := (SELECT count(*)::text FROM whatsapp_channel_members WHERE config_id = w)
    || pg_temp.nac_try(u_out, format('SELECT can_use_channel(%L,%L)::text', acct, w));
  IF r <> '0false' THEN failed := array_append(failed, 'only team member deactivated: ' || r); END IF;

  -- The team itself is deleted.
  DELETE FROM teams WHERE id = t1;
  cnt := cnt + 1;
  r := pg_temp.nac_try(u_out, format('SELECT can_use_channel(%L,%L)::text', acct, w));
  IF r <> 'false' THEN failed := array_append(failed, 'team deleted: ' || r); END IF;

  -- A team taken off the number in the team's own list: also not "everyone".
  PERFORM pg_temp.nac_try(u_adm, format('SELECT set_channel_access(%L, ''{}'', ''{}'')::text', w));
  PERFORM pg_temp.nac_try(u_adm, format('SELECT set_team_channels(%L, ARRAY[%L]::uuid[])::text', t2, w));
  PERFORM pg_temp.nac_try(u_adm, format('SELECT set_team_channels(%L, ''{}'')::text', t2));
  cnt := cnt + 1;
  r := pg_temp.nac_try(u_out, format('SELECT can_use_channel(%L,%L)::text', acct, w));
  IF r <> 'false' THEN failed := array_append(failed, 'team list emptied: ' || r); END IF;

  -- Two admins on one number.
  PERFORM pg_temp.nac_try(u_adm, format('SELECT set_channel_access(%L, ARRAY[%L]::uuid[], ARRAY[%L]::uuid[])::text', w, u_out, t2));
  cnt := cnt + 1;
  r := pg_temp.nac_try(u_adm, format('SELECT set_channel_access(%L, ARRAY[%L]::uuid[], NULL, ''{}'', NULL)::text', w, u_b));
  IF r <> '22023 access_changed' THEN failed := array_append(failed, 'stale people list: ' || r); END IF;
  cnt := cnt + 1;
  r := pg_temp.nac_try(u_adm, format('SELECT set_channel_access(%L, ARRAY[%L]::uuid[], ''{}'', ARRAY[%L]::uuid[], ''{}'')::text', w, u_b, u_out));
  IF r <> '22023 access_changed' THEN failed := array_append(failed, 'stale team list: ' || r); END IF;
  cnt := cnt + 1;
  r := pg_temp.nac_try(u_adm, format('SELECT set_channel_access(%L, ''{}'', ''{}'', NULL, NULL)::text', w));
  IF r <> '22023' THEN failed := array_append(failed, 'lists not given: ' || r); END IF;
  cnt := cnt + 1;
  r := pg_temp.nac_try(u_adm, format('SELECT set_channel_access(%L, ARRAY[%L]::uuid[], ''{}'', ARRAY[%L]::uuid[], ARRAY[%L]::uuid[])::text', w, u_b, u_out, t2));
  r := r || (SELECT string_agg(user_id::text, ',') FROM whatsapp_channel_members WHERE config_id = w);
  IF r <> u_b::text THEN failed := array_append(failed, 'the lists as stored: ' || r); END IF;

  -- Two admins on one team.
  PERFORM pg_temp.nac_try(u_adm, format('SELECT update_team(p_team_id => %L, p_member_ids => ARRAY[%L]::uuid[])::text', t2, u_out));
  cnt := cnt + 1;
  r := pg_temp.nac_try(u_adm, format('SELECT update_team(%L, NULL, false, NULL, ARRAY[%L]::uuid[], NULL, ''{}'')::text', t2, u_b));
  IF r <> '22023 members_changed' THEN failed := array_append(failed, 'stale members: ' || r); END IF;
  cnt := cnt + 1;
  r := pg_temp.nac_try(u_adm, format('SELECT update_team(%L, NULL, false, NULL, ARRAY[%L]::uuid[], NULL, ARRAY[%L]::uuid[])::text', t2, u_b, u_out));
  r := r || (SELECT string_agg(user_id::text, ',') FROM team_members WHERE team_id = t2);
  IF r <> u_b::text THEN failed := array_append(failed, 'the members as stored: ' || r); END IF;
  cnt := cnt + 1;
  r := pg_temp.nac_try(u_out, format('SELECT update_team(%L, ''x'', false, NULL, NULL, NULL, ''{}'')::text', t2));
  IF r <> 'P0002' THEN failed := array_append(failed, 'an agent changed a team: ' || r); END IF;

  -- Grants.
  cnt := cnt + 1;
  IF has_function_privilege('anon', 'public.set_channel_access(uuid,uuid[],uuid[],uuid[],uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.update_team(uuid,text,boolean,uuid,uuid[],uuid[],uuid[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.whatsapp_channel_restrict()', 'EXECUTE')
     OR has_column_privilege('authenticated', 'public.whatsapp_config', 'access_token', 'SELECT') THEN
    failed := array_append(failed, 'grants');
  END IF;

  RAISE EXCEPTION 'nac-rollback' USING ERRCODE = 'P9999';
  EXCEPTION WHEN SQLSTATE 'P9999' THEN NULL;
  END;
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'verify-number-access failed: %', array_to_string(failed, '; ');
  END IF;
  RAISE NOTICE 'verify-number-access: % checks passed', cnt;
END
$verify$;
