-- ============================================================
-- 215_hr_automsg_rcs.sql — HR automated messages: an RCS channel beside
-- WhatsApp.
--
-- Ported from package 030a onto 203's engine and 212's receipts (the
-- package's workspace_id and granted_at / revoked_at consent are
-- wacrm's account_id and granted boolean). An automated message can now
-- go to a candidate over RCS as well as WhatsApp: each trigger names its
-- channel, and every row, template and consent belongs to one channel.
-- No provider is chosen here: sending over RCS stays off in TypeScript
-- until an admin configures one, and a row whose channel is not
-- connected is held 'channel_not_connected'.
--
-- WhatsApp behaviour is unchanged: every channel column defaults to
-- 'whatsapp', so existing rows, triggers, templates and consent are
-- WhatsApp ones and every WhatsApp dedupe key keeps its shape.
--
--   1. channel text NOT NULL DEFAULT 'whatsapp' ('whatsapp' | 'rcs') on
--      hr_automsg_outbox, hr_automsg_consent, hr_automsg_templates and
--      hr_automsg_triggers.
--   2. Consent is per channel (PK account × contact × channel): a
--      WhatsApp consent never satisfies RCS. An opt-out
--      (contacts.opted_out_at) still stops every channel.
--   3. Templates are per channel (PK account × kind × language ×
--      channel). For rcs, meta_template_name holds the RCS provider's
--      template id, so its name check is wider ('^[A-Za-z0-9_.:-]*$').
--   4. Enqueue writes the trigger's channel on the row; an rcs row's
--      dedupe key ends in '|rcs'. The daily cap counts every channel
--      (hr_automsg_sent_today is unchanged).
--   5. Receipts match a provider message id within one channel only
--      (hr_automsg_delivery_record gains p_channel, default 'whatsapp').
--   6. No cross-channel fallback anywhere: an RCS row is never sent over
--      WhatsApp or SMS. Nothing here sends.
--
--   7. The admin side names the channel: hr_automsg_trigger_set gains
--      p_channel (NULL keeps the trigger's), hr_automsg_template_set,
--      hr_automsg_consent_get and hr_automsg_consent_set gain p_channel
--      (default 'whatsapp'), hr_automsg_outbox_list returns channel last,
--      and hr_automsg_config shows each trigger's and template's channel.
--      The old signatures are dropped.
--
-- Restates 203's hr_automsg_on_history, hr_automsg_enqueue_nudges,
-- hr_automsg_row_state, hr_automsg_claim, hr_automsg_mark,
-- hr_automsg_config, hr_automsg_trigger_set, hr_automsg_template_set,
-- hr_automsg_consent_get, hr_automsg_consent_set, hr_automsg_outbox_list
-- and 212's hr_automsg_delivery_record: re-running 203 or 212 after 215
-- reverts them (and leaves both signatures of the re-created writers) —
-- apply in order, once.
--
-- Apply after 212. Re-runnable. No BEGIN/COMMIT. Must be applied by a
-- superuser or BYPASSRLS role (the refusal below runs before any DDL).
-- ============================================================

-- The tables are RLS-forced with no policies, so the SECURITY DEFINER
-- functions below read and write them only when owned by a role that
-- bypasses RLS.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '215 must be applied by a superuser or BYPASSRLS role (the automated-message functions read RLS-forced tables)';
  END IF;
END $$;

SET lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. Channel columns
-- ------------------------------------------------------------

ALTER TABLE public.hr_automsg_outbox   ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'whatsapp';
ALTER TABLE public.hr_automsg_consent  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'whatsapp';
ALTER TABLE public.hr_automsg_templates ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'whatsapp';
ALTER TABLE public.hr_automsg_triggers ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'whatsapp';

-- Each constraint swap is ONE ALTER statement (drop and add together),
-- so a lock timeout on the add can never leave a table without its key
-- or check: the whole statement rolls back.
ALTER TABLE public.hr_automsg_outbox
  DROP CONSTRAINT IF EXISTS hr_automsg_outbox_channel_check,
  ADD CONSTRAINT hr_automsg_outbox_channel_check
  CHECK (channel IN ('whatsapp', 'rcs'));
ALTER TABLE public.hr_automsg_consent
  DROP CONSTRAINT IF EXISTS hr_automsg_consent_channel_check,
  ADD CONSTRAINT hr_automsg_consent_channel_check
  CHECK (channel IN ('whatsapp', 'rcs'));
ALTER TABLE public.hr_automsg_templates
  DROP CONSTRAINT IF EXISTS hr_automsg_templates_channel_check,
  ADD CONSTRAINT hr_automsg_templates_channel_check
  CHECK (channel IN ('whatsapp', 'rcs'));
ALTER TABLE public.hr_automsg_triggers
  DROP CONSTRAINT IF EXISTS hr_automsg_triggers_channel_check,
  ADD CONSTRAINT hr_automsg_triggers_channel_check
  CHECK (channel IN ('whatsapp', 'rcs'));

-- ------------------------------------------------------------
-- 2. Per-channel keys
-- ------------------------------------------------------------

ALTER TABLE public.hr_automsg_consent
  DROP CONSTRAINT IF EXISTS hr_automsg_consent_pkey,
  ADD CONSTRAINT hr_automsg_consent_pkey
  PRIMARY KEY (account_id, contact_id, channel);

ALTER TABLE public.hr_automsg_templates
  DROP CONSTRAINT IF EXISTS hr_automsg_templates_pkey,
  ADD CONSTRAINT hr_automsg_templates_pkey
  PRIMARY KEY (account_id, kind, language, channel);

-- ------------------------------------------------------------
-- 3. Template name per channel (POSIX regexes cap {m,n} at 255, so the
--    length is checked apart, as in 203)
-- ------------------------------------------------------------

ALTER TABLE public.hr_automsg_templates
  DROP CONSTRAINT IF EXISTS hr_automsg_templates_name_check,
  ADD CONSTRAINT hr_automsg_templates_name_check CHECK (
  char_length(meta_template_name) <= 512
  AND CASE channel
        WHEN 'rcs' THEN meta_template_name ~ '^[A-Za-z0-9_.:-]*$'
        ELSE meta_template_name ~ '^[a-z0-9_]*$'
      END);

-- ------------------------------------------------------------
-- 4. Hold reasons
-- ------------------------------------------------------------

ALTER TABLE public.hr_automsg_outbox
  DROP CONSTRAINT IF EXISTS hr_automsg_outbox_hold_reason_check,
  ADD CONSTRAINT hr_automsg_outbox_hold_reason_check
  CHECK (hold_reason IS NULL OR hold_reason IN (
    'kill_switch', 'disabled', 'closed', 'opted_out', 'no_consent', 'quiet_hours',
    'outside_window_no_template', 'daily_cap', 'duplicate', 'channel_not_connected'));

-- ------------------------------------------------------------
-- 5. Enqueue (restates 203)
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
    -- An rcs row's key ends in '|rcs'; a WhatsApp key keeps 203's shape.
    INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger,
                                   template_kind, language, params, status, dedupe_key,
                                   channel)
    VALUES (NEW.account_id, NEW.conversation_id, v_contact, v_trigger,
            v_kind, 'en', '{}'::jsonb, 'queued',
            'hist:' || NEW.id || CASE WHEN v_channel = 'rcs' THEN '|rcs' ELSE '' END,
            v_channel)
    ON CONFLICT ON CONSTRAINT hr_automsg_outbox_dedupe DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'hr_automsg_on_history: % (%)', SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

-- One nudge per waiting period: the dedupe key carries the outbound
-- timestamp the candidate has not answered (and '|rcs' on an rcs row).
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
           || CASE WHEN t.channel = 'rcs' THEN '|rcs' ELSE '' END,
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

-- ------------------------------------------------------------
-- 6. Drain (restates 203): row state, claim, mark
-- ------------------------------------------------------------

-- The template and the consent are the row's channel's; the opt-out and
-- today's sends count every channel.
CREATE OR REPLACE FUNCTION public.hr_automsg_row_state(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  o hr_automsg_outbox;
  h hr_conversations;
  c conversations;
  v_name text;
  v_opted boolean;
BEGIN
  SELECT * INTO o FROM hr_automsg_outbox x WHERE x.id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO h FROM hr_conversations x WHERE x.conversation_id = o.conversation_id;
  SELECT * INTO c FROM conversations x WHERE x.id = o.conversation_id;
  SELECT ct.name, ct.opted_out_at IS NOT NULL INTO v_name, v_opted
    FROM contacts ct WHERE ct.id = o.contact_id AND ct.account_id = o.account_id;
  RETURN jsonb_build_object(
    'row', to_jsonb(o),
    'channel', o.channel,
    'closed', h.conversation_id IS NULL OR h.closed_at IS NOT NULL,
    'inbox', h.inbox,
    'personal', c.personal_owner_id IS NOT NULL,
    'opted_out', COALESCE(v_opted, false),
    'consent', EXISTS (SELECT 1 FROM hr_automsg_consent k
                        WHERE k.account_id = o.account_id AND k.contact_id = o.contact_id
                          AND k.channel = o.channel AND k.granted),
    'last_inbound_at', h.last_inbound_at,
    'contact_name', v_name,
    'settings', hr_automsg_settings_json(o.account_id),
    'trigger_enabled', COALESCE((SELECT t.enabled FROM hr_automsg_triggers t
                                  WHERE t.account_id = o.account_id AND t.trigger = o.trigger), false),
    'template', (SELECT jsonb_build_object(
                   'kind', x.kind, 'language', x.language, 'body', x.body,
                   'meta_template_name', x.meta_template_name,
                   'approval_status', x.approval_status, 'category', x.category,
                   'updated_at', x.updated_at)
                   FROM hr_automsg_templates x
                  WHERE x.account_id = o.account_id AND x.kind = o.template_kind
                    AND x.language = o.language AND x.channel = o.channel),
    'sent_today', hr_automsg_sent_today(o.account_id, o.contact_id, now()));
END;
$$;

-- The consent re-check reads the row's channel, as row_state does: a
-- WhatsApp consent never lets an rcs row through.
CREATE OR REPLACE FUNCTION public.hr_automsg_claim(p_id uuid, p_now timestamptz DEFAULT now())
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid;
  v_contact uuid;
  v_now timestamptz := COALESCE(p_now, now());
  v_conversation uuid;
  v_trigger text;
  v_channel text;
  s hr_automsg_settings;
BEGIN
  SELECT x.account_id, x.contact_id, x.conversation_id, x.trigger, x.channel
    INTO v_account, v_contact, v_conversation, v_trigger, v_channel
    FROM hr_automsg_outbox x WHERE x.id = p_id;
  IF NOT FOUND THEN RETURN 'lost'; END IF;
  -- One claim at a time per contact, so two drains cannot both pass the cap.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_account::text || ':' || v_contact::text, 0));
  -- The drain decided the guards before calling; re-check them here, from
  -- the database, so a kill switch turned back on, a trigger switched off,
  -- a closed or moved chat, an opt-out or a withdrawn consent in between
  -- never gets a send. A failure changes nothing: the next drain decides
  -- and holds the row with the right reason.
  s := hr_automsg_settings_of(v_account);
  IF s.kill_switch
     OR NOT EXISTS (SELECT 1 FROM hr_automsg_triggers t
                     WHERE t.account_id = v_account AND t.trigger = v_trigger AND t.enabled)
     OR NOT EXISTS (SELECT 1 FROM hr_conversations h
                     WHERE h.conversation_id = v_conversation AND h.account_id = v_account
                       AND h.closed_at IS NULL AND h.inbox = 'recruiter')
     OR NOT EXISTS (SELECT 1 FROM conversations c
                     WHERE c.id = v_conversation AND c.account_id = v_account
                       AND c.personal_owner_id IS NULL)
     OR NOT EXISTS (SELECT 1 FROM contacts ct
                     WHERE ct.id = v_contact AND ct.account_id = v_account
                       AND ct.opted_out_at IS NULL)
     OR (s.requires_consent
         AND NOT EXISTS (SELECT 1 FROM hr_automsg_consent k
                          WHERE k.account_id = v_account AND k.contact_id = v_contact
                            AND k.channel = v_channel AND k.granted)) THEN
    RETURN 'lost';
  END IF;
  IF hr_automsg_sent_today(v_account, v_contact, v_now)
     >= (hr_automsg_settings_of(v_account)).daily_cap THEN
    UPDATE hr_automsg_outbox x
       SET status = 'held', hold_reason = 'daily_cap', updated_at = now()
     WHERE x.id = p_id AND x.status IN ('queued', 'held', 'failed') AND x.claim_state IS NULL;
    RETURN 'capped';
  END IF;
  UPDATE hr_automsg_outbox x
     SET status = 'queued', hold_reason = NULL, claim_state = 'sending',
         claimed_at = v_now, attempts = x.attempts + 1, updated_at = now()
   WHERE x.id = p_id AND x.status IN ('queued', 'held', 'failed')
     AND x.claim_state IS NULL AND x.attempts < 3;
  RETURN CASE WHEN FOUND THEN 'claimed' ELSE 'lost' END;
