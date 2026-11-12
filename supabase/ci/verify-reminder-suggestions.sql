-- Behavioural regression suite for migration 197: reminder suggestions
-- and the due-now task reminder.
--
-- message_reminder_suggestions: RLS on, authenticated reads only and
-- service_role writes; every CHECK refuses a bad value and a message has
-- at most one row; a suggestion is visible to whoever can see its chat
-- (owner, the assigned agent) and to nobody else (another agent, another
-- account, a bank guest of the same workspace, anon), with a control
-- that the other agent does see one on a
-- chat of their own; deleting the task keeps the row with task_id NULL,
-- deleting the message removes it; the table is in supabase_realtime.
-- ai_insight_settings.reminder_suggest_enabled is NOT NULL DEFAULT false.
-- calendar_reminder_sweep rings task_due 15 minutes before (offset 15,
-- 'Due in 15 minutes') and again when due (offset 0, 'Due now') once
-- each, again after a snooze, never for a done or unassigned task, and
-- only the service role may run it; a first sweep 5 minutes after due_at
-- rings nothing, and a task set under 10 minutes ahead rings once, when
-- due. Every task_due push of one task is
-- tagged 'task:<id>' (the due-now push replaces the heads-up on the
-- device); other bells keep 'bell:<row id>'.
--
-- ONE statement on purpose (the pinned CLI rejects several). Failing
-- assertions are named in the final exception; fixtures (fresh ids, so
-- the block can run twice) are undone by a sentinel exception while the
-- collected results survive.

