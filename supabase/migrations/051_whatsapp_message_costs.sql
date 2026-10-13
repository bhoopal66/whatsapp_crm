-- 051_whatsapp_message_costs
--
-- Per-message cost ledger for the Meta Cloud API number, fed by the
-- `pricing` object Meta attaches to every delivery-status webhook.
--
-- ─── Why a ledger and not an invoice import ────────────────────────
--
-- Meta bills per delivered message (the per-message model that
-- replaced conversation-based pricing on 2025-07-01), at a rate that
-- depends on the RECIPIENT's market and the message category. The
-- invoice arrives a month later as one number. Recording the cost as
-- each delivery receipt lands is what lets an admin see, mid-month,
-- what a campaign cost and how much of the free service allowance is
-- left — and reconcile the invoice against something.
--
-- The 2026-10-01 rate card changes the rules in ways this file
-- encodes, so they are spelled out:
--
--   * service (free-form) messages, free until then, become billable
--     at the market's utility rate after the first 1,000 delivered
--     per business number per calendar month;
--   * utility messages inside the 24-hour window become billable;
--   * new marketing rates for the UAE / GCC.
--
-- ─── Design ────────────────────────────────────────────────────────
--
--   * The logic lives in ONE Postgres function,
--     `record_whatsapp_message_cost`, called once per `statuses[]`
--     entry with the raw object. The service quota is a count over
--     this table, so it belongs next to the table rather than in a
--     read-modify-write from the app.
--   * Meta's own `pricing.billable` flag, when present, is
--     authoritative. The date/quota rules below are the fallback for
--     payloads that do not carry it — Meta has been inconsistent about
--     it across API versions.
--   * An unknown rate resolves to `cost_usd IS NULL`, never 0. The
--     seeded rate card covers the GCC corridors this template's
--     authors actually message; every other market stays visible as
--     "unknown rate" until the official CSV is loaded with
--     `scripts/load-meta-rate-card.ts`. A faked zero would silently
--     under-report spend, which is the one thing a cost ledger must
--     not do.
--   * Idempotent on (phone_number_id, message_id, status): Meta
--     redelivers on any non-200, and the webhook already tolerates
--     replay everywhere else.
--   * Fail-open by contract at the call site (`lib/whatsapp/message-costs.ts`):
--     a costing error is logged and swallowed, never allowed to fail
--     the webhook — a failed webhook makes Meta redeliver and re-run
--     the entire inbound fan-out.
--   * Whapi is deliberately not costed. A Whapi channel is a flat
--     subscription to the gateway, with no per-message Meta billing
--     and no `pricing` object in its callbacks.
--
-- ─── Tenancy ───────────────────────────────────────────────────────
--
-- The rate card and market map are global reference data (Meta
-- publishes one card). The ledger is account-scoped like everything
-- else, with the same admin+ SELECT policy `ai_usage_log` uses —
-- spend is billing-class. Writes come only from the service role
-- (the webhook), so there are no INSERT/UPDATE/DELETE policies.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. Rate card — one row per (market, category, effective_from),
--    USD per delivered message as published by Meta.
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_rate_card (
  market          TEXT NOT NULL,
  category        TEXT NOT NULL CHECK (category IN (
                    'marketing', 'marketing_lite', 'utility', 'authentication',
                    'authentication_international', 'service', 'referral_conversion'
                  )),
  rate_usd        NUMERIC(10, 6) NOT NULL,
  effective_from  DATE NOT NULL,
  source          TEXT NOT NULL DEFAULT 'manual',
  loaded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (market, category, effective_from)
);

COMMENT ON TABLE whatsapp_rate_card IS
  'Meta WhatsApp per-message rate card (USD per delivered message). Seeded with a verified GCC subset; load the full official CSV with scripts/load-meta-rate-card.ts.';

