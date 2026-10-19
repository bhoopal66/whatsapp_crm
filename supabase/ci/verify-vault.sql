-- Behavioural regression suite for the sensitive-value vault (migration
-- 121, module 019c).
--
-- The app encrypts; the database keeps the ciphertext under a random
-- token and lets only a vault admin / super_admin of the account reveal
-- it, for a stated reason, at most 20 attempts per actor per rolling
-- hour, every attempt audited. A vault_roles row counts only while its
-- holder is a live owner/admin profile of that account. This asserts
-- bootstrap / grant / revoke (NOT_OWNER, WORKSPACE_HAS_ROLES, NO_ROLE,
-- INVALID_ROLE, NOT_ADMIN, NOOP, LAST_SUPER_ADMIN), the live-profile
-- rule, put / dedupe / BAD_SUBJECT and the refused kinds, reveal (roles,
-- NOT_FOUND, the reason filter, the rate limit), delete, key rotation
-- (candidates with keyset paging, rewrap, CONFLICT, the failure
-- reports), the audit read, the append-only and identity guards, and
-- that service_role / anon / authenticated hold no table or sequence
-- privilege and execute exactly the 12 API functions (service_role) or
-- none. Every call the app makes runs as service_role.
--
-- Not testable in one DO block: the READ COMMITTED requirement
-- (vault_reveal and the role functions raise 25000 under REPEATABLE
-- READ; the isolation level cannot change inside a running transaction)
-- and concurrent bootstraps (serialised by an advisory lock; needs two
-- sessions).
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_o   UUID := '00000000-0000-4000-8000-000000121001';  -- owner of A, bootstrapped super_admin
  u_a1  UUID := '00000000-0000-4000-8000-000000121002';  -- admin, vault admin
  u_a2  UUID := '00000000-0000-4000-8000-000000121003';  -- admin, vault super_admin (live check)
  u_a3  UUID := '00000000-0000-4000-8000-000000121004';  -- admin, vault admin then revoked
  u_a4  UUID := '00000000-0000-4000-8000-000000121005';  -- admin, never granted
  u_r   UUID := '00000000-0000-4000-8000-000000121006';  -- admin, vault admin (rate limit)
  u_g   UUID := '00000000-0000-4000-8000-000000121007';  -- agent
  u_v   UUID := '00000000-0000-4000-8000-000000121008';  -- viewer
  u_bg  UUID := '00000000-0000-4000-8000-000000121009';  -- bank guest
  u_od  UUID := '00000000-0000-4000-8000-000000121010';  -- deactivated owner of A
  u_o2  UUID := '00000000-0000-4000-8000-000000121011';  -- owner of B
  a_acct UUID;
  b_acct UUID;
  v_ct   BYTEA := '\xdeadbeef01'::bytea;
  v_iv   BYTEA := decode(repeat('00', 12), 'hex');
  v_tg   BYTEA := decode(repeat('11', 16), 'hex');
  subj   UUID := gen_random_uuid();
  t1 TEXT; t2 TEXT; tb TEXT; ti TEXT; td TEXT; te TEXT; tx TEXT;
  tr1 TEXT; tr2 TEXT; tr3 TEXT; tr4 TEXT;
  s  TEXT;
  d  BOOLEAN;
  r  RECORD;
  j  JSONB;
  c0 BIGINT;
  c1 BIGINT;
  k  INT;
  uu UUID;
  arr  TEXT[];
  arr2 TEXT[];
  cur_at TIMESTAMPTZ;
  cur_id UUID;
  reasons TEXT[];
  whys    TEXT[];
  n INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run p_sql as p_role (NULL: as the session user): a SELECT's value,
  -- 'ok', or 'ERROR <sqlstate>: <message>'. Always ends as the session user.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.v_try(p_role text, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        IF p_role IS NOT NULL THEN EXECUTE format('SET LOCAL ROLE %I', p_role); END IF;
        IF p_sql ILIKE 'select%' THEN EXECUTE p_sql INTO v; ELSE EXECUTE p_sql; END IF;
        RESET ROLE;
        RETURN coalesce(v, 'ok');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;
  -- A deterministic 64-hex blind index per label.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.v_bi(p text) RETURNS text LANGUAGE sql IMMUTABLE
    AS $body$ SELECT encode(sha256(convert_to('vault-121-' || p, 'UTF8')), 'hex') $body$
  $fn$;
  -- vault_put as the CALLER's role (invoker): the token, NULL when refused.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.v_put(p_actor uuid, p_account uuid, p_kind text, p_bi text, p_key text, p_subject_type text)
    RETURNS text LANGUAGE sql
    AS $body$
      SELECT p.token FROM public.vault_put(p_actor, p_account, p_kind, '\xdeadbeef02'::bytea, decode(repeat('00', 12), 'hex'),
                                           decode(repeat('11', 16), 'hex'), p_key, pg_temp.v_bi(p_bi), p_subject_type,
                                           gen_random_uuid()) p
    $body$
  $fn$;
  -- Owner-level reads, usable while the role is service_role.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.v_last(p_account uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER
    AS $body$ SELECT to_jsonb(a) FROM public.vault_audit a WHERE a.account_id = p_account ORDER BY a.id DESC LIMIT 1 $body$
  $fn$;
  -- 'action:outcome:why' of the account's latest audit row.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.v_why(p_account uuid) RETURNS text LANGUAGE sql SECURITY DEFINER
    AS $body$ SELECT a.action || ':' || a.outcome || ':' || coalesce(a.detail->>'why', '')
                FROM public.vault_audit a WHERE a.account_id = p_account ORDER BY a.id DESC LIMIT 1 $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.v_audits(p_account uuid) RETURNS bigint LANGUAGE sql SECURITY DEFINER
    AS $body$ SELECT count(*) FROM public.vault_audit a WHERE a.account_id = p_account $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.v_item(p_token text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER
    AS $body$ SELECT jsonb_build_object('account_id', i.account_id, 'kind', i.kind, 'key_id', i.key_id,
                       'ct', encode(i.ciphertext, 'hex'), 'iv_len', octet_length(i.iv), 'tag_len', octet_length(i.auth_tag),
                       'bi', i.blind_index, 'deleted', i.deleted_at IS NOT NULL, 'subject_type', i.subject_type,
                       'subject_id', i.subject_id, 'created_at', i.created_at, 'id', i.id)
                FROM public.vault_items i WHERE i.token = p_token $body$
  $fn$;
  -- Any owner-level scalar query.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.v_q(p_sql text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
    AS $body$ DECLARE v text; BEGIN EXECUTE p_sql INTO v; RETURN v; END $body$
  $fn$;
  GRANT EXECUTE ON FUNCTION pg_temp.v_last(uuid), pg_temp.v_why(uuid), pg_temp.v_audits(uuid), pg_temp.v_item(text),
    pg_temp.v_q(text), pg_temp.v_bi(text), pg_temp.v_put(uuid, uuid, text, text, text, text) TO service_role;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_o,  'vault-o@example.invalid'),  (u_a1, 'vault-a1@example.invalid'), (u_a2, 'vault-a2@example.invalid'),
    (u_a3, 'vault-a3@example.invalid'), (u_a4, 'vault-a4@example.invalid'), (u_r,  'vault-r@example.invalid'),
    (u_g,  'vault-g@example.invalid'),  (u_v,  'vault-v@example.invalid'),  (u_bg, 'vault-bg@example.invalid'),
    (u_od, 'vault-od@example.invalid'), (u_o2, 'vault-o2@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_o;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_o2;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id IN (u_a1, u_a2, u_a3, u_a4, u_r);
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_g;
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_v;
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_bg;
  UPDATE profiles SET account_id = a_acct, account_role = 'owner', deactivated_at = now() WHERE user_id = u_od;
  IF (SELECT count(*) FROM profiles WHERE account_id = a_acct AND user_id IN (u_o, u_a1, u_a2, u_a3, u_a4, u_r, u_g, u_v, u_bg, u_od)) <> 10
     OR (SELECT account_role::text FROM profiles WHERE user_id = u_o) <> 'owner'
     OR (SELECT account_role::text FROM profiles WHERE user_id = u_o2) <> 'owner' THEN
    RAISE EXCEPTION 'fixture: profiles not where expected';
  END IF;

  SET LOCAL ROLE service_role;

  -- ---------- overview before any role (Settings -> Vault) ----------
  n := n + 1;
  IF vault_overview(u_o, a_acct) IS DISTINCT FROM '{"bootstrap_available": true, "my_role": null, "roles": []}'::jsonb THEN
    failed := failed || format('vault_overview before any role is not bootstrap-available / no role (%s)', vault_overview(u_o, a_acct));
  END IF;

  -- ---------- bootstrap ----------
  FOREACH uu IN ARRAY ARRAY[u_a1, u_g, u_od, u_o2] LOOP
    s := vault_role_bootstrap(u_o, a_acct, uu);
    n := n + 1;
    IF s || '|' || pg_temp.v_why(a_acct) IS DISTINCT FROM 'DENIED|role_bootstrap:DENIED:NOT_OWNER' THEN
      failed := failed || format('bootstrap for a non-owner / deactivated / other account''s owner %s: %s %s', uu, s, pg_temp.v_why(a_acct));
    END IF;
  END LOOP;
  n := n + 1;
  IF pg_temp.v_q(format('SELECT count(*) FROM vault_roles WHERE account_id = %L', a_acct)) <> '0' THEN
    failed := failed || 'a refused bootstrap stored a role'::text;
    -- Revoke it (the one change the guard allows) so the owner's
    -- bootstrap below still runs and the later checks still name their rule.
    RESET ROLE;
    UPDATE vault_roles SET revoked_at = clock_timestamp(), revoked_by = u_o WHERE account_id = a_acct AND revoked_at IS NULL;
    SET LOCAL ROLE service_role;
  END IF;
  s := vault_role_bootstrap(u_o, a_acct, u_o);
  n := n + 1;
  IF s || '|' || pg_temp.v_why(a_acct) IS DISTINCT FROM 'OK|role_bootstrap:OK:'
     OR pg_temp.v_q(format('SELECT string_agg(user_id || role, '','') FROM vault_roles WHERE account_id = %L AND revoked_at IS NULL', a_acct))
        IS DISTINCT FROM u_o::text || 'super_admin' THEN
    failed := failed || format('bootstrap of the live owner did not grant super_admin: %s', s);
  END IF;
  s := vault_role_bootstrap(u_o, a_acct, u_o);
  n := n + 1;
  IF s || '|' || pg_temp.v_why(a_acct) IS DISTINCT FROM 'DENIED|role_bootstrap:DENIED:WORKSPACE_HAS_ROLES' THEN
    failed := failed || format('a second bootstrap was not DENIED WORKSPACE_HAS_ROLES: %s', s);
  END IF;
  n := n + 1;
  IF pg_temp.v_q(format('SELECT count(*) FROM vault_audit WHERE account_id = %L AND action = ''role_bootstrap'' AND outcome = ''DENIED''', a_acct)) <> '5' THEN
    failed := failed || 'not every refused bootstrap was audited'::text;
  END IF;
  s := vault_role_bootstrap(u_o2, b_acct, u_o2);
  IF s IS DISTINCT FROM 'OK' THEN RAISE EXCEPTION 'fixture: bootstrap of B: %', s; END IF;

  -- ---------- grant / revoke ----------
  s := vault_role_grant(u_o, a_acct, u_a1, 'admin');
  n := n + 1;
  IF s || '|' || pg_temp.v_why(a_acct) IS DISTINCT FROM 'OK|role_grant:OK:' THEN failed := failed || format('grant admin: %s', s); END IF;
  s := vault_role_grant(u_o, a_acct, u_a1, 'admin');
  n := n + 1;
  IF s IS DISTINCT FROM 'NOOP' THEN failed := failed || format('a repeated grant was not NOOP: %s', s); END IF;
  IF vault_role_grant(u_o, a_acct, u_a2, 'super_admin') <> 'OK' OR vault_role_grant(u_o, a_acct, u_a3, 'admin') <> 'OK'
     OR vault_role_grant(u_o, a_acct, u_r, 'admin') <> 'OK' THEN
    RAISE EXCEPTION 'fixture: grants';
  END IF;
  s := vault_role_grant(u_a1, a_acct, u_a4, 'admin');
  n := n + 1;
  IF s || '|' || pg_temp.v_why(a_acct) IS DISTINCT FROM 'DENIED|role_grant:DENIED:NO_ROLE' THEN
    failed := failed || format('an admin holder granted a role: %s', s);
  END IF;
  s := vault_role_revoke(u_a1, a_acct, u_a3, 'admin');
  n := n + 1;
  IF s || '|' || pg_temp.v_why(a_acct) IS DISTINCT FROM 'DENIED|role_revoke:DENIED:NO_ROLE' THEN
    failed := failed || format('an admin holder revoked a role: %s', s);
  END IF;
  s := vault_role_grant(u_o, a_acct, u_a4, 'owner');
  n := n + 1;
  IF s || '|' || pg_temp.v_why(a_acct) IS DISTINCT FROM 'DENIED|role_grant:DENIED:INVALID_ROLE' THEN
    failed := failed || format('grant of role owner was not INVALID_ROLE: %s', s);
  END IF;
  s := vault_role_grant(u_o, a_acct, u_a4, NULL);
  n := n + 1;
  IF s || '|' || pg_temp.v_why(a_acct) IS DISTINCT FROM 'DENIED|role_grant:DENIED:INVALID_ROLE' THEN
    failed := failed || format('grant of a NULL role was not INVALID_ROLE: %s', s);
  END IF;
  FOREACH uu IN ARRAY ARRAY[u_g, u_v, u_bg, u_od, u_o2, NULL::uuid] LOOP
    s := vault_role_grant(u_o, a_acct, uu, 'admin');
    n := n + 1;
    IF s || '|' || pg_temp.v_why(a_acct) IS DISTINCT FROM 'DENIED|role_grant:DENIED:NOT_ADMIN' THEN
      failed := failed || format('grant to a non-admin (agent / viewer / guest / deactivated / other account / NULL) %s: %s', uu, s);
    END IF;
  END LOOP;
  n := n + 1;
  IF pg_temp.v_q(format('SELECT count(*) FROM vault_roles WHERE account_id = %L AND user_id IN (%L, %L, %L, %L, %L, %L)',
                        a_acct, u_g, u_v, u_bg, u_od, u_o2, u_a4)) <> '0' THEN
    failed := failed || 'a refused grant stored a role'::text;
  END IF;
  s := vault_role_revoke(u_o, a_acct, u_a3, 'admin');
  n := n + 1;
  IF s IS DISTINCT FROM 'OK' THEN failed := failed || format('revoke admin: %s', s); END IF;
  s := vault_role_revoke(u_o, a_acct, u_a3, 'admin');
  n := n + 1;
  IF s IS DISTINCT FROM 'NOOP' THEN failed := failed || format('a repeated revoke was not NOOP: %s', s); END IF;
  -- 121 has no INVALID_ROLE branch on revoke (nor has 019c): an unknown role revokes nothing.
  s := vault_role_revoke(u_o, a_acct, u_a1, 'owner');
  n := n + 1;
  IF s IS NOT DISTINCT FROM 'OK'
     OR pg_temp.v_q(format('SELECT count(*) FROM vault_roles WHERE account_id = %L AND user_id = %L AND revoked_at IS NULL', a_acct, u_a1)) <> '1' THEN
    failed := failed || format('revoke of an invalid role changed something: %s', s);
  END IF;
  n := n + 1;
  IF pg_temp.v_q(format('SELECT count(*) FROM vault_roles WHERE account_id = %L AND user_id = %L AND revoked_at IS NULL', a_acct, u_a3)) <> '0' THEN
    failed := failed || 'a revoked role is still active'::text;
  END IF;
  -- last super_admin: O and A2 hold it
  s := vault_role_revoke(u_o, a_acct, u_a2, 'super_admin');
  n := n + 1;
  IF s IS DISTINCT FROM 'OK' THEN failed := failed || format('revoking a super_admin while another counts was refused: %s', s); END IF;
  s := vault_role_revoke(u_o, a_acct, u_o, 'super_admin');
  n := n + 1;
  IF s || '|' || pg_temp.v_why(a_acct) IS DISTINCT FROM 'DENIED|role_revoke:DENIED:LAST_SUPER_ADMIN' THEN
    failed := failed || format('revoking the last super_admin was not LAST_SUPER_ADMIN: %s', s);
  END IF;
  IF vault_role_grant(u_o, a_acct, u_a2, 'super_admin') <> 'OK' THEN RAISE EXCEPTION 'fixture: re-grant A2'; END IF;
  RESET ROLE;
  UPDATE profiles SET account_role = 'agent' WHERE user_id = u_a2;
  SET LOCAL ROLE service_role;
  s := vault_role_revoke(u_o, a_acct, u_o, 'super_admin');
  n := n + 1;
  IF s || '|' || pg_temp.v_why(a_acct) IS DISTINCT FROM 'DENIED|role_revoke:DENIED:LAST_SUPER_ADMIN' THEN
    failed := failed || format('a demoted super_admin counted toward LAST_SUPER_ADMIN: %s', s);
  END IF;
  RESET ROLE;
  -- Keep the fixture (O a super_admin) when that revoke wrongly went through.
  INSERT INTO vault_roles (account_id, user_id, role, granted_by)
  SELECT a_acct, u_o, 'super_admin', u_o
   WHERE NOT EXISTS (SELECT 1 FROM vault_roles WHERE account_id = a_acct AND user_id = u_o AND role = 'super_admin' AND revoked_at IS NULL);
  UPDATE profiles SET account_role = 'admin' WHERE user_id = u_a2;
  SET LOCAL ROLE service_role;

  -- ---------- put / dedupe ----------
  SELECT p.status, p.token, p.deduped INTO s, t1, d
    FROM vault_put(u_g, a_acct, 'EID', v_ct, v_iv, v_tg, 'k1', pg_temp.v_bi('1'), 'contact', subj) p;
  n := n + 1;
  IF s IS DISTINCT FROM 'OK' OR d IS DISTINCT FROM false OR t1 !~ '^vlt_[ghjkmnpqrstvwxyz]{26}$' OR t1 IS NULL
     OR pg_temp.v_why(a_acct) <> 'put:OK:' THEN
    failed := failed || format('put: %s %s %s', s, t1, d);
  END IF;
  SELECT p.status, p.token, p.deduped INTO s, tx, d
    FROM vault_put(u_o, a_acct, 'EID', '\xdeadbeef09'::bytea, v_iv, v_tg, 'k1', pg_temp.v_bi('1'), 'case', gen_random_uuid()) p;
  n := n + 1;
  IF s IS DISTINCT FROM 'OK' OR d IS DISTINCT FROM true OR tx IS DISTINCT FROM t1 OR pg_temp.v_why(a_acct) <> 'dedupe:OK:'
     OR pg_temp.v_q(format('SELECT count(*) FROM vault_items WHERE account_id = %L AND blind_index = %L', a_acct, pg_temp.v_bi('1'))) <> '1'
     OR pg_temp.v_item(t1)->>'ct' <> 'deadbeef01' THEN
    failed := failed || format('dedupe did not return the live token without storing: %s %s %s', s, tx, d);
  END IF;
  tb := pg_temp.v_put(u_o2, b_acct, 'EID', '1', 'k1', 'contact');
  ti := pg_temp.v_put(u_o, a_acct, 'IBAN', '1', 'k1', 'contact');
  t2 := pg_temp.v_put(u_o, a_acct, 'EID', '2', 'k1', 'contact');
  n := n + 1;
  IF tb IS NULL OR ti IS NULL OR t2 IS NULL OR tb = t1 OR ti = t1 OR t2 = t1 OR tb = ti THEN
    failed := failed || format('the same blind index in another account / kind, or another value, did not get its own token: %s %s %s', tb, ti, t2);
  END IF;
  -- kinds refused by the CHECK (owner insert and vault_put)
  RESET ROLE;
  FOREACH s IN ARRAY ARRAY['CARD', 'CVV', 'OTP', 'PIN'] LOOP
    tx := pg_temp.v_try('service_role', format('SELECT pg_temp.v_put(%L, %L, %L, %L, ''k1'', ''contact'')', u_o, a_acct, s, 'kind-' || s));
    n := n + 1;
    IF tx NOT LIKE 'ERROR 23514%' THEN failed := failed || format('vault_put accepted kind %s (%s)', s, tx); END IF;
    tx := pg_temp.v_try(NULL, format(
      'INSERT INTO vault_items (account_id, kind, ciphertext, iv, auth_tag, key_id, subject_type, subject_id, blind_index, created_by)
       VALUES (%L, %L, ''\xdeadbeef03'', decode(repeat(''00'', 12), ''hex''), decode(repeat(''11'', 16), ''hex''), ''k1'', ''contact'',
               gen_random_uuid(), %L, %L)', a_acct, s, pg_temp.v_bi('own-' || s), u_o));
    n := n + 1;
    IF tx NOT LIKE 'ERROR 23514%' THEN failed := failed || format('the owner inserted kind %s (%s)', s, tx); END IF;
  END LOOP;
  SET LOCAL ROLE service_role;
  -- BAD_SUBJECT
  c1 := pg_temp.v_q(format('SELECT count(*) FROM vault_items WHERE account_id = %L', a_acct))::bigint;
  FOR k IN 1..3 LOOP
    SELECT p.status, p.token, p.deduped INTO s, tx, d
      FROM vault_put(u_o, a_acct, 'EID', v_ct, v_iv, v_tg, 'k1', pg_temp.v_bi('bad' || k),
                     (ARRAY['deal', 'contact', NULL])[k], CASE WHEN k = 2 THEN NULL ELSE gen_random_uuid() END) p;
    n := n + 1;
    IF s || '|' || pg_temp.v_why(a_acct) IS DISTINCT FROM 'DENIED|put:DENIED:BAD_SUBJECT' OR tx IS NOT NULL OR d IS NOT NULL THEN
      failed := failed || format('put with a bad subject (case %s): %s %s %s', k, s, tx, d);
    END IF;
  END LOOP;
  n := n + 1;
  IF pg_temp.v_q(format('SELECT count(*) FROM vault_items WHERE account_id = %L', a_acct))::bigint <> c1 THEN
    failed := failed || 'a BAD_SUBJECT put stored an item'::text;
  END IF;

  -- ---------- reveal ----------
  SELECT * INTO r FROM vault_reveal(u_o, a_acct, t1, 'customer asked to confirm their EID on file');
  j := pg_temp.v_last(a_acct);
  n := n + 1;
  IF r.status IS DISTINCT FROM 'OK' OR r.kind <> 'EID' OR r.ciphertext <> v_ct OR r.iv <> v_iv OR r.auth_tag <> v_tg
     OR r.key_id <> 'k1' OR r.blind_index <> pg_temp.v_bi('1')
     OR j->>'action' <> 'reveal' OR j->>'outcome' <> 'OK' OR j->>'token' <> t1
     OR j->>'reason' IS DISTINCT FROM 'customer asked to confirm their EID on file' THEN
    failed := failed || format('super_admin reveal: %s / %s', r.status, j);
  END IF;
  SELECT * INTO r FROM vault_reveal(u_a1, a_acct, t1, 'verifying the customer identity');
  n := n + 1;
  IF r.status IS DISTINCT FROM 'OK' OR r.ciphertext IS DISTINCT FROM v_ct OR pg_temp.v_why(a_acct) <> 'reveal:OK:' THEN
    failed := failed || format('admin reveal: %s', r.status);
  END IF;
  -- no role, a revoked admin, an admin never granted, another account's owner
  FOREACH uu IN ARRAY ARRAY[u_g, u_a3, u_a4, u_o2] LOOP
    SELECT * INTO r FROM vault_reveal(uu, a_acct, t1, 'verifying the customer identity');
    n := n + 1;
    IF r.status || '|' || pg_temp.v_why(a_acct) IS DISTINCT FROM 'DENIED|reveal:DENIED:NO_ROLE'
       OR r.ciphertext IS NOT NULL OR r.kind IS NOT NULL OR r.blind_index IS NOT NULL THEN
      failed := failed || format('reveal by a non-holder %s: %s', uu, r.status);
    END IF;
  END LOOP;
  -- NOT_FOUND: another account's token, unknown, malformed
  SELECT * INTO r FROM vault_reveal(u_o2, b_acct, t1, 'verifying the customer identity');
  n := n + 1;
  IF r.status || '|' || pg_temp.v_why(b_acct) IS DISTINCT FROM 'NOT_FOUND|reveal:NOT_FOUND:' OR r.ciphertext IS NOT NULL THEN
    failed := failed || format('reveal of another account''s token: %s', r.status);
  END IF;
  SELECT * INTO r FROM vault_reveal(u_o, a_acct, 'vlt_' || repeat('g', 26), 'verifying the customer identity');
  n := n + 1;
  IF r.status || '|' || pg_temp.v_why(a_acct) IS DISTINCT FROM 'NOT_FOUND|reveal:NOT_FOUND:' THEN
    failed := failed || format('reveal of an unknown token: %s', r.status);
  END IF;
  SELECT * INTO r FROM vault_reveal(u_o, a_acct, 'not-a-token', 'verifying the customer identity');
  j := pg_temp.v_last(a_acct);
  n := n + 1;
  IF r.status IS DISTINCT FROM 'NOT_FOUND' OR j->>'outcome' <> 'NOT_FOUND' OR j->>'token' IS NOT NULL THEN
    failed := failed || format('reveal of a malformed token: %s %s', r.status, j->>'token');
  END IF;

  -- ---------- live check: a holder counts only while a live owner/admin ----------
  SELECT * INTO r FROM vault_reveal(u_a2, a_acct, t1, 'verifying the customer identity');
  IF r.status IS DISTINCT FROM 'OK' THEN RAISE EXCEPTION 'fixture: A2 reveal %', r.status; END IF;
  FOR k IN 1..2 LOOP
    RESET ROLE;
    IF k = 1 THEN UPDATE profiles SET account_role = 'agent' WHERE user_id = u_a2;
    ELSE UPDATE profiles SET deactivated_at = now() WHERE user_id = u_a2; END IF;
    SET LOCAL ROLE service_role;
    SELECT * INTO r FROM vault_reveal(u_a2, a_acct, t1, 'verifying the customer identity');
    n := n + 1;
    IF r.status IS DISTINCT FROM 'DENIED' OR r.ciphertext IS NOT NULL THEN
      failed := failed || format('live check: a %s holder still revealed (%s)', CASE k WHEN 1 THEN 'demoted' ELSE 'deactivated' END, r.status);
    END IF;
    s := vault_delete(u_a2, a_acct, t2, 'customer asked for erasure');
    n := n + 1;
    IF s IS DISTINCT FROM 'DENIED' OR (pg_temp.v_item(t2)->>'deleted')::boolean THEN
      failed := failed || format('live check: a %s holder still deleted (%s)', CASE k WHEN 1 THEN 'demoted' ELSE 'deactivated' END, s);
    END IF;
    s := vault_role_grant(u_a2, a_acct, u_a1, 'admin');
    n := n + 1;
    IF s || '|' || pg_temp.v_why(a_acct) IS DISTINCT FROM 'DENIED|role_grant:DENIED:NO_ROLE' THEN
      failed := failed || format('live check: a %s super_admin still granted (%s)', CASE k WHEN 1 THEN 'demoted' ELSE 'deactivated' END, s);
    END IF;
    RESET ROLE;
    UPDATE profiles SET account_role = 'admin', deactivated_at = NULL WHERE user_id = u_a2;
    SET LOCAL ROLE service_role;
    SELECT * INTO r FROM vault_reveal(u_a2, a_acct, t1, 'verifying the customer identity');
    s := vault_role_grant(u_a2, a_acct, u_a1, 'admin');
    n := n + 1;
    IF r.status IS DISTINCT FROM 'OK' OR s IS DISTINCT FROM 'NOOP' THEN
      failed := failed || format('live check: restoring the profile did not restore the role (%s %s)', r.status, s);
    END IF;
  END LOOP;

  -- ---------- reason filter (A1) ----------
  reasons := ARRAY['', '   ', NULL, repeat('a', 501), 'ids x98765 y98765 z98', 'ref 9876543 checked',
                   'passport Z - 654321 checked', 'iban starts AE07 per customer', 'ref ٩٨٧', 'ref ९८७'];
  whys := ARRAY['REASON_REQUIRED', 'REASON_REQUIRED', 'REASON_REQUIRED', 'REASON_TOO_LONG', 'REASON_HAS_IDENTIFIER',
                'REASON_HAS_IDENTIFIER', 'REASON_HAS_IDENTIFIER', 'REASON_HAS_IDENTIFIER', 'NON_ASCII_DIGITS', 'NON_ASCII_DIGITS'];
  FOR k IN 1..array_length(reasons, 1) LOOP
    SELECT * INTO r FROM vault_reveal(u_a1, a_acct, t1, reasons[k]);
    j := pg_temp.v_last(a_acct);
    n := n + 1;
    IF r.status IS DISTINCT FROM 'DENIED' OR r.ciphertext IS NOT NULL OR j->>'action' <> 'reveal' OR j->>'outcome' <> 'DENIED'
       OR j->'detail'->>'why' IS DISTINCT FROM whys[k] OR j->>'reason' IS NOT NULL
       OR (btrim(coalesce(reasons[k], '')) <> '' AND strpos(j::text, reasons[k]) > 0) THEN
      failed := failed || format('reason %s was not refused (%s) or was stored: %s %s', k, whys[k], r.status, j->'detail');
    END IF;
  END LOOP;
  SELECT * INTO r FROM vault_reveal(u_a1, a_acct, t1, 'customer KYC check, ticket in words');
  j := pg_temp.v_last(a_acct);
  n := n + 1;
  IF r.status IS DISTINCT FROM 'OK' OR j->>'reason' IS DISTINCT FROM 'customer KYC check, ticket in words' THEN
    failed := failed || format('a normal reason was refused: %s', r.status);
  END IF;

  -- ---------- rate limit (R): 15 in A, 5 in B, then the 21st and 22nd ----------
  arr := '{}';
  FOR k IN 1..20 LOOP
    SELECT * INTO r FROM vault_reveal(u_r, CASE WHEN k <= 15 THEN a_acct ELSE b_acct END, t1, 'rate check in words');
    arr := arr || r.status;
  END LOOP;
  n := n + 1;
  IF arr IS DISTINCT FROM array_cat(array_fill('OK'::text, ARRAY[15]), array_fill('DENIED'::text, ARRAY[5])) THEN
    failed := failed || format('rate limit fixture: the first 20 attempts were %s', arr);
  END IF;
  FOR k IN 21..22 LOOP
    SELECT * INTO r FROM vault_reveal(u_r, a_acct, t1, 'rate check in words');
    j := pg_temp.v_last(a_acct);
    n := n + 1;
    IF r.status IS DISTINCT FROM 'RATE_LIMITED' OR r.ciphertext IS NOT NULL OR j->>'outcome' <> 'RATE_LIMITED'
       OR j->>'actor' <> u_r::text OR j->'detail'->>'window_count' IS DISTINCT FROM '20' THEN
      failed := failed || format('rate limit: attempt %s (20 per hour across accounts, RATE_LIMITED not counted): %s %s', k, r.status, j->'detail');
    END IF;
  END LOOP;

  -- ---------- delete ----------
  td := pg_temp.v_put(u_o, a_acct, 'PASSPORT', 'd', 'k1', 'case');
  j := pg_temp.v_item(td);
  s := vault_delete(u_g, a_acct, td, 'customer asked for erasure');
  n := n + 1;
  IF s || '|' || pg_temp.v_why(a_acct) IS DISTINCT FROM 'DENIED|delete:DENIED:NO_ROLE' OR (pg_temp.v_item(td)->>'deleted')::boolean THEN
    failed := failed || format('delete by an agent: %s', s);
  END IF;
  s := vault_delete(u_o, a_acct, td, NULL);
  n := n + 1;
  IF s || '|' || pg_temp.v_why(a_acct) IS DISTINCT FROM 'DENIED|delete:DENIED:REASON_REQUIRED' OR (pg_temp.v_item(td)->>'deleted')::boolean THEN
    failed := failed || format('delete without a reason: %s', s);
  END IF;
  s := vault_delete(u_o, a_acct, td, 'customer asked for erasure');
  n := n + 1;
  IF s || '|' || pg_temp.v_why(a_acct) IS DISTINCT FROM 'OK|delete:OK:'
     OR pg_temp.v_item(td) IS DISTINCT FROM j || jsonb_build_object('ct', '', 'iv_len', 0, 'tag_len', 0, 'bi', NULL, 'deleted', true) THEN
    failed := failed || format('delete did not wipe the payload and keep token / kind / subject: %s %s', s, pg_temp.v_item(td));
  END IF;
  SELECT * INTO r FROM vault_reveal(u_o, a_acct, td, 'verifying the customer identity');
  n := n + 1;
  IF r.status IS DISTINCT FROM 'NOT_FOUND' THEN failed := failed || format('reveal of a deleted item: %s', r.status); END IF;
  s := vault_delete(u_o, a_acct, td, 'customer asked for erasure');
  n := n + 1;
  IF s IS DISTINCT FROM 'NOT_FOUND' THEN failed := failed || format('a second delete: %s', s); END IF;
  SELECT p.status, p.token, p.deduped INTO s, tx, d
    FROM vault_put(u_o, a_acct, 'PASSPORT', v_ct, v_iv, v_tg, 'k1', pg_temp.v_bi('d'), 'case', gen_random_uuid()) p;
  n := n + 1;
  IF s IS DISTINCT FROM 'OK' OR d IS DISTINCT FROM false OR tx IS NULL OR tx = td THEN
    failed := failed || format('a re-put after delete did not create a new token: %s %s %s', s, tx, d);
  END IF;
  te := pg_temp.v_put(u_o, a_acct, 'PHONE', 'e', 'k1', 'contact');
  s := vault_delete(u_a1, a_acct, te, 'customer asked for erasure');
  n := n + 1;
  IF s IS DISTINCT FROM 'OK' THEN failed := failed || format('delete by an admin holder: %s', s); END IF;

  -- ---------- rewrap ----------
  tr1 := pg_temp.v_put(u_o, a_acct, 'ACCOUNT', 'r1', 'kold', 'contact');
  tr2 := pg_temp.v_put(u_o, a_acct, 'ACCOUNT', 'r2', 'kold', 'contact');
  tr3 := pg_temp.v_put(u_o, a_acct, 'ACCOUNT', 'r3', 'kold', 'contact');
  tr4 := pg_temp.v_put(u_o, a_acct, 'ACCOUNT', 'r4', 'kold', 'contact');
  tx := pg_temp.v_put(u_o2, b_acct, 'ACCOUNT', 'r5', 'kold', 'contact');
  tx := pg_temp.v_put(u_o, a_acct, 'ACCOUNT', 'r6', 'kother', 'contact');
  IF vault_delete(u_o, a_acct, tr4, 'customer asked for erasure') <> 'OK' THEN RAISE EXCEPTION 'fixture: delete tr4'; END IF;
  arr2 := string_to_array(pg_temp.v_q(format(
    'SELECT string_agg(token, '','' ORDER BY created_at, id) FROM vault_items WHERE account_id = %L AND key_id = ''kold'' AND deleted_at IS NULL',
    a_acct)), ',');
  IF cardinality(arr2) <> 3 OR NOT (arr2 @> ARRAY[tr1, tr2, tr3]) THEN RAISE EXCEPTION 'fixture: kold items %', arr2; END IF;
  c0 := pg_temp.v_audits(a_acct);
  SELECT array_agg(c.status ORDER BY c.ord) INTO arr
    FROM vault_rewrap_candidates(u_a1, a_acct, 'kold', 10) WITH ORDINALITY
         c(status, token, kind, ciphertext, iv, auth_tag, key_id, blind_index, created_at, id, ord);
  n := n + 1;
  IF arr IS DISTINCT FROM ARRAY['DENIED'] OR pg_temp.v_why(a_acct) <> 'rewrap_read:DENIED:NO_ROLE' OR pg_temp.v_audits(a_acct) <> c0 + 1 THEN
    failed := failed || format('rewrap_candidates by an admin: %s', arr);
  END IF;
  SELECT array_agg(c.token ORDER BY c.ord) INTO arr
    FROM vault_rewrap_candidates(u_o, a_acct, 'kold', 2) WITH ORDINALITY
         c(status, token, kind, ciphertext, iv, auth_tag, key_id, blind_index, created_at, id, ord);
  SELECT c.created_at, c.id INTO cur_at, cur_id
    FROM vault_rewrap_candidates(u_o, a_acct, 'kold', 2) WITH ORDINALITY
         c(status, token, kind, ciphertext, iv, auth_tag, key_id, blind_index, created_at, id, ord)
   ORDER BY c.ord DESC LIMIT 1;
  n := n + 1;
  IF arr IS DISTINCT FROM arr2[1:2] THEN
    failed := failed || format('rewrap_candidates page 1 is not the first two live kold items in (created_at, id) order: %s vs %s', arr, arr2);
  END IF;
  SELECT array_agg(c.token ORDER BY c.ord) INTO arr
    FROM vault_rewrap_candidates(u_o, a_acct, 'kold', 2, cur_at, cur_id) WITH ORDINALITY
         c(status, token, kind, ciphertext, iv, auth_tag, key_id, blind_index, created_at, id, ord);
  n := n + 1;
  IF arr IS DISTINCT FROM arr2[3:3] THEN
    failed := failed || format('rewrap_candidates page 2 does not continue after the cursor: %s vs %s', arr, arr2);
  END IF;
  RESET ROLE;
  FOREACH s IN ARRAY ARRAY['0', '501', 'NULL'] LOOP
    tx := pg_temp.v_try('service_role', format(
      'SELECT count(*)::text FROM vault_rewrap_candidates(%L, %L, ''kold'', %s)', u_o, a_acct, s));
    n := n + 1;
    IF tx NOT LIKE 'ERROR 22023%' THEN failed := failed || format('rewrap_candidates p_limit %s did not raise 22023 (%s)', s, tx); END IF;
  END LOOP;
  SET LOCAL ROLE service_role;
  s := vault_rewrap(u_a1, a_acct, tr1, 'kold', '\xdeadbeef04'::bytea, v_iv, v_tg, 'knew');
  n := n + 1;
  IF s || '|' || pg_temp.v_why(a_acct) IS DISTINCT FROM 'DENIED|rewrap:DENIED:NO_ROLE' OR pg_temp.v_item(tr1)->>'key_id' <> 'kold' THEN
    failed := failed || format('rewrap by an admin: %s', s);
  END IF;
  s := vault_rewrap(u_o, a_acct, tr1, 'kold', '\xdeadbeef05'::bytea, v_iv, v_tg, 'knew');
  n := n + 1;
  IF s IS DISTINCT FROM 'OK' OR pg_temp.v_item(tr1)->>'key_id' <> 'knew' OR pg_temp.v_item(tr1)->>'ct' <> 'deadbeef05' THEN
    failed := failed || format('rewrap by the super_admin did not move the item: %s %s', s, pg_temp.v_item(tr1));
  END IF;
  s := vault_rewrap(u_o, a_acct, tr1, 'kold', '\xdeadbeef06'::bytea, v_iv, v_tg, 'knewer');
  n := n + 1;
  IF s || '|' || pg_temp.v_why(a_acct) IS DISTINCT FROM 'CONFLICT|rewrap:CONFLICT:'
     OR pg_temp.v_item(tr1)->>'key_id' <> 'knew' OR pg_temp.v_item(tr1)->>'ct' <> 'deadbeef05' THEN
    failed := failed || format('rewrap with a stale expected key id: %s %s', s, pg_temp.v_item(tr1));
  END IF;
  s := vault_rewrap(u_o, a_acct, 'vlt_' || repeat('h', 26), 'kold', '\xdeadbeef07'::bytea, v_iv, v_tg, 'knew');
  n := n + 1;
  IF s || '|' || pg_temp.v_why(a_acct) IS DISTINCT FROM 'NOT_FOUND|rewrap:NOT_FOUND:' THEN
    failed := failed || format('rewrap of an unknown token: %s', s);
  END IF;
  c0 := pg_temp.v_audits(a_acct);
  s := vault_rewrap_failed(u_o, a_acct, tr2, 'kold');
  n := n + 1;
  IF s || '|' || pg_temp.v_why(a_acct) IS DISTINCT FROM 'OK|rewrap:DECRYPT_FAILED:' OR pg_temp.v_audits(a_acct) <> c0 + 1 THEN
    failed := failed || format('rewrap_failed by the super_admin did not write one audit row: %s', s);
  END IF;
  s := vault_rewrap_failed(u_a1, a_acct, tr2, 'kold');
  n := n + 1;
  IF s || '|' || pg_temp.v_why(a_acct) IS DISTINCT FROM 'DENIED|rewrap:DENIED:NO_ROLE' OR pg_temp.v_audits(a_acct) <> c0 + 2 THEN
    failed := failed || format('rewrap_failed by an admin: %s', s);
  END IF;
  s := vault_rewrap_failed(u_o, a_acct, 'vlt_' || repeat('h', 26), 'kold');
  n := n + 1;
  IF s IS DISTINCT FROM 'NOT_FOUND' OR pg_temp.v_audits(a_acct) <> c0 + 2 THEN
    failed := failed || format('rewrap_failed of an unknown token wrote a row or was not NOT_FOUND: %s', s);
  END IF;
  -- reveal_failed: holders write one row, never counted as a reveal; others and unknown tokens write nothing
  s := vault_reveal_failed(u_a1, a_acct, t1);
  n := n + 1;
  IF s || '|' || pg_temp.v_why(a_acct) IS DISTINCT FROM 'OK|reveal_failed:DECRYPT_FAILED:' OR pg_temp.v_audits(a_acct) <> c0 + 3 THEN
    failed := failed || format('reveal_failed by an admin holder: %s', s);
  END IF;
  s := vault_reveal_failed(u_g, a_acct, t1);
  tx := vault_reveal_failed(u_a1, a_acct, 'vlt_' || repeat('h', 26));
  n := n + 1;
  IF s IS DISTINCT FROM 'DENIED' OR tx IS DISTINCT FROM 'NOT_FOUND' OR pg_temp.v_audits(a_acct) <> c0 + 3 THEN
    failed := failed || format('reveal_failed by an agent / of an unknown token: %s %s', s, tx);
  END IF;

  -- ---------- audit read ----------
  c0 := pg_temp.v_audits(a_acct);
  SELECT array_agg(c.id ORDER BY c.ord)::text, count(*), bool_and(c.account_id = a_acct) INTO s, c1, d
    FROM vault_audit_list(u_o, a_acct, 500) WITH ORDINALITY
         c(id, at, action, outcome, actor, account_id, token, kind, subject_type, subject_id, reason, detail, ord);
  n := n + 1;
  IF c1 <> c0 OR d IS NOT TRUE OR s IS DISTINCT FROM pg_temp.v_q(format(
       'SELECT array_agg(id ORDER BY at DESC, id DESC)::text FROM vault_audit WHERE account_id = %L', a_acct)) THEN
    failed := failed || format('vault_audit_list for a super_admin is not the account''s rows newest first (%s of %s)', c1, c0);
  END IF;
  n := n + 1;
  IF (SELECT count(*) FROM vault_audit_list(u_a1, a_acct)) = 0 THEN
    failed := failed || 'vault_audit_list for an admin holder is empty'::text;
  END IF;
  n := n + 1;
  IF (SELECT count(*) FROM vault_audit_list(u_g, a_acct, 500)) <> 0 OR (SELECT count(*) FROM vault_audit_list(u_a4, a_acct, 500)) <> 0
     OR (SELECT count(*) FROM vault_audit_list(u_o2, a_acct, 500)) <> 0 OR pg_temp.v_audits(a_acct) <> c0 THEN
    failed := failed || 'vault_audit_list returned rows to a non-holder, or a read was audited'::text;
  END IF;
  WHILE pg_temp.v_audits(a_acct) < 520 LOOP
    PERFORM vault_put(u_o, a_acct, 'EID', v_ct, v_iv, v_tg, 'k1', pg_temp.v_bi('pad'), 'deal', gen_random_uuid());
  END LOOP;
  n := n + 1;
  IF (SELECT count(*) FROM vault_audit_list(u_o, a_acct, 1000)) <> 500 OR (SELECT count(*) FROM vault_audit_list(u_o, a_acct, 0)) <> 1
     OR (SELECT count(*) FROM vault_audit_list(u_o, a_acct, -5)) <> 1 OR (SELECT count(*) FROM vault_audit_list(u_o, a_acct, NULL)) <> 100
     OR (SELECT count(*) FROM vault_audit_list(u_o, a_acct)) <> 100 THEN
    failed := failed || 'vault_audit_list limit is not clamped to 1..500 (NULL / default 100)'::text;
  END IF;
  -- vault_overview: the holder sees every active role, anyone else nothing; never audited
  c0 := pg_temp.v_audits(a_acct);
  n := n + 1;
  IF (vault_overview(u_o, a_acct) ->> 'bootstrap_available')::boolean IS DISTINCT FROM false
     OR vault_overview(u_o, a_acct) ->> 'my_role' IS DISTINCT FROM 'super_admin'
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(vault_overview(u_o, a_acct) -> 'roles') e
                     WHERE e ->> 'user_id' = u_o::text AND e ->> 'role' = 'super_admin' AND (e ->> 'counts')::boolean)
     OR jsonb_array_length(vault_overview(u_o, a_acct) -> 'roles')
        <> pg_temp.v_q(format('SELECT count(*) FROM vault_roles WHERE account_id = %L AND revoked_at IS NULL', a_acct))::int THEN
    failed := failed || format('vault_overview for the super_admin is not the account''s active roles (%s)', vault_overview(u_o, a_acct));
  END IF;
  n := n + 1;
  IF vault_overview(u_a1, a_acct) ->> 'my_role' IS DISTINCT FROM 'admin' THEN
    failed := failed || format('vault_overview does not report the admin holder''s role (%s)', vault_overview(u_a1, a_acct));
  END IF;
  n := n + 1;
  IF vault_overview(u_g, a_acct) IS DISTINCT FROM '{"bootstrap_available": false, "my_role": null, "roles": []}'::jsonb
     OR vault_overview(u_o2, a_acct) IS DISTINCT FROM '{"bootstrap_available": false, "my_role": null, "roles": []}'::jsonb THEN
    failed := failed || format('vault_overview showed roles to a non-holder (%s / %s)', vault_overview(u_g, a_acct), vault_overview(u_o2, a_acct));
  END IF;
  n := n + 1;
  IF pg_temp.v_audits(a_acct) <> c0 THEN
    failed := failed || 'a vault_overview read was audited'::text;
  END IF;
  tx := pg_temp.v_try('service_role', format('SELECT vault_overview(NULL, %L)::text', a_acct));
  n := n + 1;
  IF tx NOT LIKE 'ERROR 22023%' THEN failed := failed || format('vault_overview with a NULL actor was not 22023 (%s)', tx); END IF;
  -- the audit never holds a blind index (64 hex) or a ciphertext
  n := n + 1;
  IF pg_temp.v_q('SELECT count(*) FROM vault_audit a WHERE a::text ~ ''[0-9a-f]{64}'' OR a::text ~* ''deadbeef''') <> '0' THEN
    failed := failed || 'an audit row holds a blind index or ciphertext'::text;
  END IF;

  -- ---------- locks (as the owner) ----------
  RESET ROLE;
  FOREACH s IN ARRAY ARRAY['UPDATE vault_audit SET reason = ''x''', 'DELETE FROM vault_audit', 'TRUNCATE vault_audit'] LOOP
    tx := pg_temp.v_try(NULL, s);
    n := n + 1;
    IF tx NOT LIKE 'ERROR 42501%' THEN failed := failed || format('vault_audit is not append-only for the owner: %s (%s)', s, tx); END IF;
  END LOOP;
  FOREACH s IN ARRAY ARRAY[
      format('UPDATE vault_items SET token = %L WHERE token = %L', 'vlt_' || repeat('k', 26), t2),
      format('UPDATE vault_items SET kind = ''IBAN'' WHERE token = %L', t2),
      format('UPDATE vault_items SET blind_index = %L WHERE token = %L', pg_temp.v_bi('other'), t2),
      format('UPDATE vault_items SET account_id = %L WHERE token = %L', b_acct, t2),
      format('UPDATE vault_items SET subject_type = ''case'' WHERE token = %L', t2),
      format('UPDATE vault_items SET subject_id = gen_random_uuid() WHERE token = %L', t2),
      'DELETE FROM vault_items', 'TRUNCATE vault_items'] LOOP
    tx := pg_temp.v_try(NULL, s);
    n := n + 1;
    IF tx NOT LIKE 'ERROR 42501%' THEN failed := failed || format('vault_items guard let the owner through: %s (%s)', s, tx); END IF;
  END LOOP;
  FOREACH s IN ARRAY ARRAY['DELETE FROM vault_roles', 'TRUNCATE vault_roles', 'UPDATE vault_roles SET role = ''super_admin'' WHERE role = ''admin'''] LOOP
    tx := pg_temp.v_try(NULL, s);
    n := n + 1;
    IF tx NOT LIKE 'ERROR 42501%' THEN failed := failed || format('vault_roles guard let the owner through: %s (%s)', s, tx); END IF;
  END LOOP;

  -- ---------- grants ----------
  n := n + 1;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['service_role', 'anon', 'authenticated']) rl,
                           unnest(ARRAY['public.vault_items', 'public.vault_roles', 'public.vault_audit']) tbl
              WHERE has_table_privilege(rl, tbl, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                 OR has_any_column_privilege(rl, tbl, 'SELECT, INSERT, UPDATE, REFERENCES'))
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['service_role', 'anon', 'authenticated']) rl,
                              unnest(ARRAY['public.vault_roles_id_seq', 'public.vault_audit_id_seq']) sq
                 WHERE has_sequence_privilege(rl, sq, 'USAGE, SELECT, UPDATE')) THEN
    failed := failed || 'service_role / anon / authenticated hold a privilege on a vault table or sequence'::text;
  END IF;
  tx := pg_temp.v_try('service_role', 'SELECT count(*)::text FROM vault_items');
  n := n + 1;
  IF tx NOT LIKE 'ERROR 42501%' THEN failed := failed || format('service_role read vault_items (%s)', tx); END IF;
  n := n + 1;
  IF (SELECT array_agg(p.proname::text ORDER BY p.proname) FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'vault\_%'
         AND has_function_privilege('service_role', p.oid, 'EXECUTE'))
     IS DISTINCT FROM ARRAY['vault_audit_list', 'vault_delete', 'vault_overview', 'vault_put', 'vault_reveal', 'vault_reveal_failed', 'vault_rewrap',
                            'vault_rewrap_candidates', 'vault_rewrap_failed', 'vault_role_bootstrap', 'vault_role_grant', 'vault_role_revoke'] THEN
    failed := failed || 'service_role does not execute exactly the 12 vault API functions'::text;
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'vault\_%'
                AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')))
     OR EXISTS (SELECT 1 FROM pg_proc p, unnest(ARRAY['service_role', 'anon', 'authenticated']) rl
                 WHERE p.pronamespace = 'public'::regnamespace
                   AND p.proname IN ('vault_new_token', 'vault_live_profile', 'vault_has_role', 'vault_reason_problem', 'vault_audit_role',
                                     'vault_audit_text', 'vault_items_guard', 'vault_roles_guard', 'vault_append_only')
                   AND has_function_privilege(rl, p.oid, 'EXECUTE'))
     OR (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
            AND p.proname IN ('vault_new_token', 'vault_live_profile', 'vault_has_role', 'vault_reason_problem', 'vault_audit_role',
                              'vault_audit_text', 'vault_items_guard', 'vault_roles_guard', 'vault_append_only')) <> 9 THEN
    failed := failed || 'anon / authenticated execute a vault function, or an API role executes a helper'::text;
  END IF;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT121', MESSAGE = 'verify-vault rollback';
  EXCEPTION WHEN SQLSTATE 'ZT121' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'vault verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'vault verification passed (% checks)', n;
END
$verify$;
