-- ============================================================
-- 085: tasks — one shared to-do list for people and the modules
--
-- Until now a follow-up lived in someone's head or in a chat note.
-- `tasks` is one table for both kinds of writer:
--
--   * people create them by hand ("Create task" on a conversation
--     card or the contact panel): source 'manual' or 'chat', always
--     with created_by = themselves;
--   * modules create them on the service role: a missed call on the
--     PBX ('pbx'), the journey bot's advisor tasks ('journey'),
--     automations ('automation'). Those carry a source_ref, and
--     UNIQUE (account_id, source, source_ref) makes a redelivered
--     webhook or outbox item a no-op instead of a second task
--     (lib/tasks/system.ts createSystemTask). It is a plain UNIQUE,
--     not a partial index: NULL refs never collide anyway, and a
--     partial index cannot be the target of PostgREST's on_conflict.
--
-- Who sees a task (tasks_select): admins and owners every task in the
-- account; anyone the task is assigned to or who created it; anyone
-- who can see its contact (can_view_contact, 072 — so a task follows
-- the customer the way chats do); a team leader the tasks of the
-- people they lead. Allocation, pins and channels grant nothing here.
-- Writing one: agents and up, on tasks they hold or created (leaders
-- also their team's, admins all). Deleting: the creator of a task a
-- person made, or an admin. The service role bypasses RLS and is how
-- system tasks are written.
--
-- tasks_guard (BEFORE INSERT/UPDATE) is the integrity the policies
-- cannot express, and it holds for every writer, the service role
-- included: the contact, conversation and deal belong to the task's
-- account; the assignee is an active staff member of it (an
-- owner/admin/team_leader/agent profile with no deactivated_at —
-- named positively so a later non-staff role is excluded without a
-- change here); account_id, kind, source, source_ref and created_by
-- never change after insert (except an FK's ON DELETE SET NULL when
-- the person's login is deleted); completed_at / completed_by are
-- stamped when the status leaves 'open' and cleared when it returns.
--
-- Assigning a task to someone else rings their bell
-- (tasks_notify_assigned, type 'task_assigned'). Assigning it to
-- yourself does not; a service-role write (no auth.uid()) always
-- counts as someone else. The notifications type CHECK is rebuilt
-- once here with every kind the planned modules need (077 is the last
-- list; every value is kept), so each module does not redefine it.
--
-- tasks joins the supabase_realtime publication when it exists.
--
-- Re-runnable: CREATE … IF NOT EXISTS, guarded constraints,
-- CREATE OR REPLACE, DROP … IF EXISTS.
-- ============================================================

SET lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. The table
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  kind            text NOT NULL,
  title           text NOT NULL,
  note            text NULL,
  contact_id      uuid NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  conversation_id uuid NULL REFERENCES public.conversations(id) ON DELETE SET NULL,
  deal_id         uuid NULL REFERENCES public.deals(id) ON DELETE SET NULL,
  assigned_to     uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  due_at          timestamptz NULL,
  status          text NOT NULL DEFAULT 'open',
  source          text NOT NULL DEFAULT 'manual',
  source_ref      text NULL,
  meta            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by      uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz NULL,
  completed_by    uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT tasks_kind_check CHECK (
    kind IN ('manual', 'callback', 'missed_call', 'journey', 'follow_up')),
  CONSTRAINT tasks_status_check CHECK (
    status IN ('open', 'done', 'cancelled')),
  CONSTRAINT tasks_source_check CHECK (
    source IN ('manual', 'pbx', 'journey', 'chat', 'automation')),
  CONSTRAINT tasks_title_check CHECK (
    btrim(title) <> '' AND char_length(title) <= 300),
  CONSTRAINT tasks_note_check CHECK (
    note IS NULL OR char_length(note) <= 4000),
  CONSTRAINT tasks_meta_check CHECK (jsonb_typeof(meta) = 'object'),
  CONSTRAINT tasks_source_ref_key UNIQUE (account_id, source, source_ref)
);

-- "My open tasks, soonest first" — the bell and the task list.
CREATE INDEX IF NOT EXISTS tasks_assignee_open_idx
  ON public.tasks (assigned_to, due_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS tasks_contact_idx
  ON public.tasks (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_account_status_idx
  ON public.tasks (account_id, status, due_at);
-- The two ON DELETE SET NULL references, and the conversation card.
CREATE INDEX IF NOT EXISTS tasks_conversation_idx
  ON public.tasks (conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_deal_idx
  ON public.tasks (deal_id) WHERE deal_id IS NOT NULL;

COMMENT ON TABLE public.tasks IS
  'Follow-ups for people: created by hand (source manual/chat) or by modules on the service role (pbx/journey/automation, idempotent on source_ref). Migration 085; docs/tasks.md.';
COMMENT ON COLUMN public.tasks.source_ref IS
  'The creating module''s own id for the event (a call id, an outbox item id). UNIQUE per (account_id, source).';

-- ------------------------------------------------------------
-- 2. Integrity (every writer, the service role included)
-- ------------------------------------------------------------

-- SECURITY DEFINER: the account checks must see the contact,
-- conversation, deal and profile whatever the caller's RLS hands them
-- (a service-role job has no auth.uid() at all).
CREATE OR REPLACE FUNCTION public.tasks_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.title := btrim(NEW.title);
  NEW.note := NULLIF(btrim(NEW.note), '');
  NEW.updated_at := now();

  IF TG_OP = 'UPDATE' THEN
    IF NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.source IS DISTINCT FROM OLD.source
       OR NEW.source_ref IS DISTINCT FROM OLD.source_ref THEN
      RAISE EXCEPTION 'A task''s account, kind and source cannot be changed'
        USING ERRCODE = 'check_violation';
    END IF;
    -- created_by may only lose its value to the FK's ON DELETE SET NULL,
    -- i.e. when that login no longer exists.
    IF NEW.created_by IS DISTINCT FROM OLD.created_by
       AND NOT (NEW.created_by IS NULL
                AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = OLD.created_by)) THEN
      RAISE EXCEPTION 'A task''s creator cannot be changed'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.contact_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.contact_id IS DISTINCT FROM OLD.contact_id)
     AND NOT EXISTS (SELECT 1 FROM contacts c
                      WHERE c.id = NEW.contact_id AND c.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'The contact does not belong to this task''s account'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.conversation_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id)
     AND NOT EXISTS (SELECT 1 FROM conversations cv
                      WHERE cv.id = NEW.conversation_id AND cv.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'The conversation does not belong to this task''s account'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.deal_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.deal_id IS DISTINCT FROM OLD.deal_id)
     AND NOT EXISTS (SELECT 1 FROM deals d
                      WHERE d.id = NEW.deal_id AND d.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'The deal does not belong to this task''s account'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Checked when it changes: a task whose assignee was deactivated
  -- later stays editable, so it can be completed or handed on.
  IF NEW.assigned_to IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.assigned_to IS DISTINCT FROM OLD.assigned_to)
     AND NOT EXISTS (SELECT 1 FROM profiles p
                      WHERE p.user_id = NEW.assigned_to
                        AND p.account_id = NEW.account_id
                        AND p.deactivated_at IS NULL
                        AND p.account_role IN ('owner', 'admin', 'team_leader', 'agent')) THEN
    RAISE EXCEPTION 'A task can only be assigned to an active staff member of its account'
      USING ERRCODE = 'check_violation';
  END IF;

  -- completed_at / completed_by are trigger-owned.
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'open' THEN
      NEW.completed_at := NULL;
      NEW.completed_by := NULL;
    ELSE
      NEW.completed_at := now();
      NEW.completed_by := auth.uid();
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'open' THEN
      NEW.completed_at := NULL;
      NEW.completed_by := NULL;
    ELSE
      NEW.completed_at := now();
      NEW.completed_by := auth.uid();
    END IF;
  ELSE
    NEW.completed_at := OLD.completed_at;
    -- Again, only the FK's SET NULL may clear it.
    IF NOT (NEW.completed_by IS NULL
            AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = OLD.completed_by)) THEN
      NEW.completed_by := OLD.completed_by;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tasks_guard ON public.tasks;
CREATE TRIGGER tasks_guard
  BEFORE INSERT OR UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.tasks_guard();

-- ------------------------------------------------------------
-- 3. Row-level security
-- ------------------------------------------------------------

-- can_view_contact (072) takes the contact's owner, which the task row
-- does not carry. DEFINER so the lookup is not filtered a second time
-- by contacts' own RLS; can_view_contact itself still judges the caller.
CREATE OR REPLACE FUNCTION public.can_view_task_contact(p_account_id uuid, p_contact_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM contacts c
     WHERE c.id = p_contact_id
       AND c.account_id = p_account_id
       AND can_view_contact(c.account_id, c.id, c.user_id)
  );
$$;

REVOKE ALL ON FUNCTION public.can_view_task_contact(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_view_task_contact(uuid, uuid) TO authenticated, service_role;

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tasks_select ON public.tasks;
CREATE POLICY tasks_select ON public.tasks FOR SELECT TO authenticated
  USING (
    account_id = (SELECT current_account_id())
    AND (
      (SELECT current_role_rank()) >= 4
      OR assigned_to = (SELECT auth.uid())
      OR created_by = (SELECT auth.uid())
      OR (contact_id IS NOT NULL AND can_view_task_contact(account_id, contact_id))
      OR ((SELECT current_role_rank()) = 3 AND leads_teammate(account_id, assigned_to))
    )
  );

DROP POLICY IF EXISTS tasks_insert ON public.tasks;
CREATE POLICY tasks_insert ON public.tasks FOR INSERT TO authenticated
  WITH CHECK (
    account_id = (SELECT current_account_id())
    AND (SELECT current_role_rank()) >= 2
    AND created_by = (SELECT auth.uid())
    AND source IN ('manual', 'chat')
    AND (contact_id IS NULL OR can_view_task_contact(account_id, contact_id))
  );

-- WITH CHECK stays at the account: handing a task to someone else is
-- allowed (tasks_guard vets the assignee). Postgres still requires the
-- new row to pass tasks_select, so nobody can write a task out of
-- their own sight.
DROP POLICY IF EXISTS tasks_update ON public.tasks;
CREATE POLICY tasks_update ON public.tasks FOR UPDATE TO authenticated
  USING (
    account_id = (SELECT current_account_id())
    AND (SELECT current_role_rank()) >= 2
    AND (
      (SELECT current_role_rank()) >= 4
      OR assigned_to = (SELECT auth.uid())
      OR created_by = (SELECT auth.uid())
      OR ((SELECT current_role_rank()) = 3 AND leads_teammate(account_id, assigned_to))
    )
  )
  WITH CHECK (
    account_id = (SELECT current_account_id())
    AND (SELECT current_role_rank()) >= 2
  );

DROP POLICY IF EXISTS tasks_delete ON public.tasks;
CREATE POLICY tasks_delete ON public.tasks FOR DELETE TO authenticated
  USING (
    account_id = (SELECT current_account_id())
    AND (
      (SELECT current_role_rank()) >= 4
      OR ((SELECT current_role_rank()) >= 2
          AND created_by = (SELECT auth.uid())
          AND source IN ('manual', 'chat'))
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tasks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tasks TO service_role;
REVOKE ALL ON public.tasks FROM anon;

-- ------------------------------------------------------------
-- 4. The bell: every planned kind, once
-- ------------------------------------------------------------
ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'conversation_assigned',
    'channel_disconnected',
    'channel_reconnected',
    'team_activity_alert',
    'ai_handoff',
    'task_assigned',
    'task_due',
    'chat_mention',
    'chat_dm',
    'chat_thread_reply',
    'chat_broadcast',
    'call_missed',
    'callback_requested',
    'deal_room_join_request',
    'deal_room_update'
  ));

-- Mirrors notify_conversation_assigned (027): DEFINER because
-- notifications has no INSERT policy, and a failure is logged and
-- swallowed — a missed bell must never undo the task write.
CREATE OR REPLACE FUNCTION public.tasks_notify_assigned()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.assigned_to IS NULL OR NEW.status <> 'open' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.assigned_to IS NOT DISTINCT FROM OLD.assigned_to THEN
    RETURN NEW;
  END IF;
  -- Assigning yourself is not news. No auth.uid() (a module on the
  -- service role) is someone else.
  IF auth.uid() IS NOT NULL AND auth.uid() = NEW.assigned_to THEN
    RETURN NEW;
  END IF;

  INSERT INTO notifications (
    account_id, user_id, type, conversation_id, contact_id,
    actor_user_id, title, body
  ) VALUES (
    NEW.account_id,
    NEW.assigned_to,
    'task_assigned',
    NEW.conversation_id,
    NEW.contact_id,
    auth.uid(),
    NEW.title,
    CASE WHEN NEW.due_at IS NOT NULL THEN
      'Due ' || to_char(NEW.due_at AT TIME ZONE 'UTC', 'DD Mon YYYY HH24:MI') || ' UTC'
    END
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to create the assignment notification for task %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tasks_notify_assigned ON public.tasks;
CREATE TRIGGER tasks_notify_assigned
  AFTER INSERT OR UPDATE OF assigned_to ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.tasks_notify_assigned();

-- Trigger functions are not for calling.
REVOKE ALL ON FUNCTION public.tasks_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tasks_notify_assigned() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 5. Realtime
-- ------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public' AND tablename = 'tasks'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.tasks;
  END IF;
END
$$;

RESET lock_timeout;
