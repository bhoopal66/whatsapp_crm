-- Behavioural suite for migration 285: who reads automation runs,
-- automation steps and flow nodes; that no session reads a WhatsApp
-- number's secrets while the columns the app names still work; and that
-- a customer note is the writer's own, on a customer they can see.
--
-- ONE statement on purpose (the pinned CLI rejects several). Fixtures
-- are rolled back by a sentinel exception; the results survive.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000285001';
  u_admin UUID := '00000000-0000-4000-8000-000000285002';
  u_lead  UUID := '00000000-0000-4000-8000-000000285003';
  u_agent UUID := '00000000-0000-4000-8000-000000285004';
  u_view  UUID := '00000000-0000-4000-8000-000000285005';
  u_guest UUID := '00000000-0000-4000-8000-000000285006';
  u_gone  UUID := '00000000-0000-4000-8000-000000285007';
  c_mine  UUID := '00000000-0000-4000-8000-0000002850c1';
  c_other UUID := '00000000-0000-4000-8000-0000002850c2';
  auto    UUID := '00000000-0000-4000-8000-0000002850a1';
  flow    UUID := '00000000-0000-4000-8000-0000002850f1';
  num     UUID := '00000000-0000-4000-8000-0000002850e1';
  -- The columns whatsapp-config.tsx, channels.ts and the hooks name.
  app_cols TEXT := 'id, user_id, phone_number_id, waba_id, status, connected_at, registered_at, subscribed_apps_at, last_registration_error, mirror_inbound_media, provider, label, is_primary, is_personal, account_id, created_at, updated_at';
  acct    UUID;
  note    UUID;
  it      RECORD;
  want    TEXT;
  r       TEXT;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.rr_try(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; c bigint;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        IF p_sql ILIKE 'select%' THEN
          EXECUTE p_sql INTO v;
        ELSE
          EXECUTE p_sql;
          GET DIAGNOSTICS c = ROW_COUNT;
          v := c::text;
        END IF;
        RESET ROLE;
        RETURN coalesce(v, 'null');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        RETURN SQLSTATE;
      END;
    END $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'rr285-owner@example.test'), (u_admin, 'rr285-admin@example.test'),
    (u_lead, 'rr285-lead@example.test'), (u_agent, 'rr285-agent@example.test'),
    (u_view, 'rr285-view@example.test'), (u_guest, 'rr285-guest@example.test'),
    (u_gone, 'rr285-gone@example.test');
  SELECT account_id INTO acct FROM profiles WHERE user_id = u_owner LIMIT 1;
  UPDATE profiles p SET account_id = acct, account_role = v.r::account_role_enum,
         bank_code = CASE WHEN v.r = 'bank_guest' THEN 'ADCB' END
    FROM (VALUES (u_admin, 'admin'), (u_lead, 'team_leader'), (u_agent, 'agent'),
                 (u_view, 'viewer'), (u_guest, 'bank_guest'), (u_gone, 'admin')) v(u, r)
   WHERE p.user_id = v.u;
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_gone;

  INSERT INTO contacts (id, account_id, user_id, phone, name) VALUES
    (c_mine, acct, u_agent, '+971500285001', 'rr285 mine'),
    (c_other, acct, u_owner, '+971500285002', 'rr285 other');
  INSERT INTO automations (id, user_id, account_id, name, trigger_type)
    VALUES (auto, u_owner, acct, 'rr285', 'new_message_received');
  INSERT INTO automation_steps (automation_id, step_type, step_config, position)
    VALUES (auto, 'send_webhook', '{"headers":{"X-Key":"s"}}', 0);
  INSERT INTO automation_logs (automation_id, user_id, account_id, contact_id, trigger_event, status)
    VALUES (auto, u_owner, acct, c_mine, 'x', 'success'),
           (auto, u_owner, acct, c_other, 'x', 'success');
  INSERT INTO flows (id, user_id, account_id, name, trigger_type)
    VALUES (flow, u_owner, acct, 'rr285', 'manual');
  INSERT INTO flow_nodes (flow_id, node_key, node_type, config)
    VALUES (flow, 'n1', 'start', '{}');
  INSERT INTO whatsapp_config (id, user_id, account_id, provider, label,
      phone_number_id, access_token, verify_token, app_secret, status)
    VALUES (num, u_owner, acct, 'whapi', 'rr285', 'rr285', 'enc', 'enc', 'enc', 'connected');

  -- Reads, by role.
  FOR it IN
    SELECT p.who, p.uid, t.lbl, t.sql,
           CASE WHEN p.who IN ('owner', 'admin') THEN t.adm
                WHEN p.who IN ('guest', 'gone') THEN '0'
                ELSE t.staff END AS want
      FROM (VALUES ('owner', u_owner), ('admin', u_admin), ('leader', u_lead),
                   ('agent', u_agent), ('viewer', u_view), ('guest', u_guest),
                   ('gone', u_gone)) p(who, uid),
           (VALUES
      ('run log', format('SELECT count(*) FROM (SELECT * FROM automation_logs WHERE automation_id = %L) q', auto), '2', '0'),
      ('steps', format('SELECT count(*) FROM (SELECT * FROM automation_steps WHERE automation_id = %L) q', auto), '1', '0'),
      ('nodes', format('SELECT count(*) FROM (SELECT * FROM flow_nodes WHERE flow_id = %L) q', flow), '1', '0'),
      ('number, the app''s columns', format('SELECT count(*) FROM (SELECT %s FROM whatsapp_config WHERE account_id = %L) q', app_cols, acct), '1', '1')
           ) t(lbl, sql, adm, staff)
  LOOP
    n := n + 1;
    r := pg_temp.rr_try(it.uid, it.sql);
    IF r IS DISTINCT FROM it.want THEN
      failed := failed || format('%s reads %s: %s, want %s', it.who, it.lbl, r, it.want);
    END IF;
  END LOOP;

  -- No session reads a secret, whatever its role; * and a filter count.
  FOR it IN
    SELECT p.who, p.uid, s.sql
      FROM (VALUES ('owner', u_owner), ('admin', u_admin), ('agent', u_agent),
                   ('viewer', u_view)) p(who, uid),
           (VALUES ('SELECT access_token FROM whatsapp_config'),
                   ('SELECT verify_token FROM whatsapp_config'),
                   ('SELECT app_secret FROM whatsapp_config'),
                   ('SELECT count(*) FROM (SELECT * FROM whatsapp_config) q'),
                   ('SELECT count(*) FROM whatsapp_config WHERE access_token LIKE ''e%''')) s(sql)
  LOOP
    n := n + 1;
    r := pg_temp.rr_try(it.uid, it.sql);
    IF r <> '42501' THEN
      failed := failed || format('%s: %s answers %s, want 42501', it.who, it.sql, r);
    END IF;
  END LOOP;
  -- A column added later is granted, or named here as a secret.
  SELECT string_agg(attname, ', ') INTO r FROM pg_attribute
   WHERE attrelid = 'whatsapp_config'::regclass AND attnum > 0 AND NOT attisdropped
     AND has_column_privilege('authenticated', attrelid, attnum, 'SELECT')
         = (attname IN ('access_token', 'verify_token', 'app_secret'));
  n := n + 1;
  IF r IS NOT NULL THEN failed := failed || ('whatsapp_config column grants: ' || r); END IF;

  -- An admin still saves a token (Settings), reading the id back.
  n := n + 1;
  r := pg_temp.rr_try(u_admin, format('UPDATE whatsapp_config SET access_token = ''enc2'', label = ''x'' WHERE id = %L AND account_id = %L', num, acct));
  IF r <> '1' THEN failed := failed || ('admin saves a token: ' || r); END IF;

  -- Customer notes: the app's own INSERT, then the two it must refuse.
  FOR it IN
    SELECT * FROM (VALUES
      ('owner', u_owner, u_owner, c_other, '1'), ('admin', u_admin, u_admin, c_mine, '1'),
      ('agent, own customer', u_agent, u_agent, c_mine, '1'),
      ('agent, unseen customer', u_agent, u_agent, c_other, '42501'),
      ('agent, other name', u_agent, u_owner, c_mine, '42501'),
      ('admin, other name', u_admin, u_agent, c_mine, '42501'),
      ('viewer', u_view, u_view, c_mine, '42501'),
      ('guest', u_guest, u_guest, c_mine, '42501'),
      ('gone', u_gone, u_gone, c_mine, '42501')) v(who, uid, author, contact, want)
  LOOP
    n := n + 1;
    r := pg_temp.rr_try(it.uid, format(
      'INSERT INTO contact_notes (contact_id, account_id, user_id, note_text) VALUES (%L, %L, %L, %L)',
      it.contact, acct, it.author, 'rr285 ' || it.who));
    IF r <> it.want THEN
      failed := failed || format('note by %s: %s, want %s', it.who, r, it.want);
    END IF;
  END LOOP;

  INSERT INTO contact_notes (contact_id, account_id, user_id, note_text)
    VALUES (c_mine, acct, u_owner, 'rr285 edit') RETURNING id INTO note;
  FOR it IN
    SELECT * FROM (VALUES
      ('another person''s note', u_agent, format('UPDATE contact_notes SET note_text = ''z'' WHERE id = %L', note), '0'),
      ('own note', u_owner, format('UPDATE contact_notes SET note_text = ''z'' WHERE id = %L', note), '1'),
      ('own note given away', u_owner, format('UPDATE contact_notes SET user_id = %L WHERE id = %L', u_agent, note), '42501'),
      ('read back', u_agent, format('SELECT count(*) FROM contact_notes WHERE id = %L', note), '1'),
      -- 286: its writer, or an admin.
      ('a colleague''s note deleted', u_agent, format('DELETE FROM contact_notes WHERE id = %L', note), '0'),
      ('own note deleted', u_owner, format('DELETE FROM contact_notes WHERE id = %L', note), '1')) v(lbl, uid, sql, want)
  LOOP
    n := n + 1;
    r := pg_temp.rr_try(it.uid, it.sql);
    IF r <> it.want THEN
      failed := failed || format('%s: %s, want %s', it.lbl, r, it.want);
    END IF;
  END LOOP;

  RAISE EXCEPTION USING ERRCODE = 'RR285', MESSAGE = 'rollback';
  EXCEPTION WHEN SQLSTATE 'RR285' THEN NULL;
  END;

  IF cardinality(failed) > 0 THEN
    RAISE EXCEPTION E'verify-read-rules: % of % failed:\n%', cardinality(failed), n,
      array_to_string(failed, E'\n');
  END IF;
  RAISE NOTICE 'verify-read-rules: % checks passed', n;
END
$verify$;