-- Seed: the 2025-07-01 per-message card — verified subset only.
INSERT INTO whatsapp_rate_card (market, category, rate_usd, effective_from, source) VALUES
  ('AE',       'marketing',      0.0499, '2025-07-01', 'seed-2026-09-11'),
  ('AE',       'utility',        0.0157, '2025-07-01', 'seed-2026-09-11'),
  ('AE',       'authentication', 0.0157, '2025-07-01', 'seed-2026-09-11'),
  ('AE',       'service',        0.0000, '2025-07-01', 'seed-2026-09-11'),
  ('SA',       'marketing',      0.0501, '2025-07-01', 'seed-2026-09-11'),
  ('KW',       'marketing',      0.0341, '2025-07-01', 'seed-2026-09-11'),
  ('KW',       'utility',        0.0091, '2025-07-01', 'seed-2026-09-11'),
  ('KW',       'authentication', 0.0091, '2025-07-01', 'seed-2026-09-11'),
  ('OM',       'utility',        0.0091, '2025-07-01', 'seed-2026-09-11'),
  ('OM',       'authentication', 0.0091, '2025-07-01', 'seed-2026-09-11'),
  ('OTHER_ME', 'marketing',      0.0341, '2025-07-01', 'seed-2026-09-11'),
  ('PK',       'utility',        0.0100, '2025-07-01', 'seed-2026-09-11'),
  ('PK',       'authentication', 0.0100, '2025-07-01', 'seed-2026-09-11')
ON CONFLICT DO NOTHING;

-- Seed: the 2026-10-01 card — verified subset. Service is billed at
-- the market's utility rate; the resolver falls back service → utility
-- so markets without an explicit service row still cost correctly.
INSERT INTO whatsapp_rate_card (market, category, rate_usd, effective_from, source) VALUES
  ('AE',       'marketing',                    0.0576, '2026-10-01', 'seed-2026-09-11'),
  ('AE',       'utility',                      0.0157, '2026-10-01', 'seed-2026-09-11'),
  ('AE',       'authentication',               0.0157, '2026-10-01', 'seed-2026-09-11'),
  ('AE',       'service',                      0.0157, '2026-10-01', 'seed-2026-09-11'),
  ('SA',       'marketing',                    0.0576, '2026-10-01', 'seed-2026-09-11'),
  ('KW',       'marketing',                    0.0792, '2026-10-01', 'seed-2026-09-11'),
  ('KW',       'utility',                      0.0440, '2026-10-01', 'seed-2026-09-11'),
  ('KW',       'authentication',               0.0440, '2026-10-01', 'seed-2026-09-11'),
  ('KW',       'authentication_international', 0.1200, '2026-10-01', 'seed-2026-09-11'),
  ('OM',       'utility',                      0.0247, '2026-10-01', 'seed-2026-09-11'),
  ('OM',       'authentication',               0.0247, '2026-10-01', 'seed-2026-09-11'),
  ('OM',       'authentication_international', 0.0600, '2026-10-01', 'seed-2026-09-11'),
  ('OTHER_ME', 'marketing',                    0.0392, '2026-10-01', 'seed-2026-09-11'),
  ('PK',       'utility',                      0.0150, '2026-10-01', 'seed-2026-09-11'),
  ('PK',       'authentication',               0.0150, '2026-10-01', 'seed-2026-09-11')
ON CONFLICT DO NOTHING;
-- SA/IN/EG utility, marketing_lite, and every market not listed are
-- NOT seeded on purpose — they resolve to NULL until the official CSV
-- is loaded.

-- ============================================================
-- 2. Recipient market by phone prefix (longest-prefix match).
--    Anything unmapped resolves to 'UNKNOWN', and so to a NULL cost.
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_market_prefix (
  prefix  TEXT PRIMARY KEY,   -- digits only, no '+'
  market  TEXT NOT NULL
);

INSERT INTO whatsapp_market_prefix (prefix, market) VALUES
  ('971', 'AE'), ('966', 'SA'), ('965', 'KW'), ('968', 'OM'),
  ('973', 'OTHER_ME'),  -- Bahrain
  ('974', 'OTHER_ME'),  -- Qatar (confirm standalone status on the official CSV)
  ('962', 'OTHER_ME'),  -- Jordan
  ('961', 'OTHER_ME'),  -- Lebanon
  ('91', 'IN'), ('92', 'PK'), ('20', 'EG'), ('212', 'MA'),
  ('44', 'GB'), ('1', 'NA_US_CA')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION whatsapp_resolve_market(p_wa_id TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT market
       FROM whatsapp_market_prefix
      WHERE regexp_replace(COALESCE(p_wa_id, ''), '\D', '', 'g') LIKE prefix || '%'
      ORDER BY length(prefix) DESC
      LIMIT 1),
    'UNKNOWN');
$$;

