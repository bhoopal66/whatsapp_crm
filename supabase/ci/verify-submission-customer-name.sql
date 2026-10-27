-- Behavioural regression suite for the submission's customer name
-- (migration 141).
--
-- sg_open stores p_customer_name on a new group and leaves an existing
-- group's name alone; case_inbox's contact_name is the group's
-- customer_name, else the CRM contact's name (which is never renamed);
-- the backfill expression turns a "<company> - <ref>" subject into the
-- company and a phone-number default subject into NULL.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The fixtures are
-- rolled back by a sentinel exception; the results survive in plpgsql
-- variables.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000141001';
  u_agent UUID := '00000000-0000-4000-8000-000000141002';
  a_acct  UUID;
  c1      UUID;
  g1      UUID;
  g2      UUID;
  k1      UUID;
  k2      UUID;
  r       TEXT;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  BEGIN
  -- ---------- the backfill expression (as in 141, section 2) ----------
  n := n + 1;
  r := (SELECT CASE WHEN x.rest ~ '^[[:space:]]*$' OR x.rest !~ '[[:alpha:]]' THEN NULL ELSE left(x.rest, 200) END
          FROM (SELECT regexp_replace('CANTUS - F.Z.E - 3d88f130', ' (-|·) [^[:space:]]+$', '') AS rest) x);
  IF r IS DISTINCT FROM 'CANTUS - F.Z.E' THEN
    failed := failed || format('backfill of "CANTUS - F.Z.E - 3d88f130" gave %s', coalesce(r, 'NULL'));
  END IF;
  n := n + 1;
  r := (SELECT CASE WHEN x.rest ~ '^[[:space:]]*$' OR x.rest !~ '[[:alpha:]]' THEN NULL ELSE left(x.rest, 200) END
          FROM (SELECT regexp_replace('+971501234567 · SUB-1', ' (-|·) [^[:space:]]+$', '') AS rest) x);
  IF r IS NOT NULL THEN
    failed := failed || format('backfill of a phone-number default subject gave %s', r);
  END IF;
  n := n + 1;
  r := (SELECT CASE WHEN x.rest ~ '^[[:space:]]*$' OR x.rest !~ '[[:alpha:]]' THEN NULL ELSE left(x.rest, 200) END
          FROM (SELECT regexp_replace('Acme Trading · SUB-2', ' (-|·) [^[:space:]]+$', '') AS rest) x);
  IF r IS DISTINCT FROM 'Acme Trading' THEN
    failed := failed || format('backfill of our own default subject gave %s', coalesce(r, 'NULL'));
  END IF;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'cn-owner@example.invalid'),
    (u_agent, 'cn-agent@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500141001', 'Nasrullah')
    RETURNING id INTO c1;

  -- ---------- sg_open ----------
  -- Assigned first: a subquery in the same expression would read the
  -- snapshot taken before the call.
  g1 := (SELECT x.group_id FROM sg_open(a_acct, 'CN-141-1', c1, NULL, 'CANTUS - F.Z.E - 3d88f130', NULL,
    jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL, 'none', 'CANTUS - F.Z.E') x);
  g2 := (SELECT x.group_id FROM sg_open(a_acct, 'CN-141-2', c1, NULL, 'two', NULL,
    jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL, 'none') x);
  IF g1 IS NULL OR g2 IS NULL THEN RAISE EXCEPTION 'fixture: sg_open returned no group'; END IF;
  n := n + 1;
  IF (SELECT customer_name FROM submission_groups WHERE id = g1) IS DISTINCT FROM 'CANTUS - F.Z.E' THEN
    failed := failed || 'sg_open did not store p_customer_name'::text;
  END IF;
  n := n + 1;
  IF (SELECT customer_name FROM submission_groups WHERE id = g2) IS NOT NULL THEN
    failed := failed || 'sg_open without p_customer_name stored a name'::text;
  END IF;
  k1 := (SELECT x.group_id FROM sg_open(a_acct, 'CN-141-1', c1, NULL, 'other', NULL, '[]', NULL, 'none', 'Other') x);
  n := n + 1;
  IF k1 IS DISTINCT FROM g1 OR (SELECT customer_name FROM submission_groups WHERE id = g1) <> 'CANTUS - F.Z.E' THEN
    failed := failed || 'a repeat sg_open changed the existing row''s customer name'::text;
  END IF;
  n := n + 1;
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'sg_open' AND pronamespace = 'public'::regnamespace) <> 1 THEN
    failed := failed || 'sg_open has more than one signature'::text;
  END IF;
  n := n + 1;
  BEGIN
    PERFORM sg_open(a_acct, 'CN-141-3', c1, NULL, 'three', NULL, '[]', NULL, 'none', repeat('x', 201));
    failed := failed || 'a 201-character customer name was accepted'::text;
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- ---------- case_inbox ----------
  PERFORM case_bank_upsert(u_owner, a_acct, 'ADCB', 'ADCB Bank');
  k1 := (SELECT x.case_id FROM case_open(g1, 'ADCB', NULL, 'Loan', 1000, NULL) x);
  k2 := (SELECT x.case_id FROM case_open(g2, 'ADCB', NULL, 'Loan', 2000, NULL) x);
  IF k1 IS NULL OR k2 IS NULL THEN RAISE EXCEPTION 'fixture: case_open returned no case'; END IF;
  n := n + 1;
  IF (SELECT x.contact_name FROM case_inbox(u_owner, a_acct, '{}', now(), 200) x WHERE x.case_id = k1)
       IS DISTINCT FROM 'CANTUS - F.Z.E' THEN
    failed := failed || 'case_inbox did not name the submission''s customer'::text;
  END IF;
  n := n + 1;
  IF (SELECT x.contact_name FROM case_inbox(u_owner, a_acct, '{}', now(), 200) x WHERE x.case_id = k2)
       IS DISTINCT FROM 'Nasrullah' THEN
    failed := failed || 'case_inbox did not fall back to the contact''s name'::text;
  END IF;
  n := n + 1;
  IF (SELECT name FROM contacts WHERE id = c1) <> 'Nasrullah' THEN
    failed := failed || 'the CRM contact was renamed'::text;
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZT141', MESSAGE = 'verify-submission-customer-name rollback';
  EXCEPTION WHEN SQLSTATE 'ZT141' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'submission customer name verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'submission customer name verification passed (% checks)', n;
END
$verify$;