END;
$$;

-- 'sent' with p_message_id NULL keeps message_id NULL: an RCS send has
-- no chat message row (212's receipt trigger needs a message_id, so it
-- does not fire for one).
CREATE OR REPLACE FUNCTION public.hr_automsg_mark(
  p_id uuid, p_status text, p_hold_reason text DEFAULT NULL,
  p_provider_message_id text DEFAULT NULL, p_message_id uuid DEFAULT NULL,
  p_error text DEFAULT NULL, p_body_rendered text DEFAULT NULL)
RETURNS public.hr_automsg_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  o hr_automsg_outbox;
  v_releasable boolean;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('queued', 'held', 'sent', 'failed', 'cancelled') THEN
    PERFORM hr_refuse('INVALID', 'unknown status');
  END IF;
  IF p_hold_reason IS NOT NULL AND p_hold_reason NOT IN (
       'kill_switch', 'disabled', 'closed', 'opted_out', 'no_consent', 'quiet_hours',
       'outside_window_no_template', 'daily_cap', 'duplicate', 'channel_not_connected') THEN
    PERFORM hr_refuse('INVALID', 'unknown hold reason');
  END IF;
  SELECT * INTO o FROM hr_automsg_outbox x WHERE x.id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM hr_refuse('NOT_FOUND', 'message not found'); END IF;
  v_releasable := o.status IN ('queued', 'held', 'failed') AND o.claim_state IS NULL;

  IF v_releasable AND p_status = 'held' THEN
    IF p_hold_reason IS NULL THEN
      PERFORM hr_refuse('INVALID', 'holding a message needs a reason');
    END IF;
    UPDATE hr_automsg_outbox x SET status = 'held', hold_reason = p_hold_reason, updated_at = now()
     WHERE x.id = p_id RETURNING * INTO o;
  ELSIF v_releasable AND p_status = 'cancelled' THEN
    UPDATE hr_automsg_outbox x SET status = 'cancelled', hold_reason = NULL, updated_at = now()
     WHERE x.id = p_id RETURNING * INTO o;
  ELSIF o.claim_state = 'sending' AND p_status = 'sent' THEN
    UPDATE hr_automsg_outbox x
       SET status = 'sent', hold_reason = NULL, claim_state = NULL, sent_at = now(),
           provider_message_id = COALESCE(p_provider_message_id, x.provider_message_id),
           message_id = COALESCE(p_message_id, x.message_id),
           body_rendered = COALESCE(p_body_rendered, x.body_rendered),
           updated_at = now()
     WHERE x.id = p_id RETURNING * INTO o;
  ELSIF o.claim_state = 'sending' AND p_status = 'failed' THEN
    UPDATE hr_automsg_outbox x
       SET status = 'failed', hold_reason = NULL, claim_state = NULL,
           last_error = left(p_error, 500), updated_at = now()
     WHERE x.id = p_id RETURNING * INTO o;
  ELSE
    PERFORM hr_refuse('ALREADY_DECIDED',
      format('cannot mark a %s message (claim %s) as %s',
             o.status, COALESCE(o.claim_state, 'none'), p_status));
  END IF;
  RETURN o;
