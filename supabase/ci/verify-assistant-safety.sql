-- Behavioural regression suite for the assistant guard (migration 120):
-- pending-action confirmations, the atomic rate limiter and the
-- append-only audit.
--
-- assist_pending_request is the only way in: it fixes the nonce (20 hex
-- chars, stored only as its sha256), the lifetime (expires_at = now() +
-- 300 s) and the cap (5 open pending rows per user, across accounts; an
-- expired row, swept or not, holds no slot). Confirm needs the row's own
-- nonce, user and account and an unexpired pending row; consume needs
-- the exact action hash and an unexpired confirmed row, and writes its
-- ALLOW:CONFIRMED decision row in the same call: when that insert fails
-- the call raises HINT AUDIT_UNAVAILABLE, nothing moves, and a retry
-- consumes exactly once. Expire moves stale pending / confirmed rows
-- (one or the sweep); cancel moves only a pending row to denied with
-- one DENY:<reason> decision row. The triggers bind the owner too:
-- born pending, forward-only status, fixed identity, no DELETE /
-- TRUNCATE, every insert and transition copied to the audit, the audit
-- append-only. assist_rate_take takes a slot on every key or none,
-- per key over its window; prune keeps anything younger than two
-- windows; reset is per key, audited, and not service_role's. Grants:
-- service_role reads, inserts rate events and audit rows, and executes
-- exactly the seven API functions; anon / authenticated get nothing.
--
-- Not testable in one DO block (one session, one snapshot): two
-- requests racing for the last cap slot, and concurrent rate takes on
-- the same key. Both rest on the advisory locks in 120.
--
-- Rows are aged (created_at / expires_at moved into the past) as the
-- table owner with the guard and audit triggers disabled for that one
-- UPDATE: the identity guard refuses it otherwise, and now() does not
-- move inside a transaction.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_aown UUID := '00000000-0000-4000-8000-000000120001';  -- auth user: owner of account A
  u_bown UUID := '00000000-0000-4000-8000-000000120002';  -- auth user: owner of account B
  u_cap  UUID := '00000000-0000-4000-8000-000000120011';  -- cap: 3 in A + 2 in B
  u_oth  UUID := '00000000-0000-4000-8000-000000120012';  -- another user while u_cap is capped
  u_cf   UUID := '00000000-0000-4000-8000-000000120013';  -- confirm / consume
  u_ex   UUID := '00000000-0000-4000-8000-000000120014';  -- expire / cancel
  u_tr   UUID := '00000000-0000-4000-8000-000000120015';  -- trigger checks
  a_acct UUID;
  b_acct UUID;
  h      TEXT := encode(sha256(convert_to('{"args":{"a":1},"tool":"send_message"}', 'UTF8')), 'hex');
  h_bad  TEXT := repeat('0', 64);
  x      TEXT;
  p      TEXT[];
  r1 TEXT[]; r2 TEXT[]; r6 TEXT[];
  c1 TEXT[]; c2 TEXT[]; c3 TEXT[]; c4 TEXT[]; c5 TEXT[];
  e1 TEXT[]; e2 TEXT[]; e3 TEXT[]; e4 TEXT[]; e5 TEXT[];
  t1 TEXT[];
  k_u    TEXT := 'assistant:user:' || '00000000-0000-4000-8000-000000120013';
  k_w    TEXT := 'assistant:workspace:verify-120';
  k_o    TEXT := 'assistant:user:other-120';
  k_old  TEXT := 'assistant:user:old-120';
  k_p    TEXT := 'verify:prune-120';
  rec    RECORD;
  st     TEXT;
  i      INT;
  m      BIGINT;
  n      INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (NULL: as the current user, the owner):
  -- a SELECT's value, 'ok', or 'ERROR <sqlstate> <hint>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cs_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; h text;
    BEGIN
      BEGIN
        IF p_role IS NOT NULL THEN
          PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
          PERFORM set_config('request.jwt.claims',
            json_build_object('sub', p_uid, 'role', p_role)::text, true);
          EXECUTE format('SET LOCAL ROLE %I', p_role);
        END IF;
        IF p_sql ILIKE 'select%' OR p_sql ILIKE 'with%' THEN
          EXECUTE p_sql INTO v;
        ELSE
          EXECUTE p_sql;
        END IF;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(v, 'ok');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ' ' || coalesce(nullif(h, ''), '-') || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cs_check(p_name text, p_role text, p_uid uuid, p_sql text, p_like text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := pg_temp.cs_try(p_role, p_uid, p_sql);
    BEGIN
      RETURN CASE WHEN v LIKE p_like THEN NULL ELSE p_name || ' (' || v || ')' END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cs_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  -- p_sql as service_role.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sr(p_sql text)
    RETURNS text LANGUAGE sql AS $body$ SELECT pg_temp.cs_try('service_role', NULL, p_sql) $body$
  $fn$;
  -- assist_pending_request as service_role: '<id> <nonce>', 'NOROW' or 'ERROR …'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.req(p_acct uuid, p_user uuid, p_hash text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.sr(format(
        'select coalesce((select r.id::text || '' '' || r.nonce from public.assist_pending_request(%L, %L, %L, %L, %L, %L, %L) r), ''NOROW'')',
        p_acct, p_user, 'run-120', 'send_message', '{"a":1}', p_hash, 'assistant:' || p_user))
    $body$
  $fn$;
  -- A fixture request that must be admitted: {id, nonce}.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.req_must(p_acct uuid, p_user uuid, p_hash text, p_label text)
    RETURNS text[] LANGUAGE plpgsql AS $body$
    DECLARE v text := pg_temp.req(p_acct, p_user, p_hash);
    BEGIN
      IF v !~ '^[0-9a-f-]{36} [^ ]+$' THEN
        RAISE EXCEPTION 'fixture: request % was not admitted (%)', p_label, v;
      END IF;
      RETURN ARRAY[split_part(v, ' ', 1), split_part(v, ' ', 2)];
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.confirm(p_id text, p_user uuid, p_acct uuid, p_nonce text, p_decision text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.sr(format('select public.assist_pending_confirm(%L, %L, %L, %L, %L, %L)',
        p_id, p_user, p_acct, p_nonce, 'human:' || p_user || '@web', p_decision))
    $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.consume(p_id text, p_user uuid, p_acct uuid, p_hash text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.sr(format('select public.assist_pending_consume(%L, %L, %L, %L, %L, %L, %L, %L)',
        p_id, p_user, p_acct, p_hash, 'assistant:' || p_user, 'run-120', 'send_message', '{"mode":"confirm","risk":"high"}'))
    $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.take(p_keys text[], p_limits int[], p_windows bigint[])
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.sr(format(
        'select (select r.allowed::text || ''/'' || coalesce(r.denied_key, ''-'') || ''/'' || r.retry_after_ms from public.assist_rate_take(%L, %L, %L) r)',
        p_keys, p_limits, p_windows))
    $body$
  $fn$;
  -- Age a pending action as the owner: the guard refuses identity changes and
  -- now() does not move, so the triggers are off for this one UPDATE.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.age(p_id text)
    RETURNS void LANGUAGE plpgsql AS $body$
    BEGIN
      ALTER TABLE public.assist_pending_actions DISABLE TRIGGER assist_pending_guard;
      ALTER TABLE public.assist_pending_actions DISABLE TRIGGER assist_pending_audit;
      UPDATE public.assist_pending_actions
         SET created_at = now() - interval '1 hour', expires_at = now() - interval '1 second'
       WHERE id = p_id::uuid;
      ALTER TABLE public.assist_pending_actions ENABLE TRIGGER assist_pending_guard;
      ALTER TABLE public.assist_pending_actions ENABLE TRIGGER assist_pending_audit;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.status(p_id text)
    RETURNS text LANGUAGE sql AS $body$ SELECT status FROM public.assist_pending_actions WHERE id = p_id::uuid $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.decisions(p_id text)
    RETURNS int LANGUAGE sql AS $body$
      SELECT count(*)::int FROM public.assist_audit WHERE pending_id = p_id::uuid AND kind = 'decision'
    $body$
  $fn$;
  -- The kind 'pending' audit trail of one action: 'outcome:from,…' in order.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.trail(p_id text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT string_agg(outcome || ':' || coalesce(detail ->> 'from', '-'), ',' ORDER BY id)
        FROM public.assist_audit WHERE pending_id = p_id::uuid AND kind = 'pending'
    $body$
  $fn$;

  -- ---------- fixture: two accounts ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_aown, 'as-aown@example.invalid'),
    (u_bown, 'as-bown@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_aown;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_bown;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;

  -- ---------- request ----------
  x := pg_temp.req(a_acct, u_cap, h);
  n := n + 1; failed := failed || pg_temp.cs_ok(x ~ '^[0-9a-f-]{36} [0-9a-f]{20}$',
    format('request: the nonce is not 20 hex chars (%s)', x));
  IF x !~ '^[0-9a-f-]{36} [^ ]+$' THEN RAISE EXCEPTION 'fixture: first request was not admitted (%)', x; END IF;
  r1 := ARRAY[split_part(x, ' ', 1), split_part(x, ' ', 2)];
  SELECT * INTO rec FROM public.assist_pending_actions WHERE id = r1[1]::uuid;
  n := n + 1; failed := failed || pg_temp.cs_ok(
    rec.nonce_hash = encode(sha256(convert_to(r1[2], 'UTF8')), 'hex')
    AND position(r1[2] IN row_to_json(rec)::text) = 0
    AND NOT EXISTS (SELECT 1 FROM public.assist_audit au WHERE position(r1[2] IN row_to_json(au)::text) > 0),
    'request: the nonce is not stored as its sha256 only');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    rec.status = 'pending' AND rec.created_at = now() AND rec.expires_at = now() + interval '300 seconds'
    AND rec.account_id = a_acct AND rec.user_id = u_cap AND rec.action_hash = h AND rec.tool = 'send_message'
    AND rec.confirmed_at IS NULL AND rec.closed_at IS NULL,
    format('request: the row is not pending with expires_at = now() + 300 s (%s)', row_to_json(rec)));
  n := n + 1; failed := failed || pg_temp.cs_ok(pg_temp.trail(r1[1]) = 'pending:-',
    format('request: the insert was not audited (%s)', pg_temp.trail(r1[1])));

  r2 := pg_temp.req_must(a_acct, u_cap, h, 'r2');
  p  := pg_temp.req_must(a_acct, u_cap, h, 'r3');
  p  := pg_temp.req_must(b_acct, u_cap, h, 'r4');
  p  := pg_temp.req_must(b_acct, u_cap, h, 'r5');
  n := n + 1; failed := failed || pg_temp.cs_ok(pg_temp.req(a_acct, u_cap, h) = 'NOROW',
    'request: a 6th open request (account A) was admitted');
  n := n + 1; failed := failed || pg_temp.cs_ok(pg_temp.req(b_acct, u_cap, h) = 'NOROW',
    'request: the cap does not count across accounts (a 6th open request in account B was admitted)');
  x := pg_temp.req(a_acct, u_oth, h);
  n := n + 1; failed := failed || pg_temp.cs_ok(x ~ '^[0-9a-f-]{36} ',
    format('request: another user was refused while the first is capped (%s)', x));
  PERFORM pg_temp.age(r2[1]);
  x := pg_temp.req(a_acct, u_cap, h);
  n := n + 1; failed := failed || pg_temp.cs_ok(x ~ '^[0-9a-f-]{36} ',
    format('request: an expired, unswept row still holds a cap slot (%s)', x));
  n := n + 1; failed := failed || pg_temp.cs_ok(pg_temp.req(a_acct, u_cap, h) = 'NOROW'
    AND (SELECT count(*) FROM public.assist_pending_actions WHERE user_id = u_cap) = 6,
    'request: the cap no longer holds after an expired row freed a slot');

  -- ---------- confirm ----------
  c1 := pg_temp.req_must(a_acct, u_cf, h, 'c1');
  c2 := pg_temp.req_must(a_acct, u_cf, h, 'c2');
  c3 := pg_temp.req_must(a_acct, u_cf, h, 'c3');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    pg_temp.confirm(c1[1], u_cf, a_acct, 'deadbeefdeadbeefdead', 'confirmed') = 'false' AND pg_temp.status(c1[1]) = 'pending',
    'confirm: a wrong nonce confirmed or moved the row');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    pg_temp.confirm(c1[1], u_cf, a_acct, c2[2], 'confirmed') = 'false' AND pg_temp.status(c1[1]) = 'pending',
    'confirm: another row''s nonce confirmed the row');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    pg_temp.confirm(c1[1], u_oth, a_acct, c1[2], 'confirmed') = 'false' AND pg_temp.status(c1[1]) = 'pending',
    'confirm: a wrong user confirmed or moved the row');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    pg_temp.confirm(c1[1], u_cf, b_acct, c1[2], 'confirmed') = 'false' AND pg_temp.status(c1[1]) = 'pending',
    'confirm: a wrong account confirmed or moved the row');
  x := pg_temp.confirm(c1[1], u_cf, a_acct, c1[2], 'confirmed');
  SELECT * INTO rec FROM public.assist_pending_actions WHERE id = c1[1]::uuid;
  n := n + 1; failed := failed || pg_temp.cs_ok(x = 'true' AND rec.status = 'confirmed'
    AND rec.confirmed_at = now() AND rec.closed_at IS NULL AND rec.actor = 'human:' || u_cf || '@web',
    format('confirm: the right nonce did not confirm (%s, %s)', x, row_to_json(rec)));
  n := n + 1; failed := failed || pg_temp.cs_ok(
    pg_temp.confirm(c1[1], u_cf, a_acct, c1[2], 'confirmed') = 'false' AND pg_temp.status(c1[1]) = 'confirmed',
    'confirm: a second confirm returned true');
  PERFORM pg_temp.age(c2[1]);
  n := n + 1; failed := failed || pg_temp.cs_ok(
    pg_temp.confirm(c2[1], u_cf, a_acct, c2[2], 'confirmed') = 'false' AND pg_temp.status(c2[1]) = 'pending',
    'confirm: an expired row was confirmed');
  x := pg_temp.confirm(c3[1], u_cf, a_acct, c3[2], 'denied');
  SELECT * INTO rec FROM public.assist_pending_actions WHERE id = c3[1]::uuid;
  n := n + 1; failed := failed || pg_temp.cs_ok(x = 'true' AND rec.status = 'denied'
    AND rec.closed_at = now() AND rec.confirmed_at IS NULL,
    format('confirm: decision denied did not move the row to denied (%s, %s)', x, row_to_json(rec)));
  n := n + 1; failed := failed || pg_temp.cs_check('confirm: a decision other than confirmed / denied was accepted',
    NULL, NULL, format('select public.assist_pending_confirm(%L, %L, %L, %L, %L, %L)', c1[1], u_cf, a_acct, c1[2], 'x', 'consumed'),
    'ERROR 22023 %');

  -- ---------- consume ----------
  n := n + 1; failed := failed || pg_temp.cs_ok(
    pg_temp.consume(c1[1], u_cf, a_acct, h_bad) = 'false' AND pg_temp.status(c1[1]) = 'confirmed'
    AND pg_temp.decisions(c1[1]) = 0,
    'consume: a wrong action hash consumed the row or wrote a decision row');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    pg_temp.consume(c1[1], u_oth, a_acct, h) = 'false' AND pg_temp.consume(c1[1], u_cf, b_acct, h) = 'false'
    AND pg_temp.status(c1[1]) = 'confirmed' AND pg_temp.decisions(c1[1]) = 0,
    'consume: a wrong user or account consumed the row or wrote a decision row');
  x := pg_temp.consume(c1[1], u_cf, a_acct, h);
  SELECT * INTO rec FROM public.assist_pending_actions WHERE id = c1[1]::uuid;
  n := n + 1; failed := failed || pg_temp.cs_ok(x = 'true' AND rec.status = 'consumed' AND rec.closed_at = now(),
    format('consume: the right hash did not consume (%s, %s)', x, row_to_json(rec)));
  SELECT string_agg(concat_ws('|', au.outcome, au.actor, au.account_id, au.user_id, au.run_id, au.tool, au.action_hash,
                              au.detail::text), ',') INTO st
    FROM public.assist_audit au WHERE au.pending_id = c1[1]::uuid AND au.kind = 'decision';
  n := n + 1; failed := failed || pg_temp.cs_ok(st = concat_ws('|', 'ALLOW:CONFIRMED', 'assistant:' || u_cf, a_acct, u_cf,
      'run-120', 'send_message', h, '{"mode": "confirm", "risk": "high"}'),
    format('consume: not exactly one ALLOW:CONFIRMED decision row with pending_id (%s)', st));
  n := n + 1; failed := failed || pg_temp.cs_ok(
    pg_temp.consume(c1[1], u_cf, a_acct, h) = 'false' AND pg_temp.decisions(c1[1]) = 1,
    'consume: a second consume returned true or wrote another decision row');
  c5 := pg_temp.req_must(a_acct, u_cf, h, 'c5');
  IF pg_temp.confirm(c5[1], u_cf, a_acct, c5[2], 'confirmed') <> 'true' THEN RAISE EXCEPTION 'fixture: confirm c5'; END IF;
  PERFORM pg_temp.age(c5[1]);
  n := n + 1; failed := failed || pg_temp.cs_ok(
    pg_temp.consume(c5[1], u_cf, a_acct, h) = 'false' AND pg_temp.status(c5[1]) = 'confirmed'
    AND pg_temp.decisions(c5[1]) = 0,
    'consume: an expired confirmed row was consumed');

  -- The decision append fails: the call raises AUDIT_UNAVAILABLE and nothing moves.
  c4 := pg_temp.req_must(a_acct, u_cf, h, 'c4');
  IF pg_temp.confirm(c4[1], u_cf, a_acct, c4[2], 'confirmed') <> 'true' THEN RAISE EXCEPTION 'fixture: confirm c4'; END IF;
  EXECUTE $fn$
    CREATE FUNCTION public.verify_120_audit_down() RETURNS trigger LANGUAGE plpgsql AS $body$
    BEGIN
      IF new.kind = 'decision' THEN RAISE EXCEPTION 'verify-120: audit down'; END IF;
      RETURN new;
    END $body$
  $fn$;
  CREATE TRIGGER verify_120_audit_down BEFORE INSERT ON public.assist_audit
    FOR EACH ROW EXECUTE FUNCTION public.verify_120_audit_down();
  x := pg_temp.consume(c4[1], u_cf, a_acct, h);
  DROP TRIGGER verify_120_audit_down ON public.assist_audit;
  DROP FUNCTION public.verify_120_audit_down();
  n := n + 1; failed := failed || pg_temp.cs_ok(
    x LIKE 'ERROR P0001 AUDIT_UNAVAILABLE: assist_pending_consume: the decision audit append failed%',
    format('consume: a failing decision append did not raise HINT AUDIT_UNAVAILABLE (%s)', x));
  n := n + 1; failed := failed || pg_temp.cs_ok(pg_temp.status(c4[1]) = 'confirmed' AND pg_temp.decisions(c4[1]) = 0
    AND pg_temp.trail(c4[1]) = 'pending:-,confirmed:pending',
    format('consume: a failing decision append still moved the row (%s, %s)', pg_temp.status(c4[1]), pg_temp.trail(c4[1])));
  x := pg_temp.consume(c4[1], u_cf, a_acct, h);
  n := n + 1; failed := failed || pg_temp.cs_ok(x = 'true' AND pg_temp.consume(c4[1], u_cf, a_acct, h) = 'false'
    AND pg_temp.status(c4[1]) = 'consumed' AND pg_temp.decisions(c4[1]) = 1,
    format('consume: the retry after AUDIT_UNAVAILABLE did not consume exactly once (%s)', x));

  -- ---------- expire / cancel ----------
  e1 := pg_temp.req_must(a_acct, u_ex, h, 'e1');
  e2 := pg_temp.req_must(a_acct, u_ex, h, 'e2');
  e3 := pg_temp.req_must(a_acct, u_ex, h, 'e3');
  e4 := pg_temp.req_must(a_acct, u_ex, h, 'e4');
  e5 := pg_temp.req_must(a_acct, u_ex, h, 'e5');
  IF pg_temp.confirm(e2[1], u_ex, a_acct, e2[2], 'confirmed') <> 'true'
     OR pg_temp.confirm(e5[1], u_ex, a_acct, e5[2], 'confirmed') <> 'true' THEN
    RAISE EXCEPTION 'fixture: confirm e2 / e5';
  END IF;
  PERFORM pg_temp.age(e1[1]);
  PERFORM pg_temp.age(e2[1]);
  n := n + 1; failed := failed || pg_temp.cs_ok(
    pg_temp.sr(format('select public.assist_pending_expire(%L, %L)', 'system:assist', e3[1])) = '0'
    AND pg_temp.status(e3[1]) = 'pending',
    'expire: a fresh pending row was expired');
  x := pg_temp.sr(format('select public.assist_pending_expire(%L, %L)', 'system:assist', e1[1]));
  SELECT * INTO rec FROM public.assist_pending_actions WHERE id = e1[1]::uuid;
  n := n + 1; failed := failed || pg_temp.cs_ok(x = '1' AND rec.status = 'expired' AND rec.closed_at = now()
    AND rec.actor = 'system:assist',
    format('expire: one stale pending row was not expired (%s, %s)', x, row_to_json(rec)));
  SELECT count(*) INTO m FROM public.assist_pending_actions
   WHERE status IN ('pending', 'confirmed') AND expires_at <= now();
  x := pg_temp.sr(format('select public.assist_pending_expire(%L)', 'system:assist'));
  n := n + 1; failed := failed || pg_temp.cs_ok(m >= 4 AND x = m::text
    AND pg_temp.status(e2[1]) = 'expired' AND pg_temp.status(c5[1]) = 'expired' AND pg_temp.status(r2[1]) = 'expired'
    AND pg_temp.status(e3[1]) = 'pending' AND pg_temp.status(e5[1]) = 'confirmed'
    AND NOT EXISTS (SELECT 1 FROM public.assist_pending_actions
                     WHERE status IN ('pending', 'confirmed') AND expires_at <= now()),
    format('expire: the sweep did not move exactly the stale pending / confirmed rows (%s of %s)', x, m));
  n := n + 1; failed := failed || pg_temp.cs_ok(
    pg_temp.sr(format('select public.assist_pending_expire(%L, %L)', 'system:assist', e1[1])) = '0',
    'expire: an expired row was expired again');

  x := pg_temp.sr(format('select public.assist_pending_cancel(%L, %L)', e4[1], 'NOTIFY_FAILED'));
  SELECT string_agg(concat_ws('|', au.outcome, au.actor, au.account_id, au.user_id, au.tool, au.action_hash), ',') INTO st
    FROM public.assist_audit au WHERE au.pending_id = e4[1]::uuid AND au.kind = 'decision';
  n := n + 1; failed := failed || pg_temp.cs_ok(x = 'true' AND pg_temp.status(e4[1]) = 'denied'
    AND st = concat_ws('|', 'DENY:NOTIFY_FAILED', 'system:assist', a_acct, u_ex, 'send_message', h),
    format('cancel: a pending row did not move to denied with one DENY:<reason> decision row (%s, %s)', x, st));
  n := n + 1; failed := failed || pg_temp.cs_ok(
    pg_temp.sr(format('select public.assist_pending_cancel(%L, %L)', e4[1], 'NOTIFY_FAILED')) = 'false'
    AND pg_temp.decisions(e4[1]) = 1,
    'cancel: a denied row was cancelled again');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    pg_temp.sr(format('select public.assist_pending_cancel(%L, %L)', e5[1], 'NOTIFY_FAILED')) = 'false'
    AND pg_temp.status(e5[1]) = 'confirmed' AND pg_temp.decisions(e5[1]) = 0,
    'cancel: a confirmed row was cancelled');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    pg_temp.sr(format('select public.assist_pending_cancel(%L, %L)', e1[1], 'NOTIFY_FAILED')) = 'false'
    AND pg_temp.status(e1[1]) = 'expired' AND pg_temp.decisions(e1[1]) = 0
    AND pg_temp.sr(format('select public.assist_pending_cancel(%L, %L)', gen_random_uuid(), 'NOTIFY_FAILED')) = 'false',
    'cancel: an expired or unknown row was not a no-op');
  n := n + 1; failed := failed || pg_temp.cs_check('cancel: a reason that is not an UPPER_SNAKE code was accepted',
    'service_role', NULL, format('select public.assist_pending_cancel(%L, %L)', e3[1], 'notify failed'), 'ERROR 22023 %');

  -- ---------- triggers (as the owner) ----------
  t1 := pg_temp.req_must(a_acct, u_tr, h, 't1');
  n := n + 1; failed := failed || pg_temp.cs_check('trigger: an insert not born pending was accepted', NULL, NULL,
    format('INSERT INTO public.assist_pending_actions (account_id, user_id, tool, args, action_hash, nonce_hash, status, actor, expires_at, confirmed_at) '
           'VALUES (%L, %L, ''send_message'', ''{}'', %L, %L, ''confirmed'', ''x'', now() + interval ''1 minute'', now())',
           a_acct, u_tr, h, h),
    'ERROR 42501 -: public.assist_pending_actions: a pending action is inserted pending (INSERT refused)');
  n := n + 1; failed := failed || pg_temp.cs_check('trigger: pending -> consumed was accepted', NULL, NULL,
    format('UPDATE public.assist_pending_actions SET status = ''consumed'' WHERE id = %L', t1[1]),
    'ERROR 42501 -: public.assist_pending_actions: pending -> consumed refused%');
  FOREACH st IN ARRAY ARRAY['pending', 'confirmed', 'expired', 'denied'] LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('trigger: consumed -> %s was accepted', st), NULL, NULL,
      format('UPDATE public.assist_pending_actions SET status = %L WHERE id = %L', st, c1[1]),
      format('ERROR 42501 -: public.assist_pending_actions: consumed -> %s refused%%', st));
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_check('trigger: denied -> confirmed was accepted', NULL, NULL,
    format('UPDATE public.assist_pending_actions SET status = ''confirmed'' WHERE id = %L', c3[1]),
    'ERROR 42501 -: public.assist_pending_actions: denied -> confirmed refused%');
  n := n + 1; failed := failed || pg_temp.cs_check('trigger: expired -> pending was accepted', NULL, NULL,
    format('UPDATE public.assist_pending_actions SET status = ''pending'' WHERE id = %L', e1[1]),
    'ERROR 42501 -: public.assist_pending_actions: expired -> pending refused%');
  FOREACH st IN ARRAY ARRAY[format('user_id = %L', u_oth), format('account_id = %L', b_acct), 'tool = ''delete_contact''',
                            format('action_hash = %L', h_bad), format('nonce_hash = %L', h_bad)] LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('trigger: identity change %s was accepted', split_part(st, ' ', 1)),
      NULL, NULL, format('UPDATE public.assist_pending_actions SET %s WHERE id = %L', st, t1[1]),
      'ERROR 42501 -: public.assist_pending_actions: the action identity is fixed (UPDATE refused)');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_check('trigger: DELETE of a pending action as the owner was accepted', NULL, NULL,
    'DELETE FROM public.assist_pending_actions',
    'ERROR 42501 -: public.assist_pending_actions: DELETE refused (rows are never removed)');
  n := n + 1; failed := failed || pg_temp.cs_check('trigger: TRUNCATE of assist_pending_actions as the owner was accepted',
    NULL, NULL, 'TRUNCATE public.assist_pending_actions',
    'ERROR 42501 -: public.assist_pending_actions is append-only (TRUNCATE refused)');
  n := n + 1; failed := failed || pg_temp.cs_check('service_role UPDATE of assist_pending_actions was accepted',
    'service_role', NULL, format('UPDATE public.assist_pending_actions SET status = ''confirmed'' WHERE id = %L', t1[1]),
    'ERROR 42501 %: permission denied%');
  n := n + 1; failed := failed || pg_temp.cs_check('service_role INSERT into assist_pending_actions was accepted',
    'service_role', NULL,
    format('INSERT INTO public.assist_pending_actions (account_id, user_id, tool, args, action_hash, nonce_hash, actor, expires_at) '
           'VALUES (%L, %L, ''send_message'', ''{}'', %L, %L, ''x'', now() + interval ''1 minute'')', a_acct, u_tr, h, h),
    'ERROR 42501 %: permission denied%');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    pg_temp.trail(c1[1]) = 'pending:-,confirmed:pending,consumed:confirmed'
    AND pg_temp.trail(c3[1]) = 'pending:-,denied:pending'
    AND pg_temp.trail(c4[1]) = 'pending:-,confirmed:pending,consumed:confirmed'
    AND pg_temp.trail(e1[1]) = 'pending:-,expired:pending'
    AND pg_temp.trail(e2[1]) = 'pending:-,confirmed:pending,expired:confirmed'
    AND pg_temp.trail(e4[1]) = 'pending:-,denied:pending'
    AND pg_temp.trail(t1[1]) = 'pending:-',
    format('trigger: a transition left no kind pending audit row (c1 %s, c3 %s, c4 %s, e1 %s, e2 %s, e4 %s, t1 %s)',
      pg_temp.trail(c1[1]), pg_temp.trail(c3[1]), pg_temp.trail(c4[1]), pg_temp.trail(e1[1]), pg_temp.trail(e2[1]),
      pg_temp.trail(e4[1]), pg_temp.trail(t1[1])));
  SELECT count(*) INTO m FROM public.assist_pending_actions a
   WHERE (SELECT au.outcome FROM public.assist_audit au WHERE au.pending_id = a.id AND au.kind = 'pending'
           ORDER BY au.id DESC LIMIT 1) IS DISTINCT FROM a.status
      OR (SELECT count(*) FROM public.assist_audit au WHERE au.pending_id = a.id AND au.kind = 'pending'
           AND au.outcome = 'pending' AND au.detail = '{}'::jsonb) <> 1;
  n := n + 1; failed := failed || pg_temp.cs_ok(m = 0,
    format('trigger: %s pending actions have no insert audit row or a last audit row that is not their status', m));
  n := n + 1; failed := failed || pg_temp.cs_check('UPDATE of assist_audit as the owner was not refused', NULL, NULL,
    'UPDATE public.assist_audit SET outcome = outcome', 'ERROR 42501 -: public.assist_audit is append-only (UPDATE refused)');
  n := n + 1; failed := failed || pg_temp.cs_check('DELETE from assist_audit as the owner was not refused', NULL, NULL,
    'DELETE FROM public.assist_audit', 'ERROR 42501 -: public.assist_audit is append-only (DELETE refused)');
  n := n + 1; failed := failed || pg_temp.cs_check('TRUNCATE of assist_audit as the owner was not refused', NULL, NULL,
    'TRUNCATE public.assist_audit', 'ERROR 42501 -: public.assist_audit is append-only (TRUNCATE refused)');

  -- ---------- rate ----------
  FOR i IN 1 .. 3 LOOP
    x := pg_temp.take(ARRAY[k_w, k_u], ARRAY[10, 3], ARRAY[60000, 60000]::bigint[]);
    n := n + 1; failed := failed || pg_temp.cs_ok(x = 'true/-/0', format('rate: take %s under the limit was refused (%s)', i, x));
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM public.assist_rate_events WHERE key = k_w) = 3
    AND (SELECT count(*) FROM public.assist_rate_events WHERE key = k_u) = 3,
    'rate: an admitted take did not store one event on every key');
  x := pg_temp.take(ARRAY[k_w, k_u], ARRAY[10, 3], ARRAY[60000, 60000]::bigint[]);
  n := n + 1; failed := failed || pg_temp.cs_ok(x LIKE 'false/' || k_u || '/%'
    AND split_part(x, '/', 3)::bigint BETWEEN 1 AND 60000,
    format('rate: the 4th take over a limit of 3 was not refused on that key with 0 < retry_after_ms <= window (%s)', x));
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM public.assist_rate_events WHERE key = k_w) = 3,
    'rate: a refused take stored an event on the other key');
  x := pg_temp.take(ARRAY[k_o], ARRAY[3], ARRAY[60000]::bigint[]);
  n := n + 1; failed := failed || pg_temp.cs_ok(x = 'true/-/0',
    format('rate: a key under its limit was refused while another key is full (%s)', x));
  INSERT INTO public.assist_rate_events (key, ts, window_ms)
  SELECT k_old, clock_timestamp() - interval '10 minutes', 60000 FROM generate_series(1, 5);
  x := pg_temp.take(ARRAY[k_old], ARRAY[3], ARRAY[60000]::bigint[]);
  n := n + 1; failed := failed || pg_temp.cs_ok(x = 'true/-/0',
    format('rate: events older than the window still counted (%s)', x));
  n := n + 1; failed := failed || pg_temp.cs_check('rate: mismatched keys / limits / windows were accepted',
    'service_role', NULL, format('select (select r.allowed from public.assist_rate_take(%L, %L, %L) r)',
      ARRAY[k_o, k_w], ARRAY[1], ARRAY[1000]::bigint[]), 'ERROR 22023 %');

  INSERT INTO public.assist_rate_events (key, ts, window_ms) VALUES
    (k_p, clock_timestamp() - interval '3 minutes', 60000),   -- older than two windows: pruned
    (k_p, clock_timestamp() - interval '90 seconds', 60000),  -- inside two windows: kept
    (k_p, clock_timestamp() - interval '90 seconds', 30000);  -- older than two of ITS windows: pruned
  x := pg_temp.sr('select public.assist_rate_prune()');
  n := n + 1; failed := failed || pg_temp.cs_ok(x = '7'
    AND (SELECT count(*) FROM public.assist_rate_events WHERE key = k_p) = 1
    AND (SELECT window_ms FROM public.assist_rate_events WHERE key = k_p) = 60000
    AND (SELECT count(*) FROM public.assist_rate_events WHERE key = k_old) = 1
    AND (SELECT count(*) FROM public.assist_rate_events WHERE key = k_u) = 3,
    format('rate: prune did not remove exactly the rows older than two of their windows (%s removed)', x));
  n := n + 1; failed := failed || pg_temp.cs_check('rate: TRUNCATE of assist_rate_events as the owner was accepted',
    NULL, NULL, 'TRUNCATE public.assist_rate_events',
    'ERROR 42501 -: public.assist_rate_events is append-only (TRUNCATE refused)');
  n := n + 1; failed := failed || pg_temp.cs_check('rate: service_role ran assist_rate_reset', 'service_role', NULL,
    format('select public.assist_rate_reset(%L, %L, %L)', k_u, 'system:assist', 'verify'), 'ERROR 42501 %: permission denied%');
  n := n + 1; failed := failed || pg_temp.cs_check('rate: a reset without a reason was accepted', NULL, NULL,
    format('select public.assist_rate_reset(%L, %L, %L)', k_u, 'human:admin', ' '), 'ERROR 22023 %');
  x := pg_temp.cs_try(NULL, NULL, format('select public.assist_rate_reset(%L, %L, %L)', k_u, 'human:admin', 'support ticket'));
  SELECT string_agg(concat_ws('|', au.actor, au.outcome, coalesce(au.account_id::text, 'null'),
                              coalesce(au.user_id::text, 'null'), au.detail::text), ',') INTO st
    FROM public.assist_audit au WHERE au.kind = 'rate_reset';
  n := n + 1; failed := failed || pg_temp.cs_ok(x = '3'
    AND NOT EXISTS (SELECT 1 FROM public.assist_rate_events WHERE key = k_u)
    AND (SELECT count(*) FROM public.assist_rate_events WHERE key = k_w) = 3
    AND st = concat_ws('|', 'human:admin', 'RESET', 'null', 'null',
                       jsonb_build_object('key', k_u, 'reason', 'support ticket', 'removed', 3)::text),
    format('rate: reset did not clear exactly its key with one rate_reset audit row (%s, %s)', x, st));
  x := pg_temp.take(ARRAY[k_w, k_u], ARRAY[10, 3], ARRAY[60000, 60000]::bigint[]);
  n := n + 1; failed := failed || pg_temp.cs_ok(x = 'true/-/0', format('rate: a reset key was still refused (%s)', x));

  -- ---------- grants ----------
  SELECT string_agg(rl || '/' || pv || '/' || t, ',' ORDER BY rl COLLATE "C", pv COLLATE "C", t COLLATE "C") INTO st
    FROM unnest(ARRAY['assist_pending_actions', 'assist_rate_events', 'assist_audit']) t,
         unnest(ARRAY['anon', 'authenticated', 'service_role']) rl,
         unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) pv
   WHERE has_table_privilege(rl, 'public.' || t, pv);
  n := n + 1; failed := failed || pg_temp.cs_ok(st = 'service_role/INSERT/assist_audit,service_role/INSERT/assist_rate_events,'
      'service_role/SELECT/assist_audit,service_role/SELECT/assist_pending_actions,service_role/SELECT/assist_rate_events'
    AND NOT EXISTS (
      SELECT 1 FROM unnest(ARRAY['assist_rate_events_id_seq', 'assist_audit_id_seq']) s,
                    unnest(ARRAY['anon', 'authenticated', 'service_role']) rl,
                    unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) pv
       WHERE has_sequence_privilege(rl, 'public.' || s, pv)),
    format('120 table privileges are not exactly service_role SELECT (3 tables) + INSERT (rate events, audit) (%s)', st));
  SELECT string_agg(rl || '/' || f, ',' ORDER BY rl COLLATE "C", f COLLATE "C") INTO st
    FROM unnest(ARRAY['assist_pending_guard()', 'assist_pending_audit()', 'assist_append_only()',
                      'assist_rate_take(text[],integer[],bigint[])', 'assist_rate_prune()',
                      'assist_rate_reset(text,text,text)',
                      'assist_pending_request(uuid,uuid,text,text,jsonb,text,text)',
                      'assist_pending_confirm(uuid,uuid,uuid,text,text,text)',
                      'assist_pending_consume(uuid,uuid,uuid,text,text,text,text,jsonb)',
                      'assist_pending_expire(text,uuid)', 'assist_pending_cancel(uuid,text)']) f,
         unnest(ARRAY['anon', 'authenticated', 'service_role']) rl
   WHERE has_function_privilege(rl, 'public.' || f, 'EXECUTE');
  n := n + 1; failed := failed || pg_temp.cs_ok(st = 'service_role/assist_pending_cancel(uuid,text),'
      'service_role/assist_pending_confirm(uuid,uuid,uuid,text,text,text),'
      'service_role/assist_pending_consume(uuid,uuid,uuid,text,text,text,text,jsonb),'
      'service_role/assist_pending_expire(text,uuid),'
      'service_role/assist_pending_request(uuid,uuid,text,text,jsonb,text,text),'
      'service_role/assist_rate_prune(),service_role/assist_rate_take(text[],integer[],bigint[])',
    format('120 function privileges are not exactly the seven API functions to service_role (%s)', st));

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT120', MESSAGE = 'verify-assistant-safety rollback';
  EXCEPTION WHEN SQLSTATE 'ZT120' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'assistant safety verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'assistant safety verification passed (% checks)', n;
END
$verify$;
