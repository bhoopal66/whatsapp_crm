-- Behavioural regression suite for personal WhatsApp numbers
-- (migration 190).
--
-- A personal number is an agent's own OpenWA number in the workspace.
-- Its chats are visible to its owner and to the team leaders of the
-- owner, besides the usual rules; it is never the primary number, a
-- route, or allocated to people or teams; whether a number is personal
-- and whose it is never change; and only an owner/admin grants the
-- permission to connect one. This asserts the grant through every
-- predicate that carries it and through the real RLS, that the grant
-- follows the chat's number, every refusal, and the privileges.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000190001';
  u_admin  UUID := '00000000-0000-4000-8000-000000190002';
  u_p      UUID := '00000000-0000-4000-8000-000000190003';  -- has a personal number
  u_lead   UUID := '00000000-0000-4000-8000-000000190004';  -- leads P's team
  u_x      UUID := '00000000-0000-4000-8000-000000190005';  -- owns the chat
  u_y      UUID := '00000000-0000-4000-8000-000000190006';  -- unrelated agent
  u_v      UUID := '00000000-0000-4000-8000-000000190007';  -- viewer
  a_acct   UUID;
  t_team   UUID;
  w_pn     UUID;  -- P's personal number
  w_co     UUID;  -- a company number
  c_ct     UUID;
  c_cv     UUID;
  b_acct   UUID;  -- P's second workspace
  v_primary BOOLEAN;
  u        UUID;
  who      TEXT;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as a signed-in user: 'ok' / the value, or
  -- 'ERROR <sqlstate> <hint>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.pn_try(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; st text; h text; m text;
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
        GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, h = PG_EXCEPTION_HINT,
                                m = MESSAGE_TEXT;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN format('ERROR %s %s: %s', st, coalesce(h, ''), m);
      END;
    END $body$
  $fn$;

  -- The same as the table owner (no JWT role): triggers and constraints
  -- bind every writer, so these refusals must hold here too.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.pn_raw(p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE st text; h text; m text;
    BEGIN
      EXECUTE p_sql;
      RETURN 'ok';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, h = PG_EXCEPTION_HINT,
                              m = MESSAGE_TEXT;
      RETURN format('ERROR %s %s: %s', st, coalesce(h, ''), m);
    END $body$
  $fn$;

  -- Fixture: one account; the auth.users trigger provisions each person
  -- an account of their own, and everyone but the owner moves into the
  -- owner's.
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'pn-owner@example.invalid'),
    (u_admin, 'pn-admin@example.invalid'),
    (u_p,     'pn-p@example.invalid'),
    (u_lead,  'pn-lead@example.invalid'),
    (u_x,     'pn-x@example.invalid'),
    (u_y,     'pn-y@example.invalid'),
    (u_v,     'pn-v@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_p, u_x, u_y);
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_v;
  INSERT INTO teams (account_id, name, leader_user_id)
    VALUES (a_acct, 'PN team', u_lead) RETURNING id INTO t_team;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (t_team, u_p, a_acct);

  -- ---- The permission ----------------------------------------------
  r := pg_temp.pn_try(u_p, format(
    'UPDATE profiles SET may_connect_personal_whatsapp = true WHERE user_id = %L', u_p));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%'
     OR (SELECT may_connect_personal_whatsapp FROM profiles WHERE user_id = u_p) THEN
    failed := array_append(failed, ('a person granted themselves the permission: ' || r)::text);
  END IF;

  r := pg_temp.pn_try(u_x, format('SELECT set_member_personal_whatsapp(%L, true)::text', u_y));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('an agent granted the permission: ' || r)::text);
  END IF;

  r := pg_temp.pn_try(u_owner, format('SELECT set_member_personal_whatsapp(%L, true)::text', u_v));
  n := n + 1;
  IF r NOT LIKE 'ERROR 22023 not_eligible%' THEN
    failed := array_append(failed, ('a viewer was granted the permission: ' || r)::text);
  END IF;

  r := pg_temp.pn_try(u_owner, format('SELECT set_member_personal_whatsapp(%L, true)::text',
    '00000000-0000-4000-8000-0000001900ff'));
  n := n + 1;
  IF r NOT LIKE 'ERROR P0002%' THEN
    failed := array_append(failed, ('granting an unknown person: ' || r)::text);
  END IF;

  r := pg_temp.pn_try(u_owner, format('SELECT set_member_personal_whatsapp(%L, true)::text', u_p));
  n := n + 1;
  IF r LIKE 'ERROR%'
     OR NOT (SELECT may_connect_personal_whatsapp FROM profiles WHERE user_id = u_p) THEN
    failed := array_append(failed, ('the owner could not grant an agent: ' || r)::text);
  END IF;

  -- ---- The number --------------------------------------------------
  r := pg_temp.pn_raw(format(
    'INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, is_personal)
     VALUES (%L, %L, ''openwa'', ''pn-sess-x'', ''t'', true)', u_x, a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501 PERSONAL_NOT_ALLOWED%' THEN
    failed := array_append(failed, ('a personal number without the permission: ' || r)::text);
  END IF;

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, is_personal, is_primary)
    VALUES (u_p, a_acct, 'openwa', 'pn-sess-p', 't', true, true)
    RETURNING id, is_primary INTO w_pn, v_primary;
  n := n + 1;
  IF v_primary THEN
    failed := array_append(failed, 'a personal number was inserted as primary'::text);
  END IF;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token)
    VALUES (u_owner, a_acct, 'openwa', 'pn-sess-co', 't') RETURNING id INTO w_co;

  r := pg_temp.pn_raw(format(
    'INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, is_personal)
     VALUES (%L, %L, ''openwa'', ''pn-sess-p2'', ''t'', true)', u_p, a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23505%' THEN
    failed := array_append(failed, ('a second personal number for one person: ' || r)::text);
  END IF;

  r := pg_temp.pn_raw(format('UPDATE whatsapp_config SET is_primary = true WHERE id = %L', w_pn));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514%' THEN
    failed := array_append(failed, ('a personal number made primary directly: ' || r)::text);
  END IF;

  r := pg_temp.pn_raw(format('UPDATE whatsapp_config SET is_personal = false WHERE id = %L', w_pn));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501 PERSONAL_NUMBER%' THEN
    failed := array_append(failed, ('a personal number became a company number: ' || r)::text);
  END IF;
  r := pg_temp.pn_raw(format('UPDATE whatsapp_config SET is_personal = true WHERE id = %L', w_co));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501 PERSONAL_NUMBER%' THEN
    failed := array_append(failed, ('a company number became personal: ' || r)::text);
  END IF;
  r := pg_temp.pn_raw(format('UPDATE whatsapp_config SET user_id = %L WHERE id = %L', u_x, w_pn));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501 PERSONAL_NUMBER%' THEN
    failed := array_append(failed, ('a personal number changed hands: ' || r)::text);
  END IF;

  r := pg_temp.pn_try(u_owner, format('SELECT set_member_personal_whatsapp(%L, false)::text', u_p));
  n := n + 1;
  IF r NOT LIKE 'ERROR 22023 PERSONAL_NUMBER_EXISTS%' THEN
    failed := array_append(failed, ('revoked while the number exists: ' || r)::text);
  END IF;

  r := pg_temp.pn_try(u_owner, format('SELECT set_primary_channel(%L)::text', w_pn));
  n := n + 1;
  IF r NOT LIKE 'ERROR 22023 PERSONAL_NUMBER%' THEN
    failed := array_append(failed, ('set_primary_channel on a personal number: ' || r)::text);
  END IF;

  r := pg_temp.pn_raw(format(
    'INSERT INTO whatsapp_routes (account_id, surface, config_id) VALUES (%L, ''broadcast'', %L)',
    a_acct, w_pn));
  n := n + 1;
  IF r NOT LIKE 'ERROR 22023 PERSONAL_NUMBER%' THEN
    failed := array_append(failed, ('a route to a personal number: ' || r)::text);
  END IF;

  r := pg_temp.pn_raw(format(
    'INSERT INTO whatsapp_channel_members (config_id, user_id, account_id) VALUES (%L, %L, %L)',
    w_pn, u_x, a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 22023 PERSONAL_NUMBER%' THEN
    failed := array_append(failed, ('a person allocated to a personal number: ' || r)::text);
  END IF;
  INSERT INTO whatsapp_channel_members (config_id, user_id, account_id) VALUES (w_co, u_y, a_acct);
  r := pg_temp.pn_raw(format(
    'UPDATE whatsapp_channel_members SET config_id = %L WHERE config_id = %L AND user_id = %L',
    w_pn, w_co, u_y));
  n := n + 1;
  IF r NOT LIKE 'ERROR 22023 PERSONAL_NUMBER%' THEN
    failed := array_append(failed, ('an allocation moved onto a personal number: ' || r)::text);
  END IF;
  DELETE FROM whatsapp_channel_members WHERE config_id = w_co;

  r := pg_temp.pn_raw(format(
    'INSERT INTO whatsapp_channel_teams (config_id, team_id, account_id) VALUES (%L, %L, %L)',
    w_pn, t_team, a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 22023 PERSONAL_NUMBER%' THEN
    failed := array_append(failed, ('a team allocated to a personal number: ' || r)::text);
  END IF;

  -- ---- Visibility --------------------------------------------------
  -- X's chat on P's personal number: X owns it, nobody is assigned, and
  -- X is in no team, so P and L see it only through the 190 grant.
  INSERT INTO contacts (account_id, user_id, phone, name)
    VALUES (a_acct, u_x, '971500190001', 'PN customer') RETURNING id INTO c_ct;
  PERFORM set_config('request.jwt.claim.sub', u_owner::text, true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  INSERT INTO conversations (account_id, user_id, contact_id, channel_id)
    VALUES (a_acct, u_x, c_ct, w_pn) RETURNING id INTO c_cv;
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_type, content_text)
    VALUES (c_cv, 'agent', u_x, 'text', 'pn hello');
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);

  FOR u, who IN SELECT * FROM (VALUES (u_p, 'number owner'), (u_lead, 'owner''s leader'),
                                      (u_admin, 'admin'), (u_y, 'unrelated agent')) s
  LOOP
    r := pg_temp.pn_try(u, format(
      'SELECT concat_ws('','',
         can_view_conversation(%1$L, %2$L, NULL, %3$L, NULL),
         can_view_conversation(%1$L, %2$L, NULL, %3$L),
         can_view_contact(%1$L, %4$L, %2$L),
         %4$L::uuid IN (SELECT contact_visibility_chat_contact_ids()),
         (SELECT count(*) FROM conversations WHERE id = %5$L),
         (SELECT count(*) FROM messages WHERE conversation_id = %5$L))',
      a_acct, u_x, w_pn, c_ct, c_cv));
    n := n + 1;
    IF u = u_y AND r <> 'f,f,f,f,0,0' THEN
      failed := array_append(failed, (who || ' sees the chat on a personal number: ' || r)::text);
    ELSIF u = u_admin AND r NOT LIKE 't,t,t,%,1,1' THEN
      failed := array_append(failed, (who || ' cannot see the chat: ' || r)::text);
    ELSIF u IN (u_p, u_lead) AND r <> 't,t,t,t,1,1' THEN
      failed := array_append(failed, (who || ' cannot see the chat on the personal number: ' || r)::text);
    END IF;
  END LOOP;

  FOR u, who IN SELECT * FROM (VALUES (u_p, 'number owner'), (u_lead, 'owner''s leader'),
                                      (u_y, 'unrelated agent')) s
  LOOP
    r := concat_ws(',',
      memory_can_read(u, a_acct, 'contact', c_ct),
      can_view_conversation_for_user(u, a_acct, u_x, NULL, w_pn));
    n := n + 1;
    IF r <> (CASE WHEN u = u_y THEN 'f,f' ELSE 't,t' END) THEN
      failed := array_append(failed, (who || ': memory_can_read, can_view_conversation_for_user = ' || r)::text);
    END IF;
  END LOOP;

  r := pg_temp.pn_try(u_p, format('SELECT (%L::uuid IN (SELECT pbx_visible_contact_ids()))::text', c_ct));
  n := n + 1;
  IF r <> 'true' THEN
    failed := array_append(failed, ('pbx_visible_contact_ids leaves out the number owner''s contact: ' || r)::text);
  END IF;
  r := pg_temp.pn_try(u_y, format('SELECT (%L::uuid IN (SELECT pbx_visible_contact_ids()))::text', c_ct));
  n := n + 1;
  IF r <> 'false' THEN
    failed := array_append(failed, ('pbx_visible_contact_ids hands an unrelated agent the contact: ' || r)::text);
  END IF;

  -- ---- Using the number --------------------------------------------
  FOR u, who IN SELECT * FROM (VALUES (u_p, 'number owner'), (u_lead, 'owner''s leader'),
                                      (u_admin, 'admin'), (u_x, 'chat owner'),
                                      (u_y, 'unrelated agent')) s
  LOOP
    r := pg_temp.pn_try(u, format('SELECT can_use_channel(%L, %L)::text', a_acct, w_pn));
    n := n + 1;
    IF r <> (CASE WHEN u IN (u_x, u_y) THEN 'false' ELSE 'true' END) THEN
      failed := array_append(failed, (who || ': can_use_channel on the personal number = ' || r)::text);
    END IF;
  END LOOP;

  -- The owner must still be staff who can send there: demoted to
  -- viewer, they keep the number but may not use it.
  UPDATE profiles SET account_role = 'viewer' WHERE user_id = u_p AND account_id = a_acct;
  r := pg_temp.pn_try(u_p, format('SELECT can_use_channel(%L, %L)::text', a_acct, w_pn));
  n := n + 1;
  IF r <> 'false' THEN
    failed := array_append(failed, ('a number owner demoted to viewer can still use it: ' || r)::text);
  END IF;
  UPDATE profiles SET account_role = 'agent' WHERE user_id = u_p AND account_id = a_acct;

  -- The connect guard holds the RPC's grant rule: a viewer with the
  -- flag set (set here as the table owner) still cannot connect.
  UPDATE profiles SET may_connect_personal_whatsapp = true WHERE user_id = u_v;
  r := pg_temp.pn_raw(format(
    'INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, is_personal)
     VALUES (%L, %L, ''openwa'', ''pn-sess-v'', ''t'', true)', u_v, a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501 PERSONAL_NOT_ALLOWED%' THEN
    failed := array_append(failed, ('a viewer with the flag connected a personal number: ' || r)::text);
  END IF;
  UPDATE profiles SET may_connect_personal_whatsapp = false WHERE user_id = u_v;

  -- A route moved onto a personal number, not only inserted on one.
  INSERT INTO whatsapp_routes (account_id, surface, config_id) VALUES (a_acct, 'broadcast', w_co);
  r := pg_temp.pn_raw(format(
    'UPDATE whatsapp_routes SET config_id = %L WHERE account_id = %L AND surface = ''broadcast''',
    w_pn, a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 22023 PERSONAL_NUMBER%' THEN
    failed := array_append(failed, ('a route moved onto a personal number: ' || r)::text);
  END IF;
  DELETE FROM whatsapp_routes WHERE account_id = a_acct AND surface = 'broadcast';

  -- P working in another workspace: the grant needs the caller's
  -- ACTIVE account, so the chat and the number close while B is active.
  -- profiles_one_active_per_user: demote A before promoting B.
  SELECT id INTO b_acct FROM accounts WHERE owner_user_id = u_p;
  IF b_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: no second account for P';
  END IF;
  INSERT INTO profiles (user_id, account_id, full_name, email, account_role, is_active)
    VALUES (u_p, b_acct, 'PN P', 'pn-p@example.invalid', 'agent', false);
  UPDATE profiles SET is_active = false WHERE user_id = u_p AND account_id = a_acct;
  UPDATE profiles SET is_active = true WHERE user_id = u_p AND account_id = b_acct;
  r := pg_temp.pn_try(u_p, format(
    'SELECT concat_ws('','', can_view_conversation(%1$L, %2$L, NULL, %3$L, NULL),
       can_use_channel(%1$L, %3$L))', a_acct, u_x, w_pn));
  n := n + 1;
  IF r <> 'f,f' THEN
    failed := array_append(failed, ('the number owner, active in another workspace, still sees or uses it: ' || r)::text);
  END IF;
  UPDATE profiles SET is_active = false WHERE user_id = u_p AND account_id = b_acct;
  UPDATE profiles SET is_active = true WHERE user_id = u_p AND account_id = a_acct;

  -- ---- The grant follows the chat's number -------------------------
  PERFORM set_config('request.jwt.claim.sub', u_owner::text, true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  UPDATE conversations SET channel_id = w_co WHERE id = c_cv;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);

  r := pg_temp.pn_try(u_p, format(
    'SELECT concat_ws('','', can_view_conversation(%1$L, %2$L, NULL, %3$L, NULL),
       (SELECT count(*) FROM conversations WHERE id = %4$L))', a_acct, u_x, w_co, c_cv));
  n := n + 1;
  IF r <> 'f,0' THEN
    failed := array_append(failed, ('the number owner still sees a chat moved to a company number: ' || r)::text);
  END IF;
  r := pg_temp.pn_try(u_x, format(
    'SELECT concat_ws('','', can_view_conversation(%1$L, %2$L, NULL, %3$L, NULL),
       (SELECT count(*) FROM conversations WHERE id = %4$L))', a_acct, u_x, w_co, c_cv));
  n := n + 1;
  IF r <> 't,1' THEN
    failed := array_append(failed, ('the chat owner lost the chat moved to a company number: ' || r)::text);
  END IF;

  -- ---- Privileges --------------------------------------------------
  n := n + 1;
  IF has_function_privilege('authenticated', 'public.refuse_personal_number_config()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.refuse_personal_number_config()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.whatsapp_config_personal_guard()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.whatsapp_config_personal_guard()', 'EXECUTE') THEN
    failed := array_append(failed, 'clients may call the 190 trigger functions'::text);
  END IF;
  n := n + 1;
  IF NOT has_function_privilege('authenticated', 'public.set_member_personal_whatsapp(uuid, boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.set_member_personal_whatsapp(uuid, boolean)', 'EXECUTE') THEN
    failed := array_append(failed, 'set_member_personal_whatsapp: authenticated must, anon must not, execute'::text);
  END IF;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT190', MESSAGE = 'verify-personal-numbers rollback';
  EXCEPTION WHEN SQLSTATE 'ZT190' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'personal number verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'personal number verification passed (% checks)', n;
END
$verify$;
