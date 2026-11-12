-- ============================================================
-- Migration 195: SECOND BRAIN PAGES, one living, AI-generated summary
-- page per case, contact and bank.
-- ============================================================
--
-- Ported from the wacrm module package's migration 022c (pages), on top
-- of migration 194 (brain_items, brain_item_visible,
-- brain_contact_marked, brain_actor_role), with 194's mapping:
--  * workspace_id text -> account_id uuid (accounts); actor text -> an
--    auth user id. The package's 'system:retention' / 'system:erasure'
--    are p_actor NULL plus p_system_label.
--  * case_actor_role -> brain_actor_role; no 'it' role, so "any non-IT
--    member" is any actor brain_actor_role names in the account.
--  * bank_id -> bank_code; contact ids are uuids.
--
-- PAGES (brain_pages): one row per (account_id, kind, key); kind case
--   (key = case id as text), contact (key = contact id as text) or bank
--   (key = bank_code). A case or contact key is a lowercase uuid (CHECK),
--   so a case read with a key that is not one simply finds nothing.
--   summary is AI-generated (ai_generated always true); version is
--   bumped by every put and every wipe; built_from_item_ids holds every
--   item the summariser was fed.
-- DIRTY: brain_page_mark_dirty(account, item_ids) marks the case /
--   contact / bank pages of those items dirty (creating version-0
--   pages). Idempotent: a page already dirty keeps its dirty_since; a
--   marked contact's page and a deleted (forgotten) page are never
--   created or reopened. The app calls it after each ingest.
-- SOURCES: brain_page_sources(account, kind, key, limit): the items a
--   page is built from: live, of the page's case / contact / bank,
--   restricted_role NULL, contact unmarked; newest first, capped by
--   limit (NULL = all).
-- PUT: brain_page_put(account, kind, key, expected_version, summary,
--   item_ids): optimistic (another version is CONFLICT); the summary
--   gets the items' 9+ digit guard (TEXT_UNREDACTED); every item id must
--   be a current source of the page (ITEM_NOT_FOUND). The page stays
--   dirty when a source newer than the oldest fed item was not fed.
-- READ (fail closed): brain_page_read(actor, account, kind, key) returns
--   the page only when it is built, not deleted, and EVERY built-from
--   item still exists, is live, its contact is unmarked and it is
--   visible to the actor (brain_item_visible). A case page also needs
--   case_can_read; a contact / bank page with no source items is never
--   returned. Not returned is indistinguishable from missing.
-- FORGET: brain_page_forget wipes the contact's page (tombstone, never
--   rebuilt) and wipes (summary '', dirty) every page built from that
--   contact's items. brain_item_forget (defined in 194): any scope also
--   wipes pages built from a forgotten item; scope contact also deletes
--   that contact's page. Deleting a contact (contacts_forget_brain) does
--   the same. Actors: admin / super_admin, system:retention /
--   system:erasure, or any brain role once the contact is marked
--   (wiping only narrows).
-- PRIVILEGES: RLS forced, no policies; table privileges revoked;
--   SECURITY DEFINER functions executable by service_role only
--   (brain_page_wipe by nobody).
--
-- Refusals (hint): KIND_INVALID, SCOPE_INVALID, TEXT_INVALID,
--   TEXT_UNREDACTED, PAGE_NOT_FOUND, ITEM_NOT_FOUND, CONFLICT,
--   NOT_ALLOWED.
--
-- Re-runnable: every statement is guarded.
-- ============================================================

-- ---------- 1. Table ----------

