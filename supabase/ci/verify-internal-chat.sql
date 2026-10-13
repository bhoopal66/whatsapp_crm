-- Behavioural regression suite for internal chat (migration 087), part 1.
--
-- Ported from the 014b package's database tests (role matrix,
-- cross-workspace isolation, internal_chat_enabled = false, DMs,
-- threads, notifications, edit and delete, unread counts, search,
-- shared conversations), on this repo's names: workspace = accounts
-- row, membership = a non-deactivated profiles row, chat_channels /
-- chat_channel_members, account_id. Package role -> fixture user:
-- owner, admin, supervisor = team_leader, rm and rm2 = agent,
-- agent = viewer, bank_guest. Plus 087's own additions: deal rooms
-- (refused by chat_create_channel; a guest member sees the room, never
-- its Team notes), shared cards (snapshot and live fields only for
-- someone who can open the chat now, through chat_shared_cards and a
-- plain SELECT alike; other readers see that a card exists; no share
-- into a channel with a bank guest), cross-account sharing, system
-- posts (service role only, no notifications), the bell row mirrored
-- from chat_notifications and rewritten by an edit, and a person active
-- in another account still reading this account's channels and badges.
-- Since 102, chat_channels_with_guests, which keeps the automation step
-- Post to team chat away from channels with a bank guest.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. Each check is a
-- row (label, got, want-LIKE-pattern) in a temp table; failures are
-- named in the final exception (chat_delete_message returns the removed
-- attachment paths, so a clean delete reads '{}'). Every fixture is rolled back by a
-- sentinel exception; the collected results survive in variables.
-- Everything runs in one transaction, so now() never moves: unread
-- counts backdate joined_at instead of waiting.