-- ============================================================
-- 3. The ledger.
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_message_costs (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  phone_number_id   TEXT NOT NULL,             -- the Meta number that sent it
  message_id        TEXT NOT NULL,             -- wamid
  status            TEXT NOT NULL,             -- sent|delivered|read|failed|…
  recipient_wa_id   TEXT NOT NULL,
  recipient_market  TEXT NOT NULL,
  category          TEXT,                      -- Meta pricing category
  pricing_model     TEXT,                      -- 'PMP' expected
  meta_billable     BOOLEAN,                   -- Meta's flag, when sent
  quota_free        BOOLEAN NOT NULL DEFAULT FALSE,
  billable          BOOLEAN NOT NULL,          -- final verdict
  rate_usd          NUMERIC(10, 6),            -- NULL = unknown rate
  cost_usd          NUMERIC(12, 6),            -- NULL = unknown, never faked to 0
  raw_status        JSONB NOT NULL,
  delivered_at      TIMESTAMPTZ,
  -- First day of the billing month the delivery falls in, computed in
  -- the WABA's timezone when the row is written. The month boundary
  -- lives here, once, so the quota count and the reporting views need
  -- no timezone arithmetic of their own.
  billing_month     DATE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Webhook redelivery safe. Scoped by number: `messages.message_id`
  -- is documented as non-unique across numbers (migration 009).
  UNIQUE (phone_number_id, message_id, status)
);

-- The quota count and the per-number monthly view.
CREATE INDEX IF NOT EXISTS idx_whatsapp_message_costs_quota
  ON whatsapp_message_costs (phone_number_id, category, billing_month)
  WHERE status = 'delivered';

-- Account-scoped monthly reporting.
CREATE INDEX IF NOT EXISTS idx_whatsapp_message_costs_account_month
  ON whatsapp_message_costs (account_id, billing_month);

ALTER TABLE whatsapp_message_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_rate_card ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_market_prefix ENABLE ROW LEVEL SECURITY;

-- SELECT: admin+ only — spend is billing-class, like ai_usage_log.
DROP POLICY IF EXISTS whatsapp_message_costs_select ON whatsapp_message_costs;
CREATE POLICY whatsapp_message_costs_select ON whatsapp_message_costs FOR SELECT
  USING (is_account_member(account_id, 'admin'));

-- Reference data is readable by any signed-in member (nothing tenant
-- specific in it); written only by the service role via the loader.
DROP POLICY IF EXISTS whatsapp_rate_card_select ON whatsapp_rate_card;
CREATE POLICY whatsapp_rate_card_select ON whatsapp_rate_card FOR SELECT
  TO authenticated USING (TRUE);

DROP POLICY IF EXISTS whatsapp_market_prefix_select ON whatsapp_market_prefix;
CREATE POLICY whatsapp_market_prefix_select ON whatsapp_market_prefix FOR SELECT
  TO authenticated USING (TRUE);

-- ============================================================
-- 4. Rate resolution. Date-aware (latest effective_from on or before
--    the delivery date). service → utility fallback, per Meta's
--    "service billed at the utility rate". Unknown → NULL.
-- ============================================================

CREATE OR REPLACE FUNCTION whatsapp_resolve_rate(
  p_market   TEXT,
  p_category TEXT,
  p_on       DATE
) RETURNS NUMERIC
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH direct AS (
    SELECT rate_usd FROM whatsapp_rate_card
     WHERE market = p_market AND category = p_category
       AND effective_from <= p_on
     ORDER BY effective_from DESC LIMIT 1
  ),
  fallback AS (
    SELECT rate_usd FROM whatsapp_rate_card
     WHERE market = p_market AND category = 'utility'
       AND p_category = 'service'
       AND effective_from <= p_on
     ORDER BY effective_from DESC LIMIT 1
  )
  SELECT COALESCE((SELECT rate_usd FROM direct),
                  (SELECT rate_usd FROM fallback));
$$;

-- ============================================================
-- 5. Entry point. One call per raw `statuses[i]` object from the Meta
--    webhook, plus the account and the `metadata.phone_number_id`.
--    Returns the ledger row as `{"ok": true, "data": {...}}`, a
--    duplicate marker on replay, or `{"ok": false, "error": {...}}`
--    on a malformed status — never raises for bad input.
--
--    Rules encoded:
--      * Only status='delivered' is costed (Meta charges on delivery).
--        Other statuses are recorded with billable=false, cost 0, so
--        a `failed` receipt is visible next to the send it belongs to.
--      * Category: pricing.category, else conversation.origin.type
--        (the pre-PMP shape), else the category already recorded for
--        an earlier receipt of the SAME message — Meta puts `pricing`
--        on the `sent` receipt and does not always repeat it on
--        `delivered`, and defaulting that to 'service' would zero-rate
--        a template send invisibly. Only then 'service', for a message
--        that really is free-form.
--      * Service quota: from 2026-10-01 the first 1,000 delivered
--        service messages per phone_number_id per billing month are
--        free. Before that date service is free outright.
--      * pricing.billable=false from Meta always wins (the 72-hour
--        click-to-WhatsApp free entry point, free_customer_service…).
--
--    `p_timezone` decides which calendar month a delivery belongs to
--    for the quota — the WABA's timezone. Defaults to the Gulf; the
--    caller passes WHATSAPP_BILLING_TIMEZONE when set.
-- ============================================================