DO $verify$
DECLARE
  u_own  UUID := gen_random_uuid();
  u_ag1  UUID := gen_random_uuid();
  u_ag2  UUID := gen_random_uuid();
  u_b    UUID := gen_random_uuid();
  u_g    UUID := gen_random_uuid();
  a_acct UUID;
  b_acct UUID;
  ct1    UUID;
  ct2    UUID;
  c1     UUID;
  c2     UUID;
  m1     UUID := gen_random_uuid();
  m2     UUID := gen_random_uuid();
  m3     UUID := gen_random_uuid();
  s1     UUID := gen_random_uuid();
  s2     UUID := gen_random_uuid();
  t_link UUID;
  t_due  UUID;
  t_done UUID;
  t_none UUID;
  t_note UUID;
  t_edge UUID;
  t_late UUID;
  t0     TIMESTAMPTZ := '2031-03-03 10:00+00';
  priv   TEXT;
  rl     TEXT;
  r      TEXT;
  q      TEXT;
  n      INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (a signed-in user when p_uid is given):
  -- the value of a SELECT, the row count of anything else, or the error.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.rs_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; c bigint;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', p_role)::text, true);
        EXECUTE format('SET LOCAL ROLE %I', p_role);
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
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;

  -- Fixture: account A (owner, agents ag1 and ag2), account B (owner).
  -- Chat c1 is assigned to ag1, chat c2 to ag2; both owned by A's owner.
  INSERT INTO auth.users (id, email) VALUES
    (u_own, 'rs-own-' || u_own || '@example.invalid'),
    (u_ag1, 'rs-ag1-' || u_ag1 || '@example.invalid'),
    (u_ag2, 'rs-ag2-' || u_ag2 || '@example.invalid'),
    (u_b,   'rs-b-'   || u_b   || '@example.invalid'),
    (u_g,   'rs-g-'   || u_g   || '@example.invalid');
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_own;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_b;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_ag1, u_ag2);
  -- A partner bank's guest login in the same workspace (082-083).
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_g;

  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_own, '9715' || lpad((random() * 1e8)::bigint::text, 8, '0'), 'RS contact 1')
  RETURNING id INTO ct1;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_own, '9715' || lpad((random() * 1e8)::bigint::text, 8, '0'), 'RS contact 2')
  RETURNING id INTO ct2;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_own, ct1, u_ag1) RETURNING id INTO c1;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_own, ct2, u_ag2) RETURNING id INTO c2;

  r := pg_temp.rs_try('service_role', NULL, format(
         'INSERT INTO messages (id, conversation_id, sender_type, content_text) VALUES (%L, %L, %L, %L), (%L, %L, %L, %L), (%L, %L, %L, %L)',
         m1, c1, 'customer', 'call me tomorrow at 3',
         m2, c1, 'customer', 'I will send the papers on Sunday',
         m3, c2, 'customer', 'pay on the 5th'));
  IF r <> '3' THEN
    RAISE EXCEPTION 'fixture: messages insert failed: %', r;
  END IF;

  -- ---------- 1. RLS and grants ----------
  n := n + 1;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.message_reminder_suggestions'::regclass) THEN
    failed := array_append(failed, 'RLS is not enabled on message_reminder_suggestions'::text);
  END IF;
  n := n + 1;
  IF NOT has_table_privilege('authenticated', 'public.message_reminder_suggestions', 'SELECT') THEN
    failed := array_append(failed, 'authenticated lacks SELECT on message_reminder_suggestions'::text);
  END IF;
  FOREACH priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
    n := n + 1;
    IF has_table_privilege('authenticated', 'public.message_reminder_suggestions', priv) THEN
      failed := array_append(failed, ('authenticated has ' || priv || ' on message_reminder_suggestions')::text);
    END IF;
  END LOOP;
  FOREACH priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
    n := n + 1;
    IF has_table_privilege('anon', 'public.message_reminder_suggestions', priv) THEN
      failed := array_append(failed, ('anon has ' || priv || ' on message_reminder_suggestions')::text);
    END IF;
  END LOOP;
  FOREACH priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    n := n + 1;
    IF NOT has_table_privilege('service_role', 'public.message_reminder_suggestions', priv) THEN
      failed := array_append(failed, ('service_role lacks ' || priv || ' on message_reminder_suggestions')::text);
    END IF;
  END LOOP;

  -- The service role writes; a signed-in user cannot.
  r := pg_temp.rs_try('service_role', NULL, format(
         'INSERT INTO message_reminder_suggestions (id, account_id, conversation_id, message_id, side, kind, due_at, phrase, p) VALUES (%L, %L, %L, %L, %L, %L, %L, %L, %s), (%L, %L, %L, %L, %L, %L, %L, %L, %s)',
         s1, a_acct, c1, m1, 'customer', 'call', t0, 'tomorrow at 3', 0.9,
         s2, a_acct, c2, m3, 'customer', 'payment', t0, 'on the 5th', 0.7));
  n := n + 1;
  IF r <> '2' THEN
    failed := array_append(failed, ('service_role could not insert suggestions: ' || r)::text);
  END IF;
  r := pg_temp.rs_try('service_role', NULL, format(
         'UPDATE message_reminder_suggestions SET status = %L, acted_by = %L, acted_at = now() WHERE id = %L',
         'dismissed', u_ag2, s2));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('service_role could not update a suggestion: ' || r)::text);
  END IF;
  r := pg_temp.rs_try('authenticated', u_own, format(
         'INSERT INTO message_reminder_suggestions (account_id, conversation_id, message_id, side, kind, due_at, phrase, p) VALUES (%L, %L, %L, %L, %L, %L, %L, 0.5)',
         a_acct, c1, m2, 'customer', 'documents', t0, 'on Sunday'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('an owner inserted a suggestion directly: ' || r)::text);
  END IF;
  r := pg_temp.rs_try('authenticated', u_own, format(
         'UPDATE message_reminder_suggestions SET status = %L WHERE id = %L', 'added', s1));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('an owner updated a suggestion directly: ' || r)::text);
  END IF;

  -- ---------- 2. CHECKs and one row per message ----------
  FOREACH q IN ARRAY ARRAY[
    format('(%L, %L, %L, %L, %L, %L, %L, %s, %L)', a_acct, c1, m2, 'bot', 'call', t0, 'x', 0.5, 'open'),
    format('(%L, %L, %L, %L, %L, %L, %L, %s, %L)', a_acct, c1, m2, 'agent', 'lunch', t0, 'x', 0.5, 'open'),
    format('(%L, %L, %L, %L, %L, %L, %L, %s, %L)', a_acct, c1, m2, 'agent', 'call', t0, 'x', 0.5, 'snoozed'),
    format('(%L, %L, %L, %L, %L, %L, %L, %s, %L)', a_acct, c1, m2, 'agent', 'call', t0, 'x', 1.5, 'open'),
    format('(%L, %L, %L, %L, %L, %L, %L, %s, %L)', a_acct, c1, m2, 'agent', 'call', t0, 'x', -0.1, 'open'),
    format('(%L, %L, %L, %L, %L, %L, %L, %s, %L)', a_acct, c1, m2, 'agent', 'call', t0, '', 0.5, 'open'),
    format('(%L, %L, %L, %L, %L, %L, %L, %s, %L)', a_acct, c1, m2, 'agent', 'call', t0, repeat('x', 121), 0.5, 'open')
  ] LOOP
    r := pg_temp.rs_try('service_role', NULL,
           'INSERT INTO message_reminder_suggestions (account_id, conversation_id, message_id, side, kind, due_at, phrase, p, status) VALUES ' || q);
    n := n + 1;
    IF r NOT LIKE 'ERROR 23514%' THEN
      failed := array_append(failed, ('a CHECK accepted ' || q || ': ' || r)::text);
    END IF;
  END LOOP;
  r := pg_temp.rs_try('service_role', NULL, format(
         'INSERT INTO message_reminder_suggestions (account_id, conversation_id, message_id, side, kind, due_at, phrase, p) VALUES (%L, %L, %L, %L, %L, %L, %L, 0.5)',
         a_acct, c1, m1, 'agent', 'follow_up', t0, 'again'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23505%' THEN
    failed := array_append(failed, ('a second suggestion for one message was stored: ' || r)::text);
  END IF;

  -- ---------- 3. Visibility follows the chat ----------
  q := format('SELECT count(*)::text FROM message_reminder_suggestions WHERE id = %L', s1);
  r := pg_temp.rs_try('authenticated', u_own, q);
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, ('the owner does not see a suggestion on c1: ' || r)::text); END IF;
  r := pg_temp.rs_try('authenticated', u_ag1, q);
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, ('the agent assigned c1 does not see its suggestion: ' || r)::text); END IF;
  r := pg_temp.rs_try('authenticated', u_ag2, q);
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, ('an agent who cannot see c1 sees its suggestion: ' || r)::text); END IF;
  r := pg_temp.rs_try('authenticated', u_b, q);
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, ('another account''s member sees the suggestion: ' || r)::text); END IF;
  r := pg_temp.rs_try('anon', NULL, q);
  n := n + 1;
  IF r <> '0' AND r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('anon sees the suggestion: ' || r)::text);
  END IF;
  -- A bank guest of the same workspace: current_account_id() is NULL
  -- for a guest, so the policy's first clause refuses.
  r := pg_temp.rs_try('authenticated', u_g, q);
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, ('a bank guest of the workspace sees the suggestion: ' || r)::text); END IF;
  -- Control: ag2 does see the one on the chat assigned to them, so the
  -- denial above is about c1, not a blanket refusal.
  r := pg_temp.rs_try('authenticated', u_ag2, format(
         'SELECT count(*)::text FROM message_reminder_suggestions WHERE id = %L', s2));
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, ('the agent assigned c2 does not see its suggestion: ' || r)::text); END IF;

  -- ---------- 4. Task and message deletes ----------
  INSERT INTO tasks (account_id, kind, title, assigned_to, created_by, due_at)
  VALUES (a_acct, 'follow_up', 'RS linked', u_ag1, u_own, t0 + interval '1 day') RETURNING id INTO t_link;
  UPDATE message_reminder_suggestions SET status = 'added', task_id = t_link, acted_by = u_ag1, acted_at = now() WHERE id = s1;
  DELETE FROM tasks WHERE id = t_link;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM message_reminder_suggestions WHERE id = s1 AND task_id IS NULL AND status = 'added') THEN
    failed := array_append(failed, 'deleting the linked task did not keep the suggestion with task_id NULL'::text);
  END IF;
  DELETE FROM messages WHERE id = m1;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM message_reminder_suggestions WHERE id = s1) THEN
    failed := array_append(failed, 'deleting the message kept its suggestion'::text);
  END IF;

  -- ---------- 5. The switch ----------
  n := n + 1;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'ai_insight_settings'
       AND column_name = 'reminder_suggest_enabled' AND data_type = 'boolean'
       AND is_nullable = 'NO' AND column_default = 'false'
  ) THEN
    failed := array_append(failed, 'ai_insight_settings.reminder_suggest_enabled is not boolean NOT NULL DEFAULT false'::text);
  END IF;

  -- ---------- 6. The sweep: 15 minutes before, and when due ----------
  INSERT INTO tasks (account_id, kind, title, assigned_to, created_by, due_at)
  VALUES (a_acct, 'follow_up', 'RS due', u_ag1, u_own, t0) RETURNING id INTO t_due;
  INSERT INTO tasks (account_id, kind, title, assigned_to, created_by, due_at, status)
  VALUES (a_acct, 'follow_up', 'RS done', u_ag1, u_own, t0, 'done') RETURNING id INTO t_done;
  INSERT INTO tasks (account_id, kind, title, assigned_to, created_by, due_at)
  VALUES (a_acct, 'follow_up', 'RS none', NULL, u_own, t0) RETURNING id INTO t_none;
  -- A device, so the rings below are also queued as pushes (section 9).
  INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
  VALUES (u_ag1, 'https://push.example.invalid/rs-ag1', 'k', 'a');

  r := pg_temp.rs_try('service_role', NULL, format('SELECT calendar_reminder_sweep(%L)::text', t0 - interval '12 minutes'));
  n := n + 1;
  IF r <> '1' OR (SELECT count(*) FROM notifications WHERE type = 'task_due' AND meta->>'task_id' = t_due::text) <> 1
     OR NOT EXISTS (SELECT 1 FROM notifications WHERE type = 'task_due' AND user_id = u_ag1
                       AND meta->>'task_id' = t_due::text AND meta->'offset' = '15'::jsonb
                       AND body LIKE 'Due in 15 minutes%') THEN
    failed := array_append(failed, ('the 15-minute task_due ring (offset 15, "Due in 15 minutes"): ' || r)::text);
  END IF;

  r := pg_temp.rs_try('service_role', NULL, format('SELECT calendar_reminder_sweep(%L)::text', t0 + interval '1 minute'));
  n := n + 1;
  IF r <> '1' OR (SELECT count(*) FROM notifications WHERE type = 'task_due' AND meta->>'task_id' = t_due::text) <> 2
     OR NOT EXISTS (SELECT 1 FROM notifications WHERE type = 'task_due' AND user_id = u_ag1
                       AND meta->>'task_id' = t_due::text AND meta->'offset' = '0'::jsonb
                       AND body LIKE 'Due now%') THEN
    failed := array_append(failed, ('the due-now task_due ring (offset 0, "Due now"): ' || r)::text);
  END IF;

  r := pg_temp.rs_try('service_role', NULL, format('SELECT calendar_reminder_sweep(%L)::text', t0 + interval '2 minutes'));
  n := n + 1;
  IF r <> '0' OR (SELECT count(*) FROM notifications WHERE type = 'task_due' AND meta->>'task_id' = t_due::text) <> 2 THEN
    failed := array_append(failed, ('a second sweep in the due-now window rang again: ' || r)::text);
  END IF;

  -- A snooze moves due_at: the due-now ring comes again at the new time.
  UPDATE tasks SET due_at = t0 + interval '60 minutes' WHERE id = t_due;
  r := pg_temp.rs_try('service_role', NULL, format('SELECT calendar_reminder_sweep(%L)::text', t0 + interval '61 minutes'));
  n := n + 1;
  IF r <> '1' OR (SELECT count(*) FROM notifications WHERE type = 'task_due' AND meta->>'task_id' = t_due::text
                    AND meta->'offset' = '0'::jsonb) <> 2 THEN
    failed := array_append(failed, ('a snoozed task did not ring due-now at its new time: ' || r)::text);
  END IF;

  n := n + 1;
  IF EXISTS (SELECT 1 FROM notifications WHERE type = 'task_due' AND meta->>'task_id' IN (t_done::text, t_none::text)) THEN
    failed := array_append(failed, 'a done or unassigned task rang task_due'::text);
  END IF;

  -- ---------- 9. One phone notification per task ----------
  -- Every task_due push of a task shares the tag 'task:<id>', so the
  -- due-now push replaces the 15-minute heads-up on the device and the
  -- snoozed ring replaces the last one: three rings above, three queued
  -- pushes, one tag, none tagged per bell row.
  n := n + 1;
  IF (SELECT count(*) FROM push_outbox WHERE user_id = u_ag1 AND kind = 'task_due'
        AND tag = 'task:' || t_due::text) <> 3
     OR EXISTS (SELECT 1 FROM push_outbox WHERE user_id = u_ag1 AND kind = 'task_due'
                  AND tag IS DISTINCT FROM 'task:' || t_due::text) THEN
    failed := array_append(failed, 'task_due pushes are not all tagged task:<task id>'::text);
  END IF;
  -- Control: any other bell keeps its own tag, 'bell:<row id>'.
  INSERT INTO notifications (account_id, user_id, type, title)
  VALUES (a_acct, u_ag1, 'task_assigned', 'RS control') RETURNING id INTO t_note;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM push_outbox WHERE user_id = u_ag1 AND kind = 'task_assigned'
                   AND tag = 'bell:' || t_note::text) THEN
    failed := array_append(failed, 'another bell type lost its bell:<id> push tag'::text);
  END IF;

  -- ---------- 10. The due-now window's edges ----------
  -- (After section 9: these rings queue pushes with their own tags.)
  -- The window closes 5 minutes after due_at: a first sweep exactly then
  -- rings nothing.
  INSERT INTO tasks (account_id, kind, title, assigned_to, created_by, due_at)
  VALUES (a_acct, 'follow_up', 'RS edge', u_ag1, u_own, t0 + interval '3 hours') RETURNING id INTO t_edge;
  r := pg_temp.rs_try('service_role', NULL, format('SELECT calendar_reminder_sweep(%L)::text', t0 + interval '3 hours 5 minutes'));
  n := n + 1;
  IF EXISTS (SELECT 1 FROM notifications WHERE type = 'task_due' AND meta->>'task_id' = t_edge::text) THEN
    failed := array_append(failed, ('a first sweep 5 minutes after due_at still rang: ' || r)::text);
  END IF;
  -- A task set under 10 minutes ahead misses the heads-up window and
  -- rings exactly once, when due.
  INSERT INTO tasks (account_id, kind, title, assigned_to, created_by, due_at)
  VALUES (a_acct, 'follow_up', 'RS late', u_ag1, u_own, t0 + interval '5 hours') RETURNING id INTO t_late;
  r := pg_temp.rs_try('service_role', NULL, format('SELECT calendar_reminder_sweep(%L)::text', t0 + interval '5 hours' - interval '5 minutes'));
  r := pg_temp.rs_try('service_role', NULL, format('SELECT calendar_reminder_sweep(%L)::text', t0 + interval '5 hours 1 minute'));
  n := n + 1;
  IF (SELECT count(*) FROM notifications WHERE type = 'task_due' AND meta->>'task_id' = t_late::text) <> 1
     OR NOT EXISTS (SELECT 1 FROM notifications WHERE type = 'task_due' AND meta->>'task_id' = t_late::text
                      AND meta->'offset' = '0'::jsonb) THEN
    failed := array_append(failed, 'a task due in under 10 minutes did not ring exactly once, when due'::text);
  END IF;

  -- ---------- 7. Realtime ----------
  n := n + 1;
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                      WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
                        AND tablename = 'message_reminder_suggestions') THEN
    failed := array_append(failed, 'message_reminder_suggestions is not in supabase_realtime'::text);
  END IF;

  -- ---------- 8. Who may run the sweep ----------
  n := n + 1;
  IF NOT has_function_privilege('service_role', 'public.calendar_reminder_sweep(timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.calendar_reminder_sweep(timestamptz)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.calendar_reminder_sweep(timestamptz)', 'EXECUTE') THEN
    failed := array_append(failed, 'calendar_reminder_sweep is not service-role only'::text);
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZT197', MESSAGE = 'verify-reminder-suggestions rollback';
  EXCEPTION WHEN SQLSTATE 'ZT197' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'reminder suggestions verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'reminder suggestions verification passed (% checks)', n;
END
$verify$;
