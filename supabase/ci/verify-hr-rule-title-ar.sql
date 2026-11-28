-- Behavioural regression suite for migration 335 (Arabic task titles
-- for HR workflow rules).
--
-- A seeded task rule carries its Arabic title, a flag rule none; the task
-- a rule creates snapshots it as meta.hr_title_ar (one row, English
-- title kept); hr_rule_set sets, clears and bounds it; one hr_rule_set
-- overload, so a named call that leaves p_title_ar out is not ambiguous.
-- Without 335 every check below fails (no title_ar column, no
-- p_title_ar parameter). ONE statement on purpose, rolled back on
-- success (see verify-hr-automsg-rcs.sql).

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000335001';
  u_lead  UUID := '00000000-0000-4000-8000-000000335002';
  a_acct  UUID;
  k1 UUID;
  v1 UUID;
  r       TEXT;
  c       TEXT[] := '{}';
  failed  TEXT[];
  n       INT := 0;
BEGIN
  BEGIN
  -- Run a statement as a signed-in user (p_uid) or, with p_uid NULL, as
  -- the migration role itself: the value / 'ok', or
  -- 'ERROR <sqlstate> <hint>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.hr_as(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; st text; h text; m text;
    BEGIN
      BEGIN
        IF p_uid IS NOT NULL THEN
          PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
          PERFORM set_config('request.jwt.claims',
            json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
          SET LOCAL ROLE authenticated;
        END IF;
        EXECUTE p_sql INTO v;
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

  -- ---------- Fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'hr335-owner@example.invalid'),
    (u_lead,  'hr335-lead@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  IF a_acct IS NULL THEN RAISE EXCEPTION 'fixture: no account'; END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_lead;
  INSERT INTO contacts (account_id, user_id, phone) VALUES (a_acct, u_owner, '971503350001') RETURNING id INTO k1;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k1, u_lead) RETURNING id INTO v1;
  r := pg_temp.hr_as(u_owner, format('SELECT public.hr_member_set(%L, ''recruiter'', ''lead'')', u_lead))
    || pg_temp.hr_as(u_owner, 'SELECT count(*)::text FROM public.hr_rules_list()');
  IF r LIKE '%ERROR%' THEN RAISE EXCEPTION 'fixture: %', r; END IF;

  -- ---------- 1. Seeded Arabic titles ----------
  r := pg_temp.hr_as(NULL, format(
         'SELECT string_agg(w.key || ''='' || coalesce(w.title_ar, ''-''), '','' ORDER BY w.key)
            FROM hr_workflow_rules w
           WHERE w.account_id = %L AND w.key IN (''stage_cv_review'', ''topic_complaint_flag'', ''reply_overdue_dept'')',
         a_acct));
  c := c || pg_temp.hr_chk('the seeded rules do not carry their Arabic titles', r,
    'reply_overdue_dept=الرد على العميل,stage_cv_review=مراجعة السيرة الذاتية,topic_complaint_flag=-');

  -- ---------- 2. The task snapshots the Arabic title ----------
  r := pg_temp.hr_as(u_lead, format('SELECT (public.hr_open(%L, ''candidate'')).stage_key', v1));
  c := c || pg_temp.hr_chk('fixture: hr_open', r, 'cv_review');
  r := pg_temp.hr_as(NULL, format(
         'SELECT count(*) || ''/'' || min(t.title) || ''/'' || min(t.meta->>''hr_title_ar'') || ''/'' || min(t.meta->>''hr_rule'')
            FROM tasks t WHERE t.conversation_id = %L', v1));
  c := c || pg_temp.hr_chk('the Review CV task did not snapshot its Arabic title (one row, English title)', r,
    '1/Review CV/مراجعة السيرة الذاتية/stage_cv_review');

  -- ---------- 3. hr_rule_set sets the Arabic title ----------
  r := pg_temp.hr_as(u_lead,
         'SELECT (public.hr_rule_set(p_key => ''stage_ai_interview'', p_title_ar => ''  أرسل الرابط  '')).title_ar');
  c := c || pg_temp.hr_chk('hr_rule_set did not set (and trim) the Arabic title', r, 'أرسل الرابط');
  r := pg_temp.hr_as(NULL, format(
         'SELECT w.title || ''/'' || w.title_ar FROM hr_workflow_rules w
           WHERE w.account_id = %L AND w.key = ''stage_ai_interview''', a_acct));
  c := c || pg_temp.hr_chk('the Arabic title was not stored, or the English one changed', r,
    'Send AI interview link/أرسل الرابط');
  r := pg_temp.hr_as(u_lead, format('SELECT (public.hr_set_stage(%L, ''ai_interview'', ''ok'')).stage_key', v1));
  c := c || pg_temp.hr_chk('fixture: stage ai_interview', r, 'ai_interview');
  r := pg_temp.hr_as(NULL, format(
         'SELECT t.meta->>''hr_title_ar'' FROM tasks t
           WHERE t.conversation_id = %L AND t.meta->>''hr_rule'' = ''stage_ai_interview''', v1));
  c := c || pg_temp.hr_chk('a new task did not snapshot the edited Arabic title', r, 'أرسل الرابط');

  -- ---------- 4. A blank Arabic title clears it ----------
  r := pg_temp.hr_as(u_lead,
         'SELECT coalesce((public.hr_rule_set(p_key => ''stage_hr_interview'', p_title_ar => E'' \t'')).title_ar, ''<cleared>'')');
  c := c || pg_temp.hr_chk('a blank Arabic title did not clear it', r, '<cleared>');
  r := pg_temp.hr_as(NULL, format(
         'SELECT coalesce(w.title_ar, ''<null>'') FROM hr_workflow_rules w
           WHERE w.account_id = %L AND w.key = ''stage_hr_interview''', a_acct));
  c := c || pg_temp.hr_chk('the cleared Arabic title was not stored as NULL', r, '<null>');
  r := pg_temp.hr_as(u_lead, format('SELECT (public.hr_set_stage(%L, ''hr_interview'', ''ok'')).stage_key', v1));
  c := c || pg_temp.hr_chk('fixture: stage hr_interview', r, 'hr_interview');
  r := pg_temp.hr_as(NULL, format(
         'SELECT count(*) || ''/'' || bool_or(t.meta ? ''hr_title_ar'') FROM tasks t
           WHERE t.conversation_id = %L AND t.meta->>''hr_rule'' = ''stage_hr_interview''', v1));
  c := c || pg_temp.hr_chk('a rule with no Arabic title put hr_title_ar on its task', r, '1/false');

  -- ---------- 5. Bounds ----------
  r := pg_temp.hr_as(u_owner,
         'SELECT (public.hr_rule_set(p_key => ''topic_complaint_flag'', p_title_ar => ''عاجل'')).key');
  c := c || pg_temp.hr_chk('an Arabic title on a flag rule was not INVALID', r, 'ERROR 22023 INVALID:%');
  r := pg_temp.hr_as(u_lead, format(
         'SELECT (public.hr_rule_set(p_key => ''stage_cv_review'', p_title_ar => %L)).key', repeat('ع', 301)));
  c := c || pg_temp.hr_chk('a 301-character Arabic title was not INVALID', r, 'ERROR 22023 INVALID:%');
  r := pg_temp.hr_as(NULL, format(
         'SELECT w.title_ar FROM hr_workflow_rules w WHERE w.account_id = %L AND w.key = ''stage_cv_review''', a_acct));
  c := c || pg_temp.hr_chk('a refused Arabic title changed the rule', r, 'مراجعة السيرة الذاتية');

  -- ---------- 6. One overload; old-style named call still works ----------
  r := (SELECT count(*) FROM pg_proc p
         WHERE p.proname = 'hr_rule_set' AND p.pronamespace = 'public'::regnamespace)::text;
  c := c || pg_temp.hr_chk('hr_rule_set has more than one overload', r, '1');
  r := pg_temp.hr_as(u_lead,
         'SELECT (public.hr_rule_set(p_key => ''stage_cv_review'', p_due_hours => 12)).title_ar');
  c := c || pg_temp.hr_chk('a named call without p_title_ar failed or dropped the Arabic title', r, 'مراجعة السيرة الذاتية');
  r := concat_ws('/',
    has_function_privilege('authenticated',
      to_regprocedure('public.hr_rule_set(text,boolean,integer,integer,text,text)'), 'EXECUTE'),
    has_function_privilege('anon',
      to_regprocedure('public.hr_rule_set(text,boolean,integer,integer,text,text)'), 'EXECUTE'));
  c := c || pg_temp.hr_chk('hr_rule_set grants are not authenticated-only', r, 'true/false');

  RAISE EXCEPTION 'verify-hr-rule-title-ar rollback' USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN
    NULL;
  END;

  n := cardinality(c);
  SELECT array_agg(x) INTO failed FROM unnest(c) x WHERE x IS NOT NULL;
  IF failed IS NOT NULL THEN
    RAISE EXCEPTION 'verify-hr-rule-title-ar: % of % checks failed: %', cardinality(failed), n,
      array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'verify-hr-rule-title-ar: all % checks passed', n;
END
$verify$;
