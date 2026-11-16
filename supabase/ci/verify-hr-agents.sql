-- Behavioural regression suite for the recruiter AI agent drafts (migration 202).
--
-- The agents never send: they park a draft (hr_agent_drafts) on a
-- recruiter-inbox chat for a person to approve or reject, and an admin or
-- recruiter lead switches each agent kind on (hr_agent_settings). Both
-- tables are read through RLS (a recruiter role in the caller's active
-- account, and for drafts also hr_can_see on the chat) and written only
-- by SECURITY DEFINER functions: two for the signed-in user, five for the
-- service role (context, create, flag urgent, supersede, expire). This
-- asserts each refusal by its HINT, the reads for every kind of caller,
-- the idempotent source, the 3-pending limit, what supersede / expire
-- leave NULL, the guard that freezes a draft's identity, the
-- ai_usage_log 'hr_agent' mode and the grants.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000202001';  -- owner of A (admin)
  u_rlead  UUID := '00000000-0000-4000-8000-000000202002';  -- agent, recruiter lead
  u_rmem   UUID := '00000000-0000-4000-8000-000000202003';  -- agent, recruiter member, assigned c1
  u_plain  UUID := '00000000-0000-4000-8000-000000202005';  -- agent, no HR role, assigned c6
  u_blind  UUID := '00000000-0000-4000-8000-000000202006';  -- agent, recruiter member, sees no chat
  u_out    UUID := '00000000-0000-4000-8000-000000202008';  -- owner of workspace B
  a_acct   UUID;
  a_out    UUID;
  k        UUID[] := '{}';  -- contacts
  c1 UUID; c2 UUID; c3 UUID; c4 UUID; c5 UUID; c6 UUID; c7 UUID;
  m1 UUID := gen_random_uuid();
  m2 UUID := gen_random_uuid();
  m3 UUID := gen_random_uuid();
  m4 UUID := gen_random_uuid();
  m5 UUID := gen_random_uuid();
  m6 UUID := gen_random_uuid();
  m7 UUID := gen_random_uuid();
  d1 UUID; d2 UUID; d3 UUID; d4 UUID; d6 UUID; d7 UUID;
  r        TEXT;
  r2       TEXT;
  i        INT;
  c        TEXT[] := '{}';  -- one element per check: NULL = passed
  failed   TEXT[];
  n        INT := 0;
  create_fmt TEXT := 'SELECT public.hr_agent_draft_create(%L, %L, %L, %L, %L, %L, %L, %L, %L, %L)';
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

  -- Run one statement as the table owner: 'ok' or 'ERROR <sqlstate>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.hr_try(p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    BEGIN
      EXECUTE p_sql;
      RETURN 'ok';
    EXCEPTION WHEN OTHERS THEN
      RETURN 'ERROR ' || SQLSTATE;
    END $body$
  $fn$;

  -- Fixture: workspace A (u_owner's) and B (u_out's). The auth.users
  -- trigger provisions each person an account of their own; everyone
  -- but the two owners moves into A.
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'a202v-owner@example.invalid'),
    (u_rlead, 'a202v-rlead@example.invalid'),
    (u_rmem,  'a202v-rmem@example.invalid'),
    (u_plain, 'a202v-plain@example.invalid'),
    (u_blind, 'a202v-blind@example.invalid'),
    (u_out,   'a202v-out@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  SELECT id INTO a_out FROM accounts WHERE owner_user_id = u_out;
  IF a_acct IS NULL OR a_out IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent'
   WHERE user_id IN (u_rlead, u_rmem, u_plain, u_blind);

  FOR i IN 1..7 LOOP
    INSERT INTO contacts (account_id, user_id, phone)
    VALUES (a_acct, u_owner, '97150220' || lpad(i::text, 4, '0'))
    RETURNING id INTO c1;
    k := k || c1;
  END LOOP;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k[1], u_rmem) RETURNING id INTO c1;   -- candidate, the main chat
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k[2], u_rmem) RETURNING id INTO c2;   -- employee (dept inbox)
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k[3], u_rmem) RETURNING id INTO c3;   -- candidate, closed
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k[4], u_rmem) RETURNING id INTO c4;   -- candidate, opted out
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k[5], u_rmem) RETURNING id INTO c5;   -- candidate, other contact
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k[6], u_plain) RETURNING id INTO c6;  -- candidate, plain agent's own
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k[7], u_rmem) RETURNING id INTO c7;   -- never opened by HR

  r := pg_temp.hr_as(u_owner, format('SELECT public.hr_member_set(%L, ''recruiter'', ''lead'')', u_rlead))
    || pg_temp.hr_as(u_owner, format('SELECT public.hr_member_set(%L, ''recruiter'', ''member'')', u_rmem))
    || pg_temp.hr_as(u_owner, format('SELECT public.hr_member_set(%L, ''recruiter'', ''member'')', u_blind));
  c := c || pg_temp.hr_chk('fixture: recruiter members', r, 'okokok');
  r := pg_temp.hr_as(u_owner, format('SELECT (public.hr_open(%L, ''candidate'')).inbox', c1))
    || pg_temp.hr_as(u_owner, format('SELECT (public.hr_open(%L, ''employee'')).inbox', c2))
    || pg_temp.hr_as(u_owner, format('SELECT (public.hr_open(%L, ''candidate'')).inbox', c3))
    || pg_temp.hr_as(u_owner, format('SELECT (public.hr_open(%L, ''candidate'')).inbox', c4))
    || pg_temp.hr_as(u_owner, format('SELECT (public.hr_open(%L, ''candidate'')).inbox', c5))
    || pg_temp.hr_as(u_owner, format('SELECT (public.hr_open(%L, ''candidate'')).inbox', c6));
  c := c || pg_temp.hr_chk('fixture: hr_open', r, 'recruiterdeptrecruiterrecruiterrecruiterrecruiter');
  UPDATE hr_conversations SET closed_at = now() WHERE conversation_id = c3;
  UPDATE contacts SET opted_out_at = now() WHERE id = k[4];
  r := (SELECT count(*) FROM contacts WHERE id = k[4] AND opted_out_at IS NOT NULL)::text
    || '/' || (SELECT count(*) FROM hr_conversations WHERE conversation_id = c3 AND closed_at IS NOT NULL);
  c := c || pg_temp.hr_chk('fixture: closed chat and opted-out contact', r, '1/1');

  -- ---------- Settings: hr_agent_settings_set ----------
  r := pg_temp.hr_as(u_owner, 'SELECT (public.hr_agent_settings_set(''orchestrator'', true)).enabled');
  c := c || pg_temp.hr_chk('settings_set by an admin was refused', r, 'true');
  r := pg_temp.hr_as(u_rlead, 'SELECT (public.hr_agent_settings_set(''cv_screening'', true)).enabled');
  c := c || pg_temp.hr_chk('settings_set by a recruiter lead was refused', r, 'true');
  r := pg_temp.hr_as(u_rlead, 'SELECT (public.hr_agent_settings_set(''cv_screening'', false)).enabled');
  c := c || pg_temp.hr_chk('settings_set did not update an existing kind', r, 'false');
  r := (SELECT count(*) FROM hr_agent_settings WHERE account_id = a_acct AND agent_kind = 'cv_screening')::text
    || '/' || (SELECT count(*) FROM hr_agent_settings WHERE account_id = a_acct AND updated_by = u_rlead);
  c := c || pg_temp.hr_chk('settings_set made a second row for one kind, or lost updated_by', r, '1/1');
  r := pg_temp.hr_as(u_rmem, 'SELECT (public.hr_agent_settings_set(''orchestrator'', false)).enabled');
  c := c || pg_temp.hr_chk('settings_set by a recruiter member was not NOT_ALLOWED', r, 'ERROR 42501 NOT_ALLOWED:%');
  r := pg_temp.hr_as(u_plain, 'SELECT (public.hr_agent_settings_set(''orchestrator'', false)).enabled');
  c := c || pg_temp.hr_chk('settings_set by an agent with no HR role was not NOT_ALLOWED', r, 'ERROR 42501 NOT_ALLOWED:%');
  r := pg_temp.hr_as(u_owner, 'SELECT (public.hr_agent_settings_set(''nope'', true)).enabled');
  c := c || pg_temp.hr_chk('settings_set with an unknown kind was not INVALID', r, 'ERROR 22023 INVALID:%');
  r := pg_temp.hr_as(u_owner, 'SELECT (public.hr_agent_settings_set(NULL, true)).enabled');
  c := c || pg_temp.hr_chk('settings_set with a NULL kind was not INVALID', r, 'ERROR 22023 INVALID:%');
  r := pg_temp.hr_as(u_owner, 'SELECT (public.hr_agent_settings_set(''scheduling'', NULL)).enabled');
  c := c || pg_temp.hr_chk('settings_set with a NULL enabled was not INVALID', r, 'ERROR 22023 INVALID:%');
  r2 := pg_temp.hr_as(NULL, 'SELECT public.hr_agent_settings_set(''scheduling'', true)::text');
  c := c || pg_temp.hr_chk('settings_set is callable by the service role', r2, 'ERROR 42501 %');

  -- ---------- Create: refusals ----------
  r := pg_temp.hr_as(NULL, format(create_fmt, c7, NULL, 'candidate_faq', 'other', 'x', 'en', false, NULL, NULL, NULL));
  c := c || pg_temp.hr_chk('create on a chat HR does not track was not NOT_FOUND', r, 'ERROR P0002 NOT_FOUND:%');
  r := pg_temp.hr_as(NULL, format(create_fmt, gen_random_uuid(), NULL, 'candidate_faq', 'other', 'x', 'en', false, NULL, NULL, NULL));
  c := c || pg_temp.hr_chk('create on an unknown chat was not NOT_FOUND', r, 'ERROR P0002 NOT_FOUND:%');
  r := pg_temp.hr_as(NULL, format(create_fmt, c2, NULL, 'candidate_faq', 'other', 'x', 'en', false, NULL, NULL, NULL));
  c := c || pg_temp.hr_chk('create on a dept-inbox chat was not INVALID', r, 'ERROR 22023 INVALID:%');
  r := pg_temp.hr_as(NULL, format(create_fmt, c3, NULL, 'candidate_faq', 'other', 'x', 'en', false, NULL, NULL, NULL));
  c := c || pg_temp.hr_chk('create on a closed chat was not CLOSED', r, 'ERROR 22023 CLOSED:%');
  r := pg_temp.hr_as(NULL, format(create_fmt, c4, NULL, 'candidate_faq', 'other', 'x', 'en', false, NULL, NULL, NULL));
  c := c || pg_temp.hr_chk('create for an opted-out contact was not OPTED_OUT', r, 'ERROR 22023 OPTED_OUT:%');
  r := pg_temp.hr_as(NULL, format(create_fmt, c1, NULL, 'bogus', 'other', 'x', 'en', false, NULL, NULL, NULL));
  c := c || pg_temp.hr_chk('create with an unknown kind was not INVALID', r, 'ERROR 22023 INVALID:%');
  r := pg_temp.hr_as(NULL, format(create_fmt, c1, NULL, 'candidate_faq', 'bogus', 'x', 'en', false, NULL, NULL, NULL));
  c := c || pg_temp.hr_chk('create with an unknown intent was not INVALID', r, 'ERROR 22023 INVALID:%');
  r := pg_temp.hr_as(NULL, format(create_fmt, c1, NULL, 'candidate_faq', 'other', 'x', 'fr', false, NULL, NULL, NULL));
  c := c || pg_temp.hr_chk('create with lang fr was not INVALID', r, 'ERROR 22023 INVALID:%');
  r := pg_temp.hr_as(NULL, format(create_fmt, c1, NULL, 'candidate_faq', 'other', 'x', 'en', false, 'bogus', NULL, NULL));
  c := c || pg_temp.hr_chk('create with an unknown handoff reason was not INVALID', r, 'ERROR 22023 INVALID:%');
  r := pg_temp.hr_as(NULL, format(create_fmt, c1, NULL, 'candidate_faq', 'other', repeat('x', 4001), 'en', false, NULL, NULL, NULL));
  c := c || pg_temp.hr_chk('create with a 4001-character body was not INVALID', r, 'ERROR 22023 INVALID:%');
  r := pg_temp.hr_as(NULL, format(create_fmt, c1, NULL, 'candidate_faq', 'other', repeat('x', 4000), 'en', false, NULL, NULL, NULL));
  c := c || pg_temp.hr_chk('create with a 4000-character body was refused', r, '________-____-____-____-____________');
  d7 := r::uuid;
  UPDATE hr_agent_drafts SET status = 'rejected' WHERE id = d7;
  r := pg_temp.hr_as(NULL, format(create_fmt, c1, NULL, 'candidate_faq', 'other', 'x', 'en', false, NULL, NULL, u_out));
  c := c || pg_temp.hr_chk('create for a requester of another workspace was not NOT_ALLOWED', r, 'ERROR 42501 NOT_ALLOWED:%');
  r := (SELECT count(*) FROM hr_agent_drafts WHERE conversation_id = c1 AND status = 'pending')::text;
  c := c || pg_temp.hr_chk('a refused create left a pending draft behind', r, '0');

  -- ---------- Create: three drafts, idempotent source, LIMIT ----------
  d1 := pg_temp.hr_as(NULL, format(create_fmt, c1, m1, 'candidate_faq', 'question_role', 'Hello', 'en', false, NULL, NULL, NULL))::uuid;
  d2 := pg_temp.hr_as(NULL, format(create_fmt, c1, m2, 'candidate_faq', 'other', 'Hi', 'en', false, NULL, NULL, NULL))::uuid;
  d3 := pg_temp.hr_as(NULL, format(create_fmt, c1, m3, 'escalation', 'upset', '', 'ar', false, 'guardrail', '[{"a":1}]', u_rmem))::uuid;
  r := (SELECT d.status || '/' || d.lang || '/' || d.requires_template || '/' || coalesce(d.handoff_reason, '-')
               || '/' || coalesce(d.created_by::text, '-') || '/' || d.trace::text
          FROM hr_agent_drafts d WHERE d.id = d3);
  c := c || pg_temp.hr_chk('a created draft kept the wrong fields', r, 'pending/ar/false/guardrail/' || u_rmem || '/[{"a": 1}]');
  r := (SELECT d.account_id = a_acct AND d.decided_by IS NULL AND d.decided_at IS NULL AND d.reject_reason IS NULL
               AND d.trace = '[]'::jsonb FROM hr_agent_drafts d WHERE d.id = d1)::text;
  c := c || pg_temp.hr_chk('a created draft has an account mismatch, a decision or a non-empty default trace', r, 'true');
  r := pg_temp.hr_as(NULL, format(create_fmt, c1, gen_random_uuid(), 'candidate_faq', 'other', 'x', 'en', false, NULL, NULL, NULL));
  c := c || pg_temp.hr_chk('a 4th pending draft was not LIMIT', r, 'ERROR 22023 LIMIT:%');
  r := pg_temp.hr_as(NULL, format(create_fmt, c1, m1, 'escalation', 'other', 'different', 'en', false, NULL, NULL, NULL));
  c := c || pg_temp.hr_chk('the same source did not return the same draft id (even at the limit)', r, d1::text);
  r := (SELECT count(*) FROM hr_agent_drafts WHERE conversation_id = c1 AND source_message_id = m1)::text
    || '/' || (SELECT body FROM hr_agent_drafts WHERE id = d1);
  c := c || pg_temp.hr_chk('the same source made a second row or rewrote the draft', r, '1/Hello');
  r := pg_temp.hr_as(NULL, format(create_fmt, c1, NULL, 'candidate_faq', 'other', 'x', 'en', false, NULL, NULL, NULL));
  c := c || pg_temp.hr_chk('a draft with no source skipped the limit', r, 'ERROR 22023 LIMIT:%');
  r := pg_temp.hr_as(u_owner, format(create_fmt, c1, NULL, 'candidate_faq', 'other', 'x', 'en', false, NULL, NULL, NULL));
  c := c || pg_temp.hr_chk('create by an admin (authenticated) was not refused', r, 'ERROR 42501 %');
  r := pg_temp.hr_as(u_rmem, format(create_fmt, c1, NULL, 'candidate_faq', 'other', 'x', 'en', false, NULL, NULL, NULL));
  c := c || pg_temp.hr_chk('create by a recruiter member was not refused', r, 'ERROR 42501 %');

  -- ---------- Context ----------
  r := pg_temp.hr_as(NULL, format(
    'SELECT (SELECT count(*) FROM jsonb_object_keys(enabled))::text || ''/'' || (enabled->>''orchestrator'') || ''/'' || (enabled->>''cv_screening'') || ''/'' || (enabled->>''candidate_faq'') || ''/'' || pending_drafts || ''/'' || drafts_today || ''/'' || opted_out || ''/'' || inbox || ''/'' || closed || ''/'' || (account_id = %L) FROM public.hr_agent_context(%L)',
    a_acct, c1));
  c := c || pg_temp.hr_chk('context figures', r, '5/true/false/false/3/4/false/recruiter/false/true');
  r := pg_temp.hr_as(NULL, format('SELECT (SELECT count(*) FROM public.hr_agent_context(%L))::text', c7));
  c := c || pg_temp.hr_chk('context for a chat HR does not track returned a row', r, '0');
  r := pg_temp.hr_as(NULL, format('SELECT (opted_out)::text || ''/'' || contact_id FROM public.hr_agent_context(%L)', c4));
  c := c || pg_temp.hr_chk('context did not report the opt-out', r, 'true/%');
  r := pg_temp.hr_as(NULL, format('SELECT closed::text FROM public.hr_agent_context(%L)', c3));
  c := c || pg_temp.hr_chk('context did not report a closed chat', r, 'true');
  r := pg_temp.hr_as(u_owner, format('SELECT (SELECT count(*) FROM public.hr_agent_context(%L))::text', c1));
  c := c || pg_temp.hr_chk('context by an admin (authenticated) was not refused', r, 'ERROR 42501 %');

  -- ---------- RLS reads ----------
  r := pg_temp.hr_as(u_rmem, format('SELECT count(*) FROM public.hr_agent_drafts WHERE conversation_id = %L', c1));
  c := c || pg_temp.hr_chk('a recruiter member on a visible chat does not see its drafts', r, '4');
  r := pg_temp.hr_as(u_rlead, format('SELECT count(*) FROM public.hr_agent_drafts WHERE conversation_id = %L', c1));
  c := c || pg_temp.hr_chk('a recruiter lead who cannot see the chat reads its drafts', r, '0');
  r := pg_temp.hr_as(u_blind, format('SELECT count(*) FROM public.hr_agent_drafts WHERE conversation_id = %L', c1));
  c := c || pg_temp.hr_chk('a recruiter member who cannot see the chat reads its drafts', r, '0');
  r := pg_temp.hr_as(u_owner, format('SELECT count(*) FROM public.hr_agent_drafts WHERE conversation_id = %L', c1));
  c := c || pg_temp.hr_chk('an admin does not see the drafts', r, '4');
  r := pg_temp.hr_as(u_out, format('SELECT count(*) FROM public.hr_agent_drafts WHERE conversation_id = %L', c1));
  c := c || pg_temp.hr_chk('a user of another workspace reads the drafts', r, '0');
  r := pg_temp.hr_as(u_out, 'SELECT count(*) FROM public.hr_agent_settings');
  c := c || pg_temp.hr_chk('a user of another workspace reads the settings', r, '0');
  r := pg_temp.hr_as(u_rmem, 'SELECT count(*) FROM public.hr_agent_settings');
  c := c || pg_temp.hr_chk('a recruiter member does not read the settings', r, '2');
  r := pg_temp.hr_as(u_owner, 'SELECT count(*) FROM public.hr_agent_settings');
  c := c || pg_temp.hr_chk('an admin does not read the settings', r, '2');
  r := pg_temp.hr_as(u_plain, 'SELECT count(*) FROM public.hr_agent_settings');
  c := c || pg_temp.hr_chk('an agent with no recruiter role reads the settings', r, '0');
  d6 := pg_temp.hr_as(NULL, format(create_fmt, c6, m6, 'candidate_faq', 'other', 'Hey', 'en', false, NULL, NULL, NULL))::uuid;
  r := pg_temp.hr_as(u_plain, format('SELECT count(*) FROM public.conversations WHERE id = %L', c6))
    || '/' || pg_temp.hr_as(u_plain, format('SELECT count(*) FROM public.hr_agent_drafts WHERE conversation_id = %L', c6));
  c := c || pg_temp.hr_chk('an agent with no recruiter role reads the drafts of a chat they can see', r, '1/0');
  r := pg_temp.hr_as(u_owner, format('SELECT count(*) FROM public.hr_agent_drafts WHERE conversation_id = %L', c6));
  c := c || pg_temp.hr_chk('an admin does not see the drafts of another agent''s chat', r, '1');

  -- ---------- No client writes ----------
  r := pg_temp.hr_as(u_owner, format(
    'INSERT INTO public.hr_agent_drafts (account_id, conversation_id, agent_kind, intent, body, lang) VALUES (%L, %L, ''candidate_faq'', ''other'', ''x'', ''en'')', a_acct, c1));
  c := c || pg_temp.hr_chk('an admin inserted a draft directly', r, 'ERROR 42501 %');
  r := pg_temp.hr_as(u_owner, format('UPDATE public.hr_agent_drafts SET body = ''y'' WHERE id = %L', d1));
  c := c || pg_temp.hr_chk('an admin updated a draft directly', r, 'ERROR 42501 %');
  r := pg_temp.hr_as(u_owner, format('DELETE FROM public.hr_agent_drafts WHERE id = %L', d1));
  c := c || pg_temp.hr_chk('an admin deleted a draft directly', r, 'ERROR 42501 %');
  r := pg_temp.hr_as(u_owner, format(
    'INSERT INTO public.hr_agent_settings (account_id, agent_kind, enabled) VALUES (%L, ''escalation'', true)', a_acct));
  c := c || pg_temp.hr_chk('an admin inserted a setting directly', r, 'ERROR 42501 %');
  r := pg_temp.hr_as(u_owner, 'UPDATE public.hr_agent_settings SET enabled = false');
  c := c || pg_temp.hr_chk('an admin updated a setting directly', r, 'ERROR 42501 %');
  r := pg_temp.hr_as(u_owner, 'DELETE FROM public.hr_agent_settings');
  c := c || pg_temp.hr_chk('an admin deleted a setting directly', r, 'ERROR 42501 %');

  -- ---------- Decide: refusals ----------
  r := pg_temp.hr_as(u_blind, format('SELECT (public.hr_agent_draft_decide(%L, ''reject'')).status', d3));
  c := c || pg_temp.hr_chk('decide by a member who cannot see the chat was not NOT_FOUND', r, 'ERROR P0002 NOT_FOUND:%');
  r := pg_temp.hr_as(u_out, format('SELECT (public.hr_agent_draft_decide(%L, ''reject'')).status', d3));
  c := c || pg_temp.hr_chk('decide by a user of another workspace was not NOT_FOUND', r, 'ERROR P0002 NOT_FOUND:%');
  r := pg_temp.hr_as(u_rmem, format('SELECT (public.hr_agent_draft_decide(%L, ''reject'')).status', gen_random_uuid()));
  c := c || pg_temp.hr_chk('decide on an unknown draft was not NOT_FOUND', r, 'ERROR P0002 NOT_FOUND:%');
  r := pg_temp.hr_as(u_plain, format('SELECT (public.hr_agent_draft_decide(%L, ''reject'')).status', d6));
  c := c || pg_temp.hr_chk('decide with no recruiter role was not NOT_ALLOWED', r, 'ERROR 42501 NOT_ALLOWED:%');
  r := pg_temp.hr_as(u_rmem, format('SELECT (public.hr_agent_draft_decide(%L, ''maybe'')).status', d2));
  c := c || pg_temp.hr_chk('decide with an unknown decision was not INVALID', r, 'ERROR 22023 INVALID:%');
  r := pg_temp.hr_as(u_rmem, format('SELECT (public.hr_agent_draft_decide(%L, NULL)).status', d2));
  c := c || pg_temp.hr_chk('decide with a NULL decision was not INVALID', r, 'ERROR 22023 INVALID:%');
  r := pg_temp.hr_as(u_rmem, format('SELECT (public.hr_agent_draft_decide(%L, ''approve'')).status', d3));
  c := c || pg_temp.hr_chk('approve of a blank-body draft was not INVALID', r, 'ERROR 22023 INVALID:%');
  r := pg_temp.hr_as(u_rmem, format('SELECT (public.hr_agent_draft_decide(%L, ''reject'', %L)).status', d2, repeat('r', 501)));
  c := c || pg_temp.hr_chk('reject with a 501-character reason was not INVALID', r, 'ERROR 22023 INVALID:%');
  r := (SELECT status FROM hr_agent_drafts WHERE id = d2);
  c := c || pg_temp.hr_chk('a refused decide changed the draft', r, 'pending');

  -- ---------- Decide: approve, reject, stamps ----------
  r := pg_temp.hr_as(u_rmem, format('SELECT (public.hr_agent_draft_decide(%L, ''approve'', ''looks good'')).status', d1));
  c := c || pg_temp.hr_chk('approve by a recruiter member was refused', r, 'approved');
  r := (SELECT (decided_by = u_rmem)::text || '/' || (decided_at IS NOT NULL) || '/' || coalesce(reject_reason, '-')
          FROM hr_agent_drafts WHERE id = d1);
  c := c || pg_temp.hr_chk('approve did not stamp decided_by/at, or stored a reason', r, 'true/true/-');
  r := pg_temp.hr_as(u_rmem, format('SELECT (public.hr_agent_draft_decide(%L, ''reject'')).status', d1));
  c := c || pg_temp.hr_chk('decide on a decided draft was not ALREADY_DECIDED', r, 'ERROR 22023 ALREADY_DECIDED:%');
  r := pg_temp.hr_as(u_rmem, format('SELECT (public.hr_agent_draft_decide(%L, ''approve'')).status', d1));
  c := c || pg_temp.hr_chk('approve of an approved draft was not ALREADY_DECIDED', r, 'ERROR 22023 ALREADY_DECIDED:%');
  r := pg_temp.hr_as(u_owner, format('SELECT (public.hr_agent_draft_decide(%L, ''reject'', ''  not now  '')).status', d2));
  c := c || pg_temp.hr_chk('reject by an admin was refused', r, 'rejected');
  r := (SELECT (decided_by = u_owner)::text || '/' || (decided_at IS NOT NULL) || '/' || coalesce(reject_reason, '-')
          FROM hr_agent_drafts WHERE id = d2);
  c := c || pg_temp.hr_chk('reject did not stamp decided_by/at or keep the reason', r, 'true/true/  not now  ');
  d4 := pg_temp.hr_as(NULL, format(create_fmt, c1, m4, 'scheduling', 'schedule_interview', 'Template body', 'en', true, NULL, NULL, NULL))::uuid;
  r := pg_temp.hr_as(u_rmem, format('SELECT (public.hr_agent_draft_decide(%L, ''approve'')).status', d4));
  c := c || pg_temp.hr_chk('approve of a requires_template draft was not INVALID', r, 'ERROR 22023 INVALID:%');
  d2 := pg_temp.hr_as(NULL, format(create_fmt, c1, m5, 'candidate_faq', 'other', 'again', 'en', false, NULL, NULL, NULL))::uuid;
  r := pg_temp.hr_as(u_rlead, format('SELECT (public.hr_agent_draft_decide(%L, ''reject'')).status', d2));
  c := c || pg_temp.hr_chk('decide by a recruiter lead who cannot see the chat was not NOT_FOUND', r, 'ERROR P0002 NOT_FOUND:%');
  r := pg_temp.hr_as(u_rmem, format('SELECT (public.hr_agent_draft_decide(%L, ''reject'', repeat(''r'', 500))).reject_reason IS NOT NULL', d2));
  c := c || pg_temp.hr_chk('reject with a 500-character reason was refused', r, 'true');

  -- ---------- flag_urgent ----------
  r := (SELECT urgent::text FROM hr_conversations WHERE conversation_id = c1);
  c := c || pg_temp.hr_chk('fixture: the chat started urgent', r, 'false');
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_agent_flag_urgent(%L)', c1));
  r2 := (SELECT urgent::text FROM hr_conversations WHERE conversation_id = c1);
  c := c || pg_temp.hr_chk('flag_urgent did not set the flag', r || '/' || r2, 'ok/true');
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_agent_flag_urgent(%L)', c1));
  c := c || pg_temp.hr_chk('flag_urgent is not repeatable', r, 'ok');
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_agent_flag_urgent(%L)', c3));
  r2 := (SELECT urgent::text FROM hr_conversations WHERE conversation_id = c3);
  c := c || pg_temp.hr_chk('flag_urgent flagged a closed chat', r || '/' || r2, 'ok/false');
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_agent_flag_urgent(%L)', c7));
  c := c || pg_temp.hr_chk('flag_urgent on an untracked chat was refused', r, 'ok');
  r := (SELECT urgent::text FROM hr_conversations WHERE conversation_id = c5);
  c := c || pg_temp.hr_chk('flag_urgent flagged another chat', r, 'false');
  r := pg_temp.hr_as(u_owner, format('SELECT public.hr_agent_flag_urgent(%L)', c5));
  c := c || pg_temp.hr_chk('flag_urgent by an admin (authenticated) was not refused', r, 'ERROR 42501 %');

  -- ---------- supersede ----------
  d7 := pg_temp.hr_as(NULL, format(create_fmt, c5, m7, 'candidate_faq', 'other', 'other contact', 'en', false, NULL, NULL, NULL))::uuid;
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_agent_supersede(%L, %L)', a_out, k[1]));
  c := c || pg_temp.hr_chk('supersede with another account touched drafts', r, '0');
  r := (SELECT count(*) FROM hr_agent_drafts WHERE conversation_id = c1 AND status = 'pending')::text;
  c := c || pg_temp.hr_chk('fixture: pending drafts on the main chat', r, '2');
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_agent_supersede(%L, %L)', a_acct, k[1]));
  c := c || pg_temp.hr_chk('supersede did not return the number of pending drafts', r, '2');
  r := (SELECT string_agg(status, ',' ORDER BY status) FROM hr_agent_drafts WHERE conversation_id = c1);
  c := c || pg_temp.hr_chk('supersede changed the wrong statuses', r, 'approved,rejected,rejected,rejected,superseded,superseded');
  r := (SELECT count(*) FROM hr_agent_drafts WHERE status = 'superseded' AND (decided_by IS NOT NULL OR decided_at IS NOT NULL))::text;
  c := c || pg_temp.hr_chk('supersede stamped decided_by/decided_at', r, '0');
  r := (SELECT status FROM hr_agent_drafts WHERE id = d7) || '/' || (SELECT status FROM hr_agent_drafts WHERE id = d6);
  c := c || pg_temp.hr_chk('supersede touched another contact''s drafts', r, 'pending/pending');
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_agent_supersede(%L, %L)', a_acct, k[1]));
  c := c || pg_temp.hr_chk('supersede is not repeatable', r, '0');
  r := pg_temp.hr_as(u_owner, format('SELECT public.hr_agent_supersede(%L, %L)', a_acct, k[1]));
  c := c || pg_temp.hr_chk('supersede by an admin (authenticated) was not refused', r, 'ERROR 42501 %');
  r := pg_temp.hr_as(NULL, format(create_fmt, c1, NULL, 'candidate_faq', 'other', 'fresh', 'en', false, NULL, NULL, NULL));
  c := c || pg_temp.hr_chk('after supersede a new draft was refused', r, '________-____-____-____-____________');

  -- ---------- Frozen identity ----------
  r := pg_temp.hr_try(format('UPDATE hr_agent_drafts SET source_message_id = gen_random_uuid() WHERE id = %L', d7));
  c := c || pg_temp.hr_chk('the guard did not freeze source_message_id', r, 'ERROR 23514');
  r := pg_temp.hr_try(format('UPDATE hr_agent_drafts SET conversation_id = %L WHERE id = %L', c6, d7));
  c := c || pg_temp.hr_chk('the guard did not freeze conversation_id', r, 'ERROR 23514');
  r := pg_temp.hr_try(format('UPDATE hr_agent_drafts SET account_id = %L WHERE id = %L', a_out, d7));
  c := c || pg_temp.hr_chk('the guard did not freeze account_id', r, 'ERROR 23514');
  r := pg_temp.hr_try(format('UPDATE hr_agent_drafts SET id = gen_random_uuid() WHERE id = %L', d7));
  c := c || pg_temp.hr_chk('the guard did not freeze id', r, 'ERROR 23514');
  r := pg_temp.hr_try(format('UPDATE hr_agent_drafts SET created_at = now() - interval ''1 day'' WHERE id = %L', d7));
  c := c || pg_temp.hr_chk('the guard did not freeze created_at', r, 'ERROR 23514');
  r := pg_temp.hr_try(format(
    'INSERT INTO hr_agent_drafts (account_id, conversation_id, agent_kind, intent, body, lang) VALUES (%L, %L, ''candidate_faq'', ''other'', ''x'', ''en'')', a_out, c6));
  c := c || pg_temp.hr_chk('a draft could be filed under another account than its chat''s', r, 'ERROR 23514');

  -- ---------- Table CHECKs ----------
  r := pg_temp.hr_try(format(
    'INSERT INTO hr_agent_drafts (account_id, conversation_id, agent_kind, intent, body, lang, status) VALUES (%L, %L, ''candidate_faq'', ''other'', ''x'', ''en'', ''sent'')', a_acct, c6));
  c := c || pg_temp.hr_chk('a draft status outside the list was accepted', r, 'ERROR 23514');
  r := pg_temp.hr_try(format(
    'INSERT INTO hr_agent_settings (account_id, agent_kind, enabled) VALUES (%L, ''bogus'', true)', a_acct));
  c := c || pg_temp.hr_chk('a setting kind outside the list was accepted', r, 'ERROR 23514');

  -- ---------- ai_usage_log ----------
  r := pg_temp.hr_try(format(
    'INSERT INTO ai_usage_log (account_id, conversation_id, mode, provider, model) VALUES (%L, %L, ''hr_agent'', ''openai'', ''m'')', a_acct, c1));
  c := c || pg_temp.hr_chk('ai_usage_log refused mode hr_agent', r, 'ok');
  r := pg_temp.hr_try(format(
    'INSERT INTO ai_usage_log (account_id, conversation_id, mode, provider, model) VALUES (%L, %L, ''auto_reply'', ''openai'', ''m'')', a_acct, c1));
  c := c || pg_temp.hr_chk('ai_usage_log refused mode auto_reply', r, 'ok');
  r := pg_temp.hr_try(format(
    'INSERT INTO ai_usage_log (account_id, conversation_id, mode, provider, model) VALUES (%L, %L, ''bogus'', ''openai'', ''m'')', a_acct, c1));
  c := c || pg_temp.hr_chk('ai_usage_log accepted an unknown mode', r, 'ERROR 23514');

  -- ---------- Expire ----------
  r := pg_temp.hr_as(NULL, 'SELECT public.hr_agent_expire(now() + interval ''23 hours'')');
  c := c || pg_temp.hr_chk('expire at +23 h expired a draft', r, '0');
  r := (SELECT status FROM hr_agent_drafts WHERE id = d7) || '/' || (SELECT status FROM hr_agent_drafts WHERE id = d6);
  c := c || pg_temp.hr_chk('expire at +23 h changed a pending draft', r, 'pending/pending');
  r := pg_temp.hr_as(NULL, 'SELECT (public.hr_agent_expire(now() + interval ''25 hours'') >= 3)::text');
  c := c || pg_temp.hr_chk('expire at +25 h did not expire the pending drafts', r, 'true');
  r := (SELECT status FROM hr_agent_drafts WHERE id = d7) || '/' || (SELECT status FROM hr_agent_drafts WHERE id = d6);
  c := c || pg_temp.hr_chk('expire at +25 h left a pending draft', r, 'expired/expired');
  r := (SELECT count(*) FROM hr_agent_drafts WHERE status = 'expired' AND (decided_by IS NOT NULL OR decided_at IS NOT NULL))::text;
  c := c || pg_temp.hr_chk('expire stamped decided_by/decided_at', r, '0');
  r := (SELECT string_agg(status, ',' ORDER BY status) FROM hr_agent_drafts WHERE conversation_id = c1 AND status IN ('approved', 'rejected'));
  c := c || pg_temp.hr_chk('expire touched decided drafts', r, 'approved,rejected,rejected,rejected');
  r := pg_temp.hr_as(NULL, 'SELECT (public.hr_agent_expire(now() + interval ''25 hours''))::text');
  c := c || pg_temp.hr_chk('expire is not repeatable', r, '0');
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_agent_expire()');
  c := c || pg_temp.hr_chk('expire by an admin (authenticated) was not refused', r, 'ERROR 42501 %');
  r := pg_temp.hr_as(u_rmem, format('SELECT (public.hr_agent_draft_decide(%L, ''approve'')).status', d7));
  c := c || pg_temp.hr_chk('an expired draft could be decided', r, 'ERROR 22023 ALREADY_DECIDED:%');

  -- ---------- Cascade ----------
  DELETE FROM hr_conversations WHERE conversation_id = c5;
  r := (SELECT count(*) FROM hr_agent_drafts WHERE conversation_id = c5)::text;
  c := c || pg_temp.hr_chk('deleting the HR row left its drafts behind', r, '0');

  -- ---------- Grants ----------
  r := has_function_privilege('authenticated', 'public.hr_agent_settings_set(text, boolean)', 'EXECUTE')::text
    || '/' || has_function_privilege('authenticated', 'public.hr_agent_draft_decide(uuid, text, text)', 'EXECUTE')::text
    || '/' || has_function_privilege('authenticated', 'public.hr_my_recruiter_role(uuid)', 'EXECUTE')::text;
  c := c || pg_temp.hr_chk('a user function is not executable by authenticated', r, 'true/true/true');
  r := has_function_privilege('anon', 'public.hr_agent_settings_set(text, boolean)', 'EXECUTE')::text
    || '/' || has_function_privilege('anon', 'public.hr_agent_draft_decide(uuid, text, text)', 'EXECUTE')::text
    || '/' || has_function_privilege('anon', 'public.hr_my_recruiter_role(uuid)', 'EXECUTE')::text;
  c := c || pg_temp.hr_chk('a user function is executable by anon', r, 'false/false/false');
  r := has_function_privilege('authenticated', 'public.hr_agent_context(uuid)', 'EXECUTE')::text
    || '/' || has_function_privilege('authenticated', 'public.hr_agent_draft_create(uuid, uuid, text, text, text, text, boolean, text, jsonb, uuid)', 'EXECUTE')::text
    || '/' || has_function_privilege('authenticated', 'public.hr_agent_flag_urgent(uuid)', 'EXECUTE')::text
    || '/' || has_function_privilege('authenticated', 'public.hr_agent_supersede(uuid, uuid)', 'EXECUTE')::text
    || '/' || has_function_privilege('authenticated', 'public.hr_agent_expire(timestamptz)', 'EXECUTE')::text;
  c := c || pg_temp.hr_chk('a system function is executable by authenticated', r, 'false/false/false/false/false');
  r := has_function_privilege('anon', 'public.hr_agent_context(uuid)', 'EXECUTE')::text
    || '/' || has_function_privilege('anon', 'public.hr_agent_draft_create(uuid, uuid, text, text, text, text, boolean, text, jsonb, uuid)', 'EXECUTE')::text
    || '/' || has_function_privilege('anon', 'public.hr_agent_flag_urgent(uuid)', 'EXECUTE')::text
    || '/' || has_function_privilege('anon', 'public.hr_agent_supersede(uuid, uuid)', 'EXECUTE')::text
    || '/' || has_function_privilege('anon', 'public.hr_agent_expire(timestamptz)', 'EXECUTE')::text;
  c := c || pg_temp.hr_chk('a system function is executable by anon', r, 'false/false/false/false/false');
  r := has_function_privilege('service_role', 'public.hr_agent_context(uuid)', 'EXECUTE')::text
    || '/' || has_function_privilege('service_role', 'public.hr_agent_draft_create(uuid, uuid, text, text, text, text, boolean, text, jsonb, uuid)', 'EXECUTE')::text
    || '/' || has_function_privilege('service_role', 'public.hr_agent_flag_urgent(uuid)', 'EXECUTE')::text
    || '/' || has_function_privilege('service_role', 'public.hr_agent_supersede(uuid, uuid)', 'EXECUTE')::text
    || '/' || has_function_privilege('service_role', 'public.hr_agent_expire(timestamptz)', 'EXECUTE')::text;
  c := c || pg_temp.hr_chk('a system function is not executable by service_role', r, 'true/true/true/true/true');
  r := has_function_privilege('service_role', 'public.hr_agent_settings_set(text, boolean)', 'EXECUTE')::text
    || '/' || has_function_privilege('service_role', 'public.hr_agent_draft_decide(uuid, text, text)', 'EXECUTE')::text;
  c := c || pg_temp.hr_chk('a user function is executable by service_role', r, 'false/false');
  r := has_function_privilege('authenticated', 'public.hr_agent_drafts_guard()', 'EXECUTE')::text
    || '/' || has_function_privilege('anon', 'public.hr_agent_drafts_guard()', 'EXECUTE')::text;
  c := c || pg_temp.hr_chk('the guard trigger function is executable by a client role', r, 'false/false');
  r := has_table_privilege('authenticated', 'public.hr_agent_drafts', 'SELECT')::text
    || '/' || has_table_privilege('authenticated', 'public.hr_agent_settings', 'SELECT')::text;
  c := c || pg_temp.hr_chk('authenticated cannot read the agent tables', r, 'true/true');
  r := (SELECT count(*) FROM unnest(ARRAY['INSERT', 'UPDATE', 'DELETE']) p,
               unnest(ARRAY['public.hr_agent_drafts', 'public.hr_agent_settings']) t
         WHERE has_table_privilege('authenticated', t, p) OR has_table_privilege('anon', t, p))::text;
  c := c || pg_temp.hr_chk('a client role can write an agent table', r, '0');
  r := has_table_privilege('anon', 'public.hr_agent_drafts', 'SELECT')::text
    || '/' || has_table_privilege('anon', 'public.hr_agent_settings', 'SELECT')::text;
  c := c || pg_temp.hr_chk('anon can read the agent tables', r, 'false/false');
  r := (SELECT count(*) FROM pg_class
         WHERE oid IN ('public.hr_agent_drafts'::regclass, 'public.hr_agent_settings'::regclass)
           AND relrowsecurity)::text;
  c := c || pg_temp.hr_chk('row level security is not on for both agent tables', r, '2');
  r := pg_temp.hr_as(u_rmem, format('SELECT public.hr_my_recruiter_role(%L)', a_acct))
    || '/' || pg_temp.hr_as(u_rlead, format('SELECT public.hr_my_recruiter_role(%L)', a_acct))
    || '/' || pg_temp.hr_as(u_owner, format('SELECT public.hr_my_recruiter_role(%L)', a_acct))
    || '/' || pg_temp.hr_as(u_plain, format('SELECT coalesce(public.hr_my_recruiter_role(%L), ''none'')', a_acct))
    || '/' || pg_temp.hr_as(u_out, format('SELECT coalesce(public.hr_my_recruiter_role(%L), ''none'')', a_acct));
  c := c || pg_temp.hr_chk('hr_my_recruiter_role', r, 'member/lead/admin/none/none');

  -- Undo every fixture; `c` survives the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT202', MESSAGE = 'verify-hr-agents rollback';
  EXCEPTION WHEN SQLSTATE 'ZT202' THEN
    NULL;
  END;

  n := cardinality(c);
  failed := array_remove(c, NULL);
  IF n = 0 THEN
    RAISE EXCEPTION 'HR agents verification ran no checks';
  END IF;
  IF cardinality(failed) > 0 THEN
    RAISE EXCEPTION 'HR agents verification: % of % checks failed: %',
      cardinality(failed), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'HR agents verification passed (% checks)', n;
END
$verify$;
