-- Behavioural regression suite for campaign reply classes (migration
-- 148): broadcast_recipients_reply_class_guard keeps reply_class /
-- reply_class_p / reply_classified_at service-role-only while an
-- admin's ordinary recipient inserts and status updates (the broadcast
-- wizard and detail page) still work, and the CHECKs refuse an unknown
-- class or an out-of-range probability.
--
-- ONE statement on purpose (the pinned CLI rejects several). Failing
-- assertions are named in the final exception; fixtures are undone by
-- a sentinel exception while the collected results survive.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000148001';
  u_admin UUID := '00000000-0000-4000-8000-000000148002';
  a_acct  UUID;
  bc      UUID;
  ct1     UUID;
  ct2     UUID;
  ct3     UUID;
  rc      UUID;
  r       TEXT;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (a signed-in user when p_uid is given):
  -- the value of a SELECT, the row count of anything else, or the error.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.rc_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; c bigint;
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
          GET DIAGNOSTICS c = ROW_COUNT;
          v := c::text;
        END IF;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(v, 'null');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;

  -- As the table owner: 'ok' or the SQLSTATE + error.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.rc_do(p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    BEGIN
      EXECUTE p_sql;
      RETURN 'ok';
    EXCEPTION WHEN OTHERS THEN
      RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
    END $body$
  $fn$;

  -- Fixture: one account (owner, admin), a broadcast, three contacts.
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'rc-owner@example.invalid'),
    (u_admin, 'rc-admin@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;

  INSERT INTO broadcasts (account_id, user_id, name, template_name)
  VALUES (a_acct, u_owner, 'RC bc', 'hello') RETURNING id INTO bc;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_owner, '971500148001', 'RC one') RETURNING id INTO ct1;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_owner, '971500148002', 'RC two') RETURNING id INTO ct2;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_owner, '971500148003', 'RC three') RETURNING id INTO ct3;

  -- ---------- 1. an admin cannot set the classes ----------
  r := pg_temp.rc_try('authenticated', u_admin, format(
         'INSERT INTO broadcast_recipients (broadcast_id, contact_id, reply_class) VALUES (%L, %L, ''interested'')',
         bc, ct1));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('an admin inserted a recipient with a reply_class (want 42501): ' || r)::text);
  END IF;

  r := pg_temp.rc_try('authenticated', u_admin, format(
         'INSERT INTO broadcast_recipients (broadcast_id, contact_id, reply_classified_at) VALUES (%L, %L, now())',
         bc, ct1));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('an admin inserted a recipient with reply_classified_at (want 42501): ' || r)::text);
  END IF;

  -- ---------- 2. an admin's ordinary writes still work ----------
  r := pg_temp.rc_try('authenticated', u_admin, format(
         'INSERT INTO broadcast_recipients (broadcast_id, contact_id) VALUES (%L, %L)', bc, ct1));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('an admin''s ordinary recipient insert failed: ' || r)::text);
  END IF;
  SELECT id INTO rc FROM broadcast_recipients WHERE broadcast_id = bc AND contact_id = ct1;

  r := pg_temp.rc_try('authenticated', u_admin, format(
         'UPDATE broadcast_recipients SET status = ''sent'', sent_at = now() WHERE id = %L', rc));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('an admin''s status update failed: ' || r)::text);
  END IF;

  r := pg_temp.rc_try('authenticated', u_admin, format(
         'UPDATE broadcast_recipients SET reply_class = ''interested'' WHERE id = %L', rc));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('an admin set reply_class by UPDATE (want 42501): ' || r)::text);
  END IF;

  r := pg_temp.rc_try('authenticated', u_admin, format(
         'UPDATE broadcast_recipients SET reply_class_p = 0.5 WHERE id = %L', rc));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('an admin set reply_class_p by UPDATE (want 42501): ' || r)::text);
  END IF;

  -- ---------- 3. the service role sets them ----------
  r := pg_temp.rc_try('service_role', NULL, format(
         'UPDATE broadcast_recipients SET reply_class = ''interested'', reply_class_p = 0.91, reply_classified_at = now() WHERE id = %L',
         rc));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('the service role could not classify a reply: ' || r)::text);
  END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM broadcast_recipients
                 WHERE id = rc AND reply_class = 'interested'
                   AND reply_class_p BETWEEN 0.9 AND 0.92
                   AND reply_classified_at IS NOT NULL) THEN
    failed := array_append(failed, 'the service role''s classification did not land'::text);
  END IF;

  r := pg_temp.rc_try('service_role', NULL, format(
         'INSERT INTO broadcast_recipients (broadcast_id, contact_id, reply_class, reply_class_p, reply_classified_at) VALUES (%L, %L, ''stop'', 0.99, now())',
         bc, ct2));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('the service role could not insert a classified recipient: ' || r)::text);
  END IF;

  -- Once classified, an admin's ordinary update still works, and an
  -- admin cannot clear or change the class.
  r := pg_temp.rc_try('authenticated', u_admin, format(
         'UPDATE broadcast_recipients SET status = ''replied'', replied_at = now() WHERE id = %L', rc));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('an admin''s status update on a classified row failed: ' || r)::text);
  END IF;

  r := pg_temp.rc_try('authenticated', u_admin, format(
         'UPDATE broadcast_recipients SET reply_class = NULL WHERE id = %L', rc));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('an admin cleared reply_class (want 42501): ' || r)::text);
  END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM broadcast_recipients WHERE id = rc AND reply_class = 'interested') THEN
    failed := array_append(failed, 'reply_class changed after a refused admin write'::text);
  END IF;

  -- ---------- 4. the CHECKs ----------
  r := pg_temp.rc_do(format(
         'INSERT INTO broadcast_recipients (broadcast_id, contact_id, reply_class) VALUES (%L, %L, ''maybe'')',
         bc, ct3));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514%' THEN
    failed := array_append(failed, ('an unknown reply_class was accepted (want 23514): ' || r)::text);
  END IF;

  r := pg_temp.rc_do(format(
         'INSERT INTO broadcast_recipients (broadcast_id, contact_id, reply_class, reply_class_p) VALUES (%L, %L, ''other'', 1.5)',
         bc, ct3));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514%' THEN
    failed := array_append(failed, ('a reply_class_p above 1 was accepted (want 23514): ' || r)::text);
  END IF;

  n := n + 1;
  IF has_function_privilege('authenticated', 'public.broadcast_recipients_reply_class_guard()', 'EXECUTE') THEN
    failed := array_append(failed, 'clients may execute the guard function'::text);
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZT148', MESSAGE = 'verify-campaign-reply-classes rollback';
  EXCEPTION WHEN SQLSTATE 'ZT148' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'campaign reply classes verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'campaign reply classes verification passed (% checks)', n;
END
$verify$;
