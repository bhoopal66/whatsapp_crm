-- ============================================================
-- Migration 194: SECOND BRAIN, a role-filtered searchable store of
-- redacted staff knowledge.
-- ============================================================
--
-- Ported from the wacrm module package's migrations 022a (core) and
-- 022b (one grant), adapted to this repo's schema:
--  * workspace_id text -> account_id uuid (accounts); actor text -> an
--    auth user id (profiles.user_id). The package's trusted jobs
--    'system:retention' / 'system:erasure' are p_actor NULL plus
--    p_system_label, accepted only for those two labels.
--  * created_by text -> created_by uuid + system_label text.
--  * case_id references cases (id, account_id); contact_id is a uuid
--    with no foreign key (a forgotten row keeps it); bank_id ->
--    bank_code.
--  * case_actor_role -> brain_actor_role (below). There is no 'it' role
--    here, so every 'it' branch is gone.
--
-- ITEMS (brain_items): one row per stored chunk (<= 800 chars) of an
--   already-redacted text. brain_item_upsert refuses text still holding
--   a run of 9+ digits (TEXT_UNREDACTED). Idempotent on (account,
--   source_kind, source_id, text_sha256); the sha256 is computed here,
--   never taken from the caller. A forgotten row stays forgotten:
--   re-ingesting the same chunk returns NULL and stores nothing. Nothing
--   is stored while case_account_settings.brain_enabled is off (or the
--   account has no settings row): the upsert returns NULL.
-- EMBEDDINGS (brain_embeddings): one real[] per item and model. No
--   pgvector: cosine similarity is computed in SQL over the role-visible
--   candidates.
-- CONTACT MARKS (brain_contact_marks): opt_out / deletion. A contact is
--   marked by a row there or by contacts.opted_out_at /
--   do_not_contact_at. A marked contact's items are never returned and
--   new ones are not stored (upsert returns NULL).
-- FORGET (brain_item_forget): one item, a contact, or everything older
--   than a date; blanks the text, stamps deleted_at, deletes the
--   embeddings. An admin / owner of the account, or the system jobs.
--   Deleting a contact does the same for its items (contacts_forget_brain).
-- VISIBILITY (brain_item_visible): a case item when case_can_read; a
--   case-less item for admins / owners or its creator. restricted_role
--   narrows to that role plus admin / super_admin.
-- AUDIT (brain_audit): account, actor, query sha256, result count; the
--   query text is never stored.
-- PRIVILEGES: RLS forced, no policies, every table privilege revoked
--   from public / anon / authenticated / service_role. Everything goes
--   through SECURITY DEFINER functions, executable by service_role only.
--
-- Refusals (hint): SCOPE_INVALID, KIND_INVALID, TEXT_INVALID,
--   TEXT_UNREDACTED, CASE_NOT_FOUND, ITEM_NOT_FOUND, VEC_INVALID,
--   NOT_ALLOWED, HASH_INVALID.
--
-- Re-runnable: every statement is guarded.
-- ============================================================

-- ---------- 1. The switch ----------

ALTER TABLE public.case_account_settings
  ADD COLUMN IF NOT EXISTS brain_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.case_account_settings.brain_enabled IS
  'Second brain on for this account: brain_item_upsert stores nothing while off. Written only through case_settings_set_brain. Migration 194.';

-- ---------- 2. Tables ----------

