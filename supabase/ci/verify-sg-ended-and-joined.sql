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