END;
$$;

-- ------------------------------------------------------------
-- 7. Admin side: settings, templates, consent and history name the
--    channel (restates 203). Every new parameter defaults to WhatsApp,
--    so a caller that does not pass one behaves exactly as before.
-- ------------------------------------------------------------

DROP FUNCTION IF EXISTS public.hr_automsg_trigger_set(text, boolean, text);
DROP FUNCTION IF EXISTS public.hr_automsg_template_set(text, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.hr_automsg_consent_set(uuid, boolean, text);
DROP FUNCTION IF EXISTS public.hr_automsg_consent_get(uuid);
DROP FUNCTION IF EXISTS public.hr_automsg_outbox_list(text, integer);

CREATE OR REPLACE FUNCTION public.hr_automsg_config()
RETURNS jsonb
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
  IF COALESCE(v_role, '') NOT IN ('lead', 'admin') THEN
    PERFORM hr_refuse('NOT_ALLOWED', 'automated messages need a recruiter lead or an admin');
  END IF;
  RETURN jsonb_build_object(
    'settings', hr_automsg_settings_json(v_account),
    'triggers', (
      SELECT jsonb_agg(jsonb_build_object(
               'trigger', k.trigger,
               'enabled', COALESCE(t.enabled, false),
               'template_kind', COALESCE(t.template_kind, hr_automsg_default_kind(k.trigger)),
               'channel', COALESCE(t.channel, 'whatsapp'))
             ORDER BY k.ord)
        FROM unnest(ARRAY['cv_received', 'stage_ai_interview', 'stage_hr_interview',
                          'stage_manager_interview', 'interview_reminder',
                          'reply_overdue_nudge']::text[]) WITH ORDINALITY AS k(trigger, ord)
        LEFT JOIN hr_automsg_triggers t
          ON t.account_id = v_account AND t.trigger = k.trigger),
    'templates', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'kind', x.kind, 'language', x.language, 'channel', x.channel, 'body', x.body,
               'meta_template_name', x.meta_template_name,
               'approval_status', x.approval_status, 'category', x.category,
               'updated_at', x.updated_at)
             ORDER BY x.kind, x.language, x.channel)
        FROM hr_automsg_templates x WHERE x.account_id = v_account), '[]'::jsonb),
    'role', v_role);
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
  IF p_channel IS NOT NULL AND p_channel NOT IN ('whatsapp', 'rcs') THEN
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
-- as a WhatsApp draft may leave its Meta name empty.
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
  IF p_channel IS NULL OR p_channel NOT IN ('whatsapp', 'rcs') THEN
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
  IF p_channel IS NULL OR p_channel NOT IN ('whatsapp', 'rcs') THEN
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
  IF p_channel IS NULL OR p_channel NOT IN ('whatsapp', 'rcs') THEN
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

