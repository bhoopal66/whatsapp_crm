-- ============================================================
-- 327_shared_daily_cap.sql — one daily cap of automated messages per
-- person, counted the same way by every automated sender.
--
-- The cap (3 a day) was lopsided: the HR claim (203/275) counted only HR
-- messages, the desk digest claim (263) HR messages and digests, and a
-- CSAT request (246/281) counted nothing and was not counted. A person
-- could get 3 HR messages and a reminder in one day, and any number of
-- automated messages plus a rating request.
--
--  1. automated_sends_today(account, contact, now, tz) is the one
--     definition: HR messages sent or in flight (203's rule, unchanged),
--     digests and CSAT requests 'sending' / 'sent' / 'unconfirmed' (one
--     whose result never came back may have gone out), on p_now's day in
--     p_tz. Each claim keeps its own day: HR the workspace's HR time zone
--     (hr_automsg_settings.tz, default Asia/Dubai), the desk and CSAT the
--     Dubai day (desk_today).
--  2. hr_automsg_sent_today (203) now answers that count, so the HR claim
--     (275) and hr_automsg_row_state's sent_today (the engine's guard)
--     include digests and CSAT requests. Over the cap HR still holds
--     ('held' / 'daily_cap') against its own daily_cap setting.
--  3. desk_digest_claim (RESTATES 263) counts with it; over the cap it
--     still cancels ('daily_cap'), and the enqueue may queue again the
--     next day.
--  4. case_csat_claim (RESTATES 281) counts with it; over the cap the
--     request is held ('held' / 'daily_cap') until the next Dubai day,
--     then goes out within the send hours like any held request; one not
--     sent within 3 days expires as before.
--  5. The desk and CSAT claims take the HR claim's per-person advisory
--     lock before they count, so two senders cannot both pass the same
--     count. They only try it: a row whose lock is held waits for the
--     next pass, so two claim loops never wait on each other.
--
-- RESTATES 203's hr_automsg_sent_today, 263's desk_digest_claim and
-- 281's case_csat_claim: apply in order, once. Re-applying 203, 263 or
-- 281 after this file brings back the one-way cap; re-apply this file
-- after them. Apply as a superuser or a BYPASSRLS role (the claims read
-- RLS-forced tables). Asserted by supabase/ci/verify-shared-daily-cap.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '327 must be applied by a superuser or BYPASSRLS role (the claims read RLS-forced tables)';
  END IF;
  IF to_regprocedure('public.hr_automsg_stale_reason(text,text,uuid)') IS NULL THEN
    RAISE EXCEPTION '327: apply 275_hr_automsg_still_true.sql first';
  END IF;
  IF to_regprocedure('public.case_csat_handoff(uuid,timestamptz,timestamptz)') IS NULL THEN
    RAISE EXCEPTION '327: apply 281_csat_fixes.sql first';
  END IF;
END $$;

-- ---------- 1. The one count ----------

CREATE OR REPLACE FUNCTION public.automated_sends_today(
  p_account uuid, p_contact uuid, p_now timestamptz, p_tz text)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT (
    (SELECT count(*) FROM public.hr_automsg_outbox o
      WHERE o.account_id = p_account AND o.contact_id = p_contact
        AND (o.status = 'sent' OR o.claim_state IN ('sending', 'needs_review'))
        AND (coalesce(o.sent_at, o.claimed_at) AT TIME ZONE p_tz)::date = (p_now AT TIME ZONE p_tz)::date)
  + (SELECT count(*) FROM public.desk_digest_outbox d
      WHERE d.account_id = p_account AND d.contact_id = p_contact
        AND d.status IN ('sending', 'sent', 'unconfirmed')
        AND coalesce((coalesce(d.sent_at, d.claimed_at) AT TIME ZONE p_tz)::date, d.local_day)
            = (p_now AT TIME ZONE p_tz)::date)
  + (SELECT count(*) FROM public.case_csat_requests c
      WHERE c.account_id = p_account AND c.contact_id = p_contact
        AND c.status IN ('sending', 'sent', 'unconfirmed')
        AND (coalesce(c.sent_at, c.claimed_at) AT TIME ZONE p_tz)::date = (p_now AT TIME ZONE p_tz)::date)
  )::integer
$$;

COMMENT ON FUNCTION public.automated_sends_today(uuid, uuid, timestamptz, text) IS
  'Automated messages (HR, desk digests, CSAT requests) sent or in flight to a contact on p_now''s day in p_tz: the shared daily cap. Migration 327.';

-- ---------- 2. HR counts it (RESTATES 203) ----------

-- Was: HR outbox rows only. hr_automsg_claim (275) and
-- hr_automsg_row_state (275) call this; neither is restated.
CREATE OR REPLACE FUNCTION public.hr_automsg_sent_today(
  p_account uuid, p_contact uuid, p_now timestamptz)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.automated_sends_today(p_account, p_contact, p_now,
           coalesce((hr_automsg_settings_of(p_account)).tz, 'Asia/Dubai'))
$$;

-- ---------- 3. The desk digest counts it (RESTATES 263) ----------

