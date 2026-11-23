-- Behavioural regression suite for migration 267: statuses after a final
-- one, the bell of an ended group still open on WhatsApp, and an echo
-- settling a send shown as failed. ONE statement; the fixtures are rolled
-- back by a sentinel, the results survive in plpgsql variables.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000267001';
  u_agent  UUID := '00000000-0000-4000-8000-000000267002';
  u_coord  UUID := '00000000-0000-4000-8000-000000267003';
  u_left   UUID := '00000000-0000-4000-8000-000000267004'; -- removed before the end
  u_admin  UUID := '00000000-0000-4000-8000-000000267005';
  a_acct   UUID;
  w1       UUID;
  c1       UUID;
  ga       UUID; -- the sends, then the end
  gn       UUID; -- nobody on the list at the end
  kase     UUID;
  acc      JSONB;
  tok      UUID;
  m1       BIGINT;
  m2       BIGINT;
  i        INT;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sgf_ok(p_ok boolean, p_msg text) RETURNS text LANGUAGE sql AS
    $body$ SELECT CASE WHEN p_ok IS TRUE THEN NULL ELSE p_msg END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sgf_try(p_sql text) RETURNS text LANGUAGE plpgsql AS $body$
    BEGIN
      EXECUTE p_sql;
      RETURN 'ok';
    EXCEPTION WHEN OTHERS THEN
      RETURN SQLSTATE;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sgf_as(p_uid uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      EXECUTE p_sql INTO v;
      RESET ROLE;
      PERFORM set_config('request.jwt.claim.sub', '', true);
      PERFORM set_config('request.jwt.claims', '', true);
      RETURN coalesce(v, 'NULL');
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sgf_state(p_id bigint) RETURNS text LANGUAGE sql AS
    $body$ SELECT send_status || ':' || coalesce(wa_message_id, '-')
             FROM public.submission_group_messages WHERE id = p_id $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'sgf-owner@example.invalid'), (u_agent, 'sgf-agent@example.invalid'),
    (u_coord, 'sgf-coord@example.invalid'), (u_left, 'sgf-left@example.invalid'),
    (u_admin, 'sgf-admin@example.invalid');
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agent, u_coord, u_left);
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'SGF-1', 'x', 'connected', true) RETURNING id INTO w1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500267001', 'SGF one')
    RETURNING id INTO c1;
  acc := jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent'),
                           jsonb_build_object('user_id', u_coord, 'label', 'coordinator'),
                           jsonb_build_object('user_id', u_left, 'label', 'coordinator'));
  ga := (SELECT o.group_id FROM sg_open(a_acct, 'SGF-A', c1, w1, 'a', NULL, acc, NULL, 'group') o);
  gn := (SELECT o.group_id FROM sg_open(a_acct, 'SGF-N', c1, w1, 'n', NULL, acc, NULL, 'group') o);
  PERFORM case_open(ga, 'SGF', 'Bank SGF', NULL, NULL, NULL);
  PERFORM case_open(gn, 'SGF', 'Bank SGF', NULL, NULL, NULL);
  kase := (SELECT c.id FROM cases c WHERE c.group_id = ga);
  tok := sg_claim_create(ga, 60000);
  PERFORM sg_attach_wa_group(ga, '120363000000267001@g.us', NULL, tok);
  tok := sg_claim_create(gn, 60000);
  PERFORM sg_attach_wa_group(gn, '120363000000267002@g.us', NULL, tok);

  -- ---------- 3. echoes ----------
  -- A timed-out send, settled failed; its echo settles it, once.
  m1 := sg_send_begin(ga, u_agent, 'hi', 'A (Agent): hi');
  PERFORM sg_settle_send(m1, 'failed', NULL);
  failed := array_append(failed, pg_temp.sgf_ok(NOT sg_reconcile_echo(ga, 'WA-0', 'text', 'A (Agent): other'),
    'echo: another text claims nothing')); n := n + 1;
  failed := array_append(failed, pg_temp.sgf_ok(NOT sg_reconcile_echo(ga, 'WA-0', 'image', 'A (Agent): hi'),
    'echo: an attachment''s caption never claims a text')); n := n + 1;
  failed := array_append(failed, pg_temp.sgf_ok(NOT sg_reconcile_echo(gn, 'WA-0', 'text', 'A (Agent): hi'),
    'echo: another group claims nothing')); n := n + 1;
  failed := array_append(failed, pg_temp.sgf_ok(
    NOT sg_reconcile_echo(ga, 'WA-0', 'text', 'A (Agent): hi', now() - interval '1 minute'),
    'echo: a row written after the echo is not the one')); n := n + 1;
  failed := array_append(failed, pg_temp.sgf_ok(sg_reconcile_echo(ga, 'WA-1', 'text', 'A (Agent): hi', now()),
    'echo: a failed send is claimed')); n := n + 1;
  failed := array_append(failed, pg_temp.sgf_ok(pg_temp.sgf_state(m1) = 'sent:WA-1', 'echo: sent with the id')); n := n + 1;
  failed := array_append(failed, pg_temp.sgf_ok(
    NOT sg_reconcile_echo(ga, 'WA-1', 'text', 'A (Agent): hi') AND NOT sg_reconcile_echo(ga, 'WA-9', 'text', 'A (Agent): hi'),
    'echo: once')); n := n + 1;
  failed := array_append(failed, pg_temp.sgf_ok(NOT sg_settle_send(m1, 'sent', 'WA-1') AND pg_temp.sgf_state(m1) = 'sent:WA-1',
    'settle: the same id again changes nothing')); n := n + 1;

  -- A pending send, as before; a blocked one never.
  m1 := sg_send_begin(ga, u_agent, 'two', 'A (Agent): two');
  failed := array_append(failed, pg_temp.sgf_ok(sg_reconcile_echo(ga, 'WA-2', 'text', 'A (Agent): two')
    AND pg_temp.sgf_state(m1) = 'sent:WA-2', 'echo: a pending send')); n := n + 1;
  m1 := sg_send_begin(ga, u_agent, 'blk', 'A (Agent): blk');
  PERFORM sg_settle_send(m1, 'blocked', NULL);
  failed := array_append(failed, pg_temp.sgf_ok(NOT sg_reconcile_echo(ga, 'WA-3', 'text', 'A (Agent): blk')
    AND NOT sg_settle_send(m1, 'sent', 'WA-3'), 'echo: never a blocked send')); n := n + 1;

  -- An attachment, by its caption.
  m1 := sg_send_begin_media(ga, u_agent, 'image', '', 'A (Agent)',
    '{"link":"https://x.example.invalid/a.jpg","path":"a.jpg"}'::jsonb);
  PERFORM sg_settle_send(m1, 'failed', NULL);
  failed := array_append(failed, pg_temp.sgf_ok(NOT sg_reconcile_echo(ga, 'WA-4', 'text', 'A (Agent)')
    AND sg_reconcile_echo(ga, 'WA-4', 'image', 'A (Agent)') AND pg_temp.sgf_state(m1) = 'sent:WA-4',
    'echo: an attachment by its caption')); n := n + 1;

  -- Two attachments without a caption: the echo takes its own kind first.
  m1 := sg_send_begin_media(ga, u_agent, 'image', '', 'A (Agent)',
    '{"link":"https://x.example.invalid/b.jpg","path":"b.jpg"}'::jsonb);
  PERFORM sg_settle_send(m1, 'failed', NULL);
  m2 := sg_send_begin_media(ga, u_agent, 'document', '', 'A (Agent)',
    '{"link":"https://x.example.invalid/c.pdf","path":"c.pdf"}'::jsonb);
  PERFORM sg_settle_send(m2, 'failed', NULL);
  failed := array_append(failed, pg_temp.sgf_ok(sg_reconcile_echo(ga, 'WA-4b', 'document', 'A (Agent)')
    AND pg_temp.sgf_state(m2) = 'sent:WA-4b' AND pg_temp.sgf_state(m1) = 'failed:-',
    'echo: its own kind of attachment first')); n := n + 1;

  -- A failed send and its retry; only the retry went out, and its echo
  -- comes before the gateway's answer: the answer corrects the guess.
  m1 := sg_send_begin(ga, u_agent, 'tw', 'A (Agent): tw');
  PERFORM sg_settle_send(m1, 'failed', NULL);
  m2 := sg_send_begin(ga, u_agent, 'tw', 'A (Agent): tw');
  failed := array_append(failed, pg_temp.sgf_ok(sg_reconcile_echo(ga, 'WA-5', 'text', 'A (Agent): tw')
    AND pg_temp.sgf_state(m1) = 'sent:WA-5' AND pg_temp.sgf_state(m2) = 'pending:-', 'twins: oldest first')); n := n + 1;
  failed := array_append(failed, pg_temp.sgf_ok(sg_settle_send(m2, 'sent', 'WA-5')
    AND pg_temp.sgf_state(m2) = 'sent:WA-5' AND pg_temp.sgf_state(m1) = 'pending:-',
    'twins: the id goes to the row it belongs to')); n := n + 1;
  -- The first one's echo after all: both are sent, each its own row.
  failed := array_append(failed, pg_temp.sgf_ok(sg_reconcile_echo(ga, 'WA-6', 'text', 'A (Agent): tw')
    AND pg_temp.sgf_state(m1) = 'sent:WA-6' AND pg_temp.sgf_state(m2) = 'sent:WA-5', 'twins: both, one row each')); n := n + 1;

  -- Two in flight, each settled with the other's echo: no error, no swap.
  m1 := sg_send_begin(ga, u_agent, 'xx', 'A (Agent): xx');
  m2 := sg_send_begin(ga, u_agent, 'xx', 'A (Agent): xx');
  PERFORM sg_reconcile_echo(ga, 'WA-8', 'text', 'A (Agent): xx');
  PERFORM sg_reconcile_echo(ga, 'WA-7', 'text', 'A (Agent): xx');
  failed := array_append(failed, pg_temp.sgf_ok(sg_settle_send(m1, 'sent', 'WA-7') AND sg_settle_send(m2, 'sent', 'WA-8')
    AND pg_temp.sgf_state(m1) LIKE 'sent:%' AND pg_temp.sgf_state(m2) LIKE 'sent:%', 'twins: crossed echoes')); n := n + 1;
  -- The second's echo claims the first; the first's answer arrives.
  m1 := sg_send_begin(ga, u_agent, 'yy', 'A (Agent): yy');
  m2 := sg_send_begin(ga, u_agent, 'yy', 'A (Agent): yy');
  PERFORM sg_reconcile_echo(ga, 'WA-11', 'text', 'A (Agent): yy');
  failed := array_append(failed, pg_temp.sgf_ok(sg_settle_send(m1, 'sent', 'WA-10')
    AND pg_temp.sgf_state(m1) = 'sent:WA-10' AND pg_temp.sgf_state(m2) = 'sent:WA-11', 'twins: handed on')); n := n + 1;

  -- The settle guard still refuses everything else.
  failed := array_append(failed, pg_temp.sgf_ok(pg_temp.sgf_try(format(
    'UPDATE submission_group_messages SET send_status = ''failed'', wa_message_id = NULL WHERE id = %s', m1)) = '42501',
    'guard: a sent row cannot be changed')); n := n + 1;
  failed := array_append(failed, pg_temp.sgf_ok(pg_temp.sgf_try(format(
    'UPDATE submission_group_messages SET body = ''x'' WHERE id = %s', m1)) = '42501', 'guard: the body is fixed')); n := n + 1;
  failed := array_append(failed, pg_temp.sgf_ok(
    NOT has_function_privilege('authenticated', 'sg_reconcile_echo(uuid,text,text,text,timestamptz)', 'EXECUTE')
    AND has_function_privilege('service_role', 'sg_reconcile_echo(uuid,text,text,text,timestamptz)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'sg_settle_send(bigint,text,text)', 'EXECUTE'),
    'grants: service role only')); n := n + 1;

  -- ---------- 2. the bell ----------
  DELETE FROM notifications WHERE account_id = a_acct;
  PERFORM sg_record_inbound(ga, 'IN-1', '971500267001', 'customer', 'text', 'q', NULL, now());
  failed := array_append(failed, pg_temp.sgf_ok((SELECT count(*) FROM notifications
    WHERE account_id = a_acct AND type = 'submission_group_message') = 3, 'bell: ACTIVE as before')); n := n + 1;
  -- Two of them keep that bell into the end: the agent has read it, the
  -- coordinator who is taken off the list has not.
  DELETE FROM notifications WHERE account_id = a_acct AND user_id = u_coord;
  UPDATE notifications SET created_at = now() - interval '5 minutes' WHERE account_id = a_acct;
  UPDATE notifications SET read_at = now() WHERE account_id = a_acct AND user_id = u_agent;

  PERFORM sg_note_submission_status(ga, 'APPROVED');
  failed := array_append(failed, pg_temp.sgf_ok(NOT EXISTS (
    SELECT 1 FROM case_detail_log WHERE case_id = kase AND field = 'submission_status'),
    'status: before the end nothing is logged')); n := n + 1;
  PERFORM sg_access_remove(ga, u_left);
  PERFORM sg_end(ga, 'APPROVED');
  PERFORM case_apply_submission_status(ga, 'APPROVED');
  PERFORM sg_record_inbound(ga, 'IN-2', '971500267001', 'customer', 'text', 'q', NULL, now());
  failed := array_append(failed, pg_temp.sgf_ok((SELECT array_agg(user_id ORDER BY user_id) FROM notifications
    WHERE account_id = a_acct AND type = 'submission_group_message' AND read_at IS NULL
      AND created_at = now()) = ARRAY[u_agent, u_coord],
    'bell: ended, those on the list at the end, one read minutes before included')); n := n + 1;
  failed := array_append(failed, pg_temp.sgf_ok(
    EXISTS (SELECT 1 FROM notifications WHERE user_id = u_left AND read_at IS NULL)
    AND pg_temp.sgf_as(u_left, 'SELECT sg_unread_count()') = '0',
    'unread: an old bell of someone taken off the list counts nothing')); n := n + 1;
  DELETE FROM notifications WHERE account_id = a_acct AND created_at < now();
  failed := array_append(failed, pg_temp.sgf_ok((SELECT post_end FROM submission_group_messages
    WHERE group_id = ga AND wa_message_id = 'IN-2'), 'bell: the message is still post_end')); n := n + 1;
  PERFORM sg_record_inbound(ga, 'IN-3', '971500267001', 'customer', 'text', 'q', NULL, now());
  PERFORM sg_record_inbound(ga, 'IN-4', '971500267009', 'other', 'text', 'q', NULL, now());
  failed := array_append(failed, pg_temp.sgf_ok((SELECT count(*) FROM notifications
    WHERE account_id = a_acct AND type = 'submission_group_message') = 2, 'bell: one while unread')); n := n + 1;
  failed := array_append(failed, pg_temp.sgf_ok(
    pg_temp.sgf_as(u_agent, format('SELECT unread FROM sg_unread_by_group() WHERE group_id = %L', ga)) = '2'
    AND pg_temp.sgf_as(u_agent, 'SELECT sg_unread_count()') = '2'
    AND pg_temp.sgf_as(u_left, format('SELECT unread FROM sg_unread_by_group() WHERE group_id = %L', ga)) = 'NULL',
    'unread: the customer''s messages since the bell')); n := n + 1;
  -- Rung after the end (which is stamped with the clock; this transaction's
  -- now() is older).
  UPDATE notifications SET read_at = now(), created_at = clock_timestamp() WHERE account_id = a_acct;
  failed := array_append(failed, pg_temp.sgf_ok(
    pg_temp.sgf_as(u_agent, format('SELECT unread FROM sg_unread_by_group() WHERE group_id = %L', ga)) = 'NULL',
    'unread: gone once the bell is read')); n := n + 1;
  PERFORM sg_record_inbound(ga, 'IN-5', '971500267001', 'customer', 'text', 'q', NULL, now());
  failed := array_append(failed, pg_temp.sgf_ok((SELECT count(*) FROM notifications
    WHERE account_id = a_acct AND type = 'submission_group_message') = 2, 'bell: one per 30 minutes')); n := n + 1;
  UPDATE notifications SET created_at = now() - interval '31 minutes' WHERE account_id = a_acct;
  PERFORM sg_record_inbound(ga, 'IN-6', '971500267001', 'customer', 'text', 'q', NULL, now());
  failed := array_append(failed, pg_temp.sgf_ok((SELECT count(*) FROM notifications
    WHERE account_id = a_acct AND type = 'submission_group_message') = 4, 'bell: again after 30 minutes')); n := n + 1;

  -- Nobody left on the list: the case's agent; then the owner and admins.
  DELETE FROM notifications WHERE account_id = a_acct;
  PERFORM sg_access_remove(gn, u_agent);
  PERFORM sg_access_remove(gn, u_coord);
  PERFORM sg_access_remove(gn, u_left);
  PERFORM sg_end(gn, 'test');
  PERFORM sg_record_inbound(gn, 'IN-1', '971500267001', 'customer', 'text', 'q', NULL, now());
  failed := array_append(failed, pg_temp.sgf_ok((SELECT array_agg(user_id) FROM notifications
    WHERE account_id = a_acct AND type = 'submission_group_message') = ARRAY[u_agent],
    'bell: the case''s agent when nobody is left')); n := n + 1;
  DELETE FROM notifications WHERE account_id = a_acct;
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_agent;
  PERFORM sg_record_inbound(gn, 'IN-2', '971500267001', 'customer', 'text', 'q', NULL, now());
  failed := array_append(failed, pg_temp.sgf_ok((SELECT array_agg(user_id ORDER BY user_id) FROM notifications
    WHERE account_id = a_acct AND type = 'submission_group_message') = ARRAY[u_owner, u_admin],
    'bell: else the owner and admins')); n := n + 1;
  -- Closed on WhatsApp: silence.
  DELETE FROM notifications WHERE account_id = a_acct;
  PERFORM sg_mark_wa_closed(gn);
  PERFORM sg_record_inbound(gn, 'IN-3', '971500267001', 'customer', 'text', 'q', NULL, now());
  failed := array_append(failed, pg_temp.sgf_ok(NOT EXISTS (SELECT 1 FROM notifications
    WHERE account_id = a_acct AND type = 'submission_group_message'), 'bell: none once WhatsApp is closed')); n := n + 1;

  -- ---------- 1. later statuses ----------
  PERFORM sg_mark_wa_closed(ga);
  SELECT count(*) INTO i FROM case_stage_history WHERE case_id = kase;
  failed := array_append(failed, pg_temp.sgf_ok(NOT sg_note_submission_status(ga, 'APPROVED')
    AND NOT EXISTS (SELECT 1 FROM case_detail_log WHERE case_id = kase AND field = 'submission_status'),
    'status: a repeat changes nothing')); n := n + 1;
  failed := array_append(failed, pg_temp.sgf_ok(sg_note_submission_status(ga, 'DISBURSED')
    AND sg_note_submission_status(ga, 'DECLINED'), 'status: stored after the end')); n := n + 1;
  failed := array_append(failed, pg_temp.sgf_ok((SELECT submission_status = 'DECLINED' AND submission_status_at IS NOT NULL
    AND status = 'ENDED' FROM submission_groups WHERE id = ga), 'status: text and time on the group')); n := n + 1;
  r := NULL;
  PERFORM case_apply_submission_status(ga, 'DECLINED');
  failed := array_append(failed, pg_temp.sgf_ok((SELECT stage = 'Approved' AND outcome = 'Approved' AND closed_at IS NOT NULL
    FROM cases WHERE id = kase)
    AND (SELECT count(*) FROM case_stage_history WHERE case_id = kase) = i, 'status: the closed case stays as decided')); n := n + 1;
  SELECT string_agg(t.summary, '; ' ORDER BY t.ref_id::bigint) INTO r
    FROM case_timeline(u_owner, kase) t WHERE t.kind = 'submission_status';
  failed := array_append(failed, pg_temp.sgf_ok(r = 'APPROVED -> DISBURSED; DISBURSED -> DECLINED',
    'status: the timeline (' || coalesce(r, 'none') || ')')); n := n + 1;
  failed := array_append(failed, pg_temp.sgf_ok(
    pg_temp.sgf_try(format('UPDATE submission_groups SET subject = ''x'' WHERE id = %L', ga)) = '42501'
    AND pg_temp.sgf_try(format('UPDATE submission_groups SET submission_status = NULL WHERE id = %L', ga)) = '42501'
    AND pg_temp.sgf_try(format('UPDATE submission_groups SET submission_status = ''X'', end_reason = ''y'' WHERE id = %L', ga)) = '42501',
    'guard: nothing else of an ended group changes')); n := n + 1;
  failed := array_append(failed, pg_temp.sgf_ok(NOT sg_note_submission_status(gen_random_uuid(), 'X'),
    'status: an unknown group')); n := n + 1;

  RAISE EXCEPTION 'SGF_ROLLBACK';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'SGF_ROLLBACK' THEN RAISE; END IF;
  END;

  failed := array_remove(failed, NULL);
  IF n < 40 THEN RAISE EXCEPTION 'verify-sg-fixes: only % checks ran', n; END IF;
  IF cardinality(failed) > 0 THEN
    RAISE EXCEPTION 'verify-sg-fixes: % of % failed: %', cardinality(failed), n, array_to_string(failed, '; ');
  END IF;
  RAISE NOTICE 'verify-sg-fixes: % checks passed', n;
END $verify$;
