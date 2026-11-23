-- Behavioural suite for migration 283: in chat-media and flow-media a
-- signed-in person reaches (lists, reads, changes, deletes) only the
-- objects they uploaded, uploads only into the folders the browser
-- writes, and cannot move an object into a server folder. The voice
-- library stays as 242 left it, the service role does everything, a
-- guest and a deactivated person still reach nothing, and another bucket
-- is not touched.
--
-- Two kinds of statement on purpose: one with a WHERE (what Storage
-- runs; it needs the SELECT policy as well) and one without, which reads
-- no column and so meets the UPDATE or DELETE policy alone. Without the
-- second kind, the SELECT policy would hide a missing one.
--
-- ONE statement on purpose (the pinned CLI rejects several). Fixtures
-- are rolled back by a sentinel exception; the results survive.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000283001';
  u_admin UUID := '00000000-0000-4000-8000-000000283002';
  u_a     UUID := '00000000-0000-4000-8000-000000283003';
  u_b     UUID := '00000000-0000-4000-8000-000000283004';
  u_lead  UUID := '00000000-0000-4000-8000-000000283005';
  u_guest UUID := '00000000-0000-4000-8000-000000283006';
  u_gone  UUID := '00000000-0000-4000-8000-000000283007';
  acct    UUID;
  dir     TEXT;
  who     RECORD;
  it      RECORD;
  r       TEXT;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  BEGIN
  -- As one signed-in person (p_uid NULL: the service role): the value of
  -- a SELECT, the row count of anything else, or the error.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.mo_try(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; c bigint; v_role text;
    BEGIN
      v_role := CASE WHEN p_uid IS NULL THEN 'service_role' ELSE 'authenticated' END;
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', v_role)::text, true);
        EXECUTE format('SET LOCAL ROLE %I', v_role);
        IF p_sql ILIKE 'select%' THEN
          EXECUTE p_sql INTO v;
        ELSE
          EXECUTE p_sql;
          GET DIAGNOSTICS c = ROW_COUNT;
          v := c::text;
        END IF;
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
  -- The same, with everything it wrote undone afterwards.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.mo_dry(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        v := pg_temp.mo_try(p_uid, p_sql);
        RAISE EXCEPTION USING ERRCODE = 'ZT284';
      EXCEPTION WHEN SQLSTATE 'ZT284' THEN
        NULL;
      END;
      RETURN v;
    END $body$
  $fn$;

  -- Storage API's own flag: newer versions refuse a direct DELETE
  -- without it (see verify-voice-note-library.sql).
  PERFORM set_config('storage.allow_delete_query', 'true', true);

  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'media283-owner@example.invalid'),
    (u_admin, 'media283-admin@example.invalid'),
    (u_a,     'media283-a@example.invalid'),
    (u_b,     'media283-b@example.invalid'),
    (u_lead,  'media283-lead@example.invalid'),
    (u_guest, 'media283-guest@example.invalid'),
    (u_gone,  'media283-gone@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO acct FROM accounts WHERE owner_user_id = u_owner;
  IF acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = acct, account_role = 'agent' WHERE user_id IN (u_a, u_b);
  UPDATE profiles SET account_id = acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = acct, account_role = 'agent', deactivated_at = now()
   WHERE user_id = u_gone;
  UPDATE profiles SET account_id = acct, account_role = 'bank_guest', bank_code = 'ADCB'
   WHERE user_id = u_guest;
  IF (SELECT count(*) FROM profiles WHERE account_id = acct AND is_active
         AND user_id IN (u_owner, u_admin, u_a, u_b, u_lead, u_guest, u_gone)) <> 7 THEN
    RAISE EXCEPTION 'fixture: the seven people are not active members of the account';
  END IF;

  dir := 'account-' || acct || '/';
  -- The server's files carry no owner, as the Storage API stores them.
  INSERT INTO storage.objects (bucket_id, name, owner, owner_id) VALUES
    ('chat-media', dir || 'staged/1-a283.jpg',      u_a,    u_a::text),
    ('chat-media', dir || 'groups/1-a283.jpg',      u_a,    u_a::text),
    ('chat-media', dir || '1-header283.jpg',        u_a,    u_a::text),
    ('chat-media', dir || 'staged/1-old283.jpg',    u_a,    NULL),
    ('chat-media', dir || 'staged/1-b283.jpg',      u_b,    u_b::text),
    ('chat-media', dir || 'inbound/1-in283.pdf',    NULL,   NULL),
    ('chat-media', dir || 'avatars/1-av283.jpg',    NULL,   NULL),
    ('chat-media', dir || 'voice-library/1-vl283.ogg', NULL, NULL),
    ('chat-media', dir || 'staged/1-guest283.jpg',  u_guest, u_guest::text),
    ('chat-media', dir || 'staged/1-gone283.jpg',   u_gone, u_gone::text),
    ('flow-media', dir || '1-fa283.jpg',            u_a,    u_a::text),
    ('flow-media', dir || '1-fb283.jpg',            u_b,    u_b::text),
    -- Another bucket: owned by somebody else, or by nobody, on purpose.
    ('avatars',    u_a || '/1-me283.png',           NULL,   NULL),
    ('case-files', dir || '1-case283.pdf',          u_a,    u_a::text);

  -- ---------- who sees what: own uploads only, whatever the role ----------
  FOR who IN SELECT * FROM (VALUES
      ('agent A',     u_a,     '1-header283.jpg,groups/1-a283.jpg,staged/1-a283.jpg,staged/1-old283.jpg'),
      ('agent B',     u_b,     'staged/1-b283.jpg'),
      ('team leader', u_lead,  ''),
      ('admin',       u_admin, ''),
      ('owner',       u_owner, ''),
      ('guest',       u_guest, ''),
      ('deactivated', u_gone,  '')) v(label, uid, want)
  LOOP
    r := pg_temp.mo_try(who.uid, format(
      'SELECT coalesce(string_agg(substr(name, %s), '','' ORDER BY substr(name, %s) COLLATE "C"), '''')
         FROM storage.objects WHERE bucket_id = ''chat-media'' AND name LIKE %L',
      length(dir) + 1, length(dir) + 1, dir || '%'));
    n := n + 1;
    IF r IS DISTINCT FROM who.want THEN
      failed := array_append(failed, format(
        '"WhatsApp media is read by its uploader": %s lists [%s] in chat-media, want [%s]',
        who.label, r, who.want));
    END IF;
  END LOOP;
  FOR who IN SELECT * FROM (VALUES
      ('agent A', u_a, '1'), ('agent B', u_b, '1'), ('admin', u_admin, '0'),
      ('guest', u_guest, '0'), ('deactivated', u_gone, '0')) v(label, uid, want)
  LOOP
    r := pg_temp.mo_try(who.uid, format(
      'SELECT count(*) FROM storage.objects WHERE bucket_id = ''flow-media'' AND name LIKE %L', dir || '%'));
    n := n + 1;
    IF r IS DISTINCT FROM who.want THEN
      failed := array_append(failed, format(
        '"WhatsApp media is read by its uploader": %s lists %s in flow-media, want %s',
        who.label, r, who.want));
    END IF;
  END LOOP;

  -- ---------- B, a leader and an admin against A's and the server's files ----------
  FOR who IN SELECT * FROM (VALUES
      ('agent B', u_b), ('team leader', u_lead), ('admin', u_admin)) v(label, uid)
  LOOP
    FOR it IN SELECT * FROM (VALUES
        ('chat-media', 'staged/1-a283.jpg'), ('chat-media', 'groups/1-a283.jpg'),
        ('chat-media', '1-header283.jpg'), ('chat-media', 'staged/1-old283.jpg'),
        ('chat-media', 'inbound/1-in283.pdf'), ('chat-media', 'avatars/1-av283.jpg'),
        ('chat-media', 'voice-library/1-vl283.ogg'), ('flow-media', '1-fa283.jpg')) v(bucket, name)
    LOOP
      r := pg_temp.mo_dry(who.uid, format(
        'UPDATE storage.objects SET version = ''x'' WHERE bucket_id = %L AND name = %L',
        it.bucket, dir || it.name));
      n := n + 1;
      IF r <> '0' THEN
        failed := array_append(failed, format('%s changes %s %s: %s', who.label, it.bucket, it.name, r));
      END IF;
      -- An upload with upsert over it: ON CONFLICT DO UPDATE.
      r := pg_temp.mo_dry(who.uid, format(
        'INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES (%L, %L, %L)
           ON CONFLICT (bucket_id, name) DO UPDATE SET version = ''x'', owner_id = excluded.owner_id',
        it.bucket, dir || it.name, who.uid));
      n := n + 1;
      IF r NOT LIKE 'ERROR 42501:%' THEN
        failed := array_append(failed, format('%s replaces %s %s: %s', who.label, it.bucket, it.name, r));
      END IF;
      r := pg_temp.mo_dry(who.uid, format(
        'DELETE FROM storage.objects WHERE bucket_id = %L AND name = %L', it.bucket, dir || it.name));
      n := n + 1;
      IF r <> '0' THEN
        failed := array_append(failed, format('%s deletes %s %s: %s', who.label, it.bucket, it.name, r));
      END IF;
    END LOOP;
  END LOOP;
  -- The UPDATE and DELETE policies alone (no WHERE, so no SELECT policy):
  -- B's two objects and nobody else's.
  r := pg_temp.mo_dry(u_b, 'UPDATE storage.objects SET version = ''x''');
  n := n + 1;
  IF r <> '2' THEN
    failed := array_append(failed, '"WhatsApp media is changed by its uploader": B changes every row they may, want 2: ' || r);
  END IF;
  r := pg_temp.mo_dry(u_b, 'DELETE FROM storage.objects');
  n := n + 1;
  IF r <> '2' THEN
    failed := array_append(failed, '"WhatsApp media is deleted by its uploader": B deletes every row they may, want 2: ' || r);
  END IF;
  FOR who IN SELECT * FROM (VALUES
      ('admin', u_admin), ('guest', u_guest), ('deactivated', u_gone)) v(label, uid)
  LOOP
    r := pg_temp.mo_dry(who.uid, 'UPDATE storage.objects SET version = ''x''');
    n := n + 1;
    IF r <> '0' THEN
      failed := array_append(failed, format('"WhatsApp media is changed by its uploader": %s: %s', who.label, r));
    END IF;
    r := pg_temp.mo_dry(who.uid, 'DELETE FROM storage.objects');
    n := n + 1;
    IF r <> '0' THEN
      failed := array_append(failed, format('"WhatsApp media is deleted by its uploader": %s: %s', who.label, r));
    END IF;
  END LOOP;

  -- ---------- where a person may upload ----------
  FOR it IN SELECT * FROM (VALUES
      ('chat-media', 'staged/2-n283.jpg', true), ('chat-media', 'groups/2-n283.jpg', true),
      ('chat-media', '2-n283.jpg', true), ('flow-media', '2-n283.jpg', true),
      ('chat-media', 'inbound/2-n283.jpg', false), ('chat-media', 'avatars/2-n283.jpg', false),
      ('chat-media', 'voice-library/2-n283.ogg', false), ('chat-media', 'another/2-n283.jpg', false),
      ('chat-media', '/inbound/2-n283.jpg', false), ('chat-media', './inbound/2-n283.jpg', false),
      ('chat-media', 'staged/../inbound/2-n283.jpg', false),
      ('chat-media', 'staged/inbound/2-n283.jpg', false)) v(bucket, name, ok)
  LOOP
    FOR who IN SELECT * FROM (VALUES ('agent A', u_a), ('admin', u_admin)) v(label, uid)
    LOOP
      r := pg_temp.mo_dry(who.uid, format(
        'INSERT INTO storage.objects (bucket_id, name, owner, owner_id) VALUES (%L, %L, %L, %L)',
        it.bucket, dir || it.name, who.uid, who.uid));
      n := n + 1;
      IF it.ok AND r <> '1' THEN
        failed := array_append(failed, format('%s cannot upload %s %s: %s', who.label, it.bucket, it.name, r));
      ELSIF NOT it.ok AND r NOT LIKE 'ERROR 42501:%' THEN
        failed := array_append(failed, format(
          '"WhatsApp media is uploaded to the client folders": %s uploads %s %s: %s',
          who.label, it.bucket, it.name, r));
      END IF;
    END LOOP;
  END LOOP;
  FOR who IN SELECT * FROM (VALUES ('guest', u_guest), ('deactivated', u_gone)) v(label, uid)
  LOOP
    r := pg_temp.mo_dry(who.uid, format(
      'INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES (''chat-media'', %L, %L)',
      dir || 'staged/2-x283.jpg', who.uid));
    n := n + 1;
    IF r NOT LIKE 'ERROR 42501:%' THEN
      failed := array_append(failed, format('%s uploads to chat-media: %s', who.label, r));
    END IF;
  END LOOP;

  -- ---------- A's own files ----------
  FOR it IN SELECT * FROM (VALUES
      ('chat-media', 'staged/1-a283.jpg'), ('chat-media', 'groups/1-a283.jpg'),
      ('chat-media', 'staged/1-old283.jpg'), ('flow-media', '1-fa283.jpg')) v(bucket, name)
  LOOP
    r := pg_temp.mo_dry(u_a, format(
      'DELETE FROM storage.objects WHERE bucket_id = %L AND name = %L', it.bucket, dir || it.name));
    n := n + 1;
    IF r <> '1' THEN
      failed := array_append(failed, format('A cannot remove their own %s %s: %s', it.bucket, it.name, r));
    END IF;
  END LOOP;
  -- A move of A's own file: between client folders, never to a server's.
  FOR it IN SELECT * FROM (VALUES
      ('groups/3-mv283.jpg', true), ('inbound/3-mv283.jpg', false),
      ('avatars/3-mv283.jpg', false), ('voice-library/3-mv283.ogg', false)) v(name, ok)
  LOOP
    r := pg_temp.mo_dry(u_a, format(
      'UPDATE storage.objects SET name = %L WHERE bucket_id = ''chat-media'' AND name = %L',
      dir || it.name, dir || 'staged/1-a283.jpg'));
    n := n + 1;
    IF it.ok AND r <> '1' THEN
      failed := array_append(failed, format('A cannot move their own file to %s: %s', it.name, r));
    ELSIF NOT it.ok AND r NOT LIKE 'ERROR 42501:%' THEN
      failed := array_append(failed, format(
        '"WhatsApp media is changed by its uploader": A moves a file to %s: %s', it.name, r));
    END IF;
  END LOOP;
  -- Nor into another person's name.
  r := pg_temp.mo_dry(u_a, 'UPDATE storage.objects SET owner_id = ''' || u_b || '''');
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN
    failed := array_append(failed, '"WhatsApp media is changed by its uploader": A signs a file over to B: ' || r);
  END IF;

  -- ---------- the server ----------
  r := pg_temp.mo_dry(NULL, format(
    'SELECT count(*) FROM storage.objects WHERE bucket_id = ''chat-media'' AND name LIKE %L', dir || '%'));
  n := n + 1;
  IF r <> '10' THEN failed := array_append(failed, 'the service role lists ' || r || ' of 10'); END IF;
  -- The voice library as 242 left it: written by the routes' service role.
  FOR it IN SELECT * FROM (VALUES ('inbound'), ('avatars'), ('voice-library'), ('staged')) v(folder)
  LOOP
    r := pg_temp.mo_dry(NULL, format(
      'INSERT INTO storage.objects (bucket_id, name) VALUES (''chat-media'', %L)',
      dir || it.folder || '/4-srv283.ogg'));
    n := n + 1;
    IF r <> '1' THEN failed := array_append(failed, format('the service role cannot store in %s: %s', it.folder, r)); END IF;
  END LOOP;
  r := pg_temp.mo_dry(NULL, format(
    'DELETE FROM storage.objects WHERE bucket_id = ''chat-media'' AND name = %L', dir || 'voice-library/1-vl283.ogg'));
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, 'the service role cannot remove library audio: ' || r); END IF;

  -- ---------- other buckets ----------
  -- avatars (008, 057): by folder, whoever owns the row.
  r := pg_temp.mo_dry(u_a, 'SELECT count(*) FROM storage.objects WHERE bucket_id = ''avatars''');
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, 'A reads their avatar (no owner): ' || r); END IF;
  r := pg_temp.mo_dry(u_a, format(
    'UPDATE storage.objects SET version = ''x'' WHERE bucket_id = ''avatars'' AND name = %L', u_a || '/1-me283.png'));
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, 'A replaces their avatar: ' || r); END IF;
  r := pg_temp.mo_dry(u_a, format(
    'DELETE FROM storage.objects WHERE bucket_id = ''avatars'' AND name = %L', u_a || '/1-me283.png'));
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, 'A removes their avatar: ' || r); END IF;
  r := pg_temp.mo_dry(u_b, 'SELECT count(*) FROM storage.objects WHERE bucket_id = ''avatars''');
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, 'B reads A''s avatar row: ' || r); END IF;
  -- case-files (180): no client policy, so owning the row is not access.
  r := pg_temp.mo_dry(u_a, 'SELECT count(*) FROM storage.objects WHERE bucket_id = ''case-files''');
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, 'A reads case-files: ' || r); END IF;
  r := pg_temp.mo_dry(u_a, format(
    'INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES (''case-files'', %L, %L)', dir || '2-c283.pdf', u_a));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN failed := array_append(failed, 'A uploads to case-files: ' || r); END IF;
  -- Every bucket but the two, chat-files included: the four policies pass
  -- a row nobody owns at a server-like path. A permissive policy made
  -- here for it is the only one that decides.
  INSERT INTO storage.objects (bucket_id, name) VALUES ('chat-files', 'm283/inbound/x.pdf');
  EXECUTE $p$CREATE POLICY "media283 chat-files probe" ON storage.objects FOR ALL TO authenticated
            USING (bucket_id = 'chat-files' AND name LIKE 'm283/%')
            WITH CHECK (bucket_id = 'chat-files' AND name LIKE 'm283/%')$p$;
  FOR it IN SELECT * FROM (VALUES
      ('select', 'SELECT count(*) FROM storage.objects WHERE bucket_id = ''chat-files'' AND name LIKE ''m283/%'''),
      ('insert', 'INSERT INTO storage.objects (bucket_id, name) VALUES (''chat-files'', ''m283/inbound/y.pdf'')'),
      ('update', 'UPDATE storage.objects SET name = ''m283/inbound/z.pdf'' WHERE bucket_id = ''chat-files'' AND name = ''m283/inbound/x.pdf'''),
      ('delete', 'DELETE FROM storage.objects WHERE bucket_id = ''chat-files'' AND name = ''m283/inbound/x.pdf''')) v(op, sql)
  LOOP
    r := pg_temp.mo_dry(u_b, it.sql);
    n := n + 1;
    IF r <> '1' THEN failed := array_append(failed, format('283 touches another bucket: chat-files %s: %s', it.op, r)); END IF;
  END LOOP;

  RAISE EXCEPTION USING ERRCODE = 'ZT283', MESSAGE = 'verify-chat-media-owner rollback';
  EXCEPTION WHEN SQLSTATE 'ZT283' THEN
    NULL;
  END;

  IF cardinality(failed) > 0 THEN
    RAISE EXCEPTION 'chat-media owner verification: % of % checks failed: %',
      cardinality(failed), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'chat-media owner verification passed (% checks)', n;
END
$verify$;
