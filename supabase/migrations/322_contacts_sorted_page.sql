-- ============================================================
-- 322_contacts_sorted_page.sql — order the Contacts list by owner,
-- assigned agent or last activity, server side, so paging stays right.
--
-- PostgREST cannot order contacts by a value that lives in another
-- table (the owner's name, the chat's assignee, the chat's last
-- message), and sorting only the 25 loaded rows would look like a sort
-- and be wrong. This returns the ids of ONE page in the right order,
-- plus the total, and the screen then reads those rows as it always
-- has.
--
-- SECURITY INVOKER: contacts, conversations and profiles RLS decide
-- what the caller sees, exactly as for a plain list. Narrowing mirrors
-- the screen's own filters:
--   * p_user      only that user's contacts (a team leader on /contacts)
--   * p_tag_ids   a company chat whose main tag or sub-tag is any of them
--   * p_sources   contacts.lead_source any of these
-- The company chat is the one with personal_owner_id NULL; when a
-- contact has several, the oldest names the assignee (as the list's
-- Assigned to column does) and the newest message counts for activity.
-- Contacts with nothing to sort by go last in both directions; ties
-- fall back to newest created, then id, so pages never overlap.
--
-- No data changes; re-runnable.
-- ============================================================

CREATE OR REPLACE FUNCTION public.contacts_sorted_page(
  p_key     text,
  p_dir     text,
  p_user    uuid   DEFAULT NULL,
  p_tag_ids uuid[] DEFAULT NULL,
  p_sources text[] DEFAULT NULL,
  p_limit   int    DEFAULT 25,
  p_offset  int    DEFAULT 0
)
RETURNS TABLE (contact_id uuid, total bigint)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_limit  int := GREATEST(1, LEAST(COALESCE(p_limit, 25), 200));
  v_offset int := GREATEST(0, COALESCE(p_offset, 0));
BEGIN
  IF p_key IS NULL OR p_key NOT IN ('owner', 'assigned', 'activity') THEN
    RAISE EXCEPTION 'contacts_sorted_page: unknown sort key'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_dir IS NULL OR p_dir NOT IN ('asc', 'desc') THEN
    RAISE EXCEPTION 'contacts_sorted_page: unknown direction'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT
      c.id,
      c.created_at,
      CASE p_key
        WHEN 'owner' THEN (
          SELECT lower(nullif(btrim(pr.full_name), ''))
            FROM public.profiles pr
           WHERE pr.user_id = c.user_id AND pr.account_id = c.account_id
           LIMIT 1)
        WHEN 'assigned' THEN (
          SELECT lower(nullif(btrim(pr.full_name), ''))
            FROM public.profiles pr
           WHERE pr.account_id = c.account_id
             AND pr.user_id = (
               SELECT cv.assigned_agent_id
                 FROM public.conversations cv
                WHERE cv.contact_id = c.id AND cv.personal_owner_id IS NULL
                ORDER BY cv.created_at
                LIMIT 1)
           LIMIT 1)
      END AS sort_text,
      CASE WHEN p_key = 'activity' THEN (
        SELECT max(cv.last_message_at)
          FROM public.conversations cv
         WHERE cv.contact_id = c.id AND cv.personal_owner_id IS NULL)
      END AS sort_ts
    FROM public.contacts c
    WHERE (p_user IS NULL OR c.user_id = p_user)
      AND (p_sources IS NULL OR cardinality(p_sources) = 0
           OR c.lead_source = ANY (p_sources))
      AND (p_tag_ids IS NULL OR cardinality(p_tag_ids) = 0
           OR EXISTS (
                SELECT 1 FROM public.conversations cv
                 WHERE cv.contact_id = c.id
                   AND cv.personal_owner_id IS NULL
                   AND (cv.chat_tag_id = ANY (p_tag_ids)
                        OR cv.chat_sub_tag_id = ANY (p_tag_ids))))
  )
  SELECT b.id, count(*) OVER ()
    FROM base b
   ORDER BY
     (b.sort_text IS NULL AND b.sort_ts IS NULL),
     CASE WHEN p_dir = 'asc'  THEN b.sort_text END ASC,
     CASE WHEN p_dir = 'desc' THEN b.sort_text END DESC,
     CASE WHEN p_dir = 'asc'  THEN b.sort_ts END ASC,
     CASE WHEN p_dir = 'desc' THEN b.sort_ts END DESC,
     b.created_at DESC,
     b.id DESC
   LIMIT v_limit OFFSET v_offset;
END;
$$;

REVOKE ALL ON FUNCTION public.contacts_sorted_page(text, text, uuid, uuid[], text[], int, int)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.contacts_sorted_page(text, text, uuid, uuid[], text[], int, int)
  TO authenticated;
