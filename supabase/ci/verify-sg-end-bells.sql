-- Migration 313: at the end of a submission group the unread bell of an
-- agent who loses it opens the customer (who may see them) or is read (who
-- may not); a coordinator's stays with the group. Rolled back.
BEGIN;
DO $$
DECLARE
  u_owner uuid := '00000000-0000-4000-8000-000000313001';
  u_sees  uuid := '00000000-0000-4000-8000-000000313002';
  u_blind uuid := '00000000-0000-4000-8000-000000313003';
  u_coord uuid := '00000000-0000-4000-8000-000000313004';
  a uuid; w uuid; c uuid; g uuid; g2 uuid; acc jsonb; r text;
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'seb-owner@example.invalid'), (u_sees, 'seb-sees@example.invalid'),
    (u_blind, 'seb-blind@example.invalid'), (u_coord, 'seb-coord@example.invalid');
  SELECT account_id INTO a FROM profiles WHERE user_id = u_owner;
  UPDATE profiles SET account_id = a, account_role = 'agent' WHERE user_id IN (u_sees, u_blind, u_coord);
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a, 'whapi', 'SEB-313', 'x', 'connected', true) RETURNING id INTO w;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a, u_owner, '971500313001', 'SEB') RETURNING id INTO c;
  INSERT INTO conversations (account_id, user_id, contact_id, channel_id, assigned_agent_id) VALUES (a, u_owner, c, w, u_sees);
  acc := jsonb_build_array(jsonb_build_object('user_id', u_sees, 'label', 'agent'),
                           jsonb_build_object('user_id', u_blind, 'label', 'agent'),
                           jsonb_build_object('user_id', u_coord, 'label', 'coordinator'));
  g := (SELECT o.group_id FROM sg_open(a, 'SEB-1', c, w, 's', NULL, acc, NULL, 'group') o);
  PERFORM sg_attach_wa_group(g, '120363000000313001@g.us', NULL, sg_claim_create(g, 60000));
  g2 := (SELECT o.group_id FROM sg_open(a, 'SEB-2', c, w, 's', NULL, acc, NULL, 'group') o);
  PERFORM sg_attach_wa_group(g2, '120363000000313002@g.us', NULL, sg_claim_create(g2, 60000));
  PERFORM sg_record_inbound(g, 'SEB-IN-1', '971500313001', 'customer', 'text', 'q', NULL, now());
  PERFORM sg_record_inbound(g2, 'SEB-IN-2', '971500313001', 'customer', 'text', 'q', NULL, now());
  ASSERT (SELECT count(*) = 6 FROM notifications WHERE account_id = a AND type = 'submission_group_message' AND read_at IS NULL),
    'fixture: the bells';

  ASSERT sg_end(g, 'MANUAL'), 'the group did not end';
  SELECT string_agg(split_part(u.email, '@', 1) || ' ' || public.push_bell_url(n), ', ' ORDER BY u.email) INTO r
    FROM notifications n JOIN auth.users u ON u.id = n.user_id
   WHERE n.type = 'submission_group_message' AND n.read_at IS NULL AND n.meta ->> 'group_id' = g::text;
  ASSERT r = format('seb-coord /submission-groups/%s, seb-sees /contacts/%s', g, c), 'the bells after the end: ' || r;
  ASSERT (SELECT n.contact_id = c AND n.meta -> 'ended' = 'true'::jsonb FROM notifications n
           WHERE n.user_id = u_sees AND n.meta ->> 'group_id' = g::text), 'the bell of who may see the customer';
  -- The other group's bells are not this one's.
  ASSERT (SELECT count(*) = 3 FROM notifications n
           WHERE n.read_at IS NULL AND n.meta ->> 'group_id' = g2::text AND NOT n.meta ? 'ended'), 'another group''s bells changed';
  -- The customer writes on: one unread bell per person still.
  PERFORM sg_record_inbound(g, 'SEB-IN-3', '971500313001', 'customer', 'text', 'q', NULL, now());
  ASSERT (SELECT count(*) = 1 FROM notifications n
           WHERE n.user_id = u_sees AND n.read_at IS NULL AND n.meta ->> 'group_id' = g::text), 'a second bell beside the turned one';
  ASSERT NOT sg_end(g, 'MANUAL'), 'it ended twice';
  ASSERT NOT has_function_privilege('authenticated', 'public.sg_end(uuid, text)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.sg_end(uuid, text)', 'EXECUTE')
     AND has_function_privilege('service_role', 'public.sg_end(uuid, text)', 'EXECUTE'), 'grants';
END $$;
ROLLBACK;
