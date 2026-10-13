-- 090_pbx_recording_storage.sql — pausing the CRM's copies of call
-- recordings (module 015)
--
-- A workspace can stop the CRM from copying recordings off the PBX, for
-- a server with little disk. pbx_settings.store_recordings (default
-- true) is read by the event processor and the fetch job
-- (src/lib/pbx/process.ts, recordings.ts): while it is false, a call
-- the PBX recorded ends 'not_stored' instead of 'pending' (a bank
-- number's call is still 'held'), and a call still pending is marked
-- 'not_stored' without contacting the PBX. Nothing is changed on the
-- PBX, which keeps recording. A not_stored call is never fetched later,
-- also once storing is switched back on.
--
-- No function of 089 changes: a not_stored call has no audio in
-- storage, so pbx_recording_playable (which requires 'fetched') never
-- plays it, pbx_erase_contact_calls marks it 'erased' as any other
-- state, pbx_purge does not touch calls, and pbx_orphan_recordings
-- spares only a pending call's object.
--
-- Re-runnable: ADD COLUMN IF NOT EXISTS, and the state CHECK is
-- replaced only while it lacks 'not_stored'.

SET lock_timeout = '5s';

ALTER TABLE public.pbx_settings
  ADD COLUMN IF NOT EXISTS store_recordings boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN public.pbx_settings.store_recordings IS
  'false: the CRM does not download call recordings (calls end not_stored); the PBX keeps recording. Migration 090.';

-- 089 declared the state list inline, so Postgres named it: it is found
-- as the CHECK on recording_state alone (calls_erased_check spans
-- several columns and stays as it is).
DO $$
DECLARE
  v_con name;
BEGIN
  FOR v_con IN
    SELECT con.conname
      FROM pg_constraint con
     WHERE con.conrelid = 'public.calls'::regclass
       AND con.contype = 'c'
       AND con.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a
                                WHERE a.attrelid = 'public.calls'::regclass
                                  AND a.attname = 'recording_state')]
       AND pg_get_constraintdef(con.oid) NOT LIKE '%not_stored%'
  LOOP
    EXECUTE format('ALTER TABLE public.calls DROP CONSTRAINT %I', v_con);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.calls'::regclass
                    AND conname = 'calls_recording_state_check') THEN
    ALTER TABLE public.calls ADD CONSTRAINT calls_recording_state_check
      CHECK (recording_state IN ('none', 'pending', 'fetched', 'held', 'failed', 'erased', 'not_stored'));
  END IF;
END $$;
