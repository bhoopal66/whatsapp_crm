-- Behavioural regression suite for per-person deals and deals from
-- chat tags (migration 080).
--
-- A deal is visible to its owner (the assignee, else the creator),
-- that owner's team leader, and the account's admins. Tagging a chat
-- with the tag an admin linked to a pipeline stage opens a deal there,
-- once per open deal, owned by the right person, and never moves an
-- existing one. The rules live in RLS and triggers, none of which
-- `npm test` can reach.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000080001';
  u_admin  UUID := '00000000-0000-4000-8000-000000080002';
  u_lead   UUID := '00000000-0000-4000-8000-000000080003';
  u_ag1    UUID := '00000000-0000-4000-8000-000000080004';  -- in u_lead's team
  u_ag2    UUID := '00000000-0000-4000-8000-000000080005';  -- in no team
  u_view   UUID := '00000000-0000-4000-8000-000000080006';
  u_other  UUID := '00000000-0000-4000-8000-000000080007';  -- account B owner
  a_acct   UUID;
  b_acct   UUID;
  p_ag1    UUID;  -- profiles.id of u_ag1 (deals.assigned_to is a profile id)
  p_ag2    UUID;
  team     UUID;
  pl       UUID;  -- account A pipeline
  st_open  UUID;  -- first stage, not linked
  st_int   UUID;  -- linked to m_int
  pl_b     UUID;  -- account B pipeline
  m_int    UUID;  -- main: Interested customer (sub-tags s_adcb, s_fab)
  m_new    UUID;  -- main: New customer, linked to nothing
  m_not    UUID;  -- main: Not interested
  s_adcb   UUID;
  s_fab    UUID;
  m_b      UUID;  -- account B's main tag
  ct       UUID;
  ct_seen  UUID;  -- contact u_ag1 created (so can see), deal owned by u_ag2
  cv       UUID;
  d        UUID;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as a signed-in user: the value of a SELECT, the
  -- row count of anything else, or the error.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.pd_try(p_uid uuid, p_sql text)
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

  -- Run a statement as the table owner (no RLS), optionally with a
  -- caller's auth.uid() in scope: 'ok' or the SQLSTATE + error.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.pd_do(p_sql text, p_uid uuid DEFAULT NULL)
    RETURNS text LANGUAGE plpgsql AS $body$
    BEGIN
      IF p_uid IS NOT NULL THEN
        PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
      END IF;
      EXECUTE p_sql;
      PERFORM set_config('request.jwt.claim.sub', '', true);
      PERFORM set_config('request.jwt.claims', '', true);
      RETURN 'ok';
    EXCEPTION WHEN OTHERS THEN
      PERFORM set_config('request.jwt.claim.sub', '', true);
      PERFORM set_config('request.jwt.claims', '', true);
      RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
    END $body$
  $fn$;

  -- A contact's deals as "stage/owner user/assignee profile/status;...".
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.pd_deals(p_contact uuid)
    RETURNS text LANGUAGE sql AS $body$
      SELECT coalesce(string_agg(
               stage_id::text || '/' || user_id::text || '/'
               || coalesce(assigned_to::text, 'null') || '/' || status,
               ';' ORDER BY created_at, id), '')
        FROM public.deals WHERE contact_id = p_contact;
    $body$
  $fn$;

  -- Fixture: account A (owner, admin, leader, two agents, viewer), B.
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'pd-owner@example.invalid'),
    (u_admin, 'pd-admin@example.invalid'),
    (u_lead,  'pd-lead@example.invalid'),
    (u_ag1,   'pd-ag1@example.invalid'),
    (u_ag2,   'pd-ag2@example.invalid'),
    (u_view,  'pd-view@example.invalid'),
    (u_other, 'pd-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  SELECT id INTO b_acct FROM accounts WHERE owner_user_id = u_other;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin'       WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent'       WHERE user_id IN (u_ag1, u_ag2);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer'      WHERE user_id = u_view;
  SELECT id INTO p_ag1 FROM profiles WHERE user_id = u_ag1;
  SELECT id INTO p_ag2 FROM profiles WHERE user_id = u_ag2;
  IF p_ag1 = u_ag1 THEN
    RAISE EXCEPTION 'fixture: profiles.id equals user_id, so the profile/user mapping is untested';
  END IF;
  UPDATE accounts SET default_currency = 'AED' WHERE id = a_acct;

  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'PD Sales', u_lead) RETURNING id INTO team;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (team, u_ag1, a_acct);

  INSERT INTO pipelines (account_id, user_id, name) VALUES (a_acct, u_owner, 'PD Sales') RETURNING id INTO pl;
  INSERT INTO pipeline_stages (pipeline_id, name, position) VALUES (pl, 'New', 0) RETURNING id INTO st_open;
  INSERT INTO pipeline_stages (pipeline_id, name, position) VALUES (pl, 'Interested', 1) RETURNING id INTO st_int;
  INSERT INTO pipelines (account_id, user_id, name) VALUES (b_acct, u_other, 'PD B') RETURNING id INTO pl_b;

  INSERT INTO chat_tags (account_id, name, sub_tag_title) VALUES (a_acct, 'Interested customer', 'Bank') RETURNING id INTO m_int;
  INSERT INTO chat_tags (account_id, name) VALUES (a_acct, 'New customer') RETURNING id INTO m_new;
  INSERT INTO chat_tags (account_id, name) VALUES (a_acct, 'Not interested') RETURNING id INTO m_not;
  INSERT INTO chat_tags (account_id, parent_id, name) VALUES (a_acct, m_int, 'ADCB') RETURNING id INTO s_adcb;
  INSERT INTO chat_tags (account_id, parent_id, name) VALUES (a_acct, m_int, 'FAB') RETURNING id INTO s_fab;
  INSERT INTO chat_tags (account_id, name) VALUES (b_acct, 'Interested customer') RETURNING id INTO m_b;

  -- Deals with known owners. Titles name them for the visibility checks.
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_ag1, '971500080001', 'PD seen by ag1') RETURNING id INTO ct_seen;
  INSERT INTO deals (account_id, user_id, pipeline_id, stage_id, contact_id, title, assigned_to) VALUES
    (a_acct, u_admin, pl, st_open, ct_seen, 'ag1-assigned', p_ag1),
    (a_acct, u_ag1,   pl, st_open, ct_seen, 'ag1-created',  NULL),
    (a_acct, u_ag2,   pl, st_open, ct_seen, 'ag2',          NULL),
    (a_acct, u_admin, pl, st_open, ct_seen, 'ag2-assigned', p_ag2),
    (a_acct, u_lead,  pl, st_open, ct_seen, 'lead',         NULL),
    (a_acct, u_admin, pl, st_open, ct_seen, 'admin',        NULL);
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (b_acct, u_other, '971500080009', 'PD B contact') RETURNING id INTO ct;
  INSERT INTO pipeline_stages (pipeline_id, name) VALUES (pl_b, 'B stage') RETURNING id INTO d;
  INSERT INTO deals (account_id, user_id, pipeline_id, stage_id, contact_id, title)
  VALUES (b_acct, u_other, pl_b, d, ct, 'other-account');

  -- ---------- 1. who sees which deal ----------
  r := pg_temp.pd_try(u_admin, 'SELECT string_agg(title, '','' ORDER BY title) FROM deals');
  n := n + 1;
  IF r <> 'admin,ag1-assigned,ag1-created,ag2,ag2-assigned,lead' THEN
    failed := array_append(failed, ('admin does not see exactly every deal of the account: ' || r)::text);
  END IF;
  r := pg_temp.pd_try(u_ag1, 'SELECT string_agg(title, '','' ORDER BY title) FROM deals');
  n := n + 1;
  IF r <> 'ag1-assigned,ag1-created' THEN
    failed := array_append(failed, ('agent does not see exactly own deals (assigned + created-unassigned): ' || r)::text);
  END IF;
  r := pg_temp.pd_try(u_ag1, 'SELECT count(*)::text FROM deals WHERE title = ''ag2''');
  n := n + 1;
  IF r <> '0' THEN
    failed := array_append(failed, ('agent sees another agent''s deal on a contact the agent can see: ' || r)::text);
  END IF;
  r := pg_temp.pd_try(u_lead, 'SELECT string_agg(title, '','' ORDER BY title) FROM deals');
  n := n + 1;
  IF r <> 'ag1-assigned,ag1-created,lead' THEN
    failed := array_append(failed, ('leader does not see exactly own + teammate''s deals (no non-teammate''s): ' || r)::text);
  END IF;
  r := pg_temp.pd_try(u_view, 'SELECT count(*)::text FROM deals');
  n := n + 1;
  IF r <> '0' THEN
    failed := array_append(failed, ('viewer sees other people''s deals: ' || r)::text);
  END IF;
  r := pg_temp.pd_try(u_other, format('SELECT count(*)::text FROM deals WHERE account_id = %L', a_acct));
  n := n + 1;
  IF r <> '0' THEN
    failed := array_append(failed, ('another account sees account A''s deals: ' || r)::text);
  END IF;
  r := pg_temp.pd_try(u_ag1, format('SELECT count(*)::text FROM deals WHERE account_id = %L', b_acct));
  n := n + 1;
  IF r <> '0' THEN
    failed := array_append(failed, ('account A''s agent sees account B''s deals: ' || r)::text);
  END IF;

  -- ---------- 2. who may write which deal ----------
  r := pg_temp.pd_try(u_ag1, format(
         'INSERT INTO deals (account_id, user_id, pipeline_id, stage_id, contact_id, title, assigned_to) '
         'VALUES (%L, %L, %L, %L, %L, %L, %L)', a_acct, u_ag1, pl, st_open, ct_seen, 'ag1 for ag2', p_ag2));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN
    failed := array_append(failed, ('agent inserted a deal assigned to another agent: ' || r)::text);
  END IF;
  r := pg_temp.pd_try(u_ag1, format(
         'INSERT INTO deals (account_id, user_id, pipeline_id, stage_id, contact_id, title) '
         'VALUES (%L, %L, %L, %L, %L, %L)', a_acct, u_ag2, pl, st_open, ct_seen, 'ag1 as ag2'));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN
    failed := array_append(failed, ('agent inserted an unassigned deal created as another agent: ' || r)::text);
  END IF;
  r := pg_temp.pd_try(u_ag1, format(
         'INSERT INTO deals (account_id, user_id, pipeline_id, stage_id, contact_id, title, assigned_to) '
         'VALUES (%L, %L, %L, %L, %L, %L, %L)', a_acct, u_ag1, pl, st_open, ct_seen, 'ag1 own', p_ag1));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('agent could not insert a deal of their own: ' || r)::text);
  END IF;
  r := pg_temp.pd_try(u_ag1, format('UPDATE deals SET assigned_to = %L WHERE title = %L', p_ag2, 'ag1-created'));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' OR (SELECT assigned_to FROM deals WHERE title = 'ag1-created') IS NOT NULL THEN
    failed := array_append(failed, ('agent handed their deal to another agent: ' || r)::text);
  END IF;
  r := pg_temp.pd_try(u_ag1, format('UPDATE deals SET value = 5 WHERE title = %L', 'ag1-created'));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('agent could not update their own deal: ' || r)::text);
  END IF;
  r := pg_temp.pd_try(u_ag1, format('UPDATE deals SET value = 5 WHERE title = %L', 'ag2'));
  n := n + 1;
  IF r <> '0' THEN
    failed := array_append(failed, ('agent updated another agent''s deal: ' || r)::text);
  END IF;
  r := pg_temp.pd_try(u_ag1, format('DELETE FROM deals WHERE title = %L', 'ag2'));
  n := n + 1;
  IF r <> '0' OR NOT EXISTS (SELECT 1 FROM deals WHERE title = 'ag2') THEN
    failed := array_append(failed, ('agent deleted another agent''s deal: ' || r)::text);
  END IF;
  r := pg_temp.pd_try(u_view, format(
         'INSERT INTO deals (account_id, user_id, pipeline_id, stage_id, contact_id, title) '
         'VALUES (%L, %L, %L, %L, %L, %L)', a_acct, u_view, pl, st_open, ct_seen, 'viewer own'));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN
    failed := array_append(failed, ('viewer inserted a deal: ' || r)::text);
  END IF;
  r := pg_temp.pd_try(u_lead, format('UPDATE deals SET assigned_to = %L WHERE title = %L', p_ag1, 'lead'));
  n := n + 1;
  IF r <> '1' OR (SELECT assigned_to FROM deals WHERE title = 'lead') IS DISTINCT FROM p_ag1 THEN
    failed := array_append(failed, ('leader could not assign their deal to a teammate: ' || r)::text);
  END IF;
  r := pg_temp.pd_try(u_lead, format('UPDATE deals SET assigned_to = %L WHERE title = %L', p_ag2, 'ag1-created'));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN
    failed := array_append(failed, ('leader handed a teammate''s deal to a non-teammate: ' || r)::text);
  END IF;
  r := pg_temp.pd_try(u_lead, format('UPDATE deals SET value = 7 WHERE title = %L', 'ag2'));
  n := n + 1;
  IF r <> '0' THEN
    failed := array_append(failed, ('leader updated a non-teammate''s deal: ' || r)::text);
  END IF;
  r := pg_temp.pd_try(u_admin, format('UPDATE deals SET assigned_to = %L WHERE title = %L', p_ag1, 'ag2'));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('admin could not reassign a deal: ' || r)::text);
  END IF;
  r := pg_temp.pd_try(u_admin, format(
         'INSERT INTO deals (account_id, user_id, pipeline_id, stage_id, contact_id, title, assigned_to) '
         'VALUES (%L, %L, %L, %L, %L, %L, %L)', a_acct, u_admin, pl, st_open, ct_seen, 'admin for ag2', p_ag2));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('admin could not create a deal for an agent: ' || r)::text);
  END IF;
  r := pg_temp.pd_try(u_admin, format('DELETE FROM deals WHERE title = %L', 'admin for ag2'));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('admin could not delete an agent''s deal: ' || r)::text);
  END IF;
  r := pg_temp.pd_try(u_admin, format(
         'INSERT INTO deals (account_id, user_id, pipeline_id, stage_id, contact_id, title) '
         'VALUES (%L, %L, %L, %L, %L, %L)', b_acct, u_admin, pl_b, d, ct, 'cross account'));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN
    failed := array_append(failed, ('admin inserted a deal into another account: ' || r)::text);
  END IF;

  -- ---------- 3. linking a stage to a tag ----------
  r := pg_temp.pd_do(format('UPDATE pipeline_stages SET auto_chat_tag_id = %L WHERE id = %L', s_adcb, st_open));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN
    failed := array_append(failed, ('a stage was linked to a sub-tag: ' || r)::text);
  END IF;
  r := pg_temp.pd_do(format('UPDATE pipeline_stages SET auto_chat_tag_id = %L WHERE id = %L', m_b, st_open));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN
    failed := array_append(failed, ('a stage was linked to another account''s tag: ' || r)::text);
  END IF;
  r := pg_temp.pd_do(format(
         'INSERT INTO pipeline_stages (pipeline_id, name, auto_chat_tag_id) VALUES (%L, %L, %L)', pl, 'Foreign', m_b));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN
    failed := array_append(failed, ('a new stage was linked to another account''s tag: ' || r)::text);
  END IF;
  r := pg_temp.pd_try(u_ag1, format('UPDATE pipeline_stages SET auto_chat_tag_id = %L WHERE id = %L', m_int, st_int));
  n := n + 1;
  IF r <> '0' OR (SELECT auto_chat_tag_id FROM pipeline_stages WHERE id = st_int) IS NOT NULL THEN
    failed := array_append(failed, ('an agent linked a stage to a tag: ' || r)::text);
  END IF;
  r := pg_temp.pd_try(u_admin, format('UPDATE pipeline_stages SET auto_chat_tag_id = %L WHERE id = %L', m_int, st_int));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('an admin could not link a stage to a main tag: ' || r)::text);
  END IF;
  r := pg_temp.pd_do(format('UPDATE pipeline_stages SET auto_chat_tag_id = %L WHERE id = %L', m_int, st_open));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23505:%' THEN
    failed := array_append(failed, ('two stages of one pipeline were linked to the same tag: ' || r)::text);
  END IF;

  -- ---------- 4. tagging a chat opens a deal ----------
  -- (a) the chat's assignee owns it; inbound chat, admin tags.
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_owner, '971500080011', 'PD case a') RETURNING id INTO ct;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, ct, u_ag2) RETURNING id INTO cv;
  r := pg_temp.pd_try(u_admin, format('UPDATE conversations SET chat_tag_id = %L WHERE id = %L', m_int, cv));
  n := n + 1;
  IF r <> '1' OR pg_temp.pd_deals(ct) <> format('%s/%s/%s/open', st_int, u_ag2, p_ag2)
     OR NOT EXISTS (SELECT 1 FROM deals WHERE contact_id = ct AND conversation_id = cv
                      AND title = 'PD case a' AND currency = 'AED' AND value = 0 AND account_id = a_acct) THEN
    failed := array_append(failed, ('(a) assigned chat: not one deal in the linked stage owned by the assignee: '
      || r || ' ' || pg_temp.pd_deals(ct))::text);
  END IF;

  -- (b) an agent started the chat and tags it themselves, sub-tag included.
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_ag1, '971500080012', '  ') RETURNING id INTO ct;
  INSERT INTO conversations (account_id, user_id, contact_id)
  VALUES (a_acct, u_ag1, ct) RETURNING id INTO cv;
  r := pg_temp.pd_try(u_ag1, format(
         'UPDATE conversations SET chat_tag_id = %L, chat_sub_tag_id = %L WHERE id = %L', m_int, s_fab, cv));
  n := n + 1;
  IF r <> '1' OR pg_temp.pd_deals(ct) <> format('%s/%s/%s/open', st_int, u_ag1, p_ag1)
     OR (SELECT title FROM deals WHERE contact_id = ct) IS DISTINCT FROM '971500080012' THEN
    failed := array_append(failed, ('(b) agent-started chat: not one deal owned by the agent, titled by phone: '
      || r || ' ' || pg_temp.pd_deals(ct))::text);
  END IF;
  r := pg_temp.pd_try(u_ag1, format('SELECT count(*)::text FROM deals WHERE contact_id = %L', ct));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('(b) the agent cannot see the deal their tag opened: ' || r)::text);
  END IF;

  -- Re-tagging never moves the deal and never duplicates an open one.
  UPDATE deals SET stage_id = st_open WHERE contact_id = ct;
  r := pg_temp.pd_try(u_ag1, format('UPDATE conversations SET chat_tag_id = %L WHERE id = %L', m_not, cv));
  r := r || ',' || pg_temp.pd_try(u_ag1, format('UPDATE conversations SET chat_tag_id = %L WHERE id = %L', m_int, cv));
  n := n + 1;
  IF r <> '1,1' OR pg_temp.pd_deals(ct) <> format('%s/%s/%s/open', st_open, u_ag1, p_ag1) THEN
    failed := array_append(failed, ('re-tag away and back with an open deal duplicated or moved it: '
      || r || ' ' || pg_temp.pd_deals(ct))::text);
  END IF;
  -- A sub-tag change alone never opens one, even with no open deal.
  UPDATE deals SET status = 'lost' WHERE contact_id = ct;
  r := pg_temp.pd_try(u_ag1, format('UPDATE conversations SET chat_sub_tag_id = %L WHERE id = %L', s_adcb, cv));
  n := n + 1;
  IF r <> '1' OR pg_temp.pd_deals(ct) <> format('%s/%s/%s/lost', st_open, u_ag1, p_ag1) THEN
    failed := array_append(failed, ('a sub-tag change alone opened a deal: ' || r || ' ' || pg_temp.pd_deals(ct))::text);
  END IF;
  -- Once the deal is lost, coming back to the tag opens a new one.
  r := pg_temp.pd_try(u_ag1, format('UPDATE conversations SET chat_tag_id = %L WHERE id = %L', m_not, cv));
  r := r || ',' || pg_temp.pd_try(u_ag1, format('UPDATE conversations SET chat_tag_id = %L WHERE id = %L', m_int, cv));
  n := n + 1;
  IF r <> '1,1' OR pg_temp.pd_deals(ct) <> format('%s/%s/%s/lost;%s/%s/%s/open',
       st_open, u_ag1, p_ag1, st_int, u_ag1, p_ag1) THEN
    failed := array_append(failed, ('re-tag after the deal was lost did not open exactly one new deal: '
      || r || ' ' || pg_temp.pd_deals(ct))::text);
  END IF;

  -- (c) inbound chat (stamped with the owner), admin tags: the admin owns it.
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_owner, '971500080013', 'PD case c') RETURNING id INTO ct;
  INSERT INTO conversations (account_id, user_id, contact_id)
  VALUES (a_acct, u_owner, ct) RETURNING id INTO cv;
  r := pg_temp.pd_try(u_admin, format('UPDATE conversations SET chat_tag_id = %L WHERE id = %L', m_int, cv));
  n := n + 1;
  IF r <> '1' OR pg_temp.pd_deals(ct) <> format('%s/%s/%s/open', st_int, u_admin,
       (SELECT id FROM profiles WHERE user_id = u_admin)) THEN
    failed := array_append(failed, ('(c) inbound chat tagged by an admin: not owned by the tagger: '
      || r || ' ' || pg_temp.pd_deals(ct))::text);
  END IF;

  -- (c) inbound chat, an agent tags it: the agent, not the account owner.
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_owner, '971500080014', 'PD case c agent') RETURNING id INTO ct;
  INSERT INTO conversations (account_id, user_id, contact_id)
  VALUES (a_acct, u_owner, ct) RETURNING id INTO cv;
  r := pg_temp.pd_do(format('UPDATE conversations SET chat_tag_id = %L WHERE id = %L', m_int, cv), u_ag2);
  n := n + 1;
  IF r <> 'ok' OR pg_temp.pd_deals(ct) <> format('%s/%s/%s/open', st_int, u_ag2, p_ag2) THEN
    failed := array_append(failed, ('(c) inbound chat tagged by an agent: not owned by that agent: '
      || r || ' ' || pg_temp.pd_deals(ct))::text);
  END IF;

  -- (d) inbound chat, tagged by a bot (no caller): the chat's owner.
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_owner, '971500080015', 'PD case d') RETURNING id INTO ct;
  INSERT INTO conversations (account_id, user_id, contact_id)
  VALUES (a_acct, u_owner, ct) RETURNING id INTO cv;
  r := pg_temp.pd_do(format('UPDATE conversations SET chat_tag_id = %L WHERE id = %L', m_int, cv));
  n := n + 1;
  IF r <> 'ok' OR pg_temp.pd_deals(ct) <> format('%s/%s/%s/open', st_int, u_owner,
       (SELECT id FROM profiles WHERE user_id = u_owner)) THEN
    failed := array_append(failed, ('(d) bot-tagged inbound chat: not owned by the chat''s owner: '
      || r || ' ' || pg_temp.pd_deals(ct))::text);
  END IF;

  -- A tag no stage is linked to opens nothing.
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_ag1, '971500080016', 'PD unlinked') RETURNING id INTO ct;
  INSERT INTO conversations (account_id, user_id, contact_id)
  VALUES (a_acct, u_ag1, ct) RETURNING id INTO cv;
  r := pg_temp.pd_try(u_ag1, format('UPDATE conversations SET chat_tag_id = %L WHERE id = %L', m_new, cv));
  n := n + 1;
  IF r <> '1' OR pg_temp.pd_deals(ct) <> '' THEN
    failed := array_append(failed, ('a tag linked to no stage opened a deal: ' || r || ' ' || pg_temp.pd_deals(ct))::text);
  END IF;

  n := n + 1;
  IF has_function_privilege('authenticated', 'public.create_deals_for_chat_tag()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pipeline_stages_auto_tag_guard()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.can_view_deal(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.deal_owner(uuid, uuid)', 'EXECUTE') THEN
    failed := array_append(failed, 'anon / clients hold privileges 080 revoked'::text);
  END IF;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT080', MESSAGE = 'verify-pipeline-deals rollback';
  EXCEPTION WHEN SQLSTATE 'ZT080' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'pipeline deals verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'pipeline deals verification passed (% checks)', n;
END
$verify$;
