-- Behavioural regression suite for an agent's own desk leave (migration 328).
--
-- Any live staff records, reads, changes and cancels their own leave; a
-- team leader and up does so for anyone; an agent never for someone
-- else; a viewer and a bank guest not at all.
--
-- ONE statement on purpose: `supabase db query --file` sends the file as
-- a single prepared statement and rejects several. Fixtures are rolled
-- back by a sentinel exception; failures are named in the final one.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000328001';
  u_lead   UUID := '00000000-0000-4000-8000-000000328002';
  u_agent  UUID := '00000000-0000-4000-8000-000000328003';
  u_other  UUID := '00000000-0000-4000-8000-000000328004';
  u_viewer UUID := '00000000-0000-4000-8000-000000328005';
  u_guest  UUID := '00000000-0000-4000-8000-000000328006';
  a_acct   UUID;
  today    DATE := (now() AT TIME ZONE 'Asia/Dubai')::date;
  lv_own   UUID;
  lv_other UUID;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.dol_try(p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; h text;
    BEGIN
      BEGIN
        EXECUTE p_sql INTO v;
        RETURN coalesce(v, 'ok');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
        RETURN 'ERROR ' || SQLSTATE || ' ' || coalesce(nullif(h, ''), '-') || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.dol_check(p_name text, p_sql text, p_like text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := pg_temp.dol_try(p_sql);
    BEGIN
      RETURN CASE WHEN v LIKE p_like THEN NULL ELSE p_name || ' (' || v || ')' END;
    END $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'dol328-owner@example.invalid'), (u_lead, 'dol328-lead@example.invalid'),
    (u_agent, 'dol328-agent@example.invalid'), (u_other, 'dol328-other@example.invalid'),
    (u_viewer, 'dol328-viewer@example.invalid'), (u_guest, 'dol328-guest@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agent, u_other);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_viewer;
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_guest;

  -- ---------- 1. an agent's own leave ----------
  lv_own := desk_leave_add(u_agent, a_acct, u_agent, today, today + 2, 'annual');
  n := n + 1; failed := failed || pg_temp.dol_check('an agent could not read their own leave',
    format('SELECT string_agg(id::text || ''|'' || first_day || ''|'' || last_day, '','') FROM desk_my_leave(%L, %L)', u_agent, a_acct),
    lv_own::text || '|' || today || '|' || (today + 2));
  n := n + 1; failed := failed || pg_temp.dol_check('an agent could not change their own leave',
    format('SELECT desk_leave_change(%L, %L, %L, %L, %L, NULL)::text', u_agent, a_acct, lv_own, today + 1, today + 5),
    'true');
  n := n + 1; failed := failed || pg_temp.dol_check('the change did not take',
    format('SELECT first_day || ''|'' || last_day FROM desk_my_leave(%L, %L)', u_agent, a_acct),
    (today + 1) || '|' || (today + 5));
  n := n + 1; failed := failed || pg_temp.dol_check('a change into the past was accepted',
    format('SELECT desk_leave_change(%L, %L, %L, %L, %L, NULL)::text', u_agent, a_acct, lv_own, today - 5, today - 2),
    'ERROR % INVALID:%');
  n := n + 1; failed := failed || pg_temp.dol_check('a change of missing leave did not answer false',
    format('SELECT desk_leave_change(%L, %L, %L, %L, %L, NULL)::text', u_agent, a_acct, gen_random_uuid(), today, today),
    'false');

  -- ---------- 2. someone else's leave ----------
  n := n + 1; failed := failed || pg_temp.dol_check('an agent recorded another person''s leave',
    format('SELECT desk_leave_add(%L, %L, %L, %L, %L, NULL)::text', u_agent, a_acct, u_other, today, today),
    'ERROR % NOT_ALLOWED:%');
  n := n + 1; failed := failed || pg_temp.dol_check('a team leader could not record another person''s leave',
    format('SELECT desk_leave_add(%L, %L, %L, %L, %L, NULL)::text', u_lead, a_acct, u_other, today, today + 1),
    '________-____-____-____-____________');
  SELECT l.id INTO lv_other FROM desk_leave l WHERE l.account_id = a_acct AND l.user_id = u_other;
  n := n + 1; failed := failed || pg_temp.dol_check('an agent changed another person''s leave',
    format('SELECT desk_leave_change(%L, %L, %L, %L, %L, NULL)::text', u_agent, a_acct, lv_other, today, today),
    'ERROR % NOT_ALLOWED:%');
  n := n + 1; failed := failed || pg_temp.dol_check('an agent read another person''s leave as their own',
    format('SELECT count(*)::text FROM desk_my_leave(%L, %L) WHERE id = %L', u_agent, a_acct, lv_other), '0');
  n := n + 1; failed := failed || pg_temp.dol_check('a team leader could not change another person''s leave',
    format('SELECT desk_leave_change(%L, %L, %L, %L, %L, ''moved'')::text', u_lead, a_acct, lv_other, today + 2, today + 3),
    'true');

  -- ---------- 3. viewer and guest ----------
  n := n + 1; failed := failed || pg_temp.dol_check('a viewer recorded their own leave',
    format('SELECT desk_leave_add(%L, %L, %L, %L, %L, NULL)::text', u_viewer, a_acct, u_viewer, today, today),
    'ERROR % NOT_ALLOWED:%');
  n := n + 1; failed := failed || pg_temp.dol_check('a viewer read leave',
    format('SELECT count(*)::text FROM desk_my_leave(%L, %L)', u_viewer, a_acct), 'ERROR % NOT_ALLOWED:%');
  n := n + 1; failed := failed || pg_temp.dol_check('a viewer changed leave',
    format('SELECT desk_leave_change(%L, %L, %L, %L, %L, NULL)::text', u_viewer, a_acct, lv_own, today, today),
    'ERROR % NOT_ALLOWED:%');
  n := n + 1; failed := failed || pg_temp.dol_check('a guest recorded their own leave',
    format('SELECT desk_leave_add(%L, %L, %L, %L, %L, NULL)::text', u_guest, a_acct, u_guest, today, today),
    'ERROR % NOT_ALLOWED:%');
  n := n + 1; failed := failed || pg_temp.dol_check('a guest read leave',
    format('SELECT count(*)::text FROM desk_my_leave(%L, %L)', u_guest, a_acct), 'ERROR % NOT_ALLOWED:%');
  n := n + 1; failed := failed || pg_temp.dol_check('a guest changed leave',
    format('SELECT desk_leave_change(%L, %L, %L, %L, %L, NULL)::text', u_guest, a_acct, lv_own, today, today),
    'ERROR % NOT_ALLOWED:%');

  -- ---------- 4. cancel ----------
  n := n + 1; failed := failed || pg_temp.dol_check('an agent removed another person''s leave',
    format('SELECT desk_leave_remove(%L, %L, %L)::text', u_agent, a_acct, lv_other), 'ERROR % NOT_ALLOWED:%');
  n := n + 1; failed := failed || pg_temp.dol_check('an agent could not cancel their own leave',
    format('SELECT desk_leave_remove(%L, %L, %L)::text', u_agent, a_acct, lv_own), 'true');
  n := n + 1; failed := failed || pg_temp.dol_check('cancelled leave was still listed',
    format('SELECT count(*)::text FROM desk_my_leave(%L, %L)', u_agent, a_acct), '0');

  -- ---------- 5. closed to API roles ----------
  n := n + 1; failed := failed || pg_temp.dol_check('authenticated may call desk_my_leave',
    'SELECT has_function_privilege(''authenticated'', ''public.desk_my_leave(uuid, uuid, timestamptz)'', ''EXECUTE'')::text',
    'false');
  n := n + 1; failed := failed || pg_temp.dol_check('authenticated may call desk_leave_change',
    'SELECT has_function_privilege(''authenticated'', ''public.desk_leave_change(uuid, uuid, uuid, date, date, text, timestamptz)'', ''EXECUTE'')::text',
    'false');

  RAISE EXCEPTION USING ERRCODE = 'ZT328', MESSAGE = 'verify-desk-own-leave rollback';
  EXCEPTION WHEN SQLSTATE 'ZT328' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'desk own leave verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'desk own leave verification passed (% checks)', n;
END
$verify$;
