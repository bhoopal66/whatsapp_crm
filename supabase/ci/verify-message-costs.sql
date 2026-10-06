-- Behavioural regression suite for the message-cost ledger (051).
--
-- `verify-schema.sql` asserts the objects EXIST. This file asserts they
-- COMPUTE THE RIGHT NUMBER, which schema checks cannot: the costing
-- rules — the rate card, the market map, the free tier, Meta's
-- `billable` override — live in `record_whatsapp_message_cost`, so the
-- vitest suite (which only covers the app-side adapter and the report
-- shaping) can never reach them. Every regression fixed in this area
-- has a case here.
--
-- Runs against the clean database `supabase db reset` builds, after
-- every migration has replayed. It writes rows; that database is
-- thrown away.

DO $$
DECLARE
  v_acct  UUID;
  v_user  UUID := '00000000-0000-4000-8000-0000000c0575';
  r       JSONB;
  n       INT := 0;
  bad     INT := 0;
  sep     TIMESTAMPTZ := '2026-09-14 10:00+00';  -- before the 2026-10-01 rules
  nov     TIMESTAMPTZ := '2026-11-05 10:00+00';  -- after them
BEGIN
  -- An account to hang the ledger rows off. A trigger on auth.users
  -- provisions one; fall back to an explicit insert if that ever stops
  -- being true, so this file fails on costing bugs and not on setup.
  INSERT INTO auth.users (id, email)
       VALUES (v_user, 'ci-message-costs@example.invalid')
  ON CONFLICT DO NOTHING;

  SELECT id INTO v_acct FROM accounts WHERE owner_user_id = v_user;
  IF v_acct IS NULL THEN
    INSERT INTO accounts (name, owner_user_id)
         VALUES ('CI message costs', v_user)
      RETURNING id INTO v_acct;
  END IF;

  -- ---------------------------------------------------------------
  -- The category a delivery is priced under
  -- ---------------------------------------------------------------

  -- Meta puts `pricing` on the `sent` receipt and does not always
  -- repeat it on `delivered`. Filing that delivery as 'service' would
  -- zero-rate a template send AND hide it from the unknown-rate
  -- counter, so the spend would vanish silently.
  PERFORM record_whatsapp_message_cost(v_acct, 'PNA', jsonb_build_object(
    'id', 'adopt-1', 'status', 'sent',
    'timestamp', extract(epoch FROM sep)::BIGINT::TEXT,
    'recipient_id', '971501234567',
    'pricing', '{"pricing_model":"PMP","category":"marketing"}'::jsonb));
  r := record_whatsapp_message_cost(v_acct, 'PNA', jsonb_build_object(
    'id', 'adopt-1', 'status', 'delivered',
    'timestamp', extract(epoch FROM sep)::BIGINT::TEXT,
    'recipient_id', '971501234567'))->'data';
  n := n + 1;
  IF r->>'category' = 'marketing' AND (r->>'cost_usd')::NUMERIC = 0.0499 THEN
    RAISE NOTICE 'PASS  delivery without pricing adopts the sent receipt''s category';
  ELSE
    bad := bad + 1;
    RAISE WARNING 'FAIL  category adoption: %', r;
  END IF;

  -- ...but a message that really is free-form must stay free.
  PERFORM record_whatsapp_message_cost(v_acct, 'PNA', jsonb_build_object(
    'id', 'adopt-2', 'status', 'sent',
    'timestamp', extract(epoch FROM sep)::BIGINT::TEXT,
    'recipient_id', '971501234567'));
  r := record_whatsapp_message_cost(v_acct, 'PNA', jsonb_build_object(
    'id', 'adopt-2', 'status', 'delivered',
    'timestamp', extract(epoch FROM sep)::BIGINT::TEXT,
    'recipient_id', '971501234567'))->'data';
  n := n + 1;
  IF r->>'category' = 'service' AND NOT (r->>'billable')::BOOLEAN THEN
    RAISE NOTICE 'PASS  a genuinely free-form delivery is still service, unbilled';
  ELSE
    bad := bad + 1;
    RAISE WARNING 'FAIL  free-form default: %', r;
  END IF;

  -- Meta spells one category with a hyphen; the rate card uses
  -- underscores throughout.
  r := record_whatsapp_message_cost(v_acct, 'PNB', jsonb_build_object(
    'id', 'hyphen-1', 'status', 'delivered',
    'timestamp', extract(epoch FROM nov)::BIGINT::TEXT,
    'recipient_id', '96550123456',
    'pricing', '{"category":"authentication-international"}'::jsonb))->'data';
  n := n + 1;
  IF r->>'category' = 'authentication_international'
     AND (r->>'cost_usd')::NUMERIC = 0.12 THEN
    RAISE NOTICE 'PASS  hyphenated category normalises and prices';
  ELSE
    bad := bad + 1;
    RAISE WARNING 'FAIL  hyphenated category: %', r;
  END IF;

  -- Pre-per-message envelopes. `user_initiated` is what the new card
  -- calls service; `business_initiated` could be marketing or utility,
  -- so it is NOT guessed at — it must surface as an unknown rate.
  r := record_whatsapp_message_cost(v_acct, 'PNB', jsonb_build_object(
    'id', 'prepmp-1', 'status', 'delivered',
    'timestamp', extract(epoch FROM sep)::BIGINT::TEXT,
    'recipient_id', '971501234567',
    'conversation', '{"origin":{"type":"user_initiated"}}'::jsonb))->'data';
  n := n + 1;
  IF r->>'category' = 'service' AND NOT (r->>'billable')::BOOLEAN THEN
    RAISE NOTICE 'PASS  pre-per-message user_initiated maps to service';
  ELSE
    bad := bad + 1;
    RAISE WARNING 'FAIL  user_initiated: %', r;
  END IF;

  r := record_whatsapp_message_cost(v_acct, 'PNB', jsonb_build_object(
    'id', 'prepmp-2', 'status', 'delivered',
    'timestamp', extract(epoch FROM sep)::BIGINT::TEXT,
    'recipient_id', '971501234567',
    'conversation', '{"origin":{"type":"business_initiated"}}'::jsonb))->'data';
  n := n + 1;
  IF (r->>'billable')::BOOLEAN AND r->>'cost_usd' IS NULL THEN
    RAISE NOTICE 'PASS  business_initiated is reported unpriced, never guessed';
  ELSE
    bad := bad + 1;
    RAISE WARNING 'FAIL  business_initiated: %', r;
  END IF;

  -- ---------------------------------------------------------------
  -- What gets billed
  -- ---------------------------------------------------------------

  r := record_whatsapp_message_cost(v_acct, 'PNC', jsonb_build_object(
    'id', 'rate-1', 'status', 'delivered',
    'timestamp', extract(epoch FROM sep)::BIGINT::TEXT,
    'recipient_id', '971501234567',
    'pricing', '{"category":"marketing"}'::jsonb))->'data';
  n := n + 1;
  IF (r->>'cost_usd')::NUMERIC = 0.0499 AND r->>'recipient_market' = 'AE' THEN
    RAISE NOTICE 'PASS  longest-prefix market map + dated rate card (AE marketing)';
  ELSE
    bad := bad + 1;
    RAISE WARNING 'FAIL  AE marketing: %', r;
  END IF;

  -- An unknown rate is NULL, never 0: a faked zero under-reports spend,
  -- which is the one thing a cost ledger must not do.
  r := record_whatsapp_message_cost(v_acct, 'PNC', jsonb_build_object(
    'id', 'rate-2', 'status', 'delivered',
    'timestamp', extract(epoch FROM sep)::BIGINT::TEXT,
    'recipient_id', '4915112345678',
    'pricing', '{"category":"marketing"}'::jsonb))->'data';
  n := n + 1;
  IF r->>'recipient_market' = 'UNKNOWN' AND r->>'cost_usd' IS NULL THEN
    RAISE NOTICE 'PASS  an unmapped market costs NULL, not 0';
  ELSE
    bad := bad + 1;
    RAISE WARNING 'FAIL  unknown market: %', r;
  END IF;

  -- Service is billed at the market's utility rate, so a market with no
  -- explicit service row still prices (KW utility, 2026-10-01: 0.0440).
  r := record_whatsapp_message_cost(v_acct, 'PND', jsonb_build_object(
    'id', 'svc-fallback', 'status', 'delivered',
    'timestamp', extract(epoch FROM nov)::BIGINT::TEXT,
    'recipient_id', '96550123456',
    'pricing', '{"category":"service","billable":true}'::jsonb))->'data';
  n := n + 1;
  IF (r->>'cost_usd')::NUMERIC = 0.044 THEN
    RAISE NOTICE 'PASS  service falls back to the market utility rate';
  ELSE
    bad := bad + 1;
    RAISE WARNING 'FAIL  service->utility fallback: %', r;
  END IF;

  -- Meta's explicit flag wins over the local rules — and when it says
  -- billable, the free tier did NOT absorb the message, so the
  -- quota_free mark has to come off or the settings panel bills it and
  -- counts it against the allowance at the same time.
  n := n + 1;
  IF (r->>'billable')::BOOLEAN AND NOT (r->>'quota_free')::BOOLEAN THEN
    RAISE NOTICE 'PASS  a Meta-billable service message is not also counted free';
  ELSE
    bad := bad + 1;
    RAISE WARNING 'FAIL  billable override vs quota_free: %', r;
  END IF;

  -- Only `delivered` is costed; Meta charges on delivery.
  r := record_whatsapp_message_cost(v_acct, 'PNE', jsonb_build_object(
    'id', 'sent-only', 'status', 'sent',
    'timestamp', extract(epoch FROM sep)::BIGINT::TEXT,
    'recipient_id', '971501234567',
    'pricing', '{"category":"marketing"}'::jsonb))->'data';
  n := n + 1;
  IF NOT (r->>'billable')::BOOLEAN AND (r->>'cost_usd')::NUMERIC = 0
     AND r->>'billing_month' IS NULL THEN
    RAISE NOTICE 'PASS  a non-delivered receipt is recorded but not costed';
  ELSE
    bad := bad + 1;
    RAISE WARNING 'FAIL  sent receipt: %', r;
  END IF;

  -- ---------------------------------------------------------------
  -- The free service tier and the billing month
  -- ---------------------------------------------------------------

  -- Free outright before 2026-10-01, so quota_free must stay FALSE:
  -- the flag means "the allowance absorbed it", not "it was free".
  r := record_whatsapp_message_cost(v_acct, 'PNF', jsonb_build_object(
    'id', 'tier-pre', 'status', 'delivered',
    'timestamp', extract(epoch FROM sep)::BIGINT::TEXT,
    'recipient_id', '971501234567',
    'pricing', '{"category":"service"}'::jsonb))->'data';
  n := n + 1;
  IF NOT (r->>'billable')::BOOLEAN AND NOT (r->>'quota_free')::BOOLEAN THEN
    RAISE NOTICE 'PASS  service before 2026-10-01 is free without using the allowance';
  ELSE
    bad := bad + 1;
    RAISE WARNING 'FAIL  pre-2026-10-01 service: %', r;
  END IF;

  -- 21:00 UTC on 30 September is already 1 October in the Gulf, and the
  -- allowance is a calendar month in the WABA's timezone.
  r := record_whatsapp_message_cost(v_acct, 'PNG', jsonb_build_object(
    'id', 'tz-1', 'status', 'delivered',
    'timestamp', extract(epoch FROM TIMESTAMPTZ '2026-09-30 21:00+00')::BIGINT::TEXT,
    'recipient_id', '971501234567',
    'pricing', '{"category":"service"}'::jsonb))->'data';
  n := n + 1;
  IF r->>'billing_month' = '2026-10-01' AND (r->>'quota_free')::BOOLEAN THEN
    RAISE NOTICE 'PASS  the billing month is the WABA timezone, not UTC';
  ELSE
    bad := bad + 1;
    RAISE WARNING 'FAIL  timezone boundary: %', r;
  END IF;

  -- The allowance is 1,000 per number per month: #1000 free, #1001 billed.
  INSERT INTO whatsapp_message_costs (
    account_id, phone_number_id, message_id, status, recipient_wa_id,
    recipient_market, category, quota_free, billable, cost_usd,
    raw_status, delivered_at, billing_month)
  SELECT v_acct, 'PNH', 'bulk-' || i, 'delivered', '971501234567',
         'AE', 'service', TRUE, FALSE, 0, '{}'::jsonb, nov, DATE '2026-11-01'
    FROM generate_series(1, 999) AS i;

  r := record_whatsapp_message_cost(v_acct, 'PNH', jsonb_build_object(
    'id', 'tier-1000', 'status', 'delivered',
    'timestamp', extract(epoch FROM nov)::BIGINT::TEXT,
    'recipient_id', '971501234567',
    'pricing', '{"category":"service"}'::jsonb))->'data';
  n := n + 1;
  IF (r->>'quota_free')::BOOLEAN AND NOT (r->>'billable')::BOOLEAN THEN
    RAISE NOTICE 'PASS  the 1000th service message of the month is still free';
  ELSE
    bad := bad + 1;
    RAISE WARNING 'FAIL  tier boundary (1000th): %', r;
  END IF;

  r := record_whatsapp_message_cost(v_acct, 'PNH', jsonb_build_object(
    'id', 'tier-1001', 'status', 'delivered',
    'timestamp', extract(epoch FROM nov)::BIGINT::TEXT,
    'recipient_id', '971501234567',
    'pricing', '{"category":"service"}'::jsonb))->'data';
  n := n + 1;
  IF NOT (r->>'quota_free')::BOOLEAN AND (r->>'billable')::BOOLEAN
     AND (r->>'cost_usd')::NUMERIC = 0.0157 THEN
    RAISE NOTICE 'PASS  the 1001st bills at the market utility rate';
  ELSE
    bad := bad + 1;
    RAISE WARNING 'FAIL  tier boundary (1001st): %', r;
  END IF;

  -- ---------------------------------------------------------------
  -- Replay and bad input
  -- ---------------------------------------------------------------

  -- Meta redelivers on any non-200, so the same receipt must not
  -- double-charge.
  r := record_whatsapp_message_cost(v_acct, 'PNC', jsonb_build_object(
    'id', 'rate-1', 'status', 'delivered',
    'timestamp', extract(epoch FROM sep)::BIGINT::TEXT,
    'recipient_id', '971501234567',
    'pricing', '{"category":"marketing"}'::jsonb))->'data';
  n := n + 1;
  IF (r->>'duplicate')::BOOLEAN THEN
    RAISE NOTICE 'PASS  a replayed receipt is a no-op, not a second charge';
  ELSE
    bad := bad + 1;
    RAISE WARNING 'FAIL  replay: %', r;
  END IF;

  -- A malformed status returns a structured rejection; it must never
  -- raise, because the webhook's fail-open contract depends on it.
  r := record_whatsapp_message_cost(v_acct, 'PNC', '{"status":"delivered"}'::jsonb);
  n := n + 1;
  IF NOT (r->>'ok')::BOOLEAN AND r->'error'->>'code' = 'BAD_STATUS' THEN
    RAISE NOTICE 'PASS  a malformed receipt is rejected, not raised';
  ELSE
    bad := bad + 1;
    RAISE WARNING 'FAIL  malformed status: %', r;
  END IF;

  -- ---------------------------------------------------------------
  -- The reporting views the settings panel reads
  -- ---------------------------------------------------------------

  n := n + 1;
  IF (SELECT count(*) FROM whatsapp_cost_monthly WHERE account_id = v_acct) > 0
     AND (SELECT count(*) FROM whatsapp_cost_monthly
           WHERE account_id = v_acct AND unknown_rate > 0) > 0 THEN
    RAISE NOTICE 'PASS  whatsapp_cost_monthly aggregates and surfaces unpriced rows';
  ELSE
    bad := bad + 1;
    RAISE WARNING 'FAIL  whatsapp_cost_monthly is empty or hides unpriced rows';
  END IF;

  n := n + 1;
  IF (SELECT free_remaining FROM whatsapp_service_quota
       WHERE account_id = v_acct AND phone_number_id = 'PNH'
         AND month = DATE '2026-11-01') = 0 THEN
    RAISE NOTICE 'PASS  whatsapp_service_quota reports the allowance exhausted';
  ELSE
    bad := bad + 1;
    RAISE WARNING 'FAIL  whatsapp_service_quota free_remaining is wrong';
  END IF;

  RAISE NOTICE '--- message-cost ledger: % assertions, % failed ---', n, bad;
  IF bad > 0 THEN
    RAISE EXCEPTION '% message-cost assertion(s) failed', bad;
  END IF;
END $$;
