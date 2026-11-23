-- ============================================================
-- 266_member_handover.sql — hand over the work of a person who leaves
--
-- Deactivating a member (069) leaves their chats, open tasks, open deals
-- and customers with them: the customer writes to somebody who is gone.
--
--  1. member_work_counts(person): what one person still holds.
--     members_left_work(): the same for every deactivated member.
--  2. member_handover(from, to, what): moves it, in one transaction.
--     Only an owner or admin of the active workspace, as themselves, so
--     the assignment, task, deal and personal-chat guards all run.
--     A personal chat (191) never moves. A contact with an assigned chat
--     follows that chat (169), so "contacts" are the others.
--  3. One bell, not one per row: both assignment triggers are silent
--     while app.member_handover is on (only member_handover sets it;
--     clients have no SQL access and PostgREST sets only request.*), and
--     one work_handed_over bell is sent instead.
--  4. One workspace_audit row per handover that moved something.
--
-- Locks: per-workspace handover lock, then 192's inbox-department lock
-- shared (its trigger takes it per chat; taken after the chat rows it
-- could deadlock with a recompute), then chats, contacts, tasks, deals,
-- each in id order. No profile is locked: 192's recompute takes the
-- profile on either side of its lock depending on the caller, and a
-- person deactivated meanwhile is the same as deactivated just after.
--
-- Restates notify_conversation_assigned (083) and tasks_notify_assigned
-- (089), and widens two CHECKs: apply in order, once.
-- Additive for the previous build. Re-runnable.
-- Asserted by supabase/ci/verify-member-handover.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '266 must be applied by a superuser or BYPASSRLS role';
  END IF;
  IF to_regprocedure('public.inbox_department_lock_key(uuid)') IS NULL THEN
    RAISE EXCEPTION '266: apply 192 first (inbox_department_lock_key)';
  END IF;
  IF to_regprocedure('public.member_lately_admin(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '266: apply 265_guards.sql first';
  END IF;
END $$;

-- ---------- 1. The bell type and the audit action ----------

-- Adds to whatever list is there, so a re-run undoes nothing later.
DO $$
DECLARE
  r      record;
  v_def  text;
  v_list text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('notifications', 'notifications_type_check', 'type'),
      ('workspace_audit', 'workspace_audit_action_check', 'action')) AS t(tab, con, col)
  LOOP
    SELECT pg_get_constraintdef(oid) INTO v_def
      FROM pg_constraint
     WHERE conrelid = format('public.%I', r.tab)::regclass AND conname = r.con;
    IF v_def IS NULL THEN
      RAISE EXCEPTION '266: % is missing', r.con;
    END IF;
    CONTINUE WHEN position(quote_literal('work_handed_over') IN v_def) > 0;
    SELECT string_agg(quote_literal(x), ', ') INTO v_list
      FROM (
        SELECT DISTINCT q.m[1] AS x FROM regexp_matches(v_def, '''([^'']+)''', 'g') AS q(m)
        UNION
        SELECT 'work_handed_over'
      ) vals;
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', r.tab, r.con);
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%I IN (%s)) NOT VALID',
                   r.tab, r.con, r.col, v_list);
    EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', r.tab, r.con);
  END LOOP;
END $$;

-- ---------- 2. Silent while a handover runs ----------

-- 083's body; the first check is new.
CREATE OR REPLACE FUNCTION public.notify_conversation_assigned()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_contact_name TEXT;
  v_actor_name TEXT;
