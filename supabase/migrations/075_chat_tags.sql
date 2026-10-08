-- ============================================================
-- 075: chat tags — one main tag and one sub-tag per chat
--
-- The chat header's Open / Pending / Closed selector told an agent
-- little about where a customer stands. This replaces it, on screen,
-- with tags an admin defines and colours in Settings: "New customer",
-- "Interested customer", "Not interested". A main tag may carry
-- sub-tags ("Interested customer" → ADCB, Emirates NBD, FAB) under an
-- optional caption ("Bank"). A chat carries at most ONE main tag and
-- at most ONE sub-tag, and the sub-tag must belong to the main tag.
--
-- conversations.status is untouched: automations, the public API and
-- the inbox filters still read it. The contact `tags` / `contact_tags`
-- tables are a different thing (many labels per contact) and are not
-- involved.
--
-- Design:
--
--   chat_tags (account_id, parent_id NULL)       a main tag
--   chat_tags (account_id, parent_id = main)     one of its sub-tags
--   conversations.chat_tag_id                    the chat's main tag
--   conversations.chat_sub_tag_id                its sub-tag
--
-- Two columns rather than a join table because the rule is "at most
-- one of each", and a column says that with no extra constraint.
--
-- Invariants, each enforced in the database rather than the app:
--
-- * One level of nesting. A sub-tag's parent must be a main tag
--   (chat_tags_guard). parent_id is immutable once written, so a sub-
--   tag can never move out from under the chats that carry it.
-- * Same account, by construction. Every reference — sub-tag to main
--   tag, chat to either tag — is a composite FK on (id, account_id),
--   the 062 pattern: another account's tag is impossible, not merely
--   filtered by RLS.
-- * Deleting a main tag deletes its sub-tags (CASCADE) and clears both
--   columns on the chats that used them. The SET NULL carries a column
--   list: without it Postgres would null conversations.account_id too.
-- * conversations_chat_tag_guard: chat_tag_id must name a main tag,
--   chat_sub_tag_id a sub-tag of it. Switching the main tag without
--   naming a sub-tag drops the old one ("Interested → Not interested"
--   loses the bank); naming a sub-tag of a different main tag is
--   refused. The trigger is column-scoped, so status and assignment
--   updates never pay for it.
--
-- Who may do what: any member reads the account's tags; admins and
-- owners (rank >= 4) write them. Setting a chat's tag is an ordinary
-- conversations UPDATE, so the existing conversations_update policy
-- decides: agent and up, on a chat they can see; viewers never.
--
-- Re-runnable: every statement is guarded.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The tag list
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.chat_tags (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- NULL for a main tag; the main tag's id for a sub-tag.
  parent_id     uuid NULL,
  name          text NOT NULL,
  color         text NOT NULL DEFAULT '#3b82f6',
  -- Caption for a main tag's sub-tags ("Bank"). Always NULL on a sub-tag.
  sub_tag_title text NULL,
  position      integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_tags_id_account_key UNIQUE (id, account_id),
  CONSTRAINT chat_tags_parent_fkey
    FOREIGN KEY (parent_id, account_id)
    REFERENCES public.chat_tags (id, account_id) ON DELETE CASCADE,
  CONSTRAINT chat_tags_name_check
    CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 40),
  CONSTRAINT chat_tags_color_check
    CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  CONSTRAINT chat_tags_sub_tag_title_check
    CHECK (sub_tag_title IS NULL
           OR (sub_tag_title = btrim(sub_tag_title)
               AND char_length(sub_tag_title) BETWEEN 1 AND 30)),
  CONSTRAINT chat_tags_not_own_parent_check
    CHECK (parent_id <> id)
);

-- Sibling names are unique regardless of case: two main tags, or two
-- sub-tags of one main tag, cannot both be "ADCB". The same name under
-- two different main tags is fine.
CREATE UNIQUE INDEX IF NOT EXISTS chat_tags_sibling_name_key
  ON public.chat_tags (
    account_id,
    COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(name)
  );

CREATE INDEX IF NOT EXISTS idx_chat_tags_account_parent_position
  ON public.chat_tags (account_id, parent_id, position);

COMMENT ON TABLE public.chat_tags IS
  'Admin-defined chat tags (migration 075). parent_id NULL is a main tag; '
  'otherwise a sub-tag of that main tag, one level deep. A conversation '
  'carries at most one main tag (chat_tag_id) and at most one sub-tag of '
  'it (chat_sub_tag_id).';

-- ------------------------------------------------------------
-- 2. chat_tags_guard: tidy the text, one level of nesting,
--    parent_id immutable, updated_at stamped.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.chat_tags_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_grandparent uuid;
BEGIN
  new.name := btrim(new.name);
  new.sub_tag_title := nullif(btrim(new.sub_tag_title), '');

  IF tg_op = 'UPDATE' THEN
    -- A chat's sub-tag must keep belonging to its main tag.
    IF new.parent_id IS DISTINCT FROM old.parent_id THEN
      RAISE EXCEPTION 'A tag cannot be moved under a different main tag; delete it and create a new one'
        USING ERRCODE = 'check_violation';
    END IF;
    new.updated_at := now();
  END IF;

  IF new.parent_id IS NOT NULL THEN
    -- A missing parent is the FK's to report.
    SELECT t.parent_id INTO v_grandparent
      FROM public.chat_tags t
     WHERE t.id = new.parent_id;
    IF v_grandparent IS NOT NULL THEN
      RAISE EXCEPTION 'A sub-tag can only belong to a main tag, not to another sub-tag'
        USING ERRCODE = 'check_violation';
    END IF;
    new.sub_tag_title := NULL;
  END IF;

  RETURN new;
END
$$;

