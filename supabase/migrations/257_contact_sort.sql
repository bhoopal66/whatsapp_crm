-- ============================================================
-- 257: Sort the Contacts list by owner, assigned person and last
-- activity.
--
-- The Contacts screens (/contacts, /team-contacts) sort by name and
-- created date in the PostgREST query itself. Owner name, the assigned
-- person's name and the last message are not contacts columns: the
-- names live on profiles and the assignee and last message on the
-- contact's conversations, a to-many embed PostgREST cannot order the
-- contacts by. Sorting only the loaded page would look like a sort and
-- be wrong, so this function orders the whole filtered match set and
-- hands back ONE page of contact ids plus the total.
--
--   contacts_sorted_page(p_sort, p_dir, p_limit, p_offset, p_owner_id,
--                        p_search_like, p_search_digits,
--                        p_chat_tag_ids, p_sources) -> jsonb
--     {"ids": [uuid, ...], "total": n}
--
-- SECURITY INVOKER: contacts RLS decides which contacts exist for the
-- caller, and conversations / profiles RLS which chats and names the
-- keys are read from, exactly as the page's own reads do. Nothing here
-- widens what a caller sees; an id it returns is one a plain SELECT on
-- contacts would also return.
--
-- Keys (case-insensitive; empty = NULL; NULLs last in both directions):
--   owner     contacts.user_id's profile in the contact's workspace:
--             full_name, else email (the screen's nameOf), never a
--             bank guest.
--   assignee  the company chat's (personal_owner_id IS NULL)
--             assigned_agent_id, oldest chat with an assignee first,
--             named the same way.
--   activity  the newest last_message_at of the contact's company
--             chats. Personal chats (191) never count.
-- Ties: created_at newest first, then id descending, the same tiebreak
-- as compareContactRows (lib/contacts/sort.ts), so pages never overlap.
--
-- Filters mirror the page (src/app/(dashboard)/contacts/(list)/page.tsx):
--   p_owner_id       a team leader's own /contacts list (contacts.user_id).
--   p_search_like    the plain search's ILIKE pattern on name, phone and
--                    email, already escaped by the client
--                    (contactSearchTerms in lib/contacts/list-query.ts).
--   p_search_digits  phone_normalized LIKE '%digits%' (digits only, else
--                    ignored), OR'd with the pattern as the page does.
--   p_chat_tag_ids   main or sub tag ids: a contact matches when ANY of
--                    its company chats carries one (chatTagFilterOrGroup).
--   p_sources        lead_source IN (...); the value 'unknown' also keeps
--                    contacts with no source (NULL); empty or NULL = all.
-- The close-match search (193) stays relevance-ranked and never calls
-- this.
--
-- No new index: the keys come from one pass over the caller's visible
-- company chats (idx_conversations_contact_id serves the tag EXISTS)
-- and the workspace's profiles, hash-joined to the contacts.
--
-- Re-runnable (CREATE OR REPLACE); no data change, no refusal scan.
-- ============================================================

SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.contacts_sorted_page(
  p_sort          text,
  p_dir           text,
  p_limit         integer DEFAULT 25,
  p_offset        integer DEFAULT 0,
  p_owner_id      uuid    DEFAULT NULL,
  p_search_like   text    DEFAULT NULL,
  p_search_digits text    DEFAULT NULL,
  p_chat_tag_ids  uuid[]  DEFAULT NULL,
  p_sources       text[]  DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_limit   integer;
  v_offset  integer;
  v_asc     boolean;
  v_like    text;
  v_digits  text;
  v_tags    uuid[];
  v_sources text[];
  v_result  jsonb;
BEGIN
  IF p_sort IS NULL OR p_sort NOT IN ('owner', 'assignee', 'activity') THEN
    RAISE EXCEPTION 'contacts_sorted_page: unknown sort %', p_sort
      USING ERRCODE = '22023';
  END IF;
  IF p_dir IS NULL OR p_dir NOT IN ('asc', 'desc') THEN
    RAISE EXCEPTION 'contacts_sorted_page: unknown direction %', p_dir
      USING ERRCODE = '22023';
  END IF;

  v_asc    := p_dir = 'asc';
  v_limit  := least(greatest(coalesce(p_limit, 25), 1), 200);
  v_offset := greatest(coalesce(p_offset, 0), 0);
  v_like   := CASE WHEN p_search_like IS NULL
                     OR p_search_like ~ '^[[:space:]]*$' THEN NULL
                   ELSE p_search_like END;
  v_digits := CASE WHEN p_search_digits ~ '^[0-9]+$' THEN p_search_digits END;
  v_tags   := CASE WHEN cardinality(p_chat_tag_ids) > 0 THEN p_chat_tag_ids END;
  v_sources := CASE WHEN cardinality(p_sources) > 0 THEN p_sources END;

  WITH people AS (
    -- The screen's nameOf: full_name, else email; bank guests unnamed.
    SELECT p.user_id,
           p.account_id,
           pg_catalog.lower(coalesce(
             CASE WHEN p.full_name ~ '^[[:space:]]*$' THEN NULL
                  ELSE pg_catalog.btrim(p.full_name) END,
             CASE WHEN p.email ~ '^[[:space:]]*$' THEN NULL
                  ELSE pg_catalog.btrim(p.email) END
           )) AS sort_name
      FROM public.profiles p
     WHERE p.account_role::text <> 'bank_guest'
  ),
  chats AS (
    -- One row per contact over its company chats only (191).
    SELECT cv.contact_id,
           max(cv.last_message_at) AS last_at,
           (array_agg(cv.assigned_agent_id ORDER BY cv.created_at, cv.id)
              FILTER (WHERE cv.assigned_agent_id IS NOT NULL))[1] AS assignee
      FROM public.conversations cv
     WHERE cv.personal_owner_id IS NULL
       AND cv.contact_id IS NOT NULL
       AND p_sort IN ('assignee', 'activity')
     GROUP BY cv.contact_id
  ),
  matched AS (
    SELECT c.id,
           c.created_at,
           CASE p_sort
             WHEN 'owner'    THEN own.sort_name
             WHEN 'assignee' THEN asg.sort_name
           END AS k_text,
           CASE WHEN p_sort = 'activity' THEN ch.last_at END AS k_time
      FROM public.contacts c
      LEFT JOIN people own
        ON p_sort = 'owner'
       AND own.user_id = c.user_id
       AND own.account_id = c.account_id
      LEFT JOIN chats ch
        ON ch.contact_id = c.id
      LEFT JOIN people asg
        ON p_sort = 'assignee'
       AND asg.user_id = ch.assignee
       AND asg.account_id = c.account_id
     WHERE (p_owner_id IS NULL OR c.user_id = p_owner_id)
       AND (v_sources IS NULL
            OR c.lead_source = ANY (v_sources)
            OR ('unknown' = ANY (v_sources) AND c.lead_source IS NULL))
       AND (
             (v_like IS NULL AND v_digits IS NULL)
          OR c.name ILIKE v_like
          OR c.phone ILIKE v_like
          OR c.email ILIKE v_like
          OR c.phone_normalized LIKE '%' || v_digits || '%'
       )
       AND (
             v_tags IS NULL
          OR EXISTS (
               SELECT 1
                 FROM public.conversations t
                WHERE t.contact_id = c.id
                  AND t.personal_owner_id IS NULL
                  AND (t.chat_tag_id = ANY (v_tags)
                       OR t.chat_sub_tag_id = ANY (v_tags))
             )
       )
  ),
  ranked AS (
    SELECT m.id,
           row_number() OVER (
             ORDER BY
               CASE WHEN v_asc THEN m.k_text END ASC NULLS LAST,
               CASE WHEN NOT v_asc THEN m.k_text END DESC NULLS LAST,
               CASE WHEN v_asc THEN m.k_time END ASC NULLS LAST,
               CASE WHEN NOT v_asc THEN m.k_time END DESC NULLS LAST,
               m.created_at DESC NULLS LAST,
               m.id DESC
           ) AS n
      FROM matched m
  )
  SELECT jsonb_build_object(
           'ids', coalesce(
             (SELECT jsonb_agg(r.id ORDER BY r.n)
                FROM ranked r
               WHERE r.n > v_offset AND r.n <= v_offset + v_limit),
             '[]'::jsonb),
           'total', (SELECT count(*) FROM matched)
         )
    INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.contacts_sorted_page(text, text, integer, integer, uuid, text, text, uuid[], text[]) IS
  'One page of the Contacts list ordered by owner name, assigned person''s name or the company chat''s last message (NULLs last; ties created_at desc, id desc), under the screen''s filters. SECURITY INVOKER: contacts RLS decides. Returns {"ids": [...], "total": n}. Migration 257.';

REVOKE ALL ON FUNCTION public.contacts_sorted_page(text, text, integer, integer, uuid, text, text, uuid[], text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.contacts_sorted_page(text, text, integer, integer, uuid, text, text, uuid[], text[]) TO authenticated, service_role;

RESET lock_timeout;
