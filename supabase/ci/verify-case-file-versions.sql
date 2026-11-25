-- Migration 320: the document attached last is the type's newest version.
-- One statement; rolled back by the sentinel at its end.
DO $$
DECLARE
  u_owner uuid := '00000000-0000-4000-8000-000000320001';
  u_agent uuid := '00000000-0000-4000-8000-000000320002';
  u_coord uuid := '00000000-0000-4000-8000-000000320003';
  a uuid; w uuid; c uuid; c2 uuid; g uuid; g2 uuid; k uuid; k2 uuid;
  f1 uuid; f2 uuid; v1 uuid; o1 uuid; d text;
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cfv_file(p_actor uuid, p_case uuid) RETURNS uuid LANGUAGE sql AS $body$
      SELECT public.case_document_file_register(p_actor, p_case,
        (SELECT x.document_id FROM public.customer_documents_record_internal(c.account_id, c.contact_id, 'staff_upload',
          'document', 'case-files', 'v320/' || gen_random_uuid()::text || '.pdf', now(), 'application/pdf',
          'scan.pdf', NULL, k.user_id) x))
        FROM public.cases c JOIN public.contacts k ON k.id = c.contact_id WHERE c.id = p_case
    $body$
  $fn$;
  -- Attached as the app does it: classified as it was read, then checked.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cfv_attach(p_actor uuid, p_file uuid, p_key text, p_ok boolean) RETURNS text
    LANGUAGE plpgsql AS $body$
    DECLARE f public.case_document_files%ROWTYPE; v record;
    BEGIN
      SELECT * INTO f FROM public.case_document_files x WHERE x.id = p_file;
      SELECT * INTO v FROM public.case_document_file_classify(p_actor, p_file, p_key, f.classify_seq, f.status);
      PERFORM public.case_document_file_check_result(p_file, p_key, v.classify_seq,
        jsonb_build_array(jsonb_build_object('name', 'expiry', 'ok', p_ok)), 1, NULL);
      SELECT * INTO f FROM public.case_document_files x WHERE x.id = p_file;
      RETURN f.doc_key || ':v' || f.version || ':' || f.status || ':' || (v.version = f.version)::text;
    END $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'cf320-owner@example.invalid'), (u_agent, 'cf320-agent@example.invalid'),
    (u_coord, 'cf320-coord@example.invalid');
  SELECT account_id INTO a FROM profiles WHERE user_id = u_owner;
  UPDATE profiles SET account_id = a, account_role = 'agent' WHERE user_id IN (u_agent, u_coord);
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a, 'whapi', 'CF320-1', 'x', 'connected', true) RETURNING id INTO w;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a, u_owner, '971500320001', 'CF320 one') RETURNING id INTO c;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a, u_owner, '971500320002', 'CF320 two') RETURNING id INTO c2;
  g := (SELECT o.group_id FROM sg_open(a, 'CF320-A', c, w, 'a', NULL,
    jsonb_build_array(jsonb_build_object('user_id', u_coord, 'label', 'coordinator'),
                      jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL) o);
  g2 := (SELECT o.group_id FROM sg_open(a, 'CF320-B', c2, w, 'b', NULL,
    jsonb_build_array(jsonb_build_object('user_id', u_coord, 'label', 'coordinator'),
                      jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL) o);
  k := (SELECT x.case_id FROM case_open(g, 'CF320B', 'Bank CF320', 'Loan', 1000, NULL) x);
  k2 := (SELECT x.case_id FROM case_open(g2, 'CF320B', 'Bank CF320', 'Loan', 1000, NULL) x);
  INSERT INTO case_doc_requirements (account_id, bank_code, product, doc_key, label, position) VALUES
    (a, 'CF320B', 'Loan', 'passport', 'Passport', 1), (a, 'CF320B', 'Loan', 'visa', 'Visa', 2);
  v1 := pg_temp.cfv_file(u_agent, k);
  d := pg_temp.cfv_attach(u_agent, v1, 'visa', true);
  ASSERT d = 'visa:v1:passed:true', 'fixture: the visa: ' || d;

  -- ---------- 1. Back to a good document after a bad upload ----------
  f1 := pg_temp.cfv_file(u_agent, k);
  f2 := pg_temp.cfv_file(u_agent, k);
  d := pg_temp.cfv_attach(u_agent, f1, 'passport', true);
  ASSERT d = 'passport:v1:passed:true' AND case_file_ready(k), 'fixture: ready on v1: ' || d;
  d := pg_temp.cfv_attach(u_agent, f2, 'passport', false);
  ASSERT d = 'passport:v2:failed:true' AND NOT case_file_ready(k), 'fixture: v2 failed: ' || d;
  d := pg_temp.cfv_attach(u_agent, f1, 'passport', true);
  ASSERT d = 'passport:v3:passed:true', 'the good document is not the newest: ' || d;
  ASSERT case_file_ready(k), 'attached again, the case is still not ready';

  -- ---------- 2. Attached again with the right date ----------
  d := pg_temp.cfv_attach(u_agent, f2, 'passport', true);
  ASSERT d = 'passport:v4:passed:true', 'the corrected document is not the newest: ' || d;
  ASSERT (SELECT status = 'superseded' FROM case_document_files WHERE id = f1), 'its pass did not replace the other';
  ASSERT case_file_ready(k), 'the corrected document un-readied the case';

  -- ---------- 3. The newest one keeps its version ----------
  -- Versions of another type, or of another case, are not newer ones.
  d := pg_temp.cfv_attach(u_agent, f2, 'passport', false);
  ASSERT d = 'passport:v4:failed:true', 'the newest file took a new version: ' || d;
  d := pg_temp.cfv_attach(u_agent, f2, 'passport', true);
  ASSERT d = 'passport:v4:passed:true', 'the newest failed file took a new version: ' || d;
  d := pg_temp.cfv_attach(u_agent, v1, 'visa', true);
  ASSERT d = 'visa:v1:passed:true', 'another type counted: ' || d;
  o1 := pg_temp.cfv_file(u_agent, k2);
  d := pg_temp.cfv_attach(u_agent, o1, 'passport', false);
  ASSERT d = 'passport:v1:failed:true', 'fixture: the other case: ' || d;
  d := pg_temp.cfv_attach(u_agent, o1, 'passport', true);
  ASSERT d = 'passport:v1:passed:true', 'another case counted: ' || d;

  -- ---------- 4. The name's day, the grants ----------
  ASSERT (SELECT renamed_name = 'CF320-A_passport_' || to_char((now() AT TIME ZONE 'Asia/Dubai')::date, 'YYYYMMDD') || '.pdf'
            FROM case_document_files WHERE id = f2), 'the name is not dated in Dubai';
  -- Between 00:00 and 20:00 UTC both days are one.
  d := pg_get_functiondef('public.case_document_file_classify(uuid,uuid,text,integer,text)'::regprocedure);
  ASSERT position('v_now AT TIME ZONE ''Asia/Dubai''' IN d) > 0 AND position('''UTC''' IN d) = 0, 'the day is not Dubai''s';
  ASSERT (SELECT count(*) = 1 AND bool_and(p.prosecdef AND has_function_privilege('service_role', p.oid, 'EXECUTE')
                 AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
                 AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'))
            FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'case_document_file_classify'), 'grants';
  RAISE EXCEPTION USING ERRCODE = 'ZT320', MESSAGE = 'verify-case-file-versions rollback';
  EXCEPTION WHEN SQLSTATE 'ZT320' THEN
    NULL;
  END;
  RAISE NOTICE 'verify-case-file-versions: passed';
END $$;
