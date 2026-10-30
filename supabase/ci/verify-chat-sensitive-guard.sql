-- Behavioural regression suite for the team chat sensitive-data guard
-- (migration 158).
--
-- chat_sensitive_kinds(body) is the sorted, distinct subset of card
-- (Luhn), emirates_id and iban (mod-97) found in a body, the SQL mirror
-- of containsSensitiveData in src/lib/kb/sensitive.ts, and executable by
-- nobody. The corpus block below is read as text by
-- src/lib/kb/sensitive-corpus.test.ts, which holds the TypeScript
-- detector to the same expectations: keep its format (one
-- `($c$<text>$c$, '{<kinds>}'),` per entry between the two marker
-- lines) when adding cases.
--
-- chat_workspace_settings.sensitive_mode ('off' | 'warn' | 'block',
-- default off) and sensitive_scope ('guests' | 'all', default guests)
-- are written only by chat_set_sensitive_guard (live owner / admin;
-- bad or NULL values 22023; one 'update_sensitive_guard' audit row with
-- old and new) and shown by chat_my_permissions as `sensitive`. The
-- internal_messages_sensitive_guard trigger refuses (42501, "contains
-- sensitive data") a user post or body edit with sensitive data only in
-- 'block': scope 'all' everywhere, DMs and deal rooms included; scope
-- 'guests' only in a team or private channel with a bank guest member
-- (channel role 'guest' or account role bank_guest), never a deal room's
-- Team notes. Owners are not exempt. Forwards are posts. System posts,
-- deletes, erasures and updates that keep the body pass.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.
-- A writing RPC's result is assigned first and its effect read in a
-- later statement.

DO $verify$
DECLARE
  u_own UUID := '00000000-0000-4000-8000-000000158101';  -- owner of A
  u_adm UUID := '00000000-0000-4000-8000-000000158102';  -- admin of A
  u_ag  UUID := '00000000-0000-4000-8000-000000158103';  -- agent of A
  u_ag2 UUID := '00000000-0000-4000-8000-000000158104';  -- agent of A
  u_g   UUID := '00000000-0000-4000-8000-000000158105';  -- bank guest of A
  u_cg  UUID := '00000000-0000-4000-8000-000000158106';  -- agent of A, channel role 'guest' in tg
  u_dad UUID := '00000000-0000-4000-8000-000000158107';  -- deactivated admin of A
  u_po  UUID := '00000000-0000-4000-8000-000000158108';  -- owner of B
  a     UUID;
  b     UUID;
  ch    UUID;  -- A team: own, adm, ag, ag2 (no guest)
  tg    UUID;  -- A team: own, ag, cg as channel role 'guest'
  pv    UUID;  -- A private: own, ag, g (account role bank_guest)
  dm    UUID;  -- A DM: ag, ag2
  dr    UUID;  -- A deal room: ag, g (guest)
  chb   UUID;  -- B team
  m_ch  UUID;  -- ag's card in ch
  m_old UUID;  -- ag's card in pv, posted while off
  m_pl  UUID;  -- ag's plain text in pv
  m_cg  UUID;  -- cg's card in tg, posted while off
  rec   RECORD;
  corpus_n INT := 0;
  card  TEXT := 'pay with 4111 1111 1111 1111';
  iban  TEXT := 'IBAN AE07 0331 2345 6789 0123 456';
  eid   TEXT := 'EID 784-1990-1234567-1';
  r     TEXT;
  j     JSONB;
  post  TEXT := 'SELECT public.chat_post_message(%L, %L)::text';
  setg  TEXT := 'SELECT public.chat_set_sensitive_guard(%L, %L, %L)::text';
  perms TEXT := 'SELECT (public.chat_my_permissions(%L)::jsonb -> %L)::text';
  ins   TEXT := 'INSERT INTO public.internal_messages (channel_id, account_id, author_kind, author_id, body) VALUES (%L, %L, %L, %L, %L) RETURNING id::text';
  refused TEXT := 'ERROR 42501:%contains sensitive data%';
  uuid_re TEXT := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  role_name TEXT;
  n      INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (NULL: as the current user) signed in as
  -- p_uid: a SELECT's value, 'ok', or 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.tc_try(p_role text, p_uid uuid, p_sql text)
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
        RETURN coalesce(nullif(v, ''), 'ok');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.tc_check(p_name text, p_uid uuid, p_sql text, p_like text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := pg_temp.tc_try(CASE WHEN p_uid IS NULL THEN NULL ELSE 'authenticated' END, p_uid, p_sql);
    BEGIN
      RETURN CASE WHEN v LIKE p_like THEN NULL ELSE p_name || ' (' || v || ')' END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.tc_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;

  -- ---------- A. chat_sensitive_kinds over the shared corpus ----------
  FOR rec IN SELECT c.s, c.k::text[] AS k FROM (VALUES
-- corpus:begin
($c$$c$, '{}'),
($c$hello there$c$, '{}'),
($c$card 4111 1111 1111 1111 please$c$, '{card}'),
($c$card 4111-1111-1111-1112 wrong luhn$c$, '{}'),
($c$4111111111111111$c$, '{card}'),
($c$4111.1111.1111.1111$c$, '{card}'),
($c$4111/1111/1111/1111$c$, '{card}'),
($c$4222222222222$c$, '{card}'),
($c$4222222222223$c$, '{}'),
($c$6011000000000000004 nineteen$c$, '{}'),
($c$601100000000000000400 21 digits$c$, '{}'),
($c$4111  1111   1111 1111$c$, '{card}'),
($c$4111    1111 1111 1111 four spaces$c$, '{}'),
($c$4111111111111111 and 4222222222222$c$, '{card}'),
($c$call 00971501234567$c$, '{}'),
($c$call +971 50 123 4567$c$, '{}'),
($c$call 0501234567$c$, '{}'),
($c$call (050) 123 4567$c$, '{}'),
($c$+971501234567 and 4111111111111111$c$, '{card}'),
($c$tel +44 20 7946 0958$c$, '{}'),
($c$tel +1 (415) 555-2671 4111111111111111$c$, '{card}'),
($c$009715012345671$c$, '{}'),
($c$+97150123456789012$c$, '{}'),
($c$EID 784-1990-1234567-1$c$, '{emirates_id}'),
($c$EID 7841990 12345671$c$, '{emirates_id}'),
($c$EID 784199012345671$c$, '{emirates_id}'),
($c$id 1784-1990-1234567-1$c$, '{}'),
($c$IBAN AE07 0331 2345 6789 0123 456$c$, '{iban}'),
($c$AE070331234567890123456$c$, '{iban}'),
($c$ae07 0331 2345 6789 0123 456$c$, '{iban}'),
($c$AE08 0331 2345 6789 0123 456$c$, '{}'),
($c$AE07-0331-2345-6789-0123-456$c$, '{iban}'),
($c$GB82 WEST 1234 5698 7654 32$c$, '{iban}'),
($c$GB82WEST12345698765432$c$, '{iban}'),
($c$GB83 WEST 1234 5698 7654 32$c$, '{}'),
($c$SA03 8000 0000 6080 1016 7519$c$, '{iban}'),
($c$SA0380000000608010167519$c$, '{iban}'),
($c$sa03 8000 0000 6080 1016 7519$c$, '{iban}'),
($c$SA04 8000 0000 6080 1016 7519$c$, '{}'),
($c$AE07 0331 2345 6789 0123 4567 too long$c$, '{}'),
($c$XAE070331234567890123456$c$, '{}'),
($c$AE070331234567890123456X$c$, '{}'),
($c$at 20 Main Street 12345$c$, '{}'),
($c$AE07 0331  2345	6789
0123 456$c$, '{iban}'),
($c$رقم البطاقة ٤١١١ ١١١١ ١١١١ ١١١١ شكرا$c$, '{card}'),
($c$کارت ۴۱۱۱۱۱۱۱۱۱۱۱۱۱۱۱$c$, '{card}'),
($c$هوية ٧٨٤-١٩٩٠-١٢٣٤٥٦٧-١$c$, '{emirates_id}'),
($c$اتصل ٠٥٠١٢٣٤٥٦٧$c$, '{}'),
($c$４１１１ 1111 1111 1111$c$, '{card}'),
($c$https://x.com/p/4111111111111111/q$c$, '{card}'),
($c$order4111111111111111x$c$, '{card}'),
($c$ref ABC4111111111111111$c$, '{card}'),
($c$amount AED 1,234,567,890,123$c$, '{}'),
($c$date 2026-10-30 10:00$c$, '{}'),
($c$٤١١١٬١١١١$c$, '{}'),
($c$number 12345678901234567890123$c$, '{}'),
($c$مرحبا AE070331234567890123456 شكرا$c$, '{iban}'),
($c$GB82 WEST 1234 5698 7654 32 and 784-1990-1234567-1$c$, '{emirates_id,iban}'),
($c$card 4111111111111111, iban AE070331234567890123456, eid 784199012345671$c$, '{card,emirates_id,iban}'),
($c$٣٤٥ 4111 1111 1111 1111$c$, '{}')
-- corpus:end
  ) AS c(s, k) LOOP
    corpus_n := corpus_n + 1;
    n := n + 1; failed := failed || pg_temp.tc_ok(public.chat_sensitive_kinds(rec.s) = rec.k,
      format('kinds(%s) = %s, expected %s', left(rec.s, 40), public.chat_sensitive_kinds(rec.s), rec.k));
  END LOOP;
  n := n + 1; failed := failed || pg_temp.tc_ok(corpus_n >= 40, 'corpus has only ' || corpus_n || ' entries');

  -- ---------- B. grants ----------
  FOREACH role_name IN ARRAY ARRAY['public', 'anon', 'authenticated', 'service_role'] LOOP
    n := n + 1; failed := failed || pg_temp.tc_ok(NOT has_function_privilege(role_name, 'public.chat_sensitive_kinds(text)', 'EXECUTE'),
      'chat_sensitive_kinds is executable by ' || role_name);
    n := n + 1; failed := failed || pg_temp.tc_ok(NOT has_function_privilege(role_name, 'public.chat_sensitive_guard()', 'EXECUTE'),
      'chat_sensitive_guard() is executable by ' || role_name);
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY['public', 'anon', 'service_role'] LOOP
    n := n + 1; failed := failed || pg_temp.tc_ok(NOT has_function_privilege(role_name, 'public.chat_set_sensitive_guard(uuid,text,text)', 'EXECUTE'),
      'chat_set_sensitive_guard is executable by ' || role_name);
    n := n + 1; failed := failed || pg_temp.tc_ok(NOT has_function_privilege(role_name, 'public.chat_my_permissions(uuid)', 'EXECUTE'),
      'chat_my_permissions is executable by ' || role_name);
  END LOOP;
  n := n + 1; failed := failed || pg_temp.tc_ok(has_function_privilege('authenticated', 'public.chat_set_sensitive_guard(uuid,text,text)', 'EXECUTE'),
    'chat_set_sensitive_guard is not executable by authenticated');
  n := n + 1; failed := failed || pg_temp.tc_ok(has_function_privilege('authenticated', 'public.chat_my_permissions(uuid)', 'EXECUTE'),
    'chat_my_permissions is not executable by authenticated');
  n := n + 1; failed := failed || pg_temp.tc_ok(EXISTS (
      SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.internal_messages'::regclass
         AND t.tgname = 'internal_messages_sensitive_guard' AND NOT t.tgisinternal AND t.tgenabled <> 'D'),
    'internal_messages_sensitive_guard is missing or disabled');

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_own, 'ci-tc158-own@example.invalid'), (u_adm, 'ci-tc158-adm@example.invalid'),
    (u_ag, 'ci-tc158-ag@example.invalid'), (u_ag2, 'ci-tc158-ag2@example.invalid'),
    (u_g, 'ci-tc158-g@example.invalid'), (u_cg, 'ci-tc158-cg@example.invalid'),
    (u_dad, 'ci-tc158-dad@example.invalid'), (u_po, 'ci-tc158-po@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a FROM profiles WHERE user_id = u_own;
  SELECT account_id INTO b FROM profiles WHERE user_id = u_po;
  IF a IS NULL OR b IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE accounts SET internal_chat_enabled = true WHERE id IN (a, b);
  UPDATE profiles SET account_id = a, account_role = 'admin' WHERE user_id IN (u_adm, u_dad);
  UPDATE profiles SET account_id = a, account_role = 'agent' WHERE user_id IN (u_ag, u_ag2, u_cg);
  INSERT INTO case_banks (account_id, code, name) VALUES (a, 'ADCB', 'ADCB Bank') ON CONFLICT DO NOTHING;
  UPDATE profiles SET account_id = a, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_g;
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_dad;

  ch := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_create_channel(%L, %L, %L, NULL, %L::uuid[])::text', a, 'team', 'TC158 team', ARRAY[u_adm, u_ag, u_ag2]));
  tg := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_create_channel(%L, %L, %L, NULL, %L::uuid[])::text', a, 'team', 'TC158 guest-role team', ARRAY[u_ag]));
  pv := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_create_channel(%L, %L, %L, NULL, %L::uuid[])::text', a, 'private', 'TC158 private', ARRAY[u_ag, u_g]));
  dm := pg_temp.tc_try('authenticated', u_ag, format('SELECT public.chat_open_dm(%L, %L::uuid[])::text', a, ARRAY[u_ag2]));
  chb := pg_temp.tc_try('authenticated', u_po, format('SELECT public.chat_create_channel(%L, %L, %L, NULL, %L::uuid[])::text', b, 'team', 'TC158 B', '{}'));
  INSERT INTO chat_channel_members (channel_id, user_id, role) VALUES (tg, u_cg, 'guest');
  INSERT INTO chat_channels (account_id, kind, name, created_by) VALUES (a, 'deal_room', 'TC158 deal', u_own) RETURNING id INTO dr;
  INSERT INTO chat_channel_members (channel_id, user_id, role) VALUES (dr, u_own, 'admin'), (dr, u_ag, 'member'), (dr, u_g, 'guest');

  -- ---------- C. defaults: off, nothing blocked ----------
  failed := failed || pg_temp.tc_check('default sensitive is off/guests', u_ag, format(perms, a, 'sensitive'),
    '{"mode": "off", "scope": "guests"}'); n := n + 1;
  r := pg_temp.tc_try('authenticated', u_ag, format(post, pv, card));
  n := n + 1; failed := failed || pg_temp.tc_ok(r ~ uuid_re, 'off: card in a guest channel was refused (' || r || ')');
  IF r ~ uuid_re THEN m_old := r::uuid; END IF;
  r := pg_temp.tc_try('authenticated', u_cg, format(post, tg, card));
  n := n + 1; failed := failed || pg_temp.tc_ok(r ~ uuid_re, 'off: card in a guest-role channel was refused (' || r || ')');
  IF r ~ uuid_re THEN m_cg := r::uuid; END IF;

  -- ---------- D. the setter ----------
  failed := failed || pg_temp.tc_check('agent sets the guard', u_ag, format(setg, a, 'block', 'all'), 'ERROR 42501:%'); n := n + 1;
  failed := failed || pg_temp.tc_check('bank guest sets the guard', u_g, format(setg, a, 'block', 'all'), 'ERROR 42501:%'); n := n + 1;
  failed := failed || pg_temp.tc_check('deactivated admin sets the guard', u_dad, format(setg, a, 'block', 'all'), 'ERROR 42501:%'); n := n + 1;
  failed := failed || pg_temp.tc_check('owner of B sets A''s guard', u_po, format(setg, a, 'block', 'all'), 'ERROR 42501:%'); n := n + 1;
  r := pg_temp.tc_try('anon', NULL, format(setg, a, 'block', 'all'));
  n := n + 1; failed := failed || pg_temp.tc_ok(r LIKE 'ERROR 42501:%', 'anon sets the guard (' || r || ')');
  failed := failed || pg_temp.tc_check('bad mode', u_adm, format(setg, a, 'loud', 'all'), 'ERROR 22023:%'); n := n + 1;
  failed := failed || pg_temp.tc_check('NULL mode', u_adm, format(setg, a, NULL, 'all'), 'ERROR 22023:%'); n := n + 1;
  failed := failed || pg_temp.tc_check('bad scope', u_adm, format(setg, a, 'block', 'everyone'), 'ERROR 22023:%'); n := n + 1;
  failed := failed || pg_temp.tc_check('NULL scope', u_adm, format(setg, a, 'block', NULL), 'ERROR 22023:%'); n := n + 1;
  n := n + 1; failed := failed || pg_temp.tc_ok(NOT EXISTS (SELECT 1 FROM chat_workspace_settings
      WHERE account_id = a AND (sensitive_mode <> 'off' OR sensitive_scope <> 'guests'))
    AND NOT EXISTS (SELECT 1 FROM chat_audit_log WHERE account_id = a AND action = 'update_sensitive_guard'),
    'a refused setter call wrote settings or an audit row');
  r := pg_temp.tc_try(NULL, NULL, format('INSERT INTO chat_workspace_settings (account_id, sensitive_mode) VALUES (%L, %L) ON CONFLICT (account_id) DO UPDATE SET sensitive_mode = EXCLUDED.sensitive_mode', a, 'loud'));
  n := n + 1; failed := failed || pg_temp.tc_ok(r LIKE 'ERROR 23514:%', 'sensitive_mode CHECK accepts ''loud'' (' || r || ')');
  r := pg_temp.tc_try(NULL, NULL, format('INSERT INTO chat_workspace_settings (account_id, sensitive_scope) VALUES (%L, %L) ON CONFLICT (account_id) DO UPDATE SET sensitive_scope = EXCLUDED.sensitive_scope', a, 'everyone'));
  n := n + 1; failed := failed || pg_temp.tc_ok(r LIKE 'ERROR 23514:%', 'sensitive_scope CHECK accepts ''everyone'' (' || r || ')');
  failed := failed || pg_temp.tc_check('the kinds function is callable by authenticated', u_ag,
    format('SELECT public.chat_sensitive_kinds(%L)::text', card), 'ERROR 42501:%'); n := n + 1;

  r := pg_temp.tc_try('authenticated', u_adm, format(setg, a, 'warn', 'all'));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = 'ok', 'admin sets warn/all (' || r || ')');
  n := n + 1; failed := failed || pg_temp.tc_ok((SELECT count(*) FROM chat_audit_log WHERE account_id = a
      AND action = 'update_sensitive_guard' AND actor_id = u_adm
      AND detail = '{"old": {"mode": "off", "scope": "guests"}, "new": {"mode": "warn", "scope": "all"}}'::jsonb) = 1,
    'warn/all: no audit row with old off/guests and new warn/all');
  failed := failed || pg_temp.tc_check('agent sees warn/all', u_ag, format(perms, a, 'sensitive'),
    '{"mode": "warn", "scope": "all"}'); n := n + 1;

  -- ---------- E. warn never blocks ----------
  failed := failed || pg_temp.tc_check('warn: card in a guest channel', u_ag, format(post, pv, card), '________-____-____-____-____________'); n := n + 1;
  failed := failed || pg_temp.tc_check('warn: card in a DM', u_ag, format(post, dm, card), '________-____-____-____-____________'); n := n + 1;
  failed := failed || pg_temp.tc_check('warn: IBAN in a staff channel', u_ag, format(post, ch, iban), '________-____-____-____-____________'); n := n + 1;

  -- ---------- F. block, scope guests ----------
  r := pg_temp.tc_try('authenticated', u_own, format(setg, a, 'block', 'guests'));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = 'ok', 'owner sets block/guests (' || r || ')');
  n := n + 1; failed := failed || pg_temp.tc_ok((SELECT count(*) FROM chat_audit_log WHERE account_id = a
      AND action = 'update_sensitive_guard' AND actor_id = u_own
      AND detail = '{"old": {"mode": "warn", "scope": "all"}, "new": {"mode": "block", "scope": "guests"}}'::jsonb) = 1,
    'block/guests: no audit row with old warn/all and new block/guests');
  failed := failed || pg_temp.tc_check('owner sees block/guests', u_own, format(perms, a, 'sensitive'),
    '{"mode": "block", "scope": "guests"}'); n := n + 1;

  failed := failed || pg_temp.tc_check('guests: card in a bank-guest channel', u_ag, format(post, pv, card),
    'ERROR 42501: chat: this message contains sensitive data (card) and this workspace blocks it in channels with bank guests'); n := n + 1;
  failed := failed || pg_temp.tc_check('guests: owner''s IBAN in a bank-guest channel', u_own, format(post, pv, iban), 'ERROR 42501:%contains sensitive data (iban)%'); n := n + 1;
  failed := failed || pg_temp.tc_check('guests: Emirates ID in a bank-guest channel', u_ag, format(post, pv, eid), 'ERROR 42501:%contains sensitive data (emirates_id)%'); n := n + 1;
  failed := failed || pg_temp.tc_check('guests: card in a channel with a guest-role member', u_ag, format(post, tg, card), refused); n := n + 1;
  failed := failed || pg_temp.tc_check('guests: phone number in a bank-guest channel', u_ag, format(post, pv, 'call me on +971 50 123 4567'), '________-____-____-____-____________'); n := n + 1;
  failed := failed || pg_temp.tc_check('guests: bad-checksum IBAN in a bank-guest channel', u_ag, format(post, pv, 'AE08 0331 2345 6789 0123 456'), '________-____-____-____-____________'); n := n + 1;
  r := pg_temp.tc_try('authenticated', u_ag, format(post, ch, card));
  n := n + 1; failed := failed || pg_temp.tc_ok(r ~ uuid_re, 'guests: card in a staff-only channel was refused (' || r || ')');
  IF r ~ uuid_re THEN m_ch := r::uuid; END IF;
  failed := failed || pg_temp.tc_check('guests: card in a DM', u_ag, format(post, dm, card), '________-____-____-____-____________'); n := n + 1;
  failed := failed || pg_temp.tc_check('guests: card in deal-room Team notes', NULL, format(ins, dr, a, 'user', u_ag, card), '________-____-____-____-____________'); n := n + 1;
  failed := failed || pg_temp.tc_check('guests: forward of a card into a bank-guest channel', u_ag,
    format('SELECT public.chat_forward_message(%L, %L)::text', m_ch, pv), refused); n := n + 1;
  failed := failed || pg_temp.tc_check('guests: forward of a card into a DM', u_ag,
    format('SELECT public.chat_forward_message(%L, %L)::text', m_ch, dm), '________-____-____-____-____________'); n := n + 1;
  r := pg_temp.tc_try('authenticated', u_ag, format(post, pv, 'plain words'));
  n := n + 1; failed := failed || pg_temp.tc_ok(r ~ uuid_re, 'guests: plain post in a bank-guest channel was refused (' || r || ')');
  IF r ~ uuid_re THEN m_pl := r::uuid; END IF;
  failed := failed || pg_temp.tc_check('guests: edit adding a card', u_ag,
    format('SELECT public.chat_edit_message(%L, %L)::text', m_pl, 'now ' || card), refused); n := n + 1;
  n := n + 1; failed := failed || pg_temp.tc_ok((SELECT body FROM internal_messages WHERE id = m_pl) = 'plain words',
    'guests: a refused edit changed the body');
  failed := failed || pg_temp.tc_check('guests: plain edit', u_ag,
    format('SELECT public.chat_edit_message(%L, %L)::text', m_pl, 'still plain'), 'ok'); n := n + 1;
  failed := failed || pg_temp.tc_check('guests: system post with a card', NULL,
    format('SELECT public.chat_post_system_message(%L, %L)::text', pv, 'system: ' || card), '%'); n := n + 1;
  n := n + 1; failed := failed || pg_temp.tc_ok((SELECT count(*) FROM internal_messages
      WHERE channel_id = pv AND author_kind = 'system' AND body = 'system: ' || card) = 1,
    'guests: a system post with a card was not stored');
  failed := failed || pg_temp.tc_check('guests: an update keeping an old card body', NULL,
    format('UPDATE internal_messages SET body = body WHERE id = %L RETURNING id::text', m_old), m_old::text); n := n + 1;
  failed := failed || pg_temp.tc_check('guests: deleting an old card message', u_ag,
    format('SELECT public.chat_delete_message(%L)::text', m_old), '%'); n := n + 1;
  n := n + 1; failed := failed || pg_temp.tc_ok((SELECT deleted_at IS NOT NULL FROM internal_messages WHERE id = m_old),
    'guests: an old card message was not deleted');

  -- ---------- G. block, scope all ----------
  r := pg_temp.tc_try('authenticated', u_adm, format(setg, a, 'block', 'all'));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = 'ok', 'admin sets block/all (' || r || ')');
  failed := failed || pg_temp.tc_check('all: card in a DM', u_ag, format(post, dm, card),
    'ERROR 42501: chat: this message contains sensitive data (card) and this workspace blocks it in team chat'); n := n + 1;
  failed := failed || pg_temp.tc_check('all: IBAN in a staff channel', u_ag, format(post, ch, 'GB82 WEST 1234 5698 7654 32'), 'ERROR 42501:%(iban)%'); n := n + 1;
  failed := failed || pg_temp.tc_check('all: owner''s Emirates ID in a staff channel', u_own, format(post, ch, eid), 'ERROR 42501:%(emirates_id)%'); n := n + 1;
  failed := failed || pg_temp.tc_check('all: two kinds named together', u_ag, format(post, ch, iban || ' ' || card), 'ERROR 42501:%(card, iban)%'); n := n + 1;
  failed := failed || pg_temp.tc_check('all: card in deal-room Team notes', NULL, format(ins, dr, a, 'user', u_ag, card), refused); n := n + 1;
  failed := failed || pg_temp.tc_check('all: forward of a card into a DM', u_ag,
    format('SELECT public.chat_forward_message(%L, %L)::text', m_ch, dm), refused); n := n + 1;
  failed := failed || pg_temp.tc_check('all: bad-checksum IBAN', u_ag, format(post, ch, 'GB83 WEST 1234 5698 7654 32'), '________-____-____-____-____________'); n := n + 1;
  failed := failed || pg_temp.tc_check('all: phone number', u_ag, format(post, dm, 'call me on +971 50 123 4567'), '________-____-____-____-____________'); n := n + 1;
  failed := failed || pg_temp.tc_check('all: edit swapping a card for another', u_ag,
    format('SELECT public.chat_edit_message(%L, %L)::text', m_ch, 'card 4222222222222'), refused); n := n + 1;
  failed := failed || pg_temp.tc_check('all: edit removing the card', u_ag,
    format('SELECT public.chat_edit_message(%L, %L)::text', m_ch, 'card removed'), 'ok'); n := n + 1;
  failed := failed || pg_temp.tc_check('all: system post with a card', NULL,
    format('SELECT public.chat_post_system_message(%L, %L)::text', dm, 'system: ' || card), '%'); n := n + 1;
  failed := failed || pg_temp.tc_check('all: B (guard off) is untouched', u_po, format(post, chb, card), '________-____-____-____-____________'); n := n + 1;
  r := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_erase_person(%L, %L, %L)::text', a, u_cg, 'verify 158 erasure'));
  n := n + 1; failed := failed || pg_temp.tc_ok(r NOT LIKE 'ERROR%', 'all: erasing a person with a card message failed (' || r || ')');
  n := n + 1; failed := failed || pg_temp.tc_ok((SELECT body = '[erased]' AND erased_at IS NOT NULL FROM internal_messages WHERE id = m_cg),
    'all: the erased card message was not erased');

  -- A mention token whose uuid digits read as a card (4111-111111111111)
  -- is not sensitive: the raw detector flags it, the guard strips tokens.
  n := n + 1; failed := failed || pg_temp.tc_ok(
    public.chat_sensitive_kinds('hi <@aaaaaaaa-bbbb-4ccc-4111-111111111111>') = '{card}',
    'all: the sample mention token no longer reads as a card, so the next check proves nothing');
  failed := failed || pg_temp.tc_check('all: a mention token that looks like a card', u_ag,
    format(post, dm, 'hi <@aaaaaaaa-bbbb-4ccc-4111-111111111111>'), '________-____-____-____-____________'); n := n + 1;

  -- ---------- H. warn and off again ----------
  r := pg_temp.tc_try('authenticated', u_adm, format(setg, a, 'warn', 'guests'));
  failed := failed || pg_temp.tc_check('warn again: card in a bank-guest channel', u_ag, format(post, pv, card), '________-____-____-____-____________'); n := n + 1;
  r := pg_temp.tc_try('authenticated', u_adm, format(setg, a, 'off', 'all'));
  failed := failed || pg_temp.tc_check('off again: card in a DM', u_ag, format(post, dm, card), '________-____-____-____-____________'); n := n + 1;
  n := n + 1; failed := failed || pg_temp.tc_ok((SELECT count(*) FROM chat_audit_log WHERE account_id = a AND action = 'update_sensitive_guard') = 5,
    'one audit row per successful setter call');

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT158', MESSAGE = 'verify-chat-sensitive-guard rollback';
  EXCEPTION WHEN SQLSTATE 'ZT158' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'chat sensitive guard verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'chat sensitive guard verification passed (% checks)', n;
END
$verify$;
