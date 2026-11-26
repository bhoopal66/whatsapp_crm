-- Behavioural regression suite for migration 287 (what an admin may do to
-- another admin, and in whose name). ONE statement on purpose (the pinned
-- CLI rejects several); fixtures are rolled back through a sentinel.

DO $verify$
DECLARE
  u_own UUID := '00000000-0000-4000-8000-000000287001';  -- owner of W1
  u_adm UUID := '00000000-0000-4000-8000-000000287002';  -- admin of W1, owner of W2
  u_b   UUID := '00000000-0000-4000-8000-000000287003';  -- peer admin of W1
  u_c   UUID := '00000000-0000-4000-8000-000000287004';  -- admin of W1, lowered later
  u_ag  UUID := '00000000-0000-4000-8000-000000287005';  -- agent
  u_ag2 UUID := '00000000-0000-4000-8000-000000287006';  -- agent
  u_new UUID := '00000000-0000-4000-8000-000000287007';  -- redeems a link
  w1 UUID; w2 UUID; v_old UUID; v_key UUID; r UUID;
  t TEXT; fn TEXT;
  failed TEXT[] := '{}';
  denied CONSTANT TEXT := 'ERROR 42501%';
  tok CONSTANT TEXT := 'ar-token-287';
  hsh CONSTANT TEXT := encode(sha256(convert_to('ar-token-287', 'UTF8')), 'hex');
