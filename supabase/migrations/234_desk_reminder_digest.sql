-- ============================================================
-- 234_desk_reminder_digest.sql — one daily reminder per company of what
-- is still missing, across all its banks (design 035 D9, slice F).
--
-- OFF BY DEFAULT, and nothing is sent until an owner or admin switches it
-- on with an APPROVED UTILITY template (message_templates) whose body
-- takes {{1}} = the application number and {{2}} = the pending summary,
-- e.g. "Application {{1}}: still needed: {{2}}. Reply STOP to pause
-- reminders."
--
--  * Enqueue (desk_digest_enqueue, automations cron): at most ONE digest
--    per company per Dubai day (UNIQUE), between the workspace's send
--    hour and 20:00 Dubai, for a company with open desk cases not yet
--    submitted that still miss a required document (missing or
--    rejected, 233's cells). Not again within gap_days (default 2) of the
--    last digest, nor of the last document any of its people sent (a
--    document resets the rhythm). The summary is one line, each document
--    once: "All banks: Ejari. ENBD: KYC form".
--  * Recipient: an authorised person of the company (229), else the
--    contact of its oldest open case; their company chat (never a
--    personal one, 191); never someone opted out or do-not-contact.
--  * Claim (desk_digest_claim) re-checks everything at send time: the
--    switch and template, the day, opt-out and do-not-contact, quiet
--    hours (none before 08:00 or from 21:00 Dubai) and the daily cap of
--    3 messages per person counted across HR automated messages (203)
--    and these digests. A claim older than 10 minutes with no result is
--    'unconfirmed' and never resent.
--  * STOP: desk_digest_stop opts the person out (contacts.opted_out_at,
--    076) when they reply STOP to a digest sent in the last 30 days, and
--    cancels their queued digests.
--  * Whether a reminder is transactional is for legal sign-off (design
--    section 8, flag 5).
--
-- Refusals (HINT): INVALID, NOT_ALLOWED, TEMPLATE_INVALID.
--
-- PRIVILEGES: SECURITY DEFINER, search_path '', service_role only; the
-- tables force RLS with no policy and no grants. Apply as a superuser or
-- BYPASSRLS role after 233. Re-runnable. Asserted by
-- supabase/ci/verify-desk-reminder-digest.sql. docs/case-desk.md is the
-- contract.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '234 must be applied by a superuser or BYPASSRLS role (the desk functions read RLS-forced tables)';
  END IF;
  IF to_regprocedure('public.desk_case_doc_cell(uuid,text)') IS NULL THEN
    RAISE EXCEPTION '234: apply 233_desk_application_view.sql first';
  END IF;
END $$;

-- ---------- 1. Tables ----------

CREATE TABLE IF NOT EXISTS public.desk_digest_settings (
  account_id     uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  enabled        boolean NOT NULL DEFAULT false,
  template_name  text NULL,
  language       text NOT NULL DEFAULT 'en',
  send_hour      integer NOT NULL DEFAULT 10,
  gap_days       integer NOT NULL DEFAULT 2,
  updated_by     uuid NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT desk_digest_settings_hour_check CHECK (send_hour BETWEEN 8 AND 20),
  CONSTRAINT desk_digest_settings_gap_check CHECK (gap_days BETWEEN 1 AND 14),
  CONSTRAINT desk_digest_settings_language_check CHECK (language ~ '^[a-z]{2}(_[A-Z]{2})?$'),
  CONSTRAINT desk_digest_settings_on_check CHECK (NOT enabled OR template_name IS NOT NULL)
);
ALTER TABLE public.desk_digest_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.desk_digest_settings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.desk_digest_settings FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON TABLE public.desk_digest_settings IS
  'Desk reminder digest per workspace: off by default; the approved utility template; send hour; gap days. Migration 234.';

CREATE TABLE IF NOT EXISTS public.desk_digest_outbox (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL,
  customer_id          uuid NOT NULL,
  contact_id           uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  conversation_id      uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  local_day            date NOT NULL,
  app_number           text NOT NULL,
  summary              text NOT NULL,
  pending              integer NOT NULL,
  status               text NOT NULL DEFAULT 'queued',
  status_reason        text NULL,
  attempts             integer NOT NULL DEFAULT 0,
  claimed_at           timestamptz NULL,
  sent_at              timestamptz NULL,
  provider_message_id  text NULL,
  message_id           uuid NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT desk_digest_outbox_customer_fkey FOREIGN KEY (customer_id, account_id)
    REFERENCES public.desk_customers (id, account_id) ON DELETE CASCADE,
  CONSTRAINT desk_digest_outbox_one_a_day UNIQUE (customer_id, local_day),
  CONSTRAINT desk_digest_outbox_status_check
    CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'cancelled', 'unconfirmed')),
  CONSTRAINT desk_digest_outbox_summary_check CHECK (char_length(summary) BETWEEN 1 AND 900),
  CONSTRAINT desk_digest_outbox_pending_check CHECK (pending > 0)
);
CREATE INDEX IF NOT EXISTS desk_digest_outbox_queue_idx ON public.desk_digest_outbox (status, created_at);
CREATE INDEX IF NOT EXISTS desk_digest_outbox_contact_idx ON public.desk_digest_outbox (contact_id, local_day);
ALTER TABLE public.desk_digest_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.desk_digest_outbox FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.desk_digest_outbox FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON TABLE public.desk_digest_outbox IS
  'Desk reminder digests: one per company per Dubai day; guarded again at claim; never resent once unconfirmed. Migration 234.';

