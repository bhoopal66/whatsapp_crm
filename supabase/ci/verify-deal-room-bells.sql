-- Behavioural regression suite for migration 274: an inbound deal room
-- message rings the room's live staff and whoever opened it, once while
-- unread; never a guest, a deactivated person, an outsider, for a
-- redelivery, for our own messages, or for a cancelled or closed room.
--
-- ONE statement on purpose (see verify-submission-group-reads.sql); the
-- fixtures are rolled back by a sentinel exception.

DO $verify$
DECLARE
  u_owner   uuid := '00000000-0000-4000-8000-000000274001'; -- opened the room, not in its channel
  u_agent   uuid := '00000000-0000-4000-8000-000000274002'; -- in the channel
  u_gone    uuid := '00000000-0000-4000-8000-000000274003'; -- in the channel, deactivated
  u_guest   uuid := '00000000-0000-4000-8000-000000274004'; -- in the channel, a bank guest
  u_out     uuid := '00000000-0000-4000-8000-000000274005'; -- staff, not in the channel
  u_left    uuid := '00000000-0000-4000-8000-000000274006'; -- an agent who opened the second room and left it
  a_acct    uuid;
  v_contact uuid;
  v_cfg     uuid;
  v_chan    uuid;
  v_chan2   uuid;
  v_room    uuid;
  v_room2   uuid;
  v_biz     uuid;
  who       text;
  n         int := 0;
  failed    text[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.rang(p_room uuid) RETURNS text LANGUAGE sql AS $body$
      SELECT coalesce(string_agg(right(user_id::text, 1), '' ORDER BY user_id), '')
        FROM public.notifications
       WHERE type = 'deal_room_message' AND meta ->> 'room_id' = p_room::text
    $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'drb-owner@example.invalid'), (u_agent, 'drb-agent@example.invalid'),
    (u_gone, 'drb-gone@example.invalid'), (u_guest, 'drb-guest@example.invalid'),
    (u_out, 'drb-out@example.invalid'), (u_left, 'drb-left@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agent, u_gone, u_out, u_left);
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_guest;

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, waba_id, status, is_primary)
  VALUES (u_owner, a_acct, 'meta', 'drb-meta', 'x', 'drb-waba', 'connected', false) RETURNING id INTO v_cfg;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_owner, '+971500002740', 'DRB customer') RETURNING id INTO v_contact;
  INSERT INTO chat_channels (account_id, kind, name, created_by)
  VALUES (a_acct, 'deal_room', 'DRB room', u_owner) RETURNING id INTO v_chan;
  INSERT INTO chat_channels (account_id, kind, name, created_by)
  VALUES (a_acct, 'deal_room', 'DRB room 2', u_left) RETURNING id INTO v_chan2;
  DELETE FROM chat_channel_members WHERE channel_id IN (v_chan, v_chan2);
  INSERT INTO deal_rooms (account_id, channel_id, contact_id, whatsapp_config_id, wa_group_id, subject, status, created_by)
  VALUES (a_acct, v_chan, v_contact, v_cfg, 'drb-group', 'DRB subject', 'open', u_owner) RETURNING id INTO v_room;
  INSERT INTO deal_rooms (account_id, channel_id, contact_id, whatsapp_config_id, wa_group_id, subject, status, created_by)
  VALUES (a_acct, v_chan2, v_contact, v_cfg, 'drb-group-2', 'DRB second', 'open', u_left) RETURNING id INTO v_room2;
  INSERT INTO chat_channel_members (channel_id, user_id)
  VALUES (v_chan, u_agent), (v_chan, u_gone), (v_chan, u_guest), (v_chan2, u_agent);
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_gone;
  INSERT INTO deal_room_participants (room_id, account_id, display_name, role, status)
  VALUES (v_room, a_acct, 'Our number', 'business', 'joined')
  ON CONFLICT DO NOTHING;
  SELECT id INTO v_biz FROM deal_room_participants WHERE room_id = v_room AND role = 'business';

  -- 1. What we send, and an inbound copy of our own number: silent.
  n := n + 1;
  INSERT INTO group_messages (room_id, account_id, direction, type, body, status, wa_message_id)
  VALUES (v_room, a_acct, 'out', 'text', 'ours', 'sent', 'drb-out');
  INSERT INTO group_messages (room_id, account_id, direction, type, body, sender_participant_id, wa_message_id)
  VALUES (v_room, a_acct, 'in', 'text', 'ours', v_biz, 'drb-own');
  who := pg_temp.rang(v_room);
  IF who <> '' THEN failed := array_append(failed, 'our own messages rang ' || who); END IF;

  -- 2. A customer's message: the manager and the live member.
  n := n + 1;
  PERFORM public.deal_room_record_message(a_acct, 'drb-group', 'in', 'text', 'drb-1', '971500002740', 'secret words');
  who := pg_temp.rang(v_room);
  IF who <> '12' THEN failed := array_append(failed, 'a customer message rang ' || who); END IF;

  -- 3. It names the room, never the words, and opens it.
  n := n + 1;
  IF EXISTS (SELECT 1 FROM notifications x WHERE x.type = 'deal_room_message' AND x.meta ->> 'room_id' = v_room::text
               AND (x.body IS DISTINCT FROM 'DRB subject' OR x.title ~ 'secret'
                    OR public.push_bell_url(x) IS DISTINCT FROM '/chat/rooms/' || v_room)) THEN
    failed := array_append(failed, 'the bell does not name and open its room');
  END IF;

  -- 4. A second message, and a redelivery, add nothing while unread.
  n := n + 1;
  PERFORM public.deal_room_record_message(a_acct, 'drb-group', 'in', 'text', 'drb-2', '971500002741', 'two');
  PERFORM public.deal_room_record_message(a_acct, 'drb-group', 'in', 'text', 'drb-1', '971500002740', 'secret words');
  who := pg_temp.rang(v_room);
  IF who <> '12' THEN failed := array_append(failed, 'more while unread rang ' || who); END IF;

  -- 5. Read by one: the next rings that one only; a redelivery nobody.
  n := n + 1;
  UPDATE notifications SET read_at = now() WHERE user_id = u_agent AND type = 'deal_room_message';
  PERFORM public.deal_room_record_message(a_acct, 'drb-group', 'in', 'text', 'drb-1', '971500002740', 'secret words');
  who := pg_temp.rang(v_room);
  IF who <> '12' THEN failed := array_append(failed, 'a redelivery after reading rang ' || who); END IF;
  PERFORM public.deal_room_record_message(a_acct, 'drb-group', 'in', 'text', 'drb-3', '971500002740', 'three');
  who := pg_temp.rang(v_room);
  IF who <> '122' THEN failed := array_append(failed, 'after reading rang ' || who); END IF;

  -- 6. Another room rings on its own; its agent creator, no longer in the
  -- channel, is not told of a room they cannot open.
  n := n + 1;
  PERFORM public.deal_room_record_message(a_acct, 'drb-group-2', 'in', 'text', 'drb-4', '971500002740', 'four');
  who := pg_temp.rang(v_room2);
  IF who <> '2' THEN failed := array_append(failed, 'the other room rang ' || who); END IF;

  -- 7. Cancelled or closed: recorded, silent.
  n := n + 1;
  UPDATE notifications SET read_at = now() WHERE type = 'deal_room_message';
  UPDATE deal_rooms SET status = 'failed' WHERE id = v_room2;
  INSERT INTO group_messages (room_id, account_id, direction, type, body, wa_message_id)
  VALUES (v_room2, a_acct, 'in', 'text', 'late', 'drb-5');
  UPDATE deal_rooms SET status = 'closed' WHERE id = v_room;
  INSERT INTO group_messages (room_id, account_id, direction, type, body, wa_message_id)
  VALUES (v_room, a_acct, 'in', 'text', 'late', 'drb-6');
  IF pg_temp.rang(v_room2) <> '2' OR pg_temp.rang(v_room) <> '122' THEN
    failed := array_append(failed, 'a cancelled or closed room rang');
  END IF;

  -- 8. No client can call it.
  n := n + 1;
  IF has_function_privilege('anon', 'public.deal_room_ring_message()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.deal_room_ring_message()', 'EXECUTE') THEN
    failed := array_append(failed, 'a client may execute the trigger function');
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZT274', MESSAGE = 'verify-deal-room-bells rollback';
  EXCEPTION WHEN SQLSTATE 'ZT274' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'deal room bells verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'deal room bells verification passed (% checks)', n;
END
$verify$;
