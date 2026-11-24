-- Verifies 309_case_config_versions.sql: a stage list, a file spec and an
-- intake wording approval are refused when what the page had loaded is no
-- longer stored, a drop of a stage in use is asked about first, and the
-- old signatures still work. One statement; fixtures rolled back.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000309001';
  u_admin UUID := '00000000-0000-4000-8000-000000309002';
  u_agent UUID := '00000000-0000-4000-8000-000000309003';
  acct    UUID;
  base    TEXT[];
  one     TEXT[];
  two     TEXT[];
  spec    JSONB := '[{"doc_key": "passport", "position": 1, "name_pattern": "{{doc}}", "required": true, "max_mb": 10,
                      "allowed_mime": ["application/pdf"], "min_valid_days": null, "merged": true}]';
  j       JSONB;
  ts      TIMESTAMPTZ;
  fn      TEXT;
  rl      TEXT;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ccv_hint(p_sql text) RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE h text;
    BEGIN
      EXECUTE p_sql;
      RETURN 'ok';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
      RETURN coalesce(nullif(h, ''), SQLERRM);
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ccv_is(p_name text, p_got text, p_want text) RETURNS text LANGUAGE sql AS
    $body$ SELECT CASE WHEN p_got IS DISTINCT FROM p_want
      THEN p_name || ' got ' || coalesce(p_got, 'NULL') || ' want ' || coalesce(p_want, 'NULL') END $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'ccv-owner@example.invalid'), (u_admin, 'ccv-admin@example.invalid'),
    (u_agent, 'ccv-agent@example.invalid');
  SELECT account_id INTO acct FROM public.profiles WHERE user_id = u_owner;
  UPDATE public.profiles SET account_id = acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE public.profiles SET account_id = acct, account_role = 'agent' WHERE user_id = u_agent;
  PERFORM public.case_bank_upsert(u_owner, acct, 'CCV', 'CCV bank');

  -- ---------- stages ----------
  base := public.case_stages_for_bank(acct, 'CCV');
  one := array_cat(array_append(base[1:cardinality(base) - 4], 'ccv one'), base[cardinality(base) - 3:]);
  two := array_cat(array_append(base[1:cardinality(base) - 4], 'ccv two'), base[cardinality(base) - 3:]);
  j := public.case_bank_stages_set(u_admin, acct, 'CCV', one, base, false);
  n := n + 1; failed := array_append(failed, pg_temp.ccv_is('first save', j ->> 'saved', 'true'));
  -- The owner still holds the list as it was.
  n := n + 1; failed := array_append(failed, pg_temp.ccv_is('stale stages',
    pg_temp.ccv_hint(format('SELECT public.case_bank_stages_set(%L, %L, %L, %L::text[], %L::text[], true)', u_owner, acct, 'CCV', two, base)),
    'STAGES_CHANGED'));
  n := n + 1; failed := array_append(failed, pg_temp.ccv_is('list kept',
    public.case_stages_for_bank(acct, 'CCV')::text, one::text));
  n := n + 1; failed := array_append(failed, pg_temp.ccv_is('agent refused',
    pg_temp.ccv_hint(format('SELECT public.case_bank_stages_set(%L, %L, %L, %L::text[], %L::text[], true)', u_agent, acct, 'CCV', two, one)),
    'NOT_ALLOWED'));

  -- A dropped stage a Compass status and a deadline rule point to.
  INSERT INTO public.case_status_stage_map (account_id, status_key, status_label, stage, source)
  VALUES (acct, 'CCV STATUS', 'Ccv status', 'ccv one', 'admin'),
         (acct, 'CCV OTHER', 'Ccv other', 'ccv elsewhere', 'admin');
  INSERT INTO public.case_sla_config (account_id, bank_code, stage, timer, amount, unit)
  VALUES (acct, 'CCV', 'ccv one', 'bank_response', 2, 'days');
  j := public.case_bank_stages_set(u_owner, acct, 'CCV', two, one, false);
  n := n + 1; failed := array_append(failed, pg_temp.ccv_is('asked first', j::text,
    '{"sla": [{"stage": "ccv one", "timer": "bank_response"}], "saved": false, "mappings": [{"stage": "ccv one", "status": "Ccv status"}]}'));
  n := n + 1; failed := array_append(failed, pg_temp.ccv_is('nothing saved yet',
    public.case_stages_for_bank(acct, 'CCV')::text, one::text));
  j := public.case_bank_stages_set(u_owner, acct, 'CCV', two, one, true);
  n := n + 1; failed := array_append(failed, pg_temp.ccv_is('saved once confirmed', j ->> 'saved', 'true'));
  n := n + 1; failed := array_append(failed, pg_temp.ccv_is('new list',
    public.case_stages_for_bank(acct, 'CCV')::text, two::text));
  -- The running build's call, and a back-to-defaults without a check.
  n := n + 1; failed := array_append(failed, pg_temp.ccv_is('old signature',
    public.case_bank_stages_set(u_owner, acct, 'CCV', one)::text, cardinality(one)::text));
  j := public.case_bank_stages_set(u_owner, acct, 'CCV', '{}', NULL, true);
  n := n + 1; failed := array_append(failed, pg_temp.ccv_is('reset', j ->> 'count', '0'));

  -- ---------- file spec ----------
  INSERT INTO public.case_doc_requirements (account_id, bank_code, product, doc_key, label)
  VALUES (acct, 'CCV', 'Loan', 'passport', 'Passport');
  n := n + 1; failed := array_append(failed, pg_temp.ccv_is('spec first save',
    pg_temp.ccv_hint(format('SELECT public.case_file_spec_set(%L, %L, %L, %L::jsonb, %L::jsonb)', u_admin, 'CCV', 'Loan', spec, '[]')), 'ok'));
  n := n + 1; failed := array_append(failed, pg_temp.ccv_is('stale spec',
    pg_temp.ccv_hint(format('SELECT public.case_file_spec_set(%L, %L, %L, %L::jsonb, %L::jsonb)', u_owner, 'CCV', 'Loan', '[]', '[]')),
    'SPEC_CHANGED'));
  n := n + 1; failed := array_append(failed, pg_temp.ccv_is('spec agent',
    pg_temp.ccv_hint(format('SELECT public.case_file_spec_set(%L, %L, %L, %L::jsonb, %L::jsonb)', u_agent, 'CCV', 'Loan', '[]', spec)),
    'NOT_ALLOWED'));
  n := n + 1; failed := array_append(failed, pg_temp.ccv_is('current spec',
    pg_temp.ccv_hint(format('SELECT public.case_file_spec_set(%L, %L, %L, %L::jsonb, %L::jsonb)', u_owner, 'CCV', ' loan ', '[]', spec)), 'ok'));

  -- ---------- intake wording ----------
  PERFORM public.case_intake_template_set(u_admin, acct, 'document_rejected', 'first');
  SELECT updated_at INTO ts FROM public.case_intake_templates WHERE account_id = acct AND kind = 'document_rejected';
  UPDATE public.case_intake_templates SET body = 'second', updated_at = ts + interval '1 microsecond'
   WHERE account_id = acct AND kind = 'document_rejected';
  n := n + 1; failed := array_append(failed, pg_temp.ccv_is('unread wording',
    pg_temp.ccv_hint(format('SELECT public.case_intake_template_approve(%L, %L, %L, %L)', u_owner, acct, 'document_rejected', ts)),
    'TEMPLATE_CHANGED'));
  n := n + 1; failed := array_append(failed, pg_temp.ccv_is('not approved',
    (SELECT approved::text FROM public.case_intake_templates WHERE account_id = acct AND kind = 'document_rejected'), 'false'));
  n := n + 1; failed := array_append(failed, pg_temp.ccv_is('admin may not approve',
    pg_temp.ccv_hint(format('SELECT public.case_intake_template_approve(%L, %L, %L, %L)', u_admin, acct, 'document_rejected', ts)),
    'NOT_ALLOWED'));
  j := public.case_intake_template_approve(u_owner, acct, 'document_rejected', ts + interval '1 microsecond');
  n := n + 1; failed := array_append(failed, pg_temp.ccv_is('approved row',
    (j ->> 'body') || '/' || (j ->> 'approved'), 'second/true'));

  -- ---------- grants ----------
  FOREACH fn IN ARRAY ARRAY[
    'public.case_bank_stages_set(uuid, uuid, text, text[], text[], boolean)',
    'public.case_file_spec_set(uuid, text, text, jsonb, jsonb)',
    'public.case_intake_template_approve(uuid, uuid, text, timestamptz)'] LOOP
    FOREACH rl IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      n := n + 1; failed := array_append(failed, pg_temp.ccv_is(fn || ' ' || rl,
        has_function_privilege(rl, fn, 'EXECUTE')::text, (rl = 'service_role')::text));
    END LOOP;
  END LOOP;

  RAISE EXCEPTION USING ERRCODE = 'ZT309', MESSAGE = 'verify-case-config-versions rollback';
  EXCEPTION WHEN SQLSTATE 'ZT309' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'case config versions verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'case config versions verification passed (% checks)', n;
END
$verify$;
