-- ============================================================
-- 281_csat_fixes.sql — case satisfaction requests (246) made safe to
-- switch on. docs/case-csat.md is the contract.
--
--  1. case_csat_claim (RESTATES 263) re-reads the case: an 'approved'
--     request whose case is no longer approved, or a 'submitted' one
--     whose case is back before submission or closed as anything but
--     approved, is 'cancelled' / 'case_changed' (held ones too).
--  2. case_csat_capture with the conversation: a reply is a rating only
--     in the chat the request went to, and only when nothing else was
--     said to the customer there since, or when it quotes the request.
--     246's six-argument form stays for a build before this one.
--  3. handed_to_gateway_at, stamped by case_csat_handoff just before the
--     gateway: a lost claim without it goes back to the queue, one with
--     it is 'unconfirmed'. case_csat_mark with the claim's own
--     claimed_at also takes 'unconfirmed', and only for that claim.
--
-- Re-runnable. Re-applying 246 or 263 restores their case_csat_claim:
-- apply in order, once, or re-apply this file after them. Switch CSAT on
-- only with the build that stamps the handoff: an older build never
-- does, so a send it lost would go out again.
--
-- PRIVILEGES: SECURITY DEFINER, search_path '', service_role only. Apply
-- as a superuser or BYPASSRLS role after 263. Asserted by
-- supabase/ci/verify-csat-fixes.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '281 must be applied by a superuser or BYPASSRLS role (the CSAT functions read RLS-forced tables)';
  END IF;
  IF to_regclass('public.case_csat_requests') IS NULL THEN
    RAISE EXCEPTION '281 needs 246 (case_csat_requests)';
  END IF;
  -- Only when the column is added: a row an older build has in flight may
  -- have reached the gateway.
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = 'public.case_csat_requests'::regclass
                    AND a.attname = 'handed_to_gateway_at' AND NOT a.attisdropped) THEN
    ALTER TABLE public.case_csat_requests ADD COLUMN handed_to_gateway_at timestamptz NULL;
    UPDATE public.case_csat_requests x SET handed_to_gateway_at = x.claimed_at WHERE x.status = 'sending';
  END IF;
END $$;

COMMENT ON COLUMN public.case_csat_requests.handed_to_gateway_at IS
  'Stamped just before the request goes to the gateway: without it a lost claim was never sent. Migration 281.';

-- ---------- 1. Is the moment still true? ----------

