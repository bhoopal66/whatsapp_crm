-- Behavioural regression suite for migration 333: an owner or admin of a
-- submission group's account sends to any ACTIVE group of it without
-- being on its access list; an ENDED group stays unsendable; an unlisted
-- agent or viewer, a deactivated admin and an admin of another workspace
-- still cannot send; a listed agent still can.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The fixtures are
-- rolled back by a sentinel exception; the results survive in plpgsql
-- variables. Fails without 333 (sg_can_send refuses the unlisted owner).

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000333001';
  u_admin  UUID := '00000000-0000-4000-8000-000000333002';
  u_agent  UUID := '00000000-0000-4000-8000-000000333003'; -- listed
  u_other  UUID := '00000000-0000-4000-8000-000000333004'; -- unlisted agent
  u_view   UUID := '00000000-0000-4000-8000-000000333005'; -- unlisted viewer
  u_gone   UUID := '00000000-0000-4000-8000-000000333006'; -- deactivated admin
  u_faro   UUID := '00000000-0000-4000-8000-000000333007'; -- owner of another account
  u_fara   UUID := '00000000-0000-4000-8000-000000333008'; -- admin of another account
  a_acct   UUID;
  a_far    UUID;
  w1       UUID;
  c1       UUID;
  ga       UUID;
  ge       UUID;
  acc      JSONB;
  r        TEXT;
  b        BOOLEAN;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a SELECT as p_role signed in as p_uid: its value, or
  -- 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sas_try(p_role text, p_uid uuid, p_sql text)
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
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sas_ok(p_ok boolean, p_msg text)
    RETURNS text[] LANGUAGE sql AS $body$
      SELECT CASE WHEN coalesce(p_ok, false) THEN '{}'::text[] ELSE ARRAY[p_msg] END
    $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'sas333-owner@example.invalid'), (u_admin, 'sas333-admin@example.invalid'),
    (u_agent, 'sas333-agent@example.invalid'), (u_other, 'sas333-other@example.invalid'),
    (u_view,  'sas333-view@example.invalid'),  (u_gone,  'sas333-gone@example.invalid'),
    (u_faro,  'sas333-faro@example.invalid'),  (u_fara,  'sas333-fara@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO a_far FROM profiles WHERE user_id = u_faro;
  IF a_acct IS NULL OR a_far IS NULL OR a_acct = a_far THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision two accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id IN (u_admin, u_gone);
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agent, u_other);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_view;
  UPDATE profiles SET account_id = a_far, account_role = 'admin' WHERE user_id = u_fara;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'SAS-333-A1', 'x', 'connected', true) RETURNING id INTO w1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500333001', 'SAS one')
    RETURNING id INTO c1;

  acc := jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent'));
  ga := (SELECT o.group_id FROM sg_open(a_acct, 'SAS-333-A', c1, w1, 'a', NULL, acc, NULL, 'group') o);
  ge := (SELECT o.group_id FROM sg_open(a_acct, 'SAS-333-E', c1, w1, 'e', NULL, acc, NULL, 'group') o);
  IF ga IS NULL OR ge IS NULL THEN
    RAISE EXCEPTION 'fixture: sg_open returned no group';
  END IF;
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_gone;
  b := sg_end(ge, 'test');
  IF (SELECT status FROM submission_groups WHERE id = ge) IS DISTINCT FROM 'ENDED' THEN
    RAISE EXCEPTION 'fixture: sg_end did not end the group';
  END IF;
  IF EXISTS (SELECT 1 FROM submission_group_access
              WHERE group_id = ga AND user_id IN (u_owner, u_admin, u_other, u_view, u_gone, u_fara)
                AND removed_at IS NULL) THEN
    RAISE EXCEPTION 'fixture: an unlisted person is on the access list';
  END IF;

  -- ---------- (a) unlisted owner and admin send on ACTIVE ----------
  n := n + 1; failed := failed || pg_temp.sas_ok(sg_can_send(ga, u_owner), 'an unlisted owner cannot send to an ACTIVE group');
  n := n + 1; failed := failed || pg_temp.sas_ok(sg_can_send(ga, u_admin), 'an unlisted admin cannot send to an ACTIVE group');
  n := n + 1; failed := failed || pg_temp.sas_ok(
    sg_resolve_role(ga, u_owner) IS NOT DISTINCT FROM 'owner'
    AND sg_resolve_role(ga, u_admin) IS NOT DISTINCT FROM 'admin',
    'sg_resolve_role does not label an unlisted owner/admin by account role');
  n := n + 1; r := pg_temp.sas_try('service_role', NULL, format('SELECT sg_send_begin(%L, %L, ''hi'', ''Owner (Owner): hi'')::text', ga, u_owner));
  failed := failed || pg_temp.sas_ok(r NOT LIKE 'ERROR%' AND r <> 'NULL', format('sg_send_begin refused an unlisted owner (%s)', r));
  n := n + 1; r := pg_temp.sas_try('service_role', NULL, format(
    'SELECT sg_send_begin_media(%L, %L, ''image'', '''', ''Admin (Admin)'', %L::jsonb)::text',
    ga, u_admin, '{"link":"https://example.invalid/a.png"}'));
  failed := failed || pg_temp.sas_ok(r NOT LIKE 'ERROR%' AND r <> 'NULL', format('sg_send_begin_media refused an unlisted admin (%s)', r));

  -- ---------- (b) an ENDED group: nobody sends ----------
  n := n + 1; failed := failed || pg_temp.sas_ok(NOT sg_can_send(ge, u_owner), 'an owner can send to an ENDED group');
  n := n + 1; failed := failed || pg_temp.sas_ok(NOT sg_can_send(ge, u_admin), 'an admin can send to an ENDED group');
  n := n + 1; failed := failed || pg_temp.sas_ok(NOT sg_can_send(ge, u_agent), 'a listed agent can send to an ENDED group');
  n := n + 1; r := pg_temp.sas_try('service_role', NULL, format('SELECT sg_send_begin(%L, %L, ''hi'', ''x'')::text', ge, u_owner));
  failed := failed || pg_temp.sas_ok(r = 'NULL', format('sg_send_begin stored an owner''s send into an ENDED group (%s)', r));

  -- ---------- (c) still refused ----------
  n := n + 1; failed := failed || pg_temp.sas_ok(NOT sg_can_send(ga, u_other), 'an unlisted agent can send');
  n := n + 1; failed := failed || pg_temp.sas_ok(NOT sg_can_send(ga, u_view), 'an unlisted viewer can send');
  n := n + 1; failed := failed || pg_temp.sas_ok(NOT sg_can_send(ga, u_gone), 'a deactivated admin can send');
  n := n + 1; failed := failed || pg_temp.sas_ok(NOT sg_can_send(ga, u_fara), 'an admin of another workspace can send');
  n := n + 1; failed := failed || pg_temp.sas_ok(NOT sg_can_send(ga, u_faro), 'an owner of another workspace can send');
  n := n + 1; r := pg_temp.sas_try('service_role', NULL, format('SELECT sg_send_begin(%L, %L, ''hi'', ''x'')::text', ga, u_fara));
  failed := failed || pg_temp.sas_ok(r = 'NULL', format('sg_send_begin stored another workspace''s admin''s send (%s)', r));

  -- ---------- (d) unchanged: a listed agent sends ----------
  n := n + 1; failed := failed || pg_temp.sas_ok(sg_can_send(ga, u_agent), 'a listed agent can no longer send');

  RAISE EXCEPTION USING ERRCODE = 'ZT333', MESSAGE = 'verify-sg-admin-send rollback';
  EXCEPTION WHEN SQLSTATE 'ZT333' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'submission group admin send verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'submission group admin send verification passed (% checks)', n;
END
$verify$;
