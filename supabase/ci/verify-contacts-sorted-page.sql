-- Behavioural regression suite for contacts_sorted_page (migration 322).
--
-- Ordering by owner name, assigned agent name and last activity, nulls
-- last in both directions, narrowing by owner / tag / source, the page
-- window and total, and that RLS (the caller's own view) still decides
-- which contacts exist. ONE statement; fixtures roll back via a sentinel.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000322001';
  u_amy    UUID := '00000000-0000-4000-8000-000000322002';
  u_zed    UUID := '00000000-0000-4000-8000-000000322003';
  u_other  UUID := '00000000-0000-4000-8000-000000322004';
  a_acct   UUID;
  b_acct   UUID;
  c1 UUID; c2 UUID; c3 UUID; c4 UUID; cb UUID;
  tg UUID;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cs_try(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; c bigint;
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
          GET DIAGNOSTICS c = ROW_COUNT;
          v := c::text;
        END IF;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(v, 'null');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR: ' || SQLERRM;
      END;
    END $body$
  $fn$;


  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'cs-owner@example.invalid'),
    (u_amy,   'cs-amy@example.invalid'),
    (u_zed,   'cs-zed@example.invalid'),
    (u_other, 'cs-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  SELECT id INTO b_acct FROM accounts WHERE owner_user_id = u_other;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent', full_name = 'Amy' WHERE user_id = u_amy;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent', full_name = 'Zed' WHERE user_id = u_zed;
  UPDATE profiles SET full_name = 'Owner' WHERE user_id = u_owner;

  INSERT INTO chat_tags (account_id, name, position) VALUES (a_acct, 'CS tag', 0) RETURNING id INTO tg;

  -- c1 owned by Zed, assigned Amy, active 1 day ago; c2 owned by Amy,
  -- assigned Zed, active 3 days ago; c3 owned by Zed, unassigned, no
  -- chat activity; c4 owned by Amy, no chat at all, source web_form.
  INSERT INTO contacts (account_id, user_id, phone, name, created_at) VALUES (a_acct, u_zed, '971500322001', 'CS one', now() - interval '4 days') RETURNING id INTO c1;
  INSERT INTO contacts (account_id, user_id, phone, name, created_at) VALUES (a_acct, u_amy, '971500322002', 'CS two', now() - interval '3 days') RETURNING id INTO c2;
  INSERT INTO contacts (account_id, user_id, phone, name, created_at) VALUES (a_acct, u_zed, '971500322003', 'CS three', now() - interval '2 days') RETURNING id INTO c3;
  INSERT INTO contacts (account_id, user_id, phone, name, lead_source, created_at) VALUES (a_acct, u_amy, '971500322004', 'CS four', 'web_form', now() - interval '1 day') RETURNING id INTO c4;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (b_acct, u_other, '971500322009', 'CS other acct') RETURNING id INTO cb;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id, last_message_at, chat_tag_id)
    VALUES (a_acct, u_zed, c1, u_amy, now() - interval '1 day', tg);
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id, last_message_at)
    VALUES (a_acct, u_amy, c2, u_zed, now() - interval '3 days');
  INSERT INTO conversations (account_id, user_id, contact_id, last_message_at)
    VALUES (a_acct, u_zed, c3, NULL);

  -- Assigning a chat moves its contact's owner (169), so put the owners
  -- back the way the scenario says before ordering by them.
  UPDATE contacts SET user_id = u_zed WHERE id IN (c1, c3);
  UPDATE contacts SET user_id = u_amy WHERE id IN (c2, c4);

  -- Order by owner, ascending: Amy's (c2, c4; newest created first = c4)
  -- then Zed's (c3, c1).
  r := pg_temp.cs_try(u_owner, format(
    'SELECT string_agg(contact_id::text, '','' ORDER BY ord) FROM (SELECT contact_id, row_number() OVER () ord FROM contacts_sorted_page(%L, %L)) s', 'owner', 'asc'));
  n := n + 1;
  IF r IS DISTINCT FROM (c4::text || ',' || c2::text || ',' || c3::text || ',' || c1::text) THEN
    failed := array_append(failed, 'owner asc order wrong: ' || r);
  END IF;
  r := pg_temp.cs_try(u_owner, format(
    'SELECT string_agg(contact_id::text, '','' ORDER BY ord) FROM (SELECT contact_id, row_number() OVER () ord FROM contacts_sorted_page(%L, %L)) s', 'owner', 'desc'));
  n := n + 1;
  IF r IS DISTINCT FROM (c3::text || ',' || c1::text || ',' || c4::text || ',' || c2::text) THEN
    failed := array_append(failed, 'owner desc order wrong: ' || r);
  END IF;

  -- Assigned: Amy (c1), Zed (c2), then the unassigned (c4, c3 by newest) last.
  r := pg_temp.cs_try(u_owner, format(
    'SELECT string_agg(contact_id::text, '','' ORDER BY ord) FROM (SELECT contact_id, row_number() OVER () ord FROM contacts_sorted_page(%L, %L)) s', 'assigned', 'asc'));
  n := n + 1;
  IF r IS DISTINCT FROM (c1::text || ',' || c2::text || ',' || c4::text || ',' || c3::text) THEN
    failed := array_append(failed, 'assigned asc order wrong: ' || r);
  END IF;
  r := pg_temp.cs_try(u_owner, format(
    'SELECT string_agg(contact_id::text, '','' ORDER BY ord) FROM (SELECT contact_id, row_number() OVER () ord FROM contacts_sorted_page(%L, %L)) s', 'assigned', 'desc'));
  n := n + 1;
  IF r IS DISTINCT FROM (c2::text || ',' || c1::text || ',' || c4::text || ',' || c3::text) THEN
    failed := array_append(failed, 'assigned desc order wrong (nulls must stay last): ' || r);
  END IF;

  -- Activity: newest first in desc (c1, c2), no activity last.
  r := pg_temp.cs_try(u_owner, format(
    'SELECT string_agg(contact_id::text, '','' ORDER BY ord) FROM (SELECT contact_id, row_number() OVER () ord FROM contacts_sorted_page(%L, %L)) s', 'activity', 'desc'));
  n := n + 1;
  IF r IS DISTINCT FROM (c1::text || ',' || c2::text || ',' || c4::text || ',' || c3::text) THEN
    failed := array_append(failed, 'activity desc order wrong: ' || r);
  END IF;
  r := pg_temp.cs_try(u_owner, format(
    'SELECT string_agg(contact_id::text, '','' ORDER BY ord) FROM (SELECT contact_id, row_number() OVER () ord FROM contacts_sorted_page(%L, %L)) s', 'activity', 'asc'));
  n := n + 1;
  IF r IS DISTINCT FROM (c2::text || ',' || c1::text || ',' || c4::text || ',' || c3::text) THEN
    failed := array_append(failed, 'activity asc order wrong: ' || r);
  END IF;

  -- Total counts the whole match, not the page; window works.
  r := pg_temp.cs_try(u_owner, format(
    'SELECT max(total)::text || '':'' || count(*)::text FROM contacts_sorted_page(%L, %L, NULL, NULL, NULL, 2, 2)', 'owner', 'asc'));
  n := n + 1;
  IF r <> '4:2' THEN failed := array_append(failed, 'page window or total wrong: ' || r); END IF;

  -- Narrowing: owner, tag, source.
  r := pg_temp.cs_try(u_owner, format(
    'SELECT count(*)::text FROM contacts_sorted_page(%L, %L, %L)', 'owner', 'asc', u_zed));
  n := n + 1;
  IF r <> '2' THEN failed := array_append(failed, 'p_user narrowing wrong: ' || r); END IF;
  r := pg_temp.cs_try(u_owner, format(
    'SELECT string_agg(contact_id::text, '','') FROM contacts_sorted_page(%L, %L, NULL, ARRAY[%L]::uuid[])', 'owner', 'asc', tg));
  n := n + 1;
  IF r IS DISTINCT FROM c1::text THEN failed := array_append(failed, 'tag narrowing wrong: ' || r); END IF;
  r := pg_temp.cs_try(u_owner, format(
    'SELECT string_agg(contact_id::text, '','') FROM contacts_sorted_page(%L, %L, NULL, NULL, ARRAY[''web_form''])', 'owner', 'asc'));
  n := n + 1;
  IF r IS DISTINCT FROM c4::text THEN failed := array_append(failed, 'source narrowing wrong: ' || r); END IF;

  -- Never another account's contacts; bad arguments refused.
  r := pg_temp.cs_try(u_owner, format(
    'SELECT count(*)::text FROM contacts_sorted_page(%L, %L) WHERE contact_id = %L', 'owner', 'asc', cb));
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, 'another account''s contact was listed: ' || r); END IF;
  r := pg_temp.cs_try(u_owner, 'SELECT count(*)::text FROM contacts_sorted_page(''name'', ''asc'')');
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN failed := array_append(failed, 'unknown key accepted: ' || r); END IF;
  r := pg_temp.cs_try(u_owner, 'SELECT count(*)::text FROM contacts_sorted_page(''owner'', ''sideways'')');
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN failed := array_append(failed, 'unknown direction accepted: ' || r); END IF;

  n := n + 1;
  IF has_function_privilege('anon', 'public.contacts_sorted_page(text, text, uuid, uuid[], text[], int, int)', 'EXECUTE') THEN
    failed := array_append(failed, 'anon can run contacts_sorted_page');
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZT322', MESSAGE = 'verify-contacts-sorted-page rollback';
  EXCEPTION WHEN SQLSTATE 'ZT322' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'contacts sorted page verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'contacts sorted page verification passed (% checks)', n;
END
$verify$;
