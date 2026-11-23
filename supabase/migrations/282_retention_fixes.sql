-- ============================================================
-- 282_retention_fixes.sql — retention removes the files too, works in
-- slices, and a failure is seen.
--
-- RESTATES 262's privacy_retention_sweep, privacy_erase_objects_pending and
-- privacy_erase_objects_settle, and 223's privacy_retention_get: apply in
-- order, once. Re-running 262 afterwards puts a two-argument sweep beside
-- this one, so every sweep call is ambiguous and fails: re-run 282.
--
--  1. A sweep lists the stored files of the messages it deletes or blanks
--     that nothing else points at (privacy_objects_unreferenced, after the
--     deletes) in privacy_requests.detail.objects_list, in the same
--     transaction, at most 1000 to a row (further rows carry part_of). The
--     erase's retry takes 'retention' rows like 'erase' ones, without its
--     10-minute wait: no route deletes these. A dry run counts them only.
--  2. privacy_retention_sweep(account, dry_run, limit): at most `limit`
--     rows of each kind when it applies, answering `more`. NULL (a caller
--     that passes none) is everything, as before. A dry run counts all.
--  3. privacy_retention_failed(account, code): a 'retention_failed' row and
--     the owners' bell (retention_failed, opens Settings -> Privacy), once
--     a day. privacy_retention_get also answers the last run.
--
-- Allow-list, legal holds and the dry run are unchanged. Applying this
-- deletes nothing. Apply after 280 as a superuser or BYPASSRLS role, before
-- the build. Re-runnable. verify-retention-fixes.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '282 must be applied by a superuser or BYPASSRLS role';
  END IF;
  IF to_regprocedure('public.privacy_objects_unreferenced(uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION '282: apply 262_privacy_fixes.sql first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.notifications'::regclass
                  AND conname = 'notifications_type_check')
     OR position('WHEN n.type IN (''channel_disconnected''' IN
                 pg_get_functiondef('public.push_bell_url(public.notifications)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '282: notifications_type_check or push_bell_url is not as 253 left it';
  END IF;
END $$;

-- ---------- 3: the failure's row and bell type ----------

DO $$
DECLARE
  v_def  text := (SELECT pg_get_constraintdef(oid) FROM pg_constraint
                   WHERE conrelid = 'public.notifications'::regclass AND conname = 'notifications_type_check');
  v_fn   text := pg_get_functiondef('public.push_bell_url(public.notifications)'::regprocedure);
  v_list text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.privacy_requests'::regclass
                  AND conname = 'privacy_requests_kind_check'
                  AND position('''retention_failed''' IN pg_get_constraintdef(oid)) > 0) THEN
    ALTER TABLE public.privacy_requests DROP CONSTRAINT IF EXISTS privacy_requests_kind_check,
      ADD CONSTRAINT privacy_requests_kind_check CHECK (kind IN ('export', 'erase_dry_run', 'erase',
        'legal_hold_placed', 'legal_hold_released', 'retention_dry_run', 'retention', 'retention_failed', 'objects_done'));
  END IF;
  -- Every type the constraint has now, plus ours (as 274).
  IF position('''retention_failed''' IN v_def) = 0 THEN
    SELECT string_agg(quote_literal(x), ', ') INTO v_list
      FROM (SELECT DISTINCT q.m[1] AS x FROM regexp_matches(v_def, '''([^'']+)''', 'g') AS q(m)
            UNION SELECT 'retention_failed') vals;
    ALTER TABLE public.notifications DROP CONSTRAINT notifications_type_check;
    EXECUTE format('ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (%s)) NOT VALID', v_list);
    ALTER TABLE public.notifications VALIDATE CONSTRAINT notifications_type_check;
  END IF;
  IF position('retention_failed' IN v_fn) = 0 THEN
    EXECUTE replace(v_fn, 'WHEN n.type IN (''channel_disconnected''',
      'WHEN n.type = ''retention_failed'' THEN
      RETURN CASE WHEN v_role IN (''owner'', ''admin'') THEN ''/settings?tab=privacy'' ELSE ''/notifications'' END;
    WHEN n.type IN (''channel_disconnected''');
  END IF;
END $$;

-- The newest run of a workspace (not the extra file-list rows). An applied
-- run is its slices: back to the last row that left nothing over.
CREATE OR REPLACE FUNCTION public.privacy_retention_last_run(p_account uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object('at', l.at,
           'mode', CASE l.kind WHEN 'retention' THEN 'apply' WHEN 'retention_failed' THEN 'failed' ELSE 'dry_run' END,
           'code', l.detail -> 'code', 'more', coalesce((l.detail ->> 'more')::boolean, false),
           'rows', s.n_rows, 'files', s.n_files)
    FROM (SELECT r.* FROM public.privacy_requests r
           WHERE r.account_id = p_account AND r.kind IN ('retention', 'retention_dry_run', 'retention_failed')
             AND NOT r.detail ? 'part_of'
           ORDER BY r.id DESC LIMIT 1) l
    CROSS JOIN LATERAL (
      SELECT coalesce(sum((SELECT sum((t.v ->> 'rows')::bigint) FROM jsonb_each(r.detail -> 'tables') AS t(k, v))), 0) AS n_rows,
             coalesce(sum((r.detail ->> 'objects')::bigint), 0) AS n_files
        FROM public.privacy_requests r
       WHERE r.account_id = p_account AND r.kind = l.kind AND l.kind <> 'retention_failed'
         AND NOT r.detail ? 'part_of' AND r.id <= l.id
         AND r.id > CASE WHEN l.kind = 'retention_dry_run' THEN l.id - 1 ELSE coalesce(
               (SELECT max(b.id) FROM public.privacy_requests b
                 WHERE b.account_id = p_account AND b.kind = 'retention' AND NOT b.detail ? 'part_of'
                   AND b.id < l.id AND NOT coalesce((b.detail ->> 'more')::boolean, false)), 0) END) s
$$;

CREATE OR REPLACE FUNCTION public.privacy_retention_get(p_actor uuid, p_account uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.privacy_require_admin('privacy_retention_get', p_actor, p_account);
  RETURN coalesce((SELECT jsonb_build_object('policy', s.policy, 'apply', s.apply, 'updated_at', s.updated_at)
                     FROM public.privacy_retention_settings s WHERE s.account_id = p_account),
                  jsonb_build_object('policy', '{"tables": {}}'::jsonb, 'apply', false, 'updated_at', NULL))
         || jsonb_build_object('last_run', public.privacy_retention_last_run(p_account));
END;
$$;

-- A failed sweep: an error code, never text. One bell to the owners in 23
-- hours; a row when it rings, or when the last run on record was not a
-- failure. True when it rang.
CREATE OR REPLACE FUNCTION public.privacy_retention_failed(p_account uuid, p_code text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ring boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('privacy_retention_failed:' || p_account::text, 282));
  v_ring := NOT EXISTS (SELECT 1 FROM public.privacy_requests r
                         WHERE r.account_id = p_account AND r.kind = 'retention_failed'
                           AND r.detail -> 'rang' = 'true'::jsonb AND r.at > now() - interval '23 hours');
  IF v_ring THEN
    BEGIN
      INSERT INTO public.notifications (account_id, user_id, type, title, body)
      SELECT p_account, p.user_id, 'retention_failed', 'Automatic data removal failed',
             'The daily retention sweep stopped with an error. It is tried again automatically; see Settings, Privacy.'
        FROM public.profiles p WHERE p.account_id = p_account AND p.account_role = 'owner';
    EXCEPTION WHEN OTHERS THEN
      v_ring := false;  -- the row below still records the failure
    END;
  END IF;
  IF v_ring OR public.privacy_retention_last_run(p_account) ->> 'mode' IS DISTINCT FROM 'failed' THEN
    INSERT INTO public.privacy_requests (account_id, kind, actor_label, detail)
    VALUES (p_account, 'retention_failed', 'system:retention',
            jsonb_build_object('code', left(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'), 10), 'rang', v_ring));
  END IF;
  RETURN v_ring;
END;
$$;

-- ---------- 1: the files of the swept messages ----------

-- What a group message's media points at: a deal-room file by storage_path,
-- chat media by its path inside this account's folder.
CREATE OR REPLACE FUNCTION public.privacy_media_objects(p_account uuid, p_media jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(x.o), '[]'::jsonb) FROM (
    SELECT jsonb_build_object('bucket', 'deal-files', 'path', p_media ->> 'storage_path') AS o
     WHERE p_media ->> 'storage_path' IS NOT NULL
    UNION
    SELECT jsonb_build_object('bucket', 'chat-media', 'path', m.m[1])
      FROM regexp_matches(CASE WHEN jsonb_typeof(p_media) = 'object' THEN (p_media - 'storage_path')::text ELSE '' END,
             '(account-' || p_account::text || '/[^"?#\\[:space:]]+)', 'g') AS m(m)) x
$$;

CREATE OR REPLACE FUNCTION public.privacy_erase_objects_pending(p_limit integer DEFAULT 20)
RETURNS TABLE (account_id uuid, request_id bigint, objects jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT x.account_id, x.id, public.privacy_objects_unreferenced(x.account_id, x.objects)
    FROM (SELECT r.account_id, r.id,
                 CASE WHEN d.id IS NULL THEN r.detail -> 'objects_list' ELSE d.detail -> 'remaining' END AS objects
            FROM public.privacy_requests r
            LEFT JOIN LATERAL (SELECT o.id, o.detail FROM public.privacy_requests o
                                WHERE o.account_id = r.account_id AND o.kind = 'objects_done'
                                  AND o.detail ->> 'request_id' = r.id::text
                                ORDER BY o.id DESC LIMIT 1) d ON true
           WHERE r.kind IN ('erase', 'retention')
             AND (d.detail ->> 'objects_state' = 'pending'
                  OR (d.id IS NULL AND r.detail ? 'objects_list'
                      AND (r.kind = 'retention' OR r.at < now() - interval '10 minutes')))
           ORDER BY coalesce(d.id, r.id)
           LIMIT greatest(1, least(coalesce(p_limit, 20), 100))) x
   WHERE jsonb_typeof(x.objects) = 'array'
$$;

CREATE OR REPLACE FUNCTION public.privacy_erase_objects_settle(p_request bigint, p_remaining jsonb)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account uuid;
BEGIN
  SELECT r.account_id INTO v_account FROM public.privacy_requests r
   WHERE r.id = p_request AND r.kind IN ('erase', 'retention');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'privacy_erase_objects_settle: request not found' USING ERRCODE = 'no_data_found', HINT = 'NOT_FOUND';
  END IF;
  IF p_remaining IS NULL OR jsonb_typeof(p_remaining) <> 'array' THEN
    RAISE EXCEPTION 'privacy_erase_objects_settle: remaining must be an array' USING ERRCODE = 'check_violation', HINT = 'INVALID';
  END IF;
  INSERT INTO public.privacy_requests (account_id, kind, actor_label, detail)
  VALUES (v_account, 'objects_done', 'system:retention', jsonb_build_object('request_id', p_request,
          'objects_state', CASE WHEN jsonb_array_length(p_remaining) = 0 THEN 'done' ELSE 'pending' END,
          'remaining', p_remaining));
END;
$$;

-- ---------- 2: the sweep, restated from 262 ----------

-- Two overloads would make the earlier build's call ambiguous: dropped
-- right before the new one is created.
DROP FUNCTION IF EXISTS public.privacy_retention_sweep(uuid, boolean);
CREATE OR REPLACE FUNCTION public.privacy_retention_sweep(p_account uuid, p_dry_run boolean DEFAULT NULL,
  p_limit integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  s       public.privacy_retention_settings%ROWTYPE;
  v_dry   boolean;
  r       record;
  v_cut   timestamptz;
  v_n     integer;
  v_held  integer;
  v_out   jsonb := '{}'::jsonb;
  v_id    bigint;
  v_ids    text[];
  v_phones text[];
  v_lim   integer;
  v_more  boolean := false;
  v_got   jsonb;
  v_obj   jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO s FROM public.privacy_retention_settings x WHERE x.account_id = p_account;
  IF NOT FOUND OR s.policy -> 'tables' = '{}'::jsonb THEN
    RETURN NULL;
  END IF;
  IF public.privacy_retention_problem(s.policy) IS NOT NULL THEN
    RAISE EXCEPTION 'privacy_retention_sweep: the stored policy is invalid' USING ERRCODE = 'check_violation', HINT = 'INVALID';
  END IF;
  v_dry := coalesce(p_dry_run, NOT s.apply);
  -- LIMIT NULL is no limit. A dry run counts everything.
  v_lim := CASE WHEN v_dry OR p_limit IS NULL THEN NULL ELSE greatest(1, least(p_limit, 5000)) END;

  -- Contacts under a legal hold, and their phone digits.
  CREATE TEMP TABLE IF NOT EXISTS pg_temp.privacy_held (contact_id uuid, digits text, phone text) ON COMMIT DROP;
  TRUNCATE pg_temp.privacy_held;
  INSERT INTO pg_temp.privacy_held
  SELECT c.id, public.privacy_digits(coalesce(c.phone_normalized, c.phone)), nullif(c.phone_normalized, '')
    FROM public.privacy_legal_holds h JOIN public.contacts c ON c.id = h.contact_id
   WHERE h.account_id = p_account AND h.released_at IS NULL;

  -- 262: what else belongs to a held customer. Calls: 222's match (093),
  -- set-based; change both. Rooms: theirs, or with them in it. Groups: with
  -- them in it.
  CREATE TEMP TABLE IF NOT EXISTS pg_temp.privacy_held_rows (kind text, id uuid) ON COMMIT DROP;
  TRUNCATE pg_temp.privacy_held_rows;
  IF EXISTS (SELECT 1 FROM pg_temp.privacy_held) THEN
    SELECT array_agg(h.contact_id::text), coalesce(array_agg(h.phone) FILTER (WHERE h.phone IS NOT NULL), '{}')
      INTO v_ids, v_phones FROM pg_temp.privacy_held h;
    INSERT INTO pg_temp.privacy_held_rows
    SELECT 'call', x.id FROM public.calls x
     WHERE x.account_id = p_account AND x.erased_at IS NULL
       AND (x.contact_id::text = ANY (v_ids)
            OR x.meta -> 'contact_candidates' ?| v_ids
            OR public.pbx_phone_variants(x.remote_number)::text[] && v_phones
            OR (length(x.remote_number) >= 8
                AND right(x.remote_number, 8) IN (SELECT right(h.phone, 8) FROM pg_temp.privacy_held h WHERE length(h.phone) >= 8)
                AND NOT EXISTS (SELECT 1 FROM public.contacts o
                                 WHERE o.account_id = p_account
                                   AND o.phone_normalized = ANY (public.pbx_phone_variants(x.remote_number)))));
    INSERT INTO pg_temp.privacy_held_rows
    SELECT 'room', d.id FROM public.deal_rooms d
     WHERE d.account_id = p_account AND d.contact_id IN (SELECT h.contact_id FROM pg_temp.privacy_held h)
    UNION
    SELECT 'room', p.room_id FROM public.deal_room_participants p
     WHERE p.account_id = p_account AND p.contact_id IN (SELECT h.contact_id FROM pg_temp.privacy_held h);
    INSERT INTO pg_temp.privacy_held_rows
    SELECT DISTINCT 'group', p.group_id FROM public.whatsapp_group_participants p
     WHERE p.account_id = p_account
       AND (p.contact_id IN (SELECT h.contact_id FROM pg_temp.privacy_held h)
            OR public.privacy_digits(p.wa_id) IN (SELECT h.digits FROM pg_temp.privacy_held h WHERE h.digits IS NOT NULL));
  END IF;

  BEGIN
    FOR r IN SELECT k, (v ->> 'days')::integer AS days, v ->> 'action' AS action
               FROM jsonb_each(s.policy -> 'tables') AS e(k, v) ORDER BY k LOOP
      v_cut := now() - make_interval(days => r.days);
      v_n := 0; v_got := '[]'::jsonb;
      -- Each kind: lock the slice (its media as it is now), remove exactly
      -- those rows, keep what their media pointed at.
      IF r.k = 'deal_room_messages' THEN
        SELECT count(*) INTO v_held FROM public.group_messages m
         WHERE m.account_id = p_account AND m.created_at < v_cut AND m.room_id IN (SELECT x.id FROM pg_temp.privacy_held_rows x WHERE x.kind = 'room');
        IF r.action = 'delete' THEN
          WITH pick AS MATERIALIZED (
            SELECT m.id, m.media FROM public.group_messages m WHERE m.account_id = p_account AND m.created_at < v_cut
               AND m.room_id NOT IN (SELECT x.id FROM pg_temp.privacy_held_rows x WHERE x.kind = 'room')
             LIMIT v_lim FOR UPDATE),
          gone AS (DELETE FROM public.group_messages m USING pick WHERE m.id = pick.id RETURNING pick.media)
          SELECT count(*), coalesce(jsonb_agg(o.o) FILTER (WHERE o.o IS NOT NULL), '[]')
            INTO v_n, v_got FROM gone LEFT JOIN LATERAL (
              SELECT public.privacy_media_objects(p_account, gone.media) AS o WHERE gone.media IS NOT NULL) o ON true;
        ELSE
          WITH pick AS MATERIALIZED (
            SELECT m.id, m.media FROM public.group_messages m
             WHERE m.account_id = p_account AND m.created_at < v_cut AND (m.body IS NOT NULL OR m.media IS NOT NULL)
               AND m.room_id NOT IN (SELECT x.id FROM pg_temp.privacy_held_rows x WHERE x.kind = 'room')
             LIMIT v_lim FOR UPDATE),
          gone AS (UPDATE public.group_messages m SET body = NULL, media = NULL, sender_wa_id = NULL
                     FROM pick WHERE m.id = pick.id RETURNING pick.media)
          SELECT count(*), coalesce(jsonb_agg(o.o) FILTER (WHERE o.o IS NOT NULL), '[]')
            INTO v_n, v_got FROM gone LEFT JOIN LATERAL (
              SELECT public.privacy_media_objects(p_account, gone.media) AS o WHERE gone.media IS NOT NULL) o ON true;
        END IF;
      ELSIF r.k = 'whatsapp_group_messages' THEN
        SELECT count(*) INTO v_held FROM public.whatsapp_group_messages m
         WHERE m.account_id = p_account AND m.created_at < v_cut
           AND (m.group_id IN (SELECT x.id FROM pg_temp.privacy_held_rows x WHERE x.kind = 'group')
                OR public.privacy_digits(m.sender_wa_id) IN (SELECT digits FROM pg_temp.privacy_held WHERE digits IS NOT NULL));
        IF r.action = 'delete' THEN
          WITH pick AS MATERIALIZED (
            SELECT m.id, m.media FROM public.whatsapp_group_messages m WHERE m.account_id = p_account AND m.created_at < v_cut
               AND m.group_id NOT IN (SELECT x.id FROM pg_temp.privacy_held_rows x WHERE x.kind = 'group')
               AND coalesce(public.privacy_digits(m.sender_wa_id), '') NOT IN (SELECT digits FROM pg_temp.privacy_held WHERE digits IS NOT NULL)
             LIMIT v_lim FOR UPDATE),
          gone AS (DELETE FROM public.whatsapp_group_messages m USING pick WHERE m.id = pick.id RETURNING pick.media)
          SELECT count(*), coalesce(jsonb_agg(o.o) FILTER (WHERE o.o IS NOT NULL), '[]')
            INTO v_n, v_got FROM gone LEFT JOIN LATERAL (
              SELECT public.privacy_media_objects(p_account, gone.media) AS o WHERE gone.media IS NOT NULL) o ON true;
        ELSE
          WITH pick AS MATERIALIZED (
            SELECT m.id, m.media FROM public.whatsapp_group_messages m
             WHERE m.account_id = p_account AND m.created_at < v_cut
               AND (m.body IS NOT NULL OR m.media IS NOT NULL OR m.sender_name IS NOT NULL)
               AND m.group_id NOT IN (SELECT x.id FROM pg_temp.privacy_held_rows x WHERE x.kind = 'group')
               AND coalesce(public.privacy_digits(m.sender_wa_id), '') NOT IN (SELECT digits FROM pg_temp.privacy_held WHERE digits IS NOT NULL)
             LIMIT v_lim FOR UPDATE),
          gone AS (UPDATE public.whatsapp_group_messages m SET body = NULL, media = NULL, sender_name = NULL
                     FROM pick WHERE m.id = pick.id RETURNING pick.media)
          SELECT count(*), coalesce(jsonb_agg(o.o) FILTER (WHERE o.o IS NOT NULL), '[]')
            INTO v_n, v_got FROM gone LEFT JOIN LATERAL (
              SELECT public.privacy_media_objects(p_account, gone.media) AS o WHERE gone.media IS NOT NULL) o ON true;
        END IF;
      ELSIF r.k = 'hr_outbox_bodies' THEN
        SELECT count(*) INTO v_held FROM public.hr_automsg_outbox o
         WHERE o.account_id = p_account AND o.created_at < v_cut AND o.status IN ('sent', 'failed', 'cancelled')
           AND o.contact_id IN (SELECT contact_id FROM pg_temp.privacy_held);
        WITH pick AS MATERIALIZED (
          SELECT o.id FROM public.hr_automsg_outbox o
           WHERE o.account_id = p_account AND o.created_at < v_cut AND o.status IN ('sent', 'failed', 'cancelled')
             AND o.body_rendered <> '' AND o.contact_id NOT IN (SELECT contact_id FROM pg_temp.privacy_held)
           LIMIT v_lim FOR UPDATE)
        UPDATE public.hr_automsg_outbox o SET body_rendered = '', params = '[]'::jsonb FROM pick WHERE o.id = pick.id;
        GET DIAGNOSTICS v_n = ROW_COUNT;
      ELSIF r.k = 'hr_agent_drafts' THEN
        SELECT count(*) INTO v_held FROM public.hr_agent_drafts d JOIN public.conversations v ON v.id = d.conversation_id
         WHERE d.account_id = p_account AND d.created_at < v_cut AND d.status <> 'pending'
           AND v.contact_id IN (SELECT contact_id FROM pg_temp.privacy_held);
        WITH pick AS MATERIALIZED (
          SELECT d.id FROM public.hr_agent_drafts d JOIN public.conversations v ON v.id = d.conversation_id
           WHERE d.account_id = p_account AND d.created_at < v_cut AND d.status <> 'pending'
             AND v.contact_id NOT IN (SELECT contact_id FROM pg_temp.privacy_held)
           LIMIT v_lim FOR UPDATE OF d)
        DELETE FROM public.hr_agent_drafts d USING pick WHERE d.id = pick.id;
        GET DIAGNOSTICS v_n = ROW_COUNT;
      ELSIF r.k = 'call_records' THEN
        SELECT count(*) INTO v_held FROM public.calls c
         WHERE c.account_id = p_account AND c.started_at < v_cut AND c.erased_at IS NULL
           AND c.id IN (SELECT x.id FROM pg_temp.privacy_held_rows x WHERE x.kind = 'call');
        WITH pick AS MATERIALIZED (
          SELECT c.id FROM public.calls c
           WHERE c.account_id = p_account AND c.started_at < v_cut AND c.erased_at IS NULL
             AND c.id NOT IN (SELECT x.id FROM pg_temp.privacy_held_rows x WHERE x.kind = 'call')
             AND NOT EXISTS (SELECT 1 FROM public.call_recordings rr WHERE rr.call_id = c.id AND rr.erased_at IS NULL)
           LIMIT v_lim FOR UPDATE)
        UPDATE public.calls c SET notes = NULL, disposition = NULL, notes_updated_by = NULL, notes_updated_at = NULL,
               recording_state = 'erased', erased_at = now()
          FROM pick WHERE c.id = pick.id;
        GET DIAGNOSTICS v_n = ROW_COUNT;
      END IF;
      v_more := v_more OR coalesce(v_n >= v_lim, false);
      v_obj := v_obj || coalesce((SELECT jsonb_agg(o) FROM jsonb_array_elements(v_got) AS g(l),
                                         LATERAL jsonb_array_elements(g.l) AS e(o)), '[]'::jsonb);
      v_out := v_out || jsonb_build_object(r.k, jsonb_build_object('action', r.action, 'days', r.days,
                                                                   'rows', v_n, 'held_skipped', v_held));
    END LOOP;
    -- Every row of this slice is gone or blank now: what still points at a
    -- file is what stays.
    v_obj := public.privacy_objects_unreferenced(p_account, v_obj);
    IF v_dry THEN
      RAISE EXCEPTION USING ERRCODE = 'ZP223', MESSAGE = 'privacy_retention_sweep dry run';
    END IF;
  EXCEPTION WHEN SQLSTATE 'ZP223' THEN
    NULL;
  END;

  INSERT INTO public.privacy_requests (account_id, kind, actor_label, detail)
  VALUES (p_account, CASE WHEN v_dry THEN 'retention_dry_run' ELSE 'retention' END, 'system:retention',
          jsonb_build_object('tables', v_out, 'objects', jsonb_array_length(v_obj), 'more', v_more)
          || CASE WHEN v_dry OR jsonb_array_length(v_obj) = 0 THEN '{}'::jsonb
                  ELSE jsonb_build_object('objects_list', jsonb_path_query_array(v_obj, '$[0 to 999]')) END)
  RETURNING id INTO v_id;
  IF NOT v_dry THEN
    INSERT INTO public.privacy_requests (account_id, kind, actor_label, detail)
    SELECT p_account, 'retention', 'system:retention', jsonb_build_object('part_of', v_id, 'objects_list', jsonb_agg(e.o ORDER BY e.n))
      FROM jsonb_array_elements(v_obj) WITH ORDINALITY AS e(o, n)
     WHERE e.n > 1000 GROUP BY (e.n - 1) / 1000 ORDER BY (e.n - 1) / 1000;
  END IF;
  RETURN jsonb_build_object('mode', CASE WHEN v_dry THEN 'dry_run' ELSE 'apply' END, 'request_id', v_id, 'tables', v_out,
                            'objects', jsonb_array_length(v_obj), 'more', v_more);
END;
$$;

REVOKE ALL ON FUNCTION public.privacy_retention_last_run(uuid), public.privacy_retention_get(uuid, uuid),
  public.privacy_retention_failed(uuid, text), public.privacy_media_objects(uuid, jsonb),
  public.privacy_erase_objects_pending(integer), public.privacy_erase_objects_settle(bigint, jsonb),
  public.privacy_retention_sweep(uuid, boolean, integer)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.privacy_retention_get(uuid, uuid), public.privacy_retention_failed(uuid, text),
  public.privacy_erase_objects_pending(integer), public.privacy_erase_objects_settle(bigint, jsonb),
  public.privacy_retention_sweep(uuid, boolean, integer)
TO service_role;

RESET lock_timeout;
