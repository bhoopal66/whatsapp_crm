-- Behavioural regression suite for desk cover (migration 232).
--
-- Owners and admins name a bank's primary and second coordinator from
-- its holders; losing the bank drops the role. Leave is set by the
-- person or a team leader and up. Cover is the primary, else the second,
-- else the lead (the desk duty owner, else the owner). Queue-age alerts:
-- a bank's oldest waiting upload past 2 h goes to the second coordinator
-- (else the cover), past 4 h to the lead; the no-bank queue to the lead.
-- Tables are closed to API roles.
--
-- ONE statement on purpose: `supabase db query --file` sends the file as
-- a single prepared statement and rejects several. Fixtures are rolled
-- back by a sentinel exception; failures are named in the final one.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000232001';
  u_lead  UUID := '00000000-0000-4000-8000-000000232002';
  u_agent UUID := '00000000-0000-4000-8000-000000232003';
  u_r1    UUID := '00000000-0000-4000-8000-000000232004';  -- holds RAK
  u_r2    UUID := '00000000-0000-4000-8000-000000232005';  -- holds RAK
  u_e     UUID := '00000000-0000-4000-8000-000000232006';  -- holds ENBD
  a_acct  UUID;
  today   DATE := (now() AT TIME ZONE 'Asia/Dubai')::date;
  lv1     UUID;
  lv2     UUID;
  i1      UUID := gen_random_uuid();
  i2      UUID := gen_random_uuid();
  r       RECORD;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.bc_try(p_role text, p_sql text)
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
    CREATE FUNCTION pg_temp.bc_check(p_name text, p_role text, p_sql text, p_like text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := pg_temp.bc_try(p_role, p_sql);
    BEGIN
      RETURN CASE WHEN v LIKE p_like THEN NULL ELSE p_name || ' (' || v || ')' END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.bc_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.bc_cover(p_account uuid, p_bank text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT x.level || '|' || coalesce(x.user_id::text, '-')
        FROM desk_bank_cover(p_account, p_bank, (now() AT TIME ZONE 'Asia/Dubai')::date) x
    $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'dbc-owner@example.invalid'), (u_lead, 'dbc-lead@example.invalid'),
    (u_agent, 'dbc-agent@example.invalid'), (u_r1, 'dbc-r1@example.invalid'),
    (u_r2, 'dbc-r2@example.invalid'), (u_e, 'dbc-e@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agent, u_r1, u_r2, u_e);
  INSERT INTO case_banks (account_id, code, name) VALUES
    (a_acct, 'RAK', 'RAKBANK'), (a_acct, 'ENBD', 'Emirates NBD')
  ON CONFLICT DO NOTHING;
  INSERT INTO coordinator_banks (account_id, user_id, bank_code) VALUES
    (a_acct, u_r1, 'RAK'), (a_acct, u_r2, 'RAK'), (a_acct, u_e, 'ENBD');

  -- ---------- 1. roles ----------
  n := n + 1; failed := failed || pg_temp.bc_check('an agent named a primary', NULL,
    format('SELECT desk_bank_role_set(%L, %L, ''RAK'', ''primary'', %L)::text', u_agent, a_acct, u_r1),
    'ERROR % NOT_ALLOWED:%');
  n := n + 1; failed := failed || pg_temp.bc_check('a non-holder was named primary', NULL,
    format('SELECT desk_bank_role_set(%L, %L, ''RAK'', ''primary'', %L)::text', u_owner, a_acct, u_e),
    'ERROR % INVALID:%');
  PERFORM desk_bank_role_set(u_owner, a_acct, 'RAK', 'primary', u_r1);
  PERFORM desk_bank_role_set(u_owner, a_acct, 'RAK', 'second', u_r2);
  n := n + 1; failed := failed || pg_temp.bc_ok(pg_temp.bc_cover(a_acct, 'RAK') = 'primary|' || u_r1,
    'the available primary does not cover the bank');
  -- One role each: naming the second as primary moves them.
  PERFORM desk_bank_role_set(u_owner, a_acct, 'RAK', 'primary', u_r2);
  n := n + 1; failed := failed || pg_temp.bc_ok(
    (SELECT count(*) FROM desk_bank_roles x WHERE x.account_id = a_acct AND x.bank_code = 'RAK') = 1
    AND (SELECT x.user_id FROM desk_bank_roles x WHERE x.account_id = a_acct AND x.bank_code = 'RAK' AND x.role = 'primary') = u_r2,
    'one person held two roles, or the old primary stayed');
  PERFORM desk_bank_role_set(u_owner, a_acct, 'RAK', 'primary', u_r1);
  PERFORM desk_bank_role_set(u_owner, a_acct, 'RAK', 'second', u_r2);

  -- ---------- 2. leave and cover ----------
  lv1 := desk_leave_add(u_r1, a_acct, u_r1, today, today + 3, 'annual leave');
  n := n + 1; failed := failed || pg_temp.bc_ok(pg_temp.bc_cover(a_acct, 'RAK') = 'second|' || u_r2,
    'the second did not cover a primary on leave');
  n := n + 1; failed := failed || pg_temp.bc_check('an agent set someone else''s leave', NULL,
    format('SELECT desk_leave_add(%L, %L, %L, %L, %L, NULL)::text', u_agent, a_acct, u_r2, today, today),
    'ERROR % NOT_ALLOWED:%');
  n := n + 1; failed := failed || pg_temp.bc_check('leave in the past was accepted', NULL,
    format('SELECT desk_leave_add(%L, %L, %L, %L, %L, NULL)::text', u_lead, a_acct, u_r2, today - 5, today - 2),
    'ERROR % INVALID:%');
  lv2 := desk_leave_add(u_lead, a_acct, u_r2, today, today, NULL);
  n := n + 1; failed := failed || pg_temp.bc_ok(pg_temp.bc_cover(a_acct, 'RAK') = 'lead|' || u_owner,
    'with both on leave the owner (no duty owner) did not cover');
  PERFORM desk_duty_set(u_lead, a_acct, u_lead);
  n := n + 1; failed := failed || pg_temp.bc_ok(pg_temp.bc_cover(a_acct, 'RAK') = 'lead|' || u_lead,
    'the desk duty owner did not cover as the lead');
  n := n + 1; failed := failed || pg_temp.bc_check('an agent removed someone else''s leave', NULL,
    format('SELECT desk_leave_remove(%L, %L, %L)::text', u_agent, a_acct, lv2), 'ERROR % NOT_ALLOWED:%');
  n := n + 1; failed := failed || pg_temp.bc_ok(desk_leave_remove(u_lead, a_acct, lv2),
    'a team leader could not remove leave');
  n := n + 1; failed := failed || pg_temp.bc_ok(pg_temp.bc_cover(a_acct, 'RAK') = 'second|' || u_r2,
    'cover did not return to the second after their leave was removed');

  -- ---------- 3. queue-age alerts ----------
  -- The primary is back, so the cover (primary) and the second differ:
  -- the 2-hour alert goes to the second.
  PERFORM desk_leave_remove(u_r1, a_acct, lv1);
  PERFORM intake_submit(u_agent, a_acct, i1, 'dbc-000001', NULL, 'RAK', NULL, NULL, NULL, NULL, NULL, NULL,
                        'needs sorting', NULL, NULL, NULL, NULL, NULL, now());
  PERFORM intake_submit(u_agent, a_acct, i2, 'dbc-000002', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                        'no bank', NULL, NULL, NULL, NULL, NULL, now());
  UPDATE intake_items SET received_at = now() - interval '1 hour' WHERE id IN (i1, i2);
  n := n + 1; failed := failed || pg_temp.bc_ok(NOT EXISTS (SELECT 1 FROM desk_queue_alerts_due(now()) x
    WHERE x.account_id = a_acct), 'a queue under 2 hours old alerted');
  UPDATE intake_items SET received_at = now() - interval '3 hours' WHERE id IN (i1, i2);
  SELECT x.* INTO r FROM desk_queue_alerts_due(now()) x WHERE x.account_id = a_acct AND x.bank_code = 'RAK';
  n := n + 1; failed := failed || pg_temp.bc_ok(r.level = 'second' AND r.assignee = u_r2 AND r.item_id = i1,
    format('a 3-hour RAK queue did not alert the second coordinator (%s %s)', r.level, r.assignee));
  SELECT x.* INTO r FROM desk_queue_alerts_due(now()) x WHERE x.account_id = a_acct AND x.bank_code IS NULL;
  n := n + 1; failed := failed || pg_temp.bc_ok(r.level = 'lead' AND r.assignee = u_lead,
    'the no-bank queue did not alert the lead');
  UPDATE intake_items SET received_at = now() - interval '5 hours' WHERE id = i1;
  SELECT x.* INTO r FROM desk_queue_alerts_due(now()) x WHERE x.account_id = a_acct AND x.bank_code = 'RAK';
  n := n + 1; failed := failed || pg_temp.bc_ok(r.level = 'lead' AND r.assignee = u_lead,
    'a 5-hour queue did not alert the lead');

  -- ---------- 4. reading, the holder rule, closed tables ----------
  n := n + 1; failed := failed || pg_temp.bc_check('an agent read the cover list', NULL,
    format('SELECT count(*)::text FROM desk_cover_list(%L, %L)', u_agent, a_acct), 'ERROR % NOT_ALLOWED:%');
  SELECT x.* INTO r FROM desk_cover_list(u_lead, a_acct) x WHERE x.bank_code = 'RAK';
  n := n + 1; failed := failed || pg_temp.bc_ok(r.primary_user = u_r1 AND r.cover_user = u_r1
    AND jsonb_array_length(r.holders) = 2,
    'the cover list did not show the roles and today''s cover');
  PERFORM desk_leave_add(u_r2, a_acct, u_r2, today, today, NULL);
  SELECT x.* INTO r FROM desk_cover_list(u_lead, a_acct) x WHERE x.bank_code = 'RAK';
  n := n + 1; failed := failed || pg_temp.bc_ok(
    (SELECT bool_or((e->>'on_leave')::boolean AND (e->>'user_id')::uuid = u_r2) FROM jsonb_array_elements(r.holders) e),
    'the cover list did not show who is on leave');
  DELETE FROM coordinator_banks WHERE account_id = a_acct AND user_id = u_r1 AND bank_code = 'RAK';
  n := n + 1; failed := failed || pg_temp.bc_ok(NOT EXISTS (SELECT 1 FROM desk_bank_roles x
    WHERE x.account_id = a_acct AND x.user_id = u_r1), 'losing the bank did not drop the role');
  n := n + 1; failed := failed || pg_temp.bc_check('authenticated read desk_bank_roles', 'authenticated',
    'SELECT count(*)::text FROM public.desk_bank_roles', 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.bc_check('service_role read desk_leave directly', 'service_role',
    'SELECT count(*)::text FROM public.desk_leave', 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.bc_check('authenticated called desk_queue_alerts_due', 'authenticated',
    'SELECT count(*)::text FROM desk_queue_alerts_due()', 'ERROR 42501%');

  RAISE EXCEPTION USING ERRCODE = 'ZT232', MESSAGE = 'verify-desk-bank-cover rollback';
  EXCEPTION WHEN SQLSTATE 'ZT232' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'desk cover verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'desk cover verification passed (% checks)', n;
END
$verify$;
