-- ============================================================
-- 336_call_service_details.sql — after an agent handles a customer's
-- call (Yeastar, src/lib/pbx/process.ts), the customer gets one approved
-- utility WhatsApp template naming the service. The rules and their
-- order live in src/lib/pbx/service-details.ts; the database keeps the
-- settings, the service map, and a ledger of one outcome per call.
--
--  1. pbx_service_details_settings: per workspace, off by default; the
--     template, the minimum talk time (20 s), inbound on, outbound off.
--     Set by an owner or admin of the ACTIVE workspace
--     (pbx_service_details_settings_set).
--  2. pbx_service_map: queue / DID / extension -> the service's label.
--     Owner/admin upsert and delete.
--  3. pbx_service_details_log: one row per call (calls.id, unique per
--     account) with its outcome, recorded even while switched off.
--  4. pbx_service_details_claim: records an outcome. A later leg of the
--     call may overwrite a non-send outcome; a 'sending', 'sent' or
--     'send_failed' row is final ('duplicate'). 'sending' takes 327's
--     per-person advisory lock, refuses an opted-out or do-not-contact
--     person ('opted_out', recorded), and takes the shared daily cap
--     slot in the same statement, or records and answers 'daily_cap'.
--     pbx_service_details_settle turns 'sending' into 'sent' or
--     'send_failed'.
--  5. automated_sends_today (RESTATES 327) also counts this ledger's
--     'sending' / 'sent' rows, so HR, desk digests, CSAT and these
--     messages share one cap of 3 a person a day.
--
-- RESTATES 327's automated_sends_today: apply in order, once. Re-applying
-- 327 after this file drops these messages from the shared cap; re-apply
-- this file after it. Apply as a superuser or a BYPASSRLS role (the
-- claim reads RLS-forced tables). Re-runnable otherwise. Asserted by
-- supabase/ci/verify-call-service-details.sql.
--
-- PRIVILEGES: the claim and settle are SECURITY DEFINER, search_path '',
-- service_role only. The setters check is_account_member(.., 'admin')
-- and are granted to authenticated. The tables are read by owners and
-- admins under RLS.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '336 must be applied by a superuser or BYPASSRLS role (the claim reads RLS-forced tables)';
  END IF;
  IF to_regprocedure('public.automated_sends_today(uuid,uuid,timestamptz,text)') IS NULL THEN
    RAISE EXCEPTION '336: apply 327_shared_daily_cap.sql first';
  END IF;
  IF to_regclass('public.calls') IS NULL THEN
    RAISE EXCEPTION '336: apply 089_pbx.sql first';
  END IF;
END $$;

-- ---------- 1. Settings ----------

CREATE TABLE IF NOT EXISTS public.pbx_service_details_settings (
  account_id    uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  enabled       boolean NOT NULL DEFAULT false,
  template_name text NULL,
  language      text NULL,
  min_seconds   integer NOT NULL DEFAULT 20,
  inbound       boolean NOT NULL DEFAULT true,
  outbound      boolean NOT NULL DEFAULT false,
  updated_by    uuid NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pbx_service_details_settings_template_check
    CHECK (template_name IS NULL OR template_name ~ '^[a-z0-9_]{1,100}$'),
  CONSTRAINT pbx_service_details_settings_language_check
    CHECK (language IS NULL OR language ~ '^[a-z]{2}(_[A-Z]{2})?$'),
  CONSTRAINT pbx_service_details_settings_min_check CHECK (min_seconds BETWEEN 0 AND 3600)
);
ALTER TABLE public.pbx_service_details_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pbx_service_details_settings FORCE ROW LEVEL SECURITY;
COMMENT ON TABLE public.pbx_service_details_settings IS
  'Call service details per workspace: off by default; template, minimum talk seconds, inbound/outbound. Migration 336.';

-- ---------- 2. Service map ----------

