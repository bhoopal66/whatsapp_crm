-- Behavioural regression suite for the WhatsApp document intake prompts
-- (migration 183).
--
-- Off by default: nothing records while files_intake_prompts is off
-- (INTAKE_OFF) or the document_classify wording is unapproved; the
-- wording (owner/admin set, a changed body resets approval, only an owner
-- approves and never their own edit, get is NULL until approved, the
-- audit); record (FILE_NOT_FOUND, FILE_STATE, PROMPT_INVALID,
-- CASE_CLOSED, one open prompt per case, a new record supersedes);
-- answer (once, PROMPT_STALE, PROMPT_OPTION, PROMPT_NOT_FOUND, a file
-- staff classified makes the prompt stale); MANAGED_EXTERNALLY (the
-- intake neither registers, classifies, records nor answers on a case
-- Compass manages); the prompts guard; privileges.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The fixtures are
-- rolled back on success too (a sentinel exception ends the block).

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000183001';
  u_admin  UUID := '00000000-0000-4000-8000-000000183002';
  u_coord  UUID := '00000000-0000-4000-8000-000000183003';
  u_agent  UUID := '00000000-0000-4000-8000-000000183004';
  u_other  UUID := '00000000-0000-4000-8000-000000183005';  -- owner of another workspace
  a_acct   UUID;
  o_acct   UUID;
  wa       UUID;
  ca       UUID;
  k1 UUID; k2 UUID; k3 UUID;
  f1 UUID; f2 UUID; f3 UUID; f4 UUID; f_staff UUID; f_k2 UUID; f_k3 UUID;
  p1 UUID; p2 UUID; p3 UUID; p4 UUID;
  opts     JSONB := '[{"n": 1, "doc_key": "passport", "label": "Passport"},
                      {"n": 2, "doc_key": "emirates_id", "label": "Emirates ID"}]';
  q        RECORD;
  r        TEXT;
  rl       TEXT;
  fn       TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ci_try(p_role text, p_uid uuid, p_sql text)
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
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ci_check(p_name text, p_role text, p_uid uuid, p_sql text, p_like text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := pg_temp.ci_try(p_role, p_uid, p_sql);
    BEGIN
      RETURN CASE WHEN v LIKE p_like THEN NULL ELSE p_name || ' (' || v || ')' END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ci_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  -- A document the customer sent into the case's group (source
  -- submission_group, in the contact's folder), registered by the system
  -- intake (NULL actor); returns the file id.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ci_customer_file(p_case uuid)
    RETURNS uuid LANGUAGE plpgsql AS $body$
    DECLARE v_c public.cases%ROWTYPE; v_staff uuid; v_doc uuid;
    BEGIN
      SELECT * INTO v_c FROM public.cases WHERE id = p_case;
      SELECT x.document_id INTO v_staff FROM public.customer_documents_record_internal(v_c.account_id, v_c.contact_id,
        'staff_upload', 'document', 'case-files', 'v183/' || gen_random_uuid()::text || '.pdf', now(),
        'application/pdf', 'scan.pdf', NULL, (SELECT k.user_id FROM public.contacts k WHERE k.id = v_c.contact_id)) x;
      INSERT INTO public.customer_documents (account_id, folder_id, contact_id, source, kind, mime, original_name,
        media_url, received_at)
      SELECT d.account_id, d.folder_id, d.contact_id, 'submission_group', 'document', 'application/pdf', 'sent.pdf',
             'https://example.invalid/v183/' || gen_random_uuid()::text || '.pdf', now()
        FROM public.customer_documents d WHERE d.id = v_staff
      RETURNING id INTO v_doc;
      RETURN public.case_document_file_register(NULL, p_case, v_doc);
    END $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'ci-owner@example.invalid'),
    (u_admin, 'ci-admin@example.invalid'),
    (u_coord, 'ci-coord@example.invalid'),
    (u_agent, 'ci-agent@example.invalid'),
    (u_other, 'ci-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO o_acct FROM profiles WHERE user_id = u_other;
  IF a_acct IS NULL OR o_acct IS NULL OR a_acct = o_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision two accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_coord, u_agent);

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'CI-183-A1', 'x', 'connected', true) RETURNING id INTO wa;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500183001', 'CI one')
    RETURNING id INTO ca;
  FOR q IN SELECT * FROM (VALUES (1, 'CI-183-1'), (2, 'CI-183-2'), (3, 'CI-183-3')) v(i, ref) LOOP
    k3 := (SELECT x.case_id FROM case_open(
      (SELECT x.group_id FROM sg_open(a_acct, q.ref, ca, wa, 'case intake', NULL,
         jsonb_build_array(jsonb_build_object('user_id', u_coord, 'label', 'coordinator'),
                           jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL) x),
      'ADCB', 'ADCB Bank', 'Loan', 1000, NULL) x);
    IF k3 IS NULL THEN
      RAISE EXCEPTION 'fixture: sg_open / case_open returned nothing for %', q.ref;
    END IF;
    CASE q.i WHEN 1 THEN k1 := k3; WHEN 2 THEN k2 := k3; ELSE NULL; END CASE;
  END LOOP;
  INSERT INTO case_doc_requirements (account_id, bank_code, product, doc_key, label, position) VALUES
    (a_acct, 'ADCB', 'Loan', 'passport', 'Passport', 1),
    (a_acct, 'ADCB', 'Loan', 'emirates_id', 'Emirates ID', 2);
  f1 := pg_temp.ci_customer_file(k1);
  f2 := pg_temp.ci_customer_file(k1);
  f3 := pg_temp.ci_customer_file(k1);
  f4 := pg_temp.ci_customer_file(k1);
  f_k2 := pg_temp.ci_customer_file(k2);
  f_k3 := pg_temp.ci_customer_file(k3);
  f_staff := public.case_document_file_register(u_agent, k1,
    (SELECT x.document_id FROM customer_documents_record_internal(a_acct, ca, 'staff_upload', 'document',
       'case-files', 'v183/' || gen_random_uuid()::text || '.pdf', now(), 'application/pdf', 'scan.pdf', NULL,
       u_owner) x));

  -- ---------- 1. off by default ----------
  n := n + 1; failed := failed || pg_temp.ci_ok(
    NOT (SELECT files_intake_prompts FROM case_files_settings(a_acct)),
    'files_intake_prompts is not off by default');
  n := n + 1; failed := failed || pg_temp.ci_ok(case_intake_template_get(a_acct, 'document_classify') IS NULL,
    'template get returned a body with no wording stored');
  n := n + 1; failed := failed || pg_temp.ci_check('a prompt was recorded with no approved wording and the intake off',
    NULL, NULL, format('SELECT case_intake_prompt_record(%L, %L, %L)::text', k1, f1, opts), 'ERROR 23514 INTAKE_OFF%');

  -- ---------- 2. wording ----------
  n := n + 1; failed := failed || pg_temp.ci_check('an agent set intake wording', NULL, NULL,
    format('SELECT case_intake_template_set(%L, %L, %L, %L)::text', u_agent, a_acct, 'document_classify', 'Hi'),
    'ERROR 42501 NOT_ALLOWED%');
  n := n + 1; failed := failed || pg_temp.ci_check('an owner of another workspace set this one''s wording', NULL, NULL,
    format('SELECT case_intake_template_set(%L, %L, %L, %L)::text', u_other, a_acct, 'document_classify', 'Hi'),
    'ERROR 42501 NOT_ALLOWED%');
  n := n + 1; failed := failed || pg_temp.ci_check('an unknown kind was accepted', NULL, NULL,
    format('SELECT case_intake_template_set(%L, %L, %L, %L)::text', u_admin, a_acct, 'document_other', 'Hi'),
    'ERROR 23514 TEMPLATE_INVALID%');
  n := n + 1; failed := failed || pg_temp.ci_check('a blank body was accepted', NULL, NULL,
    format('SELECT case_intake_template_set(%L, %L, %L, %L)::text', u_admin, a_acct, 'document_classify', E' \t\n'),
    'ERROR 23514 TEMPLATE_INVALID%');
  n := n + 1; failed := failed || pg_temp.ci_check('a 1001-character body was accepted', NULL, NULL,
    format('SELECT case_intake_template_set(%L, %L, %L, %L)::text', u_admin, a_acct, 'document_classify',
           repeat('x', 1001)), 'ERROR 23514 TEMPLATE_INVALID%');
  n := n + 1; failed := failed || pg_temp.ci_check('an admin could not set wording', NULL, NULL,
    format('SELECT case_intake_template_set(%L, %L, %L, %L)::text', u_admin, a_acct, 'document_classify',
           'Taamul: Reply with the number of the document you just sent:'), 'false');
  n := n + 1; failed := failed || pg_temp.ci_ok(case_intake_template_get(a_acct, 'document_classify') IS NULL,
    'template get returned unapproved wording');
  n := n + 1; failed := failed || pg_temp.ci_check('an admin approved wording', NULL, NULL,
    format('SELECT case_intake_template_approve(%L, %L, %L)::text', u_admin, a_acct, 'document_classify'),
    'ERROR 42501 NOT_ALLOWED%');
  n := n + 1; failed := failed || pg_temp.ci_check('an owner of another workspace approved this one''s wording', NULL,
    NULL, format('SELECT case_intake_template_approve(%L, %L, %L)::text', u_other, a_acct, 'document_classify'),
    'ERROR 42501 NOT_ALLOWED%');
  n := n + 1; failed := failed || pg_temp.ci_check('approving missing wording was not TEMPLATE_NOT_FOUND', NULL, NULL,
    format('SELECT case_intake_template_approve(%L, %L, %L)::text', u_owner, a_acct, 'document_rejected'),
    'ERROR P0002 TEMPLATE_NOT_FOUND%');
  n := n + 1; failed := failed || pg_temp.ci_check('the owner could not approve an admin''s wording', NULL, NULL,
    format('SELECT case_intake_template_approve(%L, %L, %L)::text', u_owner, a_acct, 'document_classify'), 'true');
  n := n + 1; failed := failed || pg_temp.ci_ok(
    case_intake_template_get(a_acct, 'document_classify') = 'Taamul: Reply with the number of the document you just sent:'
    AND (SELECT approved_by = u_owner AND approved_at IS NOT NULL FROM case_intake_templates
          WHERE account_id = a_acct AND kind = 'document_classify'),
    'template get does not return approved wording, or the approval is not stamped');
  n := n + 1; failed := failed || pg_temp.ci_check('setting the same body again cleared the approval', NULL, NULL,
    format('SELECT case_intake_template_set(%L, %L, %L, %L)::text', u_admin, a_acct, 'document_classify',
           'Taamul: Reply with the number of the document you just sent:'), 'true');
  n := n + 1; failed := failed || pg_temp.ci_check('a changed body kept its approval', NULL, NULL,
    format('SELECT case_intake_template_set(%L, %L, %L, %L)::text', u_admin, a_acct, 'document_classify',
           'Taamul: Which document did you just send?'), 'false');
  n := n + 1; failed := failed || pg_temp.ci_ok(case_intake_template_get(a_acct, 'document_classify') IS NULL
    AND (SELECT NOT approved AND approved_by IS NULL AND approved_at IS NULL FROM case_intake_templates
          WHERE account_id = a_acct AND kind = 'document_classify'),
    'a changed body is still served or still marked approved');
  PERFORM case_intake_template_set(u_owner, a_acct, 'document_classify', 'Taamul: Reply with the number:');
  n := n + 1; failed := failed || pg_temp.ci_check('an owner approved their own edit', NULL, NULL,
    format('SELECT case_intake_template_approve(%L, %L, %L)::text', u_owner, a_acct, 'document_classify'),
    'ERROR 42501 SELF_APPROVAL%');
  PERFORM case_intake_template_set(u_admin, a_acct, 'document_classify', 'Taamul: Reply with the number of the document:');
  PERFORM case_intake_template_approve(u_owner, a_acct, 'document_classify');
  n := n + 1; failed := failed || pg_temp.ci_ok(
    (SELECT array_agg(action || ':' || actor::text ORDER BY at, id) FILTER (WHERE true) IS NOT NULL
            AND count(*) FILTER (WHERE action = 'set') = 4 AND count(*) FILTER (WHERE action = 'approve') = 2
       FROM case_intake_template_audit WHERE account_id = a_acct AND kind = 'document_classify'),
    'the audit is not one row per change and approval');
  n := n + 1; failed := failed || pg_temp.ci_check('the template audit was updated', NULL, NULL,
    format('UPDATE case_intake_template_audit SET body = %L WHERE account_id = %L', 'x', a_acct), 'ERROR 42501 %');

  -- ---------- 3. record ----------
  n := n + 1; failed := failed || pg_temp.ci_check('a prompt was recorded with approved wording but the intake off',
    NULL, NULL, format('SELECT case_intake_prompt_record(%L, %L, %L)::text', k1, f1, opts), 'ERROR 23514 INTAKE_OFF%');
  n := n + 1; failed := failed || pg_temp.ci_ok(NOT EXISTS (SELECT 1 FROM case_intake_prompts WHERE account_id = a_acct),
    'a refused record left a prompt row');
  PERFORM case_settings_set_files_switch(u_owner, a_acct, 'files_intake_prompts', true);
  PERFORM case_intake_template_set(u_admin, a_acct, 'document_classify', 'Taamul: unapproved again');
  n := n + 1; failed := failed || pg_temp.ci_check('a prompt was recorded with the classify wording unapproved',
    NULL, NULL, format('SELECT case_intake_prompt_record(%L, %L, %L)::text', k1, f1, opts),
    'ERROR 23514 TEMPLATE_NOT_APPROVED%');
  PERFORM case_intake_template_approve(u_owner, a_acct, 'document_classify');
  n := n + 1; failed := failed || pg_temp.ci_check('a file of another case was not FILE_NOT_FOUND', NULL, NULL,
    format('SELECT case_intake_prompt_record(%L, %L, %L)::text', k1, f_k2, opts), 'ERROR P0002 FILE_NOT_FOUND%');
  n := n + 1; failed := failed || pg_temp.ci_check('an unknown file was not FILE_NOT_FOUND', NULL, NULL,
    format('SELECT case_intake_prompt_record(%L, %L, %L)::text', k1, gen_random_uuid(), opts),
    'ERROR P0002 FILE_NOT_FOUND%');
  n := n + 1; failed := failed || pg_temp.ci_check('an unknown case was not CASE_NOT_FOUND', NULL, NULL,
    format('SELECT case_intake_prompt_record(%L, %L, %L)::text', gen_random_uuid(), f1, opts),
    'ERROR P0002 CASE_NOT_FOUND%');
  n := n + 1; failed := failed || pg_temp.ci_check('a staff-registered file was prompted for', NULL, NULL,
    format('SELECT case_intake_prompt_record(%L, %L, %L)::text', k1, f_staff, opts), 'ERROR 23514 FILE_STATE%');
  FOREACH r IN ARRAY ARRAY[
    '[]',
    '{"n": 1, "doc_key": "passport", "label": "Passport"}',
    '[{"n": 0, "doc_key": "passport", "label": "Passport"}]',
    '[{"n": 21, "doc_key": "passport", "label": "Passport"}]',
    '[{"n": 1.5, "doc_key": "passport", "label": "Passport"}]',
    '[{"n": "1", "doc_key": "passport", "label": "Passport"}]',
    '[{"n": 1, "doc_key": "visa", "label": "Visa"}]',
    '[{"n": 1, "doc_key": "passport", "label": " "}]',
    '[{"n": 1, "doc_key": "passport"}]',
    '[{"n": 1, "doc_key": "passport", "label": "A"}, {"n": 1, "doc_key": "emirates_id", "label": "B"}]',
    '[{"n": 1, "doc_key": "passport", "label": "A"}, {"n": 2, "doc_key": "passport", "label": "B"}]',
    (SELECT jsonb_agg(jsonb_build_object('n', i, 'doc_key', 'passport', 'label', 'P')) FROM generate_series(1, 21) i)::text
  ] LOOP
    n := n + 1; failed := failed || pg_temp.ci_check('invalid options were accepted: ' || r, NULL, NULL,
      format('SELECT case_intake_prompt_record(%L, %L, %L)::text', k1, f1, r), 'ERROR 23514 PROMPT_INVALID%');
  END LOOP;
  UPDATE cases SET stage = 'Approved', closed_at = now() WHERE id = k3;
  n := n + 1; failed := failed || pg_temp.ci_check('a closed case was prompted for', NULL, NULL,
    format('SELECT case_intake_prompt_record(%L, %L, %L)::text', k3, f_k3, opts), 'ERROR 23514 CASE_CLOSED%');

  -- happy path, one open prompt per case
  p1 := case_intake_prompt_record(k1, f1, opts, '2026-11-10 09:00+00');
  n := n + 1; failed := failed || pg_temp.ci_ok(
    (SELECT prompt_id FROM case_intake_open_prompt(k1)) = p1
    AND (SELECT account_id = a_acct AND file_id = f1 AND sent_at = '2026-11-10 09:00+00' AND options = opts
           FROM case_intake_prompts WHERE prompt_id = p1),
    'the recorded prompt is not the open prompt, or its row is wrong');
  n := n + 1; failed := failed || pg_temp.ci_ok(NOT EXISTS (SELECT 1 FROM case_intake_open_prompt(k2)),
    'a case with no prompt has an open prompt');
  p2 := case_intake_prompt_record(k1, f2, '[{"n": 3, "doc_key": "emirates_id", "label": "Emirates ID"}]',
    '2026-11-10 09:05+00');
  n := n + 1; failed := failed || pg_temp.ci_ok(
    (SELECT prompt_id FROM case_intake_open_prompt(k1)) = p2
    AND (SELECT superseded_at = '2026-11-10 09:05+00' FROM case_intake_prompts WHERE prompt_id = p1)
    AND (SELECT count(*) FROM case_intake_prompts WHERE case_id = k1 AND answered_at IS NULL AND superseded_at IS NULL) = 1,
    'recording a second prompt did not supersede the first');
  n := n + 1; failed := failed || pg_temp.ci_check('a second open prompt for one case was inserted', NULL, NULL,
    format('INSERT INTO case_intake_prompts (account_id, case_id, file_id, options, sent_at) VALUES (%L, %L, %L, %L, now())',
           a_acct, k1, f3, opts), 'ERROR 23505 %');

  -- ---------- 3b. never on a case Compass manages (181, 134) ----------
  -- k1 has a group, so the account switch makes it managed; the intake is on
  -- and the wording approved, so only the managed rule refuses here.
  PERFORM case_settings_set(u_owner, a_acct, true);
  n := n + 1; failed := failed || pg_temp.ci_check('managed externally, the intake could register', NULL, NULL,
    format('SELECT case_document_file_can_register(NULL, %L)::text', k1), 'ERROR 55000 MANAGED_EXTERNALLY%');
  n := n + 1; failed := failed || pg_temp.ci_check('managed externally, staff could not register', NULL, NULL,
    format('SELECT case_document_file_can_register(%L, %L)::text', u_agent, k1), 'true');
  n := n + 1; failed := failed || pg_temp.ci_check('managed externally, a prompt was answered', NULL, NULL,
    format('SELECT case_intake_prompt_answer(%L, 3)', p2), 'ERROR 55000 MANAGED_EXTERNALLY%');
  n := n + 1; failed := failed || pg_temp.ci_check('managed externally, a prompt was recorded', NULL, NULL,
    format('SELECT case_intake_prompt_record(%L, %L, %L)::text', k1, f4, opts), 'ERROR 55000 MANAGED_EXTERNALLY%');
  -- last: a classify that slipped through would make p2 stale for the checks above
  n := n + 1; failed := failed || pg_temp.ci_check('managed externally, the intake could classify', NULL, NULL,
    format('SELECT version::text FROM case_document_file_classify(NULL, %L, %L)', f2, 'emirates_id'),
    'ERROR 55000 MANAGED_EXTERNALLY%');
  PERFORM case_settings_set(u_owner, a_acct, false);
  n := n + 1; failed := failed || pg_temp.ci_ok(
    (SELECT prompt_id FROM case_intake_open_prompt(k1)) = p2
    AND (SELECT status = 'unclassified' FROM case_document_files WHERE id = f2),
    'a refusal while managed externally changed the open prompt or its file');

  -- ---------- 4. answer ----------
  n := n + 1; failed := failed || pg_temp.ci_check('a superseded prompt was answered', NULL, NULL,
    format('SELECT case_intake_prompt_answer(%L, 1)', p1), 'ERROR 23514 PROMPT_STALE%');
  n := n + 1; failed := failed || pg_temp.ci_check('an unknown prompt was not PROMPT_NOT_FOUND', NULL, NULL,
    format('SELECT case_intake_prompt_answer(%L, 1)', gen_random_uuid()), 'ERROR P0002 PROMPT_NOT_FOUND%');
  n := n + 1; failed := failed || pg_temp.ci_check('a number not offered was accepted', NULL, NULL,
    format('SELECT case_intake_prompt_answer(%L, 1)', p2), 'ERROR 23514 PROMPT_OPTION%');
  n := n + 1; failed := failed || pg_temp.ci_check('a NULL number was accepted', NULL, NULL,
    format('SELECT case_intake_prompt_answer(%L, NULL)', p2), 'ERROR 23514 PROMPT_OPTION%');
  n := n + 1; failed := failed || pg_temp.ci_ok(
    (SELECT answered_at IS NULL FROM case_intake_prompts WHERE prompt_id = p2),
    'a refused answer marked the prompt answered');
  n := n + 1; failed := failed || pg_temp.ci_check('the offered number did not return its doc_key', NULL, NULL,
    format('SELECT case_intake_prompt_answer(%L, 3, %L)', p2, '2026-11-10 09:06+00'), 'emirates_id');
  n := n + 1; failed := failed || pg_temp.ci_ok(
    (SELECT answered_at = '2026-11-10 09:06+00' AND answer_doc_key = 'emirates_id' AND superseded_at IS NULL
       FROM case_intake_prompts WHERE prompt_id = p2)
    AND NOT EXISTS (SELECT 1 FROM case_intake_open_prompt(k1)),
    'the answer was not stored, or the prompt is still open');
  n := n + 1; failed := failed || pg_temp.ci_check('a prompt was answered twice', NULL, NULL,
    format('SELECT case_intake_prompt_answer(%L, 3)', p2), 'ERROR 23514 PROMPT_STALE%');
  -- the answered doc_key is what the system intake then classifies
  n := n + 1; failed := failed || pg_temp.ci_check('the system intake could not classify the answered file', NULL, NULL,
    format('SELECT version::text FROM case_document_file_classify(NULL, %L, %L)', f2, 'emirates_id'), '1');

  -- a file staff classified makes its prompt stale
  p3 := case_intake_prompt_record(k1, f3, opts);
  PERFORM case_document_file_classify(u_agent, f3, 'passport');
  n := n + 1; failed := failed || pg_temp.ci_check('a prompt about a file staff classified was answered', NULL, NULL,
    format('SELECT case_intake_prompt_answer(%L, 1)', p3), 'ERROR 23514 PROMPT_STALE%');
  n := n + 1; failed := failed || pg_temp.ci_check('a classified file was prompted for', NULL, NULL,
    format('SELECT case_intake_prompt_record(%L, %L, %L)::text', k1, f3, opts), 'ERROR 23514 FILE_STATE%');

  -- the guard: an answered or superseded prompt is final; nothing is deleted
  n := n + 1; failed := failed || pg_temp.ci_check('an answered prompt was re-answered directly', NULL, NULL,
    format('UPDATE case_intake_prompts SET answer_doc_key = %L WHERE prompt_id = %L', 'passport', p2),
    'ERROR 42501 PROMPT_STALE%');
  n := n + 1; failed := failed || pg_temp.ci_check('a superseded prompt was reopened directly', NULL, NULL,
    format('UPDATE case_intake_prompts SET superseded_at = NULL WHERE prompt_id = %L', p1), 'ERROR 42501 PROMPT_STALE%');
  p4 := case_intake_prompt_record(k1, f4, opts);
  n := n + 1; failed := failed || pg_temp.ci_check('an open prompt''s options were rewritten', NULL, NULL,
    format('UPDATE case_intake_prompts SET options = %L WHERE prompt_id = %L', '[{"n": 1, "doc_key": "passport", "label": "X"}]', p4),
    'ERROR 42501 PROMPT_STALE%');
  n := n + 1; failed := failed || pg_temp.ci_check('a prompt was deleted', NULL, NULL,
    format('DELETE FROM case_intake_prompts WHERE prompt_id = %L', p1), 'ERROR 42501 %');

  -- ---------- 5. privileges ----------
  FOREACH fn IN ARRAY ARRAY[
    'public.case_intake_template_set(uuid, uuid, text, text)',
    'public.case_intake_template_approve(uuid, uuid, text)',
    'public.case_intake_template_get(uuid, text)',
    'public.case_intake_prompt_record(uuid, uuid, jsonb, timestamptz)',
    'public.case_intake_prompt_answer(uuid, integer, timestamptz)',
    'public.case_intake_open_prompt(uuid)'] LOOP
    FOREACH rl IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      n := n + 1; failed := failed || pg_temp.ci_ok(NOT has_function_privilege(rl, fn, 'EXECUTE'),
        rl || ' may execute ' || fn);
    END LOOP;
    n := n + 1; failed := failed || pg_temp.ci_ok(has_function_privilege('service_role', fn, 'EXECUTE'),
      'the service role may not execute ' || fn);
  END LOOP;
  n := n + 1; failed := failed || pg_temp.ci_check('authenticated ran case_intake_prompt_answer', 'authenticated', u_owner,
    format('SELECT case_intake_prompt_answer(%L, 1)', p4), 'ERROR 42501 %');
  n := n + 1; failed := failed || pg_temp.ci_check('authenticated approved wording directly', 'authenticated', u_owner,
    format('SELECT case_intake_template_approve(%L, %L, %L)::text', u_owner, a_acct, 'document_classify'), 'ERROR 42501 %');
  FOREACH rl IN ARRAY ARRAY['case_intake_templates', 'case_intake_template_audit', 'case_intake_prompts'] LOOP
    n := n + 1; failed := failed || pg_temp.ci_ok(
      NOT has_table_privilege('authenticated', 'public.' || rl, 'INSERT, UPDATE, DELETE, TRUNCATE')
      AND NOT has_table_privilege('anon', 'public.' || rl, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE'),
      'anon or authenticated may write ' || rl);
  END LOOP;
  n := n + 1; failed := failed || pg_temp.ci_ok(
    NOT has_table_privilege('authenticated', 'public.case_intake_prompts', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.case_intake_template_audit', 'SELECT'),
    'authenticated may read the prompts or the template audit');
  n := n + 1; failed := failed || pg_temp.ci_check('authenticated approved wording by UPDATE', 'authenticated', u_owner,
    format('UPDATE case_intake_templates SET approved = true WHERE account_id = %L', a_acct), 'ERROR 42501 %');
  n := n + 1; failed := failed || pg_temp.ci_check('a member could not read the account''s wording', 'authenticated',
    u_agent, format('SELECT count(*)::text FROM case_intake_templates WHERE account_id = %L', a_acct), '1');
  n := n + 1; failed := failed || pg_temp.ci_check('another workspace read this one''s wording', 'authenticated',
    u_other, format('SELECT count(*)::text FROM case_intake_templates WHERE account_id = %L', a_acct), '0');

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT183', MESSAGE = 'verify-case-intake rollback';
  EXCEPTION WHEN SQLSTATE 'ZT183' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'case intake verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'case intake verification passed (% checks)', n;
END
$verify$;
