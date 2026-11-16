-- ============================================================
-- 200_hr_workflows.sql — HR workflows on the HR inbox (192).
--
-- Port of package release 023 (023a_hr, 023b_workflows) onto the real
-- wacrm chats. The HR inbox splits in two:
--   recruiter — candidates, moved through four ordered stages
--               (cv_review < ai_interview < hr_interview < manager_interview);
--   dept      — employees, tagged with one topic.
--
--   1. Tables: hr_team_members (who works which HR inbox, lead|member),
--      hr_conversations (ONE row per chat, PK = conversation_id),
--      hr_stage_history (append-only), hr_workflow_rules (per account,
--      seeded by hr_seed_rules: 11 rules).
--   2. Visibility is unchanged. HR team membership grants NO chat
--      visibility: every HR action also needs the caller to see the chat
--      under the conversations_select predicate of 191 (hr_can_see). A
--      chat the caller cannot see, or of another account, is NOT_FOUND.
--      The SELECT policies reach hr_conversations through an EXISTS on
--      conversations, which runs under the caller's conversations RLS.
--   3. The owner is the chat's assignment (conversations.assigned_agent_id;
--      unassigned → conversations.user_id). No HR owner column.
--   4. Rules create public.tasks rows (085; source 'automation', kind
--      'follow_up', source_ref 'hr:<conversation>:<rule key>:<event>',
--      unique per account+source → ON CONFLICT DO NOTHING is the dedupe)
--      or set a flag. They never message anyone.
--      Firing: AFTER INSERT / AFTER UPDATE OF stage_key, topic, inbox,
--      guarded by pg_trigger_depth() so a rule's own flag write never
--      fires rules. Stage events are 'stage:<stage>:<n>', n = earlier
--      entries into that stage (history is written AFTER the row update,
--      so a retry creates nothing and a re-entry after a backward move
--      creates a new task); topic events 'topic:<topic>:<n>', n = entries
--      into the dept inbox including the current stay (hr_set_topic
--      writes its 'move' row before the update: once per stay). Closed
--      rows fire nothing.
--   5. Reply state comes from real messages: hr_messages_note (AFTER
--      INSERT ON messages) stamps last_inbound_at (customer) /
--      last_outbound_at (agent) monotonically; bot messages are ignored;
--      it can never fail a message insert. reply_state is generated:
--      new (no outbound), reply_due (inbound after outbound), waiting.
--   6. HR closure (closed_at + outcome) is separate from
--      conversations.status; inbound does not reopen it.
--   7. hr_sweep(p_now) — service role only, every account — fires
--      reply_overdue and no_activity once per triggering timestamp.
--
-- Refusals: RAISE … USING HINT = NOT_ALLOWED (42501) | NOT_FOUND (P0002)
-- | CLOSED | STAGE_UNKNOWN | NEEDS_REASON | INVALID (22023).
-- Re-runnable. No BEGIN/COMMIT.
-- ============================================================

SET lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. Tables
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.hr_team_members (
  account_id  uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  inbox       text NOT NULL,
  role        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid NULL,
  CONSTRAINT hr_team_members_pkey PRIMARY KEY (account_id, user_id, inbox),
  CONSTRAINT hr_team_members_inbox_check CHECK (inbox IN ('recruiter', 'dept')),
  CONSTRAINT hr_team_members_role_check CHECK (role IN ('lead', 'member'))
);

