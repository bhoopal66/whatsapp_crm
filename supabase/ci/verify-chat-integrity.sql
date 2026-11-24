-- Migration 284: what a signed-in session may write to conversations and
-- messages. Every statement runs as `authenticated` with the person's
-- claims, as PostgREST runs it; fixtures (prefix ci284) are rolled back.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000284001';
  u_agent  UUID := '00000000-0000-4000-8000-000000284002';
  u_agent2 UUID := '00000000-0000-4000-8000-000000284003';  -- has a personal number
  u_lead   UUID := '00000000-0000-4000-8000-000000284004';  -- leads agent and agent2
  u_viewer UUID := '00000000-0000-4000-8000-000000284005';
  u_guest  UUID := '00000000-0000-4000-8000-000000284006';
  u_coord  UUID := '00000000-0000-4000-8000-000000284007';
  u_out    UUID := '00000000-0000-4000-8000-000000284008';  -- agent in no team
  u_other  UUID := '00000000-0000-4000-8000-000000284009';  -- account B
  acct UUID; acct_b UUID; team UUID;
  w1 UUID; w2 UUID; wp UUID;
  c_mine UUID; c_hid UUID; c_free UUID; c_gone UUID; c_team UUID;
  cv UUID; cv_hid UUID; cv_pers UUID; cv_view UUID; cv_free UUID; cv_gone UUID; cv_num UUID;
  m_cust UUID; m_own UUID;
  who RECORD; chk RECORD; r TEXT; n INT := 0; failed TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run p_sql as p_uid's session: 'ok:<rows>', or '<sqlstate>: <message>'.
  -- The statement is undone unless p_keep.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ci284(p_uid uuid, p_sql text, p_keep boolean DEFAULT false)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE k bigint; out text;
    BEGIN
      PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
      PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
      PERFORM set_config('request.jwt.claims',
        json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
      BEGIN
        SET LOCAL ROLE authenticated;
        EXECUTE p_sql;
        GET DIAGNOSTICS k = ROW_COUNT;
        RESET ROLE;
        out := 'ok:' || k;
        IF NOT p_keep THEN RAISE EXCEPTION USING ERRCODE = 'ZU284'; END IF;
      EXCEPTION
        WHEN SQLSTATE 'ZU284' THEN RESET ROLE;
        WHEN OTHERS THEN RESET ROLE; out := SQLSTATE || ': ' || SQLERRM;
      END;
      PERFORM set_config('request.jwt.claim.sub', '', true);
      PERFORM set_config('request.jwt.claim.role', '', true);
      PERFORM set_config('request.jwt.claims', '', true);
      RETURN out;
    END $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'ci284-owner@example.invalid'), (u_agent, 'ci284-agent@example.invalid'),
    (u_agent2, 'ci284-agent2@example.invalid'), (u_lead, 'ci284-lead@example.invalid'),
    (u_viewer, 'ci284-viewer@example.invalid'), (u_guest, 'ci284-guest@example.invalid'),
    (u_coord, 'ci284-coord@example.invalid'), (u_out, 'ci284-out@example.invalid'),
    (u_other, 'ci284-other@example.invalid');
  SELECT account_id INTO acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO acct_b FROM profiles WHERE user_id = u_other;
  UPDATE profiles SET account_id = acct, account_role = 'agent'
   WHERE user_id IN (u_agent, u_agent2, u_coord, u_out);
  UPDATE profiles SET account_id = acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = acct, account_role = 'viewer' WHERE user_id = u_viewer;
  UPDATE profiles SET account_id = acct, account_role = 'bank_guest', bank_code = 'ADCB'
   WHERE user_id = u_guest;
  UPDATE profiles SET may_connect_personal_whatsapp = true WHERE user_id = u_agent2;
  INSERT INTO teams (account_id, name, leader_user_id)
  VALUES (acct, 'CI284 team', u_lead) RETURNING id INTO team;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES
    (team, u_agent, acct), (team, u_agent2, acct);

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, is_primary)
  VALUES (u_owner, acct, 'openwa', 'ci284-a', 't', false) RETURNING id INTO w1;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, is_primary)
  VALUES (u_owner, acct, 'openwa', 'ci284-b', 't', false) RETURNING id INTO w2;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, is_personal)
  VALUES (u_agent2, acct, 'openwa', 'ci284-p', 't', true) RETURNING id INTO wp;

  INSERT INTO contacts (account_id, user_id, phone, name) VALUES
    (acct, u_agent, '971500284001', 'mine') RETURNING id INTO c_mine;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES
    (acct, u_out, '971500284002', 'hidden') RETURNING id INTO c_hid;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES
    (acct, u_agent, '971500284003', 'free') RETURNING id INTO c_free;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES
    (acct, u_agent, '971500284004', 'gone') RETURNING id INTO c_gone;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES
    (acct, u_agent2, '971500284005', 'team') RETURNING id INTO c_team;

  INSERT INTO conversations (account_id, user_id, contact_id, channel_id, unread_count)
  VALUES (acct, u_agent, c_mine, w1, 3) RETURNING id INTO cv;
  INSERT INTO conversations (account_id, user_id, contact_id, channel_id)
  VALUES (acct, u_out, c_hid, w1) RETURNING id INTO cv_hid;
  INSERT INTO conversations (account_id, user_id, contact_id)
  VALUES (acct, u_agent, c_gone) RETURNING id INTO cv_gone;
  INSERT INTO conversations (account_id, user_id, contact_id, channel_id, personal_owner_id)
  VALUES (acct, u_agent2, c_team, wp, u_agent2) RETURNING id INTO cv_pers;
  INSERT INTO conversations (account_id, user_id, contact_id)
  SELECT acct, u_viewer, id FROM contacts WHERE id = c_team RETURNING id INTO cv_view;
  INSERT INTO messages (conversation_id, sender_type, content_text, message_id, status, channel_id)
  VALUES (cv, 'customer', 'what the customer wrote', 'ci284-in', 'delivered', w1) RETURNING id INTO m_cust;
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text, message_id, channel_id)
  VALUES (cv, 'agent', u_agent, 'reply', 'ci284-out', w1) RETURNING id INTO m_own;
  INSERT INTO messages (conversation_id, sender_type, content_text) VALUES (cv_gone, 'customer', 'x');
  INSERT INTO case_banks (account_id, code, name) VALUES (acct, 'ADCB', 'ADCB') ON CONFLICT DO NOTHING;
  INSERT INTO coordinator_banks (account_id, user_id, bank_code)
  VALUES (acct, u_coord, 'ADCB');
  INSERT INTO conversation_coordinator_shares (account_id, conversation_id, coordinator_user_id, bank_code, shared_by)
  SELECT acct, cv, u_coord, 'ADCB', u_agent;

  -- p_want: 'ok:n' exactly, or the start of the refusal.
  FOR chk IN SELECT * FROM (VALUES
    -- What the app does today -----------------------------------
    ('agent opens a company chat', u_agent, format('INSERT INTO conversations (account_id,user_id,contact_id,assigned_agent_id) VALUES (%L,%L,%L,%L) RETURNING id', acct, u_agent, c_free, u_agent), 'ok:1'),
    ('lead opens a company chat', u_lead, format('INSERT INTO conversations (account_id,user_id,contact_id,assigned_agent_id) VALUES (%L,%L,%L,%L) RETURNING id', acct, u_lead, c_free, u_lead), 'ok:1'),
    ('holder opens a personal chat', u_agent2, format('INSERT INTO conversations (account_id,user_id,contact_id,assigned_agent_id,personal_owner_id,channel_id) SELECT %L,%L,id,%L,%L,%L FROM contacts WHERE name=''ci284-new'' RETURNING id', acct, u_agent2, u_agent2, u_agent2, wp), 'ok:1'),
    ('agent sends', u_agent, format('INSERT INTO messages (conversation_id,sender_type,sender_id,content_type,content_text,media_url,template_name,interactive_payload,message_id,status,reply_to_message_id,provider,channel_id,is_forwarded) VALUES (%L,''agent'',%L,''text'',''hi'',NULL,NULL,NULL,''ci284-s1'',''sent'',%L,''openwa'',%L,false) RETURNING *', cv, u_agent, m_cust, w1), 'ok:1'),
    ('agent sends a template', u_agent, format('INSERT INTO messages (conversation_id,sender_type,sender_id,content_type,content_text,template_name,message_id,status,provider,channel_id,is_forwarded) VALUES (%L,''agent'',%L,''template'',''t'',''t1'',''ci284-s2'',''sent'',''meta'',%L,false) RETURNING *', cv, u_agent, w1), 'ok:1'),
    ('agent sends interactive', u_agent, format('INSERT INTO messages (conversation_id,sender_type,sender_id,content_type,content_text,interactive_payload,status) VALUES (%L,''agent'',%L,''interactive'',''t'',''{}'',''sent'') RETURNING *', cv, u_agent), 'ok:1'),
    ('agent forwards a voice note', u_agent, format('INSERT INTO messages (conversation_id,sender_type,sender_id,content_type,media_url,status,is_forwarded) VALUES (%L,''agent'',%L,''audio'',''https://x/a'',''sent'',true) RETURNING *', cv, u_agent), 'ok:1'),
    ('lead sends', u_lead, format('INSERT INTO messages (conversation_id,sender_type,sender_id,content_text) VALUES (%L,''agent'',%L,''hi'') RETURNING *', cv, u_lead), 'ok:1'),
    ('owner sends', u_owner, format('INSERT INTO messages (conversation_id,sender_type,sender_id,content_text) VALUES (%L,''agent'',%L,''hi'') RETURNING *', cv_hid, u_owner), 'ok:1'),
    ('holder sends in the personal chat', u_agent2, format('INSERT INTO messages (conversation_id,sender_type,sender_id,content_text,channel_id) VALUES (%L,''agent'',%L,''hi'',%L) RETURNING *', cv_pers, u_agent2, wp), 'ok:1'),
    ('coordinator sends in the shared chat', u_coord, format('INSERT INTO messages (conversation_id,sender_type,sender_id,content_text,channel_id) VALUES (%L,''agent'',%L,''hi'',%L) RETURNING *', cv, u_coord, w1), 'ok:1'),
    ('agent: last message', u_agent, format('UPDATE conversations SET last_message_text=''hi'',last_message_at=now(),updated_at=now() WHERE id=%L', cv), 'ok:1'),
    ('agent: read state', u_agent, format('UPDATE conversations SET unread_count=0 WHERE id=%L', cv), 'ok:1'),
    ('agent: take the chat', u_agent, format('UPDATE conversations SET assigned_agent_id=%L WHERE id=%L', u_agent, cv), 'ok:1'),
    ('lead: assign to the team', u_lead, format('UPDATE conversations SET assigned_agent_id=%L WHERE id=%L', u_agent2, cv), 'ok:1'),
    ('agent: reopen', u_agent, format('UPDATE conversations SET status=''open'',updated_at=now() WHERE id=%L', cv), 'ok:1'),
    ('agent: pause AI', u_agent, format('UPDATE conversations SET ai_autoreply_disabled=true,ai_attention_at=NULL,ai_paused_reason=''take_over'',ai_paused_at=now(),assigned_agent_id=%L WHERE id=%L', u_agent, cv), 'ok:1'),
    ('agent: resume AI', u_agent, format('UPDATE conversations SET ai_autoreply_disabled=false,ai_attention_at=NULL,assigned_agent_id=NULL,ai_reply_count=0,ai_handoff_summary=NULL,ai_handoff_reason=NULL,ai_paused_reason=NULL,ai_paused_at=NULL,ai_pending_draft=NULL,ai_pending_draft_at=NULL WHERE id=%L', cv), 'ok:1'),
    ('agent: held draft', u_agent, format('UPDATE conversations SET ai_pending_draft=NULL,ai_pending_draft_at=NULL,ai_attention_at=now() WHERE id=%L', cv), 'ok:1'),
    ('agent: chat tags', u_agent, format('UPDATE conversations SET chat_tag_id=NULL,chat_sub_tag_id=NULL WHERE id=%L', cv), 'ok:1'),
    ('agent: record an empty chat''s number', u_agent, format('UPDATE conversations SET channel_id=%L WHERE id=%L AND channel_id IS NULL', w1, cv_gone), 'ok:1'),
    ('agent: number picker', u_agent, format('SELECT set_conversation_send_channel(%L,%L)', cv, w2), 'ok:1'),
    ('agent: number picker, automatic', u_agent, format('SELECT set_conversation_send_channel(%L,NULL)', cv), 'ok:1'),
    ('owner: move the number', u_owner, format('UPDATE conversations SET channel_id=%L WHERE id=%L', w2, cv), 'ok:1'),
    ('owner: clear the number', u_owner, format('UPDATE conversations SET channel_id=NULL WHERE id=%L', cv), 'ok:1'),
    ('agent deletes their contact', u_agent, format('DELETE FROM contacts WHERE id=%L', c_gone), 'ok:1'),
    ('holder reads their chat', u_agent2, format('SELECT 1 FROM conversations WHERE id=%L', cv_pers), 'ok:1'),
    ('viewer reads their chat', u_viewer, format('SELECT 1 FROM conversations WHERE id=%L', cv_view), 'ok:1'),
    ('lead reads the team''s messages', u_lead, format('SELECT 1 FROM messages WHERE conversation_id=%L', cv), 'ok:2'),
    ('coordinator reads the shared messages', u_coord, format('SELECT 1 FROM messages WHERE conversation_id=%L', cv), 'ok:2'),
    -- 1. identity ------------------------------------------------
    ('agent: contact_id', u_agent, format('UPDATE conversations SET contact_id=%L WHERE id=%L', c_hid, cv), '42501: A chat cannot be moved'),
    ('owner: contact_id', u_owner, format('UPDATE conversations SET contact_id=%L WHERE id=%L', c_free, cv), '42501: A chat cannot be moved'),
    ('holder: personal contact_id', u_agent2, format('UPDATE conversations SET contact_id=%L WHERE id=%L', c_hid, cv_pers), '42501: A chat cannot be moved'),
    ('agent: contact_id by upsert', u_agent, format('INSERT INTO conversations (id,account_id,user_id,contact_id) VALUES (%L,%L,%L,%L) ON CONFLICT (id) DO UPDATE SET contact_id=%L', cv, acct, u_agent, c_free, c_hid), '42501: A chat cannot be moved'),
    ('owner: account_id', u_owner, format('UPDATE conversations SET account_id=%L WHERE id=%L', acct_b, cv), '42501: A chat cannot be moved'),
    -- 2. personal chats ------------------------------------------
    ('agent: personal, no number', u_agent, format('INSERT INTO conversations (account_id,user_id,contact_id,personal_owner_id) VALUES (%L,%L,%L,%L)', acct, u_agent, c_free, u_agent), '42501: A personal chat'),
    ('holder: personal, no number', u_agent2, format('INSERT INTO conversations (account_id,user_id,contact_id,personal_owner_id) SELECT %L,%L,id,%L FROM contacts WHERE name=''ci284-new''', acct, u_agent2, u_agent2), '42501: A personal chat'),
    ('agent: personal on a colleague''s number', u_agent, format('INSERT INTO conversations (account_id,user_id,contact_id,personal_owner_id,channel_id) VALUES (%L,%L,%L,%L,%L)', acct, u_agent, c_free, u_agent, wp), '42501: '),
    ('lead: personal for a teammate', u_lead, format('INSERT INTO conversations (account_id,user_id,contact_id,personal_owner_id,channel_id) VALUES (%L,%L,%L,%L,%L)', acct, u_agent2, c_free, u_agent2, wp), '42501: A personal chat'),
    ('viewer opens a chat', u_viewer, format('INSERT INTO conversations (account_id,user_id,contact_id) VALUES (%L,%L,%L)', acct, u_viewer, c_free), '42501: '),
    ('guest opens a chat', u_guest, format('INSERT INTO conversations (account_id,user_id,contact_id) VALUES (%L,%L,%L)', acct, u_guest, c_free), '42501: '),
    -- 3. messages ------------------------------------------------
    ('agent: as the customer', u_agent, format('INSERT INTO messages (conversation_id,sender_type,content_text) VALUES (%L,''customer'',''x'')', cv), '42501: Customer messages'),
    ('agent: as the bot', u_agent, format('INSERT INTO messages (conversation_id,sender_type,content_text) VALUES (%L,''bot'',''x'')', cv), '42501: You can only record'),
    ('agent: as a colleague', u_agent, format('INSERT INTO messages (conversation_id,sender_type,sender_id,content_text) VALUES (%L,''agent'',%L,''x'')', cv, u_agent2), '42501: You can only record'),
    ('owner: as a colleague', u_owner, format('INSERT INTO messages (conversation_id,sender_type,sender_id,content_text) VALUES (%L,''agent'',%L,''x'')', cv, u_agent), '42501: You can only record'),
    ('agent: as nobody', u_agent, format('INSERT INTO messages (conversation_id,sender_type,content_text) VALUES (%L,''agent'',''x'')', cv), '42501: You can only record'),
    ('agent: backdated', u_agent, format('INSERT INTO messages (conversation_id,sender_type,sender_id,content_text,created_at) VALUES (%L,''agent'',%L,''x'',now()-interval ''1 day'')', cv, u_agent), '42501: This message has'),
    ('agent: marked read', u_agent, format('INSERT INTO messages (conversation_id,sender_type,sender_id,content_text,status) VALUES (%L,''agent'',%L,''x'',''read'')', cv, u_agent), '42501: This message has'),
    ('agent: marked as the AI''s', u_agent, format('INSERT INTO messages (conversation_id,sender_type,sender_id,content_text,ai_generated) VALUES (%L,''agent'',%L,''x'',true)', cv, u_agent), '42501: This message has'),
    ('agent: contact cards', u_agent, format('INSERT INTO messages (conversation_id,sender_type,sender_id,content_type,contact_cards) VALUES (%L,''agent'',%L,''contacts'',''[]'')', cv, u_agent), '42501: This message has'),
    ('agent: a chat they cannot see', u_agent, format('INSERT INTO messages (conversation_id,sender_type,sender_id,content_text) VALUES (%L,''agent'',%L,''x'')', cv_hid, u_agent), '42501: '),
    ('agent: a colleague''s personal chat', u_agent, format('INSERT INTO messages (conversation_id,sender_type,sender_id,content_text) VALUES (%L,''agent'',%L,''x'')', cv_pers, u_agent), '42501: '),
    ('coordinator: an unshared chat', u_coord, format('INSERT INTO messages (conversation_id,sender_type,sender_id,content_text,channel_id) VALUES (%L,''agent'',%L,''x'',%L)', cv_hid, u_coord, w1), '42501: '),
    ('viewer: their own chat', u_viewer, format('INSERT INTO messages (conversation_id,sender_type,sender_id,content_text) VALUES (%L,''agent'',%L,''x'')', cv_view, u_viewer), '42501: '),
    ('guest sends', u_guest, format('INSERT INTO messages (conversation_id,sender_type,sender_id,content_text) VALUES (%L,''agent'',%L,''x'')', cv, u_guest), '42501: '),
    ('agent: edit the customer''s message', u_agent, format('UPDATE messages SET content_text=''x'' WHERE id=%L', m_cust), '42501: Messages cannot be changed'),
    ('agent: edit their own', u_agent, format('UPDATE messages SET content_text=''x'' WHERE id=%L', m_own), '42501: Messages cannot be changed'),
    ('owner: edit', u_owner, format('UPDATE messages SET sender_id=%L WHERE id=%L', u_owner, m_own), '42501: Messages cannot be changed'),
    ('agent: move a message', u_agent, format('UPDATE messages SET conversation_id=%L WHERE id=%L', cv_gone, m_cust), '42501: Messages cannot be changed'),
    ('agent: edit by upsert', u_agent, format('INSERT INTO messages (id,conversation_id,sender_type,sender_id,content_text) VALUES (%L,%L,''agent'',%L,''x'') ON CONFLICT (id) DO UPDATE SET content_text=''x''', m_cust, cv, u_agent), '42501: Messages cannot be changed'),
    ('agent: delete the customer''s message', u_agent, format('DELETE FROM messages WHERE id=%L', m_cust), '42501: Messages cannot be changed'),
    ('owner: delete', u_owner, format('DELETE FROM messages WHERE id=%L', m_cust), '42501: Messages cannot be changed'),
    ('guest: delete', u_guest, format('DELETE FROM messages WHERE id=%L', m_cust), '42501: Messages cannot be changed'),
    -- 4. chats are not deleted -----------------------------------
    ('agent: delete a chat', u_agent, format('DELETE FROM conversations WHERE id=%L', cv), '42501: Chats cannot be deleted'),
    ('lead: delete a chat', u_lead, format('DELETE FROM conversations WHERE id=%L', cv), '42501: Chats cannot be deleted'),
    ('owner: delete a chat', u_owner, format('DELETE FROM conversations WHERE id=%L', cv), '42501: Chats cannot be deleted'),
    ('holder: delete a personal chat', u_agent2, format('DELETE FROM conversations WHERE id=%L', cv_pers), '42501: Chats cannot be deleted'),
    -- 5. the number ----------------------------------------------
    ('agent: clear the number', u_agent, format('UPDATE conversations SET channel_id=NULL WHERE id=%L', cv), '42501: Only an admin'),
    ('lead: clear the number', u_lead, format('UPDATE conversations SET channel_id=NULL WHERE id=%L', cv), '42501: Only an admin'),
    ('agent: change the number', u_agent, format('UPDATE conversations SET channel_id=%L WHERE id=%L', w2, cv), '42501: Only an admin'),
    ('holder: clear a personal chat''s number', u_agent2, format('UPDATE conversations SET channel_id=NULL WHERE id=%L', cv_pers), '42501: Only an admin'),
    -- The policies refuse on their own, were the triggers gone.
    ('policies left', u_owner, 'SELECT 1 FROM pg_policies WHERE schemaname=''public'' AND ((tablename=''messages'' AND cmd IN (''ALL'',''UPDATE'',''DELETE'')) OR (tablename=''conversations'' AND cmd IN (''ALL'',''DELETE'')))', 'ok:0')
  ) AS t(label, uid, sql, want)
  LOOP
    IF n = 0 THEN
      INSERT INTO contacts (account_id, user_id, phone, name)
      VALUES (acct, u_agent2, '971500284006', 'ci284-new');
    END IF;
    n := n + 1;
    r := pg_temp.ci284(chk.uid, chk.sql);
    IF (chk.want LIKE 'ok:%' AND r IS DISTINCT FROM chk.want)
       OR (chk.want NOT LIKE 'ok:%' AND position(chk.want IN coalesce(r, '')) <> 1) THEN
      failed := failed || format('%s: wanted [%s], got [%s]', chk.label, chk.want, r);
    END IF;
  END LOOP;

  -- Removing a number (as an agent: their own personal one; as the
  -- owner: a company one) still clears it from its chats and messages,
  -- and deleting a contact still takes its chat and messages.
  r := pg_temp.ci284(u_owner, format('DELETE FROM whatsapp_config WHERE id=%L', w1), true);
  r := r || '/' || (SELECT (channel_id IS NULL)::text FROM conversations WHERE id = cv)
         || '/' || (SELECT (channel_id IS NULL)::text FROM messages WHERE id = m_cust);
  n := n + 1;
  IF r IS DISTINCT FROM 'ok:1/true/true' THEN
    failed := failed || ('owner removes a number: ' || r);
  END IF;
  r := pg_temp.ci284(u_agent2, format('DELETE FROM whatsapp_config WHERE id=%L', wp), true);
  r := r || '/' || (SELECT (channel_id IS NULL)::text FROM conversations WHERE id = cv_pers);
  n := n + 1;
  IF r NOT IN ('ok:1/true', 'ok:0/false') THEN  -- 0 rows: not theirs to delete under RLS
    failed := failed || ('holder removes their number: ' || r);
  END IF;
  r := pg_temp.ci284(u_agent, format('DELETE FROM contacts WHERE id=%L', c_gone), true);
  r := r || '/' || (SELECT count(*) FROM conversations WHERE id = cv_gone)
         || '/' || (SELECT count(*) FROM messages WHERE conversation_id = cv_gone);
  n := n + 1;
  IF r IS DISTINCT FROM 'ok:1/0/0' THEN
    failed := failed || ('contact deletion takes its chat: ' || r);
  END IF;

  -- The service role keeps every write (webhooks, echoes, merges).
  SET LOCAL ROLE service_role;
  UPDATE messages SET status = 'read', content_text = 's' WHERE id = m_own;
  UPDATE conversations SET contact_id = c_free WHERE id = cv;
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at, status)
  VALUES (cv, 'customer', 'in', now() - interval '1 hour', 'delivered');
  DELETE FROM messages WHERE id = m_own;
  DELETE FROM conversations WHERE id = cv;
  RESET ROLE;

  RAISE EXCEPTION USING ERRCODE = 'ZT284', MESSAGE = 'verify-chat-integrity rollback';
  EXCEPTION WHEN SQLSTATE 'ZT284' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'chat integrity verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'chat integrity verification passed (% checks)', n;
END
$verify$;
