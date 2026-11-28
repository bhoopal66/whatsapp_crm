-- Behavioural regression suite for migration 331.
--
-- The Contacts page's lead-source filter value 'unknown' means "no lead
-- source recorded" (contacts.lead_source IS NULL), in both functions
-- that read the filter: contacts_sorted_page (257) and the search
-- (search_contacts / search_contact_candidates, 298). Unknown returns
-- only no-source contacts the caller can see; a named source still
-- works, alone or with unknown; an agent (RLS) and a list narrowed to
-- one owner see only that person's unknowns; another account's never
-- show. Fails without 331: 'unknown' then matches nobody.
--
-- ONE statement, rolled back by a sentinel, as verify-contact-search.sql
-- explains.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000331001';
  u_ag    UUID := '00000000-0000-4000-8000-000000331002';  -- agent in A
  u_out   UUID := '00000000-0000-4000-8000-000000331003';  -- owns B
  a_acct  UUID;
  a_out   UUID;
  c       RECORD;
  q       TEXT;
  r       TEXT;
  w       TEXT;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a SELECT as a signed-in user: the value, 'ok' for no row, or
  -- 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cus331_try(p_uid uuid, p_sql text)
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
  -- The names a search found (their last word), alphabetically.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cus331_search(p_uid uuid, p_call text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.cus331_try(p_uid, format(
        'SELECT coalesce(string_agg(split_part(c.name, '' '', 3), '','' ORDER BY split_part(c.name, '' '', 3)), ''-'') FROM %s s JOIN public.contacts c ON c.id = s.contact_id', p_call))
    $body$
  $fn$;
  -- The names on one sorted page (owner order), alphabetically, then
  -- '/' and the total the page reports.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cus331_sorted(p_uid uuid, p_owner uuid, p_sources text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.cus331_try(p_uid, format(
        'WITH p AS (SELECT public.contacts_sorted_page(''owner'', ''asc'', 200, 0, %L::uuid, ''%%Cus331 Zz%%'', NULL, NULL, %L::text[]) AS j) '
        'SELECT coalesce((SELECT string_agg(split_part(c.name, '' '', 3), '','' ORDER BY split_part(c.name, '' '', 3)) '
        'FROM p CROSS JOIN LATERAL jsonb_array_elements_text(p.j->''ids'') AS i(id) '
        'JOIN public.contacts c ON c.id = i.id::uuid), ''-'') '
        '|| ''/'' || (SELECT p.j->>''total'' FROM p)',
        p_owner, p_sources))
    $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'cus331-owner@example.invalid'),
    (u_ag,    'cus331-agent@example.invalid'),
    (u_out,   'cus331-out@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  SELECT id INTO a_out FROM accounts WHERE owner_user_id = u_out;
  IF a_acct IS NULL OR a_out IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_ag;

  -- Own: the owner's, no source. Agent: the agent's, no source.
  -- Web: the owner's, web_form. Ad: the agent's, ad. Out: B's, no source.
  INSERT INTO contacts (account_id, user_id, name, phone, lead_source) VALUES
    (a_acct, u_owner, 'Cus331 Zz Own',   '+971503310001', NULL),
    (a_acct, u_ag,    'Cus331 Zz Agent', '+971503310002', NULL),
    (a_acct, u_owner, 'Cus331 Zz Web',   '+971503310003', 'web_form'),
    (a_acct, u_ag,    'Cus331 Zz Ad',    '+971503310004', 'ad'),
    (a_out,  u_out,   'Cus331 Zz Out',   '+971503310005', NULL);

  -- 'unknown' is a filter value, never a stored one.
  n := n + 1;
  BEGIN
    UPDATE contacts SET lead_source = 'unknown'
     WHERE account_id = a_acct AND name = 'Cus331 Zz Own';
    failed := array_append(failed, 'lead_source accepted ''unknown''');
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- ---- contacts_sorted_page ------------------------------------------
  FOR c IN SELECT * FROM (VALUES
      ('owner, unknown',          u_owner, NULL::uuid, '{unknown}',    'Agent,Own/2'),
      ('owner, web_form',         u_owner, NULL::uuid, '{web_form}',   'Web/1'),
      ('owner, unknown or ad',    u_owner, NULL::uuid, '{ad,unknown}', 'Ad,Agent,Own/3'),
      ('owner, no filter',        u_owner, NULL::uuid, NULL,           'Ad,Agent,Own,Web/4'),
      ('owner narrowed to agent', u_owner, u_ag,       '{unknown}',    'Agent/1'),
      ('agent, unknown',          u_ag,    NULL::uuid, '{unknown}',    'Agent/1'),
      ('agent, own only',         u_ag,    u_ag,       '{unknown}',    'Agent/1'),
      ('outsider, unknown',       u_out,   NULL::uuid, '{unknown}',    'Out/1')
    ) AS t(label, uid, owner_id, sources, expected)
  LOOP
    n := n + 1;
    r := pg_temp.cus331_sorted(c.uid, c.owner_id, c.sources);
    IF r IS DISTINCT FROM c.expected THEN
      failed := array_append(failed,
        format('sorted page, %s: %s (want %s)', c.label, r, c.expected));
    END IF;
  END LOOP;

  -- ---- the search, every query path ----------------------------------
  -- Text (words), a short number and a long number.
  FOREACH w IN ARRAY ARRAY['cus331 zz', '0331', '5033100'] LOOP
    FOR c IN SELECT * FROM (VALUES
        ('owner, unknown',          u_owner, NULL::uuid, '{unknown}',    'Agent,Own'),
        ('owner, web_form',         u_owner, NULL::uuid, '{web_form}',   'Web'),
        ('owner, unknown or ad',    u_owner, NULL::uuid, '{ad,unknown}', 'Ad,Agent,Own'),
        ('owner narrowed to agent', u_owner, u_ag,       '{unknown}',    'Agent'),
        ('agent, unknown',          u_ag,    NULL::uuid, '{unknown}',    'Agent'),
        ('agent, own only',         u_ag,    u_ag,       '{unknown}',    'Agent'),
        ('outsider, unknown',       u_out,   NULL::uuid, '{unknown}',    'Out')
      ) AS t(label, uid, owner_id, sources, expected)
    LOOP
      n := n + 1;
      r := pg_temp.cus331_search(c.uid, format(
        'search_contacts(%L, 500, %L::uuid, %L::text[], NULL)', w, c.owner_id, c.sources));
      IF r IS DISTINCT FROM c.expected THEN
        failed := array_append(failed,
          format('search %s, %s: %s (want %s)', w, c.label, r, c.expected));
      END IF;
    END LOOP;
    -- The SECURITY DEFINER lookup called directly widens nothing.
    n := n + 1;
    r := pg_temp.cus331_search(u_ag, format(
      'search_contact_candidates(%L, 500, NULL::uuid, %L::text[], NULL::uuid[])', w, '{unknown}'));
    IF r IS DISTINCT FROM 'Agent' THEN
      failed := array_append(failed,
        format('candidates %s as the agent, unknown: %s', w, r));
    END IF;
  END LOOP;

  RAISE EXCEPTION USING ERRCODE = 'ZT331', MESSAGE = 'verify-contacts-unknown-source rollback';
  EXCEPTION WHEN SQLSTATE 'ZT331' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'contacts unknown source verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'contacts unknown source verification passed (% checks)', n;
END
$verify$;
