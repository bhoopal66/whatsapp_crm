-- Behavioural regression suite for migration 081: approved answers.
--
-- Asserts that a placeholder answer can never be approved; that
-- kb_shortlist never returns internal_staff or non-approved rows, gives
-- a small KB (<= 12 approved client rows) whole and a large one only
-- matching rows; the trigger's version bump and approval stamp; that a
-- non-admin member reads but cannot write, and cannot import; the
-- kb_import counts and keep-existing rule; the RPC privileges; the
-- ai_configs columns; and the widened hand-off reason CHECK.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000081001';
  u_admin  UUID := '00000000-0000-4000-8000-000000081002';
  u_agent  UUID := '00000000-0000-4000-8000-000000081003';
  u_owner2 UUID := '00000000-0000-4000-8000-000000081004';
  a_acct   UUID;   -- large KB (> 12 approved client rows)
  b_acct   UUID;   -- small KB
  e        UUID;
  ct       UUID;
  cv       UUID;
  res      JSONB;
  rec      RECORD;
  r        TEXT;
  i        INT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as a signed-in user: the value of a SELECT, the
  -- row count of anything else, or the error.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.kb_try(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; c bigint;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        IF p_sql ILIKE 'select%' THEN
          EXECUTE p_sql INTO v;
        ELSE
          EXECUTE p_sql;
          GET DIAGNOSTICS c = ROW_COUNT;
          v := c::text;
        END IF;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(v, 'null');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR: ' || SQLERRM;
      END;
    END $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'kb81-owner@example.invalid'),
    (u_admin,  'kb81-admin@example.invalid'),
    (u_agent,  'kb81-agent@example.invalid'),
    (u_owner2, 'kb81-owner2@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_owner2;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision two accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent;

  -- ---------- a placeholder can never be approved ----------
  FOR rec IN
    SELECT * FROM (VALUES
      ('', NULL, 'a blank answer'),
      ('   ', NULL, 'a whitespace answer'),
      ('Rates are [TO CONFIRM] percent', NULL, 'an EN placeholder'),
      ('Rates are [ to confirm: rate ]', NULL, 'a lower-case EN placeholder'),
      ('Fine answer', 'السعر [TO CONFIRM]', 'an AR placeholder')
    ) AS t(en, ar, label)
  LOOP
    BEGIN
      INSERT INTO kb_entries (account_id, ref, audience, question, answer_en, answer_ar, status)
      VALUES (a_acct, 'KB-PH', 'prospective_client', 'q?', rec.en, rec.ar, 'approved');
      r := 'ok';
    EXCEPTION WHEN check_violation THEN r := 'rejected';
    END;
    n := n + 1;
    IF r <> 'rejected' THEN
      failed := array_append(failed, format('approved %s', rec.label));
    END IF;
  END LOOP;
  -- ... nor become approved later.
  INSERT INTO kb_entries (account_id, ref, audience, question, answer_en, status)
  VALUES (a_acct, 'KB-PH', 'prospective_client', 'q?', 'Fee is [TO CONFIRM]', 'draft') RETURNING id INTO e;
  BEGIN
    UPDATE kb_entries SET status = 'approved' WHERE id = e;
    r := 'ok';
  EXCEPTION WHEN check_violation THEN r := 'rejected';
  END;
  n := n + 1;
  IF r <> 'rejected' THEN
    failed := array_append(failed, 'a draft placeholder was promoted to approved'::text);
  END IF;
  DELETE FROM kb_entries WHERE id = e;

  -- ---------- trigger: version bump and approval stamp ----------
  INSERT INTO kb_entries (account_id, ref, audience, question, answer_en, answer_ar, status)
  VALUES (a_acct, 'KB-T1', 'existing_client', 'How do I pay?', 'By transfer.', '', 'draft')
  RETURNING id INTO e;
  n := n + 1;
  IF (SELECT answer_ar IS NOT NULL OR version <> 1 OR approved_at IS NOT NULL FROM kb_entries WHERE id = e) THEN
    failed := array_append(failed, 'insert: answer_ar '''' not NULL, version not 1, or a draft stamped approved'::text);
  END IF;
  UPDATE kb_entries SET answer_en = 'By bank transfer.', version = 42 WHERE id = e;
  n := n + 1;
  IF (SELECT version FROM kb_entries WHERE id = e) <> 2 THEN
    failed := array_append(failed, 'an answer edit did not bump version to 2 (or a client set version)'::text);
  END IF;
  r := pg_temp.kb_try(u_admin, format($q$UPDATE kb_entries SET status = 'approved' WHERE id = %L$q$, e));
  n := n + 1;
  IF r <> '1' OR (SELECT approved_at IS NULL OR approved_by IS DISTINCT FROM u_admin OR version <> 2
                    FROM kb_entries WHERE id = e) THEN
    failed := array_append(failed, ('approval not stamped with the admin (or version moved): ' || r)::text);
  END IF;
  r := pg_temp.kb_try(u_owner, format($q$UPDATE kb_entries SET reviewer_notes = 'ok' WHERE id = %L$q$, e));
  n := n + 1;
  IF r <> '1' OR (SELECT approved_by IS DISTINCT FROM u_admin OR version <> 2 FROM kb_entries WHERE id = e) THEN
    failed := array_append(failed, ('a notes-only edit re-stamped the approval or bumped version: ' || r)::text);
  END IF;
  r := pg_temp.kb_try(u_owner, format($q$UPDATE kb_entries SET answer_en = 'By card or transfer.' WHERE id = %L$q$, e));
  n := n + 1;
  IF r <> '1' OR (SELECT approved_by IS DISTINCT FROM u_owner OR version <> 3 FROM kb_entries WHERE id = e) THEN
    failed := array_append(failed, ('an approved answer edit did not re-stamp the approval and bump version: ' || r)::text);
  END IF;
  UPDATE kb_entries SET status = 'to_confirm' WHERE id = e;
  n := n + 1;
  IF (SELECT approved_at IS NOT NULL OR approved_by IS NOT NULL FROM kb_entries WHERE id = e) THEN
    failed := array_append(failed, 'leaving approved did not clear the approval stamp'::text);
  END IF;
  DELETE FROM kb_entries WHERE id = e;

  -- ---------- RLS: members read, admins write ----------
  INSERT INTO kb_entries (account_id, ref, audience, question, answer_en, status)
  VALUES (a_acct, 'KB-R1', 'prospective_client', 'Who are you?', 'A broker.', 'approved') RETURNING id INTO e;
  n := n + 1;
  r := pg_temp.kb_try(u_agent, format($q$SELECT count(*) FROM kb_entries WHERE id = %L$q$, e));
  IF r <> '1' THEN
    failed := array_append(failed, ('an agent cannot read its account''s answers: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.kb_try(u_owner2, format($q$SELECT count(*) FROM kb_entries WHERE id = %L$q$, e));
  IF r <> '0' THEN
    failed := array_append(failed, ('another account reads the answers: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.kb_try(u_agent, format($q$UPDATE kb_entries SET answer_en = 'hacked' WHERE id = %L$q$, e));
  IF r <> '0' OR (SELECT answer_en FROM kb_entries WHERE id = e) <> 'A broker.' THEN
    failed := array_append(failed, ('an agent updated an answer: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.kb_try(u_agent, format(
    $q$INSERT INTO kb_entries (account_id, ref, audience, question) VALUES (%L, 'KB-AG', 'existing_client', 'x')$q$, a_acct));
  IF r NOT LIKE 'ERROR:%' THEN
    failed := array_append(failed, ('an agent inserted an answer: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.kb_try(u_agent, format($q$DELETE FROM kb_entries WHERE id = %L$q$, e));
  IF r <> '0' THEN
    failed := array_append(failed, ('an agent deleted an answer: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.kb_try(u_agent, format($q$SELECT kb_import(%L, 'f.xlsx', '[]'::jsonb, '[]'::jsonb)::text$q$, a_acct));
  IF r NOT LIKE 'ERROR:%admin%' THEN
    failed := array_append(failed, ('an agent ran kb_import: ' || r)::text);
  END IF;
  DELETE FROM kb_entries WHERE id = e;

  -- ---------- kb_import counts ----------
  r := pg_temp.kb_try(u_admin, format($q$SELECT kb_import(%L, 'kb.xlsx', %L::jsonb, %L::jsonb)::text$q$, a_acct,
    '[{"ref":"kb-001","audience":"prospective_client","category":"Fees","question":"What is the fee?","answer_en":"One percent.","status":"approved","row":3},
      {"ref":"KB-002","audience":"existing_client","question":"Where is my file?","answer_en":"[TO CONFIRM] ask ops","status":"approved","row":4},
      {"ref":"KB-003","audience":"internal_staff","question":"Staff only?","answer_en":"Internal.","status":"approved","row":5},
      {"ref":"KB-004","audience":"nobody","question":"Bad audience","answer_en":"x","row":6}]',
    '[{"row":7,"ref":null,"message":"Missing question","skipped":true}]'));
  res := CASE WHEN r LIKE 'ERROR:%' THEN NULL ELSE r::jsonb END;
  n := n + 1;
  IF res IS NULL OR (res->>'inserted')::int <> 3 OR (res->>'updated')::int <> 0
     OR (res->>'unchanged')::int <> 0 OR (res->>'skipped')::int <> 2
     OR (res->>'approved')::int <> 2 OR res->>'import_id' IS NULL THEN
    failed := array_append(failed, ('first import counts wrong: ' || r)::text);
  ELSE
    n := n + 1;
    IF NOT EXISTS (
      SELECT 1 FROM kb_imports
       WHERE id = (res->>'import_id')::uuid AND imported_by = u_admin AND file_name = 'kb.xlsx'
         AND total = 5 AND inserted = 3 AND skipped = 2 AND approved = 2
         AND jsonb_array_length(issues) = 3
    ) THEN
      failed := array_append(failed, 'kb_imports audit row missing or wrong'::text);
    END IF;
  END IF;
  n := n + 1;
  IF (SELECT status FROM kb_entries WHERE account_id = a_acct AND ref = 'KB-002') IS DISTINCT FROM 'to_confirm'
     OR NOT EXISTS (SELECT 1 FROM kb_entries WHERE account_id = a_acct AND ref = 'KB-001') THEN
    failed := array_append(failed, 'placeholder not downgraded to to_confirm, or the ref not upper-cased'::text);
  END IF;
  -- Arabic and hand-off set by hand; a re-import without those columns keeps them.
  UPDATE kb_entries SET answer_ar = 'واحد بالمئة', handoff_after = true WHERE account_id = a_acct AND ref = 'KB-001';
  r := pg_temp.kb_try(u_admin, format($q$SELECT kb_import(%L, 'kb.xlsx', %L::jsonb, '[]'::jsonb)::text$q$, a_acct,
    '[{"ref":"KB-001","audience":"prospective_client","category":"Fees","question":"What is the fee?","answer_en":"One percent.","status":"approved"},
      {"ref":"KB-003","audience":"internal_staff","question":"Staff only?","answer_en":"Internal, changed.","status":"approved"}]'));
  res := CASE WHEN r LIKE 'ERROR:%' THEN NULL ELSE r::jsonb END;
  n := n + 1;
  IF res IS NULL OR (res->>'inserted')::int <> 0 OR (res->>'updated')::int <> 1
     OR (res->>'unchanged')::int <> 1 OR (res->>'skipped')::int <> 0 OR (res->>'approved')::int <> 2 THEN
    failed := array_append(failed, ('re-import counts wrong: ' || r)::text);
  END IF;
  n := n + 1;
  IF (SELECT answer_ar IS DISTINCT FROM 'واحد بالمئة' OR NOT handoff_after
        FROM kb_entries WHERE account_id = a_acct AND ref = 'KB-001')
     OR (SELECT status FROM kb_entries WHERE account_id = a_acct AND ref = 'KB-002') <> 'to_confirm' THEN
    failed := array_append(failed, 'a re-import dropped a value its file had no column for, or touched a row not in the file'::text);
  END IF;
  n := n + 1;
  r := pg_temp.kb_try(u_admin, format(
    $q$INSERT INTO kb_imports (account_id, imported_by) VALUES (%L, %L)$q$, a_acct, u_owner));
  IF r NOT LIKE 'ERROR:%' THEN
    failed := array_append(failed, 'an admin logged an import in another member''s name'::text);
  END IF;
  DELETE FROM kb_entries WHERE account_id = a_acct;

  -- ---------- kb_shortlist: large KB ----------
  FOR i IN 1..14 LOOP
    INSERT INTO kb_entries (account_id, ref, audience, question, answer_en, status)
    VALUES (a_acct, format('KB-%s', lpad(i::text, 3, '0')),
            CASE WHEN i % 2 = 0 THEN 'existing_client' ELSE 'prospective_client' END,
            CASE WHEN i <= 3 THEN format('What is the mortgage rate %s?', i) ELSE format('Office hours %s', i) END,
            'Answer.', 'approved');
  END LOOP;
  INSERT INTO kb_entries (account_id, ref, audience, question, answer_en, status) VALUES
    (a_acct, 'KB-090', 'internal_staff', 'Mortgage rate staff margin', 'Internal.', 'approved'),
    (a_acct, 'KB-091', 'prospective_client', 'Mortgage rate draft', 'Draft.', 'draft'),
    (a_acct, 'KB-092', 'existing_client', 'Mortgage rate removed', 'Old.', 'remove'),
    (a_acct, 'KB-093', 'prospective_client', 'Mortgage rate pending', 'Later.', 'to_confirm');
  n := n + 1;
  SELECT string_agg(s.ref, ',' ORDER BY s.ref) INTO r FROM kb_shortlist(a_acct, 'what is the mortgage rate', 8) s;
  IF r IS DISTINCT FROM 'KB-001,KB-002,KB-003' THEN
    failed := array_append(failed, ('large KB shortlist should be the three approved client matches, got ' || coalesce(r, 'nothing'))::text);
  END IF;
  n := n + 1;
  SELECT count(*) INTO i FROM kb_shortlist(a_acct, 'office hours', 5) s;
  IF i <> 5 THEN
    failed := array_append(failed, format('large KB shortlist ignored p_limit: %s rows', i));
  END IF;

  -- ---------- kb_shortlist: small KB returns every approved client row ----------
  INSERT INTO kb_entries (account_id, ref, audience, question, answer_en, status) VALUES
    (b_acct, 'KB-001', 'prospective_client', 'Can I get a loan?', 'Yes.', 'approved'),
    (b_acct, 'KB-002', 'existing_client', 'Where is my application?', 'With the bank.', 'approved'),
    (b_acct, 'KB-003', 'internal_staff', 'Commission split?', 'Internal.', 'approved'),
    (b_acct, 'KB-004', 'prospective_client', 'Draft question', 'Draft.', 'draft');
  n := n + 1;
  SELECT string_agg(s.ref, ',' ORDER BY s.ref) INTO r FROM kb_shortlist(b_acct, 'zzz unrelated paraphrase', 8) s;
  IF r IS DISTINCT FROM 'KB-001,KB-002' THEN
    failed := array_append(failed, ('small KB shortlist should be KB-001,KB-002, got ' || coalesce(r, 'nothing'))::text);
  END IF;
  n := n + 1;
  SELECT string_agg(s.ref, ',' ORDER BY s.ref) INTO r FROM kb_shortlist(b_acct, 'commission split draft', 8) s;
  IF r IS DISTINCT FROM 'KB-001,KB-002' THEN
    failed := array_append(failed, ('small KB shortlist leaked internal or draft rows: ' || coalesce(r, 'nothing'))::text);
  END IF;

  -- ---------- privileges ----------
  n := n + 1;
  IF has_function_privilege('authenticated', 'public.kb_shortlist(uuid, text, integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.kb_shortlist(uuid, text, integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.kb_shortlist(uuid, text, integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.kb_import(uuid, text, jsonb, jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.kb_import(uuid, text, jsonb, jsonb)', 'EXECUTE') THEN
    failed := array_append(failed, 'kb_shortlist is client-callable (or not service_role), or kb_import is not authenticated-only'::text);
  END IF;

  -- ---------- ai_configs columns ----------
  INSERT INTO ai_configs (account_id, provider, model, api_key) VALUES (b_acct, 'openai', 'gpt-x', 'enc')
  ON CONFLICT (account_id) DO NOTHING;
  n := n + 1;
  IF (SELECT answer_mode <> 'generate' OR approved_min_score <> 0.8::real OR sensitive_data_reply IS NOT NULL
        FROM ai_configs WHERE account_id = b_acct) THEN
    failed := array_append(failed, 'ai_configs defaults are not generate / 0.8 / NULL'::text);
  END IF;
  FOR rec IN
    SELECT * FROM (VALUES
      ($q$answer_mode = 'free'$q$, false),
      ('approved_min_score = 0.49', false),
      ('approved_min_score = 1', false),
      ('approved_min_score = 0.5', true),
      ('approved_min_score = 0.99', true),
      ($q$answer_mode = 'approved'$q$, true)
    ) AS t(assign, ok)
  LOOP
    BEGIN
      EXECUTE format('UPDATE ai_configs SET %s WHERE account_id = %L', rec.assign, b_acct);
      r := 'ok';
    EXCEPTION WHEN check_violation THEN r := 'rejected';
    END;
    n := n + 1;
    IF (r = 'ok') <> rec.ok THEN
      failed := array_append(failed, format('ai_configs %s was %s', rec.assign, r));
    END IF;
  END LOOP;

  -- ---------- hand-off reasons ----------
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (b_acct, u_owner2, '971500081001', 'KB81 contact') RETURNING id INTO ct;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (b_acct, u_owner2, ct) RETURNING id INTO cv;
  FOREACH r IN ARRAY ARRAY['keyword', 'no_knowledge', 'model', 'error', 'cap', 'triage', 'guardrail', 'kb', 'bogus'] LOOP
    n := n + 1;
    BEGIN
      UPDATE conversations SET ai_handoff_reason = r WHERE id = cv;
      IF r = 'bogus' THEN
        failed := array_append(failed, 'an unknown hand-off reason was accepted'::text);
      END IF;
    EXCEPTION WHEN check_violation THEN
      IF r <> 'bogus' THEN
        failed := array_append(failed, format('hand-off reason %s refused', r));
      END IF;
    END;
  END LOOP;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT081', MESSAGE = 'verify-approved-answers rollback';
  EXCEPTION WHEN SQLSTATE 'ZT081' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'approved answers verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'approved answers verification passed (% checks)', n;
END
$verify$;
