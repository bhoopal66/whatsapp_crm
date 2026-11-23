-- Behavioural check for migration 208: WhatsApp groups on company
-- OpenWA numbers.
--
-- whatsapp_group_can_create is true for an admin on a company OpenWA
-- number (and still on Whapi), false on a personal OpenWA number (190)
-- and on a Meta number; the whatsapp_groups_guard trigger accepts a
-- group on company OpenWA and refuses one on personal OpenWA or Meta.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The fixtures are
-- rolled back by a sentinel exception; the collected results (plpgsql
-- variables) survive it.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000208001';
  u_admin  UUID := '00000000-0000-4000-8000-000000208002';
  u_pers   UUID := '00000000-0000-4000-8000-000000208003';  -- agent allowed a personal number
  a_acct   UUID;
  w_whapi  UUID;
  w_co     UUID;  -- company OpenWA
  w_pn     UUID;  -- personal OpenWA
  w_meta   UUID;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.go_try(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        EXECUTE p_sql INTO v;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(v, 'ok');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'go-owner@example.invalid'),
    (u_admin, 'go-admin@example.invalid'),
    (u_pers,  'go-pers@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_pers;
  -- Granted there: a grant does not move in with the row (265).
  UPDATE profiles SET may_connect_personal_whatsapp = true WHERE user_id = u_pers;

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'GO-208-W', 'x', 'connected', true) RETURNING id INTO w_whapi;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'openwa', 'GO-208-CO', 'x', 'connected', false) RETURNING id INTO w_co;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary, is_personal)
  VALUES (u_pers, a_acct, 'openwa', 'GO-208-PN', 'x', 'connected', false, true) RETURNING id INTO w_pn;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'meta', 'GO-208-M', 'x', 'connected', false) RETURNING id INTO w_meta;

  -- ---------- who creates ----------
  r := pg_temp.go_try(u_admin, format(
    'SELECT whatsapp_group_can_create(%L)::text || ''/'' || whatsapp_group_can_create(%L)::text || ''/'' || whatsapp_group_can_create(%L)::text || ''/'' || whatsapp_group_can_create(%L)::text',
    w_whapi, w_co, w_pn, w_meta));
  n := n + 1;
  IF r <> 'true/true/false/false' THEN
    failed := array_append(failed, ('admin create on Whapi/company OpenWA/personal OpenWA/Meta: ' || r)::text);
  END IF;
  -- The personal number's own holder may not host a group on it either.
  r := pg_temp.go_try(u_pers, format('SELECT whatsapp_group_can_create(%L)::text', w_pn));
  n := n + 1;
  IF r <> 'false' THEN
    failed := array_append(failed, ('the owner of a personal number may create a group on it: ' || r)::text);
  END IF;

  -- ---------- the channel guard ----------
  BEGIN
    INSERT INTO whatsapp_groups (account_id, channel_id, wa_group_id, name)
    VALUES (a_acct, w_co, '120363000000208001@g.us', 'GO on company OpenWA');
    r := 'inserted';
  EXCEPTION WHEN OTHERS THEN r := SQLSTATE || ': ' || SQLERRM; END;
  n := n + 1;
  IF r <> 'inserted' THEN
    failed := array_append(failed, ('a group on a company OpenWA number was refused: ' || r)::text);
  END IF;
  BEGIN
    INSERT INTO whatsapp_groups (account_id, channel_id, wa_group_id, name)
    VALUES (a_acct, w_pn, '120363000000208002@g.us', 'GO on personal OpenWA');
    r := 'inserted';
  EXCEPTION WHEN OTHERS THEN r := SQLSTATE || ': ' || SQLERRM; END;
  n := n + 1;
  IF r NOT LIKE '23514: Groups need a Whapi or company OpenWA number%' THEN
    failed := array_append(failed, ('a group on a personal OpenWA number was not refused: ' || r)::text);
  END IF;
  BEGIN
    INSERT INTO whatsapp_groups (account_id, channel_id, wa_group_id, name)
    VALUES (a_acct, w_meta, '120363000000208003@g.us', 'GO on Meta');
    r := 'inserted';
  EXCEPTION WHEN OTHERS THEN r := SQLSTATE || ': ' || SQLERRM; END;
  n := n + 1;
  IF r NOT LIKE '23514: Groups need a Whapi or company OpenWA number%' THEN
    failed := array_append(failed, ('a group on a Meta number was not refused: ' || r)::text);
  END IF;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT208', MESSAGE = 'verify-groups-on-openwa rollback';
  EXCEPTION WHEN SQLSTATE 'ZT208' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'groups on OpenWA verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'groups on OpenWA verification passed (% checks)', n;
END
$verify$;