CREATE TABLE IF NOT EXISTS public.hr_conversations (
  conversation_id  uuid PRIMARY KEY REFERENCES public.conversations(id) ON DELETE CASCADE,
  account_id       uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  inbox            text NOT NULL,
  stage_key        text NULL,
  topic            text NULL,
  urgent           boolean NOT NULL DEFAULT false,
  upset            boolean NOT NULL DEFAULT false,
  last_inbound_at  timestamptz NULL,
  last_outbound_at timestamptz NULL,
  reply_state      text GENERATED ALWAYS AS (
                     CASE WHEN last_outbound_at IS NULL THEN 'new'
                          WHEN last_inbound_at IS NOT NULL
                               AND last_inbound_at > last_outbound_at THEN 'reply_due'
                          ELSE 'waiting' END) STORED,
  outcome          text NULL,
  closed_at        timestamptz NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hr_conversations_inbox_check CHECK (inbox IN ('recruiter', 'dept')),
  CONSTRAINT hr_conversations_stage_check CHECK (
    stage_key IS NULL
    OR stage_key IN ('cv_review', 'ai_interview', 'hr_interview', 'manager_interview')),
  CONSTRAINT hr_conversations_topic_check CHECK (
    topic IS NULL
    OR topic IN ('onboarding', 'visa_documents', 'leave_attendance', 'payroll', 'complaint', 'other')),
  CONSTRAINT hr_conversations_outcome_check CHECK (
    outcome IS NULL OR outcome IN ('hired', 'not_selected', 'withdrawn')),
  CONSTRAINT hr_conversations_one_inbox CHECK (
    (inbox = 'recruiter' AND topic IS NULL AND stage_key IS NOT NULL)
    OR (inbox = 'dept' AND stage_key IS NULL AND outcome IS NULL)),
  CONSTRAINT hr_conversations_outcome_closed CHECK (outcome IS NULL OR closed_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS hr_conversations_account_inbox_open_idx
  ON public.hr_conversations (account_id, inbox) WHERE closed_at IS NULL;

CREATE TABLE IF NOT EXISTS public.hr_stage_history (
  id              bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES public.hr_conversations(conversation_id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  event           text NOT NULL,
  from_stage      text NULL,
  to_stage        text NULL,
  from_inbox      text NULL,
  to_inbox        text NOT NULL,
  actor           uuid NULL,
  reason          text NULL,
  at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hr_stage_history_event_check CHECK (event IN ('open', 'stage', 'move', 'close', 'reopen')),
  CONSTRAINT hr_stage_history_inbox_check CHECK (
    (from_inbox IS NULL OR from_inbox IN ('recruiter', 'dept')) AND to_inbox IN ('recruiter', 'dept'))
);

CREATE INDEX IF NOT EXISTS hr_stage_history_conversation_idx
  ON public.hr_stage_history (conversation_id, id);

CREATE TABLE IF NOT EXISTS public.hr_workflow_rules (
  account_id    uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  key           text NOT NULL,
  inbox         text NOT NULL,
  trigger_kind  text NOT NULL,
  trigger_value text NULL,
  action        text NOT NULL,
  flag          text NULL,
  after_hours   integer NULL,
  due_hours     integer NULL,
  title         text NULL,
  enabled       boolean NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid NULL,
  CONSTRAINT hr_workflow_rules_pkey PRIMARY KEY (account_id, key),
  CONSTRAINT hr_workflow_rules_inbox_check CHECK (inbox IN ('recruiter', 'dept')),
  CONSTRAINT hr_workflow_rules_trigger_check CHECK (
    trigger_kind IN ('stage', 'topic', 'reply_overdue', 'no_activity')),
  CONSTRAINT hr_workflow_rules_action_check CHECK (action IN ('task', 'set_flag')),
  CONSTRAINT hr_workflow_rules_flag_check CHECK (flag IS NULL OR flag IN ('urgent', 'upset')),
  CONSTRAINT hr_workflow_rules_after_check CHECK (after_hours IS NULL OR after_hours BETWEEN 1 AND 720),
  CONSTRAINT hr_workflow_rules_due_check CHECK (due_hours IS NULL OR due_hours BETWEEN 0 AND 720),
  CONSTRAINT hr_workflow_rules_title_check CHECK (
    title IS NULL OR (title !~ '^[[:space:]]*$' AND char_length(title) <= 300)),
  CONSTRAINT hr_workflow_rules_shape CHECK (
    (trigger_kind IN ('stage', 'topic') AND trigger_value IS NOT NULL AND after_hours IS NULL)
    OR (trigger_kind IN ('reply_overdue', 'no_activity') AND trigger_value IS NULL AND after_hours IS NOT NULL)),
  CONSTRAINT hr_workflow_rules_action_shape CHECK (
    (action = 'task' AND title IS NOT NULL AND due_hours IS NOT NULL AND flag IS NULL)
    OR (action = 'set_flag' AND flag IS NOT NULL AND title IS NULL AND due_hours IS NULL))
);

COMMENT ON TABLE public.hr_conversations IS
  'HR tracking of one chat (recruiter stage or dept topic, flags, reply state, HR closure). Grants no visibility: the SELECT policy goes through the caller''s conversations RLS. Migration 200.';
COMMENT ON TABLE public.hr_workflow_rules IS
  'Per-account HR workflow rules (create a public.tasks row or set a flag; never send). Seeded by hr_seed_rules. Migration 200.';

-- ------------------------------------------------------------
-- 2. RLS, grants (no client writes on any of the four tables)
-- ------------------------------------------------------------

ALTER TABLE public.hr_team_members   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_conversations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_stage_history  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_workflow_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hr_team_members_select ON public.hr_team_members;
CREATE POLICY hr_team_members_select ON public.hr_team_members
  FOR SELECT USING (account_id = (SELECT current_account_id()));

DROP POLICY IF EXISTS hr_conversations_select ON public.hr_conversations;
CREATE POLICY hr_conversations_select ON public.hr_conversations
  FOR SELECT USING (
    account_id = (SELECT current_account_id())
    AND EXISTS (SELECT 1 FROM public.conversations c
                 WHERE c.id = hr_conversations.conversation_id));

DROP POLICY IF EXISTS hr_stage_history_select ON public.hr_stage_history;
CREATE POLICY hr_stage_history_select ON public.hr_stage_history
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.hr_conversations h
             WHERE h.conversation_id = hr_stage_history.conversation_id));

DROP POLICY IF EXISTS hr_workflow_rules_select ON public.hr_workflow_rules;
CREATE POLICY hr_workflow_rules_select ON public.hr_workflow_rules
  FOR SELECT USING (account_id = (SELECT current_account_id()));

REVOKE ALL ON public.hr_team_members, public.hr_conversations,
              public.hr_stage_history, public.hr_workflow_rules
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.hr_team_members, public.hr_conversations,
                public.hr_stage_history, public.hr_workflow_rules
  TO authenticated, service_role;
REVOKE ALL ON SEQUENCE public.hr_stage_history_id_seq
  FROM PUBLIC, anon, authenticated, service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
      AND tablename = 'hr_conversations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.hr_conversations;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 3. Internal helpers (not granted)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.hr_refuse(p_hint text, p_message text)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '%', p_message
    USING ERRCODE = CASE p_hint WHEN 'NOT_ALLOWED' THEN '42501'
                                WHEN 'NOT_FOUND' THEN 'P0002'
                                ELSE '22023' END,
          HINT = p_hint;
END;
$$;

-- Position of a stage in the fixed order; NULL for anything else.
CREATE OR REPLACE FUNCTION public.hr_stage_pos(p_stage text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT array_position(
    ARRAY['cv_review', 'ai_interview', 'hr_interview', 'manager_interview']::text[], p_stage)
$$;

-- Live staff (owner/admin/team_leader/agent, not deactivated) of an account.
CREATE OR REPLACE FUNCTION public.hr_is_live_staff(p_account uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_user IS NOT NULL AND EXISTS (
    SELECT 1 FROM profiles p
     WHERE p.user_id = p_user AND p.account_id = p_account
       AND p.deactivated_at IS NULL
       AND p.account_role IN ('owner', 'admin', 'team_leader', 'agent'))
$$;

-- 'admin' (live owner/admin of the account, both inboxes), else the
-- hr_team_members role while the person is live staff, else NULL.
CREATE OR REPLACE FUNCTION public.hr_role(p_account uuid, p_user uuid, p_inbox text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_user IS NULL OR p_account IS NULL THEN NULL
    WHEN EXISTS (SELECT 1 FROM profiles p
                  WHERE p.user_id = p_user AND p.account_id = p_account
                    AND p.deactivated_at IS NULL
                    AND p.account_role IN ('owner', 'admin')) THEN 'admin'
    WHEN hr_is_live_staff(p_account, p_user) THEN
      (SELECT m.role FROM hr_team_members m
        WHERE m.account_id = p_account AND m.user_id = p_user AND m.inbox = p_inbox)
    ELSE NULL END
$$;

-- The conversations_select predicate of 191, for the caller.
CREATE OR REPLACE FUNCTION public.hr_can_see(p_conversation_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT c.account_id = current_account_id()
           AND (current_role_rank() >= 4
                OR CASE WHEN c.personal_owner_id IS NULL
                        THEN can_view_conversation(c.account_id, c.user_id, c.assigned_agent_id,
                                                   c.channel_id, c.send_channel_id)
                        ELSE can_view_personal_chat(c.account_id, c.personal_owner_id)
                   END)
      FROM conversations c WHERE c.id = p_conversation_id), false)
$$;

-- Lock and return the caller's HR row: NOT_FOUND unless the caller can
-- see the chat and it has an HR row; NOT_ALLOWED unless the caller is
-- member/lead/admin of the row's current inbox.
CREATE OR REPLACE FUNCTION public.hr_load_for_write(p_conversation_id uuid)
RETURNS public.hr_conversations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  h hr_conversations;
BEGIN
  IF p_conversation_id IS NULL OR NOT hr_can_see(p_conversation_id) THEN
    PERFORM hr_refuse('NOT_FOUND', 'conversation not found');
  END IF;
  SELECT * INTO h FROM hr_conversations x WHERE x.conversation_id = p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM hr_refuse('NOT_FOUND', 'conversation is not tracked by HR');
  END IF;
  IF COALESCE(hr_role(h.account_id, auth.uid(), h.inbox), '') NOT IN ('member', 'lead', 'admin') THEN
    PERFORM hr_refuse('NOT_ALLOWED', format('you may not change this %s conversation', h.inbox));
  END IF;
  RETURN h;
END;
$$;

-- ------------------------------------------------------------
-- 4. Seed rules (idempotent)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.hr_seed_rules(p_account uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_account IS NULL THEN RETURN; END IF;
  INSERT INTO hr_workflow_rules
    (account_id, key, inbox, trigger_kind, trigger_value, action, flag, after_hours, due_hours, title)
  VALUES
    (p_account, 'stage_cv_review',         'recruiter', 'stage', 'cv_review',         'task', NULL, NULL, 24, 'Review CV'),
    (p_account, 'stage_ai_interview',      'recruiter', 'stage', 'ai_interview',      'task', NULL, NULL, 24, 'Send AI interview link'),
    (p_account, 'stage_hr_interview',      'recruiter', 'stage', 'hr_interview',      'task', NULL, NULL, 48, 'Schedule HR interview'),
    (p_account, 'stage_manager_interview', 'recruiter', 'stage', 'manager_interview', 'task', NULL, NULL, 48, 'Schedule manager interview'),
    (p_account, 'topic_payroll',           'dept',      'topic', 'payroll',           'task', NULL, NULL, 24, 'Check payroll query'),
    (p_account, 'topic_visa_documents',    'dept',      'topic', 'visa_documents',    'task', NULL, NULL, 48, 'Check visa or document request'),
    (p_account, 'topic_complaint_flag',    'dept',      'topic', 'complaint',         'set_flag', 'urgent', NULL, NULL, NULL),
    (p_account, 'topic_complaint_task',    'dept',      'topic', 'complaint',         'task', NULL, NULL, 4,  'Respond to complaint'),
    (p_account, 'reply_overdue_recruiter', 'recruiter', 'reply_overdue', NULL,        'task', NULL, 4,    0,  'Reply to customer'),
    (p_account, 'reply_overdue_dept',      'dept',      'reply_overdue', NULL,        'task', NULL, 4,    0,  'Reply to customer'),
    (p_account, 'no_activity_recruiter',   'recruiter', 'no_activity',   NULL,        'task', NULL, 72,   24, 'Chase candidate')
  ON CONFLICT (account_id, key) DO NOTHING;
END;
$$;

-- ------------------------------------------------------------
-- 5. Rule engine (not granted)
-- ------------------------------------------------------------

-- Apply one rule to one HR row. Returns 1 when a task was created, 0
-- when deduplicated (or for a flag).
CREATE OR REPLACE FUNCTION public.hr_apply_rule(
  p_rule public.hr_workflow_rules, p_conversation_id uuid, p_event text, p_now timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  cv conversations;
  v_assignee uuid;
  n integer;
BEGIN
  IF p_rule.action = 'set_flag' THEN
    UPDATE hr_conversations x
       SET urgent = CASE WHEN p_rule.flag = 'urgent' THEN true ELSE x.urgent END,
           upset  = CASE WHEN p_rule.flag = 'upset'  THEN true ELSE x.upset END
     WHERE x.conversation_id = p_conversation_id;
    RETURN 0;
  END IF;

  SELECT * INTO cv FROM conversations c WHERE c.id = p_conversation_id;
  IF NOT FOUND THEN RETURN 0; END IF;
  -- 085's tasks_guard refuses a non-staff assignee: check first.
  v_assignee := CASE
    WHEN hr_is_live_staff(cv.account_id, cv.assigned_agent_id) THEN cv.assigned_agent_id
    WHEN hr_is_live_staff(cv.account_id, cv.user_id) THEN cv.user_id
    ELSE NULL END;

  INSERT INTO tasks (account_id, kind, title, contact_id, conversation_id, assigned_to,
                     due_at, source, source_ref, meta, created_by)
  VALUES (cv.account_id, 'follow_up', p_rule.title, cv.contact_id, cv.id, v_assignee,
          p_now + make_interval(hours => p_rule.due_hours), 'automation',
          'hr:' || cv.id::text || ':' || p_rule.key || ':' || p_event,
          jsonb_build_object('hr_rule', p_rule.key, 'hr_inbox', p_rule.inbox), NULL)
  ON CONFLICT ON CONSTRAINT tasks_source_ref_key DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- Fire every enabled stage/topic rule of the row's account matching its
-- current inbox and stage/topic. Closed rows fire nothing.
CREATE OR REPLACE FUNCTION public.hr_fire_rules(p_conversation_id uuid, p_kind text, p_event text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  h hr_conversations;
  r hr_workflow_rules;
  v_created integer := 0;
BEGIN
  SELECT * INTO h FROM hr_conversations x WHERE x.conversation_id = p_conversation_id;
  IF NOT FOUND OR h.closed_at IS NOT NULL THEN RETURN 0; END IF;
  FOR r IN SELECT * FROM hr_workflow_rules w
            WHERE w.account_id = h.account_id AND w.enabled
              AND w.trigger_kind = p_kind AND w.inbox = h.inbox
              AND w.trigger_value = CASE p_kind WHEN 'stage' THEN h.stage_key ELSE h.topic END
            ORDER BY w.key
  LOOP
    v_created := v_created + hr_apply_rule(r, h.conversation_id, p_event, now());
  END LOOP;
  RETURN v_created;
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_conversations_fire()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n bigint;
BEGIN
  IF pg_trigger_depth() > 1 OR NEW.closed_at IS NOT NULL THEN RETURN NULL; END IF;
  IF NEW.stage_key IS NOT NULL THEN
    SELECT count(*) INTO n FROM hr_stage_history s
     WHERE s.conversation_id = NEW.conversation_id AND s.to_stage = NEW.stage_key
       AND s.event IN ('open', 'stage', 'move');
    PERFORM hr_fire_rules(NEW.conversation_id, 'stage', format('stage:%s:%s', NEW.stage_key, n));
  END IF;
  IF NEW.topic IS NOT NULL THEN
    SELECT count(*) INTO n FROM hr_stage_history s
     WHERE s.conversation_id = NEW.conversation_id AND s.to_inbox = 'dept'
       AND s.event IN ('open', 'move');
    PERFORM hr_fire_rules(NEW.conversation_id, 'topic', format('topic:%s:%s', NEW.topic, n));
  END IF;
  RETURN NULL;
END;
$$;

-- Integrity for every writer: account = the chat's, identity frozen.
CREATE OR REPLACE FUNCTION public.hr_conversations_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.account_id IS DISTINCT FROM OLD.account_id
          OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id) THEN
    RAISE EXCEPTION 'An HR row''s chat and account cannot be changed'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (
       SELECT 1 FROM conversations c
        WHERE c.id = NEW.conversation_id AND c.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'The HR row''s account must be its chat''s account'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS hr_conversations_guard ON public.hr_conversations;
CREATE TRIGGER hr_conversations_guard
  BEFORE INSERT OR UPDATE ON public.hr_conversations
  FOR EACH ROW EXECUTE FUNCTION public.hr_conversations_guard();

DROP TRIGGER IF EXISTS hr_conversations_fire_ins ON public.hr_conversations;
CREATE TRIGGER hr_conversations_fire_ins
  AFTER INSERT ON public.hr_conversations
  FOR EACH ROW EXECUTE FUNCTION public.hr_conversations_fire();

DROP TRIGGER IF EXISTS hr_conversations_fire_upd ON public.hr_conversations;
CREATE TRIGGER hr_conversations_fire_upd
  AFTER UPDATE OF stage_key, topic, inbox ON public.hr_conversations
  FOR EACH ROW EXECUTE FUNCTION public.hr_conversations_fire();

-- ------------------------------------------------------------
-- 6. Messages trigger: reply state from real messages
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.hr_messages_note()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.sender_type NOT IN ('customer', 'agent') THEN RETURN NULL; END IF;
  BEGIN
    UPDATE hr_conversations x
       SET last_inbound_at = CASE WHEN NEW.sender_type = 'customer'
                                  THEN GREATEST(x.last_inbound_at, COALESCE(NEW.created_at, now()))
                                  ELSE x.last_inbound_at END,
           last_outbound_at = CASE WHEN NEW.sender_type = 'agent'
                                   THEN GREATEST(x.last_outbound_at, COALESCE(NEW.created_at, now()))
                                   ELSE x.last_outbound_at END
     WHERE x.conversation_id = NEW.conversation_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'hr_messages_note: % (%)', SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS hr_messages_note ON public.messages;
CREATE TRIGGER hr_messages_note
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.hr_messages_note();

-- ------------------------------------------------------------
-- 7. Caller-facing RPCs
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.hr_my_roles()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'admin', COALESCE(hr_role(a.id, auth.uid(), 'recruiter') = 'admin', false),
    'recruiter', CASE WHEN hr_role(a.id, auth.uid(), 'recruiter') IN ('lead', 'member')
                      THEN hr_role(a.id, auth.uid(), 'recruiter') END,
    'dept', CASE WHEN hr_role(a.id, auth.uid(), 'dept') IN ('lead', 'member')
                 THEN hr_role(a.id, auth.uid(), 'dept') END)
  FROM (SELECT current_account_id() AS id) a
$$;

CREATE OR REPLACE FUNCTION public.hr_open(p_conversation_id uuid, p_kind text)
RETURNS public.hr_conversations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_account uuid;
  v_inbox text;
  v_stage text;
  h hr_conversations;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('candidate', 'employee') THEN
    PERFORM hr_refuse('INVALID', 'kind is candidate|employee');
  END IF;
  IF p_conversation_id IS NULL OR NOT hr_can_see(p_conversation_id) THEN
    PERFORM hr_refuse('NOT_FOUND', 'conversation not found');
  END IF;
  SELECT c.account_id INTO v_account FROM conversations c WHERE c.id = p_conversation_id;
  v_inbox := CASE p_kind WHEN 'candidate' THEN 'recruiter' ELSE 'dept' END;
  IF COALESCE(hr_role(v_account, v_uid, v_inbox), '') NOT IN ('member', 'lead', 'admin') THEN
    PERFORM hr_refuse('NOT_ALLOWED', format('you may not open a %s conversation', v_inbox));
  END IF;

  SELECT * INTO h FROM hr_conversations x WHERE x.conversation_id = p_conversation_id;
  IF FOUND THEN RETURN h; END IF;

  PERFORM hr_seed_rules(v_account);
  v_stage := CASE WHEN v_inbox = 'recruiter' THEN 'cv_review' END;

  INSERT INTO hr_conversations (conversation_id, account_id, inbox, stage_key,
                                last_inbound_at, last_outbound_at, created_by)
  VALUES (p_conversation_id, v_account, v_inbox, v_stage,
          (SELECT max(m.created_at) FROM messages m
            WHERE m.conversation_id = p_conversation_id AND m.sender_type = 'customer'),
          (SELECT max(m.created_at) FROM messages m
            WHERE m.conversation_id = p_conversation_id AND m.sender_type = 'agent'),
          v_uid)
  ON CONFLICT (conversation_id) DO NOTHING;

  IF FOUND THEN
    INSERT INTO hr_stage_history (conversation_id, account_id, event, from_stage, to_stage,
                                  from_inbox, to_inbox, actor)
    VALUES (p_conversation_id, v_account, 'open', NULL, v_stage, NULL, v_inbox, v_uid);
  END IF;

  SELECT * INTO h FROM hr_conversations x WHERE x.conversation_id = p_conversation_id;
  RETURN h;
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_set_stage(p_conversation_id uuid, p_stage text, p_reason text DEFAULT NULL)
RETURNS public.hr_conversations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  h hr_conversations;
  v_to integer;
  v_from integer;
  v_reason text := CASE WHEN p_reason IS NULL OR p_reason ~ '^[[:space:]]*$' THEN NULL
                        ELSE btrim(p_reason) END;
BEGIN
  h := hr_load_for_write(p_conversation_id);
  IF h.closed_at IS NOT NULL THEN PERFORM hr_refuse('CLOSED', 'conversation is closed'); END IF;
  v_to := hr_stage_pos(p_stage);
  IF v_to IS NULL THEN PERFORM hr_refuse('STAGE_UNKNOWN', format('unknown stage %s', p_stage)); END IF;
  IF h.inbox = 'recruiter' AND h.stage_key = p_stage THEN RETURN h; END IF;

  IF h.inbox = 'recruiter' THEN
    v_from := hr_stage_pos(h.stage_key);
  ELSE
    -- Returning from dept: compare with the furthest stage ever reached.
    SELECT max(hr_stage_pos(s.to_stage)) INTO v_from
      FROM hr_stage_history s WHERE s.conversation_id = h.conversation_id;
  END IF;
  IF v_from IS NOT NULL AND v_to < v_from THEN
    IF COALESCE(hr_role(h.account_id, v_uid, 'recruiter'), '') NOT IN ('lead', 'admin') THEN
      PERFORM hr_refuse('NOT_ALLOWED', 'moving a candidate back needs a recruiter lead or an admin');
    END IF;
    IF v_reason IS NULL THEN
      PERFORM hr_refuse('NEEDS_REASON', 'moving a candidate back needs a reason');
    END IF;
  END IF;

  UPDATE hr_conversations x
     SET inbox = 'recruiter', stage_key = p_stage, topic = NULL
   WHERE x.conversation_id = h.conversation_id;
  INSERT INTO hr_stage_history (conversation_id, account_id, event, from_stage, to_stage,
                                from_inbox, to_inbox, actor, reason)
  VALUES (h.conversation_id, h.account_id,
          CASE WHEN h.inbox = 'recruiter' THEN 'stage' ELSE 'move' END,
          h.stage_key, p_stage, h.inbox, 'recruiter', v_uid, v_reason);

  SELECT * INTO h FROM hr_conversations x WHERE x.conversation_id = p_conversation_id;
  RETURN h;
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_set_topic(p_conversation_id uuid, p_topic text)
RETURNS public.hr_conversations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  h hr_conversations;
BEGIN
  h := hr_load_for_write(p_conversation_id);
  IF h.closed_at IS NOT NULL THEN PERFORM hr_refuse('CLOSED', 'conversation is closed'); END IF;
  IF p_topic IS NULL OR p_topic NOT IN
       ('onboarding', 'visa_documents', 'leave_attendance', 'payroll', 'complaint', 'other') THEN
    PERFORM hr_refuse('INVALID', format('unknown topic %s', p_topic));
  END IF;
  IF h.inbox = 'dept' AND h.topic IS NOT DISTINCT FROM p_topic THEN RETURN h; END IF;
  -- The move is recorded BEFORE the update, so the topic rules' count
  -- of entries into dept already includes this stay: every topic set
  -- during one stay uses the same n (once per stay).
  IF h.inbox <> 'dept' THEN
    INSERT INTO hr_stage_history (conversation_id, account_id, event, from_stage, to_stage,
                                  from_inbox, to_inbox, actor)
    VALUES (h.conversation_id, h.account_id, 'move', h.stage_key, NULL, h.inbox, 'dept', auth.uid());
  END IF;
  UPDATE hr_conversations x
     SET inbox = 'dept', topic = p_topic, stage_key = NULL, outcome = NULL
   WHERE x.conversation_id = h.conversation_id;
  SELECT * INTO h FROM hr_conversations x WHERE x.conversation_id = p_conversation_id;
  RETURN h;
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_set_flag(p_conversation_id uuid, p_flag text, p_value boolean)
RETURNS public.hr_conversations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  h hr_conversations;
BEGIN
  h := hr_load_for_write(p_conversation_id);
  IF h.closed_at IS NOT NULL THEN PERFORM hr_refuse('CLOSED', 'conversation is closed'); END IF;
  IF p_flag IS NULL OR p_flag NOT IN ('urgent', 'upset') OR p_value IS NULL THEN
    PERFORM hr_refuse('INVALID', 'flag is urgent|upset with a boolean value');
  END IF;
  UPDATE hr_conversations x
     SET urgent = CASE WHEN p_flag = 'urgent' THEN p_value ELSE x.urgent END,
         upset  = CASE WHEN p_flag = 'upset'  THEN p_value ELSE x.upset END
   WHERE x.conversation_id = h.conversation_id
  RETURNING * INTO h;
  RETURN h;
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_close(p_conversation_id uuid, p_outcome text DEFAULT NULL)
RETURNS public.hr_conversations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  h hr_conversations;
BEGIN
  h := hr_load_for_write(p_conversation_id);
  IF h.closed_at IS NOT NULL THEN PERFORM hr_refuse('CLOSED', 'conversation is already closed'); END IF;
  IF (h.inbox = 'recruiter' AND (p_outcome IS NULL OR p_outcome NOT IN ('hired', 'not_selected', 'withdrawn')))
     OR (h.inbox = 'dept' AND p_outcome IS NOT NULL) THEN
    PERFORM hr_refuse('INVALID', 'a recruiter conversation closes with hired|not_selected|withdrawn, a dept one with none');
  END IF;
  UPDATE hr_conversations x SET outcome = p_outcome, closed_at = now()
   WHERE x.conversation_id = h.conversation_id;
  INSERT INTO hr_stage_history (conversation_id, account_id, event, from_stage, to_stage,
                                from_inbox, to_inbox, actor, reason)
  VALUES (h.conversation_id, h.account_id, 'close', h.stage_key, h.stage_key, h.inbox, h.inbox,
          auth.uid(), p_outcome);
  SELECT * INTO h FROM hr_conversations x WHERE x.conversation_id = p_conversation_id;
  RETURN h;
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_reopen(p_conversation_id uuid, p_reason text)
RETURNS public.hr_conversations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  h hr_conversations;
BEGIN
  h := hr_load_for_write(p_conversation_id);
  IF COALESCE(hr_role(h.account_id, auth.uid(), h.inbox), '') NOT IN ('lead', 'admin') THEN
    PERFORM hr_refuse('NOT_ALLOWED', 'reopening needs a lead or an admin');
  END IF;
  IF p_reason IS NULL OR p_reason ~ '^[[:space:]]*$' THEN
    PERFORM hr_refuse('NEEDS_REASON', 'reopening needs a reason');
  END IF;
  IF h.closed_at IS NULL THEN RETURN h; END IF;
  UPDATE hr_conversations x SET outcome = NULL, closed_at = NULL
   WHERE x.conversation_id = h.conversation_id;
  INSERT INTO hr_stage_history (conversation_id, account_id, event, from_stage, to_stage,
                                from_inbox, to_inbox, actor, reason)
  VALUES (h.conversation_id, h.account_id, 'reopen', h.stage_key, h.stage_key, h.inbox, h.inbox,
          auth.uid(), btrim(p_reason));
  SELECT * INTO h FROM hr_conversations x WHERE x.conversation_id = p_conversation_id;
  RETURN h;
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_member_set(p_user_id uuid, p_inbox text, p_role text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid := current_account_id();
BEGIN
  IF v_account IS NULL OR COALESCE(hr_role(v_account, auth.uid(), 'recruiter'), '') <> 'admin' THEN
    PERFORM hr_refuse('NOT_ALLOWED', 'only an owner or admin manages the HR team');
  END IF;
  IF p_inbox IS NULL OR p_inbox NOT IN ('recruiter', 'dept')
     OR (p_role IS NOT NULL AND p_role NOT IN ('lead', 'member')) THEN
    PERFORM hr_refuse('INVALID', 'inbox is recruiter|dept and role lead|member (or null to remove)');
  END IF;
  IF NOT hr_is_live_staff(v_account, p_user_id) THEN
    PERFORM hr_refuse('NOT_FOUND', 'no such staff member in this workspace');
  END IF;
  IF p_role IS NULL THEN
    DELETE FROM hr_team_members m
     WHERE m.account_id = v_account AND m.user_id = p_user_id AND m.inbox = p_inbox;
  ELSE
    INSERT INTO hr_team_members (account_id, user_id, inbox, role, created_by)
    VALUES (v_account, p_user_id, p_inbox, p_role, auth.uid())
    ON CONFLICT ON CONSTRAINT hr_team_members_pkey DO UPDATE SET role = EXCLUDED.role;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_rule_set(
  p_key text, p_enabled boolean DEFAULT NULL, p_after_hours integer DEFAULT NULL,
  p_due_hours integer DEFAULT NULL, p_title text DEFAULT NULL)
RETURNS public.hr_workflow_rules
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid := current_account_id();
  r hr_workflow_rules;
BEGIN
  IF v_account IS NULL THEN PERFORM hr_refuse('NOT_ALLOWED', 'no active workspace'); END IF;
  PERFORM hr_seed_rules(v_account);
  SELECT * INTO r FROM hr_workflow_rules w
   WHERE w.account_id = v_account AND w.key = p_key FOR UPDATE;
  IF NOT FOUND THEN PERFORM hr_refuse('NOT_FOUND', 'rule not found'); END IF;
  IF COALESCE(hr_role(v_account, auth.uid(), r.inbox), '') NOT IN ('lead', 'admin') THEN
    PERFORM hr_refuse('NOT_ALLOWED', format('only a %s lead or an admin changes this rule', r.inbox));
  END IF;
  IF p_after_hours IS NOT NULL
     AND (r.trigger_kind NOT IN ('reply_overdue', 'no_activity') OR p_after_hours NOT BETWEEN 1 AND 720) THEN
    PERFORM hr_refuse('INVALID', 'after_hours is 1..720 on a reply_overdue / no_activity rule');
  END IF;
  IF p_due_hours IS NOT NULL AND (r.action <> 'task' OR p_due_hours NOT BETWEEN 0 AND 720) THEN
    PERFORM hr_refuse('INVALID', 'due_hours is 0..720 on a task rule');
  END IF;
  IF p_title IS NOT NULL
     AND (r.action <> 'task' OR p_title ~ '^[[:space:]]*$' OR char_length(btrim(p_title)) > 300) THEN
    PERFORM hr_refuse('INVALID', 'a title is 1..300 characters on a task rule');
  END IF;
  UPDATE hr_workflow_rules w
     SET enabled     = COALESCE(p_enabled, w.enabled),
         after_hours = COALESCE(p_after_hours, w.after_hours),
         due_hours   = COALESCE(p_due_hours, w.due_hours),
         title       = COALESCE(btrim(p_title), w.title),
         updated_at  = now(),
         updated_by  = auth.uid()
   WHERE w.account_id = v_account AND w.key = p_key
  RETURNING * INTO r;
  RETURN r;
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_rules_list()
RETURNS SETOF public.hr_workflow_rules
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid := current_account_id();
BEGIN
  IF v_account IS NULL
     OR (hr_role(v_account, auth.uid(), 'recruiter') IS NULL
         AND hr_role(v_account, auth.uid(), 'dept') IS NULL) THEN
    PERFORM hr_refuse('NOT_ALLOWED', 'HR rules are for the HR team and admins');
  END IF;
  PERFORM hr_seed_rules(v_account);
  RETURN QUERY SELECT * FROM hr_workflow_rules w WHERE w.account_id = v_account ORDER BY w.key;
END;
$$;

-- SECURITY INVOKER: RLS decides which HR rows and chats are counted.
CREATE OR REPLACE FUNCTION public.hr_counts()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH rows AS (
    SELECT h.inbox, h.reply_state, h.urgent,
           (c.assigned_agent_id = auth.uid()
            OR (c.assigned_agent_id IS NULL AND c.user_id = auth.uid())) AS mine
      FROM hr_conversations h
      JOIN conversations c ON c.id = h.conversation_id
     WHERE h.account_id = current_account_id() AND h.closed_at IS NULL
  ), per AS (
    SELECT i.inbox,
           jsonb_build_object(
             'all',    count(r.inbox),
             'unread', count(r.inbox) FILTER (WHERE r.reply_state = 'reply_due'),
             'mine',   count(r.inbox) FILTER (WHERE r.mine),
             'urgent', count(r.inbox) FILTER (WHERE r.urgent)) AS o
      FROM (VALUES ('recruiter'), ('dept')) i (inbox)
      LEFT JOIN rows r ON r.inbox = i.inbox
     GROUP BY i.inbox
  )
  SELECT jsonb_build_object(
    'recruiter', (SELECT o FROM per WHERE inbox = 'recruiter'),
    'dept',      (SELECT o FROM per WHERE inbox = 'dept'),
    'unsorted',  (SELECT count(*) FROM conversations c
                   WHERE c.account_id = current_account_id()
                     AND c.inbox_department = 'hr'
                     AND c.status IS DISTINCT FROM 'closed'
                     AND NOT EXISTS (SELECT 1 FROM hr_conversations h
                                      WHERE h.conversation_id = c.id)))
$$;

-- ------------------------------------------------------------
-- 8. Sweep (service role only, every account)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.hr_sweep(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := COALESCE(p_now, now());
  r hr_workflow_rules;
  h hr_conversations;
  n integer;
  v_created integer := 0;
  v_skipped integer := 0;
BEGIN
  FOR r IN SELECT * FROM hr_workflow_rules w
            WHERE w.enabled AND w.trigger_kind IN ('reply_overdue', 'no_activity')
            ORDER BY w.account_id, w.key
  LOOP
    FOR h IN SELECT * FROM hr_conversations x
              WHERE x.account_id = r.account_id AND x.inbox = r.inbox AND x.closed_at IS NULL
                AND ((r.trigger_kind = 'reply_overdue'
                      AND x.reply_state IN ('new', 'reply_due')
                      AND x.last_inbound_at IS NOT NULL
                      AND x.last_inbound_at < v_now - make_interval(hours => r.after_hours))
                  OR (r.trigger_kind = 'no_activity'
                      AND x.inbox = 'recruiter'
                      AND x.reply_state = 'waiting'
                      AND x.last_outbound_at < v_now - make_interval(hours => r.after_hours)))
              ORDER BY x.conversation_id
    LOOP
      n := hr_apply_rule(r, h.conversation_id,
             format('%s:%s', r.trigger_kind,
                    extract(epoch FROM CASE WHEN r.trigger_kind = 'reply_overdue'
                                            THEN h.last_inbound_at ELSE h.last_outbound_at END)),
             v_now);
      IF r.action = 'task' THEN
        IF n > 0 THEN v_created := v_created + 1; ELSE v_skipped := v_skipped + 1; END IF;
      END IF;
    END LOOP;
  END LOOP;
  RETURN jsonb_build_object('created', v_created, 'skipped', v_skipped);
END;
$$;

-- ------------------------------------------------------------
-- 9. Function privileges
-- ------------------------------------------------------------

REVOKE ALL ON FUNCTION
  public.hr_refuse(text, text),
  public.hr_stage_pos(text),
  public.hr_is_live_staff(uuid, uuid),
  public.hr_role(uuid, uuid, text),
  public.hr_can_see(uuid),
  public.hr_load_for_write(uuid),
  public.hr_seed_rules(uuid),
  public.hr_apply_rule(public.hr_workflow_rules, uuid, text, timestamptz),
  public.hr_fire_rules(uuid, text, text),
  public.hr_conversations_fire(),
  public.hr_conversations_guard(),
  public.hr_messages_note(),
  public.hr_my_roles(),
  public.hr_open(uuid, text),
  public.hr_set_stage(uuid, text, text),
  public.hr_set_topic(uuid, text),
  public.hr_set_flag(uuid, text, boolean),
  public.hr_close(uuid, text),
  public.hr_reopen(uuid, text),
  public.hr_member_set(uuid, text, text),
  public.hr_rule_set(text, boolean, integer, integer, text),
  public.hr_rules_list(),
  public.hr_counts(),
  public.hr_sweep(timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.hr_my_roles(),
  public.hr_open(uuid, text),
  public.hr_set_stage(uuid, text, text),
  public.hr_set_topic(uuid, text),
  public.hr_set_flag(uuid, text, boolean),
  public.hr_close(uuid, text),
  public.hr_reopen(uuid, text),
  public.hr_member_set(uuid, text, text),
  public.hr_rule_set(text, boolean, integer, integer, text),
  public.hr_rules_list(),
  public.hr_counts()
  TO authenticated;

GRANT EXECUTE ON FUNCTION public.hr_sweep(timestamptz) TO service_role;

-- ------------------------------------------------------------
-- 10. Seed every existing account's rules
-- ------------------------------------------------------------

DO $$
DECLARE
  a record;
BEGIN
  FOR a IN SELECT id FROM public.accounts LOOP
    PERFORM public.hr_seed_rules(a.id);
  END LOOP;
END $$;