CREATE TABLE IF NOT EXISTS public.brain_pages (
  page_id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  kind                text        NOT NULL CHECK (kind IN ('case', 'contact', 'bank')),
  key                 text        NOT NULL CHECK (key !~ '^[[:space:]]*$' AND length(key) <= 200),
  summary             text        NOT NULL DEFAULT '' CHECK (length(summary) <= 8000),
  ai_generated        boolean     NOT NULL DEFAULT true,
  version             integer     NOT NULL DEFAULT 0,
  built_from_item_ids uuid[]      NOT NULL DEFAULT '{}',
  built_at            timestamptz NULL,
  dirty               boolean     NOT NULL DEFAULT true,
  dirty_since         timestamptz NULL,
  deleted_at          timestamptz NULL,
  CONSTRAINT brain_pages_key UNIQUE (account_id, kind, key),
  CONSTRAINT brain_pages_key_uuid CHECK (kind = 'bank' OR key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  CONSTRAINT brain_pages_deleted_wiped CHECK (deleted_at IS NULL OR summary = '' AND cardinality(built_from_item_ids) = 0)
);

CREATE INDEX IF NOT EXISTS brain_pages_dirty_idx ON public.brain_pages (account_id, dirty_since)
  WHERE dirty AND deleted_at IS NULL;

ALTER TABLE public.brain_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brain_pages FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE public.brain_pages IS
  'Second brain summary pages: one per (account, case / contact / bank). AI-generated, never the record. Written only through the brain_page_* functions. Migration 195.';

-- ---------- 2. Sources and dirty marks ----------

CREATE OR REPLACE FUNCTION public.brain_page_sources(p_account uuid, p_kind text, p_key text, p_limit integer)
RETURNS TABLE (item_id uuid, text text, created_at timestamptz, source_kind text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT i.item_id, i.text, i.created_at, i.source_kind
    FROM public.brain_items i
   WHERE i.account_id = p_account
     AND i.deleted_at IS NULL
     AND i.restricted_role IS NULL
     AND NOT public.brain_contact_marked(p_account, i.contact_id)
     AND CASE p_kind WHEN 'case' THEN i.case_id::text = p_key
                     WHEN 'contact' THEN i.contact_id::text = p_key
                     WHEN 'bank' THEN i.bank_code = p_key
                     ELSE false END
   ORDER BY i.created_at DESC, i.item_id
   LIMIT p_limit
$$;

COMMENT ON FUNCTION public.brain_page_sources(uuid, text, text, integer) IS
  'The items a page is built from: live, unrestricted, contact unmarked, of the page''s case / contact / bank; newest first, at most p_limit (NULL = all). Migration 195.';

CREATE OR REPLACE FUNCTION public.brain_page_mark_dirty(p_account uuid, p_item_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  INSERT INTO public.brain_pages AS p (account_id, kind, key, dirty, dirty_since)
  SELECT DISTINCT p_account, k.kind, k.key, true, now()
    FROM public.brain_items i
   CROSS JOIN LATERAL (VALUES ('case', i.case_id::text), ('contact', i.contact_id::text), ('bank', i.bank_code)) AS k(kind, key)
   WHERE i.account_id = p_account
     AND i.item_id = ANY (coalesce(p_item_ids, '{}'))
     AND i.deleted_at IS NULL
     AND k.key IS NOT NULL
     AND k.key !~ '^[[:space:]]*$'
     AND length(k.key) <= 200
     AND NOT (k.kind = 'contact' AND public.brain_contact_marked(p_account, i.contact_id))
  ON CONFLICT ON CONSTRAINT brain_pages_key DO UPDATE SET dirty = true, dirty_since = coalesce(p.dirty_since, now())
   WHERE p.deleted_at IS NULL AND NOT p.dirty;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;

COMMENT ON FUNCTION public.brain_page_mark_dirty(uuid, uuid[]) IS
  'Marks the case / contact / bank pages of these items dirty, creating version-0 pages; never a marked contact''s page or a deleted page. Returns pages created or newly dirtied. Migration 195.';

CREATE OR REPLACE FUNCTION public.brain_page_dirty_list(p_account uuid, p_limit integer)
RETURNS TABLE (kind text, key text, version integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.kind, p.key, p.version FROM public.brain_pages p
   WHERE p.account_id = p_account AND p.dirty AND p.deleted_at IS NULL
   ORDER BY p.dirty_since, p.page_id
   LIMIT greatest(coalesce(p_limit, 10), 0)
$$;

COMMENT ON FUNCTION public.brain_page_dirty_list(uuid, integer) IS
  'The oldest dirty, live pages of an account (default 10). Migration 195.';

CREATE OR REPLACE FUNCTION public.brain_page_dirty_count(p_account uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT count(*)::integer FROM public.brain_pages p
   WHERE p.account_id = p_account AND p.dirty AND p.deleted_at IS NULL
$$;

COMMENT ON FUNCTION public.brain_page_dirty_count(uuid) IS
  'How many live pages of an account are dirty. Migration 195.';

CREATE OR REPLACE FUNCTION public.brain_page_version(p_account uuid, p_kind text, p_key text)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.version FROM public.brain_pages p
   WHERE p.account_id = p_account AND p.kind = p_kind AND p.key = p_key AND p.deleted_at IS NULL
$$;

COMMENT ON FUNCTION public.brain_page_version(uuid, text, text) IS
  'The current version of a live page, NULL when there is none. Migration 195.';

-- ---------- 3. Put (optimistic) ----------

CREATE OR REPLACE FUNCTION public.brain_page_put(p_account uuid, p_kind text, p_key text, p_expected_version integer,
  p_summary text, p_item_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_version integer;
  v_ids     uuid[] := coalesce(p_item_ids, '{}');
  v_oldest  timestamptz;
  v_dirty   boolean;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('case', 'contact', 'bank') THEN
    RAISE EXCEPTION 'brain_page_put: kind is case, contact or bank'
      USING ERRCODE = 'invalid_parameter_value', HINT = 'KIND_INVALID';
  END IF;
  IF p_summary IS NULL OR p_summary ~ '^[[:space:]]*$' OR length(p_summary) > 8000 THEN
    RAISE EXCEPTION 'brain_page_put: summary must be 1..8000 chars'
      USING ERRCODE = 'invalid_parameter_value', HINT = 'TEXT_INVALID';
  END IF;
  IF p_summary ~ '[0-9]([-. ]?[0-9]){8,}' THEN
    RAISE EXCEPTION 'brain_page_put: summary holds an unredacted number'
      USING ERRCODE = 'invalid_parameter_value', HINT = 'TEXT_UNREDACTED';
  END IF;
  SELECT p.version INTO v_version FROM public.brain_pages p
   WHERE p.account_id = p_account AND p.kind = p_kind AND p.key = p_key AND p.deleted_at IS NULL
   FOR UPDATE;
  IF v_version IS NULL THEN
    RAISE EXCEPTION 'brain_page_put: page not found'
      USING ERRCODE = 'no_data_found', HINT = 'PAGE_NOT_FOUND';
  END IF;
  IF p_expected_version IS NULL OR v_version <> p_expected_version THEN
    RAISE EXCEPTION 'brain_page_put: version % expected, % current', p_expected_version, v_version
      USING ERRCODE = 'object_not_in_prerequisite_state', HINT = 'CONFLICT';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_ids) AS x(id)
              WHERE NOT EXISTS (SELECT 1 FROM public.brain_page_sources(p_account, p_kind, p_key, NULL) s
                                 WHERE s.item_id = x.id)) THEN
    RAISE EXCEPTION 'brain_page_put: an item is not a source of the page'
      USING ERRCODE = 'no_data_found', HINT = 'ITEM_NOT_FOUND';
  END IF;
  SELECT min(i.created_at) INTO v_oldest FROM public.brain_items i
   WHERE i.account_id = p_account AND i.item_id = ANY (v_ids);
  SELECT EXISTS (SELECT 1 FROM public.brain_page_sources(p_account, p_kind, p_key, NULL) s
                  WHERE NOT (s.item_id = ANY (v_ids)) AND (v_oldest IS NULL OR s.created_at > v_oldest))
    INTO v_dirty;
  UPDATE public.brain_pages p
     SET summary = p_summary, ai_generated = true, version = p.version + 1, built_from_item_ids = v_ids,
         built_at = now(), dirty = v_dirty,
         dirty_since = CASE WHEN v_dirty THEN coalesce(p.dirty_since, now()) END
   WHERE p.account_id = p_account AND p.kind = p_kind AND p.key = p_key;
  RETURN v_version + 1;
END
$$;

COMMENT ON FUNCTION public.brain_page_put(uuid, text, text, integer, text, uuid[]) IS
  'Writes a page summary at p_expected_version (CONFLICT otherwise); refuses unredacted numbers and items that are not current sources. Returns the new version. Migration 195.';

-- ---------- 4. Read (fail closed) ----------

-- The ::uuid casts only ever see stored case / contact keys, which
-- brain_pages_key_uuid holds to the uuid shape.
CREATE OR REPLACE FUNCTION public.brain_page_read(p_actor uuid, p_account uuid, p_kind text, p_key text)
RETURNS TABLE (summary text, version integer, built_at timestamptz, sources jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.summary, p.version, p.built_at,
         (SELECT coalesce(jsonb_agg(jsonb_build_object('id', i.item_id::text, 'kind', i.source_kind)
                                    ORDER BY i.created_at DESC, i.item_id), '[]'::jsonb)
            FROM public.brain_items i
           WHERE i.account_id = p_account AND i.item_id = ANY (p.built_from_item_ids))
    FROM public.brain_pages p
   WHERE p.account_id = p_account AND p.kind = p_kind AND p.key = p_key
     AND p.deleted_at IS NULL AND p.built_at IS NOT NULL
     AND public.brain_actor_role(p_account, p_actor) IS NOT NULL
     AND CASE WHEN p.kind = 'case'
              THEN EXISTS (SELECT 1 FROM public.cases c WHERE c.id = p.key::uuid AND c.account_id = p_account)
                   AND coalesce(public.case_can_read(p.key::uuid, p_actor), false)
              ELSE cardinality(p.built_from_item_ids) > 0
                   AND NOT (p.kind = 'contact' AND public.brain_contact_marked(p_account, p.key::uuid))
         END
     AND NOT EXISTS (SELECT 1 FROM unnest(p.built_from_item_ids) AS b(id)
                       LEFT JOIN public.brain_items i ON i.item_id = b.id AND i.account_id = p_account
                      WHERE i.item_id IS NULL OR i.deleted_at IS NOT NULL
                         OR public.brain_contact_marked(p_account, i.contact_id)
                         OR NOT public.brain_item_visible(p_account, i.case_id, i.created_by, i.restricted_role, p_actor))
$$;

COMMENT ON FUNCTION public.brain_page_read(uuid, uuid, text, text) IS
  'A built, live page only when every item it was built from is live, unmarked and visible to the actor (a case page also needs case_can_read); otherwise no row, exactly as for a missing page. Migration 195.';

-- ---------- 5. Forget / wipe ----------

-- Internal (granted to nobody): wipe every page built from one of
-- p_item_ids (rebuilt later without them); with a contact, also delete
-- that contact's page (a tombstone when it had none).
CREATE OR REPLACE FUNCTION public.brain_page_wipe(p_account uuid, p_item_ids uuid[], p_contact uuid)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer := 0;
  v_c integer := 0;
BEGIN
  UPDATE public.brain_pages p
     SET summary = '', built_from_item_ids = '{}', built_at = NULL, version = p.version + 1,
         dirty = true, dirty_since = coalesce(p.dirty_since, now())
   WHERE p.account_id = p_account AND p.deleted_at IS NULL
     AND p.built_from_item_ids && coalesce(p_item_ids, '{}')
     AND NOT (p_contact IS NOT NULL AND p.kind = 'contact' AND p.key = p_contact::text);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF p_contact IS NOT NULL THEN
    INSERT INTO public.brain_pages AS p (account_id, kind, key, dirty, deleted_at)
    VALUES (p_account, 'contact', p_contact::text, false, now())
    ON CONFLICT ON CONSTRAINT brain_pages_key DO UPDATE
      SET summary = '', built_from_item_ids = '{}', built_at = NULL, version = p.version + 1,
          dirty = false, dirty_since = NULL, deleted_at = coalesce(p.deleted_at, now());
    GET DIAGNOSTICS v_c = ROW_COUNT;
  END IF;
  RETURN v_n + v_c;
END
$$;

COMMENT ON FUNCTION public.brain_page_wipe(uuid, uuid[], uuid) IS
  'Internal: wipes pages built from these items (summary emptied, dirty) and, with a contact, tombstones that contact''s page. Executable by nobody but its callers. Migration 195.';

CREATE OR REPLACE FUNCTION public.brain_page_forget(p_actor uuid, p_system_label text, p_account uuid,
  p_contact uuid, p_reason text)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text := public.brain_actor_role(p_account, p_actor);
  v_ids  uuid[];
BEGIN
  IF p_reason IS NULL OR p_reason ~ '^[[:space:]]*$' OR p_contact IS NULL THEN
    RAISE EXCEPTION 'brain_page_forget: contact and reason are required'
      USING ERRCODE = 'invalid_parameter_value', HINT = 'SCOPE_INVALID';
  END IF;
  IF NOT ((p_actor IS NULL AND coalesce(p_system_label, '') IN ('system:retention', 'system:erasure'))
          OR coalesce(v_role, '') IN ('admin', 'super_admin')
          OR (v_role IS NOT NULL AND public.brain_contact_marked(p_account, p_contact))) THEN
    RAISE EXCEPTION 'brain_page_forget: % may not forget', coalesce(p_actor::text, p_system_label)
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  SELECT coalesce(array_agg(i.item_id), '{}') INTO v_ids FROM public.brain_items i
   WHERE i.account_id = p_account AND i.contact_id = p_contact;
  RETURN public.brain_page_wipe(p_account, v_ids, p_contact);
END
$$;

COMMENT ON FUNCTION public.brain_page_forget(uuid, text, uuid, uuid, text) IS
  'Deletes a contact''s page (tombstone) and wipes every page built from its items. Admins / owners, system:retention / system:erasure with actor NULL, or any brain role once the contact is marked. Migration 195.';

-- brain_item_forget and brain_forget_deleted_contact are defined once,
-- in 194, and call brain_page_wipe when it exists: redefining them here
-- let a re-run of 194 silently drop the page wipe.

-- ---------- 6. Privileges ----------

REVOKE ALL ON public.brain_pages FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION
  public.brain_page_sources(uuid, text, text, integer),
  public.brain_page_mark_dirty(uuid, uuid[]),
  public.brain_page_dirty_list(uuid, integer),
  public.brain_page_dirty_count(uuid),
  public.brain_page_version(uuid, text, text),
  public.brain_page_put(uuid, text, text, integer, text, uuid[]),
  public.brain_page_read(uuid, uuid, text, text),
  public.brain_page_wipe(uuid, uuid[], uuid),
  public.brain_page_forget(uuid, text, uuid, uuid, text),
  public.brain_item_forget(uuid, text, uuid, uuid, uuid, timestamptz, text),
  public.brain_forget_deleted_contact()
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.brain_page_sources(uuid, text, text, integer),
  public.brain_page_mark_dirty(uuid, uuid[]),
  public.brain_page_dirty_list(uuid, integer),
  public.brain_page_dirty_count(uuid),
  public.brain_page_version(uuid, text, text),
  public.brain_page_put(uuid, text, text, integer, text, uuid[]),
  public.brain_page_read(uuid, uuid, text, text),
  public.brain_page_forget(uuid, text, uuid, uuid, text),
  public.brain_item_forget(uuid, text, uuid, uuid, uuid, timestamptz, text)
  TO service_role;
