-- ============================================================
-- 332: A deleted in-chat note disappears for everyone at once
--
-- 241 hard-deleted a note. Supabase Realtime delivers a DELETE with
-- only the primary key and can neither filter it by conversation_id
-- nor replay RLS on it, so the open chats (subscribed with
-- conversation_id=eq.<id>) never heard about a teammate's delete and
-- showed the note until the chat was reopened. Listening to every
-- DELETE on the table instead would hand each client the ids of notes
-- deleted in every workspace, which breaks the realtime rule (RLS is
-- replayed per subscriber, so a subscription cannot leak rows a query
-- would not).
--
-- So a delete is now a tombstone: an UPDATE that sets `deleted_at` and
-- clears the note's text and its mention list in the same statement.
-- Realtime delivers that UPDATE through the chat's filtered
-- subscription, checked against conversation_notes_select, and the
-- client drops the note.
--
--   * The author deletes with `UPDATE ... SET deleted_at = now()`
--     (column grant). The BEFORE UPDATE trigger stamps the time, sets
--     body to '' and mention_ids to '{}', so deleted text never
--     persists. 241's update policy (author only, agent and up, chat
--     visible) is the delete rule, unchanged.
--   * A tombstone is final: any later UPDATE is refused (22023), so it
--     is neither edited nor restored.
--   * Hard DELETE is no longer granted to `authenticated` (it would
--     skip the tombstone and leave teammates' views stale) and 241's
--     delete policy is dropped. The PDPL erase (241, definer) and the
--     service role still delete rows outright, tombstones included.
--   * Bells and pushes: the tombstone removes the note's
--     chat_note_mention bells and every push of them, as 241's delete
--     did (conversation_notes_sync_bells).
--   * conversation_notes_select still returns a tombstone to whoever
--     sees the chat: Realtime checks the new row against it, so hiding
--     tombstones would mean the UPDATE is never delivered. A tombstone
--     carries no text. Every reader excludes `deleted_at IS NOT NULL`:
--     the thread's list (use-conversation-notes.ts) and the PDPL export
--     below. Nothing else reads the table (notes-isolation.test.ts).
--   * No purge: no existing daily sweep touches notes or retention, and
--     a new background job is not added for an empty row.
--
-- RESTATES 241's conversation_notes_before_update,
-- conversation_notes_sync_bells and privacy_conversation_notes_export,
-- and revokes the DELETE grant 241 makes: apply in order, once.
-- Re-running 241 reverts them; re-run 332 after it.
-- ============================================================

DO $$
BEGIN
  IF to_regclass('public.conversation_notes') IS NULL THEN
    RAISE EXCEPTION '332: apply 241_conversation_notes.sql first';
  END IF;
END $$;

-- ---------- 1. The column and the body rule ----------

ALTER TABLE public.conversation_notes
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- 241's rule for a live note; a tombstone's body is exactly ''.
ALTER TABLE public.conversation_notes
  DROP CONSTRAINT IF EXISTS conversation_notes_body_check;
ALTER TABLE public.conversation_notes
  ADD CONSTRAINT conversation_notes_body_check
    CHECK (CASE WHEN deleted_at IS NULL
                THEN body !~ '^[[:space:]]*$' AND char_length(body) <= 4000
                ELSE body = '' AND cardinality(mention_ids) = 0
           END);

COMMENT ON COLUMN public.conversation_notes.deleted_at IS
  'Set when the author deletes the note; body and mention_ids are cleared in the same UPDATE so Realtime can deliver the delete to open chats. Readers exclude these rows. Migration 332.';

-- ---------- 2. The tombstone (RESTATES 241) ----------

-- Everything but the body is frozen; an edited body is stamped. Setting
-- deleted_at makes a tombstone; a tombstone changes no more.
CREATE OR REPLACE FUNCTION public.conversation_notes_before_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'This note was deleted' USING ERRCODE = '22023';
  END IF;
  NEW.id := OLD.id;
  NEW.account_id := OLD.account_id;
  NEW.conversation_id := OLD.conversation_id;
  NEW.author_id := OLD.author_id;
  NEW.created_at := OLD.created_at;
  IF NEW.deleted_at IS NOT NULL THEN
    NEW.deleted_at := now();
    NEW.body := '';
    NEW.mention_ids := '{}'::uuid[];
    NEW.edited_at := OLD.edited_at;
    RETURN NEW;
  END IF;
  NEW.mention_ids := OLD.mention_ids;
  IF NEW.body IS DISTINCT FROM OLD.body THEN
    NEW.edited_at := now();
  ELSE
    NEW.edited_at := OLD.edited_at;
  END IF;
  RETURN NEW;
END $$;

-- An edit rewrites the quote in the note's bells and their unsent
-- pushes; a delete (now the tombstone, or the erase's hard delete)
-- removes the bells and every push of them, sent ones included.
CREATE OR REPLACE FUNCTION public.conversation_notes_sync_bells()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_gone    boolean := TG_OP = 'DELETE';
  v_note    uuid := OLD.id;
  v_account uuid := OLD.account_id;
BEGIN
  IF NOT v_gone THEN
    v_gone := NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL;
  END IF;
  IF v_gone THEN
    DELETE FROM public.push_outbox o
     USING public.notifications n
     WHERE n.account_id = v_account
       AND n.type = 'chat_note_mention'
       AND n.meta->>'note_id' = v_note::text
       AND o.account_id = v_account
       AND o.tag = 'bell:' || n.id::text;
    DELETE FROM public.notifications n
     WHERE n.account_id = v_account
       AND n.type = 'chat_note_mention'
       AND n.meta->>'note_id' = v_note::text;
    RETURN NULL;
  END IF;
  IF NEW.body IS DISTINCT FROM OLD.body THEN
    UPDATE public.push_outbox o
       SET body = left(NEW.body, 140)
      FROM public.notifications n
     WHERE n.account_id = NEW.account_id
       AND n.type = 'chat_note_mention'
       AND n.meta->>'note_id' = NEW.id::text
       AND o.account_id = NEW.account_id
       AND o.tag = 'bell:' || n.id::text
       AND o.sent_at IS NULL;
    UPDATE public.notifications n
       SET body = left(NEW.body, 140)
     WHERE n.account_id = NEW.account_id
       AND n.type = 'chat_note_mention'
       AND n.meta->>'note_id' = NEW.id::text;
  END IF;
  RETURN NULL;
END $$;

-- 241 fires this only on UPDATE OF body; a delete names deleted_at.
DROP TRIGGER IF EXISTS conversation_notes_sync_bells_update ON public.conversation_notes;
CREATE TRIGGER conversation_notes_sync_bells_update
  AFTER UPDATE OF body, deleted_at ON public.conversation_notes
  FOR EACH ROW EXECUTE FUNCTION public.conversation_notes_sync_bells();

REVOKE ALL ON FUNCTION public.conversation_notes_before_update(),
  public.conversation_notes_sync_bells()
FROM PUBLIC, anon, authenticated;

-- ---------- 3. Grants: delete is an UPDATE of deleted_at ----------

DROP POLICY IF EXISTS conversation_notes_delete ON public.conversation_notes;
REVOKE DELETE ON public.conversation_notes FROM authenticated;
GRANT UPDATE (body, deleted_at) ON public.conversation_notes TO authenticated;

-- ---------- 4. PDPL export: tombstones carry nothing (RESTATES 241) ----------

-- The erase (241) is unchanged: it deletes every row of the contact's
-- chats, tombstones included.
CREATE OR REPLACE FUNCTION public.privacy_conversation_notes_export(p_account uuid, p_contact uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'conversation_id', n.conversation_id, 'body', n.body,
           'created_at', n.created_at, 'edited_at', n.edited_at) ORDER BY n.created_at), '[]'::jsonb)
    FROM public.conversation_notes n
    JOIN public.conversations c ON c.id = n.conversation_id
   WHERE n.account_id = p_account AND c.account_id = p_account AND c.contact_id = p_contact
     AND n.deleted_at IS NULL
$$;

REVOKE ALL ON FUNCTION public.privacy_conversation_notes_export(uuid, uuid)
FROM PUBLIC, anon, authenticated, service_role;
