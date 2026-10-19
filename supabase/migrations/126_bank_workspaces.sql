-- ============================================================
-- 126_bank_workspaces.sql — bank workspaces: one internal workspace
-- per (account, bank), with threads, posts, versioned pins and
-- 'Action needed' markers, over 122-123's cases and case tasks.
-- Port of module 018c (018c_bankws.sql).
--
--  * WORKSPACE: bank_workspaces, one per (account_id, bank_code)
--    (composite FK to case_banks). Created only by a live owner / admin
--    of p_account (bank_ws_create; the account is explicit because one
--    login holds a profile in several workspaces). Idempotent: a second
--    call returns the existing id. It also seeds the account's
--    'bank_ws_action_needed' task template for that bank (title 'Action
--    needed', due_hours NULL) if absent; an existing row is kept as
--    configured, another account's templates are never touched. Every
--    other function takes the account from the bank workspace row. A
--    bank workspace holds the account's cases of that bank through
--    cases.bank_code (no copy; bank_ws_cases lists the readable ones).
--  * ACCESS (bank_ws_access(bank_ws, user), live, never from the caller):
--      admin   live owner / admin of the bank workspace's account
--      member  anyone else with case_role(case, user) IS NOT NULL on at
--              least one OPEN case (closed_at IS NULL) of that account
--              and bank: the case's agent or coordinator, or the team
--              lead of the agent's team. Lapses at once when the last
--              such case closes; earlier posts stay visible to others.
--    There is no view-only level (the reference's IT role has no wacrm
--    counterpart). Membership is computed set-wise from
--    bank_ws_viewer (role once, led-team agents once), the same
--    predicate 125's case_inbox uses, never case_role per row (074).
--  * RIGHTS (owner decision D1 without IT): members and admins read,
--    post, reply, retract their OWN posts, create threads and mark
--    'Action needed'. Pins are edited by admins, team_lead members, and
--    members who coordinate (cases.coordinator_id) an open case of that
--    bank in that account; not by agents otherwise.
--  * PINS: bank_ws_pins, kinds bank_contacts | product_rules |
--    required_documents | turnaround_times | known_pitfalls, text up to
--    8000 characters (blank clears). Versioned: every edit is a new row,
--    the latest row of a kind is current, the history is every row.
--  * DISCUSSION: bank_ws_threads (title 1..200) + bank_ws_posts (body
--    1..4000, whitespace-only refused; the first post is the thread's
--    root, parent NULL). A post links a case, a case task, or nothing; a
--    task link stores its case too. A link must be a case of the SAME
--    account and SAME bank that the poster may read (case_can_read),
--    else LINK_INVALID (absent, foreign and unreadable look the same).
--    The thread's link is its root post's link. A post is withdrawn only
--    by its author, by a bank_ws_post_retractions row; the listing then
--    returns retracted = true and body NULL. Listings return link ids;
--    stage / product only to a viewer who may read the case.
--  * ACTION NEEDED: bank_ws_actions, at most one per thread, owner and
--    finite due date required. Case-linked thread: a real case task is
--    created by case_task_create from the bank's 'bank_ws_action_needed'
--    template, so the case's write rule and owner rule apply. Unlinked:
--    the action row is the record and its owner must be a MEMBER (an
--    admin who is not a member may not own one, as the reference).
--  * INTERNAL: posts and pins are never sent to a customer or bank.
--  * PRIVILEGES: every table RLS-forced; authenticated SELECTs the rows
--    of the bank workspaces of its active account it has access to
--    (bank_ws_rls_access, auth.uid()), EXCEPT bank_ws_posts: a retracted
--    post keeps its body in the append-only row, so posts are read only
--    through bank_ws_posts_list. service_role has NO table privilege; it
--    reads and writes only through the SECURITY DEFINER functions
--    (search_path ''). Every table refuses UPDATE / DELETE / TRUNCATE by
--    trigger (case_append_only, the owner included).
--
-- The SECURITY DEFINER functions read RLS-forced tables, so, as 122,
-- this must be applied by a superuser or BYPASSRLS role.
--
-- Re-runnable: CREATE … IF NOT EXISTS, CREATE OR REPLACE,
-- DROP … IF EXISTS.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '126 must be applied by a superuser or BYPASSRLS role (the bank_ws_* functions read RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. Tables ----------

CREATE TABLE IF NOT EXISTS public.bank_workspaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id),
  bank_code  text NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_workspaces_one_per_bank UNIQUE (account_id, bank_code),
  CONSTRAINT bank_workspaces_id_account_key UNIQUE (id, account_id),
  CONSTRAINT bank_workspaces_bank_fkey FOREIGN KEY (account_id, bank_code)
    REFERENCES public.case_banks (account_id, code)
);
COMMENT ON TABLE public.bank_workspaces IS
  'One internal workspace per (account, bank). Written only through bank_ws_create. Append-only. Migration 126.';

