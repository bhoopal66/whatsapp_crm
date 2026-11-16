-- ============================================================
-- 202_hr_agents.sql — recruiter AI agents: drafts and switches.
--
-- Port of package releases 024a/026 (recruiter agents) onto 200's HR
-- chats. Agents only DRAFT replies for the recruiter inbox; a person
-- approves or rejects every draft. NOTHING here sends a message, and no
-- function writes messages, tasks or contacts.
--
--   1. ai_usage_log.mode gains 'hr_agent' (the agents' token spend).
--      Re-running 154 after 202 fails while 'hr_agent' usage rows exist:
--      apply in order.
--   2. hr_agent_settings: one row per (account, agent kind); no row = off.
--      'orchestrator' is the master switch. Written only by
--      hr_agent_settings_set (recruiter lead or admin).
--   3. hr_agent_drafts: one row per draft, at most 3 pending per chat
--      (LIMIT), one per (chat, source message) (idempotent create).
--      Drafts belong to an hr_conversations row and die with it.
--   4. Visibility is 200's: a draft is read by a recruiter member, lead
--      or admin of the account who can see the chat (hr_can_see). The
--      switches are read by anyone with a recruiter role. No client
--      writes on either table.
--   5. System writers (the inbound hook, the cron) use service-role-only
--      functions with no auth.uid(): hr_agent_context, hr_agent_draft_create,
--      hr_agent_flag_urgent, hr_agent_supersede, hr_agent_expire.
--
-- Refusals (via 200's hr_refuse): NOT_ALLOWED | NOT_FOUND | INVALID |
-- CLOSED | LIMIT | OPTED_OUT | ALREADY_DECIDED.
-- Apply after 200. Re-runnable. No BEGIN/COMMIT.
-- ============================================================

SET lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. ai_usage_log.mode gains 'hr_agent'
-- ------------------------------------------------------------

ALTER TABLE public.ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_mode_check;
ALTER TABLE public.ai_usage_log
  ADD CONSTRAINT ai_usage_log_mode_check
  CHECK (mode IN ('auto_reply', 'draft', 'translate', 'hr_agent'));

-- ------------------------------------------------------------
-- 2. Tables
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.hr_agent_settings (
  account_id  uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  agent_kind  text NOT NULL,
  enabled     boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT hr_agent_settings_pkey PRIMARY KEY (account_id, agent_kind),
  CONSTRAINT hr_agent_settings_kind_check CHECK (
    agent_kind IN ('orchestrator', 'cv_screening', 'scheduling', 'candidate_faq', 'escalation'))
);

CREATE TABLE IF NOT EXISTS public.hr_agent_drafts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  conversation_id   uuid NOT NULL REFERENCES public.hr_conversations(conversation_id) ON DELETE CASCADE,
  -- messages.id the run answered. No FK: a draft outlives nothing it
  -- needs from the message, and the message table is hot.
  source_message_id uuid NULL,
  agent_kind        text NOT NULL,
  intent            text NOT NULL,
  body              text NOT NULL DEFAULT '',
  lang              text NOT NULL DEFAULT 'en',
  requires_template boolean NOT NULL DEFAULT false,
  handoff_reason    text NULL,
  status            text NOT NULL DEFAULT 'pending',
  decided_by        uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at        timestamptz NULL,
  reject_reason     text NULL,
  trace             jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- NULL = the inbound hook; else the staff member who asked for it.
  created_by        uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hr_agent_drafts_kind_check CHECK (
    agent_kind IN ('orchestrator', 'cv_screening', 'scheduling', 'candidate_faq', 'escalation')),
  CONSTRAINT hr_agent_drafts_intent_check CHECK (
    intent IN ('cv_received', 'schedule_interview', 'question_role', 'question_process',
               'salary_offer_visa', 'upset', 'opt_out', 'other')),
  CONSTRAINT hr_agent_drafts_body_check CHECK (char_length(body) <= 4000),
  CONSTRAINT hr_agent_drafts_lang_check CHECK (lang IN ('en', 'ar')),
  CONSTRAINT hr_agent_drafts_handoff_check CHECK (
    handoff_reason IN ('keyword', 'no_knowledge', 'model', 'error', 'cap', 'triage', 'guardrail', 'kb')),
  CONSTRAINT hr_agent_drafts_status_check CHECK (
    status IN ('pending', 'approved', 'rejected', 'expired', 'superseded')),
  CONSTRAINT hr_agent_drafts_reject_reason_check CHECK (
    reject_reason IS NULL OR char_length(reject_reason) BETWEEN 1 AND 500)
);

CREATE UNIQUE INDEX IF NOT EXISTS hr_agent_drafts_source_uidx
  ON public.hr_agent_drafts (conversation_id, source_message_id)
  WHERE source_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS hr_agent_drafts_conversation_idx
  ON public.hr_agent_drafts (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hr_agent_drafts_pending_idx
  ON public.hr_agent_drafts (created_at) WHERE status = 'pending';

COMMENT ON TABLE public.hr_agent_settings IS
  'Per-account recruiter agent switches; no row = off, orchestrator = master switch. Written only by hr_agent_settings_set. Migration 202.';
COMMENT ON TABLE public.hr_agent_drafts IS
  'Recruiter agent reply drafts; a person approves or rejects each one. Nothing here sends. Migration 202.';

-- Guard: the draft's account is its HR row's account; identity frozen.
CREATE OR REPLACE FUNCTION public.hr_agent_drafts_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.id IS DISTINCT FROM OLD.id
          OR NEW.account_id IS DISTINCT FROM OLD.account_id
          OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
          OR NEW.source_message_id IS DISTINCT FROM OLD.source_message_id
          OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'A draft''s identity cannot be changed'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (
       SELECT 1 FROM hr_conversations h
        WHERE h.conversation_id = NEW.conversation_id AND h.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'The draft''s account must be its HR chat''s account'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS hr_agent_drafts_guard ON public.hr_agent_drafts;
CREATE TRIGGER hr_agent_drafts_guard
  BEFORE INSERT OR UPDATE ON public.hr_agent_drafts
  FOR EACH ROW EXECUTE FUNCTION public.hr_agent_drafts_guard();

-- ------------------------------------------------------------
-- 3. RLS, grants (no client writes)
-- ------------------------------------------------------------

-- The caller's recruiter role in an account (200's hr_role for auth.uid()).
CREATE OR REPLACE FUNCTION public.hr_my_recruiter_role(p_account uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT hr_role(p_account, auth.uid(), 'recruiter')
$$;

ALTER TABLE public.hr_agent_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_agent_drafts   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hr_agent_settings_select ON public.hr_agent_settings;
CREATE POLICY hr_agent_settings_select ON public.hr_agent_settings
  FOR SELECT USING (
    account_id = (SELECT current_account_id())
    AND public.hr_my_recruiter_role(account_id) IS NOT NULL);

DROP POLICY IF EXISTS hr_agent_drafts_select ON public.hr_agent_drafts;
CREATE POLICY hr_agent_drafts_select ON public.hr_agent_drafts
  FOR SELECT USING (
    account_id = (SELECT current_account_id())
    AND public.hr_my_recruiter_role(account_id) IS NOT NULL
    AND public.hr_can_see(conversation_id));

REVOKE ALL ON public.hr_agent_settings, public.hr_agent_drafts
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.hr_agent_settings, public.hr_agent_drafts
  TO authenticated, service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
      AND tablename = 'hr_agent_drafts'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.hr_agent_drafts;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 4. Functions run as the user
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.hr_agent_settings_set(p_agent_kind text, p_enabled boolean)
RETURNS public.hr_agent_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid := current_account_id();
  s hr_agent_settings;
BEGIN
  IF v_account IS NULL
     OR COALESCE(hr_role(v_account, auth.uid(), 'recruiter'), '') NOT IN ('lead', 'admin') THEN
    PERFORM hr_refuse('NOT_ALLOWED', 'only a recruiter lead or an admin may switch agents');
  END IF;
  IF p_agent_kind IS NULL
     OR p_agent_kind NOT IN ('orchestrator', 'cv_screening', 'scheduling', 'candidate_faq', 'escalation')
     OR p_enabled IS NULL THEN
    PERFORM hr_refuse('INVALID', 'unknown agent kind or missing enabled value');
  END IF;
  INSERT INTO hr_agent_settings AS x (account_id, agent_kind, enabled, updated_at, updated_by)
  VALUES (v_account, p_agent_kind, p_enabled, now(), auth.uid())
  ON CONFLICT (account_id, agent_kind) DO UPDATE
    SET enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
  RETURNING * INTO s;
  RETURN s;
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_agent_draft_decide(
  p_draft_id uuid, p_decision text, p_reason text DEFAULT NULL)
RETURNS public.hr_agent_drafts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  d hr_agent_drafts;
  v_reason text := p_reason;
BEGIN
  SELECT * INTO d FROM hr_agent_drafts x WHERE x.id = p_draft_id FOR UPDATE;
  IF NOT FOUND OR d.account_id IS DISTINCT FROM current_account_id()
     OR NOT hr_can_see(d.conversation_id) THEN
    PERFORM hr_refuse('NOT_FOUND', 'draft not found');
  END IF;
  IF COALESCE(hr_role(d.account_id, auth.uid(), 'recruiter'), '') NOT IN ('member', 'lead', 'admin') THEN
    PERFORM hr_refuse('NOT_ALLOWED', 'you may not decide recruiter drafts');
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN
    PERFORM hr_refuse('INVALID', 'decision is approve|reject');
  END IF;
  IF d.status <> 'pending' THEN
    PERFORM hr_refuse('ALREADY_DECIDED', format('draft is already %s', d.status));
  END IF;
  IF p_decision = 'approve' AND (d.body ~ '^[[:space:]]*$' OR d.requires_template) THEN
    PERFORM hr_refuse('INVALID', 'an empty draft or one that needs a template cannot be approved');
  END IF;
  -- The contact may have opted out by another path since the draft was
  -- written (the bot, the TypeSafe watch, a STOP): approving would send.
  -- Rejecting stays allowed.
  IF p_decision = 'approve' AND EXISTS (
       SELECT 1 FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
        WHERE c.id = d.conversation_id AND ct.opted_out_at IS NOT NULL) THEN
    PERFORM hr_refuse('OPTED_OUT', 'the contact has opted out');
  END IF;
  IF v_reason IS NOT NULL AND v_reason ~ '^[[:space:]]*$' THEN
    v_reason := NULL;
  END IF;
  IF v_reason IS NOT NULL AND char_length(v_reason) > 500 THEN
    PERFORM hr_refuse('INVALID', 'reason is at most 500 characters');
  END IF;
  UPDATE hr_agent_drafts x
     SET status = CASE p_decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END,
         decided_by = auth.uid(),
         decided_at = now(),
         reject_reason = CASE p_decision WHEN 'reject' THEN v_reason ELSE NULL END
   WHERE x.id = d.id
  RETURNING * INTO d;
  RETURN d;
END;
$$;

-- ------------------------------------------------------------
-- 5. Functions for system writers (service role; no auth.uid())
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.hr_agent_context(p_conversation_id uuid)
RETURNS TABLE (
  account_id        uuid,
  inbox             text,
  stage_key         text,
  closed            boolean,
  reply_state       text,
  last_inbound_at   timestamptz,
  contact_id        uuid,
  personal_owner_id uuid,
  send_provider     text,
  opted_out         boolean,
  pending_drafts    integer,
  drafts_today      integer,
  enabled           jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT h.account_id, h.inbox, h.stage_key, h.closed_at IS NOT NULL, h.reply_state,
         h.last_inbound_at, c.contact_id, c.personal_owner_id,
         (SELECT w.provider FROM whatsapp_config w
           WHERE w.id = COALESCE(c.send_channel_id, c.channel_id)),
         COALESCE((SELECT ct.opted_out_at IS NOT NULL FROM contacts ct
                    WHERE ct.id = c.contact_id), false),
         (SELECT count(*)::integer FROM hr_agent_drafts d
           WHERE d.conversation_id = h.conversation_id AND d.status = 'pending'),
         (SELECT count(*)::integer FROM hr_agent_drafts d
           WHERE d.conversation_id = h.conversation_id
             AND d.created_at > now() - interval '24 hours'),
         (SELECT jsonb_object_agg(k.kind, COALESCE(s.enabled, false))
            FROM unnest(ARRAY['orchestrator', 'cv_screening', 'scheduling',
                              'candidate_faq', 'escalation']::text[]) AS k(kind)
            LEFT JOIN hr_agent_settings s
              ON s.account_id = h.account_id AND s.agent_kind = k.kind)
    FROM hr_conversations h
    JOIN conversations c ON c.id = h.conversation_id
   WHERE h.conversation_id = p_conversation_id
$$;

CREATE OR REPLACE FUNCTION public.hr_agent_draft_create(
  p_conversation_id   uuid,
  p_source_message_id uuid,
  p_agent_kind        text,
  p_intent            text,
  p_body              text,
  p_lang              text,
  p_requires_template boolean,
  p_handoff_reason    text,
  p_trace             jsonb,
  p_created_by        uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  h hr_conversations;
  v_id uuid;
  v_body text := COALESCE(p_body, '');
BEGIN
  SELECT * INTO h FROM hr_conversations x WHERE x.conversation_id = p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM hr_refuse('NOT_FOUND', 'conversation is not tracked by HR');
  END IF;
  IF h.inbox <> 'recruiter' THEN
    PERFORM hr_refuse('INVALID', 'agents draft only for the recruiter inbox');
  END IF;
  IF h.closed_at IS NOT NULL THEN
    PERFORM hr_refuse('CLOSED', 'conversation is closed');
  END IF;
  IF EXISTS (SELECT 1 FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
              WHERE c.id = h.conversation_id AND ct.opted_out_at IS NOT NULL) THEN
    PERFORM hr_refuse('OPTED_OUT', 'the contact has opted out');
  END IF;
  IF p_source_message_id IS NOT NULL THEN
    SELECT d.id INTO v_id FROM hr_agent_drafts d
     WHERE d.conversation_id = h.conversation_id AND d.source_message_id = p_source_message_id;
    IF FOUND THEN RETURN v_id; END IF;
  END IF;
  IF (SELECT count(*) FROM hr_agent_drafts d
       WHERE d.conversation_id = h.conversation_id AND d.status = 'pending') >= 3 THEN
    PERFORM hr_refuse('LIMIT', 'this conversation already has 3 pending drafts');
  END IF;
  IF p_created_by IS NOT NULL AND NOT hr_is_live_staff(h.account_id, p_created_by) THEN
    PERFORM hr_refuse('NOT_ALLOWED', 'the requester is not live staff of this account');
  END IF;
  IF p_agent_kind IS NULL
     OR p_agent_kind NOT IN ('orchestrator', 'cv_screening', 'scheduling', 'candidate_faq', 'escalation') THEN
    PERFORM hr_refuse('INVALID', 'unknown agent kind');
  END IF;
  IF p_intent IS NULL
     OR p_intent NOT IN ('cv_received', 'schedule_interview', 'question_role', 'question_process',
                         'salary_offer_visa', 'upset', 'opt_out', 'other') THEN
    PERFORM hr_refuse('INVALID', 'unknown intent');
  END IF;
  IF p_lang IS NULL OR p_lang NOT IN ('en', 'ar') THEN
    PERFORM hr_refuse('INVALID', 'lang is en|ar');
  END IF;
  IF p_handoff_reason IS NOT NULL
     AND p_handoff_reason NOT IN ('keyword', 'no_knowledge', 'model', 'error', 'cap',
                                  'triage', 'guardrail', 'kb') THEN
    PERFORM hr_refuse('INVALID', 'unknown handoff reason');
  END IF;
  IF char_length(v_body) > 4000 THEN
    PERFORM hr_refuse('INVALID', 'body is at most 4000 characters');
  END IF;
  INSERT INTO hr_agent_drafts (account_id, conversation_id, source_message_id, agent_kind, intent,
                               body, lang, requires_template, handoff_reason, trace, created_by)
  VALUES (h.account_id, h.conversation_id, p_source_message_id, p_agent_kind, p_intent,
          v_body, p_lang, COALESCE(p_requires_template, false), p_handoff_reason,
          COALESCE(p_trace, '[]'::jsonb), p_created_by)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_agent_flag_urgent(p_conversation_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE hr_conversations x SET urgent = true
   WHERE x.conversation_id = p_conversation_id
     AND x.closed_at IS NULL AND NOT x.urgent
$$;

CREATE OR REPLACE FUNCTION public.hr_agent_supersede(p_account_id uuid, p_contact_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  UPDATE hr_agent_drafts d SET status = 'superseded'
    FROM conversations c
   WHERE d.status = 'pending'
     AND d.account_id = p_account_id
     AND c.id = d.conversation_id
     AND c.account_id = p_account_id
     AND c.contact_id = p_contact_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_agent_expire(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  UPDATE hr_agent_drafts d SET status = 'expired'
   WHERE d.status = 'pending' AND d.created_at < p_now - interval '24 hours';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- ------------------------------------------------------------
-- 6. Function privileges
-- ------------------------------------------------------------

REVOKE ALL ON FUNCTION
  public.hr_agent_drafts_guard(),
  public.hr_my_recruiter_role(uuid),
  public.hr_agent_settings_set(text, boolean),
  public.hr_agent_draft_decide(uuid, text, text),
  public.hr_agent_context(uuid),
  public.hr_agent_draft_create(uuid, uuid, text, text, text, text, boolean, text, jsonb, uuid),
  public.hr_agent_flag_urgent(uuid),
  public.hr_agent_supersede(uuid, uuid),
  public.hr_agent_expire(timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.hr_my_recruiter_role(uuid),
  public.hr_agent_settings_set(text, boolean),
  public.hr_agent_draft_decide(uuid, text, text)
  TO authenticated;

GRANT EXECUTE ON FUNCTION
  public.hr_agent_context(uuid),
  public.hr_agent_draft_create(uuid, uuid, text, text, text, text, boolean, text, jsonb, uuid),
  public.hr_agent_flag_urgent(uuid),
  public.hr_agent_supersede(uuid, uuid),
  public.hr_agent_expire(timestamptz)
  TO service_role;
