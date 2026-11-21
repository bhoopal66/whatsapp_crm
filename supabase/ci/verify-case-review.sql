-- Behavioural regression suite for the case file reviewer (migration 225).
--
-- Off by default: a passed file queues nothing until an owner or admin
-- turns the reviewer on, and the model needs the reviewer on. A passed
-- file queues its case 60 s out (debounced); a claim takes due cases and
-- takes back a stale running one; three failures end it. Drafts are
-- idempotent on their input hash, a new one supersedes the pending one,
-- readers of the case list them, writers decide once.
--
-- ONE statement on purpose: `supabase db query --file` sends the file as
-- a single prepared statement and rejects several. Fixtures are rolled
-- back by a sentinel exception; failures are named in the final one.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000225001';
  u_agent  UUID := '00000000-0000-4000-8000-000000225002';
  u_other  UUID := '00000000-0000-4000-8000-000000225003';
  a_acct   UUID;
  c1       UUID;
  k1       UUID;
  d1       UUID;
  d2       UUID;
  f1       UUID;
  f2       UUID;
  r        RECORD;
  v        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cr_try(p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; h text;
    BEGIN
      BEGIN
        IF p_sql ILIKE 'select%' THEN EXECUTE p_sql INTO v; ELSE EXECUTE p_sql; END IF;
        RETURN coalesce(v, 'ok');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
        RETURN 'ERROR ' || SQLSTATE || ' ' || coalesce(nullif(h, ''), '-') || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cr_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  -- A staff-uploaded file on the case, then passed.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cr_file(p_account uuid, p_contact uuid, p_case uuid, p_actor uuid, p_name text)
    RETURNS uuid LANGUAGE plpgsql AS $body$
    DECLARE v_doc uuid; v_file uuid;
    BEGIN
      SELECT r.document_id INTO v_doc FROM customer_documents_record_internal(p_account, p_contact, 'staff_upload',
        'document', 'case-files', 'cases/' || p_case || '/' || p_name, now(), 'application/pdf', p_name, p_case, p_actor) r;
      INSERT INTO case_document_files (account_id, case_id, customer_document_id, registered_by)
      VALUES (p_account, p_case, v_doc, p_actor) RETURNING id INTO v_file;
      RETURN v_file;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cr_pass(p_file uuid, p_key text)
    RETURNS void LANGUAGE sql AS $body$
      UPDATE case_document_files SET doc_key = p_key, version = 1, renamed_name = 'x.pdf',
             classified_at = now(), status = 'passed', checks = '[]'::jsonb
       WHERE id = p_file
    $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'cr-owner@example.invalid'), (u_agent, 'cr-agent@example.invalid'), (u_other, 'cr-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agent, u_other);
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500225001', 'CR one')
    RETURNING id INTO c1;
  INSERT INTO case_banks (account_id, code, name) VALUES (a_acct, 'CRB', 'CR Bank') ON CONFLICT DO NOTHING;
  k1 := case_open_lead(u_agent, a_acct, c1, 'CRB', 'Card', u_agent);

  -- ---------- settings ----------
  n := n + 1; failed := failed || pg_temp.cr_ok(
    pg_temp.cr_try(format('SELECT review_enabled::text FROM case_settings_set_review(%L, %L, true, false)', u_agent, a_acct))
      LIKE 'ERROR % NOT_ALLOWED:%', 'an agent switched the reviewer on');
  n := n + 1; failed := failed || pg_temp.cr_ok(
    pg_temp.cr_try(format('SELECT review_enabled::text FROM case_settings_set_review(%L, %L, false, true)', u_owner, a_acct))
      LIKE 'ERROR % SETTING_INVALID:%', 'the model was switched on without the reviewer');

  -- ---------- off: nothing queued ----------
  f1 := pg_temp.cr_file(a_acct, c1, k1, u_agent, 'a.pdf');
  PERFORM pg_temp.cr_pass(f1, 'passport');
  n := n + 1; failed := failed || pg_temp.cr_ok(
    NOT EXISTS (SELECT 1 FROM case_review_queue WHERE case_id = k1), 'a passed file queued a review with the reviewer off');

  -- ---------- on: debounced queue, claim, retries ----------
  PERFORM case_settings_set_review(u_owner, a_acct, true, false);
  f2 := pg_temp.cr_file(a_acct, c1, k1, u_agent, 'b.pdf');
  PERFORM pg_temp.cr_pass(f2, 'trade_licence');
  n := n + 1; failed := failed || pg_temp.cr_ok(
    (SELECT due_at BETWEEN now() + interval '50 seconds' AND now() + interval '70 seconds' AND state = 'queued'
       FROM case_review_queue WHERE case_id = k1), 'a passed file did not queue its case 60 s out');
  n := n + 1; failed := failed || pg_temp.cr_ok(
    (SELECT count(*) FROM case_review_claim(20)) = 0, 'a case was claimed before it was due');
  UPDATE case_review_queue SET due_at = now() - interval '1 second' WHERE case_id = k1;
  SELECT * INTO r FROM case_review_claim(20) x WHERE x.case_id = k1;
  n := n + 1; failed := failed || pg_temp.cr_ok(r.attempts = 1
    AND (SELECT state FROM case_review_queue WHERE case_id = k1) = 'running', 'a due case was not claimed');
  PERFORM case_review_finish(k1, false, 'model timeout');
  n := n + 1; failed := failed || pg_temp.cr_ok(
    (SELECT state = 'queued' AND due_at > now() FROM case_review_queue WHERE case_id = k1), 'a failed review was not retried later');
  UPDATE case_review_queue SET due_at = now() - interval '1 second' WHERE case_id = k1;
  PERFORM case_review_claim(20);
  -- A running row older than 15 minutes is taken back.
  UPDATE case_review_queue SET claimed_at = now() - interval '16 minutes' WHERE case_id = k1;
  SELECT * INTO r FROM case_review_claim(20) x WHERE x.case_id = k1;
  n := n + 1; failed := failed || pg_temp.cr_ok(r.attempts = 3, 'a stale running review was not taken back');
  PERFORM case_review_finish(k1, false, 'again');
  n := n + 1; failed := failed || pg_temp.cr_ok(
    (SELECT state FROM case_review_queue WHERE case_id = k1) = 'failed', 'three failures did not end the review');

  -- ---------- drafts ----------
  SELECT x.draft_id INTO d1 FROM case_review_draft_create(k1,
    '{"checklist": [], "flags": [], "narrative": "1 of 1"}', 'deterministic', repeat('a', 64)) x;
  n := n + 1; failed := failed || pg_temp.cr_ok(
    (SELECT x.draft_id = d1 AND NOT x.created FROM case_review_draft_create(k1,
       '{"checklist": [], "flags": [], "narrative": "1 of 1"}', 'deterministic', repeat('a', 64)) x),
    'the same inputs made a second draft');
  SELECT x.draft_id INTO d2 FROM case_review_draft_create(k1,
    '{"checklist": [], "flags": [], "narrative": "changed"}', 'model', repeat('b', 64)) x;
  n := n + 1; failed := failed || pg_temp.cr_ok(
    (SELECT status FROM case_review_drafts WHERE id = d1) = 'superseded'
    AND (SELECT count(*) FROM case_review_drafts WHERE case_id = k1 AND status = 'pending') = 1,
    'a new draft did not supersede the pending one');
  n := n + 1; failed := failed || pg_temp.cr_ok(
    pg_temp.cr_try(format('SELECT count(*)::text FROM case_review_drafts_list(%L, %L)', u_agent, k1)) = '2',
    'the case''s agent could not list its drafts');
  n := n + 1; failed := failed || pg_temp.cr_ok(
    pg_temp.cr_try(format('SELECT count(*)::text FROM case_review_drafts_list(%L, %L)', u_other, k1)) LIKE 'ERROR % CASE_NOT_FOUND:%',
    'someone with no access listed the drafts');
  n := n + 1; failed := failed || pg_temp.cr_ok(
    pg_temp.cr_try(format('SELECT case_review_draft_decide(%L, %L, %L, true)', u_other, k1, d2)) LIKE 'ERROR % CASE_NOT_FOUND:%',
    'someone with no access decided a draft');
  -- The write first, its effect in a separate statement (snapshot).
  v := case_review_draft_decide(u_agent, k1, d2, true);
  n := n + 1; failed := failed || pg_temp.cr_ok(v = 'approved'
    AND (SELECT decided_by FROM case_review_drafts WHERE id = d2) = u_agent, 'the case''s agent could not approve');
  n := n + 1; failed := failed || pg_temp.cr_ok(
    pg_temp.cr_try(format('SELECT case_review_draft_decide(%L, %L, %L, false)', u_owner, k1, d2)) LIKE 'ERROR % ALREADY_DECIDED:%',
    'a decided draft was decided again');
  n := n + 1; failed := failed || pg_temp.cr_ok(
    pg_temp.cr_try(format('SELECT case_review_draft_decide(%L, %L, %L, false)', u_owner, k1, d1)) LIKE 'ERROR % ALREADY_DECIDED:%',
    'a superseded draft was decided');
  n := n + 1; failed := failed || pg_temp.cr_ok(
    pg_temp.cr_try('SET LOCAL ROLE authenticated; SELECT count(*)::text FROM case_review_drafts') LIKE 'ERROR 42501%',
    'authenticated read the drafts table');
  RESET ROLE;

  RAISE EXCEPTION USING ERRCODE = 'ZT225', MESSAGE = 'verify-case-review rollback';
  EXCEPTION WHEN SQLSTATE 'ZT225' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'case review verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'case review verification passed (% checks)', n;
END
$verify$;