CREATE TABLE IF NOT EXISTS public.bank_ws_pins (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bank_ws_id uuid NOT NULL,
  account_id uuid NOT NULL,
  kind       text NOT NULL,
  body       text NOT NULL,
  author_id  uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_ws_pins_ws_fkey FOREIGN KEY (bank_ws_id, account_id)
    REFERENCES public.bank_workspaces (id, account_id),
  CONSTRAINT bank_ws_pins_kind_check CHECK (kind IN ('bank_contacts', 'product_rules', 'required_documents',
                                                     'turnaround_times', 'known_pitfalls')),
  CONSTRAINT bank_ws_pins_body_check CHECK (char_length(body) <= 8000)
);
CREATE INDEX IF NOT EXISTS bank_ws_pins_kind_idx ON public.bank_ws_pins (bank_ws_id, kind, id);
COMMENT ON TABLE public.bank_ws_pins IS
  'Versioned pinned info per bank workspace and kind: the latest row is current, every row is history. Append-only. Migration 126.';

CREATE TABLE IF NOT EXISTS public.bank_ws_threads (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_ws_id uuid NOT NULL,
  account_id uuid NOT NULL,
  title      text NOT NULL,
  author_id  uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_ws_threads_id_account_key UNIQUE (id, account_id),
  CONSTRAINT bank_ws_threads_ws_fkey FOREIGN KEY (bank_ws_id, account_id)
    REFERENCES public.bank_workspaces (id, account_id),
  CONSTRAINT bank_ws_threads_title_check CHECK (title !~ '^[[:space:]]*$' AND char_length(title) <= 200)
);
CREATE INDEX IF NOT EXISTS bank_ws_threads_ws_idx ON public.bank_ws_threads (bank_ws_id, created_at);

CREATE TABLE IF NOT EXISTS public.bank_ws_posts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id      uuid NOT NULL,
  bank_ws_id     uuid NOT NULL,
  account_id     uuid NOT NULL,
  parent_post_id uuid NULL,
  author_id      uuid NOT NULL,
  body           text NOT NULL,
  case_id        uuid NULL,
  task_id        uuid NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_ws_posts_id_account_key UNIQUE (id, account_id),
  CONSTRAINT bank_ws_posts_thread_fkey FOREIGN KEY (thread_id, account_id)
    REFERENCES public.bank_ws_threads (id, account_id),
  CONSTRAINT bank_ws_posts_ws_fkey FOREIGN KEY (bank_ws_id, account_id)
    REFERENCES public.bank_workspaces (id, account_id),
  CONSTRAINT bank_ws_posts_parent_fkey FOREIGN KEY (parent_post_id, account_id)
    REFERENCES public.bank_ws_posts (id, account_id),
  CONSTRAINT bank_ws_posts_case_fkey FOREIGN KEY (case_id, account_id)
    REFERENCES public.cases (id, account_id),
  CONSTRAINT bank_ws_posts_task_fkey FOREIGN KEY (task_id, account_id)
    REFERENCES public.case_tasks (id, account_id),
  CONSTRAINT bank_ws_posts_body_check CHECK (body !~ '^[[:space:]]*$' AND char_length(body) <= 4000),
  CONSTRAINT bank_ws_posts_task_has_case CHECK (task_id IS NULL OR case_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS bank_ws_posts_one_root ON public.bank_ws_posts (thread_id)
  WHERE parent_post_id IS NULL;
CREATE INDEX IF NOT EXISTS bank_ws_posts_thread_idx ON public.bank_ws_posts (thread_id, created_at);

CREATE TABLE IF NOT EXISTS public.bank_ws_post_retractions (
  post_id      uuid PRIMARY KEY,
  bank_ws_id   uuid NOT NULL,
  account_id   uuid NOT NULL,
  retracted_by uuid NOT NULL,
  retracted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_ws_post_retractions_post_fkey FOREIGN KEY (post_id, account_id)
    REFERENCES public.bank_ws_posts (id, account_id),
  CONSTRAINT bank_ws_post_retractions_ws_fkey FOREIGN KEY (bank_ws_id, account_id)
    REFERENCES public.bank_workspaces (id, account_id)
);

CREATE TABLE IF NOT EXISTS public.bank_ws_actions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id  uuid NOT NULL,
  bank_ws_id uuid NOT NULL,
  account_id uuid NOT NULL,
  owner_id   uuid NOT NULL,
  due_at     timestamptz NOT NULL,
  case_id    uuid NULL,
  task_id    uuid NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_ws_actions_one_per_thread UNIQUE (thread_id),
  CONSTRAINT bank_ws_actions_thread_fkey FOREIGN KEY (thread_id, account_id)
    REFERENCES public.bank_ws_threads (id, account_id),
  CONSTRAINT bank_ws_actions_ws_fkey FOREIGN KEY (bank_ws_id, account_id)
    REFERENCES public.bank_workspaces (id, account_id),
  CONSTRAINT bank_ws_actions_case_fkey FOREIGN KEY (case_id, account_id)
    REFERENCES public.cases (id, account_id),
  CONSTRAINT bank_ws_actions_task_fkey FOREIGN KEY (task_id, account_id)
    REFERENCES public.case_tasks (id, account_id),
  CONSTRAINT bank_ws_actions_due_finite CHECK (isfinite(due_at)),
  CONSTRAINT bank_ws_actions_task_iff_case CHECK ((task_id IS NULL) = (case_id IS NULL))
);
CREATE INDEX IF NOT EXISTS bank_ws_actions_ws_idx ON public.bank_ws_actions (bank_ws_id, due_at);

