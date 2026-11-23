-- Behavioural regression suite for the desk reminder digest (migration 234).
--
-- Off by default; switching on needs an approved utility template with
-- {{1}} and {{2}}. One digest per company per Dubai day, from the send
-- hour, each missing document once ("All banks: ..."), not again within
-- the gap nor after a document arrived, to an authorised person (else
-- the case contact), never someone opted out. The claim re-checks quiet
-- hours, opt-out and the daily cap of 3 per person; STOP after a digest
-- opts the person out. Exported and erased through the 229 registry.
--
-- ONE statement on purpose: `supabase db query --file` sends the file as
-- a single prepared statement and rejects several. Fixtures are rolled
-- back by a sentinel exception; failures are named in the final one.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000234001';
  u_agent UUID := '00000000-0000-4000-8000-000000234002';
  a_acct  UUID;
  c_own   UUID;
  c_pro   UUID;
  cv_own  UUID;
  cv_pro  UUID;
  cu_kite UUID;
  m_c     UUID[] := '{}';
  m_cu    UUID[] := '{}';
  cid     UUID;
  cuid    UUID;
  i       INT;
  today   DATE := (now() AT TIME ZONE 'Asia/Dubai')::date;
  t07     TIMESTAMPTZ;
  t10     TIMESTAMPTZ;
  t22     TIMESTAMPTZ;
  q       UUID;
  r       RECORD;
  j       JSONB;
  v       TEXT;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  t07 := (today::timestamp + interval '7 hours') AT TIME ZONE 'Asia/Dubai';
  t10 := (today::timestamp + interval '10 hours') AT TIME ZONE 'Asia/Dubai';
  t22 := (today::timestamp + interval '22 hours') AT TIME ZONE 'Asia/Dubai';
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.dg_try(p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; h text;
    BEGIN
      EXECUTE p_sql INTO v;
      RETURN coalesce(v, 'ok');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
      RETURN 'ERROR ' || SQLSTATE || ' ' || coalesce(nullif(h, ''), '-') || ': ' || SQLERRM;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.dg_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.dg_as(p_role text, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        EXECUTE format('SET LOCAL ROLE %I', p_role);
        EXECUTE p_sql INTO v;
        RESET ROLE;
        RETURN coalesce(v, 'ok');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        RETURN 'ERROR ' || SQLSTATE;
      END;
    END $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'ddg-owner@example.invalid'), (u_agent, 'ddg-agent@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500234001', 'DG kite')
    RETURNING id INTO c_own;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500234002', 'DG pro')
    RETURNING id INTO c_pro;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_agent, c_own) RETURNING id INTO cv_own;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_agent, c_pro) RETURNING id INTO cv_pro;
  INSERT INTO case_banks (account_id, code, name) VALUES
    (a_acct, 'RAK', 'RAKBANK'), (a_acct, 'ENBD', 'Emirates NBD')
  ON CONFLICT DO NOTHING;
  INSERT INTO case_file_specs (account_id, bank_code, product, doc_key, position, name_pattern, required) VALUES
    (a_acct, 'RAK', 'Business account', 'trade_licence', 1, '{{doc}}', true),
    (a_acct, 'RAK', 'Business account', 'ejari', 2, '{{doc}}', true),
    (a_acct, 'ENBD', 'Business account', 'trade_licence', 1, '{{doc}}', true),
    (a_acct, 'ENBD', 'Business account', 'ejari', 2, '{{doc}}', true),
    (a_acct, 'ENBD', 'Business account', 'kyc_form', 3, '{{doc}}', true);
  INSERT INTO message_templates (account_id, user_id, name, category, language, body_text, status) VALUES
    (a_acct, u_owner, 'desk_digest', 'Utility', 'en',
     'Application {{1}}: still needed: {{2}}. Reply STOP to pause reminders.', 'APPROVED'),
    (a_acct, u_owner, 'promo', 'Marketing', 'en', 'Hi {{1}} {{2}}', 'APPROVED');
  PERFORM desk_bank_code_set(u_owner, a_acct, 'RAK', 'RAK');
  PERFORM desk_bank_code_set(u_owner, a_acct, 'ENBD', 'ENB');
  SELECT x.customer_id INTO cu_kite
    FROM desk_case_open(a_acct, 'DG-1', 'Kite General Trading', 'RAK', 'Business account', c_own, u_agent, NULL, now()) x;
  PERFORM desk_case_open(a_acct, 'DG-1', NULL, 'ENBD', 'Business account', c_own, u_agent, NULL, now());

  -- ---------- 1. off by default; switching on ----------
  PERFORM desk_digest_enqueue(t10);
  n := n + 1; failed := failed || pg_temp.dg_ok(NOT EXISTS (SELECT 1 FROM desk_digest_outbox o WHERE o.account_id = a_acct),
    'a digest was queued while switched off');
  n := n + 1; failed := failed || pg_temp.dg_ok(pg_temp.dg_try(format(
    'SELECT desk_digest_settings_set(%L, %L, true, ''desk_digest'', ''en'', 10, 2)::text', u_agent, a_acct))
    LIKE 'ERROR % NOT_ALLOWED:%', 'an agent switched the digest on');
  n := n + 1; failed := failed || pg_temp.dg_ok(pg_temp.dg_try(format(
    'SELECT desk_digest_settings_set(%L, %L, true, ''promo'', ''en'', 10, 2)::text', u_owner, a_acct))
    LIKE 'ERROR % TEMPLATE_INVALID:%', 'a marketing template was accepted');
  PERFORM desk_digest_settings_set(u_owner, a_acct, true, 'desk_digest', 'en', 10, 2);

  -- ---------- 2. enqueue: the hour, one a day, the summary ----------
  PERFORM desk_digest_enqueue(t07);
  n := n + 1; failed := failed || pg_temp.dg_ok(NOT EXISTS (SELECT 1 FROM desk_digest_outbox o WHERE o.account_id = a_acct),
    'a digest was queued before the send hour');
  PERFORM desk_digest_enqueue(t10);
  PERFORM desk_digest_enqueue(t10 + interval '1 hour');
  SELECT o.* INTO r FROM desk_digest_outbox o WHERE o.customer_id = cu_kite;
  q := r.id;
  n := n + 1; failed := failed || pg_temp.dg_ok(
    (SELECT count(*) FROM desk_digest_outbox o WHERE o.customer_id = cu_kite) = 1
    AND r.summary = 'All banks: Trade Licence, Ejari. ENBD: Kyc Form',
    format('the digest is not one a day with each document once (%s)', r.summary));
  n := n + 1; failed := failed || pg_temp.dg_ok(r.pending = 3 AND r.contact_id = c_own AND r.conversation_id = cv_own
    AND r.app_number LIKE 'TC-%', 'the digest did not go to the case contact''s chat with its application number');
  PERFORM desk_digest_enqueue(t10 + interval '1 day');
  n := n + 1; failed := failed || pg_temp.dg_ok(
    (SELECT count(*) FROM desk_digest_outbox o WHERE o.customer_id = cu_kite) = 1,
    'a second digest was queued within the gap');

  -- ---------- 3. claim: quiet hours, then send ----------
  n := n + 1; failed := failed || pg_temp.dg_ok(
    (SELECT count(*) FROM desk_digest_claim(t22) x) = 0
    AND (SELECT o.status FROM desk_digest_outbox o WHERE o.id = q) = 'queued',
    'a digest was claimed in quiet hours');
  SELECT x.* INTO r FROM desk_digest_claim(t10) x WHERE x.id = q;
  n := n + 1; failed := failed || pg_temp.dg_ok(r.template_name = 'desk_digest'
    AND (SELECT o.status FROM desk_digest_outbox o WHERE o.id = q) = 'sending',
    'a due digest was not claimed with its template');
  n := n + 1; failed := failed || pg_temp.dg_ok(desk_digest_mark(q, 'sent', 'wamid.1', NULL, NULL, t10),
    'marking a claimed digest sent failed');
  n := n + 1; failed := failed || pg_temp.dg_ok(NOT desk_digest_mark(q, 'failed', NULL, NULL, 'late', t10),
    'a sent digest was marked again');

  -- ---------- 4. the daily cap of 3 per person ----------
  FOR i IN 1..4 LOOP
    INSERT INTO contacts (account_id, user_id, phone, name)
    VALUES (a_acct, u_agent, '97150023410' || i, 'DG m' || i) RETURNING id INTO cid;
    SELECT x.customer_id INTO cuid
      FROM desk_case_open(a_acct, 'DG-M' || i, 'Maro ' || i, 'RAK', 'Business account', cid, u_agent, NULL, now()) x;
    PERFORM desk_customer_contact_set(u_owner, a_acct, cuid, c_pro, 'pro', true);
    m_c := m_c || cid;
    m_cu := m_cu || cuid;
  END LOOP;
  PERFORM desk_digest_enqueue(t10);
  n := n + 1; failed := failed || pg_temp.dg_ok(
    (SELECT count(*) FROM desk_digest_outbox o WHERE o.contact_id = c_pro) = 4,
    'an authorised PRO was not the recipient of each company''s digest');
  PERFORM desk_digest_claim(t10);
  n := n + 1; failed := failed || pg_temp.dg_ok(
    (SELECT count(*) FROM desk_digest_outbox o WHERE o.contact_id = c_pro AND o.status = 'sending') = 3
    AND (SELECT count(*) FROM desk_digest_outbox o WHERE o.contact_id = c_pro AND o.status_reason = 'daily_cap') = 1,
    'the daily cap of 3 per person did not hold');

  -- ---------- 5. STOP and opt-out ----------
  n := n + 1; failed := failed || pg_temp.dg_ok(NOT desk_digest_stop(a_acct, m_c[1], t10),
    'STOP opted out someone who never received a digest');
  n := n + 1; failed := failed || pg_temp.dg_ok(desk_digest_stop(a_acct, c_own, t10),
    'STOP after a digest did not opt the person out');
  n := n + 1; failed := failed || pg_temp.dg_ok(
    (SELECT c.opted_out_at IS NOT NULL FROM contacts c WHERE c.id = c_own),
    'the opt-out was not recorded on the contact');
  DELETE FROM desk_digest_outbox o WHERE o.customer_id = cu_kite;
  PERFORM desk_digest_enqueue(t10 + interval '3 days');
  n := n + 1; failed := failed || pg_temp.dg_ok(NOT EXISTS (SELECT 1 FROM desk_digest_outbox o WHERE o.customer_id = cu_kite),
    'a digest was queued for someone opted out');
  -- An opt-out after queueing is caught at claim.
  UPDATE desk_digest_outbox o SET status = 'queued', status_reason = NULL
   WHERE o.customer_id = m_cu[4] AND o.local_day = today;
  UPDATE contacts SET opted_out_at = now() WHERE id = c_pro;
  PERFORM desk_digest_claim(t10);
  n := n + 1; failed := failed || pg_temp.dg_ok(
    (SELECT o.status_reason FROM desk_digest_outbox o WHERE o.customer_id = m_cu[4] AND o.local_day = today) = 'opted_out',
    'a queued digest went to someone who opted out since');

  -- ---------- 6. a document resets the rhythm; switching off ----------
  UPDATE contacts SET opted_out_at = NULL WHERE id IN (c_own, c_pro);
  DELETE FROM desk_digest_outbox o WHERE o.account_id = a_acct;
  INSERT INTO messages (conversation_id, sender_type, content_type, media_url)
  VALUES (cv_own, 'customer', 'document', 'https://x.invalid/dg.pdf');
  PERFORM customer_documents_record(a_acct, c_own, 'chat', 'document', 'https://x.invalid/dg.pdf', now(), cv_own,
    (SELECT m.id FROM messages m WHERE m.media_url = 'https://x.invalid/dg.pdf'), NULL, 'application/pdf', 'x.pdf', NULL);
  PERFORM desk_digest_enqueue(t10);
  -- The other companies (no document) are queued; Kite (a document) is not.
  n := n + 1; failed := failed || pg_temp.dg_ok(NOT EXISTS (SELECT 1 FROM desk_digest_outbox o WHERE o.customer_id = cu_kite)
    AND EXISTS (SELECT 1 FROM desk_digest_outbox o WHERE o.customer_id = m_cu[1]),
    'a digest was queued the day a document arrived (or none at all)');
  PERFORM desk_digest_settings_set(u_owner, a_acct, false, 'desk_digest', 'en', 10, 2);
  n := n + 1; failed := failed || pg_temp.dg_ok(NOT EXISTS (SELECT 1 FROM desk_digest_outbox o
    WHERE o.account_id = a_acct AND o.status = 'queued'), 'switching off left digests queued');

  -- ---------- 7. privacy and closed tables ----------
  j := privacy_subject_export(u_owner, a_acct, c_pro);
  n := n + 1; failed := failed || pg_temp.dg_ok(jsonb_array_length(j->'data'->'desk_reminders') >= 1,
    'the export did not carry the person''s digests');
  n := n + 1; failed := failed || pg_temp.dg_ok(pg_temp.dg_as('authenticated',
    'SELECT count(*)::text FROM public.desk_digest_outbox') LIKE 'ERROR 42501', 'authenticated read desk_digest_outbox');
  n := n + 1; failed := failed || pg_temp.dg_ok(pg_temp.dg_as('service_role',
    'SELECT count(*)::text FROM public.desk_digest_settings') LIKE 'ERROR 42501', 'service_role read desk_digest_settings');
  n := n + 1; failed := failed || pg_temp.dg_ok(pg_temp.dg_as('authenticated',
    'SELECT count(*)::text FROM desk_digest_claim()') LIKE 'ERROR 42501', 'authenticated called desk_digest_claim');

  -- 263: a STOP counts while a digest is being sent or after a feedback
  -- request, and cancels the waiting ones; the template's language.
  DECLARE t_ct uuid; t_case uuid; t_cv uuid; t_hit boolean; t_ref boolean := false; t_j263 text;
  BEGIN
    SELECT k.id INTO t_case FROM cases k WHERE k.account_id = a_acct LIMIT 1;
    INSERT INTO contacts (account_id, user_id, phone, name)
      VALUES (a_acct, u_owner, '971502630004', 'T263') RETURNING id INTO t_ct;
    DELETE FROM case_csat_requests WHERE case_id = t_case;
    INSERT INTO case_csat_requests (account_id, case_id, trigger, contact_id, stage, status) VALUES
      (a_acct, t_case, 'submitted', t_ct, 'Submitted', 'sending'),
      (a_acct, t_case, 'approved', t_ct, 'Approved', 'held');
    t_hit := desk_digest_stop(a_acct, t_ct);
  n := n + 1;
  IF (t_hit AND (SELECT x.opted_out_at IS NOT NULL FROM contacts x WHERE x.id = t_ct) AND (SELECT q.status_reason = 'opted_out' AND q.status = 'cancelled' FROM case_csat_requests q WHERE q.case_id = t_case AND q.trigger = 'approved')) IS NOT TRUE THEN failed := array_append(failed, '263: a STOP after a feedback request was not honoured'::text); END IF;
    UPDATE desk_digest_outbox o SET status = 'sending', status_reason = NULL, created_at = now()
     WHERE o.id = (SELECT x.id FROM desk_digest_outbox x WHERE x.account_id = a_acct LIMIT 1)
     RETURNING o.contact_id INTO t_ct;
    DELETE FROM desk_digest_outbox o WHERE o.contact_id = t_ct AND o.status <> 'sending';
    UPDATE contacts SET opted_out_at = NULL WHERE id = t_ct;
    t_hit := desk_digest_stop(a_acct, t_ct);
  n := n + 1;
  IF (t_ct IS NOT NULL AND t_hit) IS NOT TRUE THEN failed := array_append(failed, '263: a STOP during the send was not honoured'::text); END IF;
    BEGIN
      PERFORM desk_digest_settings_set(u_owner, a_acct, true, 'desk_digest', 'ar', 10, 2);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS t_j263 = PG_EXCEPTION_HINT;
      t_ref := t_j263 = 'TEMPLATE_INVALID';
    END;
  n := n + 1;
  IF (t_ref) IS NOT TRUE THEN failed := array_append(failed, '263: a template approved only in English was accepted in Arabic'::text); END IF;
  END;

  RAISE EXCEPTION USING ERRCODE = 'ZT234', MESSAGE = 'verify-desk-reminder-digest rollback';
  EXCEPTION WHEN SQLSTATE 'ZT234' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'desk reminder digest verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'desk reminder digest verification passed (% checks)', n;
END
$verify$;
