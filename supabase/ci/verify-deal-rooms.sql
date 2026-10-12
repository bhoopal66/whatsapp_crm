-- Behavioural regression suite for deal rooms (migration 088).
--
-- A deal room is a WhatsApp group on the account's Meta number, linked
-- to a contact; inside the CRM it is a `deal_room` internal-chat
-- channel. Clients only read (RLS plus column grants) and write through
-- SECURITY DEFINER functions that re-check the caller; the Meta client
-- and the webhooks call service-role functions. This asserts
-- deal_room_create (the channel and its members, our number's row, one
-- consent linked to the customer, the audit row) and each of its
-- refusals (a viewer, a guest, a contact the agent cannot see, a Whapi
-- number, 0 or 8 invitees, a repeated phone, an opted-out or
-- do-not-contact person, no consent, a bank guest with no bank or whose
-- bank is off); that an agent's bank guest waits for a team leader;
-- who sees which room; that a guest reads only the roster, group
-- messages and receipts of their own rooms; that no client reads a
-- phone, a WhatsApp id or the invite link; the can_manage / can_post
-- truth table; the service functions (refused to clients, the group
-- lifecycle, join requests, membership events, message dedupe and the
-- service window); the private bucket and anon's grants.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000088001';
  u_admin  UUID := '00000000-0000-4000-8000-000000088002';
  u_lead   UUID := '00000000-0000-4000-8000-000000088003';
  u_agent  UUID := '00000000-0000-4000-8000-000000088004';
  u_agent2 UUID := '00000000-0000-4000-8000-000000088005';
  u_viewer UUID := '00000000-0000-4000-8000-000000088006';
  u_guest  UUID := '00000000-0000-4000-8000-000000088007';   -- bank_guest of ADCB
  u_other  UUID := '00000000-0000-4000-8000-000000088008';   -- account B's owner
  a_acct   UUID;
  b_acct   UUID;
  w_meta   UUID;
  w_whapi  UUID;
  c_agent  UUID;   -- the agent's customer
  c_agent2 UUID;   -- the other agent's customer: the agent cannot see it
  c_lead   UUID;   -- the team leader's customer
  r_main   UUID;   -- the admin's room on the agent's customer (happy path)
  r_agent  UUID;   -- the agent's room: its bank guest waits for approval
  r_agent2 UUID;   -- the other agent's room
  r_lead   UUID;   -- the leader's room: the guest login is in it
  r_seven  UUID;   -- 7 invitees, the most WhatsApp allows beside our number
  p_guest  UUID;   -- the agent's bank guest participant
  p_pat    UUID;   -- the partner in the leader's room
  p_biz    UUID;   -- our number's row in the leader's room
  m_in     UUID;
  consent  TEXT := '{"text_version": "dr-v1", "method": "verbal",
                     "consent_text": "The customer agreed to a WhatsApp group with the partner and the bank."}';
  cara     TEXT := '{"display_name": "Cara Customer", "phone": "971500880001", "role": "customer"}';
  seven    TEXT;
  eight    TEXT;
  x        RECORD;
  s        TEXT;
  t        TEXT;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (a signed-in user when p_uid is given):
  -- a SELECT's value, 'ok', or the error as 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.dr_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', p_role)::text, true);
        EXECUTE format('SET LOCAL ROLE %I', p_role);
        IF p_sql ILIKE 'select%' THEN
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
  -- deal_room_create on a contact and number, without a deal.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.dr_create(p_contact uuid, p_config uuid, p_people text, p_consent text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT format('SELECT public.deal_room_create(%L, NULL, %L, %L, NULL, %L::jsonb, %L::jsonb)::text',
                    p_contact, p_config, 'DR room', p_people, p_consent)
    $body$
  $fn$;

  -- Fixture: account A (owner, admin, team leader, two agents, a
  -- viewer, an ADCB bank guest), account B (owner). A Whapi number and
  -- the Meta number; ADCB's guests are on (DSA checked), FAB's are off.
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'dr-owner@example.invalid'),
    (u_admin,  'dr-admin@example.invalid'),
    (u_lead,   'dr-lead@example.invalid'),
    (u_agent,  'dr-agent@example.invalid'),
    (u_agent2, 'dr-agent2@example.invalid'),
    (u_viewer, 'dr-viewer@example.invalid'),
    (u_guest,  'dr-guest@example.invalid'),
    (u_other,  'dr-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_other;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agent, u_agent2);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_viewer;
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_guest;

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, waba_id, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'DR-WHAPI-1', 'x', '971500880900', 'connected', true)
  RETURNING id INTO w_whapi;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, waba_id, status, is_primary)
  VALUES (u_owner, a_acct, 'meta', 'DR-META-1', 'x', 'DR-WABA-1', 'connected', false)
  RETURNING id INTO w_meta;

  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_agent, '971500880001', 'Cara Customer') RETURNING id INTO c_agent;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_agent2, '971500880002', 'Cy Customer') RETURNING id INTO c_agent2;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_lead, '971500880003', 'Lee Customer') RETURNING id INTO c_lead;
  INSERT INTO contacts (account_id, user_id, phone, name, opted_out_at)
  VALUES (a_acct, u_agent, '971500880004', 'Opted-out contact', now());
  INSERT INTO contacts (account_id, user_id, phone, name, do_not_contact_at, do_not_contact_reason)
  VALUES (a_acct, u_agent, '971500880005', 'Do-not-contact contact', now(), 'asked on a call');

  INSERT INTO bank_guest_policies (account_id, bank_code, guests_allowed, dsa_checked_by, dsa_checked_at)
  VALUES (a_acct, 'ADCB', true, u_admin, now()), (a_acct, 'FAB', false, NULL, NULL);

  SELECT jsonb_agg(jsonb_build_object('display_name', 'Person ' || i, 'phone', '9715008801' || lpad(i::text, 2, '0'),
                                      'role', CASE WHEN i = 1 THEN 'customer' ELSE 'partner' END)
                   ORDER BY i) FILTER (WHERE i <= 7)::text,
         jsonb_agg(jsonb_build_object('display_name', 'Person ' || i, 'phone', '9715008801' || lpad(i::text, 2, '0'),
                                      'role', CASE WHEN i = 1 THEN 'customer' ELSE 'partner' END)
                   ORDER BY i)::text
    INTO seven, eight
    FROM generate_series(1, 8) i;

  -- ---------- deal_room_create: the happy path ----------
  -- The admin, on the agent's customer, with a partner beside them.
  r := pg_temp.dr_try('authenticated', u_admin, pg_temp.dr_create(c_agent, w_meta,
         '[' || cara || ', {"display_name": "Pat Partner", "phone": "971500880010", "role": "partner"}]', consent));
  IF r ~ '^[0-9a-f]{8}-' THEN r_main := r::uuid; END IF;
  n := n + 1;
  IF r_main IS NULL OR NOT EXISTS (SELECT 1 FROM deal_rooms
       WHERE id = r_main AND account_id = a_acct AND status = 'creating' AND contact_id = c_agent
         AND whatsapp_config_id = w_meta AND created_by = u_admin AND wa_group_id IS NULL) THEN
    failed := array_append(failed, ('create: no room in status creating: ' || r)::text);
  END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM deal_rooms d JOIN chat_channels c ON c.id = d.channel_id
                  WHERE d.id = r_main AND c.kind = 'deal_room' AND c.account_id = a_acct)
     OR (SELECT string_agg(m.user_id::text || ':' || m.role, ',' ORDER BY m.role)
           FROM deal_rooms d JOIN chat_channel_members m ON m.channel_id = d.channel_id
          WHERE d.id = r_main) IS DISTINCT FROM (u_admin::text || ':admin,' || u_agent::text || ':member') THEN
    failed := array_append(failed,
      'create: not a deal_room channel with the creator as admin and the contact owner as member'::text);
  END IF;
  n := n + 1;
  IF (SELECT count(*) FROM deal_room_participants
       WHERE room_id = r_main AND role = 'business' AND status = 'invited' AND phone IS NULL) <> 1
     OR (SELECT count(*) FROM deal_room_participants WHERE room_id = r_main) <> 3 THEN
    failed := array_append(failed, 'create: not one business row beside the two people listed'::text);
  END IF;
  n := n + 1;
  IF (SELECT count(*) FROM participant_consents WHERE room_id = r_main) <> 1
     OR NOT EXISTS (SELECT 1 FROM participant_consents pc
                      JOIN deal_room_participants p ON p.consent_id = pc.id
                     WHERE pc.room_id = r_main AND pc.contact_id = c_agent AND pc.recorded_by = u_admin
                       AND pc.method = 'verbal' AND pc.text_version = 'dr-v1'
                       AND p.role = 'customer' AND p.contact_id = c_agent)
     OR EXISTS (SELECT 1 FROM deal_room_participants
                 WHERE room_id = r_main AND role <> 'customer' AND consent_id IS NOT NULL) THEN
    failed := array_append(failed, 'create: the consent is not one row linked to the customer'::text);
  END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM deal_room_audit WHERE room_id = r_main AND action = 'created' AND actor_id = u_admin) THEN
    failed := array_append(failed, 'create: no audit row'::text);
  END IF;

  -- ---------- deal_room_create: refusals ----------
  FOR x IN SELECT * FROM (VALUES
      ('a viewer', u_viewer, pg_temp.dr_create(c_agent, w_meta, '[' || cara || ']', consent),
       'ERROR 42501: deal rooms: viewers cannot create deal rooms%'),
      ('a bank guest', u_guest, pg_temp.dr_create(c_agent, w_meta, '[' || cara || ']', consent),
       'ERROR 42501: deal rooms: no active workspace%'),
      ('an agent who cannot see the contact', u_agent, pg_temp.dr_create(c_agent2, w_meta,
         '[{"display_name": "Cy Customer", "phone": "971500880002", "role": "customer"}]', consent),
       'ERROR 42501: deal rooms: contact not found%'),
      ('a Whapi number', u_agent, pg_temp.dr_create(c_agent, w_whapi, '[' || cara || ']', consent),
       'ERROR 22023: deal rooms: a deal room needs the Meta Cloud API number%'),
      ('no invitees', u_agent, pg_temp.dr_create(c_agent, w_meta, '[]', consent),
       'ERROR 22023: deal rooms: invite 1 to 7 people%'),
      ('8 invitees', u_agent, pg_temp.dr_create(c_agent, w_meta, eight, consent),
       'ERROR 22023: deal rooms: invite 1 to 7 people%'),
      ('a repeated phone', u_agent, pg_temp.dr_create(c_agent, w_meta,
         '[' || cara || ', {"display_name": "Cara Again", "phone": "+971 50 088 0001", "role": "partner"}]', consent),
       'ERROR 22023: deal rooms: Cara Again is listed twice%'),
      ('an opted-out person', u_agent, pg_temp.dr_create(c_agent, w_meta,
         '[' || cara || ', {"display_name": "Omar Optout", "phone": "971500880004", "role": "partner"}]', consent),
       'ERROR 22023: deal rooms: Omar Optout has opted out or is marked do-not-contact%'),
      ('a do-not-contact person', u_agent, pg_temp.dr_create(c_agent, w_meta,
         '[' || cara || ', {"display_name": "Dana Dnc", "phone": "971500880005", "role": "partner"}]', consent),
       'ERROR 22023: deal rooms: Dana Dnc has opted out or is marked do-not-contact%'),
      ('no consent', u_agent, pg_temp.dr_create(c_agent, w_meta, '[' || cara || ']', NULL),
       'ERROR 22023: deal rooms: the customer''s recorded consent%'),
      ('a bank guest with no bank', u_agent, pg_temp.dr_create(c_agent, w_meta,
         '[' || cara || ', {"display_name": "Bob Banker", "phone": "971500880020", "role": "bank_guest"}]', consent),
       'ERROR 22023: deal rooms: bank guest Bob Banker needs a bank code%'),
      ('a bank whose guests are off', u_agent, pg_temp.dr_create(c_agent, w_meta,
         '[' || cara || ', {"display_name": "Fay Fab", "phone": "971500880022", "role": "bank_guest", "bank_code": "fab"}]',
         consent),
       'ERROR 22023: deal rooms: FAB officers cannot join customer groups%')
    ) v(label, uid, call, want)
  LOOP
    r := pg_temp.dr_try('authenticated', x.uid, x.call);
    n := n + 1;
    IF r NOT LIKE x.want THEN
      failed := array_append(failed, ('create allowed ' || x.label || ': ' || r)::text);
    END IF;
  END LOOP;

  -- 7 invitees fit: with our number that is WhatsApp's 8.
  r := pg_temp.dr_try('authenticated', u_agent, pg_temp.dr_create(c_agent, w_meta, seven, consent));
  IF r ~ '^[0-9a-f]{8}-' THEN r_seven := r::uuid; END IF;
  n := n + 1;
  IF (SELECT count(*) FROM deal_room_participants WHERE room_id = r_seven) <> 8 THEN
    failed := array_append(failed, ('create refused 7 invitees: ' || r)::text);
  END IF;

  -- A bank's guests go on only with its DSA check, and only by an admin.
  r := pg_temp.dr_try('authenticated', u_admin, format(
         'INSERT INTO bank_guest_policies (account_id, bank_code, guests_allowed) VALUES (%L, %L, true)', a_acct, 'ENBD'))
       || ' / ' || pg_temp.dr_try('authenticated', u_lead, format(
         'INSERT INTO bank_guest_policies (account_id, bank_code, guests_allowed, dsa_checked_at) VALUES (%L, %L, true, now())',
         a_acct, 'ENBD'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:% / ERROR 42501:%' THEN
    failed := array_append(failed, ('bank guests turned on without a DSA check or an admin: ' || r)::text);
  END IF;

  -- ---------- bank guests: an agent's wait for a team leader ----------
  r := pg_temp.dr_try('authenticated', u_agent, pg_temp.dr_create(c_agent, w_meta,
         '[' || cara || ', {"display_name": "Bea Bank", "phone": "971500880020", "role": "bank_guest", "bank_code": "ADCB"}]',
         consent));
  IF r ~ '^[0-9a-f]{8}-' THEN r_agent := r::uuid; END IF;
  SELECT id INTO p_guest FROM deal_room_participants
   WHERE room_id = r_agent AND role = 'bank_guest' AND bank_code = 'ADCB' AND status = 'pending_approval';
  n := n + 1;
  IF p_guest IS NULL THEN
    failed := array_append(failed, ('an agent''s bank guest does not wait for approval: ' || r)::text);
  END IF;
  r := pg_temp.dr_try('authenticated', u_lead, pg_temp.dr_create(c_lead, w_meta,
         '[{"display_name": "Lee Customer", "phone": "971500880003", "role": "customer"},'
         ' {"display_name": "Pat Partner", "phone": "971500880010", "role": "partner"},'
         ' {"display_name": "Ben Bank", "phone": "971500880021", "role": "bank_guest", "bank_code": "ADCB"}]', consent));
  IF r ~ '^[0-9a-f]{8}-' THEN r_lead := r::uuid; END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM deal_room_participants
                  WHERE room_id = r_lead AND role = 'bank_guest' AND bank_code = 'ADCB' AND status = 'invited') THEN
    failed := array_append(failed, ('a team leader''s bank guest is not invited: ' || r)::text);
  END IF;
  r := pg_temp.dr_try('authenticated', u_agent, format('SELECT public.deal_room_approve_participant(%L, true)', p_guest));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%'
     OR NOT EXISTS (SELECT 1 FROM deal_room_participants WHERE id = p_guest AND status = 'pending_approval') THEN
    failed := array_append(failed, ('an agent approved a bank guest: ' || r)::text);
  END IF;
  r := pg_temp.dr_try('authenticated', u_lead, format('SELECT public.deal_room_approve_participant(%L, true)', p_guest));
  n := n + 1;
  IF r IS DISTINCT FROM 'invited'
     OR NOT EXISTS (SELECT 1 FROM deal_room_participants WHERE id = p_guest AND status = 'invited')
     OR NOT EXISTS (SELECT 1 FROM deal_room_audit
                     WHERE room_id = r_agent AND action = 'participant_approved' AND actor_id = u_lead) THEN
    failed := array_append(failed, ('a team leader could not approve a bank guest: ' || r)::text);
  END IF;

  -- The other agent's room; the leader adds the viewer and the guest login.
  r := pg_temp.dr_try('authenticated', u_agent2, pg_temp.dr_create(c_agent2, w_meta,
         '[{"display_name": "Cy Customer", "phone": "971500880002", "role": "customer"}]', consent));
  IF r ~ '^[0-9a-f]{8}-' THEN r_agent2 := r::uuid; END IF;
  n := n + 1;
  IF r_agent2 IS NULL THEN
    failed := array_append(failed, ('an agent could not open a room on their own customer: ' || r)::text);
  END IF;
  r := pg_temp.dr_try('authenticated', u_lead,
         format('SELECT public.deal_room_add_staff(%L, ARRAY[%L]::uuid[])::text', r_lead, u_viewer))
       || ' / ' || pg_temp.dr_try('authenticated', u_lead,
         format('SELECT ''added'' FROM public.deal_room_add_guest_user(%L, %L)', r_lead, u_guest));
  n := n + 1;
  IF r IS DISTINCT FROM '1 / added'
     OR NOT EXISTS (SELECT 1 FROM deal_rooms d JOIN chat_channel_members m ON m.channel_id = d.channel_id
                     WHERE d.id = r_lead AND m.user_id = u_guest AND m.role = 'guest') THEN
    failed := array_append(failed, ('a leader could not add the viewer and the bank guest login: ' || r)::text);
  END IF;

  -- ---------- service role: the group lifecycle ----------
  r := pg_temp.dr_try('service_role', NULL,
         format('SELECT ''requested'' FROM public.deal_room_mark_requested(%L, %L)', r_lead, 'dr-req-lead'))
       || ' / ' || pg_temp.dr_try('service_role', NULL,
         format('SELECT public.deal_room_group_created(%L, %L, %L)::text', 'dr-req-lead', 'dr-grp-lead@g.us', 'dr-hash-lead'));
  SELECT id INTO p_biz FROM deal_room_participants WHERE room_id = r_lead AND role = 'business';
  n := n + 1;
  IF r IS DISTINCT FROM ('requested / ' || r_lead::text)
     OR NOT EXISTS (SELECT 1 FROM deal_rooms
                     WHERE id = r_lead AND status = 'open' AND wa_group_id = 'dr-grp-lead@g.us'
                       AND invite_link_hash = 'dr-hash-lead' AND opened_at IS NOT NULL AND participant_count = 1)
     OR NOT EXISTS (SELECT 1 FROM deal_room_participants WHERE id = p_biz AND status = 'joined') THEN
    failed := array_append(failed, ('the group did not open the room by its request id: ' || r)::text);
  END IF;
  -- The admin's room opens too, with a message the guest must not see.
  r := pg_temp.dr_try('service_role', NULL,
         format('SELECT ''requested'' FROM public.deal_room_mark_requested(%L, %L)', r_main, 'dr-req-main'))
       || ' / ' || pg_temp.dr_try('service_role', NULL,
         format('SELECT public.deal_room_group_created(%L, %L, %L)::text', 'dr-req-main', 'dr-grp-main@g.us', 'dr-hash-main'))
       || ' / ' || pg_temp.dr_try('service_role', NULL,
         format('SELECT public.deal_room_record_message(%L, %L, %L, %L, %L, %L)::text',
                'dr-grp-main@g.us', 'in', 'text', 'wamid.DR3', '971500880001', 'In the admin''s room'));
  IF r NOT LIKE 'requested / ' || r_main::text || ' / ________-%' THEN
    failed := array_append(failed, ('fixture: the admin''s room did not open: ' || r)::text);
  END IF;

  s := format('SELECT public.deal_room_record_join_request(%L, %L, %L)', 'dr-grp-lead@g.us', 'dr-jr-1', '971500880010');
  r := pg_temp.dr_try('service_role', NULL, s)
       || ' / ' || pg_temp.dr_try('service_role', NULL,
         format('SELECT public.deal_room_record_join_request(%L, %L, %L)', 'dr-grp-lead@g.us', 'dr-jr-2', '971500880099'))
       || ' / ' || pg_temp.dr_try('service_role', NULL, s);
  n := n + 1;
  IF r IS DISTINCT FROM 'auto_approved / pending / auto_approved'
     OR (SELECT count(*) FROM deal_room_join_requests WHERE room_id = r_lead) <> 2 THEN
    failed := array_append(failed, ('join requests (invited, stranger, redelivery): ' || r)::text);
  END IF;

  r := pg_temp.dr_try('service_role', NULL, format('SELECT public.deal_room_participant_event(%L, %L, %L)',
         'dr-grp-lead@g.us', '971500880010', 'joined'));
  SELECT id INTO p_pat FROM deal_room_participants WHERE room_id = r_lead AND phone = '971500880010';
  n := n + 1;
  IF r IS DISTINCT FROM 'joined'
     OR NOT EXISTS (SELECT 1 FROM deal_rooms WHERE id = r_lead AND participant_count = 2)
     OR NOT EXISTS (SELECT 1 FROM deal_room_participants WHERE id = p_pat AND status = 'joined' AND joined_at IS NOT NULL) THEN
    failed := array_append(failed, ('a joined event did not update participant_count: ' || r)::text);
  END IF;

  s := format('SELECT public.deal_room_record_message(%L, %L, %L, %L, %L, %L)::text',
              'dr-grp-lead@g.us', 'in', 'text', 'wamid.DR1', '971500880010', 'Hello from Pat');
  r := pg_temp.dr_try('service_role', NULL, s);
  IF r ~ '^[0-9a-f]{8}-' THEN m_in := r::uuid; END IF;
  r := r || ' / ' || pg_temp.dr_try('service_role', NULL, s);
  n := n + 1;
  IF m_in IS NULL OR r IS DISTINCT FROM (m_in::text || ' / ' || m_in::text)
     OR (SELECT count(*) FROM group_messages WHERE wa_message_id = 'wamid.DR1') <> 1
     OR NOT EXISTS (SELECT 1 FROM group_messages
                     WHERE id = m_in AND direction = 'in' AND sender_participant_id = p_pat
                       AND sender_wa_id = '971500880010' AND status IS NULL)
     OR NOT EXISTS (SELECT 1 FROM deal_rooms WHERE id = r_lead AND window_until >= now() + interval '23 hours') THEN
    failed := array_append(failed, ('an inbound message was not deduplicated or did not open the window: ' || r)::text);
  END IF;

  -- Outbound is attributed to our number and the sender; a receipt moves it forward once.
  r := pg_temp.dr_try('service_role', NULL,
         format('SELECT public.deal_room_record_message(%L, %L, %L, %L, NULL, %L, NULL, NULL, %L)::text',
                'dr-grp-lead@g.us', 'out', 'text', 'wamid.DR2', 'Hello everyone', u_lead));
  s := format('SELECT public.deal_room_record_receipt(%L, %L, %L)::text', 'wamid.DR2', '971500880010', 'read');
  r := pg_temp.dr_try('service_role', NULL, s) || ' / ' || pg_temp.dr_try('service_role', NULL, s);
  n := n + 1;
  IF r IS DISTINCT FROM 'true / false'
     OR NOT EXISTS (SELECT 1 FROM group_messages
                     WHERE wa_message_id = 'wamid.DR2' AND direction = 'out' AND status = 'read'
                       AND sender_participant_id = p_biz AND staff_user_id = u_lead AND sender_wa_id IS NULL)
     OR NOT EXISTS (SELECT 1 FROM group_message_receipts WHERE participant_id = p_pat AND status = 'read') THEN
    failed := array_append(failed, ('an outbound message and its receipt: ' || r)::text);
  END IF;

  r := pg_temp.dr_try('service_role', NULL, format('SELECT public.deal_room_record_message(%L, %L, %L, %L, %L)::text',
         'dr-no-such-group', 'in', 'text', 'wamid.DR9', '971500880010'))
       || ' / ' || pg_temp.dr_try('service_role', NULL, format(
         'SELECT public.deal_room_record_join_request(%L, %L, %L)', 'dr-no-such-group', 'dr-jr-9', '971500880010'))
       || ' / ' || pg_temp.dr_try('service_role', NULL, format(
         'SELECT public.deal_room_participant_event(%L, %L, %L)', 'dr-no-such-group', '971500880010', 'joined'))
       || ' / ' || pg_temp.dr_try('service_role', NULL, format(
         'SELECT public.deal_room_record_receipt(%L, %L, %L)::text', 'wamid.DR9', '971500880010', 'read'));
  n := n + 1;
  IF r NOT LIKE 'ERROR P0002:% / ERROR P0002:% / ERROR P0002:% / false' THEN
    failed := array_append(failed, ('an unknown group was not P0002: ' || r)::text);
  END IF;

  -- Clients cannot call the service functions; a signed-in caller is
  -- refused even where EXECUTE slipped through (here: the owner).
  t := NULL;
  FOREACH s IN ARRAY ARRAY[
    format('SELECT ''x'' FROM public.deal_room_mark_requested(%L, %L)', r_agent, 'dr-req-x'),
    format('SELECT public.deal_room_group_created(%L, %L, %L)::text', 'dr-req-lead', 'dr-grp-lead@g.us', 'dr-hash-x'),
    format('SELECT ''x'' FROM public.deal_room_set_status(%L, %L)', r_lead, 'closed'),
    format('SELECT public.deal_room_record_join_request(%L, %L, %L)', 'dr-grp-lead@g.us', 'dr-jr-x', '971500880098'),
    format('SELECT public.deal_room_participant_event(%L, %L, %L)', 'dr-grp-lead@g.us', '971500880098', 'joined'),
    format('SELECT public.deal_room_record_message(%L, %L, %L, %L, %L)::text',
           'dr-grp-lead@g.us', 'in', 'text', 'wamid.DRX', '971500880098'),
    format('SELECT public.deal_room_record_receipt(%L, %L, %L)::text', 'wamid.DR2', '971500880003', 'read')
  ] LOOP
    r := pg_temp.dr_try('authenticated', u_lead, s);
    IF r NOT LIKE 'ERROR 42501:%' THEN t := concat_ws('; ', t, s || ' -> ' || r); END IF;
  END LOOP;
  r := pg_temp.dr_try(current_user, u_lead, format('SELECT public.deal_room_record_message(%L, %L, %L, %L, %L)::text',
         'dr-grp-lead@g.us', 'in', 'text', 'wamid.DRY', '971500880098'));
  n := n + 1;
  IF t IS NOT NULL OR r NOT LIKE 'ERROR 42501: deal rooms: server-only function%' THEN
    failed := array_append(failed, ('a signed-in caller ran a service function: ' || concat_ws('; ', t, r))::text);
  END IF;

  -- ---------- who sees which room ----------
  r := pg_temp.dr_try('authenticated', u_agent, format(
         'SELECT count(*) FILTER (WHERE id = %L) || ''/'' || count(*) FILTER (WHERE id = %L)'
         ' || ''/'' || count(*) FILTER (WHERE id = %L) || ''/'' || count(*) FILTER (WHERE id = %L) FROM public.deal_rooms',
         r_agent, r_main, r_agent2, r_lead));
  n := n + 1;
  IF r IS DISTINCT FROM '1/1/0/0' THEN
    failed := array_append(failed, ('the agent sees (own, member of, other agent''s, leader''s): ' || r)::text);
  END IF;
  r := pg_temp.dr_try('authenticated', u_lead, format(
         'SELECT count(*)::text FROM public.deal_rooms WHERE id IN (%L, %L, %L, %L)', r_main, r_agent, r_agent2, r_lead));
  n := n + 1;
  IF r IS DISTINCT FROM '4' THEN
    failed := array_append(failed, ('the team leader does not see every room: ' || r)::text);
  END IF;
  r := pg_temp.dr_try('authenticated', u_other,
         'SELECT ((SELECT count(*) FROM public.deal_rooms) + (SELECT count(*) FROM public.deal_room_roster)'
         ' + (SELECT count(*) FROM public.group_messages) + (SELECT count(*) FROM public.deal_room_participants)'
         ' + (SELECT count(*) FROM public.bank_guest_policies))::text');
  n := n + 1;
  IF r IS DISTINCT FROM '0' THEN
    failed := array_append(failed, ('another account''s owner sees deal-room rows: ' || r)::text);
  END IF;

  -- ---------- a guest: their rooms' roster, messages and receipts only ----------
  r := pg_temp.dr_try('authenticated', u_guest, 'SELECT coalesce(string_agg(id::text, '',''), '''') FROM public.deal_rooms');
  n := n + 1;
  IF r IS DISTINCT FROM r_lead::text THEN
    failed := array_append(failed, ('the guest sees rooms other than their own: ' || r)::text);
  END IF;
  r := pg_temp.dr_try('authenticated', u_guest, format(
         'SELECT count(*) FILTER (WHERE room_id = %L) || ''/'' || count(*) FILTER (WHERE room_id <> %L)'
         ' FROM public.deal_room_roster', r_lead, r_lead))
       || ' ' || pg_temp.dr_try('authenticated', u_guest, format(
         'SELECT count(*) FILTER (WHERE room_id = %L) || ''/'' || count(*) FILTER (WHERE room_id <> %L)'
         ' FROM public.group_messages', r_lead, r_lead))
       || ' ' || pg_temp.dr_try('authenticated', u_guest, 'SELECT count(*)::text FROM public.group_message_receipts');
  n := n + 1;
  IF r IS DISTINCT FROM ((SELECT count(*) FROM deal_room_participants WHERE room_id = r_lead)::text || '/0 2/0 1')
     OR (SELECT string_agg(column_name::text, ',' ORDER BY ordinal_position) FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'deal_room_roster')
        IS DISTINCT FROM 'id,room_id,display_name,role,status,joined_at,left_at' THEN
    failed := array_append(failed, ('the guest''s roster / messages / receipts: ' || r)::text);
  END IF;
  -- Staff-only tables: the guest reads nothing, the leader reads the room's rows.
  t := NULL;
  FOREACH s IN ARRAY ARRAY['deal_room_participants', 'participant_consents', 'deal_room_join_requests', 'deal_room_audit']
  LOOP
    r := pg_temp.dr_try('authenticated', u_guest, format('SELECT count(*)::text FROM public.%I', s));
    IF r IS DISTINCT FROM '0' AND r NOT LIKE 'ERROR 42501:%' THEN t := concat_ws('; ', t, 'guest ' || s || ' ' || r); END IF;
    r := pg_temp.dr_try('authenticated', u_lead, format('SELECT count(*)::text FROM public.%I WHERE room_id = %L', s, r_lead));
    IF r !~ '^[1-9]' THEN t := concat_ws('; ', t, 'leader ' || s || ' ' || r); END IF;
  END LOOP;
  n := n + 1;
  IF t IS NOT NULL THEN
    failed := array_append(failed, ('staff-only tables: ' || t)::text);
  END IF;

  -- No client reads the invite link or a WhatsApp id (staff neither); a
  -- sender or reader is resolved through the participant id.
  r := pg_temp.dr_try('authenticated', u_guest, 'SELECT count(invite_link_hash)::text FROM public.deal_rooms')
       || ' / ' || pg_temp.dr_try('authenticated', u_lead, 'SELECT count(invite_link_hash)::text FROM public.deal_rooms')
       || ' / ' || pg_temp.dr_try('authenticated', u_lead, 'SELECT count(*)::text FROM (SELECT * FROM public.deal_rooms) d');
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:% / ERROR 42501:% / ERROR 42501:%' THEN
    failed := array_append(failed, ('a client read deal_rooms.invite_link_hash: ' || r)::text);
  END IF;
  r := pg_temp.dr_try('authenticated', u_guest, 'SELECT count(sender_wa_id)::text FROM public.group_messages')
       || ' / ' || pg_temp.dr_try('authenticated', u_lead, 'SELECT count(sender_wa_id)::text FROM public.group_messages')
       || ' / ' || pg_temp.dr_try('authenticated', u_guest,
         'SELECT count(participant_wa_id)::text FROM public.group_message_receipts')
       || ' / ' || pg_temp.dr_try('authenticated', u_lead,
         'SELECT count(participant_wa_id)::text FROM public.group_message_receipts')
       || ' / ' || pg_temp.dr_try('authenticated', u_lead, format(
         'SELECT count(sender_participant_id)::text FROM public.group_messages WHERE room_id = %L', r_lead));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:% / ERROR 42501:% / ERROR 42501:% / ERROR 42501:% / 2' THEN
    failed := array_append(failed, ('a client read a WhatsApp id: ' || r)::text);
  END IF;

  -- ---------- can_manage / can_post ----------
  r := pg_temp.dr_try('authenticated', u_agent, format('SELECT public.deal_room_can_post(%L)::text', r_main))
       || '/' || pg_temp.dr_try('authenticated', u_agent, format('SELECT public.deal_room_can_manage(%L)::text', r_main))
       || '/' || pg_temp.dr_try('authenticated', u_viewer, format('SELECT public.deal_room_can_post(%L)::text', r_lead))
       || '/' || pg_temp.dr_try('authenticated', u_guest, format('SELECT public.deal_room_can_post(%L)::text', r_lead))
       || '/' || pg_temp.dr_try('authenticated', u_guest, format('SELECT public.deal_room_can_manage(%L)::text', r_lead))
       || '/' || pg_temp.dr_try('authenticated', u_agent2, format('SELECT public.deal_room_can_post(%L)::text', r_main))
       || '/' || pg_temp.dr_try('authenticated', u_agent2, format('SELECT public.deal_room_can_manage(%L)::text', r_main))
       || '/' || pg_temp.dr_try('authenticated', u_lead, format('SELECT public.deal_room_can_manage(%L)::text', r_agent2));
  n := n + 1;
  IF r IS DISTINCT FROM 'true/true/false/true/false/false/false/true' THEN
    failed := array_append(failed, ('can_post/can_manage (agent member post, manage; viewer post; guest post, manage; '
                                    || 'outside agent post, manage; leader manage): ' || r)::text);
  END IF;

  -- ---------- storage, realtime, anon and helpers ----------
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'deal-files' AND NOT public) THEN
    failed := array_append(failed, 'the deal-files bucket is missing or public'::text);
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND (SELECT count(*) FROM pg_publication_tables
           WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
             AND tablename IN ('group_messages', 'deal_rooms', 'deal_room_participants', 'deal_room_join_requests')) <> 4 THEN
    failed := array_append(failed, 'the deal-room tables are not in the supabase_realtime publication'::text);
  END IF;
  t := NULL;
  FOREACH s IN ARRAY ARRAY[
    'SELECT count(*)::text FROM public.deal_rooms',
    'SELECT count(*)::text FROM public.deal_room_roster',
    'SELECT count(*)::text FROM public.group_messages',
    'SELECT count(*)::text FROM public.deal_room_participants',
    'SELECT count(*)::text FROM public.bank_guest_policies',
    format('SELECT public.deal_room_access(%L)', r_lead),
    pg_temp.dr_create(c_agent, w_meta, '[' || cara || ']', consent)
  ] LOOP
    r := pg_temp.dr_try('anon', NULL, s);
    IF r NOT LIKE 'ERROR 42501:%' THEN t := concat_ws('; ', t, s || ' -> ' || r); END IF;
  END LOOP;
  n := n + 1;
  IF t IS NOT NULL THEN
    failed := array_append(failed, ('anon reached deal rooms: ' || t)::text);
  END IF;
  n := n + 1;
  IF has_function_privilege('authenticated', 'public.deal_room_add_unlisted(uuid, uuid, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.deal_room_refresh_count(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.deal_room_find_participant(uuid, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.deal_room_is_staff(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.deal_room_create(uuid, uuid, uuid, text, text, jsonb, jsonb)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.deal_rooms', 'INSERT')
     OR has_table_privilege('authenticated', 'public.deal_room_participants', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.group_messages', 'INSERT')
     OR has_table_privilege('authenticated', 'public.participant_consents', 'DELETE') THEN
    failed := array_append(failed, 'clients may call a deal-room helper or write a deal-room table'::text);
  END IF;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT088', MESSAGE = 'verify-deal-rooms rollback';
  EXCEPTION WHEN SQLSTATE 'ZT088' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'deal rooms verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'deal rooms verification passed (% checks)', n;
END
$verify$;
