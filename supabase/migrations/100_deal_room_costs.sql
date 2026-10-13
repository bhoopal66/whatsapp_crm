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
--  * A receipt can beat its message's row, which is written only once
--    Meta has answered the send: deal_room_record_message, writing an
--    outbound row, takes from the ledger what those receipts left there
--    (deal_room_record_cost found no row to lift them onto, and their
--    redeliveries are ledger duplicates). An advisory lock per message
--    makes each receipt land through exactly one of the two.
--
-- Re-running 051 after this file puts 051's record_whatsapp_message_cost
-- back (its table is left alone): it keeps recording, but keys a group
-- receipt on the group. Re-apply 100 after re-running 051.
--
-- And a group's settings: deal_room_apply_settings (service role) takes
-- the subject, description and join approval mode a
-- `group_settings_update` webhook reports onto the room of the account
-- the webhook authenticated, renaming its Team notes channel with it.
-- And Team notes: a trigger on deal_room_audit posts a short system
-- note into the room's Team notes for each change of membership, a
-- waiting join request, a STOP, a suspension or its end, and the close,
-- once per change, fail-open; the removal a STOP makes posts no note
-- beside the STOP's own.
--
-- 088's superuser / BYPASSRLS guard is repeated: deal_room_record_cost
-- and deal_room_apply_settings are new SECURITY DEFINER functions
-- writing RLS-forced tables (group_messages, chat_channels), so their
-- owner must bypass RLS.
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
  -- One writer at a time with deal_room_record_message for this message:
  -- a receipt racing the row's insert is lifted here (the row is
  -- committed) or read from the ledger there (this receipt is), never
  -- both and never neither.
  PERFORM pg_advisory_xact_lock(hashtextextended('deal_room_cost:' || coalesce(p_status->>'id', ''), 0));
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