CREATE TABLE IF NOT EXISTS public.brain_items (
  item_id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  source_kind     text        NOT NULL CHECK (source_kind IN ('message', 'note', 'timeline', 'pinned', 'discussion', 'remember', 'page')),
  source_id       text        NOT NULL CHECK (source_id !~ '^[[:space:]]*$' AND length(source_id) <= 200),
  case_id         uuid        NULL,
  contact_id      uuid        NULL,
  bank_code       text        NULL,
  text            text        NOT NULL CHECK (length(text) <= 800),
  text_sha256     text        NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  ai_generated    boolean     NOT NULL DEFAULT false,
  created_by      uuid        NULL,
  system_label    text        NULL CHECK (system_label IS NULL OR system_label ~ '^system:[a-z_]+$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz NULL,
  restricted_role text        NULL CHECK (restricted_role IS NULL OR restricted_role IN ('agent', 'coordinator', 'team_lead', 'admin', 'super_admin')),
  CONSTRAINT brain_items_case_fkey FOREIGN KEY (case_id, account_id) REFERENCES public.cases (id, account_id),
  CONSTRAINT brain_items_source_key UNIQUE (account_id, source_kind, source_id, text_sha256),
  CONSTRAINT brain_items_forgotten_wiped CHECK (deleted_at IS NULL AND text <> '' OR deleted_at IS NOT NULL AND text = '')
);
CREATE INDEX IF NOT EXISTS brain_items_account_idx ON public.brain_items (account_id, case_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS brain_items_contact_idx ON public.brain_items (account_id, contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS brain_items_tsv_idx ON public.brain_items USING gin (to_tsvector('simple', text));

COMMENT ON TABLE public.brain_items IS
  'Second brain: one redacted chunk (<= 800 chars) of staff knowledge per row, idempotent on (account, source, sha256). Forgotten rows keep only their keys. Written only through the brain_* functions. Migration 194.';

CREATE TABLE IF NOT EXISTS public.brain_embeddings (
  item_id uuid    NOT NULL REFERENCES public.brain_items (item_id) ON DELETE CASCADE,
  model   text    NOT NULL CHECK (model !~ '^[[:space:]]*$' AND length(model) <= 100),
  dim     integer NOT NULL CHECK (dim BETWEEN 1 AND 4096),
  vec     real[]  NOT NULL CHECK (cardinality(vec) = dim AND array_ndims(vec) = 1),
  CONSTRAINT brain_embeddings_one UNIQUE (item_id, model)
);

COMMENT ON TABLE public.brain_embeddings IS
  'Second brain: one embedding per item and model (real[], cosine computed in SQL). Migration 194.';

CREATE TABLE IF NOT EXISTS public.brain_contact_marks (
  account_id uuid        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id uuid        NOT NULL,
  kind       text        NOT NULL CHECK (kind IN ('opt_out', 'deletion')),
  marked_by  uuid        NULL,
  marked_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brain_contact_marks_pkey PRIMARY KEY (account_id, contact_id, kind)
);

COMMENT ON TABLE public.brain_contact_marks IS
  'Second brain: contacts whose items are never returned or stored (opt_out / deletion). marked_by NULL = a system job. Migration 194.';

CREATE TABLE IF NOT EXISTS public.brain_audit (
  audit_id     bigserial   PRIMARY KEY,
  account_id   uuid        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  actor        uuid        NULL,
  query_sha256 text        NOT NULL CHECK (query_sha256 ~ '^[0-9a-f]{64}$'),
  result_count integer     NOT NULL CHECK (result_count >= 0),
  at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.brain_audit IS
  'Second brain: one row per search (account, actor, query sha256, result count); the query text is never stored. Migration 194.';

ALTER TABLE public.brain_items         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brain_embeddings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brain_contact_marks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brain_audit         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brain_items         FORCE ROW LEVEL SECURITY;
ALTER TABLE public.brain_embeddings    FORCE ROW LEVEL SECURITY;
ALTER TABLE public.brain_contact_marks FORCE ROW LEVEL SECURITY;
ALTER TABLE public.brain_audit         FORCE ROW LEVEL SECURITY;

-- ---------- 3. Predicates ----------

-- The person's brain role in an account: their live, non-guest profile
-- there (one row per user and account, read by both).
CREATE OR REPLACE FUNCTION public.brain_actor_role(p_account uuid, p_user uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
           WHEN p.account_role = 'owner' THEN 'super_admin'
           WHEN p.account_role = 'admin' THEN 'admin'
           WHEN p.account_role = 'team_leader' THEN 'team_lead'
           WHEN p.account_role = 'agent'
                AND EXISTS (SELECT 1 FROM public.coordinator_banks b
                             WHERE b.account_id = p_account AND b.user_id = p_user) THEN 'coordinator'
           WHEN p.account_role = 'agent' THEN 'agent'
         END
    FROM public.profiles p
   WHERE p_user IS NOT NULL
     AND p.user_id = p_user AND p.account_id = p_account
     AND p.deactivated_at IS NULL AND p.account_role <> 'bank_guest'
$$;

COMMENT ON FUNCTION public.brain_actor_role(uuid, uuid) IS
  'Second brain role of a live staff member in an account: super_admin (owner), admin, team_lead, coordinator (agent with coordinator_banks), agent; NULL for a viewer, guest, deactivated or unknown person. Migration 194.';

CREATE OR REPLACE FUNCTION public.brain_contact_marked(p_account uuid, p_contact uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_contact IS NOT NULL
     AND (EXISTS (SELECT 1 FROM public.brain_contact_marks m
                   WHERE m.account_id = p_account AND m.contact_id = p_contact)
          OR EXISTS (SELECT 1 FROM public.contacts c
                      WHERE c.id = p_contact AND c.account_id = p_account
                        AND (c.opted_out_at IS NOT NULL OR c.do_not_contact_at IS NOT NULL)))
$$;

COMMENT ON FUNCTION public.brain_contact_marked(uuid, uuid) IS
  'Is this contact marked for the second brain (a brain_contact_marks row, opted out, or do-not-contact)? Migration 194.';

CREATE OR REPLACE FUNCTION public.brain_item_visible(p_account uuid, p_case uuid, p_created_by uuid,
  p_restricted_role text, p_user uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
BEGIN
  IF p_user IS NULL THEN
    RETURN false;
  END IF;
  IF p_case IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.cases c WHERE c.id = p_case AND c.account_id = p_account)
       OR NOT coalesce(public.case_can_read(p_case, p_user), false) THEN
      RETURN false;
    END IF;
    IF p_restricted_role IS NULL THEN
      RETURN true;
    END IF;
    v_role := public.case_role(p_case, p_user);
    RETURN coalesce(v_role = p_restricted_role OR v_role IN ('admin', 'super_admin'), false);
  END IF;
  v_role := public.brain_actor_role(p_account, p_user);
  RETURN v_role IS NOT NULL
     AND (p_restricted_role IS NULL OR v_role = p_restricted_role OR v_role IN ('admin', 'super_admin'))
     AND (v_role IN ('admin', 'super_admin') OR p_created_by IS NOT DISTINCT FROM p_user);
END
$$;

COMMENT ON FUNCTION public.brain_item_visible(uuid, uuid, uuid, text, uuid) IS
  'Second brain read rule: a case item when case_can_read (restricted_role narrows to that case role plus admin / super_admin); a case-less item for admins / owners or its creator. Migration 194.';

-- ---------- 4. Writes ----------

CREATE OR REPLACE FUNCTION public.brain_item_upsert(p_account uuid, p_source_kind text, p_source_id text,
  p_case uuid, p_contact uuid, p_bank_code text, p_text text, p_ai_generated boolean, p_restricted_role text,
  p_created_by uuid, p_system_label text)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_sha     text;
  v_id      uuid;
  v_deleted timestamptz;
  v_contact uuid := p_contact;
BEGIN
  IF p_account IS NULL OR p_source_id IS NULL OR p_source_id ~ '^[[:space:]]*$'
     OR (p_system_label IS NOT NULL AND p_system_label !~ '^system:[a-z_]+$') THEN
    RAISE EXCEPTION 'brain_item_upsert: account and source id are required'
      USING ERRCODE = 'invalid_parameter_value', HINT = 'SCOPE_INVALID';
  END IF;
  IF p_source_kind IS NULL OR p_source_kind NOT IN ('message', 'note', 'timeline', 'pinned', 'discussion', 'remember', 'page') THEN
    RAISE EXCEPTION 'brain_item_upsert: unknown source kind'
      USING ERRCODE = 'invalid_parameter_value', HINT = 'KIND_INVALID';
  END IF;
  IF p_text IS NULL OR p_text ~ '^[[:space:]]*$' OR length(p_text) > 800 THEN
    RAISE EXCEPTION 'brain_item_upsert: text must be 1..800 chars'
      USING ERRCODE = 'invalid_parameter_value', HINT = 'TEXT_INVALID';
  END IF;
  -- Nine or more digits (ASCII, Arabic-Indic, extended Arabic-Indic,
  -- full-width), up to two of - . / ( ) or whitespace between each: an
  -- explicit class, since [[:digit:]] beyond ASCII depends on the ctype.
  -- lib/brain/redact.ts masks a superset of this before ingest.
  IF p_text ~ '[0-9٠-٩۰-۹０-９]([-./()[:space:]]{0,2}[0-9٠-٩۰-۹０-９]){8,}' THEN
    RAISE EXCEPTION 'brain_item_upsert: text holds an unredacted number'
      USING ERRCODE = 'invalid_parameter_value', HINT = 'TEXT_UNREDACTED';
  END IF;
  IF p_case IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.cases c WHERE c.id = p_case AND c.account_id = p_account) THEN
    RAISE EXCEPTION 'brain_item_upsert: case % not found in account', p_case
      USING ERRCODE = 'no_data_found', HINT = 'CASE_NOT_FOUND';
  END IF;
  IF NOT coalesce((SELECT s.brain_enabled FROM public.case_account_settings s WHERE s.account_id = p_account), false) THEN
    RETURN NULL;   -- the switch is off: nothing is stored
  END IF;
  -- An item about a case is about the case's customer: callers that pass
  -- only the case (bank threads and posts, remember) get the contact from
  -- the case (130's cases.contact_id, else its submission group's), so the
  -- mark check, search's mark filter and a contact-scope forget all see
  -- it. A contact the caller names is kept as given.
  IF v_contact IS NULL AND p_case IS NOT NULL THEN
    SELECT coalesce(c.contact_id, g.contact_id) INTO v_contact
      FROM public.cases c
      LEFT JOIN public.submission_groups g ON g.id = c.group_id AND g.account_id = c.account_id
     WHERE c.id = p_case AND c.account_id = p_account;
  END IF;
  -- Lock the contact before the mark check: brain_contact_mark takes FOR
  -- UPDATE on it, and an opt-out or delete conflicts with FOR SHARE, so a
  -- chunk is never stored after its contact was marked or deleted.
  IF v_contact IS NOT NULL THEN
    PERFORM 1 FROM public.contacts c WHERE c.id = v_contact AND c.account_id = p_account FOR SHARE;
    IF NOT FOUND THEN
      RETURN NULL;   -- no such contact in the account (deleted): nothing is stored
    END IF;
  END IF;
  IF public.brain_contact_marked(p_account, v_contact) THEN
    RETURN NULL;   -- opted-out / deletion-marked contact: nothing is stored
  END IF;
  v_sha := encode(sha256(convert_to(p_text, 'UTF8')), 'hex');
  INSERT INTO public.brain_items (account_id, source_kind, source_id, case_id, contact_id, bank_code, text,
                                  text_sha256, ai_generated, restricted_role, created_by, system_label)
  VALUES (p_account, p_source_kind, p_source_id, p_case, v_contact, p_bank_code, p_text,
          v_sha, coalesce(p_ai_generated, false), p_restricted_role, p_created_by, p_system_label)
  ON CONFLICT ON CONSTRAINT brain_items_source_key DO NOTHING
  RETURNING item_id INTO v_id;
  IF v_id IS NULL THEN
    SELECT i.item_id, i.deleted_at INTO v_id, v_deleted FROM public.brain_items i
     WHERE i.account_id = p_account AND i.source_kind = p_source_kind
       AND i.source_id = p_source_id AND i.text_sha256 = v_sha;
    IF v_deleted IS NOT NULL THEN
      RETURN NULL;   -- forgotten stays forgotten
    END IF;
  END IF;
  RETURN v_id;
END
$$;

COMMENT ON FUNCTION public.brain_item_upsert(uuid, text, text, uuid, uuid, text, text, boolean, text, uuid, text) IS
  'Stores one redacted chunk, idempotent on its sha256 (computed here). NULL while the switch is off, for a marked contact or one not in the account, or for a forgotten chunk. Migration 194.';

CREATE OR REPLACE FUNCTION public.brain_embedding_put(p_account uuid, p_item uuid, p_model text, p_vec real[])
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_vec IS NULL OR array_ndims(p_vec) IS DISTINCT FROM 1 OR cardinality(p_vec) NOT BETWEEN 1 AND 4096
     OR p_model IS NULL OR p_model ~ '^[[:space:]]*$' OR array_position(p_vec, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'brain_embedding_put: a 1..4096 dim vector and a model are required'
      USING ERRCODE = 'invalid_parameter_value', HINT = 'VEC_INVALID';
  END IF;
  -- FOR SHARE, not a plain EXISTS: it waits for a concurrent forget's UPDATE
  -- and re-checks deleted_at after it, so no embedding outlives a forget.
  PERFORM 1 FROM public.brain_items i
   WHERE i.item_id = p_item AND i.account_id = p_account AND i.deleted_at IS NULL
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'brain_embedding_put: item % not found', p_item
      USING ERRCODE = 'no_data_found', HINT = 'ITEM_NOT_FOUND';
  END IF;
  INSERT INTO public.brain_embeddings (item_id, model, dim, vec)
  VALUES (p_item, p_model, cardinality(p_vec), p_vec)
  ON CONFLICT ON CONSTRAINT brain_embeddings_one DO UPDATE SET dim = EXCLUDED.dim, vec = EXCLUDED.vec;
END
$$;

COMMENT ON FUNCTION public.brain_embedding_put(uuid, uuid, text, real[]) IS
  'Stores (or replaces) one live item''s embedding for a model. Migration 194.';

-- Records an opt-out or a deletion mark (only narrows what is returned).
-- p_actor NULL = a system job.
CREATE OR REPLACE FUNCTION public.brain_contact_mark(p_actor uuid, p_account uuid, p_contact uuid, p_kind text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_account IS NULL OR p_contact IS NULL THEN
    RAISE EXCEPTION 'brain_contact_mark: account and contact are required'
      USING ERRCODE = 'invalid_parameter_value', HINT = 'SCOPE_INVALID';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('opt_out', 'deletion') THEN
    RAISE EXCEPTION 'brain_contact_mark: kind is opt_out or deletion'
      USING ERRCODE = 'invalid_parameter_value', HINT = 'KIND_INVALID';
  END IF;
  IF p_actor IS NOT NULL AND public.brain_actor_role(p_account, p_actor) IS NULL THEN
    RAISE EXCEPTION 'brain_contact_mark: % may not mark contacts of %', p_actor, p_account
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  -- Serialise with an in-flight brain_item_upsert, which holds FOR SHARE on
  -- the contact until it commits (a contact already deleted locks nothing).
  PERFORM 1 FROM public.contacts c WHERE c.id = p_contact AND c.account_id = p_account FOR UPDATE;
  INSERT INTO public.brain_contact_marks (account_id, contact_id, kind, marked_by)
  VALUES (p_account, p_contact, p_kind, p_actor)
  ON CONFLICT ON CONSTRAINT brain_contact_marks_pkey DO NOTHING;
END
$$;

COMMENT ON FUNCTION public.brain_contact_mark(uuid, uuid, uuid, text) IS
  'Marks a contact opt_out / deletion for the second brain: staff of the account, or a system job (actor NULL). Migration 194.';

-- Exactly one scope: one item, every item of a contact, or every item
-- created before p_older_than (retention).
CREATE OR REPLACE FUNCTION public.brain_item_forget(p_actor uuid, p_system_label text, p_account uuid,
  p_item uuid, p_contact uuid, p_older_than timestamptz, p_reason text)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ids uuid[];
BEGIN
  IF p_reason IS NULL OR p_reason ~ '^[[:space:]]*$' THEN
    RAISE EXCEPTION 'brain_item_forget: a reason is required'
      USING ERRCODE = 'invalid_parameter_value', HINT = 'SCOPE_INVALID';
  END IF;
  IF NOT ((p_actor IS NULL AND coalesce(p_system_label, '') IN ('system:retention', 'system:erasure'))
          OR coalesce(public.brain_actor_role(p_account, p_actor), '') IN ('admin', 'super_admin')) THEN
    RAISE EXCEPTION 'brain_item_forget: % may not forget', coalesce(p_actor::text, p_system_label)
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  IF (p_item IS NOT NULL)::int + (p_contact IS NOT NULL)::int + (p_older_than IS NOT NULL)::int <> 1 THEN
    RAISE EXCEPTION 'brain_item_forget: exactly one of item, contact, older_than'
      USING ERRCODE = 'invalid_parameter_value', HINT = 'SCOPE_INVALID';
  END IF;
  SELECT coalesce(array_agg(i.item_id), '{}') INTO v_ids FROM public.brain_items i
   WHERE i.account_id = p_account
     AND i.deleted_at IS NULL
     AND (p_item IS NULL OR i.item_id = p_item)
     AND (p_contact IS NULL OR i.contact_id = p_contact)
     AND (p_older_than IS NULL OR i.created_at < p_older_than);
  DELETE FROM public.brain_embeddings e WHERE e.item_id = ANY (v_ids);
  UPDATE public.brain_items i SET text = '', deleted_at = now() WHERE i.item_id = ANY (v_ids);
  -- Migration 195's pages: wipe every page built from a forgotten item
  -- (scope contact also tombstones the contact's page). This is the only
  -- definition, so re-running 194 after 195 keeps the wipe.
  IF to_regprocedure('public.brain_page_wipe(uuid,uuid[],uuid)') IS NOT NULL THEN
    PERFORM public.brain_page_wipe(p_account, v_ids, p_contact);
  END IF;
  RETURN cardinality(v_ids);
END
$$;

COMMENT ON FUNCTION public.brain_item_forget(uuid, text, uuid, uuid, uuid, timestamptz, text) IS
  'Forgets one item, a contact''s items, or items older than a date: blank text, deleted_at, embeddings deleted, and (once migration 195 is applied) pages built from them wiped, scope contact also tombstoning the contact''s page. Admins / owners, or system:retention / system:erasure with actor NULL. Migrations 194, 195.';

CREATE OR REPLACE FUNCTION public.brain_audit_record(p_account uuid, p_actor uuid, p_query_sha256 text,
  p_result_count integer)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_query_sha256 IS NULL OR p_query_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'brain_audit_record: a sha256 hex digest is required'
      USING ERRCODE = 'invalid_parameter_value', HINT = 'HASH_INVALID';
  END IF;
  INSERT INTO public.brain_audit (account_id, actor, query_sha256, result_count)
  VALUES (p_account, p_actor, p_query_sha256, greatest(coalesce(p_result_count, 0), 0));
END
$$;

COMMENT ON FUNCTION public.brain_audit_record(uuid, uuid, text, integer) IS
  'Records one second brain search by its query sha256 and result count. Migration 194.';

-- A deleted contact's items go with it, exactly as brain_item_forget's
-- contact scope. Once migration 195's pages exist, its page is also
-- tombstoned and every page built from its items (forgotten ones too)
-- wiped. A contact the brain never saw (no item, no page) writes
-- nothing. The only definition: re-running 194 after 195 keeps the wipe.
CREATE OR REPLACE FUNCTION public.brain_forget_deleted_contact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_live  uuid[];
  v_all   uuid[];
  v_pages boolean := to_regprocedure('public.brain_page_wipe(uuid,uuid[],uuid)') IS NOT NULL;
BEGIN
  SELECT coalesce(array_agg(i.item_id) FILTER (WHERE i.deleted_at IS NULL), '{}'),
         coalesce(array_agg(i.item_id), '{}')
    INTO v_live, v_all
    FROM public.brain_items i
   WHERE i.account_id = old.account_id AND i.contact_id = old.id;
  IF NOT v_pages THEN
    IF cardinality(v_live) = 0 THEN
      RETURN old;
    END IF;
  ELSIF cardinality(v_all) = 0
     AND NOT EXISTS (SELECT 1 FROM public.brain_pages p
                      WHERE p.account_id = old.account_id AND p.kind = 'contact' AND p.key = old.id::text) THEN
    RETURN old;
  END IF;
  IF cardinality(v_live) > 0 THEN
    DELETE FROM public.brain_embeddings e WHERE e.item_id = ANY (v_live);
    UPDATE public.brain_items i SET text = '', deleted_at = now() WHERE i.item_id = ANY (v_live);
  END IF;
  IF v_pages THEN
    PERFORM public.brain_page_wipe(old.account_id, v_all, old.id);
  END IF;
  RETURN old;
END
$$;

DROP TRIGGER IF EXISTS contacts_forget_brain ON public.contacts;
CREATE TRIGGER contacts_forget_brain
  AFTER DELETE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.brain_forget_deleted_contact();

COMMENT ON FUNCTION public.brain_forget_deleted_contact() IS
  'contacts AFTER DELETE: forgets the deleted contact''s second brain items (blank text, deleted_at, embeddings deleted) and, once migration 195 is applied, tombstones its page and wipes pages built from its items. Migrations 194, 195.';

-- ---------- 5. Search candidates ----------

-- The role-visible, unmarked, live items of the account (optionally of
-- one case / contact / bank), scored by cosine similarity of their
-- p_model embedding to p_qvec and by keyword rank (ts_rank, normalised
-- to [0,1)). Returns the union of the top p_limit by cosine and the top
-- p_limit by keyword rank (rank > 0); the caller blends them.
CREATE OR REPLACE FUNCTION public.brain_search_candidates(p_actor uuid, p_account uuid, p_query text,
  p_qvec real[], p_model text, p_case uuid, p_contact uuid, p_bank_code text, p_limit integer)
RETURNS TABLE (item_id uuid, source_kind text, source_id text, case_id uuid, contact_id uuid, bank_code text,
               text text, ai_generated boolean, created_at timestamptz, cosine double precision,
               kw_rank double precision)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
-- A generic plan guesses one candidate row and nested-loops every item
-- against every case (5 s on 20k items); planned with the real account
-- and filters it hashes.
SET plan_cache_mode = force_custom_plan
AS $$
#variable_conflict use_column
DECLARE
  -- Set-based on purpose: brain_item_visible / brain_contact_marked per
  -- item meant a case_role lookup and two EXISTS for every live item of
  -- the account. Same rule, worked out once per actor and once per case.
  -- An owner / admin reads every case of the account (case_role gives
  -- them super_admin / admin there, 161; the composite FK keeps a case
  -- item's case in the item's account).
  v_role text := public.brain_actor_role(p_account, p_actor);
  v_all boolean := v_role IN ('admin', 'super_admin');
BEGIN
  IF v_role IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  WITH a AS (SELECT v_role AS role),
  q AS (SELECT CASE WHEN p_query IS NULL OR p_query ~ '^[[:space:]]*$' THEN NULL::tsquery
                    ELSE websearch_to_tsquery('simple', p_query) END AS tsq),
  cand AS MATERIALIZED (
    SELECT i.* FROM public.brain_items i
     WHERE i.account_id = p_account
       AND i.deleted_at IS NULL
       AND (p_case IS NULL OR i.case_id = p_case)
       AND (p_contact IS NULL OR i.contact_id = p_contact)
       AND (p_bank_code IS NULL OR i.bank_code = p_bank_code)
  ),
  -- case_can_read is case_rule_can_read(case_role(...)) (122): one
  -- case_role call per case serves both.
  case_access AS MATERIALIZED (
    SELECT r.case_id, coalesce(public.case_rule_can_read(r.case_role), false) AS can_read, r.case_role
      FROM (SELECT d.case_id, public.case_role(d.case_id, p_actor) AS case_role
              FROM (SELECT DISTINCT c.case_id FROM cand c WHERE c.case_id IS NOT NULL) d
             WHERE NOT v_all
            OFFSET 0) r
  ),
  marked AS MATERIALIZED (
    SELECT m.contact_id FROM public.brain_contact_marks m WHERE m.account_id = p_account
    UNION
    SELECT ct.id FROM public.contacts ct
     WHERE ct.account_id = p_account AND (ct.opted_out_at IS NOT NULL OR ct.do_not_contact_at IS NOT NULL)
  ),
  visible AS (
    SELECT c.* FROM cand c CROSS JOIN a
      LEFT JOIN case_access ca ON ca.case_id = c.case_id
     WHERE (CASE
              WHEN v_all THEN true
              WHEN c.case_id IS NOT NULL THEN
                coalesce(ca.can_read
                         AND (c.restricted_role IS NULL OR ca.case_role = c.restricted_role
                              OR ca.case_role IN ('admin', 'super_admin')), false)
              ELSE c.created_by = p_actor
                   AND (c.restricted_role IS NULL OR c.restricted_role = a.role)
            END)
       AND NOT EXISTS (SELECT 1 FROM marked mk WHERE mk.contact_id = c.contact_id)
  ),
  scored AS (
    SELECT v.*,
           coalesce((SELECT sum(x * y) / nullif(sqrt(sum(x * x)) * sqrt(sum(y * y)), 0)
                       FROM unnest(e.vec, p_qvec) AS t(x, y)), 0)::double precision AS cos,
           coalesce(CASE WHEN q.tsq IS NULL THEN 0 ELSE ts_rank(to_tsvector('simple', v.text), q.tsq, 32) END, 0)::double precision AS kw
      FROM visible v CROSS JOIN q
      LEFT JOIN public.brain_embeddings e
        ON e.item_id = v.item_id AND e.model = p_model AND e.dim = cardinality(p_qvec)
  ),
  ranked AS (
    SELECT s.*, row_number() OVER (ORDER BY s.cos DESC, s.created_at DESC, s.item_id) AS rc,
                row_number() OVER (ORDER BY s.kw DESC, s.created_at DESC, s.item_id) AS rk
      FROM scored s
  )
  SELECT r.item_id, r.source_kind, r.source_id, r.case_id, r.contact_id, r.bank_code, r.text, r.ai_generated,
         r.created_at, r.cos, r.kw
    FROM ranked r
   WHERE r.rc <= greatest(coalesce(p_limit, 50), 1) OR (r.rk <= greatest(coalesce(p_limit, 50), 1) AND r.kw > 0)
   ORDER BY greatest(r.cos, r.kw) DESC, r.created_at DESC, r.item_id;
END;
$$;

COMMENT ON FUNCTION public.brain_search_candidates(uuid, uuid, text, real[], text, uuid, uuid, text, integer) IS
  'Second brain search: the actor''s visible, unmarked, live items, top p_limit by cosine plus top p_limit by keyword rank. Migration 194.';

-- ---------- 6. The switch's writer ----------

CREATE OR REPLACE FUNCTION public.case_settings_set_brain(p_actor uuid, p_account uuid, p_enabled boolean)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
BEGIN
  v_role := public.case_account_role(p_account, p_actor);
  IF v_role IS NULL OR v_role NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'NOT_ALLOWED: % may not change the case settings of %', p_actor, p_account
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  INSERT INTO public.case_account_settings AS s (account_id, brain_enabled, updated_at, updated_by)
  VALUES (p_account, coalesce(p_enabled, false), now(), p_actor)
  ON CONFLICT (account_id) DO UPDATE
    SET brain_enabled = EXCLUDED.brain_enabled,
        updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;
  RETURN coalesce(p_enabled, false);
END;
$$;

COMMENT ON FUNCTION public.case_settings_set_brain(uuid, uuid, boolean) IS
  'Turns the second brain on or off for an account (owner / admin). Migration 194.';

-- ---------- 7. Privileges ----------

REVOKE ALL ON public.brain_items, public.brain_embeddings, public.brain_contact_marks, public.brain_audit
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.brain_audit_audit_id_seq FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION
  public.brain_actor_role(uuid, uuid),
  public.brain_contact_marked(uuid, uuid),
  public.brain_item_visible(uuid, uuid, uuid, text, uuid),
  public.brain_item_upsert(uuid, text, text, uuid, uuid, text, text, boolean, text, uuid, text),
  public.brain_embedding_put(uuid, uuid, text, real[]),
  public.brain_contact_mark(uuid, uuid, uuid, text),
  public.brain_item_forget(uuid, text, uuid, uuid, uuid, timestamptz, text),
  public.brain_audit_record(uuid, uuid, text, integer),
  public.brain_forget_deleted_contact(),
  public.brain_search_candidates(uuid, uuid, text, real[], text, uuid, uuid, text, integer),
  public.case_settings_set_brain(uuid, uuid, boolean)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.brain_contact_marked(uuid, uuid),
  public.brain_item_upsert(uuid, text, text, uuid, uuid, text, text, boolean, text, uuid, text),
  public.brain_embedding_put(uuid, uuid, text, real[]),
  public.brain_contact_mark(uuid, uuid, uuid, text),
  public.brain_item_forget(uuid, text, uuid, uuid, uuid, timestamptz, text),
  public.brain_audit_record(uuid, uuid, text, integer),
  public.brain_search_candidates(uuid, uuid, text, real[], text, uuid, uuid, text, integer),
  public.case_settings_set_brain(uuid, uuid, boolean)
  TO service_role;
