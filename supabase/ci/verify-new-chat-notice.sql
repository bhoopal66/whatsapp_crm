-- Behavioural regression suite for the new chat notice (migration 207).
--
-- Asserts: no row reads as enabled with no number; an admin upserts and
-- an agent cannot write (RLS) but reads through the RPC; a personal
-- number, another account's number, an over-long or blank text are
-- refused; deleting the number nulls it and keeps the row; a Meta
-- number's phone is NULL (waba_id is the WABA id there); a bank guest
-- gets {enabled: false}.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. Every fixture is
-- rolled back by a sentinel; the verdict lives in variables.

DO $verify$
DECLARE
  u_o   UUID := '00000000-0000-4000-8000-0000000fe700';
  u_ad  UUID := '00000000-0000-4000-8000-0000000fe701';
  u_a   UUID := '00000000-0000-4000-8000-0000000fe702';
  u_g   UUID := '00000000-0000-4000-8000-0000000fe703';
  u_o2  UUID := '00000000-0000-4000-8000-0000000fe704';
  acct  UUID;
  acct2 UUID;
  w     UUID;
  wm    UUID;
  wp    UUID;
  w2    UUID;
  j     JSONB;
  r     TEXT;
  n     INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a query as a signed-in person: its value, or 'ERROR <SQLSTATE>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.nc_val(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        EXECUTE p_sql INTO v;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN v;
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE;
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.nc_rpc(p_uid uuid)
    RETURNS jsonb LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      v := pg_temp.nc_val(p_uid, 'SELECT team_activity_new_chat_notice()::text');
      IF v IS NULL OR v LIKE 'ERROR%' THEN
        RETURN jsonb_build_object('error', coalesce(v, 'null'));
      END IF;
      RETURN v::jsonb;
    END $body$
  $fn$;
  -- An upsert as a signed-in person: the row's text, or 'ERROR …'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.nc_put(p_uid uuid, p_acct uuid, p_ch uuid, p_text text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.nc_val(p_uid, format(
        'INSERT INTO team_activity_new_chat_notice (account_id, marketing_channel_id, notice_text)
         VALUES (%L::uuid, %L::uuid, %L::text)
         ON CONFLICT (account_id) DO UPDATE
           SET marketing_channel_id = EXCLUDED.marketing_channel_id,
               notice_text = EXCLUDED.notice_text
         RETURNING coalesce(notice_text, ''<null>'')', p_acct, p_ch, p_text))
    $body$
  $fn$;

  -- ---------------------------------------------------------------
  -- Fixture: account 1 (owner o, admin ad, agent a, guest g) with a
  -- Whapi number w, a Meta number wm and a's personal OpenWA number wp;
  -- account 2 (owner o2) with a Whapi number w2.
  -- ---------------------------------------------------------------
  INSERT INTO auth.users (id, email) VALUES
    (u_o, 'nc-o@example.invalid'), (u_ad, 'nc-ad@example.invalid'),
    (u_a, 'nc-a@example.invalid'), (u_g, 'nc-g@example.invalid'),
    (u_o2, 'nc-o2@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO acct FROM profiles WHERE user_id = u_o;
  SELECT account_id INTO acct2 FROM profiles WHERE user_id = u_o2;
  IF acct IS NULL OR acct2 IS NULL OR acct = acct2 THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision two accounts';
  END IF;
  UPDATE profiles SET account_id = acct, account_role = 'admin' WHERE user_id = u_ad;
  UPDATE profiles SET account_id = acct, account_role = 'agent' WHERE user_id = u_a;
  UPDATE profiles SET account_id = acct, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_g;
  UPDATE profiles SET may_connect_personal_whatsapp = true WHERE user_id = u_a;

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, waba_id, label, status, is_primary)
  VALUES (u_o, acct, 'whapi', 'NC-207-W', 'x', '971500207001', 'Marketing', 'connected', true)
  RETURNING id INTO w;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, waba_id, label, status, is_primary)
  VALUES (u_o, acct, 'meta', 'NC-207-M', 'x', 'WABA-207', 'Cloud', 'connected', false)
  RETURNING id INTO wm;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, waba_id, is_personal, is_primary)
  VALUES (u_a, acct, 'openwa', 'NC-207-P', 'x', '971500207003', true, false)
  RETURNING id INTO wp;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, waba_id, status, is_primary)
  VALUES (u_o2, acct2, 'whapi', 'NC-207-W2', 'x', '971500207004', 'connected', true)
  RETURNING id INTO w2;

  -- ---------------------------------------------------------------
  -- No row: enabled, no number, default wording.
  -- ---------------------------------------------------------------
  j := pg_temp.nc_rpc(u_a);
  n := n + 1;
  IF j IS DISTINCT FROM jsonb_build_object(
       'enabled', true, 'channel_id', null, 'channel_label', null,
       'channel_phone', null, 'channel_provider', null, 'text', null) THEN
    failed := array_append(failed, ('no row: ' || j::text)::text);
  END IF;

  -- ---------------------------------------------------------------
  -- Writers: an agent cannot insert; an admin can; the agent then
  -- cannot update either, and reads it through the RPC.
  -- ---------------------------------------------------------------
  r := pg_temp.nc_put(u_a, acct, w, 'Agent wording');
  n := n + 1;
  IF r IS DISTINCT FROM 'ERROR 42501' THEN
    failed := array_append(failed, ('agent insert: ' || coalesce(r, 'null'))::text);
  END IF;
  r := pg_temp.nc_put(u_ad, acct, w, 'Use the marketing number for new clients');
  n := n + 1;
  IF r IS DISTINCT FROM 'Use the marketing number for new clients' THEN
    failed := array_append(failed, ('admin insert: ' || coalesce(r, 'null'))::text);
  END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM team_activity_new_chat_notice
                  WHERE account_id = acct AND updated_by = u_ad) THEN
    failed := array_append(failed, 'updated_by not stamped with the admin'::text);
  END IF;
  r := pg_temp.nc_val(u_a, format(
    'WITH u AS (UPDATE team_activity_new_chat_notice SET enabled = false
                 WHERE account_id = %L RETURNING 1) SELECT count(*)::text FROM u', acct));
  n := n + 1;
  IF r IS DISTINCT FROM '0' THEN
    failed := array_append(failed, ('agent update: ' || coalesce(r, 'null'))::text);
  END IF;
  r := pg_temp.nc_val(u_ad, format(
    'WITH d AS (DELETE FROM team_activity_new_chat_notice
                 WHERE account_id = %L RETURNING 1) SELECT count(*)::text FROM d', acct));
  n := n + 1;
  IF r IS DISTINCT FROM 'ERROR 42501' THEN
    failed := array_append(failed, ('admin delete: ' || coalesce(r, 'null'))::text);
  END IF;
  j := pg_temp.nc_rpc(u_a);
  n := n + 1;
  IF j IS DISTINCT FROM jsonb_build_object(
       'enabled', true, 'channel_id', w, 'channel_label', 'Marketing',
       'channel_phone', '971500207001', 'channel_provider', 'whapi',
       'text', 'Use the marketing number for new clients') THEN
    failed := array_append(failed, ('agent reads the notice: ' || j::text)::text);
  END IF;
  r := pg_temp.nc_val(u_a, format(
    'SELECT count(*)::text FROM team_activity_new_chat_notice WHERE account_id = %L', acct));
  n := n + 1;
  IF r IS DISTINCT FROM '1' THEN
    failed := array_append(failed, ('agent select: ' || coalesce(r, 'null'))::text);
  END IF;
  -- Another account's admin cannot write into this one.
  r := pg_temp.nc_put(u_o2, acct, null, 'Not mine');
  n := n + 1;
  IF r IS DISTINCT FROM 'ERROR 42501' THEN
    failed := array_append(failed, ('cross-account write: ' || coalesce(r, 'null'))::text);
  END IF;

  -- ---------------------------------------------------------------
  -- Refusals: personal number, another account's number, text.
  -- ---------------------------------------------------------------
  r := pg_temp.nc_put(u_ad, acct, wp, 'Personal');
  n := n + 1;
  IF r IS DISTINCT FROM 'ERROR 22023' THEN
    failed := array_append(failed, ('personal number: ' || coalesce(r, 'null'))::text);
  END IF;
  r := pg_temp.nc_put(u_ad, acct, w2, 'Foreign');
  n := n + 1;
  IF r IS DISTINCT FROM 'ERROR 23503' THEN
    failed := array_append(failed, ('another account''s number: ' || coalesce(r, 'null'))::text);
  END IF;
  r := pg_temp.nc_put(u_ad, acct, w, repeat('x', 301));
  n := n + 1;
  IF r IS DISTINCT FROM 'ERROR 23514' THEN
    failed := array_append(failed, ('301-char text: ' || coalesce(r, 'null'))::text);
  END IF;
  r := pg_temp.nc_put(u_ad, acct, w, E' \t\n ');
  n := n + 1;
  IF r IS DISTINCT FROM 'ERROR 23514' THEN
    failed := array_append(failed, ('blank text: ' || coalesce(r, 'null'))::text);
  END IF;
  r := pg_temp.nc_put(u_ad, acct, w, repeat('x', 300));
  n := n + 1;
  IF r IS DISTINCT FROM repeat('x', 300) THEN
    failed := array_append(failed, ('300-char text: ' || coalesce(left(r, 40), 'null'))::text);
  END IF;
  r := pg_temp.nc_put(u_ad, acct, w, null);
  n := n + 1;
  IF r IS DISTINCT FROM '<null>' THEN
    failed := array_append(failed, ('null text (default wording): ' || coalesce(r, 'null'))::text);
  END IF;

  -- ---------------------------------------------------------------
  -- Meta number: phone NULL. Then delete it: the row stays, number gone.
  -- ---------------------------------------------------------------
  r := pg_temp.nc_put(u_ad, acct, wm, 'Meta');
  j := pg_temp.nc_rpc(u_a);
  n := n + 1;
  IF r IS DISTINCT FROM 'Meta'
     OR j ->> 'channel_id' IS DISTINCT FROM wm::text
     OR j ->> 'channel_provider' IS DISTINCT FROM 'meta'
     OR j ->> 'channel_label' IS DISTINCT FROM 'Cloud'
     OR NOT (j ? 'channel_phone') OR j -> 'channel_phone' <> 'null'::jsonb THEN
    failed := array_append(failed, ('meta number: ' || coalesce(r, 'null') || ' ' || j::text)::text);
  END IF;
  DELETE FROM whatsapp_config WHERE id = wm;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM team_activity_new_chat_notice
                  WHERE account_id = acct AND marketing_channel_id IS NULL
                    AND notice_text = 'Meta') THEN
    failed := array_append(failed, 'deleting the number did not null it (or lost the row)'::text);
  END IF;
  j := pg_temp.nc_rpc(u_a);
  n := n + 1;
  IF j -> 'channel_id' IS DISTINCT FROM 'null'::jsonb OR j ->> 'text' IS DISTINCT FROM 'Meta' THEN
    failed := array_append(failed, ('after delete: ' || j::text)::text);
  END IF;

  -- Switched off.
  r := pg_temp.nc_val(u_ad, format(
    'WITH u AS (UPDATE team_activity_new_chat_notice SET enabled = false
                 WHERE account_id = %L RETURNING 1) SELECT count(*)::text FROM u', acct));
  j := pg_temp.nc_rpc(u_a);
  n := n + 1;
  IF r IS DISTINCT FROM '1' OR j ->> 'enabled' IS DISTINCT FROM 'false' THEN
    failed := array_append(failed, ('switched off: ' || coalesce(r, 'null') || ' ' || j::text)::text);
  END IF;

  -- ---------------------------------------------------------------
  -- A bank guest: no active account, nothing shown.
  -- ---------------------------------------------------------------
  j := pg_temp.nc_rpc(u_g);
  n := n + 1;
  IF j IS DISTINCT FROM '{"enabled": false}'::jsonb THEN
    failed := array_append(failed, ('guest: ' || j::text)::text);
  END IF;
  r := pg_temp.nc_val(u_g, 'SELECT count(*)::text FROM team_activity_new_chat_notice');
  n := n + 1;
  IF r IS DISTINCT FROM '0' THEN
    failed := array_append(failed, ('guest select: ' || coalesce(r, 'null'))::text);
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZT207', MESSAGE = 'verify-new-chat-notice rollback';
  EXCEPTION WHEN SQLSTATE 'ZT207' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'new chat notice verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'new chat notice verification passed (% checks)', n;
END
$verify$;
