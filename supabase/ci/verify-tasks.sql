-- Behavioural regression suite for tasks (migration 085).
--
-- Who sees a task is RLS (tasks_select): admins and owners every task
-- of the account; the assignee and the creator; anyone who can see its
-- contact; a team leader their team's. tasks_guard holds for every
-- writer, the service role included: the contact belongs to the
-- task's account, the assignee is an active staff member of it, the
-- identity columns never change, and completed_at / completed_by are
-- stamped by the status. This asserts those rules, the dedupe of
-- system tasks on (account_id, source, source_ref), the assignment
-- bell, the notification kinds 085 adds, that deleting a login only
-- nulls its references, the realtime publication and anon's grants.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000085001';
  u_admin  UUID := '00000000-0000-4000-8000-000000085002';
  u_lead   UUID := '00000000-0000-4000-8000-000000085003';
  u_agent  UUID := '00000000-0000-4000-8000-000000085004';
  u_agent2 UUID := '00000000-0000-4000-8000-000000085005';
  u_viewer UUID := '00000000-0000-4000-8000-000000085006';
  u_gone   UUID := '00000000-0000-4000-8000-000000085007';
  u_temp   UUID := '00000000-0000-4000-8000-000000085008';
  u_other  UUID := '00000000-0000-4000-8000-000000085009';
  a_acct   UUID;
  b_acct   UUID;
  team     UUID;
  c_agent  UUID;   -- the agent's own contact
  c_agent2 UUID;   -- the other agent's contact: the agent cannot see it
  c_b      UUID;   -- account B's contact
  t_assigned UUID; -- assigned to the agent, on a contact they cannot see
  t_created  UUID; -- created by the agent, held by the other agent
  t_contact  UUID; -- someone else's, on the agent's contact
  t_hidden   UUID; -- the other agent's own, on their own contact
  t_system   UUID; -- a module's: no creator, no assignee, no contact
  t_gone     UUID; -- assigned to a member deactivated afterwards
  t_reassign UUID;
  t_temp     UUID;
  kind_name  TEXT;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (a signed-in user when p_uid is given):
  -- a SELECT's value, 'ok', or the error as 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.tk_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', p_role)::text, true);
        EXECUTE format('SET LOCAL ROLE %I', p_role);
        IF p_sql ILIKE 'select%' THEN
          EXECUTE p_sql INTO v;
        ELSE
          EXECUTE p_sql;
        END IF;
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

  -- Fixture: account A (owner, admin, team leader, two agents, a
  -- viewer, an agent deactivated below, an agent whose login is
  -- deleted below), account B (owner).
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'tk-owner@example.invalid'),
    (u_admin,  'tk-admin@example.invalid'),
    (u_lead,   'tk-lead@example.invalid'),
    (u_agent,  'tk-agent@example.invalid'),
    (u_agent2, 'tk-agent2@example.invalid'),
    (u_viewer, 'tk-viewer@example.invalid'),
    (u_gone,   'tk-gone@example.invalid'),
    (u_temp,   'tk-temp@example.invalid'),
    (u_other,  'tk-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_other;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent'
   WHERE user_id IN (u_agent, u_agent2, u_gone, u_temp);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_viewer;
  -- The leader leads the agent, not the other agent.
  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'TK Team', u_lead) RETURNING id INTO team;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (team, u_agent, a_acct);

  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_agent, '971500085001', 'TK agent contact') RETURNING id INTO c_agent;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_agent2, '971500085002', 'TK agent2 contact') RETURNING id INTO c_agent2;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (b_acct, u_other, '971500085003', 'TK B contact') RETURNING id INTO c_b;

  INSERT INTO tasks (account_id, kind, title, contact_id, assigned_to, created_by)
  VALUES (a_acct, 'manual', 'TK assigned', c_agent2, u_agent, u_admin) RETURNING id INTO t_assigned;
  INSERT INTO tasks (account_id, kind, title, contact_id, assigned_to, created_by)
  VALUES (a_acct, 'manual', 'TK created', NULL, u_agent2, u_agent) RETURNING id INTO t_created;
  INSERT INTO tasks (account_id, kind, title, contact_id, assigned_to, created_by)
  VALUES (a_acct, 'callback', 'TK contact', c_agent, u_agent2, u_admin) RETURNING id INTO t_contact;
  INSERT INTO tasks (account_id, kind, title, contact_id, assigned_to, created_by)
  VALUES (a_acct, 'follow_up', 'TK hidden', c_agent2, u_agent2, u_agent2) RETURNING id INTO t_hidden;
  INSERT INTO tasks (account_id, kind, title, source, source_ref)
  VALUES (a_acct, 'missed_call', 'TK system', 'pbx', 'tk-call-0') RETURNING id INTO t_system;
  INSERT INTO tasks (account_id, kind, title, assigned_to, created_by)
  VALUES (a_acct, 'manual', 'TK gone', u_gone, u_admin) RETURNING id INTO t_gone;
  INSERT INTO tasks (account_id, kind, title, assigned_to, created_by)
  VALUES (a_acct, 'manual', 'TK reassign', u_admin, u_admin) RETURNING id INTO t_reassign;
  -- Deactivated after the task was assigned to them.
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_gone;

  -- ---------- who sees a task ----------
  r := pg_temp.tk_try('authenticated', u_agent, format('SELECT count(*)::text FROM tasks WHERE id = %L', t_assigned));
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, ('agent sees a task assigned to them: ' || r)::text); END IF;
  r := pg_temp.tk_try('authenticated', u_agent, format('SELECT count(*)::text FROM tasks WHERE id = %L', t_created));
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, ('agent sees a task they created: ' || r)::text); END IF;
  r := pg_temp.tk_try('authenticated', u_agent, format('SELECT count(*)::text FROM tasks WHERE id = %L', t_contact));
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, ('agent sees a task on a contact they can see: ' || r)::text); END IF;
  r := pg_temp.tk_try('authenticated', u_agent, format('SELECT count(*)::text FROM tasks WHERE id IN (%L, %L)', t_hidden, t_system));
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, ('agent sees another agent''s task on a contact they cannot see, or an unassigned one: ' || r)::text); END IF;
  r := pg_temp.tk_try('authenticated', u_lead, format('SELECT count(*)::text FROM tasks WHERE id = %L', t_assigned));
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, ('leader sees a teammate''s task: ' || r)::text); END IF;
  r := pg_temp.tk_try('authenticated', u_lead, format('SELECT count(*)::text FROM tasks WHERE id = %L', t_hidden));
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, ('leader sees a task outside their team: ' || r)::text); END IF;
  r := pg_temp.tk_try('authenticated', u_admin, 'SELECT count(*)::text FROM tasks');
  n := n + 1;
  IF r IS DISTINCT FROM (SELECT count(*)::text FROM tasks WHERE account_id = a_acct) THEN
    failed := array_append(failed, ('admin sees every task of the account: ' || r)::text);
  END IF;
  r := pg_temp.tk_try('authenticated', u_other, format('SELECT count(*)::text FROM tasks WHERE account_id = %L', a_acct));
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, ('another account sees A''s tasks: ' || r)::text); END IF;

  -- ---------- inserting ----------
  r := pg_temp.tk_try('authenticated', u_agent, format(
    'INSERT INTO tasks (account_id, kind, title, contact_id, assigned_to, created_by) VALUES (%L, %L, %L, %L, %L, %L)',
    a_acct, 'callback', 'TK self-assigned', c_agent, u_agent, u_agent));
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('agent creates a task on their contact: ' || r)::text); END IF;
  r := pg_temp.tk_try('authenticated', u_viewer, format(
    'INSERT INTO tasks (account_id, kind, title, created_by) VALUES (%L, %L, %L, %L)',
    a_acct, 'manual', 'TK viewer', u_viewer));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN failed := array_append(failed, ('viewer inserted a task: ' || r)::text); END IF;
  r := pg_temp.tk_try('authenticated', u_agent, format(
    'INSERT INTO tasks (account_id, kind, title, source, source_ref, created_by) VALUES (%L, %L, %L, %L, %L, %L)',
    a_acct, 'missed_call', 'TK forged system task', 'pbx', 'tk-forged', u_agent));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN failed := array_append(failed, ('agent wrote a system-source task: ' || r)::text); END IF;
  r := pg_temp.tk_try('authenticated', u_admin, format(
    'INSERT INTO tasks (account_id, kind, title, contact_id, created_by) VALUES (%L, %L, %L, %L, %L)',
    a_acct, 'manual', 'TK cross contact', c_b, u_admin));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('admin linked another account''s contact: ' || r)::text); END IF;
  r := pg_temp.tk_try('service_role', NULL, format(
    'INSERT INTO tasks (account_id, kind, title, contact_id, source, source_ref) VALUES (%L, %L, %L, %L, %L, %L)',
    a_acct, 'missed_call', 'TK cross contact', c_b, 'pbx', 'tk-cross'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('service role linked another account''s contact: ' || r)::text); END IF;

  -- ---------- who can hold a task ----------
  r := pg_temp.tk_try('authenticated', u_admin, format(
    'INSERT INTO tasks (account_id, kind, title, assigned_to, created_by) VALUES (%L, %L, %L, %L, %L)',
    a_acct, 'manual', 'TK non-member', u_other, u_admin));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('assigned to a non-member: ' || r)::text); END IF;
  r := pg_temp.tk_try('authenticated', u_admin, format(
    'INSERT INTO tasks (account_id, kind, title, assigned_to, created_by) VALUES (%L, %L, %L, %L, %L)',
    a_acct, 'manual', 'TK deactivated', u_gone, u_admin));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('assigned to a deactivated member: ' || r)::text); END IF;
  r := pg_temp.tk_try('service_role', NULL, format(
    'INSERT INTO tasks (account_id, kind, title, assigned_to, source, source_ref) VALUES (%L, %L, %L, %L, %L, %L)',
    a_acct, 'missed_call', 'TK deactivated', u_gone, 'pbx', 'tk-gone'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('service role assigned to a deactivated member: ' || r)::text); END IF;
  r := pg_temp.tk_try('authenticated', u_admin, format(
    'INSERT INTO tasks (account_id, kind, title, assigned_to, created_by) VALUES (%L, %L, %L, %L, %L)',
    a_acct, 'manual', 'TK viewer assignee', u_viewer, u_admin));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('assigned to a viewer: ' || r)::text); END IF;
  r := pg_temp.tk_try('authenticated', u_admin, format(
    'UPDATE tasks SET assigned_to = %L WHERE id = %L', u_other, t_reassign));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('reassigned to a non-member: ' || r)::text); END IF;
  -- A task whose assignee was deactivated later stays workable.
  r := pg_temp.tk_try('authenticated', u_admin, format(
    'UPDATE tasks SET title = %L, status = %L WHERE id = %L', 'TK gone, handled', 'done', t_gone));
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('a deactivated assignee''s task is not editable: ' || r)::text); END IF;

  -- ---------- system tasks dedupe on (account_id, source, source_ref) ----------
  r := pg_temp.tk_try('service_role', NULL, format(
    'INSERT INTO tasks (account_id, kind, title, source, source_ref) VALUES (%L, %L, %L, %L, %L)',
    a_acct, 'missed_call', 'TK missed call', 'pbx', 'tk-call-1'));
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('service role system task: ' || r)::text); END IF;
  r := pg_temp.tk_try('service_role', NULL, format(
    'INSERT INTO tasks (account_id, kind, title, source, source_ref) VALUES (%L, %L, %L, %L, %L)',
    a_acct, 'missed_call', 'TK missed call again', 'pbx', 'tk-call-1'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23505:%' THEN failed := array_append(failed, ('a second task for the same source_ref: ' || r)::text); END IF;
  r := pg_temp.tk_try('service_role', NULL, format(
    'INSERT INTO tasks (account_id, kind, title, source, source_ref) VALUES (%L, %L, %L, %L, %L) ON CONFLICT (account_id, source, source_ref) DO NOTHING',
    a_acct, 'missed_call', 'TK missed call redelivered', 'pbx', 'tk-call-1'));
  n := n + 1;
  IF r <> 'ok' OR (SELECT count(*) FROM tasks WHERE account_id = a_acct AND source_ref = 'tk-call-1') <> 1 THEN
    failed := array_append(failed, ('a redelivery ON CONFLICT DO NOTHING: ' || r)::text);
  END IF;
  r := pg_temp.tk_try('service_role', NULL, format(
    'INSERT INTO tasks (account_id, kind, title, source, source_ref) VALUES (%L, %L, %L, %L, %L)',
    b_acct, 'missed_call', 'TK missed call in B', 'pbx', 'tk-call-1'));
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('the same source_ref in another account: ' || r)::text); END IF;

  -- ---------- completion is stamped by the status ----------
  r := pg_temp.tk_try('authenticated', u_agent, format('UPDATE tasks SET status = %L WHERE id = %L', 'done', t_created));
  n := n + 1;
  IF r <> 'ok' OR NOT EXISTS (SELECT 1 FROM tasks WHERE id = t_created
       AND completed_at IS NOT NULL AND completed_by = u_agent) THEN
    failed := array_append(failed, ('done stamps completed_at / completed_by: ' || r)::text);
  END IF;
  r := pg_temp.tk_try('authenticated', u_agent, format('UPDATE tasks SET status = %L WHERE id = %L', 'open', t_created));
  n := n + 1;
  IF r <> 'ok' OR NOT EXISTS (SELECT 1 FROM tasks WHERE id = t_created
       AND completed_at IS NULL AND completed_by IS NULL) THEN
    failed := array_append(failed, ('reopening clears completed_at / completed_by: ' || r)::text);
  END IF;
  r := pg_temp.tk_try('authenticated', u_agent, format(
    'UPDATE tasks SET completed_at = now(), completed_by = %L WHERE id = %L', u_admin, t_created));
  n := n + 1;
  IF r <> 'ok' OR NOT EXISTS (SELECT 1 FROM tasks WHERE id = t_created
       AND completed_at IS NULL AND completed_by IS NULL) THEN
    failed := array_append(failed, ('completed_at / completed_by written without a status change: ' || r)::text);
  END IF;

  -- ---------- identity columns never change ----------
  -- On the service role, which bypasses RLS: only the trigger refuses.
  r := pg_temp.tk_try('service_role', NULL, format('UPDATE tasks SET account_id = %L WHERE id = %L', b_acct, t_system));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('account_id changed: ' || r)::text); END IF;
  r := pg_temp.tk_try('service_role', NULL, format('UPDATE tasks SET kind = %L WHERE id = %L', 'callback', t_system));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('kind changed: ' || r)::text); END IF;
  r := pg_temp.tk_try('service_role', NULL, format('UPDATE tasks SET source = %L WHERE id = %L', 'journey', t_system));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('source changed: ' || r)::text); END IF;
  r := pg_temp.tk_try('service_role', NULL, format('UPDATE tasks SET source_ref = %L WHERE id = %L', 'tk-call-9', t_system));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('source_ref changed: ' || r)::text); END IF;
  r := pg_temp.tk_try('service_role', NULL, format('UPDATE tasks SET created_by = %L WHERE id = %L', u_admin, t_created));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('created_by changed by the service role: ' || r)::text); END IF;
  -- An admin passes tasks_update's check, so this is the trigger too.
  r := pg_temp.tk_try('authenticated', u_admin, format('UPDATE tasks SET created_by = %L WHERE id = %L', u_admin, t_created));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('created_by changed by an admin: ' || r)::text); END IF;
  -- A screen writing the whole row back, identity unchanged.
  r := pg_temp.tk_try('authenticated', u_agent, format(
    'UPDATE tasks SET account_id = account_id, kind = kind, source = source, source_ref = source_ref, created_by = created_by, title = %L WHERE id = %L',
    'TK created, renamed', t_created));
  n := n + 1;
  IF r <> 'ok' OR (SELECT title FROM tasks WHERE id = t_created) <> 'TK created, renamed' THEN
    failed := array_append(failed, ('whole-row write-back with the same identity: ' || r)::text);
  END IF;

  -- ---------- the assignment bell ----------
  r := pg_temp.tk_try('authenticated', u_agent, format(
    'INSERT INTO tasks (account_id, kind, title, assigned_to, created_by, due_at) VALUES (%L, %L, %L, %L, %L, %L)',
    a_acct, 'callback', 'TK for agent2', u_agent2, u_agent, '2026-10-12 09:00:00+00'));
  n := n + 1;
  IF r <> 'ok' OR NOT EXISTS (SELECT 1 FROM notifications WHERE user_id = u_agent2 AND account_id = a_acct
       AND type = 'task_assigned' AND title = 'TK for agent2' AND actor_user_id = u_agent
       AND body = 'Due 12 Oct 2026 09:00 UTC') THEN
    failed := array_append(failed, ('assigning someone else rings their bell: ' || r)::text);
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM notifications WHERE title = 'TK self-assigned') THEN
    failed := array_append(failed, 'assigning yourself rang a bell'::text);
  END IF;
  r := pg_temp.tk_try('authenticated', u_admin, format('UPDATE tasks SET assigned_to = %L WHERE id = %L', u_agent, t_reassign));
  n := n + 1;
  IF r <> 'ok' OR NOT EXISTS (SELECT 1 FROM notifications WHERE user_id = u_agent
       AND type = 'task_assigned' AND title = 'TK reassign' AND actor_user_id = u_admin) THEN
    failed := array_append(failed, ('reassigning rings the new assignee''s bell: ' || r)::text);
  END IF;
  r := pg_temp.tk_try('service_role', NULL, format(
    'INSERT INTO tasks (account_id, kind, title, assigned_to, source, source_ref) VALUES (%L, %L, %L, %L, %L, %L)',
    a_acct, 'journey', 'TK journey step', u_agent2, 'journey', 'tk-step-1'));
  n := n + 1;
  IF r <> 'ok' OR NOT EXISTS (SELECT 1 FROM notifications WHERE user_id = u_agent2
       AND type = 'task_assigned' AND title = 'TK journey step' AND actor_user_id IS NULL) THEN
    failed := array_append(failed, ('a service-role assignment rings the bell: ' || r)::text);
  END IF;

  -- A PBX task's insert is silent (the processor's call_missed bell
  -- carries the call, 089); reassigning it later still rings.
  r := pg_temp.tk_try('service_role', NULL, format(
    'INSERT INTO tasks (account_id, kind, title, assigned_to, source, source_ref) VALUES (%L, %L, %L, %L, %L, %L)',
    a_acct, 'missed_call', 'TK pbx bell', u_agent2, 'pbx', 'tk-call-bell'));
  n := n + 1;
  IF r <> 'ok' OR EXISTS (SELECT 1 FROM notifications WHERE type = 'task_assigned' AND title = 'TK pbx bell') THEN
    failed := array_append(failed, ('a PBX task''s insert rang the assignment bell: ' || r)::text);
  END IF;
  r := pg_temp.tk_try('service_role', NULL, format(
    'UPDATE tasks SET assigned_to = %L WHERE account_id = %L AND source_ref = %L', u_agent, a_acct, 'tk-call-bell'));
  n := n + 1;
  IF r <> 'ok' OR NOT EXISTS (SELECT 1 FROM notifications WHERE user_id = u_agent
       AND type = 'task_assigned' AND title = 'TK pbx bell') THEN
    failed := array_append(failed, ('reassigning a PBX task rings the new assignee: ' || r)::text);
  END IF;

  -- ---------- the notification kinds ----------
  FOREACH kind_name IN ARRAY ARRAY[
    'conversation_assigned', 'channel_disconnected', 'channel_reconnected',
    'team_activity_alert', 'ai_handoff', 'task_assigned', 'task_due',
    'chat_mention', 'chat_dm', 'chat_thread_reply', 'chat_broadcast',
    'call_missed', 'callback_requested', 'deal_room_join_request',
    'deal_room_update'] LOOP
    BEGIN
      INSERT INTO notifications (account_id, user_id, type, title) VALUES (a_acct, u_owner, kind_name, 'TK kind');
      r := 'ok';
    EXCEPTION WHEN OTHERS THEN
      r := 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
    END;
    n := n + 1;
    IF r <> 'ok' THEN failed := array_append(failed, ('notification type ' || kind_name || ': ' || r)::text); END IF;
  END LOOP;
  BEGIN
    INSERT INTO notifications (account_id, user_id, type, title) VALUES (a_acct, u_owner, 'tk_not_a_kind', 'TK kind');
    r := 'ok';
  EXCEPTION WHEN OTHERS THEN
    r := 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
  END;
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('an unknown notification type: ' || r)::text); END IF;

  -- ---------- deleting a login nulls its references ----------
  r := pg_temp.tk_try('authenticated', u_temp, format(
    'INSERT INTO tasks (account_id, kind, title, assigned_to, created_by) VALUES (%L, %L, %L, %L, %L)',
    a_acct, 'manual', 'TK temp', u_temp, u_temp));
  SELECT id INTO t_temp FROM tasks WHERE title = 'TK temp';
  r := r || ' / ' || pg_temp.tk_try('authenticated', u_temp, format(
    'UPDATE tasks SET status = %L WHERE id = %L', 'done', t_temp));
  BEGIN
    -- accounts.owner_user_id is RESTRICT: drop the account the
    -- auth.users trigger provisioned for this login first.
    DELETE FROM accounts WHERE owner_user_id = u_temp AND id <> a_acct;
    DELETE FROM auth.users WHERE id = u_temp;
  EXCEPTION WHEN OTHERS THEN
    r := r || ' / ERROR ' || SQLSTATE || ': ' || SQLERRM;
  END;
  n := n + 1;
  IF r <> 'ok / ok' OR NOT EXISTS (SELECT 1 FROM tasks WHERE id = t_temp
       AND created_by IS NULL AND completed_by IS NULL AND assigned_to IS NULL
       AND status = 'done' AND completed_at IS NOT NULL) THEN
    failed := array_append(failed, ('deleting a login: ' || r)::text);
  END IF;

  -- ---------- realtime and grants ----------
  n := n + 1;
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                      WHERE pubname = 'supabase_realtime'
                        AND schemaname = 'public' AND tablename = 'tasks') THEN
    failed := array_append(failed, 'tasks is not in the supabase_realtime publication'::text);
  END IF;
  r := pg_temp.tk_try('anon', NULL, 'SELECT count(*)::text FROM tasks');
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN failed := array_append(failed, ('anon selected tasks: ' || r)::text); END IF;
  r := pg_temp.tk_try('anon', NULL, format(
    'INSERT INTO tasks (account_id, kind, title) VALUES (%L, %L, %L)', a_acct, 'manual', 'TK anon'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN failed := array_append(failed, ('anon inserted a task: ' || r)::text); END IF;
  n := n + 1;
  IF has_function_privilege('authenticated', 'public.tasks_guard()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tasks_notify_assigned()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.can_view_task_contact(uuid, uuid)', 'EXECUTE') THEN
    failed := array_append(failed, 'clients may call the 085 functions'::text);
  END IF;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT085', MESSAGE = 'verify-tasks rollback';
  EXCEPTION WHEN SQLSTATE 'ZT085' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'tasks verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'tasks verification passed (% checks)', n;
END
$verify$;
