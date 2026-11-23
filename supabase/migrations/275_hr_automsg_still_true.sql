-- ============================================================
-- 275_hr_automsg_still_true.sql — an automated message only goes out
-- while its reason still holds.
--
--   1. A queued HR message was re-checked for the switches, the opt-out,
--      the consent and the cap, never for why it was queued: an interview
--      invite held for quiet hours went out next morning after the
--      recruiter had moved the candidate back, and a "we haven't heard
--      from you" nudge after the candidate had replied.
--      hr_automsg_stale_reason answers NULL (still true),
--      'stage_changed' or 'no_longer_waiting'. hr_automsg_row_state
--      carries it as `stale` and the engine cancels the row;
--      hr_automsg_claim settles the row itself as 'cancelled' with the
--      reason in last_error. hr_automsg_mark keeps the reason of a
--      cancel. (hold_reason cannot: 203 ties it to status 'held'.)
--   2. web_form_submit opened one task per contact per 10 minutes and
--      dropped the text of every other submission. A different text now
--      joins the open task's note.
--
-- Restates 215's hr_automsg_row_state, hr_automsg_claim and
-- hr_automsg_mark and 256's web_form_submit: apply in order, once.
-- Mirrors: src/lib/hr/automsg/guards.ts, types.ts (STALE_REASONS).
-- ============================================================

-- ---------- 1. Is the reason still true ----------

-- A stage row: the chat is still in the recruiter stage its trigger
-- names. A nudge: the candidate has still not answered, and the silence
-- is the one the key was built from (226: 'nudge:<chat>:<epoch of our
-- last message>', with '|rcs' or '|sms' after it). A key of another
-- shape is not proof of anything, so it is stale.
CREATE OR REPLACE FUNCTION public.hr_automsg_stale_reason(
  p_trigger text, p_dedupe_key text, p_conversation_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_trigger LIKE 'stage\_%' THEN
      CASE WHEN EXISTS (SELECT 1 FROM hr_conversations h
                         WHERE h.conversation_id = p_conversation_id
                           AND h.inbox = 'recruiter'
                           AND 'stage_' || h.stage_key = p_trigger)
           THEN NULL ELSE 'stage_changed' END
    WHEN p_trigger = 'reply_overdue_nudge' THEN
      CASE WHEN EXISTS (SELECT 1 FROM hr_conversations h
                         WHERE h.conversation_id = p_conversation_id
                           AND h.reply_state = 'waiting'
                           AND split_part(p_dedupe_key, '|', 1)
                               = 'nudge:' || h.conversation_id || ':'
                                 || floor(extract(epoch FROM h.last_outbound_at))::bigint)
           THEN NULL ELSE 'no_longer_waiting' END
  END
$$;

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
    'stale', hr_automsg_stale_reason(o.trigger, o.dedupe_key, o.conversation_id),
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
  v_key text;
  v_stale text;
  s hr_automsg_settings;
BEGIN
  SELECT x.account_id, x.contact_id, x.conversation_id, x.trigger, x.channel, x.dedupe_key
    INTO v_account, v_contact, v_conversation, v_trigger, v_channel, v_key
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
  -- 275: the reason the row was queued for is gone. 'lost' alone would
  -- leave it queued, to go out when the chat moves back: settle it.
  v_stale := hr_automsg_stale_reason(v_trigger, v_key, v_conversation);
  IF v_stale IS NOT NULL THEN
    UPDATE hr_automsg_outbox x
       SET status = 'cancelled', hold_reason = NULL, last_error = v_stale, updated_at = now()
     WHERE x.id = p_id AND x.status IN ('queued', 'held', 'failed') AND x.claim_state IS NULL;
    RETURN CASE WHEN FOUND THEN 'cancelled' ELSE 'lost' END;
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

-- A cancel keeps its reason (p_error).
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
    UPDATE hr_automsg_outbox x SET status = 'cancelled', hold_reason = NULL,
           last_error = COALESCE(left(p_error, 500), x.last_error), updated_at = now()
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

REVOKE ALL ON FUNCTION
  public.hr_automsg_stale_reason(text, text, uuid),
  public.hr_automsg_row_state(uuid),
  public.hr_automsg_claim(uuid, timestamptz),
  public.hr_automsg_mark(uuid, text, text, text, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.hr_automsg_row_state(uuid),
  public.hr_automsg_claim(uuid, timestamptz),
  public.hr_automsg_mark(uuid, text, text, text, uuid, text, text)
  TO service_role;

NOTIFY pgrst, 'reload schema';
