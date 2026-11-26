-- Migration 293: an endpoint goes off only after a streak of 30 minutes and
-- rings the live owners and admins once; a success or switching it on ends
-- the streak; a claimed event can be given back; a number's waiting
-- messages are counted. Fixtures (wob-) are rolled back.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000293001';
  u_admin UUID := '00000000-0000-4000-8000-000000293002';
  u_agent UUID := '00000000-0000-4000-8000-000000293003';
  u_gone  UUID := '00000000-0000-4000-8000-000000293004';
  a       UUID;
  e       UUID;
  cfg     UUID;
  cfg2    UUID;
  w       webhook_endpoints%ROWTYPE;
  o       BIGINT;
  old_o   BIGINT;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  BEGIN
  INSERT INTO auth.users (id, email) VALUES (u_owner, 'wob-owner@example.invalid'), (u_admin, 'wob-admin@example.invalid'),
    (u_agent, 'wob-agent@example.invalid'), (u_gone, 'wob-gone@example.invalid') ON CONFLICT DO NOTHING;
  SELECT account_id INTO a FROM profiles WHERE user_id = u_owner;
  UPDATE profiles SET account_id = a, account_role = 'admin' WHERE user_id IN (u_admin, u_gone);
  UPDATE profiles SET account_id = a, account_role = 'agent' WHERE user_id = u_agent;
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_gone;
  INSERT INTO webhook_endpoints (account_id, created_by, url, secret, events)
  VALUES (a, u_owner, 'https://wob.example.invalid/hook?token=wobsecret', 'x', ARRAY['contact.opted_out']) RETURNING id INTO e;

  -- A burst: far past the count, still on, nobody rung.
  FOR i IN 1..40 LOOP PERFORM record_webhook_failure(e, 15); END LOOP;
  SELECT * INTO w FROM webhook_endpoints WHERE id = e;
  n := n + 1; IF (w.is_active AND w.failure_count = 40 AND w.first_failure_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM notifications WHERE account_id = a AND type = 'webhook_disabled')) IS NOT TRUE THEN
    failed := failed || 'burst switched the endpoint off'::text; END IF;

  -- A success, as deliver.ts writes it, ends the streak.
  UPDATE webhook_endpoints SET failure_count = 0, last_delivery_at = now() WHERE id = e;
  n := n + 1; IF (SELECT first_failure_at FROM webhook_endpoints WHERE id = e) IS NOT NULL THEN
    failed := failed || 'success kept first_failure_at'::text; END IF;

  -- Long but few: still on.
  PERFORM record_webhook_failure(e, 15);
  UPDATE webhook_endpoints SET first_failure_at = now() - interval '2 hours' WHERE id = e;
  FOR i IN 1..13 LOOP PERFORM record_webhook_failure(e, 15); END LOOP;
  n := n + 1; IF (SELECT is_active AND failure_count = 14 FROM webhook_endpoints WHERE id = e) IS NOT TRUE THEN
    failed := failed || 'off before the count'::text; END IF;
  -- The fifteenth, 29 minutes in: still on. At 30: off, and rung once.
  UPDATE webhook_endpoints SET first_failure_at = now() - interval '29 minutes' WHERE id = e;
  PERFORM record_webhook_failure(e, 15);
  n := n + 1; IF (SELECT is_active FROM webhook_endpoints WHERE id = e) IS NOT TRUE THEN
    failed := failed || 'off at 29 minutes'::text; END IF;
  UPDATE webhook_endpoints SET first_failure_at = now() - interval '30 minutes' WHERE id = e;
  FOR i IN 1..3 LOOP PERFORM record_webhook_failure(e, 15); END LOOP;
  n := n + 1; IF (SELECT is_active FROM webhook_endpoints WHERE id = e) IS NOT FALSE THEN
    failed := failed || 'not off at 30 minutes'::text; END IF;
  n := n + 1; IF (SELECT array_agg(user_id ORDER BY user_id) FROM notifications WHERE account_id = a AND type = 'webhook_disabled')
      IS DISTINCT FROM ARRAY[u_owner, u_admin] THEN
    failed := failed || 'the bell is not one each for the live owner and admin'::text; END IF;
  n := n + 1; IF (SELECT bool_and(body LIKE 'wob.example.invalid failed%' AND strpos(body, 'wobsecret') = 0
        AND push_bell_url(nn) = '/settings?tab=api' AND meta ->> 'endpoint_id' = e::text)
      FROM notifications nn WHERE account_id = a AND type = 'webhook_disabled') IS NOT TRUE THEN
    failed := failed || 'bell text or where it opens'::text; END IF;

  -- An admin's own session switches it on: the streak starts over.
  PERFORM set_config('request.jwt.claim.sub', u_admin::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  UPDATE webhook_endpoints SET is_active = true WHERE id = e;
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  SELECT * INTO w FROM webhook_endpoints WHERE id = e;
  n := n + 1; IF (w.is_active AND w.failure_count = 0 AND w.first_failure_at IS NULL) IS NOT TRUE THEN
    failed := failed || 'switching on kept the streak'::text; END IF;
  PERFORM record_webhook_failure(e, 1);
  n := n + 1; IF (SELECT is_active FROM webhook_endpoints WHERE id = e) IS NOT TRUE THEN
    failed := failed || 'first failure after switching on took it off'::text; END IF;

  -- Give back: handed out again; not once it is a day old.
  DELETE FROM webhook_event_outbox;
  INSERT INTO webhook_event_outbox (account_id, event, payload) VALUES (a, 'contact.opted_out', '{}') RETURNING id INTO o;
  INSERT INTO webhook_event_outbox (account_id, event, payload, created_at)
  VALUES (a, 'contact.opted_out', '{}', now() - interval '25 hours') RETURNING id INTO old_o;
  PERFORM webhook_outbox_claim(10);
  n := n + 1; IF (webhook_outbox_release(o) AND NOT webhook_outbox_release(old_o) AND NOT webhook_outbox_release(o)) IS NOT TRUE THEN
    failed := failed || 'release'::text; END IF;
  n := n + 1; IF (SELECT array_agg(c.id) FROM webhook_outbox_claim(10) c) IS DISTINCT FROM ARRAY[o] THEN
    failed := failed || 'a released event is not handed out again'::text; END IF;

  -- Waiting messages of one number: not receipts, done or dead rows, nor another number's.
  INSERT INTO whatsapp_config (account_id, user_id, phone_number_id, access_token) VALUES (a, u_owner, 'wob1', 'x') RETURNING id INTO cfg;
  INSERT INTO whatsapp_config (account_id, user_id, phone_number_id, access_token, is_primary)
  VALUES (a, u_owner, 'wob2', 'x', false) RETURNING id INTO cfg2;
  INSERT INTO webhook_inbox (account_id, channel, provider, event_key, kind, payload, done_at, dead_at) VALUES
    (a, cfg, 'meta', 'wob-1', 'message', '{}', NULL, NULL), (a, cfg, 'meta', 'wob-2', 'group_message', '{}', NULL, NULL),
    (a, cfg, 'meta', 'wob-3', 'status', '{}', NULL, NULL), (a, cfg, 'meta', 'wob-4', 'message', '{}', now(), NULL),
    (a, cfg, 'meta', 'wob-5', 'message', '{}', NULL, now()), (a, cfg2, 'meta', 'wob-6', 'message', '{}', NULL, NULL);
  n := n + 1; IF webhook_inbox_waiting(cfg) IS DISTINCT FROM 2 THEN
    failed := failed || format('waiting = %s', webhook_inbox_waiting(cfg)); END IF;

  n := n + 1; IF has_function_privilege('authenticated', 'webhook_outbox_release(bigint)', 'EXECUTE')
      OR has_function_privilege('anon', 'webhook_inbox_waiting(uuid)', 'EXECUTE')
      OR has_function_privilege('authenticated', 'webhook_inbox_waiting(uuid)', 'EXECUTE')
      OR has_function_privilege('authenticated', 'record_webhook_failure(uuid,integer)', 'EXECUTE')
      OR has_column_privilege('authenticated', 'webhook_endpoints', 'first_failure_at', 'UPDATE')
      OR NOT has_function_privilege('service_role', 'webhook_outbox_release(bigint)', 'EXECUTE')
      OR NOT has_function_privilege('service_role', 'webhook_inbox_waiting(uuid)', 'EXECUTE')
      OR NOT has_function_privilege('service_role', 'record_webhook_failure(uuid,integer)', 'EXECUTE') THEN
    failed := failed || 'grants'::text; END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZP293', MESSAGE = 'rollback';
  EXCEPTION WHEN SQLSTATE 'ZP293' THEN NULL;
  END;
  IF n <> 13 OR cardinality(failed) > 0 THEN
    RAISE EXCEPTION 'verify-webhook-off-bell: % of 13 checks ran, failed: %', n, array_to_string(failed, '; ');
  END IF;
  RAISE NOTICE 'verify-webhook-off-bell: % checks passed', n;
END
$verify$;
