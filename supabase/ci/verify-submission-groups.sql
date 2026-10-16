-- Behavioural regression suite for Submission Groups (migration 115).
--
-- A submission group's identity (id, account_id, submission_ref,
-- contact_id, channel_id) never changes; wa_group_id is attached once,
-- only under a create claim; an ENDED group is frozen except its close
-- bookkeeping until the close is recorded. Out messages are born
-- pending and settled once; in messages flag post_end themselves. Who
-- reads is sg_rule_can_read (TS mirror src/lib/submission-groups/
-- rules.ts): ACTIVE, the open list or an owner/admin; ENDED, an
-- owner/admin, or a coordinator / team_lead on the list at the end
-- while now < ended_at + 60 days, never an agent, only through the
-- audited sg_read_archive. This asserts those rules, the access-list
-- and hosting-number guards, the append-only audit, that neither a
-- client nor the service role writes any table directly, and what an
-- authenticated reader sees.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner   UUID := '00000000-0000-4000-8000-000000115001';
  u_admin   UUID := '00000000-0000-4000-8000-000000115002';
  u_coord   UUID := '00000000-0000-4000-8000-000000115003';  -- agent, label coordinator on g1
  u_lead    UUID := '00000000-0000-4000-8000-000000115004';  -- team leader, label team_lead on g1
  u_agent   UUID := '00000000-0000-4000-8000-000000115005';  -- agent, label agent on g1 and g2
  u_wrong   UUID := '00000000-0000-4000-8000-000000115006';  -- team leader, but label agent on g1
  u_removed UUID := '00000000-0000-4000-8000-000000115007';  -- agent, coordinator on g1, removed before the end
  u_off     UUID := '00000000-0000-4000-8000-000000115008';  -- agent, on no list
  u_viewer  UUID := '00000000-0000-4000-8000-000000115009';
  u_guest   UUID := '00000000-0000-4000-8000-000000115010';
  u_gone    UUID := '00000000-0000-4000-8000-000000115011';  -- agent on g2, deactivated later
  u_other   UUID := '00000000-0000-4000-8000-000000115012';  -- owner of account B
  a_acct    UUID;
  b_acct    UUID;
  w1        UUID;  -- A, Whapi
  w2        UUID;  -- A, Whapi
  wm        UUID;  -- A, Meta
  wb        UUID;  -- B, Whapi
  c1        UUID;
  c2        UUID;
  cb        UUID;
  g1        UUID;  -- A, ended below
  g2        UUID;  -- A, stays ACTIVE
  gb        UUID;  -- B, ACTIVE
  tok       UUID;
  e_at      TIMESTAMPTZ;
  last_at   TIMESTAMPTZ;
  m1        BIGINT;
  m2        BIGINT;
  m3        BIGINT;
  m4        BIGINT;
  cnt       INT;
  j         JSONB;
  r         TEXT;
  n         INT := 0;
  failed    TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (NULL: as the current user) signed in as
  -- p_uid: a SELECT's value, 'ok', or 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sg_try(p_role text, p_uid uuid, p_sql text)
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
        IF p_sql ILIKE 'select%' OR p_sql ILIKE 'with%' THEN
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

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,   'sg-owner@example.invalid'),
    (u_admin,   'sg-admin@example.invalid'),
    (u_coord,   'sg-coord@example.invalid'),
    (u_lead,    'sg-lead@example.invalid'),
    (u_agent,   'sg-agent@example.invalid'),
    (u_wrong,   'sg-wrong@example.invalid'),
    (u_removed, 'sg-removed@example.invalid'),
    (u_off,     'sg-off@example.invalid'),
    (u_viewer,  'sg-viewer@example.invalid'),
    (u_guest,   'sg-guest@example.invalid'),
    (u_gone,    'sg-gone@example.invalid'),
    (u_other,   'sg-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_other;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id IN (u_lead, u_wrong);
  UPDATE profiles SET account_id = a_acct, account_role = 'agent'
   WHERE user_id IN (u_coord, u_agent, u_removed, u_off, u_gone);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_viewer;
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_guest;

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'SG-115-A1', 'x', 'connected', true) RETURNING id INTO w1;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'SG-115-A2', 'x', 'connected', false) RETURNING id INTO w2;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'meta', 'SG-115-AM', 'x', 'connected', false) RETURNING id INTO wm;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_other, b_acct, 'whapi', 'SG-115-B1', 'x', 'connected', true) RETURNING id INTO wb;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500115001', 'SG one')
    RETURNING id INTO c1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500115002', 'SG two')
    RETURNING id INTO c2;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (b_acct, u_other, '971500115003', 'SG bee')
    RETURNING id INTO cb;

  SELECT group_id INTO g1 FROM sg_open(a_acct, 'SG-115-1', c1, w1, 'one', NULL,
    jsonb_build_array(
      jsonb_build_object('user_id', u_coord, 'label', 'coordinator'),
      jsonb_build_object('user_id', u_lead, 'label', 'team_lead'),
      jsonb_build_object('user_id', u_agent, 'label', 'agent'),
      jsonb_build_object('user_id', u_wrong, 'label', 'agent'),
      jsonb_build_object('user_id', u_removed, 'label', 'coordinator')), NULL);
  -- The service role opens g2 (its grant is the real path).
  r := pg_temp.sg_try('service_role', NULL, format(
    'SELECT group_id::text FROM sg_open(%L, ''SG-115-2'', %L, %L, ''two'', NULL, %L::jsonb, NULL)',
    a_acct, c2, w1, jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent'),
                                      jsonb_build_object('user_id', u_gone, 'label', 'agent'))));
  IF r LIKE 'ERROR%' THEN
    RAISE EXCEPTION 'fixture: service role sg_open failed: %', r;
  END IF;
  g2 := r::uuid;
  SELECT group_id INTO gb FROM sg_open(b_acct, 'SG-115-B', cb, wb, 'bee', NULL,
    jsonb_build_array(jsonb_build_object('user_id', u_other, 'label', 'team_lead')), NULL);
  IF g1 IS NULL OR g2 IS NULL OR gb IS NULL THEN
    RAISE EXCEPTION 'fixture: sg_open returned no group';
  END IF;

  n := n + 1;
  IF (SELECT group_id FROM sg_open(a_acct, 'SG-115-1', c2, w2, 'again', NULL, '[]', NULL)) IS DISTINCT FROM g1
     OR (SELECT count(*) FROM submission_group_access WHERE group_id = g1) <> 5 THEN
    failed := failed || 'sg_open is not idempotent per (account, submission_ref)'::text;
  END IF;
  n := n + 1;
  IF (SELECT count(*) FROM submission_groups
       WHERE id IN (g1, g2, gb) AND status = 'ACTIVE' AND wa_group_id IS NULL AND wa_create_claim IS NULL) <> 3 THEN
    failed := failed || 'a new group is not ACTIVE, unclaimed and without a WhatsApp group'::text;
  END IF;

  -- ---------- hosting number ----------
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format(
    'SELECT group_id::text FROM sg_open(%L, ''SG-115-M'', %L, %L, NULL, NULL, ''[]'', NULL)', a_acct, c1, wm));
  IF r NOT LIKE 'ERROR 23514%' THEN
    failed := failed || format('a Meta number was accepted as the hosting number (%s)', r);
  END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format(
    'SELECT group_id::text FROM sg_open(%L, ''SG-115-X'', %L, %L, NULL, NULL, ''[]'', NULL)', a_acct, c1, wb));
  IF r NOT LIKE 'ERROR 23514%' THEN
    failed := failed || format('another workspace''s Whapi number was accepted (%s)', r);
  END IF;

  -- ---------- access list: who may be on it ----------
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format('SELECT sg_access_set(%L, %L, ''agent'', NULL)::text', g2, u_viewer));
  IF r NOT LIKE 'ERROR 23514%' THEN
    failed := failed || format('a viewer was put on an access list (%s)', r);
  END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format('SELECT sg_access_set(%L, %L, ''agent'', NULL)::text', g2, u_guest));
  IF r NOT LIKE 'ERROR 23514%' THEN
    failed := failed || format('a bank guest was put on an access list (%s)', r);
  END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format('SELECT sg_access_set(%L, %L, ''agent'', NULL)::text', g2, u_other));
  IF r NOT LIKE 'ERROR 23514%' THEN
    failed := failed || format('another workspace''s owner was put on an access list (%s)', r);
  END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format(
    'SELECT group_id::text FROM sg_open(%L, ''SG-115-V'', %L, %L, NULL, NULL, %L::jsonb, NULL)',
    a_acct, c1, w1, jsonb_build_array(jsonb_build_object('user_id', u_viewer, 'label', 'agent'))));
  IF r NOT LIKE 'ERROR 23514%' OR EXISTS (SELECT 1 FROM submission_groups WHERE submission_ref = 'SG-115-V') THEN
    failed := failed || format('sg_open with a viewer on the list opened a group (%s)', r);
  END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format('SELECT sg_access_set(%L, %L, ''team_lead'', NULL)::text', g2, u_owner));
  IF r LIKE 'ERROR%' THEN
    failed := failed || format('an owner could not be put on an access list (%s)', r);
  END IF;
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_gone;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format('SELECT sg_access_set(%L, %L, ''coordinator'', NULL)::text', g2, u_gone));
  IF r NOT LIKE 'ERROR 23514%' THEN
    failed := failed || format('a deactivated member was (re)labelled onto an access list (%s)', r);
  END IF;

  -- ---------- WhatsApp group id: under a claim, once ----------
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format(
    'UPDATE submission_groups SET wa_group_id = ''120363000000115099@g.us'' WHERE id = %L', g2));
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := failed || format('wa_group_id was set without a claim (%s)', r);
  END IF;
  n := n + 1;
  IF sg_attach_wa_group(g2, '120363000000115002@g.us', NULL, gen_random_uuid()) THEN
    failed := failed || 'sg_attach_wa_group attached without a claim'::text;
  END IF;
  tok := sg_claim_create(g2, 60000);
  n := n + 1;
  IF tok IS NULL OR sg_claim_create(g2, 60000) IS NOT NULL THEN
    failed := failed || 'a create claim was not exclusive while unexpired'::text;
  END IF;
  n := n + 1;
  IF sg_attach_wa_group(g2, '120363000000115002@g.us', NULL, gen_random_uuid()) THEN
    failed := failed || 'sg_attach_wa_group attached with another token'::text;
  END IF;
  -- A call and a read of what it wrote go in separate statements: a
  -- subquery reads the statement's snapshot, taken before the call.
  n := n + 1;
  r := sg_attach_wa_group(g2, '120363000000115002@g.us', 'https://chat.whatsapp.com/x', tok)::text;
  IF r IS DISTINCT FROM 'true' OR (SELECT wa_create_claim FROM submission_groups WHERE id = g2) IS NOT NULL THEN
    failed := failed || 'the claim holder could not attach the WhatsApp group (or the claim stayed)'::text;
  END IF;
  n := n + 1;
  IF sg_attach_wa_group(g2, '120363000000115003@g.us', NULL, tok) OR sg_claim_create(g2, 60000) IS NOT NULL THEN
    failed := failed || 'an attached group was claimed or attached again'::text;
  END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format(
    'UPDATE submission_groups SET wa_group_id = ''120363000000115004@g.us'' WHERE id = %L', g2));
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := failed || format('an attached wa_group_id was changed (%s)', r);
  END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format('UPDATE submission_groups SET wa_group_id = NULL WHERE id = %L', g2));
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := failed || format('an attached wa_group_id was cleared (%s)', r);
  END IF;
  tok := sg_claim_create(g1, 60000);
  PERFORM sg_attach_wa_group(g1, '120363000000115001@g.us', NULL, tok);

  -- ---------- frozen identity ----------
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format('UPDATE submission_groups SET id = gen_random_uuid() WHERE id = %L', g2));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('id changed (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format('UPDATE submission_groups SET account_id = %L WHERE id = %L', b_acct, g2));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('account_id changed (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format('UPDATE submission_groups SET submission_ref = ''SG-115-Z'' WHERE id = %L', g2));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('submission_ref changed (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format('UPDATE submission_groups SET contact_id = %L WHERE id = %L', c1, g2));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('contact_id changed (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format('UPDATE submission_groups SET channel_id = %L WHERE id = %L', w2, g2));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('channel_id changed (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format('DELETE FROM submission_groups WHERE id = %L', g2));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('a group was deleted (%s)', r); END IF;

  -- ---------- out messages: born pending, settled once ----------
  m1 := sg_send_begin(g2, u_agent, 'a', 'Agent (Agent): a');
  m2 := sg_send_begin(g2, u_agent, 'b', 'Agent (Agent): b');
  m3 := sg_send_begin(g2, u_agent, 'c', 'Agent (Agent): c');
  m4 := sg_send_begin(g2, u_agent, 'd', 'Agent (Agent): d');
  n := n + 1;
  IF m1 IS NULL OR (SELECT count(*) FROM submission_group_messages
                     WHERE id IN (m1, m2, m3, m4) AND send_status = 'pending' AND wa_message_id IS NULL) <> 4 THEN
    failed := failed || 'an on-list agent''s send did not begin as a pending row'::text;
  END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format(
    'INSERT INTO submission_group_messages (group_id, account_id, direction, sender_user_id, body, prefixed_body, send_status, wa_message_id)
     VALUES (%L, %L, ''out'', %L, ''x'', ''X: x'', ''sent'', ''wamid.sg-direct'')', g2, a_acct, u_agent));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('an out row was born sent (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format('SELECT sg_settle_send(%s, ''sent'', NULL)::text', m1));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('pending -> sent without wa_message_id (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format(
    'UPDATE submission_group_messages SET send_status = ''failed'', wa_message_id = ''wamid.sg-f'' WHERE id = %s', m1));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('pending -> failed with a wa_message_id (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format('UPDATE submission_group_messages SET body = ''changed'' WHERE id = %s', m1));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('a pending row''s body changed (%s)', r); END IF;
  n := n + 1;
  IF NOT sg_settle_send(m1, 'sent', 'wamid.sg-1') OR NOT sg_settle_send(m2, 'blocked', NULL)
     OR NOT sg_settle_send(m3, 'failed', NULL) THEN
    failed := failed || 'a pending row could not be settled sent / blocked / failed'::text;
  END IF;
  n := n + 1;
  IF sg_settle_send(m1, 'failed', NULL) OR sg_settle_send(m2, 'sent', 'wamid.sg-2') THEN
    failed := failed || 'a settled row was settled again'::text;
  END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format(
    'UPDATE submission_group_messages SET send_status = ''pending'', wa_message_id = NULL WHERE id = %s', m1));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('a sent row went back to pending (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format('UPDATE submission_group_messages SET send_status = ''sent'', wa_message_id = ''w'' WHERE id = %s', m2));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('a blocked row was changed (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format('DELETE FROM submission_group_messages WHERE id = %s', m3));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('a message was deleted (%s)', r); END IF;
  n := n + 1;
  IF (SELECT string_agg(send_status, ',' ORDER BY id) FROM submission_group_messages WHERE id IN (m1, m2, m3, m4))
     IS DISTINCT FROM 'sent,blocked,failed,pending'
     OR (SELECT wa_message_id FROM submission_group_messages WHERE id = m1) IS DISTINCT FROM 'wamid.sg-1' THEN
    failed := failed || 'the settled statuses are not sent,blocked,failed,pending'::text;
  END IF;

  -- ---------- who may begin a send (ACTIVE) ----------
  n := n + 1;
  IF sg_send_begin(g2, u_coord, 'x', 'C (Coordinator): x') IS NOT NULL THEN
    failed := failed || 'an off-list user began a send'::text;
  END IF;
  n := n + 1;
  IF sg_send_begin(g2, u_admin, 'x', 'A: x') IS NOT NULL THEN
    failed := failed || 'an off-list admin began a send'::text;
  END IF;
  n := n + 1;
  IF sg_send_begin(g2, u_gone, 'x', 'G (Agent): x') IS NOT NULL THEN
    failed := failed || 'a deactivated member still on the list began a send'::text;
  END IF;
  n := n + 1;
  r := pg_temp.sg_try('service_role', NULL, format('SELECT sg_send_begin(%L, %L, ''sr'', ''Agent (Agent): sr'')::text', g2, u_agent));
  IF r IS NULL OR r = 'ok' OR r LIKE 'ERROR%' THEN
    failed := failed || format('the service role could not begin a send for an on-list agent (%s)', r);
  END IF;

  -- ---------- inbound, end, post_end ----------
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format(
    'SELECT sg_record_inbound(%L, ''wa-sg-x'', ''971500115001'', ''customer'', ''text'', ''x'', NULL, NULL)::text',
    gen_random_uuid()));
  IF r NOT LIKE 'ERROR P0002%' THEN failed := failed || format('inbound on an unknown group (%s)', r); END IF;
  n := n + 1;
  IF NOT sg_record_inbound(g1, 'wa-sg-in1', '971500115001', 'customer', 'text', 'before', NULL, NULL)
     OR sg_record_inbound(g1, 'wa-sg-in1', '971500115001', 'customer', 'text', 'before', NULL, NULL) THEN
    failed := failed || 'inbound was not stored once (idempotent on wa_message_id)'::text;
  END IF;
  INSERT INTO submission_group_messages (group_id, account_id, direction, sender_wa_id, sender_kind, body, wa_message_id, post_end)
  VALUES (g1, a_acct, 'in', '971500115001', 'customer', 'forged', 'wa-sg-in2', true);
  n := n + 1;
  IF (SELECT count(*) FROM submission_group_messages WHERE group_id = g1 AND post_end) <> 0 THEN
    failed := failed || 'an inbound on an ACTIVE group kept post_end = true'::text;
  END IF;
  m4 := sg_send_begin(g1, u_coord, 'pre', 'C (Coordinator): pre');
  PERFORM sg_settle_send(m4, 'sent', 'wamid.sg-g1');

  -- API helpers: staff by login email, the reported submission status.
  n := n + 1;
  SELECT string_agg(s.user_id::text || ':' || s.role || ':' || s.email, ',' ORDER BY s.user_id) INTO r
    FROM sg_staff_by_email(a_acct, ARRAY['SG-Agent@Example.invalid', ' sg-lead@example.invalid ',
      'sg-viewer@example.invalid', 'sg-guest@example.invalid', 'sg-gone@example.invalid',
      'sg-other@example.invalid', 'nobody@example.invalid']) s;
  IF r IS DISTINCT FROM format('%s:team_leader:sg-lead@example.invalid,%s:agent:sg-agent@example.invalid', u_lead, u_agent) THEN
    failed := failed || format('sg_staff_by_email matched %s (want the live agent and leader only)', r);
  END IF;
  n := n + 1;
  r := pg_temp.sg_try('service_role', NULL, format(
    'SELECT count(*)::text FROM sg_staff_by_email(%L, ARRAY[''sg-owner@example.invalid''])', a_acct));
  IF r IS DISTINCT FROM '1' THEN failed := failed || format('the service role cannot look staff up by email (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try('authenticated', u_owner, format(
    'SELECT count(*)::text FROM sg_staff_by_email(%L, ARRAY[''sg-agent@example.invalid''])', a_acct));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('a signed-in user ran sg_staff_by_email (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try('authenticated', u_owner, format('SELECT sg_note_submission_status(%L, ''X'')::text', g1));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('a signed-in user ran sg_note_submission_status (%s)', r); END IF;
  n := n + 1;
  -- Two statements: in one expression the subquery (an initPlan) reads before the call writes.
  r := sg_note_submission_status(g1, 'UNDER_REVIEW')::text;
  IF r IS DISTINCT FROM 'true'
     OR (SELECT submission_status FROM submission_groups WHERE id = g1) IS DISTINCT FROM 'UNDER_REVIEW' THEN
    failed := failed || 'sg_note_submission_status did not record the status on an ACTIVE group'::text;
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND (SELECT count(*) FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
           AND tablename IN ('submission_groups', 'submission_group_messages')) <> 2 THEN
    failed := failed || 'submission groups are not in the supabase_realtime publication'::text;
  END IF;

  PERFORM sg_access_remove(g1, u_removed);
  n := n + 1;
  IF NOT sg_end(g1, 'FINAL_STATUS:APPROVED') OR sg_end(g1, 'again') THEN
    failed := failed || 'sg_end did not end an ACTIVE group exactly once'::text;
  END IF;
  SELECT ended_at, last_activity_at INTO e_at, last_at FROM submission_groups WHERE id = g1;
  n := n + 1;
  r := sg_note_submission_status(g1, 'LATE')::text;
  IF r IS DISTINCT FROM 'false'
     OR (SELECT submission_status FROM submission_groups WHERE id = g1) IS DISTINCT FROM 'UNDER_REVIEW' THEN
    failed := failed || 'sg_note_submission_status changed an ENDED group'::text;
  END IF;
  n := n + 1;
  IF (SELECT count(*) FROM submission_group_access WHERE group_id = g1 AND removed_at IS NULL) <> 0
     OR (SELECT count(*) FROM submission_group_access WHERE group_id = g1 AND removed_at = e_at) <> 4
     OR (SELECT removed_at FROM submission_group_access WHERE group_id = g1 AND user_id = u_removed) >= e_at THEN
    failed := failed || 'sg_end did not close the open access rows at ended_at'::text;
  END IF;
  n := n + 1;
  IF sg_send_begin(g1, u_coord, 'late', 'C (Coordinator): late') IS NOT NULL THEN
    failed := failed || 'a send began on an ENDED group'::text;
  END IF;
  n := n + 1;
  r := sg_record_inbound(g1, 'wa-sg-in3', '971500115001', 'customer', 'text', 'after', NULL, NULL)::text;
  IF r IS DISTINCT FROM 'true'
     OR (SELECT post_end FROM submission_group_messages WHERE group_id = g1 AND wa_message_id = 'wa-sg-in3') IS NOT TRUE THEN
    failed := failed || 'an inbound after the end was not stored with post_end'::text;
  END IF;
  INSERT INTO submission_group_messages (group_id, account_id, direction, sender_wa_id, sender_kind, body, wa_message_id, post_end)
  VALUES (g1, a_acct, 'in', '971500115001', 'customer', 'forged', 'wa-sg-in4', false);
  n := n + 1;
  IF (SELECT post_end FROM submission_group_messages WHERE group_id = g1 AND wa_message_id = 'wa-sg-in4') IS NOT TRUE THEN
    failed := failed || 'the caller''s post_end = false survived on an ENDED group'::text;
  END IF;
  n := n + 1;
  IF (SELECT last_activity_at FROM submission_groups WHERE id = g1) IS DISTINCT FROM last_at THEN
    failed := failed || 'an inbound after the end moved last_activity_at'::text;
  END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format(
    'INSERT INTO submission_group_messages (group_id, account_id, direction, sender_user_id, body, prefixed_body, send_status)
     VALUES (%L, %L, ''out'', %L, ''x'', ''X: x'', ''pending'')', g1, a_acct, u_coord));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('an out row was written into an ENDED group (%s)', r); END IF;

  -- ---------- ENDED is frozen except the close bookkeeping ----------
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format('UPDATE submission_groups SET subject = ''changed'' WHERE id = %L', g1));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('an ENDED group''s subject changed (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format(
    'UPDATE submission_groups SET status = ''ACTIVE'', ended_at = NULL, end_reason = NULL WHERE id = %L', g1));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('an ENDED group was reopened (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format('SELECT sg_access_set(%L, %L, ''agent'', NULL)::text', g1, u_off));
  IF r NOT LIKE 'ERROR 55000%' THEN failed := failed || format('sg_access_set on an ENDED group (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format('SELECT sg_access_remove(%L, %L)::text', g1, u_coord));
  IF r NOT LIKE 'ERROR 55000%' THEN failed := failed || format('sg_access_remove on an ENDED group (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format(
    'UPDATE submission_group_access SET removed_at = removed_at + interval ''1 second'' WHERE group_id = %L AND user_id = %L', g1, u_coord));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('a closed access row was changed (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format('DELETE FROM submission_group_access WHERE group_id = %L', g1));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('an access row was deleted (%s)', r); END IF;
  n := n + 1;
  r := (sg_record_wa_close_error(g1, 'gateway down') AND sg_mark_wa_closed(g1))::text;
  IF r IS DISTINCT FROM 'true' OR (SELECT wa_close_error FROM submission_groups WHERE id = g1) IS NOT NULL
     OR (SELECT wa_closed_at FROM submission_groups WHERE id = g1) IS NULL THEN
    failed := failed || 'the close bookkeeping of an ENDED group could not be written'::text;
  END IF;
  n := n + 1;
  IF sg_record_wa_close_error(g1, 'late') OR sg_mark_wa_closed(g1) THEN
    failed := failed || 'the close bookkeeping was written after the close was recorded'::text;
  END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format('UPDATE submission_groups SET wa_close_error = ''x'' WHERE id = %L', g1));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('a closed group''s bookkeeping changed (%s)', r); END IF;

  -- ---------- the supervisor window (sg_rule_can_read via sg_can_read) ----------
  n := n + 1;
  IF NOT sg_can_read(g1, u_coord, e_at + interval '59 days')
     OR NOT sg_can_read(g1, u_coord, e_at + interval '1440 hours' - interval '1 microsecond') THEN
    failed := failed || 'a coordinator on the list at the end could not read inside the window'::text;
  END IF;
  n := n + 1;
  IF sg_can_read(g1, u_coord, e_at + interval '1440 hours') THEN
    failed := failed || 'a coordinator read at exactly ended_at + 60 days'::text;
  END IF;
  n := n + 1;
  IF NOT sg_can_read(g1, u_lead, e_at + interval '59 days') OR sg_can_read(g1, u_lead, e_at + interval '1440 hours') THEN
    failed := failed || 'a team_lead''s window is not [ended_at, ended_at + 60 days)'::text;
  END IF;
  n := n + 1;
  IF sg_can_read(g1, u_agent, e_at) OR sg_can_read(g1, u_agent, e_at + interval '1 day') THEN
    failed := failed || 'an agent read an ENDED group'::text;
  END IF;
  n := n + 1;
  IF sg_can_read(g1, u_wrong, e_at + interval '1 day') THEN
    failed := failed || 'a team leader labelled agent read an ENDED group (the label decides, not the account role)'::text;
  END IF;
  n := n + 1;
  IF sg_can_read(g1, u_removed, e_at + interval '1 day') THEN
    failed := failed || 'a coordinator removed before the end read the archive'::text;
  END IF;
  n := n + 1;
  IF sg_can_read(g1, u_off, e_at + interval '1 day') OR sg_can_read(g1, u_other, e_at + interval '1 day') THEN
    failed := failed || 'someone never on the list (or of another workspace) read the archive'::text;
  END IF;
  n := n + 1;
  IF NOT sg_can_read(g1, u_owner, e_at + interval '3650 days') OR NOT sg_can_read(g1, u_admin, e_at + interval '3650 days') THEN
    failed := failed || 'an owner/admin could not read the archive outside the window'::text;
  END IF;
  n := n + 1;
  IF NOT sg_can_read(g2, u_agent) OR NOT sg_can_read(g2, u_admin) OR sg_can_read(g2, u_coord)
     OR sg_can_read(g2, u_viewer) OR sg_can_read(g2, u_other) THEN
    failed := failed || 'ACTIVE read is not exactly the open list plus owner/admin'::text;
  END IF;

  -- ---------- sg_read_archive and its audit ----------
  SELECT count(*) INTO cnt FROM submission_group_audit;
  j := sg_read_archive(g1, u_coord, e_at + interval '1 day');
  n := n + 1;
  IF (j->>'allowed')::boolean IS NOT TRUE OR j->>'role' IS DISTINCT FROM 'coordinator'
     OR jsonb_array_length(j->'messages') <> 5
     OR (SELECT count(*) FROM submission_group_audit) <> cnt + 1
     OR NOT EXISTS (SELECT 1 FROM submission_group_audit WHERE group_id = g1 AND user_id = u_coord
                     AND role = 'coordinator' AND viewed_at = e_at + interval '1 day' AND window_days = 60) THEN
    failed := failed || format('an allowed archive read did not return everything and write one audit row (%s)', j);
  END IF;
  SELECT count(*) INTO cnt FROM submission_group_audit;
  n := n + 1;
  j := sg_read_archive(g1, u_agent, e_at + interval '1 day');
  IF j IS DISTINCT FROM '{"allowed": false, "messages": []}'::jsonb THEN
    failed := failed || format('a refused archive read returned %s', j);
  END IF;
  n := n + 1;
  j := sg_read_archive(g1, u_coord, e_at + interval '1440 hours');
  IF (j->>'allowed')::boolean IS NOT FALSE THEN
    failed := failed || 'an archive read at ended_at + 60 days was allowed'::text;
  END IF;
  n := n + 1;
  j := sg_read_archive(g2, u_admin);
  IF (j->>'allowed')::boolean IS NOT FALSE THEN
    failed := failed || 'sg_read_archive read an ACTIVE group'::text;
  END IF;
  n := n + 1;
  IF (SELECT count(*) FROM submission_group_audit) <> cnt THEN
    failed := failed || 'a refused archive read wrote an audit row'::text;
  END IF;
  n := n + 1;
  j := sg_read_archive(g1, u_admin, e_at + interval '3650 days');
  IF j->>'role' IS DISTINCT FROM 'admin' OR (SELECT count(*) FROM submission_group_audit) <> cnt + 1 THEN
    failed := failed || 'an admin archive read was not allowed and audited as admin'::text;
  END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format(
    'INSERT INTO submission_group_audit (group_id, account_id, user_id, role) VALUES (%L, %L, %L, ''team_lead'')',
    g1, a_acct, u_coord));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('an audit row with the wrong role was written (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, 'UPDATE submission_group_audit SET window_days = 90');
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('an audit row was updated (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, 'DELETE FROM submission_group_audit');
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('an audit row was deleted (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, 'TRUNCATE submission_group_audit');
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('the audit was truncated (%s)', r); END IF;

  -- ---------- no direct writes: service role and clients ----------
  n := n + 1;
  r := pg_temp.sg_try('service_role', NULL, format(
    'INSERT INTO submission_groups (account_id, submission_ref, contact_id, channel_id) VALUES (%L, ''SG-115-SR'', %L, %L)',
    a_acct, c1, w1));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('service role inserted a group (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try('service_role', NULL, format('UPDATE submission_groups SET subject = ''sr'' WHERE id = %L', g2));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('service role updated a group (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try('service_role', NULL, format(
    'INSERT INTO submission_group_access (group_id, account_id, user_id, label) VALUES (%L, %L, %L, ''agent'')',
    g2, a_acct, u_off));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('service role inserted an access row (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try('service_role', NULL, format(
    'UPDATE submission_group_access SET removed_at = now() WHERE group_id = %L', g2));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('service role updated an access row (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try('service_role', NULL, format(
    'INSERT INTO submission_group_messages (group_id, account_id, direction, sender_wa_id, sender_kind, wa_message_id)
     VALUES (%L, %L, ''in'', ''971500115001'', ''customer'', ''wa-sg-sr'')', g2, a_acct));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('service role inserted a message (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try('service_role', NULL, format(
    'UPDATE submission_group_messages SET send_status = ''failed'' WHERE id = %s', m1));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('service role updated a message (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try('service_role', NULL, format(
    'INSERT INTO submission_group_audit (group_id, account_id, user_id, role) VALUES (%L, %L, %L, ''admin'')',
    g1, a_acct, u_admin));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('service role inserted an audit row (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try('service_role', NULL, 'UPDATE submission_group_audit SET window_days = 1');
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('service role updated the audit (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try('service_role', NULL, format(
    'SELECT count(*)::text FROM submission_groups WHERE id IN (%L, %L, %L)', g1, g2, gb));
  IF r IS DISTINCT FROM '3' THEN failed := failed || format('service role does not read every group (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try('authenticated', u_admin, format('UPDATE submission_groups SET subject = ''x'' WHERE id = %L', g2));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('an admin client updated a group (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try('authenticated', u_agent, format(
    'INSERT INTO submission_group_messages (group_id, account_id, direction, sender_user_id, body, prefixed_body, send_status)
     VALUES (%L, %L, ''out'', %L, ''x'', ''X: x'', ''pending'')', g2, a_acct, u_agent));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('an agent client inserted a message (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try('authenticated', u_coord, format('SELECT sg_read_archive(%L, %L)::text', g1, u_coord));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('a client called sg_read_archive (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try('authenticated', u_agent, format('SELECT sg_send_begin(%L, %L, ''x'', ''x'')::text', g2, u_agent));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('a client called sg_send_begin (%s)', r); END IF;

  -- ---------- what an authenticated reader sees ----------
  -- A post_end row on the ACTIVE g2 (only reachable with the guard off)
  -- pins the policy's own NOT post_end clause.
  ALTER TABLE submission_group_messages DISABLE TRIGGER submission_group_messages_guard;
  INSERT INTO submission_group_messages (group_id, account_id, direction, sender_wa_id, sender_kind, body, wa_message_id, post_end)
  VALUES (g2, a_acct, 'in', '971500115002', 'customer', 'hidden', 'wa-sg-pe', true);
  ALTER TABLE submission_group_messages ENABLE TRIGGER submission_group_messages_guard;
  SELECT count(*) INTO cnt FROM submission_group_messages WHERE group_id = g2 AND NOT post_end;

  n := n + 1;
  r := pg_temp.sg_try('authenticated', u_agent,
    'SELECT string_agg(submission_ref, '','' ORDER BY submission_ref) FROM submission_groups');
  IF r IS DISTINCT FROM 'SG-115-2' THEN failed := failed || format('an on-list agent sees groups %s', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try('authenticated', u_agent, 'SELECT count(*)::text FROM submission_group_messages');
  IF r IS DISTINCT FROM cnt::text THEN
    failed := failed || format('an on-list agent sees %s messages, not the %s live ones of g2', r, cnt);
  END IF;
  n := n + 1;
  r := pg_temp.sg_try('authenticated', u_agent, 'SELECT count(*)::text FROM submission_group_messages WHERE post_end');
  IF r IS DISTINCT FROM '0' THEN failed := failed || format('a post_end message is visible (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try('authenticated', u_agent,
    format('SELECT count(*)::text FROM submission_group_access WHERE group_id <> %L', g2));
  IF r IS DISTINCT FROM '0' THEN failed := failed || format('an agent sees access rows of other groups (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try('authenticated', u_coord, 'SELECT count(*)::text FROM submission_groups');
  IF r IS DISTINCT FROM '0' THEN failed := failed || format('a coordinator sees an ENDED group directly (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try('authenticated', u_coord, 'SELECT count(*)::text FROM submission_group_messages');
  IF r IS DISTINCT FROM '0' THEN failed := failed || format('a coordinator sees ENDED messages directly (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try('authenticated', u_admin,
    'SELECT string_agg(submission_ref, '','' ORDER BY submission_ref) FROM submission_groups');
  IF r IS DISTINCT FROM 'SG-115-2' THEN failed := failed || format('an admin sees groups %s', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try('authenticated', u_owner, 'SELECT count(*)::text FROM submission_group_messages');
  IF r IS DISTINCT FROM cnt::text THEN failed := failed || format('the owner sees %s messages', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try('authenticated', u_admin, format('SELECT count(*)::text FROM submission_group_audit WHERE account_id = %L', a_acct));
  IF r IS DISTINCT FROM '2' THEN failed := failed || format('an admin sees %s audit rows', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try('authenticated', u_coord, 'SELECT count(*)::text FROM submission_group_audit');
  IF r IS DISTINCT FROM '0' THEN failed := failed || format('a coordinator sees the audit (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try('authenticated', u_off, 'SELECT count(*)::text FROM submission_groups');
  IF r IS DISTINCT FROM '0' THEN failed := failed || format('an off-list agent sees groups (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try('authenticated', u_viewer, 'SELECT count(*)::text FROM submission_group_access');
  IF r IS DISTINCT FROM '0' THEN failed := failed || format('a viewer sees access rows (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try('authenticated', u_guest,
    'SELECT ((SELECT count(*) FROM submission_groups) + (SELECT count(*) FROM submission_group_messages))::text');
  IF r IS DISTINCT FROM '0' THEN failed := failed || format('a bank guest sees submission groups (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try('authenticated', u_gone, 'SELECT count(*)::text FROM submission_groups');
  IF r IS DISTINCT FROM '0' THEN failed := failed || format('a deactivated member still sees groups (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try('authenticated', u_other,
    'SELECT string_agg(submission_ref, '','' ORDER BY submission_ref) FROM submission_groups');
  IF r IS DISTINCT FROM 'SG-115-B' THEN failed := failed || format('B''s owner sees groups %s', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try('authenticated', u_other, format(
    'SELECT ((SELECT count(*) FROM submission_group_messages WHERE account_id = %1$L)
           + (SELECT count(*) FROM submission_group_access WHERE account_id = %1$L)
           + (SELECT count(*) FROM submission_group_audit WHERE account_id = %1$L))::text', a_acct));
  IF r IS DISTINCT FROM '0' THEN failed := failed || format('another workspace sees A''s rows (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try('authenticated', u_owner, format('SELECT count(*)::text FROM submission_groups WHERE id = %L', gb));
  IF r IS DISTINCT FROM '0' THEN failed := failed || format('A''s owner sees B''s group (%s)', r); END IF;

  -- ---------- removing the number or the contact detaches, never blocks ----------
  -- Only the FKs' ON DELETE SET NULL may clear channel_id / contact_id,
  -- and only once the referenced row is gone; the archive survives.
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format('UPDATE submission_groups SET channel_id = NULL WHERE id = %L', g2));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('channel_id cleared while the number exists (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format('UPDATE submission_groups SET contact_id = NULL WHERE id = %L', g2));
  IF r NOT LIKE 'ERROR 42501%' THEN failed := failed || format('contact_id cleared while the contact exists (%s)', r); END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format('DELETE FROM whatsapp_config WHERE id = %L', w1));
  IF r IS DISTINCT FROM 'ok' THEN failed := failed || format('a number hosting groups could not be removed (%s)', r); END IF;
  n := n + 1;
  IF (SELECT count(*) FROM submission_groups WHERE id IN (g1, g2) AND channel_id IS NULL) <> 2
     OR (SELECT status FROM submission_groups WHERE id = g1) <> 'ENDED'
     OR NOT EXISTS (SELECT 1 FROM submission_group_messages WHERE group_id = g1) THEN
    failed := failed || 'removing the number did not detach both groups and keep the archive'::text;
  END IF;
  n := n + 1;
  r := pg_temp.sg_try(NULL, NULL, format('DELETE FROM contacts WHERE id = %L', c2));
  IF r IS DISTINCT FROM 'ok' THEN failed := failed || format('a contact with a group could not be deleted (%s)', r); END IF;
  n := n + 1;
  IF (SELECT contact_id FROM submission_groups WHERE id = g2) IS NOT NULL THEN
    failed := failed || 'deleting the contact did not detach its group'::text;
  END IF;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT115', MESSAGE = 'verify-submission-groups rollback';
  EXCEPTION WHEN SQLSTATE 'ZT115' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'submission groups verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'submission groups verification passed (% checks)', n;
END
$verify$;
