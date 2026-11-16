-- 201: HR department topics widen from six to eleven (packages 023e / 023g).
--
-- Apply after 200. The topic list lives in two places, the CHECK on
-- hr_conversations.topic and hr_set_topic's own guard; both change here.
-- hr_workflow_rules has no topic list (trigger_value is free text) and the
-- five new topics fire no rule, so the rules are untouched.
--
-- Re-running 200 after 201 narrows hr_set_topic back to six topics: re-run
-- 201 after it (apply in order, once). Re-runnable itself.

ALTER TABLE public.hr_conversations DROP CONSTRAINT IF EXISTS hr_conversations_topic_check;
ALTER TABLE public.hr_conversations ADD CONSTRAINT hr_conversations_topic_check CHECK (
    topic IS NULL
    OR topic IN ('onboarding', 'visa_documents', 'leave_attendance', 'payroll', 'complaint', 'other', 'offer_letter', 'training', 'warning_letter', 'message', 'termination'));

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
       ('onboarding', 'visa_documents', 'leave_attendance', 'payroll', 'complaint', 'other', 'offer_letter', 'training', 'warning_letter', 'message', 'termination') THEN
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
