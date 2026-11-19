-- Behavioural regression suite for staff attachment sends into a
-- submission group (migration 210).
--
-- sg_send_begin_media writes the pending 'out' row with its type and
-- media at insert (the settle trigger allows no later change); it
-- refuses (22023) a type other than image | video | document | audio
-- and media that is not an object with an https link; otherwise it
-- follows sg_send_begin's rules (NULL and nothing written for a 'none'
-- group or an ENDED one). sg_send_begin still writes a text row. The
-- helper sg_send_begin_row is executable by nobody; both public
-- functions by service_role only.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The fixtures are
-- rolled back by a sentinel exception; the results survive in plpgsql
-- variables.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000210001';
  u_agent UUID := '00000000-0000-4000-8000-000000210002';
  a_acct  UUID;
  w1      UUID;
  c1      UUID;
  g1      UUID;
  g0      UUID;
  tok     UUID;
  m1      BIGINT;
  b1      BOOLEAN;
  r       TEXT;
  acl     JSONB;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ms_try(p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        IF p_sql ILIKE 'select%' THEN
          EXECUTE p_sql INTO v;
        ELSE
          EXECUTE p_sql;
        END IF;
        RETURN coalesce(v, 'ok');
      EXCEPTION WHEN OTHERS THEN
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'ms-owner@example.invalid'),
    (u_agent, 'ms-agent@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'MS-210-A1', 'x', 'connected', true) RETURNING id INTO w1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500210001', 'MS one')
    RETURNING id INTO c1;
  acl := jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent'));
  SELECT group_id INTO g1 FROM sg_open(a_acct, 'MS-210-1', c1, w1, 'one', NULL, acl, NULL);
  SELECT group_id INTO g0 FROM sg_open(a_acct, 'MS-210-0', c1, NULL, 'zero', NULL, acl, NULL, 'none');
  IF g1 IS NULL OR g0 IS NULL THEN
    RAISE EXCEPTION 'fixture: sg_open returned no group (% / %)', g1, g0;
  END IF;
  tok := sg_claim_create(g1, 60000);
  PERFORM sg_attach_wa_group(g1, '120363000000210001@g.us', NULL, tok);

  -- ---------- a media begin stores type, media, pending ----------
  m1 := sg_send_begin_media(g1, u_agent, 'image', 'look', 'Agent (Agent): look',
                            '{"link": "https://example.invalid/a.jpg", "mime_type": "image/jpeg"}');
  n := n + 1;
  IF m1 IS NULL THEN
    failed := failed || 'sg_send_begin_media wrote nothing for an allowed sender'::text;
  ELSIF NOT EXISTS (SELECT 1 FROM submission_group_messages
                     WHERE id = m1 AND group_id = g1 AND direction = 'out' AND type = 'image'
                       AND send_status = 'pending' AND sender_user_id = u_agent
                       AND body = 'look' AND prefixed_body = 'Agent (Agent): look'
                       AND media ->> 'link' = 'https://example.invalid/a.jpg'
                       AND media ->> 'mime_type' = 'image/jpeg') THEN
    failed := failed || 'the media row is not stored with its type, media and pending status'::text;
  END IF;
  m1 := sg_send_begin_media(g1, u_agent, 'document', '', 'Agent (Agent):',
                            '{"link": "https://example.invalid/b.pdf", "filename": "b.pdf"}');
  n := n + 1;
  IF m1 IS NULL OR NOT EXISTS (SELECT 1 FROM submission_group_messages
                                WHERE id = m1 AND type = 'document' AND body = '') THEN
    failed := failed || 'a document with an empty caption was not stored'::text;
  END IF;

  -- ---------- sg_send_begin still writes a text row ----------
  m1 := sg_send_begin(g1, u_agent, 'hi', 'Agent (Agent): hi');
  n := n + 1;
  IF m1 IS NULL OR NOT EXISTS (SELECT 1 FROM submission_group_messages
                                WHERE id = m1 AND type = 'text' AND media IS NULL
                                  AND send_status = 'pending' AND body = 'hi') THEN
    failed := failed || 'sg_send_begin no longer writes a pending text row without media'::text;
  END IF;

  -- ---------- refused arguments (22023), nothing written ----------
  FOREACH r IN ARRAY ARRAY[
    format('SELECT sg_send_begin_media(%L, %L, ''text'', ''x'', ''x'', ''{"link":"https://e.invalid/a"}'')::text', g1, u_agent),
    format('SELECT sg_send_begin_media(%L, %L, ''sticker'', ''x'', ''x'', ''{"link":"https://e.invalid/a"}'')::text', g1, u_agent),
    format('SELECT sg_send_begin_media(%L, %L, NULL, ''x'', ''x'', ''{"link":"https://e.invalid/a"}'')::text', g1, u_agent),
    format('SELECT sg_send_begin_media(%L, %L, ''image'', ''x'', ''x'', ''{"link":"http://e.invalid/a"}'')::text', g1, u_agent),
    format('SELECT sg_send_begin_media(%L, %L, ''image'', ''x'', ''x'', ''{"link":"javascript:x"}'')::text', g1, u_agent),
    format('SELECT sg_send_begin_media(%L, %L, ''image'', ''x'', ''x'', ''{"link":["https://e.invalid/a"]}'')::text', g1, u_agent),
    format('SELECT sg_send_begin_media(%L, %L, ''image'', ''x'', ''x'', ''{"url":"https://e.invalid/a"}'')::text', g1, u_agent),
    format('SELECT sg_send_begin_media(%L, %L, ''image'', ''x'', ''x'', ''["https://e.invalid/a"]'')::text', g1, u_agent),
    format('SELECT sg_send_begin_media(%L, %L, ''image'', ''x'', ''x'', NULL)::text', g1, u_agent)] LOOP
    n := n + 1;
    IF pg_temp.ms_try(r) NOT LIKE 'ERROR 22023%' THEN
      failed := failed || format('not refused with 22023: %s', r);
    END IF;
  END LOOP;
  n := n + 1;
  IF (SELECT count(*) FROM submission_group_messages WHERE group_id = g1) <> 3 THEN
    failed := failed || 'a refused media begin wrote a row'::text;
  END IF;

  -- ---------- a 'none' group: NULL, nothing written ----------
  m1 := sg_send_begin_media(g0, u_agent, 'image', 'x', 'x', '{"link": "https://example.invalid/a.jpg"}');
  n := n + 1;
  IF m1 IS NOT NULL OR EXISTS (SELECT 1 FROM submission_group_messages WHERE group_id = g0) THEN
    failed := failed || 'sg_send_begin_media wrote into a ''none'' group'::text;
  END IF;

  -- ---------- an ENDED group: NULL, nothing written ----------
  b1 := sg_end(g1, 'final_status');
  m1 := sg_send_begin_media(g1, u_agent, 'image', 'x', 'x', '{"link": "https://example.invalid/a.jpg"}');
  n := n + 1;
  IF NOT b1 OR m1 IS NOT NULL
     OR (SELECT count(*) FROM submission_group_messages WHERE group_id = g1 AND direction = 'out') <> 3 THEN
    failed := failed || 'sg_send_begin_media wrote into an ENDED group'::text;
  END IF;
  -- The insert guard (170) is the floor under the helper: an out row
  -- written directly into an ENDED group is refused.
  n := n + 1;
  r := pg_temp.ms_try(format(
    'INSERT INTO submission_group_messages (group_id, account_id, direction, sender_user_id, type, body, prefixed_body, media, send_status)
     VALUES (%L, %L, ''out'', %L, ''image'', ''x'', ''x'', ''{"link":"https://e.invalid/a"}'', ''pending'')',
    g1, a_acct, u_agent));
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := failed || format('an out media row was inserted into an ENDED group (%s)', r);
  END IF;

  -- ---------- privileges ----------
  FOREACH r IN ARRAY ARRAY['service_role', 'authenticated', 'anon'] LOOP
    n := n + 1;
    IF has_function_privilege(r, 'public.sg_send_begin_row(uuid,uuid,text,text,text,jsonb)', 'EXECUTE') THEN
      failed := failed || format('%s may execute sg_send_begin_row', r);
    END IF;
  END LOOP;
  FOREACH r IN ARRAY ARRAY[
    'public.sg_send_begin_media(uuid,uuid,text,text,text,jsonb)',
    'public.sg_send_begin(uuid,uuid,text,text)'] LOOP
    n := n + 1;
    IF has_function_privilege('authenticated', r, 'EXECUTE') OR has_function_privilege('anon', r, 'EXECUTE') THEN
      failed := failed || format('a client role may execute %s', r);
    END IF;
    n := n + 1;
    IF NOT has_function_privilege('service_role', r, 'EXECUTE') THEN
      failed := failed || format('service_role may not execute %s', r);
    END IF;
  END LOOP;

  RAISE EXCEPTION USING ERRCODE = 'ZT210', MESSAGE = 'verify-submission-group-media rollback';
  EXCEPTION WHEN SQLSTATE 'ZT210' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'submission group media verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'submission group media verification passed (% checks)', n;
END
$verify$;