DO $verify$
DECLARE
  u_own UUID := '00000000-0000-4000-8000-000000087001';
  u_adm UUID := '00000000-0000-4000-8000-000000087002';
  u_sup UUID := '00000000-0000-4000-8000-000000087003';
  u_rm  UUID := '00000000-0000-4000-8000-000000087004';
  u_rm2 UUID := '00000000-0000-4000-8000-000000087005';
  u_ag  UUID := '00000000-0000-4000-8000-000000087006';
  u_g   UUID := '00000000-0000-4000-8000-000000087007';
  u_po  UUID := '00000000-0000-4000-8000-000000087008';
  u_prm UUID := '00000000-0000-4000-8000-000000087009';
  u_pag UUID := '00000000-0000-4000-8000-000000087010';
  u_mx  UUID := '00000000-0000-4000-8000-000000087011';  -- active in B, also a member of A
  extras UUID[];
  a UUID; b UUID; uu UUID;
  t UUID; t2 UUID; p UUID; d UUID; d1 UUID; dr UUID;
  m UUID; m1 UUID; m2 UUID; root UUID; rep UUID; gone UUID; mr UUID; sm UUID;
  ar UUID; en UUID; ad UUID; tg UUID; tm UUID;
  k1 UUID; k2 UUID; kb UUID; cv1 UUID; cv2 UUID; cvb UUID;
  r TEXT; f1 TEXT; f2 TEXT; f3 TEXT; f4 TEXT;
  n INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  CREATE TEMP TABLE ic_checks (id serial, label text, got text, want text);
  -- Run p_sql (a SELECT) as p_role / p_uid: its first value as text,
  -- 'ok' when that is NULL or empty (void), or 'ERROR <sqlstate>: <msg>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ic(p_uid uuid, p_sql text, p_role text DEFAULT 'authenticated')
    RETURNS text LANGUAGE plpgsql AS $b$
    DECLARE v text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
        PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role)::text, true);
        EXECUTE format('SET LOCAL ROLE %I', p_role);
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
    END $b$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ck(p_label text, p_got text, p_want text) RETURNS void
    LANGUAGE sql AS $b$ INSERT INTO ic_checks (label, got, want) VALUES (p_label, p_got, p_want) $b$
  $fn$;
  -- A fixture step that must succeed and yield an id.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.must(p_got text) RETURNS uuid LANGUAGE plpgsql AS $b$
    BEGIN
      IF p_got !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'fixture step failed: %', p_got;
      END IF;
      RETURN p_got::uuid;
    END $b$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.mk(p_uid uuid, p_ws uuid, p_kind text, p_name text, p_members uuid[] DEFAULT '{}')
    RETURNS text LANGUAGE sql AS $b$
      SELECT pg_temp.ic(p_uid, format('SELECT public.chat_create_channel(%L, %L, %L, NULL, %L::uuid[])',
                                      p_ws, p_kind, p_name, p_members)) $b$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.dm(p_uid uuid, p_ws uuid, p_members uuid[]) RETURNS text LANGUAGE sql AS $b$
      SELECT pg_temp.ic(p_uid, format('SELECT public.chat_open_dm(%L, %L::uuid[])', p_ws, p_members)) $b$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.post(p_uid uuid, p_ch uuid, p_body text, p_root uuid DEFAULT NULL, p_share uuid DEFAULT NULL)
    RETURNS text LANGUAGE sql AS $b$
      SELECT pg_temp.ic(p_uid, format('SELECT public.chat_post_message(%L, %L, %L::uuid, %L::uuid)',
                                      p_ch, p_body, p_root, p_share)) $b$
  $fn$;
  -- Rows of p_from_where visible to p_uid.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cnt(p_uid uuid, p_from_where text) RETURNS text LANGUAGE sql AS $b$
      SELECT pg_temp.ic(p_uid, 'SELECT count(*) FROM ' || p_from_where) $b$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.srch(p_uid uuid, p_ws uuid, p_q text) RETURNS text LANGUAGE sql AS $b$
      SELECT pg_temp.ic(p_uid, format('SELECT coalesce(string_agg(message_id::text, '','' ORDER BY message_id), ''-'') FROM public.chat_search(%L, %L)', p_ws, p_q)) $b$
  $fn$;
  -- Notification kinds of message p_m for p_u ('-' for none); all kinds when p_u is NULL.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.nk(p_m uuid, p_u uuid DEFAULT NULL) RETURNS text LANGUAGE sql AS $b$
      SELECT coalesce(string_agg(kind, ',' ORDER BY kind), '-') FROM public.chat_notifications
       WHERE message_id = p_m AND (p_u IS NULL OR user_id = p_u) $b$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.card(p_uid uuid, p_m uuid) RETURNS text LANGUAGE sql AS $b$
      SELECT pg_temp.ic(p_uid, format('SELECT concat_ws(''/'', snapshot->>''contact_name'', can_open, coalesce(chat_tag->>''name'', ''-''), coalesce(status, ''-''), coalesce(last_message_at::text, ''-'')) FROM public.chat_shared_cards(ARRAY[%L]::uuid[])', p_m)) $b$
  $fn$;

  -- ---------- fixture: account A (seven roles + 8 extra agents), account B ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_own, 'ic-own@example.invalid'), (u_adm, 'ic-adm@example.invalid'), (u_sup, 'ic-sup@example.invalid'),
    (u_rm, 'ic-rm@example.invalid'), (u_rm2, 'ic-rm2@example.invalid'), (u_ag, 'ic-ag@example.invalid'),
    (u_g, 'ic-g@example.invalid'), (u_po, 'ic-po@example.invalid'), (u_prm, 'ic-prm@example.invalid'),
    (u_pag, 'ic-pag@example.invalid'), (u_mx, 'ic-mx@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT array_agg(('00000000-0000-4000-8000-0000000871' || lpad(i::text, 2, '0'))::uuid ORDER BY i)
    INTO extras FROM generate_series(1, 8) i;
  INSERT INTO auth.users (id, email) SELECT x, 'ic-' || x || '@example.invalid' FROM unnest(extras) x
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a FROM profiles WHERE user_id = u_own;
  SELECT account_id INTO b FROM profiles WHERE user_id = u_po;
  IF a IS NULL OR b IS NULL OR a = b THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a, account_role = 'admin' WHERE user_id = u_adm;
  UPDATE profiles SET account_id = a, account_role = 'team_leader' WHERE user_id = u_sup;
  UPDATE profiles SET account_id = a, account_role = 'agent' WHERE user_id IN (u_rm, u_rm2) OR user_id = ANY (extras);
  UPDATE profiles SET account_id = a, account_role = 'viewer' WHERE user_id = u_ag;
  UPDATE profiles SET account_id = a, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_g;
  UPDATE profiles SET account_id = b, account_role = 'agent' WHERE user_id IN (u_prm, u_pag, u_mx);
  INSERT INTO profiles (user_id, full_name, email, account_id, account_role, is_active)
  VALUES (u_mx, 'IC multi', 'ic-mx@example.invalid', a, 'agent', false);

  -- ================= role matrix =================
  FOREACH uu IN ARRAY ARRAY[u_own, u_adm, u_sup, u_rm, u_ag] LOOP
    t := pg_temp.must(pg_temp.mk(uu, a, 'team', 'team-' || uu));
    p := pg_temp.must(pg_temp.mk(uu, a, 'private', 'priv-' || uu));
    PERFORM pg_temp.ck('creator is admin of own team+private channel ' || uu,
      (SELECT string_agg(role, ',') FROM chat_channel_members WHERE user_id = uu AND channel_id IN (t, p)), 'admin,admin');
  END LOOP;
  PERFORM pg_temp.ck('guest creates team channel', pg_temp.mk(u_g, a, 'team', 'g1'), 'ERROR 42501:%bank guests cannot create channels%');
  PERFORM pg_temp.ck('guest creates private channel', pg_temp.mk(u_g, a, 'private', 'g2'), 'ERROR 42501:%bank guests cannot create channels%');
  PERFORM pg_temp.ck('guest opens DM', pg_temp.dm(u_g, a, ARRAY[u_rm]), 'ERROR 42501:%bank guests cannot open DMs%');
  PERFORM pg_temp.ck('chat_create_channel deal_room', pg_temp.mk(u_own, a, 'deal_room', 'dr'), 'ERROR 22023:%kind must be team or private%');

  t := pg_temp.must(pg_temp.mk(u_rm, a, 'team', 'vis-team'));
  p := pg_temp.must(pg_temp.mk(u_rm, a, 'private', 'vis-priv', ARRAY[u_rm2]));
  FOREACH uu IN ARRAY ARRAY[u_own, u_adm, u_sup, u_rm2, u_ag] LOOP
    PERFORM pg_temp.ck('non-guest sees team channel ' || uu, pg_temp.cnt(uu, format('public.chat_channels WHERE id = %L', t)), '1');
  END LOOP;
  PERFORM pg_temp.ck('guest sees team channel', pg_temp.cnt(u_g, format('public.chat_channels WHERE id = %L', t)), '0');
  PERFORM pg_temp.ck('member sees private channel', pg_temp.cnt(u_rm2, format('public.chat_channels WHERE id = %L', p)), '1');
  FOREACH uu IN ARRAY ARRAY[u_own, u_adm, u_sup, u_ag, u_g] LOOP
    PERFORM pg_temp.ck('non-member sees private channel ' || uu, pg_temp.cnt(uu, format('public.chat_channels WHERE id = %L', p)), '0');
  END LOOP;

  PERFORM pg_temp.ck('agent puts guest in private channel', pg_temp.mk(u_rm, a, 'private', 'rm-guest', ARRAY[u_g]), 'ERROR 42501:%bank guests can only be added%');
  PERFORM pg_temp.ck('owner puts guest in team channel', pg_temp.mk(u_own, a, 'team', 'team-guest', ARRAY[u_g]), 'ERROR 42501:%bank guests can only be added%');
  p := pg_temp.must(pg_temp.mk(u_sup, a, 'private', 'bank-room', ARRAY[u_g]));
  PERFORM pg_temp.ck('guest member role', (SELECT role FROM chat_channel_members WHERE channel_id = p AND user_id = u_g), 'guest');
  PERFORM pg_temp.ck('guest posts in its private channel', pg_temp.post(u_g, p, 'documents uploaded'), '________-____-____-____-____________');
  PERFORM pg_temp.ck('guest reads its private channel', pg_temp.cnt(u_g, format('public.internal_messages WHERE channel_id = %L', p)), '1');
  t := pg_temp.must(pg_temp.mk(u_rm, a, 'team', 'no-guests'));
  PERFORM pg_temp.ck('guest posts in team channel', pg_temp.post(u_g, t, 'hello'), 'ERROR 42501:%not a member of this channel%');

  p := pg_temp.must(pg_temp.mk(u_rm, a, 'private', 'secret', ARRAY[u_rm2]));
  PERFORM pg_temp.must(pg_temp.post(u_rm, p, 'private note'));
  d := pg_temp.must(pg_temp.dm(u_rm, a, ARRAY[u_ag]));
  PERFORM pg_temp.must(pg_temp.post(u_rm, d, 'dm note'));
  FOREACH uu IN ARRAY ARRAY[u_own, u_adm] LOOP
    PERFORM pg_temp.ck('owner/admin SELECT private messages ' || uu, pg_temp.cnt(uu, format('public.internal_messages WHERE channel_id = %L', p)), '0');
    PERFORM pg_temp.ck('owner/admin SELECT DM messages ' || uu, pg_temp.cnt(uu, format('public.internal_messages WHERE channel_id = %L', d)), '0');
  END LOOP;
  PERFORM pg_temp.ck('admin read, blank reason', pg_temp.ic(u_adm, format('SELECT count(*) FROM public.chat_admin_read_private(%L, %L)', p, '  ')), 'ERROR 22023:%reason of at least 5%');
  PERFORM pg_temp.ck('supervisor admin read', pg_temp.ic(u_sup, format('SELECT count(*) FROM public.chat_admin_read_private(%L, %L)', p, 'investigation')), 'ERROR 42501:%owner or admin%');
  PERFORM pg_temp.ck('agent admin read', pg_temp.ic(u_rm, format('SELECT count(*) FROM public.chat_admin_read_private(%L, %L)', p, 'investigation')), 'ERROR 42501:%owner or admin%');
  PERFORM pg_temp.ck('admin reads private channel', pg_temp.ic(u_adm, format('SELECT string_agg(body, ''|'') FROM public.chat_admin_read_private(%L, %L)', p, 'compliance review')), 'private note');
  PERFORM pg_temp.ck('owner reads DM', pg_temp.ic(u_own, format('SELECT string_agg(body, ''|'') FROM public.chat_admin_read_private(%L, %L)', d, 'lawful request')), 'dm note');
  PERFORM pg_temp.ck('admin read audited',
    (SELECT string_agg(actor_id || '/' || action || '/' || (detail->>'reason'), '|') FROM chat_audit_log WHERE channel_id = p),
    u_adm || '/admin_read_private/compliance review');
  PERFORM pg_temp.ck('DM read audited', (SELECT count(*)::text FROM chat_audit_log WHERE channel_id = d), '1');
  t := pg_temp.must(pg_temp.mk(u_rm, a, 'team', 'open'));
  PERFORM pg_temp.ck('admin read of a team channel', pg_temp.ic(u_own, format('SELECT count(*) FROM public.chat_admin_read_private(%L, %L)', t, 'just because')), 'ERROR 22023:%only private channels, DMs and deal rooms%');

  -- deal room: the guest sees the room and its members, never the Team notes
  INSERT INTO chat_channels (account_id, kind, name, created_by) VALUES (a, 'deal_room', 'IC deal', u_sup) RETURNING id INTO dr;
  INSERT INTO chat_channel_members (channel_id, user_id, role) VALUES (dr, u_sup, 'admin'), (dr, u_g, 'guest');
  PERFORM pg_temp.must(pg_temp.post(u_sup, dr, 'team note'));
  PERFORM pg_temp.ck('staff reads deal room notes', pg_temp.cnt(u_sup, format('public.internal_messages WHERE channel_id = %L', dr)), '1');
  PERFORM pg_temp.ck('guest reads deal room notes', pg_temp.cnt(u_g, format('public.internal_messages WHERE channel_id = %L', dr)), '0');
  PERFORM pg_temp.ck('guest sees deal room row', pg_temp.cnt(u_g, format('public.chat_channels WHERE id = %L', dr)), '1');
  PERFORM pg_temp.ck('guest sees deal room members', pg_temp.cnt(u_g, format('public.chat_channel_members WHERE channel_id = %L', dr)), '2');
  PERFORM pg_temp.ck('guest posts deal room note', pg_temp.post(u_g, dr, 'x'), 'ERROR 42501:%not a member of this channel%');

  -- ================= cross-workspace isolation =================
  t := pg_temp.must(pg_temp.mk(u_rm, a, 'team', 'tc-only'));
  PERFORM pg_temp.must(pg_temp.post(u_rm, t, 'Taamul only'));
  PERFORM pg_temp.ck('B owner sees A channel', pg_temp.cnt(u_po, format('public.chat_channels WHERE id = %L', t)), '0');
  PERFORM pg_temp.ck('B owner reads A messages', pg_temp.cnt(u_po, format('public.internal_messages WHERE channel_id = %L', t)), '0');
  PERFORM pg_temp.ck('B owner posts in A', pg_temp.post(u_po, t, 'intrusion'), 'ERROR 42501:%not a member of this workspace%');
  PERFORM pg_temp.ck('B owner creates in A', pg_temp.mk(u_po, a, 'team', 'x'), 'ERROR 42501:%not a member of this workspace%');
  PERFORM pg_temp.ck('B agent opens DM in A', pg_temp.dm(u_prm, a, ARRAY[u_rm]), 'ERROR 42501:%not a member of this workspace%');
  t := pg_temp.must(pg_temp.mk(u_rm, a, 'team', 'mention-x'));
  m := pg_temp.must(pg_temp.post(u_rm, t, format('hi <@%s> and <@%s>', u_prm, u_rm2)));
  PERFORM pg_temp.ck('cross-workspace mention dropped', (SELECT string_agg(user_id::text, ',') FROM message_mentions WHERE message_id = m), u_rm2::text);
  PERFORM pg_temp.ck('cross-workspace mention not notified', pg_temp.nk(m, u_prm), '-');
  PERFORM pg_temp.ck('mention notified', pg_temp.nk(m, u_rm2), 'mention');
  PERFORM pg_temp.ck('mention bell row', (SELECT count(*)::text FROM notifications WHERE user_id = u_rm2 AND account_id = a
      AND type = 'chat_mention' AND meta->>'channel_id' = t::text AND meta->>'message_id' = m::text), '1');
  t := pg_temp.must(pg_temp.mk(u_prm, b, 'team', 'tp'));
  PERFORM pg_temp.must(pg_temp.post(u_prm, t, 'zebrafinch settlement'));
  PERFORM pg_temp.ck('A owner searches B', pg_temp.srch(u_own, b, 'zebrafinch'), '-');
  PERFORM pg_temp.ck('A owner searches A for B text', pg_temp.srch(u_own, a, 'zebrafinch'), '-');
  PERFORM pg_temp.ck('B agent searches B', pg_temp.cnt(u_pag, format('public.chat_search(%L, %L)', b, 'zebrafinch')), '1');

  -- ================= internal_chat_enabled = false =================
  t := pg_temp.must(pg_temp.mk(u_rm, a, 'team', 'before-off'));
  p := pg_temp.must(pg_temp.mk(u_rm, a, 'private', 'before-off-priv', ARRAY[u_rm2]));
  m1 := pg_temp.must(pg_temp.post(u_rm, t, 'rm message'));
  m2 := pg_temp.must(pg_temp.post(u_adm, t, 'admin message'));
  UPDATE accounts SET internal_chat_enabled = false WHERE id = a;
  PERFORM pg_temp.ck('off: create', pg_temp.mk(u_own, a, 'team', 'off'), 'ERROR CH001:%disabled%');
  PERFORM pg_temp.ck('off: open DM', pg_temp.dm(u_own, a, ARRAY[u_adm]), 'ERROR CH001:%disabled%');
  PERFORM pg_temp.ck('off: post', pg_temp.post(u_adm, t, 'still here?'), 'ERROR CH001:%disabled%');
  PERFORM pg_temp.ck('off: edit', pg_temp.ic(u_adm, format('SELECT public.chat_edit_message(%L, %L)', m2, 'edited')), 'ERROR CH001:%disabled%');
  PERFORM pg_temp.ck('off: add members', pg_temp.ic(u_rm, format('SELECT public.chat_add_members(%L, %L::uuid[])', p, ARRAY[u_ag])), 'ERROR CH001:%disabled%');
  FOREACH uu IN ARRAY ARRAY[u_own, u_adm] LOOP
    PERFORM pg_temp.ck('off: owner/admin read history ' || uu, pg_temp.cnt(uu, format('public.internal_messages WHERE channel_id = %L', t)), '2');
  END LOOP;
  FOREACH uu IN ARRAY ARRAY[u_sup, u_rm, u_ag] LOOP
    PERFORM pg_temp.ck('off: others read history ' || uu, pg_temp.cnt(uu, format('public.internal_messages WHERE channel_id = %L', t)), '0');
  END LOOP;
  PERFORM pg_temp.ck('off: admin delete', pg_temp.ic(u_adm, format('SELECT public.chat_delete_message(%L)', m1)), '{}');
  PERFORM pg_temp.ck('off: delete tombstoned', (SELECT (deleted_at IS NOT NULL)::text FROM internal_messages WHERE id = m1), 'true');
  UPDATE accounts SET internal_chat_enabled = true WHERE id = a;

  -- ================= DMs =================
  d1 := pg_temp.must(pg_temp.dm(u_rm, a, ARRAY[u_ag, u_sup]));
  PERFORM pg_temp.ck('DM reused (other opener, order, duplicate)', pg_temp.dm(u_ag, a, ARRAY[u_sup, u_rm, u_rm]), d1::text);
  PERFORM pg_temp.ck('DM reused (third opener)', pg_temp.dm(u_sup, a, ARRAY[u_rm, u_ag]), d1::text);
  PERFORM pg_temp.ck('DM member count', (SELECT count(*)::text FROM chat_channel_members WHERE channel_id = d1), '3');
  PERFORM pg_temp.ck('other member set, other DM', (pg_temp.dm(u_rm, a, ARRAY[u_ag]) <> d1::text)::text, 'true');
  PERFORM pg_temp.ck('DM of nobody', pg_temp.dm(u_rm, a, '{}'), 'ERROR 22023:%2 to 8 members%');
  PERFORM pg_temp.ck('DM with self', pg_temp.dm(u_rm, a, ARRAY[u_rm]), 'ERROR 22023:%2 to 8 members%');
  PERFORM pg_temp.ck('DM of 9', pg_temp.dm(u_rm, a, extras), 'ERROR 22023:%2 to 8 members (got 9)%');
  PERFORM pg_temp.ck('DM of 8', pg_temp.dm(u_rm, a, extras[1:7]), '________-____-____-____-____________');
  PERFORM pg_temp.ck('DM with a guest', pg_temp.dm(u_rm, a, ARRAY[u_g]), 'ERROR 42501:%active non-guest member%');
  PERFORM pg_temp.ck('DM with another workspace', pg_temp.dm(u_rm, a, ARRAY[u_prm]), 'ERROR 42501:%active non-guest member%');

  -- ================= threads =================
  t := pg_temp.must(pg_temp.mk(u_rm, a, 'team', 'thr-a'));
  t2 := pg_temp.must(pg_temp.mk(u_rm, a, 'team', 'thr-b'));
  root := pg_temp.must(pg_temp.post(u_rm, t, 'root'));
  rep := pg_temp.must(pg_temp.post(u_ag, t, 'reply', root));
  PERFORM pg_temp.ck('reply thread root', (SELECT thread_root_id::text FROM internal_messages WHERE id = rep), root::text);
  PERFORM pg_temp.ck('nested reply', pg_temp.post(u_ag, t, 'nested', rep), 'ERROR 23514:%one level of threading%');
  PERFORM pg_temp.ck('reply in another channel', pg_temp.post(u_ag, t2, 'elsewhere', root), 'ERROR 23514:%same channel%');

  -- ================= notifications =================
  d := pg_temp.must(pg_temp.dm(u_rm, a, ARRAY[u_ag]));
  m := pg_temp.must(pg_temp.post(u_rm, d, format('note to self <@%s> @here', u_rm)));
  PERFORM pg_temp.ck('author not notified (self-mention, own DM)', pg_temp.nk(m, u_rm), '-');
  root := pg_temp.must(pg_temp.post(u_rm, d, 'root'));
  m := pg_temp.must(pg_temp.post(u_rm, d, 'own reply', root));
  PERFORM pg_temp.ck('author not notified (own thread)', pg_temp.nk(m, u_rm), '-');
  m := pg_temp.must(pg_temp.post(u_rm, d1, 'hello both'));
  PERFORM pg_temp.ck('dm notifies member 1', pg_temp.nk(m, u_ag), 'dm');
  PERFORM pg_temp.ck('dm notifies member 2', pg_temp.nk(m, u_sup), 'dm');
  PERFORM pg_temp.ck('dm notification count', pg_temp.nk(m), 'dm,dm');
  p := pg_temp.must(pg_temp.mk(u_rm, a, 'private', 'men', ARRAY[u_rm2]));
  m := pg_temp.must(pg_temp.post(u_rm, p, format('<@%s> <@%s> please check', u_rm2, u_ag)));
  PERFORM pg_temp.ck('private mention: reader notified only', pg_temp.nk(m), 'mention');
  PERFORM pg_temp.ck('private mention: reader notified', pg_temp.nk(m, u_rm2), 'mention');
  PERFORM pg_temp.ck('private mention: non-member dropped', (SELECT count(*)::text FROM message_mentions WHERE message_id = m), '1');
  t := pg_temp.must(pg_temp.mk(u_rm, a, 'team', 'thr-n'));
  root := pg_temp.must(pg_temp.post(u_rm, t, 'root'));
  PERFORM pg_temp.must(pg_temp.post(u_ag, t, 'first', root));
  m := pg_temp.must(pg_temp.post(u_sup, t, 'second', root));
  PERFORM pg_temp.ck('thread_reply: root author', pg_temp.nk(m, u_rm), 'thread_reply');
  PERFORM pg_temp.ck('thread_reply: earlier participant', pg_temp.nk(m, u_ag), 'thread_reply');
  PERFORM pg_temp.ck('thread_reply: count', pg_temp.nk(m), 'thread_reply,thread_reply');
  p := pg_temp.must(pg_temp.mk(u_rm, a, 'private', 'bc', ARRAY[u_rm2, u_ag]));
  m := pg_temp.must(pg_temp.post(u_rm, p, '@channel standup now'));
  PERFORM pg_temp.ck('@channel', pg_temp.nk(m), 'broadcast,broadcast');
  m := pg_temp.must(pg_temp.post(u_rm, p, 'ping @HERE.'));
  PERFORM pg_temp.ck('@HERE.', pg_temp.nk(m), 'broadcast,broadcast');
  m := pg_temp.must(pg_temp.post(u_rm, p, 'mail ops@channel.example'));
  PERFORM pg_temp.ck('email-like token', pg_temp.nk(m), '-');
  d := pg_temp.must(pg_temp.dm(u_rm, a, ARRAY[u_ag, u_rm2]));
  m := pg_temp.must(pg_temp.post(u_rm, d, format('<@%s> @channel', u_ag)));
  PERFORM pg_temp.ck('priority mention > dm', pg_temp.nk(m, u_ag), 'mention');
  PERFORM pg_temp.ck('priority dm > broadcast', pg_temp.nk(m, u_rm2), 'dm');
  t := pg_temp.must(pg_temp.mk(u_rm, a, 'team', 'prio', ARRAY[u_ag, u_rm2]));
  root := pg_temp.must(pg_temp.post(u_ag, t, 'root'));
  m := pg_temp.must(pg_temp.post(u_rm, t, '@channel reply', root));
  PERFORM pg_temp.ck('priority thread_reply > broadcast', pg_temp.nk(m, u_ag), 'thread_reply');
  PERFORM pg_temp.ck('priority broadcast', pg_temp.nk(m, u_rm2), 'broadcast');

  -- system posts: service role only, never notify
  PERFORM pg_temp.ck('system post as a user', pg_temp.ic(u_own, format('SELECT public.chat_post_system_message(%L, %L, %L::jsonb)', t, 'sys', '{}')), 'ERROR 42501:%permission denied%');
  r := pg_temp.ic(NULL, format('SELECT public.chat_post_system_message(%L, %L, %L::jsonb)', t, format('<@%s> @channel deal opened', u_rm2), '{"card":"deal"}'), 'service_role');
  PERFORM pg_temp.ck('system post as service role', r, '________-____-____-____-____________');
  sm := CASE WHEN r ~ '^[0-9a-f-]{36}$' THEN r::uuid END;
  PERFORM pg_temp.ck('system post shape', (SELECT author_kind || '/' || coalesce(author_id::text, 'null') || '/' || (meta->>'card') FROM internal_messages WHERE id = sm), 'system/null/deal');
  PERFORM pg_temp.ck('system post notifies nobody', pg_temp.nk(sm) || '/' || (SELECT count(*) FROM notifications WHERE meta->>'message_id' = sm::text), '-/0');

  -- ================= edit and delete =================
  t := pg_temp.must(pg_temp.mk(u_rm, a, 'team', 'ed'));
  m := pg_temp.must(pg_temp.post(u_rm, t, 'v1'));
  PERFORM pg_temp.ck('edit by another agent', pg_temp.ic(u_rm2, format('SELECT public.chat_edit_message(%L, %L)', m, 'hijack')), 'ERROR 42501:%only the author%');
  PERFORM pg_temp.ck('edit by the owner', pg_temp.ic(u_own, format('SELECT public.chat_edit_message(%L, %L)', m, 'hijack')), 'ERROR 42501:%only the author%');
  PERFORM pg_temp.ck('edit v2', pg_temp.ic(u_rm, format('SELECT public.chat_edit_message(%L, %L)', m, 'v2')), 'ok');
  PERFORM pg_temp.ck('edit v3', pg_temp.ic(u_rm, format('SELECT public.chat_edit_message(%L, %L)', m, 'v3')), 'ok');
  PERFORM pg_temp.ck('edited body', (SELECT body || '/' || (edited_at IS NOT NULL) FROM internal_messages WHERE id = m), 'v3/true');
  PERFORM pg_temp.ck('edit history', (SELECT string_agg(previous_body, ',' ORDER BY edited_at, previous_body) FROM internal_message_edits WHERE message_id = m), 'v1,v2');
  PERFORM pg_temp.ck('admin reads edit history', pg_temp.cnt(u_adm, format('public.internal_message_edits WHERE message_id = %L', m)), '2');
  PERFORM pg_temp.ck('author reads edit history', pg_temp.cnt(u_rm, format('public.internal_message_edits WHERE message_id = %L', m)), '0');
  PERFORM pg_temp.ck('supervisor reads edit history', pg_temp.cnt(u_sup, format('public.internal_message_edits WHERE message_id = %L', m)), '0');
  -- the bell keeps a copy of the body: an edit rebuilds it from the new text
  m := pg_temp.must(pg_temp.post(u_rm, t, format('<@%s> the vault code is 7741', u_rm2)));
  PERFORM pg_temp.ck('bell before the edit', pg_temp.ic(u_rm2, format('SELECT string_agg(body, ''|'') FROM public.notifications WHERE meta->>''message_id'' = %L', m)), '@% the vault code is 7741');
  PERFORM pg_temp.ck('edit away the mention text', pg_temp.ic(u_rm, format('SELECT public.chat_edit_message(%L, %L)', m, format('(removed) <@%s>', u_rm2))), 'ok');
  PERFORM pg_temp.ck('bell after the edit has no old text',
    pg_temp.ic(u_rm2, format('SELECT (strpos(string_agg(body, ''|''), ''7741'') = 0) || ''/'' || string_agg(body, ''|'') FROM public.notifications WHERE meta->>''message_id'' = %L', m)),
    'true/(removed) @%');
  p := pg_temp.must(pg_temp.mk(u_rm, a, 'private', 'ed-priv'));
  m := pg_temp.must(pg_temp.post(u_rm, p, 'draft'));
  PERFORM pg_temp.ck('private edit', pg_temp.ic(u_rm, format('SELECT public.chat_edit_message(%L, %L)', m, 'final')), 'ok');
  PERFORM pg_temp.ck('owner reads private edit history', pg_temp.cnt(u_own, format('public.internal_message_edits WHERE message_id = %L', m)), '0');
  PERFORM pg_temp.ck('owner reads private audit', pg_temp.cnt(u_own, format('public.chat_audit_log WHERE channel_id = %L', p)), '0');
  t := pg_temp.must(pg_temp.mk(u_rm, a, 'team', 'del'));
  m := pg_temp.must(pg_temp.post(u_rm, t, 'quokkaplan details'));
  PERFORM pg_temp.ck('search before delete', pg_temp.srch(u_ag, a, 'quokkaplan'), m::text);
  PERFORM pg_temp.ck('delete by another agent', pg_temp.ic(u_rm2, format('SELECT public.chat_delete_message(%L)', m)), 'ERROR 42501:%only the author or a workspace owner/admin%');
  PERFORM pg_temp.ck('delete by author', pg_temp.ic(u_rm, format('SELECT public.chat_delete_message(%L)', m)), '{}');
  PERFORM pg_temp.ck('tombstone', pg_temp.ic(u_ag, format('SELECT body || ''/'' || (deleted_at IS NOT NULL) FROM public.internal_messages WHERE id = %L', m)), '/true');
  PERFORM pg_temp.ck('search after delete', pg_temp.srch(u_ag, a, 'quokkaplan'), '-');
  PERFORM pg_temp.ck('deleted body kept in history', (SELECT string_agg(previous_body, ',') FROM internal_message_edits WHERE message_id = m), 'quokkaplan details');
  PERFORM pg_temp.ck('edit a deleted message', pg_temp.ic(u_rm, format('SELECT public.chat_edit_message(%L, %L)', m, 'resurrect')), 'ERROR 42501:%was deleted%');
  m := pg_temp.must(pg_temp.post(u_rm, t, 'admin removes this'));
  PERFORM pg_temp.ck('delete by admin', pg_temp.ic(u_adm, format('SELECT public.chat_delete_message(%L)', m)), '{}');

  -- ================= unread counts =================
  t := pg_temp.must(pg_temp.mk(u_own, a, 'team', 'unread', ARRAY[u_rm]));
  m1 := pg_temp.must(pg_temp.post(u_own, t, 'one'));
  PERFORM pg_temp.must(pg_temp.post(u_own, t, 'two'));
  PERFORM pg_temp.must(pg_temp.post(u_own, t, 'reply', m1));
  gone := pg_temp.must(pg_temp.post(u_own, t, 'deleted soon'));
  PERFORM pg_temp.ck('unread: delete', pg_temp.ic(u_own, format('SELECT public.chat_delete_message(%L)', gone)), '{}');
  PERFORM pg_temp.must(pg_temp.post(u_rm, t, 'my own'));
  mr := pg_temp.must(pg_temp.post(u_own, t, format('<@%s> in thread', u_rm), m1));
  UPDATE chat_channel_members SET joined_at = now() - interval '1 hour' WHERE channel_id = t;
  PERFORM pg_temp.ck('unread and mentions', pg_temp.ic(u_rm, format('SELECT unread || ''/'' || mentions FROM public.chat_unread_counts(%L) WHERE channel_id = %L', a, t)), '2/1');
  PERFORM pg_temp.ck('thread mention notified', pg_temp.nk(mr, u_rm), 'mention');
  PERFORM pg_temp.ck('mark read', pg_temp.ic(u_rm, format('SELECT public.chat_mark_read(%L)', t)), 'ok');
  PERFORM pg_temp.ck('unread after mark read', pg_temp.ic(u_rm, format('SELECT unread || ''/'' || mentions FROM public.chat_unread_counts(%L) WHERE channel_id = %L', a, t)), '0/0');
  PERFORM pg_temp.ck('mark read clears notification', (SELECT (read_at IS NOT NULL)::text FROM chat_notifications WHERE message_id = mr AND user_id = u_rm), 'true');

  -- ================= search =================
  t := pg_temp.must(pg_temp.mk(u_rm, a, 'team', 'srch'));
  ar := pg_temp.must(pg_temp.post(u_rm, t, 'تقرير الربع الرابع 2026'));
  en := pg_temp.must(pg_temp.post(u_rm, t, 'Quarterly settlement reconciliation'));
  ad := pg_temp.must(pg_temp.post(u_rm, t, 'فاتورة رقم ٤٤٧١'));
  PERFORM pg_temp.ck('search Arabic', pg_temp.srch(u_ag, a, 'تقرير'), ar::text);
  PERFORM pg_temp.ck('search English', pg_temp.srch(u_ag, a, 'reconciliation'), en::text);
  PERFORM pg_temp.ck('search case-insensitive', pg_temp.srch(u_ag, a, 'QUARTERLY'), en::text);
  PERFORM pg_temp.ck('search Arabic-Indic digits find ASCII', pg_temp.srch(u_ag, a, '٢٠٢٦'), ar::text);
  PERFORM pg_temp.ck('search ASCII digits find Arabic-Indic', pg_temp.srch(u_ag, a, '4471'), ad::text);
  p := pg_temp.must(pg_temp.mk(u_rm, a, 'private', 'srch-priv'));
  m := pg_temp.must(pg_temp.post(u_rm, p, 'wombatdeal terms'));
  PERFORM pg_temp.ck('search own private channel', pg_temp.srch(u_rm, a, 'wombatdeal'), m::text);
  PERFORM pg_temp.ck('owner searches private channel', pg_temp.srch(u_own, a, 'wombatdeal'), '-');
  PERFORM pg_temp.ck('non-member searches private channel', pg_temp.srch(u_rm2, a, 'wombatdeal'), '-');

  -- ================= shared conversations =================
  INSERT INTO chat_tags (account_id, name, color) VALUES (a, 'IC tag', '#22c55e') RETURNING id INTO tg;
  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a, 'IC team', u_sup) RETURNING id INTO tm;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (tm, u_rm, a), (tm, u_rm2, a);
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a, u_rm, '971500087001', 'IC customer one') RETURNING id INTO k1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a, u_rm2, '971500087002', 'IC customer two') RETURNING id INTO k2;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (b, u_mx, '971500087003', 'IC customer B') RETURNING id INTO kb;
  INSERT INTO conversations (account_id, contact_id, user_id, chat_tag_id, last_message_at)
  VALUES (a, k1, u_rm, tg, '2026-10-01 09:00:00+00') RETURNING id INTO cv1;
  INSERT INTO conversations (account_id, contact_id, user_id) VALUES (a, k2, u_rm2) RETURNING id INTO cv2;
  INSERT INTO conversations (account_id, contact_id, user_id) VALUES (b, kb, u_mx) RETURNING id INTO cvb;
  p := pg_temp.must(pg_temp.mk(u_sup, a, 'private', 'share', ARRAY[u_rm, u_rm2]));
  m := pg_temp.must(pg_temp.post(u_rm, p, 'see this customer', NULL, cv1));
  PERFORM pg_temp.ck('owning agent shares', (SELECT conversation_id || '/' || shared_by FROM shared_conversations WHERE message_id = m), cv1 || '/' || u_rm);
  PERFORM pg_temp.ck('supervisor shares a teammate''s chat', pg_temp.post(u_sup, p, 'and this one', NULL, cv2), '________-____-____-____-____________');
  PERFORM pg_temp.ck('another agent shares', pg_temp.post(u_rm2, p, 'not mine', NULL, cv1), 'ERROR 42501:%cannot share this conversation%');
  PERFORM pg_temp.ck('share another account''s chat', pg_temp.post(u_rm, p, 'other account', NULL, cvb), 'ERROR 42501:%cannot share this conversation%');
  PERFORM pg_temp.ck('snapshot masks the phone', (SELECT (snapshot->>'phone' NOT LIKE '%500087001%')::text FROM shared_conversations WHERE message_id = m), 'true');
  -- no share into a channel with a bank guest: a guest member, or a member now demoted to bank_guest
  d := pg_temp.must(pg_temp.mk(u_sup, a, 'private', 'share-guest', ARRAY[u_rm, u_g]));
  PERFORM pg_temp.ck('share into a channel with a guest', pg_temp.post(u_rm, d, 'see this customer', NULL, cv1), 'ERROR 42501:%channel with a bank guest%');
  PERFORM pg_temp.ck('plain post beside a guest', pg_temp.post(u_rm, d, 'no card'), '________-____-____-____-____________');
  t := pg_temp.must(pg_temp.mk(u_rm, a, 'team', 'share-demoted', ARRAY[extras[1]]));
  UPDATE profiles SET account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = extras[1];
  PERFORM pg_temp.ck('share into a channel with a demoted member', pg_temp.post(u_rm, t, 'see this customer', NULL, cv1), 'ERROR 42501:%channel with a bank guest%');
  UPDATE profiles SET account_role = 'agent', bank_code = NULL WHERE user_id = extras[1];
  -- a guest added after the share: no snapshot, by any path
  PERFORM pg_temp.ck('supervisor adds a guest after the share', pg_temp.ic(u_sup, format('SELECT public.chat_add_members(%L, %L::uuid[])', p, ARRAY[u_g])), '1');
  PERFORM pg_temp.ck('share once a guest is in', pg_temp.post(u_sup, p, 'again', NULL, cv2), 'ERROR 42501:%channel with a bank guest%');
  PERFORM pg_temp.ck('guest shares', pg_temp.post(u_g, p, 'peek', NULL, cv1), 'ERROR 42501:%cannot share this conversation%');
  PERFORM pg_temp.ck('card for a viewer of the chat', pg_temp.card(u_rm, m), 'IC customer one/t/IC tag/open/2026-10-01%');
  PERFORM pg_temp.ck('viewer reads the share row', pg_temp.ic(u_rm, format('SELECT snapshot->>''contact_name'' FROM public.shared_conversations WHERE message_id = %L', m)), 'IC customer one');
  PERFORM pg_temp.ck('card for a reader who cannot view the chat', pg_temp.card(u_rm2, m), 'f/-/-/-');
  PERFORM pg_temp.ck('card for a guest', pg_temp.card(u_g, m), 'f/-/-/-');
  PERFORM pg_temp.ck('card for a non-member of the channel', pg_temp.card(u_ag, m), 'ok');
  FOREACH uu IN ARRAY ARRAY[u_rm2, u_g] LOOP
    PERFORM pg_temp.ck('no customer field in the card ' || uu, pg_temp.ic(uu, format(
      'SELECT (snapshot IS NULL AND conversation_id IS NULL AND NOT can_open AND chat_tag IS NULL AND status IS NULL'
      ' AND last_message_at IS NULL AND strpos(row_to_json(c)::text, ''IC customer'') = 0)::text'
      ' FROM public.chat_shared_cards(ARRAY[%L]::uuid[]) c', m)), 'true');
    PERFORM pg_temp.ck('no share row from a plain SELECT ' || uu, pg_temp.ic(uu, format(
      'SELECT count(*) || ''/'' || coalesce(string_agg(snapshot::text, ''''), ''-'') FROM public.shared_conversations WHERE message_id = %L', m)), '0/-');
  END LOOP;

  -- ================= a person active in another account =================
  t := pg_temp.must(pg_temp.mk(u_rm, a, 'team', 'multi', ARRAY[u_mx]));
  PERFORM pg_temp.ck('share own chat of another account', pg_temp.post(u_mx, t, 'mine from B', NULL, cvb), 'ERROR 42501:%cannot share this conversation%');
  m := pg_temp.must(pg_temp.post(u_rm, t, format('<@%s> welcome', u_mx)));
  UPDATE chat_channel_members SET joined_at = now() - interval '1 hour' WHERE channel_id = t;
  PERFORM pg_temp.ck('active in B reads A channel', pg_temp.cnt(u_mx, format('public.internal_messages WHERE channel_id = %L', t)), '1');
  PERFORM pg_temp.ck('active in B: badges',
    pg_temp.ic(u_mx, format('SELECT string_agg(account_id || ''='' || unread || ''/'' || mentions, '','' ORDER BY account_id <> %L) FROM public.chat_workspace_badges()', a)),
    a || '=1/1,' || b || '=0/0');

  -- ================= attachments after a delete or an erasure =================
  -- An object is readable only while a live message carries it; what
  -- no live message carries is the cron sweep's once 24 hours old.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.postf(p_uid uuid, p_ch uuid, p_path text) RETURNS text LANGUAGE sql AS $b$
      SELECT pg_temp.ic(p_uid, format('SELECT public.chat_post_message(%L, %L, NULL, NULL, %L::jsonb)', p_ch, 'file',
        jsonb_build_array(jsonb_build_object('storage_path', p_path, 'name', 'f.pdf', 'mime', 'application/pdf', 'bytes', 1)))) $b$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.orphan(p_path text) RETURNS text LANGUAGE sql AS $b$
      SELECT pg_temp.ic(NULL, format('SELECT (%L = ANY (public.chat_orphan_files(1000)))::text', p_path), 'service_role') $b$
  $fn$;
  t := pg_temp.must(pg_temp.mk(u_rm, a, 'team', 'files-del'));
  uu := extras[1];
  f1 := format('account-%s/channel-%s/%s-a.pdf', a, t, gen_random_uuid());
  f2 := format('account-%s/channel-%s/%s-b.pdf', a, t, gen_random_uuid());
  f3 := format('account-%s/channel-%s/%s-c.pdf', a, t, gen_random_uuid());
  f4 := format('account-%s/channel-%s/%s-d.pdf', a, t, gen_random_uuid());
  INSERT INTO storage.objects (bucket_id, name, owner) VALUES
    ('chat-files', f1, u_rm), ('chat-files', f2, uu), ('chat-files', f3, u_rm), ('chat-files', f4, u_rm);
  m := pg_temp.must(pg_temp.postf(u_rm, t, f1));
  r := format('storage.objects WHERE bucket_id = ''chat-files'' AND name = %L', f1);
  PERFORM pg_temp.ck('files: another member reads a posted file', pg_temp.cnt(u_rm2, r), '1');
  PERFORM pg_temp.ck('files: delete returns the path', pg_temp.ic(u_rm, format('SELECT public.chat_delete_message(%L)', m)), '{' || f1 || '}');
  PERFORM pg_temp.ck('files: another member reads a deleted message''s file', pg_temp.cnt(u_rm2, r), '0');
  PERFORM pg_temp.ck('files: the author reads a deleted message''s file', pg_temp.cnt(u_rm, r), '0');
  PERFORM pg_temp.ck('files: an unposted upload is readable', pg_temp.cnt(u_rm, format('storage.objects WHERE bucket_id = ''chat-files'' AND name = %L', f3)), '0');
  m := pg_temp.must(pg_temp.postf(uu, t, f2));
  PERFORM pg_temp.ck('files: the person deletes their file', pg_temp.ic(uu, format('SELECT public.chat_delete_message(%L)', m)), '{' || f2 || '}');
  PERFORM pg_temp.ck('files: erasure after the delete', pg_temp.ic(u_own, format('SELECT public.chat_erase_person(%L, %L, %L)', a, uu, 'lawful request')), '{}');
  PERFORM pg_temp.must(pg_temp.postf(u_rm, t, f4));
  PERFORM pg_temp.ck('files: orphan while younger than the window', pg_temp.orphan(f2), 'false');
  PERFORM pg_temp.ck('files: fresh unposted upload is an orphan', pg_temp.orphan(f3), 'false');
  UPDATE storage.objects SET created_at = now() - interval '25 hours' WHERE bucket_id = 'chat-files' AND name IN (f1, f2, f3, f4);
  PERFORM pg_temp.ck('files: erased person''s deleted file is an orphan once old', pg_temp.orphan(f2), 'true');
  PERFORM pg_temp.ck('files: deleted file is an orphan once old', pg_temp.orphan(f1), 'true');
  PERFORM pg_temp.ck('files: old unposted upload is an orphan', pg_temp.orphan(f3), 'true');
  PERFORM pg_temp.ck('files: a live old attachment is an orphan', pg_temp.orphan(f4), 'false');
  PERFORM pg_temp.ck('files: orphan list by a member', pg_temp.ic(u_own, 'SELECT public.chat_orphan_files()'), 'ERROR 42501:%');
  PERFORM pg_temp.ck('files: orphan list grants',
    (NOT has_function_privilege('authenticated', 'public.chat_orphan_files(integer)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.chat_orphan_files(integer)', 'EXECUTE')
     AND NOT has_function_privilege('public', 'public.chat_orphan_files(integer)', 'EXECUTE')
     AND has_function_privilege('service_role', 'public.chat_orphan_files(integer)', 'EXECUTE'))::text, 'true');

  -- ================= 102: automation posts never go beside a bank guest =================
  -- chat_channels_with_guests: 087's share test (a guest member, or a
  -- member whose account role is now bank_guest); the service role
  -- asks about any channel, a signed-in caller only about channels they see.
  t := pg_temp.must(pg_temp.mk(u_rm, a, 'team', 'auto-team', ARRAY[extras[2]]));
  p := pg_temp.must(pg_temp.mk(u_sup, a, 'private', 'auto-private', ARRAY[u_rm]));
  r := format('SELECT coalesce(string_agg(x::text, '','' ORDER BY x::text), ''-'') FROM public.chat_channels_with_guests(ARRAY[%L, %L]::uuid[]) x', t, p);
  PERFORM pg_temp.ck('102: no guest yet (engine)', pg_temp.ic(NULL, r, 'service_role'), '-');
  PERFORM pg_temp.ck('102: guest added to the private channel', pg_temp.ic(u_sup, format('SELECT public.chat_add_members(%L, %L::uuid[])', p, ARRAY[u_g])), '1');
  PERFORM pg_temp.ck('102: a guest member (engine)', pg_temp.ic(NULL, r, 'service_role'), p::text);
  PERFORM pg_temp.ck('102: a guest member (member of the channel)', pg_temp.ic(u_rm, r), p::text);
  PERFORM pg_temp.ck('102: a channel the caller cannot see', pg_temp.ic(u_rm2, r), '-');
  UPDATE profiles SET account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = extras[2];
  PERFORM pg_temp.ck('102: a member now demoted to bank_guest (engine)', pg_temp.ic(NULL, r, 'service_role'),
    (SELECT string_agg(x::text, ',' ORDER BY x::text) FROM unnest(ARRAY[t, p]) x));
  UPDATE profiles SET account_role = 'agent', bank_code = NULL WHERE user_id = extras[2];
  PERFORM pg_temp.ck('102: grants',
    (has_function_privilege('service_role', 'public.chat_channels_with_guests(uuid[])', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.chat_channels_with_guests(uuid[])', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.chat_channels_with_guests(uuid[])', 'EXECUTE')
     AND NOT has_function_privilege('public', 'public.chat_channels_with_guests(uuid[])', 'EXECUTE'))::text, 'true');

  SELECT count(*), coalesce(array_agg(label || ': got ' || coalesce(got, 'NULL') || ', want ' || want ORDER BY id)
                              FILTER (WHERE got IS NULL OR got NOT LIKE want), '{}')
    INTO n, failed FROM ic_checks;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT087', MESSAGE = 'verify-internal-chat rollback';
  EXCEPTION WHEN SQLSTATE 'ZT087' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'internal chat verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'internal chat verification passed (% checks)', n;
END
$verify$;
