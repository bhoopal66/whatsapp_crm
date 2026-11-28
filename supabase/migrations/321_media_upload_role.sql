-- ============================================================
-- 321_media_upload_role.sql — only agents and up write chat-media and
-- flow-media from a session
--
-- 083's permissive policies on storage.objects (restating 023, 020 and
-- 057) let any active, live, non-guest member write under
-- account-<active account>/: no role is checked, so a viewer, the
-- read-only role, could upload, replace and remove WhatsApp media. And
-- 020, 023 and 057 still DROP and CREATE the same policy names with
-- their older predicate (a profile in ANY workspace, no is_active, no
-- deactivation, no guest exclusion): re-applying one of them after 083
-- widens the permissive policies again, so a deactivated member could
-- write under account-<id>/.
--
-- Three RESTRICTIVE policies for `authenticated`, AND-ed with 083's and
-- 283's (all keep holding). For INSERT, UPDATE (the row before and
-- after) and DELETE in chat-media and flow-media, the first folder must
-- be account-<uuid> and the caller is_account_member(<uuid>, 'agent'):
-- that is the caller's ACTIVE profile in that workspace, not
-- deactivated, not bank_guest, agent or above (083). A restrictive
-- policy holds whatever a permissive one says, so it holds too when
-- 020, 023 or 057 is re-run; none of them is edited.
--
-- A folder name that is not account-<lower-case uuid> (account-nope/,
-- a file at the top of the bucket, a user-id folder) is refused, never
-- an error: the uuid is only cast once the name is known to be one.
--
-- Every browser writer goes through uploadAccountMedia (account-<id>/):
-- the inbox and group composers (agents and up), the template manager
-- and broadcast wizard (admins), the flow builder (admins, flow-media).
-- No browser code writes a user-id folder in flow-media, so 083's
-- `auth.uid() = folder[1]` branch no longer lets a session change or
-- remove an object there.
--
-- Not affected: SELECT (public buckets; 283 already limits listing to
-- the uploader), the public URL of an object, the service role, which
-- bypasses RLS (inbound media, avatars/, voice-library/, the staged
-- sweep), and chat-files, case-files, deal-files, avatars and every
-- other bucket.
--
-- No existing row is changed. A viewer's earlier upload stays where it
-- is; only the server removes it now.
--
-- Re-runnable: DROP POLICY IF EXISTS, then CREATE. Apply as a role that
-- may create policies on storage.objects, as 283.
-- ============================================================

DO $$
DECLARE
  v_writer text;
BEGIN
  -- Before the first DDL: nothing is half applied.
  IF to_regprocedure('public.is_account_member(uuid, public.account_role_enum)') IS NULL THEN
    RAISE EXCEPTION 'public.is_account_member(uuid, account_role_enum) is missing: apply 083 before 321';
  END IF;

  -- foldername() drops the file name; [1] is NULL for a file at the top
  -- of the bucket, and the CASE then refuses it as well.
  v_writer :=
    '(bucket_id NOT IN (''chat-media'', ''flow-media'') OR coalesce(CASE'
    ' WHEN (storage.foldername(name))[1]'
    ' ~ ''^account-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'''
    ' THEN public.is_account_member('
    'substr((storage.foldername(name))[1], 9)::uuid,'
    ' ''agent''::public.account_role_enum)'
    ' ELSE false END, false))';

  DROP POLICY IF EXISTS "WhatsApp media is uploaded by agents and up" ON storage.objects;
  EXECUTE format(
    'CREATE POLICY "WhatsApp media is uploaded by agents and up"'
    ' ON storage.objects AS RESTRICTIVE FOR INSERT TO authenticated'
    ' WITH CHECK (%s)', v_writer);

  DROP POLICY IF EXISTS "WhatsApp media is changed by agents and up" ON storage.objects;
  EXECUTE format(
    'CREATE POLICY "WhatsApp media is changed by agents and up"'
    ' ON storage.objects AS RESTRICTIVE FOR UPDATE TO authenticated'
    ' USING (%s) WITH CHECK (%s)', v_writer, v_writer);

  DROP POLICY IF EXISTS "WhatsApp media is deleted by agents and up" ON storage.objects;
  EXECUTE format(
    'CREATE POLICY "WhatsApp media is deleted by agents and up"'
    ' ON storage.objects AS RESTRICTIVE FOR DELETE TO authenticated'
    ' USING (%s)', v_writer);
END $$;
