-- ============================================================
-- Migration 299: the WhatsApp mirror of a submission group (a
-- whatsapp_groups row with its account and WhatsApp id) is nobody's
-- ordinary group, ACTIVE or ENDED; nobody is made a manager of one;
-- staff_removal_phone names the phone of a person taken off a group.
-- Runs as the superuser; every fixture is rolled back.
-- ============================================================

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000299001';
  u_admin  UUID := '00000000-0000-4000-8000-000000299002';
  u_agent  UUID := '00000000-0000-4000-8000-000000299003';
  u_coord  UUID := '00000000-0000-4000-8000-000000299004';
  u_lead   UUID := '00000000-0000-4000-8000-000000299005';
  u_guest  UUID := '00000000-0000-4000-8000-000000299006';
  u_off    UUID := '00000000-0000-4000-8000-000000299007';
  u_dem    UUID := '00000000-0000-4000-8000-000000299008';
  u_sim    UUID := '00000000-0000-4000-8000-000000299009';
  u_late   UUID := '00000000-0000-4000-8000-000000299010';
  a_acct   UUID;
  w1       UUID;
  c1       UUID;
  t1       UUID;
  g_plain  UUID;   -- an ordinary group
  g_act    UUID;   -- mirror, ACTIVE, webhook before attach
  g_aft    UUID;   -- mirror, ACTIVE, webhook after attach
  g_end    UUID;   -- mirror, ENDED
  s_act    UUID;
  s_aft    UUID;
  s_end    UUID;
  tok      UUID;
  acc      JSONB;
  who      UUID;
  lbl      TEXT;
  r        TEXT;
  want     TEXT;
  k        INT;
  b        BOOLEAN;
  n        INT := 0;
  failed   TEXT[] := '{}';
  mirrors  TEXT;
BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sgng_as(p_uid uuid, p_sql text, p_role text DEFAULT 'authenticated')
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', p_role)::text, true);
        EXECUTE format('SET LOCAL ROLE %I', p_role);
        EXECUTE p_sql INTO v;
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

  BEGIN
    INSERT INTO auth.users (id, email) VALUES
      (u_owner, 'sgng-owner@example.invalid'),
      (u_admin, 'sgng-admin@example.invalid'),
      (u_agent, 'sgng-agent@example.invalid'),
      (u_coord, 'sgng-coord@example.invalid'),
      (u_lead,  'sgng-lead@example.invalid'),
      (u_guest, 'sgng-guest@example.invalid'),
      (u_off,   'sgng-off@example.invalid'),
      (u_dem,   'sgng-dem@example.invalid'),
      (u_sim,   'sgng-sim@example.invalid'),
      (u_late,  'sgng-late@example.invalid');
    SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
    UPDATE profiles SET account_id = a_acct, account_role = 'agent'
     WHERE user_id IN (u_agent, u_coord, u_off, u_sim, u_late);
    UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
    UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
    UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_dem;
    UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB'
     WHERE user_id = u_guest;
    INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'SGNG team', u_lead)
      RETURNING id INTO t1;
    INSERT INTO team_members (team_id, user_id, account_id) VALUES (t1, u_coord, a_acct);

    INSERT INTO coordinator_phones (account_id, user_id, phone) VALUES
      (a_acct, u_coord, '971500299001'),
      (a_acct, u_off,   '971500299002'),
      (a_acct, u_dem,   '971500299003');

    INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary, waba_id)
    VALUES (u_owner, a_acct, 'whapi', 'SGNG-1', 'x', 'connected', true, '+971 50 029 9000')
    RETURNING id INTO w1;
    INSERT INTO contacts (account_id, user_id, phone, name)
      VALUES (a_acct, u_owner, '971500299100', 'SGNG customer') RETURNING id INTO c1;

    acc := jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent'));
    s_act := (SELECT o.group_id FROM sg_open(a_acct, 'SGNG-1', c1, w1, 'one', NULL, acc, NULL, 'group') o);
    s_aft := (SELECT o.group_id FROM sg_open(a_acct, 'SGNG-2', c1, w1, 'two', NULL, acc, NULL, 'group') o);
    s_end := (SELECT o.group_id FROM sg_open(a_acct, 'SGNG-3', c1, w1, 'three', NULL, acc, NULL, 'group') o);

    -- ---------- (a) an ordinary group is as before ----------
    INSERT INTO whatsapp_groups (account_id, channel_id, wa_group_id, name, created_by, our_role)
    VALUES (a_acct, w1, '120363000000299000@g.us', 'SGNG plain', u_agent, 'admin') RETURNING id INTO g_plain;
    INSERT INTO whatsapp_group_participants (group_id, account_id, wa_id) VALUES (g_plain, a_acct, '971500299001');
    n := n + 1;
    IF NOT EXISTS (SELECT 1 FROM whatsapp_group_managers WHERE group_id = g_plain AND user_id = u_coord) THEN
      failed := failed || 'a staff number joining an ordinary group made nobody a manager'::text;
    END IF;

    -- ---------- (b) the webhook beats the attach ----------
    INSERT INTO whatsapp_groups (account_id, channel_id, wa_group_id, name, created_by, our_role)
    VALUES (a_acct, w1, '120363000000299001@g.us', 'SGNG mirror 1', u_agent, 'admin') RETURNING id INTO g_act;
    INSERT INTO whatsapp_group_participants (group_id, account_id, wa_id) VALUES (g_act, a_acct, '971500299001');
    INSERT INTO whatsapp_groups (account_id, channel_id, wa_group_id, name, created_by, our_role)
    VALUES (a_acct, w1, '120363000000299003@g.us', 'SGNG mirror 3', u_agent, 'admin') RETURNING id INTO g_end;
    INSERT INTO whatsapp_group_participants (group_id, account_id, wa_id) VALUES (g_end, a_acct, '971500299001');
    n := n + 1;
    IF (SELECT count(*) FROM whatsapp_group_managers WHERE group_id IN (g_act, g_end)) <> 2 THEN
      failed := failed || 'fixture: the mirror had no manager before the attach'::text;
    END IF;
    tok := sg_claim_create(s_act, 60000);
    b := sg_attach_wa_group(s_act, '120363000000299001@g.us', NULL, tok);
    tok := sg_claim_create(s_end, 60000);
    b := b AND sg_attach_wa_group(s_end, '120363000000299003@g.us', NULL, tok);
    n := n + 1;
    IF b IS NOT TRUE THEN failed := failed || 'fixture: sg_attach_wa_group refused'::text; END IF;
    n := n + 1;
    IF EXISTS (SELECT 1 FROM whatsapp_group_managers WHERE group_id IN (g_act, g_end)) THEN
      failed := failed || 'attaching the WhatsApp id left the mirror its managers'::text;
    END IF;
    n := n + 1;
    IF NOT EXISTS (SELECT 1 FROM whatsapp_group_managers WHERE group_id = g_plain AND user_id = u_coord) THEN
      failed := failed || 'attaching dropped the managers of another group'::text;
    END IF;
    n := n + 1;
    IF sg_end(s_end, 'test') IS NOT TRUE THEN failed := failed || 'fixture: sg_end refused'::text; END IF;

    -- ---------- (c) the webhook after the attach ----------
    tok := sg_claim_create(s_aft, 60000);
    b := sg_attach_wa_group(s_aft, '120363000000299002@g.us', NULL, tok);
    INSERT INTO whatsapp_groups (account_id, channel_id, wa_group_id, name, created_by, our_role)
    VALUES (a_acct, w1, '120363000000299002@g.us', 'SGNG mirror 2', u_agent, 'admin') RETURNING id INTO g_aft;
    INSERT INTO whatsapp_group_participants (group_id, account_id, wa_id) VALUES
      (g_aft, a_acct, '971500299001'),
      (g_aft, a_acct, '971500299010');
    -- and the other way round: a number saved while it is in the group,
    -- in one statement with an ordinary group, which is still granted.
    INSERT INTO whatsapp_group_participants (group_id, account_id, wa_id) VALUES
      (g_end, a_acct, '971500299010'), (g_plain, a_acct, '971500299010');
    INSERT INTO coordinator_phones (account_id, user_id, phone) VALUES (a_acct, u_late, '971500299010');
    n := n + 1;
    IF EXISTS (SELECT 1 FROM whatsapp_group_managers WHERE group_id = g_aft) THEN
      failed := failed || 'a staff number in an ACTIVE mirror became a manager'::text;
    END IF;
    n := n + 1;
    IF EXISTS (SELECT 1 FROM whatsapp_group_managers WHERE group_id = g_end) THEN
      failed := failed || 'a number saved by staff made them manager of an ENDED mirror'::text;
    END IF;
    n := n + 1;
    IF NOT EXISTS (SELECT 1 FROM whatsapp_group_managers WHERE group_id = g_plain AND user_id = u_late) THEN
      failed := failed || 'a number saved by staff no longer grants the ordinary group'::text;
    END IF;
    n := n + 1;
    IF (SELECT count(*) FROM whatsapp_groups WHERE id IN (g_act, g_aft, g_end)) <> 3 THEN
      failed := failed || 'a mirror row was deleted'::text;
    END IF;

    -- ---------- (d) nobody reads or manages a mirror ----------
    -- As an old database has it: a coordinator still a manager of every
    -- mirror (the triggers are off for this insert only).
    SET LOCAL session_replication_role = replica;
    INSERT INTO whatsapp_group_managers (group_id, account_id, user_id)
    SELECT g, a_acct, u FROM unnest(ARRAY[g_act, g_aft, g_end]) g, unnest(ARRAY[u_coord, u_guest]) u
    ON CONFLICT DO NOTHING;
    SET LOCAL session_replication_role = origin;
    INSERT INTO whatsapp_group_messages (account_id, group_id, wa_message_id, direction, body, created_at)
    SELECT a_acct, g, 'sgng-' || g, 'in', 'x', now() - interval '1 hour'
      FROM unnest(ARRAY[g_plain, g_act, g_aft, g_end]) g;
    INSERT INTO whatsapp_group_invites (group_id, account_id, invite_code, invite_link)
    SELECT g, a_acct, 'sgngcode' || row_number() OVER (), 'https://chat.whatsapp.com/sgng' FROM unnest(ARRAY[g_plain, g_act, g_aft, g_end]) g;
    mirrors := format('(%L, %L, %L)', g_act, g_aft, g_end);

    FOR lbl, who, want IN
      SELECT * FROM (VALUES ('owner', u_owner, '1'), ('admin', u_admin, '1'), ('creating agent', u_agent, '1'),
                            ('coordinator', u_coord, '1'), ('team leader', u_lead, '1'), ('bank guest', u_guest, '0')) v(a, x, w)
    LOOP
      n := n + 1;
      r := pg_temp.sgng_as(who, 'SELECT count(*)::text FROM whatsapp_group_visible_ids() v WHERE v IN ' || mirrors);
      IF r <> '0' THEN failed := failed || format('visible ids: the %s sees %s mirror(s)', lbl, r); END IF;
      n := n + 1;
      r := pg_temp.sgng_as(who, 'SELECT count(*)::text FROM whatsapp_group_manageable_ids() v WHERE v IN ' || mirrors);
      IF r <> '0' THEN failed := failed || format('manageable ids: the %s manages %s mirror(s)', lbl, r); END IF;
      n := n + 1;
      r := pg_temp.sgng_as(who, 'SELECT ((SELECT count(*) FROM whatsapp_groups WHERE id IN ' || mirrors || ')'
        || ' + (SELECT count(*) FROM whatsapp_group_messages WHERE group_id IN ' || mirrors || ')'
        || ' + (SELECT count(*) FROM whatsapp_group_participants WHERE group_id IN ' || mirrors || ')'
        || ' + (SELECT count(*) FROM whatsapp_group_invites WHERE group_id IN ' || mirrors || ')'
        || ' + (SELECT count(*) FROM whatsapp_group_managers WHERE group_id IN ' || mirrors || '))::text');
      IF r <> '0' THEN failed := failed || format('the %s reads %s row(s) of mirrors', lbl, r); END IF;
      n := n + 1;
      r := pg_temp.sgng_as(who, format('SELECT (SELECT count(*) FROM whatsapp_group_messages WHERE group_id = %L)::text', g_plain));
      IF r <> want THEN failed := failed || format('the %s reads %s message(s) of the ordinary group (want %s)', lbl, r, want); END IF;
      n := n + 1;
      r := pg_temp.sgng_as(who, format('SELECT whatsapp_group_mark_read(%L)::text', g_act));
      IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('the %s marks a mirror read (%s)', lbl, r); END IF;
    END LOOP;
    n := n + 1;
    r := pg_temp.sgng_as(u_coord, format('SELECT whatsapp_group_can_manage(%L)::text', g_plain));
    IF r <> 'true' THEN failed := failed || format('a manager no longer manages the ordinary group (%s)', r); END IF;
    n := n + 1;
    r := pg_temp.sgng_as(NULL, 'SELECT count(*)::text FROM whatsapp_groups WHERE id IN ' || mirrors, 'service_role');
    IF r <> '3' THEN failed := failed || format('the service role reads %s of 3 mirrors', r); END IF;

    -- ---------- (e) whose phone leaves ----------
    SET LOCAL session_replication_role = replica;
    UPDATE profiles SET deactivated_at = now() WHERE user_id = u_off AND account_id = a_acct;
    SET LOCAL session_replication_role = origin;
    n := n + 1;
    IF staff_removal_phone(a_acct, u_coord) IS DISTINCT FROM '971500299001'
       OR staff_removal_phone(a_acct, u_off) IS DISTINCT FROM '971500299002'
       OR staff_removal_phone(a_acct, u_dem) IS DISTINCT FROM '971500299003' THEN
      failed := failed || 'staff_removal_phone: no number for a live, a deactivated or a demoted person'::text;
    END IF;
    n := n + 1;
    IF staff_saved_phone(a_acct, u_off) IS NOT NULL OR staff_saved_phone(a_acct, u_dem) IS NOT NULL THEN
      failed := failed || 'staff_saved_phone (additions) lost its live filter'::text;
    END IF;
    n := n + 1;
    IF staff_removal_phone(a_acct, u_agent) IS NOT NULL
       OR staff_removal_phone(gen_random_uuid(), u_coord) IS NOT NULL THEN
      failed := failed || 'staff_removal_phone: a number for nobody saved or another account'::text;
    END IF;
    -- The company SIM is handed on: it is the new holder's.
    INSERT INTO coordinator_phones (account_id, user_id, phone) VALUES (a_acct, u_sim, '971500299002');
    n := n + 1;
    IF staff_removal_phone(a_acct, u_off) IS NOT NULL
       OR staff_removal_phone(a_acct, u_sim) IS DISTINCT FROM '971500299002' THEN
      failed := failed || 'staff_removal_phone: a handed-on number still belongs to the person who left'::text;
    END IF;
    n := n + 1;
    IF has_function_privilege('anon', 'public.staff_removal_phone(uuid, uuid)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.staff_removal_phone(uuid, uuid)', 'EXECUTE')
       OR NOT has_function_privilege('service_role', 'public.staff_removal_phone(uuid, uuid)', 'EXECUTE') THEN
      failed := failed || 'staff_removal_phone is not EXECUTE for service_role only'::text;
    END IF;

    -- ---------- (f) the read is indexed ----------
    n := n + 1;
    SELECT count(*) INTO k FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'submission_groups_account_wa_group_idx';
    IF k <> 1 THEN failed := failed || 'submission_groups(account_id, wa_group_id) has no index'::text; END IF;

    RAISE EXCEPTION USING ERRCODE = 'ZT299', MESSAGE = 'verify-submission-groups-not-groups rollback';
  EXCEPTION WHEN SQLSTATE 'ZT299' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'submission groups not groups verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'submission groups not groups verification passed (% checks)', n;
END
$verify$;
