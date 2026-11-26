-- Behavioural regression suite for migration 312: a bank guest's access to a
-- deal room, its chat channel and the people in it ends when the bank's last
-- person leaves or is removed from the WhatsApp group (or the bank is
-- switched off) and is back when one joins again; staff and the other bank's
-- guest are untouched.
--
-- ONE statement on purpose (see verify-submission-group-reads.sql); the
-- fixtures are rolled back by a sentinel exception.

DO $verify$
DECLARE
  u_owner  uuid := '00000000-0000-4000-8000-000000312001';
  u_agent  uuid := '00000000-0000-4000-8000-000000312002'; -- staff, in the room's channel
  u_guest  uuid := '00000000-0000-4000-8000-000000312003'; -- ADCB
  u_other  uuid := '00000000-0000-4000-8000-000000312004'; -- ENBD, its person stays in the group
  u_priv   uuid := '00000000-0000-4000-8000-000000312005'; -- staff, in a private channel with the ADCB guest
  u_out    uuid := '00000000-0000-4000-8000-000000312006'; -- ADCB, not added to the room
  a_acct   uuid;
  v_contact uuid;
  v_cfg    uuid;
  v_chan   uuid;
  v_priv   uuid;
  v_room   uuid;
  v_all    text;   -- what the guest sees with access
  v_none   text;   -- and without
  r        text;
  n        int := 0;
  failed   text[] := '{}';
