-- Behavioural regression suite for the workspace audit log (migration 092).
--
-- workspace_audit is filled by AFTER triggers on profiles and accounts,
-- so whoever makes a change (a member RPC, PATCH /api/account, the
-- service role, a hand-run UPDATE) leaves exactly one row per tracked
-- change, with the actor auth.uid() names (NULL for the server). This
-- asserts each tracked change's row (account, actor, action, target,
-- detail), that a move between accounts logs member_removed in the old
-- one and member_added in the new one, that workspace switches and
-- untracked columns log nothing, that an account delete still cascades
-- past the append-only guard while nobody (the table owner included)
-- can UPDATE, DELETE or TRUNCATE a row, and that only the workspace's
-- live owners and admins, in their active workspace, can read it. Also
-- 092's grant fix: an admin may now UPDATE accounts.short_name and
-- internal_chat_enabled, an agent still changes nothing (RLS), and
-- owner_user_id and id stay ungranted.
--
-- Every row a transaction writes has the same `at` (now()), so new rows
-- are told apart by id: pg_temp.wa_seen holds every id already checked,
-- and pg_temp.wa_step compares the rows not in it with the expected set,
-- then marks them seen.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_own   UUID := '00000000-0000-4000-8000-000000092001';  -- owner of A (until the transfer)
  u_adm   UUID := '00000000-0000-4000-8000-000000092002';  -- admin of A, agent in B
  u_agt   UUID := '00000000-0000-4000-8000-000000092003';  -- agent of A
  u_gst   UUID := '00000000-0000-4000-8000-000000092004';  -- bank guest of A
  u_ob    UUID := '00000000-0000-4000-8000-000000092005';  -- owner of B
  u_bad   UUID := '00000000-0000-4000-8000-000000092006';  -- admin of B
  u_mv    UUID := '00000000-0000-4000-8000-000000092007';  -- agent of A, only membership
  u_mul   UUID := '00000000-0000-4000-8000-000000092008';  -- agent of A and of B
  u_new   UUID := '00000000-0000-4000-8000-000000092009';  -- new login, provisioned into A
  u_red   UUID := '00000000-0000-4000-8000-000000092010';  -- new login, redeems an invitation to A
  users   UUID[];
  a_acct  UUID;
  b_acct  UUID;
  f_acct  UUID;   -- the fresh account remove_account_member moves u_mv to
  home    UUID;   -- a person's personal account (handle_new_user)
  old_name  TEXT;
  old_short TEXT;
  v_chat    BOOLEAN;
  a_n     INT;
  b_n     INT;
  fp      TEXT;
  r       TEXT;
  want    TEXT;
  f       TEXT;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  IF to_regclass('public.workspace_audit') IS NULL THEN
    RAISE EXCEPTION 'workspace audit verification: public.workspace_audit does not exist (migration 092 not applied)';
  END IF;

  BEGIN
  -- Run a statement as p_role (a signed-in user when p_uid is given);
  -- 'ok', or the error as 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.wa_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', p_role)::text, true);
        EXECUTE format('SET LOCAL ROLE %I', p_role);
        EXECUTE p_sql;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ok';
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;

  -- The value of a one-column query run as a signed-in user ('null' for
  -- NULL), or the error as 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.wa_val(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
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
        RETURN coalesce(v, 'null');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;

  -- A statement run as this session's own role (the migration owner, so
  -- privileges and RLS stand aside and only 092's triggers can refuse).
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.wa_self(p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    BEGIN
      EXECUTE p_sql;
      RETURN 'ok';
    EXCEPTION WHEN OTHERS THEN
      RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
    END $body$
  $fn$;

  -- One audit row as text: account|actor|action|target|detail ('-' for NULL).
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.wa_row(p_acct uuid, p_actor uuid, p_action text, p_target uuid,
                                   p_detail jsonb DEFAULT '{}'::jsonb)
    RETURNS text LANGUAGE sql IMMUTABLE AS $body$
      SELECT concat_ws('|', p_acct, coalesce(p_actor::text, '-'), p_action,
                       coalesce(p_target::text, '-'), p_detail::text)
    $body$
  $fn$;

  -- A set of rows, sorted (one transaction's rows share `at`, so order
  -- is not observable).
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.wa_set(VARIADIC p text[])
    RETURNS text LANGUAGE sql IMMUTABLE AS $body$
      SELECT coalesce(string_agg(x, ' ; ' ORDER BY x), '') FROM unnest(p) AS x
    $body$
  $fn$;

  -- Compares the rows written since the last step with p_want (a
  -- wa_set, '' for none) and the step's result with the LIKE pattern
  -- p_want_r, marks those rows seen, and returns the failure or NULL.
  CREATE TEMP TABLE wa_seen (id uuid PRIMARY KEY);
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.wa_step(p_label text, p_r text, p_want_r text, p_want text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE got text;
    BEGIN
      SELECT coalesce(string_agg(x, ' ; ' ORDER BY x), '') INTO got
        FROM (SELECT pg_temp.wa_row(w.account_id, w.actor_id, w.action, w.target_user_id, w.detail) AS x
                FROM public.workspace_audit w
               WHERE NOT EXISTS (SELECT 1 FROM pg_temp.wa_seen s WHERE s.id = w.id)) q;
      INSERT INTO pg_temp.wa_seen SELECT id FROM public.workspace_audit ON CONFLICT DO NOTHING;
      IF p_r IS NULL OR p_want_r IS NULL OR p_r NOT LIKE p_want_r OR got IS DISTINCT FROM p_want THEN
        RETURN format('%s: %s (want %s); logged [%s], want [%s]', p_label, p_r, p_want_r, got, p_want);
      END IF;
      RETURN NULL;
    END $body$
  $fn$;
  INSERT INTO pg_temp.wa_seen SELECT id FROM public.workspace_audit;

  -- ---------- 1. sign-up: handle_new_user's owner row ----------
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    (u_own, 'wa-owner-a@example.invalid', '{"full_name":"Audit Owner A"}'),
    (u_adm, 'wa-admin-a@example.invalid', '{"full_name":"Audit Admin"}'),
    (u_agt, 'wa-agent-a@example.invalid', '{"full_name":"Audit Agent"}'),
    (u_gst, 'wa-guest-a@example.invalid', '{"full_name":"Audit Guest"}'),
    (u_ob,  'wa-owner-b@example.invalid', '{"full_name":"Audit Owner B"}'),
    (u_bad, 'wa-admin-b@example.invalid', '{"full_name":"Audit Admin B"}'),
    (u_mv,  'wa-mover@example.invalid',   '{"full_name":"Audit Mover"}'),
    (u_mul, 'wa-multi@example.invalid',   '{"full_name":"Audit Multi"}'),
    (u_new, 'wa-new@example.invalid',     '{"full_name":"Audit New"}'),
    (u_red, 'wa-redeem@example.invalid',  '{"full_name":"Audit Redeemer"}')
  ON CONFLICT DO NOTHING;
  users := ARRAY[u_own, u_adm, u_agt, u_gst, u_ob, u_bad, u_mv, u_mul, u_new, u_red];
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_own;
  SELECT id INTO b_acct FROM accounts WHERE owner_user_id = u_ob;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct
     OR (SELECT count(*) FROM profiles WHERE user_id = ANY (users)) <> 10 THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  SELECT coalesce(string_agg(x, ' ; ' ORDER BY x), '') INTO want
    FROM (SELECT pg_temp.wa_row(a.id, NULL, 'member_added', u.id,
                   jsonb_build_object('role', 'owner', 'name', u.raw_user_meta_data->>'full_name')) AS x
            FROM auth.users u JOIN accounts a ON a.owner_user_id = u.id
           WHERE u.id = ANY (users)) q;
  f := pg_temp.wa_step('sign-up (handle_new_user, no JWT)', 'ok', 'ok', want);
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;

  -- ---------- 2. a hand-run move logs both sides ----------
  SELECT account_id INTO home FROM profiles WHERE user_id = u_adm;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_adm;
  f := pg_temp.wa_step('move (hand-run UPDATE)', 'ok', 'ok', pg_temp.wa_set(
    pg_temp.wa_row(home, NULL, 'member_removed', u_adm, '{"role": "owner", "name": "Audit Admin"}'),
    pg_temp.wa_row(a_acct, NULL, 'member_added', u_adm, '{"role": "admin", "name": "Audit Admin"}')));
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;

  -- Arriving as a guest: role and bank code are part of the new
  -- membership (member_added), not a role_changed or bank_changed.
  SELECT account_id INTO home FROM profiles WHERE user_id = u_gst;
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB'
   WHERE user_id = u_gst;
  f := pg_temp.wa_step('move (a bank guest arrives)', 'ok', 'ok', pg_temp.wa_set(
    pg_temp.wa_row(home, NULL, 'member_removed', u_gst, '{"role": "owner", "name": "Audit Guest"}'),
    pg_temp.wa_row(a_acct, NULL, 'member_added', u_gst,
                   '{"role": "bank_guest", "name": "Audit Guest", "bank_code": "ADCB"}')));
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;

  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agt, u_mv, u_mul);
  UPDATE profiles SET account_id = b_acct, account_role = 'admin' WHERE user_id = u_bad;
  INSERT INTO pg_temp.wa_seen SELECT id FROM workspace_audit ON CONFLICT DO NOTHING;

  -- A second membership (an INSERT, inactive).
  INSERT INTO profiles (user_id, full_name, email, account_id, account_role, is_active) VALUES
    (u_adm, 'Audit Admin', 'wa-admin-a@example.invalid', b_acct, 'agent', false),
    (u_mul, 'Audit Multi', 'wa-multi@example.invalid', b_acct, 'agent', false);
  f := pg_temp.wa_step('second membership (INSERT)', 'ok', 'ok', pg_temp.wa_set(
    pg_temp.wa_row(b_acct, NULL, 'member_added', u_adm, '{"role": "agent", "name": "Audit Admin"}'),
    pg_temp.wa_row(b_acct, NULL, 'member_added', u_mul, '{"role": "agent", "name": "Audit Multi"}')));
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;

  -- ---------- 3. a workspace switch (is_active flips) logs nothing ----------
  r := pg_temp.wa_val(u_adm, format('SELECT public.switch_account(%L)::text', b_acct));
  r := r || '/' || pg_temp.wa_val(u_adm, 'SELECT public.current_account_id()::text');
  f := pg_temp.wa_step('switch_account to B', r, b_acct || '/' || b_acct, '');
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;
  -- A's admin working in B (an agent there) reads neither A's rows nor B's.
  r := pg_temp.wa_val(u_adm, 'SELECT count(*)::text FROM public.workspace_audit');
  n := n + 1;
  IF r <> '0' THEN
    failed := array_append(failed, ('read: A''s admin while active in B (an agent there) sees ' || r || ' rows')::text);
  END IF;
  r := pg_temp.wa_val(u_adm, format('SELECT public.switch_account(%L)::text', a_acct));
  r := r || '/' || pg_temp.wa_val(u_adm, 'SELECT public.current_account_id()::text');
  f := pg_temp.wa_step('switch_account back to A', r, a_acct || '/' || a_acct, '');
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;

  -- ---------- 4. role changes ----------
  r := pg_temp.wa_try('authenticated', u_adm, format('SELECT public.set_member_role(%L, ''viewer'')', u_agt));
  f := pg_temp.wa_step('set_member_role agent -> viewer', r, 'ok', pg_temp.wa_set(
    pg_temp.wa_row(a_acct, u_adm, 'role_changed', u_agt, '{"from": "agent", "to": "viewer"}')));
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;
  r := pg_temp.wa_try('authenticated', u_adm, format('SELECT public.set_member_role(%L, ''agent'')', u_agt));
  f := pg_temp.wa_step('set_member_role viewer -> agent', r, 'ok', pg_temp.wa_set(
    pg_temp.wa_row(a_acct, u_adm, 'role_changed', u_agt, '{"from": "viewer", "to": "agent"}')));
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;

  -- ---------- 5. deactivation ----------
  r := pg_temp.wa_try('authenticated', u_adm, format('SELECT public.set_member_active(%L, false)', u_agt));
  f := pg_temp.wa_step('set_member_active false', r, 'ok', pg_temp.wa_set(
    pg_temp.wa_row(a_acct, u_adm, 'member_deactivated', u_agt)));
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;
  r := pg_temp.wa_try('authenticated', u_adm, format('SELECT public.set_member_active(%L, false)', u_agt));
  f := pg_temp.wa_step('set_member_active false again (no change)', r, 'ok', '');
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;
  r := pg_temp.wa_try('authenticated', u_adm, format('SELECT public.set_member_active(%L, true)', u_agt));
  f := pg_temp.wa_step('set_member_active true', r, 'ok', pg_temp.wa_set(
    pg_temp.wa_row(a_acct, u_adm, 'member_reactivated', u_agt)));
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;

  -- ---------- 6. the service role; one UPDATE, two tracked changes ----------
  r := pg_temp.wa_try('service_role', NULL, format(
    'UPDATE public.profiles SET bank_code = ''FAB'', deactivated_at = now() WHERE user_id = %L AND account_id = %L',
    u_gst, a_acct));
  f := pg_temp.wa_step('service role: bank code and deactivation in one UPDATE', r, 'ok', pg_temp.wa_set(
    pg_temp.wa_row(a_acct, NULL, 'bank_changed', u_gst, '{"from": "ADCB", "to": "FAB"}'),
    pg_temp.wa_row(a_acct, NULL, 'member_deactivated', u_gst)));
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;
  r := pg_temp.wa_try('authenticated', u_adm, format('SELECT public.set_member_active(%L, true)', u_gst));
  f := pg_temp.wa_step('set_member_active true (guest)', r, 'ok', pg_temp.wa_set(
    pg_temp.wa_row(a_acct, u_adm, 'member_reactivated', u_gst)));
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;

  -- ---------- 7. untracked columns, and tracked ones set to themselves ----------
  UPDATE profiles
     SET full_name = 'Audit Agent Renamed', avatar_url = 'https://example.invalid/a.png',
         account_role = account_role, bank_code = bank_code, deactivated_at = deactivated_at
   WHERE user_id = u_agt;
  f := pg_temp.wa_step('untracked profile columns', 'ok', 'ok', '');
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;

  -- ---------- 8. workspace settings, as A's admin (RLS client) ----------
  SELECT name, short_name, internal_chat_enabled INTO old_name, old_short, v_chat
    FROM accounts WHERE id = a_acct;
  r := pg_temp.wa_try('authenticated', u_adm, format(
    'UPDATE public.accounts SET name = ''Audit A'' WHERE id = %L', a_acct));
  r := r || '/' || (SELECT name FROM accounts WHERE id = a_acct);
  f := pg_temp.wa_step('admin renames the workspace', r, 'ok/Audit A', pg_temp.wa_set(
    pg_temp.wa_row(a_acct, u_adm, 'workspace_renamed', NULL, jsonb_build_object('from', old_name, 'to', 'Audit A'))));
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;
  -- 092's grant: before it, short_name and internal_chat_enabled were
  -- "permission denied" for every client.
  r := pg_temp.wa_try('authenticated', u_adm, format(
    'UPDATE public.accounts SET short_name = ''AUD'' WHERE id = %L', a_acct));
  r := r || '/' || (SELECT short_name FROM accounts WHERE id = a_acct);
  f := pg_temp.wa_step('admin changes the short name (grant)', r, 'ok/AUD', pg_temp.wa_set(
    pg_temp.wa_row(a_acct, u_adm, 'short_name_changed', NULL, jsonb_build_object('from', old_short, 'to', 'AUD'))));
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;
  r := pg_temp.wa_try('authenticated', u_adm, format(
    'UPDATE public.accounts SET internal_chat_enabled = %L WHERE id = %L', NOT v_chat, a_acct));
  r := r || '/' || (SELECT internal_chat_enabled FROM accounts WHERE id = a_acct);
  f := pg_temp.wa_step('admin switches team chat (grant)', r, 'ok/' || (NOT v_chat), pg_temp.wa_set(
    pg_temp.wa_row(a_acct, u_adm, CASE WHEN v_chat THEN 'team_chat_disabled' ELSE 'team_chat_enabled' END, NULL)));
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;
  r := pg_temp.wa_try('authenticated', u_adm, format(
    'UPDATE public.accounts SET internal_chat_enabled = %L WHERE id = %L', v_chat, a_acct));
  r := r || '/' || (SELECT internal_chat_enabled FROM accounts WHERE id = a_acct);
  f := pg_temp.wa_step('admin switches team chat back', r, 'ok/' || v_chat, pg_temp.wa_set(
    pg_temp.wa_row(a_acct, u_adm, CASE WHEN v_chat THEN 'team_chat_enabled' ELSE 'team_chat_disabled' END, NULL)));
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;
  r := pg_temp.wa_try('authenticated', u_adm, format(
    'UPDATE public.accounts SET name = ''Audit A2'', short_name = ''AU2'' WHERE id = %L', a_acct));
  f := pg_temp.wa_step('one UPDATE renaming both', r, 'ok', pg_temp.wa_set(
    pg_temp.wa_row(a_acct, u_adm, 'workspace_renamed', NULL, '{"from": "Audit A", "to": "Audit A2"}'),
    pg_temp.wa_row(a_acct, u_adm, 'short_name_changed', NULL, '{"from": "AUD", "to": "AU2"}')));
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;
  r := pg_temp.wa_try('authenticated', u_adm, format(
    'UPDATE public.accounts SET name = name, short_name = short_name, internal_chat_enabled = internal_chat_enabled, updated_at = now() WHERE id = %L',
    a_acct));
  f := pg_temp.wa_step('accounts UPDATE changing nothing tracked', r, 'ok', '');
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;

  -- An agent holds the grant but not the policy: nothing changes.
  r := pg_temp.wa_try('authenticated', u_agt, format('UPDATE public.accounts SET short_name = ''ZZZ'' WHERE id = %L', a_acct))
    || ' | ' || pg_temp.wa_try('authenticated', u_agt, format('UPDATE public.accounts SET internal_chat_enabled = %L WHERE id = %L', NOT v_chat, a_acct))
    || ' | ' || pg_temp.wa_try('authenticated', u_agt, format('UPDATE public.accounts SET name = ''Hijack'' WHERE id = %L', a_acct));
  r := r || ' => ' || (SELECT name || '/' || short_name || '/' || internal_chat_enabled FROM accounts WHERE id = a_acct);
  f := pg_temp.wa_step('agent UPDATEs accounts (RLS)', r, 'ok | ok | ok => Audit A2/AU2/' || v_chat, '');
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;

  -- owner_user_id and id stay ungranted, even to the owner.
  r := pg_temp.wa_try('authenticated', u_own, format('UPDATE public.accounts SET owner_user_id = %L WHERE id = %L', u_adm, a_acct))
    || ' | ' || pg_temp.wa_try('authenticated', u_own, format('UPDATE public.accounts SET id = gen_random_uuid() WHERE id = %L', a_acct));
  f := pg_temp.wa_step('owner UPDATEs owner_user_id / id', r, 'ERROR 42501:% | ERROR 42501:%', '');
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;

  -- ---------- 9. ownership transfer ----------
  r := pg_temp.wa_try('authenticated', u_own, format('SELECT public.transfer_account_ownership(%L)', u_adm));
  f := pg_temp.wa_step('transfer_account_ownership', r, 'ok', pg_temp.wa_set(
    pg_temp.wa_row(a_acct, u_own, 'role_changed', u_own, '{"from": "owner", "to": "admin"}'),
    pg_temp.wa_row(a_acct, u_own, 'role_changed', u_adm, '{"from": "admin", "to": "owner"}'),
    pg_temp.wa_row(a_acct, u_own, 'ownership_transferred', u_adm, jsonb_build_object('from_user_id', u_own))));
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;

  -- ---------- 10. membership RPCs ----------
  -- remove_account_member of someone's only membership moves the row to
  -- a fresh account: removed from A, added (as viewer) there.
  r := pg_temp.wa_val(u_own, format('SELECT public.remove_account_member(%L)::text', u_mv));
  SELECT account_id INTO f_acct FROM profiles WHERE user_id = u_mv;
  f := pg_temp.wa_step('remove_account_member (only membership: moved)', r,
    CASE WHEN f_acct IS DISTINCT FROM a_acct THEN f_acct::text ELSE 'a fresh account' END, pg_temp.wa_set(
    pg_temp.wa_row(a_acct, u_own, 'member_removed', u_mv, '{"role": "agent", "name": "Audit Mover"}'),
    pg_temp.wa_row(f_acct, u_own, 'member_added', u_mv, '{"role": "viewer", "name": "Audit Mover"}')));
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;
  -- Someone with another membership: a DELETE; the promotion of their
  -- other row (an is_active flip) logs nothing.
  r := pg_temp.wa_val(u_own, format('SELECT public.remove_account_member(%L)::text', u_mul));
  -- (A separate statement: one expression reads with the snapshot taken
  -- before the RPC inside it ran.)
  r := r || '/' || (SELECT string_agg(account_id || ':' || is_active, ',') FROM profiles WHERE user_id = u_mul);
  f := pg_temp.wa_step('remove_account_member (a DELETE)', r, 'null/' || b_acct || ':true', pg_temp.wa_set(
    pg_temp.wa_row(a_acct, u_own, 'member_removed', u_mul, '{"role": "agent", "name": "Audit Multi"}')));
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;

  -- provision_account_member and redeem_invitation move a new login's
  -- empty personal row into A and delete that account: its rows (the
  -- sign-up's member_added and the move's member_removed) go with it,
  -- through the append-only guard, and A keeps the member_added.
  SELECT account_id INTO home FROM profiles WHERE user_id = u_new;
  r := pg_temp.wa_try('service_role', NULL, format(
    'SELECT public.provision_account_member(p_user_id => %L, p_account_id => %L, p_role => ''agent'')', u_new, a_acct));
  r := r || '/' || EXISTS (SELECT 1 FROM accounts WHERE id = home)
    || '/' || (SELECT count(*) FROM workspace_audit WHERE account_id = home);
  f := pg_temp.wa_step('provision_account_member (service role, new login)', r, 'ok/false/0', pg_temp.wa_set(
    pg_temp.wa_row(a_acct, NULL, 'member_added', u_new, '{"role": "agent", "name": "Audit New"}')));
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;

  INSERT INTO account_invitations (account_id, token_hash, role, expires_at)
  VALUES (a_acct, 'wa-092-invite', 'viewer', now() + interval '1 day');
  SELECT account_id INTO home FROM profiles WHERE user_id = u_red;
  r := pg_temp.wa_val(u_red, 'SELECT public.redeem_invitation(''wa-092-invite'')::text');
  r := r || '/' || EXISTS (SELECT 1 FROM accounts WHERE id = home)
    || '/' || (SELECT count(*) FROM workspace_audit WHERE account_id = home);
  f := pg_temp.wa_step('redeem_invitation (new login)', r, a_acct || '/false/0', pg_temp.wa_set(
    pg_temp.wa_row(a_acct, u_red, 'member_added', u_red, '{"role": "viewer", "name": "Audit Redeemer"}')));
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;

  -- Deleting an account with a member: its rows cascade away, and the
  -- profile that leaves with it is logged nowhere.
  SELECT id INTO home FROM accounts WHERE owner_user_id = u_agt;
  INSERT INTO profiles (user_id, full_name, email, account_id, account_role, is_active)
  VALUES (u_agt, 'Audit Agent Renamed', 'wa-agent-a@example.invalid', home, 'agent', false);
  f := pg_temp.wa_step('second membership (INSERT, no JWT)', 'ok', 'ok', pg_temp.wa_set(
    pg_temp.wa_row(home, NULL, 'member_added', u_agt, '{"role": "agent", "name": "Audit Agent Renamed"}')));
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;
  r := pg_temp.wa_self(format('DELETE FROM public.accounts WHERE id = %L', home));
  r := r || '/' || (SELECT count(*) FROM workspace_audit WHERE account_id = home)
    || '/' || (SELECT count(*) FROM profiles WHERE user_id = u_agt);
  f := pg_temp.wa_step('account delete cascades past the append-only guard', r, 'ok/0/1', '');
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;

  -- ---------- 11. who reads ----------
  SELECT count(*) FILTER (WHERE account_id = a_acct), count(*) FILTER (WHERE account_id = b_acct)
    INTO a_n, b_n FROM workspace_audit;
  n := n + 1;
  IF a_n < 20 OR b_n < 4 THEN
    failed := array_append(failed, format('read fixture: want 20+ rows in A and 4+ in B, found %s and %s', a_n, b_n));
  END IF;
  -- '<rows of the account>/<rows of any other account>'
  r := pg_temp.wa_val(u_adm, format(
    'SELECT count(*) FILTER (WHERE account_id = %1$L) || ''/'' || count(*) FILTER (WHERE account_id <> %1$L) FROM public.workspace_audit', a_acct));
  n := n + 1;
  IF r IS DISTINCT FROM a_n || '/0' THEN
    failed := array_append(failed, ('read: A''s owner (want ' || a_n || '/0): ' || r)::text);
  END IF;
  r := pg_temp.wa_val(u_own, format(
    'SELECT count(*) FILTER (WHERE account_id = %1$L) || ''/'' || count(*) FILTER (WHERE account_id <> %1$L) FROM public.workspace_audit', a_acct));
  n := n + 1;
  IF r IS DISTINCT FROM a_n || '/0' THEN
    failed := array_append(failed, ('read: A''s admin (want ' || a_n || '/0): ' || r)::text);
  END IF;
  r := pg_temp.wa_val(u_agt, 'SELECT count(*)::text FROM public.workspace_audit')
    || ' | ' || pg_temp.wa_val(u_gst, 'SELECT count(*)::text FROM public.workspace_audit')
    || ' | ' || pg_temp.wa_val(u_red, 'SELECT count(*)::text FROM public.workspace_audit');
  n := n + 1;
  IF r IS DISTINCT FROM '0 | 0 | 0' THEN
    failed := array_append(failed, ('read: A''s agent | bank guest | viewer see rows (want 0 | 0 | 0): ' || r)::text);
  END IF;
  r := pg_temp.wa_val(u_bad, format(
    'SELECT count(*) FILTER (WHERE account_id = %1$L) || ''/'' || count(*) FILTER (WHERE account_id <> %1$L) FROM public.workspace_audit', b_acct));
  n := n + 1;
  IF r IS DISTINCT FROM b_n || '/0' THEN
    failed := array_append(failed, ('read: B''s admin, B''s rows only (want ' || b_n || '/0): ' || r)::text);
  END IF;
  r := pg_temp.wa_try('anon', NULL, 'SELECT count(*) FROM public.workspace_audit');
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN
    failed := array_append(failed, ('read: anon (want 42501): ' || r)::text);
  END IF;

  -- ---------- 12. append-only ----------
  SELECT md5(string_agg(pg_temp.wa_row(account_id, actor_id, action, target_user_id, detail) || at, ',' ORDER BY id))
    INTO fp FROM workspace_audit;
  r := pg_temp.wa_try('authenticated', u_adm, format('UPDATE public.workspace_audit SET action = ''member_added'' WHERE account_id = %L', a_acct))
    || ' | ' || pg_temp.wa_try('authenticated', u_adm, format('DELETE FROM public.workspace_audit WHERE account_id = %L', a_acct))
    || ' | ' || pg_temp.wa_try('authenticated', u_adm, format(
         'INSERT INTO public.workspace_audit (account_id, actor_id, action) VALUES (%L, %L, ''workspace_renamed'')', a_acct, u_own))
    || ' | ' || pg_temp.wa_try('authenticated', u_adm, 'TRUNCATE public.workspace_audit');
  f := pg_temp.wa_step('A''s owner writes the log (UPDATE | DELETE | INSERT | TRUNCATE)', r,
    'ERROR 42501:% | ERROR 42501:% | ERROR 42501:% | ERROR 42501:%', '');
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;
  r := pg_temp.wa_try('service_role', NULL, format('UPDATE public.workspace_audit SET action = ''member_added'' WHERE account_id = %L', a_acct))
    || ' | ' || pg_temp.wa_try('service_role', NULL, format('DELETE FROM public.workspace_audit WHERE account_id = %L', a_acct))
    || ' | ' || pg_temp.wa_try('service_role', NULL, format(
         'INSERT INTO public.workspace_audit (account_id, action) VALUES (%L, ''workspace_renamed'')', a_acct))
    || ' | ' || pg_temp.wa_try('service_role', NULL, 'TRUNCATE public.workspace_audit');
  f := pg_temp.wa_step('service role writes the log (UPDATE | DELETE | INSERT | TRUNCATE)', r,
    'ERROR 42501:% | ERROR 42501:% | ERROR 42501:% | ERROR 42501:%', '');
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;
  -- The table owner passes privileges and RLS; only the trigger refuses.
  r := pg_temp.wa_self(format('UPDATE public.workspace_audit SET detail = ''{}'' WHERE account_id = %L', a_acct))
    || ' | ' || pg_temp.wa_self(format('DELETE FROM public.workspace_audit WHERE account_id = %L', a_acct))
    || ' | ' || pg_temp.wa_self('TRUNCATE public.workspace_audit');
  f := pg_temp.wa_step('table owner UPDATE | DELETE | TRUNCATE', r,
    'ERROR 42501: workspace_audit is append-only (UPDATE blocked) | ERROR 42501: workspace_audit is append-only (DELETE blocked) | ERROR 42501: workspace_audit is append-only (TRUNCATE blocked)',
    '');
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;
  n := n + 1;
  IF (SELECT md5(string_agg(pg_temp.wa_row(account_id, actor_id, action, target_user_id, detail) || at, ',' ORDER BY id))
        FROM workspace_audit) IS DISTINCT FROM fp THEN
    failed := array_append(failed, 'append-only: a row changed or disappeared'::text);
  END IF;

  -- ---------- 13. a deactivated admin reads nothing ----------
  r := pg_temp.wa_try('authenticated', u_adm, format('SELECT public.set_member_active(%L, false)', u_own));
  f := pg_temp.wa_step('owner deactivates an admin', r, 'ok', pg_temp.wa_set(
    pg_temp.wa_row(a_acct, u_adm, 'member_deactivated', u_own)));
  n := n + 1;
  IF f IS NOT NULL THEN failed := array_append(failed, f); END IF;
  r := pg_temp.wa_val(u_own, 'SELECT count(*)::text FROM public.workspace_audit');
  n := n + 1;
  IF r <> '0' THEN
    failed := array_append(failed, ('read: a deactivated admin of A sees ' || r || ' rows')::text);
  END IF;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT092', MESSAGE = 'verify-workspace-audit rollback';
  EXCEPTION WHEN SQLSTATE 'ZT092' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'workspace audit verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'workspace audit verification passed (% checks)', n;
END
$verify$;