BEGIN
  IF current_setting('app.member_handover', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_agent_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.assigned_agent_id IS NULL
       OR NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id THEN
      RETURN NEW;
    END IF;
  END IF;
  IF auth.uid() IS NOT NULL AND auth.uid() = NEW.assigned_agent_id THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE(NULLIF(name, ''), phone) INTO v_contact_name
  FROM contacts WHERE id = NEW.contact_id;
  IF auth.uid() IS NOT NULL THEN
    SELECT full_name INTO v_actor_name
    FROM profiles WHERE user_id = auth.uid() AND account_id = NEW.account_id;
  END IF;
  INSERT INTO notifications (
    account_id, user_id, type, conversation_id, contact_id,
    actor_user_id, title, body
  ) VALUES (
    NEW.account_id,
    NEW.assigned_agent_id,
    'conversation_assigned',
    NEW.id,
    NEW.contact_id,
    auth.uid(),
    'New conversation assigned',
    COALESCE(v_actor_name, 'Someone') || ' assigned you a conversation with '
      || COALESCE(v_contact_name, 'a contact')
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to create assignment notification for conversation %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$function$;

-- 089's body; the first check is new.
CREATE OR REPLACE FUNCTION public.tasks_notify_assigned()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_setting('app.member_handover', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF NEW.assigned_to IS NULL OR NEW.status <> 'open' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.assigned_to IS NOT DISTINCT FROM OLD.assigned_to THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.source = 'pbx' THEN
    RETURN NEW;
  END IF;
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

-- ---------- 3. What somebody still holds ----------

-- The one definition of "their work"; member_handover moves the same rows.
CREATE OR REPLACE FUNCTION public.member_work(p_account uuid, p_users uuid[])
RETURNS TABLE (user_id uuid, chats integer, tasks integer, deals integer, contacts integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT u.id,
    -- Any status: a closed chat reopens when the customer writes.
    (SELECT count(*)::integer FROM public.conversations c
      WHERE c.account_id = p_account AND c.assigned_agent_id = u.id
        AND c.personal_owner_id IS NULL),
    (SELECT count(*)::integer FROM public.tasks t
      WHERE t.account_id = p_account AND t.assigned_to = u.id AND t.status = 'open'),
    coalesce(d.n, 0),
    (SELECT count(*)::integer FROM public.contacts k
      WHERE k.account_id = p_account AND k.user_id = u.id
        AND NOT EXISTS (SELECT 1 FROM public.conversations c
                         WHERE c.contact_id = k.id AND c.account_id = p_account
                           AND c.personal_owner_id IS NULL
                           AND c.assigned_agent_id IS NOT NULL))
    FROM unnest(p_users) AS u(id)
    LEFT JOIN (SELECT public.deal_owner(x.assigned_to, x.user_id) AS owner, count(*)::integer AS n
                 FROM public.deals x
                WHERE x.account_id = p_account AND x.status = 'open'
                GROUP BY 1) d ON d.owner = u.id
$$;

REVOKE ALL ON FUNCTION public.member_work(uuid, uuid[]) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.member_work_counts(p_user uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_acct uuid := public.current_account_id();
  r      record;
BEGIN
  IF auth.uid() IS NULL OR v_acct IS NULL OR public.current_role_rank() < 4 THEN
    RAISE EXCEPTION 'This action requires the admin role or higher' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = p_user AND p.account_id = v_acct) THEN
    PERFORM public.raise_not_a_member(p_user);
  END IF;
  SELECT * INTO r FROM public.member_work(v_acct, ARRAY[p_user]);
  RETURN jsonb_build_object('chats', r.chats, 'tasks', r.tasks, 'deals', r.deals, 'contacts', r.contacts);
END;
$$;

CREATE OR REPLACE FUNCTION public.members_left_work()
RETURNS TABLE (user_id uuid, chats integer, tasks integer, deals integer, contacts integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_acct uuid := public.current_account_id();
BEGIN
  IF auth.uid() IS NULL OR v_acct IS NULL OR public.current_role_rank() < 4 THEN
    RAISE EXCEPTION 'This action requires the admin role or higher' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT w.* FROM public.member_work(v_acct, ARRAY(
      SELECT p.user_id FROM public.profiles p
       WHERE p.account_id = v_acct AND p.deactivated_at IS NOT NULL
         AND p.account_role::text <> 'bank_guest')) w
     WHERE w.chats + w.tasks + w.deals + w.contacts > 0
     ORDER BY w.user_id;
END;
$$;

-- ---------- 4. The handover ----------

CREATE OR REPLACE FUNCTION public.member_handover(p_from uuid, p_to uuid, p_what text[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_acct      uuid := public.current_account_id();
  v_from_role text;
  v_from_name text;
  v_from_dept text;
  v_to        record;
  v_ids       uuid[];
  n_chats     integer := 0;
  n_tasks     integer := 0;
  n_deals     integer := 0;
  n_contacts  integer := 0;
  v_moved     jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_acct IS NULL OR public.current_role_rank() < 4 THEN
    RAISE EXCEPTION 'This action requires the admin role or higher' USING ERRCODE = '42501';
  END IF;
  IF p_what IS NULL OR cardinality(p_what) = 0
     OR NOT p_what <@ ARRAY['chats', 'tasks', 'deals', 'contacts'] THEN
    RAISE EXCEPTION 'Choose what to hand over: chats, tasks, deals or contacts' USING ERRCODE = '22023';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from = p_to THEN
    RAISE EXCEPTION 'Choose someone else to hand the work to' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member_handover:' || v_acct::text, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(public.inbox_department_lock_key(v_acct));

  SELECT p.account_role::text, nullif(btrim(p.full_name), ''), p.department
    INTO v_from_role, v_from_name, v_from_dept
    FROM public.profiles p WHERE p.user_id = p_from AND p.account_id = v_acct;
  IF NOT FOUND THEN
    PERFORM public.raise_not_a_member(p_from);
  END IF;
  IF v_from_role = 'bank_guest' THEN
    RAISE EXCEPTION 'A bank guest has no work to hand over' USING ERRCODE = '22023';
  END IF;
  SELECT p.id, p.account_role::text AS role, p.deactivated_at, p.department INTO v_to
    FROM public.profiles p WHERE p.user_id = p_to AND p.account_id = v_acct;
  IF NOT FOUND THEN
    PERFORM public.raise_not_a_member(p_to);
  END IF;
  IF v_to.deactivated_at IS NOT NULL THEN
    RAISE EXCEPTION 'The person receiving the work is deactivated' USING ERRCODE = '22023';
  END IF;
  IF v_to.role NOT IN ('owner', 'admin', 'team_leader', 'agent') THEN
    RAISE EXCEPTION 'Work can only be handed to an agent, team leader, admin or owner' USING ERRCODE = '22023';
  END IF;
  -- Between departments (192), tasks aside: a restricted one has no sales
  -- areas, and one with its own inbox (HR) keeps its chats. Colleagues of
  -- the same department take everything over, owners and admins always.
  IF p_what && ARRAY['chats', 'deals', 'contacts']
     AND v_to.role NOT IN ('owner', 'admin')
     AND v_to.department IS DISTINCT FROM v_from_dept THEN
    IF public.department_restricted(v_acct, v_to.department) THEN
      RAISE EXCEPTION 'This person''s department has no access to sales: they can only take over tasks'
        USING ERRCODE = '22023';
    END IF;
    IF public.department_own_inbox(v_acct, v_from_dept) THEN
      RAISE EXCEPTION 'This person''s department has its own inbox: hand their work to a colleague there, an admin or the owner'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  PERFORM pg_catalog.set_config('app.member_handover', 'on', true);

  IF 'chats' = ANY (p_what) THEN
    v_ids := ARRAY(
      SELECT c.id FROM public.conversations c
       WHERE c.account_id = v_acct AND c.assigned_agent_id = p_from AND c.personal_owner_id IS NULL
       ORDER BY c.id FOR NO KEY UPDATE);
    -- 169's trigger moves each contact as its chat moves.
    PERFORM 1 FROM public.contacts k
      WHERE k.account_id = v_acct
        AND k.id IN (SELECT c.contact_id FROM public.conversations c WHERE c.id = ANY (v_ids))
      ORDER BY k.id FOR NO KEY UPDATE;
    UPDATE public.conversations c SET assigned_agent_id = p_to WHERE c.id = ANY (v_ids);
    GET DIAGNOSTICS n_chats = ROW_COUNT;
  END IF;

  IF 'contacts' = ANY (p_what) THEN
    v_ids := ARRAY(
      SELECT k.id FROM public.contacts k
       WHERE k.account_id = v_acct AND k.user_id = p_from
         AND NOT EXISTS (SELECT 1 FROM public.conversations c
                          WHERE c.contact_id = k.id AND c.account_id = v_acct
                            AND c.personal_owner_id IS NULL
                            AND c.assigned_agent_id IS NOT NULL)
       ORDER BY k.id FOR NO KEY UPDATE);
    UPDATE public.contacts k SET user_id = p_to WHERE k.id = ANY (v_ids);
    GET DIAGNOSTICS n_contacts = ROW_COUNT;
  END IF;

  IF 'tasks' = ANY (p_what) THEN
    v_ids := ARRAY(
      SELECT t.id FROM public.tasks t
       WHERE t.account_id = v_acct AND t.assigned_to = p_from AND t.status = 'open'
       ORDER BY t.id FOR NO KEY UPDATE);
    UPDATE public.tasks t SET assigned_to = p_to WHERE t.id = ANY (v_ids);
    GET DIAGNOSTICS n_tasks = ROW_COUNT;
  END IF;

  IF 'deals' = ANY (p_what) THEN
    v_ids := ARRAY(
      SELECT d.id FROM public.deals d
       WHERE d.account_id = v_acct AND d.status = 'open'
         AND public.deal_owner(d.assigned_to, d.user_id) = p_from
       ORDER BY d.id FOR NO KEY UPDATE);
    -- The assignee is the owner, so the creator (user_id) stays (080).
    UPDATE public.deals d SET assigned_to = v_to.id WHERE d.id = ANY (v_ids);
    GET DIAGNOSTICS n_deals = ROW_COUNT;
  END IF;

  PERFORM pg_catalog.set_config('app.member_handover', '', true);

  v_moved := jsonb_build_object(
    'chats', n_chats, 'tasks', n_tasks, 'deals', n_deals, 'contacts', n_contacts);
  IF n_chats + n_tasks + n_deals + n_contacts = 0 THEN
    RETURN v_moved;
  END IF;

  IF p_to <> auth.uid() THEN
    INSERT INTO public.notifications (account_id, user_id, type, actor_user_id, title, body, meta)
    VALUES (v_acct, p_to, 'work_handed_over', auth.uid(), 'Work handed over to you',
      concat_ws(', ',
        CASE WHEN n_chats > 0 THEN n_chats || CASE WHEN n_chats = 1 THEN ' chat' ELSE ' chats' END END,
        CASE WHEN n_tasks > 0 THEN n_tasks || CASE WHEN n_tasks = 1 THEN ' task' ELSE ' tasks' END END,
        CASE WHEN n_deals > 0 THEN n_deals || CASE WHEN n_deals = 1 THEN ' deal' ELSE ' deals' END END,
        CASE WHEN n_contacts > 0 THEN n_contacts || CASE WHEN n_contacts = 1 THEN ' customer' ELSE ' customers' END END)
        || ' from ' || coalesce(v_from_name, 'a colleague'),
      jsonb_build_object('from', p_from) || v_moved);
  END IF;

  -- name: how the audit screen shows someone with no profile left (092).
  INSERT INTO public.workspace_audit (account_id, actor_id, action, target_user_id, detail)
  VALUES (v_acct, auth.uid(), 'work_handed_over', p_from,
          jsonb_strip_nulls(jsonb_build_object('to', p_to, 'name', v_from_name)) || v_moved);
  RETURN v_moved;
END;
$$;

REVOKE ALL ON FUNCTION public.member_work_counts(uuid), public.members_left_work(),
  public.member_handover(uuid, uuid, text[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.member_work_counts(uuid), public.members_left_work(),
  public.member_handover(uuid, uuid, text[]) TO authenticated;

COMMENT ON FUNCTION public.member_handover(uuid, uuid, text[]) IS
  'Moves a person''s company chats, open tasks, open deals and unassigned contacts to a colleague in the caller''s active account (owner/admin only); one bell and one audit row. Migration 266.';

DO $$ BEGIN
  IF (SELECT count(*) FROM pg_constraint
       WHERE conname IN ('notifications_type_check', 'workspace_audit_action_check')
         AND pg_get_constraintdef(oid) LIKE '%work_handed_over%' AND convalidated) <> 2
     OR has_function_privilege('anon', 'public.member_handover(uuid,uuid,text[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.member_handover(uuid,uuid,text[])', 'EXECUTE') THEN
    RAISE EXCEPTION '266 did not apply completely';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
