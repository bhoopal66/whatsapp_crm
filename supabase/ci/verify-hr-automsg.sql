-- Behavioural regression suite for HR automated messages (migration 203).
--
-- A recruiter-inbox stage event queues a templated WhatsApp message in
-- hr_automsg_outbox (only while that trigger is switched on, company
-- chats with a contact only). People configure it through SECURITY
-- DEFINER hr_automsg_* RPCs (lead/admin, settings and templates admin
-- only); the sender runs on the service role: due → claim (daily cap,
-- at most 3 attempts) → mark / settle, plus the stuck-claim review,
-- the 24 h expiry and the reply-overdue nudges. The tables are
-- RLS-forced with no policy and no grant, and the audit log is
-- append-only. This asserts each of those through the real RLS,
-- triggers and RPCs.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000203001';  -- owner of A (admin)
  u_lead  UUID := '00000000-0000-4000-8000-000000203002';  -- agent, recruiter lead
  u_mem   UUID := '00000000-0000-4000-8000-000000203003';  -- agent, recruiter member
  u_plain UUID := '00000000-0000-4000-8000-000000203004';  -- agent, no HR role
  u_out   UUID := '00000000-0000-4000-8000-000000203005';  -- owner of workspace B
  a_acct  UUID;
  a_out   UUID;
  k       UUID[] := '{}';  -- contacts
  c1 UUID; c2 UUID; c3 UUID; c4 UUID; c5 UUID; c6 UUID; c7 UUID; c8 UUID; c9 UUID;
  o1 UUID; o2 UUID; o3 UUID; o4 UUID; o5 UUID; o6 UUID; o7 UUID; o8 UUID; o9 UUID;
  j       JSONB;
  r       TEXT;
  i       INT;
  c       TEXT[] := '{}';  -- one element per check: NULL = passed
  failed  TEXT[];
  n       INT := 0;
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

  -- A raw statement as the table owner: 'ok' or 'ERROR <sqlstate>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.hr_raw(p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    BEGIN
      BEGIN
        EXECUTE p_sql;
        RETURN 'ok';
      EXCEPTION WHEN OTHERS THEN
        RETURN 'ERROR ' || SQLSTATE;
      END;
    END $body$
  $fn$;

  -- ---------- Schema: RLS, policies, privileges, functions ----------
  r := (SELECT count(*) FROM pg_class t
         WHERE t.relnamespace = 'public'::regnamespace
           AND t.relname IN ('hr_automsg_settings', 'hr_automsg_triggers', 'hr_automsg_templates',
                             'hr_automsg_consent', 'hr_automsg_outbox', 'hr_automsg_audit')
           AND t.relrowsecurity AND t.relforcerowsecurity)::text;
  c := c || pg_temp.hr_chk('the six hr_automsg tables are not all RLS enabled + forced', r, '6');
  r := (SELECT count(*) FROM pg_policies p
         WHERE p.schemaname = 'public' AND p.tablename LIKE 'hr\_automsg\_%')::text;
  c := c || pg_temp.hr_chk('an hr_automsg table has a policy', r, '0');
  r := (SELECT count(*)
          FROM unnest(ARRAY['hr_automsg_settings', 'hr_automsg_triggers', 'hr_automsg_templates',
                            'hr_automsg_consent', 'hr_automsg_outbox', 'hr_automsg_audit']) t,
               unnest(ARRAY['anon', 'authenticated', 'service_role']) g,
               unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
         WHERE has_table_privilege(g, 'public.' || t, p))::text;
  c := c || pg_temp.hr_chk('an API role holds a privilege on an hr_automsg table', r, '0');
  r := (SELECT count(*) FROM pg_proc f
         WHERE f.pronamespace = 'public'::regnamespace AND f.proname = 'hr_automsg_due')::text;
  c := c || pg_temp.hr_chk('there is not exactly one hr_automsg_due', r, '1');
  r := (SELECT count(*) FROM unnest(ARRAY[
           'hr_automsg_config()', 'hr_automsg_settings_set(boolean,text,text,text,boolean,integer)',
           'hr_automsg_trigger_set(text,boolean,text,text)',
           'hr_automsg_template_set(text,text,text,text,text,text,text)',
           'hr_automsg_consent_get(uuid,text)', 'hr_automsg_consent_set(uuid,boolean,text,text)',
           'hr_automsg_outbox_list(text,integer)', 'hr_automsg_cancel(uuid)']) f
         WHERE has_function_privilege('authenticated', 'public.' || f, 'EXECUTE')
           AND NOT has_function_privilege('service_role', 'public.' || f, 'EXECUTE')
           AND NOT has_function_privilege('anon', 'public.' || f, 'EXECUTE'))::text;
  c := c || pg_temp.hr_chk('user functions are not authenticated-only', r, '8');
  r := (SELECT count(*) FROM unnest(ARRAY[
           'hr_automsg_due(integer,uuid)', 'hr_automsg_active(uuid)', 'hr_automsg_row_state(uuid)',
           'hr_automsg_claim(uuid,timestamptz)',
           'hr_automsg_mark(uuid,text,text,text,uuid,text,text)',
           'hr_automsg_settle_unconfirmed(uuid,text)', 'hr_automsg_review_stuck(timestamptz)',
           'hr_automsg_expire(timestamptz)', 'hr_automsg_enqueue_nudges(timestamptz)']) f
         WHERE has_function_privilege('service_role', 'public.' || f, 'EXECUTE')
           AND NOT has_function_privilege('authenticated', 'public.' || f, 'EXECUTE')
           AND NOT has_function_privilege('anon', 'public.' || f, 'EXECUTE'))::text;
  c := c || pg_temp.hr_chk('service functions are not service_role-only', r, '9');
  r := (SELECT count(*) FROM unnest(ARRAY[
           'hr_automsg_audit_guard()', 'hr_automsg_default_kind(text)',
           'hr_automsg_settings_of(uuid)', 'hr_automsg_settings_json(uuid)',
           'hr_automsg_sent_today(uuid,uuid,timestamptz)', 'hr_automsg_log(uuid,text,jsonb)',
           'hr_automsg_caller()', 'hr_automsg_on_history()']) f,
               unnest(ARRAY['anon', 'authenticated', 'service_role']) g
         WHERE has_function_privilege(g, 'public.' || f, 'EXECUTE'))::text;
  c := c || pg_temp.hr_chk('an internal hr_automsg helper is executable by an API role', r, '0');

  -- ---------- Fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'am-owner@example.invalid'),
    (u_lead,  'am-lead@example.invalid'),
    (u_mem,   'am-mem@example.invalid'),
    (u_plain, 'am-plain@example.invalid'),
    (u_out,   'am-out@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  SELECT id INTO a_out FROM accounts WHERE owner_user_id = u_out;
  IF a_acct IS NULL OR a_out IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent'
   WHERE user_id IN (u_lead, u_mem, u_plain);

  FOR i IN 1..9 LOOP
    INSERT INTO contacts (account_id, user_id, phone, name)
    VALUES (a_acct, u_owner, '97150203' || lpad(i::text, 4, '0'), 'Cand ' || i)
    RETURNING id INTO c1;
    k := k || c1;
  END LOOP;
  -- c1 main candidate (lead's), c2 trigger off (plain agent's), c3
  -- personal, c4 dept detour, c5 no contact, c6 member's (hidden from
  -- the lead), c7 overdue for a nudge, c8 recently written, c9 cap.
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k[1], u_lead) RETURNING id INTO c1;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k[2], u_plain) RETURNING id INTO c2;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id, personal_owner_id)
  VALUES (a_acct, u_lead, k[3], u_lead, u_lead) RETURNING id INTO c3;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k[4], u_lead) RETURNING id INTO c4;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k[5], u_lead) RETURNING id INTO c5;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k[6], u_mem) RETURNING id INTO c6;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k[7], u_lead) RETURNING id INTO c7;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k[8], u_lead) RETURNING id INTO c8;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k[9], u_lead) RETURNING id INTO c9;

  r := pg_temp.hr_as(u_owner, format('SELECT public.hr_member_set(%L, ''recruiter'', ''lead'')', u_lead))
    || pg_temp.hr_as(u_owner, format('SELECT public.hr_member_set(%L, ''recruiter'', ''member'')', u_mem));
  IF r <> 'okok' THEN RAISE EXCEPTION 'fixture: hr_member_set %', r; END IF;

  -- ---------- Table constraints ----------
  r := pg_temp.hr_raw(format(
         'INSERT INTO hr_automsg_settings (account_id, daily_cap) VALUES (%L, 0)', a_out))
    || '/' || pg_temp.hr_raw(format(
         'INSERT INTO hr_automsg_settings (account_id, daily_cap) VALUES (%L, 21)', a_out));
  c := c || pg_temp.hr_chk('daily_cap outside 1..20 was stored', r, 'ERROR 23514/ERROR 23514');
  r := pg_temp.hr_raw(format(
         'INSERT INTO hr_automsg_triggers (account_id, trigger) VALUES (%L, ''bogus'')', a_out));
  c := c || pg_temp.hr_chk('an unknown trigger was stored', r, 'ERROR 23514');
  r := pg_temp.hr_raw(format(
         'INSERT INTO hr_automsg_templates (account_id, kind, language, body, approval_status)'
         ' VALUES (%L, ''cv_ack'', ''en'', ''x'', ''approved'')', a_out))
    || '/' || pg_temp.hr_raw(format(
         'INSERT INTO hr_automsg_templates (account_id, kind, language, body)'
         ' VALUES (%L, ''cv_ack'', ''fr'', ''x'')', a_out))
    || '/' || pg_temp.hr_raw(format(
         'INSERT INTO hr_automsg_templates (account_id, kind, language, body)'
         ' VALUES (%L, ''bogus'', ''en'', ''x'')', a_out))
    || '/' || pg_temp.hr_raw(format(
         'INSERT INTO hr_automsg_templates (account_id, kind, language, body, category)'
         ' VALUES (%L, ''cv_ack'', ''en'', ''x'', ''promo'')', a_out));
  c := c || pg_temp.hr_chk('templates: approved without a name / bad language / kind / category stored',
                           r, 'ERROR 23514/ERROR 23514/ERROR 23514/ERROR 23514');
  r := pg_temp.hr_raw(format(
         'INSERT INTO hr_automsg_consent (account_id, contact_id, granted, source)'
         ' VALUES (%L, %L, true, ''hearsay'')', a_acct, k[1]));
  c := c || pg_temp.hr_chk('consent with an unknown source was stored', r, 'ERROR 23514');
  r := pg_temp.hr_raw(format(
         'INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind,'
         ' dedupe_key, status) VALUES (%L, %L, %L, ''cv_received'', ''cv_ack'', ''t1'', ''bogus'')',
         a_acct, c1, k[1]))
    || '/' || pg_temp.hr_raw(format(
         'INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind,'
         ' dedupe_key, status) VALUES (%L, %L, %L, ''cv_received'', ''cv_ack'', ''t2'', ''held'')',
         a_acct, c1, k[1]))
    || '/' || pg_temp.hr_raw(format(
         'INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind,'
         ' dedupe_key, hold_reason) VALUES (%L, %L, %L, ''cv_received'', ''cv_ack'', ''t3'', ''quiet_hours'')',
         a_acct, c1, k[1]))
    || '/' || pg_temp.hr_raw(format(
         'INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind,'
         ' dedupe_key, status, hold_reason) VALUES (%L, %L, %L, ''cv_received'', ''cv_ack'', ''t4'','
         ' ''held'', ''bogus'')', a_acct, c1, k[1]));
  c := c || pg_temp.hr_chk('outbox: bad status / held without reason / reason while queued / bad reason stored',
                           r, 'ERROR 23514/ERROR 23514/ERROR 23514/ERROR 23514');
  r := pg_temp.hr_raw(format(
         'INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind,'
         ' dedupe_key, attempts) VALUES (%L, %L, %L, ''cv_received'', ''cv_ack'', ''t5'', 4)',
         a_acct, c1, k[1]))
    || '/' || pg_temp.hr_raw(format(
         'INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind,'
         ' dedupe_key, claim_state) VALUES (%L, %L, %L, ''cv_received'', ''cv_ack'', ''t6'', ''bogus'')',
         a_acct, c1, k[1]));
  c := c || pg_temp.hr_chk('outbox: attempts 4 / unknown claim_state stored', r, 'ERROR 23514/ERROR 23514');
  r := pg_temp.hr_raw(format(
         'INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind,'
         ' dedupe_key) VALUES (%L, %L, %L, ''cv_received'', ''cv_ack'', ''dup'')', a_acct, c1, k[1]))
    || '/' || pg_temp.hr_raw(format(
         'INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind,'
         ' dedupe_key) VALUES (%L, %L, %L, ''cv_received'', ''cv_ack'', ''dup'')', a_acct, c1, k[1]));
  c := c || pg_temp.hr_chk('outbox: a repeated (account, dedupe_key) was stored', r, 'ok/ERROR 23505');
  DELETE FROM hr_automsg_outbox WHERE account_id = a_acct AND dedupe_key = 'dup';

  -- ---------- hr_automsg_config ----------
  r := pg_temp.hr_as(u_mem, 'SELECT public.hr_automsg_config()::text');
  c := c || pg_temp.hr_chk('config as a recruiter member was not NOT_ALLOWED', r, 'ERROR 42501 NOT_ALLOWED:%');
  r := pg_temp.hr_as(u_plain, 'SELECT public.hr_automsg_config()::text');
  c := c || pg_temp.hr_chk('config as a plain agent was not NOT_ALLOWED', r, 'ERROR 42501 NOT_ALLOWED:%');
  r := pg_temp.hr_as(u_lead, 'SELECT public.hr_automsg_config()::text');
  c := c || pg_temp.hr_chk('config as a recruiter lead was refused', r, '{%');
  j := CASE WHEN r LIKE '{%' THEN r::jsonb END;
  r := concat_ws('/', j->>'role', j->'settings'->>'kill_switch', j->'settings'->>'quiet_start',
                 j->'settings'->>'quiet_end', j->'settings'->>'tz',
                 j->'settings'->>'requires_consent', j->'settings'->>'daily_cap');
  c := c || pg_temp.hr_chk('config role / default settings', r, 'lead/true/21:00%/08:00%/Asia/Dubai/true/3');
  r := (SELECT count(*) FROM jsonb_array_elements(j->'triggers') e
         WHERE e->>'enabled' = 'false'
           AND (e->>'trigger', e->>'template_kind') IN (
             ('cv_received', 'cv_ack'), ('stage_ai_interview', 'ai_interview_invite'),
             ('stage_hr_interview', 'hr_interview_invite'),
             ('stage_manager_interview', 'manager_interview_invite'),
             ('interview_reminder', 'interview_reminder'), ('reply_overdue_nudge', 'reply_nudge')))::text
    || '/' || coalesce(jsonb_array_length(j->'triggers'), -1)
    || '/' || coalesce(jsonb_array_length(j->'templates'), -1);
  c := c || pg_temp.hr_chk('config does not list six disabled triggers with their default kinds and no templates',
                           r, '6/6/0');

  -- ---------- hr_automsg_settings_set ----------
  r := pg_temp.hr_as(u_lead, 'SELECT public.hr_automsg_settings_set(false, NULL, NULL, NULL, NULL, NULL)::text');
  c := c || pg_temp.hr_chk('settings_set as a lead was not NOT_ALLOWED', r, 'ERROR 42501 NOT_ALLOWED:%');
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_settings_set(NULL, ''25:00'', NULL, NULL, NULL, NULL)::text');
  c := c || pg_temp.hr_chk('settings_set quiet_start 25:00 was not INVALID', r, 'ERROR % INVALID:%');
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_settings_set(NULL, NULL, ''8am'', NULL, NULL, NULL)::text');
  c := c || pg_temp.hr_chk('settings_set quiet_end 8am was not INVALID', r, 'ERROR % INVALID:%');
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_settings_set(NULL, NULL, NULL, ''Mars/Olympus'', NULL, NULL)::text');
  c := c || pg_temp.hr_chk('settings_set unknown tz was not INVALID', r, 'ERROR % INVALID:%');
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_settings_set(NULL, NULL, NULL, NULL, NULL, 0)::text')
    || '/' || pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_settings_set(NULL, NULL, NULL, NULL, NULL, 21)::text');
  c := c || pg_temp.hr_chk('settings_set cap 0 / 21 was not LIMIT', r, 'ERROR % LIMIT:%/ERROR % LIMIT:%');
  r := (SELECT count(*) FROM hr_automsg_settings s WHERE s.account_id = a_acct)::text;
  c := c || pg_temp.hr_chk('a refused settings_set stored a row', r, '0');
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_settings_set(false, NULL, NULL, NULL, NULL, NULL)::text');
  c := c || pg_temp.hr_chk('settings_set by the owner was refused', r, '{%');
  r := (SELECT concat_ws('/', s.kill_switch, s.quiet_start, s.quiet_end, s.tz, s.requires_consent, s.daily_cap)
          FROM hr_automsg_settings s WHERE s.account_id = a_acct);
  c := c || pg_temp.hr_chk('settings_set with NULLs did not keep the defaults', r, 'f/21:00:00/08:00:00/Asia/Dubai/t/3');
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_settings_set(NULL, ''22:30'', ''07:15'', ''Europe/London'', false, 5)::text');
  r := r || '/' || (SELECT concat_ws('/', s.kill_switch, s.quiet_start, s.quiet_end, s.tz, s.requires_consent, s.daily_cap)
                      FROM hr_automsg_settings s WHERE s.account_id = a_acct);
  c := c || pg_temp.hr_chk('settings_set did not store every given value', r, '{%}/f/22:30:00/07:15:00/Europe/London/f/5');
  r := (SELECT count(*) FROM hr_automsg_audit a WHERE a.account_id = a_acct AND a.actor = u_owner
           AND a.action LIKE '%settings%')::text;
  c := c || pg_temp.hr_chk('settings_set wrote no audit row per change', r, '2');
  PERFORM pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_settings_set(NULL, NULL, NULL, ''Asia/Dubai'', NULL, 3)::text');

  -- ---------- hr_automsg_trigger_set ----------
  r := pg_temp.hr_as(u_mem, 'SELECT public.hr_automsg_trigger_set(''cv_received'', true)::text');
  c := c || pg_temp.hr_chk('trigger_set as a member was not NOT_ALLOWED', r, 'ERROR 42501 NOT_ALLOWED:%');
  r := pg_temp.hr_as(u_lead, 'SELECT public.hr_automsg_trigger_set(''bogus'', true)::text');
  c := c || pg_temp.hr_chk('trigger_set unknown trigger was not NOT_FOUND', r, 'ERROR P0002 NOT_FOUND:%');
  r := pg_temp.hr_as(u_lead, 'SELECT public.hr_automsg_trigger_set(''cv_received'', NULL)::text');
  c := c || pg_temp.hr_chk('trigger_set enabled NULL was not INVALID', r, 'ERROR % INVALID:%');
  r := pg_temp.hr_as(u_lead, 'SELECT public.hr_automsg_trigger_set(''cv_received'', true, ''bogus'')::text');
  c := c || pg_temp.hr_chk('trigger_set unknown kind was not INVALID', r, 'ERROR % INVALID:%');
  r := (SELECT count(*) FROM hr_automsg_triggers t WHERE t.account_id = a_acct)::text;
  c := c || pg_temp.hr_chk('a refused trigger_set stored a row', r, '0');

  -- ---------- Enqueue trigger: off → nothing ----------
  r := pg_temp.hr_as(u_owner, format('SELECT (public.hr_open(%L, ''candidate'')).stage_key', c2))
    || pg_temp.hr_as(u_owner, format('SELECT (public.hr_open(%L, ''candidate'')).stage_key', c4))
    || pg_temp.hr_as(u_owner, format('SELECT (public.hr_open(%L, ''candidate'')).stage_key', c6));
  IF r <> 'cv_reviewcv_reviewcv_review' THEN RAISE EXCEPTION 'fixture: hr_open %', r; END IF;
  r := (SELECT count(*) FROM hr_automsg_outbox o WHERE o.account_id = a_acct)::text;
  c := c || pg_temp.hr_chk('cv_received switched off still queued a row', r, '0');

  r := pg_temp.hr_as(u_lead, 'SELECT public.hr_automsg_trigger_set(''cv_received'', true)::text')
    || '/' || pg_temp.hr_as(u_lead, 'SELECT public.hr_automsg_trigger_set(''stage_ai_interview'', true, ''hr_interview_invite'')::text')
    || '/' || pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_trigger_set(''stage_manager_interview'', true)::text');
  c := c || pg_temp.hr_chk('trigger_set by a lead / admin was refused', r, '{%}/{%}/{%}');
  r := (SELECT string_agg(t.trigger || ':' || t.enabled || ':' || coalesce(t.template_kind, '-'), ',' ORDER BY t.trigger)
          FROM hr_automsg_triggers t WHERE t.account_id = a_acct);
  c := c || pg_temp.hr_chk('trigger_set rows', r,
                           'cv_received:true:-,stage_ai_interview:true:hr_interview_invite,stage_manager_interview:true:-');
  r := (SELECT count(*) FROM hr_automsg_audit a WHERE a.account_id = a_acct AND a.action LIKE '%trigger%')::text;
  c := c || pg_temp.hr_chk('trigger_set wrote no audit row per change', r, '3');

  -- ---------- Enqueue trigger: on ----------
  r := pg_temp.hr_as(u_lead, format('SELECT (public.hr_open(%L, ''candidate'')).stage_key', c1));
  IF r <> 'cv_review' THEN RAISE EXCEPTION 'fixture: hr_open c1 %', r; END IF;
  r := (SELECT string_agg(concat_ws('/', o.trigger, o.template_kind, o.status, o.language, o.contact_id = k[1],
                                    o.dedupe_key = 'hist:' || h.id, o.attempts, o.hold_reason IS NULL), ',')
          FROM hr_automsg_outbox o
          JOIN hr_stage_history h ON h.conversation_id = o.conversation_id AND h.event = 'open'
         WHERE o.conversation_id = c1);
  c := c || pg_temp.hr_chk('open with cv_received on did not queue one cv_ack row', r,
                           'cv_received/cv_ack/queued/en/t/t/0/t');
  SELECT o.id INTO o1 FROM hr_automsg_outbox o WHERE o.conversation_id = c1;

  r := pg_temp.hr_as(u_owner, format('SELECT (public.hr_open(%L, ''candidate'')).stage_key', c3));
  r := r || '/' || (SELECT count(*) FROM hr_automsg_outbox o WHERE o.conversation_id = c3);
  c := c || pg_temp.hr_chk('a personal chat queued a row', r, 'cv_review/0');
  r := pg_temp.hr_as(u_owner, format('SELECT (public.hr_open(%L, ''employee'')).inbox', c8));
  r := r || '/' || (SELECT count(*) FROM hr_automsg_outbox o WHERE o.conversation_id = c8);
  c := c || pg_temp.hr_chk('a dept open queued a row', r, 'dept/0');

  r := pg_temp.hr_as(u_lead, format('SELECT (public.hr_set_stage(%L, ''ai_interview'', ''ok'')).stage_key', c1));
  r := r || '/' || (SELECT string_agg(o.template_kind || ':' || (o.dedupe_key LIKE 'hist:%'), ',')
                      FROM hr_automsg_outbox o WHERE o.conversation_id = c1 AND o.trigger = 'stage_ai_interview');
  c := c || pg_temp.hr_chk('stage ai_interview did not queue one row with the configured kind', r,
                           'ai_interview/hr_interview_invite:true');
  r := pg_temp.hr_as(u_lead, format('SELECT (public.hr_set_stage(%L, ''hr_interview'', ''ok'')).stage_key', c1));
  r := r || '/' || (SELECT count(*) FROM hr_automsg_outbox o WHERE o.conversation_id = c1);
  c := c || pg_temp.hr_chk('stage hr_interview (trigger off) queued a row', r, 'hr_interview/2');
  r := pg_temp.hr_as(u_lead, format('SELECT (public.hr_set_stage(%L, ''manager_interview'', ''ok'')).stage_key', c1));
  r := r || '/' || (SELECT string_agg(o.template_kind, ',') FROM hr_automsg_outbox o
                     WHERE o.conversation_id = c1 AND o.trigger = 'stage_manager_interview');
  c := c || pg_temp.hr_chk('stage manager_interview did not queue the default kind', r,
                           'manager_interview/manager_interview_invite');

  -- c4: recruiter → dept (a move out) queues nothing; dept → recruiter
  -- at ai_interview (a 'move' event) queues the stage message.
  r := pg_temp.hr_as(u_lead, format('SELECT (public.hr_set_topic(%L, ''onboarding'')).inbox', c4));
  r := r || '/' || (SELECT count(*) FROM hr_automsg_outbox o WHERE o.conversation_id = c4);
  c := c || pg_temp.hr_chk('a move into the dept inbox queued a row', r, 'dept/0');
  r := pg_temp.hr_as(u_owner, format('SELECT (public.hr_set_stage(%L, ''ai_interview'', ''back'')).stage_key', c4));
  r := r || '/' || (SELECT string_agg(o.trigger, ',') FROM hr_automsg_outbox o WHERE o.conversation_id = c4)
    || '/' || (SELECT string_agg(h.event, ',' ORDER BY h.id) FROM hr_stage_history h WHERE h.conversation_id = c4);
  c := c || pg_temp.hr_chk('a move into recruiter at ai_interview did not queue the stage row', r,
                           'ai_interview/stage_ai_interview/%move');

  -- ---------- hr_automsg_template_set ----------
  r := pg_temp.hr_as(u_lead, 'SELECT public.hr_automsg_template_set(''cv_ack'', ''en'', ''Hi'', '''', ''draft'')::text');
  c := c || pg_temp.hr_chk('template_set as a lead was not NOT_ALLOWED', r, 'ERROR 42501 NOT_ALLOWED:%');
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_template_set(''cv_ack'', ''en'', ''Hi {other}'', '''', ''draft'')::text');
  c := c || pg_temp.hr_chk('template_set {other} was not INVALID', r, 'ERROR % INVALID:%');
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_template_set(''cv_ack'', ''en'', ''Hi {name'', '''', ''draft'')::text');
  c := c || pg_temp.hr_chk('template_set unbalanced { was not INVALID', r, 'ERROR % INVALID:%');
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_template_set(''cv_ack'', ''en'', ''Hi name}'', '''', ''draft'')::text');
  c := c || pg_temp.hr_chk('template_set stray } was not INVALID', r, 'ERROR % INVALID:%');
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_template_set(''cv_ack'', ''en'', ''Hi {{name}}'', '''', ''draft'')::text');
  c := c || pg_temp.hr_chk('template_set {{name}} was not INVALID', r, 'ERROR % INVALID:%');
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_template_set(''cv_ack'', ''en'', E''Hi\x07there'', '''', ''draft'')::text')
    || '/' || pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_template_set(''cv_ack'', ''en'', E''Hi\tthere'', '''', ''draft'')::text');
  c := c || pg_temp.hr_chk('template_set with a control char (bell / tab) was not INVALID', r, 'ERROR % INVALID:%/ERROR % INVALID:%');
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_template_set(''cv_ack'', ''en'', ''Hi'', ''hr_cv'', ''draft'', ''marketing'')::text');
  c := c || pg_temp.hr_chk('template_set category marketing was not INVALID', r, 'ERROR % INVALID:%');
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_template_set(''cv_ack'', ''en'', ''Hi'', '''', ''approved'')::text');
  c := c || pg_temp.hr_chk('template_set approved without a name was not INVALID', r, 'ERROR % INVALID:%');
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_template_set(''cv_ack'', ''en'', ''Hi'', ''Bad-Name'', ''approved'')::text');
  c := c || pg_temp.hr_chk('template_set approved with a bad name was not INVALID', r, 'ERROR % INVALID:%');
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_template_set(''cv_ack'', ''en'', '''', '''', ''draft'')::text')
    || '/' || pg_temp.hr_as(u_owner, format('SELECT public.hr_automsg_template_set(''cv_ack'', ''en'', %L, '''', ''draft'')::text', repeat('a', 1025)));
  c := c || pg_temp.hr_chk('template_set empty / 1025-char body was not INVALID', r, 'ERROR % INVALID:%/ERROR % INVALID:%');
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_template_set(''bogus'', ''en'', ''Hi'', '''', ''draft'')::text')
    || '/' || pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_template_set(''cv_ack'', ''fr'', ''Hi'', '''', ''draft'')::text');
  c := c || pg_temp.hr_chk('template_set unknown kind / language was not refused', r, 'ERROR %/ERROR %');
  r := (SELECT count(*) FROM hr_automsg_templates t WHERE t.account_id = a_acct)::text;
  c := c || pg_temp.hr_chk('a refused template_set stored a row', r, '0');
  r := pg_temp.hr_as(u_owner, format('SELECT public.hr_automsg_template_set(''cv_ack'', ''en'', %L, ''hr_cv_ack'', ''approved'')::text',
                                     E'Hi {name},\nwe got your CV. Slot: {slot}'));
  c := c || pg_temp.hr_chk('template_set with {name} {slot} and a newline was refused', r, '{%');
  r := (SELECT concat_ws('/', t.meta_template_name, t.approval_status, t.category, t.body LIKE '%{slot}')
          FROM hr_automsg_templates t WHERE t.account_id = a_acct AND t.kind = 'cv_ack' AND t.language = 'en');
  c := c || pg_temp.hr_chk('template_set stored row', r, 'hr_cv_ack/approved/utility/t');
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_template_set(''cv_ack'', ''ar'', ''مرحبا {name}'', '''', ''draft'', ''utility'')::text');
  c := c || pg_temp.hr_chk('template_set ar draft was refused', r, '{%');
  r := (SELECT count(*) FROM hr_automsg_audit a WHERE a.account_id = a_acct AND a.action LIKE '%template%')::text;
  c := c || pg_temp.hr_chk('template_set wrote no audit row per change', r, '2');
  r := pg_temp.hr_as(u_lead, 'SELECT jsonb_array_length(public.hr_automsg_config()->''templates'')::text')
    || '/' || pg_temp.hr_as(u_lead, 'SELECT (SELECT e->>''template_kind'' FROM jsonb_array_elements(public.hr_automsg_config()->''triggers'') e WHERE e->>''trigger'' = ''stage_ai_interview'')');
  c := c || pg_temp.hr_chk('config after writes (templates / configured kind)', r, '2/hr_interview_invite');

  -- ---------- Consent ----------
  r := pg_temp.hr_as(u_plain, format('SELECT (public.hr_automsg_consent_get(%L)).granted::text', c2));
  c := c || pg_temp.hr_chk('consent_get by an agent with no HR role was not NOT_ALLOWED', r, 'ERROR 42501 NOT_ALLOWED:%');
  r := pg_temp.hr_as(u_lead, format('SELECT (public.hr_automsg_consent_get(%L)).granted::text', c6));
  c := c || pg_temp.hr_chk('consent_get on a chat the lead cannot see was not NOT_FOUND', r, 'ERROR P0002 NOT_FOUND:%');
  r := pg_temp.hr_as(u_lead, format('SELECT (public.hr_automsg_consent_get(%L)).granted::text', c7));
  c := c || pg_temp.hr_chk('consent_get on a chat without an HR row was not NOT_FOUND', r, 'ERROR P0002 NOT_FOUND:%');
  r := pg_temp.hr_as(u_lead, format('SELECT concat_ws(''/'', coalesce(g.granted::text, ''-''), g.opted_out, g.personal) FROM public.hr_automsg_consent_get(%L) g', c1));
  c := c || pg_temp.hr_chk('consent_get with nothing noted', r, '-/f/f');
  r := pg_temp.hr_as(u_lead, format('SELECT concat_ws(''/'', g.granted, g.source, g.opted_out, g.personal, g.noted_at IS NOT NULL) FROM public.hr_automsg_consent_set(%L, true) g', c1));
  c := c || pg_temp.hr_chk('consent_set by the lead', r, 't/recruiter_confirmed/f/f/t');
  r := (SELECT concat_ws('/', g.contact_id = k[1], g.granted, g.noted_by = u_lead)
          FROM hr_automsg_consent g WHERE g.account_id = a_acct);
  c := c || pg_temp.hr_chk('consent_set did not store the chat''s own contact', r, 't/t/t');
  r := pg_temp.hr_as(u_lead, format('SELECT (public.hr_automsg_consent_set(%L, true, ''hearsay'')).granted::text', c1));
  c := c || pg_temp.hr_chk('consent_set unknown source was not INVALID', r, 'ERROR % INVALID:%');
  r := pg_temp.hr_as(u_lead, format('SELECT (public.hr_automsg_consent_set(%L, true)).granted::text', c5));
  c := c || pg_temp.hr_chk('consent_set on a chat without an HR row was not NOT_FOUND', r, 'ERROR P0002 NOT_FOUND:%');
  r := pg_temp.hr_as(u_mem, format('SELECT (public.hr_automsg_consent_set(%L, false, ''candidate_wrote'')).source', c6));
  c := c || pg_temp.hr_chk('consent_set by a member on a visible chat', r, 'candidate_wrote');
  r := pg_temp.hr_as(u_owner, format('SELECT (public.hr_automsg_consent_get(%L)).personal::text', c3));
  c := c || pg_temp.hr_chk('consent_get did not flag a personal chat', r, 'true');
  r := (SELECT count(*) FROM hr_automsg_audit a WHERE a.account_id = a_acct AND a.action LIKE '%consent%')::text;
  c := c || pg_temp.hr_chk('consent_set wrote no audit row per change', r, '2');

  -- ---------- Outbox list and cancel ----------
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind, dedupe_key, created_at)
  VALUES (a_acct, c6, k[6], 'cv_received', 'cv_ack', 'v:hidden', now() - interval '1 minute') RETURNING id INTO o6;
  r := pg_temp.hr_as(u_mem, 'SELECT count(*)::text FROM public.hr_automsg_outbox_list()');
  c := c || pg_temp.hr_chk('outbox_list as a member was not NOT_ALLOWED', r, 'ERROR 42501 NOT_ALLOWED:%');
  r := pg_temp.hr_as(u_lead, 'SELECT count(*)::text FROM public.hr_automsg_outbox_list(''bogus'')');
  c := c || pg_temp.hr_chk('outbox_list bad status was not INVALID', r, 'ERROR % INVALID:%');
  r := pg_temp.hr_as(u_lead, format('SELECT count(*) FILTER (WHERE l.conversation_id = %L)::text || ''/'' || count(*)'
                                    ' FROM public.hr_automsg_outbox_list() l', c6));
  c := c || pg_temp.hr_chk('outbox_list showed the lead a chat they cannot see', r, '0/4');
  r := pg_temp.hr_as(u_owner, format('SELECT count(*) FILTER (WHERE l.conversation_id = %L)::text FROM public.hr_automsg_outbox_list() l', c6));
  c := c || pg_temp.hr_chk('outbox_list hid a row from the admin', r, '1');
  r := pg_temp.hr_as(u_lead, 'SELECT count(*)::text FROM public.hr_automsg_outbox_list(''queued'', 0)')
    || '/' || pg_temp.hr_as(u_lead, 'SELECT count(*)::text FROM public.hr_automsg_outbox_list(''sent'')');
  c := c || pg_temp.hr_chk('outbox_list limit 0 not clamped to 1 / status filter', r, '1/0');
  UPDATE hr_automsg_outbox o SET created_at = now() - interval '2 hours' WHERE o.id = o1;
  r :=pg_temp.hr_as(u_lead, 'SELECT x.contact_name || '':'' || (x.id = ' || quote_literal(o1) || ')::text'
                              || ' FROM public.hr_automsg_outbox_list() x OFFSET 3 LIMIT 1');
  c := c || pg_temp.hr_chk('outbox_list not newest first (oldest row last) or no contact_name', r, 'Cand 1:true');

  r := pg_temp.hr_as(u_lead, format('SELECT public.hr_automsg_cancel(%L)', o6));
  c := c || pg_temp.hr_chk('cancel of a row the lead cannot see was not NOT_FOUND', r, 'ERROR P0002 NOT_FOUND:%');
  r := pg_temp.hr_as(u_mem, format('SELECT public.hr_automsg_cancel(%L)', o6));
  c := c || pg_temp.hr_chk('cancel by a member was not NOT_ALLOWED', r, 'ERROR 42501 NOT_ALLOWED:%');
  r := pg_temp.hr_as(u_owner, format('SELECT public.hr_automsg_cancel(%L)', o6));
  r := r || '/' || (SELECT o.status FROM hr_automsg_outbox o WHERE o.id = o6);
  r := r || '/' || pg_temp.hr_as(u_owner, format('SELECT public.hr_automsg_cancel(%L)', o6));
  c := c || pg_temp.hr_chk('cancel queued → cancelled, then ALREADY_DECIDED', r, 'ok/cancelled/ERROR % ALREADY_DECIDED:%');
  r := (SELECT count(*) FROM hr_automsg_audit a WHERE a.account_id = a_acct AND a.action LIKE '%cancel%')::text;
  c := c || pg_temp.hr_chk('cancel wrote no audit row', r, '1');

  -- ---------- Service-role surface ----------
  r := pg_temp.hr_as(u_owner, 'SELECT count(*)::text FROM public.hr_automsg_due()');
  c := c || pg_temp.hr_chk('hr_automsg_due was callable by a user', r, 'ERROR 42501 %');
  r := pg_temp.hr_as(NULL, 'SELECT count(*)::text FROM public.hr_automsg_config()');
  c := c || pg_temp.hr_chk('hr_automsg_config was callable by the service role', r, 'ERROR 42501 %');

  -- claim sends only for an open recruiter chat. c9 is opened in HR;
  -- c8 sits in the dept inbox, so o7/o8 (k8's rows) move to a fresh
  -- recruiter chat of a fresh contact. The cv_received rows the opens
  -- queue are dropped.
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971502038888', 'Cand 8b')
  RETURNING id INTO o9;
  k[8] := o9;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k[8], u_lead) RETURNING id INTO c8;
  r := pg_temp.hr_as(u_lead, format('SELECT (public.hr_open(%L, ''candidate'')).stage_key', c8))
    || pg_temp.hr_as(u_lead, format('SELECT (public.hr_open(%L, ''candidate'')).stage_key', c9));
  IF r <> 'cv_reviewcv_review' THEN RAISE EXCEPTION 'fixture: hr_open c8/c9 %', r; END IF;
  DELETE FROM hr_automsg_outbox o WHERE o.conversation_id IN (c8, c9);
  -- Extra rows: o2 cap candidate (k1), o3 attempts exhausted, o4 for
  -- mark-failed, o5 settle, o7 stuck review, o8 expiry, o9 workspace B.
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind, dedupe_key, created_at)
  VALUES (a_acct, c1, k[1], 'interview_reminder', 'interview_reminder', 'v:cap', now() - interval '50 minutes') RETURNING id INTO o2;
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind, dedupe_key, attempts, status, created_at)
  VALUES (a_acct, c9, k[9], 'interview_reminder', 'interview_reminder', 'v:spent', 3, 'failed', now() - interval '3 hours') RETURNING id INTO o3;
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind, dedupe_key, created_at)
  VALUES (a_acct, c9, k[9], 'interview_reminder', 'interview_reminder', 'v:fail', now() - interval '40 minutes') RETURNING id INTO o4;
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind, dedupe_key, created_at)
  VALUES (a_acct, c9, k[9], 'interview_reminder', 'interview_reminder', 'v:settle', now() - interval '30 minutes') RETURNING id INTO o5;
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind, dedupe_key, created_at)
  VALUES (a_acct, c8, k[8], 'interview_reminder', 'interview_reminder', 'v:stuck', now() - interval '20 minutes') RETURNING id INTO o7;
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind, dedupe_key, created_at)
  VALUES (a_acct, c8, k[8], 'interview_reminder', 'interview_reminder', 'v:expire', now() - interval '23 hours') RETURNING id INTO o8;
  INSERT INTO contacts (account_id, user_id, phone) VALUES (a_out, u_out, '971502039999') RETURNING id INTO c9;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_out, u_out, c9) RETURNING id INTO c5;
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind, dedupe_key, created_at)
  VALUES (a_out, c5, c9, 'cv_received', 'cv_ack', 'v:other', now() - interval '25 minutes') RETURNING id INTO o9;

  -- The rows above are claimable only while their trigger is on.
  PERFORM pg_temp.hr_as(u_lead, 'SELECT public.hr_automsg_trigger_set(''interview_reminder'', true)::text');
  r := pg_temp.hr_as(NULL, format('SELECT string_agg(d.id::text, '','') FROM public.hr_automsg_due(100, %L) d', a_out));
  c := c || pg_temp.hr_chk('due with an account filter returned other rows', r, o9::text);
  r := pg_temp.hr_as(NULL, format('SELECT (count(*) FILTER (WHERE d.id = %L))::text || ''/'' || (count(*) FILTER (WHERE d.id = %L))'
                                  ' || ''/'' || (count(*) FILTER (WHERE d.id IN (%L, %L)))'
                                  ' || ''/'' || (count(*) FILTER (WHERE d.id = %L))'
                                  ' FROM public.hr_automsg_due(500) d', o3, o6, o1, o2, o9));
  c := c || pg_temp.hr_chk('due: attempts-3 row / cancelled row excluded, queued rows and other accounts included', r, '0/0/2/1');
  r :=pg_temp.hr_as(NULL, format('SELECT string_agg(d.id::text, '','') FROM (SELECT x.id FROM public.hr_automsg_due(2, %L) x) d', a_acct));
  c := c || pg_temp.hr_chk('due not oldest first or limit ignored', r, o8 || ',' || o1);

  r := pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_row_state(%L)::text', gen_random_uuid()));
  c := c || pg_temp.hr_chk('row_state of a missing row was not NULL', r, 'ok');
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_row_state(%L)::text', o1));
  j := CASE WHEN r LIKE '{%' THEN r::jsonb END;
  r := (SELECT string_agg(key, ',' ORDER BY key) FROM jsonb_object_keys(j) key);
  c := c || pg_temp.hr_chk('row_state keys', r,
                           'channel,closed,consent,contact_name,inbox,last_inbound_at,opted_out,personal,row,sent_today,settings,stale,template,trigger_enabled');
  r := concat_ws('/', j->'row'->>'id' = o1::text, j->>'closed', j->>'inbox', j->>'personal', j->>'opted_out',
                 j->>'contact_name', j->>'trigger_enabled', j->>'sent_today', j->'template'->>'meta_template_name',
                 j->'settings'->>'daily_cap', j->>'consent');
  c := c || pg_temp.hr_chk('row_state values', r, 't/false/recruiter/false/false/Cand 1/true/0/hr_cv_ack/3/true');

  -- due order: queued first, then failed, then held (each oldest first),
  -- so many held rows cannot starve new ones. o8 (the oldest) held and
  -- o5 failed for the check, then put back.
  UPDATE hr_automsg_outbox SET status = 'held', hold_reason = 'quiet_hours' WHERE id = o8;
  UPDATE hr_automsg_outbox SET status = 'failed' WHERE id = o5;
  r := pg_temp.hr_as(NULL, format('SELECT (string_agg(d.status, '','' ORDER BY d.ordinality) ~ ''^(queued,)+failed,held$'')::text'
                                  ' FROM public.hr_automsg_due(500, %L) WITH ORDINALITY d', a_acct));
  c := c || pg_temp.hr_chk('due: queued rows not before failed, failed not before held', r, 'true');
  UPDATE hr_automsg_outbox SET status = 'queued', hold_reason = NULL WHERE id IN (o5, o8);

  -- claim re-checks the guards under its lock: each failure is 'lost'
  -- and leaves the row untouched (kill switch on, trigger off, chat
  -- closed, contact opted out, consent
  -- withdrawn while settings require it).
  r := pg_temp.hr_raw(format('UPDATE hr_automsg_settings SET kill_switch = true WHERE account_id = %L', a_acct))
    || ':' || pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_claim(%L, now())', o1));
  PERFORM pg_temp.hr_raw(format('UPDATE hr_automsg_settings SET kill_switch = false WHERE account_id = %L', a_acct));
  r := r || '/' || pg_temp.hr_raw(format('UPDATE hr_automsg_triggers t SET enabled = false FROM hr_automsg_outbox o'
                                         ' WHERE o.id = %L AND t.account_id = o.account_id AND t.trigger = o.trigger', o1))
    || ':' || pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_claim(%L, now())', o1));
  PERFORM pg_temp.hr_raw(format('UPDATE hr_automsg_triggers t SET enabled = true FROM hr_automsg_outbox o'
                                ' WHERE o.id = %L AND t.account_id = o.account_id AND t.trigger = o.trigger', o1));
  r := r || '/' || pg_temp.hr_raw(format('UPDATE hr_conversations SET closed_at = now() WHERE conversation_id = %L', c1))
    || ':' || pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_claim(%L, now())', o1));
  PERFORM pg_temp.hr_raw(format('UPDATE hr_conversations SET closed_at = NULL WHERE conversation_id = %L', c1));
  r := r || '/' || pg_temp.hr_raw(format('UPDATE contacts SET opted_out_at = now() WHERE id = %L', k[1]))
    || ':' || pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_claim(%L, now())', o1));
  PERFORM pg_temp.hr_raw(format('UPDATE contacts SET opted_out_at = NULL WHERE id = %L', k[1]));
  r := r || '/' || pg_temp.hr_raw(format('UPDATE hr_automsg_consent SET granted = false WHERE account_id = %L AND contact_id = %L', a_acct, k[1])) || pg_temp.hr_raw(format('UPDATE hr_automsg_settings SET requires_consent = true WHERE account_id = %L', a_acct))
    || ':' || pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_claim(%L, now())', o1));
  PERFORM pg_temp.hr_raw(format('UPDATE hr_automsg_consent SET granted = true WHERE account_id = %L AND contact_id = %L', a_acct, k[1]));
  PERFORM pg_temp.hr_raw(format('UPDATE hr_automsg_settings SET requires_consent = false WHERE account_id = %L', a_acct));
  r := r || '/' || (SELECT concat_ws('/', o.status, o.attempts, coalesce(o.claim_state, '-')) FROM hr_automsg_outbox o WHERE o.id = o1);
  c := c || pg_temp.hr_chk('claim did not re-check kill switch / trigger / closed / opt-out / consent (lost, row untouched)', r,
                           'ok:lost/ok:lost/ok:lost/ok:lost/okok:lost/queued/0/-');

  -- claim / capped / lost
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_claim(%L, now())', o1))
    || '/' || pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_claim(%L, now())', o1));
  c := c || pg_temp.hr_chk('two claims on one row were not claimed then lost', r, 'claimed/lost');
  r := (SELECT concat_ws('/', o.status, o.claim_state, o.attempts, o.claimed_at IS NOT NULL) FROM hr_automsg_outbox o WHERE o.id = o1);
  c := c || pg_temp.hr_chk('a claimed row', r, 'queued/sending/1/t');
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_claim(%L, now())', gen_random_uuid()))
    || '/' || pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_claim(%L, now())', o3))
    || '/' || pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_claim(%L, now())', o6));
  c := c || pg_temp.hr_chk('claim of a missing / attempts-3 / cancelled row was not lost', r, 'lost/lost/lost');
  r := (SELECT concat_ws('/', o.status, o.attempts, coalesce(o.claim_state, '-')) FROM hr_automsg_outbox o WHERE o.id = o3);
  c := c || pg_temp.hr_chk('a lost claim changed the attempts-3 row', r, 'failed/3/-');
  r := pg_temp.hr_as(NULL, format('SELECT count(*)::text FROM public.hr_automsg_due(500, %L) d WHERE d.id = %L', a_acct, o1));
  c := c || pg_temp.hr_chk('due listed a claimed row', r, '0');

  -- mark
  r := pg_temp.hr_as(NULL, format('SELECT (public.hr_automsg_mark(%L, ''sent'', NULL, ''wamid.1'', NULL, NULL, ''Hi Cand 1'')).status', o1));
  r := r || '/' || (SELECT concat_ws('/', o.sent_at IS NOT NULL, coalesce(o.claim_state, '-'), o.provider_message_id, o.body_rendered)
                      FROM hr_automsg_outbox o WHERE o.id = o1);
  c := c || pg_temp.hr_chk('mark sending → sent', r, 'sent/t/-/wamid.1/Hi Cand 1');
  r := pg_temp.hr_as(NULL, format('SELECT (public.hr_automsg_mark(%L, ''failed'', NULL, NULL, NULL, ''late'')).status', o1));
  c := c || pg_temp.hr_chk('mark on a sent row was not ALREADY_DECIDED', r, 'ERROR % ALREADY_DECIDED:%');
  r := pg_temp.hr_as(u_owner, format('SELECT public.hr_automsg_cancel(%L)', o1));
  c := c || pg_temp.hr_chk('cancel of a sent row was not ALREADY_DECIDED', r, 'ERROR % ALREADY_DECIDED:%');

  -- cap: k1 already has one sent today; cap 1 → the next claim is capped.
  PERFORM pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_settings_set(NULL, NULL, NULL, NULL, NULL, 1)::text');
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_claim(%L, now())', o2));
  r := r || '/' || (SELECT concat_ws('/', o.status, o.hold_reason, o.attempts, coalesce(o.claim_state, '-'))
                      FROM hr_automsg_outbox o WHERE o.id = o2);
  c := c || pg_temp.hr_chk('claim over the daily cap was not capped → held daily_cap', r, 'capped/held/daily_cap/0/-');
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_claim(%L, now())', o4));
  c := c || pg_temp.hr_chk('the cap of one contact held another contact', r, 'claimed');
  PERFORM pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_settings_set(NULL, NULL, NULL, NULL, NULL, 3)::text');

  r := pg_temp.hr_as(NULL, format('SELECT (public.hr_automsg_mark(%L, ''failed'', NULL, NULL, NULL, %L)).status', o4, repeat('e', 900)));
  r := r || '/' || (SELECT concat_ws('/', char_length(o.last_error), coalesce(o.claim_state, '-'), o.attempts) FROM hr_automsg_outbox o WHERE o.id = o4);
  c := c || pg_temp.hr_chk('mark sending → failed (error clipped to 500, claim cleared)', r, 'failed/500/-/1');
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_claim(%L, now())', o4));
  r := r || '/' || (SELECT o.attempts FROM hr_automsg_outbox o WHERE o.id = o4);
  c := c || pg_temp.hr_chk('a failed row was not claimable again', r, 'claimed/2');
  r := pg_temp.hr_as(NULL, format('SELECT (public.hr_automsg_mark(%L, ''held'', ''quiet_hours'')).status', o4));
  c := c || pg_temp.hr_chk('mark held on a sending row was not ALREADY_DECIDED', r, 'ERROR % ALREADY_DECIDED:%');
  r := pg_temp.hr_as(NULL, format('SELECT (public.hr_automsg_mark(%L, ''held'')).status', o2));
  c := c || pg_temp.hr_chk('mark held without a reason was not INVALID', r, 'ERROR % INVALID:%');
  r := pg_temp.hr_as(NULL, format('SELECT (public.hr_automsg_mark(%L, ''held'', ''bogus'')).status', o2))
    || '/' || pg_temp.hr_as(NULL, format('SELECT (public.hr_automsg_mark(%L, ''bogus'')).status', o2));
  c := c || pg_temp.hr_chk('mark unknown reason / status was not INVALID', r, 'ERROR % INVALID:%/ERROR % INVALID:%');
  r := pg_temp.hr_as(NULL, format('SELECT (public.hr_automsg_mark(%L, ''held'', ''quiet_hours'')).hold_reason', o2));
  c := c || pg_temp.hr_chk('mark releasable → held with a reason', r, 'quiet_hours');
  r := pg_temp.hr_as(NULL, format('SELECT (public.hr_automsg_mark(%L, ''cancelled'')).status', o2));
  r := r || '/' || (SELECT coalesce(o.hold_reason, '-') FROM hr_automsg_outbox o WHERE o.id = o2);
  c := c || pg_temp.hr_chk('mark releasable → cancelled (reason cleared)', r, 'cancelled/-');
  r := pg_temp.hr_as(NULL, format('SELECT (public.hr_automsg_mark(%L, ''sent'')).status', o2));
  c := c || pg_temp.hr_chk('mark sent on a never-claimed row was not ALREADY_DECIDED', r, 'ERROR % ALREADY_DECIDED:%');
  r := pg_temp.hr_as(NULL, format('SELECT (public.hr_automsg_mark(%L, ''sent'')).status', gen_random_uuid()));
  c := c || pg_temp.hr_chk('mark on a missing row was not NOT_FOUND', r, 'ERROR P0002 NOT_FOUND:%');

  -- settle_unconfirmed
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_claim(%L, now())', o5))
    || '/' || pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_settle_unconfirmed(%L, ''wamid.5'')', o5));
  r := r || '/' || (SELECT concat_ws('/', o.status, o.claim_state, o.provider_message_id, o.sent_at IS NOT NULL)
                      FROM hr_automsg_outbox o WHERE o.id = o5);
  c := c || pg_temp.hr_chk('settle_unconfirmed sending → sent + unconfirmed', r, 'claimed/ok/sent/unconfirmed/wamid.5/t');
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_settle_unconfirmed(%L, ''wamid.x'')', o6));
  r := r || '/' || (SELECT concat_ws('/', o.status, coalesce(o.provider_message_id, '-')) FROM hr_automsg_outbox o WHERE o.id = o6);
  c := c || pg_temp.hr_chk('settle_unconfirmed on a non-sending row was not a no-op', r, 'ok/cancelled/-');

  -- review_stuck
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_claim(%L, now())', o7));
  UPDATE hr_automsg_outbox o SET claimed_at = now() - interval '14 minutes' WHERE o.claim_state = 'sending';
  r := r || '/' || pg_temp.hr_as(NULL, 'SELECT public.hr_automsg_review_stuck(now())::text');
  UPDATE hr_automsg_outbox o SET claimed_at = now() - interval '16 minutes' WHERE o.id = o7;
  r := r || '/' || pg_temp.hr_as(NULL, 'SELECT public.hr_automsg_review_stuck(now())::text');
  r := r || '/' || (SELECT concat_ws('/', o.status, o.claim_state) FROM hr_automsg_outbox o WHERE o.id = o7)
    || '/' || (SELECT o.claim_state FROM hr_automsg_outbox o WHERE o.id = o4);
  c := c || pg_temp.hr_chk('review_stuck at 14 / 16 minutes', r, 'claimed/0/1/queued/needs_review/sending');
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_claim(%L, now())', o7))
    || '/' || pg_temp.hr_as(u_owner, format('SELECT public.hr_automsg_cancel(%L)', o7));
  c := c || pg_temp.hr_chk('a needs_review row was claimable or cancellable', r, 'lost/ERROR % ALREADY_DECIDED:%');

  -- sent + sending + needs_review all count toward the cap (k8: o7 needs_review).
  PERFORM pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_settings_set(NULL, NULL, NULL, NULL, NULL, 1)::text');
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_claim(%L, now())', o8));
  c := c || pg_temp.hr_chk('a needs_review row did not count toward the daily cap', r, 'capped');
  PERFORM pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_settings_set(NULL, NULL, NULL, NULL, NULL, 3)::text');

  -- expire (o8 is held now: still releasable)
  r := pg_temp.hr_as(NULL, 'SELECT public.hr_automsg_expire(now())::text');
  UPDATE hr_automsg_outbox o SET created_at = now() - interval '25 hours' WHERE o.id = o8;
  r := r || '/' || pg_temp.hr_as(NULL, 'SELECT public.hr_automsg_expire(now())::text');
  r := r || '/' || (SELECT o.status FROM hr_automsg_outbox o WHERE o.id = o8);
  c := c || pg_temp.hr_chk('expire at 23 / 25 hours', r, '0/1/cancelled');

  -- ---------- Nudges ----------
  r := pg_temp.hr_as(u_lead, format('SELECT (public.hr_open(%L, ''candidate'')).stage_key', c7));
  IF r <> 'cv_review' THEN RAISE EXCEPTION 'fixture: hr_open c7 %', r; END IF;
  DELETE FROM hr_automsg_outbox o WHERE o.conversation_id = c7;
  UPDATE hr_conversations h SET last_outbound_at = now() - interval '100 hours', last_inbound_at = now() - interval '120 hours'
   WHERE h.conversation_id = c7;
  UPDATE hr_conversations h SET last_outbound_at = now() - interval '10 hours', last_inbound_at = NULL
   WHERE h.conversation_id = c1;
  UPDATE hr_conversations h SET last_outbound_at = now() - interval '100 hours', last_inbound_at = now() - interval '1 hour'
   WHERE h.conversation_id = c4;
  UPDATE hr_conversations h SET last_outbound_at = now() - interval '100 hours' WHERE h.conversation_id IN (c3, c5);
  r := (SELECT string_agg(h.reply_state, ',' ORDER BY h.conversation_id = c7 DESC) FROM hr_conversations h WHERE h.conversation_id IN (c7, c4));
  IF r <> 'waiting,reply_due' THEN RAISE EXCEPTION 'fixture: reply states %', r; END IF;
  r := pg_temp.hr_as(NULL, 'SELECT public.hr_automsg_enqueue_nudges(now())::text');
  c := c || pg_temp.hr_chk('nudges queued with reply_overdue_nudge off', r, '0');
  PERFORM pg_temp.hr_as(u_lead, 'SELECT public.hr_automsg_trigger_set(''reply_overdue_nudge'', true)::text');
  -- Switched on just now: c7 went quiet 100 h before that, so no nudge.
  r := pg_temp.hr_as(NULL, 'SELECT public.hr_automsg_enqueue_nudges(now())::text');
  -- Switched on 30 days ago, but c7's waiting period began 8 days ago:
  -- older than 7 days, so no nudge either.
  UPDATE hr_automsg_triggers SET updated_at = now() - interval '30 days'
   WHERE account_id = a_acct AND trigger = 'reply_overdue_nudge';
  UPDATE hr_conversations h SET last_outbound_at = now() - interval '8 days', last_inbound_at = now() - interval '9 days'
   WHERE h.conversation_id = c7;
  r := r || '/' || pg_temp.hr_as(NULL, 'SELECT public.hr_automsg_enqueue_nudges(now())::text');
  c := c || pg_temp.hr_chk('nudge queued for a waiting period from before the switch-on or older than 7 days', r, '0/0');
  UPDATE hr_automsg_triggers SET updated_at = now() - interval '120 hours'
   WHERE account_id = a_acct AND trigger = 'reply_overdue_nudge';
  UPDATE hr_conversations h SET last_outbound_at = now() - interval '100 hours', last_inbound_at = now() - interval '120 hours'
   WHERE h.conversation_id = c7;
  r := pg_temp.hr_as(NULL, 'SELECT public.hr_automsg_enqueue_nudges(now())::text');
  r := r || '/' || (SELECT string_agg(concat_ws('/', o.trigger, o.template_kind, o.status, o.dedupe_key LIKE 'nudge:' || c7 || ':%'), ',')
                 FROM hr_automsg_outbox o WHERE o.account_id = a_acct AND o.trigger = 'reply_overdue_nudge');
  c := c || pg_temp.hr_chk('nudges: one row for the waiting chat only', r, '1/reply_overdue_nudge/reply_nudge/queued/t');
  r := pg_temp.hr_as(NULL, 'SELECT public.hr_automsg_enqueue_nudges(now())::text');
  c := c || pg_temp.hr_chk('a second nudge pass queued again', r, '0');

  -- ---------- active ----------
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_active(%L)::text', a_out));
  PERFORM pg_temp.hr_as(u_out, 'SELECT public.hr_automsg_trigger_set(''interview_reminder'', true)::text');
  r := r || '/' || pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_active(%L)::text', a_out))
    || '/' || pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_active(%L)::text', a_acct));
  c := c || pg_temp.hr_chk('hr_automsg_active false → true', r, 'false/true/true');

  -- ---------- Audit is append-only ----------
  r := pg_temp.hr_raw(format('UPDATE hr_automsg_audit SET action = ''x'' WHERE account_id = %L', a_acct))
    || '/' || pg_temp.hr_raw(format('DELETE FROM hr_automsg_audit WHERE account_id = %L', a_acct));
  c := c || pg_temp.hr_chk('an audit row was updated or deleted', r, 'ERROR %/ERROR %');

  RAISE EXCEPTION 'verify-hr-automsg rollback' USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN
    NULL;
  END;

  n := cardinality(c);
  SELECT array_agg(x) INTO failed FROM unnest(c) x WHERE x IS NOT NULL;
  IF failed IS NOT NULL THEN
    RAISE EXCEPTION 'verify-hr-automsg: % of % checks failed: %', cardinality(failed), n,
      array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'verify-hr-automsg: all % checks passed', n;
END
$verify$;
