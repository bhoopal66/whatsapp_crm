-- Behavioural regression suite for HR workflows (migration 200).
--
-- HR chats get a row in hr_conversations: a candidate in the recruiter
-- inbox moves through four stages, an employee in the dept inbox carries
-- a topic. Every write is a SECURITY DEFINER hr_* RPC that keeps today's
-- chat visibility (a chat the caller cannot see is NOT_FOUND) and adds
-- the HR role matrix (admin, recruiter/dept lead or member). Entering a
-- stage or topic fires the account's rules (tasks deduplicated on
-- tasks' source_ref, the urgent flag), the messages trigger keeps the
-- reply state, and hr_sweep (service role only) raises reply-overdue and
-- no-activity tasks once each. This asserts each of those through the
-- real RLS, triggers and RPCs.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000200001';  -- owner of A (admin)
  u_rlead  UUID := '00000000-0000-4000-8000-000000200002';  -- agent, recruiter lead
  u_rmem   UUID := '00000000-0000-4000-8000-000000200003';  -- agent, recruiter + dept member
  u_dmem   UUID := '00000000-0000-4000-8000-000000200004';  -- agent, dept member
  u_plain  UUID := '00000000-0000-4000-8000-000000200005';  -- agent, no HR role
  u_blind  UUID := '00000000-0000-4000-8000-000000200006';  -- agent, recruiter member, sees no chat
  u_view   UUID := '00000000-0000-4000-8000-000000200007';  -- viewer (not staff)
  u_out    UUID := '00000000-0000-4000-8000-000000200008';  -- owner of workspace B
  a_acct   UUID;
  a_out    UUID;
  k        UUID[] := '{}';  -- contacts
  c1 UUID; c2 UUID; c3 UUID; c4 UUID; c5 UUID; c6 UUID; c7 UUID; c8 UUID;
  t0       TIMESTAMPTZ := now();
  r        TEXT;
  i        INT;
  c        TEXT[] := '{}';  -- one element per check: NULL = passed
  failed   TEXT[];
  n        INT := 0;
