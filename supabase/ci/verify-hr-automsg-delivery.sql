-- Behavioural regression suite for HR automated-message terminal
-- failures and delivery state (migration 212).
--
-- hr_automsg_fail_terminal marks an outbox row failed with attempts = 3
-- (never retried) and audits it, refusing a cancelled row and one the
-- provider may already hold unless its delivery failed.
-- hr_automsg_delivery_record applies one WhatsApp status to the newest
-- row of the account carrying that provider id: forward-only (sent <
-- delivered < read), nothing overwrites 'failed', 'failed' only from
-- NULL or 'sent', and an applied 'failed' fails the row terminally.
-- Both are service-role only. This asserts each of those through the
-- real functions.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000212001';  -- owner of A
  u_out   UUID := '00000000-0000-4000-8000-000000212002';  -- owner of B
  a_acct  UUID;
  a_out   UUID;
  k1 UUID; k2 UUID;  -- contacts in A and B
  v1 UUID; v2 UUID;  -- conversations in A and B
  o1 UUID; o2 UUID; o3 UUID; o4 UUID; o5 UUID; o6 UUID; o7 UUID; o8 UUID;
  o9 UUID; o10 UUID; o11 UUID; o12 UUID; o13 UUID;  -- early receipts, expiry
  m9 UUID; m10 UUID; m11 UUID;  -- the chat messages the sends wrote
  r       TEXT;
  c       TEXT[] := '{}';  -- one element per check: NULL = passed
  failed  TEXT[];
  n       INT := 0;
