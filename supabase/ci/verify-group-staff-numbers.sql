-- Behavioural regression suite for staff numbers in groups (migration 219).
--
-- staff_by_saved_phone(account, phone) names the one live agent / team
-- leader whose saved number (coordinator_phones) the phone is, digits
-- compared and a leading 00 dropped; NULL for blank, @lid, no match or
-- two matches. A participant inserted into a WhatsApp group with such a
-- number makes the person a manager (AFTER INSERT only: an upsert that
-- updates an existing participant grants nothing); saving a number
-- grants every group it is already in. sg_staff_number_joined puts the
-- person on an ACTIVE submission group's access list as 'coordinator'.
-- All three functions are EXECUTE for service_role only.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The fixtures are
-- rolled back by a sentinel exception; the results survive in plpgsql
-- variables.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000219001';
  u_agent  UUID := '00000000-0000-4000-8000-000000219002';
  u_lead   UUID := '00000000-0000-4000-8000-000000219003';
  u_viewer UUID := '00000000-0000-4000-8000-000000219004';
  u_off    UUID := '00000000-0000-4000-8000-000000219005';
  u_late   UUID := '00000000-0000-4000-8000-000000219006';
  u_dup1   UUID := '00000000-0000-4000-8000-000000219007';
  u_dup2   UUID := '00000000-0000-4000-8000-000000219008';
  u_sg     UUID := '00000000-0000-4000-8000-000000219009';
  a_acct   UUID;
  w1       UUID;
  c1       UUID;
  g1       UUID;
  g2       UUID;
  g_sg     UUID;
  g_end    UUID;
  tok      UUID;
  r        UUID;
  k        INT;
  fn       TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
    INSERT INTO auth.users (id, email) VALUES
      (u_owner,  'g219-owner@example.invalid'),
      (u_agent,  'g219-agent@example.invalid'),
      (u_lead,   'g219-lead@example.invalid'),
      (u_viewer, 'g219-viewer@example.invalid'),
      (u_off,    'g219-off@example.invalid'),
      (u_late,   'g219-late@example.invalid'),
      (u_dup1,   'g219-dup1@example.invalid'),
      (u_dup2,   'g219-dup2@example.invalid'),
      (u_sg,     'g219-sg@example.invalid');
    SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
    UPDATE profiles SET account_id = a_acct, account_role = 'agent'
     WHERE user_id IN (u_agent, u_off, u_late, u_dup1, u_dup2, u_sg);
    UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
    UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_viewer;

    INSERT INTO coordinator_phones (account_id, user_id, phone) VALUES
      (a_acct, u_owner,  '971500219009'),
      (a_acct, u_agent,  '971500219001'),
      (a_acct, u_lead,   '971500219002'),
      (a_acct, u_viewer, '971500219003'),
      (a_acct, u_off,    '971500219004'),
      (a_acct, u_dup1,   '971500219008'),
      (a_acct, u_sg,     '971500219010');
    -- Fixture shortcut past the profile guards (this transaction only).
    SET LOCAL session_replication_role = replica;
    UPDATE profiles SET deactivated_at = now() WHERE user_id = u_off AND account_id = a_acct;
    SET LOCAL session_replication_role = origin;

    INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary, waba_id)
    VALUES (u_owner, a_acct, 'whapi', 'G-219-A1', 'x', 'connected', true, '+971 50 021 9000')
    RETURNING id INTO w1;
    INSERT INTO contacts (account_id, user_id, phone, name)
      VALUES (a_acct, u_owner, '971500219100', 'C1') RETURNING id INTO c1;
    INSERT INTO whatsapp_groups (account_id, channel_id, wa_group_id, name, created_by, our_role)
    VALUES (a_acct, w1, '120363000000219001@g.us', 'WG 219 one', NULL, 'admin') RETURNING id INTO g1;
    INSERT INTO whatsapp_groups (account_id, channel_id, wa_group_id, name, created_by, our_role)
    VALUES (a_acct, w1, '120363000000219002@g.us', 'WG 219 two', NULL, 'admin') RETURNING id INTO g2;

    -- ---------- (a) the lookups ----------
    n := n + 1;
    IF public.staff_by_saved_phone(a_acct, '+971 50 021 9001') IS DISTINCT FROM u_agent
       OR public.staff_by_saved_phone(a_acct, '00971500219001') IS DISTINCT FROM u_agent
       OR public.staff_by_saved_phone(a_acct, '971500219002') IS DISTINCT FROM u_lead THEN
      failed := failed || 'staff_by_saved_phone did not match a formatted / 00 / team leader number'::text;
    END IF;
    n := n + 1;
    IF public.staff_by_saved_phone(a_acct, NULL) IS NOT NULL
       OR public.staff_by_saved_phone(a_acct, ' 	') IS NOT NULL
       OR public.staff_by_saved_phone(a_acct, '971500219001@lid') IS NOT NULL
       OR public.staff_by_saved_phone(a_acct, '971500219999') IS NOT NULL
       OR public.staff_by_saved_phone(a_acct, '971500219003') IS NOT NULL
       OR public.staff_by_saved_phone(a_acct, '971500219004') IS NOT NULL
       OR public.staff_by_saved_phone(a_acct, '971500219009') IS NOT NULL
       OR public.staff_by_saved_phone(gen_random_uuid(), '971500219001') IS NOT NULL THEN
      failed := failed || 'staff_by_saved_phone matched NULL, blank, @lid, nobody, a viewer, a deactivated agent, an owner or another account'::text;
    END IF;
    n := n + 1;
    IF public.staff_saved_phone(a_acct, u_agent) IS DISTINCT FROM '971500219001'
       OR public.staff_saved_phone(a_acct, u_lead) IS DISTINCT FROM '971500219002'
       OR public.staff_saved_phone(a_acct, u_viewer) IS NOT NULL
       OR public.staff_saved_phone(a_acct, u_off) IS NOT NULL
       OR public.staff_saved_phone(a_acct, u_owner) IS NOT NULL
       OR public.staff_saved_phone(a_acct, u_late) IS NOT NULL THEN
      failed := failed || 'staff_saved_phone: wrong number for agent / lead, or one for viewer, deactivated, owner or nobody saved'::text;
    END IF;

    -- ---------- (b) a participant joins ----------
    INSERT INTO whatsapp_group_participants (group_id, account_id, wa_id) VALUES
      (g1, a_acct, '971500219001'),
      (g1, a_acct, '971500219002'),
      (g1, a_acct, '971500219003'),
      (g1, a_acct, '971500219004'),
      (g1, a_acct, '971500219009'),
      (g1, a_acct, '971500219999'),
      (g2, a_acct, '971500219001@lid');
    n := n + 1;
    IF NOT EXISTS (SELECT 1 FROM whatsapp_group_managers WHERE group_id = g1 AND user_id = u_agent) THEN
      failed := failed || 'an agent''s number joining did not make them a manager'::text;
    END IF;
    n := n + 1;
    IF NOT EXISTS (SELECT 1 FROM whatsapp_group_managers WHERE group_id = g1 AND user_id = u_lead) THEN
      failed := failed || 'a team leader''s number joining did not make them a manager'::text;
    END IF;
    n := n + 1;
    SELECT count(*) INTO k FROM whatsapp_group_participants WHERE group_id = g1;
    IF k <> 6 THEN
      failed := failed || ('participant inserts did not all land: ' || k)::text;
    END IF;
    n := n + 1;
    SELECT count(*) INTO k FROM whatsapp_group_managers WHERE group_id = g1;
    IF k <> 2 THEN
      failed := failed || ('a viewer, deactivated agent, owner or unknown number became a manager (managers: ' || k || ')')::text;
    END IF;
    n := n + 1;
    IF EXISTS (SELECT 1 FROM whatsapp_group_managers WHERE group_id = g2) THEN
      failed := failed || 'an @lid participant made someone a manager'::text;
    END IF;

    -- ---------- (c) an upsert of an existing participant ----------
    INSERT INTO whatsapp_group_participants (group_id, account_id, wa_id) VALUES (g2, a_acct, '971500219002');
    n := n + 1;
    IF NOT EXISTS (SELECT 1 FROM whatsapp_group_managers WHERE group_id = g2 AND user_id = u_lead) THEN
      failed := failed || 'g2: the team leader''s number joining did not make them a manager'::text;
    END IF;
    DELETE FROM whatsapp_group_managers WHERE group_id = g2 AND user_id = u_lead;
    INSERT INTO whatsapp_group_participants (group_id, account_id, wa_id, role)
    VALUES (g2, a_acct, '971500219002', 'admin')
    ON CONFLICT (group_id, wa_id) DO UPDATE SET role = EXCLUDED.role;
    n := n + 1;
    IF EXISTS (SELECT 1 FROM whatsapp_group_managers WHERE group_id = g2 AND user_id = u_lead) THEN
      failed := failed || 'an upsert updating an existing participant re-granted a removed manager'::text;
    END IF;

    -- ---------- (d) a number saved later ----------
    INSERT INTO whatsapp_group_participants (group_id, account_id, wa_id) VALUES
      (g1, a_acct, '971500219005'), (g2, a_acct, '971500219005'), (g2, a_acct, '971500219007');
    INSERT INTO coordinator_phones (account_id, user_id, phone) VALUES (a_acct, u_late, '971500219005');
    n := n + 1;
    SELECT count(*) INTO k FROM whatsapp_group_managers WHERE user_id = u_late AND group_id IN (g1, g2);
    IF k <> 2 THEN
      failed := failed || ('saving a number did not grant both groups already holding it (' || k || ')')::text;
    END IF;
    UPDATE coordinator_phones SET phone = '971500219007' WHERE account_id = a_acct AND user_id = u_agent;
    n := n + 1;
    IF NOT EXISTS (SELECT 1 FROM whatsapp_group_managers WHERE group_id = g2 AND user_id = u_agent) THEN
      failed := failed || 'changing a saved number did not grant the group holding the new one'::text;
    END IF;
    UPDATE coordinator_phones SET phone = '971500219003' WHERE account_id = a_acct AND user_id = u_off;
    n := n + 1;
    IF EXISTS (SELECT 1 FROM whatsapp_group_managers WHERE user_id = u_off) THEN
      failed := failed || 'a deactivated agent''s saved number granted a group'::text;
    END IF;

    -- ---------- (e) two people, one number ----------
    INSERT INTO whatsapp_group_participants (group_id, account_id, wa_id) VALUES (g2, a_acct, '971500219008');
    INSERT INTO coordinator_phones (account_id, user_id, phone) VALUES (a_acct, u_dup2, '971500219008');
    INSERT INTO whatsapp_group_participants (group_id, account_id, wa_id) VALUES (g1, a_acct, '971500219008');
    n := n + 1;
    IF public.staff_by_saved_phone(a_acct, '971500219008') IS NOT NULL THEN
      failed := failed || 'a number two people saved matched one of them'::text;
    END IF;
    n := n + 1;
    IF EXISTS (SELECT 1 FROM whatsapp_group_managers WHERE user_id = u_dup2)
       OR EXISTS (SELECT 1 FROM whatsapp_group_managers WHERE group_id = g1 AND user_id = u_dup1) THEN
      failed := failed || 'a number two people saved granted a group'::text;
    END IF;

    -- ---------- (f) submission groups ----------
    SELECT group_id INTO g_sg FROM sg_open(a_acct, 'SG-219-1', c1, w1, 'one', NULL,
      jsonb_build_array(jsonb_build_object('user_id', u_sg, 'label', 'agent')), NULL);
    SELECT group_id INTO g_end FROM sg_open(a_acct, 'SG-219-2', c1, w1, 'two', NULL,
      jsonb_build_array(jsonb_build_object('user_id', u_sg, 'label', 'agent')), NULL);
    tok := sg_claim_create(g_end, 60000);
    PERFORM sg_attach_wa_group(g_end, '120363000000219102@g.us', NULL, tok);
    PERFORM sg_end(g_end, 'done');

    r := public.sg_staff_number_joined(g_sg, '+971 50 021 9002');
    n := n + 1;
    IF r IS DISTINCT FROM u_lead THEN
      failed := failed || ('sg_staff_number_joined did not return the team leader: ' || coalesce(r::text, 'NULL'))::text;
    END IF;
    n := n + 1;
    IF NOT EXISTS (SELECT 1 FROM submission_group_access
                    WHERE group_id = g_sg AND user_id = u_lead AND removed_at IS NULL
                      AND label = 'coordinator' AND added_by IS NULL) THEN
      failed := failed || 'sg_staff_number_joined did not add an open coordinator row (added_by NULL)'::text;
    END IF;
    r := public.sg_staff_number_joined(g_sg, '971500219002');
    n := n + 1;
    SELECT count(*) INTO k FROM submission_group_access WHERE group_id = g_sg AND user_id = u_lead;
    IF r IS DISTINCT FROM u_lead OR k <> 1 THEN
      failed := failed || ('a second call did not return the user or changed the list (' || k || ' rows)')::text;
    END IF;
    r := public.sg_staff_number_joined(g_sg, '971500219010');
    n := n + 1;
    SELECT count(*) INTO k FROM submission_group_access WHERE group_id = g_sg AND user_id = u_sg;
    IF r IS DISTINCT FROM u_sg OR k <> 1
       OR NOT EXISTS (SELECT 1 FROM submission_group_access
                       WHERE group_id = g_sg AND user_id = u_sg AND removed_at IS NULL AND label = 'agent') THEN
      failed := failed || 'an existing open row was not left alone (returned user, label agent, one row)'::text;
    END IF;
    n := n + 1;
    IF public.sg_staff_number_joined(g_end, '971500219002') IS NOT NULL
       OR EXISTS (SELECT 1 FROM submission_group_access WHERE group_id = g_end AND user_id = u_lead) THEN
      failed := failed || 'sg_staff_number_joined acted on an ENDED group'::text;
    END IF;
    n := n + 1;
    IF public.sg_staff_number_joined(g_sg, '971500219999') IS NOT NULL
       OR public.sg_staff_number_joined(g_sg, '971500219003') IS NOT NULL
       OR public.sg_staff_number_joined(gen_random_uuid(), '971500219002') IS NOT NULL THEN
      failed := failed || 'sg_staff_number_joined returned someone for an unknown number, a viewer or an unknown group'::text;
    END IF;

    -- ---------- (g) privileges ----------
    FOREACH fn IN ARRAY ARRAY['public.staff_saved_phone(uuid, uuid)',
                              'public.staff_by_saved_phone(uuid, text)',
                              'public.sg_staff_number_joined(uuid, text)'] LOOP
      n := n + 1;
      IF has_function_privilege('anon', fn, 'EXECUTE')
         OR has_function_privilege('authenticated', fn, 'EXECUTE')
         OR NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN
        failed := failed || (fn || ' is not EXECUTE for service_role only')::text;
      END IF;
    END LOOP;

    RAISE EXCEPTION USING ERRCODE = 'ZT219', MESSAGE = 'verify-group-staff-numbers rollback';
  EXCEPTION WHEN SQLSTATE 'ZT219' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'group staff numbers verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'group staff numbers verification passed (% checks)', n;
END
$verify$;