-- ---------- 2. Settings ----------

CREATE OR REPLACE FUNCTION public.desk_digest_settings_get(p_actor uuid, p_account uuid)
RETURNS TABLE (enabled boolean, template_name text, language text, send_hour integer, gap_days integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF public.case_account_role(p_account, p_actor) IS NULL THEN
    PERFORM public.desk_refuse('desk_digest_settings_get', 'NOT_ALLOWED', 'staff only');
  END IF;
  RETURN QUERY
  SELECT coalesce(s.enabled, false), s.template_name, coalesce(s.language, 'en'),
         coalesce(s.send_hour, 10), coalesce(s.gap_days, 2)
    FROM (SELECT 1) one LEFT JOIN public.desk_digest_settings s ON s.account_id = p_account;
END;
$$;

-- An approved utility template of the workspace with {{1}} and {{2}}.
CREATE OR REPLACE FUNCTION public.desk_digest_template_ok(p_account uuid, p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.message_templates t
                  WHERE t.account_id = p_account AND t.name = p_name
                    AND lower(coalesce(t.status, '')) = 'approved'
                    AND lower(coalesce(t.category, '')) = 'utility'
                    AND t.body_text LIKE '%{{1}}%' AND t.body_text LIKE '%{{2}}%')
$$;

CREATE OR REPLACE FUNCTION public.desk_digest_settings_set(p_actor uuid, p_account uuid, p_enabled boolean,
  p_template_name text, p_language text, p_send_hour integer, p_gap_days integer, p_now timestamptz DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_name text := public.desk_clean(p_template_name);
BEGIN
  IF coalesce(public.case_account_role(p_account, p_actor) IN ('admin', 'super_admin'), false) IS NOT TRUE THEN
    PERFORM public.desk_refuse('desk_digest_settings_set', 'NOT_ALLOWED', 'owners and admins only');
  END IF;
  IF p_enabled IS NULL OR p_send_hour IS NULL OR p_send_hour NOT BETWEEN 8 AND 20
     OR p_gap_days IS NULL OR p_gap_days NOT BETWEEN 1 AND 14
     OR coalesce(p_language, '') !~ '^[a-z]{2}(_[A-Z]{2})?$' THEN
    PERFORM public.desk_refuse('desk_digest_settings_set', 'INVALID', 'send hour 8-20, gap 1-14 days, a language code');
  END IF;
  IF p_enabled AND (v_name IS NULL OR NOT public.desk_digest_template_ok(p_account, v_name)) THEN
    PERFORM public.desk_refuse('desk_digest_settings_set', 'TEMPLATE_INVALID',
      'an approved utility template whose body has {{1}} and {{2}}');
  END IF;
  INSERT INTO public.desk_digest_settings AS s (account_id, enabled, template_name, language, send_hour, gap_days,
                                               updated_by, updated_at)
  VALUES (p_account, p_enabled, v_name, p_language, p_send_hour, p_gap_days, p_actor, coalesce(p_now, now()))
  ON CONFLICT (account_id) DO UPDATE
     SET enabled = excluded.enabled, template_name = excluded.template_name, language = excluded.language,
         send_hour = excluded.send_hour, gap_days = excluded.gap_days, updated_by = excluded.updated_by,
         updated_at = excluded.updated_at;
  IF NOT p_enabled THEN
    UPDATE public.desk_digest_outbox o SET status = 'cancelled', status_reason = 'switched_off'
     WHERE o.account_id = p_account AND o.status = 'queued';
  END IF;
END;
$$;

-- ---------- 3. What is missing, and to whom ----------

-- [{label, banks}] of required documents still missing or rejected on the
-- company's open, unsubmitted desk cases; each document once.
CREATE OR REPLACE FUNCTION public.desk_digest_pending(p_account uuid, p_customer uuid)
RETURNS TABLE (doc_key text, label text, banks text[], pos integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH cs AS (
    SELECT k.id, k.bank_code, k.product FROM public.cases k
     WHERE k.account_id = p_account AND k.desk_customer_id = p_customer
       AND k.closed_at IS NULL AND k.group_id IS NULL
  ), need AS (
    SELECT c.bank_code, c.product, s.doc_key, s."position"
      FROM cs c CROSS JOIN LATERAL public.case_file_spec_rows(c.id) s
     WHERE s.required AND public.desk_case_doc_cell(c.id, s.doc_key)->>'status' IN ('missing', 'failed')
  )
  SELECT n.doc_key,
         coalesce((SELECT q.label FROM public.case_doc_requirements q
                    WHERE q.account_id = p_account AND q.doc_key = n.doc_key LIMIT 1),
                  initcap(replace(n.doc_key, '_', ' '))),
         array_agg(DISTINCT n.bank_code ORDER BY n.bank_code), min(n."position")
    FROM need n GROUP BY n.doc_key
$$;

-- "All banks: A, B. ENBD: C": documents every open bank needs first.
CREATE OR REPLACE FUNCTION public.desk_digest_summary(p_account uuid, p_customer uuid)
RETURNS TABLE (summary text, pending integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH p AS (SELECT * FROM public.desk_digest_pending(p_account, p_customer)),
  banks AS (
    SELECT array_agg(DISTINCT k.bank_code ORDER BY k.bank_code) AS b FROM public.cases k
     WHERE k.account_id = p_account AND k.desk_customer_id = p_customer AND k.closed_at IS NULL AND k.group_id IS NULL
  ), lines AS (
    SELECT 0 AS ord, 'All banks: ' || string_agg(p.label, ', ' ORDER BY p.pos, p.label) AS line
      FROM p, banks WHERE cardinality(banks.b) > 1 AND p.banks = banks.b
    HAVING count(*) > 0
    UNION ALL
    SELECT 1, x.bank || ': ' || string_agg(p.label, ', ' ORDER BY p.pos, p.label)
      FROM p, banks, unnest(p.banks) AS x(bank)
     WHERE NOT (cardinality(banks.b) > 1 AND p.banks = banks.b)
     GROUP BY x.bank
  )
  SELECT left((SELECT string_agg(l.line, '. ' ORDER BY l.ord, l.line) FROM lines l), 900),
         (SELECT count(*)::integer FROM p)
$$;

-- An authorised person of the company, else its oldest open case's
-- contact; their company chat; never someone opted out or do-not-contact.
CREATE OR REPLACE FUNCTION public.desk_digest_recipient(p_account uuid, p_customer uuid)
RETURNS TABLE (contact_id uuid, conversation_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH cand AS (
    SELECT l.contact_id, 0 AS rank, l.created_at AS at FROM public.desk_customer_contacts l
     WHERE l.account_id = p_account AND l.customer_id = p_customer AND l.authorised
    UNION ALL
    SELECT k.contact_id, 1, k.opened_at FROM public.cases k
     WHERE k.account_id = p_account AND k.desk_customer_id = p_customer AND k.closed_at IS NULL
       AND k.contact_id IS NOT NULL
  )
  SELECT c.contact_id, v.id
    FROM cand c
    JOIN public.contacts ct ON ct.id = c.contact_id AND ct.account_id = p_account
     AND ct.opted_out_at IS NULL AND ct.do_not_contact_at IS NULL
    JOIN public.conversations v ON v.contact_id = c.contact_id AND v.account_id = p_account
     AND v.personal_owner_id IS NULL
   ORDER BY c.rank, c.at, c.contact_id
   LIMIT 1
$$;

-- ---------- 4. Enqueue (automations cron) ----------

CREATE OR REPLACE FUNCTION public.desk_digest_enqueue(p_now timestamptz DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now   timestamptz := coalesce(p_now, now());
  v_today date := public.desk_today(p_now);
  v_hour  integer := extract(hour FROM v_now AT TIME ZONE 'Asia/Dubai')::integer;
  s       public.desk_digest_settings%ROWTYPE;
  r       record;
  v_sum   record;
  v_to    record;
  v_n     integer := 0;
  v_id    uuid;
BEGIN
  FOR s IN SELECT * FROM public.desk_digest_settings x WHERE x.enabled AND x.template_name IS NOT NULL LOOP
    CONTINUE WHEN v_hour < s.send_hour OR v_hour >= 21;
    CONTINUE WHEN NOT public.desk_digest_template_ok(s.account_id, s.template_name);
    FOR r IN
      SELECT d.id AS customer_id, a.app_number
        FROM public.desk_customers d
        JOIN public.desk_applications a ON a.customer_id = d.id AND a.status = 'open'
       WHERE d.account_id = s.account_id AND d.merged_into IS NULL
         AND EXISTS (SELECT 1 FROM public.cases k WHERE k.desk_customer_id = d.id
                       AND k.closed_at IS NULL AND k.group_id IS NULL)
         -- Not again within gap_days of the last digest ...
         AND NOT EXISTS (SELECT 1 FROM public.desk_digest_outbox o
                          WHERE o.customer_id = d.id AND o.status <> 'cancelled'
                            AND o.local_day > v_today - s.gap_days)
         -- ... nor of the last document any of its people sent.
         AND NOT EXISTS (SELECT 1 FROM public.customer_documents cd
                          WHERE cd.account_id = s.account_id
                            AND cd.received_at > v_now - make_interval(days => s.gap_days)
                            AND cd.contact_id IN (SELECT l.contact_id FROM public.desk_customer_contacts l
                                                   WHERE l.customer_id = d.id
                                                  UNION
                                                  SELECT k.contact_id FROM public.cases k
                                                   WHERE k.desk_customer_id = d.id))
    LOOP
      SELECT * INTO v_sum FROM public.desk_digest_summary(s.account_id, r.customer_id);
      CONTINUE WHEN coalesce(v_sum.pending, 0) = 0 OR v_sum.summary IS NULL;
      SELECT * INTO v_to FROM public.desk_digest_recipient(s.account_id, r.customer_id);
      CONTINUE WHEN v_to.contact_id IS NULL;
      v_id := NULL;
      INSERT INTO public.desk_digest_outbox AS o (account_id, customer_id, contact_id, conversation_id, local_day,
                                                  app_number, summary, pending, created_at)
      VALUES (s.account_id, r.customer_id, v_to.contact_id, v_to.conversation_id, v_today, r.app_number,
              v_sum.summary, v_sum.pending, v_now)
      ON CONFLICT (customer_id, local_day) DO NOTHING
      RETURNING o.id INTO v_id;
      IF v_id IS NOT NULL THEN
        v_n := v_n + 1;
      END IF;
    END LOOP;
  END LOOP;
  RETURN v_n;
END;
$$;

-- ---------- 5. Claim, guarded again; mark ----------

CREATE OR REPLACE FUNCTION public.desk_digest_claim(p_now timestamptz DEFAULT NULL, p_limit integer DEFAULT 50)
RETURNS TABLE (id uuid, account_id uuid, contact_id uuid, conversation_id uuid, app_number text, summary text,
               template_name text, language text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_now   timestamptz := coalesce(p_now, now());
  v_today date := public.desk_today(p_now);
  v_hour  integer := extract(hour FROM v_now AT TIME ZONE 'Asia/Dubai')::integer;
  o       public.desk_digest_outbox%ROWTYPE;
  s       public.desk_digest_settings%ROWTYPE;
  ct      public.contacts%ROWTYPE;
  v_sent  integer;
BEGIN
  -- A claim with no result for 10 minutes may have reached the gateway:
  -- never resent.
  UPDATE public.desk_digest_outbox x SET status = 'unconfirmed'
   WHERE x.status = 'sending' AND x.claimed_at < v_now - interval '10 minutes';

  IF v_hour < 8 OR v_hour >= 21 THEN
    RETURN;  -- quiet hours: nothing leaves, the rows wait
  END IF;

  FOR o IN SELECT * FROM public.desk_digest_outbox x WHERE x.status = 'queued' AND x.local_day <= v_today
            ORDER BY x.created_at LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
            FOR UPDATE SKIP LOCKED LOOP
    SELECT * INTO s FROM public.desk_digest_settings x WHERE x.account_id = o.account_id;
    IF NOT coalesce(s.enabled, false) OR s.template_name IS NULL
       OR NOT public.desk_digest_template_ok(o.account_id, s.template_name) THEN
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
    -- The daily cap: 3 automated messages per person per Dubai day,
    -- HR automated messages and these digests together.
    SELECT (SELECT count(*) FROM public.hr_automsg_outbox h
             WHERE h.contact_id = o.contact_id AND h.status = 'sent'
               AND (h.sent_at AT TIME ZONE 'Asia/Dubai')::date = v_today)
         + (SELECT count(*) FROM public.desk_digest_outbox d
             WHERE d.contact_id = o.contact_id AND d.local_day = v_today
               AND d.status IN ('sent', 'sending', 'unconfirmed'))
      INTO v_sent;
    IF v_sent >= 3 THEN
      UPDATE public.desk_digest_outbox x SET status = 'cancelled', status_reason = 'daily_cap' WHERE x.id = o.id;
      CONTINUE;
    END IF;
    UPDATE public.desk_digest_outbox x
       SET status = 'sending', attempts = x.attempts + 1, claimed_at = v_now
     WHERE x.id = o.id;
    RETURN QUERY SELECT o.id, o.account_id, o.contact_id, o.conversation_id, o.app_number, o.summary,
                        s.template_name, s.language;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.desk_digest_mark(p_id uuid, p_outcome text, p_provider_message_id text,
  p_message_id uuid, p_reason text, p_now timestamptz DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_outcome NOT IN ('sent', 'failed') THEN
    RAISE EXCEPTION 'desk_digest_mark: outcome is sent or failed' USING ERRCODE = 'check_violation', HINT = 'INVALID';
  END IF;
  UPDATE public.desk_digest_outbox x
     SET status = p_outcome,
         sent_at = CASE WHEN p_outcome = 'sent' THEN coalesce(p_now, now()) END,
         provider_message_id = p_provider_message_id, message_id = p_message_id,
         status_reason = left(public.desk_clean(p_reason), 200)
   WHERE x.id = p_id AND x.status = 'sending';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$$;

-- ---------- 6. STOP ----------

-- The caller (the inbound pipeline) has already seen a STOP word. Opts
-- the person out only when a digest reached them in the last 30 days.
CREATE OR REPLACE FUNCTION public.desk_digest_stop(p_account uuid, p_contact uuid, p_now timestamptz DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.desk_digest_outbox o
                  WHERE o.account_id = p_account AND o.contact_id = p_contact
                    AND o.status IN ('sent', 'unconfirmed')
                    AND o.created_at > coalesce(p_now, now()) - interval '30 days') THEN
    RETURN false;
  END IF;
  UPDATE public.desk_digest_outbox o SET status = 'cancelled', status_reason = 'opted_out'
   WHERE o.contact_id = p_contact AND o.status = 'queued';
  UPDATE public.contacts c SET opted_out_at = coalesce(p_now, now())
   WHERE c.id = p_contact AND c.account_id = p_account AND c.opted_out_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$$;

-- ---------- 7. Privacy ----------

CREATE OR REPLACE FUNCTION public.privacy_desk_digest_export(p_account uuid, p_contact uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'day', o.local_day, 'application', o.app_number, 'summary', o.summary,
           'status', o.status, 'sent_at', o.sent_at) ORDER BY o.local_day), '[]'::jsonb)
    FROM public.desk_digest_outbox o
   WHERE o.account_id = p_account AND o.contact_id = p_contact
$$;

CREATE OR REPLACE FUNCTION public.privacy_desk_digest_erase(p_account uuid, p_contact uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  DELETE FROM public.desk_digest_outbox o WHERE o.account_id = p_account AND o.contact_id = p_contact;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('counts', jsonb_build_object('desk_digest_outbox', v_n), 'objects', '[]'::jsonb);
END;
$$;

INSERT INTO public.privacy_extensions (name, export_fn, erase_fn, added_in)
VALUES ('desk_reminders', 'privacy_desk_digest_export', 'privacy_desk_digest_erase', '234')
ON CONFLICT (name) DO UPDATE SET export_fn = excluded.export_fn, erase_fn = excluded.erase_fn;

-- ---------- 8. Privileges ----------

REVOKE ALL ON FUNCTION
  public.desk_digest_settings_get(uuid, uuid), public.desk_digest_template_ok(uuid, text),
  public.desk_digest_settings_set(uuid, uuid, boolean, text, text, integer, integer, timestamptz),
  public.desk_digest_pending(uuid, uuid), public.desk_digest_summary(uuid, uuid),
  public.desk_digest_recipient(uuid, uuid), public.desk_digest_enqueue(timestamptz),
  public.desk_digest_claim(timestamptz, integer),
  public.desk_digest_mark(uuid, text, text, uuid, text, timestamptz),
  public.desk_digest_stop(uuid, uuid, timestamptz),
  public.privacy_desk_digest_export(uuid, uuid), public.privacy_desk_digest_erase(uuid, uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.desk_digest_settings_get(uuid, uuid),
  public.desk_digest_settings_set(uuid, uuid, boolean, text, text, integer, integer, timestamptz),
  public.desk_digest_enqueue(timestamptz), public.desk_digest_claim(timestamptz, integer),
  public.desk_digest_mark(uuid, text, text, uuid, text, timestamptz),
  public.desk_digest_stop(uuid, uuid, timestamptz)
TO service_role;
