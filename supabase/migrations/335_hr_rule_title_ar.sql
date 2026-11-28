-- ============================================================
-- 335_hr_rule_title_ar.sql — Arabic task titles for HR workflow rules
-- (package 023b `title_ar`).
--
-- HR rules (200) create tasks with an English-only title, so an Arabic
-- user reads English. This migration:
--   1. adds a nullable hr_workflow_rules.title_ar (task rules only,
--      1..300 characters when set) and fills the Arabic default of every
--      seeded rule whose English title is still the seeded one;
--   2. restates hr_seed_rules (200) so a newly seeded account gets the
--      Arabic defaults too;
--   3. restates hr_apply_rule (200, the latest body; 302 only calls it)
--      so the task snapshots the rule's Arabic title as
--      tasks.meta.hr_title_ar. Still one task row; tasks created before
--      this migration stay English;
--   4. replaces hr_rule_set (200) with one that takes p_title_ar (NULL
--      keeps it, a blank string clears it). The old five-argument
--      signature is DROPPED first: two overloads would make PostgREST's
--      named call ambiguous.
--
-- Apply in order, once: re-applying 200 after this file brings back the
-- English-only hr_seed_rules / hr_apply_rule and the five-argument
-- hr_rule_set beside the new one. Re-running THIS file is safe.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Column, check, Arabic defaults
-- ------------------------------------------------------------

ALTER TABLE public.hr_workflow_rules ADD COLUMN IF NOT EXISTS title_ar text NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'hr_workflow_rules_title_ar_check'
                    AND conrelid = 'public.hr_workflow_rules'::regclass) THEN
    ALTER TABLE public.hr_workflow_rules
      ADD CONSTRAINT hr_workflow_rules_title_ar_check CHECK (
        title_ar IS NULL
        OR (action = 'task' AND title_ar !~ '^[[:space:]]*$' AND char_length(title_ar) <= 300));
  END IF;
END;
$$;

COMMENT ON COLUMN public.hr_workflow_rules.title_ar IS
  'Arabic title of the task the rule creates (NULL: English only). Snapshotted into tasks.meta.hr_title_ar. Migration 335.';

-- The seeded rules' Arabic titles. Only a rule still carrying its
-- seeded English title gets one: a renamed rule's Arabic would not match.
UPDATE public.hr_workflow_rules w
   SET title_ar = d.title_ar
  FROM (VALUES
    ('stage_cv_review',         'Review CV',                      'مراجعة السيرة الذاتية'),
    ('stage_ai_interview',      'Send AI interview link',         'إرسال رابط مقابلة الذكاء الاصطناعي'),
    ('stage_hr_interview',      'Schedule HR interview',          'تحديد موعد مقابلة الموارد البشرية'),
    ('stage_manager_interview', 'Schedule manager interview',     'تحديد موعد مقابلة المدير'),
    ('topic_payroll',           'Check payroll query',            'مراجعة استفسار الرواتب'),
    ('topic_visa_documents',    'Check visa or document request', 'مراجعة طلب التأشيرة أو المستندات'),
    ('topic_complaint_task',    'Respond to complaint',           'الرد على الشكوى'),
    ('reply_overdue_recruiter', 'Reply to customer',              'الرد على العميل'),
    ('reply_overdue_dept',      'Reply to customer',              'الرد على العميل'),
    ('no_activity_recruiter',   'Chase candidate',                'متابعة المرشح')
  ) AS d(key, title, title_ar)
 WHERE w.key = d.key AND w.title = d.title AND w.action = 'task' AND w.title_ar IS NULL;

