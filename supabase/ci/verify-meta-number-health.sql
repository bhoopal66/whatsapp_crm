-- Behavioural regression suite for migration 188: Meta number health,
-- watch-only. Event dedup and the append-only rule (with the foreign-key
-- exemption that keeps disconnecting a number and deleting an account
-- working); the number state's compare-and-set (a stale write is
-- refused); template health (forward-only, a missing field kept);
-- settings (enforce off by default, owner-only enforce, owner/admin
-- cap); the marketing ramp count and spend per won case over the 051
-- ledger; RLS (owners/admins of the account only); privileges (no
-- client executes a service function or writes a table).
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The fixtures are
-- rolled back by a sentinel exception; the results survive in plpgsql
-- variables.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000188001';
  u_admin  UUID := '00000000-0000-4000-8000-000000188002';
  u_agent  UUID := '00000000-0000-4000-8000-000000188003';
  u_far    UUID := '00000000-0000-4000-8000-000000188004'; -- owner of another account
  u_gone   UUID := '00000000-0000-4000-8000-000000188005'; -- deactivated owner
  d        DATE := DATE '2026-03-10';
  t0       TIMESTAMPTZ := TIMESTAMPTZ '2026-03-10 12:00:00+00';
  sigs     TEXT[] := ARRAY[
    'public.meta_health_event_record(uuid,uuid,text,text,jsonb)',
    'public.meta_number_state_set(uuid,timestamptz,text,text,text,text,jsonb)',
    'public.meta_template_health_set(uuid,text,text,text,text,timestamptz,timestamptz)',
    'public.meta_protection_settings_get(uuid)',
    'public.meta_protection_set_enforce(uuid,uuid,boolean)',
    'public.meta_protection_set_marketing_cap(uuid,uuid,integer)',
    'public.meta_marketing_sent_today(uuid,date)',
    'public.meta_cost_per_won_case(uuid,timestamptz,timestamptz)'];
  helpers  TEXT[] := ARRAY[
    'public.meta_health_config_account(uuid)',
    'public.meta_protection_actor_role(uuid,uuid)',
    'public.meta_health_events_append_only()'];
  tabs     TEXT[] := ARRAY['meta_health_events', 'meta_number_state', 'meta_template_health',
                           'meta_protection_settings'];
  a_acct   UUID;
  b_acct   UUID;
  c_acct   UUID;
  wm       UUID;
  ww       UUID;
  wb       UUID;
  wc       UUID;
  c1       UUID;
  c2       UUID;
  cv1      UUID;
  cv2      UUID;
  t1       TIMESTAMPTZ;
  t2       TIMESTAMPTZ;
  t3       TIMESTAMPTZ;
  st       RECORD;
  j        JSONB;
  s        TEXT;
  r        TEXT;
  b        BOOLEAN;
  i        INT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a SELECT as p_role (NULL: as the current user) signed in as
  -- p_uid: its value, or 'ERROR <sqlstate> [<hint>]: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.mnh_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; h text;
    BEGIN
      BEGIN
        IF p_role IS NOT NULL THEN
          PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
          PERFORM set_config('request.jwt.claims',
            json_build_object('sub', p_uid, 'role', p_role)::text, true);
          EXECUTE format('SET LOCAL ROLE %I', p_role);
        END IF;
        EXECUTE p_sql INTO v;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(v, 'NULL');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ' [' || coalesce(h, '') || ']: ' || SQLERRM;
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.mnh_ok(p_ok boolean, p_msg text)
    RETURNS text[] LANGUAGE sql AS $body$
      SELECT CASE WHEN coalesce(p_ok, false) THEN '{}'::text[] ELSE ARRAY[p_msg] END
    $body$
  $fn$;
  -- How many rows of p_table of p_acct the signed-in person's RLS shows.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.mnh_sees(p_uid uuid, p_table text, p_acct uuid)
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.mnh_try('authenticated', p_uid, format(
        'SELECT count(*)::text FROM public.%I WHERE account_id = %L', p_table, p_acct))
    $body$
  $fn$;
  -- A ledger receipt, written directly (051's costing is not under test).
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.mnh_receipt(p_acct uuid, p_pn text, p_msg text, p_to text, p_status text,
                                        p_cat text, p_at timestamptz, p_cost numeric)
    RETURNS void LANGUAGE sql AS $body$
      INSERT INTO public.whatsapp_message_costs (account_id, phone_number_id, message_id, status,
        recipient_wa_id, recipient_market, category, billable, cost_usd, raw_status, delivered_at,
        billing_month)
      VALUES (p_acct, p_pn, p_msg, p_status, p_to, 'AE', p_cat,
              p_status = 'delivered' AND p_cost IS DISTINCT FROM 0,
              CASE WHEN p_status = 'delivered' THEN p_cost ELSE 0 END,
              jsonb_build_object('id', p_msg, 'status', p_status,
                                 'timestamp', extract(epoch FROM p_at)::bigint::text),
              CASE WHEN p_status = 'delivered' THEN p_at END,
              CASE WHEN p_status = 'delivered' THEN date_trunc('month', p_at)::date END)
    $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'mnh-owner@example.invalid'), (u_admin, 'mnh-admin@example.invalid'),
    (u_agent, 'mnh-agent@example.invalid'), (u_far, 'mnh-far@example.invalid'),
    (u_gone, 'mnh-gone@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_far;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision two accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent;
  UPDATE profiles SET account_id = a_acct, account_role = 'owner', deactivated_at = now() WHERE user_id = u_gone;

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'meta', 'MNH-188-A', 'x', 'connected', true) RETURNING id INTO wm;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_admin, a_acct, 'whapi', 'MNH-188-W', 'x', 'connected', false) RETURNING id INTO ww;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_far, b_acct, 'meta', 'MNH-188-B', 'x', 'connected', true) RETURNING id INTO wb;

  -- ---------- (a) events: dedup, refusals, append-only ----------
  b := meta_health_event_record(a_acct, wm, 'phone_number_quality_update', 'k1',
                                '{"current_limit": "TIER_1K", "event": "FLAGGED"}'::jsonb);
  n := n + 1; failed := failed || pg_temp.mnh_ok(b, 'the first event was not recorded');
  b := meta_health_event_record(a_acct, wm, 'phone_number_quality_update', 'k1', '{"again": true}'::jsonb);
  n := n + 1; failed := failed || pg_temp.mnh_ok(NOT b
    AND (SELECT count(*) FROM meta_health_events WHERE account_id = a_acct) = 1
    AND (SELECT payload->>'event' FROM meta_health_events WHERE account_id = a_acct) = 'FLAGGED',
    'a repeated dedup key was recorded or changed the first event');
  b := meta_health_event_record(a_acct, wm, 'account_update', 'k2', '{}'::jsonb);
  n := n + 1; failed := failed || pg_temp.mnh_ok(b, 'a second key was not recorded');
  b := meta_health_event_record(a_acct, wm, 'account_review_update', 'kr', '{}'::jsonb);
  n := n + 1; failed := failed || pg_temp.mnh_ok(b, 'an account_review_update event was not recorded');
  b := meta_health_event_record(b_acct, wb, 'message_template_status_update', 'k1', '{}'::jsonb);
  n := n + 1; failed := failed || pg_temp.mnh_ok(b, 'the same key in another account was treated as a repeat');
  r := pg_temp.mnh_try(NULL, NULL, format(
    'SELECT public.meta_health_event_record(%L, %L, ''account_update'', ''k9'', ''{}'')', a_acct, ww));
  n := n + 1; failed := failed || pg_temp.mnh_ok(r LIKE 'ERROR % [CONFIG_INVALID]%',
    format('an event on a Whapi number was not refused (%s)', r));
  r := pg_temp.mnh_try(NULL, NULL, format(
    'SELECT public.meta_health_event_record(%L, %L, ''account_update'', ''k9'', ''{}'')', a_acct, wb));
  n := n + 1; failed := failed || pg_temp.mnh_ok(r LIKE 'ERROR % [CONFIG_INVALID]%',
    format('an event on another account''s number was not refused (%s)', r));
  r := pg_temp.mnh_try(NULL, NULL, format(
    'SELECT public.meta_health_event_record(%L, %L, ''message_status'', ''k9'', ''{}'')', a_acct, wm));
  n := n + 1; failed := failed || pg_temp.mnh_ok(r LIKE 'ERROR 23514%',
    format('an unknown kind was not refused (%s)', r));
  r := pg_temp.mnh_try(NULL, NULL, format(
    'WITH x AS (UPDATE public.meta_health_events SET payload = ''{}'' WHERE account_id = %L RETURNING 1) SELECT count(*)::text FROM x', a_acct));
  n := n + 1; failed := failed || pg_temp.mnh_ok(r LIKE 'ERROR % [APPEND_ONLY]%',
    format('an event could be updated (%s)', r));
  r := pg_temp.mnh_try(NULL, NULL, format(
    'WITH x AS (DELETE FROM public.meta_health_events WHERE account_id = %L RETURNING 1) SELECT count(*)::text FROM x', a_acct));
  n := n + 1; failed := failed || pg_temp.mnh_ok(r LIKE 'ERROR % [APPEND_ONLY]%',
    format('an event could be deleted (%s)', r));

  -- ---------- (b) number state: compare-and-set ----------
  t1 := meta_number_state_set(wm, NULL, 'GREEN', 'TIER_1K', 'CONNECTED', 'NORMAL', '[]'::jsonb);
  n := n + 1; failed := failed || pg_temp.mnh_ok(t1 IS NOT NULL
    AND (SELECT account_id FROM meta_number_state WHERE config_id = wm) = a_acct,
    'the first state write (expecting no row) failed');
  t2 := meta_number_state_set(wm, NULL, 'RED', 'TIER_1K', 'CONNECTED', 'MARKETING_PAUSED', '["QUALITY_RED"]'::jsonb);
  n := n + 1; failed := failed || pg_temp.mnh_ok(t2 IS NULL
    AND (SELECT quality_rating FROM meta_number_state WHERE config_id = wm) = 'GREEN',
    'a write expecting no row overwrote an existing row');
  t2 := meta_number_state_set(wm, t1, 'YELLOW', 'TIER_1K', 'CONNECTED', 'THROTTLED', '["QUALITY_YELLOW"]'::jsonb);
  n := n + 1; failed := failed || pg_temp.mnh_ok(t2 IS NOT NULL AND t2 > t1
    AND (SELECT assessed_state FROM meta_number_state WHERE config_id = wm) = 'THROTTLED',
    'a write with the current updated_at failed');
  t3 := meta_number_state_set(wm, t1, 'RED', 'TIER_1K', 'CONNECTED', 'MARKETING_PAUSED', '["QUALITY_RED"]'::jsonb);
  SELECT * INTO st FROM meta_number_state WHERE config_id = wm;
  n := n + 1; failed := failed || pg_temp.mnh_ok(t3 IS NULL AND st.quality_rating = 'YELLOW'
    AND st.assessed_state = 'THROTTLED' AND st.updated_at = t2,
    format('a stale write was not refused (%s, %s)', t3, st.quality_rating));
  t3 := meta_number_state_set(wm, t2, 'YELLOW', 'TIER_1K', 'CONNECTED', 'THROTTLED', '["QUALITY_YELLOW"]'::jsonb);
  n := n + 1; failed := failed || pg_temp.mnh_ok(t3 > t2,
    'a same-transaction rewrite did not move updated_at forward');
  r := pg_temp.mnh_try(NULL, NULL, format(
    'SELECT public.meta_number_state_set(%L, NULL, ''GREEN'', NULL, NULL, ''NORMAL'', ''[]'')::text', ww));
  n := n + 1; failed := failed || pg_temp.mnh_ok(r LIKE 'ERROR % [CONFIG_INVALID]%',
    format('a state for a Whapi number was not refused (%s)', r));
  r := pg_temp.mnh_try(NULL, NULL, format(
    'SELECT public.meta_number_state_set(%L, %L, ''GREEN'', NULL, NULL, ''BLOCKED'', ''[]'')::text', wm, t3));
  n := n + 1; failed := failed || pg_temp.mnh_ok(r LIKE 'ERROR 23514%',
    format('an unknown assessed state was not refused (%s)', r));
  PERFORM meta_number_state_set(wb, NULL, NULL, NULL, NULL, NULL, NULL);
  n := n + 1; failed := failed || pg_temp.mnh_ok(
    (SELECT assessed_state = 'NORMAL' AND reasons = '[]'::jsonb FROM meta_number_state WHERE config_id = wb),
    'a state with no assessment did not default to NORMAL');

  -- ---------- (c) template health ----------
  b := meta_template_health_set(a_acct, 'promo', 'en', 'GREEN', NULL, NULL, t0);
  n := n + 1; failed := failed || pg_temp.mnh_ok(b, 'the first template quality was not recorded');
  b := meta_template_health_set(a_acct, 'promo', 'en', NULL, 'PAUSED', t0 + interval '3 hours', t0 + interval '1 minute');
  n := n + 1; failed := failed || pg_temp.mnh_ok(b AND (SELECT quality = 'GREEN' AND status = 'PAUSED'
      AND paused_until = t0 + interval '3 hours' FROM meta_template_health
     WHERE account_id = a_acct AND template_name = 'promo' AND language = 'en'),
    'a status update dropped the quality or the pause');
  b := meta_template_health_set(a_acct, 'promo', 'en', 'RED', NULL, NULL, t0 - interval '1 hour');
  n := n + 1; failed := failed || pg_temp.mnh_ok(NOT b AND (SELECT quality FROM meta_template_health
     WHERE account_id = a_acct AND template_name = 'promo' AND language = 'en') = 'GREEN',
    'an older event overwrote a newer one');
  b := meta_template_health_set(a_acct, 'promo', 'en', NULL, 'APPROVED', NULL, t0 + interval '2 minutes');
  n := n + 1; failed := failed || pg_temp.mnh_ok(b AND (SELECT status = 'APPROVED' AND paused_until IS NULL
      FROM meta_template_health WHERE account_id = a_acct AND template_name = 'promo' AND language = 'en'),
    'a later status did not clear the pause');
  -- Quality and status each move forward on their own time: Meta does not
  -- order them. State: quality GREEN @t0, status APPROVED @t0+2m.
  b := meta_template_health_set(a_acct, 'promo', 'en', 'YELLOW', NULL, NULL, t0 + interval '10 minutes');
  b := meta_template_health_set(a_acct, 'promo', 'en', NULL, 'PAUSED', t0 + interval '4 hours', t0 + interval '5 minutes');
  n := n + 1; failed := failed || pg_temp.mnh_ok(b AND (SELECT quality = 'YELLOW' AND status = 'PAUSED'
      AND paused_until = t0 + interval '4 hours' AND updated_at = t0 + interval '10 minutes'
      FROM meta_template_health WHERE account_id = a_acct AND template_name = 'promo' AND language = 'en'),
    'an older status after a newer quality was refused (the pause was lost)');
  b := meta_template_health_set(a_acct, 'promo', 'en', NULL, 'APPROVED', NULL, t0 + interval '20 minutes');
  b := meta_template_health_set(a_acct, 'promo', 'en', 'RED', NULL, NULL, t0 + interval '15 minutes');
  n := n + 1; failed := failed || pg_temp.mnh_ok(b AND (SELECT quality = 'RED' AND status = 'APPROVED'
      AND paused_until IS NULL AND updated_at = t0 + interval '20 minutes'
      FROM meta_template_health WHERE account_id = a_acct AND template_name = 'promo' AND language = 'en'),
    'an older quality after a newer status was refused, or moved the status');
  b := meta_template_health_set(a_acct, 'promo', 'en', NULL, 'PAUSED', t0 + interval '5 hours', t0 + interval '18 minutes');
  n := n + 1; failed := failed || pg_temp.mnh_ok(NOT b AND (SELECT quality = 'RED' AND status = 'APPROVED'
      AND paused_until IS NULL AND status_at = t0 + interval '20 minutes'
      FROM meta_template_health WHERE account_id = a_acct AND template_name = 'promo' AND language = 'en'),
    'an older status after a newer status was applied');

  -- ---------- (d) settings ----------
  SELECT * INTO st FROM meta_protection_settings_get(a_acct);
  n := n + 1; failed := failed || pg_temp.mnh_ok(st.enforce IS FALSE AND st.daily_marketing_cap IS NULL,
    'with no row the settings did not read as enforce off, no cap');
  r := pg_temp.mnh_try(NULL, NULL, format('SELECT public.meta_protection_set_enforce(%L, %L, true)::text', u_admin, a_acct));
  n := n + 1; failed := failed || pg_temp.mnh_ok(r LIKE 'ERROR 42501 [NOT_ALLOWED]%',
    format('an admin could switch enforcement on (%s)', r));
  r := pg_temp.mnh_try(NULL, NULL, format('SELECT public.meta_protection_set_enforce(%L, %L, true)::text', u_gone, a_acct));
  n := n + 1; failed := failed || pg_temp.mnh_ok(r LIKE 'ERROR 42501 [NOT_ALLOWED]%',
    format('a deactivated owner could switch enforcement on (%s)', r));
  r := pg_temp.mnh_try(NULL, NULL, format('SELECT public.meta_protection_set_enforce(%L, %L, true)::text', u_far, a_acct));
  n := n + 1; failed := failed || pg_temp.mnh_ok(r LIKE 'ERROR 42501 [NOT_ALLOWED]%',
    format('another account''s owner could switch enforcement on (%s)', r));
  r := pg_temp.mnh_try(NULL, NULL, format('SELECT public.meta_protection_set_marketing_cap(%L, %L, 50)::text', u_agent, a_acct));
  n := n + 1; failed := failed || pg_temp.mnh_ok(r LIKE 'ERROR 42501 [NOT_ALLOWED]%',
    format('an agent could set the marketing cap (%s)', r));
  i := meta_protection_set_marketing_cap(u_admin, a_acct, 150);
  SELECT * INTO st FROM meta_protection_settings_get(a_acct);
  n := n + 1; failed := failed || pg_temp.mnh_ok(i = 150 AND st.daily_marketing_cap = 150
    AND st.enforce IS FALSE AND st.updated_by = u_admin,
    'an admin''s cap was not stored, or the new row did not keep enforce off');
  r := pg_temp.mnh_try(NULL, NULL, format('SELECT public.meta_protection_set_marketing_cap(%L, %L, -1)::text', u_admin, a_acct));
  n := n + 1; failed := failed || pg_temp.mnh_ok(r LIKE 'ERROR % [SETTING_INVALID]%',
    format('a negative cap was not refused (%s)', r));
  b := meta_protection_set_enforce(u_owner, a_acct, true);
  SELECT * INTO st FROM meta_protection_settings_get(a_acct);
  n := n + 1; failed := failed || pg_temp.mnh_ok(b AND st.enforce AND st.daily_marketing_cap = 150
    AND st.updated_by = u_owner, 'the owner could not switch enforcement on, or it dropped the cap');
  i := meta_protection_set_marketing_cap(u_owner, a_acct, NULL);
  SELECT * INTO st FROM meta_protection_settings_get(a_acct);
  n := n + 1; failed := failed || pg_temp.mnh_ok(st.daily_marketing_cap IS NULL AND st.enforce,
    'clearing the cap failed or touched enforce');
  n := n + 1; failed := failed || pg_temp.mnh_ok(
    (SELECT column_default FROM information_schema.columns WHERE table_schema = 'public'
        AND table_name = 'meta_protection_settings' AND column_name = 'enforce') = 'false',
    'meta_protection_settings.enforce does not default to false');

  -- ---------- (e) RLS ----------
  FOREACH s IN ARRAY tabs LOOP
    r := pg_temp.mnh_sees(u_owner, s, a_acct) || '/' || pg_temp.mnh_sees(u_admin, s, a_acct)
      || '/' || pg_temp.mnh_sees(u_agent, s, a_acct) || '/' || pg_temp.mnh_sees(u_far, s, a_acct)
      || '/' || pg_temp.mnh_sees(u_gone, s, a_acct);
    n := n + 1; failed := failed || pg_temp.mnh_ok(r ~ '^([1-9][0-9]*)/\1/0/0/0$',
      format('%s: owner/admin/agent/other owner/deactivated owner see %s', s, r));
  END LOOP;
  r := pg_temp.mnh_sees(u_far, 'meta_health_events', b_acct);
  n := n + 1; failed := failed || pg_temp.mnh_ok(r = '1', format('the other owner does not see their own event (%s)', r));
  r := pg_temp.mnh_try('anon', NULL, 'SELECT count(*)::text FROM public.meta_number_state');
  n := n + 1; failed := failed || pg_temp.mnh_ok(r LIKE 'ERROR 42501%', format('anon could read the number state (%s)', r));

  -- ---------- (f) privileges ----------
  FOREACH s IN ARRAY sigs LOOP
    n := n + 1; failed := failed || pg_temp.mnh_ok(NOT has_function_privilege('anon', s, 'EXECUTE')
      AND NOT has_function_privilege('authenticated', s, 'EXECUTE')
      AND has_function_privilege('service_role', s, 'EXECUTE'),
      format('%s is not service-role only', s));
  END LOOP;
  FOREACH s IN ARRAY helpers LOOP
    n := n + 1; failed := failed || pg_temp.mnh_ok(NOT has_function_privilege('anon', s, 'EXECUTE')
      AND NOT has_function_privilege('authenticated', s, 'EXECUTE')
      AND NOT has_function_privilege('service_role', s, 'EXECUTE'),
      format('%s is executable by a client or the service role', s));
  END LOOP;
  FOREACH s IN ARRAY tabs LOOP
    n := n + 1; failed := failed || pg_temp.mnh_ok(
      NOT has_table_privilege('authenticated', 'public.' || s, 'INSERT, UPDATE, DELETE, TRUNCATE')
      AND NOT has_table_privilege('service_role', 'public.' || s, 'INSERT, UPDATE, DELETE, TRUNCATE')
      AND NOT has_table_privilege('anon', 'public.' || s, 'SELECT, INSERT, UPDATE, DELETE')
      AND has_table_privilege('service_role', 'public.' || s, 'SELECT'),
      format('%s: a client role or the service role can write it, or the service role cannot read it', s));
    n := n + 1; failed := failed || pg_temp.mnh_ok(
      (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = ('public.' || s)::regclass),
      format('%s: RLS is not forced', s));
  END LOOP;
  r := pg_temp.mnh_try('authenticated', u_owner, format(
    'SELECT public.meta_protection_set_enforce(%L, %L, true)::text', u_owner, a_acct));
  n := n + 1; failed := failed || pg_temp.mnh_ok(r LIKE 'ERROR 42501%',
    format('a signed-in owner could call the setter directly (%s)', r));
  r := pg_temp.mnh_try('authenticated', u_owner, format(
    'SELECT public.meta_health_event_record(%L, %L, ''account_update'', ''k8'', ''{}'')::text', a_acct, wm));
  n := n + 1; failed := failed || pg_temp.mnh_ok(r LIKE 'ERROR 42501%',
    format('a signed-in owner could record an event (%s)', r));
  r := pg_temp.mnh_try('service_role', NULL, format(
    'SELECT public.meta_health_event_record(%L, %L, ''account_update'', ''k3'', ''{}'')::text', a_acct, wm));
  n := n + 1; failed := failed || pg_temp.mnh_ok(r = 'true',
    format('the service role could not record an event (%s)', r));
  r := pg_temp.mnh_try('service_role', NULL, format(
    'WITH x AS (INSERT INTO public.meta_health_events (account_id, config_id, kind, dedup_key) VALUES (%L, %L, ''account_update'', ''k4'') RETURNING 1) SELECT count(*)::text FROM x', a_acct, wm));
  n := n + 1; failed := failed || pg_temp.mnh_ok(r LIKE 'ERROR 42501%',
    format('the service role could insert an event directly (%s)', r));

  -- ---------- (g) the marketing ramp count ----------
  -- m1: marketing sent on d, read the next day (counts on d only).
  PERFORM pg_temp.mnh_receipt(a_acct, 'MNH-188-A', 'm1', '971500188001', 'sent', 'marketing', t0, NULL);
  PERFORM pg_temp.mnh_receipt(a_acct, 'MNH-188-A', 'm1', '971500188001', 'read', 'marketing', t0 + interval '1 day', NULL);
  -- m2: sent just before d, delivered on d (counts the day before).
  PERFORM pg_temp.mnh_receipt(a_acct, 'MNH-188-A', 'm2', '971500188002', 'sent', 'marketing', TIMESTAMPTZ '2026-03-09 23:59:00+00', NULL);
  PERFORM pg_temp.mnh_receipt(a_acct, 'MNH-188-A', 'm2', '971500188002', 'delivered', 'marketing', TIMESTAMPTZ '2026-03-10 00:01:00+00', 0.01);
  -- m3: utility; m4: marketing that failed; m6: marketing on the other account's number.
  PERFORM pg_temp.mnh_receipt(a_acct, 'MNH-188-A', 'm3', '971500188003', 'sent', 'utility', t0, NULL);
  PERFORM pg_temp.mnh_receipt(a_acct, 'MNH-188-A', 'm4', '971500188004', 'failed', 'marketing', t0, NULL);
  PERFORM pg_temp.mnh_receipt(b_acct, 'MNH-188-B', 'm6', '971500188006', 'sent', 'marketing', t0, NULL);
  -- m5: one marketing message to two recipients (a group send): two sends.
  PERFORM pg_temp.mnh_receipt(a_acct, 'MNH-188-A', 'm5', '971500188005', 'delivered', 'marketing', t0, 0.02);
  PERFORM pg_temp.mnh_receipt(a_acct, 'MNH-188-A', 'm5', '971500188007', 'delivered', 'marketing', t0, 0.02);
  -- m7: the delivered receipt carries no pricing ('service' by default);
  -- the sent receipt is marketing.
  PERFORM pg_temp.mnh_receipt(a_acct, 'MNH-188-A', 'm7', '971500188008', 'sent', 'marketing', t0, NULL);
  PERFORM pg_temp.mnh_receipt(a_acct, 'MNH-188-A', 'm7', '971500188008', 'delivered', 'service', t0, 0);
  r := meta_marketing_sent_today(wm, d)::text || '/' || meta_marketing_sent_today(wm, d - 1)::text
    || '/' || meta_marketing_sent_today(wm, d + 1)::text || '/' || meta_marketing_sent_today(wb, d)::text;
  n := n + 1; failed := failed || pg_temp.mnh_ok(r = '4/1/0/1',
    format('marketing sent on d / d-1 / d+1 / other number is %s, expected 4/1/0/1', r));
  r := pg_temp.mnh_try(NULL, NULL, format('SELECT public.meta_marketing_sent_today(%L, %L)::text', ww, d));
  n := n + 1; failed := failed || pg_temp.mnh_ok(r LIKE 'ERROR % [CONFIG_INVALID]%',
    format('the ramp count on a Whapi number was not refused (%s)', r));

  -- ---------- (h) spend per won case ----------
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500188101', 'MNH won')
    RETURNING id INTO c1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500188102', 'MNH other')
    RETURNING id INTO c2;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_owner, c1) RETURNING id INTO cv1;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_owner, c2) RETURNING id INTO cv2;
  INSERT INTO messages (conversation_id, sender_type, content_type, message_id) VALUES
    (cv1, 'bot', 'template', 'w-won-before'), (cv1, 'bot', 'template', 'w-won-after'),
    (cv2, 'bot', 'template', 'w-other'), (cv2, 'bot', 'template', 'w-unknown');
  INSERT INTO cases (account_id, group_id, agent_id, stage, outcome, closed_at, contact_id)
  VALUES (a_acct, NULL, u_owner, 'Closed', 'Approved', t0, c1),
         (a_acct, NULL, u_owner, 'Closed', 'Declined', t0, c2);
  -- Before the window but before the win: the won case's.
  PERFORM pg_temp.mnh_receipt(a_acct, 'MNH-188-A', 'w-won-before', '971500188101', 'delivered', 'marketing', t0 - interval '10 days', 0.05);
  -- After the win, in the window: someone else's.
  PERFORM pg_temp.mnh_receipt(a_acct, 'MNH-188-A', 'w-won-after', '971500188101', 'delivered', 'utility', t0 + interval '1 hour', 0.07);
  PERFORM pg_temp.mnh_receipt(a_acct, 'MNH-188-A', 'w-other', '971500188102', 'delivered', 'marketing', t0, 0.03);
  PERFORM pg_temp.mnh_receipt(a_acct, 'MNH-188-A', 'w-unknown', '971500188102', 'delivered', 'marketing', t0, NULL);
  -- No messages row (a group message): unlinked, someone else's.
  PERFORM pg_temp.mnh_receipt(a_acct, 'MNH-188-A', 'w-unlinked', '971500188103', 'delivered', 'marketing', t0, 0.01);
  -- Outside the window and not the won customer's: not counted.
  PERFORM pg_temp.mnh_receipt(a_acct, 'MNH-188-A', 'w-old', '971500188102', 'delivered', 'marketing', t0 - interval '20 days', 0.50);
  -- d's earlier receipts (m2 0.01, m5 2 x 0.02) are in the window and someone else's.
  j := meta_cost_per_won_case(a_acct, t0 - interval '1 day', t0 + interval '1 day');
  n := n + 1; failed := failed || pg_temp.mnh_ok((j->>'won_cases')::int = 1
    AND (j->>'won_spend_usd')::numeric = 0.05 AND (j->>'cost_per_won_case_usd')::numeric = 0.05
    AND j->'other_spend_usd' = 'null'::jsonb
    AND (j->>'unknown_cost_messages')::int = 1,
    format('spend per won case is %s', j));
  j := meta_cost_per_won_case(b_acct, t0 - interval '1 day', t0 + interval '1 day');
  n := n + 1; failed := failed || pg_temp.mnh_ok((j->>'won_cases')::int = 0
    AND j->'cost_per_won_case_usd' = 'null'::jsonb AND (j->>'won_spend_usd')::numeric = 0,
    format('an account with no won case reads %s', j));
  -- A won customer's message with no rate on file: the won spend and the
  -- cost per case are unknown (NULL), never an understated sum.
  INSERT INTO messages (conversation_id, sender_type, content_type, message_id) VALUES
    (cv1, 'bot', 'template', 'w-won-unknown');
  PERFORM pg_temp.mnh_receipt(a_acct, 'MNH-188-A', 'w-won-unknown', '971500188101', 'delivered', 'marketing', t0 - interval '2 days', NULL);
  j := meta_cost_per_won_case(a_acct, t0 - interval '1 day', t0 + interval '1 day');
  n := n + 1; failed := failed || pg_temp.mnh_ok((j->>'won_cases')::int = 1
    AND j->'won_spend_usd' = 'null'::jsonb AND j->'cost_per_won_case_usd' = 'null'::jsonb
    AND j->'other_spend_usd' = 'null'::jsonb
    AND (j->>'unknown_cost_messages')::int = 2,
    format('an unknown rate on a won customer reads %s', j));
  -- 189: other spend follows the same rule. w-unknown (someone else's,
  -- in the window, no rate) makes it NULL above, never the 0.16 the
  -- known rates add up to; a window holding only known rates (w-old)
  -- gives their sum, and one with no other message at all gives 0.
  j := meta_cost_per_won_case(a_acct, t0 - interval '25 days', t0 - interval '15 days');
  n := n + 1; failed := failed || pg_temp.mnh_ok((j->>'other_spend_usd')::numeric = 0.50,
    format('known other spend alone reads %s', j));
  j := meta_cost_per_won_case(a_acct, t0 + interval '30 days', t0 + interval '31 days');
  n := n + 1; failed := failed || pg_temp.mnh_ok(j->'other_spend_usd' = '0'::jsonb,
    format('a window with no other message reads %s', j));
  r := pg_temp.mnh_try(NULL, NULL, format('SELECT public.meta_cost_per_won_case(%L, %L, %L)::text', a_acct, t0, t0));
  n := n + 1; failed := failed || pg_temp.mnh_ok(r LIKE 'ERROR % [RANGE_INVALID]%',
    format('an empty range was not refused (%s)', r));

  -- ---------- (i) the foreign-key exemption ----------
  i := (SELECT count(*) FROM meta_health_events WHERE account_id = a_acct);
  DELETE FROM whatsapp_config WHERE id = wm;
  n := n + 1; failed := failed || pg_temp.mnh_ok(
    (SELECT count(*) FROM meta_health_events WHERE account_id = a_acct) = i AND i > 0
    AND NOT EXISTS (SELECT 1 FROM meta_health_events WHERE account_id = a_acct AND config_id IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM meta_number_state WHERE config_id = wm),
    'disconnecting the number did not keep its events (config_id NULL) and drop its state');
  r := pg_temp.mnh_try(NULL, NULL, format(
    'WITH x AS (UPDATE public.meta_health_events SET config_id = NULL WHERE account_id = %L RETURNING 1) SELECT count(*)::text FROM x', a_acct));
  n := n + 1; failed := failed || pg_temp.mnh_ok(r LIKE 'ERROR % [APPEND_ONLY]%',
    format('a direct UPDATE passed as a foreign-key action (%s)', r));
  INSERT INTO accounts (name, owner_user_id) VALUES ('MNH C', u_far) RETURNING id INTO c_acct;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_far, c_acct, 'meta', 'MNH-188-C', 'x', 'connected', true) RETURNING id INTO wc;
  b := meta_health_event_record(c_acct, wc, 'account_update', 'kc', '{}'::jsonb);
  PERFORM meta_number_state_set(wc, NULL, 'GREEN', NULL, NULL, 'NORMAL', '[]'::jsonb);
  r := pg_temp.mnh_try(NULL, NULL, format(
    'WITH x AS (DELETE FROM public.accounts WHERE id = %L RETURNING 1) SELECT count(*)::text FROM x', c_acct));
  n := n + 1; failed := failed || pg_temp.mnh_ok(r = '1'
    AND NOT EXISTS (SELECT 1 FROM meta_health_events WHERE account_id = c_acct),
    format('deleting an account did not remove its events (%s)', r));

  -- ---------- the bell: meta_number_alert (section 10) ----------
  BEGIN
    INSERT INTO notifications (account_id, user_id, type, title, body, meta) VALUES
      (a_acct, u_owner, 'meta_number_alert', 'MNH bell', 'Meta number health: THROTTLED',
       jsonb_build_object('config_id', wm)),
      (a_acct, u_agent, 'meta_number_alert', 'MNH bell', NULL, '{}'::jsonb);
    r := 'ok';
  EXCEPTION WHEN OTHERS THEN
    r := 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
  END;
  n := n + 1; failed := failed || pg_temp.mnh_ok(r = 'ok',
    format('notifications_type_check refused meta_number_alert (%s)', r));
  n := n + 1; failed := failed || pg_temp.mnh_ok(
    (SELECT push_bell_url(nn) FROM notifications nn
      WHERE nn.user_id = u_owner AND nn.type = 'meta_number_alert') IS NOT DISTINCT FROM '/settings?tab=whatsapp',
    'push_bell_url does not open WhatsApp settings for an owner''s meta_number_alert');
  n := n + 1; failed := failed || pg_temp.mnh_ok(
    (SELECT push_bell_url(nn) FROM notifications nn
      WHERE nn.user_id = u_agent AND nn.type = 'meta_number_alert') IS NOT DISTINCT FROM '/notifications',
    'push_bell_url opens settings for an agent''s meta_number_alert');
  BEGIN
    INSERT INTO notifications (account_id, user_id, type, title) VALUES (a_acct, u_owner, 'meta_number_bogus', 'MNH bell');
    r := 'ok';
  EXCEPTION WHEN check_violation THEN
    r := 'refused';
  END;
  n := n + 1; failed := failed || pg_temp.mnh_ok(r = 'refused', 'notifications_type_check accepts an unlisted type');

  RAISE EXCEPTION USING ERRCODE = 'ZT188', MESSAGE = 'verify-meta-number-health rollback';
  EXCEPTION WHEN SQLSTATE 'ZT188' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'meta number health verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'meta number health verification passed (% checks)', n;
END
$verify$;
