-- Behavioural regression suite for sorting the Contacts list by owner,
-- assigned person and last activity (migration 257).
--
-- contacts_sorted_page() orders the whole filtered match set and hands
-- back one page of ids plus the total. Checked here: each key in both
-- directions (case-insensitive names, a blank full name falling back to
-- the email, NULLs last both ways, ties on created_at newest first then
-- id), paging without overlap or gap, every filter (search pattern,
-- phone digits, chat tag main/sub over company chats only, lead source,
-- the leader's own-contacts narrowing), personal chats ignored for the
-- assignee and last activity, and above all that contacts RLS still
-- decides: an agent sees only their own contacts, a team leader their
-- team's, an admin the whole workspace, nobody another workspace.
--
-- ONE statement on purpose: `supabase db query --file` sends the file as
-- a single prepared statement and rejects several. Fixtures are rolled
-- back by a sentinel exception; failures are named in the final one.
-- Fixture emails use the prefix cs-.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000257001';  -- 'Zulu CS'
  u_admin  UUID := '00000000-0000-4000-8000-000000257002';  -- 'Alpha CS'
  u_lead   UUID := '00000000-0000-4000-8000-000000257003';  -- 'Mike CS'
  u_g1     UUID := '00000000-0000-4000-8000-000000257004';  -- 'bravo CS', in the lead's team
  u_g2     UUID := '00000000-0000-4000-8000-000000257005';  -- blank name: 'cs-g2@…', no team
  u_other  UUID := '00000000-0000-4000-8000-000000257006';  -- owner of workspace B
  a_acct   UUID;
  b_acct   UUID;
  t_team   UUID;
  tag_main UUID;
  tag_sub  UUID;
  k        UUID[] := '{}';
  ct       UUID;
  t_recent TIMESTAMPTZ := now() - interval '1 day';
  v        TEXT;
  i        INT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as a signed-in user: the value, or
  -- 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cs_as(p_uid uuid, p_sql text)
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
        RETURN v;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, m = MESSAGE_TEXT;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN format('ERROR %s: %s', st, m);
      END;
    END $body$
  $fn$;
  -- A page as the caller sees it: 'k1,k2,…|total' (an id outside the
  -- fixture shows as '?<id>').
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cs_page(p_uid uuid, p_args text, p_k uuid[])
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; j jsonb;
    BEGIN
      v := pg_temp.cs_as(p_uid,
        'SELECT public.contacts_sorted_page(' || p_args || ')::text');
      IF v IS NULL OR v LIKE 'ERROR%' THEN RETURN coalesce(v, '<null>'); END IF;
      j := v::jsonb;
      RETURN coalesce((
        SELECT string_agg(coalesce('k' || array_position(p_k, x::uuid), '?' || x),
                          ',' ORDER BY o)
          FROM jsonb_array_elements_text(j -> 'ids') WITH ORDINALITY e(x, o)
      ), '') || '|' || (j ->> 'total');
    END $body$
  $fn$;
  -- The contacts a plain SELECT shows the caller, as sorted labels.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cs_plain(p_uid uuid, p_k uuid[])
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.cs_as(p_uid, format(
        'SELECT coalesce(string_agg(coalesce(''k'' || array_position(%L::uuid[], id), ''?'' || id::text), '','' ORDER BY array_position(%L::uuid[], id) NULLS LAST, id), '''') FROM public.contacts',
        p_k, p_k))
    $body$
  $fn$;
  -- The same labels, sorted by fixture number.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cs_set(p_page text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT coalesce(string_agg(x, ',' ORDER BY nullif(regexp_replace(x, '\D', '', 'g'), '')::int NULLS LAST, x), '')
        FROM unnest(string_to_array(split_part(p_page, '|', 1), ',')) x
       WHERE x <> ''
    $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cs_chk(p_name text, p_got text, p_want text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT CASE WHEN p_got IS NOT DISTINCT FROM p_want THEN NULL
                  ELSE p_name || ' (want ' || p_want || ', got '
                       || left(coalesce(p_got, '<null>'), 300) || ')' END
    $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'cs-owner@example.invalid'), (u_admin, 'cs-admin@example.invalid'),
    (u_lead, 'cs-lead@example.invalid'), (u_g1, 'cs-g1@example.invalid'),
    (u_g2, 'cs-g2@example.invalid'), (u_other, 'cs-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  SELECT id INTO b_acct FROM accounts WHERE owner_user_id = u_other;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_g1, u_g2);
  UPDATE profiles SET full_name = 'Zulu CS' WHERE user_id = u_owner;
  UPDATE profiles SET full_name = 'Alpha CS' WHERE user_id = u_admin;
  UPDATE profiles SET full_name = 'Mike CS' WHERE user_id = u_lead;
  UPDATE profiles SET full_name = 'bravo CS' WHERE user_id = u_g1;
  UPDATE profiles SET full_name = '   ' WHERE user_id = u_g2;
  INSERT INTO teams (account_id, name, leader_user_id)
    VALUES (a_acct, 'cs team', u_lead) RETURNING id INTO t_team;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (t_team, u_g1, a_acct);
  INSERT INTO chat_tags (account_id, name) VALUES (a_acct, 'CS main') RETURNING id INTO tag_main;
  INSERT INTO chat_tags (account_id, parent_id, name) VALUES (a_acct, tag_main, 'CS sub') RETURNING id INTO tag_sub;

  -- k1..k7 in workspace A, k1 newest; k8 in workspace B.
  FOR i IN 1..7 LOOP
    INSERT INTO contacts (account_id, user_id, phone, name, created_at)
    VALUES (a_acct, u_owner, '97150257000' || i, 'CS contact ' || i,
            now() - make_interval(days => i))
    RETURNING id INTO ct;
    k := k || ct;
  END LOOP;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (b_acct, u_other, '971502570008', 'CS contact 8') RETURNING id INTO ct;
  k := k || ct;
  UPDATE contacts SET name = 'CS two' WHERE id = k[2];
  UPDATE contacts SET name = 'CS three' WHERE id = k[3];
  UPDATE contacts SET email = 'cs-four@example.invalid' WHERE id = k[4];
  UPDATE contacts SET lead_source = 'ad' WHERE id IN (k[1], k[5]);
  UPDATE contacts SET lead_source = 'manual' WHERE id = k[2];

  -- Company chats (assignee, last message, tags) and k3's personal chat.
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id, last_message_at, chat_tag_id)
    VALUES (a_acct, u_owner, k[1], u_g1, now() - interval '5 days', tag_main);
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id, last_message_at, chat_tag_id, chat_sub_tag_id)
    VALUES (a_acct, u_owner, k[2], u_lead, t_recent, tag_main, tag_sub);
  INSERT INTO conversations (account_id, user_id, contact_id)
    VALUES (a_acct, u_owner, k[3]);
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id, last_message_at)
    VALUES (a_acct, u_owner, k[5], u_admin, now() - interval '3 days');
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id, last_message_at)
    VALUES (a_acct, u_owner, k[6], u_g2, now() - interval '10 days');
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id, last_message_at)
    VALUES (a_acct, u_owner, k[7], u_lead, t_recent);
  -- k3's personal chat: newest message and an assignee, both ignored;
  -- its tag must not satisfy the tag filter.
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id, personal_owner_id, last_message_at, chat_tag_id)
    VALUES (a_acct, u_g2, k[3], u_g2, u_g2, now(), tag_main);
  -- Owners, set after the chats (169 moves an owner to the assignee).
  -- k6 belongs to someone with no profile in A: no owner name.
  UPDATE contacts SET user_id = u_admin WHERE id = k[1];
  UPDATE contacts SET user_id = u_g1 WHERE id IN (k[2], k[7]);
  UPDATE contacts SET user_id = u_g2 WHERE id = k[3];
  UPDATE contacts SET user_id = u_lead WHERE id = k[4];
  UPDATE contacts SET user_id = u_owner WHERE id = k[5];
  UPDATE contacts SET user_id = u_other WHERE id = k[6];

  -- ---------- each key, both directions (admin: all of A) ----------
  failed := failed || pg_temp.cs_chk('owner asc',
    pg_temp.cs_page(u_admin, '''owner'', ''asc''', k), 'k1,k2,k7,k3,k4,k5,k6|7');
  failed := failed || pg_temp.cs_chk('owner desc',
    pg_temp.cs_page(u_admin, '''owner'', ''desc''', k), 'k5,k4,k3,k2,k7,k1,k6|7');
  failed := failed || pg_temp.cs_chk('assignee asc (personal chat''s assignee ignored)',
    pg_temp.cs_page(u_admin, '''assignee'', ''asc''', k), 'k5,k1,k6,k2,k7,k3,k4|7');
  failed := failed || pg_temp.cs_chk('assignee desc',
    pg_temp.cs_page(u_admin, '''assignee'', ''desc''', k), 'k2,k7,k6,k1,k5,k3,k4|7');
  failed := failed || pg_temp.cs_chk('activity asc (personal chat''s message ignored)',
    pg_temp.cs_page(u_admin, '''activity'', ''asc''', k), 'k6,k1,k5,k2,k7,k3,k4|7');
  failed := failed || pg_temp.cs_chk('activity desc',
    pg_temp.cs_page(u_admin, '''activity'', ''desc''', k), 'k2,k7,k5,k1,k6,k3,k4|7');
  n := n + 6;

  -- ---------- paging: three pages, no overlap, no gap ----------
  v := split_part(pg_temp.cs_page(u_admin, '''owner'', ''asc'', 3, 0', k), '|', 1)
    || ',' || split_part(pg_temp.cs_page(u_admin, '''owner'', ''asc'', 3, 3', k), '|', 1)
    || ',' || split_part(pg_temp.cs_page(u_admin, '''owner'', ''asc'', 3, 6', k), '|', 1);
  failed := failed || pg_temp.cs_chk('pages of 3 join into the full order', v, 'k1,k2,k7,k3,k4,k5,k6');
  failed := failed || pg_temp.cs_chk('a page keeps the whole total',
    pg_temp.cs_page(u_admin, '''activity'', ''desc'', 2, 2', k), 'k5,k1|7');
  failed := failed || pg_temp.cs_chk('a page past the end is empty with the total',
    pg_temp.cs_page(u_admin, '''activity'', ''desc'', 25, 50', k), '|7');
  n := n + 3;

  -- ---------- filters ----------
  failed := failed || pg_temp.cs_chk('search pattern on name',
    pg_temp.cs_page(u_admin, '''owner'', ''asc'', 25, 0, NULL, ''%cs t%''', k), 'k2,k3|2');
  failed := failed || pg_temp.cs_chk('search pattern on email',
    pg_temp.cs_page(u_admin, '''owner'', ''asc'', 25, 0, NULL, ''%cs-four%''', k), 'k4|1');
  failed := failed || pg_temp.cs_chk('search pattern on phone',
    pg_temp.cs_page(u_admin, '''owner'', ''asc'', 25, 0, NULL, ''%2570005%''', k), 'k5|1');
  failed := failed || pg_temp.cs_chk('search digits on phone_normalized',
    pg_temp.cs_page(u_admin, '''owner'', ''asc'', 25, 0, NULL, NULL, ''2570006''', k), 'k6|1');
  failed := failed || pg_temp.cs_chk('pattern OR digits',
    pg_temp.cs_page(u_admin, '''owner'', ''asc'', 25, 0, NULL, ''%cs two%'', ''2570006''', k), 'k2,k6|2');
  failed := failed || pg_temp.cs_chk('non-digit digits are ignored',
    pg_temp.cs_page(u_admin, '''owner'', ''asc'', 25, 0, NULL, NULL, ''25%''', k), 'k1,k2,k7,k3,k4,k5,k6|7');
  failed := failed || pg_temp.cs_chk('main tag matches a company chat with it as main (not k3''s personal chat)',
    pg_temp.cs_page(u_admin, format('''owner'', ''asc'', 25, 0, NULL, NULL, NULL, ARRAY[%L]::uuid[]', tag_main), k), 'k1,k2|2');
  failed := failed || pg_temp.cs_chk('sub tag',
    pg_temp.cs_page(u_admin, format('''owner'', ''asc'', 25, 0, NULL, NULL, NULL, ARRAY[%L]::uuid[]', tag_sub), k), 'k2|1');
  failed := failed || pg_temp.cs_chk('empty tag list = no filter',
    pg_temp.cs_page(u_admin, '''owner'', ''asc'', 25, 0, NULL, NULL, NULL, ARRAY[]::uuid[]', k), 'k1,k2,k7,k3,k4,k5,k6|7');
  failed := failed || pg_temp.cs_chk('lead source',
    pg_temp.cs_page(u_admin, '''activity'', ''desc'', 25, 0, NULL, NULL, NULL, NULL, ARRAY[''ad'']', k), 'k5,k1|2');
  failed := failed || pg_temp.cs_chk('lead sources (any of)',
    pg_temp.cs_page(u_admin, '''owner'', ''asc'', 25, 0, NULL, NULL, NULL, NULL, ARRAY[''ad'', ''manual'']', k), 'k1,k2,k5|3');
  failed := failed || pg_temp.cs_chk('lead source unknown = no source',
    pg_temp.cs_page(u_admin, '''owner'', ''asc'', 25, 0, NULL, NULL, NULL, NULL, ARRAY[''unknown'']', k), 'k7,k3,k4,k6|4');
  failed := failed || pg_temp.cs_chk('lead source unknown with a known one',
    pg_temp.cs_page(u_admin, '''owner'', ''asc'', 25, 0, NULL, NULL, NULL, NULL, ARRAY[''ad'', ''unknown'']', k), 'k1,k7,k3,k4,k5,k6|6');
  failed := failed || pg_temp.cs_chk('owner narrowing',
    pg_temp.cs_page(u_admin, format('''assignee'', ''asc'', 25, 0, %L', u_g1), k), 'k2,k7|2');
  failed := failed || pg_temp.cs_chk('filters combine',
    pg_temp.cs_page(u_admin, format('''owner'', ''asc'', 25, 0, NULL, ''%%cs%%'', NULL, ARRAY[%L]::uuid[], ARRAY[''ad'']', tag_main), k), 'k1|1');
  n := n + 15;

  -- ---------- RLS decides ----------
  -- Every caller gets exactly what a plain SELECT on contacts shows them.
  failed := failed || pg_temp.cs_chk('agent: the same contacts as a plain SELECT',
    pg_temp.cs_set(pg_temp.cs_page(u_g1, '''owner'', ''asc''', k)), pg_temp.cs_plain(u_g1, k));
  failed := failed || pg_temp.cs_chk('second agent: the same contacts as a plain SELECT',
    pg_temp.cs_set(pg_temp.cs_page(u_g2, '''activity'', ''desc''', k)), pg_temp.cs_plain(u_g2, k));
  failed := failed || pg_temp.cs_chk('leader: the same contacts as a plain SELECT',
    pg_temp.cs_set(pg_temp.cs_page(u_lead, '''assignee'', ''asc''', k)), pg_temp.cs_plain(u_lead, k));
  failed := failed || pg_temp.cs_chk('admin: the same contacts as a plain SELECT',
    pg_temp.cs_set(pg_temp.cs_page(u_admin, '''owner'', ''asc''', k)), pg_temp.cs_plain(u_admin, k));
  -- An agent: own contacts and the chat assigned to them, sorted; never
  -- the lead's, the owner's, the other agent's or workspace B's.
  failed := failed || pg_temp.cs_chk('agent, owner asc',
    pg_temp.cs_page(u_g1, '''owner'', ''asc''', k), 'k1,k2,k7|3');
  failed := failed || pg_temp.cs_chk('other agent, owner asc (no owner name last)',
    pg_temp.cs_page(u_g2, '''owner'', ''asc''', k), 'k3,k6|2');
  -- Team leader: /team-contacts shows the team's contacts, /contacts
  -- narrows them to their own.
  v := pg_temp.cs_page(u_lead, '''owner'', ''asc''', k);
  n := n + 1;
  IF v NOT LIKE '%k2%' OR v NOT LIKE '%k4%' OR v NOT LIKE '%k7%'
     OR v LIKE '%k5%' OR v LIKE '%k6%' OR v LIKE '%k8%' OR v LIKE '%?%' THEN
    failed := array_append(failed, ('leader team view should hold the team''s contacts and their own, not others: ' || v)::text);
  END IF;
  failed := failed || pg_temp.cs_chk('leader personal view (own contacts only)',
    pg_temp.cs_page(u_lead, format('''owner'', ''asc'', 25, 0, %L', u_lead), k), 'k4|1');
  failed := failed || pg_temp.cs_chk('another workspace sees only its own',
    pg_temp.cs_page(u_other, '''owner'', ''asc''', k), 'k8|1');
  n := n + 8;

  -- ---------- refusals and grants ----------
  v := pg_temp.cs_page(u_admin, '''created'', ''asc''', k);
  n := n + 1;
  IF v NOT LIKE 'ERROR 22023:%' THEN failed := array_append(failed, ('an unknown sort was accepted: ' || v)::text); END IF;
  v := pg_temp.cs_page(u_admin, '''owner'', ''sideways''', k);
  n := n + 1;
  IF v NOT LIKE 'ERROR 22023:%' THEN failed := array_append(failed, ('an unknown direction was accepted: ' || v)::text); END IF;
  n := n + 1;
  IF has_function_privilege('anon', 'public.contacts_sorted_page(text, text, integer, integer, uuid, text, text, uuid[], text[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.contacts_sorted_page(text, text, integer, integer, uuid, text, text, uuid[], text[])', 'EXECUTE') THEN
    failed := array_append(failed, 'anon may execute contacts_sorted_page, or authenticated may not'::text);
  END IF;
  n := n + 1;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.contacts_sorted_page(text, text, integer, integer, uuid, text, text, uuid[], text[])'::regprocedure) THEN
    failed := array_append(failed, 'contacts_sorted_page must be SECURITY INVOKER'::text);
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZT257', MESSAGE = 'verify-contact-sort rollback';
  EXCEPTION WHEN SQLSTATE 'ZT257' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'contact sort verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'contact sort verification passed (% checks)', n;
END
$verify$;