-- ------------------------------------------------------------
-- 2. hr_seed_rules (restated from 200, plus title_ar)
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
    (account_id, key, inbox, trigger_kind, trigger_value, action, flag, after_hours, due_hours, title, title_ar)
  VALUES
    (p_account, 'stage_cv_review',         'recruiter', 'stage', 'cv_review',         'task', NULL, NULL, 24, 'Review CV', 'مراجعة السيرة الذاتية'),
    (p_account, 'stage_ai_interview',      'recruiter', 'stage', 'ai_interview',      'task', NULL, NULL, 24, 'Send AI interview link', 'إرسال رابط مقابلة الذكاء الاصطناعي'),
    (p_account, 'stage_hr_interview',      'recruiter', 'stage', 'hr_interview',      'task', NULL, NULL, 48, 'Schedule HR interview', 'تحديد موعد مقابلة الموارد البشرية'),
    (p_account, 'stage_manager_interview', 'recruiter', 'stage', 'manager_interview', 'task', NULL, NULL, 48, 'Schedule manager interview', 'تحديد موعد مقابلة المدير'),
    (p_account, 'topic_payroll',           'dept',      'topic', 'payroll',           'task', NULL, NULL, 24, 'Check payroll query', 'مراجعة استفسار الرواتب'),
    (p_account, 'topic_visa_documents',    'dept',      'topic', 'visa_documents',    'task', NULL, NULL, 48, 'Check visa or document request', 'مراجعة طلب التأشيرة أو المستندات'),
    (p_account, 'topic_complaint_flag',    'dept',      'topic', 'complaint',         'set_flag', 'urgent', NULL, NULL, NULL, NULL),
    (p_account, 'topic_complaint_task',    'dept',      'topic', 'complaint',         'task', NULL, NULL, 4,  'Respond to complaint', 'الرد على الشكوى'),
    (p_account, 'reply_overdue_recruiter', 'recruiter', 'reply_overdue', NULL,        'task', NULL, 4,    0,  'Reply to customer', 'الرد على العميل'),
    (p_account, 'reply_overdue_dept',      'dept',      'reply_overdue', NULL,        'task', NULL, 4,    0,  'Reply to customer', 'الرد على العميل'),
    (p_account, 'no_activity_recruiter',   'recruiter', 'no_activity',   NULL,        'task', NULL, 72,   24, 'Chase candidate', 'متابعة المرشح')
  ON CONFLICT (account_id, key) DO NOTHING;
END;
$$;

-- ------------------------------------------------------------
-- 3. hr_apply_rule (restated from 200, plus meta.hr_title_ar)
-- ------------------------------------------------------------

-- Apply one rule to one HR row. Returns 1 when a task was created, 0
-- when already fired (or for a flag). The hr_rule_fired claim comes
-- first: an event fires once, even after its task is deleted.
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
  v_meta jsonb;
  n integer;
BEGIN
  INSERT INTO hr_rule_fired (conversation_id, rule_key, event, fired_at)
  VALUES (p_conversation_id, p_rule.key, p_event, p_now)
  ON CONFLICT ON CONSTRAINT hr_rule_fired_pkey DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN RETURN 0; END IF;

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

  v_meta := jsonb_build_object('hr_rule', p_rule.key, 'hr_inbox', p_rule.inbox);
  IF p_rule.title_ar IS NOT NULL THEN
    v_meta := v_meta || jsonb_build_object('hr_title_ar', p_rule.title_ar);
  END IF;

  INSERT INTO tasks (account_id, kind, title, contact_id, conversation_id, assigned_to,
                     due_at, source, source_ref, meta, created_by)
  -- contact_id NULL on purpose: see 200's header, point 4.
  VALUES (cv.account_id, 'follow_up', p_rule.title, NULL, cv.id, v_assignee,
          p_now + make_interval(hours => p_rule.due_hours), 'automation',
          'hr:' || cv.id::text || ':' || p_rule.key || ':' || p_event,
          v_meta, NULL)
  ON CONFLICT ON CONSTRAINT tasks_source_ref_key DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- ------------------------------------------------------------
-- 4. hr_rule_set (replaces 200's five-argument one)
-- ------------------------------------------------------------

DROP FUNCTION IF EXISTS public.hr_rule_set(text, boolean, integer, integer, text);

CREATE OR REPLACE FUNCTION public.hr_rule_set(
  p_key text, p_enabled boolean DEFAULT NULL, p_after_hours integer DEFAULT NULL,
  p_due_hours integer DEFAULT NULL, p_title text DEFAULT NULL, p_title_ar text DEFAULT NULL)
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
  -- A blank Arabic title clears it; a set one is 1..300 characters.
  IF p_title_ar IS NOT NULL
     AND (r.action <> 'task' OR char_length(btrim(p_title_ar)) > 300) THEN
    PERFORM hr_refuse('INVALID', 'an Arabic title is up to 300 characters on a task rule');
  END IF;
  UPDATE hr_workflow_rules w
     SET enabled     = COALESCE(p_enabled, w.enabled),
         after_hours = COALESCE(p_after_hours, w.after_hours),
         due_hours   = COALESCE(p_due_hours, w.due_hours),
         title       = COALESCE(btrim(p_title), w.title),
         title_ar    = CASE WHEN p_title_ar IS NULL THEN w.title_ar
                            WHEN p_title_ar ~ '^[[:space:]]*$' THEN NULL
                            ELSE btrim(p_title_ar) END,
         updated_at  = now(),
         updated_by  = auth.uid()
   WHERE w.account_id = v_account AND w.key = p_key
  RETURNING * INTO r;
  RETURN r;
END;
$$;

REVOKE ALL ON FUNCTION
  public.hr_seed_rules(uuid),
  public.hr_apply_rule(public.hr_workflow_rules, uuid, text, timestamptz),
  public.hr_rule_set(text, boolean, integer, integer, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.hr_rule_set(text, boolean, integer, integer, text, text)
  TO authenticated;
