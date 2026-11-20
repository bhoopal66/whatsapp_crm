-- Behavioural regression suite for HR lines (migration 213).
--
-- An admin marks some of the workspace's WhatsApp numbers as HR lines
-- and may switch on auto-open: a chat on an HR line with no HR row then
-- opens as a recruiter conversation at cv_review, as 200's hr_open would.
-- Off by default; the list and switch are read with an HR role and
-- written by owners/admins only, through hr_lines_get / hr_lines_set;
-- hr_auto_open_recruiter is the service role's. This asserts each of
-- those through the real RLS, grants and RPCs.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000213001';  -- owner of A (admin)
  u_hr     UUID := '00000000-0000-4000-8000-000000213002';  -- agent, recruiter member
  u_plain  UUID := '00000000-0000-4000-8000-000000213003';  -- agent, no HR role
  u_out    UUID := '00000000-0000-4000-8000-000000213004';  -- owner of workspace B
  a_acct   UUID;
  a_out    UUID;
  w1 UUID; w2 UUID; wb UUID;   -- numbers: two of A, one of B
  k1 UUID; k2 UUID;            -- contacts
  c1 UUID; c2 UUID;            -- c1 new chat, c2 has a closed HR row
  r        TEXT;
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
  -- trigger provisions each person an account of their own; the two
  -- agents move into A.
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'hrl-owner@example.invalid'),
    (u_hr,    'hrl-hr@example.invalid'),
    (u_plain, 'hrl-plain@example.invalid'),
    (u_out,   'hrl-out@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  SELECT id INTO a_out FROM accounts WHERE owner_user_id = u_out;
  IF a_acct IS NULL OR a_out IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent'
   WHERE user_id IN (u_hr, u_plain);
  INSERT INTO hr_team_members (account_id, user_id, inbox, role)
  VALUES (a_acct, u_hr, 'recruiter', 'member');

  -- w2 is a personal number: personal numbers may be HR lines.
  UPDATE profiles SET may_connect_personal_whatsapp = true WHERE user_id = u_hr;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token)
    VALUES (u_owner, a_acct, 'openwa', 'hrl-sess-1', 't') RETURNING id INTO w1;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, is_personal)
    VALUES (u_hr, a_acct, 'openwa', 'hrl-sess-2', 't', true) RETURNING id INTO w2;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token)
    VALUES (u_out, a_out, 'openwa', 'hrl-sess-b', 't') RETURNING id INTO wb;

  INSERT INTO contacts (account_id, user_id, phone)
  VALUES (a_acct, u_owner, '971502130001') RETURNING id INTO k1;
  INSERT INTO contacts (account_id, user_id, phone)
  VALUES (a_acct, u_owner, '971502130002') RETURNING id INTO k2;
  INSERT INTO conversations (account_id, user_id, contact_id)
  VALUES (a_acct, u_owner, k1) RETURNING id INTO c1;
  INSERT INTO conversations (account_id, user_id, contact_id)
  VALUES (a_acct, u_owner, k2) RETURNING id INTO c2;
  INSERT INTO hr_conversations (conversation_id, account_id, inbox, stage_key, outcome, closed_at)
  VALUES (c2, a_acct, 'recruiter', 'cv_review', 'withdrawn', now());

  -- ---------- Defaults: no row = off, empty list ----------
  r := pg_temp.hr_as(u_owner,
         'SELECT (x->>''auto_open_recruiter'') || ''/'' || jsonb_array_length(x->''channel_ids'') FROM public.hr_lines_get() x');
  c := c || pg_temp.hr_chk('defaults are not off with no lines', r, 'false/0');
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_auto_open_recruiter(%L, %L)', c1, w1));
  c := c || pg_temp.hr_chk('no settings row did not answer off', r, 'off');

  -- ---------- Who reads, who writes ----------
  r := pg_temp.hr_as(u_plain, 'SELECT public.hr_lines_get()::text');
  c := c || pg_temp.hr_chk('an agent without an HR role read the HR lines', r, 'ERROR 42501 NOT_ALLOWED:%');
  r := pg_temp.hr_as(u_hr,
         'SELECT (x->>''auto_open_recruiter'') || ''/'' || jsonb_array_length(x->''channel_ids'') FROM public.hr_lines_get() x');
  c := c || pg_temp.hr_chk('an HR member could not read the HR lines', r, 'false/0');
  r := pg_temp.hr_as(u_hr, format('SELECT public.hr_lines_set(ARRAY[%L]::uuid[], true)::text', w1));
  c := c || pg_temp.hr_chk('an HR member changed the HR lines', r, 'ERROR 42501 NOT_ALLOWED:%');
  r := (SELECT count(*) FROM hr_lines l WHERE l.account_id = a_acct)::text
    || '/' || (SELECT count(*) FROM hr_line_settings s WHERE s.account_id = a_acct)::text;
  c := c || pg_temp.hr_chk('a refused set wrote something', r, '0/0');

  -- ---------- Round trip as the owner ----------
  r := pg_temp.hr_as(u_owner, format(
         'SELECT (x->>''auto_open_recruiter'') || ''/'' || jsonb_array_length(x->''channel_ids'') FROM public.hr_lines_set(ARRAY[%L, %L, %L]::uuid[], false) x',
         w1, w2, w1));
  c := c || pg_temp.hr_chk('set (two numbers, one repeated, off) returned the wrong shape', r, 'false/2');
  r := pg_temp.hr_as(u_owner, format(
         'SELECT (x->>''auto_open_recruiter'') || ''/'' || ((x->''channel_ids'') @> to_jsonb(ARRAY[%L, %L]::uuid[]))::text FROM public.hr_lines_get() x',
         w1, w2));
  c := c || pg_temp.hr_chk('get did not return what set saved', r, 'false/true');
  r := (SELECT string_agg(coalesce(l.created_by::text, '-'), ',') FROM hr_lines l WHERE l.account_id = a_acct)
    || '/' || (SELECT s.updated_by::text FROM hr_line_settings s WHERE s.account_id = a_acct);
  c := c || pg_temp.hr_chk('created_by / updated_by are not the caller', r,
                           u_owner::text || ',' || u_owner::text || '/' || u_owner::text);
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_auto_open_recruiter(%L, %L)', c1, w1));
  c := c || pg_temp.hr_chk('a line with the switch off did not answer off', r, 'off');

  r := pg_temp.hr_as(u_owner, 'SELECT jsonb_array_length(x->''channel_ids'')::text FROM public.hr_lines_set(NULL, false) x');
  c := c || pg_temp.hr_chk('a NULL list did not clear the lines', r, '0');

  -- ---------- Another account's number: INVALID, nothing written ----------
  r := pg_temp.hr_as(u_owner, format('SELECT public.hr_lines_set(ARRAY[%L]::uuid[], false)::text', w1));
  r := pg_temp.hr_as(u_owner, format('SELECT public.hr_lines_set(ARRAY[%L, %L]::uuid[], true)::text', w2, wb));
  c := c || pg_temp.hr_chk('another workspace''s number was not INVALID', r, 'ERROR 22023 INVALID:%');
  r := (SELECT string_agg(l.channel_id::text, ',') FROM hr_lines l WHERE l.account_id IN (a_acct, a_out))
    || '/' || (SELECT s.auto_open_recruiter::text FROM hr_line_settings s WHERE s.account_id = a_acct);
  c := c || pg_temp.hr_chk('an INVALID set wrote something', r, w1::text || '/false');

  -- ---------- Auto-open ----------
  r := pg_temp.hr_as(u_owner, format('SELECT public.hr_lines_set(ARRAY[%L]::uuid[], true)::text', w1));
  c := c || pg_temp.hr_chk('fixture: switching auto-open on failed', r, '{%');
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_auto_open_recruiter(%L, %L)', c1, w2))
    || '/' || pg_temp.hr_as(NULL, format('SELECT public.hr_auto_open_recruiter(%L, NULL)', c1))
    || '/' || pg_temp.hr_as(NULL, format('SELECT public.hr_auto_open_recruiter(%L, %L)', c1, wb));
  c := c || pg_temp.hr_chk('a number that is not a line opened something', r, 'not_hr_line/not_hr_line/not_hr_line');
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_auto_open_recruiter(%L, %L)', gen_random_uuid(), w1));
  c := c || pg_temp.hr_chk('an unknown chat was not not_found', r, 'not_found');

  r := pg_temp.hr_as(NULL, format(
         'INSERT INTO public.messages (conversation_id, sender_type, content_text, created_at) VALUES (%L, ''customer'', ''hrl-c'', %L)',
         c1, now() - interval '1 minute'));
  c := c || pg_temp.hr_chk('fixture: the message into c1 was refused', r, 'ok');
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_auto_open_recruiter(%L, %L)', c1, w1));
  c := c || pg_temp.hr_chk('a new chat on a line was not opened', r, 'opened');
  r := (SELECT x.inbox || '/' || x.stage_key || '/' || coalesce(x.created_by::text, '-')
               || '/' || (x.last_inbound_at IS NOT NULL)::text || '/' || (x.closed_at IS NULL)::text
          FROM hr_conversations x WHERE x.conversation_id = c1)
    || '/' || (SELECT count(*) FROM hr_stage_history h
                WHERE h.conversation_id = c1 AND h.event = 'open' AND h.to_stage = 'cv_review'
                  AND h.to_inbox = 'recruiter' AND h.actor IS NULL)::text
    || '/' || (SELECT count(*) FROM hr_stage_history h WHERE h.conversation_id = c1)::text
    || '/' || (SELECT (count(*) > 0)::text FROM hr_workflow_rules w WHERE w.account_id = a_acct);
  c := c || pg_temp.hr_chk('the opened row is not a recruiter row at cv_review by nobody, with one open',
                           r, 'recruiter/cv_review/-/true/true/1/1/true');
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_auto_open_recruiter(%L, %L)', c1, w1));
  c := c || pg_temp.hr_chk('a second call did not answer exists', r, 'exists');
  r := (SELECT count(*) FROM hr_stage_history h WHERE h.conversation_id = c1)::text;
  c := c || pg_temp.hr_chk('a second call wrote history', r, '1');
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_auto_open_recruiter(%L, %L)', c2, w1));
  c := c || pg_temp.hr_chk('a closed HR row was not exists', r, 'exists');
  r := (SELECT (x.closed_at IS NOT NULL)::text || '/' || x.outcome FROM hr_conversations x WHERE x.conversation_id = c2);
  c := c || pg_temp.hr_chk('a closed HR row was changed', r, 'true/withdrawn');

  -- ---------- Grants ----------
  r := has_function_privilege('anon', 'public.hr_auto_open_recruiter(uuid, uuid)', 'EXECUTE')::text
    || '/' || has_function_privilege('authenticated', 'public.hr_auto_open_recruiter(uuid, uuid)', 'EXECUTE')::text
    || '/' || has_function_privilege('anon', 'public.hr_lines_set(uuid[], boolean)', 'EXECUTE')::text
    || '/' || has_function_privilege('anon', 'public.hr_lines_get()', 'EXECUTE')::text;
  c := c || pg_temp.hr_chk('anon/authenticated may execute what they must not', r, 'false/false/false/false');
  r := pg_temp.hr_as(u_owner, format('SELECT public.hr_auto_open_recruiter(%L, %L)', c1, w1));
  c := c || pg_temp.hr_chk('an owner could call hr_auto_open_recruiter', r, 'ERROR 42501 %');
  r := pg_temp.hr_as(u_owner, 'SELECT count(*)::text FROM public.hr_lines')
    || '/' || pg_temp.hr_as(u_owner, 'SELECT count(*)::text FROM public.hr_line_settings')
    || '/' || pg_temp.hr_as(u_owner, format('INSERT INTO public.hr_lines (channel_id, account_id) VALUES (%L, %L)', w2, a_acct));
  c := c || pg_temp.hr_chk('authenticated reached the tables directly', r, 'ERROR 42501 %/ERROR 42501 %/ERROR 42501 %');

  -- ---------- Deleting the number drops its line ----------
  DELETE FROM whatsapp_config WHERE id = w1;
  r := (SELECT count(*) FROM hr_lines l WHERE l.channel_id = w1)::text;
  c := c || pg_temp.hr_chk('deleting the number left its HR line', r, '0');

  -- Undo every fixture; `c` survives the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT213', MESSAGE = 'verify-hr-lines rollback';
  EXCEPTION WHEN SQLSTATE 'ZT213' THEN
    NULL;
  END;

  n := cardinality(c);
  failed := array_remove(c, NULL);
  IF n = 0 THEN
    RAISE EXCEPTION 'HR lines verification ran no checks';
  END IF;
  IF cardinality(failed) > 0 THEN
    RAISE EXCEPTION 'HR lines verification: % of % checks failed: %',
      cardinality(failed), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'HR lines verification passed (% checks)', n;
END
$verify$;
