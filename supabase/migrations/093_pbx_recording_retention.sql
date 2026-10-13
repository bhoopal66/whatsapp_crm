-- 093_pbx_recording_retention.sql — the recording retention period is
-- enforced, and an admin can place a legal hold (module 015)
--
-- Retention. pbx_settings.retention_days (089; NULL keeps recordings)
-- was saved but nothing acted on it. pbx_expire_recordings(p_limit)
-- (service role, from the PBX cron: src/lib/pbx/housekeeping.ts) marks
-- a batch of recordings erased and returns their storage paths, which
-- the cron then removes from call-recordings. A recording is due when
-- its CALL started more than retention_days ago (calls.started_at, not
-- call_recordings.fetched_at: retention of personal data runs from the
-- call that collected it, the date every screen shows, so a late or
-- retried fetch never lengthens a recording's life), it is not under
-- legal hold, and it is not erased yet.
--
-- Same state as 089, no new one: the recording row's own erased_at,
-- which pbx_recording_playable already refuses, so from that commit no
-- play or download is logged or signed. The call itself is not erased:
-- retention deletes audio only, while an erasure request (C-3,
-- pbx_erase_contact_calls) also clears notes and the outcome and keeps
-- the bare call fact; that stays the owner's decision. The row stays as
-- the record that the audio existed and was deleted, and one pbx_audit
-- row per workspace and batch ('recording_retention', no actor) names
-- the calls.
--
-- Order: the row is marked before the audio is removed. A failed remove
-- then leaves unplayable audio, never a playable row without audio, and
-- pbx_orphan_recordings (replaced below) now also lists an object whose
-- row is erased, so the cron's orphan sweep removes what a failed
-- remove left. Batches are taken FOR UPDATE SKIP LOCKED, so two
-- overlapping runs never take the same row, and a marked row is never
-- taken again.
--
-- Legal hold. call_recordings.legal_hold (089) blocked erasure but
-- nothing could set it. pbx_set_recording_hold(call, hold, reason) is
-- an owner's or admin's, on their own session: it locks the row,
-- refuses a recording already deleted, and writes each change to the
-- append-only pbx_audit with the actor and a reason
-- ('legal_hold_placed' / 'legal_hold_lifted'). A held recording is
-- skipped by retention and still blocks erasure. pbx_recordings_kept()
-- answers Settings → Phone system what the workspace keeps now.
--
-- Re-runnable: CREATE OR REPLACE, CREATE INDEX IF NOT EXISTS.

SET lock_timeout = '5s';

-- Live, unheld rows: what retention scans each pass.
CREATE INDEX IF NOT EXISTS call_recordings_retention_idx
  ON public.call_recordings (account_id) WHERE erased_at IS NULL AND NOT legal_hold;

CREATE OR REPLACE FUNCTION public.pbx_expire_recordings(p_limit integer)
RETURNS SETOF text
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit integer := GREATEST(LEAST(COALESCE(p_limit, 0), 1000), 0);
BEGIN
  -- Data-modifying CTEs run once and to completion, read or not.
  RETURN QUERY
  WITH due AS (
    SELECT r.call_id
      FROM pbx_settings s
      JOIN call_recordings r
        ON r.account_id = s.account_id AND r.erased_at IS NULL AND NOT r.legal_hold
      JOIN calls c
        ON c.id = r.call_id AND c.erased_at IS NULL
           AND c.started_at < now() - make_interval(days => s.retention_days)
     WHERE s.retention_days IS NOT NULL
     ORDER BY c.started_at, r.call_id
     LIMIT v_limit
       FOR UPDATE OF r SKIP LOCKED
  ), gone AS (
    UPDATE call_recordings r
       SET erased_at = now()
      FROM due
     WHERE r.call_id = due.call_id
    RETURNING r.account_id, r.call_id, r.storage_path
  ), audited AS (
    INSERT INTO pbx_audit (account_id, actor_id, action, call_ids, reason, detail)
    SELECT g.account_id, NULL, 'recording_retention', array_agg(g.call_id ORDER BY g.call_id),
           format('Older than the %s-day retention period', s.retention_days),
           jsonb_build_object('recordings', count(*), 'retention_days', s.retention_days)
      FROM gone g
      JOIN pbx_settings s ON s.account_id = g.account_id
     GROUP BY g.account_id, s.retention_days
  )
  SELECT g.storage_path FROM gone g ORDER BY g.storage_path;
END;
$$;

-- 089's sweep, now also over an erased row's object (a remove the
-- retention run could not finish). Unchanged otherwise.
CREATE OR REPLACE FUNCTION public.pbx_orphan_recordings(p_older_than interval, p_limit integer)
RETURNS SETOF text
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT o.name
    FROM storage.objects o
   WHERE o.bucket_id = 'call-recordings'
     AND GREATEST(o.created_at, o.updated_at) < now() - p_older_than
     AND NOT EXISTS (SELECT 1 FROM call_recordings r
                      WHERE r.storage_path = o.name AND r.erased_at IS NULL)
     AND NOT EXISTS (
       SELECT 1 FROM calls c
        WHERE c.recording_state = 'pending'
          AND c.id = substring(o.name FROM
                '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[^/.]*$')::uuid)
   ORDER BY o.created_at, o.name
   LIMIT GREATEST(LEAST(p_limit, 1000), 0)
$$;

-- Owner or admin, on their own session. Returns the hold as it now is.
CREATE OR REPLACE FUNCTION public.pbx_set_recording_hold(p_call_id uuid, p_hold boolean, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid := current_account_id();
  v_reason  text := NULLIF(btrim(p_reason), '');
  v_rec     call_recordings%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_account IS NULL OR current_role_rank() < 4 THEN
    RAISE EXCEPTION 'Only an owner or admin can place or lift a legal hold' USING ERRCODE = '42501';
  END IF;
  IF p_hold IS NULL OR v_reason IS NULL THEN
    RAISE EXCEPTION 'Say whether to place or lift the hold, and why' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_rec FROM call_recordings
   WHERE call_id = p_call_id AND account_id = v_account
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This call has no stored recording' USING ERRCODE = 'P0002';
  END IF;
  IF v_rec.erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'This recording was already deleted' USING ERRCODE = '55000';
  END IF;
  IF v_rec.legal_hold IS DISTINCT FROM p_hold THEN
    UPDATE call_recordings SET legal_hold = p_hold WHERE call_id = p_call_id;
    INSERT INTO pbx_audit (account_id, actor_id, action, contact_id, call_ids, reason, detail)
    SELECT v_account, auth.uid(),
           CASE WHEN p_hold THEN 'legal_hold_placed' ELSE 'legal_hold_lifted' END,
           c.contact_id, ARRAY[p_call_id], v_reason, jsonb_build_object('legal_hold', p_hold)
      FROM calls c WHERE c.id = p_call_id;
  END IF;
  RETURN p_hold;
END;
$$;

-- Owner or admin: the recordings the workspace keeps now, by call date.
CREATE OR REPLACE FUNCTION public.pbx_recordings_kept()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid := current_account_id();
  v_out     jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_account IS NULL OR current_role_rank() < 4 THEN
    RAISE EXCEPTION 'Only an owner or admin can see what is kept' USING ERRCODE = '42501';
  END IF;
  SELECT jsonb_build_object(
           'kept', count(*) FILTER (WHERE r.erased_at IS NULL),
           'legal_hold', count(*) FILTER (WHERE r.erased_at IS NULL AND r.legal_hold),
           'oldest_call_at', min(c.started_at) FILTER (WHERE r.erased_at IS NULL),
           'expired', count(*) FILTER (WHERE r.erased_at IS NOT NULL))
    INTO v_out
    FROM call_recordings r
    JOIN calls c ON c.id = r.call_id
   WHERE r.account_id = v_account;
  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.pbx_expire_recordings(integer), public.pbx_set_recording_hold(uuid, boolean, text),
  public.pbx_recordings_kept()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pbx_expire_recordings(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.pbx_set_recording_hold(uuid, boolean, text), public.pbx_recordings_kept()
  TO authenticated;