CREATE OR REPLACE FUNCTION public.hr_automsg_outbox_list(
  p_status text DEFAULT NULL, p_limit integer DEFAULT 100)
RETURNS TABLE (id uuid, conversation_id uuid, contact_id uuid, contact_name text,
               trigger text, template_kind text, language text, status text,
               hold_reason text, attempts integer, claim_state text, last_error text,
               created_at timestamptz, sent_at timestamptz, channel text)
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
  IF COALESCE(v_role, '') NOT IN ('lead', 'admin') THEN
    PERFORM hr_refuse('NOT_ALLOWED', 'automated messages need a recruiter lead or an admin');
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('queued', 'held', 'sent', 'failed', 'cancelled') THEN
    PERFORM hr_refuse('INVALID', 'unknown status');
  END IF;
  RETURN QUERY
    SELECT o.id, o.conversation_id, o.contact_id, ct.name, o.trigger, o.template_kind,
           o.language, o.status, o.hold_reason, o.attempts, o.claim_state, o.last_error,
           o.created_at, o.sent_at, o.channel
      FROM hr_automsg_outbox o
      LEFT JOIN contacts ct ON ct.id = o.contact_id AND ct.account_id = o.account_id
     WHERE o.account_id = v_account
       AND (p_status IS NULL OR o.status = p_status)
       AND hr_can_see(o.conversation_id)
     ORDER BY o.created_at DESC, o.id
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
END;
$$;

