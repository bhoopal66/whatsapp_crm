-- Behavioural regression suite for hr_automsg_outbox_stats() (migration
-- 228): counts per status and channel, held rows by reason, the oldest
-- queued row's age and terminal failures, across workspaces; service
-- role only.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. Fixtures are
-- rolled back by a sentinel exception; failures are named in the final
-- one.

DO $verify$
DECLARE
  u_a  UUID := '00000000-0000-4000-8000-000000228001';
  u_b  UUID := '00000000-0000-4000-8000-000000228002';
  a_a  UUID; a_b UUID;
  k_a  UUID; k_b UUID;
  v_a  UUID; v_b UUID;
  base JSONB; j JSONB;
  r    TEXT;
  c    TEXT[] := '{}';
  failed TEXT[];
  n    INT := 0;
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.os_as(p_role text, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; st text; m text;
    BEGIN
      BEGIN
        EXECUTE format('SET LOCAL ROLE %I', p_role);
        EXECUTE p_sql INTO v;
        RESET ROLE;
        RETURN coalesce(v, 'ok');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, m = MESSAGE_TEXT;
        RESET ROLE;
        RETURN format('ERROR %s: %s', st, m);
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.os_chk(p_label text, p_got text, p_want text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT CASE WHEN p_got LIKE p_want THEN NULL
                  ELSE p_label || ' (got ' || left(coalesce(p_got, '<null>'), 200) || ')' END
    $body$
  $fn$;
  -- The count of one (status, channel) or (reason, channel) entry, 0 when absent.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.os_n(p_list jsonb, p_key text, p_val text, p_channel text)
    RETURNS bigint LANGUAGE sql AS $body$
      SELECT coalesce((SELECT (e->>'count')::bigint FROM jsonb_array_elements(p_list) e
                        WHERE e->>p_key = p_val AND e->>'channel' = p_channel), 0)
    $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_a, 'os-a@example.invalid'), (u_b, 'os-b@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_a FROM profiles WHERE user_id = u_a;
  SELECT account_id INTO a_b FROM profiles WHERE user_id = u_b;
  IF a_a IS NULL OR a_b IS NULL OR a_a = a_b THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision two accounts';
  END IF;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_a, u_a, '971502280001', 'OS A') RETURNING id INTO k_a;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_b, u_b, '971502280002', 'OS B') RETURNING id INTO k_b;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_a, u_a, k_a) RETURNING id INTO v_a;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_b, u_b, k_b) RETURNING id INTO v_b;

  -- Whatever the database already holds, measured before the fixtures.
  base := hr_automsg_outbox_stats();

  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind,
                                 dedupe_key, status, hold_reason, attempts, channel, created_at)
  VALUES
    (a_a, v_a, k_a, 'cv_received', 'cv_ack', 'v228:q1', 'queued', NULL, 0, 'whatsapp', now() - interval '2 hours'),
    (a_b, v_b, k_b, 'cv_received', 'cv_ack', 'v228:q2', 'queued', NULL, 0, 'sms', now() - interval '5 minutes'),
    (a_a, v_a, k_a, 'cv_received', 'cv_ack', 'v228:h1|sms', 'held', 'channel_not_connected', 0, 'sms', now()),
    (a_b, v_b, k_b, 'cv_received', 'cv_ack', 'v228:h2|sms', 'held', 'channel_not_connected', 0, 'sms', now()),
    (a_a, v_a, k_a, 'cv_received', 'cv_ack', 'v228:f1', 'failed', NULL, 3, 'whatsapp', now()),
    (a_a, v_a, k_a, 'cv_received', 'cv_ack', 'v228:f2', 'failed', NULL, 1, 'whatsapp', now());

  j := hr_automsg_outbox_stats();
  r := concat_ws('/',
         pg_temp.os_n(j->'rows', 'status', 'queued', 'whatsapp') - pg_temp.os_n(base->'rows', 'status', 'queued', 'whatsapp'),
         pg_temp.os_n(j->'rows', 'status', 'queued', 'sms') - pg_temp.os_n(base->'rows', 'status', 'queued', 'sms'),
         pg_temp.os_n(j->'rows', 'status', 'held', 'sms') - pg_temp.os_n(base->'rows', 'status', 'held', 'sms'),
         pg_temp.os_n(j->'rows', 'status', 'failed', 'whatsapp') - pg_temp.os_n(base->'rows', 'status', 'failed', 'whatsapp'));
  c := c || pg_temp.os_chk('rows per status and channel, across workspaces', r, '1/1/2/2');
  r := (pg_temp.os_n(j->'held', 'reason', 'channel_not_connected', 'sms')
        - pg_temp.os_n(base->'held', 'reason', 'channel_not_connected', 'sms'))::text;
  c := c || pg_temp.os_chk('held rows by reason and channel', r, '2');
  r := (((j->>'terminal_failed')::bigint) - ((base->>'terminal_failed')::bigint))::text;
  c := c || pg_temp.os_chk('terminal failed counts only attempts >= 3', r, '1');
  r := ((j->>'oldest_queued_age_seconds')::bigint >= 7190)::text;
  c := c || pg_temp.os_chk('the oldest queued age is not the oldest queued row', r, 'true');
  r := (SELECT string_agg(DISTINCT k, ',' ORDER BY k) FROM jsonb_object_keys(j) k);
  c := c || pg_temp.os_chk('the result carries other keys than the counts', r, 'held,oldest_queued_age_seconds,rows,terminal_failed');
  r := (SELECT string_agg(DISTINCT k, ',' ORDER BY k)
          FROM jsonb_array_elements(j->'rows') e, jsonb_object_keys(e) k);
  c := c || pg_temp.os_chk('a row entry carries more than status, channel and count', r, 'channel,count,status');

  -- No queued row: the age is null.
  UPDATE hr_automsg_outbox SET status = 'cancelled' WHERE status = 'queued';
  r := coalesce(hr_automsg_outbox_stats()->>'oldest_queued_age_seconds', 'null');
  c := c || pg_temp.os_chk('the age is not null with nothing queued', r, 'null');

  -- Privileges.
  r := pg_temp.os_as('service_role', 'SELECT (public.hr_automsg_outbox_stats() ? ''rows'')::text')
    || '/' || pg_temp.os_as('authenticated', 'SELECT public.hr_automsg_outbox_stats()::text')
    || '/' || pg_temp.os_as('anon', 'SELECT public.hr_automsg_outbox_stats()::text');
  c := c || pg_temp.os_chk('outbox stats are not service role only', r, 'true/ERROR 42501:%/ERROR 42501:%');

  RAISE EXCEPTION 'verify-hr-automsg-outbox-stats rollback' USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN
    NULL;
  END;

  n := cardinality(c);
  SELECT array_agg(x) INTO failed FROM unnest(c) x WHERE x IS NOT NULL;
  IF failed IS NOT NULL THEN
    RAISE EXCEPTION 'verify-hr-automsg-outbox-stats: % of % checks failed: %', cardinality(failed), n,
      array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'verify-hr-automsg-outbox-stats: all % checks passed', n;
END
$verify$;
