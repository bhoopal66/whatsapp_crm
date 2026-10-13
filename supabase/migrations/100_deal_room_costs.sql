-- 100: deal rooms — group sends costed per delivered recipient.
--
-- Meta bills a message sent to a group once per participant it is
-- delivered to, at that participant's market rate, in the message's
-- one category: a free-form message inside the GROUP's 24-hour window
-- (deal_rooms.window_until) is `service` for every member, whatever
-- each member's own 1:1 window. 051's ledger could not hold that: it
-- keyed a row on (number, message, status), so a second member's
-- delivery of the same message was a "duplicate", and it priced the
-- market of `recipient_id`, which on a group receipt is the group.
--
--  * The ledger's key gains the recipient. A 1:1 message has one
--    recipient, so its rows and its replay protection are unchanged.
--  * record_whatsapp_message_cost reads a group receipt
--    (`recipient_type: 'group'`) as the delivery to its participant
--    (`recipient_participant_id`; Meta's pages also spell it
--    `participant_recipient_id`): that number is the row's recipient
--    and market. A group receipt naming no participant is recorded
--    uncosted, keyed on the group; a DELIVERY naming none is refused
--    (BAD_STATUS) rather than priced at a market nobody is in.
--  * deal_room_record_cost (service role) feeds one group receipt to
--    the ledger and, only when the ledger wrote a new row, lifts it onto
--    our group_messages row in the same account: `category` (a real
--    category replaces a defaulted `service`) and `recipients_billed`
--    (+1 for a billable delivery). The ledger's key is what makes a
--    redelivered receipt count once. Fail-open at the call site
--    (lib/whatsapp/message-costs.ts), like 1:1 costing.
--
-- 088's superuser / BYPASSRLS guard is repeated: deal_room_record_cost
-- is a new SECURITY DEFINER function writing group_messages, which is
-- RLS-forced, so its owner must bypass RLS.
--
-- Re-runnable: every statement is guarded or replaces in place.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '100 must be applied by a superuser or BYPASSRLS role (the deal-room functions own RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. The ledger, per recipient ----------

-- The new key first, then the function that names it, then the old key
-- goes: the function in place always has a key to infer.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_message_costs_receipt_key
  ON public.whatsapp_message_costs (phone_number_id, message_id, status, recipient_wa_id);

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
  -- 100: a group receipt is the delivery to one participant.
  v_group      BOOLEAN := COALESCE(p_status->>'recipient_type', '') = 'group';
  v_member     TEXT := COALESCE(NULLIF(p_status->>'recipient_participant_id', ''),
                                NULLIF(p_status->>'participant_recipient_id', ''));
  v_waid       TEXT;
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
  IF v_group AND v_member IS NULL AND v_state = 'delivered' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object(
      'code', 'BAD_STATUS', 'message', 'a group delivery names no participant', 'retryable', FALSE));
  END IF;
  v_waid := CASE WHEN v_group THEN COALESCE(v_member, p_status->>'recipient_id', '')
                 ELSE COALESCE(p_status->>'recipient_id', '') END;

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
  -- A group-level receipt (no participant) is in no market.
  v_market := CASE WHEN v_group AND v_member IS NULL THEN 'UNKNOWN'
                   ELSE whatsapp_resolve_market(v_waid) END;

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
  -- uncategorised after that really is a free-form message. (A group
  -- message has one category: any member's receipt counts.)
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
  ON CONFLICT (phone_number_id, message_id, status, recipient_wa_id) DO NOTHING
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('ok', TRUE, 'data',
      jsonb_build_object('duplicate', TRUE, 'message_id', v_msgid));
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'data', to_jsonb(v_row) - 'raw_status');
END;
$$;

ALTER TABLE public.whatsapp_message_costs
  DROP CONSTRAINT IF EXISTS whatsapp_message_costs_phone_number_id_message_id_status_key;

-- As 051: the webhook is the sole writer.
REVOKE ALL ON FUNCTION record_whatsapp_message_cost(UUID, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_whatsapp_message_cost(UUID, TEXT, JSONB, TEXT) TO service_role;

-- ---------- 2. A group receipt onto its message ----------

-- One receipt of a group send (`recipient_type: 'group'`), in the
-- account the webhook authenticated: the ledger row, then — only when
-- the ledger wrote a new one — our message's category and billed count.
-- Returns the ledger's answer.
CREATE OR REPLACE FUNCTION public.deal_room_record_cost(p_account uuid, p_phone_number_id text, p_status jsonb,
                                                        p_timezone text DEFAULT 'Asia/Dubai')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_res jsonb;
  v_row jsonb;
BEGIN
  PERFORM public.deal_room_assert_service();
  IF p_status IS NULL OR jsonb_typeof(p_status) <> 'object'
     OR p_status->>'recipient_type' IS DISTINCT FROM 'group' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'BAD_STATUS', 'message', 'not a group receipt', 'retryable', false));
  END IF;
  v_res := public.record_whatsapp_message_cost(p_account, p_phone_number_id, p_status,
                                               coalesce(p_timezone, 'Asia/Dubai'));
  v_row := v_res->'data';
  IF NOT coalesce((v_res->>'ok')::boolean, false) OR coalesce((v_row->>'duplicate')::boolean, false) THEN
    RETURN v_res;   -- refused, or a redelivered receipt: counted already
  END IF;
  UPDATE public.group_messages
     SET category = CASE WHEN category IS NULL
                           OR (category = 'service' AND v_row->>'category' <> 'service')
                         THEN v_row->>'category' ELSE category END,
         recipients_billed = coalesce(recipients_billed, 0)
           + CASE WHEN v_row->>'status' = 'delivered' AND (v_row->>'billable')::boolean THEN 1 ELSE 0 END
   WHERE wa_message_id = p_status->>'id' AND account_id = p_account AND direction = 'out';
  RETURN v_res;
END $$;

REVOKE ALL ON FUNCTION public.deal_room_record_cost(uuid, text, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_room_record_cost(uuid, text, jsonb, text) TO service_role;