-- 088's deal_room_record_message, and an outbound row with a wamid takes
-- what the ledger already holds for it (above), as deal_room_record_cost
-- would have lifted it: the first real category (else `service`), and
-- the billable deliveries. Nothing in the ledger: both stay NULL.
CREATE OR REPLACE FUNCTION public.deal_room_record_message(
  p_account uuid, p_group_id text, p_direction text, p_type text,
  p_wa_message_id text DEFAULT NULL, p_sender_wa_id text DEFAULT NULL, p_body text DEFAULT NULL,
  p_media jsonb DEFAULT NULL, p_template_name text DEFAULT NULL, p_staff_user_id uuid DEFAULT NULL,
  p_status text DEFAULT NULL, p_error text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_r      public.deal_rooms;
  v_id     uuid;
  v_sender uuid;
  v_pn     text;
BEGIN
  PERFORM public.deal_room_assert_service();
  IF p_direction IS NULL OR p_direction NOT IN ('in','out') THEN
    RAISE EXCEPTION 'deal rooms: direction must be in or out' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_r FROM public.deal_rooms WHERE wa_group_id = p_group_id AND account_id = p_account;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deal rooms: unknown group' USING ERRCODE = 'P0002';
  END IF;
  IF p_direction = 'out' AND v_r.status = 'closed' AND p_type IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'deal rooms: the room is closed' USING ERRCODE = '22023';
  END IF;
  IF p_direction = 'out' AND p_wa_message_id IS NOT NULL THEN
    -- 100: see deal_room_record_cost.
    PERFORM pg_advisory_xact_lock(hashtextextended('deal_room_cost:' || p_wa_message_id, 0));
  END IF;
  IF p_wa_message_id IS NOT NULL THEN
    SELECT id INTO v_id FROM public.group_messages WHERE wa_message_id = p_wa_message_id AND account_id = p_account;
    IF FOUND THEN
      RETURN v_id;   -- redelivery
    END IF;
  END IF;
  IF p_direction = 'in' THEN
    IF btrim(coalesce(p_sender_wa_id, '')) = '' THEN
      RAISE EXCEPTION 'deal rooms: an inbound message needs its sender' USING ERRCODE = '22023';
    END IF;
    v_sender := coalesce(public.deal_room_find_participant(v_r.id, p_sender_wa_id),
                         public.deal_room_add_unlisted(v_r.id, v_r.account_id, p_sender_wa_id));
  ELSE
    SELECT id INTO v_sender FROM public.deal_room_participants WHERE room_id = v_r.id AND role = 'business';
  END IF;
  INSERT INTO public.group_messages (room_id, account_id, wa_message_id, direction, sender_wa_id,
                                     sender_participant_id, staff_user_id, type, body, media, template_name,
                                     status, error)
  VALUES (v_r.id, v_r.account_id, p_wa_message_id, p_direction,
          CASE WHEN p_direction = 'in' THEN p_sender_wa_id END, v_sender,
          CASE WHEN p_direction = 'out' THEN p_staff_user_id END,
          p_type, p_body, p_media, p_template_name,
          CASE WHEN p_direction = 'out'
               THEN coalesce(p_status, CASE WHEN p_wa_message_id IS NULL THEN 'pending' ELSE 'sent' END) END,
          p_error)
  ON CONFLICT (wa_message_id) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN   -- a concurrent redelivery won (NULL: the id is another account's)
    SELECT id INTO v_id FROM public.group_messages WHERE wa_message_id = p_wa_message_id AND account_id = p_account;
    RETURN v_id;
  END IF;
  IF p_direction = 'out' AND p_wa_message_id IS NOT NULL THEN
    SELECT w.phone_number_id INTO v_pn FROM public.whatsapp_config w
     WHERE w.id = v_r.whatsapp_config_id AND w.account_id = v_r.account_id;
    UPDATE public.group_messages g
       SET category = l.category, recipients_billed = l.billed
      FROM (SELECT (array_agg(c.category ORDER BY c.category = 'service', c.id))[1] AS category,
                   count(*) FILTER (WHERE c.status = 'delivered' AND c.billable)::integer AS billed
              FROM public.whatsapp_message_costs c
             WHERE c.phone_number_id = v_pn AND c.message_id = p_wa_message_id
               AND c.account_id = v_r.account_id) l
     WHERE g.id = v_id AND l.category IS NOT NULL;
  END IF;
  IF p_direction = 'in' THEN
    UPDATE public.deal_rooms SET window_until = now() + interval '24 hours' WHERE id = v_r.id;
    PERFORM public.deal_room_refresh_count(v_r.id);
  END IF;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.deal_room_record_message(uuid, text, text, text, text, text, text, jsonb, text, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_room_record_message(uuid, text, text, text, text, text, text, jsonb, text, uuid, text, text)
  TO service_role;


-- ---------- 3. A group's settings, as WhatsApp reports them ----------

-- A `group_settings_update` webhook, parsed by lib/deal-rooms/webhook.ts
-- (parseGroupSettings), for the group of a room of the account the
-- webhook authenticated. p_settings holds only what changed: `subject`,
-- `description` (JSON null: cleared) and `join_approval_mode`; a key
-- left out is left alone, and a value the room cannot hold (a blank or
-- over-long subject or description, an unknown mode) is ignored rather
-- than failing the webhook. A new subject renames the room's Team notes
-- channel as deal_room_create names it (left(subject, 80)). A closed
-- room is the record of a deleted group and changes no more. Returns
-- whether anything changed; a redelivery changes nothing.
CREATE OR REPLACE FUNCTION public.deal_room_apply_settings(p_account uuid, p_group_id text, p_settings jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_r       public.deal_rooms;
  v_subject text;
  v_desc    text;
  v_mode    text;
  v_fields  text[] := '{}';
BEGIN
  PERFORM public.deal_room_assert_service();
  SELECT * INTO v_r FROM public.deal_rooms
   WHERE wa_group_id = p_group_id AND account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deal rooms: unknown group' USING ERRCODE = 'P0002';
  END IF;
  IF v_r.status = 'closed' OR p_settings IS NULL OR jsonb_typeof(p_settings) <> 'object' THEN
    RETURN false;
  END IF;
  v_subject := v_r.subject;
  v_desc    := v_r.description;
  v_mode    := v_r.join_approval_mode;
  IF jsonb_typeof(p_settings->'subject') = 'string'
     AND char_length(btrim(p_settings->>'subject')) BETWEEN 1 AND 128 THEN
    v_subject := btrim(p_settings->>'subject');
  END IF;
  IF jsonb_typeof(p_settings->'description') = 'null' THEN
    v_desc := NULL;
  ELSIF jsonb_typeof(p_settings->'description') = 'string'
        AND char_length(btrim(p_settings->>'description')) <= 2048 THEN
    v_desc := nullif(btrim(p_settings->>'description'), '');
  END IF;
  IF jsonb_typeof(p_settings->'join_approval_mode') = 'string'
     AND p_settings->>'join_approval_mode' IN ('approval_required','auto_approve') THEN
    v_mode := p_settings->>'join_approval_mode';
  END IF;
  IF v_subject IS DISTINCT FROM v_r.subject THEN
    v_fields := v_fields || 'subject'::text;
  END IF;
  IF v_desc IS DISTINCT FROM v_r.description THEN
    v_fields := v_fields || 'description'::text;
  END IF;
  IF v_mode IS DISTINCT FROM v_r.join_approval_mode THEN
    v_fields := v_fields || 'join_approval_mode'::text;
  END IF;
  IF cardinality(v_fields) = 0 THEN
    RETURN false;
  END IF;
  UPDATE public.deal_rooms
     SET subject = v_subject, description = v_desc, join_approval_mode = v_mode
   WHERE id = v_r.id;
  IF v_subject IS DISTINCT FROM v_r.subject THEN
    UPDATE public.chat_channels SET name = left(v_subject, 80) WHERE id = v_r.channel_id;
  END IF;
  INSERT INTO public.deal_room_audit (room_id, account_id, actor_id, action, detail)
  VALUES (v_r.id, v_r.account_id, NULL, 'settings_changed',
          jsonb_build_object('fields', to_jsonb(v_fields),
                             'subject', jsonb_build_object('from', v_r.subject, 'to', v_subject),
                             'join_approval_mode', jsonb_build_object('from', v_r.join_approval_mode, 'to', v_mode)));
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.deal_room_apply_settings(uuid, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_room_apply_settings(uuid, text, jsonb) TO service_role;

-- ---------- 4. Team notes ----------

-- A short system note in the room's Team notes (its deal_room channel,
-- through chat_post_system_message) when someone joins, leaves or is
-- removed, a join request waits for a manager, a member opts out with
-- STOP, or WhatsApp suspends or reinstates the group, and when the room
-- closes. Each is posted from the audit row its change writes, and
-- those rows are written only when the state actually changed
-- (deal_room_participant_event, deal_room_record_join_request,
-- deal_room_set_status, and the webhook's `participant_opted_out` row,
-- written for a STOP message seen the first time), so a redelivered
-- webhook, which changes nothing, posts nothing, whoever made the
-- change (the webhook, or a manager's removal or close). Removals and
-- joins while the room is closing or closed are left out: the close is
-- the note. People are named as the guest roster names them: someone
-- nobody listed, or whose name holds their number, is "Unlisted number
-- ending NN"; a note never carries a whole number.
-- A removal or leaving within 5 minutes of the same person's STOP is the
-- removal that STOP made (the webhook records the STOP before asking
-- Meta to remove them): the STOP's note says it, so it posts none.
-- Fail-open: a note that cannot be posted (internal chat off: CH001, an
-- archived channel: 42501, no channel: P0002, anything else) is a
-- WARNING, and never undoes the change it describes.
CREATE OR REPLACE FUNCTION public.deal_room_audit_team_note()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_r    public.deal_rooms;
  v_p    public.deal_room_participants;
  v_pid  uuid;
  v_wa   text;
  v_who  text;
  v_body text;
  v_live boolean;
BEGIN
  IF NEW.action NOT IN ('participant_joined','participant_unlisted','participant_left','participant_removed',
                        'join_request','participant_opted_out','status_changed') THEN
    RETURN NULL;
  END IF;
  BEGIN
    SELECT * INTO v_r FROM public.deal_rooms WHERE id = NEW.room_id;
    v_live := v_r.status NOT IN ('closing','closed');
    IF NEW.detail->>'participant_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_pid := (NEW.detail->>'participant_id')::uuid;
    END IF;
    v_wa := NEW.detail->>'wa_id';
    IF NEW.action = 'join_request' THEN
      SELECT j.wa_id INTO v_wa FROM public.deal_room_join_requests j
       WHERE j.room_id = NEW.room_id AND j.join_request_id = NEW.detail->>'join_request_id';
    END IF;
    IF v_pid IS NULL AND v_wa IS NOT NULL THEN
      v_pid := public.deal_room_find_participant(NEW.room_id, v_wa);
    END IF;
    IF v_pid IS NOT NULL THEN
      SELECT * INTO v_p FROM public.deal_room_participants WHERE id = v_pid AND room_id = NEW.room_id;
    END IF;
    v_who := CASE
      WHEN v_p.id IS NULL
        THEN 'Unlisted number' || coalesce(' ending ' || right(nullif(regexp_replace(coalesce(v_wa, ''), '\D', '', 'g'), ''), 2), '')
      WHEN NOT v_p.expected
           OR (v_p.phone IS NOT NULL AND strpos(regexp_replace(v_p.display_name, '\D', '', 'g'), v_p.phone) > 0)
        THEN 'Unlisted number' || coalesce(' ending ' || right(v_p.phone, 2), '')
      ELSE v_p.display_name
    END;
    v_body := CASE
      WHEN v_p.role = 'business' THEN NULL   -- our own number
      WHEN NEW.action IN ('participant_left','participant_removed') AND EXISTS (
             SELECT 1 FROM public.deal_room_audit o
              WHERE o.room_id = NEW.room_id AND o.action = 'participant_opted_out'
                AND o.at > NEW.at - interval '5 minutes'
                AND public.deal_room_find_participant(NEW.room_id, o.detail->>'wa_id') = v_p.id)
        THEN NULL
      WHEN NEW.action IN ('participant_joined','participant_unlisted') AND v_live
        THEN '**' || v_who || '** joined the WhatsApp group.'
      WHEN NEW.action = 'participant_left' AND v_live
        THEN '**' || v_who || '** left the WhatsApp group.'
      WHEN NEW.action = 'participant_removed' AND v_live
        THEN '**' || v_who || '** was removed from the WhatsApp group.'
      WHEN NEW.action = 'join_request' AND NEW.detail->>'decision' = 'pending' AND v_r.status = 'open'
        THEN '**' || v_who || '** asked to join the WhatsApp group. A manager approves or rejects it in the room.'
      WHEN NEW.action = 'participant_opted_out'
        THEN '**' || v_who || '** wrote STOP and is removed from the WhatsApp group'
             || CASE WHEN NEW.detail->'opted_out' = 'true'::jsonb THEN '; their contact is marked opted out.'
                     WHEN NEW.detail->'contact_found' = 'true'::jsonb
                       THEN '; their contact could not be marked opted out.'
                     ELSE '; no contact of theirs was found to mark opted out.' END
      WHEN NEW.action = 'status_changed' AND NEW.detail->>'to' = 'suspended'
        THEN 'WhatsApp suspended this group. Nothing can be sent until WhatsApp clears it.'
      WHEN NEW.action = 'status_changed' AND NEW.detail->>'to' = 'open' AND NEW.detail->>'from' = 'suspended'
        THEN 'WhatsApp cleared the suspension. The group is open again.'
      WHEN NEW.action = 'status_changed' AND NEW.detail->>'to' = 'closed'
        THEN 'This deal room was closed.'
    END;
    IF v_body IS NOT NULL THEN
      PERFORM public.chat_post_system_message(v_r.channel_id, v_body,
        jsonb_build_object('deal_room_event', NEW.action, 'room_id', NEW.room_id, 'audit_id', NEW.id));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'deal rooms: team note not posted (%): %', SQLSTATE, SQLERRM;
  END;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION public.deal_room_audit_team_note() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS deal_room_audit_team_note ON public.deal_room_audit;
CREATE TRIGGER deal_room_audit_team_note AFTER INSERT ON public.deal_room_audit
  FOR EACH ROW EXECUTE FUNCTION public.deal_room_audit_team_note();