BEGIN
  BEGIN
  -- Run a statement as the service role with no user (p_uid NULL) or as
  -- a signed-in user: the value / 'ok', or 'ERROR <sqlstate> <hint>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.hr_as(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; st text; h text; m text;
    BEGIN
      BEGIN
        IF p_uid IS NULL THEN
          PERFORM set_config('request.jwt.claim.sub', '', true);
          PERFORM set_config('request.jwt.claims',
            json_build_object('role', 'service_role')::text, true);
          SET LOCAL ROLE service_role;
        ELSE
          PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
          PERFORM set_config('request.jwt.claims',
            json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
          SET LOCAL ROLE authenticated;
        END IF;
        EXECUTE p_sql INTO v;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(nullif(v, ''), 'ok');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, h = PG_EXCEPTION_HINT,
                                m = MESSAGE_TEXT;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN format('ERROR %s %s: %s', st, coalesce(h, ''), m);
      END;
    END $body$
  $fn$;

  -- NULL when `got` matches the LIKE pattern, else the named failure.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.hr_chk(p_label text, p_got text, p_want text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT CASE WHEN p_got LIKE p_want THEN NULL
                  ELSE p_label || ' (got ' || left(coalesce(p_got, '<null>'), 200) || ')' END
    $body$
  $fn$;

  -- A delivery status as the service role.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.dr(p_acct uuid, p_wamid text, p_state text, p_reason text DEFAULT NULL)
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.hr_as(NULL, format(
        'SELECT public.hr_automsg_delivery_record(%L, %L, %L, now(), %L)',
        p_acct, p_wamid, p_state, p_reason))
    $body$
  $fn$;

  -- ---------- Schema and privileges ----------
  r := (SELECT count(*) FROM pg_constraint
         WHERE conname = 'hr_automsg_outbox_delivery_state_check'
           AND conrelid = 'public.hr_automsg_outbox'::regclass)::text
    || '/' || (SELECT count(*) FROM pg_indexes
                WHERE schemaname = 'public' AND indexname = 'hr_automsg_outbox_provider_idx')::text;
  c := c || pg_temp.hr_chk('delivery_state check or provider index missing', r, '1/1');
  r := (SELECT count(*)
          FROM unnest(ARRAY['public.hr_automsg_fail_terminal(uuid, text)',
                            'public.hr_automsg_delivery_record(uuid, text, text, timestamptz, text, text)']) f,
               unnest(ARRAY['anon', 'authenticated', 'public']) g
         WHERE has_function_privilege(g, f, 'EXECUTE'))::text
    || '/' || (SELECT count(*)
          FROM unnest(ARRAY['public.hr_automsg_fail_terminal(uuid, text)',
                            'public.hr_automsg_delivery_record(uuid, text, text, timestamptz, text, text)']) f
         WHERE has_function_privilege('service_role', f, 'EXECUTE'))::text;
  c := c || pg_temp.hr_chk('anon/authenticated may execute, or service_role may not', r, '0/2');

  -- ---------- Fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'amd-owner@example.invalid'),
    (u_out,   'amd-out@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  SELECT id INTO a_out FROM accounts WHERE owner_user_id = u_out;
  IF a_acct IS NULL OR a_out IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_owner, '971502120001', 'Cand A') RETURNING id INTO k1;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_out, u_out, '971502120002', 'Cand B') RETURNING id INTO k2;
  INSERT INTO conversations (account_id, user_id, contact_id)
  VALUES (a_acct, u_owner, k1) RETURNING id INTO v1;
  INSERT INTO conversations (account_id, user_id, contact_id)
  VALUES (a_out, u_out, k2) RETURNING id INTO v2;

  -- o1 claimed, o2 sent, o3 cancelled, o4 ladder, o5 failed after sent,
  -- o6 failed after delivered, o7 in B, o8 unconfirmed claim.
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind,
                                 dedupe_key, status, attempts, claim_state, claimed_at)
  VALUES (a_acct, v1, k1, 'cv_received', 'cv_ack', 'd212:1', 'queued', 1, 'sending', now())
  RETURNING id INTO o1;
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind,
                                 dedupe_key, status, attempts, provider_message_id, sent_at)
  VALUES (a_acct, v1, k1, 'cv_received', 'cv_ack', 'd212:2', 'sent', 1, 'wamid.S2', now())
  RETURNING id INTO o2;
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind,
                                 dedupe_key, status)
  VALUES (a_acct, v1, k1, 'cv_received', 'cv_ack', 'd212:3', 'cancelled')
  RETURNING id INTO o3;
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind,
                                 dedupe_key, status, attempts, provider_message_id, sent_at)
  VALUES (a_acct, v1, k1, 'cv_received', 'cv_ack', 'd212:4', 'sent', 1, 'wamid.L4', now())
  RETURNING id INTO o4;
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind,
                                 dedupe_key, status, attempts, provider_message_id, sent_at)
  VALUES (a_acct, v1, k1, 'cv_received', 'cv_ack', 'd212:5', 'sent', 1, 'wamid.F5', now())
  RETURNING id INTO o5;
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind,
                                 dedupe_key, status, attempts, provider_message_id, sent_at)
  VALUES (a_acct, v1, k1, 'cv_received', 'cv_ack', 'd212:6', 'sent', 1, 'wamid.D6', now())
  RETURNING id INTO o6;
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind,
                                 dedupe_key, status, attempts, provider_message_id, sent_at)
  VALUES (a_out, v2, k2, 'cv_received', 'cv_ack', 'd212:7', 'sent', 1, 'wamid.X7', now())
  RETURNING id INTO o7;
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind,
                                 dedupe_key, status, attempts, claim_state, provider_message_id, sent_at)
  VALUES (a_acct, v1, k1, 'cv_received', 'cv_ack', 'd212:8', 'sent', 1, 'unconfirmed', 'wamid.U8', now())
  RETURNING id INTO o8;

  -- ---------- hr_automsg_fail_terminal ----------
  r := pg_temp.hr_as(NULL, format('SELECT (public.hr_automsg_fail_terminal(%L, ''bad_number'')).status', o1));
  c := c || pg_temp.hr_chk('fail_terminal on a claimed row', r, 'failed');
  r := (SELECT concat_ws('/', o.status, o.attempts, coalesce(o.claim_state, 'null'),
                         coalesce(o.hold_reason, 'null'), o.last_error)
          FROM hr_automsg_outbox o WHERE o.id = o1);
  c := c || pg_temp.hr_chk('fail_terminal row shape', r, 'failed/3/null/null/bad_number');
  r := (SELECT count(*) || '/' || max(a.detail->>'reason') || '/' || max(a.detail->>'attempts')
          FROM hr_automsg_audit a
         WHERE a.account_id = a_acct AND a.action = 'outbox_failed_terminal'
           AND a.detail->>'id' = o1::text);
  c := c || pg_temp.hr_chk('fail_terminal audit row', r, '1/bad_number/1');
  -- A second terminal failure changes nothing: no audit row, reason kept.
  r := pg_temp.hr_as(NULL, format('SELECT (public.hr_automsg_fail_terminal(%L, ''again'')).last_error', o1));
  r := r || '/' || (SELECT count(*) FROM hr_automsg_audit a
                     WHERE a.action = 'outbox_failed_terminal' AND a.detail->>'id' = o1::text)
    || '/' || (SELECT concat_ws('/', o.status, o.attempts, o.last_error) FROM hr_automsg_outbox o WHERE o.id = o1);
  c := c || pg_temp.hr_chk('second fail_terminal not idempotent', r, 'bad_number/1/failed/3/bad_number');
  r := pg_temp.hr_as(NULL, format('SELECT (public.hr_automsg_fail_terminal(%L, ''x'')).status', o2))
    || '|' || pg_temp.hr_as(NULL, format('SELECT (public.hr_automsg_fail_terminal(%L, ''x'')).status', o3))
    || '|' || pg_temp.hr_as(NULL, format('SELECT (public.hr_automsg_fail_terminal(%L, ''x'')).status', o8));
  c := c || pg_temp.hr_chk('fail_terminal on sent / cancelled / unconfirmed not refused',
    r, 'ERROR 22023 ALREADY_DECIDED:%|ERROR 22023 ALREADY_DECIDED:%|ERROR 22023 ALREADY_DECIDED:%');
  r := pg_temp.hr_as(NULL, format('SELECT (public.hr_automsg_fail_terminal(%L, E'' \t\n'')).status', o4))
    || '|' || pg_temp.hr_as(NULL, format('SELECT (public.hr_automsg_fail_terminal(%L, %L)).status', o4, repeat('x', 201)))
    || '|' || pg_temp.hr_as(NULL, format('SELECT (public.hr_automsg_fail_terminal(%L, ''x'')).status', gen_random_uuid()));
  c := c || pg_temp.hr_chk('fail_terminal blank / long reason or missing row not refused',
    r, 'ERROR 22023 INVALID:%|ERROR 22023 INVALID:%|ERROR P0002 NOT_FOUND:%');
  r := pg_temp.hr_as(u_owner, format('SELECT (public.hr_automsg_fail_terminal(%L, ''x'')).status', o4))
    || '|' || pg_temp.hr_as(u_owner, format(
         'SELECT public.hr_automsg_delivery_record(%L, ''wamid.L4'', ''read'', now(), NULL)', a_acct));
  c := c || pg_temp.hr_chk('a signed-in user ran a 212 function', r, 'ERROR 42501 %|ERROR 42501 %');

  -- ---------- hr_automsg_delivery_record: ladder ----------
  r := pg_temp.dr(a_acct, 'wamid.L4', 'sent');
  r := r || '/' || pg_temp.dr(a_acct, 'wamid.L4', 'delivered');
  r := r || '/' || pg_temp.dr(a_acct, 'wamid.L4', 'read');
  r := r || '/' || pg_temp.dr(a_acct, 'wamid.L4', 'delivered');
  r := r || '/' || pg_temp.dr(a_acct, 'wamid.L4', 'read');
  c := c || pg_temp.hr_chk('ladder sent→delivered→read, then lower and replay', r,
    'recorded/recorded/recorded/unchanged/unchanged');
  r := (SELECT concat_ws('/', o.delivery_state, o.delivery_at IS NOT NULL, o.status, o.attempts)
          FROM hr_automsg_outbox o WHERE o.id = o4);
  c := c || pg_temp.hr_chk('ladder row', r, 'read/t/sent/1');

  -- ---------- failed after sent: terminal ----------
  r := pg_temp.dr(a_acct, 'wamid.F5', 'sent');
  r := r || '/' || pg_temp.dr(a_acct, 'wamid.F5', 'failed', '#131026!');
  c := c || pg_temp.hr_chk('failed after sent', r, 'recorded/failed_terminal');
  r := (SELECT concat_ws('/', o.delivery_state, o.status, o.attempts, coalesce(o.claim_state, 'null'), o.last_error)
          FROM hr_automsg_outbox o WHERE o.id = o5);
  c := c || pg_temp.hr_chk('failed-after-sent row', r, 'failed/failed/3/null/delivery_failed:131026');
  r := (SELECT count(*)::text FROM hr_automsg_audit a
         WHERE a.action = 'outbox_failed_terminal' AND a.detail->>'id' = o5::text
           AND a.detail->>'reason' = 'delivery_failed:131026');
  c := c || pg_temp.hr_chk('failed-after-sent audit row', r, '1');
  r := pg_temp.dr(a_acct, 'wamid.F5', 'delivered');
  r := r || '/' || pg_temp.dr(a_acct, 'wamid.F5', 'read');
  r := r || '/' || pg_temp.dr(a_acct, 'wamid.F5', 'failed', '1');
  c := c || pg_temp.hr_chk('a status overwrote failed', r, 'unchanged/unchanged/unchanged');
  r := (SELECT concat_ws('/', o.delivery_state, o.last_error) FROM hr_automsg_outbox o WHERE o.id = o5);
  c := c || pg_temp.hr_chk('failed row after later statuses', r, 'failed/delivery_failed:131026');

  -- ---------- failed after delivered: ignored ----------
  r := pg_temp.dr(a_acct, 'wamid.D6', 'delivered');
  r := r || '/' || pg_temp.dr(a_acct, 'wamid.D6', 'failed', '131026');
  c := c || pg_temp.hr_chk('failed after delivered', r, 'recorded/unchanged');
  r := (SELECT concat_ws('/', o.delivery_state, o.status, o.attempts) FROM hr_automsg_outbox o WHERE o.id = o6);
  c := c || pg_temp.hr_chk('failed-after-delivered row', r, 'delivered/sent/1');

  -- ---------- failed on an unconfirmed claim, no code ----------
  r := pg_temp.dr(a_acct, 'wamid.U8', 'failed');
  r := r || '/' || (SELECT concat_ws('/', o.status, o.attempts, coalesce(o.claim_state, 'null'), o.last_error)
                      FROM hr_automsg_outbox o WHERE o.id = o8);
  c := c || pg_temp.hr_chk('failed on an unconfirmed claim', r,
    'failed_terminal/failed/3/null/delivery_failed:unknown');

  -- ---------- unknown, other account, invalid ----------
  r := pg_temp.dr(a_acct, 'wamid.none', 'read');
  r := r || '/' || pg_temp.dr(a_acct, 'wamid.X7', 'read');
  r := r || '/' || (SELECT coalesce(o.delivery_state, 'null') FROM hr_automsg_outbox o WHERE o.id = o7);
  c := c || pg_temp.hr_chk('unknown id / another account''s id', r, 'unknown_message/unknown_message/null');
  r := pg_temp.dr(a_acct, 'wamid.L4', 'seen');
  r := r || '|' || pg_temp.dr(a_acct, E' \t', 'read');
  r := r || '|' || pg_temp.dr(a_acct, 'wamid.L4', NULL);
  c := c || pg_temp.hr_chk('bad state or blank id not refused', r,
    'ERROR 22023 INVALID:%|ERROR 22023 INVALID:%|ERROR 22023 INVALID:%');

  -- ---------- a receipt that beat the stamp ----------
  -- send.ts writes the chat's message before hr_automsg_mark stamps the
  -- outbox row; a status in between reached only messages.status.
  INSERT INTO messages (conversation_id, sender_type, content_text, status)
  VALUES (v1, 'agent', 'early delivered', 'delivered') RETURNING id INTO m9;
  INSERT INTO messages (conversation_id, sender_type, content_text, status)
  VALUES (v1, 'agent', 'early failed', 'failed') RETURNING id INTO m10;
  INSERT INTO messages (conversation_id, sender_type, content_text, status)
  VALUES (v1, 'agent', 'no receipt yet', 'sent') RETURNING id INTO m11;
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind,
                                 dedupe_key, status, attempts, claim_state, claimed_at)
  VALUES (a_acct, v1, k1, 'cv_received', 'cv_ack', 'd212:9', 'queued', 1, 'sending', now())
  RETURNING id INTO o9;
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind,
                                 dedupe_key, status, attempts, claim_state, claimed_at)
  VALUES (a_acct, v1, k1, 'cv_received', 'cv_ack', 'd212:10', 'queued', 1, 'sending', now())
  RETURNING id INTO o10;
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind,
                                 dedupe_key, status, attempts, claim_state, claimed_at)
  VALUES (a_acct, v1, k1, 'cv_received', 'cv_ack', 'd212:11', 'queued', 1, 'sending', now())
  RETURNING id INTO o11;
  r := pg_temp.hr_as(NULL, format('SELECT (public.hr_automsg_mark(%L, ''sent'', NULL, ''wamid.E9'', %L)).status', o9, m9))
    || '/' || pg_temp.hr_as(NULL, format('SELECT (public.hr_automsg_mark(%L, ''sent'', NULL, ''wamid.E10'', %L)).status', o10, m10))
    || '/' || pg_temp.hr_as(NULL, format('SELECT (public.hr_automsg_mark(%L, ''sent'', NULL, ''wamid.E11'', %L)).status', o11, m11));
  c := c || pg_temp.hr_chk('mark sent with an early receipt', r, 'sent/sent/sent');
  r := (SELECT concat_ws('/', coalesce(o.delivery_state, 'null'), o.delivery_at IS NOT NULL, o.status, o.attempts)
          FROM hr_automsg_outbox o WHERE o.id = o9);
  c := c || pg_temp.hr_chk('early delivered receipt not caught', r, 'delivered/t/sent/1');
  r := (SELECT concat_ws('/', coalesce(o.delivery_state, 'null'), o.status, o.attempts, o.last_error)
          FROM hr_automsg_outbox o WHERE o.id = o10);
  c := c || pg_temp.hr_chk('early failed receipt not caught', r, 'failed/failed/3/delivery_failed:unknown');
  r := (SELECT concat_ws('/', coalesce(o.delivery_state, 'null'), o.status, o.attempts)
          FROM hr_automsg_outbox o WHERE o.id = o11);
  c := c || pg_temp.hr_chk('a message still sent set a delivery state', r, 'null/sent/1');

  -- ---------- a skewed receipt time is clamped ----------
  r := pg_temp.hr_as(NULL, format(
    'SELECT public.hr_automsg_delivery_record(%L, ''wamid.E11'', ''delivered'', now() + interval ''1 day'', NULL)', a_acct));
  r := r || '/' || (SELECT (o.delivery_at <= now() + interval '1 minute')::text
                      FROM hr_automsg_outbox o WHERE o.id = o11);
  c := c || pg_temp.hr_chk('receipt time a day ahead not clamped', r, 'recorded/true');

  -- ---------- expiry keeps terminal failures ----------
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind,
                                 dedupe_key, status, attempts, last_error, created_at)
  VALUES (a_acct, v1, k1, 'cv_received', 'cv_ack', 'd212:12', 'failed', 3, 'bad_number',
          now() - interval '25 hours')
  RETURNING id INTO o12;
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind,
                                 dedupe_key, status, attempts, last_error, created_at)
  VALUES (a_acct, v1, k1, 'cv_received', 'cv_ack', 'd212:13', 'failed', 1, 'timeout',
          now() - interval '25 hours')
  RETURNING id INTO o13;
  r := pg_temp.hr_as(NULL, 'SELECT public.hr_automsg_expire()::text');
  r := (SELECT o.status || '/' || o.last_error FROM hr_automsg_outbox o WHERE o.id = o12)
    || '|' || (SELECT o.status FROM hr_automsg_outbox o WHERE o.id = o13);
  c := c || pg_temp.hr_chk('expiry relabelled a terminal failure, or kept a retryable one', r,
    'failed/bad_number|cancelled');

  RAISE EXCEPTION 'verify-hr-automsg-delivery rollback' USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN
    NULL;
  END;

  n := cardinality(c);
  SELECT array_agg(x) INTO failed FROM unnest(c) x WHERE x IS NOT NULL;
  IF failed IS NOT NULL THEN
    RAISE EXCEPTION 'verify-hr-automsg-delivery: % of % checks failed: %', cardinality(failed), n,
      array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'verify-hr-automsg-delivery: all % checks passed', n;
END
$verify$;
