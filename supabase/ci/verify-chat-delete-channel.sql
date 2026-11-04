-- Behavioural regression suite for the permanent channel delete
-- (migration 172).
--
-- chat_can_delete_channel / chat_delete_channel: a live owner or admin
-- deletes a team or private channel they can read (so not a private
-- channel they are not in); a team leader or coordinator only one they
-- created and can read; a plain agent, viewer and bank guest never, even
-- as creator; a DM or deal room never. The confirm name must match
-- exactly. After a delete nothing of the channel remains in any table
-- with an FK to it or its messages, nor in the bell or push queue, its
-- files are unreadable and swept, the audit log keeps its earlier rows
-- and gains a delete_channel row with no message text, and other
-- channels are untouched. Executable by authenticated only.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. Fixtures are
-- rolled back on success too: the block ends by raising a sentinel. A
-- writing RPC's result is assigned first, its effect read in a later
-- statement.

DO $verify$
DECLARE
  u_own UUID := '00000000-0000-4000-8000-000000172101';  -- owner
  u_adm UUID := '00000000-0000-4000-8000-000000172102';  -- admin
  u_tl  UUID := '00000000-0000-4000-8000-000000172103';  -- team leader
  u_tl2 UUID := '00000000-0000-4000-8000-000000172104';  -- team leader
  u_co  UUID := '00000000-0000-4000-8000-000000172105';  -- agent, coordinator
  u_ag  UUID := '00000000-0000-4000-8000-000000172106';  -- plain agent
  u_v   UUID := '00000000-0000-4000-8000-000000172107';  -- viewer
  u_g   UUID := '00000000-0000-4000-8000-000000172108';  -- bank guest
  a     UUID;
  big   UUID;  -- team: carries every kind of row, deleted by the admin
  keep  UUID;  -- team: the same rows, must survive
  own_t UUID;  -- team: deleted by the owner
  arc   UUID;  -- team, archived: deleted by the admin
  tl_p  UUID;  -- private, by u_tl, no admin in it
  tl2_t UUID;  -- team, by u_tl2
  aud   UUID;  -- team, by u_tl, audience excludes him
  co_t  UUID;  -- team, by u_co
  ag_t  UUID;  -- team, created_by a plain agent
  v_t   UUID;  -- team, created_by a viewer
  g_p   UUID;  -- private, created_by the guest, guest a member
  dm    UUID;
  dr    UUID;  -- deal_room channel
  k     UUID;
  cl    UUID;
  m1    UUID;
  m2    UUID;
  m3    UUID;
  mk    UUID;
  ids   UUID[];
  f_big TEXT;
  f_keep TEXT;
  r     TEXT;
  v     INT;
  before_keep INT;
  fks   TEXT;
  j     JSONB;
  can   TEXT := 'SELECT public.chat_can_delete_channel(%L)::text';
  del   TEXT := 'SELECT public.chat_delete_channel(%L, %L)::text';
  mk_ch TEXT := 'SELECT public.chat_create_channel(%L, %L, %L, NULL, %L::uuid[])::text';
  n     INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.tc_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        IF p_role IS NOT NULL THEN
          PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
          PERFORM set_config('request.jwt.claims',
            json_build_object('sub', p_uid, 'role', p_role)::text, true);
          EXECUTE format('SET LOCAL ROLE %I', p_role);
        END IF;
        EXECUTE p_sql INTO v;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(nullif(v, ''), 'ok');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.tc_check(p_name text, p_uid uuid, p_sql text, p_like text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := pg_temp.tc_try(CASE WHEN p_uid IS NULL THEN NULL ELSE 'authenticated' END, p_uid, p_sql);
    BEGIN
      RETURN CASE WHEN v LIKE p_like THEN NULL ELSE p_name || ' (' || v || ')' END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.tc_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  -- Every row hanging off a channel: the messages, what points at them,
  -- what points at the channel, and the bell and push rows.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.tc_rows(p_ch uuid, p_ids uuid[])
    RETURNS integer LANGUAGE sql AS $body$
      SELECT ((SELECT count(*) FROM public.chat_channels WHERE id = p_ch)
        + (SELECT count(*) FROM public.chat_channel_members WHERE channel_id = p_ch)
        + (SELECT count(*) FROM public.internal_messages WHERE channel_id = p_ch OR id = ANY (p_ids))
        + (SELECT count(*) FROM public.internal_message_edits WHERE message_id = ANY (p_ids))
        + (SELECT count(*) FROM public.message_mentions WHERE message_id = ANY (p_ids))
        + (SELECT count(*) FROM public.message_mentions_broadcast WHERE message_id = ANY (p_ids))
        + (SELECT count(*) FROM public.internal_message_reactions WHERE message_id = ANY (p_ids))
        + (SELECT count(*) FROM public.message_pins WHERE channel_id = p_ch OR message_id = ANY (p_ids))
        + (SELECT count(*) FROM public.saved_messages WHERE message_id = ANY (p_ids))
        + (SELECT count(*) FROM public.message_attachments WHERE message_id = ANY (p_ids))
        + (SELECT count(*) FROM public.shared_conversations WHERE message_id = ANY (p_ids))
        + (SELECT count(*) FROM public.shared_calls WHERE message_id = ANY (p_ids))
        + (SELECT count(*) FROM public.chat_notifications WHERE message_id = ANY (p_ids))
        + (SELECT count(*) FROM public.chat_voice_plays WHERE message_id = ANY (p_ids))
        + (SELECT count(*) FROM public.chat_typing WHERE channel_id = p_ch)
        + (SELECT count(*) FROM public.chat_channel_restrictions WHERE channel_id = p_ch)
        + (SELECT count(*) FROM public.chat_channel_teams WHERE channel_id = p_ch)
        + (SELECT count(*) FROM public.notifications WHERE meta->>'channel_id' = p_ch::text)
        + (SELECT count(*) FROM public.push_outbox WHERE channel_id = p_ch OR message_id = ANY (p_ids)))::int
    $body$
  $fn$;
  -- A root, a thread reply and a quote, with one row of every dependant.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.tc_fill(p_ws uuid, p_ch uuid, p_by uuid, p_other uuid, p_conv uuid, p_call uuid, p_team uuid, p_path text)
    RETURNS uuid[] LANGUAGE plpgsql AS $body$
    DECLARE r1 uuid; r2 uuid; r3 uuid;
    BEGIN
      INSERT INTO public.internal_messages (channel_id, account_id, author_id, body)
      VALUES (p_ch, p_ws, p_by, 'tc172 secret words') RETURNING id INTO r1;
      INSERT INTO public.internal_messages (channel_id, account_id, author_id, body, thread_root_id)
      VALUES (p_ch, p_ws, p_by, 'tc172 thread reply', r1) RETURNING id INTO r2;
      INSERT INTO public.internal_messages (channel_id, account_id, author_id, body, reply_to_id)
      VALUES (p_ch, p_ws, p_by, 'tc172 quote', r1) RETURNING id INTO r3;
      INSERT INTO public.internal_message_edits (message_id, previous_body, edited_by) VALUES (r1, 'tc172 old words', p_by);
      INSERT INTO public.message_mentions (message_id, user_id) VALUES (r1, p_other);
      INSERT INTO public.message_mentions_broadcast (message_id, kind) VALUES (r1, 'channel');
      INSERT INTO public.internal_message_reactions (message_id, user_id, emoji) VALUES (r1, p_other, 'ok');
      INSERT INTO public.message_pins (channel_id, message_id, pinned_by) VALUES (p_ch, r1, p_by);
      INSERT INTO public.saved_messages (user_id, message_id) VALUES (p_other, r1);
      INSERT INTO public.message_attachments (message_id, storage_path, name, mime, bytes) VALUES (r1, p_path, 'a.pdf', 'application/pdf', 10);
      INSERT INTO public.shared_conversations (message_id, conversation_id, shared_by, snapshot) VALUES (r1, p_conv, p_by, '{}');
      INSERT INTO public.shared_calls (message_id, call_id, account_id, shared_by) VALUES (r1, p_call, p_ws, p_by);
      INSERT INTO public.chat_notifications (user_id, account_id, message_id, kind) VALUES (p_other, p_ws, r1, 'mention');
      INSERT INTO public.chat_voice_plays (message_id, account_id, user_id) VALUES (r1, p_ws, p_other);
      INSERT INTO public.chat_typing (channel_id, account_id, user_id) VALUES (p_ch, p_ws, p_other);
      INSERT INTO public.chat_channel_restrictions (channel_id, user_id, account_id, until, set_by)
      VALUES (p_ch, p_other, p_ws, now() + interval '1 hour', p_by);
      INSERT INTO public.chat_channel_teams (channel_id, team_id, account_id) VALUES (p_ch, p_team, p_ws);
      INSERT INTO public.push_outbox (user_id, account_id, kind, title, url, channel_id, message_id)
      VALUES (p_other, p_ws, 'chat_message', 't', '/chat/x', p_ch, r1);
      RETURN ARRAY[r1, r2, r3];
    END $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_own, 'ci-del-own@example.invalid'), (u_adm, 'ci-del-adm@example.invalid'),
    (u_tl, 'ci-del-tl@example.invalid'), (u_tl2, 'ci-del-tl2@example.invalid'),
    (u_co, 'ci-del-co@example.invalid'), (u_ag, 'ci-del-ag@example.invalid'),
    (u_v, 'ci-del-v@example.invalid'), (u_g, 'ci-del-g@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a FROM profiles WHERE user_id = u_own;
  IF a IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE accounts SET internal_chat_enabled = true WHERE id = a;
  UPDATE profiles SET account_id = a, account_role = 'admin' WHERE user_id = u_adm;
  UPDATE profiles SET account_id = a, account_role = 'team_leader' WHERE user_id IN (u_tl, u_tl2);
  UPDATE profiles SET account_id = a, account_role = 'agent' WHERE user_id IN (u_co, u_ag);
  UPDATE profiles SET account_id = a, account_role = 'viewer' WHERE user_id = u_v;
  INSERT INTO case_banks (account_id, code, name) VALUES (a, 'ADCB', 'ADCB Bank') ON CONFLICT DO NOTHING;
  INSERT INTO coordinator_banks (account_id, user_id, bank_code) VALUES (a, u_co, 'ADCB') ON CONFLICT DO NOTHING;
  UPDATE profiles SET account_id = a, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_g;

  big   := pg_temp.tc_try('authenticated', u_own, format(mk_ch, a, 'team', 'Del big', ARRAY[u_adm, u_ag]));
  keep  := pg_temp.tc_try('authenticated', u_own, format(mk_ch, a, 'team', 'Del keep', ARRAY[u_adm, u_ag]));
  own_t := pg_temp.tc_try('authenticated', u_own, format(mk_ch, a, 'team', 'Del owner', ARRAY[u_ag]));
  arc   := pg_temp.tc_try('authenticated', u_own, format(mk_ch, a, 'team', 'Del archived', ARRAY[u_ag]));
  tl_p  := pg_temp.tc_try('authenticated', u_tl, format(mk_ch, a, 'private', 'Del tl private', ARRAY[u_ag]));
  tl2_t := pg_temp.tc_try('authenticated', u_tl2, format(mk_ch, a, 'team', 'Del tl2 team', ARRAY[u_tl]));
  aud   := pg_temp.tc_try('authenticated', u_tl, format(mk_ch, a, 'team', 'Del audience', ARRAY[u_ag]));
  co_t  := pg_temp.tc_try('authenticated', u_co, format(mk_ch, a, 'team', 'Del coordinator', ARRAY[u_ag]));
  ag_t  := pg_temp.tc_try('authenticated', u_own, format(mk_ch, a, 'team', 'Del agent', ARRAY[u_ag]));
  v_t   := pg_temp.tc_try('authenticated', u_own, format(mk_ch, a, 'team', 'Del viewer', ARRAY[u_v]));
  g_p   := pg_temp.tc_try('authenticated', u_own, format(mk_ch, a, 'private', 'Del guest', ARRAY[u_ag]));
  dm    := pg_temp.tc_try('authenticated', u_tl, format('SELECT public.chat_open_dm(%L, %L::uuid[])::text', a, ARRAY[u_ag]));
  UPDATE chat_channels SET created_by = u_ag WHERE id = ag_t;
  UPDATE chat_channels SET created_by = u_v WHERE id = v_t;
  UPDATE chat_channels SET created_by = u_g WHERE id = g_p;
  UPDATE chat_channels SET archived_at = now() WHERE id = arc;
  UPDATE chat_channels SET audience_team_restricted = true WHERE id = aud;
  INSERT INTO chat_channel_members (channel_id, user_id) VALUES (g_p, u_g);
  INSERT INTO chat_channels (account_id, kind, name, created_by) VALUES (a, 'deal_room', 'Del deal room', u_own) RETURNING id INTO dr;
  INSERT INTO chat_channel_members (channel_id, user_id, role) VALUES (dr, u_own, 'admin');

  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a, u_own, '971500172101', 'Del customer') RETURNING id INTO k;
  INSERT INTO calls (account_id, pbx_call_id, direction, remote_number, user_id, contact_id, status)
  VALUES (a, 'tc172-call-1', 'inbound', '971500172101', u_ag, k, 'answered') RETURNING id INTO cl;
  INSERT INTO teams (account_id, name) VALUES (a, 'Del team') RETURNING id INTO mk;
  f_big := 'account-' || a || '/channel-' || big || '/x-a.pdf';
  f_keep := 'account-' || a || '/channel-' || keep || '/x-a.pdf';
  INSERT INTO storage.objects (bucket_id, name, created_at) VALUES
    ('chat-files', f_big, now() - interval '2 days'), ('chat-files', f_keep, now() - interval '2 days');
  ids := pg_temp.tc_fill(a, big, u_own, u_ag, gen_random_uuid(), cl, mk, f_big);
  m1 := (pg_temp.tc_fill(a, keep, u_own, u_ag, gen_random_uuid(), cl, mk, f_keep))[1];
  before_keep := pg_temp.tc_rows(keep, ARRAY(SELECT id FROM internal_messages WHERE channel_id = keep));
  -- 1 channel, 3 members, 3 messages, 15 dependants, 1 bell
  v := pg_temp.tc_rows(big, ids);
  failed := failed || pg_temp.tc_ok(v = 23, 'fixture: every dependant present, bell included (' || v || ')');
  n := n + 1;
  INSERT INTO chat_audit_log (account_id, actor_id, action, channel_id, detail)
  VALUES (a, u_own, 'update_channel', big, '{"tc":172}') RETURNING id INTO m2;

  -- ---------- who may ----------
  failed := failed || pg_temp.tc_check('owner sees yes', u_own, format(can, own_t), 'true');
  failed := failed || pg_temp.tc_check('admin yes on a team channel', u_adm, format(can, big), 'true');
  failed := failed || pg_temp.tc_check('admin yes on an archived channel', u_adm, format(can, arc), 'true');
  failed := failed || pg_temp.tc_check('admin no on a private channel not joined', u_adm, format(can, tl_p), 'false');
  failed := failed || pg_temp.tc_check('owner no on a private channel not joined', u_own, format(can, tl_p), 'false');
  failed := failed || pg_temp.tc_check('admin refused a private channel not joined', u_adm, format(del, tl_p, 'Del tl private'), 'ERROR 42501: chat_delete_channel: you may not delete%');
  failed := failed || pg_temp.tc_check('team leader no on another''s', u_tl, format(can, tl2_t), 'false');
  failed := failed || pg_temp.tc_check('team leader refused another''s', u_tl, format(del, tl2_t, 'Del tl2 team'), 'ERROR 42501:%');
  failed := failed || pg_temp.tc_check('creator outside the audience no', u_tl, format(can, aud), 'false');
  failed := failed || pg_temp.tc_check('plain agent no on another''s', u_ag, format(can, big), 'false');
  failed := failed || pg_temp.tc_check('plain agent no even as creator', u_ag, format(can, ag_t), 'false');
  failed := failed || pg_temp.tc_check('plain agent refused as creator', u_ag, format(del, ag_t, 'Del agent'), 'ERROR 42501:%');
  failed := failed || pg_temp.tc_check('viewer no even as creator', u_v, format(can, v_t), 'false');
  failed := failed || pg_temp.tc_check('viewer refused as creator', u_v, format(del, v_t, 'Del viewer'), 'ERROR 42501:%');
  failed := failed || pg_temp.tc_check('guest no even as creator', u_g, format(can, g_p), 'false');
  failed := failed || pg_temp.tc_check('guest refused as creator', u_g, format(del, g_p, 'Del guest'), 'ERROR 42501:%');
  failed := failed || pg_temp.tc_check('a DM is refused', u_tl, format(del, dm, ''), 'ERROR 42501:%');
  failed := failed || pg_temp.tc_check('a DM is no', u_tl, format(can, dm), 'false');
  failed := failed || pg_temp.tc_check('a deal room is refused', u_own, format(del, dr, 'Del deal room'), 'ERROR 42501:%');
  failed := failed || pg_temp.tc_check('a deal room is no', u_own, format(can, dr), 'false');
  failed := failed || pg_temp.tc_check('an unknown channel', u_own, format(del, gen_random_uuid(), 'x'), 'ERROR P0002:%');
  failed := failed || pg_temp.tc_ok(
    has_function_privilege('authenticated', 'public.chat_delete_channel(uuid,text)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.chat_can_delete_channel(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('service_role', 'public.chat_delete_channel(uuid,text)', 'EXECUTE')
    AND NOT has_function_privilege('service_role', 'public.chat_can_delete_channel(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.chat_delete_channel(uuid,text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.chat_can_delete_channel(uuid)', 'EXECUTE'), 'grants');
  n := n + 22;

  -- ---------- the confirm name ----------
  failed := failed || pg_temp.tc_check('wrong case refused', u_adm, format(del, big, 'del big'), 'ERROR 22023: chat_delete_channel: the confirmation%');
  failed := failed || pg_temp.tc_check('padded name refused', u_adm, format(del, big, ' Del big'), 'ERROR 22023:%');
  failed := failed || pg_temp.tc_check('NULL name refused', u_adm, format('SELECT public.chat_delete_channel(%L, NULL)::text', big), 'ERROR 22023:%');
  v := pg_temp.tc_rows(big, ids);
  failed := failed || pg_temp.tc_ok(v = 23, 'a refused delete removes nothing (' || v || ')');
  n := n + 4;

  -- ---------- chat switched off ----------
  UPDATE accounts SET internal_chat_enabled = false WHERE id = a;
  failed := failed || pg_temp.tc_check('chat off: CH001', u_adm, format(del, big, 'Del big'), 'ERROR CH001:%');
  failed := failed || pg_temp.tc_check('chat off: no', u_adm, format(can, big), 'false');
  UPDATE accounts SET internal_chat_enabled = true WHERE id = a;
  n := n + 2;

  -- ---------- the deletes ----------
  r := pg_temp.tc_try('authenticated', u_adm, format(del, big, 'Del big'));
  failed := failed || pg_temp.tc_ok(r = 'ok', 'admin deletes a full team channel (' || r || ')');
  v := pg_temp.tc_rows(big, ids);
  failed := failed || pg_temp.tc_ok(v = 0, 'nothing of the channel remains (' || v || ')');
  v := pg_temp.tc_rows(keep, ARRAY(SELECT id FROM internal_messages WHERE channel_id = keep));
  failed := failed || pg_temp.tc_ok(v = before_keep, 'another channel is untouched (' || v || ')');
  n := n + 3;

  r := pg_temp.tc_try('authenticated', u_own, format(del, own_t, 'Del owner'));
  failed := failed || pg_temp.tc_ok(r = 'ok', 'owner deletes (' || r || ')');
  r := pg_temp.tc_try('authenticated', u_adm, format(del, arc, 'Del archived'));
  failed := failed || pg_temp.tc_ok(r = 'ok', 'admin deletes an archived channel (' || r || ')');
  r := pg_temp.tc_try('authenticated', u_tl, format(del, tl_p, 'Del tl private'));
  failed := failed || pg_temp.tc_ok(r = 'ok', 'team leader deletes own (' || r || ')');
  r := pg_temp.tc_try('authenticated', u_co, format(del, co_t, 'Del coordinator'));
  failed := failed || pg_temp.tc_ok(r = 'ok', 'coordinator deletes own (' || r || ')');
  failed := failed || pg_temp.tc_ok(NOT EXISTS (SELECT 1 FROM chat_channels WHERE id IN (own_t, arc, tl_p, co_t)), 'those four are gone');
  failed := failed || pg_temp.tc_ok((SELECT count(*) = 5 FROM chat_channels WHERE id IN (tl2_t, aud, ag_t, v_t, g_p)), 'refused channels remain');
  failed := failed || pg_temp.tc_ok(EXISTS (SELECT 1 FROM chat_channels WHERE id = dm)
    AND EXISTS (SELECT 1 FROM chat_channels WHERE id = dr), 'the DM and deal room remain');
  n := n + 7;

  -- ---------- the audit log ----------
  SELECT detail INTO j FROM chat_audit_log WHERE action = 'delete_channel' AND channel_id = big AND actor_id = u_adm;
  failed := failed || pg_temp.tc_ok(j->>'name' = 'Del big' AND j->>'kind' = 'team'
    AND (j->>'messages')::int = 3 AND (j->>'members')::int = 3, 'audit row: name, kind, counts (' || coalesce(j::text, 'none') || ')');
  failed := failed || pg_temp.tc_ok(j::text !~ 'tc172', 'audit row holds no message text');
  failed := failed || pg_temp.tc_ok((SELECT count(*) = 1 FROM chat_audit_log WHERE action = 'delete_channel' AND account_id = a AND channel_id = big), 'exactly one audit row');
  failed := failed || pg_temp.tc_ok(EXISTS (SELECT 1 FROM chat_audit_log WHERE id = m2 AND channel_id = big AND action = 'update_channel'), 'an earlier audit row survives, id intact');
  failed := failed || pg_temp.tc_check('the log is still append-only', NULL, format('DELETE FROM public.chat_audit_log WHERE id = %L', m2), 'ERROR 42501:%');
  failed := failed || pg_temp.tc_check('edit history is still append-only', NULL, format('DELETE FROM public.internal_message_edits WHERE message_id IN (SELECT id FROM public.internal_messages WHERE channel_id = %L)', keep), 'ERROR 42501:%');
  failed := failed || pg_temp.tc_ok(coalesce(current_setting('chat.erase', true), '') IS DISTINCT FROM 'on', 'chat.erase is off again');
  n := n + 7;

  -- ---------- files ----------
  failed := failed || pg_temp.tc_check('a deleted channel''s file is unreadable', u_own, format('SELECT public.chat_storage_can_read(%L)::text', f_big), 'false');
  failed := failed || pg_temp.tc_ok(f_big = ANY (public.chat_orphan_files(1000)), 'its object is swept');
  failed := failed || pg_temp.tc_ok(NOT f_keep = ANY (public.chat_orphan_files(1000)), 'another channel''s object is not swept');
  n := n + 3;

  -- ---------- a new dependant must join the delete ----------
  SELECT string_agg(x, ',' ORDER BY x) INTO fks FROM (
    SELECT conrelid::regclass::text || '.' || (SELECT attname FROM pg_attribute t WHERE t.attrelid = conrelid AND t.attnum = conkey[1]) AS x
      FROM pg_constraint
     WHERE contype = 'f' AND confrelid IN ('public.chat_channels'::regclass, 'public.internal_messages'::regclass)) y;
  failed := failed || pg_temp.tc_ok(fks =
    'chat_channel_members.channel_id,chat_channel_restrictions.channel_id,chat_channel_teams.channel_id,'
    || 'chat_notifications.message_id,chat_typing.channel_id,chat_voice_plays.message_id,deal_rooms.channel_id,'
    || 'internal_message_edits.message_id,internal_message_reactions.message_id,internal_messages.channel_id,'
    || 'internal_messages.reply_to_id,internal_messages.thread_root_id,message_attachments.message_id,'
    || 'message_mentions.message_id,message_mentions_broadcast.message_id,message_pins.channel_id,'
    || 'message_pins.message_id,saved_messages.message_id,shared_calls.message_id,shared_conversations.message_id',
    'a table with an FK to a channel or message is missing from chat_delete_channel: ' || coalesce(fks, ''));
  n := n + 1;

  RAISE EXCEPTION 'TC_SENTINEL';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'TC_SENTINEL' THEN RAISE; END IF;
  END;
  failed := array_remove(failed, NULL);
  IF cardinality(failed) > 0 THEN
    RAISE EXCEPTION 'verify-chat-delete-channel: % of % failed: %', cardinality(failed), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'verify-chat-delete-channel: % checks passed', n;
END
$verify$;
