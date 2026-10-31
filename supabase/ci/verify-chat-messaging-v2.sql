-- Behavioural regression suite for team chat messaging v2 (migration 156).
--
-- Voice notes: an attachment's kind is 'file' (default) or 'voice'; a
-- voice note is audio/* with a duration of 1..1200000 ms and is its
-- message's only attachment (22023). Quote replies: reply_to_id names a
-- live message of the same channel and thread scope (top level quotes
-- top level; a reply in thread R quotes R or a reply of R), else 22023,
-- and it is immutable. chat_post_message gained p_reply_to last, its
-- 087 signature is gone and positional 5-argument calls still work.
-- chat_forward_message copies a readable live message (else P0002) into
-- a channel the caller may post in, in the same workspace (else 42501):
-- mentions rendered to @Name, meta.forwarded names the source, always
-- top level, no mention rows, only 'dm' bells for a DM target. Typing
-- (chat_set_typing) is allowed where the caller could post, never joins
-- anyone to a team channel, writes at most every 2 s per thread, takes
-- only a top-level root of the channel, and clears its own row even
-- without access; only readers of the channel see the rows (a deal
-- room's bank guest included). Voice plays (chat_mark_voice_played):
-- voice notes only, not the author, unreadable P0002, CH001 with chat
-- off; only readers see them. chat_channel_files is SECURITY INVOKER,
-- lists live messages only by kind, newest first, limit clamped 1..200.
-- chat_erase_person also drops the person's typing and play rows and
-- erases forwarded copies of their messages, forwards of forwards
-- included, returning the copies' attachment paths and counting them in
-- the audit row. No new function is executable by anon, PUBLIC or
-- service_role.
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
  u_own  UUID := '00000000-0000-4000-8000-000000156101';  -- owner of A
  u_ag   UUID := '00000000-0000-4000-8000-000000156102';  -- agent, member of every A channel
  u_x    UUID := '00000000-0000-4000-8000-000000156103';  -- agent, member of nothing
  u_ag2  UUID := '00000000-0000-4000-8000-000000156104';  -- agent, outside the private channel
  u_g    UUID := '00000000-0000-4000-8000-000000156105';  -- bank guest in the deal room
  u_po   UUID := '00000000-0000-4000-8000-000000156106';  -- owner of B
  a      UUID;
  b      UUID;
  ch     UUID;  -- A team: own, ag
  pv     UUID;  -- A private: own, ag
  dr     UUID;  -- A deal room: own (admin), ag, g (guest)
  dm     UUID;  -- A DM: own, ag
  fc     UUID;  -- A team: files-list fixture
  chb    UUID;  -- B team (own also lives in B)
  m1     UUID;  -- own, top level in ch, mentions ag
  r1     UUID;  -- ag, reply in m1's thread
  r2     UUID;  -- own, reply in m1's thread
  v1     UUID;  -- ag, voice note in ch
  ov     UUID;  -- own, voice note in ch
  pm     UUID;  -- own, text in pv
  pvv    UUID;  -- ag, voice note in pv
  drv    UUID;  -- ag, voice note in dr
  md     UUID;  -- own, deleted, in ch
  fw     UUID;
  fv     UUID;  -- own's forward of v1 (copy of ag's)
  ff     UUID;  -- x's forward of fv (forward of a forward)
  fdm    UUID;
  vp     TEXT;
  vpc    TEXT;
  vpcc   TEXT;
  t1     TIMESTAMPTZ;
  copies UUID[] := '{}';  -- every forwarded copy of an ag message
  rp     UUID;  -- own, one pdf in ch: the reuse / copy-matching source
  tch    UUID;  -- A team: typing-stop fixture (own, ag)
  tpv    UUID;  -- A private: ag types, then loses access
  dmx    UUID;  -- A DM: own, x
  fx     UUID;  -- own's forward of r1 (ag's) into dmx: x's bell and push
  p1     TEXT;
  p2     TEXT;
  fwa    TEXT := 'SELECT public.chat_forward_message(%L, %L, %L::jsonb)::text';
  r      TEXT;
  post   TEXT := 'SELECT public.chat_post_message(%L, %L, %L::uuid, NULL, %L::jsonb, %L::uuid)::text';
  att    TEXT := '[{"storage_path":%s,"name":"%s","mime":"%s","bytes":100%s}]';
  uuid_re TEXT := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  fns    TEXT[] := ARRAY[
    'public.chat_post_message(uuid,text,uuid,uuid,jsonb,uuid)',
    'public.chat_forward_message(uuid,uuid,jsonb)',
    'public.chat_set_typing(uuid,uuid,boolean)',
    'public.chat_mark_voice_played(uuid)',
    'public.chat_channel_files(uuid,text,timestamptz,integer)',
    'public.chat_erase_person(uuid,uuid,text)'];
  internal_fns TEXT[] := ARRAY[
    'public.chat_insert_attachments(public.chat_channels,uuid,jsonb)',
    'public.chat_message_before_insert()',
    'public.chat_message_before_update()'];
  f      TEXT;
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
  -- A one-item attachment list (a NULL kind or duration is left out).
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.tc_a1(p_path text, p_name text, p_mime text, p_bytes int, p_kind text, p_dur int)
    RETURNS text LANGUAGE sql AS $body$
      SELECT jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('storage_path', p_path, 'name', p_name,
               'mime', p_mime, 'bytes', p_bytes, 'kind', p_kind, 'duration_ms', p_dur)))::text
    $body$
  $fn$;
  -- An uploaded chat-files object under the channel's prefix: its path.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.tc_up(p_ws uuid, p_ch uuid, p_name text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := 'account-' || p_ws || '/channel-' || p_ch || '/' || gen_random_uuid() || '-' || p_name;
    BEGIN
      -- 165: a forward compares the copy's stored size and mimetype with
      -- the source object's, so fixture objects carry storage metadata.
      INSERT INTO storage.objects (bucket_id, name, metadata) VALUES ('chat-files', v,
        jsonb_build_object('size', 100, 'mimetype',
          CASE WHEN p_name LIKE '%.ogg' THEN 'audio/ogg' ELSE 'application/pdf' END));
      RETURN v;
    END $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_own, 'ci-tc2-own@example.invalid'), (u_ag, 'ci-tc2-ag@example.invalid'),
    (u_x, 'ci-tc2-x@example.invalid'), (u_ag2, 'ci-tc2-ag2@example.invalid'),
    (u_g, 'ci-tc2-g@example.invalid'), (u_po, 'ci-tc2-po@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a FROM profiles WHERE user_id = u_own;
  SELECT account_id INTO b FROM profiles WHERE user_id = u_po;
  IF a IS NULL OR b IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE accounts SET internal_chat_enabled = true WHERE id IN (a, b);
  UPDATE profiles SET account_id = a, account_role = 'agent' WHERE user_id IN (u_ag, u_x, u_ag2);
  UPDATE profiles SET full_name = 'Agent Vee' WHERE user_id = u_ag;
  INSERT INTO case_banks (account_id, code, name) VALUES (a, 'ADCB', 'ADCB Bank') ON CONFLICT DO NOTHING;
  UPDATE profiles SET account_id = a, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_g;
  INSERT INTO profiles (user_id, full_name, email, account_id, account_role, is_active)
  VALUES (u_own, 'Own in B', 'ci-tc2-own@example.invalid', b, 'agent', false);

  ch := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_create_channel(%L, %L, %L, NULL, %L::uuid[])::text', a, 'team', 'TC2 team', ARRAY[u_ag]));
  pv := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_create_channel(%L, %L, %L, NULL, %L::uuid[])::text', a, 'private', 'TC2 private', ARRAY[u_ag]));
  fc := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_create_channel(%L, %L, %L, NULL, %L::uuid[])::text', a, 'team', 'TC2 files', ARRAY[u_ag]));
  dm := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_open_dm(%L, %L::uuid[])::text', a, ARRAY[u_ag]));
  chb := pg_temp.tc_try('authenticated', u_po, format('SELECT public.chat_create_channel(%L, %L, %L, NULL, %L::uuid[])::text', b, 'team', 'TC2 B', '{}'));
  INSERT INTO chat_channels (account_id, kind, name, created_by) VALUES (a, 'deal_room', 'TC2 deal', u_own) RETURNING id INTO dr;
  INSERT INTO chat_channel_members (channel_id, user_id, role) VALUES (dr, u_own, 'admin'), (dr, u_ag, 'member'), (dr, u_g, 'guest');

  -- ---------- C. chat_post_message signature ----------
  r := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_post_message(%L, %L, NULL, NULL, %L::jsonb)::text', ch, 'hi <@' || u_ag || '>', '[]'));
  n := n + 1; failed := failed || pg_temp.tc_ok(r ~ uuid_re, 'a positional 5-argument post failed (' || r || ')');
  IF r ~ uuid_re THEN m1 := r::uuid; END IF;
  n := n + 1; failed := failed || pg_temp.tc_ok(to_regprocedure('public.chat_post_message(uuid,text,uuid,uuid,jsonb)') IS NULL,
    'the 087 five-argument chat_post_message overload still exists');

  -- ---------- A. voice notes ----------
  vp := pg_temp.tc_up(a, ch, 'voice.ogg');
  r := pg_temp.tc_try('authenticated', u_ag, format(post, ch, 'voice', NULL,
         format(att, to_json(vp), 'voice.ogg', 'audio/ogg', ',"kind":"voice","duration_ms":4200'), NULL));
  n := n + 1; failed := failed || pg_temp.tc_ok(r ~ uuid_re, 'a voice note post failed (' || r || ')');
  IF r ~ uuid_re THEN v1 := r::uuid; END IF;
  n := n + 1; failed := failed || pg_temp.tc_check('a voice note was not stored as kind voice with its duration', NULL,
    format('SELECT string_agg(kind || ''|'' || duration_ms, '','') FROM message_attachments WHERE message_id = %L', v1), 'voice|4200');
  n := n + 1; failed := failed || pg_temp.tc_check('a voice note with a second attachment was accepted', u_ag,
    format(post, ch, 'voice+pdf', NULL, format('[{"storage_path":%s,"name":"v.ogg","mime":"audio/ogg","bytes":10,"kind":"voice","duration_ms":5},'
      || '{"storage_path":%s,"name":"d.pdf","mime":"application/pdf","bytes":10}]', to_json(pg_temp.tc_up(a, ch, 'probe.ogg')), to_json(pg_temp.tc_up(a, ch, 'd.pdf'))), NULL),
    'ERROR 22023:%only attachment%');
  n := n + 1; failed := failed || pg_temp.tc_check('a voice note with a non-audio mime was accepted', u_ag,
    format(post, ch, 'x', NULL, format(att, to_json(pg_temp.tc_up(a, ch, 'probe.ogg')), 'v.pdf', 'application/pdf', ',"kind":"voice","duration_ms":5'), NULL), 'ERROR 22023:%');
  n := n + 1; failed := failed || pg_temp.tc_check('a voice note without a duration was accepted', u_ag,
    format(post, ch, 'x', NULL, format(att, to_json(pg_temp.tc_up(a, ch, 'probe.ogg')), 'v.ogg', 'audio/ogg', ',"kind":"voice"'), NULL), 'ERROR 22023:%');
  n := n + 1; failed := failed || pg_temp.tc_check('a duration of 0 ms was accepted', u_ag,
    format(post, ch, 'x', NULL, format(att, to_json(pg_temp.tc_up(a, ch, 'probe.ogg')), 'v.ogg', 'audio/ogg', ',"kind":"voice","duration_ms":0'), NULL), 'ERROR 22023:%');
  n := n + 1; failed := failed || pg_temp.tc_check('a duration over 1200000 ms was accepted', u_ag,
    format(post, ch, 'x', NULL, format(att, to_json(pg_temp.tc_up(a, ch, 'probe.ogg')), 'v.ogg', 'audio/ogg', ',"kind":"voice","duration_ms":1200001'), NULL), 'ERROR 22023:%');
  n := n + 1; failed := failed || pg_temp.tc_check('an attachment kind other than file/voice was accepted', u_ag,
    format(post, ch, 'x', NULL, format(att, to_json(pg_temp.tc_up(a, ch, 'probe.ogg')), 'v.ogg', 'audio/ogg', ',"kind":"image"'), NULL), 'ERROR 22023:%');
  n := n + 1; failed := failed || pg_temp.tc_check('a direct non-audio voice row passed the table CHECK', NULL,
    format('INSERT INTO message_attachments (message_id, storage_path, name, mime, bytes, kind, duration_ms) VALUES (%L, %L, ''v'', ''application/pdf'', 1, ''voice'', 5) RETURNING 1', m1, vp),
    'ERROR 23514:%');
  r := pg_temp.tc_try('authenticated', u_own, format(post, ch, 'a pdf', NULL, format(att, to_json(pg_temp.tc_up(a, ch, 'p.pdf')), 'p.pdf', 'application/pdf', ''), NULL));
  n := n + 1; failed := failed || pg_temp.tc_check('an attachment without kind is not a file with no duration', NULL,
    format('SELECT string_agg(kind || ''|'' || coalesce(duration_ms::text, ''-''), '','') FROM message_attachments WHERE message_id = %L', CASE WHEN r ~ uuid_re THEN r END),
    'file|-');

  -- ---------- B. quote replies ----------
  r1 := pg_temp.tc_try('authenticated', u_ag, format(post, ch, 'reply one', m1, '[]', NULL));
  r2 := pg_temp.tc_try('authenticated', u_own, format(post, ch, 'reply two', m1, '[]', NULL));
  n := n + 1; failed := failed || pg_temp.tc_check('a thread reply could not quote another reply of its thread', u_own,
    format(post, ch, 'q', m1, '[]', r1), '________-%');
  n := n + 1; failed := failed || pg_temp.tc_check('a thread reply could not quote its root', u_ag,
    format(post, ch, 'q', m1, '[]', m1), '________-%');
  r := pg_temp.tc_try('authenticated', u_own, format(post, ch, 'top quote', NULL, '[]', m1));
  n := n + 1; failed := failed || pg_temp.tc_ok(r ~ uuid_re, 'a top-level message could not quote a top-level one (' || r || ')');
  n := n + 1; failed := failed || pg_temp.tc_check('the quote was not stored', NULL,
    format('SELECT reply_to_id::text FROM internal_messages WHERE id = %L', CASE WHEN r ~ uuid_re THEN r END), m1::text);
  n := n + 1; failed := failed || pg_temp.tc_check('reply_to_id could be changed on UPDATE', NULL,
    format('UPDATE internal_messages SET reply_to_id = NULL WHERE id = %L RETURNING 1', CASE WHEN r ~ uuid_re THEN r END), 'ERROR 42501:%immutable%');
  n := n + 1; failed := failed || pg_temp.tc_check('a top-level message quoted a thread reply', u_own,
    format(post, ch, 'q', NULL, '[]', r1), 'ERROR 22023:%quoted message%');
  n := n + 1; failed := failed || pg_temp.tc_check('a thread reply quoted a top-level message outside its thread', u_own,
    format(post, ch, 'q', m1, '[]', v1), 'ERROR 22023:%quoted message%');
  pm := pg_temp.tc_try('authenticated', u_own, format(post, pv, 'private text', NULL, '[]', NULL));
  n := n + 1; failed := failed || pg_temp.tc_check('a message quoted one of another channel', u_own,
    format(post, ch, 'q', NULL, '[]', pm), 'ERROR 22023:%quoted message%');
  md := pg_temp.tc_try('authenticated', u_own, format(post, ch, 'to delete', NULL, '[]', NULL));
  r := pg_temp.tc_try('authenticated', u_own, format('SELECT array_to_string(public.chat_delete_message(%L), '','')', md));
  n := n + 1; failed := failed || pg_temp.tc_check('the fixture message was not deleted', NULL,
    format('SELECT (deleted_at IS NOT NULL)::text FROM internal_messages WHERE id = %L', md), 'true');
  n := n + 1; failed := failed || pg_temp.tc_check('a deleted message could be quoted', u_own,
    format(post, ch, 'q', NULL, '[]', md), 'ERROR 22023:%quoted message%');

  -- ---------- D. forwarding ----------
  r := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_forward_message(%L, %L)::text', m1, ch));
  n := n + 1; failed := failed || pg_temp.tc_ok(r ~ uuid_re, 'a forward within the workspace failed (' || r || ')');
  IF r ~ uuid_re THEN fw := r::uuid; END IF;
  n := n + 1; failed := failed || pg_temp.tc_check('a forward did not render the mention as @Name', NULL,
    format('SELECT body FROM internal_messages WHERE id = %L', fw), 'hi @Agent Vee');
  n := n + 1; failed := failed || pg_temp.tc_check('a forward''s meta.forwarded does not name the source', NULL,
    format('SELECT concat_ws(''|'', f.meta->''forwarded''->>''message_id'', f.meta->''forwarded''->>''author_id'', f.meta->''forwarded''->>''author_kind'','
      || ' ((f.meta->''forwarded''->>''created_at'')::timestamptz = s.created_at)::text, f.author_id::text)'
      || ' FROM internal_messages f, internal_messages s WHERE f.id = %L AND s.id = %L', fw, m1),
    m1 || '|' || u_own || '|user|true|' || u_own);
  n := n + 1; failed := failed || pg_temp.tc_check('a forward created mention rows or bells in a team channel', NULL,
    format('SELECT ((SELECT count(*) FROM message_mentions WHERE message_id = %L) + (SELECT count(*) FROM chat_notifications WHERE message_id = %L))::text', fw, fw), '0');
  r := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_forward_message(%L, %L)::text', r1, ch));
  n := n + 1; failed := failed || pg_temp.tc_check('a forward of a thread reply is not top level', NULL,
    format('SELECT (thread_root_id IS NULL AND reply_to_id IS NULL)::text FROM internal_messages WHERE id = %L', CASE WHEN r ~ uuid_re THEN r END), 'true');
  IF r ~ uuid_re THEN copies := copies || r::uuid; END IF;
  fdm := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_forward_message(%L, %L)::text', m1, dm));
  n := n + 1; failed := failed || pg_temp.tc_check('a forward into a DM did not ring the other member as dm only', NULL,
    format('SELECT string_agg(user_id || ''|'' || kind, '','') FROM chat_notifications WHERE message_id = %L', fdm),
    u_ag || '|dm');
  n := n + 1; failed := failed || pg_temp.tc_check('a forward into another workspace was not refused', u_own,
    format('SELECT public.chat_forward_message(%L, %L)::text', m1, chb), 'ERROR 42501:%within its workspace%');
  n := n + 1; failed := failed || pg_temp.tc_check('a forward of an unreadable message was not P0002', u_ag2,
    format('SELECT public.chat_forward_message(%L, %L)::text', pm, ch), 'ERROR P0002:%');
  n := n + 1; failed := failed || pg_temp.tc_check('a forward of a missing message was not P0002', u_own,
    format('SELECT public.chat_forward_message(%L, %L)::text', gen_random_uuid(), ch), 'ERROR P0002:%');
  n := n + 1; failed := failed || pg_temp.tc_check('a forward of a deleted message was not refused', u_own,
    format('SELECT public.chat_forward_message(%L, %L)::text', md, ch), 'ERROR 22023:%deleted message%');
  n := n + 1; failed := failed || pg_temp.tc_check('a forward into a channel the caller cannot post in was not refused', u_ag2,
    format('SELECT public.chat_forward_message(%L, %L)::text', m1, pv), 'ERROR 42501:%');
  n := n + 1; failed := failed || pg_temp.tc_check('a bank guest forwarded out of the deal room', u_g,
    format('SELECT public.chat_forward_message(%L, %L)::text', m1, dr), 'ERROR %');

  -- ---------- D2. one object, one attachment row; a forward copies its source ----------
  p1 := pg_temp.tc_up(a, ch, 'reuse.pdf');
  r := pg_temp.tc_try('authenticated', u_own, format(post, ch, 'reuse source', NULL, pg_temp.tc_a1(p1, 'reuse.pdf', 'application/pdf', 100, NULL, NULL), NULL));
  n := n + 1; failed := failed || pg_temp.tc_ok(r ~ uuid_re, 'the reuse fixture post failed (' || r || ')');
  IF r ~ uuid_re THEN rp := r::uuid; END IF;
  n := n + 1; failed := failed || pg_temp.tc_check('a post re-used another message''s attachment path', u_own,
    format(post, ch, 'reuse', NULL, pg_temp.tc_a1(p1, 'reuse.pdf', 'application/pdf', 100, NULL, NULL), NULL),
    'ERROR 22023:%already belongs to a message%');
  n := n + 1; failed := failed || pg_temp.tc_check('a forward re-used the source''s own attachment path', u_own,
    format(fwa, rp, ch, pg_temp.tc_a1(p1, 'reuse.pdf', 'application/pdf', 100, NULL, NULL)),
    'ERROR 22023:%already belongs to a message%');
  p2 := pg_temp.tc_up(a, ch, 'twice.pdf');
  n := n + 1; failed := failed || pg_temp.tc_check('a post named one path twice', u_own,
    format(post, ch, 'twice', NULL, format('[{"storage_path":%s,"name":"a.pdf","mime":"application/pdf","bytes":1},'
      || '{"storage_path":%s,"name":"b.pdf","mime":"application/pdf","bytes":1}]', to_json(p2), to_json(p2)), NULL),
    'ERROR 22023:%already belongs to a message%');
  n := n + 1; failed := failed || pg_temp.tc_check('a forward with a correct copy of the source''s file failed', u_own,
    format(fwa, rp, ch, pg_temp.tc_a1(pg_temp.tc_up(a, ch, 'reuse.pdf'), 'reuse.pdf', 'application/pdf', 100, NULL, NULL)),
    '________-____-____-____-____________');
  n := n + 1; failed := failed || pg_temp.tc_check('a forward''s copy with another name was accepted', u_own,
    format(fwa, rp, ch, pg_temp.tc_a1(pg_temp.tc_up(a, ch, 'other.pdf'), 'other.pdf', 'application/pdf', 100, NULL, NULL)),
    'ERROR 22023:%copies of the source message%');
  n := n + 1; failed := failed || pg_temp.tc_check('a forward''s copy with another mime was accepted', u_own,
    format(fwa, rp, ch, pg_temp.tc_a1(pg_temp.tc_up(a, ch, 'reuse.pdf'), 'reuse.pdf', 'application/zip', 100, NULL, NULL)),
    'ERROR 22023:%copies of the source message%');
  n := n + 1; failed := failed || pg_temp.tc_check('a forward''s copy with another size was accepted', u_own,
    format(fwa, rp, ch, pg_temp.tc_a1(pg_temp.tc_up(a, ch, 'reuse.pdf'), 'reuse.pdf', 'application/pdf', 101, NULL, NULL)),
    'ERROR 22023:%copies of the source message%');
  n := n + 1; failed := failed || pg_temp.tc_check('a forward carried more copies than the source has files', u_own,
    format(fwa, rp, ch, format('[{"storage_path":%s,"name":"reuse.pdf","mime":"application/pdf","bytes":100},'
      || '{"storage_path":%s,"name":"reuse.pdf","mime":"application/pdf","bytes":100}]',
      to_json(pg_temp.tc_up(a, ch, 'reuse.pdf')), to_json(pg_temp.tc_up(a, ch, 'reuse.pdf')))),
    'ERROR 22023:%copies of the source message%');
  n := n + 1; failed := failed || pg_temp.tc_check('a forward of a text message carried a file', u_own,
    format(fwa, m1, ch, pg_temp.tc_a1(pg_temp.tc_up(a, ch, 'reuse.pdf'), 'reuse.pdf', 'application/pdf', 100, NULL, NULL)),
    'ERROR 22023:%copies of the source message%');
  n := n + 1; failed := failed || pg_temp.tc_check('a voice note''s copy as kind file was accepted', u_own,
    format(fwa, v1, ch, pg_temp.tc_a1(pg_temp.tc_up(a, ch, 'voice.ogg'), 'voice.ogg', 'audio/ogg', 100, NULL, NULL)),
    'ERROR 22023:%copies of the source message%');
  n := n + 1; failed := failed || pg_temp.tc_check('a voice note''s copy with another duration was accepted', u_own,
    format(fwa, v1, ch, pg_temp.tc_a1(pg_temp.tc_up(a, ch, 'voice.ogg'), 'voice.ogg', 'audio/ogg', 100, 'voice', 4201)),
    'ERROR 22023:%copies of the source message%');

  -- ---------- E. typing ----------
  r := pg_temp.tc_try('authenticated', u_ag, format('SELECT public.chat_set_typing(%L)::text', ch));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = 'ok', 'a member could not type (' || r || ')');
  UPDATE chat_typing SET at = now() - interval '1 second' WHERE channel_id = ch AND user_id = u_ag RETURNING at INTO t1;
  r := pg_temp.tc_try('authenticated', u_ag, format('SELECT public.chat_set_typing(%L)::text', ch));
  n := n + 1; failed := failed || pg_temp.tc_check('a typing row younger than 2 s on the same thread was rewritten', NULL,
    format('SELECT (at = %L::timestamptz)::text FROM chat_typing WHERE channel_id = %L AND user_id = %L', t1, ch, u_ag), 'true');
  r := pg_temp.tc_try('authenticated', u_ag, format('SELECT public.chat_set_typing(%L, %L::uuid)::text', ch, m1));
  n := n + 1; failed := failed || pg_temp.tc_check('a typing row did not follow a thread switch within 2 s', NULL,
    format('SELECT (thread_root_id = %L AND at > %L::timestamptz)::text FROM chat_typing WHERE channel_id = %L AND user_id = %L', m1, t1, ch, u_ag), 'true');
  UPDATE chat_typing SET at = now() - interval '3 seconds' WHERE channel_id = ch AND user_id = u_ag RETURNING at INTO t1;
  r := pg_temp.tc_try('authenticated', u_ag, format('SELECT public.chat_set_typing(%L, %L::uuid)::text', ch, m1));
  n := n + 1; failed := failed || pg_temp.tc_check('a typing row older than 2 s was not refreshed', NULL,
    format('SELECT (at > %L::timestamptz)::text FROM chat_typing WHERE channel_id = %L AND user_id = %L', t1, ch, u_ag), 'true');
  n := n + 1; failed := failed || pg_temp.tc_check('typing took a thread reply as its root', u_ag,
    format('SELECT public.chat_set_typing(%L, %L::uuid)::text', ch, r1), 'ERROR 22023:%');
  n := n + 1; failed := failed || pg_temp.tc_check('typing took another channel''s message as its root', u_ag,
    format('SELECT public.chat_set_typing(%L, %L::uuid)::text', ch, pm), 'ERROR 22023:%');
  n := n + 1; failed := failed || pg_temp.tc_check('a member does not see a typing row', u_own,
    format('SELECT count(*)::text FROM chat_typing WHERE channel_id = %L', ch), '1');
  r := pg_temp.tc_try('authenticated', u_ag, format('SELECT public.chat_set_typing(%L, NULL, false)::text', ch));
  n := n + 1; failed := failed || pg_temp.tc_check('typing false did not keep the row and mark it stopped', NULL,
    format('SELECT count(*) FILTER (WHERE stopped) || ''/'' || count(*) FROM chat_typing WHERE channel_id = %L AND user_id = %L', ch, u_ag), '1/1');
  r := pg_temp.tc_try('authenticated', u_x, format('SELECT public.chat_set_typing(%L)::text', ch));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = 'ok', 'a workspace member could not type in a team channel (' || r || ')');
  n := n + 1; failed := failed || pg_temp.tc_check('typing in a team channel made the typist a member', NULL,
    format('SELECT count(*)::text FROM chat_channel_members WHERE channel_id = %L AND user_id = %L', ch, u_x), '0');
  n := n + 1; failed := failed || pg_temp.tc_check('someone from another workspace could type', u_po,
    format('SELECT public.chat_set_typing(%L)::text', ch), 'ERROR 42501:%');
  -- private channel: a non-member can neither type nor see typing
  r := pg_temp.tc_try('authenticated', u_ag, format('SELECT public.chat_set_typing(%L)::text', pv));
  n := n + 1; failed := failed || pg_temp.tc_check('a non-member could type in a private channel', u_ag2,
    format('SELECT public.chat_set_typing(%L)::text', pv), 'ERROR 42501:%');
  n := n + 1; failed := failed || pg_temp.tc_check('a non-reader sees a private channel''s typing (RLS)', u_ag2,
    format('SELECT count(*)::text FROM chat_typing WHERE channel_id = %L', pv), '0');
  n := n + 1; failed := failed || pg_temp.tc_check('a member does not see a private channel''s typing (RLS)', u_own,
    format('SELECT count(*)::text FROM chat_typing WHERE channel_id = %L', pv), '1');
  INSERT INTO chat_typing (channel_id, account_id, user_id) VALUES (pv, a, u_ag2);
  r := pg_temp.tc_try('authenticated', u_ag2, format('SELECT public.chat_set_typing(%L, NULL, false)::text', pv));
  n := n + 1; failed := failed || pg_temp.tc_check('typing false without access did not clear the caller''s own row', NULL,
    format('SELECT %L || ''|'' || count(*) FILTER (WHERE stopped) || ''/'' || count(*) FROM chat_typing WHERE channel_id = %L AND user_id = %L', r, pv, u_ag2), 'ok|1/1');
  -- deal room: the guest cannot read the Team notes, so no typing either way
  r := pg_temp.tc_try('authenticated', u_ag, format('SELECT public.chat_set_typing(%L)::text', dr));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = 'ok', 'a staff member could not type in a deal room (' || r || ')');
  n := n + 1; failed := failed || pg_temp.tc_check('a bank guest could type in a deal room''s Team notes', u_g,
    format('SELECT public.chat_set_typing(%L)::text', dr), 'ERROR 42501:%');
  n := n + 1; failed := failed || pg_temp.tc_check('a bank guest sees a deal room''s typing (RLS)', u_g,
    format('SELECT count(*)::text FROM chat_typing WHERE channel_id = %L', dr), '0');
  n := n + 1; failed := failed || pg_temp.tc_check('a deal room member does not see its typing (RLS)', u_own,
    format('SELECT count(*)::text FROM chat_typing WHERE channel_id = %L', dr), '1');

  -- ---------- E2. a stop keeps the row; stop + start cannot beat the 2 s cap ----------
  tch := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_create_channel(%L, %L, %L, NULL, %L::uuid[])::text', a, 'team', 'TC2 typing', ARRAY[u_ag]));
  tpv := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_create_channel(%L, %L, %L, NULL, %L::uuid[])::text', a, 'private', 'TC2 typing private', ARRAY[u_ag]));
  r := pg_temp.tc_try('authenticated', u_ag, format('SELECT public.chat_set_typing(%L)::text', tch));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = 'ok', 'the typing-stop fixture could not type (' || r || ')');
  UPDATE chat_typing SET at = now() - interval '1 second' WHERE channel_id = tch AND user_id = u_ag RETURNING at INTO t1;
  r := pg_temp.tc_try('authenticated', u_ag, format('SELECT public.chat_set_typing(%L, NULL, false)::text', tch));
  n := n + 1; failed := failed || pg_temp.tc_check('a typing stop deleted the row or moved its time', NULL,
    format('SELECT %L || ''|'' || count(*) FILTER (WHERE stopped AND at = %L::timestamptz) || ''/'' || count(*) FROM chat_typing WHERE channel_id = %L AND user_id = %L', r, t1, tch, u_ag),
    'ok|1/1');
  r := pg_temp.tc_try('authenticated', u_ag, format('SELECT public.chat_set_typing(%L)::text', tch));
  n := n + 1; failed := failed || pg_temp.tc_check('a start within 2 s of a stop on the same thread changed the row', NULL,
    format('SELECT %L || ''|'' || count(*) FILTER (WHERE stopped AND at = %L::timestamptz) || ''/'' || count(*) FROM chat_typing WHERE channel_id = %L AND user_id = %L', r, t1, tch, u_ag),
    'ok|1/1');
  r := pg_temp.tc_try('authenticated', u_ag, format('SELECT public.chat_set_typing(%L, NULL, false)::text', tch));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = 'ok', 'a second typing stop was refused (' || r || ')');
  UPDATE chat_typing SET at = now() - interval '3 seconds' WHERE channel_id = tch AND user_id = u_ag RETURNING at INTO t1;
  r := pg_temp.tc_try('authenticated', u_ag, format('SELECT public.chat_set_typing(%L)::text', tch));
  n := n + 1; failed := failed || pg_temp.tc_check('a start over 2 s after a stop did not resume typing', NULL,
    format('SELECT count(*) FILTER (WHERE NOT stopped AND at > %L::timestamptz) || ''/'' || count(*) FROM chat_typing WHERE channel_id = %L AND user_id = %L', t1, tch, u_ag),
    '1/1');
  r := pg_temp.tc_try('authenticated', u_ag, format('SELECT public.chat_set_typing(%L)::text', tpv));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = 'ok', 'the lost-access fixture could not type (' || r || ')');
  DELETE FROM chat_channel_members WHERE channel_id = tpv AND user_id = u_ag;
  n := n + 1; failed := failed || pg_temp.tc_check('the lost-access fixture can still type', u_ag,
    format('SELECT public.chat_set_typing(%L)::text', tpv), 'ERROR 42501:%');
  r := pg_temp.tc_try('authenticated', u_ag, format('SELECT public.chat_set_typing(%L, NULL, false)::text', tpv));
  n := n + 1; failed := failed || pg_temp.tc_check('a member who lost access could not stop typing, or the row went', NULL,
    format('SELECT %L || ''|'' || count(*) FILTER (WHERE stopped) || ''/'' || count(*) FROM chat_typing WHERE channel_id = %L AND user_id = %L', r, tpv, u_ag),
    'ok|1/1');

  -- ---------- F. voice plays ----------
  r := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_mark_voice_played(%L)::text', v1));
  n := n + 1; failed := failed || pg_temp.tc_check('a reader''s play was not recorded', NULL,
    format('SELECT %L || ''|'' || count(*) FROM chat_voice_plays WHERE message_id = %L AND user_id = %L', r, v1, u_own), 'ok|1');
  r := pg_temp.tc_try('authenticated', u_ag, format('SELECT public.chat_mark_voice_played(%L)::text', v1));
  n := n + 1; failed := failed || pg_temp.tc_check('the author''s own play was recorded', NULL,
    format('SELECT %L || ''|'' || count(*) FROM chat_voice_plays WHERE message_id = %L AND user_id = %L', r, v1, u_ag), 'ok|0');
  n := n + 1; failed := failed || pg_temp.tc_check('a play of a non-voice message was accepted', u_own,
    format('SELECT public.chat_mark_voice_played(%L)::text', m1), 'ERROR 22023:%');
  pvv := pg_temp.tc_try('authenticated', u_ag, format(post, pv, 'pv voice', NULL,
           format(att, to_json(pg_temp.tc_up(a, pv, 'pv.ogg')), 'pv.ogg', 'audio/ogg', ',"kind":"voice","duration_ms":900'), NULL));
  r := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_mark_voice_played(%L)::text', pvv));
  n := n + 1; failed := failed || pg_temp.tc_check('a play of an unreadable voice note was not P0002', u_ag2,
    format('SELECT public.chat_mark_voice_played(%L)::text', pvv), 'ERROR P0002:%');
  n := n + 1; failed := failed || pg_temp.tc_check('a non-reader sees a private voice note''s plays (RLS)', u_ag2,
    format('SELECT count(*)::text FROM chat_voice_plays WHERE message_id = %L', pvv), '0');
  n := n + 1; failed := failed || pg_temp.tc_check('the author does not see a play of their voice note (RLS)', u_ag,
    format('SELECT count(*)::text FROM chat_voice_plays WHERE message_id = %L', pvv), '1');
  drv := pg_temp.tc_try('authenticated', u_ag, format(post, dr, 'dr voice', NULL,
           format(att, to_json(pg_temp.tc_up(a, dr, 'dr.ogg')), 'dr.ogg', 'audio/ogg', ',"kind":"voice","duration_ms":900'), NULL));
  r := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_mark_voice_played(%L)::text', drv));
  n := n + 1; failed := failed || pg_temp.tc_check('a deal room member''s play was not recorded', u_ag,
    format('SELECT count(*)::text FROM chat_voice_plays WHERE message_id = %L', drv), '1');
  n := n + 1; failed := failed || pg_temp.tc_check('a bank guest sees a deal room voice note''s plays (RLS)', u_g,
    format('SELECT count(*)::text FROM chat_voice_plays WHERE message_id = %L', drv), '0');
  n := n + 1; failed := failed || pg_temp.tc_check('a bank guest could mark a deal room voice note played', u_g,
    format('SELECT public.chat_mark_voice_played(%L)::text', drv), 'ERROR P0002:%');
  UPDATE accounts SET internal_chat_enabled = false WHERE id = a;
  n := n + 1; failed := failed || pg_temp.tc_check('a play was accepted with internal chat off', u_own,
    format('SELECT public.chat_mark_voice_played(%L)::text', v1), 'ERROR CH001:%');
  UPDATE accounts SET internal_chat_enabled = true WHERE id = a;

  -- ---------- G. channel files ----------
  -- fc: voice 3 min ago, image 2 min, pdf 1 min, and a deleted video 30 s
  -- ago (written directly so the timestamps differ inside one transaction)
  DECLARE fm UUID;
  BEGIN
    INSERT INTO internal_messages (channel_id, account_id, author_kind, author_id, body, created_at)
    VALUES (fc, a, 'user', u_ag, 'f voice', now() - interval '3 minutes') RETURNING id INTO fm;
    INSERT INTO message_attachments (message_id, storage_path, name, mime, bytes, kind, duration_ms)
    VALUES (fm, pg_temp.tc_up(a, fc, 'a.ogg'), 'a.ogg', 'audio/ogg', 1, 'voice', 1000);
    INSERT INTO internal_messages (channel_id, account_id, author_kind, author_id, body, created_at)
    VALUES (fc, a, 'user', u_ag, 'f image', now() - interval '2 minutes') RETURNING id INTO fm;
    INSERT INTO message_attachments (message_id, storage_path, name, mime, bytes)
    VALUES (fm, pg_temp.tc_up(a, fc, 'b.png'), 'b.png', 'image/png', 1);
    INSERT INTO internal_messages (channel_id, account_id, author_kind, author_id, body, created_at)
    VALUES (fc, a, 'user', u_ag, 'f pdf', now() - interval '1 minute') RETURNING id INTO fm;
    INSERT INTO message_attachments (message_id, storage_path, name, mime, bytes)
    VALUES (fm, pg_temp.tc_up(a, fc, 'c.pdf'), 'c.pdf', 'application/pdf', 1);
    INSERT INTO internal_messages (channel_id, account_id, author_kind, author_id, body, created_at, deleted_at)
    VALUES (fc, a, 'user', u_ag, 'f video', now() - interval '30 seconds', now()) RETURNING id INTO fm;
    INSERT INTO message_attachments (message_id, storage_path, name, mime, bytes)
    VALUES (fm, pg_temp.tc_up(a, fc, 'd.mp4'), 'd.mp4', 'video/mp4', 1);
  END;
  n := n + 1; failed := failed || pg_temp.tc_check('the files list is not the live attachments newest first', u_own,
    format('SELECT string_agg(name, '','' ORDER BY ordinality) FROM public.chat_channel_files(%L) WITH ORDINALITY', fc), 'c.pdf,b.png,a.ogg');
  n := n + 1; failed := failed || pg_temp.tc_check('the voice filter is wrong', u_own,
    format('SELECT string_agg(name || ''|'' || kind || ''|'' || duration_ms, '','') FROM public.chat_channel_files(%L, %L)', fc, 'voice'), 'a.ogg|voice|1000');
  n := n + 1; failed := failed || pg_temp.tc_check('the image filter is wrong', u_own,
    format('SELECT string_agg(name, '','') FROM public.chat_channel_files(%L, %L)', fc, 'image'), 'b.png');
  n := n + 1; failed := failed || pg_temp.tc_check('the file filter is wrong', u_own,
    format('SELECT string_agg(name, '','') FROM public.chat_channel_files(%L, %L)', fc, 'file'), 'c.pdf');
  n := n + 1; failed := failed || pg_temp.tc_check('the video filter listed a deleted message', u_own,
    format('SELECT count(*)::text FROM public.chat_channel_files(%L, %L)', fc, 'video'), '0');
  n := n + 1; failed := failed || pg_temp.tc_check('p_before did not page back', u_own,
    format('SELECT string_agg(name, '','' ORDER BY ordinality) FROM public.chat_channel_files(%L, NULL, now() - interval ''90 seconds'') WITH ORDINALITY', fc), 'b.png,a.ogg');
  n := n + 1; failed := failed || pg_temp.tc_check('p_limit 0 was not clamped to 1', u_own,
    format('SELECT string_agg(name, '','') FROM public.chat_channel_files(%L, NULL, NULL, 0)', fc), 'c.pdf');
  n := n + 1; failed := failed || pg_temp.tc_check('p_limit 500 did not list everything', u_own,
    format('SELECT count(*)::text FROM public.chat_channel_files(%L, NULL, NULL, 500)', fc), '3');
  n := n + 1; failed := failed || pg_temp.tc_check('an unknown kind was accepted', u_own,
    format('SELECT count(*)::text FROM public.chat_channel_files(%L, %L)', fc, 'audio'), 'ERROR 22023:%');
  n := n + 1; failed := failed || pg_temp.tc_check('a non-reader lists a private channel''s files', u_ag2,
    format('SELECT count(*)::text FROM public.chat_channel_files(%L)', pv), '0');
  n := n + 1; failed := failed || pg_temp.tc_check('a member does not list a private channel''s files', u_own,
    format('SELECT count(*)::text FROM public.chat_channel_files(%L)', pv), '1');
  n := n + 1; failed := failed || pg_temp.tc_check('another workspace lists the channel''s files', u_po,
    format('SELECT count(*)::text FROM public.chat_channel_files(%L)', fc), '0');
  n := n + 1; failed := failed || pg_temp.tc_check('a bank guest lists a deal room''s files', u_g,
    format('SELECT count(*)::text FROM public.chat_channel_files(%L)', dr), '0');
  n := n + 1; failed := failed || pg_temp.tc_ok(NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.chat_channel_files(uuid,text,timestamptz,integer)'::regprocedure),
    'chat_channel_files is SECURITY DEFINER');

  -- ---------- H. erasure of ag ----------
  -- own forwards ag's voice note (with a copy of the file), x forwards
  -- that forward (a forward of a forward, its meta naming own), ag has a
  -- typing row and a play of own's voice note.
  vpc := pg_temp.tc_up(a, ch, 'fwd.ogg');
  fv := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_forward_message(%L, %L, %L::jsonb)::text', v1, ch,
          format(att, to_json(vpc), 'voice.ogg', 'audio/ogg', ',"kind":"voice","duration_ms":4200')));
  vpcc := pg_temp.tc_up(a, ch, 'fwd2.ogg');
  ff := pg_temp.tc_try('authenticated', u_x, format('SELECT public.chat_forward_message(%L, %L, %L::jsonb)::text', fv, ch,
          format(att, to_json(vpcc), 'voice.ogg', 'audio/ogg', ',"kind":"voice","duration_ms":4200')));
  n := n + 1; failed := failed || pg_temp.tc_check('the forward-of-a-forward fixture does not chain', NULL,
    format('SELECT concat_ws(''|'', meta->''forwarded''->>''message_id'', meta->''forwarded''->>''author_id'') FROM internal_messages WHERE id = %L', ff),
    fv || '|' || u_own);
  copies := copies || fv || ff;
  -- own forwards ag's thread reply into a DM with x: x's bell and a
  -- queued push name the copy, and neither belongs to ag.
  dmx := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_open_dm(%L, %L::uuid[])::text', a, ARRAY[u_x]));
  r := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_forward_message(%L, %L)::text', r1, dmx));
  IF r ~ uuid_re THEN fx := r::uuid; copies := copies || fx; END IF;
  INSERT INTO push_outbox (user_id, account_id, kind, title, url, channel_id, source_user_id, message_id)
  VALUES (u_x, a, 'chat_message', 'TC2', '/chat', dmx, u_own, fx);
  n := n + 1; failed := failed || pg_temp.tc_check('the copy-bell fixture has no bell or push of the copy for x', NULL,
    format('SELECT ((SELECT count(*) FROM chat_notifications WHERE message_id = %L AND user_id = %L) > 0'
      || ' AND (SELECT count(*) FROM push_outbox WHERE message_id = %L AND user_id = %L) > 0)::text', fx, u_x, fx, u_x), 'true');
  ov := pg_temp.tc_try('authenticated', u_own, format(post, ch, 'own voice', NULL,
          format(att, to_json(pg_temp.tc_up(a, ch, 'own.ogg')), 'own.ogg', 'audio/ogg', ',"kind":"voice","duration_ms":800'), NULL));
  r := pg_temp.tc_try('authenticated', u_ag, format('SELECT public.chat_mark_voice_played(%L)::text', ov));
  r := pg_temp.tc_try('authenticated', u_ag, format('SELECT public.chat_set_typing(%L)::text', ch));
  n := n + 1; failed := failed || pg_temp.tc_check('the erasure fixture has no typing or play row of the person', NULL,
    format('SELECT ((SELECT count(*) FROM chat_typing WHERE user_id = %L) > 0 AND (SELECT count(*) FROM chat_voice_plays WHERE user_id = %L) > 0)::text', u_ag, u_ag), 'true');

  r := pg_temp.tc_try('authenticated', u_ag, format('SELECT array_to_string(public.chat_erase_person(%L, %L, %L), '','')', a, u_ag, 'CI check of erasure'));
  n := n + 1; failed := failed || pg_temp.tc_ok(r LIKE 'ERROR 42501%', 'a non-owner could erase a person (' || r || ')');
  r := pg_temp.tc_try('authenticated', u_own, format('SELECT array_to_string(public.chat_erase_person(%L, %L, %L), '','')', a, u_ag, 'CI check of erasure'));
  n := n + 1; failed := failed || pg_temp.tc_ok(r NOT LIKE 'ERROR%' AND vp = ANY (string_to_array(r, ',')),
    'the erasure did not return the person''s own voice path (' || r || ')');
  n := n + 1; failed := failed || pg_temp.tc_ok(vpc = ANY (string_to_array(r, ',')) AND vpcc = ANY (string_to_array(r, ',')),
    'the erasure did not return the forwarded copies'' paths (' || r || ')');
  n := n + 1; failed := failed || pg_temp.tc_check('a forwarded copy of the person''s message was not erased', NULL,
    format('SELECT string_agg(DISTINCT body || ''|'' || (erased_at IS NOT NULL), '','') FROM internal_messages WHERE id = ANY (%L::uuid[])', copies),
    '[erased]|true');
  n := n + 1; failed := failed || pg_temp.tc_check('a forward of a forward was not erased', NULL,
    format('SELECT body || ''|'' || (erased_at IS NOT NULL) || ''|'' || (SELECT count(*) FROM message_attachments WHERE message_id = %L) FROM internal_messages WHERE id = %L', ff, ff),
    '[erased]|true|0');
  n := n + 1; failed := failed || pg_temp.tc_check('a forwarded copy kept its attachment', NULL,
    format('SELECT count(*)::text FROM message_attachments WHERE message_id = ANY (%L::uuid[])', copies), '0');
  n := n + 1; failed := failed || pg_temp.tc_check('a forward of someone else''s message was erased', NULL,
    format('SELECT body || ''|'' || (erased_at IS NULL) FROM internal_messages WHERE id = %L', fw), 'hi @Agent Vee|true');
  n := n + 1; failed := failed || pg_temp.tc_check('the person''s typing or play rows survived', NULL,
    format('SELECT ((SELECT count(*) FROM chat_typing WHERE user_id = %L) + (SELECT count(*) FROM chat_voice_plays WHERE user_id = %L))::text', u_ag, u_ag), '0');
  n := n + 1; failed := failed || pg_temp.tc_check('the audit row does not count the forwarded copies', NULL,
    format('SELECT detail->>''forwarded_copies'' FROM chat_audit_log WHERE account_id = %L AND action = ''erase_person'' AND detail->>''user_id'' = %L', a, u_ag),
    cardinality(copies)::text);
  n := n + 1; failed := failed || pg_temp.tc_check('a chat_notifications row of a forwarded copy survived the erasure', NULL,
    format('SELECT count(*)::text FROM chat_notifications WHERE message_id = %L', fx), '0');
  n := n + 1; failed := failed || pg_temp.tc_check('a push_outbox row of a forwarded copy survived the erasure', NULL,
    format('SELECT count(*)::text FROM push_outbox WHERE message_id = %L', fx), '0');

  -- ---------- privileges ----------
  n := n + 1; failed := failed || pg_temp.tc_check('the new tables are writable or readable beyond authenticated SELECT', NULL,
    'SELECT (has_table_privilege(''authenticated'', ''public.chat_typing'', ''SELECT'') AND has_table_privilege(''authenticated'', ''public.chat_voice_plays'', ''SELECT'')'
      || ' AND NOT has_table_privilege(''authenticated'', ''public.chat_typing'', ''INSERT,UPDATE,DELETE'')'
      || ' AND NOT has_table_privilege(''authenticated'', ''public.chat_voice_plays'', ''INSERT,UPDATE,DELETE'')'
      || ' AND NOT has_table_privilege(''anon'', ''public.chat_typing'', ''SELECT,INSERT,UPDATE,DELETE'')'
      || ' AND NOT has_table_privilege(''anon'', ''public.chat_voice_plays'', ''SELECT,INSERT,UPDATE,DELETE'')'
      || ' AND NOT has_table_privilege(''service_role'', ''public.chat_typing'', ''SELECT,INSERT,UPDATE,DELETE'')'
      || ' AND NOT has_table_privilege(''service_role'', ''public.chat_voice_plays'', ''SELECT,INSERT,UPDATE,DELETE''))::text', 'true');
  n := n + 1; failed := failed || pg_temp.tc_check('RLS is not forced on the new tables', NULL,
    'SELECT bool_and(relrowsecurity AND relforcerowsecurity)::text FROM pg_class WHERE oid IN (''public.chat_typing''::regclass, ''public.chat_voice_plays''::regclass)', 'true');
  FOREACH f IN ARRAY fns || internal_fns LOOP
    n := n + 1; failed := failed || pg_temp.tc_ok(NOT has_function_privilege('anon', f, 'EXECUTE')
                                                 AND NOT has_function_privilege('public', f, 'EXECUTE')
                                                 AND NOT has_function_privilege('service_role', f, 'EXECUTE'),
      f || ' is executable by anon, PUBLIC or service_role');
  END LOOP;
  FOREACH f IN ARRAY fns LOOP
    n := n + 1; failed := failed || pg_temp.tc_ok(has_function_privilege('authenticated', f, 'EXECUTE'),
      f || ' is not executable by authenticated');
  END LOOP;
  FOREACH f IN ARRAY internal_fns LOOP
    n := n + 1; failed := failed || pg_temp.tc_ok(NOT has_function_privilege('authenticated', f, 'EXECUTE'),
      f || ' is executable by authenticated');
  END LOOP;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT156', MESSAGE = 'verify-chat-messaging-v2 rollback';
  EXCEPTION WHEN SQLSTATE 'ZT156' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'chat messaging v2 verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'chat messaging v2 verification passed (% checks)', n;
END
$verify$;
