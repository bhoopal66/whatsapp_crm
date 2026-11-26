-- ============================================================
-- 283_chat_media_owner.sql — a signed-in person reaches only their own
-- uploads in chat-media and flow-media
--
-- 083's permissive policies on storage.objects (restating 023, 020 and
-- 057) look at the first folder alone: account-<my active account>. That
-- folder holds every WhatsApp file of the workspace, so the Storage API
-- gave each member more than the chats they may see. RLS on messages
-- decides who sees a file's message; these policies now leave the file's
-- row to the person who uploaded it and to the server.
--
-- Four RESTRICTIVE policies for `authenticated`, AND-ed with 083's and
-- 242's (both keep holding). Every other bucket passes them untouched:
--
--   * SELECT, UPDATE, DELETE on chat-media and flow-media: only objects
--     the caller owns. Storage writes the uploader's id in `owner_id`
--     (text), and an older version in `owner` (uuid) only, which counts
--     while owner_id is empty. A file the server stored (inbound/,
--     avatars/, voice-library/) has no owner, so nobody's session
--     reaches it.
--   * INSERT into chat-media, and the target of an UPDATE (a move): only
--     the places the app's browser code uploads to,
--         account-<id>/<file>          template and broadcast headers
--         account-<id>/staged/<file>   inbox attachments (155)
--         account-<id>/groups/<file>   group attachments (210)
--     A list of what is allowed, not of what is refused, so a folder the
--     server starts writing tomorrow is closed from the start. A new
--     folder the BROWSER uploads to must be added here, in a later
--     migration (src/lib/storage/chat-media-owner-policy.test.ts).
--
-- Not affected: the public URL of an object (a public bucket's GET does
-- not go through RLS; the gateways and the app's own screens read it
-- that way), the service role, which bypasses RLS, and chat-files,
-- case-files, deal-files, avatars and every other bucket.
--
-- No existing row is changed. A file an agent uploaded earlier stays
-- theirs; one stored by the server was never removable by its reader.
--
-- `owner` is deprecated by Storage: the predicate is built from the
-- columns this database has, and refuses to apply with neither.
--
-- Re-runnable: DROP POLICY IF EXISTS, then CREATE. Apply as a role that
-- may create policies on storage.objects, as 242.
-- ============================================================

DO $$
DECLARE
  v_has_id    boolean;
  v_has_owner boolean;
  v_owner     text;
  v_mine      text;
  v_place     text;
BEGIN
  SELECT coalesce(bool_or(attname = 'owner_id'), false),
         coalesce(bool_or(attname = 'owner'), false)
    INTO v_has_id, v_has_owner
    FROM pg_attribute
   WHERE attrelid = 'storage.objects'::regclass
     AND attnum > 0 AND NOT attisdropped;

  v_owner := CASE
    WHEN v_has_id AND v_has_owner THEN 'coalesce(owner_id, owner::text)'
    WHEN v_has_id                 THEN 'owner_id'
    WHEN v_has_owner              THEN 'owner::text'
  END;
  -- Before the first DDL: nothing is half applied.
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'storage.objects has neither owner_id nor owner: 283 cannot tell whose an object is';
  END IF;

  v_mine := format(
    '(bucket_id NOT IN (''chat-media'', ''flow-media'')'
    ' OR coalesce(%s = (SELECT auth.uid())::text, false))', v_owner);
  -- foldername() drops the file name: one element is the account folder
  -- itself. The depth is checked too, so a path through "..", an empty
  -- folder ("//") or a nested one is not a way around the list.
  v_place :=
    '(bucket_id <> ''chat-media'' OR coalesce('
    'cardinality(storage.foldername(name)) = 1'
    ' OR (cardinality(storage.foldername(name)) = 2'
    ' AND (storage.foldername(name))[2] IN (''staged'', ''groups'')), false))';

  DROP POLICY IF EXISTS "WhatsApp media is read by its uploader" ON storage.objects;
  EXECUTE format(
    'CREATE POLICY "WhatsApp media is read by its uploader"'
    ' ON storage.objects AS RESTRICTIVE FOR SELECT TO authenticated'
    ' USING (%s)', v_mine);

  DROP POLICY IF EXISTS "WhatsApp media is uploaded to the client folders" ON storage.objects;
  EXECUTE format(
    'CREATE POLICY "WhatsApp media is uploaded to the client folders"'
    ' ON storage.objects AS RESTRICTIVE FOR INSERT TO authenticated'
    ' WITH CHECK (%s)', v_place);

  DROP POLICY IF EXISTS "WhatsApp media is changed by its uploader" ON storage.objects;
  EXECUTE format(
    'CREATE POLICY "WhatsApp media is changed by its uploader"'
    ' ON storage.objects AS RESTRICTIVE FOR UPDATE TO authenticated'
    ' USING (%s) WITH CHECK (%s AND %s)', v_mine, v_mine, v_place);

  DROP POLICY IF EXISTS "WhatsApp media is deleted by its uploader" ON storage.objects;
  EXECUTE format(
    'CREATE POLICY "WhatsApp media is deleted by its uploader"'
    ' ON storage.objects AS RESTRICTIVE FOR DELETE TO authenticated'
    ' USING (%s)', v_mine);
END $$;
