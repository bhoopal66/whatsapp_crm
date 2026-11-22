-- ============================================================
-- 241: In-chat notes and @mentions
--
-- A note is a line the team writes inside a WhatsApp chat for each
-- other: "called him, he wants the business account", "@Sara can you
-- take this one?". It sits in the thread between the messages, with
-- its author and time, and is never sent to the customer.
--
-- Notes live in a table of their own, `conversation_notes`, for the
-- reason 061 gave `conversation_events` one: `messages` feed the AI's
-- context, unread counts, the dashboard aggregates, the outbound
-- webhooks and the public API, and a note must reach none of them.
-- Nothing that reads `messages` is touched here, so a note cannot leak
-- through any of them (src/lib/inbox/notes-isolation.test.ts pins it).
--
--   * Who reads: whoever can see the chat. The SELECT policy is 061's
--     conversation_events_select: the sub-select on conversations runs
--     under conversations' own RLS (042 … 217, personal chats from 191,
--     coordinator shares from 133), so a note is visible exactly when
--     its chat is.
--   * Who writes: agent and up who can see the chat, as themselves.
--     Clients INSERT directly; a BEFORE trigger stamps the author and
--     the account, and the policy's WITH CHECK re-checks both plus the
--     chat's visibility. Only the body can be changed afterwards
--     (column grants), only by its author, and `edited_at` is stamped.
--     Only the author deletes. Viewers and bank guests write nothing.
--   * Body: non-blank (`~ '^[[:space:]]*$'`, never btrim: a tab or a
--     newline passes btrim) and at most 4000 characters.
--   * @mentions: the client sends `mention_ids` with the INSERT. The
--     BEFORE trigger keeps only live staff of the workspace who can see
--     this chat, never the author, each once; the AFTER trigger rings
--     each of them once with a `chat_note_mention` bell. They are frozen
--     after the insert, so editing a note never rings again.
--     conversation_note_mention_candidates() lists who may be mentioned.
--   * "Can person X see chat Y" for an explicit X is
--     conversation_note_user_can_see(), written over 190's
--     can_view_conversation_for_user (the push path's explicit-user
--     mirror) plus 191's personal-chat rule. It leaves out coordinator
--     shares (133), so a coordinator who sees a chat only through a share
--     is not offered as a mention, and a mention of them rings nothing.
--   * The bell: 205's `notifications_type_check` gains
--     `chat_note_mention`, read from the live constraint and recreated,
--     never restated. push_bell_url (109/133/173/188/205) is not changed
--     here: until it lists the type its push opens /notifications; the
--     bell itself opens the chat (hrefFor in lib/notifications/target.ts).
--   * PDPL: notes are about a customer, so they register an export and
--     an erase in 229's privacy_extensions rather than restating 221 or
--     222.
--
-- Idempotent: safe to re-run. Needs 229 (privacy_extensions).
-- ============================================================

DO $$
BEGIN
  IF to_regclass('public.privacy_extensions') IS NULL THEN
    RAISE EXCEPTION '241: apply 229_desk_customer_contacts.sql first (privacy_extensions)';
  END IF;
END $$;

-- ---------- 1. The table ----------

CREATE TABLE IF NOT EXISTS public.conversation_notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  author_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  body            text NOT NULL,
  -- Who was mentioned and rung, as kept by the BEFORE INSERT trigger.
  mention_ids     uuid[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  edited_at       timestamptz,
  CONSTRAINT conversation_notes_body_check
    CHECK (body !~ '^[[:space:]]*$' AND char_length(body) <= 4000)
);

CREATE INDEX IF NOT EXISTS idx_conversation_notes_conversation
  ON public.conversation_notes (conversation_id, created_at);

COMMENT ON TABLE public.conversation_notes IS
  'Team notes inside a chat (migration 241). Never sent to the customer and never a message: not in AI context, unread counts, webhooks, the public API or message aggregates. Visible exactly when the chat is.';

-- ---------- 2. Who can see a chat, for an explicit person ----------

CREATE OR REPLACE FUNCTION public.conversation_note_user_can_see(p_user uuid, p_conversation uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_user IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.conversations c
      JOIN public.profiles p
        ON p.user_id = p_user
       AND p.account_id = c.account_id
       AND p.deactivated_at IS NULL
       AND p.account_role <> 'bank_guest'
     WHERE c.id = p_conversation
       AND CASE
             WHEN c.personal_owner_id IS NULL THEN
               public.can_view_conversation_for_user(
                 p_user, c.account_id, c.user_id, c.assigned_agent_id, c.channel_id)
             -- 191's can_view_personal_chat, for an explicit person.
             ELSE p.account_role IN ('owner', 'admin')
               OR c.personal_owner_id = p_user
               OR (p.account_role = 'team_leader' AND EXISTS (
                     SELECT 1 FROM public.teams t
                       JOIN public.team_members tm ON tm.team_id = t.id
                      WHERE t.account_id = c.account_id
                        AND t.leader_user_id = p_user
                        AND tm.user_id = c.personal_owner_id))
           END
  )
