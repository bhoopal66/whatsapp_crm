-- Behavioural regression suite for the customer's membership of a
-- submission group (migration 174).
--
-- customer_membership is 'unknown', 'joined' or 'absent'.
-- sg_note_customer_membership records one check and always stamps
-- customer_checked_at; 'unknown' never overwrites a known state, and
-- 'unsure', never stored, takes an 'absent' back to 'unknown'.
-- sg_membership_due lists the groups to check next. A customer's message
-- marks the group joined, and a failure there never loses the message.
-- An ENDED group is frozen: nothing here writes it. sg_invite_claim
-- gives one caller per cooldown the right to send an invite.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The fixtures are
-- rolled back by a sentinel exception; the results survive in plpgsql
-- variables.

DO $verify$
DECLARE
  u_a      UUID := '00000000-0000-4000-8000-000000174001';
  u_b      UUID := '00000000-0000-4000-8000-000000174002';
  a_a      UUID;
  a_b      UUID;
  w1       UUID;
  w2       UUID;
  wb       UUID;
  c1       UUID;
  cb       UUID;
  gm       UUID;
  gk       UUID;
  ge       UUID;
  gt       UUID;
  gs       UUID;
  gx       UUID;
  gf       UUID;
  gu       UUID;
  gc       UUID;
  d_null   UUID;
  d_old1   UUID;
  d_old2   UUID;
  d_fresh  UUID;
  d_joined UUID;
  d_nowa   UUID;
  d_none   UUID;
  d_ended  UUID;
  d_nochan UUID;
  d_other  UUID;
  b_join   UUID;
  b_absent UUID;
  b_quiet  UUID;
  b_ended  UUID;
  b        BOOLEAN;
  i        INT;
  r        TEXT;
  old_at   TIMESTAMPTZ := '2020-01-02 03:04:05+00';
  m        TEXT;
  at       TIMESTAMPTZ;
  due      UUID[];
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sm_ok(p_cond boolean, p_msg text)
    RETURNS text[] LANGUAGE sql AS $body$
      SELECT CASE WHEN coalesce(p_cond, false) THEN '{}'::text[] ELSE ARRAY[p_msg] END
    $body$
  $fn$;
  -- Run a statement as p_role (NULL: as the current user) signed in as
  -- p_uid: its value, or 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sm_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        IF p_role IS NOT NULL THEN
          PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
          PERFORM set_config('request.jwt.claims',
            json_build_object('sub', p_uid, 'role', p_role)::text, true);
          EXECUTE format('SET LOCAL ROLE %I', p_role);
        END IF;
        EXECUTE p_sql INTO v;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(v, 'NULL');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;
  -- An ACTIVE group with a real WhatsApp group attached.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sm_group(p_account uuid, p_ref text, p_contact uuid, p_channel uuid, p_wa text)
    RETURNS uuid LANGUAGE plpgsql AS $body$
    DECLARE
      v_group uuid;
      v_token uuid;
      v_ok    boolean;
    BEGIN
      v_group := (SELECT x.group_id FROM sg_open(p_account, p_ref, p_contact, p_channel, 's', NULL, '[]'::jsonb, NULL, 'group') x);
      v_token := sg_claim_create(v_group, 60000);
      v_ok := sg_attach_wa_group(v_group, p_wa || '@g.us', NULL, v_token);
      IF NOT coalesce(v_ok, false) THEN
        RAISE EXCEPTION 'fixture: no WhatsApp group attached to %', p_ref;
      END IF;
      RETURN v_group;
    END $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_a, 'sm-a@example.invalid'),
    (u_b, 'sm-b@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_a FROM profiles WHERE user_id = u_a;
  SELECT account_id INTO a_b FROM profiles WHERE user_id = u_b;
  IF a_a IS NULL OR a_b IS NULL OR a_a = a_b THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision two accounts';
  END IF;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_a, a_a, 'whapi', 'SM-174-A1', 'x', 'connected', true) RETURNING id INTO w1;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_a, a_a, 'whapi', 'SM-174-A2', 'x', 'connected', false) RETURNING id INTO w2;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_b, a_b, 'whapi', 'SM-174-B1', 'x', 'connected', true) RETURNING id INTO wb;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_a, u_a, '971500174001', 'SM a')
    RETURNING id INTO c1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_b, u_b, '971500174002', 'SM b')
    RETURNING id INTO cb;

  -- ---------- (a) the columns ----------
  n := n + 1; failed := failed || pg_temp.sm_ok(
    (SELECT c.column_default = '''unknown''::text' AND c.is_nullable = 'NO' AND c.data_type = 'text'
       FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = 'submission_groups' AND c.column_name = 'customer_membership'),
    'customer_membership is not text NOT NULL DEFAULT unknown');
  n := n + 1; failed := failed || pg_temp.sm_ok(
    (SELECT c.is_nullable = 'YES' AND c.data_type = 'timestamp with time zone'
       FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = 'submission_groups' AND c.column_name = 'customer_checked_at'),
    'customer_checked_at is not a nullable timestamptz');
  n := n + 1; failed := failed || pg_temp.sm_ok(
    (SELECT c.is_nullable = 'YES' AND c.data_type = 'timestamp with time zone'
       FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = 'submission_groups' AND c.column_name = 'invite_claimed_at'),
    'invite_claimed_at is not a nullable timestamptz');
  n := n + 1; failed := failed || pg_temp.sm_ok(
    (SELECT c.convalidated FROM pg_constraint c
      WHERE c.conname = 'submission_groups_customer_membership_check'
        AND c.conrelid = 'public.submission_groups'::regclass),
    'the customer_membership CHECK is missing or not validated');

  gm := pg_temp.sm_group(a_a, 'SM-M', c1, w1, '120363000174001');
  SELECT customer_membership, customer_checked_at INTO m, at FROM submission_groups WHERE id = gm;
  n := n + 1; failed := failed || pg_temp.sm_ok(m = 'unknown' AND at IS NULL,
    format('a new group starts %s / %s, not unknown / never checked', m, at));
  r := pg_temp.sm_try(NULL, NULL, format(
    'UPDATE public.submission_groups SET customer_membership = %L WHERE id = %L', 'maybe', gm));
  n := n + 1; failed := failed || pg_temp.sm_ok(r LIKE 'ERROR 23514:%',
    format('the CHECK let a fourth state in (%s)', r));

  -- ---------- (b) sg_note_customer_membership ----------
  b := sg_note_customer_membership(gm, 'absent');
  SELECT customer_membership, customer_checked_at INTO m, at FROM submission_groups WHERE id = gm;
  n := n + 1; failed := failed || pg_temp.sm_ok(b AND m = 'absent' AND at = now(),
    format('absent: returned %s, state %s, checked %s', b, m, at));
  b := sg_note_customer_membership(gm, 'joined');
  SELECT customer_membership INTO m FROM submission_groups WHERE id = gm;
  n := n + 1; failed := failed || pg_temp.sm_ok(b AND m = 'joined', format('absent to joined left %s', m));

  UPDATE submission_groups SET customer_checked_at = old_at WHERE id = gm;
  b := sg_note_customer_membership(gm, 'unknown');
  SELECT customer_membership, customer_checked_at INTO m, at FROM submission_groups WHERE id = gm;
  n := n + 1; failed := failed || pg_temp.sm_ok(b AND m = 'joined' AND at = now(),
    format('unknown over joined: returned %s, state %s, checked %s', b, m, at));

  b := sg_note_customer_membership(gm, 'absent');
  SELECT customer_membership INTO m FROM submission_groups WHERE id = gm;
  n := n + 1; failed := failed || pg_temp.sm_ok(b AND m = 'absent', format('joined to absent left %s', m));
  UPDATE submission_groups SET customer_checked_at = old_at WHERE id = gm;
  b := sg_note_customer_membership(gm, 'unknown');
  SELECT customer_membership, customer_checked_at INTO m, at FROM submission_groups WHERE id = gm;
  n := n + 1; failed := failed || pg_temp.sm_ok(b AND m = 'absent' AND at = now(),
    format('unknown over absent: returned %s, state %s, checked %s', b, m, at));

  gk := pg_temp.sm_group(a_a, 'SM-K', c1, w1, '120363000174002');
  b := sg_note_customer_membership(gk, 'unknown');
  SELECT customer_membership, customer_checked_at INTO m, at FROM submission_groups WHERE id = gk;
  n := n + 1; failed := failed || pg_temp.sm_ok(b AND m = 'unknown' AND at = now(),
    format('unknown over unknown: returned %s, state %s, checked %s', b, m, at));

  -- 'unsure': the list was read, a hidden number means we cannot say
  -- absent. It takes an 'absent' back and is never stored.
  gu := pg_temp.sm_group(a_a, 'SM-U', c1, w1, '120363000174004');
  b := sg_note_customer_membership(gu, 'absent');
  UPDATE submission_groups SET customer_checked_at = old_at WHERE id = gu;
  b := sg_note_customer_membership(gu, 'unsure');
  SELECT customer_membership, customer_checked_at INTO m, at FROM submission_groups WHERE id = gu;
  n := n + 1; failed := failed || pg_temp.sm_ok(b AND m = 'unknown' AND at = now(),
    format('unsure over absent: returned %s, state %s, checked %s', b, m, at));
  UPDATE submission_groups SET customer_checked_at = old_at WHERE id = gu;
  b := sg_note_customer_membership(gu, 'unsure');
  SELECT customer_membership, customer_checked_at INTO m, at FROM submission_groups WHERE id = gu;
  n := n + 1; failed := failed || pg_temp.sm_ok(b AND m = 'unknown' AND at = now(),
    format('unsure over unknown: returned %s, state %s, checked %s', b, m, at));
  b := sg_note_customer_membership(gu, 'joined');
  UPDATE submission_groups SET customer_checked_at = old_at WHERE id = gu;
  b := sg_note_customer_membership(gu, 'unsure');
  SELECT customer_membership, customer_checked_at INTO m, at FROM submission_groups WHERE id = gu;
  n := n + 1; failed := failed || pg_temp.sm_ok(b AND m = 'joined' AND at = now(),
    format('unsure over joined: returned %s, state %s, checked %s', b, m, at));
  r := pg_temp.sm_try(NULL, NULL, format(
    'UPDATE public.submission_groups SET customer_membership = %L WHERE id = %L', 'unsure', gu));
  n := n + 1; failed := failed || pg_temp.sm_ok(r LIKE 'ERROR 23514:%',
    format('the CHECK let unsure be stored (%s)', r));

  UPDATE submission_groups SET customer_checked_at = old_at WHERE id = gm;
  r := pg_temp.sm_try(NULL, NULL, format('SELECT sg_note_customer_membership(%L, %L)', gm, 'maybe'));
  n := n + 1; failed := failed || pg_temp.sm_ok(r LIKE 'ERROR 22023:%', format('an invalid state was taken (%s)', r));
  r := pg_temp.sm_try(NULL, NULL, format('SELECT sg_note_customer_membership(%L, NULL)', gm));
  n := n + 1; failed := failed || pg_temp.sm_ok(r LIKE 'ERROR 22023:%', format('a NULL state was taken (%s)', r));
  SELECT customer_membership, customer_checked_at INTO m, at FROM submission_groups WHERE id = gm;
  n := n + 1; failed := failed || pg_temp.sm_ok(m = 'absent' AND at = old_at,
    format('a refused state still wrote (%s / %s)', m, at));

  ge := pg_temp.sm_group(a_a, 'SM-E', c1, w1, '120363000174003');
  b := sg_end(ge, 'completed');
  IF NOT coalesce(b, false) THEN
    RAISE EXCEPTION 'fixture: sg_end did not end the group';
  END IF;
  b := sg_note_customer_membership(ge, 'absent');
  n := n + 1; failed := failed || pg_temp.sm_ok(NOT b, 'noting an ENDED group returned true');
  b := sg_note_customer_membership(ge, 'unknown');
  n := n + 1; failed := failed || pg_temp.sm_ok(NOT b, 'stamping an ENDED group returned true');
  b := sg_note_customer_membership(ge, 'unsure');
  n := n + 1; failed := failed || pg_temp.sm_ok(NOT b, 'unsure on an ENDED group returned true');
  SELECT customer_membership, customer_checked_at INTO m, at FROM submission_groups WHERE id = ge;
  n := n + 1; failed := failed || pg_temp.sm_ok(m = 'unknown' AND at IS NULL,
    format('an ENDED group was written (%s / %s)', m, at));
  b := sg_note_customer_membership('00000000-0000-4000-8000-000000174999', 'joined');
  n := n + 1; failed := failed || pg_temp.sm_ok(NOT b, 'noting a missing group returned true');

  -- Who may call. service_role writes through a real role switch, since
  -- the table is RLS-forced and it holds no write grant of its own.
  n := n + 1; failed := failed || pg_temp.sm_ok(
    NOT has_function_privilege('authenticated', 'public.sg_note_customer_membership(uuid, text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.sg_note_customer_membership(uuid, text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.sg_membership_due(uuid, integer)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.sg_membership_due(uuid, integer)', 'EXECUTE')
    AND has_function_privilege('service_role', 'public.sg_note_customer_membership(uuid, text)', 'EXECUTE')
    AND has_function_privilege('service_role', 'public.sg_membership_due(uuid, integer)', 'EXECUTE'),
    'the function grants are not service_role only');
  n := n + 1; failed := failed || pg_temp.sm_ok(
    NOT EXISTS (
      SELECT 1 FROM pg_proc p, LATERAL aclexplode(p.proacl) x
       WHERE p.oid IN ('public.sg_note_customer_membership(uuid, text)'::regprocedure,
                       'public.sg_membership_due(uuid, integer)'::regprocedure,
                       'public.sg_customer_wrote()'::regprocedure,
                       'public.sg_backfill_customer_membership()'::regprocedure)
         AND x.grantee = 0)
    AND NOT has_function_privilege('service_role', 'public.sg_backfill_customer_membership()', 'EXECUTE'),
    'a function is open to PUBLIC, or the backfill to service_role');
  r := pg_temp.sm_try('authenticated', u_a, format('SELECT sg_note_customer_membership(%L, %L)', gm, 'joined'));
  n := n + 1; failed := failed || pg_temp.sm_ok(r LIKE 'ERROR 42501:%', format('authenticated noted a state (%s)', r));
  r := pg_temp.sm_try('authenticated', u_a, format('SELECT count(*)::text FROM sg_membership_due(%L, 5)', a_a));
  n := n + 1; failed := failed || pg_temp.sm_ok(r LIKE 'ERROR 42501:%', format('authenticated listed the due groups (%s)', r));
  r := pg_temp.sm_try('service_role', NULL, format('SELECT sg_note_customer_membership(%L, %L)', gm, 'joined'));
  n := n + 1; failed := failed || pg_temp.sm_ok(r = 'true', format('service_role could not note a state (%s)', r));
  n := n + 1; failed := failed || pg_temp.sm_ok(
    (SELECT bool_and(p.prosecdef AND 'search_path=""' = ANY (p.proconfig)) FROM pg_proc p
      WHERE p.oid IN ('public.sg_note_customer_membership(uuid, text)'::regprocedure,
                      'public.sg_membership_due(uuid, integer)'::regprocedure,
                      'public.sg_customer_wrote()'::regprocedure)),
    'a function is not SECURITY DEFINER with an empty search_path');

  -- ---------- (c) sg_membership_due ----------
  -- Account a_a's earlier groups leave the list first: gm is joined, gk
  -- was just checked, ge is ENDED.
  n := n + 1; failed := failed || pg_temp.sm_ok(
    cardinality(ARRAY(SELECT sg_membership_due(a_a, 100))) = 0,
    'a joined, just-checked or ENDED group is due');

  d_old2 := pg_temp.sm_group(a_a, 'SM-D-OLD2', c1, w1, '120363000174012');
  d_old1 := pg_temp.sm_group(a_a, 'SM-D-OLD1', c1, w1, '120363000174011');
  d_null := pg_temp.sm_group(a_a, 'SM-D-NULL', c1, w1, '120363000174010');
  d_fresh := pg_temp.sm_group(a_a, 'SM-D-FRESH', c1, w1, '120363000174013');
  d_joined := pg_temp.sm_group(a_a, 'SM-D-JOINED', c1, w1, '120363000174014');
  d_ended := pg_temp.sm_group(a_a, 'SM-D-ENDED', c1, w1, '120363000174015');
  d_nochan := pg_temp.sm_group(a_a, 'SM-D-NOCHAN', c1, w2, '120363000174016');
  d_other := pg_temp.sm_group(a_b, 'SM-D-OTHER', cb, wb, '120363000174017');
  d_nowa := (SELECT x.group_id FROM sg_open(a_a, 'SM-D-NOWA', c1, w1, 's', NULL, '[]'::jsonb, NULL, 'group') x);
  d_none := (SELECT x.group_id FROM sg_open(a_a, 'SM-D-NONE', c1, NULL, 's', NULL, '[]'::jsonb, NULL, 'none') x);
  UPDATE submission_groups SET customer_membership = 'absent', customer_checked_at = now() - interval '6 hours 1 minute'
   WHERE id = d_old2;
  UPDATE submission_groups SET customer_checked_at = now() - interval '10 hours' WHERE id = d_old1;
  UPDATE submission_groups SET customer_membership = 'absent', customer_checked_at = now() - interval '5 hours 59 minutes'
   WHERE id = d_fresh;
  UPDATE submission_groups SET customer_membership = 'joined' WHERE id = d_joined;
  b := sg_end(d_ended, 'completed');
  DELETE FROM whatsapp_config WHERE id = w2;

  n := n + 1; failed := failed || pg_temp.sm_ok(
    (SELECT channel_id IS NULL AND wa_group_id IS NOT NULL FROM submission_groups WHERE id = d_nochan),
    'fixture: d_nochan kept its number');
  due := ARRAY(SELECT sg_membership_due(a_a, 100));
  n := n + 1; failed := failed || pg_temp.sm_ok(due = ARRAY[d_null, d_old1, d_old2],
    format('the due list is %s, want never checked, then 10 h, then 6 h 1 min (%s, %s, %s)', due, d_null, d_old1, d_old2));
  n := n + 1; failed := failed || pg_temp.sm_ok(NOT (due && ARRAY[d_fresh]),
    'a group checked 5 h 59 min ago is due');
  n := n + 1; failed := failed || pg_temp.sm_ok(NOT (due && ARRAY[d_none, d_nowa, d_nochan, d_ended, d_joined, d_other]),
    'a filtered group is due');
  due := ARRAY(SELECT sg_membership_due(a_a, 2));
  n := n + 1; failed := failed || pg_temp.sm_ok(due = ARRAY[d_null, d_old1], format('limit 2 gave %s', due));
  n := n + 1; failed := failed || pg_temp.sm_ok(
    cardinality(ARRAY(SELECT sg_membership_due(a_a, 0))) = 0
    AND cardinality(ARRAY(SELECT sg_membership_due(a_a, NULL))) = 0
    AND cardinality(ARRAY(SELECT sg_membership_due(a_a, -1))) = 0,
    'a zero, NULL or negative limit listed groups');
  due := ARRAY(SELECT sg_membership_due(a_b, 100));
  n := n + 1; failed := failed || pg_temp.sm_ok(due = ARRAY[d_other], format('account b''s list is %s', due));

  -- A note takes a group off the list for 6 hours.
  b := sg_note_customer_membership(d_null, 'absent');
  due := ARRAY(SELECT sg_membership_due(a_a, 100));
  n := n + 1; failed := failed || pg_temp.sm_ok(due = ARRAY[d_old1, d_old2],
    format('after a note the due list is %s', due));

  -- ---------- (d) a customer's message ----------
  gt := pg_temp.sm_group(a_a, 'SM-T', c1, w1, '120363000174020');
  b := sg_record_inbound(gt, 'sm-t1', '971500174009', 'coordinator', 'text', 'from a coordinator', NULL, NULL);
  b := sg_record_inbound(gt, 'sm-t2', '971500174009', 'other', 'text', 'from someone', NULL, NULL);
  SELECT customer_membership INTO m FROM submission_groups WHERE id = gt;
  n := n + 1; failed := failed || pg_temp.sm_ok(m = 'unknown', format('another sender''s message left %s', m));
  b := sg_record_inbound(gt, 'sm-t3', '971500174001', 'customer', 'text', 'from the customer', NULL, NULL);
  SELECT customer_membership, customer_checked_at INTO m, at FROM submission_groups WHERE id = gt;
  n := n + 1; failed := failed || pg_temp.sm_ok(b AND m = 'joined' AND at IS NULL,
    format('a customer message left %s / %s, want joined / unchecked', m, at));

  gs := pg_temp.sm_group(a_a, 'SM-S', c1, w1, '120363000174021');
  b := sg_note_customer_membership(gs, 'absent');
  b := sg_record_inbound(gs, 'sm-s1', '971500174001', 'customer', 'text', 'joined after all', NULL, NULL);
  SELECT customer_membership INTO m FROM submission_groups WHERE id = gs;
  n := n + 1; failed := failed || pg_temp.sm_ok(m = 'joined', format('a customer message over absent left %s', m));

  -- An ENDED group is frozen; its late message is still kept.
  b := sg_record_inbound(ge, 'sm-e1', '971500174001', 'customer', 'text', 'too late', NULL, NULL);
  SELECT customer_membership INTO m FROM submission_groups WHERE id = ge;
  n := n + 1; failed := failed || pg_temp.sm_ok(
    b AND m = 'unknown'
    AND EXISTS (SELECT 1 FROM submission_group_messages WHERE group_id = ge AND wa_message_id = 'sm-e1' AND post_end),
    format('a late message on an ENDED group: returned %s, state %s', b, m));

  n := n + 1; failed := failed || pg_temp.sm_ok(
    (SELECT 'lock_timeout=1s' = ANY (p.proconfig) FROM pg_proc p WHERE p.oid = 'public.sg_customer_wrote()'::regprocedure),
    'sg_customer_wrote has no lock_timeout');

  -- ---------- (e) the backfill ----------
  -- Rows as 174 finds them: the trigger did not exist when they wrote.
  b_join := pg_temp.sm_group(a_a, 'SM-B-JOIN', c1, w1, '120363000174030');
  b_absent := pg_temp.sm_group(a_a, 'SM-B-ABSENT', c1, w1, '120363000174031');
  b_quiet := pg_temp.sm_group(a_a, 'SM-B-QUIET', c1, w1, '120363000174032');
  b_ended := pg_temp.sm_group(a_a, 'SM-B-ENDED', c1, w1, '120363000174033');
  b := sg_record_inbound(b_join, 'sm-b1', '971500174001', 'customer', 'text', 'x', NULL, NULL);
  b := sg_record_inbound(b_absent, 'sm-b2', '971500174001', 'customer', 'text', 'x', NULL, NULL);
  b := sg_record_inbound(b_quiet, 'sm-b3', '971500174009', 'coordinator', 'text', 'x', NULL, NULL);
  b := sg_record_inbound(b_ended, 'sm-b4', '971500174001', 'customer', 'text', 'x', NULL, NULL);
  UPDATE submission_groups SET customer_membership = 'unknown' WHERE id = b_join;
  UPDATE submission_groups SET customer_membership = 'absent' WHERE id = b_absent;
  UPDATE submission_groups SET customer_membership = 'unknown' WHERE id = b_ended;
  b := sg_end(b_ended, 'completed');
  -- gt, gs and the rest are joined already; only b_join is left to do.
  i := sg_backfill_customer_membership();
  n := n + 1; failed := failed || pg_temp.sm_ok(i = 1, format('the backfill wrote %s rows, want 1', i));
  n := n + 1; failed := failed || pg_temp.sm_ok(
    (SELECT customer_membership FROM submission_groups WHERE id = b_join) = 'joined'
    AND (SELECT customer_checked_at FROM submission_groups WHERE id = b_join) IS NULL,
    'the backfill did not mark a group its customer wrote in, or stamped a check');
  n := n + 1; failed := failed || pg_temp.sm_ok(
    (SELECT customer_membership FROM submission_groups WHERE id = b_absent) = 'absent',
    'the backfill undid a recorded absent');
  n := n + 1; failed := failed || pg_temp.sm_ok(
    (SELECT customer_membership FROM submission_groups WHERE id = b_quiet) = 'unknown',
    'the backfill marked a group with no customer message');
  n := n + 1; failed := failed || pg_temp.sm_ok(
    (SELECT customer_membership FROM submission_groups WHERE id = b_ended) = 'unknown',
    'the backfill wrote an ENDED group');
  i := sg_backfill_customer_membership();
  n := n + 1; failed := failed || pg_temp.sm_ok(i = 0, format('a second backfill wrote %s rows', i));

  -- ---------- (f) sg_invite_claim ----------
  gc := pg_temp.sm_group(a_a, 'SM-C', c1, w1, '120363000174041');
  SELECT invite_claimed_at INTO at FROM submission_groups WHERE id = gc;
  n := n + 1; failed := failed || pg_temp.sm_ok(at IS NULL, format('a new group starts claimed at %s', at));
  b := sg_invite_claim(gc, 60);
  SELECT invite_claimed_at INTO at FROM submission_groups WHERE id = gc;
  n := n + 1; failed := failed || pg_temp.sm_ok(b AND at = now(),
    format('first claim: returned %s, claimed %s', b, at));
  b := sg_invite_claim(gc, 60);
  n := n + 1; failed := failed || pg_temp.sm_ok(NOT b, 'a second claim at once returned true');

  UPDATE submission_groups SET invite_claimed_at = now() - interval '59 seconds' WHERE id = gc;
  b := sg_invite_claim(gc, 60);
  SELECT invite_claimed_at INTO at FROM submission_groups WHERE id = gc;
  n := n + 1; failed := failed || pg_temp.sm_ok(NOT b AND at = now() - interval '59 seconds',
    format('a claim inside the window: returned %s, claimed %s', b, at));

  UPDATE submission_groups SET invite_claimed_at = now() - interval '61 seconds' WHERE id = gc;
  b := sg_invite_claim(gc, 60);
  SELECT invite_claimed_at INTO at FROM submission_groups WHERE id = gc;
  n := n + 1; failed := failed || pg_temp.sm_ok(b AND at = now(),
    format('a claim after the window: returned %s, claimed %s', b, at));

  -- A recent send blocks on its own, with no claim on the row.
  UPDATE submission_groups
     SET invite_claimed_at = NULL, invite_sent_at = now() - interval '59 seconds'
   WHERE id = gc;
  b := sg_invite_claim(gc, 60);
  SELECT invite_claimed_at INTO at FROM submission_groups WHERE id = gc;
  n := n + 1; failed := failed || pg_temp.sm_ok(NOT b AND at IS NULL,
    format('a recent invite_sent_at: returned %s, claimed %s', b, at));
  UPDATE submission_groups SET invite_sent_at = now() - interval '61 seconds' WHERE id = gc;
  b := sg_invite_claim(gc, 60);
  n := n + 1; failed := failed || pg_temp.sm_ok(b, 'an old invite_sent_at still blocked the claim');
  n := n + 1; failed := failed || pg_temp.sm_ok(
    (SELECT invite_sent_at = now() - interval '61 seconds' FROM submission_groups WHERE id = gc),
    'a claim moved invite_sent_at');

  -- Zero is no window, and is not refused.
  b := sg_invite_claim(gc, 0);
  n := n + 1; failed := failed || pg_temp.sm_ok(b, 'a cooldown of 0 refused the claim');

  b := sg_invite_claim(ge, 60);
  SELECT invite_claimed_at INTO at FROM submission_groups WHERE id = ge;
  n := n + 1; failed := failed || pg_temp.sm_ok(NOT b AND at IS NULL,
    format('an ENDED group: returned %s, claimed %s', b, at));
  b := sg_invite_claim('00000000-0000-4000-8000-000000174999', 60);
  n := n + 1; failed := failed || pg_temp.sm_ok(NOT b, 'claiming a missing group returned true');

  UPDATE submission_groups SET invite_claimed_at = old_at WHERE id = gc;
  r := pg_temp.sm_try(NULL, NULL, format('SELECT sg_invite_claim(%L, NULL)', gc));
  n := n + 1; failed := failed || pg_temp.sm_ok(r LIKE 'ERROR 22023:%', format('a NULL cooldown was taken (%s)', r));
  r := pg_temp.sm_try(NULL, NULL, format('SELECT sg_invite_claim(%L, -1)', gc));
  n := n + 1; failed := failed || pg_temp.sm_ok(r LIKE 'ERROR 22023:%', format('a negative cooldown was taken (%s)', r));
  r := pg_temp.sm_try('authenticated', u_a, format('SELECT sg_invite_claim(%L, 60)', gc));
  n := n + 1; failed := failed || pg_temp.sm_ok(r LIKE 'ERROR 42501:%', format('authenticated claimed an invite (%s)', r));
  r := pg_temp.sm_try('anon', NULL, format('SELECT sg_invite_claim(%L, 60)', gc));
  n := n + 1; failed := failed || pg_temp.sm_ok(r LIKE 'ERROR 42501:%', format('anon claimed an invite (%s)', r));
  SELECT invite_claimed_at INTO at FROM submission_groups WHERE id = gc;
  n := n + 1; failed := failed || pg_temp.sm_ok(at = old_at, format('a refused claim still wrote (%s)', at));
  r := pg_temp.sm_try('service_role', NULL, format('SELECT sg_invite_claim(%L, 60)', gc));
  n := n + 1; failed := failed || pg_temp.sm_ok(r = 'true', format('service_role could not claim (%s)', r));
  n := n + 1; failed := failed || pg_temp.sm_ok(
    has_function_privilege('service_role', 'public.sg_invite_claim(uuid, integer)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.sg_invite_claim(uuid, integer)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.sg_invite_claim(uuid, integer)', 'EXECUTE')
    AND NOT EXISTS (
      SELECT 1 FROM pg_proc p, LATERAL aclexplode(p.proacl) x
       WHERE p.oid = 'public.sg_invite_claim(uuid, integer)'::regprocedure AND x.grantee = 0),
    'sg_invite_claim is not service_role only');
  n := n + 1; failed := failed || pg_temp.sm_ok(
    (SELECT p.prosecdef AND 'search_path=""' = ANY (p.proconfig) FROM pg_proc p
      WHERE p.oid = 'public.sg_invite_claim(uuid, integer)'::regprocedure),
    'sg_invite_claim is not SECURITY DEFINER with an empty search_path');

  -- ---------- (g) a failing trigger never loses the message ----------
  -- Last: the swapped CHECK refuses every write of 'joined'.
  gf := pg_temp.sm_group(a_a, 'SM-F', c1, w1, '120363000174040');
  ALTER TABLE submission_groups DROP CONSTRAINT submission_groups_customer_membership_check;
  ALTER TABLE submission_groups ADD CONSTRAINT submission_groups_customer_membership_check
    CHECK (customer_membership <> 'joined') NOT VALID;
  b := sg_record_inbound(gf, 'sm-f1', '971500174001', 'customer', 'text', 'trigger fails', NULL, NULL);
  SELECT customer_membership INTO m FROM submission_groups WHERE id = gf;
  n := n + 1; failed := failed || pg_temp.sm_ok(
    b AND m = 'unknown'
    AND EXISTS (SELECT 1 FROM submission_group_messages WHERE group_id = gf AND wa_message_id = 'sm-f1'),
    format('a failing trigger lost the message, or did not fail (returned %s, state %s)', b, m));

  RAISE EXCEPTION USING ERRCODE = 'ZT174', MESSAGE = 'verify-submission-group-membership rollback';
  EXCEPTION WHEN SQLSTATE 'ZT174' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'submission group membership verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'submission group membership verification passed (% checks)', n;
END
$verify$;
