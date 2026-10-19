-- ============================================================
-- 129_crm_memory.sql — CRM memory: redacted items per case / contact /
-- workspace, the wacrm access rule, audit. Port of module 019b
-- (storage, privacy, access).
--
--  * memory_items: one remembered item per (account, scope, normalised
--    content). content is ALREADY REDACTED by the app
--    (src/lib/memory/redact.ts); content_hash = sha256 hex of the
--    normalised redacted text (the dedupe key, unique among LIVE items
--    of a scope). search = to_tsvector('simple', content with
--    Arabic-Indic digits folded to ASCII). Untrusted items carry
--    importance <= 2. Every item expires (default created_at + 24
--    months, never later). content / importance and every identity
--    column are immutable (memory_items_guard): a correction is a new
--    item that supersedes the old one (superseded_by: NULL -> id, once).
--    scope_id is a contacts id, a cases id (122), or for 'workspace' the
--    account id; memory_put checks it inside the account (SCOPE_INVALID).
--    created_by NULL = the system (a job, a future assistant).
--  * Rows are removed only inside memory_put (per-scope cap eviction,
--    expired dedupe match), memory_expire_due, memory_forget and the
--    contacts AFTER DELETE trigger (a deleted contact's memory goes
--    with it), each audited, each behind the transaction-local
--    wacrm.memory_erase flag; any other DELETE is refused.
--  * Who reads: memory_can_read(user, account, scope_type, scope_id),
--    the ONE predicate behind memory_recall_candidates,
--    memory_mark_recalled, memory_compact_candidates and memory_list.
--    A live staff profile in the account (active or not, not
--    deactivated, not bank_guest) is required; then owner / admin read
--    every scope; any such member reads ('workspace', account); a
--    contact scope follows 072's can_view_contact for an explicit user
--    (creator, own / assigned chat, a team leader's team); a case scope
--    follows 122's case_role. memory_acl rows (member | coordinator |
--    admin | super_admin) add scopes on top, kept for future service
--    users; admin / super_admin on ('workspace', account) reads it all.
--    The role always comes from the database: no function takes a
--    caller-supplied role.
--  * Writes are not access-checked in SQL (the app gates them); the
--    actor / created_by is recorded, not verified.
--  * memory_audit: append-only (UPDATE / DELETE / TRUNCATE refused,
--    owner included). Who wrote / recalled / evicted / expired / forgot
--    / granted what scope, with counts only: never content. actor NULL
--    = a scheduled job or a trigger.
--  * RLS forced on every table with no policy; anon / authenticated /
--    service_role hold no table privilege. service_role executes the
--    memory_* API functions only.
--
-- The SECURITY DEFINER functions read RLS-forced tables, so, as 121,
-- this must be applied by a superuser or BYPASSRLS role.
--
-- Re-runnable: CREATE … IF NOT EXISTS, CREATE OR REPLACE,
-- DROP … IF EXISTS.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '129 must be applied by a superuser or BYPASSRLS role (the memory_* functions read RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. Tables ----------