$$;

REVOKE ALL ON FUNCTION public.conversation_note_user_can_see(uuid, uuid) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.conversation_note_user_can_see(uuid, uuid) IS
  'Can this live staff person see this chat? 190''s can_view_conversation_for_user plus 191''s personal-chat rule; no coordinator shares. Private: the note triggers and the mention list use it. Migration 241.';

-- ---------- 3. Triggers ----------

-- Stamp the author and the account; keep only mentions that may ring.
CREATE OR REPLACE FUNCTION public.conversation_notes_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.author_id := auth.uid();
  NEW.created_at := now();
  NEW.edited_at := NULL;
  SELECT c.account_id INTO NEW.account_id FROM public.conversations c WHERE c.id = NEW.conversation_id;
  NEW.mention_ids := coalesce((
    SELECT array_agg(DISTINCT m)
      FROM unnest(coalesce(NEW.mention_ids, '{}'::uuid[])) AS m
     WHERE m IS DISTINCT FROM NEW.author_id
       AND public.conversation_note_user_can_see(m, NEW.conversation_id)
  ), '{}'::uuid[]);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS conversation_notes_before_insert ON public.conversation_notes;
CREATE TRIGGER conversation_notes_before_insert
  BEFORE INSERT ON public.conversation_notes
  FOR EACH ROW EXECUTE FUNCTION public.conversation_notes_before_insert();

-- Everything but the body is frozen; an edited body is stamped.
CREATE OR REPLACE FUNCTION public.conversation_notes_before_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.id := OLD.id;
  NEW.account_id := OLD.account_id;
  NEW.conversation_id := OLD.conversation_id;
  NEW.author_id := OLD.author_id;
  NEW.mention_ids := OLD.mention_ids;
  NEW.created_at := OLD.created_at;
  IF NEW.body IS DISTINCT FROM OLD.body THEN
    NEW.edited_at := now();
  ELSE
    NEW.edited_at := OLD.edited_at;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS conversation_notes_before_update ON public.conversation_notes;
CREATE TRIGGER conversation_notes_before_update
  BEFORE UPDATE ON public.conversation_notes
  FOR EACH ROW EXECUTE FUNCTION public.conversation_notes_before_update();

-- One bell per mentioned person. Like 087's chat bells it carries the
-- start of the text; a failure never fails the note.
CREATE OR REPLACE FUNCTION public.conversation_notes_ring_mentions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_author  text;
  v_contact uuid;
BEGIN
  IF cardinality(NEW.mention_ids) = 0 THEN
    RETURN NULL;
  END IF;
  SELECT coalesce(nullif(btrim(p.full_name), ''), 'A teammate') INTO v_author
    FROM public.profiles p
   WHERE p.user_id = NEW.author_id AND p.account_id = NEW.account_id;
  SELECT c.contact_id INTO v_contact FROM public.conversations c WHERE c.id = NEW.conversation_id;
  INSERT INTO public.notifications
    (account_id, user_id, type, conversation_id, contact_id, actor_user_id, title, body, meta)
  SELECT NEW.account_id, m, 'chat_note_mention', NEW.conversation_id, v_contact, NEW.author_id,
         coalesce(v_author, 'A teammate') || ' mentioned you in a note',
         left(NEW.body, 140),
         jsonb_build_object('note_id', NEW.id, 'author', NEW.author_id)
    FROM unnest(NEW.mention_ids) AS m;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'conversation notes: mention bells for note % failed: %', NEW.id, SQLERRM;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS conversation_notes_ring_mentions ON public.conversation_notes;
CREATE TRIGGER conversation_notes_ring_mentions
  AFTER INSERT ON public.conversation_notes
  FOR EACH ROW EXECUTE FUNCTION public.conversation_notes_ring_mentions();

REVOKE ALL ON FUNCTION public.conversation_notes_before_insert(),
  public.conversation_notes_before_update(),
  public.conversation_notes_ring_mentions()
FROM PUBLIC, anon, authenticated;

-- ---------- 4. Row-level security and grants ----------

ALTER TABLE public.conversation_notes ENABLE ROW LEVEL SECURITY;

-- 061's conversation_events_select: visible exactly when the chat is.
DROP POLICY IF EXISTS conversation_notes_select ON public.conversation_notes;
CREATE POLICY conversation_notes_select ON public.conversation_notes
  FOR SELECT USING (
    account_id = (SELECT public.current_account_id())
    AND EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_notes.conversation_id
    )
  );

DROP POLICY IF EXISTS conversation_notes_insert ON public.conversation_notes;
CREATE POLICY conversation_notes_insert ON public.conversation_notes
  FOR INSERT WITH CHECK (
    author_id = auth.uid()
    AND account_id = (SELECT public.current_account_id())
    AND public.is_account_member(account_id, 'agent')
    AND EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_notes.conversation_id
    )
  );