CREATE OR REPLACE FUNCTION record_whatsapp_message_cost(
  p_account_id      UUID,
  p_phone_number_id TEXT,
  p_status          JSONB,
  p_timezone        TEXT DEFAULT 'Asia/Dubai'
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_msgid      TEXT := p_status->>'id';
  v_state      TEXT := lower(COALESCE(p_status->>'status', ''));
  v_waid       TEXT := COALESCE(p_status->>'recipient_id', '');
  v_market     TEXT;
  v_cat        TEXT;
  v_pmodel     TEXT := p_status->'pricing'->>'pricing_model';
  v_metabill   BOOLEAN;
  v_ts         TIMESTAMPTZ;
  v_on         DATE;
  v_month      DATE;
  v_svc_count  BIGINT;
  v_quota_free BOOLEAN := FALSE;
  v_billable   BOOLEAN;
  v_rate       NUMERIC;
  v_cost       NUMERIC;
  v_row        whatsapp_message_costs;
BEGIN
  IF v_msgid IS NULL OR v_msgid = '' OR v_state = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object(
      'code', 'BAD_STATUS', 'message', 'missing id/status', 'retryable', FALSE));
  END IF;

  -- Meta sends unix seconds as a string; a missing/garbled timestamp
  -- falls back to now() rather than failing the receipt.
  BEGIN
    v_ts := to_timestamp(NULLIF(p_status->>'timestamp', '')::BIGINT);
  EXCEPTION WHEN OTHERS THEN
    v_ts := NULL;
  END;
  v_ts := COALESCE(v_ts, now());
  v_on := (v_ts AT TIME ZONE p_timezone)::DATE;
  v_month := date_trunc('month', v_on)::DATE;
  v_market := whatsapp_resolve_market(v_waid);

  -- Meta spells one category with a hyphen ('authentication-international');
  -- the rate card uses underscores throughout.
  v_cat := replace(lower(COALESCE(
    p_status->'pricing'->>'category',
    p_status->'conversation'->'origin'->>'type')), '-', '_');
  IF v_cat IN ('referral_conversion', 'free_entry_point') THEN
    v_cat := 'referral_conversion';
  END IF;
  -- Pre-PMP `conversation.origin.type`. `user_initiated` is what the
  -- per-message card now calls `service`; `business_initiated` does not
  -- map — it could be marketing or utility — so it is left alone and
  -- surfaces as "no rate on file" rather than being guessed at.
  IF v_cat = 'user_initiated' THEN v_cat := 'service'; END IF;

  -- Meta attaches `pricing` to the `sent` receipt and does not always
  -- repeat it on the `delivered` one. Defaulting that delivery to
  -- 'service' would zero-rate a marketing or utility send AND hide it
  -- from the unknown-rate counter (service is free), so the spend would
  -- simply vanish. The category is already in the ledger from the
  -- earlier receipt of the same message — adopt it. Anything still
  -- uncategorised after that really is a free-form message.
  IF v_cat IS NULL OR v_cat = '' THEN
    SELECT c.category INTO v_cat
      FROM whatsapp_message_costs c
     WHERE c.phone_number_id = p_phone_number_id
       AND c.message_id = v_msgid
       AND c.category IS NOT NULL
       AND c.category <> 'service'   -- i.e. not itself a defaulted row
     ORDER BY c.id DESC
     LIMIT 1;
  END IF;
  IF v_cat IS NULL OR v_cat = '' THEN v_cat := 'service'; END IF;

  BEGIN
    v_metabill := (p_status->'pricing'->>'billable')::BOOLEAN;
  EXCEPTION WHEN OTHERS THEN
    v_metabill := NULL;
  END;

  IF v_state <> 'delivered' THEN
    v_billable := FALSE; v_rate := NULL; v_cost := 0;
  ELSE
    IF v_cat = 'service' THEN
      IF v_on < DATE '2026-10-01' THEN
        v_billable := FALSE; v_cost := 0;
      ELSE
        SELECT count(*) INTO v_svc_count
          FROM whatsapp_message_costs
         WHERE phone_number_id = p_phone_number_id
           AND category = 'service'
           AND status = 'delivered'
           AND billing_month = v_month;
        v_quota_free := v_svc_count < 1000;
        v_billable := NOT v_quota_free;
      END IF;
    ELSIF v_cat = 'referral_conversion' THEN
      v_billable := FALSE; v_cost := 0;   -- 72-hour free entry point
    ELSE
      v_billable := TRUE;
    END IF;

    -- Meta's explicit flag is authoritative when present.
    IF v_metabill IS NOT NULL THEN v_billable := v_metabill; END IF;

    -- `quota_free` means "free because the free tier absorbed it". If
    -- Meta then says the message IS billable, the tier did not absorb
    -- it: leaving the flag set would bill the message and still count
    -- it against the free allowance in the settings panel.
    IF v_billable THEN v_quota_free := FALSE; END IF;

    IF v_billable THEN
      v_rate := whatsapp_resolve_rate(v_market, v_cat, v_on);
      v_cost := v_rate;                     -- NULL stays NULL
    ELSE
      v_cost := COALESCE(v_cost, 0);
    END IF;
  END IF;

  INSERT INTO whatsapp_message_costs (
    account_id, phone_number_id, message_id, status,
    recipient_wa_id, recipient_market, category, pricing_model,
    meta_billable, quota_free, billable, rate_usd, cost_usd,
    raw_status, delivered_at, billing_month
  ) VALUES (
    p_account_id, p_phone_number_id, v_msgid, v_state,
    v_waid, v_market, v_cat, v_pmodel,
    v_metabill, v_quota_free, v_billable, v_rate, v_cost,
    p_status,
    CASE WHEN v_state = 'delivered' THEN v_ts END,
    CASE WHEN v_state = 'delivered' THEN v_month END
  )
  -- No conflict target: 100 widens the receipt key with the recipient,
  -- and a target naming this file's key would raise 42P10 on every call
  -- if this file is re-run after 100. The only other unique index is the
  -- identity key, so this is the same rule under either key.
  ON CONFLICT DO NOTHING
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('ok', TRUE, 'data',
      jsonb_build_object('duplicate', TRUE, 'message_id', v_msgid));
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'data', to_jsonb(v_row) - 'raw_status');
END;
$$;