BEGIN
  BEGIN
  -- A statement as a signed-in user: its first value, or 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ar(p_uid uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $body$
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
    (u_own, 'ar-owner@example.test'), (u_adm, 'ar-admin@example.test'), (u_b, 'ar-b@example.test'),
    (u_c, 'ar-c@example.test'), (u_ag, 'ar-agent@example.test'), (u_ag2, 'ar-agent2@example.test'),
    (u_new, 'ar-new@example.test');
  INSERT INTO public.accounts (name, owner_user_id) VALUES ('ar-w1', u_own) RETURNING id INTO w1;
  -- Move each signup's own row in, as provisioning does.
  UPDATE public.profiles p SET account_id = w1, is_active = true,
         account_role = x.role::public.account_role_enum
    FROM (VALUES (u_own, 'owner'), (u_adm, 'admin'), (u_b, 'admin'), (u_c, 'admin'),
                 (u_ag, 'agent'), (u_ag2, 'agent')) AS x(id, role)
   WHERE p.user_id = x.id;

  -- The caller's own second workspace, with the peer admin in it as agent.
  t := pg_temp.ar(u_adm, 'SELECT public.create_workspace(''ar-w2'', ''AR2'')');
  IF t LIKE 'ERROR%' THEN RAISE EXCEPTION 'verify-admin-rules fixture: create_workspace: %', t; END IF;
  w2 := t::uuid;
  PERFORM pg_temp.ar(u_adm, format('SELECT public.switch_account(%L)', w2));
  t := pg_temp.ar(u_adm, 'SELECT public.add_workspace_member(''ar-b@example.test'', ''agent'')');
  IF t <> u_b::text THEN RAISE EXCEPTION 'verify-admin-rules fixture: add to W2: %', t; END IF;
  t := pg_temp.ar(u_adm, 'SELECT public.add_workspace_member(''ar-agent@example.test'', ''agent'')');
  PERFORM pg_temp.ar(u_adm, format('SELECT public.switch_account(%L)', w1));

  -- 1. Only the owner removes an admin; an admin still removes an agent.
  t := pg_temp.ar(u_adm, format('SELECT public.remove_account_member(%L)', u_b));
  IF t NOT LIKE 'ERROR 42501: Only the owner can remove an admin' THEN failed := failed || ('1 an admin removed an admin: ' || t); END IF;
  t := pg_temp.ar(u_adm, format('SELECT public.remove_account_member(%L)', u_ag2));
  IF t LIKE 'ERROR%' THEN failed := failed || ('1 an admin could not remove an agent: ' || t); END IF;
  UPDATE public.profiles SET deactivated_at = now() WHERE user_id = u_b AND account_id = w1;
  t := pg_temp.ar(u_adm, format('SELECT public.remove_account_member(%L)', u_b));
  IF t NOT LIKE denied THEN failed := failed || ('1 an admin removed a deactivated admin: ' || t); END IF;
  UPDATE public.profiles SET deactivated_at = NULL WHERE user_id = u_b AND account_id = w1;

  -- 2. A lowered admin: not removed by the one who lowered them, not from W2 either.
  t := pg_temp.ar(u_adm, format('SELECT public.set_member_role(%L, ''agent'')', u_c));
  IF t LIKE 'ERROR%' THEN failed := failed || ('2 an admin could not lower an admin: ' || t); END IF;
  t := pg_temp.ar(u_adm, format('SELECT public.remove_account_member(%L)', u_c));
  IF t NOT LIKE denied THEN failed := failed || ('2 an admin removed a person just lowered: ' || t); END IF;
  FOREACH fn IN ARRAY ARRAY['authorize_member_password_change', 'authorize_member_details_change'] LOOP
    t := pg_temp.ar(u_adm, format('SELECT public.%I(%L)', fn, u_c));
    IF t NOT LIKE 'ERROR 42501: This person was an admin%' THEN failed := failed || ('2 ' || fn || ' of a lowered admin: ' || t); END IF;
    t := pg_temp.ar(u_own, format('SELECT public.%I(%L)', fn, u_c));
    IF t LIKE 'ERROR%' THEN failed := failed || ('2 the owner, ' || fn || ': ' || t); END IF;
    -- Someone who never was an admin, in both workspaces the caller runs.
    t := pg_temp.ar(u_adm, format('SELECT public.%I(%L)', fn, u_ag));
    IF t LIKE 'ERROR%' THEN failed := failed || ('2 ' || fn || ' of an agent: ' || t); END IF;
  END LOOP;

  -- 3. The owner removes the peer admin: the owner of W2 stays out of the
  --    login from W2, and from W1 once the person is back there as agent.
  t := pg_temp.ar(u_own, format('SELECT public.remove_account_member(%L)', u_b));
  IF t LIKE 'ERROR%' THEN failed := failed || ('3 the owner could not remove an admin: ' || t); END IF;
  PERFORM pg_temp.ar(u_adm, format('SELECT public.switch_account(%L)', w2));
  FOREACH fn IN ARRAY ARRAY['authorize_member_password_change', 'authorize_member_details_change'] LOOP
    t := pg_temp.ar(u_adm, format('SELECT public.%I(%L)', fn, u_b));
    IF t NOT LIKE 'ERROR 42501: This person was an admin%' THEN failed := failed || ('3 ' || fn || ' from W2: ' || t); END IF;
  END LOOP;
  PERFORM pg_temp.ar(u_adm, format('SELECT public.switch_account(%L)', w1));
  t := pg_temp.ar(u_adm, 'SELECT public.add_workspace_member(''ar-b@example.test'', ''agent'')');
  IF t <> u_b::text THEN failed := failed || ('3 adding them back: ' || t); END IF;
  FOREACH fn IN ARRAY ARRAY['authorize_member_password_change', 'authorize_member_details_change'] LOOP
    t := pg_temp.ar(u_adm, format('SELECT public.%I(%L)', fn, u_b));
    IF t NOT LIKE 'ERROR 42501: This person was an admin%' THEN failed := failed || ('3 ' || fn || ' back in W1: ' || t); END IF;
    -- W1's owner, who is not in W2, keeps 140's refusal for W2.
    t := pg_temp.ar(u_own, format('SELECT public.%I(%L)', fn, u_b));
    IF t NOT LIKE 'ERROR 42501: This person also belongs%' THEN failed := failed || ('3 ' || fn || ' by the owner of W1: ' || t); END IF;
  END LOOP;
  IF public.member_login_held(u_b, u_own) OR NOT public.member_login_held(u_b, u_adm) THEN
    failed := failed || '3 member_login_held: only the owner of W1 is exempt'::text;
  END IF;
  -- Removed by the server (no actor), or long ago: not held.
  IF public.member_login_held(u_ag2, u_adm) THEN failed := failed || '3 a removed agent is held'::text; END IF;

  -- 4. Invitations: one's own, for a role the route gives, for a year.
  t := pg_temp.ar(u_adm, format('INSERT INTO public.account_invitations (account_id, token_hash, role, created_by_user_id, expires_at)
    VALUES (%L, ''ar-h1'', ''admin'', %L, now() + interval ''7 days'') RETURNING id', w1, u_own));
  IF t NOT LIKE denied THEN failed := failed || ('4 a link in the owner''s name: ' || t); END IF;
  t := pg_temp.ar(u_adm, format('INSERT INTO public.account_invitations (account_id, token_hash, role, created_by_user_id, expires_at)
    VALUES (%L, ''ar-h2'', ''agent'', %L, now() + interval ''400 days'') RETURNING id', w1, u_adm));
  IF t NOT LIKE denied THEN failed := failed || ('4 a link for more than a year: ' || t); END IF;
  t := pg_temp.ar(u_adm, format('INSERT INTO public.account_invitations (account_id, token_hash, role, created_by_user_id, expires_at)
    VALUES (%L, ''ar-h3'', ''bank_guest'', %L, now() + interval ''7 days'') RETURNING id', w1, u_adm));
  IF t NOT LIKE denied THEN failed := failed || ('4 a bank guest''s link: ' || t); END IF;
  t := pg_temp.ar(u_adm, format('INSERT INTO public.account_invitations (account_id, token_hash, role, created_by_user_id, expires_at, accepted_at)
    VALUES (%L, ''ar-h4'', ''agent'', %L, now() + interval ''7 days'', now()) RETURNING id', w1, u_adm));
  IF t NOT LIKE denied THEN failed := failed || ('4 a link already accepted: ' || t); END IF;
  t := pg_temp.ar(u_ag, format('INSERT INTO public.account_invitations (account_id, token_hash, role, created_by_user_id, expires_at)
    VALUES (%L, ''ar-h5'', ''agent'', %L, now() + interval ''7 days'') RETURNING id', w1, u_ag));
  IF t NOT LIKE denied THEN failed := failed || ('4 an agent''s link: ' || t); END IF;
  t := pg_temp.ar(u_adm, format('INSERT INTO public.account_invitations (account_id, token_hash, role, created_by_user_id, expires_at)
    VALUES (%L, %L, ''agent'', %L, now() + interval ''365 days'') RETURNING id', w1, hsh, u_adm));
  IF t LIKE 'ERROR%' THEN failed := failed || ('4 the route''s own link: ' || t); END IF;
  t := pg_temp.ar(u_adm, format('UPDATE public.account_invitations SET created_by_user_id = %L WHERE token_hash = %L RETURNING id', u_own, hsh));
  IF t <> 'NULL' AND t NOT LIKE denied THEN failed := failed || ('4 a link was updated: ' || t); END IF;
  t := pg_temp.ar(u_adm, format('INSERT INTO public.account_invitations (account_id, token_hash, role, created_by_user_id, expires_at)
    VALUES (%L, ''ar-h6'', ''viewer'', %L, now() + interval ''1 day'') RETURNING id', w1, u_adm));
  t := pg_temp.ar(u_own, format('DELETE FROM public.account_invitations WHERE id = %L RETURNING id', t));
  IF t = 'NULL' OR t LIKE 'ERROR%' THEN failed := failed || ('4 the owner could not delete an admin''s link: ' || t); END IF;

  -- 5. The token opens the link, the stored hash does not.
  t := pg_temp.ar(u_new, format('SELECT public.peek_invitation_token(%L) ->> ''reason''', hsh));
  IF t <> 'not_found' THEN failed := failed || ('5 peek by the stored hash: ' || t); END IF;
  t := pg_temp.ar(u_new, format('SELECT public.peek_invitation_token(%L) ->> ''role''', tok));
  IF t <> 'agent' THEN failed := failed || ('5 peek by the token: ' || t); END IF;
  t := pg_temp.ar(u_new, format('SELECT public.redeem_invitation_token(%L)', hsh));
  IF t NOT LIKE 'ERROR 22023: Invitation not found' THEN failed := failed || ('5 redeem by the stored hash: ' || t); END IF;
  t := pg_temp.ar(u_new, format('SELECT public.redeem_invitation_token(%L)', tok));
  IF t <> w1::text OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = u_new AND account_id = w1 AND account_role = 'agent' AND is_active) THEN
    failed := failed || ('5 redeem by the token: ' || t);
  END IF;
  IF has_function_privilege('anon', 'public.redeem_invitation_token(text)', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.peek_invitation_token(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.member_lately_admin_in(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.member_login_held(uuid,uuid)', 'EXECUTE') THEN
    failed := failed || '5 grants'::text;
  END IF;

  -- 6. API keys: one's own; only revoked afterwards.
  t := pg_temp.ar(u_adm, format('INSERT INTO public.api_keys (account_id, created_by, name, key_prefix, key_hash)
    VALUES (%L, %L, ''ar'', ''p'', ''ar-k1'') RETURNING id', w1, u_own));
  IF t NOT LIKE denied THEN failed := failed || ('6 a key in the owner''s name: ' || t); END IF;
  t := pg_temp.ar(u_adm, format('INSERT INTO public.api_keys (account_id, created_by, name, key_prefix, key_hash)
    VALUES (%L, NULL, ''ar'', ''p'', ''ar-k2'') RETURNING id', w1));
  IF t NOT LIKE denied THEN failed := failed || ('6 a key in nobody''s name: ' || t); END IF;
  t := pg_temp.ar(u_adm, format('INSERT INTO public.api_keys (account_id, created_by, name, key_prefix, key_hash)
    VALUES (%L, %L, ''ar'', ''p'', ''ar-k3'') RETURNING id', w1, u_adm));
  IF t LIKE 'ERROR%' THEN failed := failed || ('6 one''s own key: ' || t); ELSE v_key := t::uuid; END IF;
  t := pg_temp.ar(u_adm, format('UPDATE public.api_keys SET created_by = %L WHERE id = %L RETURNING id', u_own, v_key));
  IF t NOT LIKE denied THEN failed := failed || ('6 a key given another maker: ' || t); END IF;
  t := pg_temp.ar(u_adm, format('UPDATE public.api_keys SET key_hash = ''ar-k4'' WHERE id = %L RETURNING id', v_key));
  IF t NOT LIKE denied THEN failed := failed || ('6 a key''s secret replaced: ' || t); END IF;
  t := pg_temp.ar(u_own, format('UPDATE public.api_keys SET revoked_at = now() WHERE id = %L AND revoked_at IS NULL RETURNING id', v_key));
  IF t <> v_key::text THEN failed := failed || ('6 revoking a colleague''s key: ' || t); END IF;

  IF cardinality(failed) > 0 THEN
    RAISE EXCEPTION E'verify-admin-rules FAILED:\n%', array_to_string(failed, E'\n');
  END IF;
  RAISE EXCEPTION 'verify-admin-rules rollback' USING ERRCODE = 'VAR00';
  EXCEPTION WHEN SQLSTATE 'VAR00' THEN
    RAISE NOTICE 'verify-admin-rules: ok';
  END;
END $verify$;
