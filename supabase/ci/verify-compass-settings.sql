-- Behavioural regression suite for Compass settings (migration 209).
--
-- Asserts: an admin upserts the Meta template and is stamped as the
-- writer; an agent can neither read nor write it; another account's
-- admin cannot write into this one; nobody deletes; a blank name, a
-- language without a name and an over-long name are refused; the
-- service role reads it.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. Every fixture is
-- rolled back by a sentinel; the verdict lives in variables.

DO $verify$
DECLARE
  u_o   UUID := '00000000-0000-4000-8000-0000000fe900';
  u_ad  UUID := '00000000-0000-4000-8000-0000000fe901';
  u_a   UUID := '00000000-0000-4000-8000-0000000fe902';
  u_o2  UUID := '00000000-0000-4000-8000-0000000fe903';
  acct  UUID;
  acct2 UUID;
  r     TEXT;
  n     INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a query as a signed-in person: its value, or 'ERROR <SQLSTATE>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cs_val(p_uid uuid, p_sql text)
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
  -- An upsert as a signed-in person: the stored name, or 'ERROR …'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cs_put(p_uid uuid, p_acct uuid, p_name text, p_lang text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.cs_val(p_uid, format(
        'INSERT INTO compass_settings (account_id, meta_template_name, meta_template_language)
         VALUES (%L::uuid, %L::text, %L::text)
         ON CONFLICT (account_id) DO UPDATE
           SET meta_template_name = EXCLUDED.meta_template_name,
               meta_template_language = EXCLUDED.meta_template_language
         RETURNING coalesce(meta_template_name, ''<null>'')', p_acct, p_name, p_lang))
    $body$
  $fn$;

  -- ---------------------------------------------------------------
  -- Fixture: account 1 (owner o, admin ad, agent a); account 2 (owner o2).
  -- ---------------------------------------------------------------
  INSERT INTO auth.users (id, email) VALUES
    (u_o, 'cs-o@example.invalid'), (u_ad, 'cs-ad@example.invalid'),
    (u_a, 'cs-a@example.invalid'), (u_o2, 'cs-o2@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO acct FROM profiles WHERE user_id = u_o;
  SELECT account_id INTO acct2 FROM profiles WHERE user_id = u_o2;
  IF acct IS NULL OR acct2 IS NULL OR acct = acct2 THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision two accounts';
  END IF;
  UPDATE profiles SET account_id = acct, account_role = 'admin' WHERE user_id = u_ad;
  UPDATE profiles SET account_id = acct, account_role = 'agent' WHERE user_id = u_a;

  -- ---------------------------------------------------------------
  -- Writers: an agent cannot insert; an admin can and is stamped.
  -- ---------------------------------------------------------------
  r := pg_temp.cs_put(u_a, acct, 'agent_pick', 'en');
  n := n + 1;
  IF r IS DISTINCT FROM 'ERROR 42501' THEN
    failed := array_append(failed, ('agent insert: ' || coalesce(r, 'null'))::text);
  END IF;
  r := pg_temp.cs_put(u_ad, acct, 'compass_update', 'en');
  n := n + 1;
  IF r IS DISTINCT FROM 'compass_update' THEN
    failed := array_append(failed, ('admin insert: ' || coalesce(r, 'null'))::text);
  END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM compass_settings
                  WHERE account_id = acct AND updated_by = u_ad) THEN
    failed := array_append(failed, 'updated_by not stamped with the admin'::text);
  END IF;
  r := pg_temp.cs_put(u_o, acct, 'compass_update_v2', 'en_US');
  n := n + 1;
  IF r IS DISTINCT FROM 'compass_update_v2' THEN
    failed := array_append(failed, ('owner update: ' || coalesce(r, 'null'))::text);
  END IF;

  -- An agent neither reads nor updates it.
  r := pg_temp.cs_val(u_a, format(
    'SELECT count(*)::text FROM compass_settings WHERE account_id = %L', acct));
  n := n + 1;
  IF r IS DISTINCT FROM '0' THEN
    failed := array_append(failed, ('agent select: ' || coalesce(r, 'null'))::text);
  END IF;
  r := pg_temp.cs_val(u_a, format(
    'WITH u AS (UPDATE compass_settings SET meta_template_name = ''x''
                 WHERE account_id = %L RETURNING 1) SELECT count(*)::text FROM u', acct));
  n := n + 1;
  IF r IS DISTINCT FROM '0' THEN
    failed := array_append(failed, ('agent update: ' || coalesce(r, 'null'))::text);
  END IF;
  -- Nobody deletes.
  r := pg_temp.cs_val(u_ad, format(
    'WITH d AS (DELETE FROM compass_settings
                 WHERE account_id = %L RETURNING 1) SELECT count(*)::text FROM d', acct));
  n := n + 1;
  IF r IS DISTINCT FROM 'ERROR 42501' THEN
    failed := array_append(failed, ('admin delete: ' || coalesce(r, 'null'))::text);
  END IF;
  -- Another account's owner cannot write into this one, nor read it.
  r := pg_temp.cs_put(u_o2, acct, 'not_mine', 'en');
  n := n + 1;
  IF r IS DISTINCT FROM 'ERROR 42501' THEN
    failed := array_append(failed, ('cross-account write: ' || coalesce(r, 'null'))::text);
  END IF;
  r := pg_temp.cs_val(u_o2, format(
    'SELECT count(*)::text FROM compass_settings WHERE account_id = %L', acct));
  n := n + 1;
  IF r IS DISTINCT FROM '0' THEN
    failed := array_append(failed, ('cross-account read: ' || coalesce(r, 'null'))::text);
  END IF;

  -- ---------------------------------------------------------------
  -- Shape: blank name, language without a name, over-long name.
  -- Clearing (both NULL) is allowed.
  -- ---------------------------------------------------------------
  r := pg_temp.cs_put(u_ad, acct, E' \t\n ', 'en');
  n := n + 1;
  IF r IS DISTINCT FROM 'ERROR 23514' THEN
    failed := array_append(failed, ('blank name: ' || coalesce(r, 'null'))::text);
  END IF;
  r := pg_temp.cs_put(u_ad, acct, null, 'en');
  n := n + 1;
  IF r IS DISTINCT FROM 'ERROR 23514' THEN
    failed := array_append(failed, ('language without name: ' || coalesce(r, 'null'))::text);
  END IF;
  r := pg_temp.cs_put(u_ad, acct, repeat('x', 513), 'en');
  n := n + 1;
  IF r IS DISTINCT FROM 'ERROR 23514' THEN
    failed := array_append(failed, ('513-char name: ' || coalesce(r, 'null'))::text);
  END IF;
  r := pg_temp.cs_put(u_ad, acct, null, null);
  n := n + 1;
  IF r IS DISTINCT FROM '<null>' THEN
    failed := array_append(failed, ('clearing: ' || coalesce(r, 'null'))::text);
  END IF;

  -- ---------------------------------------------------------------
  -- The service role (the public API's Compass route) reads it.
  -- ---------------------------------------------------------------
  n := n + 1;
  IF NOT has_table_privilege('service_role', 'public.compass_settings', 'SELECT')
     OR has_table_privilege('service_role', 'public.compass_settings', 'UPDATE') THEN
    failed := array_append(failed, 'service_role grants: want SELECT only'::text);
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZT209', MESSAGE = 'verify-compass-settings rollback';
  EXCEPTION WHEN SQLSTATE 'ZT209' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'compass settings verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'compass settings verification passed (% checks)', n;
END
$verify$;
