-- ============================================================
-- Migration 196: SECOND BRAIN DIGEST, the reads behind the daily digest.
-- ============================================================
--
-- Ported from the wacrm module package's migration 022d (digest), on
-- top of migration 194, with 194's mapping (workspace_id text ->
-- account_id uuid, actor text -> auth user id, case_actor_role ->
-- brain_actor_role, contact ids are uuids).
--
-- brain_digest_messages(p_account, p_actor, p_since): for each case,
--   the chunks of its NEWEST staff message source the actor may see.
--   Candidates are live source_kind 'message' items written by staff
--   (created_by NOT NULL; system writers leave it NULL and set
--   system_label) on a case, in p_account, that the actor may see
--   (brain_item_visible's rule; an actor with no brain role sees
--   nothing) and whose contact carries no opt-out / deletion mark. A
--   source is one source_id: a reply over 800 characters is several
--   chunks with their own created_at. Per case the source with the
--   newest chunk wins (ties: the greater source_id), and only if that
--   chunk is at or after p_since; every visible chunk of it is
--   returned, an older one included. The digest's promise rule ("a
--   commitment with no LATER staff message on the case") needs exactly
--   this: answering it over a capped, oldest-first list reported
--   promises already followed up, and a reply's second chunk hid its
--   first chunk's promise. At most 1000 cases, newest first. The text
--   is the already-redacted item text. Nothing is stored.
--
-- brain_contacts_marked(p_account, p_contacts): the given contacts that
--   carry a mark (brain_contact_marks, opted out, do-not-contact), in
--   one call instead of brain_contact_marked per contact.
--
-- brain_digest_related(p_account, p_actor, p_contacts, p_banks, p_per):
--   closed cases (closed_at and outcome set) of the account sharing a
--   contact in p_contacts or a bank in p_banks, readable by the actor
--   and with an unmarked contact, at most p_per newest per contact and
--   per bank. Readability is applied BEFORE the per-key limit: taking
--   the account's newest cases first left an agent with nothing
--   whenever other agents had closed more recent ones.
--
-- brain_items stays forced-RLS with no grants.
--
-- PRIVILEGES: SECURITY DEFINER, executable by service_role only.
--
-- Re-runnable: every statement is guarded.
-- ============================================================

