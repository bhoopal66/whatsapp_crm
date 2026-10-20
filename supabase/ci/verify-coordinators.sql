-- Behavioural regression suite for coordinators (migration 130).
--
-- Only an owner / admin assigns coordinator banks, only to a live agent
-- or team leader, only banks the account has. A chat is shared only by
-- agent-and-up staff who can see it, with another person holding that
-- bank. The share gives that coordinator (and no other coordinator of
-- the bank) SELECT on the conversation, its messages and its contact,
-- never UPDATE / DELETE, and INSERT of their own outbound message on the
-- conversation's own number only. It rings conversation_shared once; a
-- repeat share of the same bank is idempotent. Visibility ends on
-- revoke, on removing the bank, on deactivation. The sharer and an
-- admin may revoke; an unrelated agent may not. Nothing else of the
-- chat or contact opens: not the contact's TypeSafe decision rows, not
-- writing reactions (reading them is fine). my_coordinator_shares()
-- lists exactly the shares that grant.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.
-- A writing RPC's result is assigned first and its effect read in a
-- later statement (a subquery in the same expression would read the
-- snapshot taken before the call).

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000130001';
  u_admin  UUID := '00000000-0000-4000-8000-000000130002';
  u_agent  UUID := '00000000-0000-4000-8000-000000130003';  -- owns c1 and c2; the sharer
  u_other  UUID := '00000000-0000-4000-8000-000000130004';  -- agent with no tie to c1
  u_coord  UUID := '00000000-0000-4000-8000-000000130005';  -- agent; coordinator of ADCB
  u_coord2 UUID := '00000000-0000-4000-8000-000000130006';  -- team_leader; also coordinator of ADCB
  u_viewer UUID := '00000000-0000-4000-8000-000000130007';
  u_guest  UUID := '00000000-0000-4000-8000-000000130008';
  a_acct   UUID;
  wa       UUID;  -- c1's number
  wa2      UUID;  -- another number of the account
  ca       UUID;
  ca2      UUID;
  c1       UUID;  -- shared
  c2       UUID;  -- never shared
  m1       UUID;  -- the agent's message in c1
  s1       TEXT;
  s2       TEXT;
  s3       TEXT;
  r        TEXT;
  q_conv   TEXT;
  q_msgs   TEXT;
  q_cont   TEXT;
  q_bell   TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (NULL: as the current user) signed in as
  -- p_uid: a SELECT's value, 'ok', or 'ERROR <sqlstate> <hint>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cs_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; h text;
    BEGIN
      BEGIN
        IF p_role IS NOT NULL THEN
          PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
          PERFORM set_config('request.jwt.claims',
            json_build_object('sub', p_uid, 'role', p_role)::text, true);
          EXECUTE format('SET LOCAL ROLE %I', p_role);
        END IF;
        IF p_sql ILIKE 'select%' OR p_sql ILIKE 'with%' THEN
          EXECUTE p_sql INTO v;
        ELSE
          EXECUTE p_sql;
        END IF;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(v, 'ok');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ' ' || coalesce(nullif(h, ''), '-') || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cs_check(p_name text, p_role text, p_uid uuid, p_sql text, p_like text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := pg_temp.cs_try(p_role, p_uid, p_sql);
    BEGIN
      RETURN CASE WHEN v LIKE p_like THEN NULL ELSE p_name || ' (' || v || ')' END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cs_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'ci-co-owner@example.invalid'),
    (u_admin,  'ci-co-admin@example.invalid'),
    (u_agent,  'ci-co-agent@example.invalid'),
    (u_other,  'ci-co-other@example.invalid'),
    (u_coord,  'ci-co-coord@example.invalid'),
    (u_coord2, 'ci-co-coord2@example.invalid'),
    (u_viewer, 'ci-co-viewer@example.invalid'),
    (u_guest,  'ci-co-guest@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agent, u_other, u_coord);
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_coord2;
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_viewer;
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_guest;

  INSERT INTO case_banks (account_id, code, name) VALUES (a_acct, 'ADCB', 'ADCB Bank'), (a_acct, 'ENBD', 'Emirates NBD');

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'CT-130-A1', 'x', 'connected', true) RETURNING id INTO wa;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'CT-130-A2', 'x', 'connected', false) RETURNING id INTO wa2;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500130001', 'CI shared')
    RETURNING id INTO ca;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500130002', 'CI unshared')
    RETURNING id INTO ca2;
  INSERT INTO conversations (account_id, user_id, contact_id, channel_id) VALUES (a_acct, u_agent, ca, wa)
    RETURNING id INTO c1;
  INSERT INTO conversations (account_id, user_id, contact_id, channel_id) VALUES (a_acct, u_agent, ca2, wa)
    RETURNING id INTO c2;
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text, channel_id, provider)
  VALUES (c1, 'agent', u_agent, 'hello from the agent', wa, 'whapi'),
         (c2, 'agent', u_agent, 'unshared chat', wa, 'whapi');
  SELECT id INTO m1 FROM messages WHERE conversation_id = c1;
  INSERT INTO message_reactions (message_id, conversation_id, actor_type, actor_id, emoji)
  VALUES (m1, c1, 'customer', NULL, '👍');
  INSERT INTO ts_decision_log (account_id, contact_id, conversation_id, check_name, question_set_version,
                               decision, acted, shadow)
  VALUES (a_acct, ca, c1::text, 'triage', 'ci-130', 'allow', false, true);

  q_conv := format('SELECT count(*)::text FROM conversations WHERE id = %L', c1);
  q_msgs := format('SELECT count(*)::text FROM messages WHERE conversation_id = %L', c1);
  q_cont := format('SELECT count(*)::text FROM contacts WHERE id = %L', ca);
  q_bell := format('SELECT count(*)::text FROM notifications WHERE user_id = %L AND type = ''conversation_shared'''
                   || ' AND conversation_id = %L', u_coord, c1);

  -- ---------- 1. assigning coordinator banks ----------
  n := n + 1; failed := failed || pg_temp.cs_check('an agent could set coordinator banks',
    'authenticated', u_agent, format('SELECT set_coordinator_banks(%L, ''{ADCB}'')::text', u_coord), 'ERROR 42501 %');
  n := n + 1; failed := failed || pg_temp.cs_check('the agent''s refused call stored a bank',
    NULL, NULL, format('SELECT count(*)::text FROM coordinator_banks WHERE user_id = %L', u_coord), '0');
  n := n + 1; failed := failed || pg_temp.cs_check('a viewer could be made a coordinator',
    'authenticated', u_admin, format('SELECT set_coordinator_banks(%L, ''{ADCB}'')::text', u_viewer),
    'ERROR 22023 not_eligible:%');
  n := n + 1; failed := failed || pg_temp.cs_check('a bank guest could be made a coordinator',
    'authenticated', u_admin, format('SELECT set_coordinator_banks(%L, ''{ADCB}'')::text', u_guest),
    'ERROR 22023 not_eligible:%');
  n := n + 1; failed := failed || pg_temp.cs_check('an unknown bank was accepted',
    'authenticated', u_admin, format('SELECT set_coordinator_banks(%L, ''{ADCB,NOPE}'')::text', u_coord),
    'ERROR 22023 unknown_bank:%');
  n := n + 1; failed := failed || pg_temp.cs_check('the admin could not make the agent a coordinator of ADCB',
    'authenticated', u_admin, format('SELECT set_coordinator_banks(%L, ''{ADCB}'')::text', u_coord), '{ADCB}');
  n := n + 1; failed := failed || pg_temp.cs_check('the admin could not make the team leader a coordinator of ADCB',
    'authenticated', u_admin, format('SELECT set_coordinator_banks(%L, ''{ADCB}'')::text', u_coord2), '{ADCB}');
  -- The sharer holds ENBD, so the self-share refusal below is not just
  -- "not a coordinator".
  n := n + 1; failed := failed || pg_temp.cs_check('the admin could not make the sharer a coordinator of ENBD',
    'authenticated', u_admin, format('SELECT set_coordinator_banks(%L, ''{ENBD}'')::text', u_agent), '{ENBD}');

  -- ---------- 2. refused shares ----------
  n := n + 1; failed := failed || pg_temp.cs_check('a share for a bank the coordinator does not hold was accepted',
    'authenticated', u_agent, format('SELECT share_conversation_with_coordinator(%L, %L, ''ENBD'')::text', c1, u_coord),
    'ERROR 22023 not_coordinator:%');
  n := n + 1; failed := failed || pg_temp.cs_check('an agent who cannot see the chat could share it',
    'authenticated', u_other, format('SELECT share_conversation_with_coordinator(%L, %L, ''ADCB'')::text', c1, u_coord),
    'ERROR P0002 %');
  n := n + 1; failed := failed || pg_temp.cs_check('a viewer could share a chat',
    'authenticated', u_viewer, format('SELECT share_conversation_with_coordinator(%L, %L, ''ADCB'')::text', c1, u_coord),
    'ERROR 42501 %');
  n := n + 1; failed := failed || pg_temp.cs_check('a coordinator could share a chat with themselves',
    'authenticated', u_agent, format('SELECT share_conversation_with_coordinator(%L, %L, ''ENBD'')::text', c1, u_agent),
    'ERROR 22023 self_share:%');
  n := n + 1; failed := failed || pg_temp.cs_check('a refused share left a share row',
    NULL, NULL, format('SELECT count(*)::text FROM conversation_coordinator_shares WHERE conversation_id = %L', c1), '0');
  -- Before any share the coordinator sees nothing of c1.
  n := n + 1; failed := failed || pg_temp.cs_check('the coordinator saw c1 before it was shared',
    'authenticated', u_coord, q_conv, '0');

  -- ---------- 3. after a share: what the coordinator sees ----------
  s1 := pg_temp.cs_try('authenticated', u_agent,
    format('SELECT share_conversation_with_coordinator(%L, %L, ''ADCB'')::text', c1, u_coord));
  n := n + 1; failed := failed || pg_temp.cs_ok(s1 ~ '^[0-9a-f-]{36}$', format('the sharer could not share c1 (%s)', s1));
  n := n + 1; failed := failed || pg_temp.cs_check('the coordinator does not see the shared conversation',
    'authenticated', u_coord, q_conv, '1');
  n := n + 1; failed := failed || pg_temp.cs_check('the coordinator does not see the shared chat''s messages',
    'authenticated', u_coord, q_msgs, '1');
  n := n + 1; failed := failed || pg_temp.cs_check('the coordinator does not see the shared chat''s contact',
    'authenticated', u_coord, q_cont, '1');
  n := n + 1; failed := failed || pg_temp.cs_check('the coordinator sees an unshared conversation',
    'authenticated', u_coord, format('SELECT count(*)::text FROM conversations WHERE id = %L', c2), '0');
  n := n + 1; failed := failed || pg_temp.cs_check('the coordinator sees an unshared chat''s messages or contact',
    'authenticated', u_coord, format('SELECT ((SELECT count(*) FROM messages WHERE conversation_id = %L)'
      || ' + (SELECT count(*) FROM contacts WHERE id = %L))::text', c2, ca2), '0');
  n := n + 1; failed := failed || pg_temp.cs_check('another coordinator of the same bank sees the shared chat',
    'authenticated', u_coord2, format('SELECT ((SELECT count(*) FROM conversations WHERE id = %L)'
      || ' + (SELECT count(*) FROM messages WHERE conversation_id = %L)'
      || ' + (SELECT count(*) FROM contacts WHERE id = %L))::text', c1, c1, ca), '0');
  n := n + 1; failed := failed || pg_temp.cs_check('the coordinator could update the shared conversation',
    'authenticated', u_coord, format('WITH u AS (UPDATE conversations SET status = ''closed'' WHERE id = %L RETURNING 1)'
      || ' SELECT count(*)::text FROM u', c1), '0');
  n := n + 1; failed := failed || pg_temp.cs_check('the coordinator could update the shared chat''s contact',
    'authenticated', u_coord, format('WITH u AS (UPDATE contacts SET name = ''renamed'' WHERE id = %L RETURNING 1)'
      || ' SELECT count(*)::text FROM u', ca), '0');
  n := n + 1; failed := failed || pg_temp.cs_check('the coordinator could delete the shared chat''s messages',
    'authenticated', u_coord, format('WITH d AS (DELETE FROM messages WHERE conversation_id = %L RETURNING 1)'
      || ' SELECT count(*)::text FROM d', c1), '0');
  n := n + 1; failed := failed || pg_temp.cs_check('the shared conversation or contact changed under the coordinator',
    NULL, NULL, format('SELECT ((SELECT status FROM conversations WHERE id = %L) || ''/'''
      || ' || (SELECT name FROM contacts WHERE id = %L))', c1, ca), 'open/CI shared');

  -- ---------- 3b. nothing else of the chat or contact ----------
  n := n + 1; failed := failed || pg_temp.cs_check('the sharer cannot read their contact''s TypeSafe decision rows',
    'authenticated', u_agent, format('SELECT count(*)::text FROM ts_decision_log WHERE contact_id = %L', ca), '1');
  n := n + 1; failed := failed || pg_temp.cs_check('the coordinator reads the shared contact''s TypeSafe decision rows',
    'authenticated', u_coord, format('SELECT count(*)::text FROM ts_decision_log WHERE contact_id = %L', ca), '0');
  n := n + 1; failed := failed || pg_temp.cs_check('the coordinator cannot read reactions in the shared chat',
    'authenticated', u_coord, format('SELECT count(*)::text FROM message_reactions WHERE conversation_id = %L', c1), '1');
  n := n + 1; failed := failed || pg_temp.cs_check('the coordinator could react in the shared chat',
    'authenticated', u_coord, format('INSERT INTO message_reactions (message_id, conversation_id, actor_type, actor_id, emoji)'
      || ' VALUES (%L, %L, ''agent'', %L, ''x'')', m1, c1, u_coord), 'ERROR 42501 %');
  n := n + 1; failed := failed || pg_temp.cs_check('the coordinator could change a reaction in the shared chat',
    'authenticated', u_coord, format('WITH u AS (UPDATE message_reactions SET emoji = ''y'' WHERE conversation_id = %L'
      || ' RETURNING 1) SELECT count(*)::text FROM u', c1), '0');
  n := n + 1; failed := failed || pg_temp.cs_check('the coordinator could delete a reaction in the shared chat',
    'authenticated', u_coord, format('WITH d AS (DELETE FROM message_reactions WHERE conversation_id = %L RETURNING 1)'
      || ' SELECT count(*)::text FROM d', c1), '0');
  n := n + 1; failed := failed || pg_temp.cs_check('the sharer could not react in their own chat',
    'authenticated', u_agent, format('INSERT INTO message_reactions (message_id, conversation_id, actor_type, actor_id, emoji)'
      || ' VALUES (%L, %L, ''agent'', %L, ''z'')', m1, c1, u_agent), 'ok');
  n := n + 1; failed := failed || pg_temp.cs_check('the shared chat''s reactions changed under the coordinator',
    NULL, NULL, format('SELECT string_agg(emoji, '','' ORDER BY emoji COLLATE "C") FROM message_reactions WHERE conversation_id = %L', c1),
    'z,👍');
  n := n + 1; failed := failed || pg_temp.cs_check('my_coordinator_shares() does not list the share',
    'authenticated', u_coord, 'SELECT string_agg(share_id || ''/'' || conversation_id || ''/'' || bank_code, '','')'
      || ' FROM my_coordinator_shares()', s1 || '/' || c1::text || '/ADCB');
  n := n + 1; failed := failed || pg_temp.cs_check('my_coordinator_shares() lists a share to someone else',
    'authenticated', u_coord2, 'SELECT count(*)::text FROM my_coordinator_shares()', '0');
  n := n + 1; failed := failed || pg_temp.cs_check('anon could call my_coordinator_shares()',
    'anon', NULL, 'SELECT count(*)::text FROM my_coordinator_shares()', 'ERROR 42501 %');

  -- ---------- 4. the coordinator's reply ----------
  n := n + 1; failed := failed || pg_temp.cs_check('the coordinator could not reply on the shared chat''s number',
    'authenticated', u_coord, format('INSERT INTO messages (conversation_id, sender_type, sender_id, content_text,'
      || ' channel_id, provider) VALUES (%L, ''agent'', %L, ''coordinator reply'', %L, ''whapi'')', c1, u_coord, wa), 'ok');
  n := n + 1; failed := failed || pg_temp.cs_check('the coordinator''s reply was not stored or not visible to them',
    'authenticated', u_coord, q_msgs, '2');
  n := n + 1; failed := failed || pg_temp.cs_check('the coordinator could reply on another number',
    'authenticated', u_coord, format('INSERT INTO messages (conversation_id, sender_type, sender_id, content_text,'
      || ' channel_id, provider) VALUES (%L, ''agent'', %L, ''wrong number'', %L, ''whapi'')', c1, u_coord, wa2),
    'ERROR 42501 %');
  n := n + 1; failed := failed || pg_temp.cs_check('the coordinator could reply with no number',
    'authenticated', u_coord, format('INSERT INTO messages (conversation_id, sender_type, sender_id, content_text,'
      || ' provider) VALUES (%L, ''agent'', %L, ''no number'', ''whapi'')', c1, u_coord), 'ERROR 42501 %');
  n := n + 1; failed := failed || pg_temp.cs_check('the coordinator could write a customer message',
    'authenticated', u_coord, format('INSERT INTO messages (conversation_id, sender_type, sender_id, content_text,'
      || ' channel_id, provider) VALUES (%L, ''customer'', NULL, ''forged'', %L, ''whapi'')', c1, wa), 'ERROR %');
  n := n + 1; failed := failed || pg_temp.cs_check('the coordinator could write a message as someone else',
    'authenticated', u_coord, format('INSERT INTO messages (conversation_id, sender_type, sender_id, content_text,'
      || ' channel_id, provider) VALUES (%L, ''agent'', %L, ''as the agent'', %L, ''whapi'')', c1, u_agent, wa),
    'ERROR 42501 %');
  n := n + 1; failed := failed || pg_temp.cs_check('the coordinator could reply on an unshared chat',
    'authenticated', u_coord, format('INSERT INTO messages (conversation_id, sender_type, sender_id, content_text,'
      || ' channel_id, provider) VALUES (%L, ''agent'', %L, ''not shared'', %L, ''whapi'')', c2, u_coord, wa),
    'ERROR 42501 %');
  n := n + 1; failed := failed || pg_temp.cs_check('a refused reply was stored',
    NULL, NULL, format('SELECT count(*)::text FROM messages WHERE sender_id = %L', u_coord), '1');

  -- ---------- 6. the bell, and an idempotent repeat ----------
  n := n + 1; failed := failed || pg_temp.cs_check('sharing did not ring the coordinator once (conversation_shared)',
    NULL, NULL, q_bell, '1');
  n := n + 1; failed := failed || pg_temp.cs_check('the conversation_shared bell does not name the share and bank',
    NULL, NULL, format('SELECT (meta->>''share_id'') || ''/'' || (meta->>''bank_code'') || ''/'' || contact_id::text'
      || ' FROM notifications WHERE user_id = %L AND type = ''conversation_shared''', u_coord), s1 || '/ADCB/' || ca::text);
  r := pg_temp.cs_try('authenticated', u_agent,
    format('SELECT share_conversation_with_coordinator(%L, %L, ''ADCB'')::text', c1, u_coord));
  n := n + 1; failed := failed || pg_temp.cs_ok(r = s1, format('a repeat share did not return the open share (%s, %s)', r, s1));
  n := n + 1; failed := failed || pg_temp.cs_check('a repeat share rang the coordinator again', NULL, NULL, q_bell, '1');
  n := n + 1; failed := failed || pg_temp.cs_check('a repeat share added a share row',
    NULL, NULL, format('SELECT count(*)::text FROM conversation_coordinator_shares WHERE conversation_id = %L', c1), '1');

  -- ---------- 7 and 5. revoke rights; visibility ends on revoke ----------
  n := n + 1; failed := failed || pg_temp.cs_check('an unrelated agent could revoke the share',
    'authenticated', u_other, format('SELECT revoke_conversation_share(%L)::text', s1), 'ERROR 42501 %');
  n := n + 1; failed := failed || pg_temp.cs_check('a refused revoke ended the share',
    'authenticated', u_coord, q_conv, '1');
  n := n + 1; failed := failed || pg_temp.cs_check('the sharer could not revoke the share',
    'authenticated', u_agent, format('SELECT revoke_conversation_share(%L)::text', s1), 'true');
  n := n + 1; failed := failed || pg_temp.cs_check('the coordinator still sees the conversation after revoke',
    'authenticated', u_coord, q_conv, '0');
  n := n + 1; failed := failed || pg_temp.cs_check('the coordinator still sees messages or contact after revoke',
    'authenticated', u_coord, format('SELECT ((SELECT count(*) FROM messages WHERE conversation_id = %L)'
      || ' + (SELECT count(*) FROM contacts WHERE id = %L))::text', c1, ca), '0');
  n := n + 1; failed := failed || pg_temp.cs_check('the coordinator could still reply after revoke',
    'authenticated', u_coord, format('INSERT INTO messages (conversation_id, sender_type, sender_id, content_text,'
      || ' channel_id, provider) VALUES (%L, ''agent'', %L, ''after revoke'', %L, ''whapi'')', c1, u_coord, wa),
    'ERROR 42501 %');

  s2 := pg_temp.cs_try('authenticated', u_agent,
    format('SELECT share_conversation_with_coordinator(%L, %L, ''ADCB'')::text', c1, u_coord));
  n := n + 1; failed := failed || pg_temp.cs_ok(s2 ~ '^[0-9a-f-]{36}$' AND s2 <> s1,
    format('a share after revoke was not a new share (%s)', s2));
  n := n + 1; failed := failed || pg_temp.cs_check('the coordinator does not see the re-shared conversation',
    'authenticated', u_coord, q_conv, '1');
  n := n + 1; failed := failed || pg_temp.cs_check('an admin could not revoke the share',
    'authenticated', u_admin, format('SELECT revoke_conversation_share(%L)::text', s2), 'true');
  n := n + 1; failed := failed || pg_temp.cs_check('the coordinator still sees the conversation after an admin revoke',
    'authenticated', u_coord, q_conv, '0');

  -- ---------- 5. visibility ends when the bank is removed, and on deactivation ----------
  s3 := pg_temp.cs_try('authenticated', u_agent,
    format('SELECT share_conversation_with_coordinator(%L, %L, ''ADCB'')::text', c1, u_coord));
  n := n + 1; failed := failed || pg_temp.cs_ok(s3 ~ '^[0-9a-f-]{36}$', format('the third share failed (%s)', s3));
  n := n + 1; failed := failed || pg_temp.cs_check('the coordinator does not see the third share',
    'authenticated', u_coord, q_conv, '1');
  r := pg_temp.cs_try('authenticated', u_admin, format('SELECT set_coordinator_banks(%L, ''{}'')::text', u_coord));
  n := n + 1; failed := failed || pg_temp.cs_ok(r = '{}', format('the admin could not clear the coordinator''s banks (%s)', r));
  n := n + 1; failed := failed || pg_temp.cs_check('the coordinator still sees the conversation after losing the bank',
    'authenticated', u_coord, q_conv, '0');
  n := n + 1; failed := failed || pg_temp.cs_check('the coordinator still sees messages or contact after losing the bank',
    'authenticated', u_coord, format('SELECT ((SELECT count(*) FROM messages WHERE conversation_id = %L)'
      || ' + (SELECT count(*) FROM contacts WHERE id = %L))::text', c1, ca), '0');
  n := n + 1; failed := failed || pg_temp.cs_check('my_coordinator_shares() still lists the share after the bank was removed',
    'authenticated', u_coord, 'SELECT count(*)::text FROM my_coordinator_shares()', '0');
  r := pg_temp.cs_try('authenticated', u_admin, format('SELECT set_coordinator_banks(%L, ''{ADCB}'')::text', u_coord));
  n := n + 1; failed := failed || pg_temp.cs_check('the still-open share does not grant again once the bank is back',
    'authenticated', u_coord, q_conv, '1');
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_coord;
  n := n + 1; failed := failed || pg_temp.cs_check('a deactivated coordinator still sees the conversation',
    'authenticated', u_coord, q_conv, '0');
  n := n + 1; failed := failed || pg_temp.cs_check('a deactivated coordinator still sees messages or contact',
    'authenticated', u_coord, format('SELECT ((SELECT count(*) FROM messages WHERE conversation_id = %L)'
      || ' + (SELECT count(*) FROM contacts WHERE id = %L))::text', c1, ca), '0');
  -- Deactivation alone, not the share row: the share is still open.
  n := n + 1; failed := failed || pg_temp.cs_check('the third share is not still open',
    NULL, NULL, format('SELECT count(*)::text FROM conversation_coordinator_shares WHERE id = %L AND revoked_at IS NULL', s3),
    '1');

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT130', MESSAGE = 'verify-coordinators rollback';
  EXCEPTION WHEN SQLSTATE 'ZT130' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'coordinators verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'coordinators verification passed (% checks)', n;
END
$verify$;