BEGIN
  BEGIN
  -- A statement as p_role (a signed-in user when p_uid is given): a SELECT's
  -- value, 'ok', or 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.gae(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', p_role)::text, true);
        EXECUTE format('SET LOCAL ROLE %I', p_role);
        IF p_sql ~* '^\s*select' THEN
          EXECUTE p_sql INTO v;
        ELSE
          EXECUTE p_sql;
        END IF;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(v, 'NULL');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;
  -- Everything a login sees of the room, in one line.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.gae_sees(p_uid uuid, p_room uuid, p_chan uuid, p_acct uuid)
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.gae('authenticated', p_uid, format($q$
        SELECT concat_ws(' ', 'access=' || coalesce(public.deal_room_access(%1$L), '-'),
          'since=' || (public.deal_room_visible_since(%1$L) IS NOT NULL),
          'post=' || public.deal_room_can_post(%1$L),
          'rooms=' || (SELECT count(*) FROM public.deal_room_guest_rooms WHERE id = %1$L),
          'roster=' || (SELECT count(*) FROM public.deal_room_roster WHERE room_id = %1$L),
          'messages=' || (SELECT count(*) FROM public.group_messages WHERE room_id = %1$L),
          'channel=' || (SELECT count(*) FROM public.chat_channels WHERE id = %2$L),
          'members=' || (SELECT count(*) FROM public.chat_channel_members WHERE channel_id = %2$L),
          'people=' || (SELECT coalesce(string_agg(right(user_id::text, 1), '' ORDER BY user_id), '')
                          FROM public.chat_people(%3$L)))$q$, p_room, p_chan, p_acct))
    $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.gae_event(p_acct uuid, p_phone text, p_event text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.gae('service_role', NULL,
        format('SELECT public.deal_room_participant_event(%L, %L, %L, %L)', p_acct, 'gae-group', p_phone, p_event))
    $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'gae-owner@example.invalid'), (u_agent, 'gae-agent@example.invalid'),
    (u_guest, 'gae-guest@example.invalid'), (u_other, 'gae-other@example.invalid'),
    (u_priv, 'gae-priv@example.invalid'), (u_out, 'gae-out@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  UPDATE accounts SET internal_chat_enabled = true WHERE id = a_acct;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agent, u_priv);
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id IN (u_guest, u_out);
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ENBD' WHERE user_id = u_other;
  INSERT INTO bank_guest_policies (account_id, bank_code, guests_allowed, dsa_checked_by, dsa_checked_at)
  VALUES (a_acct, 'ADCB', true, u_owner, now()), (a_acct, 'ENBD', true, u_owner, now());

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, waba_id, status, is_primary)
  VALUES (u_owner, a_acct, 'meta', 'gae-meta', 'x', 'gae-waba', 'connected', false) RETURNING id INTO v_cfg;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_owner, '+971500003120', 'GAE customer') RETURNING id INTO v_contact;
  INSERT INTO chat_channels (account_id, kind, name, created_by)
  VALUES (a_acct, 'deal_room', 'GAE room', u_owner) RETURNING id INTO v_chan;
  INSERT INTO chat_channels (account_id, kind, name, created_by)
  VALUES (a_acct, 'private', 'GAE private', u_owner) RETURNING id INTO v_priv;
  DELETE FROM chat_channel_members WHERE channel_id IN (v_chan, v_priv);
  INSERT INTO deal_rooms (account_id, channel_id, contact_id, whatsapp_config_id, wa_group_id, subject, status, created_by)
  VALUES (a_acct, v_chan, v_contact, v_cfg, 'gae-group', 'GAE subject', 'open', u_owner) RETURNING id INTO v_room;
  INSERT INTO chat_channel_members (channel_id, user_id, role) VALUES
    (v_chan, u_agent, 'member'), (v_chan, u_guest, 'guest'), (v_chan, u_other, 'guest');
  INSERT INTO deal_room_participants (room_id, account_id, display_name, phone, role, bank_code, status) VALUES
    (v_room, a_acct, 'ADCB officer', '971500003121', 'bank_guest', 'ADCB', 'invited'),
    (v_room, a_acct, 'ENBD officer', '971500003122', 'bank_guest', 'ENBD', 'joined');
  INSERT INTO group_messages (room_id, account_id, direction, type, body, status, wa_message_id)
  VALUES (v_room, a_acct, 'out', 'text', 'one', 'sent', 'gae-1');

  v_all  := 'access=guest since=true post=true rooms=1 roster=2 messages=1 channel=1 members=3 people=234';
  v_none := 'since=false post=false rooms=0 roster=0 messages=0 channel=0 members=0 people=';

  -- 1. An invited person of the bank counts, as before.
  n := n + 1;
  r := pg_temp.gae_sees(u_guest, v_room, v_chan, a_acct);
  IF r IS DISTINCT FROM v_all THEN failed := array_append(failed, 'invited: ' || r); END IF;

  -- 2. So does a joined one.
  n := n + 1;
  r := pg_temp.gae_event(a_acct, '971500003121', 'joined') || ' ' || pg_temp.gae_sees(u_guest, v_room, v_chan, a_acct);
  IF r IS DISTINCT FROM 'joined ' || v_all THEN failed := array_append(failed, 'joined: ' || r); END IF;

  -- 3. Left: nothing of the room, its channel or its people; a new message
  -- and the login's own person list stay closed too.
  n := n + 1;
  r := pg_temp.gae_event(a_acct, '971500003121', 'left');
  INSERT INTO group_messages (room_id, account_id, direction, type, body, status, wa_message_id)
  VALUES (v_room, a_acct, 'out', 'text', 'two', 'sent', 'gae-2');
  r := r || ' ' || pg_temp.gae_sees(u_guest, v_room, v_chan, a_acct);
  IF r IS DISTINCT FROM 'left access=- ' || v_none THEN failed := array_append(failed, 'left: ' || r); END IF;
  -- The channel itself would not answer either: no bell or push passes.
  n := n + 1;
  IF public.chat_user_can_read_channel(v_chan, u_guest, false) THEN
    failed := array_append(failed, 'left: chat_user_can_read_channel still true'::text);
  END IF;

  -- 4. The other bank's guest and the staff member keep all of it.
  n := n + 1;
  r := pg_temp.gae_sees(u_other, v_room, v_chan, a_acct);
  IF r IS DISTINCT FROM 'access=guest since=true post=true rooms=1 roster=2 messages=2 channel=1 members=3 people=234' THEN
    failed := array_append(failed, 'the other bank: ' || r);
  END IF;
  n := n + 1;
  r := pg_temp.gae_sees(u_agent, v_room, v_chan, a_acct);
  IF r IS DISTINCT FROM 'access=staff since=true post=true rooms=0 roster=2 messages=2 channel=1 members=3 people=123456' THEN
    failed := array_append(failed, 'the staff member: ' || r);
  END IF;

  -- 5. A login of that bank is not added to a room it could not read.
  n := n + 1;
  r := pg_temp.gae('authenticated', u_owner, format('SELECT public.deal_room_add_guest_user(%L, %L)', v_room, u_out));
  IF r NOT LIKE 'ERROR 22023: deal rooms: this room has no approved ADCB participant%' THEN
    failed := array_append(failed, 'adding a login after the bank left: ' || r);
  END IF;

  -- 6. Joined again: back.
  n := n + 1;
  r := pg_temp.gae_event(a_acct, '971500003121', 'joined') || ' ' || pg_temp.gae_sees(u_guest, v_room, v_chan, a_acct);
  IF r IS DISTINCT FROM 'joined ' || replace(v_all, 'messages=1', 'messages=2') THEN
    failed := array_append(failed, 'joined again: ' || r);
  END IF;

  -- 7. A second person of the bank keeps it open when the first leaves.
  n := n + 1;
  INSERT INTO deal_room_participants (room_id, account_id, display_name, phone, role, bank_code, status)
  VALUES (v_room, a_acct, 'ADCB second', '971500003123', 'bank_guest', 'ADCB', 'joined');
  r := pg_temp.gae_event(a_acct, '971500003121', 'left') || ' ' || pg_temp.gae_sees(u_guest, v_room, v_chan, a_acct);
  IF r NOT LIKE 'left access=guest % channel=1 members=3 people=234' THEN
    failed := array_append(failed, 'one of two left: ' || r);
  END IF;

  -- 8. Removed ends it; a private channel the guest is in stays, and the
  -- people in it (not the room's).
  n := n + 1;
  INSERT INTO chat_channel_members (channel_id, user_id, role) VALUES (v_priv, u_priv, 'member'), (v_priv, u_guest, 'guest');
  r := pg_temp.gae_event(a_acct, '971500003123', 'removed') || ' ' || pg_temp.gae_sees(u_guest, v_room, v_chan, a_acct)
       || ' private=' || pg_temp.gae('authenticated', u_guest, format('SELECT count(*) FROM public.chat_channels WHERE id = %L', v_priv));
  IF r IS DISTINCT FROM 'removed access=- ' || v_none || '35 private=1' THEN
    failed := array_append(failed, 'removed: ' || r);
  END IF;

  -- 9. The bank switched off: the same, with its person in the group.
  n := n + 1;
  PERFORM pg_temp.gae_event(a_acct, '971500003121', 'joined');
  UPDATE bank_guest_policies SET guests_allowed = false WHERE account_id = a_acct AND bank_code = 'ADCB';
  r := pg_temp.gae_sees(u_guest, v_room, v_chan, a_acct);
  IF r IS DISTINCT FROM 'access=- ' || v_none || '35' THEN failed := array_append(failed, 'bank switched off: ' || r); END IF;

  -- 10. The rule is for the definer functions only.
  n := n + 1;
  IF has_function_privilege('authenticated', 'public.deal_room_open_to_guest(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.deal_room_open_to_guest(uuid,uuid)', 'EXECUTE') THEN
    failed := array_append(failed, 'a client may call deal_room_open_to_guest'::text);
  END IF;

  IF array_length(failed, 1) IS NOT NULL THEN
    RAISE EXCEPTION E'guest access ends: % of % checks failed:\n%', array_length(failed, 1), n, array_to_string(failed, E'\n');
  END IF;
  RAISE EXCEPTION 'gae_rollback' USING ERRCODE = 'ZZ312';
  EXCEPTION WHEN SQLSTATE 'ZZ312' THEN
    RAISE NOTICE 'guest access ends: % checks passed', n;
  END;
END $verify$;