CREATE TABLE IF NOT EXISTS public.pbx_service_map (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  match_type  text NOT NULL,
  match_value text NOT NULL,
  label       text NOT NULL,
  updated_by  uuid NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pbx_service_map_type_check CHECK (match_type IN ('queue', 'did', 'extension')),
  CONSTRAINT pbx_service_map_value_check CHECK (match_value = btrim(match_value) AND char_length(match_value) BETWEEN 1 AND 64),
  CONSTRAINT pbx_service_map_label_check CHECK (btrim(label) <> '' AND char_length(label) <= 60),
  CONSTRAINT pbx_service_map_key UNIQUE (account_id, match_type, match_value)
);
ALTER TABLE public.pbx_service_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pbx_service_map FORCE ROW LEVEL SECURITY;
COMMENT ON TABLE public.pbx_service_map IS
  'Call service details: queue / DID / extension to the service label named in the message. Migration 336.';

-- ---------- 3. Ledger ----------

CREATE TABLE IF NOT EXISTS public.pbx_service_details_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL,
  call_id     uuid NOT NULL,
  contact_id  uuid NULL,
  outcome     text NOT NULL,
  claimed_at  timestamptz NULL,
  sent_at     timestamptz NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pbx_service_details_log_call_fkey FOREIGN KEY (call_id, account_id)
    REFERENCES public.calls (id, account_id) ON DELETE CASCADE,
  CONSTRAINT pbx_service_details_log_contact_fkey FOREIGN KEY (contact_id, account_id)
    REFERENCES public.contacts (id, account_id) ON DELETE SET NULL (contact_id),
  CONSTRAINT pbx_service_details_log_call_key UNIQUE (account_id, call_id),
  CONSTRAINT pbx_service_details_log_outcome_check CHECK (outcome IN (
    'switched_off', 'not_answered', 'no_agent', 'too_short', 'direction_off', 'bad_number',
    'no_contact', 'ambiguous_contact', 'opted_out', 'no_template', 'daily_cap',
    'sending', 'sent', 'send_failed'))
);
CREATE INDEX IF NOT EXISTS pbx_service_details_log_contact_idx
  ON public.pbx_service_details_log (account_id, contact_id, claimed_at)
  WHERE outcome IN ('sending', 'sent');
ALTER TABLE public.pbx_service_details_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pbx_service_details_log FORCE ROW LEVEL SECURITY;
COMMENT ON TABLE public.pbx_service_details_log IS
  'Call service details: one outcome per call; sending/sent/send_failed are final. Migration 336.';

-- Owners and admins read; nobody writes directly.
REVOKE ALL ON public.pbx_service_details_settings, public.pbx_service_map, public.pbx_service_details_log
FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.pbx_service_details_settings, public.pbx_service_map, public.pbx_service_details_log
TO authenticated, service_role;

