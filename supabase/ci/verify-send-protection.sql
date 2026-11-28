-- Behavioural regression suite for migration 334: the decision log is
-- append-only and readable by owners/admins only; a spend add past the
-- cap is refused and leaves the total unchanged, a refund gives it
-- back; only owners/admins set caps; recipient signals count opt-out,
-- marketing sends since the last inbound and 30-day failures.
--
-- ONE statement on purpose (`supabase db query --file` sends a single
-- prepared statement). Fixtures roll back via a sentinel exception; the
-- results survive in plpgsql variables. Fails without 334 (its
-- functions and tables do not exist).

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000334001';
  u_admin UUID := '00000000-0000-4000-8000-000000334002';
  u_agent UUID := '00000000-0000-4000-8000-000000334003';
  a_acct  UUID;
  c1      UUID;
  cv      UUID;
  ok      BOOLEAN;
  tot     BIGINT;
  d       DATE;
  r       TEXT;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sp_try(p_role text, p_uid uuid, p_sql text)
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
    CREATE FUNCTION pg_temp.sp_ok(p_ok boolean, p_msg text)
    RETURNS text[] LANGUAGE sql AS $body$
      SELECT CASE WHEN coalesce(p_ok, false) THEN '{}'::text[] ELSE ARRAY[p_msg] END
    $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'sp334-owner@example.invalid'), (u_admin, 'sp334-admin@example.invalid'),
    (u_agent, 'sp334-agent@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500334001', 'SP one')
    RETURNING id INTO c1;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_owner, c1) RETURNING id INTO cv;
  INSERT INTO message_templates (account_id, user_id, name, category, body_text) VALUES
    (a_acct, u_owner, 'sp334_promo', 'Marketing', 'promo'),
    (a_acct, u_owner, 'sp334_receipt', 'Utility', 'receipt');

  -- ---------- (a) decision log ----------
  PERFORM send_protection_decision_record(a_acct, NULL, 'sp334_promo', c1, 'MARKETING', 'DENY', 'SPEND_CAP', false);
  n := n + 1;
  failed := failed || pg_temp.sp_ok((SELECT count(*) FROM send_protection_decisions WHERE account_id = a_acct) = 1,
    'decision_record did not append one row');
  n := n + 1; r := pg_temp.sp_try('service_role', NULL,
    format('UPDATE send_protection_decisions SET reason = ''ALLOWED'' WHERE account_id = %L RETURNING reason', a_acct));
  failed := failed || pg_temp.sp_ok(r LIKE 'ERROR%', format('service_role updated a decision (%s)', r));
  n := n + 1;
  BEGIN
    DELETE FROM send_protection_decisions WHERE account_id = a_acct;
    failed := failed || ARRAY['a superuser deleted a decision'];
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  n := n + 1;
  BEGIN
    UPDATE send_protection_decisions SET reason = 'ALLOWED' WHERE account_id = a_acct;
    failed := failed || ARRAY['a superuser updated a decision'];
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  n := n + 1; r := pg_temp.sp_try('authenticated', u_admin,
    format('SELECT count(*)::text FROM send_protection_decisions WHERE account_id = %L', a_acct));
  failed := failed || pg_temp.sp_ok(r = '1', format('an admin cannot read the decision (%s)', r));
  n := n + 1; r := pg_temp.sp_try('authenticated', u_agent,
    format('SELECT count(*)::text FROM send_protection_decisions WHERE account_id = %L', a_acct));
  failed := failed || pg_temp.sp_ok(r = '0', format('an agent read a decision (%s)', r));
  n := n + 1; r := pg_temp.sp_try('authenticated', u_admin,
    format('SELECT send_protection_decision_record(%L, NULL, NULL, NULL, ''SESSION'', ''ALLOW'', ''SESSION_ALLOWED'', false)::text', a_acct));
  failed := failed || pg_temp.sp_ok(r LIKE 'ERROR%', format('a signed-in admin recorded a decision (%s)', r));

  -- ---------- (b) spend ledger ----------
  SELECT s.allowed, s.total_micros, s.day INTO ok, tot, d FROM send_protection_spend_add(a_acct, 'ai.daily', 700, 1000) s;
  n := n + 1; failed := failed || pg_temp.sp_ok(ok AND tot = 700, format('first add: %s %s', ok, tot));
  n := n + 1; failed := failed || pg_temp.sp_ok(d = (now() AT TIME ZONE 'UTC')::date, format('add returned day %s', d));
  SELECT s.allowed, s.total_micros INTO ok, tot FROM send_protection_spend_add(a_acct, 'ai.daily', 400, 1000) s;
  n := n + 1; failed := failed || pg_temp.sp_ok(NOT ok AND tot = 700, format('add past the cap: %s %s', ok, tot));
  SELECT amount_micros INTO tot FROM send_protection_spend
   WHERE account_id = a_acct AND scope = 'ai.daily' AND day = (now() AT TIME ZONE 'UTC')::date;
  n := n + 1; failed := failed || pg_temp.sp_ok(tot = 700, format('refused add changed the stored total to %s', tot));
  SELECT s.allowed, s.total_micros INTO ok, tot FROM send_protection_spend_add(a_acct, 'ai.daily', 300, 1000) s;
  n := n + 1; failed := failed || pg_temp.sp_ok(ok AND tot = 1000, format('add up to the cap: %s %s', ok, tot));
  tot := send_protection_spend_refund(a_acct, 'ai.daily', (now() AT TIME ZONE 'UTC')::date, 300);
  n := n + 1; failed := failed || pg_temp.sp_ok(tot = 700, format('refund returned %s', tot));
  SELECT amount_micros INTO tot FROM send_protection_spend
   WHERE account_id = a_acct AND scope = 'ai.daily' AND day = (now() AT TIME ZONE 'UTC')::date;
  n := n + 1; failed := failed || pg_temp.sp_ok(tot = 700, format('refund stored %s', tot));
  SELECT s.allowed, s.total_micros INTO ok, tot FROM send_protection_spend_add(a_acct, 'wa.marketing.daily', 5, NULL) s;
  n := n + 1; failed := failed || pg_temp.sp_ok(ok AND tot = 5, format('no-cap add: %s %s', ok, tot));
  n := n + 1; r := pg_temp.sp_try('authenticated', u_owner,
    format('SELECT (send_protection_spend_add(%L, ''ai.daily'', 1, NULL)).total_micros::text', a_acct));
  failed := failed || pg_temp.sp_ok(r LIKE 'ERROR%', format('a signed-in owner added spend (%s)', r));

  -- ---------- (c) caps ----------
  n := n + 1; r := pg_temp.sp_try('service_role', NULL,
    format('SELECT send_protection_set_caps(%L, %L, 100, 200)::text', u_agent, a_acct));
  failed := failed || pg_temp.sp_ok(r LIKE 'ERROR%NOT_ALLOWED%', format('an agent set caps (%s)', r));
  n := n + 1; r := pg_temp.sp_try('service_role', NULL,
    format('SELECT send_protection_set_caps(%L, %L, 100, 200)::text', u_admin, a_acct));
  failed := failed || pg_temp.sp_ok(r NOT LIKE 'ERROR%', format('an admin cannot set caps (%s)', r));
  n := n + 1; r := pg_temp.sp_try('service_role', NULL,
    format('SELECT daily_ai_spend_micros::text FROM send_protection_caps_get(%L)', a_acct));
  failed := failed || pg_temp.sp_ok(r = '200', format('caps_get read %s', r));
  n := n + 1; r := pg_temp.sp_try('authenticated', u_agent,
    format('SELECT count(*)::text FROM send_protection_caps WHERE account_id = %L', a_acct));
  failed := failed || pg_temp.sp_ok(r = '0', format('an agent read the caps (%s)', r));
  n := n + 1; r := pg_temp.sp_try('authenticated', u_admin,
    format('SELECT daily_marketing_spend_micros::text FROM send_protection_caps WHERE account_id = %L', a_acct));
  failed := failed || pg_temp.sp_ok(r = '100', format('an admin cannot read the caps (%s)', r));
  n := n + 1; r := pg_temp.sp_try('authenticated', u_admin,
    format('SELECT send_protection_set_caps(%L, %L, 1, 1)::text', u_admin, a_acct));
  failed := failed || pg_temp.sp_ok(r LIKE 'ERROR%', format('a signed-in admin called set_caps directly (%s)', r));

  -- ---------- (d) recipient signals ----------
  -- Before the inbound: one marketing send (not counted after the reply).
  INSERT INTO messages (conversation_id, sender_type, content_type, template_name, status, created_at)
  VALUES (cv, 'agent', 'template', 'sp334_promo', 'delivered', now() - interval '3 days');
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at)
  VALUES (cv, 'customer', 'hi', now() - interval '2 days');
  -- After it: two marketing (counted), one utility (not), one failed
  -- marketing (not a send; counts as a failure), one old failure (>30d).
  INSERT INTO messages (conversation_id, sender_type, content_type, template_name, status, created_at) VALUES
    (cv, 'agent', 'template', 'sp334_promo', 'delivered', now() - interval '1 day'),
    (cv, 'bot', 'template', 'sp334_promo', 'read', now() - interval '1 hour'),
    (cv, 'agent', 'template', 'sp334_receipt', 'delivered', now() - interval '1 hour'),
    (cv, 'agent', 'template', 'sp334_promo', 'failed', now() - interval '30 minutes'),
    (cv, 'agent', 'text', NULL, 'failed', now() - interval '40 days');
  n := n + 1; r := pg_temp.sp_try('service_role', NULL,
    format('SELECT row(opted_out, sent_without_reply, failed_deliveries)::text FROM send_protection_recipient_signals(%L, %L)', a_acct, c1));
  failed := failed || pg_temp.sp_ok(r = '(f,2,1)', format('signals before opt-out: %s', r));
  UPDATE contacts SET opted_out_at = now() WHERE id = c1;
  n := n + 1; r := pg_temp.sp_try('service_role', NULL,
    format('SELECT opted_out::text FROM send_protection_recipient_signals(%L, %L)', a_acct, c1));
  failed := failed || pg_temp.sp_ok(r = 'true', format('signals after opt-out: %s', r));
  n := n + 1; r := pg_temp.sp_try('authenticated', u_owner,
    format('SELECT opted_out::text FROM send_protection_recipient_signals(%L, %L)', a_acct, c1));
  failed := failed || pg_temp.sp_ok(r LIKE 'ERROR%', format('a signed-in owner read signals (%s)', r));

  RAISE EXCEPTION USING ERRCODE = 'ZT334', MESSAGE = 'verify-send-protection rollback';
  EXCEPTION WHEN SQLSTATE 'ZT334' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'send protection verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'send protection verification passed (% checks)', n;
END
$verify$;
