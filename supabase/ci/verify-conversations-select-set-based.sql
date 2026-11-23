-- Behavioural regression suite for migration 217: the conversations
-- SELECT policy and both messages policies compute visibility as sets,
-- and must show exactly what the per-row rule of 191 allowed
-- (can_view_conversation for a company chat, can_view_personal_chat
-- for a personal one, both unchanged).
--
-- Asserts, for an owner, an agent, a teammate agent, the team leader of
-- both, a viewer, a bank guest, a deactivated agent and another
-- workspace's owner, over a fixture of chats (the agent's own, one
-- assigned to the agent, the teammate's, an unassigned one, the
-- viewer's own, a company chat on the teammate's personal number, the
-- teammate's personal chat, and two chats of the other workspace, one
-- of them owned by the agent's login), each with one message and one
-- reaction: what each person sees through the policies equals the old
-- rule evaluated directly and equals the expected set written out by
-- hand, for conversations, messages and reactions, so the comparison
-- cannot pass vacuously; an agent's INSERT ... RETURNING of a new chat
-- still returns it; an agent cannot read the other workspace's chat by
-- id, not even one owned by their own login.
--
-- Writes through messages_insert (284; messages_modify, FOR ALL, so its USING was also its
-- WITH CHECK): every person INSERTs an agent message into every chat,
-- and the chats where that is allowed (refused = 42501) equal 191's
-- rule evaluated directly, which is the read rule AND
-- current_role_rank() >= 2, and equal a hand-written set (a viewer
-- reads their own chat but cannot write in it). UPDATE and DELETE are
-- refused to everybody (284).
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000218001';
  u_agent  UUID := '00000000-0000-4000-8000-000000218002';
  u_agent2 UUID := '00000000-0000-4000-8000-000000218003';  -- teammate, has a personal number
  u_lead   UUID := '00000000-0000-4000-8000-000000218004';  -- leads agent and agent2
  u_viewer UUID := '00000000-0000-4000-8000-000000218005';
  u_guest  UUID := '00000000-0000-4000-8000-000000218006';
  u_gone   UUID := '00000000-0000-4000-8000-000000218007';  -- deactivated agent
  u_other  UUID := '00000000-0000-4000-8000-000000218008';  -- owner of account B
  a_acct   UUID;
  b_acct   UUID;
  team     UUID;
  w_pn     UUID;  -- agent2's personal number
  cv_other UUID;  -- account B's chat owned by the agent's login
  c_new    UUID;  -- the contact of the agent's new chat
  ids      UUID[];
  labels   TEXT[];
  who      RECORD;
  kind     TEXT;
  seen_new TEXT;
  seen_old TEXT;
  expected TEXT;
  r        TEXT;
  chans    UUID[];
  i        INT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- The fixture labels, sorted, that p_uid sees of one table (p_kind
  -- conv / msg / react): through the policies (p_old false, as
  -- authenticated) or through 191's per-row rule (p_old true, as the
  -- table owner, so no policy applies). A message carries its chat's
  -- label as its text, a reaction as its emoji.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cv_seen(p_uid uuid, p_kind text, p_ids uuid[],
                                    p_labels text[], p_old boolean)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; vis uuid[];
    BEGIN
      PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
      PERFORM set_config('request.jwt.claims',
        json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
      IF p_old THEN
        SELECT coalesce(array_agg(c.id), '{}') INTO vis
          FROM public.conversations c
         WHERE c.id = ANY (p_ids)
           AND c.account_id = public.current_account_id()
           AND (public.current_role_rank() >= 4
                OR CASE WHEN c.personal_owner_id IS NULL
                     THEN public.can_view_conversation(c.account_id, c.user_id,
                            c.assigned_agent_id, c.channel_id, c.send_channel_id)
                     ELSE public.can_view_personal_chat(c.account_id, c.personal_owner_id)
                   END);
        IF p_kind = 'conv' THEN
          SELECT coalesce(string_agg(l.label, ',' ORDER BY l.label), '') INTO v
            FROM unnest(p_ids, p_labels) AS l(id, label)
           WHERE l.id = ANY (vis);
        ELSIF p_kind = 'msg' THEN
          SELECT coalesce(string_agg(m.content_text, ',' ORDER BY m.content_text), '') INTO v
            FROM public.messages m WHERE m.conversation_id = ANY (vis);
        ELSE
          SELECT coalesce(string_agg(x.emoji, ',' ORDER BY x.emoji), '') INTO v
            FROM public.message_reactions x
            JOIN public.messages m ON m.id = x.message_id
           WHERE m.conversation_id = ANY (vis);
        END IF;
      ELSE
        SET LOCAL ROLE authenticated;
        IF p_kind = 'conv' THEN
          EXECUTE 'SELECT coalesce(string_agg(l.label, '','' ORDER BY l.label), '''')
                     FROM unnest($1, $2) AS l(id, label)
                    WHERE l.id IN (SELECT id FROM public.conversations)'
            INTO v USING p_ids, p_labels;
        ELSIF p_kind = 'msg' THEN
          EXECUTE 'SELECT coalesce(string_agg(content_text, '','' ORDER BY content_text), '''')
                     FROM public.messages WHERE conversation_id = ANY ($1)'
            INTO v USING p_ids;
        ELSE
          EXECUTE 'SELECT coalesce(string_agg(emoji, '','' ORDER BY emoji), '''')
                     FROM public.message_reactions WHERE conversation_id = ANY ($1)'
            INTO v USING p_ids;
        END IF;
        RESET ROLE;
      END IF;
      PERFORM set_config('request.jwt.claim.sub', '', true);
      PERFORM set_config('request.jwt.claims', '', true);
      RETURN v;
    END $body$
  $fn$;

  -- Run p_sql as authenticated signed in as p_uid: a SELECT's (or a
  -- WITH's) value, 'ok', or 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cv_try(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
      PERFORM set_config('request.jwt.claims',
        json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
      BEGIN
        SET LOCAL ROLE authenticated;
        IF p_sql ~* '^\s*(SELECT|WITH)' THEN
          EXECUTE p_sql INTO v;
        ELSE
          EXECUTE p_sql;
          v := 'ok';
        END IF;
        RESET ROLE;
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        v := 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
      PERFORM set_config('request.jwt.claim.sub', '', true);
      PERFORM set_config('request.jwt.claims', '', true);
      RETURN v;
    END $body$
  $fn$;

  -- The fixture labels, sorted, of the chats p_uid may write a message
  -- in under 191's messages_modify rule, evaluated directly as the table
  -- owner: the read rule AND current_role_rank() >= 2.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cv_may_write(p_uid uuid, p_ids uuid[], p_labels text[])
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
      PERFORM set_config('request.jwt.claims',
        json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
      SELECT coalesce(string_agg(l.label, ',' ORDER BY l.label), '') INTO v
        FROM unnest(p_ids, p_labels) AS l(id, label)
        JOIN public.conversations c ON c.id = l.id
       WHERE c.account_id = public.current_account_id()
         AND public.current_role_rank() >= 2
         AND (public.current_role_rank() >= 4
              OR CASE WHEN c.personal_owner_id IS NULL
                   THEN public.can_view_conversation(c.account_id, c.user_id,
                          c.assigned_agent_id, c.channel_id, c.send_channel_id)
                   ELSE public.can_view_personal_chat(c.account_id, c.personal_owner_id)
                 END);
      PERFORM set_config('request.jwt.claim.sub', '', true);
      PERFORM set_config('request.jwt.claims', '', true);
      RETURN v;
    END $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'cv-owner@example.invalid'),
    (u_agent,  'cv-agent@example.invalid'),
    (u_agent2, 'cv-agent2@example.invalid'),
    (u_lead,   'cv-lead@example.invalid'),
    (u_viewer, 'cv-viewer@example.invalid'),
    (u_guest,  'cv-guest@example.invalid'),
    (u_gone,   'cv-gone@example.invalid'),
    (u_other,  'cv-other@example.invalid')
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
  UPDATE profiles SET may_connect_personal_whatsapp = true WHERE user_id = u_agent2;

  -- u_lead leads a team holding u_agent and u_agent2.
  INSERT INTO teams (account_id, name, leader_user_id)
  VALUES (a_acct, 'CV team', u_lead) RETURNING id INTO team;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES
    (team, u_agent, a_acct), (team, u_agent2, a_acct);

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, is_personal)
    VALUES (u_agent2, a_acct, 'openwa', 'cv-sess-p', 't', true) RETURNING id INTO w_pn;

  -- One contact per chat (one company chat per contact); the personal
  -- chat shares the teammate's contact, as 191 allows.
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES
    (a_acct, u_agent,  '971500218001', 'own'),
    (a_acct, u_owner,  '971500218002', 'assigned'),
    (a_acct, u_agent2, '971500218003', 'teammate'),
    (a_acct, u_owner,  '971500218004', 'unassigned'),
    (a_acct, u_viewer, '971500218005', 'viewer-own'),
    (a_acct, u_owner,  '971500218006', 'pn-company'),
    (b_acct, u_other,  '971500218007', 'other'),
    (b_acct, u_other,  '971500218008', 'other-agent'),
    (a_acct, u_agent,  '971500218009', 'agent-new');

  -- Chats, named by why they are visible, written as the owner (an
  -- admin may stamp any number).
  PERFORM set_config('request.jwt.claim.sub', u_owner::text, true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  INSERT INTO conversations (account_id, user_id, assigned_agent_id, contact_id)
  SELECT ct.account_id,
         CASE ct.name WHEN 'own' THEN u_agent WHEN 'teammate' THEN u_agent2
                      WHEN 'viewer-own' THEN u_viewer WHEN 'other' THEN u_other
                      WHEN 'other-agent' THEN u_agent ELSE u_owner END,
         CASE ct.name WHEN 'assigned' THEN u_agent END,
         ct.id
    FROM contacts ct
   WHERE ct.phone LIKE '9715002180%'
     AND ct.name IN ('own', 'assigned', 'teammate', 'unassigned', 'viewer-own',
                     'other', 'other-agent');
  -- 191's guard refuses a company chat on a personal number; 190's
  -- grant still covers chats that predate 191, so lift it for this one
  -- (rolled back with the fixture).
  ALTER TABLE conversations DISABLE TRIGGER conversations_personal_guard;
  INSERT INTO conversations (account_id, user_id, contact_id, channel_id)
  SELECT a_acct, u_owner, id, w_pn FROM contacts
   WHERE account_id = a_acct AND name = 'pn-company';
  ALTER TABLE conversations ENABLE TRIGGER conversations_personal_guard;
  INSERT INTO conversations (account_id, user_id, contact_id, channel_id, personal_owner_id)
  SELECT a_acct, u_agent2, id, w_pn, u_agent2 FROM contacts
   WHERE account_id = a_acct AND name = 'teammate';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);

  -- Labels: the contact's name, 'personal' for the personal chat.
  SELECT array_agg(cv.id ORDER BY cv.id),
         array_agg(CASE WHEN cv.personal_owner_id IS NOT NULL THEN 'personal' ELSE ct.name END
                   ORDER BY cv.id)
    INTO ids, labels
    FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id
   WHERE ct.phone LIKE '9715002180%';
  IF coalesce(array_length(ids, 1), 0) <> 9 THEN
    RAISE EXCEPTION 'fixture: expected 9 chats, made %', coalesce(array_length(ids, 1), 0);
  END IF;
  SELECT id INTO cv_other FROM conversations
   WHERE account_id = b_acct AND user_id = u_agent;

  INSERT INTO messages (conversation_id, sender_type, sender_id, content_type, content_text)
  SELECT l.id, 'agent', NULL, 'text', l.label
    FROM unnest(ids, labels) AS l(id, label);
  INSERT INTO message_reactions (message_id, conversation_id, actor_type, emoji)
  SELECT m.id, m.conversation_id, 'customer', m.content_text
    FROM messages m WHERE m.conversation_id = ANY (ids);

  -- Deactivated last, so the fixture writes above do not trip on it.
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_gone;

  FOR who IN
    SELECT * FROM (VALUES
      ('owner',  u_owner,  'assigned,own,personal,pn-company,teammate,unassigned,viewer-own'),
      ('agent',  u_agent,  'assigned,own'),
      ('agent2', u_agent2, 'personal,pn-company,teammate'),
      ('leader', u_lead,   'assigned,own,personal,pn-company,teammate'),
      ('viewer', u_viewer, 'viewer-own'),
      ('guest',  u_guest,  ''),
      ('gone',   u_gone,   ''),
      ('other',  u_other,  'other,other-agent')
    ) AS t(label, uid, expected)
  LOOP
    FOREACH kind IN ARRAY ARRAY['conv', 'msg', 'react'] LOOP
      seen_new := pg_temp.cv_seen(who.uid, kind, ids, labels, false);
      seen_old := pg_temp.cv_seen(who.uid, kind, ids, labels, true);
      expected := who.expected;
      n := n + 1;
      IF seen_new IS DISTINCT FROM seen_old THEN
        failed := array_append(failed, format('%s %s: policy sees [%s], old rule [%s]',
          who.label, kind, seen_new, seen_old));
      END IF;
      n := n + 1;
      IF seen_new IS DISTINCT FROM expected THEN
        failed := array_append(failed, format('%s %s: policy sees [%s], expected [%s]',
          who.label, kind, seen_new, expected));
      END IF;
    END LOOP;
  END LOOP;

  -- An agent's new chat passes the SELECT policy on RETURNING (the
  -- composer inserts with .select()).
  SELECT id INTO c_new FROM contacts WHERE account_id = a_acct AND name = 'agent-new';
  PERFORM set_config('request.jwt.claim.sub', u_agent::text, true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', u_agent, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    EXECUTE format(
      'INSERT INTO public.conversations (account_id, user_id, contact_id) VALUES (%L, %L, %L)
       RETURNING (contact_id = %L)::text',
      a_acct, u_agent, c_new, c_new) INTO r;
    RESET ROLE;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    r := 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
  END;
  n := n + 1;
  IF r IS DISTINCT FROM 'true' THEN
    failed := array_append(failed, ('agent insert returning: ' || coalesce(r, 'no row'))::text);
  END IF;

  -- The other workspace's chat owned by the agent's own login, read by
  -- id: neither the chat nor its message nor its reaction.
  BEGIN
    SET LOCAL ROLE authenticated;
    EXECUTE 'SELECT format(''%s/%s/%s'',
               (SELECT count(*) FROM public.conversations WHERE id = $1),
               (SELECT count(*) FROM public.messages WHERE conversation_id = $1),
               (SELECT count(*) FROM public.message_reactions WHERE conversation_id = $1))'
      INTO r USING cv_other;
    RESET ROLE;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    r := 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
  END;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  n := n + 1;
  IF cv_other IS NULL OR r IS DISTINCT FROM '0/0/0' THEN
    failed := array_append(failed,
      ('agent reads the other workspace''s chat: ' || coalesce(r, 'no fixture'))::text);
  END IF;

  -- Writes through messages_insert. Every person INSERTs an agent
  -- message, as themselves, into every chat on the chat's own number;
  -- 42501 is a refusal, any other error is reported as a failure. The
  -- team: the leader leads agent and agent2, so 'teammate' (agent2's
  -- chat) is refused to agent and 'own' / 'assigned' to agent2. The
  -- viewer reads 'viewer-own' but may not write in it (rank >= 2); agent2
  -- writes in 'pn-company' only through the personal-number term; the
  -- leader writes in agent2's personal chat.
  SELECT array_agg(cv.channel_id ORDER BY l.ord) INTO chans
    FROM unnest(ids) WITH ORDINALITY AS l(id, ord)
    JOIN conversations cv ON cv.id = l.id;
  FOR who IN
    SELECT * FROM (VALUES
      ('owner',  u_owner,  'assigned,own,personal,pn-company,teammate,unassigned,viewer-own'),
      ('agent',  u_agent,  'assigned,own'),
      ('agent2', u_agent2, 'personal,pn-company,teammate'),
      ('leader', u_lead,   'assigned,own,personal,pn-company,teammate'),
      ('viewer', u_viewer, ''),
      ('guest',  u_guest,  ''),
      ('gone',   u_gone,   ''),
      ('other',  u_other,  'other,other-agent')
    ) AS t(label, uid, expected)
  LOOP
    seen_new := NULL;
    FOR i IN 1 .. array_length(ids, 1) LOOP
      r := pg_temp.cv_try(who.uid, format(
        'INSERT INTO public.messages (conversation_id, sender_type, sender_id,'
        || ' content_type, content_text, channel_id) VALUES (%L, ''agent'', %L, ''text'', %L, %L)',
        ids[i], who.uid, 'w:' || labels[i], chans[i]));
      IF r = 'ok' THEN
        seen_new := concat_ws(',', seen_new, labels[i]);
      ELSIF r NOT LIKE 'ERROR 42501:%' THEN
        seen_new := concat_ws(',', seen_new, labels[i] || ' (' || r || ')');
      END IF;
    END LOOP;
    SELECT coalesce(string_agg(x, ',' ORDER BY x), '') INTO seen_new
      FROM unnest(string_to_array(seen_new, ',')) AS x;
    seen_old := pg_temp.cv_may_write(who.uid, ids, labels);
    n := n + 1;
    IF seen_new IS DISTINCT FROM seen_old THEN
      failed := array_append(failed, format('%s insert: policy allows [%s], old rule [%s]',
        who.label, seen_new, seen_old));
    END IF;
    n := n + 1;
    IF seen_new IS DISTINCT FROM who.expected THEN
      failed := array_append(failed, format('%s insert: policy allows [%s], expected [%s]',
        who.label, seen_new, who.expected));
    END IF;
  END LOOP;

  -- UPDATE and DELETE of a message: nobody, from a session (284).
  FOR who IN
    SELECT * FROM (VALUES ('leader', u_lead, 'personal'), ('viewer', u_viewer, 'viewer-own'),
                          ('agent2', u_agent2, 'pn-company')) AS t(label, uid, chat)
  LOOP
    FOREACH kind IN ARRAY ARRAY['UPDATE public.messages SET content_text = ''edited''',
                                'DELETE FROM public.messages'] LOOP
      r := pg_temp.cv_try(who.uid, format('%s WHERE conversation_id = %L AND content_text = %L',
        kind, ids[array_position(labels, who.chat)], who.chat));
      n := n + 1;
      IF r IS NULL OR r NOT LIKE 'ERROR 42501:%' THEN
        failed := array_append(failed, format('%s %s in %s: %s', who.label,
          split_part(kind, ' ', 1), who.chat, coalesce(r, 'null')));
      END IF;
    END LOOP;
  END LOOP;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT218', MESSAGE = 'verify-conversations-select-set-based rollback';
  EXCEPTION WHEN SQLSTATE 'ZT218' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'conversations select verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'conversations select verification passed (% checks)', n;
END
$verify$;