-- The case as it is now, by the rules of case_csat_trigger_for (246).
CREATE OR REPLACE FUNCTION public.case_csat_still_due(p_account uuid, p_case uuid, p_trigger text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce((
    SELECT CASE
             WHEN k.stage = 'Approved' OR k.outcome = 'Approved' THEN true
             WHEN p_trigger = 'approved' THEN false
             ELSE NOT public.case_stage_is_presub(k.stage)
                  AND k.stage NOT IN ('Declined', 'Withdrawn', 'Closed')
           END
      FROM public.cases k WHERE k.id = p_case AND k.account_id = p_account), false)
$$;

-- RESTATES 263.
CREATE OR REPLACE FUNCTION public.case_csat_claim(p_now timestamptz DEFAULT NULL, p_limit integer DEFAULT 50)
RETURNS TABLE (id uuid, account_id uuid, case_id uuid, trigger text, contact_id uuid, conversation_id uuid,
               contact_name text, bank_name text, product text, template_name text, language text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_now   timestamptz := coalesce(p_now, now());
  v_hour  integer := extract(hour FROM v_now AT TIME ZONE 'Asia/Dubai')::integer;
  o       public.case_csat_requests%ROWTYPE;
  s       public.case_csat_settings%ROWTYPE;
  ct      public.contacts%ROWTYPE;
  v_bank  text;
  v_prod  text;
  v_n     integer := 0;
  v_max   integer := least(greatest(coalesce(p_limit, 50), 1), 200);
BEGIN
  -- A claim with no result for 10 minutes: handed to the gateway, it may
  -- have been delivered and is never resent (281); never handed over,
  -- nobody was asked and it goes back to the queue.
  UPDATE public.case_csat_requests x
     SET status = CASE WHEN x.handed_to_gateway_at IS NULL THEN 'queued' ELSE 'unconfirmed' END,
         claimed_at = CASE WHEN x.handed_to_gateway_at IS NULL THEN NULL ELSE x.claimed_at END
   WHERE x.status = 'sending' AND x.claimed_at < v_now - interval '10 minutes';
  -- Not sent within 3 days: too late to ask.
  UPDATE public.case_csat_requests x SET status = 'cancelled', status_reason = 'expired'
   WHERE x.status IN ('queued', 'held') AND x.created_at < v_now - interval '3 days';

  IF v_hour < 8 OR v_hour >= 21 THEN
    RETURN;  -- quiet hours everywhere: nothing leaves, the rows wait
  END IF;

  FOR o IN SELECT * FROM public.case_csat_requests x
            WHERE x.status = 'queued' OR (x.status = 'held' AND coalesce(x.next_attempt_at, x.created_at) <= v_now)
            -- Fresh requests first: one held for a template retries every hour
            -- and, five to a pass, would take every place from the new ones.
            ORDER BY (x.status = 'held'), x.created_at
            LIMIT 500
            FOR UPDATE SKIP LOCKED LOOP
    EXIT WHEN v_n >= v_max;
    SELECT * INTO s FROM public.case_csat_settings x WHERE x.account_id = o.account_id;
    IF NOT coalesce(s.enabled, false)
       OR (o.trigger = 'submitted' AND NOT s.ask_on_submitted)
       OR (o.trigger = 'approved' AND NOT s.ask_on_approved) THEN
      UPDATE public.case_csat_requests x SET status = 'cancelled', status_reason = 'switched_off' WHERE x.id = o.id;
      CONTINUE;
    END IF;
    -- The workspace's own send hours (Dubai): the row waits.
    CONTINUE WHEN v_hour < s.send_start_hour OR v_hour >= s.send_end_hour;
    -- The moment must still hold (281): a corrected approval, or a case
    -- back before submission or closed without one, is not asked about.
    IF NOT public.case_csat_still_due(o.account_id, o.case_id, o.trigger) THEN
      UPDATE public.case_csat_requests x SET status = 'cancelled', status_reason = 'case_changed' WHERE x.id = o.id;
      CONTINUE;
    END IF;
    IF o.contact_id IS NULL OR o.conversation_id IS NULL THEN
      UPDATE public.case_csat_requests x SET status = 'cancelled', status_reason = 'no_chat' WHERE x.id = o.id;
      CONTINUE;
    END IF;
    -- One claimer per person at a time: the per-person count below holds.
    PERFORM pg_advisory_xact_lock(hashtextextended('case_csat:' || o.contact_id::text, 0));
    SELECT * INTO ct FROM public.contacts x WHERE x.id = o.contact_id;
    IF NOT FOUND OR ct.opted_out_at IS NOT NULL OR ct.do_not_contact_at IS NOT NULL THEN
      UPDATE public.case_csat_requests x SET status = 'cancelled', status_reason = 'opted_out' WHERE x.id = o.id;
      CONTINUE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.conversations v
                    WHERE v.id = o.conversation_id AND v.account_id = o.account_id
                      AND v.contact_id = o.contact_id AND v.personal_owner_id IS NULL) THEN
      UPDATE public.case_csat_requests x SET status = 'cancelled', status_reason = 'no_chat' WHERE x.id = o.id;
      CONTINUE;
    END IF;
    -- At most one rating request per person per 24 hours: the row waits.
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.case_csat_requests d
                           WHERE d.contact_id = o.contact_id AND d.id <> o.id
                             AND d.status IN ('sending', 'sent', 'unconfirmed')
                             AND d.claimed_at > v_now - interval '24 hours');
    SELECT b.name INTO v_bank FROM public.case_banks b WHERE b.account_id = o.account_id AND b.code = o.bank_code;
    SELECT k.product INTO v_prod FROM public.cases k WHERE k.id = o.case_id;
    UPDATE public.case_csat_requests x
       SET status = 'sending', attempts = x.attempts + 1, claimed_at = v_now, status_reason = NULL,
             handed_to_gateway_at = NULL
     WHERE x.id = o.id;
    v_n := v_n + 1;
    RETURN QUERY SELECT o.id, o.account_id, o.case_id, o.trigger, o.contact_id, o.conversation_id,
                        ct.name, coalesce(v_bank, o.bank_code), v_prod,
                        CASE o.trigger WHEN 'approved' THEN s.template_approved ELSE s.template_submitted END,
                        s.language;
  END LOOP;
