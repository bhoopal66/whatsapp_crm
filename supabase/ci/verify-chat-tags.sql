-- Behavioural regression suite for chat tags (migration 075).
--
-- A chat carries at most one main tag and at most one sub-tag, and the
-- sub-tag must belong to the main tag. The rules live in two triggers
-- (chat_tags_guard, conversations_chat_tag_guard), composite FKs and
-- RLS, none of which `npm test` can reach. This asserts the nesting
-- limit, parent immutability, sibling-name uniqueness, the chat-level
-- pairing rule, the delete cascade, the account wall, and who may
-- write what.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000075001';
  u_admin  UUID := '00000000-0000-4000-8000-000000075002';
  u_agent  UUID := '00000000-0000-4000-8000-000000075003';
  u_view   UUID := '00000000-0000-4000-8000-000000075004';
  u_other  UUID := '00000000-0000-4000-8000-000000075005';
  a_acct   UUID;
  b_acct   UUID;
  m_new    UUID;  -- main: New customer
  m_int    UUID;  -- main: Interested customer (sub-tags s_adcb, s_fab)
  m_not    UUID;  -- main: Not interested (sub-tag s_not_fab)
  s_adcb   UUID;
  s_fab    UUID;
  s_not    UUID;
  m_tmp    UUID;
  s_tmp    UUID;
  ct       UUID;
  cv_a     UUID;  -- account A, owned by the agent
  cv_b     UUID;  -- account B
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as a signed-in user: the value of a SELECT, the
  -- row count of anything else, or the error.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ct_try(p_uid uuid, p_sql text)
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

  -- Run a statement as the table owner: 'ok' or the SQLSTATE + error.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ct_do(p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    BEGIN
      EXECUTE p_sql;
      RETURN 'ok';
    EXCEPTION WHEN OTHERS THEN
      RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
    END $body$
  $fn$;

  -- A conversation's (main, sub) pair as text.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ct_pair(p_conv uuid)
    RETURNS text LANGUAGE sql AS $body$
      SELECT coalesce(chat_tag_id::text, 'null') || '/' || coalesce(chat_sub_tag_id::text, 'null')
        FROM public.conversations WHERE id = p_conv;
    $body$
  $fn$;

  -- Fixture: account A (owner, admin, agent, viewer), account B (owner).
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'ct-owner@example.invalid'),
    (u_admin, 'ct-admin@example.invalid'),
    (u_agent, 'ct-agent@example.invalid'),
    (u_view,  'ct-view@example.invalid'),
    (u_other, 'ct-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  SELECT id INTO b_acct FROM accounts WHERE owner_user_id = u_other;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin'  WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent'  WHERE user_id = u_agent;
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_view;

  INSERT INTO chat_tags (account_id, name, color, sub_tag_title, position)
  VALUES (a_acct, 'New customer', '#22c55e', NULL, 0) RETURNING id INTO m_new;
  INSERT INTO chat_tags (account_id, name, color, sub_tag_title, position)
  VALUES (a_acct, 'Interested customer', '#3b82f6', 'Bank', 1) RETURNING id INTO m_int;
  INSERT INTO chat_tags (account_id, name, sub_tag_title, position)
  VALUES (a_acct, 'Not interested', NULL, 2) RETURNING id INTO m_not;
  INSERT INTO chat_tags (account_id, parent_id, name, sub_tag_title)
  VALUES (a_acct, m_int, 'ADCB', 'ignored') RETURNING id INTO s_adcb;
  INSERT INTO chat_tags (account_id, parent_id, name)
  VALUES (a_acct, m_int, 'FAB') RETURNING id INTO s_fab;
  INSERT INTO chat_tags (account_id, parent_id, name)
  VALUES (a_acct, m_not, 'Price') RETURNING id INTO s_not;

  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_agent, '971500075001', 'CT contact A') RETURNING id INTO ct;
  INSERT INTO conversations (account_id, user_id, contact_id)
  VALUES (a_acct, u_agent, ct) RETURNING id INTO cv_a;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (b_acct, u_other, '971500075002', 'CT contact B') RETURNING id INTO ct;
  INSERT INTO conversations (account_id, user_id, contact_id)
  VALUES (b_acct, u_other, ct) RETURNING id INTO cv_b;

  -- ---------- text tidying ----------
  r := pg_temp.ct_do(format(
         'INSERT INTO chat_tags (account_id, name, sub_tag_title) VALUES (%L, %L, %L), (%L, %L, %L)',
         a_acct, '  Tidy one ', '  Bank  ', a_acct, 'Tidy two', '   '));
  n := n + 1;
  IF r <> 'ok'
     OR (SELECT sub_tag_title FROM chat_tags WHERE account_id = a_acct AND name = 'Tidy one') IS DISTINCT FROM 'Bank'
     OR NOT EXISTS (SELECT 1 FROM chat_tags WHERE account_id = a_acct AND name = 'Tidy two' AND sub_tag_title IS NULL) THEN
    failed := array_append(failed, ('name / sub_tag_title were not trimmed (blank title -> NULL): ' || r)::text);
  END IF;
  n := n + 1;
  IF (SELECT sub_tag_title FROM chat_tags WHERE id = s_adcb) IS NOT NULL THEN
    failed := array_append(failed, 'a sub-tag kept a sub_tag_title'::text);
  END IF;

  -- ---------- 1. nesting and parent immutability ----------
  -- In a block of its own that always rolls back, so a guard that
  -- fails to refuse cannot reshape the tags the later sections use.
  BEGIN
  r := pg_temp.ct_do(format(
         'INSERT INTO chat_tags (account_id, parent_id, name) VALUES (%L, %L, %L)', a_acct, s_adcb, 'Deeper'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN
    failed := array_append(failed, ('a sub-tag of a sub-tag was accepted: ' || r)::text);
  END IF;
  r := pg_temp.ct_do(format('UPDATE chat_tags SET parent_id = %L WHERE id = %L', m_not, s_adcb));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' OR (SELECT parent_id FROM chat_tags WHERE id = s_adcb) <> m_int THEN
    failed := array_append(failed, ('a sub-tag was moved to another main tag: ' || r)::text);
  END IF;
  r := pg_temp.ct_do(format('UPDATE chat_tags SET parent_id = %L WHERE id = %L', m_int, m_new));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' OR (SELECT parent_id FROM chat_tags WHERE id = m_new) IS NOT NULL THEN
    failed := array_append(failed, ('a main tag was turned into a sub-tag: ' || r)::text);
  END IF;
  r := pg_temp.ct_do(format('UPDATE chat_tags SET parent_id = NULL WHERE id = %L', s_fab));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN
    failed := array_append(failed, ('a sub-tag was promoted to a main tag: ' || r)::text);
  END IF;
  r := pg_temp.ct_do(format(
         'UPDATE chat_tags SET updated_at = %L WHERE id = %L', '2000-01-01T00:00:00Z', m_new));
  n := n + 1;
  IF r <> 'ok' OR (SELECT updated_at FROM chat_tags WHERE id = m_new) < now() - interval '1 minute' THEN
    failed := array_append(failed, ('updated_at was not stamped on UPDATE: ' || r)::text);
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'ZT751', MESSAGE = 'verify-chat-tags section 1 rollback';
  EXCEPTION WHEN SQLSTATE 'ZT751' THEN
    NULL;
  END;

  -- ---------- 2. sibling names ----------
  r := pg_temp.ct_do(format(
         'INSERT INTO chat_tags (account_id, name) VALUES (%L, %L)', a_acct, '  new CUSTOMER '));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23505:%' THEN
    failed := array_append(failed, ('a duplicate main-tag name (case/spaces) was accepted: ' || r)::text);
  END IF;
  r := pg_temp.ct_do(format(
         'INSERT INTO chat_tags (account_id, parent_id, name) VALUES (%L, %L, %L)', a_acct, m_int, ' adcb'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23505:%' THEN
    failed := array_append(failed, ('a duplicate sub-tag name was accepted: ' || r)::text);
  END IF;
  r := pg_temp.ct_do(format(
         'INSERT INTO chat_tags (account_id, parent_id, name) VALUES (%L, %L, %L)', a_acct, m_not, 'ADCB'));
  n := n + 1;
  IF r <> 'ok' THEN
    failed := array_append(failed, ('the same sub-tag name under another main tag was refused: ' || r)::text);
  END IF;
  r := pg_temp.ct_do(format(
         'INSERT INTO chat_tags (account_id, name) VALUES (%L, %L)', b_acct, 'New customer'));
  n := n + 1;
  IF r <> 'ok' THEN
    failed := array_append(failed, ('account B could not reuse account A''s tag name: ' || r)::text);
  END IF;
  r := pg_temp.ct_do(format(
         'INSERT INTO chat_tags (account_id, name, color) VALUES (%L, %L, %L)', a_acct, 'Bad colour', 'blue'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN
    failed := array_append(failed, ('a non-hex colour was accepted: ' || r)::text);
  END IF;
  r := pg_temp.ct_do(format(
         'INSERT INTO chat_tags (account_id, name) VALUES (%L, %L)', a_acct, '   '));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN
    failed := array_append(failed, ('a blank tag name was accepted: ' || r)::text);
  END IF;

  -- ---------- 3. the chat's pair ----------
  r := pg_temp.ct_do(format('UPDATE conversations SET chat_tag_id = %L WHERE id = %L', s_adcb, cv_a));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN
    failed := array_append(failed, ('a sub-tag was accepted as the chat''s main tag: ' || r)::text);
  END IF;
  r := pg_temp.ct_do(format(
         'UPDATE conversations SET chat_tag_id = %L, chat_sub_tag_id = %L WHERE id = %L', m_int, s_adcb, cv_a));
  n := n + 1;
  IF r <> 'ok' OR pg_temp.ct_pair(cv_a) <> m_int::text || '/' || s_adcb::text THEN
    failed := array_append(failed, ('a valid main + sub pair was refused: ' || r)::text);
  END IF;
  r := pg_temp.ct_do(format('UPDATE conversations SET chat_sub_tag_id = %L WHERE id = %L', s_not, cv_a));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' OR pg_temp.ct_pair(cv_a) <> m_int::text || '/' || s_adcb::text THEN
    failed := array_append(failed, ('a sub-tag of a different main tag was accepted: ' || r)::text);
  END IF;
  r := pg_temp.ct_do(format(
         'UPDATE conversations SET chat_tag_id = %L, chat_sub_tag_id = %L WHERE id = %L', m_not, s_fab, cv_a));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN
    failed := array_append(failed, ('switching the main tag while naming a foreign sub-tag was accepted: ' || r)::text);
  END IF;
  r := pg_temp.ct_do(format('UPDATE conversations SET chat_sub_tag_id = %L WHERE id = %L', m_new, cv_a));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN
    failed := array_append(failed, ('a main tag was accepted as the chat''s sub-tag: ' || r)::text);
  END IF;
  r := pg_temp.ct_do(format('UPDATE conversations SET chat_tag_id = %L WHERE id = %L', m_not, cv_a));
  n := n + 1;
  IF r <> 'ok' OR pg_temp.ct_pair(cv_a) <> m_not::text || '/null' THEN
    failed := array_append(failed, ('switching the main tag did not drop the old sub-tag: ' || r || ' ' || pg_temp.ct_pair(cv_a))::text);
  END IF;
  UPDATE conversations SET chat_tag_id = m_int, chat_sub_tag_id = s_fab WHERE id = cv_a;
  r := pg_temp.ct_do(format('UPDATE conversations SET chat_tag_id = NULL WHERE id = %L', cv_a));
  n := n + 1;
  IF r <> 'ok' OR pg_temp.ct_pair(cv_a) <> 'null/null' THEN
    failed := array_append(failed, ('clearing the main tag did not clear the sub-tag: ' || r || ' ' || pg_temp.ct_pair(cv_a))::text);
  END IF;
  -- The INSERT path runs the same guard.
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_agent, '971500075003', 'CT contact A2') RETURNING id INTO ct;
  r := pg_temp.ct_do(format(
         'INSERT INTO conversations (account_id, user_id, contact_id, chat_tag_id, chat_sub_tag_id) '
         'VALUES (%L, %L, %L, %L, %L)', a_acct, u_agent, ct, m_int, s_not));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN
    failed := array_append(failed, ('a new chat with a foreign sub-tag was accepted: ' || r)::text);
  END IF;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_agent, '971500075004', 'CT contact A3') RETURNING id INTO ct;
  r := pg_temp.ct_do(format(
         'INSERT INTO conversations (account_id, user_id, contact_id, chat_sub_tag_id) '
         'VALUES (%L, %L, %L, %L)', a_acct, u_agent, ct, s_adcb));
  n := n + 1;
  IF r <> 'ok' OR (SELECT chat_sub_tag_id FROM conversations WHERE contact_id = ct) IS NOT NULL THEN
    failed := array_append(failed, ('a new chat kept a sub-tag with no main tag: ' || r)::text);
  END IF;

  -- ---------- 4. deleting a main tag ----------
  INSERT INTO chat_tags (account_id, name) VALUES (a_acct, 'Doomed') RETURNING id INTO m_tmp;
  INSERT INTO chat_tags (account_id, parent_id, name) VALUES (a_acct, m_tmp, 'Doomed sub') RETURNING id INTO s_tmp;
  UPDATE conversations SET chat_tag_id = m_tmp, chat_sub_tag_id = s_tmp WHERE id = cv_a;
  r := pg_temp.ct_do(format('DELETE FROM chat_tags WHERE id = %L', m_tmp));
  n := n + 1;
  IF r <> 'ok' OR EXISTS (SELECT 1 FROM chat_tags WHERE id IN (m_tmp, s_tmp)) THEN
    failed := array_append(failed, ('deleting a main tag did not delete its sub-tags: ' || r)::text);
  END IF;
  n := n + 1;
  IF pg_temp.ct_pair(cv_a) <> 'null/null'
     OR (SELECT account_id FROM conversations WHERE id = cv_a) IS DISTINCT FROM a_acct THEN
    failed := array_append(failed, format('deleting a main tag left the chat as %s account=%s',
      pg_temp.ct_pair(cv_a), (SELECT account_id FROM conversations WHERE id = cv_a)));
  END IF;
  -- Deleting only a sub-tag keeps the main tag.
  UPDATE conversations SET chat_tag_id = m_int, chat_sub_tag_id = s_fab WHERE id = cv_a;
  r := pg_temp.ct_do(format('DELETE FROM chat_tags WHERE id = %L', s_fab));
  n := n + 1;
  IF r <> 'ok' OR pg_temp.ct_pair(cv_a) <> m_int::text || '/null'
     OR (SELECT account_id FROM conversations WHERE id = cv_a) IS DISTINCT FROM a_acct THEN
    failed := array_append(failed, ('deleting a sub-tag did not just clear the chat''s sub-tag: ' || r || ' ' || pg_temp.ct_pair(cv_a))::text);
  END IF;
  UPDATE conversations SET chat_tag_id = NULL WHERE id = cv_a;

  -- ---------- 5. the account wall ----------
  r := pg_temp.ct_do(format('UPDATE conversations SET chat_tag_id = %L WHERE id = %L', m_new, cv_b));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23503:%' OR pg_temp.ct_pair(cv_b) <> 'null/null' THEN
    failed := array_append(failed, ('account B''s chat referenced account A''s tag: ' || r)::text);
  END IF;
  r := pg_temp.ct_do(format(
         'INSERT INTO chat_tags (account_id, parent_id, name) VALUES (%L, %L, %L)', b_acct, m_int, 'Stolen'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23503:%' THEN
    failed := array_append(failed, ('account B made a sub-tag of account A''s main tag: ' || r)::text);
  END IF;

  -- ---------- 6. RLS ----------
  r := pg_temp.ct_try(u_agent, format('SELECT count(*)::text FROM chat_tags WHERE account_id = %L', a_acct));
  n := n + 1;
  IF r <> (SELECT count(*)::text FROM chat_tags WHERE account_id = a_acct) OR r = '0' THEN
    failed := array_append(failed, ('an agent cannot read the account''s tags: ' || r)::text);
  END IF;
  r := pg_temp.ct_try(u_view, 'SELECT count(*)::text FROM chat_tags');
  n := n + 1;
  IF r <> (SELECT count(*)::text FROM chat_tags WHERE account_id = a_acct) THEN
    failed := array_append(failed, ('a viewer does not see exactly the account''s tags: ' || r)::text);
  END IF;
  r := pg_temp.ct_try(u_other, format('SELECT count(*)::text FROM chat_tags WHERE account_id = %L', a_acct));
  n := n + 1;
  IF r <> '0' THEN
    failed := array_append(failed, ('another account''s member sees account A''s tags: ' || r)::text);
  END IF;

  r := pg_temp.ct_try(u_agent, format(
         'INSERT INTO chat_tags (account_id, name) VALUES (%L, %L)', a_acct, 'Agent made'));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN
    failed := array_append(failed, ('an agent inserted a tag: ' || r)::text);
  END IF;
  r := pg_temp.ct_try(u_agent, format('UPDATE chat_tags SET name = %L WHERE id = %L', 'Agent renamed', m_new));
  n := n + 1;
  IF r <> '0' OR (SELECT name FROM chat_tags WHERE id = m_new) <> 'New customer' THEN
    failed := array_append(failed, ('an agent updated a tag: ' || r)::text);
  END IF;
  r := pg_temp.ct_try(u_agent, format('DELETE FROM chat_tags WHERE id = %L', m_new));
  n := n + 1;
  IF r <> '0' OR NOT EXISTS (SELECT 1 FROM chat_tags WHERE id = m_new) THEN
    failed := array_append(failed, ('an agent deleted a tag: ' || r)::text);
  END IF;

  r := pg_temp.ct_try(u_admin, format(
         'INSERT INTO chat_tags (account_id, name, color) VALUES (%L, %L, %L)', a_acct, 'Admin made', '#ABCDEF'));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('an admin could not insert a tag: ' || r)::text);
  END IF;
  r := pg_temp.ct_try(u_admin, format('UPDATE chat_tags SET name = %L WHERE account_id = %L AND name = %L',
         'Admin renamed', a_acct, 'Admin made'));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('an admin could not update a tag: ' || r)::text);
  END IF;
  r := pg_temp.ct_try(u_admin, format('DELETE FROM chat_tags WHERE account_id = %L AND name = %L',
         a_acct, 'Admin renamed'));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('an admin could not delete a tag: ' || r)::text);
  END IF;
  r := pg_temp.ct_try(u_admin, format(
         'INSERT INTO chat_tags (account_id, name) VALUES (%L, %L)', b_acct, 'Cross account'));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN
    failed := array_append(failed, ('an admin inserted a tag into another account: ' || r)::text);
  END IF;
  r := pg_temp.ct_try(u_other, format('UPDATE chat_tags SET name = %L WHERE id = %L', 'Hijacked', m_new));
  n := n + 1;
  IF r <> '0' OR (SELECT name FROM chat_tags WHERE id = m_new) <> 'New customer' THEN
    failed := array_append(failed, ('another account''s owner updated account A''s tag: ' || r)::text);
  END IF;

  r := pg_temp.ct_try(u_agent, format(
         'UPDATE conversations SET chat_tag_id = %L, chat_sub_tag_id = %L WHERE id = %L', m_int, s_adcb, cv_a));
  n := n + 1;
  IF r <> '1' OR pg_temp.ct_pair(cv_a) <> m_int::text || '/' || s_adcb::text THEN
    failed := array_append(failed, ('an agent could not tag their own chat: ' || r || ' ' || pg_temp.ct_pair(cv_a))::text);
  END IF;
  r := pg_temp.ct_try(u_agent, format('UPDATE conversations SET chat_tag_id = %L WHERE id = %L', m_not, cv_a));
  n := n + 1;
  IF r <> '1' OR pg_temp.ct_pair(cv_a) <> m_not::text || '/null' THEN
    failed := array_append(failed, ('an agent''s main-tag switch did not drop the sub-tag: ' || r || ' ' || pg_temp.ct_pair(cv_a))::text);
  END IF;
  r := pg_temp.ct_try(u_view, format('UPDATE conversations SET chat_tag_id = %L WHERE id = %L', m_new, cv_a));
  n := n + 1;
  IF r LIKE 'ERROR:%' THEN r := '0'; END IF;
  IF r <> '0' OR pg_temp.ct_pair(cv_a) <> m_not::text || '/null' THEN
    failed := array_append(failed, ('a viewer tagged a chat: ' || r || ' ' || pg_temp.ct_pair(cv_a))::text);
  END IF;

  n := n + 1;
  IF has_function_privilege('authenticated', 'public.chat_tags_guard()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.conversations_chat_tag_guard()', 'EXECUTE')
     OR has_table_privilege('anon', 'public.chat_tags', 'SELECT') THEN
    failed := array_append(failed, 'anon / clients hold privileges 075 revoked'::text);
  END IF;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT075', MESSAGE = 'verify-chat-tags rollback';
  EXCEPTION WHEN SQLSTATE 'ZT075' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'chat tags verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'chat tags verification passed (% checks)', n;
END
$verify$;
