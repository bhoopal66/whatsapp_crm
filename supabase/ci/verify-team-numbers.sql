-- Behavioural regression suite for team number allocation (migration 071;
-- the visibility assertions follow 072: allocation grants no visibility).
--
-- Allocating a WhatsApp number to a team derives one
-- whatsapp_channel_members row per team member and leader (via_team),
-- and every access predicate reads that table. This asserts the
-- derivation follows the team as it changes, that a direct allocation
-- and a team allocation never cancel each other, that cascades leave
-- nothing stale, and who may call what.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000071001';
  u_admin  UUID := '00000000-0000-4000-8000-000000071002';
  u_lead   UUID := '00000000-0000-4000-8000-000000071003';
  u_m1     UUID := '00000000-0000-4000-8000-000000071004';
  u_m2     UUID := '00000000-0000-4000-8000-000000071005';
  u_new    UUID := '00000000-0000-4000-8000-000000071006';
  u_out    UUID := '00000000-0000-4000-8000-000000071007';
  u_lead2  UUID := '00000000-0000-4000-8000-000000071008';
  u_both   UUID := '00000000-0000-4000-8000-000000071009';
  u_solo   UUID := '00000000-0000-4000-8000-00000007100a';
  u_other  UUID := '00000000-0000-4000-8000-00000007100b';
  u_tm     UUID := '00000000-0000-4000-8000-00000007100c';
  u_tl     UUID := '00000000-0000-4000-8000-00000007100d';
  u_pd     UUID := '00000000-0000-4000-8000-00000007100e';
  u_dm     UUID := '00000000-0000-4000-8000-00000007100f';
  a_acct   UUID;
  b_acct   UUID;
  w1       UUID;
  w2       UUID;
  wb       UUID;
  w3       UUID;
  w4       UUID;
  w5       UUID;
  w6       UUID;
  w7       UUID;
  t1       UUID;
  t2       UUID;
  tb       UUID;
  t3       UUID;
  t4       UUID;
  t5       UUID;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as a signed-in user; 'ok' / the value, or the error.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.tn_try(p_uid uuid, p_sql text)
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

  -- The flags of one allocation row: 'direct', 'team', 'direct+team',
  -- or 'none' when there is no row.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.tn_row(p_config uuid, p_user uuid)
    RETURNS text LANGUAGE sql AS $body$
      SELECT coalesce((
        SELECT CASE WHEN direct AND via_team THEN 'direct+team'
                    WHEN direct THEN 'direct' ELSE 'team' END
          FROM public.whatsapp_channel_members
         WHERE config_id = p_config AND user_id = p_user), 'none');
    $body$
  $fn$;

  -- Fixture: account A (owner, admin, agents), account B (owner).
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'tn-owner@example.invalid'),
    (u_admin, 'tn-admin@example.invalid'),
    (u_lead,  'tn-lead@example.invalid'),
    (u_m1,    'tn-m1@example.invalid'),
    (u_m2,    'tn-m2@example.invalid'),
    (u_new,   'tn-new@example.invalid'),
    (u_out,   'tn-out@example.invalid'),
    (u_lead2, 'tn-lead2@example.invalid'),
    (u_both,  'tn-both@example.invalid'),
    (u_solo,  'tn-solo@example.invalid'),
    (u_other, 'tn-other@example.invalid'),
    (u_tm,    'tn-tm@example.invalid'),
    (u_tl,    'tn-tl@example.invalid'),
    (u_pd,    'tn-pd@example.invalid'),
    (u_dm,    'tn-dm@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_other;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id IN (u_lead, u_lead2);
  UPDATE profiles SET account_id = a_acct, account_role = 'agent'
   WHERE user_id IN (u_m1, u_m2, u_new, u_out, u_both, u_solo, u_tm, u_tl, u_pd, u_dm);

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'TN-071-A1', 'x', 'connected', true) RETURNING id INTO w1;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'TN-071-A2', 'x', 'connected', false) RETURNING id INTO w2;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_other, b_acct, 'whapi', 'TN-071-B1', 'x', 'connected', true) RETURNING id INTO wb;

  -- Team 1: led by u_lead (not a member), members m1, m2, both.
  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'TN Sales', u_lead) RETURNING id INTO t1;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES
    (t1, u_m1, a_acct), (t1, u_m2, a_acct), (t1, u_both, a_acct);
  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'TN Support', u_lead2) RETURNING id INTO t2;
  INSERT INTO teams (account_id, name, leader_user_id) VALUES (b_acct, 'TN Other', u_other) RETURNING id INTO tb;
  -- B has a direct allocation of its own, which A's syncs must not touch.
  INSERT INTO whatsapp_channel_members (config_id, user_id, account_id) VALUES (wb, u_other, b_acct);

  -- Before any allocation the number is shared.
  r := pg_temp.tn_try(u_out, format('SELECT can_use_channel(%L, %L)::text', a_acct, w1));
  n := n + 1;
  IF r <> 'true' THEN failed := array_append(failed, ('unallocated number not shared: ' || r)::text); END IF;

  -- ---------- allocate the team ----------
  r := pg_temp.tn_try(u_admin, format('SELECT set_channel_teams(%L, ARRAY[%L]::uuid[])::text', w1, t1));
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('admin set_channel_teams: ' || r)::text); END IF;

  n := n + 1;
  IF pg_temp.tn_row(w1, u_m1) <> 'team' OR pg_temp.tn_row(w1, u_m2) <> 'team'
     OR pg_temp.tn_row(w1, u_both) <> 'team' OR pg_temp.tn_row(w1, u_lead) <> 'team' THEN
    failed := array_append(failed, format('team allocation rows: m1=%s m2=%s both=%s lead=%s',
      pg_temp.tn_row(w1, u_m1), pg_temp.tn_row(w1, u_m2),
      pg_temp.tn_row(w1, u_both), pg_temp.tn_row(w1, u_lead)));
  END IF;
  n := n + 1;
  IF pg_temp.tn_row(w1, u_out) <> 'none' OR pg_temp.tn_row(w2, u_m1) <> 'none' THEN
    failed := array_append(failed, 'team allocation leaked to a non-member or another number'::text);
  END IF;

  r := pg_temp.tn_try(u_m1, format('SELECT can_use_channel(%L, %L)::text', a_acct, w1));
  n := n + 1;
  IF r <> 'true' THEN failed := array_append(failed, ('team member cannot use the number: ' || r)::text); END IF;
  r := pg_temp.tn_try(u_lead, format('SELECT can_use_channel(%L, %L)::text', a_acct, w1));
  n := n + 1;
  IF r <> 'true' THEN failed := array_append(failed, ('team leader cannot use the number: ' || r)::text); END IF;
  r := pg_temp.tn_try(u_out, format('SELECT can_use_channel(%L, %L)::text', a_acct, w1));
  n := n + 1;
  IF r <> 'false' THEN failed := array_append(failed, ('non-member can use the allocated number: ' || r)::text); END IF;

  -- 072: allocation is about sending, not seeing. A team member on w1
  -- must not see another agent's chat on w1 (the predicate takes the
  -- number as an argument, so no conversation fixture is needed), nor a
  -- contact that agent created. Their own chats and an admin's view stay.
  r := pg_temp.tn_try(u_m1, format(
         'SELECT can_view_conversation(%L, %L, NULL, %L, NULL)::text', a_acct, u_out, w1));
  n := n + 1;
  IF r <> 'false' THEN failed := array_append(failed, ('team-allocated agent sees another agent''s chat on the number: ' || r)::text); END IF;
  r := pg_temp.tn_try(u_lead, format(
         'SELECT can_view_conversation(%L, %L, NULL, %L, NULL)::text', a_acct, u_out, w1));
  n := n + 1;
  IF r <> 'false' THEN failed := array_append(failed, ('team-allocated leader sees a non-team agent''s chat on the number: ' || r)::text); END IF;
  r := pg_temp.tn_try(u_m1, format(
         'SELECT can_view_conversation(%L, %L, NULL, %L, NULL)::text', a_acct, u_m1, w1));
  n := n + 1;
  IF r <> 'true' THEN failed := array_append(failed, ('agent cannot see their own chat on an allocated number: ' || r)::text); END IF;
  r := pg_temp.tn_try(u_admin, format(
         'SELECT can_view_conversation(%L, %L, NULL, %L, NULL)::text', a_acct, u_out, w1));
  n := n + 1;
  IF r <> 'true' THEN failed := array_append(failed, ('admin cannot see a chat on the number: ' || r)::text); END IF;

  -- ---------- the team changes ----------
  r := pg_temp.tn_try(u_admin, format(
         'INSERT INTO team_members (team_id, user_id, account_id) VALUES (%L, %L, %L)', t1, u_new, a_acct));
  n := n + 1;
  IF r <> 'ok' OR pg_temp.tn_row(w1, u_new) <> 'team' THEN
    failed := array_append(failed, ('adding a person to the team did not grant: ' || r || ' / ' || pg_temp.tn_row(w1, u_new))::text);
  END IF;
  r := pg_temp.tn_try(u_new, format('SELECT can_use_channel(%L, %L)::text', a_acct, w1));
  n := n + 1;
  IF r <> 'true' THEN failed := array_append(failed, ('new team member cannot use the number: ' || r)::text); END IF;

  r := pg_temp.tn_try(u_admin, format(
         'DELETE FROM team_members WHERE team_id = %L AND user_id = %L', t1, u_m2));
  n := n + 1;
  IF r <> 'ok' OR pg_temp.tn_row(w1, u_m2) <> 'none' THEN
    failed := array_append(failed, ('removing a person from the team did not revoke: ' || r)::text);
  END IF;
  r := pg_temp.tn_try(u_m2, format('SELECT can_use_channel(%L, %L)::text', a_acct, w1));
  n := n + 1;
  IF r <> 'false' THEN failed := array_append(failed, ('removed member still uses the number: ' || r)::text); END IF;

  r := pg_temp.tn_try(u_admin, format('UPDATE teams SET leader_user_id = %L WHERE id = %L', u_out, t1));
  n := n + 1;
  IF r <> 'ok' OR pg_temp.tn_row(w1, u_out) <> 'team' OR pg_temp.tn_row(w1, u_lead) <> 'none' THEN
    failed := array_append(failed, format('changing the leader did not move access: %s new=%s old=%s',
      r, pg_temp.tn_row(w1, u_out), pg_temp.tn_row(w1, u_lead)));
  END IF;
  UPDATE teams SET leader_user_id = u_lead WHERE id = t1;

  -- ---------- direct and team never cancel each other ----------
  r := pg_temp.tn_try(u_admin, format('SELECT set_channel_members(%L, ARRAY[%L, %L]::uuid[])::text', w1, u_both, u_solo));
  n := n + 1;
  IF r <> 'ok' OR pg_temp.tn_row(w1, u_both) <> 'direct+team' OR pg_temp.tn_row(w1, u_solo) <> 'direct'
     OR pg_temp.tn_row(w1, u_m1) <> 'team' THEN
    failed := array_append(failed, format('set_channel_members with a team in place: %s both=%s solo=%s m1=%s',
      r, pg_temp.tn_row(w1, u_both), pg_temp.tn_row(w1, u_solo), pg_temp.tn_row(w1, u_m1)));
  END IF;

  r := pg_temp.tn_try(u_admin, format('SELECT set_channel_teams(%L, ARRAY[]::uuid[])::text', w1));
  n := n + 1;
  IF r <> 'ok' OR pg_temp.tn_row(w1, u_both) <> 'direct' OR pg_temp.tn_row(w1, u_m1) <> 'none'
     OR pg_temp.tn_row(w1, u_lead) <> 'none' THEN
    failed := array_append(failed, format('removing the team allocation: %s both=%s m1=%s lead=%s',
      r, pg_temp.tn_row(w1, u_both), pg_temp.tn_row(w1, u_m1), pg_temp.tn_row(w1, u_lead)));
  END IF;
  r := pg_temp.tn_try(u_both, format('SELECT can_use_channel(%L, %L)::text', a_acct, w1));
  n := n + 1;
  IF r <> 'true' THEN failed := array_append(failed, ('direct allocation lost with the team allocation: ' || r)::text); END IF;

  PERFORM pg_temp.tn_try(u_admin, format('SELECT set_channel_teams(%L, ARRAY[%L]::uuid[])::text', w1, t1));
  r := pg_temp.tn_try(u_admin, format('SELECT set_channel_members(%L, ARRAY[]::uuid[])::text', w1));
  n := n + 1;
  IF r <> 'ok' OR pg_temp.tn_row(w1, u_both) <> 'team' OR pg_temp.tn_row(w1, u_m1) <> 'team'
     OR pg_temp.tn_row(w1, u_solo) <> 'none' THEN
    failed := array_append(failed, format('set_channel_members empty list removed team access: %s both=%s m1=%s solo=%s',
      r, pg_temp.tn_row(w1, u_both), pg_temp.tn_row(w1, u_m1), pg_temp.tn_row(w1, u_solo)));
  END IF;
  r := pg_temp.tn_try(u_both, format('SELECT can_use_channel(%L, %L)::text', a_acct, w1));
  n := n + 1;
  IF r <> 'true' THEN failed := array_append(failed, ('team access lost after set_channel_members empty list: ' || r)::text); END IF;
  -- ...and the number is still allocated, not fallen back to shared.
  r := pg_temp.tn_try(u_out, format('SELECT can_use_channel(%L, %L)::text', a_acct, w1));
  n := n + 1;
  IF r <> 'false' THEN failed := array_append(failed, ('number became shared after set_channel_members empty list: ' || r)::text); END IF;

  -- ---------- set_team_channels ----------
  r := pg_temp.tn_try(u_admin, format('SELECT set_team_channels(%L, ARRAY[%L, %L]::uuid[])::text', t1, w1, w2));
  n := n + 1;
  IF r <> 'ok' OR pg_temp.tn_row(w2, u_m1) <> 'team' OR pg_temp.tn_row(w2, u_lead) <> 'team' THEN
    failed := array_append(failed, ('set_team_channels did not allocate the second number: ' || r)::text);
  END IF;
  r := pg_temp.tn_try(u_admin, format('SELECT set_team_channels(%L, ARRAY[%L]::uuid[])::text', t1, w2));
  n := n + 1;
  IF r <> 'ok' OR pg_temp.tn_row(w1, u_m1) <> 'none' OR pg_temp.tn_row(w2, u_m1) <> 'team' THEN
    failed := array_append(failed, ('set_team_channels did not replace the set: ' || r)::text);
  END IF;

  -- ---------- deleting a member's login ----------
  -- Their signup account (still owned by them) goes first; that also
  -- exercises the sync's account-deletion early return.
  DELETE FROM accounts WHERE owner_user_id = u_new;
  DELETE FROM auth.users WHERE id = u_new;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM whatsapp_channel_members WHERE user_id = u_new) THEN
    failed := array_append(failed, 'a deleted login kept its allocation rows'::text);
  END IF;

  -- ---------- cascades ----------
  PERFORM pg_temp.tn_try(u_admin, format('SELECT set_channel_teams(%L, ARRAY[%L, %L]::uuid[])::text', w1, t1, t2));
  r := pg_temp.tn_try(u_admin, format('DELETE FROM teams WHERE id = %L', t1));
  n := n + 1;
  IF r <> 'ok'
     OR EXISTS (SELECT 1 FROM whatsapp_channel_teams WHERE team_id = t1)
     OR EXISTS (SELECT 1 FROM whatsapp_channel_members
                 WHERE account_id = a_acct AND via_team AND user_id <> u_lead2) THEN
    failed := array_append(failed, ('deleting the team left derived rows: ' || r)::text);
  END IF;
  n := n + 1;
  IF pg_temp.tn_row(w1, u_lead2) <> 'team' THEN
    failed := array_append(failed, ('deleting one team removed another team''s rows: ' || pg_temp.tn_row(w1, u_lead2))::text);
  END IF;

  PERFORM pg_temp.tn_try(u_admin, format('SELECT set_team_channels(%L, ARRAY[%L, %L]::uuid[])::text', t2, w1, w2));
  r := pg_temp.tn_try(u_admin, format('DELETE FROM whatsapp_config WHERE id = %L', w2));
  n := n + 1;
  IF r <> 'ok'
     OR EXISTS (SELECT 1 FROM whatsapp_channel_teams WHERE config_id = w2)
     OR EXISTS (SELECT 1 FROM whatsapp_channel_members WHERE config_id = w2)
     OR pg_temp.tn_row(w1, u_lead2) <> 'team' THEN
    failed := array_append(failed, ('removing the number did not cascade cleanly: ' || r)::text);
  END IF;

  n := n + 1;
  IF pg_temp.tn_row(wb, u_other) <> 'direct' THEN
    failed := array_append(failed, 'account A''s syncs touched account B''s allocation'::text);
  END IF;

  -- ---------- who may call what ----------
  r := pg_temp.tn_try(u_admin, format('SELECT set_channel_teams(%L, ARRAY[%L]::uuid[])::text', w1, tb));
  n := n + 1;
  IF r NOT LIKE '%team must belong to this account%' THEN
    failed := array_append(failed, ('set_channel_teams with another account''s team: ' || r)::text);
  END IF;
  r := pg_temp.tn_try(u_admin, format('SELECT set_channel_teams(%L, ARRAY[%L]::uuid[])::text', wb, t2));
  n := n + 1;
  IF r NOT LIKE '%WhatsApp number not found%' THEN
    failed := array_append(failed, ('set_channel_teams on another account''s number: ' || r)::text);
  END IF;
  r := pg_temp.tn_try(u_admin, format('SELECT set_team_channels(%L, ARRAY[%L]::uuid[])::text', t2, wb));
  n := n + 1;
  IF r NOT LIKE '%number must belong to this account%' THEN
    failed := array_append(failed, ('set_team_channels with another account''s number: ' || r)::text);
  END IF;
  r := pg_temp.tn_try(u_admin, format('SELECT set_team_channels(%L, ARRAY[%L]::uuid[])::text', tb, w1));
  n := n + 1;
  IF r NOT LIKE '%Team not found%' THEN
    failed := array_append(failed, ('set_team_channels on another account''s team: ' || r)::text);
  END IF;

  r := pg_temp.tn_try(u_m1, format('SELECT set_channel_teams(%L, ARRAY[%L]::uuid[])::text', w1, t2));
  n := n + 1;
  IF r NOT LIKE '%WhatsApp number not found%' THEN
    failed := array_append(failed, ('an agent called set_channel_teams: ' || r)::text);
  END IF;
  r := pg_temp.tn_try(u_m1, format('SELECT set_team_channels(%L, ARRAY[%L]::uuid[])::text', t2, w1));
  n := n + 1;
  IF r NOT LIKE '%Team not found%' THEN
    failed := array_append(failed, ('an agent called set_team_channels: ' || r)::text);
  END IF;
  r := pg_temp.tn_try(u_m1, format(
         'INSERT INTO whatsapp_channel_teams (config_id, team_id, account_id) VALUES (%L, %L, %L)', w1, t2, a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN
    failed := array_append(failed, 'an agent wrote whatsapp_channel_teams directly'::text);
  END IF;

  r := pg_temp.tn_try(u_admin, format('SELECT sync_channel_team_members(%L)::text', a_acct));
  n := n + 1;
  IF r NOT LIKE '%permission denied%' THEN
    failed := array_append(failed, ('an admin called the sync function: ' || r)::text);
  END IF;
  n := n + 1;
  IF has_function_privilege('anon', 'public.sync_channel_team_members(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.sync_channel_team_members(uuid)', 'EXECUTE') THEN
    failed := array_append(failed, 'clients may EXECUTE sync_channel_team_members'::text);
  END IF;
  n := n + 1;
  IF has_function_privilege('anon', 'public.set_channel_teams(uuid, uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.set_team_channels(uuid, uuid[])', 'EXECUTE') THEN
    failed := array_append(failed, 'anon may call set_channel_teams / set_team_channels'::text);
  END IF;

  -- ---------- set_team_members / update_team are all or nothing ----------
  -- (a) t5 holds u_m1 and is w5's only allocation; u_solo joins t2.
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'TN-071-A5', 'x', 'connected', false) RETURNING id INTO w5;
  INSERT INTO teams (account_id, name) VALUES (a_acct, 'TN Five') RETURNING id INTO t5;
  r := pg_temp.tn_try(u_admin, format('SELECT set_team_members(%L, ARRAY[%L]::uuid[])::text', t5, u_m1));
  n := n + 1;
  IF r <> 'ok' OR NOT EXISTS (SELECT 1 FROM team_members WHERE team_id = t5 AND user_id = u_m1) THEN
    failed := array_append(failed, ('set_team_members did not add: ' || r)::text);
  END IF;
  PERFORM pg_temp.tn_try(u_admin, format('SELECT set_channel_teams(%L, ARRAY[%L]::uuid[])::text', w5, t5));
  r := pg_temp.tn_try(u_admin, format('SELECT set_team_members(%L, ARRAY[%L]::uuid[])::text', t2, u_solo));
  n := n + 1;
  IF r <> 'ok' OR pg_temp.tn_row(w1, u_solo) <> 'team' THEN
    failed := array_append(failed, ('set_team_members on t2: ' || r || ' / ' || pg_temp.tn_row(w1, u_solo))::text);
  END IF;

  r := pg_temp.tn_try(u_admin, format('SELECT set_team_members(%L, ARRAY[%L, %L]::uuid[])::text', t5, u_m2, u_solo));
  n := n + 1;
  IF r NOT LIKE '%already in another team%' THEN
    failed := array_append(failed, ('set_team_members with someone in another team: ' || r)::text);
  END IF;
  n := n + 1;
  IF (SELECT array_agg(user_id) FROM team_members WHERE team_id = t5) IS DISTINCT FROM ARRAY[u_m1]
     OR pg_temp.tn_row(w5, u_m1) <> 'team' OR pg_temp.tn_row(w5, u_m2) <> 'none'
     OR pg_temp.tn_row(w1, u_solo) <> 'team' THEN
    failed := array_append(failed, format('a refused set_team_members changed the team: members=%s m1=%s m2=%s solo=%s',
      (SELECT array_agg(user_id) FROM team_members WHERE team_id = t5),
      pg_temp.tn_row(w5, u_m1), pg_temp.tn_row(w5, u_m2), pg_temp.tn_row(w1, u_solo)));
  END IF;
  r := pg_temp.tn_try(u_out, format('SELECT can_use_channel(%L, %L)::text', a_acct, w5));
  n := n + 1;
  IF r <> 'false' THEN failed := array_append(failed, ('a refused set_team_members left the number shared: ' || r)::text); END IF;

  -- The route's path: name, members and numbers in one call; a refused
  -- member list leaves the name and the numbers as they were too.
  r := pg_temp.tn_try(u_admin, format(
         'SELECT update_team(%L, %L, false, NULL, ARRAY[%L]::uuid[], ARRAY[%L]::uuid[])::text',
         t5, 'TN Five renamed', u_solo, w1));
  n := n + 1;
  IF r NOT LIKE '%already in another team%'
     OR (SELECT name FROM teams WHERE id = t5) <> 'TN Five'
     OR EXISTS (SELECT 1 FROM whatsapp_channel_teams WHERE team_id = t5 AND config_id = w1)
     OR pg_temp.tn_row(w5, u_m1) <> 'team' THEN
    failed := array_append(failed, ('a refused update_team was half applied: ' || r)::text);
  END IF;
  r := pg_temp.tn_try(u_admin, format(
         'SELECT update_team(%L, %L, true, %L, ARRAY[%L, %L]::uuid[], ARRAY[%L, %L]::uuid[])::text',
         t5, 'TN Five renamed', u_lead, u_m1, u_m2, w5, w1));
  n := n + 1;
  IF r <> 'ok' OR (SELECT name FROM teams WHERE id = t5) <> 'TN Five renamed'
     OR pg_temp.tn_row(w1, u_m2) <> 'team' OR pg_temp.tn_row(w5, u_lead) <> 'team' THEN
    failed := array_append(failed, format('update_team did not apply: %s m2@w1=%s lead@w5=%s',
      r, pg_temp.tn_row(w1, u_m2), pg_temp.tn_row(w5, u_lead)));
  END IF;
  r := pg_temp.tn_try(u_admin, format('SELECT update_team(%L, %L)::text', t5, 'TN Support'));
  n := n + 1;
  IF r NOT LIKE '%team with that name already exists%' THEN
    failed := array_append(failed, ('update_team with a taken name: ' || r)::text);
  END IF;
  r := pg_temp.tn_try(u_admin, format('SELECT update_team(%L, NULL, true, %L)::text', t5, u_other));
  n := n + 1;
  IF r NOT LIKE '%leader must be a member of this account%' THEN
    failed := array_append(failed, ('update_team with another account''s leader: ' || r)::text);
  END IF;

  -- ---------- set_channel_access: both lists in one transaction ----------
  -- (b)
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'TN-071-A6', 'x', 'connected', false) RETURNING id INTO w6;
  r := pg_temp.tn_try(u_admin, format('SELECT set_channel_access(%L, ARRAY[%L]::uuid[], ARRAY[%L]::uuid[])::text', w6, u_out, t2));
  n := n + 1;
  IF r <> 'ok' OR pg_temp.tn_row(w6, u_out) <> 'direct' OR pg_temp.tn_row(w6, u_lead2) <> 'team'
     OR pg_temp.tn_row(w6, u_solo) <> 'team' THEN
    failed := array_append(failed, format('set_channel_access did not set both lists: %s out=%s lead2=%s solo=%s',
      r, pg_temp.tn_row(w6, u_out), pg_temp.tn_row(w6, u_lead2), pg_temp.tn_row(w6, u_solo)));
  END IF;
  r := pg_temp.tn_try(u_admin, format('SELECT set_channel_access(%L, ARRAY[]::uuid[], ARRAY[%L]::uuid[])::text', w6, tb));
  n := n + 1;
  IF r NOT LIKE '%team must belong to this account%' OR pg_temp.tn_row(w6, u_out) <> 'direct'
     OR pg_temp.tn_row(w6, u_lead2) <> 'team' THEN
    failed := array_append(failed, format('a refused set_channel_access changed the direct list: %s out=%s',
      r, pg_temp.tn_row(w6, u_out)));
  END IF;
  r := pg_temp.tn_try(u_admin, format('SELECT set_channel_access(%L, NULL, ARRAY[]::uuid[])::text', w6));
  n := n + 1;
  IF r <> 'ok' OR pg_temp.tn_row(w6, u_out) <> 'direct' OR pg_temp.tn_row(w6, u_lead2) <> 'none' THEN
    failed := array_append(failed, ('set_channel_access with a NULL people list touched it: ' || r)::text);
  END IF;
  r := pg_temp.tn_try(u_admin, format('SELECT set_channel_access(%L, ARRAY[%L]::uuid[], NULL)::text', w6, u_other));
  n := n + 1;
  IF r NOT LIKE '%person must be a member of this account%' OR pg_temp.tn_row(w6, u_out) <> 'direct' THEN
    failed := array_append(failed, ('set_channel_access with another account''s person: ' || r)::text);
  END IF;

  -- ---------- leaving the account leaves its teams ----------
  -- (c) w3 is allocated only to t3: leader u_tl, member u_tm.
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'TN-071-A3', 'x', 'connected', false) RETURNING id INTO w3;
  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'TN Three', u_tl) RETURNING id INTO t3;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (t3, u_tm, a_acct);
  PERFORM pg_temp.tn_try(u_admin, format('SELECT set_channel_teams(%L, ARRAY[%L]::uuid[])::text', w3, t3));
  r := pg_temp.tn_try(u_out, format('SELECT can_use_channel(%L, %L)::text', a_acct, w3));
  n := n + 1;
  IF r <> 'false' THEN failed := array_append(failed, ('fixture: w3 not restricted to t3: ' || r)::text); END IF;

  -- remove_account_member gives them a fresh account, and one owner has
  -- one account (idx_accounts_one_per_owner): drop the signup ones.
  DELETE FROM accounts WHERE owner_user_id IN (u_tm, u_tl);
  r := pg_temp.tn_try(u_admin, format('SELECT remove_account_member(%L)::text', u_tm));
  n := n + 1;
  IF r LIKE 'ERROR:%' OR EXISTS (SELECT 1 FROM whatsapp_channel_members WHERE user_id = u_tm)
     OR EXISTS (SELECT 1 FROM team_members WHERE user_id = u_tm) THEN
    failed := array_append(failed, ('a removed member kept their team or its access: ' || r)::text);
  END IF;
  r := pg_temp.tn_try(u_admin, format('SELECT remove_account_member(%L)::text', u_tl));
  n := n + 1;
  IF r LIKE 'ERROR:%' OR EXISTS (SELECT 1 FROM whatsapp_channel_members WHERE user_id = u_tl)
     OR (SELECT leader_user_id FROM teams WHERE id = t3) IS NOT NULL THEN
    failed := array_append(failed, ('a removed leader kept their team or its access: ' || r)::text);
  END IF;
  r := pg_temp.tn_try(u_out, format('SELECT can_use_channel(%L, %L)::text', a_acct, w3));
  n := n + 1;
  IF r <> 'true' THEN failed := array_append(failed, ('a number whose team emptied by removal is not shared again: ' || r)::text); END IF;

  -- A deleted profile is the same case.
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'TN-071-A4', 'x', 'connected', false) RETURNING id INTO w4;
  INSERT INTO teams (account_id, name) VALUES (a_acct, 'TN Four') RETURNING id INTO t4;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (t4, u_pd, a_acct);
  INSERT INTO whatsapp_channel_teams (config_id, team_id, account_id) VALUES (w4, t4, a_acct);
  DELETE FROM profiles WHERE user_id = u_pd;
  r := pg_temp.tn_try(u_out, format('SELECT can_use_channel(%L, %L)::text', a_acct, w4));
  n := n + 1;
  IF r <> 'true' OR EXISTS (SELECT 1 FROM team_members WHERE user_id = u_pd) THEN
    failed := array_append(failed, ('a deleted profile kept its team or the number restricted: ' || r)::text);
  END IF;

  -- (e) A number allocated directly to one person only: removing them
  -- must not leave it restricted to nobody. The sync only maintains
  -- via-team rows, so the profiles trigger deletes the direct ones.
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'TN-071-A7', 'x', 'connected', false) RETURNING id INTO w7;
  PERFORM pg_temp.tn_try(u_admin, format('SELECT set_channel_members(%L, ARRAY[%L]::uuid[])::text', w7, u_dm));
  r := pg_temp.tn_try(u_out, format('SELECT can_use_channel(%L, %L)::text', a_acct, w7));
  n := n + 1;
  IF r <> 'false' OR pg_temp.tn_row(w7, u_dm) <> 'direct' THEN
    failed := array_append(failed, ('fixture: w7 not restricted to u_dm: ' || r)::text);
  END IF;
  DELETE FROM accounts WHERE owner_user_id = u_dm;
  r := pg_temp.tn_try(u_admin, format('SELECT remove_account_member(%L)::text', u_dm));
  n := n + 1;
  IF r LIKE 'ERROR:%' OR EXISTS (SELECT 1 FROM whatsapp_channel_members WHERE user_id = u_dm) THEN
    failed := array_append(failed, ('a removed member kept a direct allocation: ' || r)::text);
  END IF;
  r := pg_temp.tn_try(u_out, format('SELECT can_use_channel(%L, %L)::text', a_acct, w7));
  n := n + 1;
  IF r <> 'true' THEN failed := array_append(failed, ('a number allocated only to a removed member is not shared again: ' || r)::text); END IF;

  -- ---------- (d) the combined RPCs: admins of this account only ----------
  r := pg_temp.tn_try(u_m1, format('SELECT set_channel_access(%L, ARRAY[]::uuid[], ARRAY[]::uuid[])::text', w6));
  n := n + 1;
  IF r NOT LIKE '%WhatsApp number not found%' OR pg_temp.tn_row(w6, u_out) <> 'direct' THEN
    failed := array_append(failed, ('an agent called set_channel_access: ' || r)::text);
  END IF;
  r := pg_temp.tn_try(u_m1, format('SELECT set_team_members(%L, ARRAY[]::uuid[])::text', t5));
  n := n + 1;
  IF r NOT LIKE '%Team not found%' OR NOT EXISTS (SELECT 1 FROM team_members WHERE team_id = t5) THEN
    failed := array_append(failed, ('an agent called set_team_members: ' || r)::text);
  END IF;
  r := pg_temp.tn_try(u_m1, format('SELECT update_team(%L, %L)::text', t5, 'TN hijack'));
  n := n + 1;
  IF r NOT LIKE '%Team not found%' THEN
    failed := array_append(failed, ('an agent called update_team: ' || r)::text);
  END IF;
  r := pg_temp.tn_try(u_admin, format('SELECT set_channel_access(%L, ARRAY[]::uuid[], NULL)::text', wb));
  n := n + 1;
  IF r NOT LIKE '%WhatsApp number not found%' OR pg_temp.tn_row(wb, u_other) <> 'direct' THEN
    failed := array_append(failed, ('set_channel_access on another account''s number: ' || r)::text);
  END IF;
  r := pg_temp.tn_try(u_admin, format('SELECT set_team_members(%L, ARRAY[]::uuid[])::text', tb));
  n := n + 1;
  IF r NOT LIKE '%Team not found%' THEN
    failed := array_append(failed, ('set_team_members on another account''s team: ' || r)::text);
  END IF;
  r := pg_temp.tn_try(u_admin, format('SELECT update_team(%L, %L)::text', tb, 'TN hijack'));
  n := n + 1;
  IF r NOT LIKE '%Team not found%' THEN
    failed := array_append(failed, ('update_team on another account''s team: ' || r)::text);
  END IF;
  r := pg_temp.tn_try(u_admin, format('SELECT set_team_members(%L, ARRAY[%L]::uuid[])::text', t5, u_other));
  n := n + 1;
  IF r NOT LIKE '%must be a member of this account%' THEN
    failed := array_append(failed, ('set_team_members with another account''s person: ' || r)::text);
  END IF;
  n := n + 1;
  IF has_function_privilege('anon', 'public.set_team_members(uuid, uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.set_channel_access(uuid, uuid[], uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.update_team(uuid, text, boolean, uuid, uuid[], uuid[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.profiles_leave_account_teams()', 'EXECUTE') THEN
    failed := array_append(failed, 'anon may call the 071 RPCs, or clients the profiles trigger function'::text);
  END IF;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT071', MESSAGE = 'verify-team-numbers rollback';
  EXCEPTION WHEN SQLSTATE 'ZT071' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'team number allocation verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'team number allocation verification passed (% checks)', n;
END
$verify$;
