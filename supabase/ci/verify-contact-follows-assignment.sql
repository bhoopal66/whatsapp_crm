-- Behavioural regression suite for migration 169: assigning a chat
-- moves its contact (contacts.user_id) to the assignee, and
-- contacts.created_by keeps who the contact was created for.
--
-- Asserts: created_by is set from user_id on insert whatever the
-- writer passes and never changes afterwards, for an admin, the
-- service role or a no-user session; assigning a chat (admin, an
-- agent's own Take over, the service role, an insert with an assignee)
-- moves the contact and leaves created_by alone; reassigning moves it
-- again; unassigning, a refused assignment, and an assignee who is
-- deactivated, a bank guest or from another account move nothing; the
-- functions are not callable by clients.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000169001';
  u_admin  UUID := '00000000-0000-4000-8000-000000169002';
  u_agent  UUID := '00000000-0000-4000-8000-000000169003';
  u_agent2 UUID := '00000000-0000-4000-8000-000000169004';
  u_gone   UUID := '00000000-0000-4000-8000-000000169005';
  u_guest  UUID := '00000000-0000-4000-8000-000000169006';
  u_other  UUID := '00000000-0000-4000-8000-000000169007';
  a_acct   UUID;
  b_acct   UUID;
  ct       UUID;
  ct2      UUID;
  ct3      UUID;
  cv       UUID;
  cv2      UUID;
  owner_id UUID;
  creator  UUID;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (a signed-in user when p_uid is given);
  -- 'ok', or the error as 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cf_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', p_role)::text, true);
        EXECUTE format('SET LOCAL ROLE %I', p_role);
        EXECUTE p_sql;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ok';
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;

  -- Fixture: account A (owner, admin, two agents, a deactivated agent,
  -- a bank guest), account B (another owner).
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'cf-owner@example.invalid'),
    (u_admin,  'cf-admin@example.invalid'),
    (u_agent,  'cf-agent@example.invalid'),
    (u_agent2, 'cf-agent2@example.invalid'),
    (u_gone,   'cf-gone@example.invalid'),
    (u_guest,  'cf-guest@example.invalid'),
    (u_other,  'cf-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_other;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agent, u_agent2, u_gone);
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_guest;
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_gone;

  -- ---------- created_by on insert ----------
  -- Whatever the writer passes, created_by is the user_id it inserted.
  INSERT INTO contacts (account_id, user_id, phone, name, created_by)
  VALUES (a_acct, u_owner, '971500169001', 'CF one', u_other) RETURNING id INTO ct;
  n := n + 1;
  IF (SELECT created_by FROM contacts WHERE id = ct) IS DISTINCT FROM u_owner THEN
    failed := array_append(failed, 'insert: created_by is not the inserted user_id'::text);
  END IF;
  r := pg_temp.cf_try('authenticated', u_agent, format(
    'INSERT INTO contacts (account_id, user_id, phone, name) VALUES (%L, %L, %L, %L)',
    a_acct, u_agent, '971500169002', 'CF agent made'));
  n := n + 1;
  IF r <> 'ok' OR (SELECT created_by FROM contacts WHERE phone = '971500169002' AND account_id = a_acct)
       IS DISTINCT FROM u_agent THEN
    failed := array_append(failed, ('agent insert: created_by not the agent: ' || r)::text);
  END IF;

  -- ---------- created_by never changes ----------
  r := pg_temp.cf_try('authenticated', u_admin, format(
    'UPDATE contacts SET created_by = %L WHERE id = %L', u_admin, ct));
  n := n + 1;
  IF (SELECT created_by FROM contacts WHERE id = ct) IS DISTINCT FROM u_owner THEN
    failed := array_append(failed, ('admin rewrote created_by: ' || r)::text);
  END IF;
  r := pg_temp.cf_try('service_role', NULL, format(
    'UPDATE contacts SET created_by = NULL WHERE id = %L', ct));
  n := n + 1;
  IF (SELECT created_by FROM contacts WHERE id = ct) IS DISTINCT FROM u_owner THEN
    failed := array_append(failed, ('service role cleared created_by: ' || r)::text);
  END IF;
  UPDATE contacts SET created_by = u_other WHERE id = ct;
  n := n + 1;
  IF (SELECT created_by FROM contacts WHERE id = ct) IS DISTINCT FROM u_owner THEN
    failed := array_append(failed, 'no-user session rewrote created_by'::text);
  END IF;
  -- A direct owner change leaves it too.
  UPDATE contacts SET user_id = u_admin WHERE id = ct;
  UPDATE contacts SET user_id = u_owner WHERE id = ct;
  n := n + 1;
  IF (SELECT created_by FROM contacts WHERE id = ct) IS DISTINCT FROM u_owner THEN
    failed := array_append(failed, 'a user_id change moved created_by'::text);
  END IF;

  -- ---------- an admin assigns: the contact moves ----------
  INSERT INTO conversations (account_id, user_id, contact_id)
  VALUES (a_acct, u_owner, ct) RETURNING id INTO cv;
  r := pg_temp.cf_try('authenticated', u_admin, format(
    'UPDATE conversations SET assigned_agent_id = %L WHERE id = %L', u_agent, cv));
  SELECT user_id, created_by INTO owner_id, creator FROM contacts WHERE id = ct;
  n := n + 1;
  IF r <> 'ok' OR owner_id IS DISTINCT FROM u_agent THEN
    failed := array_append(failed, ('admin assign did not move the contact: ' || r || ' owner=' || coalesce(owner_id::text, 'NULL'))::text);
  END IF;
  n := n + 1;
  IF creator IS DISTINCT FROM u_owner THEN
    failed := array_append(failed, 'admin assign changed created_by'::text);
  END IF;

  -- ---------- reassigning moves it again ----------
  r := pg_temp.cf_try('authenticated', u_admin, format(
    'UPDATE conversations SET assigned_agent_id = %L WHERE id = %L', u_agent2, cv));
  SELECT user_id, created_by INTO owner_id, creator FROM contacts WHERE id = ct;
  n := n + 1;
  IF r <> 'ok' OR owner_id IS DISTINCT FROM u_agent2 OR creator IS DISTINCT FROM u_owner THEN
    failed := array_append(failed, ('reassign: ' || r || ' owner=' || coalesce(owner_id::text, 'NULL')
      || ' creator=' || coalesce(creator::text, 'NULL'))::text);
  END IF;

  -- ---------- unassigning leaves it ----------
  r := pg_temp.cf_try('authenticated', u_admin, format(
    'UPDATE conversations SET assigned_agent_id = NULL WHERE id = %L', cv));
  n := n + 1;
  IF r <> 'ok' OR (SELECT user_id FROM contacts WHERE id = ct) IS DISTINCT FROM u_agent2 THEN
    failed := array_append(failed, ('unassign moved the contact: ' || r)::text);
  END IF;

  -- ---------- a refused assignment moves nothing ----------
  -- An agent may only take a chat for themselves (042/044). The chat
  -- is made theirs first, so the refusal is the guard's, not RLS's.
  UPDATE conversations SET user_id = u_agent2 WHERE id = cv;
  r := pg_temp.cf_try('authenticated', u_agent2, format(
    'UPDATE conversations SET assigned_agent_id = %L WHERE id = %L', u_agent, cv));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' OR (SELECT user_id FROM contacts WHERE id = ct) IS DISTINCT FROM u_agent2 THEN
    failed := array_append(failed, ('refused assignment: ' || r)::text);
  END IF;

  -- ---------- an agent's own Take over moves it to them ----------
  -- u_agent no longer owns the contact and has no part in the chat,
  -- so give them the chat's ownership to make it visible, then take it.
  UPDATE conversations SET user_id = u_agent WHERE id = cv;
  r := pg_temp.cf_try('authenticated', u_agent, format(
    'UPDATE conversations SET assigned_agent_id = %L WHERE id = %L', u_agent, cv));
  n := n + 1;
  IF r <> 'ok' OR (SELECT user_id FROM contacts WHERE id = ct) IS DISTINCT FROM u_agent THEN
    failed := array_append(failed, ('agent self-assign did not move the contact: ' || r)::text);
  END IF;

  -- ---------- the service role (automations, API) ----------
  r := pg_temp.cf_try('service_role', NULL, format(
    'UPDATE conversations SET assigned_agent_id = %L WHERE id = %L', u_admin, cv));
  n := n + 1;
  IF r <> 'ok' OR (SELECT user_id FROM contacts WHERE id = ct) IS DISTINCT FROM u_admin THEN
    failed := array_append(failed, ('service-role assign did not move the contact: ' || r)::text);
  END IF;

  -- ---------- assignees the contact is never moved to ----------
  r := pg_temp.cf_try('service_role', NULL, format(
    'UPDATE conversations SET assigned_agent_id = %L WHERE id = %L', u_gone, cv));
  n := n + 1;
  IF r <> 'ok' OR (SELECT user_id FROM contacts WHERE id = ct) IS DISTINCT FROM u_admin THEN
    failed := array_append(failed, ('moved to a deactivated member: ' || r)::text);
  END IF;
  r := pg_temp.cf_try('service_role', NULL, format(
    'UPDATE conversations SET assigned_agent_id = %L WHERE id = %L', u_guest, cv));
  n := n + 1;
  IF r <> 'ok' OR (SELECT user_id FROM contacts WHERE id = ct) IS DISTINCT FROM u_admin THEN
    failed := array_append(failed, ('moved to a bank guest: ' || r)::text);
  END IF;
  r := pg_temp.cf_try('service_role', NULL, format(
    'UPDATE conversations SET assigned_agent_id = %L WHERE id = %L', u_other, cv));
  n := n + 1;
  IF r <> 'ok' OR (SELECT user_id FROM contacts WHERE id = ct) IS DISTINCT FROM u_admin THEN
    failed := array_append(failed, ('moved to another account''s person: ' || r)::text);
  END IF;

  -- ---------- a chat created already assigned ----------
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_owner, '971500169003', 'CF two') RETURNING id INTO ct2;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, ct2, u_agent) RETURNING id INTO cv2;
  SELECT user_id, created_by INTO owner_id, creator FROM contacts WHERE id = ct2;
  n := n + 1;
  IF owner_id IS DISTINCT FROM u_agent OR creator IS DISTINCT FROM u_owner THEN
    failed := array_append(failed, ('insert with an assignee: owner=' || coalesce(owner_id::text, 'NULL')
      || ' creator=' || coalesce(creator::text, 'NULL'))::text);
  END IF;

  -- ---------- an unassigned chat leaves its contact alone ----------
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_owner, '971500169004', 'CF three') RETURNING id INTO ct3;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_agent, ct3);
  n := n + 1;
  IF (SELECT user_id FROM contacts WHERE id = ct3) IS DISTINCT FROM u_owner THEN
    failed := array_append(failed, 'an unassigned chat moved its contact'::text);
  END IF;

  -- ---------- grants ----------
  n := n + 1;
  IF has_function_privilege('authenticated', 'public.conversations_move_contact_owner()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.conversations_move_contact_owner()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.contacts_created_by_guard()', 'EXECUTE') THEN
    failed := array_append(failed, 'clients may call the 169 functions'::text);
  END IF;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT169', MESSAGE = 'verify-contact-follows-assignment rollback';
  EXCEPTION WHEN SQLSTATE 'ZT169' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'contact follows assignment verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'contact follows assignment verification passed (% checks)', n;
END
$verify$;
