-- Behavioural regression suite for fuzzy contact search (migration 193).
--
-- search_contacts(term, limit) is the client entry point (SECURITY
-- INVOKER, joins back to contacts under RLS); search_contact_candidates
-- is the indexed SECURITY DEFINER lookup behind it, which restates the
-- contacts SELECT policies. This asserts number, name and company
-- matching (exact and close), that neither function shows a contact
-- the caller cannot see or one of another account, the privileges, and
-- that the two contacts SELECT policies are still the ones 193
-- restates (change one, change both).
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000193001';
  u_ag     UUID := '00000000-0000-4000-8000-000000193002';  -- agent in A
  u_out    UUID := '00000000-0000-4000-8000-000000193003';  -- owns B
  a_acct   UUID;
  a_out    UUID;
  c_zed    UUID;  -- 'Zed Target', Taamul Credit, +971 58 833 6503
  c_ahmed  UUID;  -- 'Ahmed Ali'
  c_hidden UUID;  -- the owner's, out of the agent's sight
  c_mine   UUID;  -- the agent's own
  c_out    UUID;  -- B's twin of c_zed
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a SELECT as a signed-in user: the value, 'ok' for no row, or
  -- 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cs_try(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; st text; m text;
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
        RETURN coalesce(nullif(v, ''), 'ok');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, m = MESSAGE_TEXT;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN format('ERROR %s: %s', st, m);
      END;
    END $body$
  $fn$;

  -- Fixture: the auth.users trigger provisions each person an account;
  -- the agent moves into the owner's, u_out keeps B.
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'cs-owner@example.invalid'),
    (u_ag,    'cs-agent@example.invalid'),
    (u_out,   'cs-out@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  SELECT id INTO a_out FROM accounts WHERE owner_user_id = u_out;
  IF a_acct IS NULL OR a_out IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_ag;

  INSERT INTO contacts (account_id, user_id, name, company, phone)
    VALUES (a_acct, u_owner, 'Zed Target', 'Taamul Credit', '+971 58 833 6503')
    RETURNING id INTO c_zed;
  INSERT INTO contacts (account_id, user_id, name, phone)
    VALUES (a_acct, u_owner, 'Ahmed Ali', '+971 50 111 2233') RETURNING id INTO c_ahmed;
  INSERT INTO contacts (account_id, user_id, name, phone)
    VALUES (a_acct, u_owner, 'Qwerty Hidden', '+971 50 444 5566') RETURNING id INTO c_hidden;
  INSERT INTO contacts (account_id, user_id, name, phone)
    VALUES (a_acct, u_ag, 'Qwerty Mine', '+971 50 777 8899') RETURNING id INTO c_mine;
  INSERT INTO contacts (account_id, user_id, name, company, phone)
    VALUES (a_out, u_out, 'Zed Target', 'Taamul Credit', '+971 58 833 6503')
    RETURNING id INTO c_out;

  -- ---- Numbers -----------------------------------------------------
  -- Every way of writing the stored number is an exact match.
  FOREACH r IN ARRAY ARRAY['588336503', '+971 58 833 6503', '0588336503', '00971588336503'] LOOP
    n := n + 1;
    IF pg_temp.cs_try(u_owner, format(
         'SELECT exact::text FROM search_contacts(%L) WHERE contact_id = %L', r, c_zed)) <> 'true' THEN
      failed := array_append(failed, ('number ' || r || ' is not an exact match'));
    END IF;
  END LOOP;
  n := n + 1;
  r := pg_temp.cs_try(u_owner, format(
    'SELECT exact::text FROM search_contacts(%L) WHERE contact_id = %L', '588336530', c_zed));
  IF r <> 'false' THEN
    failed := array_append(failed, ('a swapped digit is not a close match: ' || r));
  END IF;

  -- ---- Names and companies -----------------------------------------
  n := n + 1;
  r := pg_temp.cs_try(u_owner, format(
    'SELECT exact::text FROM search_contacts(%L) WHERE contact_id = %L', 'zed targt', c_zed));
  IF r <> 'false' THEN
    failed := array_append(failed, ('a name typo is not a close match: ' || r));
  END IF;
  n := n + 1;
  r := pg_temp.cs_try(u_owner, format(
    'SELECT exact::text FROM search_contacts(%L) WHERE contact_id = %L', 'taamul credt', c_zed));
  IF r <> 'false' THEN
    failed := array_append(failed, ('a company typo is not a close match: ' || r));
  END IF;
  n := n + 1;
  r := pg_temp.cs_try(u_owner, format(
    'SELECT exact::text FROM search_contacts(%L) WHERE contact_id = %L', 'ali ahmed', c_ahmed));
  IF r = 'ok' OR r LIKE 'ERROR%' THEN
    failed := array_append(failed, ('swapped words did not find Ahmed Ali: ' || r));
  END IF;
  n := n + 1;
  r := pg_temp.cs_try(u_owner, 'SELECT count(*)::text FROM search_contacts(''xylophone'')');
  IF r <> '0' THEN
    failed := array_append(failed, ('an unrelated term found contacts: ' || r));
  END IF;

  -- ---- Visibility --------------------------------------------------
  -- The agent finds their own contact and not the owner's, through
  -- both functions.
  n := n + 1;
  r := pg_temp.cs_try(u_ag, format(
    'SELECT string_agg(CASE contact_id WHEN %L THEN ''mine'' WHEN %L THEN ''hidden'' ELSE ''other'' END, '','' ORDER BY 1) FROM search_contacts(''qwerty'')',
    c_mine, c_hidden));
  IF r <> 'mine' THEN
    failed := array_append(failed, ('the agent''s search_contacts(qwerty) returned ' || r));
  END IF;
  n := n + 1;
  r := pg_temp.cs_try(u_ag, format(
    'SELECT string_agg(CASE contact_id WHEN %L THEN ''mine'' WHEN %L THEN ''hidden'' ELSE ''other'' END, '','' ORDER BY 1) FROM search_contact_candidates(''qwerty'')',
    c_mine, c_hidden));
  IF r <> 'mine' THEN
    failed := array_append(failed, ('the agent''s candidate lookup (qwerty) returned ' || r));
  END IF;
  n := n + 1;
  r := pg_temp.cs_try(u_ag, format(
    'SELECT count(*)::text FROM search_contact_candidates(%L) WHERE contact_id = %L', '588336503', c_zed));
  IF r <> '0' THEN
    failed := array_append(failed, ('the agent''s candidate lookup found an owner''s number: ' || r));
  END IF;
  -- Another account's twin never appears, either way round.
  n := n + 1;
  r := pg_temp.cs_try(u_owner, format(
    'SELECT count(*)::text FROM (SELECT contact_id FROM search_contacts(''+971 58 833 6503'') UNION ALL SELECT contact_id FROM search_contacts(''zed target'') UNION ALL SELECT contact_id FROM search_contact_candidates(''588336503'') UNION ALL SELECT contact_id FROM search_contact_candidates(''taamul credt'')) s WHERE contact_id = %L',
    c_out));
  IF r <> '0' THEN
    failed := array_append(failed, ('another account''s contact was found: ' || r));
  END IF;
  n := n + 1;
  r := pg_temp.cs_try(u_out, format(
    'SELECT count(*)::text FROM (SELECT contact_id FROM search_contacts(''zed target'') UNION ALL SELECT contact_id FROM search_contact_candidates(''588336503'')) s WHERE contact_id IN (%L, %L)',
    c_zed, c_ahmed));
  IF r <> '0' THEN
    failed := array_append(failed, ('B''s owner found A''s contacts: ' || r));
  END IF;
  n := n + 1;
  r := pg_temp.cs_try(u_out, format(
    'SELECT count(*)::text FROM search_contacts(''zed target'') WHERE contact_id = %L', c_out));
  IF r <> '1' THEN
    failed := array_append(failed, ('B''s owner did not find their own contact: ' || r));
  END IF;
  -- No signed-in person (the service role): no account, nothing.
  n := n + 1;
  IF (SELECT count(*) FROM public.search_contact_candidates('zed target')) <> 0 THEN
    failed := array_append(failed, 'the candidate lookup answered with no signed-in person'::text);
  END IF;

  -- ---- The restated policies ---------------------------------------
  -- search_contact_candidates restates exactly these two SELECT
  -- policies. If this fails, update its visibility term (193) and then
  -- this text.
  n := n + 1;
  IF (SELECT string_agg(polname || '=' || pg_get_expr(polqual, polrelid), E'\n' ORDER BY polname)
        FROM pg_policy
       WHERE polrelid = 'public.contacts'::regclass AND polcmd IN ('r', '*'))
     IS DISTINCT FROM
     'contacts_coordinator_select=((account_id = ( SELECT current_account_id() AS current_account_id)) AND ( SELECT i_hold_open_coordinator_shares() AS i_hold_open_coordinator_shares) AND (id IN ( SELECT coordinator_granted_contact_ids() AS coordinator_granted_contact_ids)))'
     || E'\n' ||
     'contacts_select=((account_id = ( SELECT current_account_id() AS current_account_id)) AND ((( SELECT current_role_rank() AS current_role_rank) >= 4) OR (user_id IN ( SELECT contact_visibility_people() AS contact_visibility_people)) OR (id IN ( SELECT contact_visibility_chat_contact_ids() AS contact_visibility_chat_contact_ids))))' THEN
    failed := array_append(failed, 'the contacts SELECT policies changed: update search_contact_candidates (193) to match'::text);
  END IF;

  -- ---- Privileges --------------------------------------------------
  n := n + 1;
  IF has_function_privilege('anon', 'public.search_contacts(text, integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.search_contact_candidates(text, integer)', 'EXECUTE') THEN
    failed := array_append(failed, 'anon may execute contact search'::text);
  END IF;
  n := n + 1;
  IF NOT has_function_privilege('authenticated', 'public.search_contacts(text, integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.search_contact_candidates(text, integer)', 'EXECUTE') THEN
    failed := array_append(failed, 'signed-in users cannot execute contact search'::text);
  END IF;
  n := n + 1;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.search_contacts(text, integer)'::regprocedure)
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.search_contact_candidates(text, integer)'::regprocedure) THEN
    failed := array_append(failed, 'search_contacts must run as the caller and the candidate lookup as definer'::text);
  END IF;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT193', MESSAGE = 'verify-contact-search rollback';
  EXCEPTION WHEN SQLSTATE 'ZT193' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'contact search verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'contact search verification passed (% checks)', n;
END
$verify$;