BEGIN
  BEGIN
  -- Run a statement as a signed-in user (p_uid) or, with p_uid NULL, as
  -- the service role with no user: the value / 'ok', or
  -- 'ERROR <sqlstate> <hint>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.hr_as(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; st text; h text; m text;
    BEGIN
      BEGIN
        IF p_uid IS NULL THEN
          PERFORM set_config('request.jwt.claim.sub', '', true);
          PERFORM set_config('request.jwt.claims',
            json_build_object('role', 'service_role')::text, true);
          SET LOCAL ROLE service_role;
        ELSE
          PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
          PERFORM set_config('request.jwt.claims',
            json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
          SET LOCAL ROLE authenticated;
        END IF;
        IF p_sql ILIKE 'select%' THEN
          EXECUTE p_sql INTO v;
        ELSE
          EXECUTE p_sql;
        END IF;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(nullif(v, ''), 'ok');  -- a void RPC casts to ''
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, h = PG_EXCEPTION_HINT,
                                m = MESSAGE_TEXT;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN format('ERROR %s %s: %s', st, coalesce(h, ''), m);
      END;
    END $body$
  $fn$;

  -- NULL when `got` matches the LIKE pattern, else the named failure.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.hr_chk(p_label text, p_got text, p_want text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT CASE WHEN p_got LIKE p_want THEN NULL
                  ELSE p_label || ' (got ' || left(coalesce(p_got, '<null>'), 200) || ')' END
    $body$
  $fn$;

  -- Fixture: workspace A (u_owner's) and B (u_out's). The auth.users
  -- trigger provisions each person an account of their own; everyone
  -- but the two owners moves into A.
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'hr-owner@example.invalid'),
    (u_rlead, 'hr-rlead@example.invalid'),
    (u_rmem,  'hr-rmem@example.invalid'),
    (u_dmem,  'hr-dmem@example.invalid'),
    (u_plain, 'hr-plain@example.invalid'),
    (u_blind, 'hr-blind@example.invalid'),
    (u_view,  'hr-view@example.invalid'),
    (u_out,   'hr-out@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  SELECT id INTO a_out FROM accounts WHERE owner_user_id = u_out;
  IF a_acct IS NULL OR a_out IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent'
   WHERE user_id IN (u_rlead, u_rmem, u_dmem, u_plain, u_blind);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_view;

  FOR i IN 1..8 LOOP
    INSERT INTO contacts (account_id, user_id, phone)
    VALUES (a_acct, u_owner, '97150200' || lpad(i::text, 4, '0'))
    RETURNING id INTO c1;
    k := k || c1;
  END LOOP;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k[1], u_rmem) RETURNING id INTO c1;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k[2], u_rlead) RETURNING id INTO c2;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k[3], u_dmem) RETURNING id INTO c3;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k[4], u_plain) RETURNING id INTO c4;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k[5], u_rmem) RETURNING id INTO c5;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k[6], u_rmem) RETURNING id INTO c6;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k[7], u_rmem) RETURNING id INTO c7;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k[8], u_rmem) RETURNING id INTO c8;

  -- ---------- hr_member_set ----------
  r := pg_temp.hr_as(u_owner, format('SELECT public.hr_member_set(%L, ''recruiter'', ''lead'')', u_rlead))
    || pg_temp.hr_as(u_owner, format('SELECT public.hr_member_set(%L, ''recruiter'', ''member'')', u_rmem))
    || pg_temp.hr_as(u_owner, format('SELECT public.hr_member_set(%L, ''dept'', ''member'')', u_rmem))
    || pg_temp.hr_as(u_owner, format('SELECT public.hr_member_set(%L, ''dept'', ''member'')', u_dmem))
    || pg_temp.hr_as(u_owner, format('SELECT public.hr_member_set(%L, ''recruiter'', ''member'')', u_blind));
  c := c || pg_temp.hr_chk('hr_member_set by an owner was refused', r, 'okokokokok');
  r := pg_temp.hr_as(u_rlead, format('SELECT public.hr_member_set(%L, ''dept'', ''member'')', u_plain));
  c := c || pg_temp.hr_chk('hr_member_set by a recruiter lead was not NOT_ALLOWED', r, 'ERROR 42501 NOT_ALLOWED:%');
  r := pg_temp.hr_as(u_owner, format('SELECT public.hr_member_set(%L, ''recruiter'', ''member'')', u_view));
  c := c || pg_temp.hr_chk('hr_member_set on a non-staff target was not NOT_FOUND', r, 'ERROR P0002 NOT_FOUND:%');
  r := pg_temp.hr_as(u_owner, format('SELECT public.hr_member_set(%L, ''recruiter'', ''member'')', u_plain))
    || pg_temp.hr_as(u_owner, format('SELECT public.hr_member_set(%L, ''recruiter'', NULL)', u_plain));
  r := r || '/' || (SELECT count(*) FROM hr_team_members m WHERE m.user_id = u_plain);
  c := c || pg_temp.hr_chk('hr_member_set with role NULL did not remove the membership', r, 'okok/0');

  -- ---------- Roles ----------
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_my_roles()::text');
  c := c || pg_temp.hr_chk('hr_my_roles(admin)', r, ('{"admin": true, "recruiter": null, "dept": null}'::jsonb)::text);
  r := pg_temp.hr_as(u_rlead, 'SELECT public.hr_my_roles()::text');
  c := c || pg_temp.hr_chk('hr_my_roles(recruiter lead)', r, ('{"admin": false, "recruiter": "lead", "dept": null}'::jsonb)::text);
  r := pg_temp.hr_as(u_rmem, 'SELECT public.hr_my_roles()::text');
  c := c || pg_temp.hr_chk('hr_my_roles(recruiter member)', r, ('{"admin": false, "recruiter": "member", "dept": "member"}'::jsonb)::text);
  r := pg_temp.hr_as(u_dmem, 'SELECT public.hr_my_roles()::text');
  c := c || pg_temp.hr_chk('hr_my_roles(dept member)', r, ('{"admin": false, "recruiter": null, "dept": "member"}'::jsonb)::text);
  r := pg_temp.hr_as(u_plain, 'SELECT public.hr_my_roles()::text');
  c := c || pg_temp.hr_chk('hr_my_roles(plain agent)', r, ('{"admin": false, "recruiter": null, "dept": null}'::jsonb)::text);

  -- ---------- hr_open ----------
  r := pg_temp.hr_as(u_rmem, format('SELECT (public.hr_open(%L, ''candidate'')).stage_key', c1));
  c := c || pg_temp.hr_chk('hr_open candidate did not start at cv_review', r, 'cv_review');
  r := (SELECT count(*) FROM tasks t
         WHERE t.conversation_id = c1 AND t.title = 'Review CV' AND t.source = 'automation'
           AND t.kind = 'follow_up' AND t.source_ref LIKE 'hr:%' AND t.assigned_to = u_rmem)::text;
  c := c || pg_temp.hr_chk('hr_open candidate did not create one Review CV task for the assignee', r, '1');
  r := pg_temp.hr_as(u_rmem, format('SELECT (public.hr_open(%L, ''employee'')).inbox', c1));
  r := r || '/' || (SELECT count(*) FROM tasks t WHERE t.conversation_id = c1)
         || '/' || (SELECT count(*) FROM hr_stage_history s WHERE s.conversation_id = c1);
  c := c || pg_temp.hr_chk('hr_open is not idempotent (inbox/tasks/history)', r, 'recruiter/1/1');
  r := pg_temp.hr_as(u_dmem, format(
         'SELECT h.inbox || ''/'' || coalesce(h.stage_key, ''-'') || ''/'' || coalesce(h.topic, ''-'') FROM public.hr_open(%L, ''employee'') h', c3));
  r := r || '/' || (SELECT count(*) FROM tasks t WHERE t.conversation_id = c3);
  c := c || pg_temp.hr_chk('hr_open employee: dept, no stage, no topic, no task', r, 'dept/-/-/0');
  -- Backfill: c5 already has messages before it is opened.
  r := pg_temp.hr_as(NULL, format(
         'INSERT INTO public.messages (conversation_id, sender_type, content_text, created_at) VALUES (%L, ''agent'', ''hr-a'', %L), (%L, ''customer'', ''hr-c'', %L)',
         c5, t0 - interval '12 hours', c5, t0 - interval '10 hours'));
  c := c || pg_temp.hr_chk('fixture: messages into c5 were refused', r, 'ok');
  r := pg_temp.hr_as(u_rmem, format('SELECT (public.hr_open(%L, ''candidate'')).reply_state', c5));
  r := r || '/' || (SELECT (h.last_inbound_at = t0 - interval '10 hours'
                            AND h.last_outbound_at = t0 - interval '12 hours')::text
                      FROM hr_conversations h WHERE h.conversation_id = c5);
  c := c || pg_temp.hr_chk('hr_open did not backfill last inbound/outbound from messages', r, 'reply_due/true');

  -- ---------- Visibility unchanged ----------
  r := pg_temp.hr_as(u_blind, format('SELECT (public.hr_open(%L, ''candidate'')).inbox', c1));
  c := c || pg_temp.hr_chk('hr_open on a chat the member cannot see was not NOT_FOUND', r, 'ERROR P0002 NOT_FOUND:%');
  r := pg_temp.hr_as(u_blind, format('SELECT (public.hr_set_stage(%L, ''ai_interview'')).inbox', c1));
  c := c || pg_temp.hr_chk('hr_set_stage on a chat the member cannot see was not NOT_FOUND', r, 'ERROR P0002 NOT_FOUND:%');
  r := pg_temp.hr_as(u_blind, format('SELECT (public.hr_set_flag(%L, ''urgent'', true)).inbox', c1));
  c := c || pg_temp.hr_chk('hr_set_flag on a chat the member cannot see was not NOT_FOUND', r, 'ERROR P0002 NOT_FOUND:%');
  r := pg_temp.hr_as(u_blind, format('SELECT count(*)::text FROM public.hr_conversations WHERE conversation_id = %L', c1))
    || '/' || pg_temp.hr_as(u_blind, format('SELECT count(*)::text FROM public.hr_stage_history WHERE conversation_id = %L', c1))
    || '/' || pg_temp.hr_as(u_rmem, format('SELECT count(*)::text FROM public.hr_conversations WHERE conversation_id = %L', c1));
  c := c || pg_temp.hr_chk('HR rows of a chat the member cannot see are readable (blind rows/history/control)', r, '0/0/1');
  r := pg_temp.hr_as(u_plain, format('SELECT (public.hr_open(%L, ''candidate'')).inbox', c4));
  c := c || pg_temp.hr_chk('hr_open by an agent with no HR role was not NOT_ALLOWED', r, 'ERROR 42501 NOT_ALLOWED:%');
  r := pg_temp.hr_as(u_owner, format('SELECT (public.hr_open(%L, ''candidate'')).inbox', c4));
  c := c || pg_temp.hr_chk('hr_open by an owner was refused', r, 'recruiter');
  r := pg_temp.hr_as(u_plain, format('SELECT (public.hr_set_stage(%L, ''ai_interview'')).inbox', c4))
    || '|' || pg_temp.hr_as(u_plain, format('SELECT (public.hr_set_flag(%L, ''upset'', true)).inbox', c4));
  c := c || pg_temp.hr_chk('writes by an agent with no HR role on a visible chat were not NOT_ALLOWED', r,
                           'ERROR 42501 NOT_ALLOWED:%|ERROR 42501 NOT_ALLOWED:%');

  -- ---------- Stages ----------
  r := pg_temp.hr_as(u_rmem, format('SELECT (public.hr_set_stage(%L, ''hr_interview'')).stage_key', c1));
  c := c || pg_temp.hr_chk('forward stage move by a member was refused', r, 'hr_interview');
  r := pg_temp.hr_as(u_rmem, format('SELECT (public.hr_set_stage(%L, ''hr_interview'')).stage_key', c1));
  r := r || '/' || (SELECT count(*) FROM tasks t WHERE t.conversation_id = c1 AND t.title = 'Schedule HR interview');
  c := c || pg_temp.hr_chk('same-stage retry was not a no-op (stage/task count)', r, 'hr_interview/1');
  r := pg_temp.hr_as(u_rmem, format('SELECT (public.hr_set_stage(%L, ''cv_review'', ''because'')).stage_key', c1));
  c := c || pg_temp.hr_chk('backward move by a recruiter member was not NOT_ALLOWED', r, 'ERROR 42501 NOT_ALLOWED:%');
  r := pg_temp.hr_as(u_rmem, format('SELECT (public.hr_set_stage(%L, ''nope'')).stage_key', c1));
  c := c || pg_temp.hr_chk('unknown stage was not STAGE_UNKNOWN', r, 'ERROR 22023 STAGE_UNKNOWN:%');
  r := pg_temp.hr_as(u_rlead, format('SELECT (public.hr_open(%L, ''candidate'')).stage_key', c2))
    || '/' || pg_temp.hr_as(u_rlead, format('SELECT (public.hr_set_stage(%L, ''manager_interview'')).stage_key', c2));
  c := c || pg_temp.hr_chk('lead open + forward move', r, 'cv_review/manager_interview');
  r := pg_temp.hr_as(u_rlead, format('SELECT (public.hr_set_stage(%L, ''ai_interview'', ''  '')).stage_key', c2));
  c := c || pg_temp.hr_chk('backward move by a lead without a reason was not NEEDS_REASON', r, 'ERROR 22023 NEEDS_REASON:%');
  r := pg_temp.hr_as(u_rlead, format('SELECT (public.hr_set_stage(%L, ''ai_interview'', ''re-test'')).stage_key', c2));
  c := c || pg_temp.hr_chk('backward move by a lead with a reason was refused', r, 'ai_interview');
  r := pg_temp.hr_as(u_rlead, format('SELECT (public.hr_set_stage(%L, ''manager_interview'')).stage_key', c2));
  r := r || '/' || (SELECT count(*) FROM tasks t WHERE t.conversation_id = c2 AND t.title = 'Schedule manager interview');
  c := c || pg_temp.hr_chk('re-entering a stage did not create a new task', r, 'manager_interview/2');
  -- 023b loophole: dept -> recruiter below the furthest stage reached.
  r := pg_temp.hr_as(u_rmem, format('SELECT (public.hr_set_topic(%L, ''other'')).inbox', c1));
  c := c || pg_temp.hr_chk('member could not move a candidate to dept', r, 'dept');
  r := pg_temp.hr_as(u_rmem, format('SELECT (public.hr_set_stage(%L, ''ai_interview'', ''x'')).stage_key', c1));
  c := c || pg_temp.hr_chk('dept -> recruiter below the furthest stage by a member was not NOT_ALLOWED', r, 'ERROR 42501 NOT_ALLOWED:%');
  r := pg_temp.hr_as(u_rmem, format('SELECT (public.hr_set_stage(%L, ''hr_interview'')).inbox', c1));
  c := c || pg_temp.hr_chk('dept -> recruiter at the furthest stage by a member was refused', r, 'recruiter');

  -- ---------- Topics ----------
  r := pg_temp.hr_as(u_dmem, format('SELECT (public.hr_set_topic(%L, ''complaint'')).urgent::text', c3));
  r := r || '/' || (SELECT count(*) FROM tasks t WHERE t.conversation_id = c3 AND t.title = 'Respond to complaint');
  c := c || pg_temp.hr_chk('complaint did not set urgent and one Respond to complaint task', r, 'true/1');
  r := pg_temp.hr_as(u_dmem, format('SELECT (public.hr_set_flag(%L, ''urgent'', false)).urgent::text', c3))
    || '/' || pg_temp.hr_as(u_dmem, format('SELECT (public.hr_set_topic(%L, ''complaint'')).urgent::text', c3));
  r := r || '/' || (SELECT count(*) FROM tasks t WHERE t.conversation_id = c3 AND t.title = 'Respond to complaint');
  c := c || pg_temp.hr_chk('same topic again re-set urgent or added a task', r, 'false/false/1');
  r := pg_temp.hr_as(u_dmem, format('SELECT (public.hr_set_topic(%L, ''payroll'')).topic', c3))
    || '/' || pg_temp.hr_as(u_dmem, format('SELECT (public.hr_set_topic(%L, ''complaint'')).topic', c3))
    || '/' || pg_temp.hr_as(u_dmem, format('SELECT (public.hr_set_topic(%L, ''payroll'')).topic', c3));
  r := r || '/' || (SELECT count(*) FROM tasks t WHERE t.conversation_id = c3 AND t.title = 'Check payroll query');
  c := c || pg_temp.hr_chk('payroll task not exactly once per dept stay', r, 'payroll/complaint/payroll/1');

  -- ---------- Close / reopen ----------
  r := pg_temp.hr_as(u_rlead, format('SELECT (public.hr_close(%L)).outcome', c2));
  c := c || pg_temp.hr_chk('recruiter close without an outcome was not INVALID', r, 'ERROR 22023 INVALID:%');
  r := pg_temp.hr_as(u_rlead, format('SELECT (public.hr_close(%L, ''hired'')).outcome', c2));
  c := c || pg_temp.hr_chk('recruiter close with an outcome was refused', r, 'hired');
  r := pg_temp.hr_as(u_rlead, format('SELECT (public.hr_set_stage(%L, ''cv_review'', ''x'')).stage_key', c2));
  c := c || pg_temp.hr_chk('stage change on a closed chat was not CLOSED', r, 'ERROR 22023 CLOSED:%');
  r := pg_temp.hr_as(u_dmem, format('SELECT (public.hr_close(%L, ''hired'')).outcome', c3));
  c := c || pg_temp.hr_chk('dept close with an outcome was not INVALID', r, 'ERROR 22023 INVALID:%');
  r := pg_temp.hr_as(NULL, format(
         'INSERT INTO public.messages (conversation_id, sender_type, content_text, created_at) VALUES (%L, ''customer'', ''hr-c8'', %L)',
         c8, t0 - interval '10 hours'))
    || '/' || pg_temp.hr_as(u_rmem, format('SELECT (public.hr_open(%L, ''candidate'')).reply_state', c8))
    || '/' || pg_temp.hr_as(u_rmem, format('SELECT (public.hr_close(%L, ''withdrawn'')).outcome', c8));
  c := c || pg_temp.hr_chk('fixture: c8 open + member close', r, 'ok/new/withdrawn');
  r := pg_temp.hr_as(u_rmem, format('SELECT (public.hr_reopen(%L, ''oops'')).inbox', c8));
  c := c || pg_temp.hr_chk('reopen by a member was not NOT_ALLOWED', r, 'ERROR 42501 NOT_ALLOWED:%');
  r := pg_temp.hr_as(u_rlead, format('SELECT (public.hr_reopen(%L, ''  '')).inbox', c2));
  c := c || pg_temp.hr_chk('reopen by a lead without a reason was not NEEDS_REASON', r, 'ERROR 22023 NEEDS_REASON:%');
  r := pg_temp.hr_as(u_rlead, format(
         'SELECT ((h).closed_at IS NULL AND (h).outcome IS NULL)::text FROM (SELECT public.hr_reopen(%L, ''mistake'') AS h) x', c2));
  c := c || pg_temp.hr_chk('reopen by a lead with a reason did not clear closed_at/outcome', r, 'true');

  -- ---------- Messages trigger (c1: no messages yet) ----------
  r := pg_temp.hr_as(NULL, format(
         'INSERT INTO public.messages (conversation_id, sender_type, content_text, created_at) VALUES (%L, ''agent'', ''hr-1'', %L)',
         c1, t0 - interval '3 hours'));
  r := r || '/' || (SELECT h.reply_state FROM hr_conversations h WHERE h.conversation_id = c1);
  c := c || pg_temp.hr_chk('agent message did not make the chat waiting', r, 'ok/waiting');
  r := pg_temp.hr_as(NULL, format(
         'INSERT INTO public.messages (conversation_id, sender_type, content_text, created_at) VALUES (%L, ''customer'', ''hr-2'', %L)',
         c1, t0 - interval '2 hours'));
  r := r || '/' || (SELECT h.reply_state FROM hr_conversations h WHERE h.conversation_id = c1);
  c := c || pg_temp.hr_chk('customer message did not make the chat reply_due', r, 'ok/reply_due');
  r := pg_temp.hr_as(NULL, format(
         'INSERT INTO public.messages (conversation_id, sender_type, content_text, created_at) VALUES (%L, ''bot'', ''hr-3'', %L)',
         c1, t0 - interval '1 hour'));
  r := r || '/' || (SELECT h.reply_state || ':' || (h.last_outbound_at = t0 - interval '3 hours')::text
                      FROM hr_conversations h WHERE h.conversation_id = c1);
  c := c || pg_temp.hr_chk('bot message changed the reply state', r, 'ok/reply_due:true');
  r := pg_temp.hr_as(NULL, format(
         'INSERT INTO public.messages (conversation_id, sender_type, content_text) VALUES (%L, ''customer'', ''hr-6'')', c6));
  r := r || '/' || (SELECT count(*) FROM messages m WHERE m.conversation_id = c6);
  c := c || pg_temp.hr_chk('message into a chat with no HR row failed', r, 'ok/1');

  -- ---------- Sweep ----------
  r := pg_temp.hr_as(NULL, format('SELECT (public.hr_sweep(%L))->>''created''', t0 + interval '5 hours'));
  r := (r NOT LIKE 'ERROR%')::text || '/'
       || (SELECT count(*) FROM tasks t WHERE t.conversation_id = c5 AND t.title = 'Reply to customer');
  c := c || pg_temp.hr_chk('sweep did not create one Reply to customer for a reply_due chat', r, 'true/1');
  r := pg_temp.hr_as(NULL, format('SELECT (public.hr_sweep(%L))->>''created''', t0 + interval '5 hours'));
  r := r || '/' || (SELECT count(*) FROM tasks t WHERE t.conversation_id = c5 AND t.title = 'Reply to customer');
  c := c || pg_temp.hr_chk('second reply_overdue sweep created tasks again', r, '0/1');
  r := (SELECT count(*) FROM tasks t WHERE t.conversation_id = c8 AND t.title = 'Reply to customer')::text;
  c := c || pg_temp.hr_chk('sweep created a task for a closed chat', r, '0');
  r := pg_temp.hr_as(u_rmem, format('SELECT (public.hr_open(%L, ''candidate'')).stage_key', c7))
    || '/' || pg_temp.hr_as(NULL, format(
         'INSERT INTO public.messages (conversation_id, sender_type, content_text, created_at) VALUES (%L, ''agent'', ''hr-7'', %L)',
         c7, t0 - interval '1 hour'));
  r := r || '/' || coalesce((SELECT h.reply_state FROM hr_conversations h WHERE h.conversation_id = c7), '<no row>');
  c := c || pg_temp.hr_chk('fixture: c7 open + agent message', r, 'cv_review/ok/waiting');
  r := pg_temp.hr_as(NULL, format('SELECT (public.hr_sweep(%L))->>''created''', t0 + interval '73 hours'));
  r := (r NOT LIKE 'ERROR%')::text || '/'
       || (SELECT count(*) FROM tasks t WHERE t.conversation_id = c7 AND t.title = 'Chase candidate');
  c := c || pg_temp.hr_chk('sweep did not create one Chase candidate after 73 h waiting', r, 'true/1');
  r := pg_temp.hr_as(NULL, format('SELECT (public.hr_sweep(%L))->>''created''', t0 + interval '73 hours'));
  r := r || '/' || (SELECT count(*) FROM tasks t WHERE t.conversation_id = c7 AND t.title = 'Chase candidate');
  c := c || pg_temp.hr_chk('second no_activity sweep created tasks again', r, '0/1');
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_sweep()::text');
  c := c || pg_temp.hr_chk('authenticated could run hr_sweep', r, 'ERROR 42501 %');

  -- ---------- Rules ----------
  r := pg_temp.hr_as(u_rlead, 'SELECT count(*)::text FROM public.hr_rules_list()');
  c := c || pg_temp.hr_chk('hr_rules_list did not return the 11 rules', r, '11');
  r := pg_temp.hr_as(u_dmem, 'SELECT (public.hr_rule_set(''topic_payroll'', false)).key');
  c := c || pg_temp.hr_chk('hr_rule_set by a dept member was not NOT_ALLOWED', r, 'ERROR 42501 NOT_ALLOWED:%');
  r := pg_temp.hr_as(u_rlead, 'SELECT (public.hr_rule_set(''stage_cv_review'', p_due_hours => 12)).due_hours::text');
  c := c || pg_temp.hr_chk('hr_rule_set by a recruiter lead on a recruiter rule was refused', r, '12');
  r := pg_temp.hr_as(u_rlead, 'SELECT (public.hr_rule_set(''topic_payroll'', false)).key');
  c := c || pg_temp.hr_chk('hr_rule_set by a recruiter lead on a dept rule was not NOT_ALLOWED', r, 'ERROR 42501 NOT_ALLOWED:%');
  r := pg_temp.hr_as(u_owner, 'SELECT (public.hr_rule_set(''reply_overdue_recruiter'', p_after_hours => 0)).key')
    || '|' || pg_temp.hr_as(u_owner, 'SELECT (public.hr_rule_set(''stage_cv_review'', p_due_hours => 721)).key')
    || '|' || pg_temp.hr_as(u_owner, 'SELECT (public.hr_rule_set(''stage_cv_review'', p_title => ''   '')).key');
  c := c || pg_temp.hr_chk('hr_rule_set bounds (after 0 | due 721 | blank title) were not INVALID', r,
                           'ERROR 22023 INVALID:%|ERROR 22023 INVALID:%|ERROR 22023 INVALID:%');
  r := pg_temp.hr_as(u_owner, 'SELECT (public.hr_rule_set(''stage_hr_interview'', false)).enabled::text')
    || '/' || pg_temp.hr_as(u_rmem, format('SELECT (public.hr_set_stage(%L, ''hr_interview'')).stage_key', c7));
  r := r || '/' || (SELECT count(*) FROM tasks t WHERE t.conversation_id = c7 AND t.title = 'Schedule HR interview');
  c := c || pg_temp.hr_chk('a disabled rule still fired', r, 'false/hr_interview/0');

  -- ---------- Privileges ----------
  r := (SELECT coalesce(string_agg(tb || ':' || pv, ','), 'none')
          FROM unnest(ARRAY['hr_conversations', 'hr_team_members', 'hr_stage_history', 'hr_workflow_rules']) tb,
               unnest(ARRAY['INSERT', 'UPDATE', 'DELETE']) pv
         WHERE has_table_privilege('authenticated', 'public.' || tb, pv));
  c := c || pg_temp.hr_chk('authenticated holds write privileges on HR tables', r, 'none');
  r := pg_temp.hr_as(u_owner, format(
         'INSERT INTO public.hr_team_members (account_id, user_id, inbox, role) VALUES (%L, %L, ''dept'', ''lead'')', a_acct, u_owner))
    || '|' || pg_temp.hr_as(u_owner, format('UPDATE public.hr_conversations SET urgent = true WHERE conversation_id = %L', c3))
    || '|' || pg_temp.hr_as(u_owner, format('DELETE FROM public.hr_stage_history WHERE conversation_id = %L', c3))
    || '|' || pg_temp.hr_as(u_owner, format('UPDATE public.hr_workflow_rules SET enabled = false WHERE account_id = %L', a_acct));
  c := c || pg_temp.hr_chk('a direct client write to an HR table was not refused', r,
                           'ERROR 42501 %|ERROR 42501 %|ERROR 42501 %|ERROR 42501 %');
  r := (SELECT coalesce(string_agg(f, ','), 'none')
          FROM unnest(ARRAY['public.hr_fire_rules(uuid, text, text)',
                            'public.hr_apply_rule(public.hr_workflow_rules, uuid, text, timestamptz)',
                            'public.hr_role(uuid, uuid, text)',
                            'public.hr_can_see(uuid)',
                            'public.hr_sweep(timestamptz)']) f
         WHERE has_function_privilege('authenticated', f, 'EXECUTE'));
  c := c || pg_temp.hr_chk('authenticated may execute internal HR functions', r, 'none');

  -- ---------- Cross-account ----------
  r := pg_temp.hr_as(u_out, format('SELECT (public.hr_open(%L, ''candidate'')).inbox', c1))
    || '|' || pg_temp.hr_as(u_out, format('SELECT (public.hr_set_stage(%L, ''manager_interview'')).inbox', c1));
  c := c || pg_temp.hr_chk('an admin of another workspace was not NOT_FOUND', r,
                           'ERROR P0002 NOT_FOUND:%|ERROR P0002 NOT_FOUND:%');

  -- Undo every fixture; `c` survives the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT200', MESSAGE = 'verify-hr-workflows rollback';
  EXCEPTION WHEN SQLSTATE 'ZT200' THEN
    NULL;
  END;

  n := cardinality(c);
  failed := array_remove(c, NULL);
  IF n = 0 THEN
    RAISE EXCEPTION 'HR workflows verification ran no checks';
  END IF;
  IF cardinality(failed) > 0 THEN
    RAISE EXCEPTION 'HR workflows verification: % of % checks failed: %',
      cardinality(failed), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'HR workflows verification passed (% checks)', n;
END
$verify$;