END;
$$;

-- ---------- 3. The handoff and its result ----------

-- The stamp, for the claim that made it (p_claimed_at = the p_now the
-- claim was taken with). False: the claim was lost meanwhile (back in the
-- queue, erased) and nothing may be sent. A repeat for the same claim is
-- true again.
CREATE OR REPLACE FUNCTION public.case_csat_handoff(p_id uuid, p_claimed_at timestamptz, p_now timestamptz DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.case_csat_requests x
     SET handed_to_gateway_at = coalesce(x.handed_to_gateway_at, p_now, now())
   WHERE x.id = p_id AND x.status = 'sending' AND x.claimed_at = p_claimed_at;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$$;

-- sent | failed (certainly refused) | held (nothing was sent: the stamp is
-- taken back) | unconfirmed (it may have been delivered: never resent, and
-- a reply to it counts). Only the claim's own row, while 'sending'. No
-- defaults: 246's seven-argument form stays callable.
CREATE OR REPLACE FUNCTION public.case_csat_mark(p_id uuid, p_outcome text, p_via text, p_provider_message_id text,
  p_message_id uuid, p_reason text, p_claimed_at timestamptz, p_now timestamptz)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := coalesce(p_now, now());
  v_n   integer;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('sent', 'failed', 'held', 'unconfirmed')
     OR (p_outcome IN ('sent', 'unconfirmed') AND coalesce(p_via, '') NOT IN ('template', 'text')) THEN
    RAISE EXCEPTION 'case_csat_mark: outcome is sent or unconfirmed (with a via), failed or held'
      USING ERRCODE = 'check_violation', HINT = 'INVALID';
  END IF;
  UPDATE public.case_csat_requests x
     SET status = p_outcome,
         sent_at = CASE WHEN p_outcome = 'sent' THEN v_now END,
         sent_via = CASE WHEN p_outcome IN ('sent', 'unconfirmed') THEN p_via END,
         next_attempt_at = CASE WHEN p_outcome = 'held' THEN v_now + interval '1 hour' END,
         handed_to_gateway_at = CASE WHEN p_outcome = 'held' THEN NULL ELSE x.handed_to_gateway_at END,
         provider_message_id = p_provider_message_id, message_id = p_message_id,
         status_reason = left(nullif(btrim(regexp_replace(coalesce(p_reason, ''), '[^a-z0-9_]', '', 'g')), ''), 200)
   WHERE x.id = p_id AND x.status = 'sending' AND x.claimed_at = p_claimed_at;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$$;

-- ---------- 2. The reply ----------

-- Is this message the request itself: the row saved for it, its provider
-- id, or (unconfirmed, so no provider id) the number's own echo of it.
CREATE OR REPLACE FUNCTION public.case_csat_is_request(p_request uuid, p_message uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.case_csat_requests r
      JOIN public.messages m ON m.id = p_message
      LEFT JOIN public.messages own ON own.id = r.message_id
     WHERE r.id = p_request
       AND (m.id = r.message_id
            OR m.message_id = r.provider_message_id
            OR (r.status = 'unconfirmed' AND m.conversation_id = own.conversation_id
                AND m.sender_type <> 'customer' AND m.content_text = own.content_text)))
$$;

-- The newest open request in p_conversation that p_message answers:
-- p_quoted (the message it quotes, if any) is the request, or nothing
-- quoted and no staff or bot message but the request since it was sent.
CREATE OR REPLACE FUNCTION public.case_csat_capture(p_account uuid, p_contact uuid, p_conversation uuid, p_message uuid,
  p_quoted uuid, p_score integer, p_comment text, p_now timestamptz DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now     timestamptz := coalesce(p_now, now());
  v_window  integer;
  q         public.case_csat_requests%ROWTYPE;
  v_comment text := nullif(btrim(left(coalesce(p_comment, ''), 1000)), '');
  v_id      uuid;
BEGIN
  IF p_score IS NULL OR p_score NOT BETWEEN 1 AND 5 OR p_account IS NULL OR p_contact IS NULL
     OR p_conversation IS NULL THEN
    RETURN false;
  END IF;
  SELECT s.reply_window_days INTO v_window FROM public.case_csat_settings s
   WHERE s.account_id = p_account AND s.enabled;
  IF v_window IS NULL THEN
    RETURN false;
  END IF;
  IF v_comment ~ '^[[:space:]]*$' THEN
    v_comment := NULL;
  END IF;
  SELECT * INTO q FROM public.case_csat_requests r
   WHERE r.contact_id = p_contact AND r.account_id = p_account AND r.conversation_id = p_conversation
     AND r.answered_at IS NULL AND r.status IN ('sent', 'unconfirmed')
     AND coalesce(r.sent_at, r.claimed_at) <= v_now
     AND coalesce(r.sent_at, r.claimed_at) > v_now - make_interval(days => v_window)
     AND CASE
           WHEN p_quoted IS NOT NULL THEN public.case_csat_is_request(r.id, p_quoted)
           ELSE NOT EXISTS (
             SELECT 1 FROM public.messages m
              WHERE m.conversation_id = r.conversation_id AND m.sender_type <> 'customer'
                AND m.created_at > coalesce(r.sent_at, r.handed_to_gateway_at, r.claimed_at)
                AND NOT public.case_csat_is_request(r.id, m.id))
         END
   ORDER BY coalesce(r.sent_at, r.claimed_at) DESC
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO public.case_csat_responses AS x (account_id, case_id, request_id, trigger, contact_id, agent_id,
                                               bank_code, score, comment, message_id, responded_at)
  VALUES (q.account_id, q.case_id, q.id, q.trigger, q.contact_id, q.agent_id, q.bank_code, p_score::smallint,
          v_comment, p_message, v_now)
  ON CONFLICT ON CONSTRAINT case_csat_responses_once DO NOTHING
  RETURNING x.id INTO v_id;
  UPDATE public.case_csat_requests r SET answered_at = v_now WHERE r.id = q.id AND r.answered_at IS NULL;
  RETURN v_id IS NOT NULL;
END;
$$;

-- ---------- 4. Privileges ----------

REVOKE ALL ON FUNCTION
  public.case_csat_still_due(uuid, uuid, text),
  public.case_csat_is_request(uuid, uuid),
  public.case_csat_claim(timestamptz, integer),
  public.case_csat_handoff(uuid, timestamptz, timestamptz),
  public.case_csat_mark(uuid, text, text, text, uuid, text, timestamptz, timestamptz),
  public.case_csat_capture(uuid, uuid, uuid, uuid, uuid, integer, text, timestamptz)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.case_csat_claim(timestamptz, integer),
  public.case_csat_handoff(uuid, timestamptz, timestamptz),
  public.case_csat_mark(uuid, text, text, text, uuid, text, timestamptz, timestamptz),
  public.case_csat_capture(uuid, uuid, uuid, uuid, uuid, integer, text, timestamptz)
TO service_role;

RESET lock_timeout;
