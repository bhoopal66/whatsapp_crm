-- Behavioural regression suite for migration 290: learn from team
-- answers (knowledge base).
--
-- Asserts: the switch is off by default and, while off, nothing is
-- drafted and no run is claimed; only an admin+ sets it; a run is
-- claimed at most once per 7 days; a learned entry is always a draft
-- (source 'learned', never approved); a topic is drafted once (by its
-- gaps or its label's hash) and again only after its draft was set to
-- 'remove' or deleted, a discarded one after 28 days; another account's gaps are refused; a non-admin member
-- cannot read the ledger and no member can write it; the usage log
-- takes 'kb_learn'; the writer functions are service role only.
--
-- ONE statement on purpose (the pinned CLI rejects several); fixtures
-- are rolled back through a sentinel. Fixture emails: kb290-*.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000290001';
  u_admin  UUID := '00000000-0000-4000-8000-000000290002';
  u_agent  UUID := '00000000-0000-4000-8000-000000290003';
  u_owner2 UUID := '00000000-0000-4000-8000-000000290004';
  a_acct UUID; b_acct UUID;
  g1 UUID; g2 UUID; g3 UUID; g4 UUID; g_other UUID;
  e1 UUID; e2 UUID;
  res JSONB; r TEXT;
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
    (u_owner,  'kb290-owner@example.invalid'),
    (u_admin,  'kb290-admin@example.invalid'),
    (u_agent,  'kb290-agent@example.invalid'),
    (u_owner2, 'kb290-owner2@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_owner2;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision two accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent;

  INSERT INTO ai_knowledge_gaps (account_id, question) VALUES (a_acct, 'Can I open an account without a trade licence?') RETURNING id INTO g1;
  INSERT INTO ai_knowledge_gaps (account_id, question) VALUES (a_acct, 'Account without trade licence possible?') RETURNING id INTO g2;
  INSERT INTO ai_knowledge_gaps (account_id, question) VALUES (a_acct, 'What documents for a POS machine?') RETURNING id INTO g3;
  INSERT INTO ai_knowledge_gaps (account_id, question, created_at) VALUES (a_acct, 'POS fees?', now() + interval '1 minute') RETURNING id INTO g4;
  INSERT INTO ai_knowledge_gaps (account_id, question) VALUES (b_acct, 'Other workspace question') RETURNING id INTO g_other;

  -- ---------- off by default: nothing ----------
  IF EXISTS (SELECT 1 FROM kb_learn_settings WHERE account_id = a_acct AND enabled) THEN
    failed := failed || 'switch on by default'::text; END IF; n := n + 1;
  IF kb_learn_claim_run(a_acct) THEN failed := failed || 'claimed while off'::text; END IF; n := n + 1;
  res := kb_learn_record_draft(a_acct, NULL, encode(sha256(convert_to(lower(btrim('Account without a trade licence')), 'UTF8')), 'hex'), ARRAY[g1, g2],
    'LRN-AAAAAA', 'Account without a trade licence', 'Yes, with conditions.', NULL, 'notes', 2);
  IF res->>'status' <> 'disabled'
     OR EXISTS (SELECT 1 FROM kb_entries WHERE account_id = a_acct)
     OR EXISTS (SELECT 1 FROM kb_learned_drafts WHERE account_id = a_acct) THEN
    failed := failed || ('off wrote: ' || res::text); END IF; n := n + 1;

  -- ---------- only an admin+ sets the switch ----------
  r := pg_temp.kl_try(u_agent, 'select public.kb_learn_set_enabled(true)::text');
  IF r NOT LIKE 'ERROR:%' OR EXISTS (SELECT 1 FROM kb_learn_settings WHERE account_id = a_acct AND enabled) THEN
    failed := failed || ('agent set the switch: ' || r); END IF; n := n + 1;
  r := pg_temp.kl_try(u_agent, 'insert into public.kb_learn_settings (account_id, enabled) values (''' || a_acct || ''', true)');
  IF r NOT LIKE 'ERROR:%' THEN failed := failed || ('agent wrote settings: ' || r); END IF; n := n + 1;
  r := pg_temp.kl_try(u_admin, 'select (public.kb_learn_set_enabled(true))->>''enabled''');
  IF r <> 'true' OR NOT EXISTS (SELECT 1 FROM kb_learn_settings WHERE account_id = a_acct AND enabled) THEN
    failed := failed || ('admin could not set the switch: ' || r); END IF; n := n + 1;

  -- ---------- once per 7 days ----------
  IF NOT kb_learn_claim_run(a_acct) THEN failed := failed || 'first claim refused'::text; END IF; n := n + 1;
  IF kb_learn_claim_run(a_acct) THEN failed := failed || 'claimed twice in a week'::text; END IF; n := n + 1;
  UPDATE kb_learn_settings SET last_run_at = now() - interval '8 days' WHERE account_id = a_acct;
  IF NOT kb_learn_claim_run(a_acct) THEN failed := failed || 'claim refused after a week'::text; END IF; n := n + 1;

  -- ---------- the run's result ----------
  PERFORM kb_learn_finish_run(a_acct, 3);
  r := pg_temp.kl_try(u_admin, 'select last_run_drafted::text from public.kb_learn_settings');
  IF r <> '3' THEN failed := failed || ('finish_run: ' || r); END IF; n := n + 1;

  -- ---------- a learned entry is a draft ----------
  res := kb_learn_record_draft(a_acct, gen_random_uuid(), encode(sha256(convert_to(lower(btrim('Account without a trade licence')), 'UTF8')), 'hex'), ARRAY[g1, g2],
    'LRN-AAAAAA', 'Account without a trade licence', 'Yes, with conditions.', 'نعم، بشروط.',
    'Drafted from 2 team replies', 2);
  e1 := (res->>'entry_id')::uuid;
  IF res->>'status' <> 'drafted' OR e1 IS NULL THEN failed := failed || ('first draft: ' || res::text); END IF; n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM kb_entries WHERE id = e1 AND status = 'draft' AND source = 'learned'
                   AND approved_at IS NULL AND approved_by IS NULL AND answer_ar = 'نعم، بشروط.') THEN
    failed := failed || 'learned entry is not a plain draft'::text; END IF; n := n + 1;
  IF (SELECT count(*) FROM kb_learned_drafts WHERE account_id = a_acct AND entry_id = e1) <> 1 THEN
    failed := failed || 'no ledger row'::text; END IF; n := n + 1;

  -- ---------- drafted once ----------
  -- The same gaps under a new topic id (a recompute) ...
  res := kb_learn_record_draft(a_acct, gen_random_uuid(), encode(sha256(convert_to(lower(btrim('Opening without a licence')), 'UTF8')), 'hex'), ARRAY[g1, g2, g3],
    'LRN-BBBBBB', 'Opening without a licence', 'Again.', NULL, NULL, 3);
  IF res->>'status' <> 'already' THEN failed := failed || ('same gaps drafted again: ' || res::text); END IF; n := n + 1;
  -- ... or the same label with other gaps.
  res := kb_learn_record_draft(a_acct, NULL, encode(sha256(convert_to(lower(btrim('  account WITHOUT a trade licence ')), 'UTF8')), 'hex'), ARRAY[g3],
    'LRN-CCCCCC', 'q', 'Again.', NULL, NULL, 1);
  IF res->>'status' <> 'already' THEN failed := failed || ('same label drafted again: ' || res::text); END IF; n := n + 1;
  IF (SELECT count(*) FROM kb_entries WHERE account_id = a_acct) <> 1 THEN
    failed := failed || 'a refused draft wrote an entry'::text; END IF; n := n + 1;
  IF NOT kb_learn_topic_drafted(a_acct, ARRAY[g1], encode(sha256(convert_to(lower(btrim('x')), 'UTF8')), 'hex')) OR kb_learn_topic_drafted(a_acct, ARRAY[g3], encode(sha256(convert_to(lower(btrim('POS documents')), 'UTF8')), 'hex')) THEN
    failed := failed || 'kb_learn_topic_drafted'::text; END IF; n := n + 1;

  -- ---------- another account's gaps, a bad ref ----------
  res := kb_learn_record_draft(a_acct, NULL, encode(sha256(convert_to(lower(btrim('Other')), 'UTF8')), 'hex'), ARRAY[g_other], 'LRN-DDDDDD', 'q', 'a', NULL, NULL, 1);
  IF res->>'status' <> 'invalid' THEN failed := failed || ('foreign gaps: ' || res::text); END IF; n := n + 1;
  res := kb_learn_record_draft(a_acct, NULL, encode(sha256(convert_to(lower(btrim('POS documents')), 'UTF8')), 'hex'), ARRAY[g3], 'GAP-DDDDDD', 'q', 'a', NULL, NULL, 1);
  IF res->>'status' <> 'invalid' THEN failed := failed || ('bad ref: ' || res::text); END IF; n := n + 1;

  res := kb_learn_record_draft(a_acct, NULL, 'a customer''s own words', ARRAY[g3], 'LRN-DDDDDD', 'q', 'a', NULL, NULL, 1);
  IF res->>'status' <> 'invalid' THEN failed := failed || ('a label stored as the key: ' || res::text); END IF; n := n + 1;

  -- ---------- open topics: the covered and the drafted are left out ----------
  PERFORM kb_gap_topics_replace(a_acct, jsonb_build_array(
    jsonb_build_object('label', 'drafted', 'question_count', 9, 'first_seen_at', now(), 'last_seen_at', now(), 'gap_ids', jsonb_build_array(g1, g2)),
    jsonb_build_object('label', 'covered', 'question_count', 8, 'first_seen_at', now(), 'last_seen_at', now(), 'coverage', 'full', 'gap_ids', jsonb_build_array(g3)),
    jsonb_build_object('label', 'open', 'question_count', 1, 'first_seen_at', now(), 'last_seen_at', now(), 'gap_ids', jsonb_build_array(g3, g4))), '{}');
  SELECT string_agg(t.label || ':' || (t.gap_ids = ARRAY[g4, g3])::text, '|') INTO r FROM kb_learn_open_topics(a_acct, 1) t;
  IF r IS DISTINCT FROM 'open:true' THEN failed := failed || ('open topics: ' || coalesce(r, 'null')); END IF; n := n + 1;
  PERFORM kb_learn_record_discard(a_acct, NULL, encode(sha256(convert_to(a_acct::text || E'\n' || 'open', 'UTF8')), 'hex'), ARRAY[g4], 2);
  IF EXISTS (SELECT 1 FROM kb_learn_open_topics(a_acct)) THEN failed := failed || 'a backed-off topic is still offered'::text; END IF; n := n + 1;
  DELETE FROM kb_learned_drafts WHERE account_id = a_acct AND gap_ids = ARRAY[g4];

  -- ---------- discarded: not again for 28 days ----------
  r := kb_learn_record_discard(a_acct, NULL, repeat('b', 64), ARRAY[g3], 2)::text;
  IF r <> 'true' OR NOT kb_learn_topic_drafted(a_acct, ARRAY[g3], repeat('c', 64)) THEN
    failed := failed || 'a discarded topic is asked again at once'::text; END IF; n := n + 1;
  UPDATE kb_learned_drafts SET discarded_at = now() - interval '29 days' WHERE topic_key = repeat('b', 64);
  IF kb_learn_topic_drafted(a_acct, ARRAY[g3], repeat('b', 64)) THEN
    failed := failed || 'a discard holds for ever'::text; END IF; n := n + 1;
  IF kb_learn_record_discard(a_acct, NULL, repeat('d', 64), ARRAY[g_other], 2) THEN
    failed := failed || 'another account''s gaps discarded'::text; END IF; n := n + 1;
  -- The service role reads every table the names come from.
  IF NOT (has_table_privilege('service_role', 'public.contacts', 'SELECT')
      AND has_table_privilege('service_role', 'public.profiles', 'SELECT')
      AND has_table_privilege('service_role', 'public.submission_groups', 'SELECT')
      AND has_function_privilege('service_role', 'public.kb_learn_case_names(uuid,text,integer)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.kb_learn_case_names(uuid,text,integer)', 'EXECUTE')
      AND has_table_privilege('service_role', 'public.hr_conversations', 'SELECT')) THEN
    failed := failed || 'service_role cannot read a names table'::text; END IF; n := n + 1;

  INSERT INTO desk_customers (account_id, trade_licence_no, legal_name, created_by) VALUES
    (a_acct, '2900001', 'Al Noor Trading LLC', u_owner), (a_acct, '2900002', 'Zenith Foods', u_owner),
    (b_acct, '2900001', 'Other Workspace Co', u_owner2);
  SELECT string_agg(x, '|') INTO r FROM kb_learn_case_names(a_acct) x;
  IF r IS DISTINCT FROM 'Al Noor Trading LLC|Zenith Foods' THEN failed := failed || ('case names: ' || coalesce(r, 'null')); END IF; n := n + 1;
  SELECT string_agg(x, '|') INTO r FROM kb_learn_case_names(a_acct, 'Al Noor Trading LLC') x;
  IF r IS DISTINCT FROM 'Zenith Foods' THEN failed := failed || ('case names page: ' || coalesce(r, 'null')); END IF; n := n + 1;

  -- ---------- removed or deleted: drafted again ----------
  UPDATE kb_entries SET status = 'remove' WHERE id = e1;
  res := kb_learn_record_draft(a_acct, NULL, encode(sha256(convert_to(lower(btrim('Account without a trade licence')), 'UTF8')), 'hex'), ARRAY[g1, g2],
    'LRN-EEEEEE', 'Account without a trade licence', 'Second try.', NULL, NULL, 2);
  e2 := (res->>'entry_id')::uuid;
  IF res->>'status' <> 'drafted' THEN failed := failed || ('not re-drafted after remove: ' || res::text); END IF; n := n + 1;
  DELETE FROM kb_entries WHERE id = e2;
  IF EXISTS (SELECT 1 FROM kb_learned_drafts WHERE entry_id = e2)
     OR NOT EXISTS (SELECT 1 FROM kb_learned_drafts WHERE account_id = a_acct AND entry_id IS NULL) THEN
    failed := failed || 'a deleted draft did not clear its ledger entry'::text; END IF; n := n + 1;
  res := kb_learn_record_draft(a_acct, NULL, encode(sha256(convert_to(lower(btrim('Account without a trade licence')), 'UTF8')), 'hex'), ARRAY[g1, g2],
    'LRN-FFFFFF', 'Account without a trade licence', 'Third try.', NULL, NULL, 2);
  IF res->>'status' <> 'drafted' THEN failed := failed || ('not re-drafted after delete: ' || res::text); END IF; n := n + 1;

  -- ---------- the ledger: admin reads, agent does not, nobody writes ----------
  r := pg_temp.kl_try(u_admin, 'select count(*)::text from public.kb_learned_drafts');
  IF r::int < 1 THEN failed := failed || ('admin cannot read the ledger: ' || r); END IF; n := n + 1;
  r := pg_temp.kl_try(u_agent, 'select count(*)::text from public.kb_learned_drafts');
  IF r <> '0' THEN failed := failed || ('agent read the ledger: ' || r); END IF; n := n + 1;
  r := pg_temp.kl_try(u_agent, 'select count(*)::text from public.kb_learn_settings');
  IF r <> '0' THEN failed := failed || ('agent read the settings: ' || r); END IF; n := n + 1;
  r := pg_temp.kl_try(u_admin, 'insert into public.kb_learned_drafts (account_id, topic_key, evidence_count) values (''' || a_acct || ''', repeat(''a'', 64), 1)');
  IF r NOT LIKE 'ERROR:%' THEN failed := failed || ('admin wrote the ledger: ' || r); END IF; n := n + 1;
  r := pg_temp.kl_try(u_owner2, 'select count(*)::text from public.kb_learned_drafts');
  IF r <> '0' THEN failed := failed || ('another workspace read the ledger: ' || r); END IF; n := n + 1;

  -- ---------- switched off again: nothing ----------
  r := pg_temp.kl_try(u_owner, 'select (public.kb_learn_set_enabled(false))->>''enabled''');
  res := kb_learn_record_draft(a_acct, NULL, encode(sha256(convert_to(lower(btrim('POS documents')), 'UTF8')), 'hex'), ARRAY[g3], 'LRN-GGGGGG', 'POS documents', 'a', NULL, NULL, 1);
  IF r <> 'false' OR res->>'status' <> 'disabled' OR kb_learn_claim_run(a_acct, interval '0') THEN
    failed := failed || ('off again: ' || r || ' ' || res::text); END IF; n := n + 1;

  -- ---------- usage mode, grants ----------
  BEGIN
    INSERT INTO ai_usage_log (account_id, mode, provider, model) VALUES (a_acct, 'kb_learn', 'openai', 'm');
    r := 'ok';
  EXCEPTION WHEN check_violation THEN r := 'rejected';
  END;
  IF r <> 'ok' THEN failed := failed || 'usage log refused kb_learn'::text; END IF; n := n + 1;
  IF has_function_privilege('authenticated', 'public.kb_learn_record_draft(uuid,uuid,text,uuid[],text,text,text,text,text,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.kb_learn_claim_run(uuid,interval)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.kb_learn_finish_run(uuid,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.kb_learn_topic_drafted(uuid,uuid[],text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.kb_learn_open_topics(uuid,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.kb_learn_record_discard(uuid,uuid,text,uuid[],integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.kb_learn_record_discard(uuid,uuid,text,uuid[],integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.kb_learn_set_enabled(boolean)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.kb_learn_record_draft(uuid,uuid,text,uuid[],text,text,text,text,text,integer)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.kb_learned_drafts', 'INSERT')
     OR has_table_privilege('authenticated', 'public.kb_learn_settings', 'UPDATE') THEN
    failed := failed || 'grants'::text; END IF; n := n + 1;

  IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'ai_usage_log_mode_check')) !~ 'auto_reply.*draft.*translate.*hr_agent.*kb_learn'
     OR NOT (SELECT convalidated FROM pg_constraint WHERE conname = 'ai_usage_log_mode_check') THEN
    failed := failed || 'usage mode check'::text; END IF; n := n + 1;

  RAISE EXCEPTION 'KL_ROLLBACK';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'KL_ROLLBACK' THEN RAISE; END IF;
  END;

  IF n <> 40 THEN RAISE EXCEPTION 'verify-kb-learn: only % checks ran', n; END IF;
  IF cardinality(failed) > 0 THEN
    RAISE EXCEPTION 'verify-kb-learn: % failed: %', cardinality(failed), array_to_string(failed, '; ');
  END IF;
  RAISE NOTICE 'verify-kb-learn: % checks passed', n;
END $verify$;
