-- Behavioural regression suite for migration 298.
--
-- search_contacts / search_contact_candidates with filters: a customer
-- whose name sorts past the limit is found once the search is narrowed
-- to their owner, lead source or chat tag, in text, short-number,
-- long-number and close-match searches; tags are "any of, main or sub",
-- company chats only, and only on chats the caller can see; no filter
-- shows a contact the caller cannot see or one of another account; the
-- limit is 500; the 193 signatures still answer (and are not ambiguous);
-- privileges.
--
-- ONE statement, rolled back by a sentinel, as verify-contact-search.sql
-- explains.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000298001';
  u_ag     UUID := '00000000-0000-4000-8000-000000298002';  -- agent in A
  u_out    UUID := '00000000-0000-4000-8000-000000298003';  -- owns B
  a_acct   UUID;
  a_out    UUID;
  tag_main UUID;
  tag_sub  UUID;
  tag_none UUID;  -- a tag no chat carries
  tag_out  UUID;  -- B's tag
  c_src    UUID;  -- 'Rashid Zz Source', lead source web_form
  c_mine   UUID;  -- 'Rashid Zz Mine', the agent's
  c_main   UUID;  -- 'Rashid Zz Main', chat tagged tag_main
  c_sub    UUID;  -- 'Rashid Zz Sub', chat tagged tag_main / tag_sub
  c_pers   UUID;  -- 'Rashid Zz Personal', only a personal chat is tagged
  c_other  UUID;  -- 'Rashid Zz Other', the agent's contact, a colleague's chat
  c_hidden UUID;  -- 'Rashid Zz Hidden', the owner's, tagged and web_form
  c_out    UUID;  -- B's
  q        TEXT;
  r        TEXT;
  w        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a SELECT as a signed-in user: the value, 'ok' for no row, or
  -- 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.csf_try(p_uid uuid, p_sql text)
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
  -- The names found (their last word), in alphabetical order.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.csf_names(p_uid uuid, p_call text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.csf_try(p_uid, format(
        'SELECT coalesce(string_agg(split_part(c.name, '' '', 3), '','' ORDER BY split_part(c.name, '' '', 3)), ''-'') FROM %s s JOIN public.contacts c ON c.id = s.contact_id', p_call))
    $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'csf-owner@example.invalid'),
    (u_ag,    'csf-agent@example.invalid'),
    (u_out,   'csf-out@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  SELECT id INTO a_out FROM accounts WHERE owner_user_id = u_out;
  IF a_acct IS NULL OR a_out IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_ag;

  -- 820 contacts that match every term below as well as, and sort by
  -- name before, the ones the filters look for: more than the 500 hits
  -- of search_contacts and the 800 of the candidate lookup.
  INSERT INTO contacts (account_id, user_id, name, phone, lead_source)
    SELECT a_acct, u_owner, 'Rashid Aa ' || to_char(i, 'FM0000'), '+9715055' || to_char(i, 'FM00000'), 'manual'
      FROM generate_series(1, 820) AS i;
  INSERT INTO contacts (account_id, user_id, name, phone, lead_source)
    VALUES (a_acct, u_owner, 'Rashid Zz Source', '+971505510001', 'web_form') RETURNING id INTO c_src;
  INSERT INTO contacts (account_id, user_id, name, phone)
    VALUES (a_acct, u_ag, 'Rashid Zz Mine', '+971505510002') RETURNING id INTO c_mine;
  INSERT INTO contacts (account_id, user_id, name, phone)
    VALUES (a_acct, u_owner, 'Rashid Zz Main', '+971505510003') RETURNING id INTO c_main;
  INSERT INTO contacts (account_id, user_id, name, phone)
    VALUES (a_acct, u_owner, 'Rashid Zz Sub', '+971505510004') RETURNING id INTO c_sub;
  INSERT INTO contacts (account_id, user_id, name, phone)
    VALUES (a_acct, u_owner, 'Rashid Zz Personal', '+971505510005') RETURNING id INTO c_pers;
  INSERT INTO contacts (account_id, user_id, name, phone)
    VALUES (a_acct, u_ag, 'Rashid Zz Other', '+971505510006') RETURNING id INTO c_other;
  INSERT INTO contacts (account_id, user_id, name, phone, lead_source)
    VALUES (a_acct, u_owner, 'Rashid Zz Hidden', '+971505510007', 'ad') RETURNING id INTO c_hidden;
  INSERT INTO contacts (account_id, user_id, name, phone, lead_source)
    VALUES (a_out, u_out, 'Rashid Zz Outside', '+971505510001', 'web_form') RETURNING id INTO c_out;

  INSERT INTO chat_tags (account_id, name) VALUES (a_acct, 'CSF main') RETURNING id INTO tag_main;
  INSERT INTO chat_tags (account_id, parent_id, name) VALUES (a_acct, tag_main, 'CSF sub') RETURNING id INTO tag_sub;
  INSERT INTO chat_tags (account_id, name) VALUES (a_acct, 'CSF none') RETURNING id INTO tag_none;
  INSERT INTO chat_tags (account_id, name) VALUES (a_out, 'CSF out') RETURNING id INTO tag_out;
  INSERT INTO conversations (account_id, user_id, contact_id, chat_tag_id)
    VALUES (a_acct, u_owner, c_main, tag_main);
  INSERT INTO conversations (account_id, user_id, contact_id, chat_tag_id, chat_sub_tag_id)
    VALUES (a_acct, u_owner, c_sub, tag_main, tag_sub);
  INSERT INTO conversations (account_id, user_id, contact_id, personal_owner_id, assigned_agent_id, chat_tag_id)
    VALUES (a_acct, u_owner, c_pers, u_owner, u_owner, tag_main);
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id, chat_tag_id)
    VALUES (a_acct, u_owner, c_other, u_owner, tag_main);
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id, chat_tag_id)
    VALUES (a_acct, u_owner, c_hidden, u_owner, tag_main);
  INSERT INTO conversations (account_id, user_id, contact_id, chat_tag_id)
    VALUES (a_out, u_out, c_out, tag_out);
  -- Owners, set after the chats (169 moves an owner to the assignee).
  UPDATE contacts SET user_id = u_ag WHERE id IN (c_mine, c_other);
  UPDATE contacts SET user_id = u_owner WHERE id IN (c_src, c_main, c_sub, c_pers, c_hidden);

  -- ---- The limit, and what it used to hide --------------------------
  n := n + 1;
  r := pg_temp.csf_try(u_owner, 'SELECT count(*)::text FROM search_contacts(''rashid'', 5000, NULL, NULL, NULL)');
  IF r <> '500' THEN
    failed := array_append(failed, 'the limit is not 500: ' || r);
  END IF;
  n := n + 1;
  r := pg_temp.csf_try(u_owner, format(
    'SELECT count(*)::text FROM search_contacts(''rashid'', 500, NULL, NULL, NULL) WHERE contact_id IN (%L, %L, %L)',
    c_src, c_mine, c_main));
  IF r <> '0' THEN
    failed := array_append(failed, 'fixture: an unfiltered search already lists the filtered ones: ' || r);
  END IF;

  -- Text (2 letters, a word, two words), a short number, a long number
  -- and a typo: every query path takes every filter.
  FOREACH w IN ARRAY ARRAY['ra', 'rashid', 'rashid zz', '055', '50551', 'rashld'] LOOP
    n := n + 1;
    r := pg_temp.csf_names(u_owner, format('search_contacts(%L, 500, %L, NULL, NULL)', w, u_ag));
    IF r <> 'Mine,Other' THEN
      failed := array_append(failed, format('%s by owner found %s', w, r));
    END IF;
    n := n + 1;
    r := pg_temp.csf_names(u_owner, format('search_contacts(%L, 500, NULL, %L, NULL)', w, '{web_form,ad}'));
    IF r <> 'Hidden,Source' THEN
      failed := array_append(failed, format('%s by source found %s', w, r));
    END IF;
    n := n + 1;
    r := pg_temp.csf_names(u_owner, format('search_contacts(%L, 500, NULL, NULL, ARRAY[%L]::uuid[])', w, tag_main));
    IF r <> 'Hidden,Main,Other,Sub' THEN
      failed := array_append(failed, format('%s by main tag found %s', w, r));
    END IF;
    n := n + 1;
    r := pg_temp.csf_names(u_owner, format('search_contacts(%L, 500, %L, %L, ARRAY[%L, %L]::uuid[])', w, u_owner, '{ad}', tag_sub, tag_main));
    IF r <> 'Hidden' THEN
      failed := array_append(failed, format('%s by owner, source and tags found %s', w, r));
    END IF;
  END LOOP;

  -- A close match keeps its flag when filtered.
  n := n + 1;
  r := pg_temp.csf_try(u_owner, format('SELECT exact::text FROM search_contacts(''rashld'', 500, NULL, NULL, ARRAY[%L]::uuid[])', tag_sub));
  IF r <> 'false' THEN
    failed := array_append(failed, 'a filtered typo is not one close match: ' || r);
  END IF;

  -- ---- Tags: any of, main or sub; empty means none asked -------------
  n := n + 1;
  r := pg_temp.csf_names(u_owner, format('search_contacts(''rashid'', 500, NULL, NULL, ARRAY[%L]::uuid[])', tag_sub));
  IF r <> 'Sub' THEN
    failed := array_append(failed, 'by sub-tag found ' || r);
  END IF;
  n := n + 1;
  r := pg_temp.csf_names(u_owner, format('search_contacts(''rashid'', 500, NULL, NULL, ARRAY[%L, %L]::uuid[])', tag_none, tag_sub));
  IF r <> 'Sub' THEN
    failed := array_append(failed, 'any of two tags found ' || r);
  END IF;
  n := n + 1;
  r := pg_temp.csf_names(u_owner, format('search_contacts(''rashid'', 500, NULL, NULL, ARRAY[%L]::uuid[])', tag_none));
  IF r <> '-' THEN
    failed := array_append(failed, 'a tag no chat carries found ' || r);
  END IF;
  n := n + 1;
  r := pg_temp.csf_try(u_owner, 'SELECT count(*)::text FROM search_contacts(''rashid'', 500, NULL, ''{}'', ''{}'')');
  IF r <> '500' THEN
    failed := array_append(failed, 'empty filters narrowed the search: ' || r);
  END IF;

  -- ---- Visibility ----------------------------------------------------
  -- The agent sees their own two. The colleague's chat of 'Other' is out
  -- of their sight, so its tag must not be found through the search.
  n := n + 1;
  r := pg_temp.csf_try(u_ag, format('SELECT count(*)::text FROM conversations WHERE contact_id = %L', c_other));
  IF r <> '0' THEN
    failed := array_append(failed, 'fixture: the agent sees the colleague''s chat');
  END IF;
  n := n + 1;
  r := pg_temp.csf_names(u_ag, 'search_contacts(''rashid'', 500, NULL, NULL, NULL)');
  IF r <> 'Mine,Other' THEN
    failed := array_append(failed, 'the agent found ' || r);
  END IF;
  n := n + 1;
  r := pg_temp.csf_names(u_ag, format('search_contacts(''rashid'', 500, NULL, NULL, ARRAY[%L]::uuid[])', tag_main));
  IF r <> '-' THEN
    failed := array_append(failed, 'the agent found by a hidden chat''s tag: ' || r);
  END IF;
  n := n + 1;
  r := pg_temp.csf_names(u_ag, format('search_contacts(''rashid'', 500, %L, NULL, NULL)', u_owner));
  IF r <> '-' THEN
    failed := array_append(failed, 'the agent found the owner''s: ' || r);
  END IF;
  -- The definer lookup called directly: naming a contact does not show it.
  FOREACH w IN ARRAY ARRAY['ra', 'rashid', '055', '50551', 'rashld'] LOOP
    n := n + 1;
    r := pg_temp.csf_try(u_ag, format(
      'SELECT count(*)::text FROM search_contact_candidates(%L, 800, NULL, ''{ad}'', ARRAY[%L, %L]::uuid[])', w, c_hidden, c_out));
    IF r <> '0' THEN
      failed := array_append(failed, format('the agent''s candidate lookup (%s) showed a hidden contact: %s', w, r));
    END IF;
    n := n + 1;
    r := pg_temp.csf_try(u_out, format(
      'SELECT count(*)::text FROM search_contact_candidates(%L, 800, NULL, NULL, ARRAY[%L, %L]::uuid[])', w, c_hidden, c_out));
    IF r <> '1' THEN
      failed := array_append(failed, format('B''s candidate lookup (%s) found %s of its one contact', w, r));
    END IF;
  END LOOP;
  n := n + 1;
  r := pg_temp.csf_names(u_owner, format('search_contacts(''rashid'', 500, NULL, NULL, ARRAY[%L]::uuid[])', tag_out));
  IF r <> '-' THEN
    failed := array_append(failed, 'another account''s tag found ' || r);
  END IF;
  n := n + 1;
  IF (SELECT count(*) FROM public.search_contact_candidates('rashid', 50, NULL, NULL, NULL)) <> 0 THEN
    failed := array_append(failed, 'the candidate lookup answered with no signed-in person'::text);
  END IF;

  -- ---- The 193 signatures --------------------------------------------
  -- As PostgREST calls them, by name: not ambiguous, same answers.
  n := n + 1;
  r := pg_temp.csf_try(u_owner, 'SELECT count(*)::text FROM search_contacts(p_term => ''rashid'', p_limit => 200)');
  IF r <> '200' THEN
    failed := array_append(failed, 'the 193 search_contacts answered ' || r);
  END IF;
  n := n + 1;
  r := pg_temp.csf_try(u_owner, $q$
    SELECT (SELECT array_agg(s) FROM search_contact_candidates('rashid zz') s)::text
         = (SELECT array_agg(s) FROM search_contact_candidates('rashid zz', 50, NULL, NULL, NULL) s)::text $q$);
  IF r <> 'true' AND r <> 't' THEN
    failed := array_append(failed, 'the two candidate signatures disagree: ' || r);
  END IF;

  -- ---- Privileges ----------------------------------------------------
  FOREACH q IN ARRAY ARRAY[
    'public.search_contacts(text, integer, uuid, text[], uuid[])',
    'public.search_contact_candidates(text, integer, uuid, text[], uuid[])',
    'public.search_contact_candidates(text, integer)'
  ] LOOP
    n := n + 1;
    IF has_function_privilege('anon', q, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', q, 'EXECUTE') THEN
      failed := array_append(failed, 'privileges of ' || q);
    END IF;
    n := n + 1;
    IF (SELECT prosecdef FROM pg_proc WHERE oid = q::regprocedure)
       IS DISTINCT FROM (q LIKE '%candidates%') THEN
      failed := array_append(failed, 'caller or definer: ' || q);
    END IF;
  END LOOP;
  -- No defaults on the filters: with them, the 193 call is ambiguous.
  n := n + 1;
  IF EXISTS (SELECT 1 FROM pg_proc
              WHERE proname IN ('search_contacts', 'search_contact_candidates')
                AND pronargs = 5 AND pronargdefaults <> 0) THEN
    failed := array_append(failed, 'a filter parameter has a default'::text);
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZT298', MESSAGE = 'verify-contact-search-filters rollback';
  EXCEPTION WHEN SQLSTATE 'ZT298' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'contact search filter verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'contact search filter verification passed (% checks)', n;
END
$verify$;
