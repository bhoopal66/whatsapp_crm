-- ============================================================
-- 155_chat_media_staged_sweep.sql — find composer uploads never sent
--
-- The inbox composer uploads an attachment to the `chat-media` bucket
-- the moment it is attached, before the agent presses Send, so the
-- preview and the send can use the same public URL. When the message
-- is never sent (tab closed, draft abandoned, page reloaded) nothing
-- deletes the object, and it stays forever. Composer uploads now land
-- in their own folder,
--
--   chat-media/account-<account uuid>/staged/<epoch ms>-<basename>.<ext>
--
-- (`buildMediaPath(..., 'staged')` in src/lib/storage/upload-media.ts),
-- so an unsent one can be told apart from every other chat-media object
-- (inbound mirrors under inbound/, avatars, template and broadcast
-- headers uploaded at the top level).
--
-- chat_media_staged_orphans() lists the staged objects nothing points
-- at, oldest first; the cron deletes them through the Storage API.
-- Deleting storage.objects rows instead would leave the bytes on disk.
-- It is the chat-media counterpart of 087's chat_orphan_files.
--
-- What points at a chat-media object is a URL, not a path:
--   * messages.media_url (039: an outbound media_url is a chat-media
--     object; a sent staged attachment ends up here);
--   * message_templates.header_media_url (014) and
--     broadcasts.header_media_url (053), which the template manager and
--     the broadcast wizard upload into chat-media. They do not stage
--     today, but a header is a long-lived reference, so they are
--     honoured rather than assumed.
-- No other column in the schema stores a chat-media URL: group, deal
-- room and submission group media are jsonb from the gateway, and flow
-- media live in the flow-media bucket.
--
-- Matching is on the object name taken from the URL's path (the part
-- after `/chat-media/`, without `?query` or `#fragment`), never on the
-- whole URL: the public origin changes whenever the tunnel URL does, and
-- a signed URL carries a token query.
--
-- Guards:
--   * p_min_age under one day is refused (22023), so a mistaken call
--     cannot list a draft someone is still writing; NULL is refused too.
--   * p_limit is clamped to 1..1000, as in chat_orphan_files.
--   * Only names whose every character is URL-safe ([A-Za-z0-9._-]) are
--     candidates. buildMediaPath emits only those for the timestamp and
--     basename, but takes the extension verbatim; a name with any other
--     character might be percent-encoded in the stored URL and so never
--     match, and an unmatched referenced file must not be listed. Such
--     a name is left in place: a leak, never a deleted attachment.
--
-- Service role only. Re-runnable: CREATE OR REPLACE, REVOKE/GRANT.
-- ============================================================

CREATE OR REPLACE FUNCTION public.chat_media_staged_orphans(
  p_min_age interval DEFAULT interval '30 days',
  p_limit   integer  DEFAULT 500)
RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_min_age IS NULL OR p_min_age < interval '1 day' THEN
    RAISE EXCEPTION 'chat_media_staged_orphans: p_min_age must be at least 1 day (got %)', p_min_age
      USING ERRCODE = '22023';
  END IF;

  -- One pass over the referencing rows. `refs` is every staged name any
  -- row points at, built by a single scan of each table (the LIKE only
  -- keeps non-staged URLs out of the set; the regexp runs on what is
  -- left). NOT EXISTS against it plans as a hash anti-join: the set is
  -- hashed once and each candidate is one probe. The alternative, a
  -- LIKE '%' || o.name || '%' per candidate, rescans ~1M messages for
  -- every object; NOT IN would be a hashed subplan only while the set
  -- fits in work_mem and degrades to a rescan per candidate beyond it
  -- (and yields nothing at all if a NULL slips in).
  --
  -- An array, not a set, like chat_orphan_files: the cron reads both
  -- sweeps' answers the same way (one string array per call).
  RETURN (
    WITH refs AS (
      SELECT substring(u.url FROM '/chat-media/([^?#]+)') AS name
        FROM (SELECT m.media_url AS url FROM public.messages m
               WHERE m.media_url LIKE '%/chat-media/account-%/staged/%'
              UNION ALL
              SELECT t.header_media_url FROM public.message_templates t
               WHERE t.header_media_url LIKE '%/chat-media/account-%/staged/%'
              UNION ALL
              SELECT b.header_media_url FROM public.broadcasts b
               WHERE b.header_media_url LIKE '%/chat-media/account-%/staged/%') u
    )
    SELECT coalesce(array_agg(x.name ORDER BY x.created_at, x.name), '{}')
      FROM (SELECT o.name, o.created_at
              FROM storage.objects o
             WHERE o.bucket_id = 'chat-media'
               AND o.name ~ '^account-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/staged/[A-Za-z0-9._-]+$'
               AND o.created_at < now() - p_min_age
               AND NOT EXISTS (SELECT 1 FROM refs r WHERE r.name = o.name)
             ORDER BY o.created_at, o.name
             LIMIT least(greatest(coalesce(p_limit, 500), 1), 1000)) x
  );
END
$$;

COMMENT ON FUNCTION public.chat_media_staged_orphans(interval, integer) IS
  'Composer uploads in chat-media (account-<uuid>/staged/<name>) older than p_min_age (at least 1 day) '
  'that no messages.media_url, message_templates.header_media_url or broadcasts.header_media_url '
  'points at, compared on the URL path; oldest first, at most p_limit (1..1000). '
  'The cron deletes them through the Storage API. Service role only.';

-- Supabase grants EXECUTE on new public functions to anon and
-- authenticated by default; the listing names every account's files.
REVOKE ALL ON FUNCTION public.chat_media_staged_orphans(interval, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_media_staged_orphans(interval, integer) TO service_role;
