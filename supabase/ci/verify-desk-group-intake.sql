-- Behavioural regression suite for desk group intake (migration 324).
--
-- A WhatsApp group is linked to a bank by an owner, admin or team leader
-- who can see it, never a submission group's mirror, and replies only
-- with intake. The sender of a group file is the one live staff member
-- with that saved number (two on one number is nobody). Each group
-- message records one outcome (first write wins); a reply is claimed at
-- most once, never for chat and never with replies off. The wall shows
-- only groups the actor sees, with the bank's queue alert (2 h second,
-- 4 h lead, no coordinator first), and outcomes read the intake item's
-- current state. Who sees a group matches 299's whatsapp_group_visible_ids.
-- Tables and functions are closed to API roles.
--
-- ONE statement on purpose: `supabase db query --file` sends the file as
-- a single prepared statement and rejects several. Fixtures are rolled
-- back by a sentinel exception; failures are named in the final one.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000324001';
  u_lead   UUID := '00000000-0000-4000-8000-000000324002';
  u_agent  UUID := '00000000-0000-4000-8000-000000324003';  -- creates g1, in the lead's team
  u_agent2 UUID := '00000000-0000-4000-8000-000000324004';  -- sees none of g1
  u_r1     UUID := '00000000-0000-4000-8000-000000324005';  -- RAK primary
  u_r2     UUID := '00000000-0000-4000-8000-000000324006';  -- RAK second
  u_e      UUID := '00000000-0000-4000-8000-000000324007';  -- holds ENBD, no role
  u_s1     UUID := '00000000-0000-4000-8000-000000324008';  -- shares a number with s2
  u_s2     UUID := '00000000-0000-4000-8000-000000324009';
  u_off    UUID := '00000000-0000-4000-8000-000000324010';  -- deactivated, own number
  u_view   UUID := '00000000-0000-4000-8000-000000324011';  -- viewer, own number
  a_acct   UUID;
  v_now    TIMESTAMPTZ := now();
  t1       UUID;
  w1       UUID;
  c1       UUID;
  sg       UUID;
  tok      UUID;
  acc      JSONB;
  g1       UUID;
  g2       UUID;
  g3       UUID;
  g_mir    UUID;
  m1       UUID;
  m2       UUID;
  m3       UUID;
  m4       UUID;
  i_q      UUID := gen_random_uuid();
  i_e      UUID := gen_random_uuid();
  v        TEXT;
  b        BOOLEAN;
  r        RECORD;
  u        UUID;
  g        UUID;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.dg_try(p_role text, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; h text;
    BEGIN
      BEGIN
        IF p_role IS NOT NULL THEN
          EXECUTE format('SET LOCAL ROLE %I', p_role);
        END IF;
        IF p_sql ILIKE 'select%' THEN
          EXECUTE p_sql INTO v;
        ELSE
          EXECUTE p_sql;
        END IF;
        RESET ROLE;
        RETURN coalesce(v, 'ok');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
        RESET ROLE;
        RETURN 'ERROR ' || SQLSTATE || ' ' || coalesce(nullif(h, ''), '-') || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.dg_check(p_name text, p_role text, p_sql text, p_like text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := pg_temp.dg_try(p_role, p_sql);
    BEGIN
      RETURN CASE WHEN v LIKE p_like THEN NULL ELSE p_name || ' (' || v || ')' END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.dg_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  -- 299's own answer for a signed-in user: is the group in whatsapp_group_visible_ids()?
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.dg_visible_299(p_user uuid, p_group uuid)
    RETURNS boolean LANGUAGE plpgsql AS $body$
    DECLARE v boolean;
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
      v := EXISTS (SELECT 1 FROM public.whatsapp_group_visible_ids() x WHERE x = p_group);
      PERFORM set_config('request.jwt.claims', '', true);
      RETURN v;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.dg_alert(p_actor uuid, p_account uuid, p_group uuid, p_now timestamptz)
    RETURNS text LANGUAGE sql AS $body$
      SELECT x.alert FROM public.desk_group_wall(p_actor, p_account, ARRAY[p_group], p_now) x
    $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'dgi-owner@example.invalid'), (u_lead, 'dgi-lead@example.invalid'),
    (u_agent, 'dgi-agent@example.invalid'), (u_agent2, 'dgi-agent2@example.invalid'),
    (u_r1, 'dgi-r1@example.invalid'), (u_r2, 'dgi-r2@example.invalid'), (u_e, 'dgi-e@example.invalid'),
    (u_s1, 'dgi-s1@example.invalid'), (u_s2, 'dgi-s2@example.invalid'),
    (u_off, 'dgi-off@example.invalid'), (u_view, 'dgi-view@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent'
   WHERE user_id IN (u_agent, u_agent2, u_r1, u_r2, u_e, u_s1, u_s2, u_off);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_view;
  UPDATE profiles SET full_name = 'DGI Primary' WHERE user_id = u_r1;
  UPDATE profiles SET full_name = 'DGI Second' WHERE user_id = u_r2;
  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'DGI team', u_lead) RETURNING id INTO t1;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (t1, u_agent, a_acct);
  INSERT INTO case_banks (account_id, code, name) VALUES
    (a_acct, 'RAK', 'RAKBANK'), (a_acct, 'ENBD', 'Emirates NBD')
  ON CONFLICT DO NOTHING;
  PERFORM desk_bank_code_set(u_owner, a_acct, 'RAK', 'RAK');
  INSERT INTO coordinator_banks (account_id, user_id, bank_code) VALUES
    (a_acct, u_r1, 'RAK'), (a_acct, u_r2, 'RAK'), (a_acct, u_e, 'ENBD');
  PERFORM desk_bank_role_set(u_owner, a_acct, 'RAK', 'primary', u_r1);
  PERFORM desk_bank_role_set(u_owner, a_acct, 'RAK', 'second', u_r2);
  INSERT INTO coordinator_phones (account_id, user_id, phone) VALUES
    (a_acct, u_s1, '971500324050'), (a_acct, u_s2, '971500324050'),
    (a_acct, u_agent, '971500324051'), (a_acct, u_off, '971500324052'), (a_acct, u_view, '971500324053');
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_off AND account_id = a_acct;

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary, waba_id)
  VALUES (u_owner, a_acct, 'whapi', 'DGI-1', 'x', 'connected', true, '+971 50 032 4000')
  RETURNING id INTO w1;
  INSERT INTO contacts (account_id, user_id, phone, name)
    VALUES (a_acct, u_agent, '971500324100', 'DGI customer') RETURNING id INTO c1;
  INSERT INTO whatsapp_groups (account_id, channel_id, wa_group_id, name, created_by, our_role) VALUES
    (a_acct, w1, '120363000000324001@g.us', 'DGI one', u_agent, 'admin') RETURNING id INTO g1;
  INSERT INTO whatsapp_groups (account_id, channel_id, wa_group_id, name, created_by, our_role) VALUES
    (a_acct, w1, '120363000000324002@g.us', 'DGI two', u_owner, 'admin') RETURNING id INTO g2;
  INSERT INTO whatsapp_groups (account_id, channel_id, wa_group_id, name, created_by, our_role) VALUES
    (a_acct, w1, '120363000000324003@g.us', 'DGI three', u_agent, 'admin') RETURNING id INTO g3;
  INSERT INTO whatsapp_groups (account_id, channel_id, wa_group_id, name, created_by, our_role) VALUES
    (a_acct, w1, '120363000000324009@g.us', 'DGI mirror', u_agent, 'admin') RETURNING id INTO g_mir;
  acc := jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent'));
  sg := (SELECT o.group_id FROM sg_open(a_acct, 'DGI-SG-1', c1, w1, 'mirror', NULL, acc, NULL, 'group') o);
  tok := sg_claim_create(sg, 60000);
  IF sg_attach_wa_group(sg, '120363000000324009@g.us', NULL, tok) IS NOT TRUE THEN
    RAISE EXCEPTION 'fixture: sg_attach_wa_group refused';
  END IF;
  INSERT INTO whatsapp_group_messages (account_id, group_id, wa_message_id, direction, sender_wa_id, type, created_at)
  VALUES (a_acct, g1, 'dgi-m1', 'in', '971500324051', 'document', v_now) RETURNING id INTO m1;
  INSERT INTO whatsapp_group_messages (account_id, group_id, wa_message_id, direction, sender_wa_id, type, body, created_at)
  VALUES (a_acct, g1, 'dgi-m2', 'in', '971500324051', 'text', 'thanks', v_now) RETURNING id INTO m2;
  INSERT INTO whatsapp_group_messages (account_id, group_id, wa_message_id, direction, sender_wa_id, type, created_at)
  VALUES (a_acct, g3, 'dgi-m3', 'in', '971500324051', 'document', v_now) RETURNING id INTO m3;
  INSERT INTO whatsapp_group_messages (account_id, group_id, wa_message_id, direction, sender_wa_id, type, created_at)
  VALUES (a_acct, g2, 'dgi-m4', 'in', '971500324051', 'document', v_now) RETURNING id INTO m4;

  -- ---------- 1. who sees a group is 299's rule ----------
  FOREACH u IN ARRAY ARRAY[u_owner, u_lead, u_agent, u_agent2] LOOP
    FOREACH g IN ARRAY ARRAY[g1, g2, g3, g_mir] LOOP
      n := n + 1; failed := failed || pg_temp.dg_ok(
        desk_group_can_see(u, a_acct, g) = pg_temp.dg_visible_299(u, g),
        format('desk_group_can_see differs from whatsapp_group_visible_ids for %s on %s', u, g));
    END LOOP;
  END LOOP;
  n := n + 1; failed := failed || pg_temp.dg_ok(
    desk_group_can_see(u_lead, a_acct, g1) AND NOT desk_group_can_see(u_agent2, a_acct, g1)
    AND NOT desk_group_can_see(u_owner, a_acct, g_mir) AND NOT desk_group_can_see(u_view, a_acct, g1),
    'fixture: the visibility cases are not the intended ones');

  -- ---------- 2. links ----------
  n := n + 1; failed := failed || pg_temp.dg_check('an agent linked a group', NULL,
    format('SELECT desk_group_link_set(%L, %L, %L, ''RAK'', true, false)::text', u_agent, a_acct, g1),
    'ERROR % NOT_ALLOWED:%');
  n := n + 1; failed := failed || pg_temp.dg_check('the owner linked a submission group''s mirror', NULL,
    format('SELECT desk_group_link_set(%L, %L, %L, ''RAK'', true, false)::text', u_owner, a_acct, g_mir),
    'ERROR % GROUP_NOT_FOUND:%');
  n := n + 1; failed := failed || pg_temp.dg_check('a team leader linked a group they cannot see', NULL,
    format('SELECT desk_group_link_set(%L, %L, %L, ''RAK'', true, false)::text', u_lead, a_acct, g2),
    'ERROR % GROUP_NOT_FOUND:%');
  n := n + 1; failed := failed || pg_temp.dg_check('replies were switched on without intake', NULL,
    format('SELECT desk_group_link_set(%L, %L, %L, ''RAK'', false, true)::text', u_lead, a_acct, g1),
    'ERROR % INVALID:%');
  n := n + 1; failed := failed || pg_temp.dg_check('a group was linked to an unknown bank', NULL,
    format('SELECT desk_group_link_set(%L, %L, %L, ''NOPE'', true, false)::text', u_lead, a_acct, g1),
    'ERROR % BANK_NOT_FOUND:%');
  PERFORM desk_group_link_set(u_lead, a_acct, g1, 'RAK', true, true, v_now);
  PERFORM desk_group_link_set(u_owner, a_acct, g3, 'RAK', true, false, v_now);
  PERFORM desk_group_link_set(u_owner, a_acct, g2, 'ENBD', true, false, v_now);
  n := n + 1; failed := failed || pg_temp.dg_ok(
    (SELECT count(*) FROM desk_group_links l WHERE l.account_id = a_acct AND l.bank_code = 'RAK') = 2,
    'two groups could not link to one bank');
  n := n + 1; failed := failed || pg_temp.dg_ok(
    (SELECT array_agg(x.group_id ORDER BY x.group_name) FROM desk_group_link_list(u_agent2, a_acct) x) IS NULL
    AND (SELECT count(*) FROM desk_group_link_list(u_agent, a_acct) x) = 2
    AND (SELECT count(*) FROM desk_group_link_list(u_owner, a_acct) x) = 3,
    'the link list did not follow who sees each group');
  n := n + 1; failed := failed || pg_temp.dg_check('a viewer read the link list', NULL,
    format('SELECT count(*)::text FROM desk_group_link_list(%L, %L)', u_view, a_acct), 'ERROR % NOT_ALLOWED:%');
  PERFORM desk_group_link_set(u_owner, a_acct, g2, NULL, NULL, NULL, v_now);
  n := n + 1; failed := failed || pg_temp.dg_ok(
    NOT EXISTS (SELECT 1 FROM desk_group_links l WHERE l.group_id = g2), 'a NULL bank did not remove the link');
  -- the inbound hook's read, with no actor: linked, unlinked, mirror
  SELECT x.* INTO r FROM desk_group_link_for_group(a_acct, g1) x;
  n := n + 1; failed := failed || pg_temp.dg_ok(
    r.bank_code = 'RAK' AND r.bank_name = 'RAKBANK' AND r.intake_enabled AND r.replies_enabled
    AND (SELECT count(*) FROM desk_group_link_for_group(a_acct, g1)) = 1,
    format('the link of a linked group was not read (%s)', row_to_json(r)));
  n := n + 1; failed := failed || pg_temp.dg_ok(
    (SELECT count(*) FROM desk_group_link_for_group(a_acct, g2)) = 0
    AND (SELECT count(*) FROM desk_group_link_for_group(gen_random_uuid(), g1)) = 0,
    'an unlinked group, or another account''s, answered a link');
  -- a mirror's row can only be planted by hand: it still reads as no link
  INSERT INTO desk_group_links (account_id, group_id, bank_code, intake_enabled, replies_enabled)
    VALUES (a_acct, g_mir, 'RAK', true, true);
  n := n + 1; failed := failed || pg_temp.dg_ok(
    (SELECT count(*) FROM desk_group_link_for_group(a_acct, g_mir)) = 0,
    'a submission group''s mirror answered a link');
  DELETE FROM desk_group_links l WHERE l.group_id = g_mir;

  -- ---------- 3. who posted ----------
  n := n + 1; failed := failed || pg_temp.dg_ok(desk_group_staff_for_phone(a_acct, '971500324050') IS NULL,
    'two staff on one number answered one of them');
  n := n + 1; failed := failed || pg_temp.dg_ok(desk_group_staff_for_phone(a_acct, '+971 50 032 4051') = u_agent,
    'the one staff member with that number was not found (digits only)');
  n := n + 1; failed := failed || pg_temp.dg_ok(
    desk_group_staff_for_phone(a_acct, '971500324052') IS NULL
    AND desk_group_staff_for_phone(a_acct, '971500324053') IS NULL
    AND desk_group_staff_for_phone(a_acct, '') IS NULL AND desk_group_staff_for_phone(a_acct, NULL) IS NULL,
    'a deactivated member, a viewer or no digits answered someone');

  -- ---------- 4. recording ----------
  -- i_q: queued to RAK (220's own routing); i_e: queued to ENBD.
  PERFORM intake_submit(u_agent, a_acct, i_q, 'dgi-000001', NULL, 'RAK', NULL, NULL, NULL, NULL, NULL, NULL,
                        'from the group', NULL, NULL, NULL, NULL, NULL, v_now);
  PERFORM intake_submit(u_agent, a_acct, i_e, 'dgi-000002', NULL, 'ENBD', NULL, NULL, NULL, NULL, NULL, NULL,
                        'enbd', NULL, NULL, NULL, NULL, NULL, v_now);
  n := n + 1; failed := failed || pg_temp.dg_ok(desk_group_intake_record(a_acct, m1, 'queued', i_q, 'NO_CASE_REF', v_now) = 'queued',
    'the first record did not answer its outcome');
  n := n + 1; failed := failed || pg_temp.dg_ok(desk_group_intake_record(a_acct, m1, 'filed', NULL, NULL, v_now) = 'queued'
    AND (SELECT d.outcome || '|' || d.intake_item_id FROM desk_group_intake d WHERE d.group_message_id = m1) = 'queued|' || i_q,
    'a second record overwrote the first');
  n := n + 1; failed := failed || pg_temp.dg_ok(desk_group_intake_record(a_acct, m2, 'chat', NULL, NULL, v_now) = 'chat',
    'a chat message was not recorded');
  PERFORM desk_group_intake_record(a_acct, m3, 'refused', NULL, 'BANK_SCOPE', v_now);
  n := n + 1; failed := failed || pg_temp.dg_check('a message of an unlinked group was recorded', NULL,
    format('SELECT desk_group_intake_record(%L, %L, ''refused'', NULL, NULL)', a_acct, m4), 'ERROR % NOT_LINKED:%');
  n := n + 1; failed := failed || pg_temp.dg_check('free text was stored as the detail', NULL,
    format('SELECT desk_group_intake_record(%L, %L, ''chat'', NULL, ''the customer said no'')', a_acct, m4),
    'ERROR % INVALID:%');

  -- ---------- 5. replies ----------
  n := n + 1; failed := failed || pg_temp.dg_ok(desk_group_reply_claim(a_acct, m1, v_now), 'the first reply claim failed');
  n := n + 1; failed := failed || pg_temp.dg_ok(NOT desk_group_reply_claim(a_acct, m1, v_now), 'a reply was claimed twice');
  n := n + 1; failed := failed || pg_temp.dg_ok(NOT desk_group_reply_claim(a_acct, m2, v_now), 'a chat message claimed a reply');
  n := n + 1; failed := failed || pg_temp.dg_ok(NOT desk_group_reply_claim(a_acct, m3, v_now),
    'a reply was claimed with replies off');
  -- One call per statement: the order in which one expression evaluates
  -- its calls is the planner's.
  b := desk_group_reply_settle(a_acct, m1, true, 'dgi-reply-1', v_now);
  b := b AND NOT desk_group_reply_settle(a_acct, m1, false, NULL, v_now);
  n := n + 1; failed := failed || pg_temp.dg_ok(b
    AND (SELECT d.reply_state || '|' || d.reply_message_id FROM desk_group_intake d WHERE d.group_message_id = m1) = 'sent|dgi-reply-1',
    'the reply did not settle once as sent');
  n := n + 1; failed := failed || pg_temp.dg_ok(NOT desk_group_reply_claim(a_acct, m1, v_now), 'a sent reply was claimed again');

  -- ---------- 6. the wall ----------
  n := n + 1; failed := failed || pg_temp.dg_ok(
    (SELECT count(*) FROM desk_group_wall(u_agent2, a_acct, ARRAY[g1, g3], v_now)) = 0
    AND (SELECT array_agg(x.group_id ORDER BY x.group_id) FROM desk_group_wall(u_agent, a_acct, ARRAY[g1, g2, g_mir], v_now) x)
        = ARRAY[g1],
    'the wall showed a group the actor cannot see, an unlinked group or a mirror');
  SELECT x.* INTO r FROM desk_group_wall(u_agent, a_acct, ARRAY[g1], v_now) x;
  n := n + 1; failed := failed || pg_temp.dg_ok(r.bank_code = 'RAK' AND r.bank_name = 'RAKBANK' AND r.short_code = 'RAK'
    AND r.primary_name = 'DGI Primary' AND r.second_name = 'DGI Second' AND r.to_sort = 1 AND r.filed_today = 0,
    format('the wall row is wrong (%s)', row_to_json(r)));
  UPDATE intake_items SET received_at = v_now - interval '1 hour 59 minutes' WHERE id = i_q;
  n := n + 1; failed := failed || pg_temp.dg_ok(pg_temp.dg_alert(u_agent, a_acct, g1, v_now) = 'none', 'alert at 1h59 was not none');
  UPDATE intake_items SET received_at = v_now - interval '2 hours 1 minute' WHERE id = i_q;
  n := n + 1; failed := failed || pg_temp.dg_ok(pg_temp.dg_alert(u_agent, a_acct, g1, v_now) = 'second', 'alert at 2h01 was not second');
  UPDATE intake_items SET received_at = v_now - interval '4 hours 1 minute' WHERE id = i_q;
  n := n + 1; failed := failed || pg_temp.dg_ok(pg_temp.dg_alert(u_agent, a_acct, g1, v_now) = 'lead', 'alert at 4h01 was not lead');
  n := n + 1; failed := failed || pg_temp.dg_ok(
    (SELECT x.oldest_age_seconds FROM desk_group_wall(u_agent, a_acct, ARRAY[g1], v_now) x) = 4 * 3600 + 60,
    'the oldest age is not in seconds');
  -- ENBD has a holder but neither a primary nor a second: no_coordinator, even past 4 h.
  PERFORM desk_group_link_set(u_owner, a_acct, g2, 'ENBD', true, false, v_now);
  UPDATE intake_items SET received_at = v_now - interval '5 hours' WHERE id = i_e;
  n := n + 1; failed := failed || pg_temp.dg_ok(pg_temp.dg_alert(u_owner, a_acct, g2, v_now) = 'no_coordinator',
    'a bank with no primary and no second did not alert no_coordinator');
  n := n + 1; failed := failed || pg_temp.dg_check('a viewer read the wall', NULL,
    format('SELECT count(*)::text FROM desk_group_wall(%L, %L, ARRAY[%L]::uuid[])', u_view, a_acct, g1), 'ERROR % NOT_ALLOWED:%');

  -- ---------- 7. outcomes follow a later filing ----------
  SELECT x.* INTO r FROM desk_group_outcomes(u_agent, a_acct, ARRAY[m1]) x;
  n := n + 1; failed := failed || pg_temp.dg_ok(r.outcome = 'queued' AND r.item_state = 'untagged' AND r.case_number IS NULL
    AND r.detail = 'NO_CASE_REF' AND r.reply_state = 'sent' AND r.queue_reason IS NOT NULL,
    format('the queued outcome is wrong (%s)', row_to_json(r)));
  v := pg_temp.dg_try(NULL, format(
    'SELECT state FROM intake_file_new_case(%L, %L, %L, ''CN-324001'', ''DGI Trading'', ''RAK'', ''Account'', %L, %L)',
    u_r1, a_acct, i_q, c1, v_now));
  IF v <> 'filed' THEN RAISE EXCEPTION 'fixture: the RAK primary could not file the queued item (%)', v; END IF;
  SELECT x.* INTO r FROM desk_group_outcomes(u_agent, a_acct, ARRAY[m1, m2]) x WHERE x.group_message_id = m1;
  n := n + 1; failed := failed || pg_temp.dg_ok(r.outcome = 'queued' AND r.item_state = 'filed'
    AND r.case_number LIKE 'TC-%-RAK' AND r.caption_code IS NOT NULL,
    format('a later filing did not show in the outcome (%s)', row_to_json(r)));
  SELECT x.* INTO r FROM desk_group_wall(u_agent, a_acct, ARRAY[g1], v_now) x;
  n := n + 1; failed := failed || pg_temp.dg_ok(r.filed_today = 1 AND r.to_sort = 0 AND r.alert = 'none',
    format('the wall did not count today''s filing (%s)', row_to_json(r)));
  n := n + 1; failed := failed || pg_temp.dg_ok(
    (SELECT count(*) FROM desk_group_outcomes(u_agent2, a_acct, ARRAY[m1, m2, m3])) = 0,
    'outcomes of a group the actor cannot see were shown');
  n := n + 1; failed := failed || pg_temp.dg_check('more than 500 outcome ids were accepted', NULL,
    format('SELECT count(*)::text FROM desk_group_outcomes(%L, %L, array_fill(%L::uuid, ARRAY[501]))', u_agent, a_acct, m1),
    'ERROR % INVALID:%');

  -- ---------- 8. closed to the API roles ----------
  n := n + 1; failed := failed || pg_temp.dg_check('authenticated read desk_group_links', 'authenticated',
    'SELECT count(*)::text FROM public.desk_group_links', 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.dg_check('service_role read desk_group_intake directly', 'service_role',
    'SELECT count(*)::text FROM public.desk_group_intake', 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.dg_check('authenticated called desk_group_staff_for_phone', 'authenticated',
    'SELECT desk_group_staff_for_phone(gen_random_uuid(), ''971500324051'')::text', 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.dg_check('authenticated called desk_group_link_for_group', 'authenticated',
    'SELECT count(*)::text FROM desk_group_link_for_group(gen_random_uuid(), gen_random_uuid())', 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.dg_check('service_role could not call desk_group_link_for_group', 'service_role',
    'SELECT count(*)::text FROM desk_group_link_for_group(gen_random_uuid(), gen_random_uuid())', '0');
  n := n + 1; failed := failed || pg_temp.dg_check('service_role called the internal desk_group_can_see', 'service_role',
    'SELECT desk_group_can_see(gen_random_uuid(), gen_random_uuid(), gen_random_uuid())::text', 'ERROR 42501%');

  RAISE EXCEPTION USING ERRCODE = 'ZT324', MESSAGE = 'verify-desk-group-intake rollback';
  EXCEPTION WHEN SQLSTATE 'ZT324' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'desk group intake verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'desk group intake verification passed (% checks)', n;
END
$verify$;