DROP POLICY IF EXISTS conversation_notes_update ON public.conversation_notes;
CREATE POLICY conversation_notes_update ON public.conversation_notes
  FOR UPDATE
  USING (
    author_id = auth.uid()
    AND account_id = (SELECT public.current_account_id())
    AND public.is_account_member(account_id, 'agent')
    AND EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = conversation_notes.conversation_id)
  )
  WITH CHECK (author_id = auth.uid());

DROP POLICY IF EXISTS conversation_notes_delete ON public.conversation_notes;
CREATE POLICY conversation_notes_delete ON public.conversation_notes
  FOR DELETE USING (
    author_id = auth.uid()
    AND account_id = (SELECT public.current_account_id())
    AND public.is_account_member(account_id, 'agent')
    AND EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = conversation_notes.conversation_id)
  );

REVOKE ALL ON public.conversation_notes FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON public.conversation_notes TO authenticated;
GRANT INSERT (conversation_id, body, mention_ids) ON public.conversation_notes TO authenticated;
GRANT UPDATE (body) ON public.conversation_notes TO authenticated;
GRANT ALL ON public.conversation_notes TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND tablename = 'conversation_notes'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.conversation_notes;
  END IF;
END $$;

-- ---------- 5. Who may be mentioned ----------

-- Live staff of the caller's active workspace who can see this chat,
-- not the caller. The caller must see the chat (the same reach as the
-- SELECT policy: admin, the explicit-person rule, or a coordinator
-- share) and be agent and up; otherwise the list is empty.
CREATE OR REPLACE FUNCTION public.conversation_note_mention_candidates(p_conversation_id uuid)
RETURNS TABLE (user_id uuid, full_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.user_id, p.full_name
    FROM public.conversations c
    JOIN public.profiles p
      ON p.account_id = c.account_id
     AND p.deactivated_at IS NULL
     AND p.account_role <> 'bank_guest'
   WHERE c.id = p_conversation_id
     AND auth.uid() IS NOT NULL
     AND c.account_id = public.current_account_id()
     AND public.is_account_member(c.account_id, 'agent')
     AND (public.current_role_rank() >= 4
          OR public.conversation_note_user_can_see(auth.uid(), c.id)
          OR public.coordinator_share_grants(c.id))
     AND p.user_id <> auth.uid()
     AND public.conversation_note_user_can_see(p.user_id, c.id)
   ORDER BY lower(p.full_name), p.user_id
$$;

REVOKE ALL ON FUNCTION public.conversation_note_mention_candidates(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.conversation_note_mention_candidates(uuid) TO authenticated;

COMMENT ON FUNCTION public.conversation_note_mention_candidates(uuid) IS
  'Who an @mention in this chat''s notes can ring: live staff of the active workspace who can see the chat, not the caller. Empty unless the caller is agent and up and sees the chat. Migration 241.';

-- ---------- 6. The bell type ----------

-- 205's list plus chat_note_mention, read from the live constraint so
-- a later migration's types are kept.
DO $$
DECLARE
  v_def   text;
  v_types text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.notifications'::regclass AND conname = 'notifications_type_check';
  IF v_def IS NULL THEN
    RAISE EXCEPTION '241: notifications_type_check not found';
  END IF;
  IF v_def LIKE '%''chat_note_mention''%' THEN
    RETURN;
  END IF;
  SELECT array_agg(m[1] ORDER BY ord) INTO v_types
    FROM regexp_matches(v_def, '''([a-z0-9_]+)''', 'g') WITH ORDINALITY AS x(m, ord);
  v_types := v_types || 'chat_note_mention'::text;
  ALTER TABLE public.notifications DROP CONSTRAINT notifications_type_check;
  EXECUTE format(
    'ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (%s)) NOT VALID',
    (SELECT string_agg(quote_literal(t), ', ') FROM unnest(v_types) AS t));
  ALTER TABLE public.notifications VALIDATE CONSTRAINT notifications_type_check;
END $$;

-- ---------- 7. PDPL: export and erase through privacy_extensions ----------

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
$$;

CREATE OR REPLACE FUNCTION public.privacy_conversation_notes_erase(p_account uuid, p_contact uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  DELETE FROM public.conversation_notes n
   USING public.conversations c
   WHERE c.id = n.conversation_id
     AND n.account_id = p_account AND c.account_id = p_account AND c.contact_id = p_contact;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('counts', jsonb_build_object('conversation_notes', v_n), 'objects', '[]'::jsonb);
END;
$$;

INSERT INTO public.privacy_extensions (name, export_fn, erase_fn, added_in)
VALUES ('conversation_notes', 'privacy_conversation_notes_export', 'privacy_conversation_notes_erase', '241')
ON CONFLICT (name) DO UPDATE SET export_fn = excluded.export_fn, erase_fn = excluded.erase_fn;

REVOKE ALL ON FUNCTION public.privacy_conversation_notes_export(uuid, uuid),
  public.privacy_conversation_notes_erase(uuid, uuid)
FROM PUBLIC, anon, authenticated, service_role;
