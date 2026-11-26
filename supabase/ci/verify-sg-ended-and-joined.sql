-- Migration 308: a hidden number leaving moves 'joined' to 'unknown', due
-- at once; nothing else moves. Rolled back.
BEGIN;
DO $$
DECLARE
  u  uuid := '00000000-0000-4000-8000-000000308001';
  a  uuid; w uuid; c uuid; g uuid; tok uuid;
  stamp timestamptz;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (u, 'sej-a@example.invalid');
  SELECT account_id INTO a FROM profiles WHERE user_id = u;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u, a, 'whapi', 'SEJ-308', 'x', 'connected', true) RETURNING id INTO w;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a, u, '971500308001', 'SEJ') RETURNING id INTO c;
  g := (SELECT x.group_id FROM sg_open(a, 'SEJ-1', c, w, 's', NULL, '[]'::jsonb, NULL, 'group') x);
  tok := sg_claim_create(g, 60000);
  ASSERT sg_attach_wa_group(g, '120363000000308001@g.us', NULL, tok), 'fixture: no WhatsApp group attached';

  PERFORM sg_note_customer_membership(g, 'joined');
  ASSERT NOT EXISTS (SELECT 1 FROM sg_membership_due(a, 10) d(id) WHERE d.id = g), 'a joined group was due';
  ASSERT sg_note_customer_membership(g, 'left_unsure'), 'left_unsure moved nothing';
  ASSERT (SELECT customer_membership = 'unknown' AND customer_checked_at IS NULL
            FROM submission_groups WHERE id = g), 'joined did not become unknown, due a read';
  ASSERT EXISTS (SELECT 1 FROM sg_membership_due(a, 10) d(id) WHERE d.id = g), 'the group is not due a read';

  PERFORM sg_note_customer_membership(g, 'absent');
  SELECT customer_checked_at INTO stamp FROM submission_groups WHERE id = g;
  ASSERT NOT sg_note_customer_membership(g, 'left_unsure'), 'left_unsure moved an absent group';
  ASSERT (SELECT customer_membership = 'absent' AND customer_checked_at = stamp
            FROM submission_groups WHERE id = g), 'left_unsure touched an absent group';

  PERFORM sg_note_customer_membership(g, 'joined');
  PERFORM sg_end(g, 'MANUAL');
  ASSERT NOT sg_note_customer_membership(g, 'left_unsure'), 'an ENDED group was moved';

  BEGIN
    PERFORM sg_note_customer_membership(g, 'left');
    RAISE EXCEPTION 'accepted' USING ERRCODE = 'P0099';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  ASSERT has_function_privilege('service_role', 'public.sg_note_customer_membership(uuid,text)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.sg_note_customer_membership(uuid,text)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.sg_note_customer_membership(uuid,text)', 'EXECUTE'), 'grants';
END $$;
ROLLBACK;