-- ------------------------------------------------------------
-- 8. Receipts within one channel (restates 212)
-- ------------------------------------------------------------

DROP FUNCTION IF EXISTS public.hr_automsg_delivery_record(uuid, text, text, timestamptz, text);

-- 'recorded' | 'unchanged' | 'failed_terminal' | 'unknown_message' (no
-- row of the account and channel has that provider id; not an error).
-- p_reason is the provider's error code of a failed status, NULL
-- otherwise. 212's receipt trigger calls it with five arguments, which
-- resolve to p_channel 'whatsapp'.
CREATE OR REPLACE FUNCTION public.hr_automsg_delivery_record(
  p_account_id uuid, p_provider_message_id text, p_state text,
  p_at timestamptz, p_reason text, p_channel text DEFAULT 'whatsapp')
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
  IF p_state IS NULL OR p_state NOT IN ('sent', 'delivered', 'read', 'failed') THEN
    PERFORM hr_refuse('INVALID', 'unknown delivery state');
  END IF;
  IF p_provider_message_id IS NULL OR p_provider_message_id ~ '^[[:space:]]*$' THEN
    PERFORM hr_refuse('INVALID', 'a provider message id is required');
  END IF;
  IF p_channel IS NULL OR p_channel NOT IN ('whatsapp', 'rcs') THEN
    PERFORM hr_refuse('INVALID', 'unknown channel');
  END IF;
  SELECT * INTO o FROM hr_automsg_outbox x
   WHERE x.account_id = p_account_id AND x.provider_message_id = p_provider_message_id
     AND x.channel = p_channel
   ORDER BY x.created_at DESC, x.id DESC
   LIMIT 1
   FOR UPDATE;
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

