-- Migration 295: the push of a message that could not be processed, of a
-- personal number and of handed-over work opens the screen its bell opens
-- (lib/notifications/target.ts). Fixtures (pli-) are rolled back.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000295001';
  u_agent UUID := '00000000-0000-4000-8000-000000295002';
  a       UUID;
  c       RECORD;
  nn      notifications%ROWTYPE;
  got     TEXT;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  BEGIN
  INSERT INTO auth.users (id, email) VALUES (u_owner, 'pli-owner@example.invalid'), (u_agent, 'pli-agent@example.invalid')
    ON CONFLICT DO NOTHING;
  SELECT account_id INTO a FROM profiles WHERE user_id = u_owner;
  UPDATE profiles SET account_id = a, account_role = 'agent' WHERE user_id = u_agent;

  FOR c IN SELECT * FROM (VALUES
    (u_owner, 'inbound_message_failed', '{}'::jsonb,                '/settings?tab=whatsapp'),
    (u_agent, 'inbound_message_failed', '{}'::jsonb,                '/notifications'),
    (u_agent, 'channel_disconnected',   '{"personal": true}'::jsonb,  '/settings?tab=profile'),
    (u_owner, 'channel_reconnected',    '{"personal": true}'::jsonb,  '/settings?tab=profile'),
    -- A company number's, and any other type's, are as they were.
    (u_owner, 'channel_disconnected',   '{"personal": false}'::jsonb, '/settings?tab=whatsapp'),
    (u_agent, 'channel_disconnected',   '{}'::jsonb,                '/notifications'),
    (u_agent, 'work_handed_over',       '{}'::jsonb,                '/inbox'),
    (u_owner, 'meta_number_alert',      '{"personal": true}'::jsonb,  '/settings?tab=whatsapp'),
    (u_owner, 'retention_failed',       '{}'::jsonb,                '/settings?tab=privacy'),
    (u_owner, 'webhook_disabled',       '{}'::jsonb,                '/settings?tab=api')
  ) v(who, kind, meta, want)
  LOOP
    INSERT INTO notifications (account_id, user_id, type, title, meta)
    VALUES (a, c.who, c.kind, 'pli', c.meta) RETURNING * INTO nn;
    got := push_bell_url(nn);
    n := n + 1; IF got IS DISTINCT FROM c.want THEN
      failed := failed || format('%s %s %s opens %s', c.kind, c.meta, c.who = u_owner, got); END IF;
  END LOOP;

  n := n + 1; IF has_function_privilege('authenticated', 'push_bell_url(notifications)', 'EXECUTE')
      OR has_function_privilege('anon', 'push_bell_url(notifications)', 'EXECUTE') THEN
    failed := failed || 'grants'::text; END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZP295', MESSAGE = 'rollback';
  EXCEPTION WHEN SQLSTATE 'ZP295' THEN NULL;
  END;
  IF n <> 11 OR cardinality(failed) > 0 THEN
    RAISE EXCEPTION 'verify-push-link-inbound: % of 11 checks ran, failed: %', n, array_to_string(failed, '; ');
  END IF;
  RAISE NOTICE 'verify-push-link-inbound: % checks passed', n;
END
$verify$;