CREATE TABLE IF NOT EXISTS public.memory_items (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid        NOT NULL REFERENCES public.accounts(id),
  scope_type       text        NOT NULL CHECK (scope_type IN ('case', 'contact', 'workspace')),
  scope_id         uuid        NOT NULL,
  kind             text        NOT NULL CHECK (kind IN ('fact', 'preference', 'decision', 'document', 'summary')),
  content          text        NOT NULL CHECK (char_length(btrim(content)) BETWEEN 1 AND 4000),
  content_hash     text        NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  importance       smallint    NOT NULL CHECK (importance BETWEEN 1 AND 5),
  trust            text        NOT NULL DEFAULT 'untrusted' CHECK (trust IN ('untrusted', 'verified')),
  source_type      text        NOT NULL CHECK (source_type ~ '^[a-z][a-z_]{0,31}$'),
  source_id        text        CHECK (source_id IS NULL OR char_length(source_id) <= 200),
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_recalled_at timestamptz,
  recall_count     integer     NOT NULL DEFAULT 0 CHECK (recall_count >= 0),
  expires_at       timestamptz NOT NULL DEFAULT (now() + interval '24 months'),
  embedding        real[],
  embedding_model  text,
  search           tsvector    GENERATED ALWAYS AS (
                     to_tsvector('simple'::regconfig,
                       translate(content, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'))
                   ) STORED,
  -- No foreign key: an item stays superseded even after its successor is evicted / expired / forgotten.
  superseded_by    uuid,
  CONSTRAINT memory_items_untrusted_importance CHECK (trust = 'verified' OR importance <= 2),
  CONSTRAINT memory_items_ttl CHECK (expires_at > created_at AND expires_at <= created_at + interval '24 months'),
  CONSTRAINT memory_items_embedding_pair CHECK ((embedding IS NULL) = (embedding_model IS NULL))
);
CREATE INDEX IF NOT EXISTS memory_items_search_idx ON public.memory_items USING gin (search);
CREATE INDEX IF NOT EXISTS memory_items_scope_idx ON public.memory_items (account_id, scope_type, scope_id);
CREATE INDEX IF NOT EXISTS memory_items_expires_idx ON public.memory_items (expires_at);
-- Dedupe key: one NOT-superseded item per scope and content_hash (superseded rows may repeat a hash, so a
-- correction back to earlier content gets a fresh live item).
CREATE UNIQUE INDEX IF NOT EXISTS memory_items_live_dedupe
  ON public.memory_items (account_id, scope_type, scope_id, content_hash) WHERE superseded_by IS NULL;

CREATE TABLE IF NOT EXISTS public.memory_acl (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id   uuid        NOT NULL REFERENCES public.accounts(id),
  scope_type   text        NOT NULL CHECK (scope_type IN ('case', 'contact', 'workspace')),
  scope_id     uuid        NOT NULL,
  user_id      uuid        NOT NULL,
  role         text        NOT NULL CHECK (role IN ('member', 'coordinator', 'admin', 'super_admin')),
  granted_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at   timestamptz,
  CONSTRAINT memory_acl_revoke_after_grant CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_acl_active_uq
  ON public.memory_acl (account_id, scope_type, scope_id, user_id, role) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS memory_acl_user_idx ON public.memory_acl (account_id, user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.memory_audit (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  action       text        NOT NULL CHECK (action IN ('put', 'dedupe', 'supersede', 'recall', 'evict', 'expire',
                                                      'forget', 'acl_grant', 'acl_revoke', 'compact')),
  actor        uuid,
  account_id   uuid        NOT NULL REFERENCES public.accounts(id),
  scope_type   text,
  scope_id     uuid,
  item_count   integer     NOT NULL CHECK (item_count >= 0),
  reason       text        CHECK (reason IS NULL OR char_length(reason) <= 500),
  detail       jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS memory_audit_scope_idx ON public.memory_audit (account_id, scope_type, scope_id);

-- No policy: only the owner of the SECURITY DEFINER functions (a superuser / BYPASSRLS role) reaches the rows.
ALTER TABLE public.memory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_acl   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_items FORCE ROW LEVEL SECURITY;
ALTER TABLE public.memory_acl   FORCE ROW LEVEL SECURITY;
ALTER TABLE public.memory_audit FORCE ROW LEVEL SECURITY;

-- ---------- 2. Guards ----------

-- Items: inserted fresh; content / importance / identity immutable; only superseded_by (once) and the recall
-- counters move; DELETE only inside the erasure paths (transaction-local flag set and cleared by them).
CREATE OR REPLACE FUNCTION public.memory_items_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF tg_op = 'INSERT' THEN
    IF new.superseded_by IS NOT NULL OR new.recall_count <> 0 OR new.last_recalled_at IS NOT NULL THEN
      RAISE EXCEPTION 'public.memory_items: an item is inserted fresh (INSERT refused)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN new;
  ELSIF tg_op = 'UPDATE' THEN
    IF (new.content, new.importance) IS DISTINCT FROM (old.content, old.importance) THEN
      RAISE EXCEPTION 'public.memory_items: content and importance are immutable; supersede the item instead (UPDATE refused)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF (new.id, new.account_id, new.scope_type, new.scope_id, new.kind, new.content_hash, new.trust, new.source_type,
        new.source_id, new.created_by, new.created_at, new.expires_at, new.embedding, new.embedding_model)
       IS DISTINCT FROM
       (old.id, old.account_id, old.scope_type, old.scope_id, old.kind, old.content_hash, old.trust, old.source_type,
        old.source_id, old.created_by, old.created_at, old.expires_at, old.embedding, old.embedding_model) THEN
      RAISE EXCEPTION 'public.memory_items: the item identity is fixed (UPDATE refused)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF old.superseded_by IS NOT NULL AND new.superseded_by IS DISTINCT FROM old.superseded_by THEN
      RAISE EXCEPTION 'public.memory_items: superseded_by is set once (UPDATE refused)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF new.recall_count < old.recall_count THEN
      RAISE EXCEPTION 'public.memory_items: recall_count only grows (UPDATE refused)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN new;
  END IF;
  -- DELETE
  IF coalesce(current_setting('wacrm.memory_erase', true), '') <> 'on' THEN
    RAISE EXCEPTION 'public.memory_items: items are removed only by memory_forget / memory_expire_due / cap eviction / contact deletion (DELETE refused)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN old;
END
$$;

CREATE OR REPLACE FUNCTION public.memory_acl_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF tg_op = 'UPDATE' THEN
    IF old.revoked_at IS NULL AND new.revoked_at IS NOT NULL
       AND (new.id, new.account_id, new.scope_type, new.scope_id, new.user_id, new.role, new.granted_at)
           IS NOT DISTINCT FROM
           (old.id, old.account_id, old.scope_type, old.scope_id, old.user_id, old.role, old.granted_at) THEN
      RETURN new;
    END IF;
    RAISE EXCEPTION 'public.memory_acl: the only change is revoking an active row (UPDATE refused)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RAISE EXCEPTION 'public.memory_acl: rows are never removed (% refused)', tg_op
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE OR REPLACE FUNCTION public.memory_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'public.% is append-only (% refused)', tg_table_name, tg_op
    USING ERRCODE = 'insufficient_privilege';
END
$$;

DROP TRIGGER IF EXISTS memory_items_guard ON public.memory_items;
CREATE TRIGGER memory_items_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.memory_items
  FOR EACH ROW EXECUTE FUNCTION public.memory_items_guard();
DROP TRIGGER IF EXISTS memory_items_no_truncate ON public.memory_items;
CREATE TRIGGER memory_items_no_truncate
  BEFORE TRUNCATE ON public.memory_items
  FOR EACH STATEMENT EXECUTE FUNCTION public.memory_append_only();
DROP TRIGGER IF EXISTS memory_acl_guard ON public.memory_acl;
CREATE TRIGGER memory_acl_guard
  BEFORE UPDATE OR DELETE ON public.memory_acl
  FOR EACH ROW EXECUTE FUNCTION public.memory_acl_guard();
DROP TRIGGER IF EXISTS memory_acl_no_truncate ON public.memory_acl;
CREATE TRIGGER memory_acl_no_truncate
  BEFORE TRUNCATE ON public.memory_acl
  FOR EACH STATEMENT EXECUTE FUNCTION public.memory_append_only();
DROP TRIGGER IF EXISTS memory_audit_append_only ON public.memory_audit;
CREATE TRIGGER memory_audit_append_only
  BEFORE UPDATE OR DELETE ON public.memory_audit
  FOR EACH ROW EXECUTE FUNCTION public.memory_append_only();
DROP TRIGGER IF EXISTS memory_audit_no_truncate ON public.memory_audit;
CREATE TRIGGER memory_audit_no_truncate
  BEFORE TRUNCATE ON public.memory_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.memory_append_only();

-- ---------- 3. Access rule ----------

-- The ONE read predicate. A live staff profile of p_user in p_account is required (active or not, as 109's
-- can_view_conversation_for_user: the app names the account). Contact branch: 072's can_view_contact written for
-- an explicit user (072 reads auth.uid(), NULL on the service-role path), branch for branch: creator
-- (contacts.user_id), own or assigned chat of the contact, a team leader whose team holds the creator or a chat's
-- owner / assignee. Change one, change both. Case branch: 122's case_role. memory_acl rows add scopes on top.
CREATE OR REPLACE FUNCTION public.memory_can_read(p_user uuid, p_account uuid, p_scope_type text, p_scope_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH me AS (
    SELECT p.account_role::text AS role
      FROM public.profiles p
     WHERE p.user_id = p_user
       AND p.account_id = p_account
       AND p.deactivated_at IS NULL
       AND p.account_role <> 'bank_guest'
  )
  SELECT CASE
    WHEN p_user IS NULL OR p_account IS NULL OR p_scope_type IS NULL OR p_scope_id IS NULL THEN false
    WHEN NOT EXISTS (SELECT 1 FROM me) THEN false
    WHEN EXISTS (SELECT 1 FROM me WHERE me.role IN ('owner', 'admin')) THEN true
    WHEN p_scope_type = 'workspace' AND p_scope_id = p_account THEN true
    WHEN p_scope_type = 'contact' AND EXISTS (
      SELECT 1 FROM public.contacts ct
       WHERE ct.id = p_scope_id AND ct.account_id = p_account
         AND (ct.user_id = p_user
              OR EXISTS (SELECT 1 FROM public.conversations c
                          WHERE c.contact_id = ct.id
                            AND (c.user_id = p_user OR c.assigned_agent_id = p_user))
              OR (EXISTS (SELECT 1 FROM me WHERE me.role = 'team_leader')
                  AND EXISTS (SELECT 1 FROM public.teams t
                                JOIN public.team_members tm ON tm.team_id = t.id
                               WHERE t.account_id = p_account
                                 AND t.leader_user_id = p_user
                                 AND (tm.user_id = ct.user_id
                                      OR EXISTS (SELECT 1 FROM public.conversations c
                                                  WHERE c.contact_id = ct.id
                                                    AND tm.user_id IN (c.user_id, c.assigned_agent_id))))))
    ) THEN true
    WHEN p_scope_type = 'case'
      AND EXISTS (SELECT 1 FROM public.cases k WHERE k.id = p_scope_id AND k.account_id = p_account)
      AND public.case_role(p_scope_id, p_user) IS NOT NULL THEN true
    WHEN EXISTS (
      SELECT 1 FROM public.memory_acl a
       WHERE a.account_id = p_account AND a.user_id = p_user AND a.revoked_at IS NULL
         AND ((a.scope_type = p_scope_type AND a.scope_id = p_scope_id)
              OR (a.role IN ('admin', 'super_admin') AND a.scope_type = 'workspace' AND a.scope_id = p_account))
    ) THEN true
    ELSE false
  END
$$;

-- ---------- 4. Write path ----------

-- One call: scope check, dedupe on the scope's content_hash, optional supersede of an older item of the same
-- scope (a verified item only by a verified write whose stored row is verified: else SUPERSEDE_VERIFIED, 42501),
-- per-scope cap on LIVE items (superseded rows evicted first; then the lowest importance x recency live
-- NON-verified item other than the new one, never a summary that still has sources; a scope with nothing
-- evictable over the cap refuses the write), audit. Serialised per scope by an advisory lock. Returns the STORED
-- row's trust and importance (on dedupe: the existing row's, not the requested values).
-- The scope's contact / case row is taken FOR KEY SHARE, so a contact deleted concurrently either refuses this
-- write (SCOPE_INVALID) or waits for it and then erases what it wrote.
DROP FUNCTION IF EXISTS public.memory_put(uuid, text, uuid, text, text, text, smallint, text, text, text, uuid, real[], text, uuid, integer, jsonb);
CREATE FUNCTION public.memory_put(
  p_account_id uuid, p_scope_type text, p_scope_id uuid, p_kind text, p_content text, p_content_hash text,
  p_importance smallint, p_trust text, p_source_type text, p_source_id text, p_created_by uuid,
  p_embedding real[], p_embedding_model text, p_supersedes uuid, p_max_items integer, p_redactions jsonb)
RETURNS TABLE (item_id uuid, deduped boolean, evicted integer, item_trust text, item_importance smallint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id         uuid;
  v_trust      text;
  v_importance smallint;
  v_deduped    boolean := false;
  v_n          integer;
  v_victim     record;
  v_evicted    integer := 0;
  v_live       integer;
  v_dead       boolean;
  v_ok         boolean;
BEGIN
  IF p_max_items IS NULL OR p_max_items < 1 OR p_max_items > 10000 THEN
    RAISE EXCEPTION 'memory_put: p_max_items must be 1..10000' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_redactions IS NULL OR jsonb_typeof(p_redactions) <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_each(p_redactions) e WHERE jsonb_typeof(e.value) <> 'number') THEN
    RAISE EXCEPTION 'memory_put: p_redactions is an object of counts' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The scope must exist inside the account.
  v_ok := false;
  IF p_account_id IS NOT NULL AND p_scope_id IS NOT NULL THEN
    IF p_scope_type = 'workspace' THEN
      v_ok := p_scope_id = p_account_id AND EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = p_account_id);
    ELSIF p_scope_type = 'contact' THEN
      PERFORM 1 FROM public.contacts ct WHERE ct.id = p_scope_id AND ct.account_id = p_account_id FOR KEY SHARE;
      v_ok := found;
    ELSIF p_scope_type = 'case' THEN
      PERFORM 1 FROM public.cases k WHERE k.id = p_scope_id AND k.account_id = p_account_id FOR KEY SHARE;
      v_ok := found;
    END IF;
  END IF;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'memory_put: the scope is not a contact, case or the workspace of this account'
      USING ERRCODE = 'invalid_parameter_value', HINT = 'SCOPE_INVALID';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('memory:' || p_account_id::text || ':' || p_scope_type || ':' || p_scope_id::text));

  -- Only a verified write may supersede a verified item (checked before dedupe so no path skips it).
  IF p_supersedes IS NOT NULL AND coalesce(p_trust, 'untrusted') <> 'verified'
     AND EXISTS (SELECT 1 FROM public.memory_items m WHERE m.id = p_supersedes AND m.trust = 'verified'
                   AND m.account_id = p_account_id AND m.scope_type = p_scope_type AND m.scope_id = p_scope_id) THEN
    RAISE EXCEPTION 'memory_put: SUPERSEDE_VERIFIED: only a verified write may supersede a verified item'
      USING ERRCODE = 'insufficient_privilege', HINT = 'SUPERSEDE_VERIFIED';
  END IF;

  -- Dedupe only onto the scope's LIVE item with this hash. A not-superseded match that has expired but not yet
  -- been swept is removed here (audited like the TTL sweep, counts only) and a fresh item is inserted; a
  -- superseded match is ignored (a correction back to earlier content gets a fresh live item).
  PERFORM set_config('wacrm.memory_erase', 'on', true);
  DELETE FROM public.memory_items m
   WHERE m.account_id = p_account_id AND m.scope_type = p_scope_type AND m.scope_id = p_scope_id
     AND m.content_hash = p_content_hash AND m.superseded_by IS NULL AND m.expires_at <= now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('wacrm.memory_erase', '', true);
  IF v_n > 0 THEN
    INSERT INTO public.memory_audit (action, actor, account_id, scope_type, scope_id, item_count, reason)
    VALUES ('expire', p_created_by, p_account_id, p_scope_type, p_scope_id, v_n, 'ttl');
  END IF;
  SELECT m.id, m.trust, m.importance INTO v_id, v_trust, v_importance FROM public.memory_items m
   WHERE m.account_id = p_account_id AND m.scope_type = p_scope_type AND m.scope_id = p_scope_id
     AND m.content_hash = p_content_hash AND m.superseded_by IS NULL AND m.expires_at > now();

  IF v_id IS NOT NULL THEN
    v_deduped := true;
    INSERT INTO public.memory_audit (action, actor, account_id, scope_type, scope_id, item_count, detail)
    VALUES ('dedupe', p_created_by, p_account_id, p_scope_type, p_scope_id, 1, jsonb_build_object('redactions', p_redactions));
  ELSE
    INSERT INTO public.memory_items (account_id, scope_type, scope_id, kind, content, content_hash, importance, trust,
                                     source_type, source_id, created_by, embedding, embedding_model)
    VALUES (p_account_id, p_scope_type, p_scope_id, p_kind, p_content, p_content_hash, p_importance,
            coalesce(p_trust, 'untrusted'), p_source_type, p_source_id, p_created_by, p_embedding, p_embedding_model)
    RETURNING id, trust, importance INTO v_id, v_trust, v_importance;
    INSERT INTO public.memory_audit (action, actor, account_id, scope_type, scope_id, item_count, detail)
    VALUES ('put', p_created_by, p_account_id, p_scope_type, p_scope_id, 1,
            jsonb_build_object('redactions', p_redactions, 'trust', coalesce(p_trust, 'untrusted'), 'importance', p_importance,
                               'embedded', p_embedding IS NOT NULL));
  END IF;

  -- Runs on the dedupe path too: re-putting live content that corrects another item still supersedes that item.
  IF p_supersedes IS NOT NULL THEN
    -- The replacing row is the STORED one (on dedupe: the existing row, whatever trust this write requested), so
    -- a verified item is superseded only by a row that is itself verified.
    IF v_trust <> 'verified'
       AND EXISTS (SELECT 1 FROM public.memory_items m WHERE m.id = p_supersedes AND m.trust = 'verified'
                     AND m.account_id = p_account_id AND m.scope_type = p_scope_type AND m.scope_id = p_scope_id) THEN
      RAISE EXCEPTION 'memory_put: SUPERSEDE_VERIFIED: only a verified write may supersede a verified item'
        USING ERRCODE = 'insufficient_privilege', HINT = 'SUPERSEDE_VERIFIED';
    END IF;
    UPDATE public.memory_items m SET superseded_by = v_id
     WHERE m.id = p_supersedes AND m.account_id = p_account_id AND m.scope_type = p_scope_type
       AND m.scope_id = p_scope_id AND m.superseded_by IS NULL AND m.id <> v_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'memory_put: the superseded item must be a live item of the same scope' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    INSERT INTO public.memory_audit (action, actor, account_id, scope_type, scope_id, item_count)
    VALUES ('supersede', p_created_by, p_account_id, p_scope_type, p_scope_id, 1);
  END IF;

  IF v_deduped THEN
    RETURN QUERY SELECT v_id, true, 0, v_trust, v_importance;
    RETURN;
  END IF;

  -- Cap: only LIVE rows (not superseded) count against p_max_items, so dead rows never cost live data. While the
  -- scope holds more than p_max_items rows in total, superseded non-verified rows are evicted first (oldest
  -- first); live rows are evicted only while the LIVE count is over the cap, by importance x recency. A summary
  -- is not evictable while any of its sources (rows superseded by it) remains. Verified rows are never evicted.
  SELECT count(*), count(*) FILTER (WHERE m.superseded_by IS NULL) INTO v_n, v_live FROM public.memory_items m
   WHERE m.account_id = p_account_id AND m.scope_type = p_scope_type AND m.scope_id = p_scope_id;
  WHILE v_n > p_max_items LOOP
    SELECT m.id, m.importance, m.kind INTO v_victim FROM public.memory_items m
     WHERE m.account_id = p_account_id AND m.scope_type = p_scope_type AND m.scope_id = p_scope_id
       AND m.superseded_by IS NOT NULL AND m.trust <> 'verified'
     ORDER BY m.created_at, m.id
     LIMIT 1;
    IF found THEN
      v_dead := true;
    ELSE
      EXIT WHEN v_live <= p_max_items;
      v_dead := false;
      SELECT m.id, m.importance, m.kind INTO v_victim FROM public.memory_items m
       WHERE m.account_id = p_account_id AND m.scope_type = p_scope_type AND m.scope_id = p_scope_id
         AND m.superseded_by IS NULL AND m.trust <> 'verified' AND m.id <> v_id
         AND NOT (m.kind = 'summary' AND EXISTS (
               SELECT 1 FROM public.memory_items s
                WHERE s.account_id = p_account_id AND s.scope_type = p_scope_type AND s.scope_id = p_scope_id
                  AND s.superseded_by = m.id))
       ORDER BY m.importance::double precision
                / (1 + extract(epoch FROM (now() - greatest(m.created_at, coalesce(m.last_recalled_at, m.created_at)))) / 2592000.0),
                m.created_at, m.id
       LIMIT 1;
      IF NOT found THEN
        RAISE EXCEPTION 'memory_put: scope is at its cap of % live items and holds no evictable item', p_max_items
          USING ERRCODE = 'program_limit_exceeded';
      END IF;
    END IF;
    PERFORM set_config('wacrm.memory_erase', 'on', true);
    DELETE FROM public.memory_items m WHERE m.id = v_victim.id;
    PERFORM set_config('wacrm.memory_erase', '', true);
    INSERT INTO public.memory_audit (action, actor, account_id, scope_type, scope_id, item_count, reason, detail)
    VALUES ('evict', p_created_by, p_account_id, p_scope_type, p_scope_id, 1, 'scope cap',
            jsonb_build_object('cap', p_max_items, 'importance', v_victim.importance, 'kind', v_victim.kind));
    v_evicted := v_evicted + 1;
    v_n := v_n - 1;
    IF NOT v_dead THEN
      v_live := v_live - 1;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_id, false, v_evicted, v_trust, v_importance;
END
$$;

-- ---------- 5. Read path ----------

-- READ-ONLY (STABLE, writes nothing). Live (not superseded, not expired) items of the scopes memory_can_read
-- allows RIGHT NOW, judged once per scope. Optional scope filter: parallel arrays p_scope_types[i] /
-- p_scope_ids[i]. Optional full-text query (tsquery, 'simple' config); rank is ts_rank_cd (0 without a query).
-- At most 100 rows. Recall counters are NOT touched here: the caller ranks the candidates and passes only the ids
-- it actually uses to memory_mark_recalled, which bumps and audits them.
DROP FUNCTION IF EXISTS public.memory_recall_candidates(uuid, uuid, text[], uuid[], tsquery, integer);
CREATE FUNCTION public.memory_recall_candidates(
  p_user_id uuid, p_account_id uuid, p_scope_types text[], p_scope_ids uuid[], p_query tsquery, p_limit integer)
RETURNS TABLE (id uuid, scope_type text, scope_id uuid, kind text, content text, importance smallint, trust text,
               source_type text, created_at timestamptz, last_recalled_at timestamptz, embedding real[], rank real)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF p_user_id IS NULL OR p_account_id IS NULL THEN
    RAISE EXCEPTION 'memory_recall_candidates: user and account are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF coalesce(cardinality(p_scope_types), 0) <> coalesce(cardinality(p_scope_ids), 0) THEN
    RAISE EXCEPTION 'memory_recall_candidates: scope filter arrays differ in length' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
    WITH live AS MATERIALIZED (
      SELECT m.* FROM public.memory_items m
       WHERE m.account_id = p_account_id
         AND m.superseded_by IS NULL
         AND m.expires_at > now()
         AND (p_scope_types IS NULL
              OR (m.scope_type, m.scope_id) IN (SELECT f.t, f.i FROM unnest(p_scope_types, p_scope_ids) AS f(t, i)))
         AND (p_query IS NULL OR m.search @@ p_query)
    ), readable AS MATERIALIZED (
      SELECT s.scope_type, s.scope_id
        FROM (SELECT DISTINCT l.scope_type, l.scope_id FROM live l) s
       WHERE public.memory_can_read(p_user_id, p_account_id, s.scope_type, s.scope_id)
    )
    SELECT l.id, l.scope_type, l.scope_id, l.kind, l.content, l.importance, l.trust, l.source_type, l.created_at,
           l.last_recalled_at, l.embedding,
           CASE WHEN p_query IS NULL THEN 0::real ELSE ts_rank_cd(l.search, p_query) END
      FROM live l
      JOIN readable r ON r.scope_type = l.scope_type AND r.scope_id = l.scope_id
     ORDER BY 12 DESC, l.importance DESC, l.created_at DESC
     LIMIT least(greatest(coalesce(p_limit, 20), 1), 100);
END
$$;

-- Marks the items a caller actually put in a prompt as recalled: bumps last_recalled_at / recall_count, audits the
-- count ('recall', always, also for an empty list). Only ids of live items of this account that memory_can_read
-- allows RIGHT NOW are touched; any other id is silently skipped. At most 100 ids. Returns the number bumped.
CREATE OR REPLACE FUNCTION public.memory_mark_recalled(p_user_id uuid, p_account_id uuid, p_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer := 0;
BEGIN
  IF p_user_id IS NULL OR p_account_id IS NULL THEN
    RAISE EXCEPTION 'memory_mark_recalled: user and account are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF coalesce(cardinality(p_ids), 0) > 100 THEN
    RAISE EXCEPTION 'memory_mark_recalled: at most 100 ids' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF coalesce(cardinality(p_ids), 0) > 0 THEN
    UPDATE public.memory_items m SET last_recalled_at = now(), recall_count = m.recall_count + 1
     WHERE m.id = ANY (p_ids)
       AND m.account_id = p_account_id
       AND m.superseded_by IS NULL
       AND m.expires_at > now()
       AND public.memory_can_read(p_user_id, p_account_id, m.scope_type, m.scope_id);
    GET DIAGNOSTICS v_n = ROW_COUNT;
  END IF;
  INSERT INTO public.memory_audit (action, actor, account_id, item_count, detail)
  VALUES ('recall', p_user_id, p_account_id, v_n, jsonb_build_object('requested', coalesce(cardinality(p_ids), 0)));
  RETURN v_n;
END
$$;

-- The staff panel's read of ONE scope: live items, newest first (created_at, id desc), created_at < p_before when
-- given, 1..200 rows (default 50); zero rows unless memory_can_read. Not audited (prompt recalls stay audited
-- through memory_mark_recalled).
DROP FUNCTION IF EXISTS public.memory_list(uuid, uuid, text, uuid, integer, timestamptz);
CREATE FUNCTION public.memory_list(
  p_user uuid, p_account uuid, p_scope_type text, p_scope_id uuid,
  p_limit integer DEFAULT 50, p_before timestamptz DEFAULT NULL)
RETURNS TABLE (id uuid, kind text, content text, importance smallint, trust text, source_type text, source_id text,
               created_by uuid, created_at timestamptz, expires_at timestamptz, recall_count integer,
               last_recalled_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT m.id, m.kind, m.content, m.importance, m.trust, m.source_type, m.source_id, m.created_by, m.created_at,
         m.expires_at, m.recall_count, m.last_recalled_at
    FROM public.memory_items m
   WHERE public.memory_can_read(p_user, p_account, p_scope_type, p_scope_id)
     AND m.account_id = p_account AND m.scope_type = p_scope_type AND m.scope_id = p_scope_id
     AND m.superseded_by IS NULL
     AND m.expires_at > now()
     AND (p_before IS NULL OR m.created_at < p_before)
   ORDER BY m.created_at DESC, m.id DESC
   LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
$$;

-- ---------- 6. Erasure ----------

-- Privacy request: removes every item of one scope; the audit keeps who / why / how many, never content.
CREATE OR REPLACE FUNCTION public.memory_forget(p_actor uuid, p_account_id uuid, p_scope_type text, p_scope_id uuid, p_reason text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_n integer;
BEGIN
  -- Blank means no visible character (tabs and newlines included); the store refuses a reason over 1000 characters,
  -- and so does the database, since no other layer stands between a caller and this audit row.
  IF p_actor IS NULL OR coalesce(p_reason, '') !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'memory_forget: actor and reason are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF char_length(p_reason) > 1000 THEN
    RAISE EXCEPTION 'memory_forget: the reason is over 1000 characters' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_account_id IS NULL OR p_scope_type IS NULL OR p_scope_id IS NULL THEN
    RAISE EXCEPTION 'memory_forget: a full scope is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('memory:' || p_account_id::text || ':' || p_scope_type || ':' || p_scope_id::text));
  PERFORM set_config('wacrm.memory_erase', 'on', true);
  DELETE FROM public.memory_items m
   WHERE m.account_id = p_account_id AND m.scope_type = p_scope_type AND m.scope_id = p_scope_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('wacrm.memory_erase', '', true);
  INSERT INTO public.memory_audit (action, actor, account_id, scope_type, scope_id, item_count, reason)
  VALUES ('forget', p_actor, p_account_id, p_scope_type, p_scope_id, v_n, left(p_reason, 500));
  RETURN v_n;
END
$$;

-- A deleted contact's memory goes with it: one 'forget' audit row (reason 'contact deleted', actor NULL, count
-- only) when there was something to erase. Nothing to erase is a no-op (no lock, no audit row), so a bulk contact
-- delete costs one index probe per contact. memory_put holds the contact row FOR KEY SHARE, so no item can land in
-- this scope between the probe and the delete.
CREATE OR REPLACE FUNCTION public.memory_forget_deleted_contact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.memory_items m
                  WHERE m.account_id = old.account_id AND m.scope_type = 'contact' AND m.scope_id = old.id) THEN
    RETURN old;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('memory:' || old.account_id::text || ':contact:' || old.id::text));
  PERFORM set_config('wacrm.memory_erase', 'on', true);
  DELETE FROM public.memory_items m
   WHERE m.account_id = old.account_id AND m.scope_type = 'contact' AND m.scope_id = old.id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('wacrm.memory_erase', '', true);
  IF v_n > 0 THEN
    INSERT INTO public.memory_audit (action, actor, account_id, scope_type, scope_id, item_count, reason)
    VALUES ('forget', NULL, old.account_id, 'contact', old.id, v_n, 'contact deleted');
  END IF;
  RETURN old;
END
$$;

DROP TRIGGER IF EXISTS contacts_forget_memory ON public.contacts;
CREATE TRIGGER contacts_forget_memory
  AFTER DELETE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.memory_forget_deleted_contact();

-- TTL sweep: removes only items whose expires_at has passed; one audit row per scope with its count. p_actor NULL
-- = the scheduled job.
CREATE OR REPLACE FUNCTION public.memory_expire_due(p_actor uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_n integer;
BEGIN
  PERFORM set_config('wacrm.memory_erase', 'on', true);
  WITH gone AS (
    DELETE FROM public.memory_items m WHERE m.expires_at <= now()
    RETURNING m.account_id, m.scope_type, m.scope_id
  ), per_scope AS (
    SELECT g.account_id, g.scope_type, g.scope_id, count(*)::integer AS n FROM gone g
     GROUP BY g.account_id, g.scope_type, g.scope_id
  ), audited AS (
    INSERT INTO public.memory_audit (action, actor, account_id, scope_type, scope_id, item_count, reason)
    SELECT 'expire', p_actor, s.account_id, s.scope_type, s.scope_id, s.n, 'ttl' FROM per_scope s
    RETURNING item_count
  )
  SELECT coalesce(sum(a.item_count), 0)::integer INTO v_n FROM audited a;
  PERFORM set_config('wacrm.memory_erase', '', true);
  RETURN v_n;
END
$$;

-- ---------- 7. Compaction ----------

-- READ-ONLY (STABLE). Rows only when memory_can_read(actor, scope). Candidates: live (not superseded, not
-- expired), kind <> 'summary', trust 'untrusted' (verified items are never compacted), created more than
-- p_older_than_days days ago, oldest first, at most p_limit (1..500).
DROP FUNCTION IF EXISTS public.memory_compact_candidates(uuid, uuid, text, uuid, integer, integer);
CREATE FUNCTION public.memory_compact_candidates(
  p_actor uuid, p_account_id uuid, p_scope_type text, p_scope_id uuid, p_older_than_days integer, p_limit integer)
RETURNS TABLE (id uuid, kind text, content text, created_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF p_actor IS NULL OR p_account_id IS NULL OR p_scope_type IS NULL OR p_scope_id IS NULL THEN
    RAISE EXCEPTION 'memory_compact_candidates: actor and a full scope are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_older_than_days IS NULL OR p_older_than_days < 0 OR p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'memory_compact_candidates: p_older_than_days >= 0 and p_limit 1..500' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT public.memory_can_read(p_actor, p_account_id, p_scope_type, p_scope_id) THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT m.id, m.kind, m.content, m.created_at
      FROM public.memory_items m
     WHERE m.account_id = p_account_id AND m.scope_type = p_scope_type AND m.scope_id = p_scope_id
       AND m.superseded_by IS NULL
       AND m.expires_at > now()
       AND m.kind <> 'summary'
       AND m.trust = 'untrusted'
       AND m.created_at < now() - make_interval(days => p_older_than_days)
     ORDER BY m.created_at, m.id
     LIMIT p_limit;
END
$$;

-- Applies one compaction in ONE transaction: inserts the summary item (kind 'summary', trust 'untrusted',
-- importance 2, source_type 'compaction', expires no later than the latest source) and sets superseded_by on every
-- source. Every id must be a live untrusted item of this account and scope; if any is not (e.g. superseded or
-- expired since it was selected), it raises serialization_failure and NOTHING changes. Sources are kept (soft
-- supersede), never deleted. p_summary is ALREADY REDACTED; p_summary_hash is its contentHash. Dedupe on the
-- scope's LIVE item with that hash: a replay (every id already superseded by it) returns that item and changes
-- nothing; otherwise it becomes the summary the sources are superseded by. Audit 'compact' with counts only.
DROP FUNCTION IF EXISTS public.memory_compact_apply(uuid, text, uuid, uuid[], text, text, uuid);
CREATE FUNCTION public.memory_compact_apply(
  p_account_id uuid, p_scope_type text, p_scope_id uuid, p_ids uuid[], p_summary text, p_summary_hash text, p_actor uuid)
RETURNS TABLE (summary_id uuid, deduped boolean, superseded integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ids       uuid[];
  v_req       integer;
  v_id        uuid;
  v_deduped   boolean := false;
  v_expires   timestamptz;
  v_exist_exp timestamptz;
  v_n         integer;
BEGIN
  IF p_actor IS NULL OR p_account_id IS NULL OR p_scope_type IS NULL OR p_scope_id IS NULL THEN
    RAISE EXCEPTION 'memory_compact_apply: actor and a full scope are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT coalesce(array_agg(DISTINCT x), '{}') INTO v_ids FROM unnest(p_ids) AS u(x) WHERE x IS NOT NULL;
  v_req := cardinality(v_ids);
  IF v_req < 1 OR v_req > 500 THEN
    RAISE EXCEPTION 'memory_compact_apply: 1..500 source ids' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('memory:' || p_account_id::text || ':' || p_scope_type || ':' || p_scope_id::text));

  -- Only the scope's LIVE item with the summary hash counts (as in memory_put): a not-superseded match that has
  -- expired but not yet been swept is removed first (audited like the TTL sweep) so the summary can be inserted.
  PERFORM set_config('wacrm.memory_erase', 'on', true);
  DELETE FROM public.memory_items m
   WHERE m.account_id = p_account_id AND m.scope_type = p_scope_type AND m.scope_id = p_scope_id
     AND m.content_hash = p_summary_hash AND m.superseded_by IS NULL AND m.expires_at <= now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('wacrm.memory_erase', '', true);
  IF v_n > 0 THEN
    INSERT INTO public.memory_audit (action, actor, account_id, scope_type, scope_id, item_count, reason)
    VALUES ('expire', p_actor, p_account_id, p_scope_type, p_scope_id, v_n, 'ttl');
  END IF;
  SELECT m.id, m.expires_at INTO v_id, v_exist_exp FROM public.memory_items m
   WHERE m.account_id = p_account_id AND m.scope_type = p_scope_type AND m.scope_id = p_scope_id
     AND m.content_hash = p_summary_hash AND m.superseded_by IS NULL AND m.expires_at > now();
  SELECT max(m.expires_at) INTO v_expires FROM public.memory_items m
   WHERE m.id = ANY (v_ids) AND m.account_id = p_account_id AND m.scope_type = p_scope_type
     AND m.scope_id = p_scope_id;
  IF v_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM unnest(v_ids) AS u(x)
                    WHERE NOT EXISTS (SELECT 1 FROM public.memory_items m WHERE m.id = u.x AND m.superseded_by = v_id)) THEN
      INSERT INTO public.memory_audit (action, actor, account_id, scope_type, scope_id, item_count, detail)
      VALUES ('compact', p_actor, p_account_id, p_scope_type, p_scope_id, 0,
              jsonb_build_object('requested', v_req, 'deduped', true));
      RETURN QUERY SELECT v_id, true, 0;
      RETURN;
    END IF;
    IF v_id = ANY (v_ids) THEN
      RAISE EXCEPTION 'memory_compact_apply: an item with the summary hash exists and is not a usable summary'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_exist_exp < v_expires THEN
      RAISE EXCEPTION 'memory_compact_apply: the existing item with the summary hash expires before the sources; nothing applied'
        USING ERRCODE = 'serialization_failure';
    END IF;
    v_deduped := true;
  END IF;

  IF NOT v_deduped THEN
    INSERT INTO public.memory_items (account_id, scope_type, scope_id, kind, content, content_hash, importance, trust,
                                     source_type, source_id, created_by, expires_at)
    VALUES (p_account_id, p_scope_type, p_scope_id, 'summary', p_summary, p_summary_hash, 2, 'untrusted',
            'compaction', NULL, p_actor, coalesce(v_expires, now() + interval '24 months'))
    RETURNING id INTO v_id;
  END IF;

  UPDATE public.memory_items m SET superseded_by = v_id
   WHERE m.id = ANY (v_ids) AND m.account_id = p_account_id AND m.scope_type = p_scope_type
     AND m.scope_id = p_scope_id AND m.trust = 'untrusted' AND m.kind <> 'summary' AND m.superseded_by IS NULL
     AND m.expires_at > now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> v_req THEN
    RAISE EXCEPTION 'memory_compact_apply: % of % sources are not live untrusted items of the scope; nothing applied',
      v_req - v_n, v_req USING ERRCODE = 'serialization_failure';
  END IF;

  INSERT INTO public.memory_audit (action, actor, account_id, scope_type, scope_id, item_count, detail)
  VALUES ('compact', p_actor, p_account_id, p_scope_type, p_scope_id, v_n,
          jsonb_build_object('requested', v_req, 'deduped', v_deduped));
  RETURN QUERY SELECT v_id, v_deduped, v_n;
END
$$;

-- ---------- 8. ACL (extra scopes, kept for future service users) ----------

-- Grant is idempotent per (scope, user, role); revoke closes every active row of the user on the scope.
CREATE OR REPLACE FUNCTION public.memory_acl_grant(p_actor uuid, p_account_id uuid, p_scope_type text, p_scope_id uuid,
                                                   p_user_id uuid, p_role text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_n integer;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'memory_acl_grant: actor is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO public.memory_acl (account_id, scope_type, scope_id, user_id, role)
  VALUES (p_account_id, p_scope_type, p_scope_id, p_user_id, p_role)
  ON CONFLICT (account_id, scope_type, scope_id, user_id, role) WHERE revoked_at IS NULL DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    INSERT INTO public.memory_audit (action, actor, account_id, scope_type, scope_id, item_count, detail)
    VALUES ('acl_grant', p_actor, p_account_id, p_scope_type, p_scope_id, 1,
            jsonb_build_object('user_id', p_user_id, 'role', p_role));
  END IF;
  RETURN v_n = 1;
END
$$;

CREATE OR REPLACE FUNCTION public.memory_acl_revoke(p_actor uuid, p_account_id uuid, p_scope_type text, p_scope_id uuid,
                                                    p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_n integer;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'memory_acl_revoke: actor is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.memory_acl a SET revoked_at = clock_timestamp()
   WHERE a.account_id = p_account_id AND a.scope_type = p_scope_type AND a.scope_id = p_scope_id
     AND a.user_id = p_user_id AND a.revoked_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  INSERT INTO public.memory_audit (action, actor, account_id, scope_type, scope_id, item_count, detail)
  VALUES ('acl_revoke', p_actor, p_account_id, p_scope_type, p_scope_id, v_n, jsonb_build_object('user_id', p_user_id));
  RETURN v_n;
END
$$;

-- ---------- 9. Privileges ----------

-- Revoke Supabase's defaults (tables, identity sequences, functions), then grant the minimum.
REVOKE ALL ON public.memory_items, public.memory_acl, public.memory_audit
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.memory_acl_id_seq, public.memory_audit_id_seq
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION
  public.memory_items_guard(),
  public.memory_acl_guard(),
  public.memory_append_only(),
  public.memory_forget_deleted_contact(),
  public.memory_can_read(uuid, uuid, text, uuid),
  public.memory_put(uuid, text, uuid, text, text, text, smallint, text, text, text, uuid, real[], text, uuid, integer, jsonb),
  public.memory_recall_candidates(uuid, uuid, text[], uuid[], tsquery, integer),
  public.memory_mark_recalled(uuid, uuid, uuid[]),
  public.memory_list(uuid, uuid, text, uuid, integer, timestamptz),
  public.memory_forget(uuid, uuid, text, uuid, text),
  public.memory_expire_due(uuid),
  public.memory_acl_grant(uuid, uuid, text, uuid, uuid, text),
  public.memory_acl_revoke(uuid, uuid, text, uuid, uuid),
  public.memory_compact_candidates(uuid, uuid, text, uuid, integer, integer),
  public.memory_compact_apply(uuid, text, uuid, uuid[], text, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- No table privilege for service_role: every read goes through memory_can_read, every write and removal is audited.
GRANT EXECUTE ON FUNCTION
  public.memory_can_read(uuid, uuid, text, uuid),
  public.memory_put(uuid, text, uuid, text, text, text, smallint, text, text, text, uuid, real[], text, uuid, integer, jsonb),
  public.memory_recall_candidates(uuid, uuid, text[], uuid[], tsquery, integer),
  public.memory_mark_recalled(uuid, uuid, uuid[]),
  public.memory_list(uuid, uuid, text, uuid, integer, timestamptz),
  public.memory_forget(uuid, uuid, text, uuid, text),
  public.memory_expire_due(uuid),
  public.memory_acl_grant(uuid, uuid, text, uuid, uuid, text),
  public.memory_acl_revoke(uuid, uuid, text, uuid, uuid),
  public.memory_compact_candidates(uuid, uuid, text, uuid, integer, integer),
  public.memory_compact_apply(uuid, text, uuid, uuid[], text, text, uuid)
  TO service_role;
