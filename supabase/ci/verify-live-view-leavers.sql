-- Behavioural regression suite for the live view's leavers (migration 272).
--
-- unassigned_waiting counts a waiting company chat that no live staff
-- member of the workspace holds: nobody's, a deactivated person's, a
-- removed person's, a bank guest's and one held by someone who is live
-- only in another workspace, each by exactly 1. A live person's chat, a
-- leaver's answered or closed chat and a leaver's personal chat add
-- nothing. A team leader still gets no count; an agent is refused.
--
-- ONE statement on purpose: `supabase db query --file` sends the file as
-- a single prepared statement and rejects several. Fixtures are rolled
-- back by a sentinel exception; failures are named in the final one.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000272001';
  u_lead   UUID := '00000000-0000-4000-8000-000000272002';
  u_live   UUID := '00000000-0000-4000-8000-000000272003';
  u_left   UUID := '00000000-0000-4000-8000-000000272004';  -- deactivated
  u_gone   UUID := '00000000-0000-4000-8000-000000272005';  -- removed
  u_guest  UUID := '00000000-0000-4000-8000-000000272006';  -- a bank guest
  u_other  UUID := '00000000-0000-4000-8000-000000272007';  -- live elsewhere
  a_acct   UUID;
  who      UUID[];
  cv       UUID[] := '{}';
  id_      UUID;
  ct       UUID;
  i        INT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- live_team_view() as a signed-in user, or 'ERROR <sqlstate> <hint>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ll_as(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; st text; h text; m text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        EXECUTE p_sql INTO v;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(v, '<null>');
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
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ll_count(p_uid uuid)
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.ll_as(p_uid,
        'SELECT coalesce(public.live_team_view() ->> ''unassigned_waiting'', ''<null>'')')
    $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ll_chk(p_name text, p_got text, p_want text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT CASE WHEN p_got LIKE p_want THEN NULL
                  ELSE p_name || ' (got ' || left(coalesce(p_got, '<null>'), 300)
                       || ', want ' || p_want || ')' END
    $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'lv272-owner@example.invalid'), (u_lead, 'lv272-lead@example.invalid'),
    (u_live, 'lv272-live@example.invalid'), (u_left, 'lv272-left@example.invalid'),
    (u_gone, 'lv272-gone@example.invalid'), (u_guest, 'lv272-guest@example.invalid'),
    (u_other, 'lv272-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent'
   WHERE user_id IN (u_live, u_left, u_gone);
  -- u_other keeps the live profile of the workspace of their own.

  -- Chats 1..7: nobody, live, to be deactivated, to be removed, to become
  -- a guest, live elsewhere, the leaver's answered one. 8: the leaver's
  -- closed one. 9: the leaver's personal one.
  who := ARRAY[NULL, u_live, u_left, u_gone, u_guest, u_other, u_left, u_left, u_left];
  FOR i IN 1..9 LOOP
    INSERT INTO contacts (account_id, user_id, phone, name)
    VALUES (a_acct, u_owner, '97150272' || lpad(i::text, 4, '0'), 'LV272 customer ' || i)
    RETURNING id INTO ct;
    INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id, personal_owner_id)
    VALUES (a_acct, CASE WHEN i = 9 THEN u_left ELSE u_owner END, ct, who[i], CASE WHEN i = 9 THEN u_left END)
    RETURNING id INTO id_;
    cv := cv || id_;
  END LOOP;

  -- Only the live person's chat waits: nothing is unassigned.
  UPDATE conversations SET status = 'closed' WHERE id = cv[8];
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at)
    VALUES (cv[2], 'customer', 'hello', now() - interval '20 minutes');
  n := n + 1; failed := failed || pg_temp.ll_chk(
    'a live person''s waiting chat counted as unassigned', pg_temp.ll_count(u_owner), '0');

  -- Everyone's chat waits, everyone still live: only nobody's and the
  -- two held by someone who is not staff here.
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at)
    VALUES (cv[1], 'customer', 'hello', now() - interval '20 minutes');
  n := n + 1; failed := failed || pg_temp.ll_chk(
    'nobody''s waiting chat does not raise the count by 1', pg_temp.ll_count(u_owner), '1');
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at) VALUES
    (cv[3], 'customer', 'hello', now() - interval '30 minutes'),
    (cv[4], 'customer', 'hello', now() - interval '40 minutes');
  n := n + 1; failed := failed || pg_temp.ll_chk(
    'chats of people who are still live counted as unassigned', pg_temp.ll_count(u_owner), '1');

  -- Deactivated.
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_left AND account_id = a_acct;
  UPDATE conversations SET assigned_agent_id = u_left WHERE id = cv[3];
  n := n + 1; failed := failed || pg_temp.ll_chk(
    'a deactivated person''s waiting chat does not raise the count by 1',
    pg_temp.ll_count(u_owner), '2');

  -- Removed, through the RPC the app calls.
  n := n + 1; failed := failed || pg_temp.ll_chk('remove_account_member failed',
    pg_temp.ll_as(u_owner, format('SELECT ''ok '' || coalesce(public.remove_account_member(%L)::text, '''')', u_gone)),
    'ok %');
  UPDATE conversations SET assigned_agent_id = u_gone WHERE id = cv[4];
  n := n + 1; failed := failed || pg_temp.ll_chk(
    'a removed person''s waiting chat does not raise the count by 1',
    pg_temp.ll_count(u_owner), '3');

  -- A bank guest of this workspace, and a live member of another one.
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'LV272' WHERE user_id = u_guest;
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at)
    VALUES (cv[5], 'customer', 'hello', now() - interval '20 minutes');
  n := n + 1; failed := failed || pg_temp.ll_chk(
    'a guest''s waiting chat does not raise the count by 1', pg_temp.ll_count(u_owner), '4');
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at)
    VALUES (cv[6], 'customer', 'hello', now() - interval '20 minutes');
  n := n + 1; failed := failed || pg_temp.ll_chk(
    'a chat held by someone live only elsewhere does not raise the count by 1',
    pg_temp.ll_count(u_owner), '5');

  -- What never counts: answered, closed, personal.
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at)
    VALUES (cv[7], 'customer', 'hello', now() - interval '60 minutes');
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text, status, created_at)
    VALUES (cv[7], 'agent', u_live, 'on it', 'sent', now());
  UPDATE conversations SET customer_waiting_since = now() - interval '90 minutes'
   WHERE id IN (cv[8], cv[9]);
  n := n + 1; failed := failed || pg_temp.ll_chk(
    'a leaver''s answered, closed or personal chat was counted', pg_temp.ll_count(u_owner), '5');

  -- Reactivated: theirs again, so no longer unassigned.
  UPDATE profiles SET deactivated_at = NULL WHERE user_id = u_left AND account_id = a_acct;
  n := n + 1; failed := failed || pg_temp.ll_chk(
    'a reactivated person''s waiting chat is still counted', pg_temp.ll_count(u_owner), '4');

  -- Who may ask is as 238 left it.
  n := n + 1; failed := failed || pg_temp.ll_chk('a team leader got the count',
    pg_temp.ll_count(u_lead), '<null>');
  n := n + 1; failed := failed || pg_temp.ll_chk('an agent opened the live view',
    pg_temp.ll_count(u_live), 'ERROR 42501 not_allowed%');
  n := n + 1; failed := failed || pg_temp.ll_chk('anon may execute live_team_view',
    has_function_privilege('anon', 'public.live_team_view()', 'EXECUTE')::text, 'false');
  n := n + 1; failed := failed || pg_temp.ll_chk('authenticated may not execute live_team_view',
    has_function_privilege('authenticated', 'public.live_team_view()', 'EXECUTE')::text, 'true');

  RAISE EXCEPTION USING ERRCODE = 'ZT272', MESSAGE = 'verify-live-view-leavers rollback';
  EXCEPTION WHEN SQLSTATE 'ZT272' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'live view leavers verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'live view leavers verification passed (% checks)', n;
END
$verify$;