-- A customer's message after the end: who is rung, with what, and how it is
-- cleared. Rolled back.
BEGIN;
CREATE FUNCTION pg_temp.sej_as(p_uid uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    EXECUTE p_sql INTO v;
  EXCEPTION WHEN insufficient_privilege THEN
    v := SQLSTATE;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN coalesce(v, 'NULL');
END $f$;
CREATE FUNCTION pg_temp.sej_rung(p_group uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT coalesce(string_agg(split_part(u.email, '@', 1) || coalesce(':' || n.contact_id, '') || ' ' || public.push_bell_url(n),
                             ', ' ORDER BY u.email), '-')
    FROM public.notifications n JOIN auth.users u ON u.id = n.user_id
   WHERE n.type = 'submission_group_message' AND n.read_at IS NULL
     AND n.meta ->> 'group_id' = p_group::text
$f$;
DO $$
DECLARE
  u_owner uuid := '00000000-0000-4000-8000-000000308011';
  u_admin uuid := '00000000-0000-4000-8000-000000308012';
  u_sees  uuid := '00000000-0000-4000-8000-000000308013'; -- an agent with the customer's chat
  u_blind uuid := '00000000-0000-4000-8000-000000308014'; -- an agent who may not see the customer
  u_coord uuid := '00000000-0000-4000-8000-000000308015';
  u_tl    uuid := '00000000-0000-4000-8000-000000308016'; -- leads u_sees, on the list as an agent
  a uuid; w uuid; c uuid; c2 uuid; g uuid; t uuid; acc jsonb; r text;
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'sej-owner@example.invalid'), (u_admin, 'sej-admin@example.invalid'),
    (u_sees, 'sej-sees@example.invalid'), (u_blind, 'sej-blind@example.invalid'),
    (u_coord, 'sej-coord@example.invalid'), (u_tl, 'sej-tl@example.invalid');
  SELECT account_id INTO a FROM profiles WHERE user_id = u_owner;
  UPDATE profiles SET account_id = a, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a, account_role = 'team_leader' WHERE user_id = u_tl;
  UPDATE profiles SET account_id = a, account_role = 'agent' WHERE user_id IN (u_sees, u_blind, u_coord);
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a, 'whapi', 'SEJ-308B', 'x', 'connected', true) RETURNING id INTO w;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a, u_owner, '971500308011', 'SEJ two') RETURNING id INTO c;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a, u_owner, '971500308012', 'SEJ three') RETURNING id INTO c2;
  INSERT INTO conversations (account_id, user_id, contact_id, channel_id, assigned_agent_id) VALUES (a, u_owner, c, w, u_sees);
  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a, 'SEJ', u_tl) RETURNING id INTO t;
  INSERT INTO team_members (team_id, account_id, user_id) VALUES (t, a, u_sees);

  -- The same answer as the policy the customer page reads through.
  ASSERT sg_user_sees_contact(a, u_sees, c) AND sg_user_sees_contact(a, u_tl, c)
     AND sg_user_sees_contact(a, u_admin, c) AND sg_user_sees_contact(a, u_admin, c2)
     AND NOT sg_user_sees_contact(a, u_blind, c) AND NOT sg_user_sees_contact(a, u_sees, c2)
     AND NOT sg_user_sees_contact(a, u_tl, c2), 'sg_user_sees_contact';
  FOR r IN SELECT 1 FROM unnest(ARRAY[u_owner, u_admin, u_sees, u_blind, u_coord, u_tl]) u, unnest(ARRAY[c, c2]) k
            WHERE (pg_temp.sej_as(u, format('SELECT count(*) FROM contacts WHERE id = %L', k)) = '1')
                  IS DISTINCT FROM sg_user_sees_contact(a, u, k) LOOP
    ASSERT false, 'sg_user_sees_contact differs from the contacts policy';
  END LOOP;
  ASSERT NOT has_function_privilege('authenticated', 'public.sg_user_sees_contact(uuid,uuid,uuid)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.sg_user_sees_contact(uuid,uuid,uuid)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.sg_ring_customer_message()', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.push_bell_url(public.notifications)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.sg_mark_read(uuid)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.sg_mark_read(uuid)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.sg_unread_by_group()', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.sg_unread_by_group()', 'EXECUTE'), 'grants';

  -- 1. A coordinator may read the archive: they are rung with the group, the
  -- agents who may see the customer with the customer, nobody else.
  acc := jsonb_build_array(jsonb_build_object('user_id', u_sees, 'label', 'agent'),
                           jsonb_build_object('user_id', u_blind, 'label', 'agent'),
                           jsonb_build_object('user_id', u_tl, 'label', 'agent'),
                           jsonb_build_object('user_id', u_coord, 'label', 'coordinator'));
  g := (SELECT o.group_id FROM sg_open(a, 'SEJ-2', c, w, 's', NULL, acc, NULL, 'group') o);
  PERFORM sg_attach_wa_group(g, '120363000000308002@g.us', NULL, sg_claim_create(g, 60000));
  PERFORM sg_record_inbound(g, 'SEJ-IN-1', '971500308011', 'customer', 'text', 'q', NULL, now());
  r := pg_temp.sej_rung(g);
  ASSERT r = (SELECT string_agg(x || ' /submission-groups/' || g, ', ' ORDER BY x)
                FROM unnest(ARRAY['sej-blind', 'sej-coord', 'sej-sees', 'sej-tl']) x), 'ACTIVE: ' || r;
  -- The unread bells of before the end stay with the agent into the end.
  UPDATE notifications SET read_at = now() WHERE account_id = a AND user_id IN (u_coord, u_blind, u_tl);
  UPDATE notifications SET created_at = now() - interval '1 minute' WHERE account_id = a;
  PERFORM sg_end(g, 'MANUAL');
  PERFORM sg_record_inbound(g, 'SEJ-IN-2', '971500308011', 'customer', 'text', 'q', NULL, now());
  r := pg_temp.sej_rung(g);
  ASSERT r = format('sej-coord /submission-groups/%s, sej-sees:%s /contacts/%s, sej-tl:%s /contacts/%s', g, c, c, c, c),
    'ENDED: ' || r;
  PERFORM sg_record_inbound(g, 'SEJ-IN-3', '971500308011', 'customer', 'text', 'q', NULL, now());
  ASSERT pg_temp.sej_rung(g) = r, 'a second message rang twice';

  -- The count: only who may open it. A lost contact leaves no link to a group.
  ASSERT pg_temp.sej_as(u_coord, 'SELECT sg_unread_count()') = '2'
     AND pg_temp.sej_as(u_sees, 'SELECT sg_unread_count()') = '0', 'the count of an ended group';
  ASSERT (SELECT public.push_bell_url(x) FROM (
            SELECT (jsonb_populate_record(n, '{"contact_id": null}')).* FROM notifications n
             WHERE n.user_id = u_sees AND n.read_at IS NULL AND n.type = 'submission_group_message') x) = '/notifications', 'a bell without its contact';

  -- Opening the archive clears it, for who may read it; refused for the rest.
  ASSERT pg_temp.sej_as(u_sees, format('SELECT sg_mark_read(%L)', g)) = '42501', 'an agent marked an ended group';
  ASSERT pg_temp.sej_as(u_coord, format('SELECT sg_mark_read(%L)', g)) <> '42501', 'the coordinator was refused';
  ASSERT pg_temp.sej_as(u_coord, 'SELECT sg_unread_count()') = '0'
     AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = u_coord AND n.read_at IS NULL
                        AND n.type = 'submission_group_message'), 'the archive did not clear the bell';
  ASSERT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = u_sees AND n.read_at IS NULL
                    AND n.type = 'submission_group_message'), 'another person''s bell was cleared';
  ASSERT pg_temp.sej_as(u_admin, format('SELECT sg_mark_read(%L)', g)) <> '42501', 'an admin was refused';
  -- A bell rung after the end by the function before 308 opens the group the
  -- agent lost: replaced, not taken for the bell of the last 30 minutes.
  UPDATE notifications SET meta = meta - 'ended', contact_id = NULL,
         created_at = (SELECT x.ended_at + interval '1 second' FROM submission_groups x WHERE x.id = g)
   WHERE account_id = a AND user_id = u_sees AND read_at IS NULL AND type = 'submission_group_message';
  PERFORM sg_record_inbound(g, 'SEJ-IN-3B', '971500308011', 'customer', 'text', 'q', NULL, now());
  r := pg_temp.sej_rung(g);
  ASSERT position(format('sej-sees:%s /contacts/%s', c, c) IN r) > 0, 'an older bell silenced the agent: ' || r;

  -- 2. Nobody on the list may read it: the owner and admins too.
  g := (SELECT o.group_id FROM sg_open(a, 'SEJ-3', c, w, 's', NULL, acc - 3 - 2, NULL, 'group') o);
  PERFORM sg_attach_wa_group(g, '120363000000308003@g.us', NULL, sg_claim_create(g, 60000));
  PERFORM sg_end(g, 'MANUAL');
  PERFORM sg_record_inbound(g, 'SEJ-IN-4', '971500308011', 'customer', 'text', 'q', NULL, now());
  r := pg_temp.sej_rung(g);
  ASSERT r = format('sej-admin /submission-groups/%s, sej-owner /submission-groups/%s, sej-sees:%s /contacts/%s', g, g, c, c),
    'nobody may read it: ' || r;

  -- 3. A coordinator whose window is over reads nothing: the admins.
  g := (SELECT o.group_id FROM sg_open(a, 'SEJ-4', c2, w, 's', NULL, acc, NULL, 'group') o);
  PERFORM sg_attach_wa_group(g, '120363000000308004@g.us', NULL, sg_claim_create(g, 60000));
  PERFORM sg_end(g, 'MANUAL');
  ALTER TABLE submission_groups DISABLE TRIGGER USER;
  ALTER TABLE submission_group_access DISABLE TRIGGER USER;
  UPDATE submission_groups SET created_at = now() - interval '90 days', ended_at = now() - interval '61 days' WHERE id = g;
  UPDATE submission_group_access SET added_at = now() - interval '90 days' WHERE group_id = g;
  ALTER TABLE submission_groups ENABLE TRIGGER USER;
  ALTER TABLE submission_group_access ENABLE TRIGGER USER;
  PERFORM sg_record_inbound(g, 'SEJ-IN-5', '971500308012', 'customer', 'text', 'q', NULL, now());
  r := pg_temp.sej_rung(g);
  ASSERT r = format('sej-admin /submission-groups/%s, sej-owner /submission-groups/%s', g, g), 'window over: ' || r;
END $$;
ROLLBACK;
