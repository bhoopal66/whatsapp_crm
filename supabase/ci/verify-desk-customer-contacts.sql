-- Behavioural regression suite for company contacts (migration 229).
--
-- A desk case's own contact is linked to its company automatically; a
-- writer of one of the company's cases (or a team leader and up) links
-- other contacts with a role and an authorised flag, only contacts they
-- can see; someone with no case of the company learns nothing about it.
-- One phone may act for several companies (desk_customers_for_contact
-- lists both). privacy_extensions: 221's export carries the registered
-- section, 222's erase runs a registered erase (counts and objects) and
-- keeps the links. Tables and the registry are closed to every API role.
--
-- ONE statement on purpose: `supabase db query --file` sends the file as
-- a single prepared statement and rejects several. Fixtures are rolled
-- back by a sentinel exception; failures are named in the final one.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000229001';
  u_lead   UUID := '00000000-0000-4000-8000-000000229002';
  u_agent  UUID := '00000000-0000-4000-8000-000000229003';  -- agent of the Kite case
  u_agent2 UUID := '00000000-0000-4000-8000-000000229004';  -- agent of the Maro case only
  u_crak   UUID := '00000000-0000-4000-8000-000000229005';  -- holds RAK
  u_bown   UUID := '00000000-0000-4000-8000-000000229006';  -- owner of account B
  a_acct   UUID;
  b_acct   UUID;
  c1       UUID;  -- Kite's case contact
  c2       UUID;  -- a PRO, agent's own contact
  c3       UUID;  -- Maro's case contact, agent2's
  c_b      UUID;  -- a contact of account B
  k1       UUID;
  cu1      UUID;
  cu2      UUID;
  r        RECORD;
  j        JSONB;
  v        TEXT;
  b1       BOOLEAN;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- A statement as p_role (NULL: the current user): a SELECT's value,
  -- 'ok', or 'ERROR <sqlstate> <hint>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.dc_try(p_role text, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; h text;
    BEGIN
      BEGIN
        IF p_role IS NOT NULL THEN
          EXECUTE format('SET LOCAL ROLE %I', p_role);
        END IF;
        IF p_sql ILIKE 'select%' THEN
          EXECUTE p_sql INTO v;
        ELSE
          EXECUTE p_sql;
        END IF;
        RESET ROLE;
        RETURN coalesce(v, 'ok');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
        RESET ROLE;
        RETURN 'ERROR ' || SQLSTATE || ' ' || coalesce(nullif(h, ''), '-') || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.dc_check(p_name text, p_role text, p_sql text, p_like text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := pg_temp.dc_try(p_role, p_sql);
    BEGIN
      RETURN CASE WHEN v LIKE p_like THEN NULL ELSE p_name || ' (' || v || ')' END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.dc_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'dcc-owner@example.invalid'), (u_lead, 'dcc-lead@example.invalid'),
    (u_agent, 'dcc-agent@example.invalid'), (u_agent2, 'dcc-agent2@example.invalid'),
    (u_crak, 'dcc-crak@example.invalid'), (u_bown, 'dcc-bown@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_bown;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agent, u_agent2, u_crak);
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500229001', 'DCC one')
    RETURNING id INTO c1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500229002', 'DCC pro')
    RETURNING id INTO c2;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent2, '971500229003', 'DCC three')
    RETURNING id INTO c3;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (b_acct, u_bown, '971500229004', 'DCC other')
    RETURNING id INTO c_b;
  INSERT INTO case_banks (account_id, code, name) VALUES
    (a_acct, 'RAK', 'RAKBANK'), (a_acct, 'ENBD', 'Emirates NBD')
  ON CONFLICT DO NOTHING;
  INSERT INTO coordinator_banks (account_id, user_id, bank_code) VALUES (a_acct, u_crak, 'RAK');
  PERFORM desk_bank_code_set(u_owner, a_acct, 'RAK', 'RAK');
  PERFORM desk_bank_code_set(u_owner, a_acct, 'ENBD', 'ENB');
  SELECT x.case_id, x.customer_id INTO k1, cu1
    FROM desk_case_open(a_acct, 'DCC-1', 'Kite General Trading', 'RAK', 'Business account', c1, u_agent, NULL, now()) x;
  SELECT x.customer_id INTO cu2
    FROM desk_case_open(a_acct, 'DCC-2', 'Maro Trading', 'ENBD', 'Business account', c3, u_agent2, NULL, now()) x;

  -- ---------- 1. the case contact is linked automatically ----------
  SELECT * INTO r FROM desk_customer_contacts l WHERE l.customer_id = cu1 AND l.contact_id = c1;
  n := n + 1; failed := failed || pg_temp.dc_ok(FOUND AND r.role = 'other' AND NOT r.authorised AND r.added_by IS NULL,
    'a desk case''s contact was not linked to its company (other, not authorised, automatic)');

  -- ---------- 2. the case writer links a PRO; an update reports no new row ----------
  n := n + 1; failed := failed || pg_temp.dc_ok(desk_customer_contact_set(u_agent, a_acct, cu1, c2, 'pro', true),
    'linking a new contact did not report a new row');
  n := n + 1; failed := failed || pg_temp.dc_ok(NOT desk_customer_contact_set(u_agent, a_acct, cu1, c2, 'accountant', true),
    'updating a link reported a new row');
  SELECT * INTO r FROM desk_customer_contacts l WHERE l.customer_id = cu1 AND l.contact_id = c2;
  n := n + 1; failed := failed || pg_temp.dc_ok(r.role = 'accountant' AND r.authorised AND r.added_by = u_agent
    AND r.updated_by = u_agent, 'the update did not change the role, or lost who added it');

  -- ---------- 3. who ----------
  n := n + 1; failed := failed || pg_temp.dc_check('an agent with no case of the company listed its contacts', NULL,
    format('SELECT count(*)::text FROM desk_customer_contacts_list(%L, %L, %L)', u_agent2, a_acct, cu1),
    'ERROR % CUSTOMER_NOT_FOUND:%');
  n := n + 1; failed := failed || pg_temp.dc_check('an agent with no case of the company linked a contact', NULL,
    format('SELECT desk_customer_contact_set(%L, %L, %L, %L, ''pro'', false)::text', u_agent2, a_acct, cu1, c3),
    'ERROR % CUSTOMER_NOT_FOUND:%');
  n := n + 1; failed := failed || pg_temp.dc_check('an agent with no case of the company removed a contact', NULL,
    format('SELECT desk_customer_contact_remove(%L, %L, %L, %L)::text', u_agent2, a_acct, cu1, c2),
    'ERROR % CUSTOMER_NOT_FOUND:%');
  n := n + 1; failed := failed || pg_temp.dc_check('another workspace''s owner reached the company', NULL,
    format('SELECT count(*)::text FROM desk_customer_contacts_list(%L, %L, %L)', u_bown, b_acct, cu1),
    'ERROR % CUSTOMER_NOT_FOUND:%');
  n := n + 1; failed := failed || pg_temp.dc_check('a team leader could not list a company''s contacts', NULL,
    format('SELECT count(*)::text FROM desk_customer_contacts_list(%L, %L, %L)', u_lead, a_acct, cu1), '2');
  n := n + 1; failed := failed || pg_temp.dc_check('the bank''s coordinator could not list the company''s contacts', NULL,
    format('SELECT count(*)::text FROM desk_customer_contacts_list(%L, %L, %L)', u_crak, a_acct, cu1), '2');
  n := n + 1; failed := failed || pg_temp.dc_check('a contact the agent cannot see was linked', NULL,
    format('SELECT desk_customer_contact_set(%L, %L, %L, %L, ''pro'', false)::text', u_agent, a_acct, cu1, c3),
    'ERROR % CONTACT_INVALID:%');
  n := n + 1; failed := failed || pg_temp.dc_check('another workspace''s contact was linked', NULL,
    format('SELECT desk_customer_contact_set(%L, %L, %L, %L, ''pro'', false)::text', u_owner, a_acct, cu1, c_b),
    'ERROR % CONTACT_INVALID:%');
  n := n + 1; failed := failed || pg_temp.dc_check('an unknown role was accepted', NULL,
    format('SELECT desk_customer_contact_set(%L, %L, %L, %L, ''director'', false)::text', u_agent, a_acct, cu1, c2),
    'ERROR % INVALID:%');
  n := n + 1; failed := failed || pg_temp.dc_check('the role CHECK let a bad role in', NULL,
    format('UPDATE desk_customer_contacts SET role = ''x'' WHERE customer_id = %L', cu1), 'ERROR 23514%');

  -- ---------- 4. one phone, two companies ----------
  PERFORM desk_customer_contact_set(u_owner, a_acct, cu2, c2, 'pro', true);
  SELECT count(*) = 2 AND bool_and(x.authorised) INTO b1 FROM desk_customers_for_contact(a_acct, c2) x;
  n := n + 1; failed := failed || pg_temp.dc_ok(b1, 'a PRO linked to two companies did not list both');
  n := n + 1; failed := failed || pg_temp.dc_ok((SELECT count(*) FROM desk_customers_for_contact(b_acct, c2)) = 0,
    'desk_customers_for_contact answered for another workspace');

  -- ---------- 5. find ----------
  n := n + 1; failed := failed || pg_temp.dc_check('a team leader could not find the company by name', NULL,
    format('SELECT string_agg(x.legal_name, '','') FROM desk_customer_find(%L, %L, ''kite'') x', u_lead, a_acct),
    'Kite General Trading');
  n := n + 1; failed := failed || pg_temp.dc_check('the company could not be found by licence', NULL,
    format('SELECT x.contacts::text || x.can_manage::text FROM desk_customer_find(%L, %L, ''dcc 1'') x', u_agent, a_acct),
    '2true');
  n := n + 1; failed := failed || pg_temp.dc_check('an agent with no case of the company found it', NULL,
    format('SELECT count(*)::text FROM desk_customer_find(%L, %L, ''kite'') x', u_agent2, a_acct), '0');
  n := n + 1; failed := failed || pg_temp.dc_check('a one-character search ran', NULL,
    format('SELECT count(*)::text FROM desk_customer_find(%L, %L, ''k'') x', u_lead, a_acct), 'ERROR % INVALID:%');
  n := n + 1; failed := failed || pg_temp.dc_check('someone outside the workspace searched it', NULL,
    format('SELECT count(*)::text FROM desk_customer_find(%L, %L, ''kite'') x', u_bown, a_acct), 'ERROR % NOT_ALLOWED:%');

  -- ---------- 6. remove ----------
  n := n + 1; failed := failed || pg_temp.dc_ok(desk_customer_contact_remove(u_agent, a_acct, cu1, c2),
    'removing a link reported nothing removed');
  n := n + 1; failed := failed || pg_temp.dc_ok(NOT desk_customer_contact_remove(u_agent, a_acct, cu1, c2),
    'removing a missing link reported a removal');
  n := n + 1; failed := failed || pg_temp.dc_ok((SELECT count(*) FROM desk_customers_for_contact(a_acct, c2)) = 1,
    'removing one company''s link touched the other''s');

  -- ---------- 7. privacy: export section, erase hook, links kept ----------
  j := privacy_subject_export(u_owner, a_acct, c1);
  n := n + 1; failed := failed || pg_temp.dc_ok(
    jsonb_array_length(j->'data'->'desk_company_links') = 1
    AND j->'data'->'desk_company_links'->0->>'company' = 'Kite General Trading',
    'the export did not carry the registered desk_company_links section');
  EXECUTE $fn$
    CREATE FUNCTION public.privacy_zz229_erase(p_account uuid, p_contact uuid)
    RETURNS jsonb LANGUAGE sql AS $body$
      SELECT jsonb_build_object('counts', jsonb_build_object('zz229', 7),
                                'objects', jsonb_build_array(
                                  jsonb_build_object('bucket', 'zz', 'path', 'account-' || p_account || '/zz/1'),
                                  jsonb_build_object('bucket', 'zz', 'path', 'zz/1')))
    $body$
  $fn$;
  INSERT INTO privacy_extensions (name, export_fn, erase_fn, added_in)
  VALUES ('zz229', 'privacy_desk_contacts_export', 'privacy_zz229_erase', 'verify');
  j := privacy_subject_erase(u_owner, a_acct, c1, true);
  n := n + 1; failed := failed || pg_temp.dc_ok((j->'counts'->>'zz229') = '7' AND (j->>'objects_count')::int >= 1,
    'the erase did not run a registered erase (counts and objects)');
  j := privacy_subject_erase(u_owner, a_acct, c1, false, 'ERASE ' || c1::text);
  n := n + 1; failed := failed || pg_temp.dc_ok(
    EXISTS (SELECT 1 FROM desk_customer_contacts l WHERE l.customer_id = cu1 AND l.contact_id = c1)
    AND (SELECT x.name FROM contacts x WHERE x.id = c1) = 'Erased customer'
    AND j->'objects' @> jsonb_build_array(jsonb_build_object('bucket', 'zz', 'path', 'account-' || a_acct || '/zz/1')),
    'an erasure dropped the company link, kept the name, or lost a registered object');
  -- 262: a registered erase cannot queue a file outside the workspace's folder.
  n := n + 1; failed := failed || pg_temp.dc_ok(NOT (j->'objects' @> '[{"bucket": "zz", "path": "zz/1"}]'::jsonb),
    '262: a registered erase queued a file outside the workspace''s own folder');
  n := n + 1; failed := failed || pg_temp.dc_check('a registry name in a bad shape was stored', NULL,
    'INSERT INTO privacy_extensions (name, export_fn, added_in) VALUES (''Bad name'', ''privacy_x'', ''x'')',
    'ERROR 23514%');
  n := n + 1; failed := failed || pg_temp.dc_check('a registry function outside privacy_* was stored', NULL,
    'INSERT INTO privacy_extensions (name, export_fn, added_in) VALUES (''x'', ''pg_sleep'', ''x'')',
    'ERROR 23514%');

  -- ---------- 8. closed to API roles ----------
  n := n + 1; failed := failed || pg_temp.dc_check('authenticated read desk_customer_contacts', 'authenticated',
    'SELECT count(*)::text FROM public.desk_customer_contacts', 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.dc_check('service_role read desk_customer_contacts directly', 'service_role',
    'SELECT count(*)::text FROM public.desk_customer_contacts', 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.dc_check('service_role read privacy_extensions', 'service_role',
    'SELECT count(*)::text FROM public.privacy_extensions', 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.dc_check('authenticated called desk_customer_contacts_list', 'authenticated',
    format('SELECT count(*)::text FROM desk_customer_contacts_list(%L, %L, %L)', u_lead, a_acct, cu1), 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.dc_check('service_role called the export section directly', 'service_role',
    format('SELECT privacy_desk_contacts_export(%L, %L)::text', a_acct, c1), 'ERROR 42501%');

  RAISE EXCEPTION USING ERRCODE = 'ZT229', MESSAGE = 'verify-desk-customer-contacts rollback';
  EXCEPTION WHEN SQLSTATE 'ZT229' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'company contacts verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'company contacts verification passed (% checks)', n;
END
$verify$;
