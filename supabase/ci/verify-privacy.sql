-- Behavioural regression suite for the PDPL work (migrations 221-223).
--
-- 221: privacy_subject_export is owners and admins only, confined to the
-- account, strips staff ids and storage locations, and logs one
-- privacy_requests row with a hash, never the contact id.
--
-- ONE statement on purpose: `supabase db query --file` sends the file as
-- a single prepared statement and rejects several. Fixtures are rolled
-- back by a sentinel exception; failures are named in the final one.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000221001';
  u_admin  UUID := '00000000-0000-4000-8000-000000221002';
  u_agent  UUID := '00000000-0000-4000-8000-000000221003';
  u_bown   UUID := '00000000-0000-4000-8000-000000221004';
  a_acct   UUID;
  b_acct   UUID;
  c1       UUID;
  c_b      UUID;
  v1       UUID;
  j        JSONB;
  v        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.pv_try(p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; h text;
    BEGIN
      BEGIN
        IF p_sql ILIKE 'select%' THEN EXECUTE p_sql INTO v; ELSE EXECUTE p_sql; END IF;
        RETURN coalesce(v, 'ok');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
        RETURN 'ERROR ' || SQLSTATE || ' ' || coalesce(nullif(h, ''), '-') || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.pv_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'pv-owner@example.invalid'), (u_admin, 'pv-admin@example.invalid'),
    (u_agent, 'pv-agent@example.invalid'), (u_bown, 'pv-bown@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_bown;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent;
  INSERT INTO contacts (account_id, user_id, phone, name, email) VALUES (a_acct, u_agent, '971500221001', 'PV one', 'pv@example.invalid')
    RETURNING id INTO c1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (b_acct, u_bown, '971500221002', 'PV other')
    RETURNING id INTO c_b;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_agent, c1) RETURNING id INTO v1;
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_type, content_text, media_url)
  VALUES (v1, 'customer', NULL, 'text', 'hello, my passport is attached', NULL),
         (v1, 'agent', u_agent, 'image', 'here you go', 'https://x.invalid/chat-media/a.jpg');
  INSERT INTO contact_notes (contact_id, user_id, account_id, note_text) VALUES (c1, u_agent, a_acct, 'prefers Arabic');

  -- ---------- 221: export ----------
  n := n + 1; failed := failed || pg_temp.pv_ok(
    pg_temp.pv_try(format('SELECT privacy_subject_export(%L, %L, %L)::text', u_agent, a_acct, c1)) LIKE 'ERROR % NOT_ALLOWED:%',
    'an agent exported a customer');
  n := n + 1; failed := failed || pg_temp.pv_ok(
    privacy_subject_export(u_owner, a_acct, c_b) IS NULL, 'another account''s contact was exported');
  j := privacy_subject_export(u_admin, a_acct, c1);
  n := n + 1; failed := failed || pg_temp.pv_ok(j->'data'->'contact'->>'name' = 'PV one'
    AND j->'data'->'contact'->>'email' = 'pv@example.invalid', 'the export lacks the contact');
  n := n + 1; failed := failed || pg_temp.pv_ok(
    jsonb_array_length(j->'data'->'conversations'->0->'messages') = 2
    AND j->'data'->'conversations'->0->'messages'->0->>'content_text' LIKE 'hello%',
    'the export lacks the messages');
  n := n + 1; failed := failed || pg_temp.pv_ok(
    j->'data'->'notes'->0->>'note_text' = 'prefers Arabic', 'the export lacks the notes');
  v := j::text;
  n := n + 1; failed := failed || pg_temp.pv_ok(
    position(u_agent::text IN v) = 0 AND position('chat-media' IN v) = 0 AND position(a_acct::text IN v) = 0,
    'the export carries a staff id, a storage URL or the account id');
  n := n + 1; failed := failed || pg_temp.pv_ok(
    (SELECT count(*) FROM privacy_requests r WHERE r.account_id = a_acct AND r.kind = 'export'
      AND r.contact_hash = privacy_contact_hash(a_acct, c1) AND r.actor_id = u_admin
      AND position(c1::text IN r.detail::text) = 0) = 1,
    'the export was not logged once, by hash');
  n := n + 1; failed := failed || pg_temp.pv_ok(
    pg_temp.pv_try('UPDATE privacy_requests SET kind = ''erase''') LIKE 'ERROR %',
    'the request log took an UPDATE');
  n := n + 1; failed := failed || pg_temp.pv_ok(
    pg_temp.pv_try('SET LOCAL ROLE authenticated; SELECT count(*)::text FROM privacy_requests') LIKE 'ERROR 42501%',
    'authenticated read the request log');
  RESET ROLE;

  RAISE EXCEPTION USING ERRCODE = 'ZT221', MESSAGE = 'verify-privacy rollback';
  EXCEPTION WHEN SQLSTATE 'ZT221' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'privacy verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'privacy verification passed (% checks)', n;
END
$verify$;
