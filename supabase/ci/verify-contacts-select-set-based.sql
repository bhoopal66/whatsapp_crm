-- Behavioural regression suite for migration 177: the contacts_select
-- policy computes visibility as sets, and must show exactly what
-- can_view_contact (043/072, unchanged) allows.
--
-- Asserts, for an owner, two agents, a team leader, a viewer, a bank
-- guest, a deactivated agent and another workspace's owner, over a
-- fixture of contacts (own, through an own chat, through an assigned
-- chat, a team member's, through a team member's chat, nobody's):
-- what each sees through the policy equals the old rule (current
-- account, rank >= 4 or can_view_contact) and equals the expected set
-- written out by hand, so the comparison cannot pass vacuously; an
-- agent's INSERT ... RETURNING of their own new contact still returns
-- it; the helpers are not callable by anon.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000177001';
  u_agent  UUID := '00000000-0000-4000-8000-000000177002';
  u_agent2 UUID := '00000000-0000-4000-8000-000000177003';
  u_lead   UUID := '00000000-0000-4000-8000-000000177004';
  u_viewer UUID := '00000000-0000-4000-8000-000000177005';
  u_guest  UUID := '00000000-0000-4000-8000-000000177006';
  u_gone   UUID := '00000000-0000-4000-8000-000000177007';
  u_other  UUID := '00000000-0000-4000-8000-000000177008';
  a_acct   UUID;
  b_acct   UUID;
  team     UUID;
  ids      UUID[];
  who      RECORD;
  seen_new TEXT;
  seen_old TEXT;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- The fixture contacts' names, sorted, that p_uid sees: through the
  -- policy (p_old false, as authenticated) or through the pre-177 rule
  -- (p_old true, as the table owner, so no policy applies).
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cs_seen(p_uid uuid, p_ids uuid[], p_old boolean)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
      PERFORM set_config('request.jwt.claims',
        json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
      IF p_old THEN
        SELECT coalesce(string_agg(c.name, ',' ORDER BY c.name), '') INTO v
          FROM public.contacts c
         WHERE c.id = ANY (p_ids)
           AND c.account_id = public.current_account_id()
           AND (public.current_role_rank() >= 4
                OR public.can_view_contact(c.account_id, c.id, c.user_id));
      ELSE
        SET LOCAL ROLE authenticated;
        EXECUTE 'SELECT coalesce(string_agg(name, '','' ORDER BY name), '''')
                   FROM public.contacts WHERE id = ANY ($1)'
          INTO v USING p_ids;
        RESET ROLE;
      END IF;
      PERFORM set_config('request.jwt.claim.sub', '', true);
      PERFORM set_config('request.jwt.claims', '', true);
      RETURN v;
    END $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'cs-owner@example.invalid'),
    (u_agent,  'cs-agent@example.invalid'),
    (u_agent2, 'cs-agent2@example.invalid'),
    (u_lead,   'cs-lead@example.invalid'),
    (u_viewer, 'cs-viewer@example.invalid'),
    (u_guest,  'cs-guest@example.invalid'),
    (u_gone,   'cs-gone@example.invalid'),
    (u_other,  'cs-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_other;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent'
   WHERE user_id IN (u_agent, u_agent2, u_gone);
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_viewer;
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB'
   WHERE user_id = u_guest;
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_gone;

  -- u_lead leads a team holding u_agent2.
  INSERT INTO teams (account_id, name, leader_user_id)
  VALUES (a_acct, 'CS team', u_lead) RETURNING id INTO team;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (team, u_agent2, a_acct);

  -- Contacts, named by why they are visible. Chats are left
  -- unassigned where the test is about the chat's owner, because
  -- assigning a chat moves its contact (169).
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES
    (a_acct, u_agent,  '971500177001', 'agent-own'),
    (a_acct, u_owner,  '971500177002', 'agent-chat'),
    (a_acct, u_owner,  '971500177003', 'agent-assigned'),
    (a_acct, u_agent2, '971500177004', 'team-own'),
    (a_acct, u_owner,  '971500177005', 'team-chat'),
    (a_acct, u_owner,  '971500177006', 'nobody'),
    (a_acct, u_gone,   '971500177007', 'gone-own'),
    (b_acct, u_other,  '971500177008', 'other-account');
  INSERT INTO conversations (account_id, user_id, contact_id)
  SELECT a_acct, u_agent, id FROM contacts WHERE account_id = a_acct AND name = 'agent-chat';
  INSERT INTO conversations (account_id, user_id, contact_id)
  SELECT a_acct, u_agent2, id FROM contacts WHERE account_id = a_acct AND name = 'team-chat';
  INSERT INTO conversations (account_id, user_id, contact_id)
  SELECT a_acct, u_owner, id FROM contacts WHERE account_id = a_acct AND name = 'agent-assigned';
  -- An assignment moves the contact to the assignee (169) and the
  -- contact stays visible through the assignment as well.
  UPDATE conversations SET assigned_agent_id = u_agent
   WHERE contact_id = (SELECT id FROM contacts WHERE account_id = a_acct AND name = 'agent-assigned');
  UPDATE contacts SET user_id = u_owner
   WHERE account_id = a_acct AND name = 'agent-assigned';

  SELECT array_agg(id) INTO ids FROM contacts
   WHERE phone LIKE '9715001770%' AND account_id IN (a_acct, b_acct);

  FOR who IN
    SELECT * FROM (VALUES
      ('owner',  u_owner,  'agent-assigned,agent-chat,agent-own,gone-own,nobody,team-chat,team-own'),
      ('agent',  u_agent,  'agent-assigned,agent-chat,agent-own'),
      ('agent2', u_agent2, 'team-chat,team-own'),
      ('leader', u_lead,   'team-chat,team-own'),
      ('viewer', u_viewer, ''),
      ('guest',  u_guest,  ''),
      ('gone',   u_gone,   ''),
      ('other',  u_other,  'other-account')
    ) AS t(label, uid, expected)
  LOOP
    seen_new := pg_temp.cs_seen(who.uid, ids, false);
    seen_old := pg_temp.cs_seen(who.uid, ids, true);
    n := n + 1;
    IF seen_new IS DISTINCT FROM seen_old THEN
      failed := array_append(failed, format('%s: policy sees [%s], can_view_contact [%s]',
        who.label, seen_new, seen_old));
    END IF;
    n := n + 1;
    IF seen_new IS DISTINCT FROM who.expected THEN
      failed := array_append(failed, format('%s: policy sees [%s], expected [%s]',
        who.label, seen_new, who.expected));
    END IF;
  END LOOP;

  -- An agent's own new contact passes the SELECT policy on RETURNING
  -- (the contact form inserts with .select('id')).
  PERFORM set_config('request.jwt.claim.sub', u_agent::text, true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', u_agent, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    EXECUTE format(
      'INSERT INTO public.contacts (account_id, user_id, phone, name) VALUES (%L, %L, %L, %L) RETURNING name',
      a_acct, u_agent, '971500177009', 'agent-new') INTO r;
    RESET ROLE;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    r := 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
  END;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  n := n + 1;
  IF r IS DISTINCT FROM 'agent-new' THEN
    failed := array_append(failed, ('agent insert returning: ' || coalesce(r, 'no row'))::text);
  END IF;

  -- ---------- grants ----------
  n := n + 1;
  IF has_function_privilege('anon', 'public.contact_visibility_people()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.contact_visibility_chat_contact_ids()', 'EXECUTE') THEN
    failed := array_append(failed, 'anon may call the 177 helpers'::text);
  END IF;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT177', MESSAGE = 'verify-contacts-select-set-based rollback';
  EXCEPTION WHEN SQLSTATE 'ZT177' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'contacts select verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'contacts select verification passed (% checks)', n;
END
$verify$;
