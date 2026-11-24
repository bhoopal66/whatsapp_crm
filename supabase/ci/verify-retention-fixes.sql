-- Migration 282: an applied sweep lists the files nothing else points at
-- (never a shared one) where the erase's retry finds them, works in slices
-- that say whether more is left, and a failure leaves a row and one bell.
-- ONE statement on purpose (see verify-privacy.sql); fixtures are rolled back.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000282001';
  u_admin UUID := '00000000-0000-4000-8000-000000282002';
  u_agent UUID := '00000000-0000-4000-8000-000000282003';
  a       UUID;
  c       UUID;
  v       UUID;
  chan    UUID;
  room    UUID;
  grp     UUID;
  cfg     UUID;
  pre     TEXT;
  rang    BOOLEAN;
  again   BOOLEAN;
  j       JSONB;
  ids     BIGINT[];
  want    JSONB;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  BEGIN
  INSERT INTO auth.users (id, email) VALUES (u_owner, 'rf282-owner@example.invalid'),
    (u_admin, 'rf282-admin@example.invalid'), (u_agent, 'rf282-agent@example.invalid') ON CONFLICT DO NOTHING;
  SELECT account_id INTO a FROM profiles WHERE user_id = u_owner;
  UPDATE profiles SET account_id = a, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a, account_role = 'agent' WHERE user_id = u_agent;
  pre := 'https://x.invalid/storage/v1/object/public/chat-media/account-' || a || '/';
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a, u_agent, '971500282001', 'RF') RETURNING id INTO c;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a, u_agent, c) RETURNING id INTO v;
  -- A 1:1 chat still shows shared.jpg.
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_type, media_url)
  VALUES (v, 'agent', u_agent, 'image', pre || 'shared.jpg');
  INSERT INTO chat_channels (account_id, kind, name, created_by) VALUES (a, 'deal_room', 'rf282-room', u_admin) RETURNING id INTO chan;
  INSERT INTO deal_rooms (account_id, channel_id, contact_id, subject, status) VALUES (a, chan, c, 'RF room', 'creating') RETURNING id INTO room;
  INSERT INTO group_messages (account_id, room_id, direction, status, type, media, body, created_at) VALUES
    (a, room, 'out', 'sent', 'image', jsonb_build_object('storage_path', format('account-%s/room/one.pdf', a)), 'old', now() - interval '400 days'),
    (a, room, 'out', 'sent', 'image', jsonb_build_object('storage_path', format('account-%s/room/filed.pdf', a)), 'old', now() - interval '400 days');
  INSERT INTO deal_files (account_id, room_id, storage_path, name, source)
  VALUES (a, room, format('account-%s/room/filed.pdf', a), 'filed.pdf', 'deal_room_media');
  INSERT INTO whatsapp_config (account_id, user_id, phone_number_id, access_token) VALUES (a, u_owner, 'rf282', 'x') RETURNING id INTO cfg;
  INSERT INTO whatsapp_groups (account_id, channel_id, wa_group_id, name)
  VALUES (a, cfg, '120363000000282001@g.us', 'RF group') RETURNING id INTO grp;
  INSERT INTO whatsapp_group_messages (account_id, group_id, wa_message_id, direction, type, body, media, created_at)
  SELECT a, grp, 'rf282-' || k, 'in', 'image', 'old', jsonb_build_object('link', l), now() - interval '400 days'
    FROM (VALUES (1, pre || 'passport.jpg'), (2, pre || 'shared.jpg'), (3, 'https://gateway.invalid/x.jpg'),
                 (4, pre || 'photo.png?x=1')) t(k, l);
  want := (SELECT jsonb_agg(jsonb_build_object('bucket', b, 'path', 'account-' || a || '/' || p) ORDER BY b, p)
             FROM (VALUES ('chat-media', 'passport.jpg'), ('chat-media', 'photo.png'), ('deal-files', 'room/one.pdf')) t(b, p));

  PERFORM privacy_retention_set(u_owner, a, '{"tables": {"deal_room_messages": {"days": 365, "action": "anonymise"},
    "whatsapp_group_messages": {"days": 365, "action": "delete"}}}', false);
  -- Dry run: everything counted whatever the limit, no list, nothing changed.
  j := privacy_retention_sweep(a, NULL, 1);
  n := n + 1; IF (j ->> 'mode' = 'dry_run' AND (j -> 'tables' -> 'whatsapp_group_messages' ->> 'rows')::int = 4
      AND (j ->> 'objects')::int = 3 AND j ->> 'more' = 'false'
      AND (SELECT count(*) FROM whatsapp_group_messages WHERE group_id = grp AND media IS NOT NULL) = 4
      AND NOT EXISTS (SELECT 1 FROM privacy_requests WHERE account_id = a AND detail ? 'objects_list')) IS NOT TRUE THEN
    failed := array_append(failed, format('the dry run is wrong (%s)', j)); END IF;

  -- Apply, in slices of three.
  PERFORM privacy_retention_set(u_owner, a, (SELECT policy FROM privacy_retention_settings WHERE account_id = a), true);
  j := privacy_retention_sweep(a, NULL, 3);
  n := n + 1; IF (j ->> 'more' = 'true' AND (j -> 'tables' -> 'whatsapp_group_messages' ->> 'rows')::int = 3
      AND (SELECT count(*) FROM whatsapp_group_messages WHERE group_id = grp) = 1) IS NOT TRUE THEN
    failed := array_append(failed, format('a full slice did not say that more is left (%s)', j)); END IF;
  n := n + 1; IF ((privacy_retention_get(u_admin, a) -> 'last_run' ->> 'more') = 'true') IS NOT TRUE THEN
    failed := array_append(failed, 'the last run does not say that more is left'); END IF;
  j := privacy_retention_sweep(a, NULL, 3);
  n := n + 1; IF (j ->> 'more' = 'false' AND (SELECT count(*) FROM whatsapp_group_messages WHERE group_id = grp) = 0
      AND (SELECT count(*) FROM group_messages WHERE room_id = room AND media IS NULL AND body IS NULL) = 2) IS NOT TRUE THEN
    failed := array_append(failed, format('the last slice is wrong (%s)', j)); END IF;
  SELECT privacy_retention_get(u_admin, a) -> 'last_run' INTO j;
  n := n + 1; IF (j ->> 'mode' = 'apply' AND (j ->> 'rows')::int = 6 AND (j ->> 'files')::int = 3) IS NOT TRUE THEN
    failed := array_append(failed, format('the last run does not add up its slices (%s)', j)); END IF;

  -- The files: found by the retry at once, the shared ones not.
  SELECT array_agg(p.request_id), coalesce((SELECT jsonb_agg(e.o ORDER BY e.o ->> 'bucket', e.o ->> 'path')
           FROM privacy_erase_objects_pending(100) q, jsonb_array_elements(q.objects) AS e(o) WHERE q.account_id = a), '[]')
    INTO ids, j FROM privacy_erase_objects_pending(100) p WHERE p.account_id = a;
  n := n + 1; IF j @> want IS NOT TRUE THEN
    failed := array_append(failed, format('the files of the swept messages are not listed for the retry (%s)', j)); END IF;
  n := n + 1; IF (EXISTS (SELECT 1 FROM privacy_requests r, jsonb_array_elements(r.detail -> 'objects_list') AS e(o)
      WHERE r.account_id = a AND (e.o ->> 'path' LIKE '%shared.jpg' OR e.o ->> 'path' LIKE '%filed.pdf'))) THEN
    failed := array_append(failed, 'a file another row points at was listed'); END IF;
  PERFORM privacy_erase_objects_settle(x, '[]') FROM unnest(ids) x;
  n := n + 1; IF EXISTS (SELECT 1 FROM privacy_erase_objects_pending(100) p WHERE p.account_id = a) THEN
    failed := array_append(failed, 'a settled list is still pending'); END IF;

  -- A caller that passes no limit: everything, the list 1000 to a row.
  INSERT INTO whatsapp_group_messages (account_id, group_id, wa_message_id, direction, type, media, created_at)
  SELECT a, grp, 'rf282-b' || k, 'in', 'image', jsonb_build_object('link', pre || 'b' || k || '.jpg'), now() - interval '400 days'
    FROM generate_series(1, 1500) k;
  j := privacy_retention_sweep(a);
  n := n + 1; IF (j ->> 'more' = 'false' AND (j ->> 'objects')::int = 1500
      AND (SELECT array_agg(jsonb_array_length(detail -> 'objects_list') ORDER BY id) FROM privacy_requests
            WHERE account_id = a AND (id = (j ->> 'request_id')::bigint OR detail ->> 'part_of' = j ->> 'request_id'))
          = ARRAY[1000, 500]) IS NOT TRUE THEN
    failed := array_append(failed, format('an unlimited sweep is wrong (%s)', j)); END IF;

  -- A failure: one row, one bell per owner, once a day.
  rang := privacy_retention_failed(a, '57014');
  again := privacy_retention_failed(a, '57014');
  n := n + 1; IF (rang AND NOT again AND (SELECT count(*) FROM privacy_requests WHERE account_id = a AND kind = 'retention_failed' AND detail ->> 'code' = '57014') = 1) IS NOT TRUE THEN
    failed := array_append(failed, 'a failure left no row, or one per try'); END IF;
  n := n + 1; IF ((SELECT array_agg(user_id) FROM notifications WHERE account_id = a AND type = 'retention_failed') = ARRAY[u_owner]
      AND (SELECT push_bell_url(nn) FROM notifications nn WHERE nn.account_id = a AND nn.type = 'retention_failed') = '/settings?tab=privacy') IS NOT TRUE THEN
    failed := array_append(failed, 'a failure did not ring the owner once, with a link to Privacy'); END IF;
  n := n + 1; IF ((privacy_retention_get(u_admin, a) -> 'last_run' ->> 'mode') = 'failed') IS NOT TRUE THEN
    failed := array_append(failed, 'the last run does not show the failure'); END IF;
  n := n + 1; IF (has_function_privilege('authenticated', 'privacy_retention_failed(uuid,text)', 'EXECUTE')
      OR has_function_privilege('authenticated', 'privacy_retention_sweep(uuid,boolean,integer)', 'EXECUTE')
      OR NOT has_function_privilege('service_role', 'privacy_retention_failed(uuid,text)', 'EXECUTE')
      OR to_regprocedure('privacy_retention_sweep(uuid,boolean)') IS NOT NULL) THEN
    failed := array_append(failed, 'the sweep''s grants or overloads are wrong'); END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZT282', MESSAGE = 'rollback';
  EXCEPTION WHEN SQLSTATE 'ZT282' THEN
    NULL;
  END;
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'retention fixes verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'retention fixes verification passed (% checks)', n;
END
$verify$;