CREATE OR REPLACE FUNCTION public.desk_digest_claim(p_now timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 50)
 RETURNS TABLE(id uuid, account_id uuid, contact_id uuid, conversation_id uuid, app_number text, summary text, template_name text, language text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_now   timestamptz := coalesce(p_now, now());
  v_today date := public.desk_today(p_now);
  v_hour  integer := extract(hour FROM v_now AT TIME ZONE 'Asia/Dubai')::integer;
  o       public.desk_digest_outbox%ROWTYPE;
  s       public.desk_digest_settings%ROWTYPE;
  ct      public.contacts%ROWTYPE;
  v_sent  integer;
  v_n     integer := 0;
  v_max   integer := least(greatest(coalesce(p_limit, 50), 1), 200);
BEGIN
  -- A claim with no result for 10 minutes may have reached the gateway:
  -- never resent.
  UPDATE public.desk_digest_outbox x SET status = 'unconfirmed'
   WHERE x.status = 'sending' AND x.claimed_at < v_now - interval '10 minutes';

  IF v_hour < 8 OR v_hour >= 21 THEN
    RETURN;  -- quiet hours: nothing leaves, the rows wait
  END IF;

  FOR o IN SELECT * FROM public.desk_digest_outbox x WHERE x.status = 'queued' AND x.local_day <= v_today
            -- The limit counts digests claimed, not rows only cancelled
            -- (yesterday's, opted out): those must not use up a pass.
            ORDER BY x.created_at LIMIT 500
            FOR UPDATE SKIP LOCKED LOOP
    EXIT WHEN v_n >= v_max;
    SELECT * INTO s FROM public.desk_digest_settings x WHERE x.account_id = o.account_id;
    IF NOT coalesce(s.enabled, false) OR s.template_name IS NULL
       OR NOT public.desk_digest_template_ok(o.account_id, s.template_name, s.language) THEN
      UPDATE public.desk_digest_outbox x SET status = 'cancelled', status_reason = 'switched_off' WHERE x.id = o.id;
      CONTINUE;
    END IF;
    IF o.local_day < v_today THEN
      UPDATE public.desk_digest_outbox x SET status = 'cancelled', status_reason = 'stale' WHERE x.id = o.id;
      CONTINUE;
    END IF;
    SELECT * INTO ct FROM public.contacts x WHERE x.id = o.contact_id;
    IF ct.opted_out_at IS NOT NULL OR ct.do_not_contact_at IS NOT NULL THEN
      UPDATE public.desk_digest_outbox x SET status = 'cancelled', status_reason = 'opted_out' WHERE x.id = o.id;
      CONTINUE;
    END IF;
    -- The daily cap: 3 automated messages per person per Dubai day, HR
    -- automated messages, these digests and CSAT requests together (327:
    -- automated_sends_today). HR's per-person lock first, so an HR claim
    -- or a CSAT claim cannot pass the same count meanwhile; taken, the row
    -- waits for the next pass rather than block a loop holding others.
    CONTINUE WHEN NOT pg_try_advisory_xact_lock(
      hashtextextended(o.account_id::text || ':' || o.contact_id::text, 0));
    v_sent := public.automated_sends_today(o.account_id, o.contact_id, v_now, 'Asia/Dubai');
    IF v_sent >= 3 THEN
      UPDATE public.desk_digest_outbox x SET status = 'cancelled', status_reason = 'daily_cap' WHERE x.id = o.id;
      CONTINUE;
    END IF;
    UPDATE public.desk_digest_outbox x
       SET status = 'sending', attempts = x.attempts + 1, claimed_at = v_now
     WHERE x.id = o.id;
    v_n := v_n + 1;
    RETURN QUERY SELECT o.id, o.account_id, o.contact_id, o.conversation_id, o.app_number, o.summary,
                        s.template_name, s.language;
  END LOOP;
END;
$function$;


-- ---------- 4. CSAT counts it and is counted (RESTATES 281) ----------

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
    -- The daily cap (327): 3 automated messages per person per Dubai day,
    -- HR automated messages, desk digests and these requests together.
    -- HR's per-person lock first (taken: the row waits for the next pass).
    -- Over the cap the request is held until the next Dubai day and goes
    -- out then, within the send hours; the 3-day expiry above still ends it.
    CONTINUE WHEN NOT pg_try_advisory_xact_lock(
      hashtextextended(o.account_id::text || ':' || o.contact_id::text, 0));
    IF public.automated_sends_today(o.account_id, o.contact_id, v_now, 'Asia/Dubai') >= 3 THEN
      UPDATE public.case_csat_requests x
         SET status = 'held', status_reason = 'daily_cap',
             next_attempt_at = ((public.desk_today(v_now) + 1)::timestamp AT TIME ZONE 'Asia/Dubai')
       WHERE x.id = o.id;
      CONTINUE;
    END IF;
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

-- ---------- 5. Privileges ----------

-- Only the claims (SECURITY DEFINER) call the count. CREATE OR REPLACE
-- keeps the restated functions' own grants (service_role).
REVOKE ALL ON FUNCTION public.automated_sends_today(uuid, uuid, timestamptz, text)
FROM PUBLIC, anon, authenticated, service_role;

RESET lock_timeout;
