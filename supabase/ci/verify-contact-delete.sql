-- Behavioural suite for migration 280: an opt-out outlives its contact and
-- comes back with the number, lifting it clears it, and open work refuses
-- the delete for a person (not for the service or an account deletion).
-- ONE statement; fixtures rolled back by a sentinel; failures are named.
DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000280001';
  u_agent UUID := '00000000-0000-4000-8000-000000280002';
  u_bown  UUID := '00000000-0000-4000-8000-000000280003';
  a_acct UUID; b_acct UUID; c UUID; c2 UUID; c3 UUID; g UUID; chan UUID; r UUID;
  s contact_suppressions%ROWTYPE;
  t0 TIMESTAMPTZ := '2026-01-02 03:04:05.678901+00';
  v TEXT; n INT := 0; j JSONB; failed TEXT[] := '{}'; f TEXT;
BEGIN
  BEGIN
  -- Both spellings: auth.uid()/auth.role() read either, by image.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.kd_claims(p_uid uuid, p_role text) RETURNS text[] LANGUAGE sql AS $body$
      SELECT ARRAY[set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true),
             set_config('request.jwt.claim.role', coalesce(p_role, ''), true),
             set_config('request.jwt.claims', CASE WHEN p_uid IS NULL THEN ''
               ELSE json_build_object('sub', p_uid, 'role', p_role)::text END, true)]
    $body$ $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.kd_as(p_uid uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; h text; d text;
    BEGIN
      PERFORM pg_temp.kd_claims(p_uid, 'authenticated');
      SET LOCAL ROLE authenticated;
      BEGIN
        IF p_sql ILIKE 'select%' OR p_sql ILIKE '%returning%' THEN EXECUTE p_sql INTO v; ELSE EXECUTE p_sql; END IF;
        v := coalesce(v, 'ok');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT, d = PG_EXCEPTION_DETAIL;
        v := 'ERROR ' || SQLSTATE || ' ' || coalesce(nullif(h, ''), '-') || ' ' || coalesce(d, '') || ': ' || SQLERRM;
      END;
      RESET ROLE;
      PERFORM pg_temp.kd_claims(NULL, NULL);
      RETURN v;
    END $body$ $fn$;

  INSERT INTO auth.users (id, email) VALUES (u_owner, 'kd-owner@example.invalid'),
    (u_agent, 'kd-agent@example.invalid'), (u_bown, 'kd-bown@example.invalid');
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_bown;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent;

  -- number forms
  n := n + 1;
  IF (SELECT count(DISTINCT contact_suppression_number(p)) FROM unnest(ARRAY['0501280001', '501280001',
        '+971 50 128 0001', '00971501280001', '9710501280001']) p) <> 1
     OR contact_suppression_number('97141234567') IS DISTINCT FROM contact_suppression_number('041234567')
     OR contact_suppression_number('erased-123456789012') IS NOT NULL OR contact_suppression_number('12345') IS NOT NULL
     OR contact_suppression_number('447700900123') <> '447700900123' THEN
    failed := failed || 'FORMS: the canonical number is wrong'::text; END IF;

  -- keep (an admin deletes), no number, no name
  INSERT INTO contacts (account_id, user_id, phone, name, opted_out_at, do_not_contact_at, do_not_contact_reason)
  VALUES (a_acct, u_agent, '+971 50 128 0001', 'KD Secretname', t0, t0, 'asked twice') RETURNING id INTO c;
  v := pg_temp.kd_as(u_owner, format('DELETE FROM contacts WHERE id = %L', c));
  SELECT * INTO s FROM contact_suppressions WHERE account_id = a_acct;
  n := n + 1;
  IF v <> 'ok' OR s.opted_out_at IS DISTINCT FROM t0 OR s.do_not_contact_at IS DISTINCT FROM t0
     OR s.do_not_contact_reason IS DISTINCT FROM 'asked twice' OR s.deleted_by IS DISTINCT FROM u_owner OR s.via <> 'delete'
     OR NOT jsonb_path_exists(s.consent_events, '$[*] ? (@.kind == "opted_out")')
     OR to_jsonb(s)::text ~ '(501280001|Secretname)' THEN
    failed := failed || format('KEEP: the opt-out of a deleted contact was not kept (%s, %s)', v, to_jsonb(s)); END IF;
  n := n + 1;
  IF has_table_privilege('service_role', 'contact_suppressions', 'SELECT') OR has_table_privilege('authenticated', 'contact_suppressions', 'SELECT')
     OR has_table_privilege('service_role', 'contact_suppression_keys', 'SELECT')
     OR pg_temp.kd_as(u_owner, 'SELECT count(*)::text FROM contact_suppressions') NOT LIKE 'ERROR 42501%'
     OR NOT (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'contact_suppressions'::regclass) THEN
    failed := failed || 'KEEP: the table is readable'::text; END IF;

  -- restore: an agent re-adds it in the local form; another account does not get it
  v := pg_temp.kd_as(u_agent, format('INSERT INTO contacts (account_id, user_id, phone, name) VALUES (%L, %L, ''0501280001'', ''again'')', a_acct, u_agent));
  SELECT x.id INTO c FROM contacts x WHERE x.account_id = a_acct AND x.phone = '0501280001';
  n := n + 1;
  IF v <> 'ok' OR NOT (SELECT opted_out_at = t0 AND do_not_contact_at = t0 AND do_not_contact_reason = 'asked twice' FROM contacts WHERE id = c) IS TRUE
  THEN failed := failed || format('RESTORE: a re-added number is not opted out (%s)', v); END IF;
  n := n + 1;
  IF (SELECT string_agg(kind, ',') FROM contact_consent_events WHERE contact_id = c) IS DISTINCT FROM 'restored' THEN
    failed := failed || format('RESTORE: not exactly one restored event (%s)',
      (SELECT string_agg(kind, ',') FROM contact_consent_events WHERE contact_id = c)); END IF;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (b_acct, u_bown, '971501280001', 'KD b') RETURNING id INTO c2;
  n := n + 1;
  IF (SELECT opted_out_at FROM contacts WHERE id = c2) IS NOT NULL THEN failed := failed || 'RESTORE: crossed accounts'::text; END IF;
  -- a contact given the number
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971501280009', 'KD p') RETURNING id INTO c2;
  UPDATE contacts SET phone = '971501280001' WHERE id = c2;
  n := n + 1;
  IF NOT (SELECT opted_out_at = t0 FROM contacts WHERE id = c2) IS TRUE
     OR (SELECT string_agg(kind, ',') FROM contact_consent_events WHERE contact_id = c2) IS DISTINCT FROM 'restored' THEN
    failed := failed || 'RESTORE: a contact given the number is not opted out, or not logged once'::text; END IF;
  -- a fresh contact of another number is untouched and silent
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971501280010', 'KD q') RETURNING id INTO c3;
  n := n + 1;
  IF (SELECT opted_out_at FROM contacts WHERE id = c3) IS NOT NULL OR EXISTS (SELECT 1 FROM contact_consent_events WHERE contact_id = c3) THEN
    failed := failed || 'RESTORE: a stranger was stamped'::text; END IF;

  -- lift: one stamp at a time, by an admin
  v := pg_temp.kd_as(u_owner, format('UPDATE contacts SET opted_out_at = NULL WHERE id = %L', c));
  SELECT * INTO s FROM contact_suppressions WHERE account_id = a_acct;
  n := n + 1;
  IF v <> 'ok' OR s.opted_out_at IS NOT NULL OR s.do_not_contact_at IS DISTINCT FROM t0 THEN
    failed := failed || format('LIFT: the kept opt-out was not cleared alone (%s, %s)', v, to_jsonb(s)); END IF;
  UPDATE contacts SET do_not_contact_at = NULL, do_not_contact_reason = NULL WHERE id = c;
  DELETE FROM contacts WHERE id IN (c, c3);
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '501280001', 'KD third') RETURNING id INTO c;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM contact_suppressions WHERE account_id = a_acct)
     OR (SELECT opted_out_at IS NOT NULL OR do_not_contact_at IS NOT NULL FROM contacts WHERE id = c) THEN
    failed := failed || 'LIFT: a lifted stamp came back'::text; END IF;

  -- erase: kept with no reason and no actor; an open room does not refuse it
  INSERT INTO contacts (account_id, user_id, phone, name, opted_out_at, do_not_contact_at, do_not_contact_reason)
  VALUES (a_acct, u_agent, '971501280020', 'KD erased', t0, t0, 'reason Secretname') RETURNING id INTO c;
  INSERT INTO chat_channels (account_id, kind, name, created_by) VALUES (a_acct, 'deal_room', 'kd-room', u_owner) RETURNING id INTO chan;
  INSERT INTO deal_rooms (account_id, channel_id, contact_id, subject, status) VALUES (a_acct, chan, c, 'KD room', 'open') RETURNING id INTO r;
  j := privacy_subject_erase(u_owner, a_acct, c, false, 'ERASE ' || c);
  SELECT * INTO s FROM contact_suppressions WHERE account_id = a_acct;
  n := n + 1;
  IF j ->> 'mode' IS DISTINCT FROM 'erase' OR s.opted_out_at IS DISTINCT FROM t0 OR s.via <> 'erase' OR s.do_not_contact_reason IS NOT NULL
     OR s.deleted_by IS NOT NULL OR to_jsonb(s)::text ~ '(501280020|Secretname)' THEN
    failed := failed || format('ERASE: an erased person''s opt-out is not kept by hash alone (%s)', to_jsonb(s)); END IF;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '0501280020', 'KD back') RETURNING id INTO c2;
  n := n + 1;
  IF (SELECT opted_out_at FROM contacts WHERE id = c2) IS DISTINCT FROM t0 THEN failed := failed || 'ERASE: the number came back without its opt-out'::text; END IF;
  n := n + 1;
  j := privacy_subject_export(u_owner, a_acct, c2);
  IF position('"via": "erase"' IN j::text) = 0 OR position('phone_hash' IN j::text) > 0 THEN
    failed := failed || 'EXPORT: the kept opt-out is not exported, or with its hash'::text; END IF;

  -- guard: room, group, case; a person is refused, the service is not
  n := n + 1; v := pg_temp.kd_as(u_owner, format('DELETE FROM contacts WHERE id = %L', c));
  IF v NOT LIKE 'ERROR ZC280 HAS_OPEN_WORK {"cases": 0, "deal_rooms": 1, "submission_groups": 0}: %deal rooms: 1%' THEN
    failed := failed || format('GUARD: an open deal room did not refuse (%s)', v); END IF;
  UPDATE deal_rooms SET status = 'closed' WHERE id = r;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971501280030', 'KD g') RETURNING id INTO c3;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'KD-280-A1', 'x', 'connected', true) RETURNING id INTO chan;
  INSERT INTO submission_groups (account_id, submission_ref, contact_id, channel_id)
  VALUES (a_acct, 'KD-280-1', c3, chan) RETURNING id INTO g;
  n := n + 1; v := pg_temp.kd_as(u_owner, format('DELETE FROM contacts WHERE id = %L', c3));
  IF v NOT LIKE 'ERROR ZC280 HAS_OPEN_WORK %"submission_groups": 1}:%' THEN failed := failed || format('GUARD: an active group did not refuse (%s)', v); END IF;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971501280031', 'KD k') RETURNING id INTO c2;
  INSERT INTO cases (account_id, contact_id, agent_id, stage) VALUES (a_acct, c2, u_agent, 'Interested');
  n := n + 1; v := pg_temp.kd_as(u_owner, format('DELETE FROM contacts WHERE id = %L', c2));
  IF v NOT LIKE 'ERROR ZC280 HAS_OPEN_WORK {"cases": 1,%' THEN failed := failed || format('GUARD: an open case did not refuse (%s)', v); END IF;
  -- preview: counts, blocked, and the same people as the delete
  n := n + 1; j := pg_temp.kd_as(u_owner, format('SELECT contact_delete_preview(ARRAY[%L, %L, %L]::uuid[])::text', c, c2, c3))::jsonb;
  IF j ->> 'contacts' <> '3' OR jsonb_array_length(j -> 'blocked') <> 2 OR j ->> 'cases' <> '1' OR j ->> 'deal_rooms' <> '1' THEN
    failed := failed || format('PREVIEW: wrong counts (%s)', j); END IF;
  n := n + 1; v := pg_temp.kd_as(u_bown, format('SELECT contact_delete_preview(ARRAY[%L]::uuid[])::text', c2));
  IF v::jsonb ->> 'contacts' <> '0' OR v::jsonb ->> 'cases' <> '0' OR v::jsonb -> 'blocked' <> '[]' THEN failed := failed || format('PREVIEW: another account counted (%s)', v); END IF;
  -- closed work does not refuse; nor does the service
  n := n + 1; v := pg_temp.kd_as(u_owner, format('DELETE FROM contacts WHERE id = %L', c));
  IF v <> 'ok' THEN failed := failed || format('GUARD: a closed deal room refused (%s)', v); END IF;
  n := n + 1;
  PERFORM pg_temp.kd_claims(u_owner, 'service_role');
  BEGIN DELETE FROM contacts WHERE id = c2;
  EXCEPTION WHEN OTHERS THEN failed := failed || format('BYPASS service: %s', SQLERRM); END;
  PERFORM pg_temp.kd_claims(NULL, NULL);
  n := n + 1;
  BEGIN DELETE FROM contacts WHERE id = c3;
  EXCEPTION WHEN OTHERS THEN failed := failed || format('BYPASS no user: %s', SQLERRM); END;

  -- the whole account goes, signed in: neither refused nor kept.
  -- (An account with rooms or cases cannot be deleted at all: their own FKs refuse.)
  INSERT INTO contacts (account_id, user_id, phone, name, opted_out_at) VALUES (b_acct, u_bown, '971501280040', 'KD acct', t0) RETURNING id INTO c;
  n := n + 1;
  PERFORM pg_temp.kd_claims(u_bown, 'authenticated');
  BEGIN
    DELETE FROM profiles WHERE account_id = b_acct;
    DELETE FROM accounts WHERE id = b_acct;
    IF EXISTS (SELECT 1 FROM contacts WHERE account_id = b_acct) OR EXISTS (SELECT 1 FROM contact_suppressions WHERE account_id = b_acct) THEN
      failed := failed || 'BYPASS account: rows left'::text; END IF;
  EXCEPTION WHEN OTHERS THEN failed := failed || format('BYPASS account: %s', SQLERRM); END;
  PERFORM pg_temp.kd_claims(NULL, NULL);

  RAISE EXCEPTION USING ERRCODE = 'ZZ280', MESSAGE = 'rollback';
  EXCEPTION WHEN SQLSTATE 'ZZ280' THEN NULL;
  END;
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'verify-contact-delete: % of % failed: %', array_length(failed, 1), n, array_to_string(failed, '; ');
  END IF;
  RAISE NOTICE 'verify-contact-delete: % checks passed', n;
END $verify$;
