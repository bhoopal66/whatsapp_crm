-- ============================================================
-- 226_hr_automsg_sms.sql — HR automated messages: an SMS channel beside
-- WhatsApp and RCS, sent through a Dinstar GSM gateway.
--
-- Ported from package 032a/032b onto 215 (the package's workspace_id and
-- phone-number contact_id are wacrm's account_id and a contacts row).
-- Sending stays off in TypeScript until DINSTAR_* is set; until then an
-- sms row is held 'channel_not_connected' and never sent, and never moved
-- to WhatsApp or RCS (no fallback anywhere, either way).
--
--   1. 'sms' joins every 215 channel check: hr_automsg_outbox,
--      hr_automsg_consent, hr_automsg_templates, hr_automsg_triggers, and
--      the channel arguments of trigger_set, template_set, consent_get,
--      consent_set and delivery_record. Consent is per channel (WhatsApp
--      or RCS consent never lets an sms row through); the contact's
--      opt-out and the daily cap span every channel, as in 215.
--   2. An sms template's meta_template_name is the admin's label
--      (letters, digits and _ . : -, up to 512; needed to approve, as
--      203's constraint wants): the SMS text is the template body,
--      rendered by the engine. No sms template is seeded, so nothing goes
--      out until an admin saves and approves one.
--   3. An sms row's dedupe key ends in '|sms' (on_history and nudges).
--   4. Delivery: the gateway's push names no message id we stored, only
--      the user_id we sent (provider_message_id is '<task_id>:<user_id>')
--      and the number. hr_automsg_sms_delivery_record matches the newest
--      sms row of the account whose provider id ends in ':<user_id>' and
--      whose contact's phone has the same last nine digits;
--      hr_automsg_sms_ref_record stores the gateway's ref_id on that row
--      (sms_ref_id, never overwriting a different one);
--      hr_automsg_sms_dlr_record matches a later delivery report by
--      ref_id and number, else the newest sms row to that number sent in
--      the last 48 hours with no ref_id and no final state.
--      hr_automsg_sms_contact names the contact of the newest sms row to a
--      number, for an inbound STOP. All service role only.
--   5. hr_automsg_delivery_apply holds the receipt ladder once (sent <
--      delivered < read; failed only over nothing or sent, then terminal
--      'delivery_failed:<code>'); delivery_record is restated to call it,
--      with the same behaviour.
--
-- Restates 215's hr_automsg_on_history, hr_automsg_enqueue_nudges,
-- hr_automsg_trigger_set, hr_automsg_template_set,
-- hr_automsg_consent_get, hr_automsg_consent_set and
-- hr_automsg_delivery_record: re-running 215 (or 203, 212) after 226
-- reverts them — apply in order, once.
--
-- Apply after 215. Re-runnable. No BEGIN/COMMIT. Must be applied by a
-- superuser or BYPASSRLS role (the refusal below runs before any DDL).
-- ============================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '226 must be applied by a superuser or BYPASSRLS role (the automated-message functions read RLS-forced tables)';
  END IF;
END $$;

SET lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. Channel checks (one ALTER per swap, as in 215)
-- ------------------------------------------------------------

ALTER TABLE public.hr_automsg_outbox
  DROP CONSTRAINT IF EXISTS hr_automsg_outbox_channel_check,
  ADD CONSTRAINT hr_automsg_outbox_channel_check
  CHECK (channel IN ('whatsapp', 'rcs', 'sms'));
ALTER TABLE public.hr_automsg_consent
  DROP CONSTRAINT IF EXISTS hr_automsg_consent_channel_check,
  ADD CONSTRAINT hr_automsg_consent_channel_check
  CHECK (channel IN ('whatsapp', 'rcs', 'sms'));
ALTER TABLE public.hr_automsg_templates
  DROP CONSTRAINT IF EXISTS hr_automsg_templates_channel_check,
  ADD CONSTRAINT hr_automsg_templates_channel_check
  CHECK (channel IN ('whatsapp', 'rcs', 'sms'));
ALTER TABLE public.hr_automsg_triggers
  DROP CONSTRAINT IF EXISTS hr_automsg_triggers_channel_check,
  ADD CONSTRAINT hr_automsg_triggers_channel_check
  CHECK (channel IN ('whatsapp', 'rcs', 'sms'));

-- ------------------------------------------------------------
-- 2. Template name per channel (length apart, as in 203 and 215)
-- ------------------------------------------------------------

ALTER TABLE public.hr_automsg_templates
  DROP CONSTRAINT IF EXISTS hr_automsg_templates_name_check,
  ADD CONSTRAINT hr_automsg_templates_name_check CHECK (
  char_length(meta_template_name) <= 512
  AND CASE channel
        WHEN 'rcs' THEN meta_template_name ~ '^[A-Za-z0-9_.:-]*$'
        WHEN 'sms' THEN meta_template_name ~ '^[A-Za-z0-9_.:-]*$'
        ELSE meta_template_name ~ '^[a-z0-9_]*$'
      END);

-- ------------------------------------------------------------
-- 3. The gateway's ref_id, for delivery reports in a later push
-- ------------------------------------------------------------

ALTER TABLE public.hr_automsg_outbox ADD COLUMN IF NOT EXISTS sms_ref_id text;
ALTER TABLE public.hr_automsg_outbox
  DROP CONSTRAINT IF EXISTS hr_automsg_outbox_sms_ref_check,
  ADD CONSTRAINT hr_automsg_outbox_sms_ref_check
  CHECK (sms_ref_id IS NULL OR (channel = 'sms' AND sms_ref_id ~ '^[A-Za-z0-9_.:-]{1,64}$'));
CREATE INDEX IF NOT EXISTS hr_automsg_outbox_sms_ref_idx
  ON public.hr_automsg_outbox (account_id, sms_ref_id)
  WHERE channel = 'sms' AND sms_ref_id IS NOT NULL;

-- ------------------------------------------------------------
-- 4. Enqueue and admin RPCs (restate 215 with 'sms')
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.hr_automsg_on_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_trigger text;
  v_kind text;
  v_channel text;
  v_contact uuid;
BEGIN
  IF NEW.to_inbox IS DISTINCT FROM 'recruiter' THEN RETURN NULL; END IF;
  v_trigger := CASE
    WHEN NEW.event = 'open' THEN 'cv_received'
    WHEN NEW.event IN ('stage', 'move')
         AND NEW.to_stage IN ('ai_interview', 'hr_interview', 'manager_interview')
      THEN 'stage_' || NEW.to_stage
  END;
  IF v_trigger IS NULL THEN RETURN NULL; END IF;
  BEGIN
    SELECT COALESCE(t.template_kind, hr_automsg_default_kind(t.trigger)),
           COALESCE(t.channel, 'whatsapp')
      INTO v_kind, v_channel
      FROM hr_automsg_triggers t
     WHERE t.account_id = NEW.account_id AND t.trigger = v_trigger AND t.enabled;
    IF v_kind IS NULL THEN RETURN NULL; END IF;
    -- Company chats with a contact only; a personal chat never gets a row.
    SELECT c.contact_id INTO v_contact
      FROM conversations c
     WHERE c.id = NEW.conversation_id AND c.account_id = NEW.account_id
       AND c.personal_owner_id IS NULL;
    IF v_contact IS NULL THEN RETURN NULL; END IF;
    -- An rcs or sms row's key ends in '|rcs' / '|sms'; a WhatsApp key
    -- keeps 203's shape.
    INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger,
                                   template_kind, language, params, status, dedupe_key,
                                   channel)
    VALUES (NEW.account_id, NEW.conversation_id, v_contact, v_trigger,
            v_kind, 'en', '{}'::jsonb, 'queued',
            'hist:' || NEW.id || CASE WHEN v_channel IN ('rcs', 'sms') THEN '|' || v_channel ELSE '' END,
            v_channel)
    ON CONFLICT ON CONSTRAINT hr_automsg_outbox_dedupe DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'hr_automsg_on_history: % (%)', SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

-- One nudge per waiting period: the dedupe key carries the outbound
-- timestamp the candidate has not answered (and '|rcs' / '|sms' on an
-- rcs / sms row).
CREATE OR REPLACE FUNCTION public.hr_automsg_enqueue_nudges(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger,
                                 template_kind, language, params, status, dedupe_key,
                                 channel)
  SELECT h.account_id, h.conversation_id, c.contact_id, 'reply_overdue_nudge',
         COALESCE(t.template_kind, 'reply_nudge'), 'en', '{}'::jsonb, 'queued',
         'nudge:' || h.conversation_id || ':'
           || floor(extract(epoch FROM h.last_outbound_at))::bigint
           || CASE WHEN t.channel IN ('rcs', 'sms') THEN '|' || t.channel ELSE '' END,
         t.channel
    FROM hr_automsg_triggers t
    JOIN hr_conversations h ON h.account_id = t.account_id
    JOIN conversations c ON c.id = h.conversation_id AND c.account_id = h.account_id
    LEFT JOIN hr_workflow_rules r
      ON r.account_id = h.account_id AND r.key = 'no_activity_recruiter'
   WHERE t.trigger = 'reply_overdue_nudge' AND t.enabled
     AND h.inbox = 'recruiter' AND h.closed_at IS NULL
     AND h.reply_state = 'waiting'
     AND h.last_outbound_at <= COALESCE(p_now, now())
                               - make_interval(hours => COALESCE(r.after_hours, 72))
     -- Only waiting periods that began after the trigger was last switched
     -- or changed, and within the last 7 days: switching it on must not
     -- nudge every chat that went quiet any time before.
     AND h.last_outbound_at > t.updated_at
     AND h.last_outbound_at >= COALESCE(p_now, now()) - interval '7 days'
     AND c.personal_owner_id IS NULL AND c.contact_id IS NOT NULL
  ON CONFLICT ON CONSTRAINT hr_automsg_outbox_dedupe DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- p_channel NULL keeps the trigger's channel (a new row is WhatsApp).
CREATE OR REPLACE FUNCTION public.hr_automsg_trigger_set(
  p_trigger text, p_enabled boolean, p_template_kind text DEFAULT NULL,
  p_channel text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid;
  v_role text;
  v_channel text;
BEGIN
  SELECT o_account, o_role INTO v_account, v_role FROM hr_automsg_caller();
  IF COALESCE(v_role, '') NOT IN ('lead', 'admin') THEN
    PERFORM hr_refuse('NOT_ALLOWED', 'automated messages need a recruiter lead or an admin');
  END IF;
  IF hr_automsg_default_kind(p_trigger) IS NULL THEN
    PERFORM hr_refuse('NOT_FOUND', 'unknown trigger');
  END IF;
  IF p_enabled IS NULL THEN
    PERFORM hr_refuse('INVALID', 'enabled is required');
  END IF;
  IF p_template_kind IS NOT NULL AND p_template_kind NOT IN (
       'cv_ack', 'ai_interview_invite', 'hr_interview_invite', 'manager_interview_invite',
       'interview_reminder', 'reply_nudge') THEN
    PERFORM hr_refuse('INVALID', 'unknown template kind');
  END IF;
  IF p_channel IS NOT NULL AND p_channel NOT IN ('whatsapp', 'rcs', 'sms') THEN
    PERFORM hr_refuse('INVALID', 'unknown channel');
  END IF;
  INSERT INTO hr_automsg_triggers AS t (account_id, trigger, enabled, template_kind, channel,
                                        updated_at, updated_by)
  VALUES (v_account, p_trigger, p_enabled, p_template_kind, COALESCE(p_channel, 'whatsapp'),
          now(), auth.uid())
  ON CONFLICT (account_id, trigger) DO UPDATE
    SET enabled = EXCLUDED.enabled, template_kind = EXCLUDED.template_kind,
        channel = COALESCE(p_channel, t.channel),
        updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
  RETURNING t.channel INTO v_channel;
  PERFORM hr_automsg_log(v_account, 'trigger', jsonb_build_object(
    'trigger', p_trigger, 'enabled', p_enabled, 'template_kind', p_template_kind,
    'channel', v_channel));
  RETURN hr_automsg_config();
END;
$$;

-- For rcs, meta_template_name holds the RCS provider's template id
-- (letters, digits and _ . : -, up to 512); a draft may leave it empty,
-- as a WhatsApp draft may leave its Meta name empty. For sms it is the
-- admin's label in the same characters (the SMS text is the body
-- itself); a draft may leave it empty.
CREATE OR REPLACE FUNCTION public.hr_automsg_template_set(
  p_kind text, p_language text, p_body text, p_meta_template_name text,
  p_approval_status text, p_category text DEFAULT 'utility',
  p_channel text DEFAULT 'whatsapp')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid;
  v_role text;
  v_name text := COALESCE(p_meta_template_name, '');
BEGIN
  SELECT o_account, o_role INTO v_account, v_role FROM hr_automsg_caller();
  IF v_role IS DISTINCT FROM 'admin' THEN
    PERFORM hr_refuse('NOT_ALLOWED', 'only an admin may change automated-message templates');
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN (
       'cv_ack', 'ai_interview_invite', 'hr_interview_invite', 'manager_interview_invite',
       'interview_reminder', 'reply_nudge') THEN
    PERFORM hr_refuse('INVALID', 'unknown template kind');
  END IF;
  IF p_language IS NULL OR p_language NOT IN ('en', 'ar') THEN
    PERFORM hr_refuse('INVALID', 'unknown language');
  END IF;
  IF p_channel IS NULL OR p_channel NOT IN ('whatsapp', 'rcs', 'sms') THEN
    PERFORM hr_refuse('INVALID', 'unknown channel');
  END IF;
  IF p_approval_status IS NULL OR p_approval_status NOT IN ('draft', 'approved') THEN
    PERFORM hr_refuse('INVALID', 'unknown approval status');
  END IF;
  IF p_category IS DISTINCT FROM 'utility' THEN
    PERFORM hr_refuse('INVALID', 'automated templates must be Utility templates');
  END IF;
  IF p_body IS NULL OR char_length(p_body) NOT BETWEEN 1 AND 1024 THEN
    PERFORM hr_refuse('INVALID', 'the body must be 1 to 1024 characters');
  END IF;
  -- Control characters other than a newline.
  IF p_body ~ '[\x01-\x09\x0B-\x1F\x7F]' THEN
    PERFORM hr_refuse('INVALID', 'the body may not contain control characters');
  END IF;
  -- Braces only as the exact tokens {name} and {slot}.
  IF replace(replace(p_body, '{name}', ''), '{slot}', '') ~ '[{}]' THEN
    PERFORM hr_refuse('INVALID', 'the only placeholders allowed are {name} and {slot}');
  END IF;
  IF p_channel = 'rcs' THEN
    IF p_approval_status = 'approved'
       AND (v_name !~ '^[A-Za-z0-9_.:-]+$' OR char_length(v_name) > 512) THEN
      PERFORM hr_refuse('INVALID', 'an approved RCS template needs its provider template id');
    END IF;
    IF v_name !~ '^[A-Za-z0-9_.:-]*$' OR char_length(v_name) > 512 THEN
      PERFORM hr_refuse('INVALID', 'an RCS template id is up to 512 letters, digits and _ . : -');
    END IF;
  ELSIF p_channel = 'sms' THEN
    -- An SMS template has no provider registry: the name is the admin's
    -- label (203's hr_automsg_templates_approved_named still wants one
    -- to approve), and approving means the admin has checked the text.
    IF p_approval_status = 'approved'
       AND (v_name !~ '^[A-Za-z0-9_.:-]+$' OR char_length(v_name) > 512) THEN
      PERFORM hr_refuse('INVALID', 'an approved SMS template needs a label');
    END IF;
    IF v_name !~ '^[A-Za-z0-9_.:-]*$' OR char_length(v_name) > 512 THEN
      PERFORM hr_refuse('INVALID', 'an SMS template label is up to 512 letters, digits and _ . : -');
    END IF;
  ELSE
    IF p_approval_status = 'approved'
       AND (v_name !~ '^[a-z0-9_]+$' OR char_length(v_name) > 512) THEN
      PERFORM hr_refuse('INVALID', 'an approved template needs its Meta template name');
    END IF;
    IF v_name !~ '^[a-z0-9_]*$' OR char_length(v_name) > 512 THEN
      PERFORM hr_refuse('INVALID', 'a Meta template name is lower-case letters, digits and _');
    END IF;
  END IF;

  INSERT INTO hr_automsg_templates (account_id, kind, language, channel, body, meta_template_name,
                                    approval_status, category, updated_at, updated_by)
  VALUES (v_account, p_kind, p_language, p_channel, p_body, v_name, p_approval_status, p_category,
          now(), auth.uid())
  ON CONFLICT (account_id, kind, language, channel) DO UPDATE
    SET body = EXCLUDED.body, meta_template_name = EXCLUDED.meta_template_name,
        approval_status = EXCLUDED.approval_status, category = EXCLUDED.category,
        updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;
  PERFORM hr_automsg_log(v_account, 'template', jsonb_build_object(
    'kind', p_kind, 'language', p_language, 'channel', p_channel, 'meta_template_name', v_name,
    'approval_status', p_approval_status, 'category', p_category));
  RETURN hr_automsg_config();
END;
$$;

-- Consent of the chat's contact on one channel. Any recruiter role
-- (member and up) on a recruiter or dept HR chat the caller can see.
CREATE OR REPLACE FUNCTION public.hr_automsg_consent_get(
  p_conversation_id uuid, p_channel text DEFAULT 'whatsapp')
RETURNS TABLE (granted boolean, source text, noted_at timestamptz,
               opted_out boolean, personal boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid;
  v_role text;
BEGIN
  SELECT o_account, o_role INTO v_account, v_role FROM hr_automsg_caller();
  IF p_conversation_id IS NULL OR NOT hr_can_see(p_conversation_id)
     OR NOT EXISTS (SELECT 1 FROM hr_conversations x
                     WHERE x.conversation_id = p_conversation_id AND x.account_id = v_account) THEN
    PERFORM hr_refuse('NOT_FOUND', 'conversation not found');
  END IF;
  IF COALESCE(v_role, '') NOT IN ('member', 'lead', 'admin') THEN
    PERFORM hr_refuse('NOT_ALLOWED', 'consent needs a recruiter role');
  END IF;
  IF p_channel IS NULL OR p_channel NOT IN ('whatsapp', 'rcs', 'sms') THEN
    PERFORM hr_refuse('INVALID', 'unknown channel');
  END IF;
  RETURN QUERY
    SELECT k.granted, k.source, k.noted_at,
           COALESCE(ct.opted_out_at IS NOT NULL, false),
           c.personal_owner_id IS NOT NULL
      FROM conversations c
      LEFT JOIN contacts ct ON ct.id = c.contact_id AND ct.account_id = c.account_id
      LEFT JOIN hr_automsg_consent k ON k.account_id = c.account_id AND k.contact_id = c.contact_id
                                    AND k.channel = p_channel
     WHERE c.id = p_conversation_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_automsg_consent_set(
  p_conversation_id uuid, p_granted boolean, p_source text DEFAULT 'recruiter_confirmed',
  p_channel text DEFAULT 'whatsapp')
RETURNS TABLE (granted boolean, source text, noted_at timestamptz,
               opted_out boolean, personal boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid;
  v_role text;
  v_contact uuid;
BEGIN
  SELECT o_account, o_role INTO v_account, v_role FROM hr_automsg_caller();
  IF p_conversation_id IS NULL OR NOT hr_can_see(p_conversation_id)
     OR NOT EXISTS (SELECT 1 FROM hr_conversations x
                     WHERE x.conversation_id = p_conversation_id AND x.account_id = v_account) THEN
    PERFORM hr_refuse('NOT_FOUND', 'conversation not found');
  END IF;
  IF COALESCE(v_role, '') NOT IN ('member', 'lead', 'admin') THEN
    PERFORM hr_refuse('NOT_ALLOWED', 'consent needs a recruiter role');
  END IF;
  SELECT c.contact_id INTO v_contact FROM conversations c WHERE c.id = p_conversation_id;
  IF v_contact IS NULL THEN
    PERFORM hr_refuse('NOT_FOUND', 'the conversation has no contact');
  END IF;
  IF p_granted IS NULL THEN
    PERFORM hr_refuse('INVALID', 'granted is required');
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('recruiter_confirmed', 'candidate_wrote', 'form') THEN
    PERFORM hr_refuse('INVALID', 'unknown consent source');
  END IF;
  IF p_channel IS NULL OR p_channel NOT IN ('whatsapp', 'rcs', 'sms') THEN
    PERFORM hr_refuse('INVALID', 'unknown channel');
  END IF;
  INSERT INTO hr_automsg_consent AS k (account_id, contact_id, channel, granted, source, noted_at, noted_by)
  VALUES (v_account, v_contact, p_channel, p_granted, p_source, now(), auth.uid())
  ON CONFLICT (account_id, contact_id, channel) DO UPDATE
    SET granted = EXCLUDED.granted, source = EXCLUDED.source,
        noted_at = EXCLUDED.noted_at, noted_by = EXCLUDED.noted_by;
  PERFORM hr_automsg_log(v_account, 'consent', jsonb_build_object(
    'conversation_id', p_conversation_id, 'contact_id', v_contact,
    'granted', p_granted, 'source', p_source, 'channel', p_channel));
  RETURN QUERY SELECT * FROM hr_automsg_consent_get(p_conversation_id, p_channel);
END;
$$;
-- ------------------------------------------------------------
-- 5. Receipts: one ladder, then delivery_record (restates 215)
-- ------------------------------------------------------------

-- 'recorded' | 'unchanged' | 'failed_terminal' for one outbox row.
-- p_reason is the provider's error code of a failed status.
CREATE OR REPLACE FUNCTION public.hr_automsg_delivery_apply(
  p_id uuid, p_state text, p_at timestamptz, p_reason text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  o hr_automsg_outbox;
  v_code text;
  v_rank_new integer;
  v_rank_old integer;
BEGIN
  SELECT * INTO o FROM hr_automsg_outbox x WHERE x.id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'unknown_message'; END IF;

  -- Nothing overwrites 'failed'.
  IF o.delivery_state = 'failed' THEN RETURN 'unchanged'; END IF;

  IF p_state = 'failed' THEN
    IF o.delivery_state IS NOT NULL AND o.delivery_state <> 'sent' THEN RETURN 'unchanged'; END IF;
    UPDATE hr_automsg_outbox x SET delivery_state = 'failed', delivery_at = LEAST(COALESCE(p_at, now()), now() + interval '1 minute')
     WHERE x.id = o.id;
    IF o.status = 'cancelled' OR (o.status = 'failed' AND o.attempts >= 3) THEN
      RETURN 'recorded';
    END IF;
    v_code := left(regexp_replace(COALESCE(p_reason, ''), '[^A-Za-z0-9_.:-]', '', 'g'), 60);
    PERFORM hr_automsg_fail_terminal(o.id,
      'delivery_failed:' || CASE WHEN v_code = '' THEN 'unknown' ELSE v_code END);
    RETURN 'failed_terminal';
  END IF;

  v_rank_new := CASE p_state WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 ELSE 3 END;
  v_rank_old := CASE o.delivery_state WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 0 END;
  IF v_rank_new <= v_rank_old THEN RETURN 'unchanged'; END IF;
  UPDATE hr_automsg_outbox x SET delivery_state = p_state, delivery_at = LEAST(COALESCE(p_at, now()), now() + interval '1 minute')
   WHERE x.id = o.id;
  RETURN 'recorded';
END;
$$;

-- 'recorded' | 'unchanged' | 'failed_terminal' | 'unknown_message' (no
-- row of the account and channel has that provider id; not an error).
-- 212's receipt trigger calls it with five arguments, which resolve to
-- p_channel 'whatsapp'.
CREATE OR REPLACE FUNCTION public.hr_automsg_delivery_record(
  p_account_id uuid, p_provider_message_id text, p_state text,
  p_at timestamptz, p_reason text, p_channel text DEFAULT 'whatsapp')
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_state IS NULL OR p_state NOT IN ('sent', 'delivered', 'read', 'failed') THEN
    PERFORM hr_refuse('INVALID', 'unknown delivery state');
  END IF;
  IF p_provider_message_id IS NULL OR p_provider_message_id ~ '^[[:space:]]*$' THEN
    PERFORM hr_refuse('INVALID', 'a provider message id is required');
  END IF;
  IF p_channel IS NULL OR p_channel NOT IN ('whatsapp', 'rcs', 'sms') THEN
    PERFORM hr_refuse('INVALID', 'unknown channel');
  END IF;
  SELECT x.id INTO v_id FROM hr_automsg_outbox x
   WHERE x.account_id = p_account_id AND x.provider_message_id = p_provider_message_id
     AND x.channel = p_channel
   ORDER BY x.created_at DESC, x.id DESC
   LIMIT 1
   FOR UPDATE;
  IF v_id IS NULL THEN RETURN 'unknown_message'; END IF;
  RETURN hr_automsg_delivery_apply(v_id, p_state, p_at, p_reason);
END;
$$;

-- ------------------------------------------------------------
-- 6. SMS receipts and STOP (Dinstar push, src/app/api/sms/webhook)
-- ------------------------------------------------------------

-- The last nine digits of a number, NULL with fewer: the gateway reports
-- '+9715…' where the contact may be saved as '05…'. Contact search
-- matches on the same tail (migration 193).
CREATE OR REPLACE FUNCTION public.hr_automsg_sms_tail(p_number text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN char_length(d) >= 9 THEN right(d, 9) END
    FROM (SELECT regexp_replace(COALESCE(p_number, ''), '\D', '', 'g') AS d) s
$$;

-- The sms row an sms_result item names: the newest of the account whose
-- provider id ends in ':<user_id>' and whose contact has the same tail.
CREATE OR REPLACE FUNCTION public.hr_automsg_sms_row(
  p_account_id uuid, p_user_id text, p_number text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tail text := hr_automsg_sms_tail(p_number);
  v_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_user_id !~ '^[0-9]{1,10}$' THEN
    PERFORM hr_refuse('INVALID', 'a user id is required');
  END IF;
  IF v_tail IS NULL THEN RETURN NULL; END IF;
  SELECT x.id INTO v_id
    FROM hr_automsg_outbox x
    JOIN contacts ct ON ct.id = x.contact_id AND ct.account_id = x.account_id
   WHERE x.account_id = p_account_id AND x.channel = 'sms'
     AND x.provider_message_id LIKE '%:' || p_user_id
     AND right(ct.phone_normalized, 9) = v_tail
   ORDER BY x.created_at DESC, x.id DESC
   LIMIT 1
   FOR UPDATE OF x;
  RETURN v_id;
END;
$$;

-- One sms_result item, p_state already mapped (sent | delivered | failed).
CREATE OR REPLACE FUNCTION public.hr_automsg_sms_delivery_record(
  p_account_id uuid, p_user_id text, p_number text, p_state text,
  p_at timestamptz, p_reason text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_state IS NULL OR p_state NOT IN ('sent', 'delivered', 'failed') THEN
    PERFORM hr_refuse('INVALID', 'unknown delivery state');
  END IF;
  v_id := hr_automsg_sms_row(p_account_id, p_user_id, p_number);
  IF v_id IS NULL THEN RETURN 'unknown_message'; END IF;
  RETURN hr_automsg_delivery_apply(v_id, p_state, p_at, p_reason);
END;
$$;

-- 'stored' | 'unchanged' | 'conflict' (the row holds a different ref) |
-- 'unknown_message'.
CREATE OR REPLACE FUNCTION public.hr_automsg_sms_ref_record(
  p_account_id uuid, p_user_id text, p_number text, p_ref_id text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_old text;
BEGIN
  IF p_ref_id IS NULL OR p_ref_id !~ '^[A-Za-z0-9_.:-]{1,64}$' THEN
    PERFORM hr_refuse('INVALID', 'a ref id is up to 64 letters, digits and _ . : -');
  END IF;
  v_id := hr_automsg_sms_row(p_account_id, p_user_id, p_number);
  IF v_id IS NULL THEN RETURN 'unknown_message'; END IF;
  SELECT x.sms_ref_id INTO v_old FROM hr_automsg_outbox x WHERE x.id = v_id;
  IF v_old = p_ref_id THEN RETURN 'unchanged'; END IF;
  IF v_old IS NOT NULL THEN RETURN 'conflict'; END IF;
  UPDATE hr_automsg_outbox x SET sms_ref_id = p_ref_id WHERE x.id = v_id;
  RETURN 'stored';
END;
$$;

-- One sms_deliver_status item (no user_id; a later push than the
-- sms_result that carried the ref): by ref and tail, else the newest sms
-- row to that tail sent in the last 48 hours with no ref of its own and
-- no final state.
CREATE OR REPLACE FUNCTION public.hr_automsg_sms_dlr_record(
  p_account_id uuid, p_ref_id text, p_number text, p_state text,
  p_at timestamptz, p_reason text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tail text := hr_automsg_sms_tail(p_number);
  v_id uuid;
BEGIN
  IF p_state IS NULL OR p_state NOT IN ('sent', 'delivered', 'failed') THEN
    PERFORM hr_refuse('INVALID', 'unknown delivery state');
  END IF;
  IF v_tail IS NULL THEN RETURN 'unknown_message'; END IF;
  IF p_ref_id IS NOT NULL AND p_ref_id ~ '^[A-Za-z0-9_.:-]{1,64}$' THEN
    SELECT x.id INTO v_id
      FROM hr_automsg_outbox x
      JOIN contacts ct ON ct.id = x.contact_id AND ct.account_id = x.account_id
     WHERE x.account_id = p_account_id AND x.channel = 'sms' AND x.sms_ref_id = p_ref_id
       AND right(ct.phone_normalized, 9) = v_tail
     ORDER BY x.created_at DESC, x.id DESC
     LIMIT 1
     FOR UPDATE OF x;
  END IF;
  IF v_id IS NULL THEN
    SELECT x.id INTO v_id
      FROM hr_automsg_outbox x
      JOIN contacts ct ON ct.id = x.contact_id AND ct.account_id = x.account_id
     WHERE x.account_id = p_account_id AND x.channel = 'sms' AND x.status = 'sent'
       AND x.sms_ref_id IS NULL
       AND (x.delivery_state IS NULL OR x.delivery_state = 'sent')
       AND x.sent_at >= now() - interval '48 hours'
       AND right(ct.phone_normalized, 9) = v_tail
     ORDER BY x.created_at DESC, x.id DESC
     LIMIT 1
     FOR UPDATE OF x;
  END IF;
  IF v_id IS NULL THEN RETURN 'unknown_message'; END IF;
  RETURN hr_automsg_delivery_apply(v_id, p_state, p_at, p_reason);
END;
$$;

-- The contact of the newest sms row to a number (NULL when none): an
-- inbound STOP opts out only someone we have texted.
CREATE OR REPLACE FUNCTION public.hr_automsg_sms_contact(p_account_id uuid, p_number text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tail text := hr_automsg_sms_tail(p_number);
BEGIN
  IF v_tail IS NULL THEN RETURN NULL; END IF;
  RETURN (SELECT x.contact_id
            FROM hr_automsg_outbox x
            JOIN contacts ct ON ct.id = x.contact_id AND ct.account_id = x.account_id
           WHERE x.account_id = p_account_id AND x.channel = 'sms'
             AND x.status = 'sent'
             AND right(ct.phone_normalized, 9) = v_tail
           ORDER BY x.created_at DESC, x.id DESC
           LIMIT 1);
END;
$$;

-- ------------------------------------------------------------
-- 7. Function privileges
-- ------------------------------------------------------------

REVOKE ALL ON FUNCTION
  public.hr_automsg_on_history(),
  public.hr_automsg_trigger_set(text, boolean, text, text),
  public.hr_automsg_template_set(text, text, text, text, text, text, text),
  public.hr_automsg_consent_get(uuid, text),
  public.hr_automsg_consent_set(uuid, boolean, text, text),
  public.hr_automsg_enqueue_nudges(timestamptz),
  public.hr_automsg_delivery_record(uuid, text, text, timestamptz, text, text),
  public.hr_automsg_delivery_apply(uuid, text, timestamptz, text),
  public.hr_automsg_sms_tail(text),
  public.hr_automsg_sms_row(uuid, text, text),
  public.hr_automsg_sms_delivery_record(uuid, text, text, text, timestamptz, text),
  public.hr_automsg_sms_ref_record(uuid, text, text, text),
  public.hr_automsg_sms_dlr_record(uuid, text, text, text, timestamptz, text),
  public.hr_automsg_sms_contact(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.hr_automsg_trigger_set(text, boolean, text, text),
  public.hr_automsg_template_set(text, text, text, text, text, text, text),
  public.hr_automsg_consent_get(uuid, text),
  public.hr_automsg_consent_set(uuid, boolean, text, text)
  TO authenticated;

GRANT EXECUTE ON FUNCTION
  public.hr_automsg_enqueue_nudges(timestamptz),
  public.hr_automsg_delivery_record(uuid, text, text, timestamptz, text, text),
  public.hr_automsg_sms_delivery_record(uuid, text, text, text, timestamptz, text),
  public.hr_automsg_sms_ref_record(uuid, text, text, text),
  public.hr_automsg_sms_dlr_record(uuid, text, text, text, timestamptz, text),
  public.hr_automsg_sms_contact(uuid, text)
  TO service_role;