-- The output gains source_id, and CREATE OR REPLACE cannot change a
-- function's result columns.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.oid = to_regprocedure('public.brain_digest_messages(uuid, uuid, timestamptz)')
                AND NOT ('source_id' = ANY (p.proargnames))) THEN
    DROP FUNCTION public.brain_digest_messages(uuid, uuid, timestamptz);
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.brain_digest_messages(p_account uuid, p_actor uuid, p_since timestamptz)
RETURNS TABLE (item_id uuid, source_id text, case_id uuid, contact_id uuid, text text, created_by uuid,
               created_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
SET plan_cache_mode = force_custom_plan
AS $$
#variable_conflict use_column
DECLARE
  -- Set-based on purpose (as 194's brain_search_candidates): the actor's
  -- role once, one case_role per distinct case (owner / admin need none:
  -- case_role gives them admin / super_admin on every case of the
  -- account, 161, and the composite FK keeps an item's case in its
  -- account), and the account's marked contacts as one set, instead of
  -- brain_item_visible + brain_contact_marked per item.
  v_role text := public.brain_actor_role(p_account, p_actor);
  v_all boolean := v_role IN ('admin', 'super_admin');
BEGIN
  IF v_role IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  WITH cand AS MATERIALIZED (
    SELECT i.item_id, i.source_id, i.case_id, i.contact_id, i.created_at, i.restricted_role
      FROM public.brain_items i
     WHERE i.account_id = p_account
       AND i.deleted_at IS NULL
       AND i.source_kind = 'message'
       AND i.case_id IS NOT NULL
       AND i.created_by IS NOT NULL
       AND i.created_at >= p_since
  ),
  -- case_can_read is case_rule_can_read(case_role(...)) (122).
  case_access AS MATERIALIZED (
    SELECT r.case_id, coalesce(public.case_rule_can_read(r.case_role), false) AS can_read, r.case_role
      FROM (SELECT d.case_id, public.case_role(d.case_id, p_actor) AS case_role
              FROM (SELECT DISTINCT c.case_id FROM cand c) d
             WHERE NOT v_all
            OFFSET 0) r
  ),
  marked AS MATERIALIZED (
    SELECT m.contact_id FROM public.brain_contact_marks m WHERE m.account_id = p_account
    UNION
    SELECT ct.id FROM public.contacts ct
     WHERE ct.account_id = p_account AND (ct.opted_out_at IS NOT NULL OR ct.do_not_contact_at IS NOT NULL)
  ),
  -- A source whose newest chunk is at or after p_since has that chunk in
  -- cand, so the newest source of a case is decided on cand alone.
  newest AS MATERIALIZED (
    SELECT s.case_id, s.source_id
      FROM (SELECT DISTINCT ON (c.case_id) c.case_id, c.source_id, max(c.created_at) AS last_at
              FROM cand c
              LEFT JOIN case_access ca ON ca.case_id = c.case_id
             WHERE (v_all
                    OR coalesce(ca.can_read
                                AND (c.restricted_role IS NULL OR ca.case_role = c.restricted_role
                                     OR ca.case_role IN ('admin', 'super_admin')), false))
               AND NOT EXISTS (SELECT 1 FROM marked mk WHERE mk.contact_id = c.contact_id)
             GROUP BY c.case_id, c.source_id
             ORDER BY c.case_id, max(c.created_at) DESC, c.source_id DESC) s
     ORDER BY s.last_at DESC, s.case_id
     LIMIT 1000
  )
  -- Every visible chunk of the winning source, an older one included.
  SELECT i.item_id, i.source_id, i.case_id, i.contact_id, i.text, i.created_by, i.created_at
    FROM newest n
    JOIN public.brain_items i
      ON i.account_id = p_account
     AND i.source_kind = 'message'
     AND i.source_id = n.source_id
     AND i.case_id = n.case_id
    LEFT JOIN case_access ca ON ca.case_id = i.case_id
   WHERE i.deleted_at IS NULL
     AND i.created_by IS NOT NULL
     AND (v_all
          OR coalesce(ca.can_read
                      AND (i.restricted_role IS NULL OR ca.case_role = i.restricted_role
                           OR ca.case_role IN ('admin', 'super_admin')), false))
     AND NOT EXISTS (SELECT 1 FROM marked mk WHERE mk.contact_id = i.contact_id)
   ORDER BY i.case_id, i.created_at, i.item_id;
END;
$$;

COMMENT ON FUNCTION public.brain_digest_messages(uuid, uuid, timestamptz) IS
  'Per case, the visible chunks of its newest staff message source, that source newer than p_since, contact unmarked; at most 1000 cases. Migration 196.';

REVOKE ALL ON FUNCTION public.brain_digest_messages(uuid, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.brain_digest_messages(uuid, uuid, timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.brain_contacts_marked(p_account uuid, p_contacts uuid[])
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT DISTINCT k.id
    FROM unnest(coalesce(p_contacts, '{}'::uuid[])) AS k(id)
   WHERE k.id IS NOT NULL
     AND (EXISTS (SELECT 1 FROM public.brain_contact_marks m
                   WHERE m.account_id = p_account AND m.contact_id = k.id)
          OR EXISTS (SELECT 1 FROM public.contacts c
                      WHERE c.id = k.id AND c.account_id = p_account
                        AND (c.opted_out_at IS NOT NULL OR c.do_not_contact_at IS NOT NULL)))
$$;

COMMENT ON FUNCTION public.brain_contacts_marked(uuid, uuid[]) IS
  'The given contacts that are marked for the second brain (a brain_contact_marks row, opted out, or do-not-contact), in one call. Migration 196.';

REVOKE ALL ON FUNCTION public.brain_contacts_marked(uuid, uuid[])
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.brain_contacts_marked(uuid, uuid[]) TO service_role;

CREATE OR REPLACE FUNCTION public.brain_digest_related(p_account uuid, p_actor uuid, p_contacts uuid[],
  p_banks text[], p_per integer)
RETURNS TABLE (case_id uuid, contact_id uuid, bank_code text, outcome text, closed_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
SET plan_cache_mode = force_custom_plan
AS $$
#variable_conflict use_column
DECLARE
  v_role text := public.brain_actor_role(p_account, p_actor);
  v_all boolean := v_role IN ('admin', 'super_admin');
  v_per integer := least(greatest(coalesce(p_per, 2), 1), 20);
BEGIN
  IF v_role IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  WITH marked AS MATERIALIZED (
    SELECT m.contact_id FROM public.brain_contact_marks m WHERE m.account_id = p_account
    UNION
    SELECT ct.id FROM public.contacts ct
     WHERE ct.account_id = p_account AND (ct.opted_out_at IS NOT NULL OR ct.do_not_contact_at IS NOT NULL)
  ),
  keys AS (
    SELECT DISTINCT 'contact'::text AS kind, k.id AS contact_key, NULL::text AS bank_key
      FROM unnest(coalesce(p_contacts, '{}'::uuid[])) AS k(id) WHERE k.id IS NOT NULL
    UNION
    SELECT DISTINCT 'bank'::text, NULL::uuid, b.code
      FROM unnest(coalesce(p_banks, '{}'::text[])) AS b(code) WHERE b.code IS NOT NULL
  ),
  -- Per key, newest first, the readability test ABOVE the sort (OFFSET 0
  -- keeps the subquery from being flattened), so the LIMIT stops reading
  -- once p_per readable cases are found: case_role runs on as few cases
  -- as the answer needs, not on every closed case of a busy bank.
  hits AS (
    SELECT h.*
      FROM keys k
     CROSS JOIN LATERAL (
       SELECT s.id, s.contact_id, s.bank_code, s.outcome, s.closed_at
         FROM (SELECT c.id, c.contact_id, c.bank_code, c.outcome, c.closed_at
                 FROM public.cases c
                WHERE c.account_id = p_account
                  AND c.closed_at IS NOT NULL
                  AND c.outcome IS NOT NULL
                  AND (CASE WHEN k.kind = 'contact' THEN c.contact_id = k.contact_key
                            ELSE c.bank_code = k.bank_key END)
                  AND NOT EXISTS (SELECT 1 FROM marked mk WHERE mk.contact_id = c.contact_id)
                ORDER BY c.closed_at DESC, c.id
               OFFSET 0) s
        WHERE v_all OR coalesce(public.case_rule_can_read(public.case_role(s.id, p_actor)), false)
        LIMIT v_per
     ) h
  )
  SELECT DISTINCT ON (h.id) h.id, h.contact_id, h.bank_code, h.outcome, h.closed_at
    FROM hits h
   ORDER BY h.id;
END;
$$;

COMMENT ON FUNCTION public.brain_digest_related(uuid, uuid, uuid[], text[], integer) IS
  'Closed cases with an outcome sharing a given contact or bank, readable by the actor, contact unmarked; at most p_per newest per contact and per bank, readability applied before the limit. Migration 196.';

REVOKE ALL ON FUNCTION public.brain_digest_related(uuid, uuid, uuid[], text[], integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.brain_digest_related(uuid, uuid, uuid[], text[], integer) TO service_role;
