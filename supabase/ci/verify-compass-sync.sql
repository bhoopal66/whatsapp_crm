-- Behavioural regression suite for the Compass two-way case sync
-- (migration 134).
--
-- case_sync_from_submission applies Compass's view of a submitted case as
-- the v1 API (actor NULL, role 'api'): no case and stale updates write
-- nothing, the stage obeys 122/130's move rules (UNKNOWN_STAGE,
-- PRESUB_REENTRY, FINAL_STAGE), bank / product / amount overwrite with a
-- detail-log row each, and documents outside the requirements are
-- reported, not raised. case_settings_set (owner/admin) turns on
-- managed_externally, which locks the people-facing case_set_stage on a
-- submitted case (MANAGED_EXTERNALLY) but never on a lead or the API path.
-- The webhook outbox queues an event only for an account with an active
-- endpoint subscribed to it, and webhook_outbox_claim hands each row out
-- once. compass_link_contact_by_phone links unlinked Compass customers.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000134001';
  u_admin  UUID := '00000000-0000-4000-8000-000000134002';
  u_agent  UUID := '00000000-0000-4000-8000-000000134003';
  a_acct   UUID;
  w1       UUID;
  c1       UUID;  -- customer of g1 / k1
  c2       UUID;  -- customer of g2 / k2
  c3       UUID;  -- the lead's customer
  c4       UUID;  -- opts out
  c5       UUID;  -- linked to a Compass customer by phone
  g1       UUID;
  g2       UUID;
  k1       UUID;
  k2       UUID;
  l1       UUID;
  v_claim  UUID;
  b1       BOOLEAN;
  st       TEXT;
  r        TEXT;
  j        JSONB;
  h0       INT;
  h1       INT;
  v_n      INT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (NULL: as the current user) signed in as
  -- p_uid: a SELECT's value, 'ok', or 'ERROR <sqlstate> <hint>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cs_try(p_role text, p_uid uuid, p_sql text)
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
        IF p_sql ILIKE 'select%' OR p_sql ILIKE 'with%' THEN
          EXECUTE p_sql INTO v;
        ELSE
          EXECUTE p_sql;
        END IF;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(v, 'ok');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ' ' || coalesce(nullif(h, ''), '-') || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;
  -- NULL when cs_try's result is LIKE p_like, else the check's name and
  -- the result (so `failed := failed || cs_check(…)` records failures only).
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cs_check(p_name text, p_role text, p_uid uuid, p_sql text, p_like text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := pg_temp.cs_try(p_role, p_uid, p_sql);
    BEGIN
      RETURN CASE WHEN v LIKE p_like THEN NULL ELSE p_name || ' (' || v || ')' END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cs_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  -- case_sync_from_submission(group, now(), patch) as SQL text for cs_check.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sync_sql(p_group uuid, p_patch jsonb)
    RETURNS text LANGUAGE sql AS $body$
      SELECT format('SELECT case_sync_from_submission(%L, now(), %L)::text', p_group, p_patch)
    $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'csy-owner@example.invalid'),
    (u_admin, 'csy-admin@example.invalid'),
    (u_agent, 'csy-agent@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent;

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'CSY-134-A1', 'x', 'connected', true) RETURNING id INTO w1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500134001', 'CSY one')
    RETURNING id INTO c1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500134002', 'CSY two')
    RETURNING id INTO c2;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500134003', 'CSY three')
    RETURNING id INTO c3;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500134004', 'CSY four')
    RETURNING id INTO c4;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500134005', 'CSY five')
    RETURNING id INTO c5;
  INSERT INTO case_banks (account_id, code, name) VALUES (a_acct, 'ENBD', 'Emirates NBD'), (a_acct, 'ADCB', 'ADCB')
  ON CONFLICT DO NOTHING;
  INSERT INTO case_doc_requirements (account_id, bank_code, product, doc_key, label)
  VALUES (a_acct, 'ENBD', 'Mortgage', 'salary_cert', 'Salary certificate');

  g1 := (SELECT x.group_id FROM sg_open(a_acct, 'CSY-134-1', c1, w1, 'case 1', NULL,
          jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL) x);
  k1 := (SELECT x.case_id FROM case_open(g1, 'ENBD', NULL, 'Mortgage', NULL, NULL) x);
  g2 := (SELECT x.group_id FROM sg_open(a_acct, 'CSY-134-2', c2, w1, 'case 2', NULL,
          jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL) x);
  k2 := (SELECT x.case_id FROM case_open(g2, 'ENBD', NULL, 'Card', NULL, NULL) x);
  IF k1 IS NULL OR k2 IS NULL THEN RAISE EXCEPTION 'fixture: case_open returned no case'; END IF;
  SELECT x.stage INTO st FROM cases x WHERE x.id = k1;
  IF st IS DISTINCT FROM 'Submitted' THEN RAISE EXCEPTION 'fixture: k1 opened at %, not Submitted', st; END IF;

  -- ---------- 1. no case ----------
  j := case_sync_from_submission(gen_random_uuid(), now(), '{"stage": "Approved"}');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    j = '{"applied": false, "reason": "no_case"}'::jsonb,
    format('an unknown group did not answer {applied:false, reason:no_case} (%s)', j));

  -- ---------- 2. stale ----------
  j := case_sync_from_submission(g1, now() - interval '2 days', '{"amount": 100}');
  n := n + 1; failed := failed || pg_temp.cs_ok((j ->> 'applied') = 'true',
    format('the newer update was not applied (%s)', j));
  j := case_sync_from_submission(g1, now() - interval '3 days', '{"amount": 999, "product": "Stale"}');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    j = '{"applied": false, "reason": "stale"}'::jsonb,
    format('an older changed_at after a newer one did not answer {applied:false, reason:stale} (%s)', j));
  SELECT x.amount::text || '/' || x.product INTO st FROM cases x WHERE x.id = k1;
  n := n + 1; failed := failed || pg_temp.cs_ok(st = '100.00/Mortgage',
    format('the stale update wrote to the case (amount/product %s)', st));
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT x.external_changed_at FROM cases x WHERE x.id = k1) = now() - interval '2 days',
    'the stale update moved external_changed_at');

  n := n + 1; failed := failed || pg_temp.cs_check(
    'an infinite changed_at older than the stored one was not CHANGED_AT_INVALID', NULL, NULL,
    format('SELECT case_sync_from_submission(%L, ''-infinity'', ''{"amount": 5}'')::text', g1),
    'ERROR P0001 CHANGED_AT_INVALID:%');

  -- ---------- 3. stage refusals ----------
  n := n + 1; failed := failed || pg_temp.cs_check('a stage outside the bank list was not UNKNOWN_STAGE', NULL, NULL,
    pg_temp.sync_sql(g1, '{"stage": "Nope"}'), 'ERROR P0001 UNKNOWN_STAGE:%');
  n := n + 1; failed := failed || pg_temp.cs_check('a submitted case moved to Interested (expected PRESUB_REENTRY)', NULL, NULL,
    pg_temp.sync_sql(g1, '{"stage": "Interested"}'), 'ERROR P0001 PRESUB_REENTRY:%');
  n := n + 1; failed := failed || pg_temp.cs_check('a submitted case moved to Data collection (expected PRESUB_REENTRY)', NULL, NULL,
    pg_temp.sync_sql(g1, '{"stage": "Data collection"}'), 'ERROR P0001 PRESUB_REENTRY:%');
  n := n + 1; failed := failed || pg_temp.cs_check('a submitted case moved to Review (expected PRESUB_REENTRY)', NULL, NULL,
    pg_temp.sync_sql(g1, '{"stage": "Review"}'), 'ERROR P0001 PRESUB_REENTRY:%');

  -- ---------- 4. documents ----------
  j := case_sync_from_submission(g1, now(), '{"documents": [{"key": "unknown_doc", "status": "received"},
                                                           {"key": "salary_cert", "status": "received"}]}');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (j -> 'rejected') = '[{"key": "unknown_doc", "error": "DOC_NOT_REQUIRED"}]'::jsonb,
    format('an unknown document key was not rejected DOC_NOT_REQUIRED (%s)', j -> 'rejected'));
  SELECT d.status || '/' || coalesce(d.file_ref, '-') || '/' || coalesce(d.updated_by::text, 'api') INTO st
    FROM case_documents d WHERE d.case_id = k1 AND d.doc_key = 'salary_cert';
  n := n + 1; failed := failed || pg_temp.cs_ok(st = 'received/external/api',
    format('a required document received was stored as %s, not received/external with updated_by NULL', st));
  n := n + 1; failed := failed || pg_temp.cs_ok(
    NOT EXISTS (SELECT 1 FROM case_documents d WHERE d.case_id = k1 AND d.doc_key = 'unknown_doc'),
    'the rejected document was stored');

  -- ---------- 5. details overwrite ----------
  SELECT count(*) INTO h0 FROM case_detail_log l WHERE l.case_id = k1;
  j := case_sync_from_submission(g1, now(), '{"bank": "FAB", "product": "Card", "amount": 1234.5}');
  SELECT x.bank_code || '/' || x.product || '/' || x.amount::text INTO st FROM cases x WHERE x.id = k1;
  n := n + 1; failed := failed || pg_temp.cs_ok(st = 'FAB/Card/1234.50',
    format('bank/product/amount were not overwritten (%s; %s)', st, j));
  SELECT count(*) INTO h1 FROM case_detail_log l WHERE l.case_id = k1;
  n := n + 1; failed := failed || pg_temp.cs_ok(h1 - h0 = 3 AND (
      SELECT array_agg(l.field || ':' || l.to_value ORDER BY l.field) FROM case_detail_log l
       WHERE l.case_id = k1 AND l.actor_id IS NULL AND l.actor_role = 'api' AND l.to_value IN ('FAB', 'Card', '1234.50'))
      = ARRAY['amount:1234.50', 'bank_code:FAB', 'product:Card'],
    format('the overwrite did not write one api case_detail_log row per field (%s new rows)', h1 - h0));
  n := n + 1; failed := failed || pg_temp.cs_ok(
    EXISTS (SELECT 1 FROM case_banks b WHERE b.account_id = a_acct AND b.code = 'FAB'),
    'an unknown bank from the API was not added to case_banks');

  -- ---------- 6. outbox: no endpoint, nothing queued ----------
  j := case_sync_from_submission(g1, now(), '{"stage": "Bank acknowledged"}');
  SELECT count(*) INTO h0 FROM case_stage_history h WHERE h.case_id = k1 AND h.to_stage = 'Bank acknowledged';
  SELECT count(*) INTO h1 FROM webhook_event_outbox o WHERE o.account_id = a_acct;
  n := n + 1; failed := failed || pg_temp.cs_ok(h0 = 1 AND h1 = 0,
    format('with no endpoint a stage change queued %s outbox rows (history rows %s)', h1, h0));

  INSERT INTO webhook_endpoints (account_id, url, secret, events, is_active)
  VALUES (a_acct, 'https://hooks.example.invalid/csy', 'x',
          ARRAY['case.stage_changed', 'case.lead_created', 'submission_group.ready', 'submission_group.ended',
                'contact.opted_out'], true);

  -- ---------- 7. the move to Approved ----------
  j := case_sync_from_submission(g1, now(), '{"stage": "Approved"}');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (j ->> 'applied') = 'true' AND (j ->> 'final') = 'true' AND (j ->> 'stage') = 'Approved' AND (j ->> 'outcome') = 'Approved',
    format('the move to Approved did not answer applied/final/Approved (%s)', j));
  SELECT x.outcome, x.closed_at IS NOT NULL INTO st, b1 FROM cases x WHERE x.id = k1;
  n := n + 1; failed := failed || pg_temp.cs_ok(st = 'Approved' AND b1,
    format('the move to Approved left outcome %s, closed_at set %s', st, b1));
  -- The final move on an ACTIVE group takes the group-end claim (as
  -- case_set_stage does), so the case sweeper cannot end it concurrently.
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT x.group_end_claimed_at IS NOT NULL AND x.group_end_claimed_at = (j ->> 'group_end_token')::timestamptz
       FROM cases x WHERE x.id = k1),
    format('the final move on an ACTIVE group did not take the group-end claim it returned (%s)', j));
  n := n + 1; failed := failed || pg_temp.cs_ok(
    EXISTS (SELECT 1 FROM case_stage_history h
             WHERE h.case_id = k1 AND h.to_stage = 'Approved' AND h.actor_role = 'api' AND h.actor_id IS NULL),
    'the move to Approved wrote no case_stage_history row with actor_role api and actor_id NULL');
  SELECT count(*), min(o.payload ->> 'source') INTO h0, st FROM webhook_event_outbox o
   WHERE o.account_id = a_acct AND o.event = 'case.stage_changed' AND (o.payload ->> 'case_id')::uuid = k1;
  n := n + 1; failed := failed || pg_temp.cs_ok(h0 = 1 AND st = 'compass',
    format('the API move to Approved queued %s case.stage_changed rows (source %s), not one from compass', h0, st));

  -- ---------- 8. from Approved only Closed ----------
  n := n + 1; failed := failed || pg_temp.cs_check('an Approved case moved to Under review (expected FINAL_STAGE)', NULL, NULL,
    pg_temp.sync_sql(g1, '{"stage": "Under review"}'), 'ERROR P0001 FINAL_STAGE:%');
  j := case_sync_from_submission(g1, now(), '{"stage": "Closed"}');
  SELECT x.stage INTO st FROM cases x WHERE x.id = k1;
  n := n + 1; failed := failed || pg_temp.cs_ok((j ->> 'applied') = 'true' AND st = 'Closed',
    format('an Approved case could not move to Closed (stage %s; %s)', st, j));

  -- ---------- 9. lead_created ----------
  l1 := case_open_lead(u_agent, a_acct, c3, 'ADCB', 'Card', u_agent);
  SELECT count(*) INTO h0 FROM webhook_event_outbox o
   WHERE o.account_id = a_acct AND o.event = 'case.lead_created' AND (o.payload ->> 'case_id')::uuid = l1;
  n := n + 1; failed := failed || pg_temp.cs_ok(h0 = 1,
    format('a lead insert queued %s case.lead_created rows, not one', h0));

  -- ---------- 10. the managed_externally lock ----------
  n := n + 1; failed := failed || pg_temp.cs_check('an agent changed the case settings (expected NOT_ALLOWED)', NULL, NULL,
    format('SELECT case_settings_set(%L, %L, true)::text', u_agent, a_acct), 'ERROR 42501 NOT_ALLOWED:%');
  b1 := case_settings_set(u_owner, a_acct, true);
  n := n + 1; failed := failed || pg_temp.cs_ok(b1 AND case_managed_externally(a_acct),
    'case_settings_set by the owner did not turn managed_externally on');
  n := n + 1; failed := failed || pg_temp.cs_check(
    'a person moved a submitted case while managed externally (expected MANAGED_EXTERNALLY)', NULL, NULL,
    format('SELECT moved::text FROM case_set_stage(%L, %L, ''Bank acknowledged'') x', k2, u_agent),
    'ERROR 55000 MANAGED_EXTERNALLY:%');
  n := n + 1; failed := failed || pg_temp.cs_check('a person could not move a lead while managed externally', NULL, NULL,
    format('SELECT moved::text FROM case_set_stage(%L, %L, ''Review'') x', l1, u_agent), 'true');
  j := case_sync_from_submission(g2, now(), '{"stage": "Bank acknowledged"}');
  SELECT x.stage INTO st FROM cases x WHERE x.id = k2;
  n := n + 1; failed := failed || pg_temp.cs_ok((j ->> 'applied') = 'true' AND st = 'Bank acknowledged',
    format('the API path did not move a submitted case while locked (stage %s; %s)', st, j));
  b1 := case_settings_set(u_admin, a_acct, false);
  n := n + 1; failed := failed || pg_temp.cs_check('a person could not move a submitted case with the lock off', NULL, NULL,
    format('SELECT moved::text FROM case_set_stage(%L, %L, ''Under review'') x', k2, u_agent), 'true');
  SELECT count(*), min(o.payload ->> 'source') INTO h0, st FROM webhook_event_outbox o
   WHERE o.account_id = a_acct AND o.event = 'case.stage_changed' AND (o.payload ->> 'case_id')::uuid = k2
     AND (o.payload ->> 'to_stage') = 'Under review';
  n := n + 1; failed := failed || pg_temp.cs_ok(h0 = 1 AND st = 'crm',
    format('a person''s move queued %s case.stage_changed rows (source %s), not one from crm', h0, st));

  -- ---------- 11. submission_group.ready / .ended ----------
  v_claim := sg_claim_create(g2, 60000);
  b1 := sg_attach_wa_group(g2, '120363000000134002@g.us', NULL, v_claim);
  IF NOT coalesce(b1, false) THEN RAISE EXCEPTION 'fixture: sg_attach_wa_group refused g2'; END IF;
  SELECT count(*) INTO h0 FROM webhook_event_outbox o
   WHERE o.account_id = a_acct AND o.event = 'submission_group.ready' AND (o.payload ->> 'submission_id') = 'CSY-134-2';
  n := n + 1; failed := failed || pg_temp.cs_ok(h0 = 1,
    format('wa_group_id NULL -> value queued %s submission_group.ready rows, not one', h0));
  b1 := sg_end(g2, 'test');
  IF NOT coalesce(b1, false) THEN RAISE EXCEPTION 'fixture: sg_end refused g2'; END IF;
  SELECT count(*) INTO h0 FROM webhook_event_outbox o
   WHERE o.account_id = a_acct AND o.event = 'submission_group.ended' AND (o.payload ->> 'submission_id') = 'CSY-134-2';
  n := n + 1; failed := failed || pg_temp.cs_ok(h0 = 1,
    format('status -> ENDED queued %s submission_group.ended rows, not one', h0));

  -- ---------- 12. contact.opted_out ----------
  UPDATE contacts SET opted_out_at = now() WHERE id = c4;
  SELECT count(*) INTO h0 FROM webhook_event_outbox o
   WHERE o.account_id = a_acct AND o.event = 'contact.opted_out' AND (o.payload ->> 'contact_id')::uuid = c4;
  n := n + 1; failed := failed || pg_temp.cs_ok(h0 = 1,
    format('opted_out_at NULL -> value queued %s contact.opted_out rows, not one', h0));

  -- ---------- 13. webhook_outbox_claim hands each row out once ----------
  SELECT count(*) INTO h0 FROM webhook_event_outbox o WHERE o.delivered_at IS NULL;
  v_n := 0;
  LOOP
    SELECT count(*) INTO h1 FROM webhook_outbox_claim(10);
    EXIT WHEN h1 = 0;
    v_n := v_n + h1;
    IF v_n > h0 THEN EXIT; END IF;
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_ok(h0 > 0 AND v_n = h0,
    format('webhook_outbox_claim(10) handed out %s rows of %s pending', v_n, h0));
  SELECT count(*) INTO h1 FROM webhook_outbox_claim(10);
  n := n + 1; failed := failed || pg_temp.cs_ok(h1 = 0,
    format('a second webhook_outbox_claim returned %s rows, not 0', h1));

  -- ---------- 14. compass_link_contact_by_phone ----------
  INSERT INTO compass_contacts (account_id, compass_id, name, phone)
  VALUES (a_acct, 'CSY-CMP-1', 'CSY five', '+971 50 013 4005');
  v_n := compass_link_contact_by_phone(a_acct, c5, '971500134005');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    v_n = 1 AND (SELECT cc.contact_id FROM compass_contacts cc WHERE cc.account_id = a_acct AND cc.compass_id = 'CSY-CMP-1') = c5,
    format('compass_link_contact_by_phone linked %s rows, not the matching customer', v_n));
  v_n := compass_link_contact_by_phone(a_acct, c5, '971500134005');
  n := n + 1; failed := failed || pg_temp.cs_ok(v_n = 0,
    format('a second compass_link_contact_by_phone linked %s rows, not 0', v_n));

  -- ---------- 15. grants ----------
  n := n + 1; failed := failed || pg_temp.cs_ok(
    NOT has_function_privilege('authenticated', 'public.case_sync_from_submission(uuid, timestamptz, jsonb)', 'EXECUTE'),
    'authenticated may execute case_sync_from_submission');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    NOT has_function_privilege('authenticated', 'public.webhook_outbox_claim(integer)', 'EXECUTE'),
    'authenticated may execute webhook_outbox_claim');

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT134', MESSAGE = 'verify-compass-sync rollback';
  EXCEPTION WHEN SQLSTATE 'ZT134' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'compass sync verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'compass sync verification passed (% checks)', n;
END
$verify$;