-- ------------------------------------------------------------
-- 9. Function privileges (as in 203 and 212)
-- ------------------------------------------------------------

REVOKE ALL ON FUNCTION
  public.hr_automsg_on_history(),
  public.hr_automsg_config(),
  public.hr_automsg_trigger_set(text, boolean, text, text),
  public.hr_automsg_template_set(text, text, text, text, text, text, text),
  public.hr_automsg_consent_get(uuid, text),
  public.hr_automsg_consent_set(uuid, boolean, text, text),
  public.hr_automsg_outbox_list(text, integer),
  public.hr_automsg_row_state(uuid),
  public.hr_automsg_claim(uuid, timestamptz),
  public.hr_automsg_mark(uuid, text, text, text, uuid, text, text),
  public.hr_automsg_enqueue_nudges(timestamptz),
  public.hr_automsg_delivery_record(uuid, text, text, timestamptz, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.hr_automsg_config(),
  public.hr_automsg_trigger_set(text, boolean, text, text),
  public.hr_automsg_template_set(text, text, text, text, text, text, text),
  public.hr_automsg_consent_get(uuid, text),
  public.hr_automsg_consent_set(uuid, boolean, text, text),
  public.hr_automsg_outbox_list(text, integer)
  TO authenticated;

GRANT EXECUTE ON FUNCTION
  public.hr_automsg_row_state(uuid),
  public.hr_automsg_claim(uuid, timestamptz),
  public.hr_automsg_mark(uuid, text, text, text, uuid, text, text),
  public.hr_automsg_enqueue_nudges(timestamptz),
  public.hr_automsg_delivery_record(uuid, text, text, timestamptz, text, text)
  TO service_role;
