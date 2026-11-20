-- Behavioural regression suite for adding a number to a submission
-- group (migration 211).
--
-- sg_add_number_begin(group, user, phone) refuses with a code, checked in
-- this order: not_found, not_active, not_allowed, no_whatsapp,
-- no_group_yet, detached, bad_phone, own_number, opted_out,
-- do_not_contact, in_progress (same group and number still pending under
-- 2 minutes), too_many (10 rows for the group in 24 hours). Otherwise it
-- writes a pending row in submission_group_added_numbers and returns the
-- ids the caller needs to talk to the gateway.
-- sg_add_number_settle moves that row from pending to added / invited /
-- refused / failed exactly once, stamps settled_at, clips the error to
-- 500 characters and stores a blank one as NULL; any other status raises
-- 22023.
-- The table is RLS-forced with no policy: anon and authenticated have no
-- access, service_role may only SELECT, and both functions are EXECUTE
-- for service_role only.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The fixtures are
-- rolled back by a sentinel exception; the results survive in plpgsql
-- variables.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000211001';
  u_agent UUID := '00000000-0000-4000-8000-000000211002';
  u_off   UUID := '00000000-0000-4000-8000-000000211003';
  a_acct  UUID;
  w1      UUID;
  c1      UUID;
  c_opt   UUID;
  c_dnc   UUID;
  c_trunk UUID;
  g1      UUID;
  g_end   UUID;
  g_none  UUID;
  g_nogrp UUID;
  tok     UUID;
  j       JSONB;
  ok      BOOLEAN;
  v_id    UUID;
  v_id2   UUID;
  i       INT;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  BEGIN
    INSERT INTO auth.users (id, email) VALUES
      (u_owner, 'sg211-owner@example.invalid'),
      (u_agent, 'sg211-agent@example.invalid'),
      (u_off,   'sg211-off@example.invalid');
    SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
    UPDATE profiles SET account_id = a_acct, account_role = 'agent'
     WHERE user_id IN (u_agent, u_off);

    INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary, waba_id)
    VALUES (u_owner, a_acct, 'whapi', 'SG-211-A1', 'x', 'connected', true, '+971 50 021 1000')
    RETURNING id INTO w1;
    INSERT INTO contacts (account_id, user_id, phone, name)
      VALUES (a_acct, u_owner, '971500211001', 'C1') RETURNING id INTO c1;
    INSERT INTO contacts (account_id, user_id, phone, name)
      VALUES (a_acct, u_owner, '+971 50 021 1009', 'Opt') RETURNING id INTO c_opt;
    INSERT INTO contacts (account_id, user_id, phone, name)
      VALUES (a_acct, u_owner, '971500211008', 'Dnc') RETURNING id INTO c_dnc;
    -- An older contact saved without its country code.
    INSERT INTO contacts (account_id, user_id, phone, name)
      VALUES (a_acct, u_owner, '0500211007', 'Trunk') RETURNING id INTO c_trunk;
    -- Fixture shortcut past the consent guards (this transaction only).
    SET LOCAL session_replication_role = replica;
    UPDATE contacts SET opted_out_at = now() WHERE id IN (c_opt, c_trunk);
    UPDATE contacts SET do_not_contact_at = now(), do_not_contact_reason = 'asked' WHERE id = c_dnc;
    SET LOCAL session_replication_role = origin;

    SELECT group_id INTO g1 FROM sg_open(a_acct, 'SG-211-1', c1, w1, 'one', NULL,
      jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL);
    SELECT group_id INTO g_end FROM sg_open(a_acct, 'SG-211-2', c1, w1, 'two', NULL,
      jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL);
    SELECT group_id INTO g_none FROM sg_open(a_acct, 'SG-211-3', c1, NULL, 'three', NULL,
      jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL, 'none');
    SELECT group_id INTO g_nogrp FROM sg_open(a_acct, 'SG-211-4', c1, w1, 'four', NULL,
      jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL);
    tok := sg_claim_create(g1, 60000);
    PERFORM sg_attach_wa_group(g1, '120363000000211001@g.us', 'https://chat.whatsapp.com/abc211', tok);
    tok := sg_claim_create(g_end, 60000);
    PERFORM sg_attach_wa_group(g_end, '120363000000211002@g.us', NULL, tok);
    PERFORM sg_end(g_end, 'done');

    -- ---------- (a) the ok path ----------
    j := sg_add_number_begin(g1, u_agent, '971500211050');
    n := n + 1;
    IF NOT ((j->>'ok')::boolean IS TRUE AND j->>'id' IS NOT NULL
        AND (j->>'account_id')::uuid = a_acct AND (j->>'channel_id')::uuid = w1
        AND j->>'wa_group_id' = '120363000000211001@g.us'
        AND j->>'invite_link' = 'https://chat.whatsapp.com/abc211') THEN
      failed := failed || ('ok path returned ' || j::text);
    END IF;
    v_id := (j->>'id')::uuid;
    n := n + 1;
    IF NOT coalesce((SELECT status = 'pending' AND settled_at IS NULL
                       AND phone = '971500211050' AND added_by = u_agent
                       FROM submission_group_added_numbers WHERE id = v_id), false) THEN
      failed := failed || 'the begin did not write a pending row for the digits-only number'::text;
    END IF;

    -- ---------- (b) in_progress while the first is pending ----------
    j := sg_add_number_begin(g1, u_agent, '971500211050');
    n := n + 1;
    IF j->>'code' IS DISTINCT FROM 'in_progress' THEN
      failed := failed || ('in_progress: ' || j::text);
    END IF;

    -- ---------- (c) settle happens once ----------
    ok := sg_add_number_settle(v_id, 'added', repeat('x', 600));
    n := n + 1;
    IF ok IS NOT TRUE THEN
      failed := failed || 'the first settle did not return true'::text;
    END IF;
    n := n + 1;
    IF NOT coalesce((SELECT status = 'added' AND settled_at IS NOT NULL AND char_length(error) = 500
                       FROM submission_group_added_numbers WHERE id = v_id), false) THEN
      failed := failed || 'settled row: status not added, settled_at unset or error not clipped to 500'::text;
    END IF;
    ok := sg_add_number_settle(v_id, 'failed', NULL);
    n := n + 1;
    IF ok IS NOT FALSE THEN
      failed := failed || 'a second settle of an already settled row returned true'::text;
    END IF;
    n := n + 1;
    IF NOT coalesce((SELECT status = 'added' FROM submission_group_added_numbers WHERE id = v_id), false) THEN
      failed := failed || 'a second settle overwrote the settled status'::text;
    END IF;
    n := n + 1;
    BEGIN
      PERFORM sg_add_number_settle(v_id, 'pending', NULL);
      failed := failed || 'settle accepted the status pending'::text;
    EXCEPTION WHEN invalid_parameter_value THEN
      NULL;
    END;
    n := n + 1;
    BEGIN
      PERFORM sg_add_number_settle(v_id, 'bogus', NULL);
      failed := failed || 'settle accepted an unknown status'::text;
    EXCEPTION WHEN invalid_parameter_value THEN
      NULL;
    END;

    -- ---------- (d) refusals, in contract order ----------
    j := sg_add_number_begin(gen_random_uuid(), u_agent, '971500211051');
    n := n + 1;
    IF j->>'code' IS DISTINCT FROM 'not_found' THEN failed := failed || ('not_found: ' || j::text); END IF;
    j := sg_add_number_begin(g_end, u_owner, '971500211051');
    n := n + 1;
    IF j->>'code' IS DISTINCT FROM 'not_active' THEN failed := failed || ('not_active (ENDED group): ' || j::text); END IF;
    j := sg_add_number_begin(g1, u_off, '971500211051');
    n := n + 1;
    IF j->>'code' IS DISTINCT FROM 'not_allowed' THEN failed := failed || ('not_allowed: ' || j::text); END IF;
    j := sg_add_number_begin(g_none, u_owner, '971500211051');
    n := n + 1;
    IF j->>'code' IS DISTINCT FROM 'no_whatsapp' THEN failed := failed || ('no_whatsapp: ' || j::text); END IF;
    j := sg_add_number_begin(g_nogrp, u_agent, '971500211051');
    n := n + 1;
    IF j->>'code' IS DISTINCT FROM 'no_group_yet' THEN failed := failed || ('no_group_yet: ' || j::text); END IF;
    j := sg_add_number_begin(g1, u_agent, '+971500211051');
    n := n + 1;
    IF j->>'code' IS DISTINCT FROM 'bad_phone' THEN failed := failed || ('bad_phone (plus sign): ' || j::text); END IF;
    j := sg_add_number_begin(g1, u_agent, '12345');
    n := n + 1;
    IF j->>'code' IS DISTINCT FROM 'bad_phone' THEN failed := failed || ('bad_phone (too short): ' || j::text); END IF;
    j := sg_add_number_begin(g1, u_agent, NULL);
    n := n + 1;
    IF j->>'code' IS DISTINCT FROM 'bad_phone' THEN failed := failed || ('bad_phone (null): ' || j::text); END IF;
    j := sg_add_number_begin(g1, u_agent, '971500211000');
    n := n + 1;
    IF j->>'code' IS DISTINCT FROM 'own_number' THEN failed := failed || ('own_number: ' || j::text); END IF;
    j := sg_add_number_begin(g1, u_agent, '971500211009');
    n := n + 1;
    IF j->>'code' IS DISTINCT FROM 'opted_out' THEN failed := failed || ('opted_out: ' || j::text); END IF;
    -- Consent matches the last 9 digits: '0500211007' opted out.
    j := sg_add_number_begin(g1, u_agent, '971500211007');
    n := n + 1;
    IF j->>'code' IS DISTINCT FROM 'opted_out' THEN failed := failed || ('opted_out (trunk 0 contact): ' || j::text); END IF;
    j := sg_add_number_begin(g1, u_agent, '971500211008');
    n := n + 1;
    IF j->>'code' IS DISTINCT FROM 'do_not_contact' THEN failed := failed || ('do_not_contact: ' || j::text); END IF;

    -- A refusal writes nothing: still only the one row so far.
    n := n + 1;
    IF (SELECT count(*) FROM submission_group_added_numbers WHERE group_id = g1) <> 1 THEN
      failed := failed || 'a refused begin left a row behind'::text;
    END IF;

    -- ---------- (e) too_many: 1 row so far, 9 more fit, the 11th is refused ----------
    FOR i IN 1..9 LOOP
      j := sg_add_number_begin(g1, u_owner, '9715002112' || lpad(i::text, 2, '0'));
      IF (j->>'ok')::boolean IS NOT TRUE THEN
        failed := failed || ('filling attempt ' || i || ': ' || j::text);
      ELSIF i = 1 THEN
        v_id2 := (j->>'id')::uuid;
      END IF;
    END LOOP;
    n := n + 1;
    IF (SELECT count(*) FROM submission_group_added_numbers WHERE group_id = g1) <> 10 THEN
      failed := failed || 'ten attempts were not logged for the group'::text;
    END IF;
    j := sg_add_number_begin(g1, u_owner, '971500211299');
    n := n + 1;
    IF j->>'code' IS DISTINCT FROM 'too_many' THEN failed := failed || ('too_many at the 11th: ' || j::text); END IF;

    -- A blank error is stored as NULL, and invited is a valid outcome.
    ok := sg_add_number_settle(v_id2, 'invited', '   ');
    n := n + 1;
    IF NOT (ok IS TRUE AND coalesce((SELECT status = 'invited' AND error IS NULL AND settled_at IS NOT NULL
                                       FROM submission_group_added_numbers WHERE id = v_id2), false)) THEN
      failed := failed || 'a blank error was not stored as NULL on an invited settle'::text;
    END IF;

    -- ---------- (f) detached last: the channel was removed (ON DELETE SET NULL) ----------
    DELETE FROM whatsapp_config WHERE id = w1;
    j := sg_add_number_begin(g1, u_owner, '971500211299');
    n := n + 1;
    IF j->>'code' IS DISTINCT FROM 'detached' THEN failed := failed || ('detached: ' || j::text); END IF;

    -- ---------- (g) privileges ----------
    n := n + 1;
    IF has_function_privilege('anon', 'public.sg_add_number_begin(uuid,uuid,text)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.sg_add_number_begin(uuid,uuid,text)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.sg_add_number_settle(uuid,text,text)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.sg_add_number_settle(uuid,text,text)', 'EXECUTE')
       OR NOT has_function_privilege('service_role', 'public.sg_add_number_begin(uuid,uuid,text)', 'EXECUTE')
       OR NOT has_function_privilege('service_role', 'public.sg_add_number_settle(uuid,text,text)', 'EXECUTE') THEN
      failed := failed || 'the functions are not EXECUTE for service_role only'::text;
    END IF;
    n := n + 1;
    IF has_table_privilege('anon', 'public.submission_group_added_numbers', 'SELECT')
       OR has_table_privilege('authenticated', 'public.submission_group_added_numbers', 'SELECT')
       OR has_table_privilege('service_role', 'public.submission_group_added_numbers', 'INSERT,UPDATE,DELETE')
       OR NOT has_table_privilege('service_role', 'public.submission_group_added_numbers', 'SELECT') THEN
      failed := failed || 'the table is not SELECT-only for service_role and closed to anon and authenticated'::text;
    END IF;
    n := n + 1;
    IF NOT coalesce((SELECT c.relrowsecurity AND c.relforcerowsecurity
                       FROM pg_class c WHERE c.oid = 'public.submission_group_added_numbers'::regclass), false) THEN
      failed := failed || 'row level security is not enabled and forced on the table'::text;
    END IF;
    n := n + 1;
    BEGIN
      SET LOCAL ROLE authenticated;
      j := public.sg_add_number_begin(g1, u_owner, '971500211299');
      RESET ROLE;
      failed := failed || 'authenticated executed sg_add_number_begin'::text;
    EXCEPTION WHEN insufficient_privilege THEN
      RESET ROLE;
    END;
    n := n + 1;
    BEGIN
      SET LOCAL ROLE anon;
      PERFORM count(*) FROM public.submission_group_added_numbers;
      RESET ROLE;
      failed := failed || 'anon selected from the table'::text;
    EXCEPTION WHEN insufficient_privilege THEN
      RESET ROLE;
    END;
    n := n + 1;
    BEGIN
      SET LOCAL ROLE service_role;
      INSERT INTO public.submission_group_added_numbers (group_id, account_id, phone, added_by)
        VALUES (g1, a_acct, '971500211300', u_owner);
      RESET ROLE;
      failed := failed || 'service_role inserted into the table directly'::text;
    EXCEPTION WHEN insufficient_privilege THEN
      RESET ROLE;
    END;

    -- The sweep settles only pending rows older than the cut-off, as
    -- failed 'unconfirmed'; settled and fresh rows are left alone.
    INSERT INTO public.submission_group_added_numbers (group_id, account_id, phone, added_by, created_at)
      VALUES (g1, a_acct, '971500211401', u_agent, now() - interval '11 minutes') RETURNING id INTO v_id;
    INSERT INTO public.submission_group_added_numbers (group_id, account_id, phone, added_by, created_at)
      VALUES (g1, a_acct, '971500211402', u_agent, now() - interval '1 minute') RETURNING id INTO v_id2;
    i := sg_add_number_sweep(600);
    n := n + 1;
    IF i <> 1 THEN failed := failed || ('the sweep settled ' || i || ' rows, not 1'); END IF;
    n := n + 1;
    IF (SELECT status || '/' || coalesce(error, '') || '/' || (settled_at IS NOT NULL)::text
          FROM submission_group_added_numbers WHERE id = v_id) IS DISTINCT FROM 'failed/unconfirmed/true' THEN
      failed := failed || 'the sweep did not settle an old pending row as failed unconfirmed'::text;
    END IF;
    n := n + 1;
    IF (SELECT status FROM submission_group_added_numbers WHERE id = v_id2) IS DISTINCT FROM 'pending' THEN
      failed := failed || 'the sweep touched a fresh pending row'::text;
    END IF;
    n := n + 1;
    IF has_function_privilege('anon', 'public.sg_add_number_sweep(integer)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.sg_add_number_sweep(integer)', 'EXECUTE')
       OR NOT has_function_privilege('service_role', 'public.sg_add_number_sweep(integer)', 'EXECUTE') THEN
      failed := failed || 'sg_add_number_sweep is not EXECUTE for service_role only'::text;
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'ZT211', MESSAGE = 'verify-submission-group-add-number rollback';
  EXCEPTION WHEN SQLSTATE 'ZT211' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'submission group add number verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'submission group add number verification passed (% checks)', n;
END
$verify$;
