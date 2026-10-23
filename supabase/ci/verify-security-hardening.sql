-- Behavioural regression suite for migration 135 (security hardening).
--
-- Asserts that an agent's own JWT cannot write automations, automation
-- steps, flows, flow nodes, broadcasts or broadcast recipients through
-- PostgREST while an admin can; that nobody changes their own
-- profiles.email while a name change still propagates to every one of
-- their rows; that peek_invitation answers 'expired' for a link into an
-- archived workspace and for a link whose creator may no longer grant
-- its role; that update_team refuses a bank guest or deactivated person
-- as a new member or leader but keeps someone already on the team; and
-- that transfer_account_ownership takes the per-person lock.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_ow   UUID := '00000000-0000-4000-8000-000000135001';  -- owner of A (and of E)
  u_ad   UUID := '00000000-0000-4000-8000-000000135002';  -- admin of A
  u_ag   UUID := '00000000-0000-4000-8000-000000135003';  -- agent of A, inactive row in B
  u_g    UUID := '00000000-0000-4000-8000-000000135004';  -- bank guest of A
  u_dx   UUID := '00000000-0000-4000-8000-000000135005';  -- deactivated agent of A
  u_ob   UUID := '00000000-0000-4000-8000-000000135006';  -- owner of B
  a_acct UUID;
  b_acct UUID;
  e_acct UUID;   -- archived workspace
  auto_a UUID;
  flow_a UUID;
  bc_a   UUID;
  ct     UUID;
  team1  UUID;
  r      TEXT;
  n      INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (a signed-in user when p_uid is given);
  -- 'ok', or the error as 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sh_try(p_role text, p_uid uuid, p_sql text)
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

  -- The value of a one-column query run as p_role ('null' for NULL),
  -- or the error as 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sh_val(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', p_role)::text, true);
        EXECUTE format('SET LOCAL ROLE %I', p_role);
        EXECUTE p_sql INTO v;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(v, 'null');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;

  -- Fixture: each auth user gets a personal account and its owner row.
  INSERT INTO auth.users (id, email) VALUES
    (u_ow, 'sh-owner@example.invalid'),
    (u_ad, 'sh-admin@example.invalid'),
    (u_ag, 'sh-agent@example.invalid'),
    (u_g,  'sh-guest@example.invalid'),
    (u_dx, 'sh-deact@example.invalid'),
    (u_ob, 'sh-owner-b@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_ow;
  SELECT id INTO b_acct FROM accounts WHERE owner_user_id = u_ob;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_ad;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_ag, u_dx);
  UPDATE profiles SET deactivated_at = now(), deactivated_by = u_ow WHERE user_id = u_dx;
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB'
   WHERE user_id = u_g;
  INSERT INTO profiles (user_id, full_name, email, account_id, account_role, is_active)
  VALUES (u_ag, 'Agent', 'sh-agent@example.invalid', b_acct, 'agent', false);
  UPDATE profiles SET full_name = 'Agent' WHERE user_id = u_ag;

  INSERT INTO automations (account_id, user_id, name, trigger_type)
  VALUES (a_acct, u_ow, 'SH auto', 'keyword') RETURNING id INTO auto_a;
  INSERT INTO flows (account_id, user_id, name, trigger_type)
  VALUES (a_acct, u_ow, 'SH flow', 'keyword') RETURNING id INTO flow_a;
  INSERT INTO broadcasts (account_id, user_id, name, template_name)
  VALUES (a_acct, u_ow, 'SH bc', 'hello') RETURNING id INTO bc_a;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_ow, '971500135001', 'SH contact') RETURNING id INTO ct;

  -- ---------- 1. agents cannot write workspace configuration ----------
  n := n + 1;
  r := pg_temp.sh_try('authenticated', u_ag, format(
    'INSERT INTO automations (account_id, user_id, name, trigger_type, is_active) VALUES (%L, %L, ''x'', ''keyword'', true)',
    a_acct, u_ag));
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('agent inserts an automation (want 42501): ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.sh_try('authenticated', u_ag, format(
    'INSERT INTO flows (account_id, user_id, name, trigger_type) VALUES (%L, %L, ''x'', ''keyword'')',
    a_acct, u_ag));
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('agent inserts a flow (want 42501): ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.sh_try('authenticated', u_ag, format(
    'INSERT INTO broadcasts (account_id, user_id, name, template_name, status) VALUES (%L, %L, ''x'', ''hello'', ''scheduled'')',
    a_acct, u_ag));
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('agent inserts a broadcast (want 42501): ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.sh_try('authenticated', u_ag, format(
    'INSERT INTO automation_steps (automation_id, step_type, step_config, position) VALUES (%L, ''send_webhook'', ''{"url":"https://evil.example"}'', 0)',
    auto_a));
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('agent inserts an automation step (want 42501): ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.sh_try('authenticated', u_ag, format(
    'INSERT INTO flow_nodes (flow_id, node_key, node_type) VALUES (%L, ''n1'', ''send_message'')',
    flow_a));
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('agent inserts a flow node (want 42501): ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.sh_try('authenticated', u_ag, format(
    'INSERT INTO broadcast_recipients (broadcast_id, contact_id, status) VALUES (%L, %L, ''pending'')',
    bc_a, ct));
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('agent inserts a broadcast recipient (want 42501): ' || r)::text);
  END IF;

  -- An UPDATE or DELETE the policy hides matches no row: read the effect.
  n := n + 1;
  r := pg_temp.sh_try('authenticated', u_ag, format(
    'UPDATE automations SET is_active = true WHERE id = %L', auto_a));
  IF r <> 'ok' OR (SELECT is_active FROM automations WHERE id = auto_a) THEN
    failed := array_append(failed, ('agent activates an automation (want no change): ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.sh_try('authenticated', u_ag, format(
    'DELETE FROM broadcasts WHERE id = %L', bc_a));
  IF r <> 'ok' OR NOT EXISTS (SELECT 1 FROM broadcasts WHERE id = bc_a) THEN
    failed := array_append(failed, ('agent deletes a broadcast (want no change): ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.sh_val('authenticated', u_ag, format(
    'SELECT count(*)::text FROM automations WHERE id = %L', auto_a));
  IF r <> '1' THEN
    failed := array_append(failed, ('agent reads automations (want 1, SELECT unchanged): ' || r)::text);
  END IF;

  -- ---------- 2. admins still can ----------
  n := n + 1;
  r := pg_temp.sh_try('authenticated', u_ad, format(
    'INSERT INTO automations (account_id, user_id, name, trigger_type) VALUES (%L, %L, ''y'', ''keyword'')',
    a_acct, u_ad));
  IF r <> 'ok' THEN
    failed := array_append(failed, ('admin inserts an automation (want ok): ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.sh_try('authenticated', u_ad, format(
    'INSERT INTO flows (account_id, user_id, name, trigger_type) VALUES (%L, %L, ''y'', ''keyword'')',
    a_acct, u_ad));
  IF r <> 'ok' THEN
    failed := array_append(failed, ('admin inserts a flow (want ok): ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.sh_try('authenticated', u_ad, format(
    'INSERT INTO broadcasts (account_id, user_id, name, template_name) VALUES (%L, %L, ''y'', ''hello'')',
    a_acct, u_ad));
  IF r <> 'ok' THEN
    failed := array_append(failed, ('admin inserts a broadcast (want ok): ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.sh_try('authenticated', u_ad, format(
    'INSERT INTO broadcast_recipients (broadcast_id, contact_id, status) VALUES (%L, %L, ''pending'')',
    bc_a, ct));
  IF r <> 'ok' THEN
    failed := array_append(failed, ('admin inserts a broadcast recipient (want ok): ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.sh_try('authenticated', u_ad, format(
    'INSERT INTO automation_steps (automation_id, step_type, position) VALUES (%L, ''add_tag'', 0)',
    auto_a));
  IF r <> 'ok' THEN
    failed := array_append(failed, ('admin inserts an automation step (want ok): ' || r)::text);
  END IF;

  -- ---------- 3. profiles.email is not self-editable ----------
  n := n + 1;
  r := pg_temp.sh_try('authenticated', u_ag, format(
    'UPDATE profiles SET email = ''sh-owner@example.invalid'' WHERE user_id = %L', u_ag));
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('own email change (want 42501): ' || r)::text);
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM profiles WHERE user_id = u_ag AND email <> 'sh-agent@example.invalid') THEN
    failed := array_append(failed, 'own email change left a different email'::text);
  END IF;
  -- A name change still goes through and the definer-run propagation
  -- (whose nested guard sees the function owner) copies it.
  n := n + 1;
  r := pg_temp.sh_try('authenticated', u_ag, format(
    'UPDATE profiles SET full_name = ''Agent Renamed'' WHERE user_id = %L AND is_active', u_ag));
  IF r <> 'ok' THEN
    failed := array_append(failed, ('own name change (want ok): ' || r)::text);
  END IF;
  n := n + 1;
  IF (SELECT count(*) FROM profiles WHERE user_id = u_ag AND full_name = 'Agent Renamed') <> 2 THEN
    failed := array_append(failed, 'own name change did not reach both of the person''s rows'::text);
  END IF;

  -- ---------- 4. peek_invitation agrees with redeem ----------
  INSERT INTO accounts (name, owner_user_id) VALUES ('SH E', u_ow) RETURNING id INTO e_acct;
  INSERT INTO profiles (user_id, full_name, email, account_id, account_role, is_active)
  VALUES (u_ow, '', 'sh-owner@example.invalid', e_acct, 'owner', false);
  INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, expires_at) VALUES
    (a_acct, 'sh135-valid',   'agent', u_ow, now() + interval '1 day'),
    (a_acct, 'sh135-byagent', 'agent', u_ag, now() + interval '1 day'),
    (e_acct, 'sh135-archive', 'agent', u_ow, now() + interval '1 day');
  UPDATE accounts SET archived_at = now(), archived_by = u_ow WHERE id = e_acct;

  n := n + 1;
  r := pg_temp.sh_val('anon', NULL, 'SELECT public.peek_invitation(''sh135-valid'')->>''ok''');
  IF r <> 'true' THEN
    failed := array_append(failed, ('peek of a valid link (want true): ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.sh_val('anon', NULL,
    'SELECT (public.peek_invitation(''sh135-archive'')->>''ok'') || '':'' || coalesce(public.peek_invitation(''sh135-archive'')->>''reason'', '''')');
  IF r <> 'false:expired' THEN
    failed := array_append(failed, ('peek of an archived workspace''s link (want false:expired): ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.sh_val('anon', NULL,
    'SELECT (public.peek_invitation(''sh135-byagent'')->>''ok'') || '':'' || coalesce(public.peek_invitation(''sh135-byagent'')->>''reason'', '''')');
  IF r <> 'false:expired' THEN
    failed := array_append(failed, ('peek of a link its creator may not grant (want false:expired): ' || r)::text);
  END IF;

  -- ---------- 5. teams take live staff only ----------
  INSERT INTO teams (account_id, name) VALUES (a_acct, 'SH T1') RETURNING id INTO team1;
  n := n + 1;
  r := pg_temp.sh_try('authenticated', u_ad, format(
    'SELECT public.update_team(%L, NULL, false, NULL, ARRAY[%L, %L]::uuid[], NULL)', team1, u_ag, u_g));
  IF r NOT LIKE 'ERROR 22023%' THEN
    failed := array_append(failed, ('bank guest as a new member (want 22023): ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.sh_try('authenticated', u_ad, format(
    'SELECT public.update_team(%L, NULL, false, NULL, ARRAY[%L]::uuid[], NULL)', team1, u_dx));
  IF r NOT LIKE 'ERROR 22023%' THEN
    failed := array_append(failed, ('deactivated person as a new member (want 22023): ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.sh_try('authenticated', u_ad, format(
    'SELECT public.update_team(%L, NULL, true, %L, NULL, NULL)', team1, u_g));
  IF r NOT LIKE 'ERROR 22023%' THEN
    failed := array_append(failed, ('bank guest as leader (want 22023): ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.sh_try('authenticated', u_ad, format(
    'SELECT public.update_team(%L, NULL, true, %L, NULL, NULL)', team1, u_dx));
  IF r NOT LIKE 'ERROR 22023%' THEN
    failed := array_append(failed, ('deactivated person as leader (want 22023): ' || r)::text);
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM team_members WHERE team_id = team1)
     OR (SELECT leader_user_id FROM teams WHERE id = team1) IS NOT NULL THEN
    failed := array_append(failed, 'a refused team save changed the team'::text);
  END IF;
  -- Someone deactivated after joining stays when the list is re-saved.
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (team1, u_dx, a_acct)
  ON CONFLICT DO NOTHING;
  UPDATE teams SET leader_user_id = u_dx WHERE id = team1;
  n := n + 1;
  r := pg_temp.sh_try('authenticated', u_ad, format(
    'SELECT public.update_team(%L, ''SH T1b'', true, %L, ARRAY[%L, %L]::uuid[], NULL)', team1, u_dx, u_dx, u_ag));
  IF r <> 'ok' THEN
    failed := array_append(failed, ('re-save keeping a deactivated member and leader (want ok): ' || r)::text);
  END IF;
  n := n + 1;
  IF (SELECT string_agg(user_id::text, ',' ORDER BY user_id) FROM team_members WHERE team_id = team1)
     IS DISTINCT FROM (u_ag::text || ',' || u_dx::text) THEN
    failed := array_append(failed, 're-save did not leave the deactivated member and the new one'::text);
  END IF;

  -- ---------- 6. ownership transfer takes the per-person lock ----------
  n := n + 1;
  IF pg_get_functiondef('public.transfer_account_ownership(uuid)'::regprocedure)
     !~ 'PERFORM 1 FROM profiles WHERE user_id = auth\.uid\(\) ORDER BY id FOR UPDATE' THEN
    failed := array_append(failed, 'transfer_account_ownership does not take the per-person lock'::text);
  END IF;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT135', MESSAGE = 'verify-security-hardening rollback';
  EXCEPTION WHEN SQLSTATE 'ZT135' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'security hardening verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'security hardening verification passed (% checks)', n;
END
$verify$;