DROP TRIGGER IF EXISTS chat_tags_guard ON public.chat_tags;
CREATE TRIGGER chat_tags_guard
  BEFORE INSERT OR UPDATE ON public.chat_tags
  FOR EACH ROW EXECUTE FUNCTION public.chat_tags_guard();

REVOKE ALL ON FUNCTION public.chat_tags_guard() FROM PUBLIC, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 3. RLS: members read, admins write
-- ------------------------------------------------------------
ALTER TABLE public.chat_tags ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.chat_tags FROM PUBLIC, anon, authenticated, service_role;

DROP POLICY IF EXISTS chat_tags_read   ON public.chat_tags;
DROP POLICY IF EXISTS chat_tags_insert ON public.chat_tags;
DROP POLICY IF EXISTS chat_tags_update ON public.chat_tags;
DROP POLICY IF EXISTS chat_tags_delete ON public.chat_tags;
CREATE POLICY chat_tags_read ON public.chat_tags
  FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id()));
CREATE POLICY chat_tags_insert ON public.chat_tags
  FOR INSERT TO authenticated
  WITH CHECK (
    account_id = (SELECT public.current_account_id())
    AND (SELECT public.current_role_rank()) >= 4
  );
CREATE POLICY chat_tags_update ON public.chat_tags
  FOR UPDATE TO authenticated
  USING (
    account_id = (SELECT public.current_account_id())
    AND (SELECT public.current_role_rank()) >= 4
  )
  WITH CHECK (
    account_id = (SELECT public.current_account_id())
    AND (SELECT public.current_role_rank()) >= 4
  );
CREATE POLICY chat_tags_delete ON public.chat_tags
  FOR DELETE TO authenticated
  USING (
    account_id = (SELECT public.current_account_id())
    AND (SELECT public.current_role_rank()) >= 4
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.chat_tags TO authenticated;
GRANT SELECT ON public.chat_tags TO service_role;

-- ------------------------------------------------------------
-- 4. The chat's tag and sub-tag
-- ------------------------------------------------------------
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS chat_tag_id uuid,
  ADD COLUMN IF NOT EXISTS chat_sub_tag_id uuid;

-- Same-account composite FKs (062). The column list on SET NULL is
-- load-bearing: a bare SET NULL would null account_id as well.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_chat_tag_fkey'
  ) THEN
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_chat_tag_fkey
      FOREIGN KEY (chat_tag_id, account_id)
      REFERENCES public.chat_tags (id, account_id)
      ON DELETE SET NULL (chat_tag_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_chat_sub_tag_fkey'
  ) THEN
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_chat_sub_tag_fkey
      FOREIGN KEY (chat_sub_tag_id, account_id)
      REFERENCES public.chat_tags (id, account_id)
      ON DELETE SET NULL (chat_sub_tag_id);
  END IF;
END
$$;

-- The inbox filters on these, and deleting a tag scans them.
CREATE INDEX IF NOT EXISTS idx_conversations_chat_tag
  ON public.conversations (chat_tag_id) WHERE chat_tag_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_chat_sub_tag
  ON public.conversations (chat_sub_tag_id) WHERE chat_sub_tag_id IS NOT NULL;

COMMENT ON COLUMN public.conversations.chat_tag_id IS
  'The chat''s main tag (migration 075): a chat_tags row with parent_id NULL. '
  'One main tag per chat.';
COMMENT ON COLUMN public.conversations.chat_sub_tag_id IS
  'The chat''s sub-tag (migration 075): a sub-tag of chat_tag_id, or NULL. '
  'Cleared when chat_tag_id is cleared or switched without naming a new one.';

-- ------------------------------------------------------------
-- 5. conversations_chat_tag_guard: main tag is a main tag, sub-tag
--    belongs to it. SECURITY INVOKER: it only reads tags the writer
--    can already see, and the FKs settle anything it cannot.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.conversations_chat_tag_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_main_parent uuid;
  v_sub_parent  uuid;
BEGIN
  IF new.chat_tag_id IS NULL THEN
    new.chat_sub_tag_id := NULL;
    RETURN new;
  END IF;

  -- A row that is not found is not refused here: the FK reports a bad
  -- id, and while the tag itself is being deleted its row is already
  -- gone when ON DELETE SET NULL updates the chat.
  SELECT t.parent_id INTO v_main_parent
    FROM public.chat_tags t
   WHERE t.id = new.chat_tag_id;
  IF v_main_parent IS NOT NULL THEN
    RAISE EXCEPTION 'A chat''s main tag must be a main tag, not a sub-tag'
      USING ERRCODE = 'check_violation';
  END IF;

  IF new.chat_sub_tag_id IS NOT NULL THEN
    SELECT t.parent_id INTO v_sub_parent
      FROM public.chat_tags t
     WHERE t.id = new.chat_sub_tag_id;
    IF v_sub_parent IS DISTINCT FROM new.chat_tag_id THEN
      IF tg_op = 'UPDATE'
         AND new.chat_sub_tag_id IS NOT DISTINCT FROM old.chat_sub_tag_id THEN
        -- The main tag was switched and the sub-tag left as it was:
        -- it belonged to the old main tag, so it goes.
        new.chat_sub_tag_id := NULL;
      ELSE
        RAISE EXCEPTION 'A chat''s sub-tag must belong to its main tag'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  RETURN new;
END
$$;

DROP TRIGGER IF EXISTS conversations_chat_tag_guard ON public.conversations;
CREATE TRIGGER conversations_chat_tag_guard
  BEFORE INSERT OR UPDATE OF chat_tag_id, chat_sub_tag_id ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.conversations_chat_tag_guard();

REVOKE ALL ON FUNCTION public.conversations_chat_tag_guard() FROM PUBLIC, anon, authenticated, service_role;