-- Service role only: the webhook is the sole writer, and an
-- authenticated caller must not be able to append to another
-- account's ledger by passing its id.
REVOKE ALL ON FUNCTION record_whatsapp_message_cost(UUID, TEXT, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_whatsapp_message_cost(UUID, TEXT, JSONB, TEXT) FROM anon;
REVOKE ALL ON FUNCTION record_whatsapp_message_cost(UUID, TEXT, JSONB, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION record_whatsapp_message_cost(UUID, TEXT, JSONB, TEXT) TO service_role;

-- ============================================================
-- 6. Reporting views.
--
-- `security_invoker` so the ledger's RLS applies to whoever selects
-- from the view — without it a view runs as its owner and would hand
-- every account's spend to any signed-in user.
-- ============================================================

CREATE OR REPLACE VIEW whatsapp_cost_monthly
WITH (security_invoker = true) AS
SELECT account_id,
       billing_month                             AS month,
       phone_number_id,
       recipient_market,
       category,
       count(*)                                  AS delivered,
       count(*) FILTER (WHERE billable)          AS billed,
       count(*) FILTER (WHERE quota_free)        AS quota_free,
       count(*) FILTER (WHERE cost_usd IS NULL)  AS unknown_rate,  -- must be 0 once the card is loaded
       sum(cost_usd)                             AS cost_usd
  FROM whatsapp_message_costs
 WHERE status = 'delivered'
 GROUP BY 1, 2, 3, 4, 5;

CREATE OR REPLACE VIEW whatsapp_service_quota
WITH (security_invoker = true) AS
SELECT account_id,
       phone_number_id,
       billing_month                  AS month,
       count(*)                       AS service_delivered,
       greatest(0, 1000 - count(*))   AS free_remaining
  FROM whatsapp_message_costs
 WHERE status = 'delivered' AND category = 'service'
 GROUP BY 1, 2, 3;