DROP POLICY IF EXISTS pbx_service_details_settings_select ON public.pbx_service_details_settings;
CREATE POLICY pbx_service_details_settings_select ON public.pbx_service_details_settings
  FOR SELECT TO authenticated USING (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS pbx_service_map_select ON public.pbx_service_map;
CREATE POLICY pbx_service_map_select ON public.pbx_service_map
  FOR SELECT TO authenticated USING (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS pbx_service_details_log_select ON public.pbx_service_details_log;
CREATE POLICY pbx_service_details_log_select ON public.pbx_service_details_log
  FOR SELECT TO authenticated USING (public.is_account_member(account_id, 'admin'));

-- ---------- 4. Owner/admin setters ----------

CREATE OR REPLACE FUNCTION public.pbx_service_details_settings_set(p_account uuid, p_enabled boolean,
  p_template_name text, p_language text, p_min_seconds integer, p_inbound boolean, p_outbound boolean)
RETURNS timestamptz
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tpl text := nullif(lower(btrim(coalesce(p_template_name, ''))), '');
  v_now timestamptz := clock_timestamp();
BEGIN
  IF NOT public.is_account_member(p_account, 'admin') THEN
    RAISE EXCEPTION 'pbx_service_details_settings_set: owners and admins only'
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  IF p_enabled IS NULL OR p_inbound IS NULL OR p_outbound IS NULL
     OR p_min_seconds IS NULL OR p_min_seconds NOT BETWEEN 0 AND 3600
     OR (v_tpl IS NOT NULL AND v_tpl !~ '^[a-z0-9_]{1,100}$')
     OR (p_language IS NOT NULL AND p_language !~ '^[a-z]{2}(_[A-Z]{2})?$')
     OR (p_enabled AND v_tpl IS NULL) THEN
    RAISE EXCEPTION 'pbx_service_details_settings_set: template name a-z 0-9 _ (required when on), a language code, 0-3600 seconds'
      USING ERRCODE = 'check_violation', HINT = 'INVALID';
  END IF;
  INSERT INTO public.pbx_service_details_settings AS s
    (account_id, enabled, template_name, language, min_seconds, inbound, outbound, updated_by, updated_at)
  VALUES (p_account, p_enabled, v_tpl, p_language, p_min_seconds, p_inbound, p_outbound, auth.uid(), v_now)
  ON CONFLICT (account_id) DO UPDATE
     SET enabled = excluded.enabled, template_name = excluded.template_name, language = excluded.language,
         min_seconds = excluded.min_seconds, inbound = excluded.inbound, outbound = excluded.outbound,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  RETURN v_now;
END;
$$;

CREATE OR REPLACE FUNCTION public.pbx_service_map_upsert(p_account uuid, p_match_type text, p_match_value text,
  p_label text)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_value text := btrim(coalesce(p_match_value, ''));
  v_label text := btrim(regexp_replace(coalesce(p_label, ''), '\s+', ' ', 'g'));
  v_id    uuid;
BEGIN
  IF NOT public.is_account_member(p_account, 'admin') THEN
    RAISE EXCEPTION 'pbx_service_map_upsert: owners and admins only'
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  IF coalesce(p_match_type, '') NOT IN ('queue', 'did', 'extension')
     OR char_length(v_value) NOT BETWEEN 1 AND 64
     OR char_length(v_label) NOT BETWEEN 1 AND 60 THEN
    RAISE EXCEPTION 'pbx_service_map_upsert: queue, did or extension; a value; a label of 1-60 characters'
      USING ERRCODE = 'check_violation', HINT = 'INVALID';
  END IF;
  INSERT INTO public.pbx_service_map AS m (account_id, match_type, match_value, label, updated_by, updated_at)
  VALUES (p_account, p_match_type, v_value, v_label, auth.uid(), clock_timestamp())
  ON CONFLICT (account_id, match_type, match_value) DO UPDATE
     SET label = excluded.label, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  RETURNING m.id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.pbx_service_map_delete(p_account uuid, p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_account_member(p_account, 'admin') THEN
    RAISE EXCEPTION 'pbx_service_map_delete: owners and admins only'
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  DELETE FROM public.pbx_service_map m WHERE m.account_id = p_account AND m.id = p_id;
  RETURN FOUND;
END;
$$;

-- ---------- 5. Claim and settle ----------

-- 'claimed', 'duplicate' (the call's outcome is final), 'daily_cap'
-- (recorded) or 'opted_out' (recorded; the app reads it as not claimed).
CREATE OR REPLACE FUNCTION public.pbx_service_details_claim(p_account uuid, p_call uuid, p_outcome text,
  p_contact uuid, p_now timestamptz DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now  timestamptz := coalesce(p_now, now());
  v_cur  text;
  v_out  text := p_outcome;
  v_ret  text;
  ct     public.contacts%ROWTYPE;
BEGIN
  IF p_account IS NULL OR p_call IS NULL OR coalesce(p_outcome, '') NOT IN (
       'switched_off', 'not_answered', 'no_agent', 'too_short', 'direction_off', 'bad_number',
       'no_contact', 'ambiguous_contact', 'opted_out', 'no_template', 'daily_cap', 'sending')
     OR (p_outcome = 'sending' AND p_contact IS NULL) THEN
    RAISE EXCEPTION 'pbx_service_details_claim: a call, an outcome (sending needs a contact)'
      USING ERRCODE = 'check_violation', HINT = 'INVALID';
  END IF;

  IF p_outcome = 'sending' THEN
    -- 327's per-person lock: an HR, desk or CSAT claim cannot pass the
    -- same count meanwhile, nor can another leg of this call.
    PERFORM pg_advisory_xact_lock(hashtextextended(p_account::text || ':' || p_contact::text, 0));
    SELECT * INTO ct FROM public.contacts x WHERE x.id = p_contact AND x.account_id = p_account;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'pbx_service_details_claim: no such contact in this workspace'
        USING ERRCODE = 'foreign_key_violation', HINT = 'INVALID';
    END IF;
    IF ct.opted_out_at IS NOT NULL OR ct.do_not_contact_at IS NOT NULL THEN
      v_out := 'opted_out';
    ELSIF public.automated_sends_today(p_account, p_contact, v_now, 'Asia/Dubai') >= 3 THEN
      v_out := 'daily_cap';
    END IF;
  END IF;

  SELECT l.outcome INTO v_cur FROM public.pbx_service_details_log l
   WHERE l.account_id = p_account AND l.call_id = p_call FOR UPDATE;
  IF v_cur IN ('sending', 'sent', 'send_failed') THEN
    RETURN 'duplicate';
  END IF;

  INSERT INTO public.pbx_service_details_log AS l (account_id, call_id, contact_id, outcome, claimed_at, updated_at)
  VALUES (p_account, p_call, p_contact, v_out, CASE WHEN v_out = 'sending' THEN v_now END, v_now)
  ON CONFLICT (account_id, call_id) DO UPDATE
     SET outcome = excluded.outcome, contact_id = excluded.contact_id,
         claimed_at = excluded.claimed_at, updated_at = excluded.updated_at
   WHERE l.outcome NOT IN ('sending', 'sent', 'send_failed')
  RETURNING l.outcome INTO v_ret;
  IF v_ret IS NULL THEN
    RETURN 'duplicate';  -- another leg's 'sending' landed first
  END IF;
  RETURN CASE WHEN p_outcome = 'sending' AND v_out <> 'sending' THEN v_out ELSE 'claimed' END;
END;
$$;

CREATE OR REPLACE FUNCTION public.pbx_service_details_settle(p_account uuid, p_call uuid, p_outcome text,
  p_now timestamptz DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF coalesce(p_outcome, '') NOT IN ('sent', 'send_failed') THEN
    RAISE EXCEPTION 'pbx_service_details_settle: sent or send_failed'
      USING ERRCODE = 'check_violation', HINT = 'INVALID';
  END IF;
  UPDATE public.pbx_service_details_log l
     SET outcome = p_outcome,
         sent_at = CASE WHEN p_outcome = 'sent' THEN coalesce(p_now, now()) END,
         updated_at = coalesce(p_now, now())
   WHERE l.account_id = p_account AND l.call_id = p_call AND l.outcome = 'sending';
  RETURN FOUND;
END;
$$;

-- ---------- 6. The one count (RESTATES 327) ----------

-- 327's body unchanged, plus this ledger's 'sending' / 'sent' rows.
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
  + (SELECT count(*) FROM public.pbx_service_details_log s
      WHERE s.account_id = p_account AND s.contact_id = p_contact
        AND s.outcome IN ('sending', 'sent')
        AND (coalesce(s.sent_at, s.claimed_at) AT TIME ZONE p_tz)::date = (p_now AT TIME ZONE p_tz)::date)
  )::integer
$$;

COMMENT ON FUNCTION public.automated_sends_today(uuid, uuid, timestamptz, text) IS
  'Automated messages (HR, desk digests, CSAT requests, call service details) sent or in flight to a contact on p_now''s day in p_tz: the shared daily cap. Migrations 327, 336.';

-- ---------- 7. Privileges ----------

REVOKE ALL ON FUNCTION
  public.automated_sends_today(uuid, uuid, timestamptz, text),
  public.pbx_service_details_settings_set(uuid, boolean, text, text, integer, boolean, boolean),
  public.pbx_service_map_upsert(uuid, text, text, text),
  public.pbx_service_map_delete(uuid, uuid),
  public.pbx_service_details_claim(uuid, uuid, text, uuid, timestamptz),
  public.pbx_service_details_settle(uuid, uuid, text, timestamptz)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.pbx_service_details_settings_set(uuid, boolean, text, text, integer, boolean, boolean),
  public.pbx_service_map_upsert(uuid, text, text, text),
  public.pbx_service_map_delete(uuid, uuid)
TO authenticated;
GRANT EXECUTE ON FUNCTION
  public.pbx_service_details_claim(uuid, uuid, text, uuid, timestamptz),
  public.pbx_service_details_settle(uuid, uuid, text, timestamptz)
TO service_role;

RESET lock_timeout;
