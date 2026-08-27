-- ============================================================
-- 045: let the contact tag-filter narrow to one owner
--
-- The Contacts list has two query paths: a plain select, and this RPC
-- when a tag filter is active. A team leader's personal Contacts page
-- narrows to the contacts they created (their team's live on the Team
-- contacts page instead) — and a filter applied to only one of those
-- two paths is a bug waiting to be reported as "my contact list
-- changes when I filter by tag".
--
-- `p_owner_id` defaults to NULL, meaning "no narrowing", so every
-- existing caller keeps its current behaviour.
-- ============================================================

CREATE OR REPLACE FUNCTION public.filter_contacts_by_tags(
  p_tag_ids  UUID[],
  p_search   TEXT    DEFAULT NULL,
  p_limit    INTEGER DEFAULT 25,
  p_offset   INTEGER DEFAULT 0,
  p_owner_id UUID    DEFAULT NULL
)
RETURNS TABLE(contact contacts, total_count BIGINT)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  WITH matched AS (
    -- Distinct contacts having ANY of the selected tags (OR),
    -- narrowed by the same name/phone/email search as the list.
    SELECT DISTINCT c.id, c.created_at
    FROM contacts c
    JOIN contact_tags ct ON ct.contact_id = c.id
    WHERE ct.tag_id = ANY(p_tag_ids)
      AND (p_owner_id IS NULL OR c.user_id = p_owner_id)
      AND (
        p_search IS NULL
        OR c.name ILIKE '%' || p_search || '%'
        OR c.phone ILIKE '%' || p_search || '%'
        OR c.email ILIKE '%' || p_search || '%'
      )
  ),
  page AS (
    -- count(*) OVER() is evaluated before LIMIT, so it is the full
    -- match total regardless of the page being returned.
    SELECT id, count(*) OVER() AS total_count
    FROM matched
    ORDER BY created_at DESC, id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT c AS contact, page.total_count
  FROM page
  JOIN contacts c ON c.id = page.id
  ORDER BY c.created_at DESC, c.id;
$$;

-- Drop the 4-argument original. Adding a defaulted parameter creates
-- an OVERLOAD rather than replacing the function, and PostgREST
-- resolves an RPC by the exact set of argument NAMES it is given — so
-- a call passing the original four would match both and fail as
-- ambiguous. The new signature covers every existing caller.
DROP FUNCTION IF EXISTS public.filter_contacts_by_tags(UUID[], TEXT, INTEGER, INTEGER);
