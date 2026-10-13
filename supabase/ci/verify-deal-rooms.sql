-- Behavioural regression suite for deal rooms (migrations 088, 095, 096, 100).
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
-- bank is off); that an agent's bank guest waits for a team leader,
-- and that only a leader or admin who manages the room decides (095)
-- or adds a bank guest login (096);
-- who sees which room; that a guest reads only the roster, group
-- messages and receipts of their own rooms; that no client reads a
-- phone, a WhatsApp id or the invite link; the can_manage / can_post
-- truth table; the service functions (refused to clients, the group
-- lifecycle, join requests, membership events, message dedupe and the
-- service window); the private bucket and anon's grants; and
-- deal_room_settings, the account's group-invite template: an admin
-- writes it, an agent reads it but cannot write it, another account
-- and anon cannot read it. And 096's cancel: only the service role
-- cancels, only a room still `creating`, once; a late group never
-- opens a cancelled room (recorded once, NULL back), nor is handed back
-- as NULL (delete it) when another room holds that group, and a
-- cancelled room is never requested again; deal_room_fail_creation
-- fails only a room still `creating`, once, and says whether it did.
-- And 100's deal_room_apply_settings: a group's subject, description
-- and join approval mode from the webhook, in its own account only.
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
  r_x      UUID;   -- write-path checks: a room closed with a guest awaiting approval
  r_x2     UUID;   -- 096: a cancelled room whose late group another room holds
  r_y      UUID;   -- 096: the room opened on that group (as the reconcile would)
  r_z      UUID;   -- 096: a creating room deal_room_fail_creation fails
  p_x      UUID;
  p_guest  UUID;   -- the agent's bank guest participant
  p_team   UUID;   -- a bank guest in the teammate's room: the leader with a team decides
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
  v_team UUID; v_pl UUID; v_st UUID; v_deal_out UUID; v_deal_in UUID; v_ch UUID; v_pre UUID;
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
  -- 095: the approver must manage the room. The fixture's team leader has
  -- no team yet, so the agent's customer is not theirs to see: approving
  -- or rejecting there is refused; the admin may.
  r := pg_temp.dr_try('authenticated', u_lead, format('SELECT public.deal_room_approve_participant(%L, true)', p_guest))
       || ' / ' || pg_temp.dr_try('authenticated', u_lead, format('SELECT public.deal_room_approve_participant(%L, false)', p_guest));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501: deal rooms: only a manager of this room%'
                ' / ERROR 42501: deal rooms: only a manager of this room%'
     OR NOT EXISTS (SELECT 1 FROM deal_room_participants WHERE id = p_guest AND status = 'pending_approval')
     OR EXISTS (SELECT 1 FROM deal_room_audit
                 WHERE room_id = r_agent AND action IN ('participant_approved','participant_rejected')) THEN
    failed := array_append(failed, ('a team leader decided on a bank guest in a room they cannot see: ' || r)::text);
  END IF;
  r := pg_temp.dr_try('authenticated', u_admin, format('SELECT public.deal_room_approve_participant(%L, true)', p_guest));
  n := n + 1;
  IF r IS DISTINCT FROM 'invited'
     OR NOT EXISTS (SELECT 1 FROM deal_room_participants WHERE id = p_guest AND status = 'invited')
     OR NOT EXISTS (SELECT 1 FROM deal_room_audit
                     WHERE room_id = r_agent AND action = 'participant_approved' AND actor_id = u_admin) THEN
    failed := array_append(failed, ('an admin could not approve a bank guest: ' || r)::text);
  END IF;

  -- 096: adding a bank guest login needs the room's manager too. The
  -- leader (no team yet) cannot manage the agent's room, whose ADCB
  -- officer the admin has just approved; the guest stays out.
  r := pg_temp.dr_try('authenticated', u_lead,
         format('SELECT ''added'' FROM public.deal_room_add_guest_user(%L, %L)', r_agent, u_guest));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501: deal rooms: only a manager of this room%'
     OR EXISTS (SELECT 1 FROM chat_channel_members m JOIN deal_rooms d ON d.channel_id = m.channel_id
                 WHERE d.id = r_agent AND m.user_id = u_guest) THEN
    failed := array_append(failed, ('a team leader added a bank guest to a room they cannot manage: ' || r)::text);
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
         format('SELECT public.deal_room_group_created(%L, %L, %L, %L)::text', a_acct, 'dr-req-lead', 'dr-grp-lead@g.us', 'dr-hash-lead'));
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
         format('SELECT public.deal_room_group_created(%L, %L, %L, %L)::text', a_acct, 'dr-req-main', 'dr-grp-main@g.us', 'dr-hash-main'))
       || ' / ' || pg_temp.dr_try('service_role', NULL,
         format('SELECT public.deal_room_record_message(%L, %L, %L, %L, %L, %L, %L)::text', a_acct,
                'dr-grp-main@g.us', 'in', 'text', 'wamid.DR3', '971500880001', 'In the admin''s room'));
  IF r NOT LIKE 'requested / ' || r_main::text || ' / ________-%' THEN
    failed := array_append(failed, ('fixture: the admin''s room did not open: ' || r)::text);
  END IF;

  s := format('SELECT public.deal_room_record_join_request(%L, %L, %L, %L)', a_acct, 'dr-grp-lead@g.us', 'dr-jr-1', '971500880010');
  r := pg_temp.dr_try('service_role', NULL, s)
       || ' / ' || pg_temp.dr_try('service_role', NULL,
         format('SELECT public.deal_room_record_join_request(%L, %L, %L, %L)', a_acct, 'dr-grp-lead@g.us', 'dr-jr-2', '971500880099'))
       || ' / ' || pg_temp.dr_try('service_role', NULL, s);
  n := n + 1;
  IF r IS DISTINCT FROM 'auto_approved / pending / auto_approved'
     OR (SELECT count(*) FROM deal_room_join_requests WHERE room_id = r_lead) <> 2 THEN
    failed := array_append(failed, ('join requests (invited, stranger, redelivery): ' || r)::text);
  END IF;

  r := pg_temp.dr_try('service_role', NULL, format('SELECT public.deal_room_participant_event(%L, %L, %L, %L)', a_acct,
         'dr-grp-lead@g.us', '971500880010', 'joined'));
  SELECT id INTO p_pat FROM deal_room_participants WHERE room_id = r_lead AND phone = '971500880010';
  n := n + 1;
  IF r IS DISTINCT FROM 'joined'
     OR NOT EXISTS (SELECT 1 FROM deal_rooms WHERE id = r_lead AND participant_count = 2)
     OR NOT EXISTS (SELECT 1 FROM deal_room_participants WHERE id = p_pat AND status = 'joined' AND joined_at IS NOT NULL) THEN
    failed := array_append(failed, ('a joined event did not update participant_count: ' || r)::text);
  END IF;

  s := format('SELECT public.deal_room_record_message(%L, %L, %L, %L, %L, %L, %L)::text', a_acct,
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
         format('SELECT public.deal_room_record_message(%L, %L, %L, %L, %L, NULL, %L, NULL, NULL, %L)::text', a_acct,
                'dr-grp-lead@g.us', 'out', 'text', 'wamid.DR2', 'Hello everyone', u_lead));
  s := format('SELECT public.deal_room_record_receipt(%L, %L, %L, %L)::text', a_acct, 'wamid.DR2', '971500880010', 'read');
  r := pg_temp.dr_try('service_role', NULL, s) || ' / ' || pg_temp.dr_try('service_role', NULL, s);
  n := n + 1;
  IF r IS DISTINCT FROM 'true / false'
     OR NOT EXISTS (SELECT 1 FROM group_messages
                     WHERE wa_message_id = 'wamid.DR2' AND direction = 'out' AND status = 'read'
                       AND sender_participant_id = p_biz AND staff_user_id = u_lead AND sender_wa_id IS NULL)
     OR NOT EXISTS (SELECT 1 FROM group_message_receipts WHERE participant_id = p_pat AND status = 'read') THEN
    failed := array_append(failed, ('an outbound message and its receipt: ' || r)::text);
  END IF;

  r := pg_temp.dr_try('service_role', NULL, format('SELECT public.deal_room_record_message(%L, %L, %L, %L, %L, %L)::text', a_acct,
         'dr-no-such-group', 'in', 'text', 'wamid.DR9', '971500880010'))
       || ' / ' || pg_temp.dr_try('service_role', NULL, format('SELECT public.deal_room_record_join_request(%L, %L, %L, %L)', a_acct, 'dr-no-such-group', 'dr-jr-9', '971500880010'))
       || ' / ' || pg_temp.dr_try('service_role', NULL, format('SELECT public.deal_room_participant_event(%L, %L, %L, %L)', a_acct, 'dr-no-such-group', '971500880010', 'joined'))
       || ' / ' || pg_temp.dr_try('service_role', NULL, format('SELECT public.deal_room_record_receipt(%L, %L, %L, %L)::text', a_acct, 'wamid.DR9', '971500880010', 'read'));
  n := n + 1;
  IF r NOT LIKE 'ERROR P0002:% / ERROR P0002:% / ERROR P0002:% / false' THEN
    failed := array_append(failed, ('an unknown group was not P0002: ' || r)::text);
  END IF;

  -- Clients cannot call the service functions; a signed-in caller is
  -- refused even where EXECUTE slipped through (here: the owner).
  t := NULL;
  FOREACH s IN ARRAY ARRAY[
    format('SELECT ''x'' FROM public.deal_room_mark_requested(%L, %L)', r_agent, 'dr-req-x'),
    format('SELECT public.deal_room_group_created(%L, %L, %L, %L)::text', a_acct, 'dr-req-lead', 'dr-grp-lead@g.us', 'dr-hash-x'),
    format('SELECT ''x'' FROM public.deal_room_set_status(%L, %L)', r_lead, 'closed'),
    format('SELECT public.deal_room_record_join_request(%L, %L, %L, %L)', a_acct, 'dr-grp-lead@g.us', 'dr-jr-x', '971500880098'),
    format('SELECT public.deal_room_participant_event(%L, %L, %L, %L)', a_acct, 'dr-grp-lead@g.us', '971500880098', 'joined'),
    format('SELECT public.deal_room_record_message(%L, %L, %L, %L, %L, %L)::text', a_acct,
           'dr-grp-lead@g.us', 'in', 'text', 'wamid.DRX', '971500880098'),
    format('SELECT public.deal_room_record_receipt(%L, %L, %L, %L)::text', a_acct, 'wamid.DR2', '971500880003', 'read')
  ] LOOP
    r := pg_temp.dr_try('authenticated', u_lead, s);
    IF r NOT LIKE 'ERROR 42501:%' THEN t := concat_ws('; ', t, s || ' -> ' || r); END IF;
  END LOOP;
  r := pg_temp.dr_try(current_user, u_lead, format('SELECT public.deal_room_record_message(%L, %L, %L, %L, %L, %L)::text', a_acct,
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
  IF r IS DISTINCT FROM '1' THEN
    failed := array_append(failed, ('a team leader with no team sees rooms other than their own customer''s: ' || r)::text);
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
  r := pg_temp.dr_try('authenticated', u_guest, 'SELECT coalesce(string_agg(id::text, '',''), '''') FROM public.deal_room_guest_rooms');
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
  IF r IS DISTINCT FROM 'true/true/false/true/false/false/false/false' THEN
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

  -- ---------- deal_room_settings: the group-invite template ----------
  -- An admin writes the account's row; the agent's UPDATE matches no row
  -- (RLS) and their INSERT is refused, so the admin's name stays.
  r := pg_temp.dr_try('authenticated', u_admin, format(
         'INSERT INTO public.deal_room_settings (account_id, invite_template_name, updated_by) VALUES (%L, %L, %L)',
         a_acct, 'dr_group_invite', u_admin))
       || ' / ' || pg_temp.dr_try('authenticated', u_agent, format(
         'UPDATE public.deal_room_settings SET invite_template_name = %L WHERE account_id = %L', 'dr_agent_invite', a_acct))
       || ' / ' || pg_temp.dr_try('authenticated', u_agent, format(
         'INSERT INTO public.deal_room_settings (account_id, invite_template_name) VALUES (%L, %L)', a_acct, 'dr_agent_invite'));
  -- A statement of its own: the one above cannot see the rows its calls wrote.
  r := r || ' / ' || coalesce((SELECT invite_template_name FROM deal_room_settings WHERE account_id = a_acct), 'no row');
  n := n + 1;
  IF r NOT LIKE 'ok / ok / ERROR 42501:% / dr_group_invite' THEN
    failed := array_append(failed, ('deal_room_settings writes (admin insert, agent update, agent insert, name): ' || r)::text);
  END IF;
  -- Members of the account read it; another account's owner and anon do not.
  s := format('SELECT count(*)::text FROM public.deal_room_settings WHERE account_id = %L', a_acct);
  r := pg_temp.dr_try('authenticated', u_agent, s)
       || ' / ' || pg_temp.dr_try('authenticated', u_other, s)
       || ' / ' || pg_temp.dr_try('anon', NULL, s);
  n := n + 1;
  IF r NOT LIKE '1 / 0 / ERROR 42501:%' THEN
    failed := array_append(failed, ('deal_room_settings reads (agent, another account''s owner, anon): ' || r)::text);
  END IF;

  -- ---------- a team leader's and a guest's reach ----------
  -- A team leader with no team (the fixture's) is no supervisor of the
  -- admin's room on the agent's customer: no access, no managing, no
  -- adding themselves (so no Team notes), no rows, no room files.
  SELECT channel_id INTO v_ch FROM deal_rooms WHERE id = r_main;
  INSERT INTO deal_files (account_id, room_id, storage_path, name, source)
  VALUES (a_acct, r_main, format('account-%s/room-%s/f.pdf', a_acct, r_main), 'f.pdf', 'upload');
  s := format('SELECT public.deal_files_storage_can_read(%L)::text', format('account-%s/room-%s/f.pdf', a_acct, r_main));
  r := pg_temp.dr_try('authenticated', u_lead, format('SELECT coalesce(public.deal_room_access(%L), ''none'')', r_main))
       || '/' || pg_temp.dr_try('authenticated', u_lead, format('SELECT public.deal_room_can_manage(%L)::text', r_main))
       || '/' || left(pg_temp.dr_try('authenticated', u_lead,
         format('SELECT public.deal_room_add_staff(%L, ARRAY[%L]::uuid[])::text', r_main, u_lead)), 11)
       || '/' || pg_temp.dr_try('authenticated', u_lead, format('SELECT public.chat_can_read_channel(%L)::text', v_ch))
       || '/' || pg_temp.dr_try('authenticated', u_lead, format(
         'SELECT ((SELECT count(*) FROM public.deal_rooms WHERE id = %L)'
         ' + (SELECT count(*) FROM public.deal_room_participants WHERE room_id = %L)'
         ' + (SELECT count(*) FROM public.deal_room_roster WHERE room_id = %L)'
         ' + (SELECT count(*) FROM public.deal_files WHERE room_id = %L))::text', r_main, r_main, r_main, r_main))
       || '/' || pg_temp.dr_try('authenticated', u_lead, s)
       || '/' || pg_temp.dr_try('authenticated', u_admin, s);
  n := n + 1;
  IF r IS DISTINCT FROM 'none/false/ERROR 42501/false/0/false/true' THEN
    failed := array_append(failed, ('a team leader with no team (access/manage/add self/Team notes/rows/file; '
                                    || 'the admin''s file): ' || r)::text);
  END IF;
  -- With a team, the leader supervises the room of a teammate's customer,
  -- unless the room's deal is someone else's.
  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'DR team', u_lead) RETURNING id INTO v_team;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (v_team, u_agent2, a_acct);
  INSERT INTO pipelines (account_id, user_id, name) VALUES (a_acct, u_owner, 'DR pipe') RETURNING id INTO v_pl;
  INSERT INTO pipeline_stages (pipeline_id, name, position) VALUES (v_pl, 'New', 0) RETURNING id INTO v_st;
  INSERT INTO deals (account_id, user_id, pipeline_id, stage_id, contact_id, title)
  VALUES (a_acct, u_agent, v_pl, v_st, c_agent2, 'not the team''s') RETURNING id INTO v_deal_out;
  INSERT INTO deals (account_id, user_id, pipeline_id, stage_id, contact_id, title)
  VALUES (a_acct, u_agent2, v_pl, v_st, c_agent2, 'the team''s') RETURNING id INTO v_deal_in;
  s := format('SELECT coalesce(public.deal_room_access(%L), ''none'') || '' '' || public.deal_room_can_manage(%L)::text',
              r_agent2, r_agent2);
  r := pg_temp.dr_try('authenticated', u_lead, s);
  UPDATE deal_rooms SET deal_id = v_deal_out WHERE id = r_agent2;
  r := r || '/' || pg_temp.dr_try('authenticated', u_lead, s);
  UPDATE deal_rooms SET deal_id = v_deal_in WHERE id = r_agent2;
  r := r || '/' || pg_temp.dr_try('authenticated', u_lead, s);
  n := n + 1;
  IF r IS DISTINCT FROM 'supervisor true/none false/supervisor true' THEN
    failed := array_append(failed, ('a team leader with a team (teammate''s customer; another''s deal; '
                                    || 'the teammate''s deal): ' || r)::text);
  END IF;
  -- ... and so decides on a bank guest waiting there (095).
  INSERT INTO deal_room_participants (room_id, account_id, display_name, phone, role, bank_code, status)
  VALUES (r_agent2, a_acct, 'Di Bank', '971500880024', 'bank_guest', 'ADCB', 'pending_approval')
  RETURNING id INTO p_team;
  r := pg_temp.dr_try('authenticated', u_lead, format('SELECT public.deal_room_approve_participant(%L, true)', p_team));
  n := n + 1;
  IF r IS DISTINCT FROM 'invited'
     OR NOT EXISTS (SELECT 1 FROM deal_room_participants WHERE id = p_team AND status = 'invited')
     OR NOT EXISTS (SELECT 1 FROM deal_room_audit
                     WHERE room_id = r_agent2 AND action = 'participant_approved' AND actor_id = u_lead) THEN
    failed := array_append(failed, ('a team leader could not approve a bank guest in a room they supervise: ' || r)::text);
  END IF;
  -- A guest loses the room when their bank's guests are switched off,
  -- and when their bank's participant is removed from the group.
  s := format('SELECT coalesce(public.deal_room_access(%L), ''none'') || '' '' || public.deal_room_can_post(%L)::text'
              ' || '' '' || (SELECT count(*) FROM public.group_messages WHERE room_id = %L)', r_lead, r_lead, r_lead);
  r := pg_temp.dr_try('authenticated', u_guest, s);
  UPDATE bank_guest_policies SET guests_allowed = false WHERE account_id = a_acct AND bank_code = 'ADCB';
  r := r || '/' || pg_temp.dr_try('authenticated', u_guest, s);
  UPDATE bank_guest_policies SET guests_allowed = true WHERE account_id = a_acct AND bank_code = 'ADCB';
  UPDATE deal_room_participants SET status = 'removed' WHERE room_id = r_lead AND role = 'bank_guest';
  r := r || '/' || pg_temp.dr_try('authenticated', u_guest, s);
  UPDATE deal_room_participants SET status = 'joined' WHERE room_id = r_lead AND role = 'bank_guest';
  n := n + 1;
  IF r IS DISTINCT FROM 'guest true 2/none false 0/none false 0' THEN
    failed := array_append(failed, ('a guest (cleared; bank switched off; participant removed): ' || r)::text);
  END IF;
  -- A guest's roster masks someone nobody listed (named after their
  -- number); staff read the name. A guest reads no message from before
  -- they joined; staff do.
  PERFORM public.deal_room_add_unlisted(r_lead, a_acct, '971555000111');
  INSERT INTO group_messages (room_id, account_id, direction, type, body, created_at)
  VALUES (r_lead, a_acct, 'in', 'text', 'before the guest joined', now() - interval '1 day') RETURNING id INTO v_pre;
  r := pg_temp.dr_try('authenticated', u_guest, format(
         'SELECT count(*) FILTER (WHERE display_name ~ ''555000111'') || '' '' '
         ' || count(*) FILTER (WHERE display_name = ''Unlisted number ending 11'') FROM public.deal_room_roster WHERE room_id = %L', r_lead))
       || '/' || pg_temp.dr_try('authenticated', u_lead, format(
         'SELECT count(*)::text FROM public.deal_room_roster WHERE room_id = %L AND display_name = ''+971555000111''', r_lead))
       || '/' || pg_temp.dr_try('authenticated', u_guest,
         format('SELECT count(*)::text FROM public.group_messages WHERE id = %L', v_pre))
       || '/' || pg_temp.dr_try('authenticated', u_lead,
         format('SELECT count(*)::text FROM public.group_messages WHERE id = %L', v_pre));
  n := n + 1;
  IF r IS DISTINCT FROM '0 1/1/0/1' THEN
    failed := array_append(failed, ('a guest''s roster masks an unlisted number; a guest reads no earlier message '
                                    || '(guest roster / leader roster / guest / leader): ' || r)::text);
  END IF;

  -- ---------- write paths: auto-approval, closed rooms, consent and contact links ----------
  -- The consent is the consented contact's own: the seven-person room's
  -- customer has another number, so their row carries none.
  n := n + 1;
  IF EXISTS (SELECT 1 FROM deal_room_participants WHERE room_id = r_seven AND consent_id IS NOT NULL)
     OR NOT EXISTS (SELECT 1 FROM deal_room_participants p JOIN participant_consents pc ON pc.id = p.consent_id
                     WHERE p.room_id = r_lead AND p.role = 'customer' AND pc.contact_id = c_lead) THEN
    failed := array_append(failed, 'consent: not only on the consented contact''s own row'::text);
  END IF;
  -- An expected, consented customer is let in; a bank guest whose bank was
  -- switched off and a partner who opted out wait for a person.
  r := pg_temp.dr_try('service_role', NULL, format('SELECT public.deal_room_record_join_request(%L, %L, %L, %L)', a_acct,
         'dr-grp-lead@g.us', 'dr-jr-c1', '971500880003'));
  UPDATE bank_guest_policies SET guests_allowed = false WHERE account_id = a_acct AND bank_code = 'ADCB';
  INSERT INTO contacts (account_id, user_id, phone, name, opted_out_at)
  VALUES (a_acct, u_agent, '971500880010', 'Pat as a contact', now());
  r := r || ' / ' || pg_temp.dr_try('service_role', NULL, format('SELECT public.deal_room_record_join_request(%L, %L, %L, %L)', a_acct,
         'dr-grp-lead@g.us', 'dr-jr-b1', '971500880021'))
       || ' / ' || pg_temp.dr_try('service_role', NULL, format('SELECT public.deal_room_record_join_request(%L, %L, %L, %L)', a_acct,
         'dr-grp-main@g.us', 'dr-jr-o1', '971500880010'));
  UPDATE bank_guest_policies SET guests_allowed = true WHERE account_id = a_acct AND bank_code = 'ADCB';
  n := n + 1;
  IF r IS DISTINCT FROM 'auto_approved / pending / pending' THEN
    failed := array_append(failed, ('join requests (consented customer, bank switched off, opted out): ' || r)::text);
  END IF;
  -- A room that is not open lets nobody in by itself.
  r := pg_temp.dr_try('service_role', NULL, format('SELECT ''s'' FROM public.deal_room_set_status(%L, %L)', r_lead, 'suspended'))
       || ' / ' || pg_temp.dr_try('service_role', NULL, format('SELECT public.deal_room_record_join_request(%L, %L, %L, %L)', a_acct,
         'dr-grp-lead@g.us', 'dr-jr-c2', '971500880003'))
       || ' / ' || pg_temp.dr_try('service_role', NULL, format('SELECT ''c'' FROM public.deal_room_set_status(%L, %L)', r_lead, 'closed'))
       || ' / ' || pg_temp.dr_try('service_role', NULL, format('SELECT public.deal_room_record_join_request(%L, %L, %L, %L)', a_acct,
         'dr-grp-lead@g.us', 'dr-jr-c3', '971500880003'));
  n := n + 1;
  IF r IS DISTINCT FROM 's / pending / c / pending' THEN
    failed := array_append(failed, ('join requests on a suspended, then closed room: ' || r)::text);
  END IF;
  -- A closed room takes no outbound message and nobody new; an inbound
  -- message and a system note are still kept for the record.
  r := pg_temp.dr_try('authenticated', u_agent, pg_temp.dr_create(c_agent, w_meta,
         '[' || cara || ', {"display_name": "Bo Bank", "phone": "971500880023", "role": "bank_guest", "bank_code": "ADCB"}]',
         consent));
  IF r ~ '^[0-9a-f]{8}-' THEN r_x := r::uuid; END IF;
  SELECT id INTO p_x FROM deal_room_participants WHERE room_id = r_x AND status = 'pending_approval';
  PERFORM pg_temp.dr_try('service_role', NULL, format('SELECT ''c'' FROM public.deal_room_set_status(%L, %L)', r_x, 'closed'));
  r := pg_temp.dr_try('service_role', NULL, format('SELECT public.deal_room_record_message(%L, %L, %L, %L, %L, NULL, %L, NULL, NULL, %L)::text', a_acct,
         'dr-grp-lead@g.us', 'out', 'text', 'wamid.DRC1', 'After the close', u_lead))
       || ' / ' || pg_temp.dr_try('authenticated', u_lead,
         format('SELECT public.deal_room_add_staff(%L, ARRAY[%L]::uuid[])::text', r_lead, u_agent2))
       || ' / ' || pg_temp.dr_try('authenticated', u_lead,
         format('SELECT ''added'' FROM public.deal_room_add_guest_user(%L, %L)', r_lead, u_guest))
       || ' / ' || pg_temp.dr_try('authenticated', u_admin,
         format('SELECT public.deal_room_approve_participant(%L, true)', p_x));
  n := n + 1;
  IF p_x IS NULL OR r NOT LIKE 'ERROR 22023: deal rooms: the room is closed% / ERROR 22023: deal rooms: the room is closed%'
                             ' / ERROR 22023: deal rooms: the room is closed% / ERROR 22023: deal rooms: the room is closed%'
     OR EXISTS (SELECT 1 FROM group_messages WHERE wa_message_id = 'wamid.DRC1')
     OR EXISTS (SELECT 1 FROM deal_rooms d JOIN chat_channel_members m ON m.channel_id = d.channel_id
                 WHERE d.id = r_lead AND m.user_id = u_agent2) THEN
    failed := array_append(failed, ('a closed room took an outbound message, staff, a guest or an approval: ' || r)::text);
  END IF;
  r := pg_temp.dr_try('service_role', NULL, format('SELECT public.deal_room_record_message(%L, %L, %L, %L, %L, %L, %L)::text', a_acct,
         'dr-grp-lead@g.us', 'in', 'text', 'wamid.DRC2', '971500880010', 'Late reply'))
       || ' / ' || pg_temp.dr_try('service_role', NULL, format('SELECT public.deal_room_record_message(%L, %L, %L, %L, NULL, NULL, %L, NULL, NULL, NULL, %L)::text', a_acct,
         'dr-grp-lead@g.us', 'out', 'system', 'Someone asked to stop', 'sent'));
  n := n + 1;
  IF r !~ '^[0-9a-f]{8}-.* / [0-9a-f]{8}-' THEN
    failed := array_append(failed, ('a closed room dropped a late inbound message or system note: ' || r)::text);
  END IF;
  -- A contact the agent cannot see: unknown, opted out or not, and never
  -- linked by phone.
  INSERT INTO contacts (account_id, user_id, phone, name, opted_out_at)
  VALUES (a_acct, u_agent2, '971500880006', 'Hidden opted-out contact', now());
  r := pg_temp.dr_try('authenticated', u_agent, pg_temp.dr_create(c_agent, w_meta,
         '[' || cara || format(', {"display_name": "Ivy Invisible", "phone": "971500880030", "role": "partner", "contact_id": "%s"}]',
         c_agent2), consent))
       || ' / ' || pg_temp.dr_try('authenticated', u_agent, pg_temp.dr_create(c_agent, w_meta,
         '[' || cara || ', {"display_name": "Hal Hidden", "phone": "971500880006", "role": "partner"}]', consent));
  n := n + 1;
  IF r NOT LIKE 'ERROR P0002: deal rooms: the contact given for Ivy Invisible was not found%'
                ' / ERROR P0002: deal rooms: the contact given for Hal Hidden was not found%' THEN
    failed := array_append(failed, ('an invisible contact (given, opted out) was not an unknown contact: ' || r)::text);
  END IF;
  r := pg_temp.dr_try('authenticated', u_agent, pg_temp.dr_create(c_agent, w_meta,
         '[' || cara || ', {"display_name": "Cy Again", "phone": "971500880002", "role": "partner"}]', consent));
  n := n + 1;
  IF r !~ '^[0-9a-f]{8}-' OR EXISTS (SELECT 1 FROM deal_room_participants
                                       WHERE room_id = r::uuid AND phone = '971500880002' AND contact_id IS NOT NULL)
     OR has_function_privilege('authenticated', 'public.deal_room_admit_block(uuid, text)', 'EXECUTE') THEN
    failed := array_append(failed, ('linked by phone to a contact the agent cannot see, or admit_block is a client''s: ' || r)::text);
  END IF;

  -- Webhook-driven functions act only in the account the webhook
  -- authenticated: another account naming this account's request, group
  -- or message id changes nothing; the same account's receipt lands.
  s := (SELECT wa_group_id FROM deal_rooms WHERE id = r_main);
  r := pg_temp.dr_try('service_role', NULL, format('SELECT public.deal_room_group_created(%L, %L, %L, %L)::text',
         b_acct, (SELECT create_request_id FROM deal_rooms WHERE id = r_main), s, 'dr-hash-f4c'))
       || ' / ' || pg_temp.dr_try('service_role', NULL, format('SELECT public.deal_room_record_join_request(%L, %L, %L, %L)',
         b_acct, s, 'dr-jr-f4c', '971500880001'))
       || ' / ' || pg_temp.dr_try('service_role', NULL, format('SELECT public.deal_room_participant_event(%L, %L, %L, %L)',
         b_acct, s, '971500880077', 'joined'))
       || ' / ' || pg_temp.dr_try('service_role', NULL, format('SELECT public.deal_room_record_message(%L, %L, %L, %L, %L, %L)::text',
         b_acct, s, 'in', 'text', 'wamid.DRF4D', '971500880001'));
  n := n + 1;
  IF s IS NULL OR r NOT LIKE 'ERROR P0002:% / ERROR P0002:% / ERROR P0002:% / ERROR P0002:%'
     OR (SELECT invite_link_hash FROM deal_rooms WHERE id = r_main) IS NOT DISTINCT FROM 'dr-hash-f4c'
     OR EXISTS (SELECT 1 FROM deal_room_join_requests WHERE join_request_id = 'dr-jr-f4c')
     OR EXISTS (SELECT 1 FROM deal_room_participants WHERE room_id = r_main AND phone = '971500880077')
     OR EXISTS (SELECT 1 FROM group_messages WHERE wa_message_id = 'wamid.DRF4D') THEN
    failed := array_append(failed, ('another account reached a room by its ids: ' || coalesce(r, 'no group'))::text);
  END IF;
  INSERT INTO group_messages (room_id, account_id, wa_message_id, direction, type, body, status)
  VALUES (r_main, a_acct, 'wamid.DRF4C', 'out', 'text', 'Receipt scope', 'sent');
  r := pg_temp.dr_try('service_role', NULL, format('SELECT public.deal_room_record_receipt(%L, %L, %L, %L)::text',
         b_acct, 'wamid.DRF4C', '971500880001', 'failed'))
       || ' / ' || pg_temp.dr_try('service_role', NULL, format('SELECT public.deal_room_record_receipt(%L, %L, %L, %L)::text',
         b_acct, 'wamid.DRF4C', '971500880001', 'read'));
  n := n + 1;
  IF r IS DISTINCT FROM 'false / false'
     OR (SELECT status FROM group_messages WHERE wa_message_id = 'wamid.DRF4C') IS DISTINCT FROM 'sent'
     OR EXISTS (SELECT 1 FROM group_message_receipts g JOIN group_messages m ON m.id = g.message_id
                 WHERE m.wa_message_id = 'wamid.DRF4C') THEN
    failed := array_append(failed, ('a receipt from another account changed a message: ' || r)::text);
  END IF;
  r := pg_temp.dr_try('service_role', NULL, format('SELECT public.deal_room_record_receipt(%L, %L, %L, %L)::text',
         a_acct, 'wamid.DRF4C', '971500880001', 'read'));
  n := n + 1;
  IF r IS DISTINCT FROM 'true'
     OR (SELECT status FROM group_messages WHERE wa_message_id = 'wamid.DRF4C') IS DISTINCT FROM 'read'
     OR (SELECT count(*) FROM group_message_receipts g JOIN group_messages m ON m.id = g.message_id
          WHERE m.wa_message_id = 'wamid.DRF4C') <> 1 THEN
    failed := array_append(failed, ('a receipt in its own account did not land: ' || r)::text);
  END IF;

  -- deal_rooms is staff-only: a guest reads no row of it (so none of
  -- wa_group_id, contact_id, deal_id, last_error) and sees exactly their
  -- guest rooms through deal_room_guest_rooms; staff still read it.
  s := pg_temp.dr_try(current_user, u_guest,
         'SELECT string_agg(id::text, '','' ORDER BY id) FROM public.deal_rooms WHERE public.deal_room_access(id) = ''guest''');
  r := pg_temp.dr_try('authenticated', u_guest,
         'SELECT count(*)::text FROM (SELECT wa_group_id, contact_id, deal_id, last_error FROM public.deal_rooms) x')
       || ' / ' || pg_temp.dr_try('authenticated', u_guest,
         'SELECT coalesce(string_agg(id::text, '','' ORDER BY id), ''none'') FROM public.deal_room_guest_rooms');
  n := n + 1;
  IF s IN ('ok', '') OR s LIKE 'ERROR%' OR r IS DISTINCT FROM '0 / ' || s THEN
    failed := array_append(failed, ('a guest read deal_rooms, or the guest view is not their rooms ('
                                    || coalesce(s, 'none') || '): ' || r)::text);
  END IF;
  r := pg_temp.dr_try('authenticated', u_admin, 'SELECT count(*)::text FROM public.deal_rooms');
  n := n + 1;
  IF r IS DISTINCT FROM (SELECT count(*)::text FROM deal_rooms WHERE account_id = a_acct) OR r = '0' THEN
    failed := array_append(failed, ('staff no longer read deal_rooms: ' || r)::text);
  END IF;
  -- A guest put in the channel of a room with no approved participant of
  -- their bank still does not see it.
  r := (SELECT d.id::text FROM deal_rooms d
         WHERE d.account_id = a_acct
           AND NOT EXISTS (SELECT 1 FROM chat_channel_members m WHERE m.channel_id = d.channel_id AND m.user_id = u_guest)
           AND NOT EXISTS (SELECT 1 FROM deal_room_participants pp
                            WHERE pp.room_id = d.id AND pp.bank_code = 'ADCB'
                              AND pp.status NOT IN ('pending_approval','rejected','removed'))
         ORDER BY d.created_at LIMIT 1);
  INSERT INTO chat_channel_members (channel_id, user_id) SELECT channel_id, u_guest FROM deal_rooms WHERE id = r::uuid;
  s := pg_temp.dr_try('authenticated', u_guest,
         'SELECT coalesce(string_agg(id::text, '','' ORDER BY id), ''none'') FROM public.deal_room_guest_rooms');
  n := n + 1;
  IF r IS NULL OR s LIKE 'ERROR%' OR position(r IN s) > 0 THEN
    failed := array_append(failed, ('the guest view showed a room of another bank: '
                                    || coalesce(r, 'no such room') || ' in ' || s)::text);
  END IF;

  -- ---------- 096: cancelling a room still being created ----------
  r := pg_temp.dr_try('authenticated', u_admin, pg_temp.dr_create(c_agent, w_meta, '[' || cara || ']', consent));
  r_x := NULL;
  IF r ~ '^[0-9a-f]{8}-' THEN r_x := r::uuid; END IF;
  PERFORM pg_temp.dr_try('service_role', NULL,
            format('SELECT ''requested'' FROM public.deal_room_mark_requested(%L, %L)', r_x, 'dr-req-cancel'));
  -- A signed-in manager cannot call it: the route calls it on the service role.
  r := pg_temp.dr_try('authenticated', u_admin,
         format('SELECT public.deal_room_cancel_creation(%L, %L, %L)', r_x, u_admin, 'Cancelled: wrong customer'));
  n := n + 1;
  IF r_x IS NULL OR r NOT LIKE 'ERROR 42501:%'
     OR NOT EXISTS (SELECT 1 FROM deal_rooms WHERE id = r_x AND status = 'creating' AND cancelled_at IS NULL) THEN
    failed := array_append(failed, ('a client called deal_room_cancel_creation: ' || r)::text);
  END IF;
  r := pg_temp.dr_try('service_role', NULL,
         format('SELECT public.deal_room_cancel_creation(%L, %L, %L)', r_x, u_admin, 'Cancelled: wrong customer'))
       || ' / ' || pg_temp.dr_try('service_role', NULL,
         format('SELECT public.deal_room_cancel_creation(%L, %L, %L)', r_x, u_admin, 'Cancelled: again'));
  n := n + 1;
  IF r IS DISTINCT FROM 'cancelled / cancelled'
     OR NOT EXISTS (SELECT 1 FROM deal_rooms WHERE id = r_x AND status = 'failed' AND cancelled_at IS NOT NULL
                       AND last_error = 'Cancelled: wrong customer')
     OR (SELECT count(*) FROM deal_room_audit WHERE room_id = r_x AND action = 'create_cancelled'
                                                AND actor_id = u_admin) <> 1
     OR NOT EXISTS (SELECT 1 FROM deal_room_audit WHERE room_id = r_x AND action = 'status_changed'
                       AND detail ->> 'from' = 'creating' AND detail ->> 'to' = 'failed') THEN
    failed := array_append(failed, ('the service role could not cancel a creating room once: ' || r)::text);
  END IF;
  -- The group arrives late (twice): the room stays failed and groupless,
  -- the group is recorded once, and NULL tells the webhook nothing opened.
  s := format('SELECT coalesce(public.deal_room_group_created(%L, %L, %L, NULL)::text, ''null'')',
              a_acct, 'dr-req-cancel', 'dr-grp-cancel@g.us');
  r := pg_temp.dr_try('service_role', NULL, s) || ' / ' || pg_temp.dr_try('service_role', NULL, s);
  n := n + 1;
  IF r IS DISTINCT FROM 'null / null'
     OR NOT EXISTS (SELECT 1 FROM deal_rooms WHERE id = r_x AND status = 'failed' AND wa_group_id IS NULL)
     OR (SELECT count(*) FROM deal_room_audit WHERE room_id = r_x AND action = 'group_discarded'
                                                AND detail ->> 'group_id' = 'dr-grp-cancel@g.us') <> 1
     OR EXISTS (SELECT 1 FROM deal_room_audit WHERE room_id = r_x AND action = 'group_created') THEN
    failed := array_append(failed, ('a late group opened a cancelled room: ' || r)::text);
  END IF;
  -- Nor is it asked for again (the create route or a reconcile that read it earlier).
  r := pg_temp.dr_try('service_role', NULL,
         format('SELECT ''requested'' FROM public.deal_room_mark_requested(%L, %L)', r_x, 'dr-req-cancel-2'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 22023: deal rooms: the room was cancelled%'
     OR NOT EXISTS (SELECT 1 FROM deal_rooms WHERE id = r_x AND status = 'failed'
                       AND create_request_id = 'dr-req-cancel') THEN
    failed := array_append(failed, ('a cancelled room was requested again: ' || r)::text);
  END IF;
  -- A room whose group exists is not cancelled: its status (the main
  -- room's, whatever it is by now) comes back unchanged.
  t := (SELECT status FROM deal_rooms WHERE id = r_main);
  r := pg_temp.dr_try('service_role', NULL,
         format('SELECT public.deal_room_cancel_creation(%L, %L, %L)', r_main, u_admin, 'Cancelled: too late'));
  n := n + 1;
  IF t IS NULL OR t = 'creating' OR r IS DISTINCT FROM t
     OR NOT EXISTS (SELECT 1 FROM deal_rooms WHERE id = r_main AND status = t AND cancelled_at IS NULL)
     OR EXISTS (SELECT 1 FROM deal_room_audit WHERE room_id = r_main AND action = 'create_cancelled') THEN
    failed := array_append(failed, ('a room with a group was cancelled: ' || r || ' (was ' || coalesce(t, 'none') || ')')::text);
  END IF;
  -- A cancelled room's late group that another room holds by now (the
  -- reconcile matched that room to it by subject, then invited people
  -- into it) is refused, as 088's unique wa_group_id refused it: NULL
  -- would have the webhook delete the group with those people in it.
  s := pg_temp.dr_try('authenticated', u_admin, pg_temp.dr_create(c_agent, w_meta, '[' || cara || ']', consent));
  t := pg_temp.dr_try('authenticated', u_admin, pg_temp.dr_create(c_agent, w_meta, '[' || cara || ']', consent));
  r_x2 := NULL;
  r_y := NULL;
  IF s ~ '^[0-9a-f]{8}-' THEN r_x2 := s::uuid; END IF;
  IF t ~ '^[0-9a-f]{8}-' THEN r_y := t::uuid; END IF;
  PERFORM pg_temp.dr_try('service_role', NULL,
            format('SELECT ''requested'' FROM public.deal_room_mark_requested(%L, %L)', r_x2, 'dr-req-x2'));
  PERFORM pg_temp.dr_try('service_role', NULL,
            format('SELECT public.deal_room_cancel_creation(%L, %L, %L)', r_x2, u_admin, 'Cancelled: duplicate'));
  PERFORM pg_temp.dr_try('service_role', NULL,
            format('SELECT ''requested'' FROM public.deal_room_mark_requested(%L, %L)', r_y, 'dr-req-y2'));
  PERFORM pg_temp.dr_try('service_role', NULL,
            format('SELECT public.deal_room_group_created(%L, %L, %L, NULL)::text', a_acct, 'dr-req-y2', 'dr-grp-shared@g.us'));
  r := pg_temp.dr_try('service_role', NULL,
         format('SELECT coalesce(public.deal_room_group_created(%L, %L, %L, NULL)::text, ''null'')',
                a_acct, 'dr-req-x2', 'dr-grp-shared@g.us'));
  n := n + 1;
  IF r_x2 IS NULL OR r_y IS NULL OR r NOT LIKE 'ERROR 23505:%'
     OR NOT EXISTS (SELECT 1 FROM deal_rooms WHERE id = r_y AND status = 'open' AND wa_group_id = 'dr-grp-shared@g.us')
     OR NOT EXISTS (SELECT 1 FROM deal_rooms WHERE id = r_x2 AND status = 'failed' AND cancelled_at IS NOT NULL
                       AND wa_group_id IS NULL)
     OR EXISTS (SELECT 1 FROM deal_room_audit WHERE room_id = r_x2 AND action = 'group_discarded') THEN
    failed := array_append(failed, ('a cancelled room''s late group was given up though another room holds it: '
                                    || r || ' (rooms ' || s || ', ' || t || ')')::text);
  END IF;
  -- deal_room_fail_creation (service role only) fails a room still
  -- `creating` once and answers true; a cancelled or open room, or the
  -- same room again, answers false and is left as it was.
  r := pg_temp.dr_try('authenticated', u_admin, pg_temp.dr_create(c_agent, w_meta, '[' || cara || ']', consent));
  r_z := NULL;
  IF r ~ '^[0-9a-f]{8}-' THEN r_z := r::uuid; END IF;
  s := format('SELECT public.deal_room_fail_creation(%L, %L)::text', r_z, 'Meta refused');
  r := pg_temp.dr_try('authenticated', u_admin, s)
       || ' / ' || pg_temp.dr_try('service_role', NULL, s)
       || ' / ' || pg_temp.dr_try('service_role', NULL, s)
       || ' / ' || pg_temp.dr_try('service_role', NULL,
                     format('SELECT public.deal_room_fail_creation(%L, %L)::text', r_x2, 'Meta refused'))
       || ' / ' || pg_temp.dr_try('service_role', NULL,
                     format('SELECT public.deal_room_fail_creation(%L, %L)::text', r_y, 'Meta refused'));
  n := n + 1;
  IF r_z IS NULL OR r NOT LIKE 'ERROR 42501:% / true / false / false / false'
     OR NOT EXISTS (SELECT 1 FROM deal_rooms WHERE id = r_z AND status = 'failed' AND last_error = 'Meta refused')
     OR (SELECT count(*) FROM deal_room_audit WHERE room_id = r_z AND action = 'status_changed') <> 1
     OR NOT EXISTS (SELECT 1 FROM deal_rooms WHERE id = r_y AND status = 'open')
     OR NOT EXISTS (SELECT 1 FROM deal_rooms WHERE id = r_x2 AND last_error = 'Cancelled: duplicate') THEN
    failed := array_append(failed, ('deal_room_fail_creation did not fail only a creating room, once: ' || r)::text);
  END IF;

  -- 100: a group send is costed per delivered member, at the member's
  -- market, in the message's one category (Meta priced it on `sent`);
  -- a redelivered receipt counts once, a read is not billed, a delivery
  -- naming no member is refused, another account's receipt never
  -- touches our message, and a client cannot call it.
  -- A field of dr_try's jsonb answer, or the error it returned.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.dr_j(p text, p_path text[])
    RETURNS text LANGUAGE sql AS $body$
      SELECT CASE WHEN p LIKE 'ERROR%' THEN p ELSE coalesce(p::jsonb #>> p_path, 'null') END
    $body$
  $fn$;
  INSERT INTO group_messages (room_id, account_id, wa_message_id, direction, type, body, status)
  VALUES (r_lead, a_acct, 'dr-cost-1', 'out', 'text', 'Hello', 'sent');
  t := '{"id": "dr-cost-1", "recipient_type": "group", "recipient_id": "dr-grp-lead@g.us", "timestamp": "1793000000"';
  s := 'SELECT public.deal_room_record_cost(%L, %L, %L::jsonb)::text';
  r := pg_temp.dr_try('authenticated', u_admin, format(s, a_acct, 'PN-DR', t || ', "status": "sent"}'));
  PERFORM pg_temp.dr_try('service_role', NULL, format(s, a_acct, 'PN-DR',
    t || ', "status": "sent", "pricing": {"category": "marketing", "pricing_model": "PMP"}}'));
  PERFORM pg_temp.dr_try('service_role', NULL, format(s, a_acct, 'PN-DR',
    t || ', "status": "delivered", "recipient_participant_id": "971500880001"}'));
  PERFORM pg_temp.dr_try('service_role', NULL, format(s, a_acct, 'PN-DR',
    t || ', "status": "delivered", "participant_recipient_id": "966500880002", "pricing": {"category": "marketing", "billable": true}}'));
  r := r || ' / ' || pg_temp.dr_j(pg_temp.dr_try('service_role', NULL, format(s, a_acct, 'PN-DR',
    t || ', "status": "delivered", "recipient_participant_id": "971500880001"}')), '{data,duplicate}')
    || ' / ' || pg_temp.dr_j(pg_temp.dr_try('service_role', NULL, format(s, a_acct, 'PN-DR',
    t || ', "status": "read", "recipient_participant_id": "971500880001"}')), '{ok}')
    || ' / ' || pg_temp.dr_j(pg_temp.dr_try('service_role', NULL, format(s, a_acct, 'PN-DR',
    t || ', "status": "delivered"}')), '{error,code}')
    || ' / ' || pg_temp.dr_j(pg_temp.dr_try('service_role', NULL, format(s, b_acct, 'PN-B',
    t || ', "status": "delivered", "recipient_participant_id": "971500880009"}')), '{ok}');
  -- A separate statement: one sees no write its own function calls made.
  r := r || ' / ' || coalesce((SELECT category || ':' || recipients_billed FROM group_messages WHERE wa_message_id = 'dr-cost-1'), '-')
    || ' / ' || coalesce((SELECT string_agg(recipient_market || '=' || (cost_usd = whatsapp_resolve_rate(recipient_market,
                          'marketing', DATE '2026-10-25'))::text, ',' ORDER BY recipient_market)
                   FROM whatsapp_message_costs
                  WHERE message_id = 'dr-cost-1' AND status = 'delivered' AND account_id = a_acct), '-');
  n := n + 1;
  IF r IS NULL OR r NOT LIKE 'ERROR 42501:% / true / true / BAD_STATUS / true / marketing:2 / AE=true,SA=true' THEN
    failed := array_append(failed, ('a group send is not costed once per delivered member: ' || coalesce(r, 'NULL'))::text);
  END IF;

  -- 100: a group's settings, as a group_settings_update webhook reports
  -- them, land on the room of the account the webhook authenticated,
  -- renaming its Team notes channel; a client, another account, a
  -- redelivery, values the room cannot hold and a closed room change
  -- nothing, and a cleared description clears it.
  s := 'SELECT public.deal_room_apply_settings(%L, %L, %L::jsonb)::text';
  t := '{"subject": "  ' || repeat('Villa ', 15) || 'deal  ", "description": "Two bedrooms", '
       || '"join_approval_mode": "auto_approve"}';
  r := pg_temp.dr_try('authenticated', u_admin, format(s, a_acct, 'dr-grp-shared@g.us', t))
       || ' / ' || pg_temp.dr_try('service_role', NULL, format(s, b_acct, 'dr-grp-shared@g.us', t))
       || ' / ' || pg_temp.dr_try('service_role', NULL, format(s, a_acct, 'dr-grp-shared@g.us', t))
       || ' / ' || pg_temp.dr_try('service_role', NULL, format(s, a_acct, 'dr-grp-shared@g.us', t))
       || ' / ' || pg_temp.dr_try('service_role', NULL, format(s, a_acct, 'dr-grp-shared@g.us',
                     '{"subject": "   ", "description": 7, "join_approval_mode": "open"}'))
       || ' / ' || pg_temp.dr_try('service_role', NULL, format(s, a_acct, 'dr-grp-shared@g.us', '{"description": null}'))
       || ' / ' || pg_temp.dr_try('service_role', NULL, format(s, a_acct, 'dr-grp-lead@g.us', '{"subject": "Reopened"}'));
  n := n + 1;
  IF r IS NULL OR r NOT LIKE 'ERROR 42501:% / ERROR P0002:% / true / false / false / true / false'
     OR NOT EXISTS (SELECT 1 FROM deal_rooms d JOIN chat_channels c ON c.id = d.channel_id
                     WHERE d.id = r_y AND d.subject = btrim(repeat('Villa ', 15) || 'deal')
                       AND c.name = left(d.subject, 80) AND d.description IS NULL
                       AND d.join_approval_mode = 'auto_approve')
     OR (SELECT count(*) FROM deal_room_audit WHERE room_id = r_y AND action = 'settings_changed') <> 2
     OR EXISTS (SELECT 1 FROM deal_rooms WHERE id = r_lead AND subject = 'Reopened') THEN
    failed := array_append(failed, ('a group settings update was not applied once, in its own account: '
                                    || coalesce(r, 'NULL'))::text);
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