ALTER TABLE public.bank_workspaces          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_workspaces          FORCE ROW LEVEL SECURITY;
ALTER TABLE public.bank_ws_pins             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_ws_pins             FORCE ROW LEVEL SECURITY;
ALTER TABLE public.bank_ws_threads          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_ws_threads          FORCE ROW LEVEL SECURITY;
ALTER TABLE public.bank_ws_posts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_ws_posts            FORCE ROW LEVEL SECURITY;
ALTER TABLE public.bank_ws_post_retractions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_ws_post_retractions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.bank_ws_actions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_ws_actions          FORCE ROW LEVEL SECURITY;

-- ---------- 2. Access (internal) ----------

-- p_user's case reach in p_account, once: the account-level case role
-- (case_account_role) and, for a team lead, the agents of the teams
-- they lead. A case of the account is readable iff role IS NOT NULL
-- AND (role IN (super_admin, admin) OR agent_id = user OR
-- coordinator_id = user OR agent_id = ANY (team_agents)) — exactly
-- case_role(case, user) IS NOT NULL (122), as 125's case_inbox.
CREATE OR REPLACE FUNCTION public.bank_ws_viewer(p_account uuid, p_user uuid)
RETURNS TABLE (role text, team_agents uuid[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT r.role,
         CASE WHEN r.role = 'team_lead' THEN
           (SELECT coalesce(array_agg(DISTINCT m.user_id), '{}')
              FROM public.teams t
              JOIN public.team_members m ON m.team_id = t.id
             WHERE t.account_id = p_account AND m.account_id = p_account AND t.leader_user_id = p_user)
         ELSE '{}'::uuid[] END
    FROM (SELECT public.case_account_role(p_account, p_user) AS role) r
$$;

-- 'admin' | 'member' | NULL for p_user in the bank workspace.
CREATE OR REPLACE FUNCTION public.bank_ws_access(p_bank_ws uuid, p_user uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
           WHEN v.role IN ('super_admin', 'admin') THEN 'admin'
           WHEN v.role IN ('team_lead', 'agent') AND EXISTS (
             SELECT 1 FROM public.cases c
              WHERE c.account_id = w.account_id AND c.bank_code = w.bank_code AND c.closed_at IS NULL
                AND (c.agent_id = p_user OR c.coordinator_id = p_user OR c.agent_id = ANY (v.team_agents)))
             THEN 'member'
         END
    FROM public.bank_workspaces w
   CROSS JOIN LATERAL public.bank_ws_viewer(w.account_id, p_user) v
   WHERE w.id = p_bank_ws
$$;

-- The RLS row check: the caller's own access. Takes no user argument,
-- so authenticated learns nothing about anyone else.
CREATE OR REPLACE FUNCTION public.bank_ws_rls_access(p_bank_ws uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT public.bank_ws_access(p_bank_ws, auth.uid()) IS NOT NULL $$;

-- The bank workspace for a write by p_actor (a member or an admin);
-- raises BANK_WS_NOT_FOUND or NOT_ALLOWED.
CREATE OR REPLACE FUNCTION public.bank_ws_require_member(p_bank_ws uuid, p_actor uuid)
RETURNS public.bank_workspaces
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  w public.bank_workspaces%ROWTYPE;
BEGIN
  SELECT * INTO w FROM public.bank_workspaces x WHERE x.id = p_bank_ws;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank workspace % not found', p_bank_ws USING ERRCODE = 'no_data_found', HINT = 'BANK_WS_NOT_FOUND';
  END IF;
  IF public.bank_ws_access(p_bank_ws, p_actor) IS NULL THEN
    RAISE EXCEPTION 'bank workspace %: % is not a member', p_bank_ws, p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  RETURN w;
END;
$$;

-- Validates a post link and returns the linked case (NULL: no link). A
-- task link resolves to its case; a case given with a task must be that
-- task's case. The case must be of p_account and p_bank_code and
-- readable by p_actor; anything else is LINK_INVALID.
CREATE OR REPLACE FUNCTION public.bank_ws_link_case(p_account uuid, p_bank_code text, p_actor uuid,
  p_case uuid, p_task uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_case      uuid := p_case;
  v_task_case uuid;
BEGIN
  IF p_task IS NOT NULL THEN
    SELECT t.case_id INTO v_task_case FROM public.case_tasks t WHERE t.id = p_task AND t.account_id = p_account;
    IF v_task_case IS NULL OR (v_case IS NOT NULL AND v_case <> v_task_case) THEN
      RAISE EXCEPTION 'link invalid' USING ERRCODE = 'check_violation', HINT = 'LINK_INVALID';
    END IF;
    v_case := v_task_case;
  END IF;
  IF v_case IS NULL THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cases c
                  WHERE c.id = v_case AND c.account_id = p_account AND c.bank_code = p_bank_code)
     OR NOT public.case_can_read(v_case, p_actor) THEN
    RAISE EXCEPTION 'link invalid' USING ERRCODE = 'check_violation', HINT = 'LINK_INVALID';
  END IF;
  RETURN v_case;
END;
$$;

CREATE OR REPLACE FUNCTION public.bank_ws_check_body(p_body text)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
  -- [[:space:]], not btrim(): btrim strips spaces only.
  IF p_body IS NULL OR p_body ~ '^[[:space:]]*$' OR char_length(p_body) > 4000 THEN
    RAISE EXCEPTION 'post body must be 1..4000 characters' USING ERRCODE = 'check_violation', HINT = 'BODY_INVALID';
  END IF;
END;
$$;

-- ---------- 3. Workspaces ----------

-- Owner / admin of p_account; idempotent per (account, bank). Seeds the
-- bank's 'bank_ws_action_needed' template in p_account if absent.
CREATE OR REPLACE FUNCTION public.bank_ws_create(p_actor uuid, p_account uuid, p_bank_code text,
  p_now timestamptz DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF coalesce(public.case_account_role(p_account, p_actor) IN ('super_admin', 'admin'), false) IS NOT TRUE THEN
    RAISE EXCEPTION '% may not create a bank workspace', p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.case_banks b WHERE b.account_id = p_account AND b.code = p_bank_code) THEN
    RAISE EXCEPTION 'bank % is not a bank of this workspace', p_bank_code
      USING ERRCODE = 'no_data_found', HINT = 'BANK_UNKNOWN';
  END IF;
  INSERT INTO public.case_task_templates (account_id, bank_code, template_key, title, position, due_hours)
  VALUES (p_account, p_bank_code, 'bank_ws_action_needed', 'Action needed', 1, NULL)
  ON CONFLICT ON CONSTRAINT case_task_templates_pkey DO NOTHING;
  INSERT INTO public.bank_workspaces (account_id, bank_code, created_by, created_at)
  VALUES (p_account, p_bank_code, p_actor, coalesce(p_now, now()))
  ON CONFLICT ON CONSTRAINT bank_workspaces_one_per_bank DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT w.id INTO v_id FROM public.bank_workspaces w WHERE w.account_id = p_account AND w.bank_code = p_bank_code;
  END IF;
  RETURN v_id;
END;
$$;

-- The bank workspaces of p_account the actor is an admin or member of
-- (membership set-wise: the banks of the open cases the actor reads).
CREATE OR REPLACE FUNCTION public.bank_ws_list(p_actor uuid, p_account uuid)
RETURNS TABLE (bank_ws_id uuid, account_id uuid, bank_code text, bank_name text, access text, created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH v AS (SELECT * FROM public.bank_ws_viewer(p_account, p_actor)),
  mb AS (
    SELECT DISTINCT c.bank_code
      FROM public.cases c, v
     WHERE v.role IN ('team_lead', 'agent') AND c.account_id = p_account AND c.closed_at IS NULL
       AND c.bank_code IS NOT NULL
       AND (c.agent_id = p_actor OR c.coordinator_id = p_actor OR c.agent_id = ANY (v.team_agents))
  )
  SELECT w.id, w.account_id, w.bank_code, b.name,
         CASE WHEN v.role IN ('super_admin', 'admin') THEN 'admin' ELSE 'member' END, w.created_at
    FROM public.bank_workspaces w
    JOIN public.case_banks b ON b.account_id = w.account_id AND b.code = w.bank_code
   CROSS JOIN v
   WHERE w.account_id = p_account
     AND (v.role IN ('super_admin', 'admin') OR w.bank_code IN (SELECT mb.bank_code FROM mb))
   ORDER BY w.bank_code, w.id
$$;

-- The cases of the bank workspace (cases.bank_code, no copy) the actor
-- may read, open and closed; nothing without access.
CREATE OR REPLACE FUNCTION public.bank_ws_cases(p_bank_ws uuid, p_actor uuid)
RETURNS TABLE (case_id uuid, stage text, product text, agent_id uuid, coordinator_id uuid, opened_at timestamptz,
  closed_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT c.id, c.stage, c.product, c.agent_id, c.coordinator_id, c.opened_at, c.closed_at
    FROM public.bank_workspaces w
   CROSS JOIN LATERAL public.bank_ws_viewer(w.account_id, p_actor) v
    JOIN public.cases c ON c.account_id = w.account_id AND c.bank_code = w.bank_code
   WHERE w.id = p_bank_ws AND public.bank_ws_access(w.id, p_actor) IS NOT NULL
     AND v.role IS NOT NULL
     AND (v.role IN ('super_admin', 'admin') OR c.agent_id = p_actor OR c.coordinator_id = p_actor
          OR c.agent_id = ANY (v.team_agents))
   ORDER BY c.opened_at, c.id
$$;

-- ---------- 4. Pins (versioned, append-only) ----------

-- Editors: admins; members who are team leads or coordinate an open case
-- of the bank in the account. Returns the new version's id.
CREATE OR REPLACE FUNCTION public.bank_ws_pin_set(p_bank_ws uuid, p_actor uuid, p_kind text, p_body text,
  p_now timestamptz DEFAULT NULL)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  w        public.bank_workspaces%ROWTYPE;
  v_access text;
  v_ok     boolean;
  v_id     bigint;
BEGIN
  SELECT * INTO w FROM public.bank_workspaces x WHERE x.id = p_bank_ws;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank workspace % not found', p_bank_ws USING ERRCODE = 'no_data_found', HINT = 'BANK_WS_NOT_FOUND';
  END IF;
  v_access := public.bank_ws_access(p_bank_ws, p_actor);
  v_ok := v_access = 'admin'
       OR (v_access = 'member'
           AND (public.case_account_role(w.account_id, p_actor) = 'team_lead'
                OR EXISTS (SELECT 1 FROM public.cases c
                            WHERE c.account_id = w.account_id AND c.bank_code = w.bank_code
                              AND c.closed_at IS NULL AND c.coordinator_id = p_actor)));
  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'bank workspace %: % may not edit pins', p_bank_ws, p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('bank_contacts', 'product_rules', 'required_documents', 'turnaround_times',
                                      'known_pitfalls') THEN
    RAISE EXCEPTION 'pin kind % is not known', p_kind USING ERRCODE = 'check_violation', HINT = 'KIND_INVALID';
  END IF;
  IF p_body IS NULL OR char_length(p_body) > 8000 THEN
    RAISE EXCEPTION 'pin text must be at most 8000 characters' USING ERRCODE = 'check_violation', HINT = 'BODY_INVALID';
  END IF;
  INSERT INTO public.bank_ws_pins (bank_ws_id, account_id, kind, body, author_id, created_at)
  VALUES (p_bank_ws, w.account_id, p_kind, p_body, p_actor, coalesce(p_now, now()))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Current pins (latest version per kind), or every version when
-- p_history; nothing without access.
CREATE OR REPLACE FUNCTION public.bank_ws_pins_list(p_bank_ws uuid, p_actor uuid, p_history boolean DEFAULT false)
RETURNS TABLE (pin_id bigint, kind text, body text, author_id uuid, created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.id, p.kind, p.body, p.author_id, p.created_at
    FROM public.bank_ws_pins p
   WHERE p.bank_ws_id = p_bank_ws AND public.bank_ws_access(p_bank_ws, p_actor) IS NOT NULL
     AND (coalesce(p_history, false)
          OR p.id = (SELECT max(q.id) FROM public.bank_ws_pins q WHERE q.bank_ws_id = p.bank_ws_id AND q.kind = p.kind))
   ORDER BY p.kind, p.id
$$;

-- ---------- 5. Discussion ----------

CREATE OR REPLACE FUNCTION public.bank_ws_thread_create(p_bank_ws uuid, p_actor uuid, p_title text, p_body text,
  p_case uuid DEFAULT NULL, p_task uuid DEFAULT NULL, p_now timestamptz DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  w        public.bank_workspaces%ROWTYPE;
  v_case   uuid;
  v_thread uuid;
  v_now    timestamptz := coalesce(p_now, now());
BEGIN
  w := public.bank_ws_require_member(p_bank_ws, p_actor);
  IF p_title IS NULL OR p_title ~ '^[[:space:]]*$' OR char_length(p_title) > 200 THEN
    RAISE EXCEPTION 'thread title must be 1..200 characters' USING ERRCODE = 'check_violation', HINT = 'TITLE_INVALID';
  END IF;
  PERFORM public.bank_ws_check_body(p_body);
  v_case := public.bank_ws_link_case(w.account_id, w.bank_code, p_actor, p_case, p_task);
  INSERT INTO public.bank_ws_threads (bank_ws_id, account_id, title, author_id, created_at)
  VALUES (p_bank_ws, w.account_id, p_title, p_actor, v_now)
  RETURNING id INTO v_thread;
  INSERT INTO public.bank_ws_posts (thread_id, bank_ws_id, account_id, parent_post_id, author_id, body, case_id,
                                    task_id, created_at)
  VALUES (v_thread, p_bank_ws, w.account_id, NULL, p_actor, p_body, v_case, p_task, v_now);
  RETURN v_thread;
END;
$$;

-- A reply in the thread; p_parent NULL = a reply to the root post. The
-- parent must be in the same thread.
CREATE OR REPLACE FUNCTION public.bank_ws_post_add(p_thread uuid, p_actor uuid, p_parent uuid, p_body text,
  p_case uuid DEFAULT NULL, p_task uuid DEFAULT NULL, p_now timestamptz DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  t        public.bank_ws_threads%ROWTYPE;
  w        public.bank_workspaces%ROWTYPE;
  v_parent uuid;
  v_case   uuid;
  v_id     uuid;
BEGIN
  SELECT * INTO t FROM public.bank_ws_threads x WHERE x.id = p_thread;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'thread % not found', p_thread USING ERRCODE = 'no_data_found', HINT = 'THREAD_NOT_FOUND';
  END IF;
  w := public.bank_ws_require_member(t.bank_ws_id, p_actor);
  SELECT p.id INTO v_parent FROM public.bank_ws_posts p
   WHERE p.thread_id = p_thread AND (p.id = p_parent OR (p_parent IS NULL AND p.parent_post_id IS NULL));
  IF v_parent IS NULL THEN
    RAISE EXCEPTION 'post % is not in thread %', p_parent, p_thread
      USING ERRCODE = 'check_violation', HINT = 'PARENT_INVALID';
  END IF;
  PERFORM public.bank_ws_check_body(p_body);
  v_case := public.bank_ws_link_case(w.account_id, w.bank_code, p_actor, p_case, p_task);
  INSERT INTO public.bank_ws_posts (thread_id, bank_ws_id, account_id, parent_post_id, author_id, body, case_id,
                                    task_id, created_at)
  VALUES (p_thread, t.bank_ws_id, t.account_id, v_parent, p_actor, p_body, v_case, p_task, coalesce(p_now, now()))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Withdrawal by the post's author (still a member or admin); the post
-- row is kept.
CREATE OR REPLACE FUNCTION public.bank_ws_post_retract(p_post uuid, p_actor uuid, p_now timestamptz DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  p public.bank_ws_posts%ROWTYPE;
BEGIN
  SELECT * INTO p FROM public.bank_ws_posts x WHERE x.id = p_post;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'post % not found', p_post USING ERRCODE = 'no_data_found', HINT = 'POST_NOT_FOUND';
  END IF;
  PERFORM public.bank_ws_require_member(p.bank_ws_id, p_actor);
  IF p.author_id IS DISTINCT FROM p_actor THEN
    RAISE EXCEPTION 'post %: only its author may retract it', p_post
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  INSERT INTO public.bank_ws_post_retractions (post_id, bank_ws_id, account_id, retracted_by, retracted_at)
  VALUES (p_post, p.bank_ws_id, p.account_id, p_actor, coalesce(p_now, now()))
  ON CONFLICT (post_id) DO NOTHING;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'post % is already retracted', p_post USING ERRCODE = 'unique_violation', HINT = 'ALREADY_RETRACTED';
  END IF;
END;
$$;

-- Threads with their root link and action marker; nothing without access.
CREATE OR REPLACE FUNCTION public.bank_ws_threads_list(p_bank_ws uuid, p_actor uuid)
RETURNS TABLE (thread_id uuid, title text, author_id uuid, created_at timestamptz, case_id uuid, task_id uuid,
  post_count integer, action_owner_id uuid, action_due_at timestamptz, action_task_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT t.id, t.title, t.author_id, t.created_at, r.case_id, r.task_id,
         (SELECT count(*)::integer FROM public.bank_ws_posts q WHERE q.thread_id = t.id),
         a.owner_id, a.due_at, a.task_id
    FROM public.bank_ws_threads t
    JOIN public.bank_ws_posts r ON r.thread_id = t.id AND r.parent_post_id IS NULL
    LEFT JOIN public.bank_ws_actions a ON a.thread_id = t.id
   WHERE t.bank_ws_id = p_bank_ws AND public.bank_ws_access(p_bank_ws, p_actor) IS NOT NULL
   ORDER BY t.created_at, t.id
$$;

-- The thread's posts in order. Link ids always; stage / product only
-- when the viewer may read the case (set-wise, bank_ws_viewer).
CREATE OR REPLACE FUNCTION public.bank_ws_posts_list(p_thread uuid, p_actor uuid)
RETURNS TABLE (post_id uuid, parent_post_id uuid, author_id uuid, body text, retracted boolean, case_id uuid,
  task_id uuid, case_readable boolean, case_stage text, case_product text, created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.id, p.parent_post_id, p.author_id,
         CASE WHEN x.post_id IS NULL THEN p.body END, x.post_id IS NOT NULL,
         p.case_id, p.task_id, coalesce(rd.readable, false),
         CASE WHEN rd.readable THEN c.stage END, CASE WHEN rd.readable THEN c.product END, p.created_at
    FROM public.bank_ws_threads t
   CROSS JOIN LATERAL public.bank_ws_viewer(t.account_id, p_actor) v
    JOIN public.bank_ws_posts p ON p.thread_id = t.id
    LEFT JOIN public.bank_ws_post_retractions x ON x.post_id = p.id
    LEFT JOIN public.cases c ON c.id = p.case_id AND c.account_id = p.account_id
    LEFT JOIN LATERAL (SELECT v.role IS NOT NULL
                              AND (v.role IN ('super_admin', 'admin') OR c.agent_id = p_actor
                                   OR c.coordinator_id = p_actor OR c.agent_id = ANY (v.team_agents)) AS readable
                      ) rd ON c.id IS NOT NULL
   WHERE t.id = p_thread AND public.bank_ws_access(t.bank_ws_id, p_actor) IS NOT NULL
   ORDER BY p.created_at, p.id
$$;

-- ---------- 6. Action needed ----------

-- Marks the thread (once). Case-linked: a case task from the
-- 'bank_ws_action_needed' template (case_task_create's write and owner
-- rules apply). Unlinked: the owner must be a member. Returns the id.
CREATE OR REPLACE FUNCTION public.bank_ws_action_mark(p_thread uuid, p_actor uuid, p_owner uuid,
  p_due_at timestamptz, p_now timestamptz DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  t      public.bank_ws_threads%ROWTYPE;
  v_case uuid;
  v_task uuid;
  v_id   uuid;
BEGIN
  -- Serialises two marks of one thread (the UNIQUE would also refuse).
  SELECT * INTO t FROM public.bank_ws_threads x WHERE x.id = p_thread FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'thread % not found', p_thread USING ERRCODE = 'no_data_found', HINT = 'THREAD_NOT_FOUND';
  END IF;
  PERFORM public.bank_ws_require_member(t.bank_ws_id, p_actor);
  IF p_due_at IS NULL THEN
    RAISE EXCEPTION 'an action needs a due date' USING ERRCODE = 'check_violation', HINT = 'DUE_REQUIRED';
  END IF;
  -- A finite past date is allowed (created already overdue); infinity never is.
  IF NOT isfinite(p_due_at) THEN
    RAISE EXCEPTION 'an action needs a finite due date' USING ERRCODE = 'check_violation', HINT = 'DUE_INVALID';
  END IF;
  IF EXISTS (SELECT 1 FROM public.bank_ws_actions a WHERE a.thread_id = p_thread) THEN
    RAISE EXCEPTION 'thread % is already marked', p_thread USING ERRCODE = 'unique_violation', HINT = 'ALREADY_MARKED';
  END IF;
  -- Checked before branching: case_task_create would default a NULL
  -- owner to the case agent.
  IF p_owner IS NULL THEN
    RAISE EXCEPTION 'an action needs an owner' USING ERRCODE = 'check_violation', HINT = 'OWNER_INVALID';
  END IF;
  SELECT r.case_id INTO v_case FROM public.bank_ws_posts r WHERE r.thread_id = p_thread AND r.parent_post_id IS NULL;
  IF v_case IS NOT NULL THEN
    v_task := public.case_task_create(v_case, p_actor, 'bank_ws_action_needed', p_owner, p_due_at, p_now);
  ELSIF public.bank_ws_access(t.bank_ws_id, p_owner) IS DISTINCT FROM 'member' THEN
    RAISE EXCEPTION 'user % may not own an action of this bank workspace', p_owner
      USING ERRCODE = 'check_violation', HINT = 'OWNER_INVALID';
  END IF;
  INSERT INTO public.bank_ws_actions (thread_id, bank_ws_id, account_id, owner_id, due_at, case_id, task_id,
                                      created_by, created_at)
  VALUES (p_thread, t.bank_ws_id, t.account_id, p_owner, p_due_at, v_case, v_task, p_actor, coalesce(p_now, now()))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- The workspace's actions by due date. Task status only when the viewer
-- may read the case.
CREATE OR REPLACE FUNCTION public.bank_ws_actions_list(p_bank_ws uuid, p_actor uuid)
RETURNS TABLE (action_id uuid, thread_id uuid, owner_id uuid, due_at timestamptz, case_id uuid, task_id uuid,
  task_status text, created_by uuid, created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT a.id, a.thread_id, a.owner_id, a.due_at, a.case_id, a.task_id,
         CASE WHEN v.role IS NOT NULL
                   AND (v.role IN ('super_admin', 'admin') OR c.agent_id = p_actor
                        OR c.coordinator_id = p_actor OR c.agent_id = ANY (v.team_agents))
              THEN k.status END,
         a.created_by, a.created_at
    FROM public.bank_workspaces w
   CROSS JOIN LATERAL public.bank_ws_viewer(w.account_id, p_actor) v
    JOIN public.bank_ws_actions a ON a.bank_ws_id = w.id
    LEFT JOIN public.cases c ON c.id = a.case_id AND c.account_id = a.account_id
    LEFT JOIN public.case_tasks k ON k.id = a.task_id AND k.account_id = a.account_id
   WHERE w.id = p_bank_ws AND public.bank_ws_access(w.id, p_actor) IS NOT NULL
   ORDER BY a.due_at, a.id
$$;

-- ---------- 7. Append-only (case_append_only is 122's) ----------

DROP TRIGGER IF EXISTS bank_workspaces_append_only ON public.bank_workspaces;
CREATE TRIGGER bank_workspaces_append_only
  BEFORE UPDATE OR DELETE ON public.bank_workspaces FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS bank_workspaces_no_truncate ON public.bank_workspaces;
CREATE TRIGGER bank_workspaces_no_truncate
  BEFORE TRUNCATE ON public.bank_workspaces FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS bank_ws_pins_append_only ON public.bank_ws_pins;
CREATE TRIGGER bank_ws_pins_append_only
  BEFORE UPDATE OR DELETE ON public.bank_ws_pins FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS bank_ws_pins_no_truncate ON public.bank_ws_pins;
CREATE TRIGGER bank_ws_pins_no_truncate
  BEFORE TRUNCATE ON public.bank_ws_pins FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS bank_ws_threads_append_only ON public.bank_ws_threads;
CREATE TRIGGER bank_ws_threads_append_only
  BEFORE UPDATE OR DELETE ON public.bank_ws_threads FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS bank_ws_threads_no_truncate ON public.bank_ws_threads;
CREATE TRIGGER bank_ws_threads_no_truncate
  BEFORE TRUNCATE ON public.bank_ws_threads FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS bank_ws_posts_append_only ON public.bank_ws_posts;
CREATE TRIGGER bank_ws_posts_append_only
  BEFORE UPDATE OR DELETE ON public.bank_ws_posts FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS bank_ws_posts_no_truncate ON public.bank_ws_posts;
CREATE TRIGGER bank_ws_posts_no_truncate
  BEFORE TRUNCATE ON public.bank_ws_posts FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS bank_ws_post_retractions_append_only ON public.bank_ws_post_retractions;
CREATE TRIGGER bank_ws_post_retractions_append_only
  BEFORE UPDATE OR DELETE ON public.bank_ws_post_retractions FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS bank_ws_post_retractions_no_truncate ON public.bank_ws_post_retractions;
CREATE TRIGGER bank_ws_post_retractions_no_truncate
  BEFORE TRUNCATE ON public.bank_ws_post_retractions FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS bank_ws_actions_append_only ON public.bank_ws_actions;
CREATE TRIGGER bank_ws_actions_append_only
  BEFORE UPDATE OR DELETE ON public.bank_ws_actions FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS bank_ws_actions_no_truncate ON public.bank_ws_actions;
CREATE TRIGGER bank_ws_actions_no_truncate
  BEFORE TRUNCATE ON public.bank_ws_actions FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();

-- ---------- 8. RLS (authenticated, active account) ----------

DROP POLICY IF EXISTS bank_workspaces_select ON public.bank_workspaces;
CREATE POLICY bank_workspaces_select ON public.bank_workspaces FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id()) AND public.bank_ws_rls_access(id));
DROP POLICY IF EXISTS bank_ws_pins_select ON public.bank_ws_pins;
CREATE POLICY bank_ws_pins_select ON public.bank_ws_pins FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id()) AND public.bank_ws_rls_access(bank_ws_id));
DROP POLICY IF EXISTS bank_ws_threads_select ON public.bank_ws_threads;
CREATE POLICY bank_ws_threads_select ON public.bank_ws_threads FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id()) AND public.bank_ws_rls_access(bank_ws_id));
-- bank_ws_posts: no policy and no grant (a retracted body stays in the row).
DROP POLICY IF EXISTS bank_ws_post_retractions_select ON public.bank_ws_post_retractions;
CREATE POLICY bank_ws_post_retractions_select ON public.bank_ws_post_retractions FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id()) AND public.bank_ws_rls_access(bank_ws_id));
DROP POLICY IF EXISTS bank_ws_actions_select ON public.bank_ws_actions;
CREATE POLICY bank_ws_actions_select ON public.bank_ws_actions FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id()) AND public.bank_ws_rls_access(bank_ws_id));

-- ---------- 9. Privileges ----------

REVOKE ALL ON public.bank_workspaces, public.bank_ws_pins, public.bank_ws_threads, public.bank_ws_posts,
  public.bank_ws_post_retractions, public.bank_ws_actions
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.bank_ws_pins_id_seq FROM PUBLIC, anon, authenticated, service_role;
-- Not bank_ws_posts (see the header); service_role reads nothing directly.
GRANT SELECT ON public.bank_workspaces, public.bank_ws_pins, public.bank_ws_threads,
  public.bank_ws_post_retractions, public.bank_ws_actions
  TO authenticated;

REVOKE ALL ON FUNCTION
  public.bank_ws_viewer(uuid, uuid),
  public.bank_ws_access(uuid, uuid),
  public.bank_ws_rls_access(uuid),
  public.bank_ws_require_member(uuid, uuid),
  public.bank_ws_link_case(uuid, text, uuid, uuid, uuid),
  public.bank_ws_check_body(text),
  public.bank_ws_create(uuid, uuid, text, timestamptz),
  public.bank_ws_list(uuid, uuid),
  public.bank_ws_cases(uuid, uuid),
  public.bank_ws_pin_set(uuid, uuid, text, text, timestamptz),
  public.bank_ws_pins_list(uuid, uuid, boolean),
  public.bank_ws_thread_create(uuid, uuid, text, text, uuid, uuid, timestamptz),
  public.bank_ws_post_add(uuid, uuid, uuid, text, uuid, uuid, timestamptz),
  public.bank_ws_post_retract(uuid, uuid, timestamptz),
  public.bank_ws_threads_list(uuid, uuid),
  public.bank_ws_posts_list(uuid, uuid),
  public.bank_ws_action_mark(uuid, uuid, uuid, timestamptz, timestamptz),
  public.bank_ws_actions_list(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.bank_ws_create(uuid, uuid, text, timestamptz),
  public.bank_ws_list(uuid, uuid),
  public.bank_ws_cases(uuid, uuid),
  public.bank_ws_pin_set(uuid, uuid, text, text, timestamptz),
  public.bank_ws_pins_list(uuid, uuid, boolean),
  public.bank_ws_thread_create(uuid, uuid, text, text, uuid, uuid, timestamptz),
  public.bank_ws_post_add(uuid, uuid, uuid, text, uuid, uuid, timestamptz),
  public.bank_ws_post_retract(uuid, uuid, timestamptz),
  public.bank_ws_threads_list(uuid, uuid),
  public.bank_ws_posts_list(uuid, uuid),
  public.bank_ws_action_mark(uuid, uuid, uuid, timestamptz, timestamptz),
  public.bank_ws_actions_list(uuid, uuid)
  TO service_role;
-- The RLS policies call this as the reader.
GRANT EXECUTE ON FUNCTION public.bank_ws_rls_access(uuid) TO authenticated;

RESET lock_timeout;
