-- Behavioural regression suite for web push (migration 109).
--
-- Asserts: no client reads or writes push_outbox, and the dispatcher's
-- functions are the service role's alone; a person sees, adds and
-- removes only their own devices and preferences; push_eligible (every
-- writer's gate) skips a person with no device, push switched off, the
-- kind switched off, or no live profile in the account; a bell row
-- pushes with hrefFor's link, except the four chat_* types, whose
-- message already pushes once; a team-chat message pushes every
-- member who can read it but its author, a muted member only when
-- @mentioned, a bank guest nothing from a deal room's Team notes, and
-- nothing for a system or deleted message; WhatsApp inbound goes to the
-- assignee if live and able to see the chat, else the number's allocated
-- people who can see it, else owners and admins, and never to anyone
-- who cannot see it (can_view_conversation_for_user, which must answer
-- as can_view_conversation does for that person); push_claim /
-- push_settle / push_purge.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.
--
-- The chat trigger is deferred to commit; the suite fires it with
-- SET CONSTRAINTS … IMMEDIATE after each post, then defers it again.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000109001';
  u_admin UUID := '00000000-0000-4000-8000-000000109002';
  u_a     UUID := '00000000-0000-4000-8000-000000109003';   -- author, "PT Alice"
  u_b     UUID := '00000000-0000-4000-8000-000000109004';
  u_m     UUID := '00000000-0000-4000-8000-000000109005';   -- mutes the team channel
  u_c     UUID := '00000000-0000-4000-8000-000000109006';   -- no device
  u_g     UUID := '00000000-0000-4000-8000-000000109007';   -- bank guest
  u_x     UUID := '00000000-0000-4000-8000-000000109008';   -- deactivated
  u_z     UUID := '00000000-0000-4000-8000-000000109009';   -- another workspace
  u_l     UUID := '00000000-0000-4000-8000-000000109010';   -- team leader of u_b
  a_acct  UUID;
  b_acct  UUID;
  ch_team UUID;
  ch_dm   UUID;
  ch_deal UUID;
  msg     UUID;
  root    UUID;
  k1      UUID;
  k2      UUID;
  cv      UUID;
  cv2     UUID;
  t_team  UUID;
  who     UUID;
  chat    UUID;
  w_alloc UUID;
  w_shared UUID;
  wm      UUID;
  ids     BIGINT[];
  r       TEXT;
  b       BOOLEAN;
  i       INT;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (a signed-in user when p_uid is given):
  -- a SELECT's (or WITH's) value, 'ok', or 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.pu_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', p_role)::text, true);
        EXECUTE format('SET LOCAL ROLE %I', p_role);
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
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;
  -- Fire the deferred chat trigger for what was posted so far, then defer it again.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.pu_flush() RETURNS void LANGUAGE plpgsql AS $body$
    BEGIN
      SET CONSTRAINTS public.push_on_chat_message IMMEDIATE;
      SET CONSTRAINTS public.push_on_chat_message DEFERRED;
    END $body$
  $fn$;
  -- Queued rows for a person, of a kind (NULL: any kind).
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.pu_n(p_user uuid, p_kind text) RETURNS int LANGUAGE sql AS $body$
      SELECT count(*)::int FROM public.push_outbox WHERE user_id = p_user AND (p_kind IS NULL OR kind = p_kind)
    $body$
  $fn$;

  -- Fixture: account A (owner, admin, four agents, a bank guest, an
  -- agent deactivated), account B (owner). Everyone but u_c has a device.
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'pu-owner@example.invalid'), (u_admin, 'pu-admin@example.invalid'),
    (u_a, 'pu-a@example.invalid'), (u_b, 'pu-b@example.invalid'), (u_m, 'pu-m@example.invalid'),
    (u_c, 'pu-c@example.invalid'), (u_g, 'pu-g@example.invalid'), (u_x, 'pu-x@example.invalid'),
    (u_z, 'pu-z@example.invalid'), (u_l, 'pu-l@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_z;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_a, u_b, u_m, u_c, u_x);
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_g;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_l;
  UPDATE profiles SET full_name = 'PT Alice' WHERE user_id = u_a;
  INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
  SELECT u, 'https://push.example.invalid/' || u, 'k', 'a'
    FROM unnest(ARRAY[u_owner, u_admin, u_a, u_b, u_m, u_g, u_x, u_z, u_l]) u;
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_x;

  -- ---------- grants and RLS ----------
  r := pg_temp.pu_try('authenticated', u_b, 'SELECT count(*)::text FROM push_outbox');
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN failed := array_append(failed, ('a client read push_outbox: ' || r)::text); END IF;
  r := pg_temp.pu_try('authenticated', u_b, format(
    'INSERT INTO push_outbox (user_id, account_id, kind, title, url) VALUES (%L, %L, %L, %L, %L)', u_b, a_acct, 'x', 'x', '/'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN failed := array_append(failed, ('a client wrote push_outbox: ' || r)::text); END IF;
  n := n + 1;
  IF has_table_privilege('anon', 'public.push_outbox', 'SELECT')
     OR has_table_privilege('anon', 'public.push_subscriptions', 'SELECT')
     OR has_table_privilege('anon', 'public.push_preferences', 'SELECT')
     OR has_table_privilege('authenticated', 'public.push_subscriptions', 'UPDATE')
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'push_outbox')
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.push_outbox'::regclass) THEN
    failed := array_append(failed, 'push tables: anon has access, a client may update a device, or push_outbox has a policy / no RLS'::text);
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY[
                'public.push_enqueue(uuid, uuid, text, text, text, text, text)', 'public.push_whatsapp_inbound(uuid)',
                'public.push_claim(integer)', 'public.push_settle(bigint, boolean, text)', 'public.push_purge()']) f
              WHERE has_function_privilege('authenticated', f, 'EXECUTE')
                 OR has_function_privilege('anon', f, 'EXECUTE')
                 OR NOT has_function_privilege('service_role', f, 'EXECUTE'))
     OR has_function_privilege('authenticated', 'public.push_eligible(uuid, uuid, text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.push_eligible(uuid, uuid, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.can_view_conversation_for_user(uuid, uuid, uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.can_view_conversation_for_user(uuid, uuid, uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.can_view_conversation_for_user(uuid, uuid, uuid, uuid)', 'EXECUTE') THEN
    failed := array_append(failed, 'push functions: not executable by service_role only'::text);
  END IF;

  r := pg_temp.pu_try('authenticated', u_c, format(
    'INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (%L, %L, %L, %L)', u_c, 'https://push.example.invalid/c-own', 'k', 'a'));
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('a person adds their own device: ' || r)::text); END IF;
  r := pg_temp.pu_try('authenticated', u_c, format(
    'INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (%L, %L, %L, %L)', u_b, 'https://push.example.invalid/c-forged', 'k', 'a'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN failed := array_append(failed, ('a person added a device for someone else: ' || r)::text); END IF;
  r := pg_temp.pu_try('authenticated', u_c, 'SELECT count(*)::text FROM push_subscriptions');
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, ('a person sees only their own device (1): ' || r)::text); END IF;
  r := pg_temp.pu_try('authenticated', u_c, format('DELETE FROM push_subscriptions WHERE user_id = %L', u_b));
  n := n + 1;
  IF r <> 'ok' OR NOT EXISTS (SELECT 1 FROM push_subscriptions WHERE user_id = u_b) THEN
    failed := array_append(failed, ('a person removed someone else''s device: ' || r)::text);
  END IF;
  r := pg_temp.pu_try('authenticated', u_c, format('DELETE FROM push_subscriptions WHERE user_id = %L', u_c));
  n := n + 1;
  IF r <> 'ok' OR EXISTS (SELECT 1 FROM push_subscriptions WHERE user_id = u_c) THEN
    failed := array_append(failed, ('a person removes their own device: ' || r)::text);
  END IF;
  r := pg_temp.pu_try('authenticated', u_c, format(
    'INSERT INTO push_preferences (user_id, enabled) VALUES (%L, false)', u_b));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN failed := array_append(failed, ('a person wrote someone else''s preferences: ' || r)::text); END IF;
  r := pg_temp.pu_try('authenticated', u_c, format(
    'INSERT INTO push_preferences (user_id, kinds) VALUES (%L, %L)', u_c, '{"chat_message": false}'));
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('a person saves their own preferences: ' || r)::text); END IF;

  -- ---------- push_eligible / push_enqueue ----------
  n := n + 1;
  IF NOT public.push_enqueue(u_b, a_acct, 'task_assigned', 'T', 'B', '/x', 'tag')
     OR public.push_enqueue(u_c, a_acct, 'task_assigned', 'T', 'B', '/x', 'tag')         -- no device
     OR public.push_enqueue(u_x, a_acct, 'task_assigned', 'T', 'B', '/x', 'tag')         -- deactivated
     OR public.push_enqueue(u_b, b_acct, 'task_assigned', 'T', 'B', '/x', 'tag') THEN    -- not in B
    failed := array_append(failed, 'push_enqueue: queues for a live member with a device only'::text);
  END IF;
  INSERT INTO push_preferences (user_id, kinds) VALUES (u_b, '{"task_assigned": false, "meeting_invite": true}');
  n := n + 1;
  IF public.push_enqueue(u_b, a_acct, 'task_assigned', 'T', 'B', '/x', 'tag')
     OR NOT public.push_enqueue(u_b, a_acct, 'meeting_invite', 'T', 'B', '/x', 'tag')
     OR NOT public.push_enqueue(u_b, a_acct, 'call_missed', 'T', 'B', '/x', 'tag') THEN
    failed := array_append(failed, 'push_enqueue: a kind switched off is skipped, others (and missing keys) are on'::text);
  END IF;
  UPDATE push_preferences SET enabled = false WHERE user_id = u_b;
  n := n + 1;
  IF public.push_enqueue(u_b, a_acct, 'call_missed', 'T', 'B', '/x', 'tag') THEN
    failed := array_append(failed, 'push_enqueue: push switched off still queues'::text);
  END IF;
  DELETE FROM push_preferences WHERE user_id = u_b;
  DELETE FROM push_outbox;

  -- ---------- bell rows ----------
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500109001', 'PT Customer') RETURNING id INTO k1;
  INSERT INTO conversations (account_id, contact_id, user_id) VALUES (a_acct, k1, u_owner) RETURNING id INTO cv;
  INSERT INTO notifications (account_id, user_id, type, conversation_id, title, body)
  VALUES (a_acct, u_b, 'conversation_assigned', cv, 'PT assigned', 'to you');
  INSERT INTO notifications (account_id, user_id, type, title, meta)
  VALUES (a_acct, u_b, 'meeting_invite', 'PT meeting', jsonb_build_object('meeting_id', '00000000-0000-4000-8000-0000001090aa'));
  INSERT INTO notifications (account_id, user_id, type, title)
  VALUES (a_acct, u_b, 'team_activity_alert', 'PT alert'), (a_acct, u_admin, 'team_activity_alert', 'PT alert');
  INSERT INTO notifications (account_id, user_id, type, title, meta)
  VALUES (a_acct, u_b, 'chat_mention', 'PT mention', '{}'), (a_acct, u_b, 'chat_dm', 'PT dm', '{}');
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM push_outbox WHERE user_id = u_b AND kind = 'conversation_assigned'
                    AND title = 'PT assigned' AND body = 'to you' AND url = '/inbox?c=' || cv AND account_id = a_acct)
     OR NOT EXISTS (SELECT 1 FROM push_outbox WHERE user_id = u_b AND kind = 'meeting_invite'
                       AND url = '/meetings/00000000-0000-4000-8000-0000001090aa')
     OR NOT EXISTS (SELECT 1 FROM push_outbox WHERE user_id = u_b AND kind = 'team_activity_alert' AND url = '/notifications')
     OR NOT EXISTS (SELECT 1 FROM push_outbox WHERE user_id = u_admin AND kind = 'team_activity_alert' AND url = '/team-activity') THEN
    failed := array_append(failed, 'a bell row pushes with hrefFor''s link (inbox, meeting, role-gated team activity)'::text);
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM push_outbox WHERE kind LIKE 'chat\_%' AND kind <> 'chat_message') THEN
    failed := array_append(failed, 'a chat_* bell row was pushed (its message already pushes)'::text);
  END IF;
  DELETE FROM push_outbox;

  -- ---------- team chat ----------
  INSERT INTO chat_channels (account_id, kind, name, created_by) VALUES (a_acct, 'team', 'pt-team', u_a) RETURNING id INTO ch_team;
  INSERT INTO chat_channel_members (channel_id, user_id, role, muted) VALUES
    (ch_team, u_a, 'admin', false), (ch_team, u_b, 'member', false), (ch_team, u_m, 'member', true),
    (ch_team, u_c, 'member', false), (ch_team, u_x, 'member', false);

  r := pg_temp.pu_try('authenticated', u_a, format('SELECT public.chat_post_message(%L, %L)::text', ch_team, 'hello team @channel'));
  PERFORM pg_temp.pu_flush();
  n := n + 1;
  IF r LIKE 'ERROR%' THEN
    failed := array_append(failed, ('fixture: post a team message: ' || r)::text);
  ELSE
    msg := r::uuid;
    IF pg_temp.pu_n(u_a, NULL) <> 0 THEN
      failed := array_append(failed, 'chat: the author was pushed their own message'::text);
    END IF;
    n := n + 1;
    IF pg_temp.pu_n(u_m, NULL) <> 0 THEN
      failed := array_append(failed, 'chat: a muted member was pushed a message (even @channel) that does not mention them'::text);
    END IF;
    n := n + 1;
    IF pg_temp.pu_n(u_c, NULL) + pg_temp.pu_n(u_x, NULL) <> 0 THEN
      failed := array_append(failed, 'chat: a member without a device, or deactivated, was queued'::text);
    END IF;
    n := n + 1;
    IF (SELECT count(*) FROM push_outbox) <> 1
       OR NOT EXISTS (SELECT 1 FROM push_outbox WHERE user_id = u_b AND kind = 'chat_message' AND account_id = a_acct
                         AND title = 'PT Alice in #pt-team' AND body = 'hello team @channel'
                         AND url = '/chat/' || ch_team AND tag = 'chat:' || ch_team) THEN
      failed := array_append(failed, 'chat: one push to the other member, titled "<author> in #<channel>", linking the channel'::text);
    END IF;
  END IF;
  DELETE FROM push_outbox;

  r := pg_temp.pu_try('authenticated', u_a, format('SELECT public.chat_post_message(%L, %L, %L::uuid)::text',
         ch_team, 'ping <@' || u_m || '>', msg));
  PERFORM pg_temp.pu_flush();
  n := n + 1;
  IF r LIKE 'ERROR%'
     OR pg_temp.pu_n(u_m, 'chat_message') <> 1 OR pg_temp.pu_n(u_b, 'chat_message') <> 1 OR pg_temp.pu_n(u_a, NULL) <> 0
     OR NOT EXISTS (SELECT 1 FROM push_outbox WHERE user_id = u_m AND url = '/chat/' || ch_team || '?thread=' || msg
                       AND body NOT LIKE '%<@%') THEN
    failed := array_append(failed, ('chat: a muted member is pushed when @mentioned (thread link, mention rendered): ' || r)::text);
  END IF;
  n := n + 1;
  IF (SELECT count(*) FROM push_outbox WHERE user_id = u_m) <> 1 THEN
    failed := array_append(failed, 'chat: the mention''s bell row pushed a second time'::text);
  END IF;
  DELETE FROM push_outbox;

  -- system, deleted before commit, and files-only
  INSERT INTO internal_messages (channel_id, account_id, author_kind, author_id, body)
  VALUES (ch_team, a_acct, 'system', NULL, 'PT system');
  INSERT INTO internal_messages (channel_id, account_id, author_kind, author_id, body)
  VALUES (ch_team, a_acct, 'user', u_a, 'PT gone') RETURNING id INTO msg;
  UPDATE internal_messages SET deleted_at = now() WHERE id = msg;
  PERFORM pg_temp.pu_flush();
  n := n + 1;
  IF EXISTS (SELECT 1 FROM push_outbox) THEN
    failed := array_append(failed, 'chat: a system message or one deleted before commit was pushed'::text);
  END IF;
  INSERT INTO internal_messages (channel_id, account_id, author_kind, author_id, body)
  VALUES (ch_team, a_acct, 'user', u_a, 'a.pdf, b.png') RETURNING id INTO msg;
  INSERT INTO message_attachments (message_id, storage_path, name, mime, bytes) VALUES
    (msg, 'x/a', 'a.pdf', 'application/pdf', 1), (msg, 'x/b', 'b.png', 'image/png', 1);
  INSERT INTO internal_messages (channel_id, account_id, author_kind, author_id, body)
  VALUES (ch_team, a_acct, 'user', u_a, 'see this') RETURNING id INTO root;
  INSERT INTO message_attachments (message_id, storage_path, name, mime, bytes) VALUES (root, 'x/c', 'c.pdf', 'application/pdf', 1);
  PERFORM pg_temp.pu_flush();
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM push_outbox WHERE user_id = u_b AND body = '📎 Attachment')
     OR NOT EXISTS (SELECT 1 FROM push_outbox WHERE user_id = u_b AND body = '📎 see this') THEN
    failed := array_append(failed, 'chat: a files-only post reads "📎 Attachment", text with files "📎 <text>"'::text);
  END IF;
  DELETE FROM push_outbox;

  -- a DM is titled with the author's name
  INSERT INTO chat_channels (account_id, kind, dm_key, created_by) VALUES (a_acct, 'dm', 'pt-dm-key', u_a) RETURNING id INTO ch_dm;
  INSERT INTO chat_channel_members (channel_id, user_id, role) VALUES (ch_dm, u_a, 'member'), (ch_dm, u_b, 'member');
  r := pg_temp.pu_try('authenticated', u_a, format('SELECT public.chat_post_message(%L, %L)::text', ch_dm, 'psst'));
  PERFORM pg_temp.pu_flush();
  n := n + 1;
  IF r LIKE 'ERROR%' OR (SELECT count(*) FROM push_outbox) <> 1
     OR NOT EXISTS (SELECT 1 FROM push_outbox WHERE user_id = u_b AND kind = 'chat_message' AND title = 'PT Alice' AND body = 'psst')
     OR NOT EXISTS (SELECT 1 FROM notifications WHERE user_id = u_b AND type = 'chat_dm' AND meta ->> 'channel_id' = ch_dm::text) THEN
    failed := array_append(failed, ('chat: a DM pushes once (not again for its chat_dm bell), titled with the author: ' || r)::text);
  END IF;
  DELETE FROM push_outbox;

  -- a deal room's Team notes never reach a bank guest
  INSERT INTO chat_channels (account_id, kind, name, created_by) VALUES (a_acct, 'deal_room', 'pt deal', u_owner) RETURNING id INTO ch_deal;
  INSERT INTO chat_channel_members (channel_id, user_id, role) VALUES
    (ch_deal, u_a, 'member'), (ch_deal, u_b, 'member'), (ch_deal, u_g, 'guest');
  INSERT INTO internal_messages (channel_id, account_id, author_kind, author_id, body)
  VALUES (ch_deal, a_acct, 'user', u_a, 'PT notes');
  PERFORM pg_temp.pu_flush();
  n := n + 1;
  IF pg_temp.pu_n(u_g, NULL) <> 0 OR pg_temp.pu_n(u_b, 'chat_message') <> 1 THEN
    failed := array_append(failed, 'chat: deal-room Team notes push staff members but never a bank guest'::text);
  END IF;
  DELETE FROM push_outbox;

  -- ---------- WhatsApp inbound ----------
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'PT-109-ALLOC', 'x', 'connected', true) RETURNING id INTO w_alloc;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'PT-109-SHARED', 'x', 'connected', false) RETURNING id INTO w_shared;
  INSERT INTO whatsapp_channel_members (config_id, user_id, account_id) VALUES (w_alloc, u_m, a_acct), (w_alloc, u_c, a_acct);

  UPDATE conversations SET assigned_agent_id = u_b, channel_id = w_alloc WHERE id = cv;
  DELETE FROM push_outbox;   -- the assignment's own bell
  INSERT INTO messages (conversation_id, sender_type, content_type, content_text)
  VALUES (cv, 'customer', 'text', 'PT hello there') RETURNING id INTO wm;
  i := public.push_whatsapp_inbound(wm);
  n := n + 1;
  IF i <> 1 OR (SELECT count(*) FROM push_outbox) <> 1
     OR NOT EXISTS (SELECT 1 FROM push_outbox WHERE user_id = u_b AND kind = 'whatsapp_message' AND account_id = a_acct
                       AND title = 'PT Customer' AND body = 'PT hello there'
                       AND url = '/inbox?c=' || cv AND tag = 'wa:' || cv) THEN
    failed := array_append(failed, ('whatsapp: an assigned chat pushes its assignee only: ' || i)::text);
  END IF;
  DELETE FROM push_outbox;

  -- u_m is allocated to w_alloc but, since 072, cannot open a chat that
  -- is neither theirs nor assigned to them: the owners and admins hear.
  UPDATE conversations SET assigned_agent_id = NULL WHERE id = cv;
  INSERT INTO messages (conversation_id, sender_type, content_type, content_text)
  VALUES (cv, 'customer', 'image', NULL) RETURNING id INTO wm;
  i := public.push_whatsapp_inbound(wm);
  n := n + 1;
  IF i <> 2 OR pg_temp.pu_n(u_m, NULL) <> 0
     OR NOT EXISTS (SELECT 1 FROM push_outbox WHERE user_id = u_owner AND body = '📷 Photo')
     OR NOT EXISTS (SELECT 1 FROM push_outbox WHERE user_id = u_admin AND body = '📷 Photo') THEN
    failed := array_append(failed, ('whatsapp: an allocated agent who cannot see the chat is not pushed; owners and admins are: ' || i)::text);
  END IF;
  DELETE FROM push_outbox;

  -- u_l leads a team holding u_b, and is allocated to w_alloc too.
  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'PT 109 team', u_l) RETURNING id INTO t_team;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (t_team, u_b, a_acct);
  INSERT INTO whatsapp_channel_members (config_id, user_id, account_id) VALUES (w_alloc, u_l, a_acct);
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_b, '971500109002', 'PT Second') RETURNING id INTO k2;
  INSERT INTO conversations (account_id, contact_id, user_id, channel_id) VALUES (a_acct, k2, u_b, w_alloc) RETURNING id INTO cv2;
  DELETE FROM push_outbox;

  -- The mirror: for each person and chat, the helper answers as
  -- can_view_conversation does when that person asks it themselves.
  UPDATE conversations SET assigned_agent_id = u_m WHERE id = cv;
  FOREACH who IN ARRAY ARRAY[u_owner, u_admin, u_a, u_b, u_m, u_c, u_g, u_x, u_z, u_l] LOOP
    FOREACH chat IN ARRAY ARRAY[cv, cv2] LOOP
      SELECT pg_temp.pu_try('authenticated', who, format(
               'SELECT can_view_conversation(%L, %L, %L, %L, %L)::text',
               cc.account_id, cc.user_id, cc.assigned_agent_id, cc.channel_id, cc.send_channel_id)),
             public.can_view_conversation_for_user(who, cc.account_id, cc.user_id, cc.assigned_agent_id)
        INTO r, b
        FROM conversations cc WHERE cc.id = chat;
      n := n + 1;
      IF r IS DISTINCT FROM b::text THEN
        failed := array_append(failed, format('can_view_conversation_for_user(%s, %s) disagrees with can_view_conversation as that person (%s)', who, chat, r));
      END IF;
    END LOOP;
  END LOOP;
  UPDATE conversations SET assigned_agent_id = NULL WHERE id = cv;
  DELETE FROM push_outbox;

  INSERT INTO messages (conversation_id, sender_type, content_type, content_text)
  VALUES (cv2, 'customer', 'text', 'PT team chat') RETURNING id INTO wm;
  i := public.push_whatsapp_inbound(wm);
  n := n + 1;
  IF i <> 1 OR pg_temp.pu_n(u_l, 'whatsapp_message') <> 1 THEN
    failed := array_append(failed, ('whatsapp: an allocated team leader who can see their member''s unassigned chat is pushed, alone: ' || i)::text);
  END IF;
  DELETE FROM push_outbox;

  -- An assignee who is not live gets nothing; the next tier hears.
  UPDATE conversations SET assigned_agent_id = u_x WHERE id = cv2;
  DELETE FROM push_outbox;
  i := public.push_whatsapp_inbound(wm);
  n := n + 1;
  IF i <> 1 OR pg_temp.pu_n(u_x, NULL) <> 0 OR pg_temp.pu_n(u_l, 'whatsapp_message') <> 1 THEN
    failed := array_append(failed, ('whatsapp: a deactivated assignee falls back to the allocated people who can see the chat: ' || i)::text);
  END IF;
  DELETE FROM push_outbox;

  UPDATE conversations SET assigned_agent_id = u_x WHERE id = cv;
  DELETE FROM push_outbox;
  INSERT INTO messages (conversation_id, sender_type, content_type, content_text)
  VALUES (cv, 'customer', 'text', 'PT to nobody') RETURNING id INTO wm;
  i := public.push_whatsapp_inbound(wm);
  n := n + 1;
  IF i <> 2 OR pg_temp.pu_n(u_x, NULL) + pg_temp.pu_n(u_m, NULL) + pg_temp.pu_n(u_l, NULL) <> 0
     OR pg_temp.pu_n(u_owner, 'whatsapp_message') <> 1 OR pg_temp.pu_n(u_admin, 'whatsapp_message') <> 1 THEN
    failed := array_append(failed, ('whatsapp: a deactivated assignee, with nobody allocated able to see the chat, falls back to owners and admins: ' || i)::text);
  END IF;
  UPDATE conversations SET assigned_agent_id = NULL WHERE id = cv;
  DELETE FROM push_outbox;

  UPDATE conversations SET channel_id = w_shared WHERE id = cv;
  i := public.push_whatsapp_inbound(wm);
  n := n + 1;
  IF i <> 2 OR pg_temp.pu_n(u_owner, 'whatsapp_message') <> 1 OR pg_temp.pu_n(u_admin, 'whatsapp_message') <> 1 THEN
    failed := array_append(failed, ('whatsapp: unassigned on a shared number pushes the owners and admins: ' || i)::text);
  END IF;
  DELETE FROM push_outbox;

  UPDATE conversations SET channel_id = NULL WHERE id = cv;
  i := public.push_whatsapp_inbound(wm);
  n := n + 1;
  IF i <> 2 OR pg_temp.pu_n(u_owner, NULL) <> 1 OR pg_temp.pu_n(u_admin, NULL) <> 1 THEN
    failed := array_append(failed, ('whatsapp: unassigned on no number pushes the owners and admins: ' || i)::text);
  END IF;
  DELETE FROM push_outbox;

  INSERT INTO messages (conversation_id, sender_type, content_type, content_text)
  VALUES (cv, 'agent', 'text', 'PT reply') RETURNING id INTO wm;
  i := public.push_whatsapp_inbound(wm);
  n := n + 1;
  IF i <> 0 OR EXISTS (SELECT 1 FROM push_outbox) THEN
    failed := array_append(failed, ('whatsapp: our own message pushed: ' || i)::text);
  END IF;

  -- ---------- claim / settle / purge ----------
  DELETE FROM push_outbox;
  FOR i IN 1..3 LOOP
    PERFORM public.push_enqueue(u_b, a_acct, 'call_missed', 'T' || i, NULL, '/calls', NULL);
  END LOOP;
  SELECT array_agg(id ORDER BY id) INTO ids FROM public.push_claim(2);
  n := n + 1;
  IF coalesce(array_length(ids, 1), 0) <> 2
     OR EXISTS (SELECT 1 FROM push_outbox WHERE id = ANY (ids) AND (claimed_at IS NULL OR attempts <> 1)) THEN
    failed := array_append(failed, 'push_claim: claims the requested number, stamping claimed_at and attempts'::text);
  END IF;
  n := n + 1;
  IF (SELECT count(*) FROM public.push_claim(10)) <> 1 THEN
    failed := array_append(failed, 'push_claim: a fresh claim was handed out twice'::text);
  END IF;
  PERFORM public.push_settle(ids[1], true, NULL);
  PERFORM public.push_settle(ids[2], false, 'PT 500');
  UPDATE push_outbox SET claimed_at = now() - interval '3 minutes' WHERE id = ANY (ids);
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM push_outbox WHERE id = ids[1] AND sent_at IS NOT NULL)
     OR NOT EXISTS (SELECT 1 FROM push_outbox WHERE id = ids[2] AND sent_at IS NULL AND last_error = 'PT 500')
     OR (SELECT array_agg(id) FROM public.push_claim(10)) IS DISTINCT FROM ARRAY[ids[2]] THEN
    failed := array_append(failed, 'push_settle: a sent row is done; a failed one is retried after the lease'::text);
  END IF;
  UPDATE push_outbox SET created_at = now() - interval '3 days' WHERE id = ids[1];
  i := public.push_purge();
  n := n + 1;
  IF i <> 1 OR EXISTS (SELECT 1 FROM push_outbox WHERE id = ids[1]) THEN
    failed := array_append(failed, 'push_purge: rows older than 2 days go, younger stay'::text);
  END IF;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT109', MESSAGE = 'verify-push rollback';
  EXCEPTION WHEN SQLSTATE 'ZT109' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'push verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'push verification passed (% checks)', n;
END
$verify$;
