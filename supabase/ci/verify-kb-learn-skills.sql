-- ============================================================
-- verify-kb-learn-skills.sql — assertions for migration 318.
--
-- A learned draft keeps its drafted answer, which goes when a subject
-- erase takes any of its gaps; the skill library refuses identifiers, adds
-- at most three per cycle and 24 in all, one cycle in six days, skips one
-- bad skill without losing the others, never re-adds what an admin retired
-- (under another kind, or spelled with other punctuation), and only an
-- admin of the workspace reads or retires; the writers are service role.
--
-- ONE statement on purpose; fixtures are rolled back through a sentinel.
-- Fixture emails: kb318-*.
-- ============================================================
DO $$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000318001';
  u_admin  UUID := '00000000-0000-4000-8000-000000318002';
  u_agent  UUID := '00000000-0000-4000-8000-000000318003';
  u_owner2 UUID := '00000000-0000-4000-8000-000000318004';
  a_acct UUID; b_acct UUID;
  c_id UUID; v_id UUID; gs UUID[] := '{}'; g1 UUID;
  res JSONB; r TEXT; sk UUID; k INT; f TEXT;
  n INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.kl_try(p_uid uuid, p_sql text)
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
    (u_owner,  'kb318-owner@example.invalid'),
    (u_admin,  'kb318-admin@example.invalid'),
    (u_agent,  'kb318-agent@example.invalid'),
    (u_owner2, 'kb318-owner2@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_owner2;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision two accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent;

  FOR i IN 1..3 LOOP
    INSERT INTO contacts (user_id, account_id, phone) VALUES (u_owner, a_acct, '97150318000' || i) RETURNING id INTO c_id;
    INSERT INTO conversations (user_id, account_id, contact_id) VALUES (u_owner, a_acct, c_id) RETURNING id INTO v_id;
    INSERT INTO ai_knowledge_gaps (account_id, conversation_id, question) VALUES (a_acct, v_id, 'Licence ' || i) RETURNING id INTO g1;
    gs := gs || g1;
  END LOOP;

  -- ---------- switched off, or no such account: nothing ----------
  k := kb_learn_add_skills(a_acct, '[{"kind":"general","title":"T","principle":"P"}]', '{}')
     + kb_learn_add_skills(gen_random_uuid(), '[{"kind":"general","title":"T","principle":"P"}]', '{}')
     + kb_learn_add_skills(NULL, '[{"kind":"general","title":"T","principle":"P"}]', '{}');
  IF k <> 0 OR EXISTS (SELECT 1 FROM kb_learn_skills WHERE account_id = a_acct) THEN
    failed := failed || 'added while off'::text; END IF; n := n + 1;
  r := pg_temp.kl_try(u_owner, 'select (public.kb_learn_set_enabled(true))->>''enabled''');

  -- ---------- the ledger keeps the drafted answer ----------
  res := kb_learn_record_draft(a_acct, NULL, repeat('a', 64), gs, 'LRN-KBAAAA', 'Licence?', ' Yes, with conditions. ', NULL, NULL, 2);
  IF res->>'status' <> 'drafted' OR NOT EXISTS (
       SELECT 1 FROM kb_learned_drafts WHERE account_id = a_acct AND topic_key = repeat('a', 64)
          AND draft_answer_en = 'Yes, with conditions.' AND reviewed_outcome IS NULL AND distilled_at IS NULL)
     OR NOT EXISTS (SELECT 1 FROM kb_entries WHERE account_id = a_acct AND status = 'draft' AND source = 'learned') THEN
    failed := failed || ('draft: ' || res::text); END IF; n := n + 1;

  -- ---------- the CHECK refuses identifiers, whatever the job sends ----------
  FOREACH f IN ARRAY ARRAY['Write to help@bank.example', 'Quote 1234 5678 90', 'Call ٠٥٠١٢٣٤٥٦٧', 'Ask [NAME] first',
                           'See [CASE]', 'Go to [LINK]', 'Use https://x.example', 'Ref 20451 then'] LOOP
    BEGIN
      INSERT INTO kb_learn_skills (account_id, kind, title, principle) VALUES (a_acct, 'general', 'x', f);
      failed := failed || ('skill CHECK let through: ' || f);
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP; n := n + 1;

  -- ---------- one cycle: bad ones skipped, three at most ----------
  UPDATE kb_learned_drafts SET reviewed_outcome = 'approved' WHERE account_id = a_acct;
  k := kb_learn_add_skills(a_acct, jsonb_build_array(
    '7'::jsonb, '{"kind":"general"}'::jsonb,
    jsonb_build_object('kind', 'nonsense', 'title', 'x', 'principle', 'y'),
    jsonb_build_object('kind', 'general', 'title', 'Leak', 'principle', 'Call 0501234567'),
    jsonb_build_object('kind', 'general', 'title', 'Name every document', 'principle', 'List each document.', 'evidence_count', 'many'),
    jsonb_build_object('kind', 'category', 'category', 'fees', 'title', 'Fee timing', 'principle', 'Say when a fee applies.', 'evidence_count', 1e12),
    jsonb_build_object('kind', 'mistake', 'title', 'Promising approval', 'principle', 'Say the bank decides.', 'evidence_count', 2.5),
    jsonb_build_object('kind', 'general', 'title', 'Fourth', 'principle', 'Over the cap.')),
    (SELECT array_agg(id) FROM kb_learned_drafts WHERE account_id = a_acct));
  IF k <> 3 OR (SELECT count(*) FROM kb_learn_skills WHERE account_id = a_acct) <> 3
     OR (SELECT evidence_count FROM kb_learn_skills WHERE account_id = a_acct AND kind = 'general') <> 1
     OR (SELECT evidence_count FROM kb_learn_skills WHERE account_id = a_acct AND kind = 'category') <> 1000
     OR EXISTS (SELECT 1 FROM kb_learned_drafts WHERE account_id = a_acct AND distilled_at IS NULL)
     OR (SELECT last_distilled_at FROM kb_learn_settings WHERE account_id = a_acct) IS NULL THEN
    failed := failed || ('add_skills: ' || k); END IF; n := n + 1;
  -- ---------- one cycle in six days, and what it did not use stays unmarked ----------
  UPDATE kb_learned_drafts SET distilled_at = NULL WHERE account_id = a_acct;
  UPDATE kb_learn_settings SET last_distilled_at = now() - interval '6 days' + interval '1 second' WHERE account_id = a_acct;
  k := kb_learn_add_skills(a_acct, '[{"kind":"general","title":"Too soon","principle":"P"}]',
    (SELECT array_agg(id) FROM kb_learned_drafts WHERE account_id = a_acct));
  IF k <> 0 OR EXISTS (SELECT 1 FROM kb_learned_drafts WHERE account_id = a_acct AND distilled_at IS NOT NULL)
     OR (SELECT last_distilled_at FROM kb_learn_settings WHERE account_id = a_acct) > now() - interval '5 days' THEN
    failed := failed || ('a second cycle in six days: ' || k); END IF; n := n + 1;
  -- A cycle that added nothing (a failed call) counts too, after six days.
  UPDATE kb_learn_settings SET last_distilled_at = now() - interval '6 days' WHERE account_id = a_acct;
  k := kb_learn_add_skills(a_acct, '[]', '{}');
  IF k <> 0 OR (SELECT last_distilled_at FROM kb_learn_settings WHERE account_id = a_acct) IS DISTINCT FROM now()
     OR EXISTS (SELECT 1 FROM kb_learned_drafts WHERE account_id = a_acct AND distilled_at IS NOT NULL) THEN
    failed := failed || 'a failed cycle was not stamped'::text; END IF; n := n + 1;
  UPDATE kb_learn_settings SET last_distilled_at = NULL WHERE account_id = a_acct;
  k := kb_learn_add_skills(a_acct, '{"kind":"general"}', NULL);
  UPDATE kb_learn_settings SET last_distilled_at = NULL WHERE account_id = a_acct;
  k := k + kb_learn_add_skills(a_acct, NULL, NULL);
  IF k <> 0 THEN failed := failed || 'not a list'::text; END IF; n := n + 1;

  -- ---------- who reads and retires ----------
  SELECT id INTO sk FROM kb_learn_skills WHERE account_id = a_acct AND title = 'Promising approval';
  r := pg_temp.kl_try(u_admin, 'select count(*)::text from public.kb_learn_skills');
  IF r <> '3' THEN failed := failed || ('admin read skills: ' || r); END IF; n := n + 1;
  r := pg_temp.kl_try(u_agent, 'select count(*)::text from public.kb_learn_skills')
    || pg_temp.kl_try(u_owner2, 'select count(*)::text from public.kb_learn_skills');
  IF r <> '00' THEN failed := failed || ('outsider read skills: ' || r); END IF; n := n + 1;
  r := pg_temp.kl_try(u_agent, 'select (public.kb_learn_skill_set_status(''' || sk || ''', ''retired''))->>''status''');
  IF r NOT LIKE 'ERROR:%' THEN failed := failed || ('agent retired a skill: ' || r); END IF; n := n + 1;
  r := pg_temp.kl_try(u_owner2, 'select (public.kb_learn_skill_set_status(''' || sk || ''', ''retired''))->>''status''');
  IF r NOT LIKE 'ERROR:%' THEN failed := failed || ('other workspace retired a skill: ' || r); END IF; n := n + 1;
  r := pg_temp.kl_try(u_admin, 'update public.kb_learn_skills set status = ''retired''');
  IF r NOT LIKE 'ERROR:%' THEN failed := failed || ('admin wrote the table: ' || r); END IF; n := n + 1;

  -- ---------- an admin retires it; the next cycle does not add it back ----------
  r := pg_temp.kl_try(u_admin, 'select (public.kb_learn_skill_set_status(''' || sk || ''', ''retired''))->>''status''');
  UPDATE kb_learn_settings SET last_distilled_at = NULL WHERE account_id = a_acct;
  k := kb_learn_add_skills(a_acct, jsonb_build_array(
    jsonb_build_object('kind', 'mistake', 'title', ' promising  APPROVAL ', 'principle', 'Again.'),
    jsonb_build_object('kind', 'general', 'title', 'Promising approval', 'principle', 'Again.'),
    jsonb_build_object('kind', 'category', 'category', 'loans', 'title', '“Promising-approval”…', 'principle', 'Again.'),
    jsonb_build_object('kind', 'general', 'title', '?!', 'principle', 'No title.')), '{}');
  IF r <> 'retired' OR k <> 0 OR (SELECT count(*) FROM kb_learn_skills WHERE account_id = a_acct AND status = 'active') <> 2
     OR (SELECT retired_by FROM kb_learn_skills WHERE id = sk) IS DISTINCT FROM u_admin THEN
    failed := failed || ('retire: ' || r || ' / re-added ' || k); END IF; n := n + 1;

  -- An Arabic title is compared by its letters, not dropped as marks.
  UPDATE kb_learn_settings SET last_distilled_at = NULL WHERE account_id = a_acct;
  k := kb_learn_add_skills(a_acct, jsonb_build_array(
    jsonb_build_object('kind', 'general', 'title', 'اذكر الرسوم', 'principle', 'p'),
    jsonb_build_object('kind', 'mistake', 'title', 'اذكر، الرسوم؟', 'principle', 'p'),
    jsonb_build_object('kind', 'general', 'title', 'اذكر المدة', 'principle', 'p')), '{}');
  IF k <> 2 THEN failed := failed || ('Arabic titles: ' || k); END IF; n := n + 1;

  -- ---------- at most 24 active ----------
  INSERT INTO kb_learn_skills (account_id, kind, title, principle)
    SELECT a_acct, 'general', 'filler ' || i, 'p' FROM generate_series(1, 20) i;
  UPDATE kb_learn_settings SET last_distilled_at = NULL WHERE account_id = a_acct;
  k := kb_learn_add_skills(a_acct, jsonb_build_array(
    jsonb_build_object('kind', 'general', 'title', 'One too many', 'principle', 'p')), '{}');
  r := pg_temp.kl_try(u_admin, 'select (public.kb_learn_skill_set_status(''' || sk || ''', ''active''))->>''status''');
  IF k <> 0 OR r NOT LIKE 'ERROR:%' THEN failed := failed || ('cap: ' || k || ' ' || r); END IF; n := n + 1;

  -- ---------- an erased gap takes the drafted answer, the last but one the draft ----------
  DELETE FROM ai_knowledge_gaps WHERE id = gs[1];
  IF EXISTS (SELECT 1 FROM kb_learned_drafts WHERE account_id = a_acct AND draft_answer_en IS NOT NULL)
     OR NOT EXISTS (SELECT 1 FROM kb_entries WHERE account_id = a_acct)
     OR NOT EXISTS (SELECT 1 FROM kb_learned_drafts WHERE account_id = a_acct AND cardinality(gap_ids) = 2) THEN
    failed := failed || 'a draft with two chats left kept its drafted answer'::text; END IF; n := n + 1;
  DELETE FROM ai_knowledge_gaps WHERE id = gs[2];
  IF EXISTS (SELECT 1 FROM kb_learned_drafts WHERE account_id = a_acct AND draft_answer_en IS NOT NULL)
     OR EXISTS (SELECT 1 FROM kb_entries WHERE account_id = a_acct) THEN
    failed := failed || 'an erase left the drafted answer'::text; END IF; n := n + 1;

  -- ---------- shapes and grants ----------
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.kb_learn_skills'::regclass AND conname = 'kb_learn_skills_no_identifiers')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.kb_learned_drafts'::regclass AND conname = 'kb_learned_drafts_outcome_check')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.kb_learned_drafts'::regclass AND conname = 'kb_learned_drafts_draft_len_check') THEN
    failed := failed || 'a CHECK is missing'::text; END IF; n := n + 1;
  IF has_function_privilege('authenticated', 'public.kb_learn_add_skills(uuid,jsonb,uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.kb_learn_add_skills(uuid,jsonb,uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.kb_learn_add_skills(uuid,jsonb,uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.kb_learn_skill_set_status(uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.kb_learn_skill_set_status(uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.kb_learn_record_draft(uuid,uuid,text,uuid[],text,text,text,text,text,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.kb_learn_gaps_deleted()', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.kb_learn_skills', 'INSERT')
     OR has_table_privilege('authenticated', 'public.kb_learn_skills', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.kb_learn_skills', 'DELETE')
     OR has_table_privilege('anon', 'public.kb_learn_skills', 'SELECT') THEN
    failed := failed || 'a grant is wrong'::text; END IF; n := n + 1;

  RAISE EXCEPTION 'KL318_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'KL318_ROLLBACK' THEN RAISE; END IF;
  END;

  IF n <> 19 THEN RAISE EXCEPTION 'verify-kb-learn-skills: only % checks ran', n; END IF;
  IF cardinality(failed) > 0 THEN
    RAISE EXCEPTION 'verify-kb-learn-skills: % failed: %', cardinality(failed), array_to_string(failed, '; ');
  END IF;
  RAISE NOTICE 'verify-kb-learn-skills: % checks passed', n;
END $$;
