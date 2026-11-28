-- Behavioural suite for migration 321: in chat-media and flow-media a
-- signed-in person uploads, changes and removes objects only as an
-- agent or above of the workspace the first folder names, and only
-- while that workspace is their active one. A viewer, a deactivated
-- agent and a guest are refused, a folder that is not account-<uuid> is
-- refused without an error, and every other bucket is not touched.
--
-- ONE statement on purpose (the pinned CLI rejects several). Fixtures
-- are rolled back by a sentinel exception; the results survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000321001';
  u_agent  UUID := '00000000-0000-4000-8000-000000321002';
  u_viewer UUID := '00000000-0000-4000-8000-000000321003';
  u_gone   UUID := '00000000-0000-4000-8000-000000321004';
  u_guest  UUID := '00000000-0000-4000-8000-000000321005';
  u_multi  UUID := '00000000-0000-4000-8000-000000321006';
  u_bown   UUID := '00000000-0000-4000-8000-000000321007';
  acct     UUID;
  acct_b   UUID;
  dir      TEXT;
  dir_b    TEXT;
  who      RECORD;
  it       RECORD;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- As one signed-in person: the value of a SELECT, the row count of
  -- anything else, or the error.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.mur_try(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; c bigint;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
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
    CREATE FUNCTION pg_temp.mur_dry(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        v := pg_temp.mur_try(p_uid, p_sql);
        RAISE EXCEPTION USING ERRCODE = 'ZT322';
      EXCEPTION WHEN SQLSTATE 'ZT322' THEN
        NULL;
      END;
      RETURN v;
    END $body$
  $fn$;

  -- Storage API's own flag: newer versions refuse a direct DELETE
  -- without it (see verify-voice-note-library.sql).
  PERFORM set_config('storage.allow_delete_query', 'true', true);

  -- ---------- the three policies, restrictive ----------
  FOR it IN SELECT * FROM (VALUES
      ('WhatsApp media is uploaded by agents and up', 'INSERT'),
      ('WhatsApp media is changed by agents and up',  'UPDATE'),
      ('WhatsApp media is deleted by agents and up',  'DELETE')) v(pol, cmd)
  LOOP
    SELECT CASE WHEN p.permissive <> 'RESTRICTIVE' THEN 'permissive'
                WHEN p.cmd <> it.cmd THEN 'for ' || p.cmd
                WHEN p.roles <> ARRAY['authenticated']::name[] THEN 'to ' || p.roles::text
                WHEN coalesce(p.qual, '') || coalesce(p.with_check, '') NOT LIKE '%''agent''%'
                  THEN 'no agent minimum'
                ELSE 'ok' END
      INTO r
      FROM pg_policies p
     WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname = it.pol;
    n := n + 1;
    IF r IS DISTINCT FROM 'ok' THEN
      failed := array_append(failed, format('policy "%s": %s', it.pol, coalesce(r, 'missing')));
    END IF;
  END LOOP;

  -- ---------- fixtures ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'mur321-owner@example.invalid'),
    (u_agent,  'mur321-agent@example.invalid'),
    (u_viewer, 'mur321-viewer@example.invalid'),
    (u_gone,   'mur321-gone@example.invalid'),
    (u_guest,  'mur321-guest@example.invalid'),
    (u_multi,  'mur321-multi@example.invalid'),
    (u_bown,   'mur321-bown@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO acct FROM accounts WHERE owner_user_id = u_owner;
  SELECT id INTO acct_b FROM accounts WHERE owner_user_id = u_bown;
  IF acct IS NULL OR acct_b IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision the two accounts';
  END IF;
  UPDATE profiles SET account_id = acct, account_role = 'agent' WHERE user_id IN (u_agent, u_multi);
  UPDATE profiles SET account_id = acct, account_role = 'viewer' WHERE user_id = u_viewer;
  UPDATE profiles SET account_id = acct, account_role = 'agent', deactivated_at = now()
   WHERE user_id = u_gone;
  UPDATE profiles SET account_id = acct, account_role = 'bank_guest', bank_code = 'ADCB'
   WHERE user_id = u_guest;
  -- u_multi is an agent of B too, but A is their active workspace.
  INSERT INTO profiles (user_id, full_name, email, account_id, account_role, is_active)
  VALUES (u_multi, '', 'mur321-multi@example.invalid', acct_b, 'agent', false);
  IF (SELECT count(*) FROM profiles WHERE account_id = acct AND is_active
         AND user_id IN (u_owner, u_agent, u_viewer, u_gone, u_guest, u_multi)) <> 6 THEN
    RAISE EXCEPTION 'fixture: the six people are not active members of A';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = u_multi AND account_id = acct_b
                    AND NOT is_active AND account_role = 'agent') THEN
    RAISE EXCEPTION 'fixture: the second person has no inactive agent profile in B';
  END IF;

  dir   := 'account-' || acct || '/';
  dir_b := 'account-' || acct_b || '/';
  -- Each person's own upload (283 leaves an object to its uploader).
  INSERT INTO storage.objects (bucket_id, name, owner, owner_id) VALUES
    ('chat-media', dir || 'staged/1-agent321.jpg',  u_agent,  u_agent::text),
    ('chat-media', dir || 'staged/1-viewer321.jpg', u_viewer, u_viewer::text),
    ('chat-media', dir || 'staged/1-gone321.jpg',   u_gone,   u_gone::text),
    ('chat-media', dir_b || 'staged/1-multi321.jpg', u_multi, u_multi::text),
    ('flow-media', dir || '1-agent321.jpg',         u_agent,  u_agent::text),
    ('flow-media', dir || '1-viewer321.jpg',        u_viewer, u_viewer::text),
    ('flow-media', u_viewer || '/1-viewer321.jpg',  u_viewer, u_viewer::text);

  -- ---------- uploads ----------
  FOR it IN SELECT * FROM (VALUES
      -- who, label, bucket, path, ok
      (u_agent,  'agent',       'chat-media', dir || 'x321.png',          true),
      (u_agent,  'agent',       'chat-media', dir || 'staged/x321.png',   true),
      (u_agent,  'agent',       'chat-media', dir || 'groups/x321.png',   true),
      (u_agent,  'agent',       'flow-media', dir || 'x321.png',          true),
      (u_owner,  'owner',       'chat-media', dir || 'staged/x321.png',   true),
      (u_owner,  'owner',       'flow-media', dir || 'x321.png',          true),
      (u_viewer, 'viewer',      'chat-media', dir || 'x321.png',          false),
      (u_viewer, 'viewer',      'chat-media', dir || 'staged/x321.png',   false),
      (u_viewer, 'viewer',      'flow-media', dir || 'x321.png',          false),
      (u_viewer, 'viewer',      'flow-media', u_viewer || '/x321.png',    false),
      (u_gone,   'deactivated', 'chat-media', dir || 'staged/x321.png',   false),
      (u_gone,   'deactivated', 'flow-media', dir || 'x321.png',          false),
      (u_guest,  'guest',       'chat-media', dir || 'staged/x321.png',   false),
      (u_guest,  'guest',       'flow-media', dir || 'x321.png',          false),
      (u_multi,  'agent of A',  'chat-media', dir || 'staged/x321.png',   true),
      (u_multi,  'agent of B (A active)', 'chat-media', dir_b || 'staged/x321.png', false),
      (u_multi,  'agent of B (A active)', 'flow-media', dir_b || 'x321.png',        false),
      (u_agent,  'agent',       'chat-media', 'account-nope/x321.png',    false),
      (u_agent,  'agent',       'flow-media', 'account-nope/x321.png',    false),
      (u_agent,  'agent',       'flow-media', 'x321.png',                 false),
      (u_agent,  'agent',       'flow-media', upper(dir) || 'x321.png',   false),
      (u_agent,  'agent',       'flow-media', u_agent || '/x321.png',     false)
    ) v(uid, label, bucket, path, ok)
  LOOP
    r := pg_temp.mur_dry(it.uid, format(
      'INSERT INTO storage.objects (bucket_id, name, owner, owner_id) VALUES (%L, %L, %L, %L)',
      it.bucket, it.path, it.uid, it.uid));
    n := n + 1;
    IF it.ok AND r <> '1' THEN
      failed := array_append(failed, format('%s cannot upload %s %s: %s', it.label, it.bucket, it.path, r));
    ELSIF NOT it.ok AND r NOT LIKE 'ERROR 42501:%' THEN
      failed := array_append(failed, format(
        '"WhatsApp media is uploaded by agents and up": %s uploads %s %s: %s',
        it.label, it.bucket, it.path, r));
    END IF;
  END LOOP;

  -- ---------- changes and removals of one's own upload ----------
  FOR it IN SELECT * FROM (VALUES
      (u_agent,  'agent',       'chat-media', dir || 'staged/1-agent321.jpg',   '1'),
      (u_agent,  'agent',       'flow-media', dir || '1-agent321.jpg',          '1'),
      (u_viewer, 'viewer',      'chat-media', dir || 'staged/1-viewer321.jpg',  '0'),
      (u_viewer, 'viewer',      'flow-media', dir || '1-viewer321.jpg',         '0'),
      (u_viewer, 'viewer',      'flow-media', u_viewer || '/1-viewer321.jpg',   '0'),
      (u_gone,   'deactivated', 'chat-media', dir || 'staged/1-gone321.jpg',    '0'),
      (u_multi,  'agent of B (A active)', 'chat-media', dir_b || 'staged/1-multi321.jpg', '0')
    ) v(uid, label, bucket, path, want)
  LOOP
    r := pg_temp.mur_dry(it.uid, format(
      'UPDATE storage.objects SET version = ''x'' WHERE bucket_id = %L AND name = %L',
      it.bucket, it.path));
    n := n + 1;
    IF r IS DISTINCT FROM it.want THEN
      failed := array_append(failed, format(
        '"WhatsApp media is changed by agents and up": %s changes %s %s: %s, want %s',
        it.label, it.bucket, it.path, r, it.want));
    END IF;
    r := pg_temp.mur_dry(it.uid, format(
      'DELETE FROM storage.objects WHERE bucket_id = %L AND name = %L', it.bucket, it.path));
    n := n + 1;
    IF r IS DISTINCT FROM it.want THEN
      failed := array_append(failed, format(
        '"WhatsApp media is deleted by agents and up": %s removes %s %s: %s, want %s',
        it.label, it.bucket, it.path, r, it.want));
    END IF;
  END LOOP;
  -- No WHERE: the UPDATE and DELETE policies alone (no SELECT policy).
  r := pg_temp.mur_dry(u_viewer, 'UPDATE storage.objects SET version = ''x''');
  n := n + 1;
  IF r <> '0' THEN
    failed := array_append(failed, '"WhatsApp media is changed by agents and up": a viewer changes every row they may, want 0: ' || r);
  END IF;
  r := pg_temp.mur_dry(u_viewer, 'DELETE FROM storage.objects');
  n := n + 1;
  IF r <> '0' THEN
    failed := array_append(failed, '"WhatsApp media is deleted by agents and up": a viewer deletes every row they may, want 0: ' || r);
  END IF;
  -- An agent's move: within A, never into B or a malformed folder.
  FOR it IN SELECT * FROM (VALUES
      (dir || 'groups/2-mv321.jpg', true),
      (dir_b || 'staged/2-mv321.jpg', false),
      ('account-nope/2-mv321.jpg', false)) v(path, ok)
  LOOP
    r := pg_temp.mur_dry(u_agent, format(
      'UPDATE storage.objects SET name = %L WHERE bucket_id = ''chat-media'' AND name = %L',
      it.path, dir || 'staged/1-agent321.jpg'));
    n := n + 1;
    IF it.ok AND r <> '1' THEN
      failed := array_append(failed, format('the agent cannot move their file to %s: %s', it.path, r));
    ELSIF NOT it.ok AND r NOT LIKE 'ERROR 42501:%' THEN
      failed := array_append(failed, format(
        '"WhatsApp media is changed by agents and up": the agent moves a file to %s: %s', it.path, r));
    END IF;
  END LOOP;

  -- ---------- other buckets ----------
  -- avatars (008): a viewer still uploads into their own folder.
  r := pg_temp.mur_dry(u_viewer, format(
    'INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES (''avatars'', %L, %L)',
    u_viewer || '/1-me321.png', u_viewer));
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, '321 touches avatars: a viewer uploads their avatar: ' || r); END IF;
  -- Every bucket but the two: the three policies pass a viewer's write
  -- at a folder that is no account. A permissive policy made here for it
  -- is the only one that decides.
  INSERT INTO storage.objects (bucket_id, name) VALUES ('chat-files', 'm321/x.pdf');
  EXECUTE $p$CREATE POLICY "mur321 chat-files probe" ON storage.objects FOR ALL TO authenticated
            USING (bucket_id = 'chat-files' AND name LIKE 'm321/%')
            WITH CHECK (bucket_id = 'chat-files' AND name LIKE 'm321/%')$p$;
  FOR it IN SELECT * FROM (VALUES
      ('insert', 'INSERT INTO storage.objects (bucket_id, name) VALUES (''chat-files'', ''m321/y.pdf'')'),
      ('update', 'UPDATE storage.objects SET name = ''m321/z.pdf'' WHERE bucket_id = ''chat-files'' AND name = ''m321/x.pdf'''),
      ('delete', 'DELETE FROM storage.objects WHERE bucket_id = ''chat-files'' AND name = ''m321/x.pdf''')) v(op, sql)
  LOOP
    FOR who IN SELECT * FROM (VALUES ('viewer', u_viewer), ('agent', u_agent)) v(label, uid)
    LOOP
      r := pg_temp.mur_dry(who.uid, it.sql);
      n := n + 1;
      IF r <> '1' THEN
        failed := array_append(failed, format('321 touches another bucket: %s chat-files %s: %s', who.label, it.op, r));
      END IF;
    END LOOP;
  END LOOP;

  RAISE EXCEPTION USING ERRCODE = 'ZT321', MESSAGE = 'verify-media-upload-role rollback';
  EXCEPTION WHEN SQLSTATE 'ZT321' THEN
    NULL;
  END;

  IF cardinality(failed) > 0 THEN
    RAISE EXCEPTION 'media upload role verification: % of % checks failed: %',
      cardinality(failed), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'media upload role verification passed (% checks)', n;
END
$verify$;
