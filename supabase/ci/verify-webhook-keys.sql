-- Migration 315: revoking or deleting an API key switches its webhook
-- endpoints off and rings; an erasure empties the webhook queue of the
-- customer; the web form keeps a text sent after its task was closed and
-- finds a customer stored in another form of the number.
--
-- ONE statement on purpose (`supabase db query --file`); rolled back by a
-- sentinel exception.

DO $verify$
DECLARE
  u_owner uuid := '00000000-0000-4000-8000-000000315001';
  u_agent uuid := '00000000-0000-4000-8000-000000315002';
  u_other uuid := '00000000-0000-4000-8000-000000315003';
  a       uuid;
  a2      uuid;
  k1      uuid;
  k2      uuid;
  k3      uuid;
  kx      uuid;
  e1      uuid;
  e1off   uuid;
  e2      uuid;
  e0      uuid;
  e3      uuid;
  c1      uuid;
  c2      uuid;
  c3      uuid;
  cv      uuid;
  tok     text := repeat('3', 63) || '5';
  j       jsonb;
  t       text;
  n       int := 0;
  failed  text[] := '{}';
BEGIN
  BEGIN
  INSERT INTO auth.users (id, email, aud, role) VALUES
    (u_owner, 'whk-owner@example.invalid', 'authenticated', 'authenticated'),
    (u_agent, 'whk-agent@example.invalid', 'authenticated', 'authenticated'),
    (u_other, 'whk-other@example.invalid', 'authenticated', 'authenticated');
  SELECT account_id INTO a FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO a2 FROM profiles WHERE user_id = u_other;
  UPDATE profiles SET account_id = a, account_role = 'agent' WHERE user_id = u_agent;
  INSERT INTO api_keys (account_id, name, key_prefix, key_hash) VALUES (a, 'whk one', 'p', 'whk-1') RETURNING id INTO k1;
  INSERT INTO api_keys (account_id, name, key_prefix, key_hash) VALUES (a, 'whk two', 'p', 'whk-2') RETURNING id INTO k2;
  INSERT INTO api_keys (account_id, name, key_prefix, key_hash) VALUES (a, 'whk three', 'p', 'whk-3') RETURNING id INTO k3;
  INSERT INTO api_keys (account_id, name, key_prefix, key_hash) VALUES (a2, 'whk other', 'p', 'whk-x') RETURNING id INTO kx;
  INSERT INTO webhook_endpoints (account_id, url, secret, events, api_key_id)
  VALUES (a, 'https://whk1.example.invalid/h?token=whksecret', 'x', ARRAY['contact.opted_out'], k1) RETURNING id INTO e1;
  INSERT INTO webhook_endpoints (account_id, url, secret, events, api_key_id, is_active)
  VALUES (a, 'https://whk1off.example.invalid/', 'x', ARRAY['contact.opted_out'], k1, false) RETURNING id INTO e1off;
  INSERT INTO webhook_endpoints (account_id, url, secret, events, api_key_id)
  VALUES (a, 'https://whk2.example.invalid/', 'x', ARRAY['contact.opted_out'], k2) RETURNING id INTO e2;
  INSERT INTO webhook_endpoints (account_id, url, secret, events)
  VALUES (a, 'https://whk0.example.invalid/', 'x', ARRAY['contact.opted_out']) RETURNING id INTO e0;

  -- Not a revocation: nothing changes.
  UPDATE api_keys SET last_used_at = now(), name = 'whk one b' WHERE id = k1;
  n := n + 1; IF (SELECT bool_and(is_active) FROM webhook_endpoints WHERE id IN (e1, e2, e0)) IS NOT TRUE THEN
    failed := failed || 'a key update switched an endpoint off'::text; END IF;

  -- 1: revoked by the owner's own session, as the app does it.
  PERFORM set_config('request.jwt.claim.sub', u_owner::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  UPDATE api_keys SET revoked_at = now() WHERE id = k1;
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  n := n + 1; IF (SELECT array_agg(is_active ORDER BY array_position(ARRAY[e1, e1off, e2, e0], id))
                    FROM webhook_endpoints WHERE id IN (e1, e1off, e2, e0))
       IS DISTINCT FROM ARRAY[false, false, true, true] THEN
    failed := failed || 'revoke did not switch exactly its endpoint off'::text; END IF;
  n := n + 1; IF (SELECT count(*) = 1 AND bool_and(user_id = u_owner AND meta ->> 'endpoint_id' = e1::text
        AND body LIKE 'whk1.example.invalid gets no more%whk one b%revoked%' AND strpos(body, 'whksecret') = 0
        AND push_bell_url(nn) = '/settings?tab=api')
      FROM notifications nn WHERE account_id = a AND type = 'webhook_disabled') IS NOT TRUE THEN
    failed := failed || 'the revoke bell'::text; END IF;

  -- It stays off under the revoked key; a live key takes it over.
  UPDATE webhook_endpoints SET is_active = true, failure_count = 0 WHERE id = e1;
  n := n + 1; IF (SELECT is_active FROM webhook_endpoints WHERE id = e1) IS NOT FALSE THEN
    failed := failed || 'switched on under a revoked key'::text; END IF;
  UPDATE webhook_endpoints SET is_active = true, api_key_id = k2 WHERE id = e1;
  n := n + 1; IF (SELECT is_active AND api_key_id = k2 FROM webhook_endpoints WHERE id = e1) IS NOT TRUE THEN
    failed := failed || 'a live key could not take the endpoint over'::text; END IF;
  -- Made by a key revoked meanwhile: off. Another workspace's key: not recorded.
  INSERT INTO webhook_endpoints (account_id, url, secret, events, api_key_id)
  VALUES (a, 'https://whk3.example.invalid/', 'x', ARRAY['contact.opted_out'], k1) RETURNING id INTO e3;
  n := n + 1; IF (SELECT is_active FROM webhook_endpoints WHERE id = e3) IS NOT FALSE THEN
    failed := failed || 'made on under a revoked key'::text; END IF;
  UPDATE webhook_endpoints SET api_key_id = kx WHERE id = e3;
  n := n + 1; IF (SELECT api_key_id IS NULL FROM webhook_endpoints WHERE id = e3) IS NOT TRUE THEN
    failed := failed || 'another workspace''s key was recorded'::text; END IF;

  -- Deleted: off before the key id goes.
  DELETE FROM api_keys WHERE id = k2;
  n := n + 1; IF (SELECT count(*) = 2 AND bool_and(NOT is_active AND api_key_id IS NULL)
                    FROM webhook_endpoints WHERE id IN (e1, e2)) IS NOT TRUE THEN
    failed := failed || 'delete did not switch its endpoints off'::text; END IF;
  n := n + 1; IF (SELECT count(*) FROM notifications WHERE account_id = a AND type = 'webhook_disabled' AND body LIKE '%deleted%') <> 2 THEN
    failed := failed || 'the delete bells'::text; END IF;
  -- An endpoint with no key is untouched, and one whose receiver fails works as before.
  PERFORM record_webhook_failure(e0, 15);
  n := n + 1; IF (SELECT is_active AND failure_count = 1 FROM webhook_endpoints WHERE id = e0) IS NOT TRUE THEN
    failed := failed || 'an endpoint with no key changed'::text; END IF;

  -- 2: the erased customer's rows go, queued and delivered; others stay.
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a, u_owner, '971509990001', 'whk one') RETURNING id INTO c1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a, u_owner, '971509990002', 'whk two') RETURNING id INTO c2;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a, u_owner, c1) RETURNING id INTO cv;
  UPDATE contacts SET opted_out_at = now() WHERE id IN (c1, c2);
  INSERT INTO webhook_event_outbox (account_id, event, payload, delivered_at) VALUES
    (a, 'case.lead_created', jsonb_build_object('contact_id', c1), now()),
    (a, 'message.received', jsonb_build_object('conversation_id', cv), NULL),
    (a2, 'contact.opted_out', jsonb_build_object('contact_id', c1, 'phone', 'elsewhere'), NULL);
  n := n + 1; IF jsonb_array_length(privacy_webhook_outbox_export(a, c1)) <> 3 THEN
    failed := failed || 'export does not list the rows'::text; END IF;
  PERFORM privacy_subject_erase(u_owner, a, c1, false, 'ERASE ' || c1::text);
  n := n + 1; IF (SELECT count(*) FROM webhook_event_outbox o WHERE o.account_id = a
                    AND (o.payload::text LIKE '%' || c1::text || '%' OR o.payload::text LIKE '%' || cv::text || '%'
                         OR o.payload::text LIKE '%971509990001%')) <> 0 THEN
    failed := failed || 'an erased customer is still in the webhook queue'::text; END IF;
  n := n + 1; IF (SELECT count(*) FROM webhook_event_outbox o WHERE o.payload ->> 'contact_id' = c2::text OR o.account_id = a2) <> 2 THEN
    failed := failed || 'the erase took another row'::text; END IF;

  -- 3: open = appended; closed = a new task.
  INSERT INTO web_lead_forms (account_id, token, enabled) VALUES (a, tok, true);
  PERFORM web_form_submit(tok, 'Whk', '971509990010', NULL, 'first', NULL);
  j := web_form_submit(tok, 'Whk', '971509990010', NULL, 'second', NULL);
  c3 := (j ->> 'contact_id')::uuid;
  n := n + 1; IF (j ->> 'task_created')::boolean OR (SELECT array_agg(note) FROM tasks WHERE contact_id = c3)
       IS DISTINCT FROM ARRAY[E'first\n\nsecond'] THEN
    failed := failed || 'an open task did not take the second text'::text; END IF;
  UPDATE tasks SET status = 'done', completed_at = now() WHERE contact_id = c3;
  PERFORM pg_sleep(0.005);
  j := web_form_submit(tok, 'Whk', '971509990010', NULL, 'third', NULL);
  n := n + 1; IF (j ->> 'task_created')::boolean IS NOT TRUE
       OR (SELECT note LIKE 'third%' FROM tasks WHERE contact_id = c3 AND status = 'open') IS NOT TRUE THEN
    failed := failed || 'a text after the task was closed is lost'::text; END IF;
  -- The same again, after that task was closed too, opens nothing: with the
  -- same text, and with nothing but the contact's own name.
  UPDATE tasks SET status = 'done', completed_at = now() WHERE contact_id = c3;
  PERFORM pg_sleep(0.005);
  j := web_form_submit(tok, 'Whk', '971509990010', NULL, 'third', NULL);
  n := n + 1; IF (j ->> 'task_created')::boolean OR EXISTS (SELECT 1 FROM tasks WHERE contact_id = c3 AND status = 'open') THEN
    failed := failed || 'the same text again opened a task'::text; END IF;
  j := web_form_submit(tok, 'Whk', '971509990010', NULL, NULL, NULL);
  n := n + 1; IF (j ->> 'task_created')::boolean OR EXISTS (SELECT 1 FROM tasks WHERE contact_id = c3 AND status = 'open') THEN
    failed := failed || 'a submission with nothing new opened a task'::text; END IF;
  -- Out of the window it is a new lead again.
  UPDATE tasks SET created_at = now() - interval '11 minutes' WHERE contact_id = c3;
  PERFORM pg_sleep(0.005);
  j := web_form_submit(tok, 'Whk', '971509990010', NULL, NULL, NULL);
  n := n + 1; IF (j ->> 'task_created')::boolean IS NOT TRUE THEN
    failed := failed || 'a submission after the window opened nothing'::text; END IF;

  -- 4: one customer in another form is found; two, or a foreign number, are not.
  FOREACH t IN ARRAY ARRAY['050 777 0001', '50 777 0002', '+9710507770003', '00971507770004', '04 777 0005'] LOOP
    INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a, u_agent, t, 'whk local') RETURNING id INTO c3;
    j := web_form_submit(tok, 'Visitor', '971' || CASE WHEN t LIKE '04%' THEN '4777000' ELSE '50777000' END || right(t, 1), NULL, 'hi', NULL);
    n := n + 1; IF (j ->> 'contact_id')::uuid IS DISTINCT FROM c3 OR (j ->> 'contact_created')::boolean
         OR (SELECT name FROM contacts WHERE id = c3) <> 'whk local' THEN
      failed := failed || ('a twin of ' || t); END IF;
  END LOOP;
  INSERT INTO contacts (account_id, user_id, phone) VALUES (a, u_agent, '0507770006'), (a, u_agent, '507770006');
  j := web_form_submit(tok, 'Visitor', '971507770006', NULL, 'hi', NULL);
  n := n + 1; IF (j ->> 'contact_created')::boolean IS NOT TRUE THEN
    failed := failed || 'two candidates and one was taken'::text; END IF;
  INSERT INTO contacts (account_id, user_id, phone) VALUES (a, u_agent, '0507770007'), (a, u_agent, '0407770007');
  j := web_form_submit(tok, 'Visitor', '971507770007', NULL, 'hi', NULL);
  n := n + 1; IF (j ->> 'contact_created')::boolean IS NOT TRUE THEN
    failed := failed || 'a second local number with the same end was passed over'::text; END IF;
  INSERT INTO contacts (account_id, user_id, phone) VALUES (a, u_agent, '0507770008'), (a, u_agent, '966507770009');
  j := web_form_submit(tok, 'Visitor', '966507770008', NULL, 'hi', NULL);
  n := n + 1; IF (j ->> 'contact_created')::boolean IS NOT TRUE THEN
    failed := failed || 'a Saudi number took a local row'::text; END IF;
  j := web_form_submit(tok, 'Visitor', '971507770009', NULL, 'hi', NULL);
  n := n + 1; IF (j ->> 'contact_created')::boolean IS NOT TRUE THEN
    failed := failed || 'another country''s row was taken'::text; END IF;
  -- Exact first, whatever else there is.
  j := web_form_submit(tok, 'Visitor', '971507770006', NULL, 'again', NULL);
  n := n + 1; IF (j ->> 'contact_created')::boolean IS NOT FALSE THEN
    failed := failed || 'exact is not first'::text; END IF;

  n := n + 1; IF EXISTS (SELECT 1 FROM unnest(ARRAY['api_key_webhooks_off()', 'webhook_endpoint_key()',
         'privacy_webhook_outbox_erase(uuid,uuid)', 'privacy_webhook_outbox_export(uuid,uuid)',
         'web_form_stored_forms(text)', 'web_form_contact_by_form(uuid,text)']) f,
         unnest(ARRAY['anon', 'authenticated', 'service_role']) r WHERE has_function_privilege(r, 'public.' || f, 'EXECUTE'))
      OR has_function_privilege('anon', 'web_form_submit(text,text,text,text,text,jsonb)', 'EXECUTE')
      OR NOT has_function_privilege('service_role', 'web_form_submit(text,text,text,text,text,jsonb)', 'EXECUTE')
      OR has_column_privilege('authenticated', 'webhook_endpoints', 'api_key_id', 'UPDATE') THEN
    failed := failed || 'grants'::text; END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZP315', MESSAGE = 'rollback';
  EXCEPTION WHEN SQLSTATE 'ZP315' THEN NULL;
  END;
  IF n <> 29 OR cardinality(failed) > 0 THEN
    RAISE EXCEPTION 'verify-webhook-keys: % of 29 checks ran, failed: %', n, array_to_string(failed, '; ');
  END IF;
  RAISE NOTICE 'verify-webhook-keys: % checks passed', n;
END
$verify$;
