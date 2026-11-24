-- ============================================================
-- 291_delivery_corrects_failed.sql
--
-- A gateway may report an ack error for a message, retry it and deliver
-- it. 'failed' was terminal, so the later 'delivered' / 'read' was
-- ignored: staff sent the message again, and a campaign's "Retry failed"
-- could pick it up. `delivered` and `read` (never `sent`) now correct
-- `failed`, and the stored failure text goes. The app's half is
-- MESSAGE_STATUS_PREDECESSORS / RECIPIENT_STATUS_PREDECESSORS in
-- src/lib/whatsapp/inbound-pipeline.ts. SQL mirrors:
--
--   1. reconcile_broadcast_recipient_statuses (restates 066): a delivery
--      in the ledger beats a failure there, in either order, and moves a
--      'failed' recipient; its campaign goes back from 'failed' to 'sent'.
--   2. hr_automsg_delivery_apply (restates 226).
--
-- Unchanged, checked: broadcast_recipient_aggregate_trigger (005) already
-- subtracts the old status and adds the new one, so failed_count falls.
--
-- Re-runnable. Re-running 066 or 226 reverts it: apply 291 again after.
-- Privileges are kept by CREATE OR REPLACE.
-- ============================================================

-- 1. Campaign recipients (restates 066)

CREATE OR REPLACE FUNCTION public.reconcile_broadcast_recipient_statuses(
  p_broadcast_id uuid DEFAULT NULL,
  p_since        interval DEFAULT '2 days'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_bids    uuid[];
  v_moved   integer := 0;
  v_reasons integer := 0;
BEGIN
  WITH receipts AS (
    SELECT c.account_id,
           c.message_id,
           c.status,
           -- Meta's own event time. A garbled one falls back to when the
           -- ledger saw it rather than failing every cron tick.
           CASE WHEN c.raw_status->>'timestamp' ~ '^[0-9]{1,12}$'
                THEN to_timestamp((c.raw_status->>'timestamp')::bigint)
                ELSE c.created_at
           END AS at,
           c.raw_status->'errors'->0 AS err
      FROM public.broadcast_recipients r
      JOIN public.broadcasts b
        ON b.id = r.broadcast_id
      JOIN public.whatsapp_message_costs c
        ON c.message_id = r.whatsapp_message_id
       AND c.account_id = b.account_id
     WHERE r.status IN ('sent', 'failed')
       AND r.sent_at > now() - p_since
       AND (p_broadcast_id IS NULL OR r.broadcast_id = p_broadcast_id)
       AND c.status IN ('delivered', 'read', 'failed')
  ),
  best AS (
    SELECT account_id,
           message_id,
           -- A delivery beats a failure, whichever came first (291).
           max(CASE status WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 ELSE 1 END) AS lvl,
           min(at) FILTER (WHERE status = 'delivered') AS delivered_at,
           min(at) FILTER (WHERE status = 'read') AS read_at,
           (array_agg(err ORDER BY at) FILTER (WHERE status = 'failed'))[1] AS err
      FROM receipts
     GROUP BY account_id, message_id
  ),
  changed AS (
    UPDATE public.broadcast_recipients r
       SET status = CASE best.lvl WHEN 3 THEN 'read' WHEN 2 THEN 'delivered' ELSE 'failed' END,
           error_message = CASE
             WHEN best.lvl = 1 THEN public.describe_meta_failure(
               best.err->>'code',
               best.err->>'title',
               best.err->'error_data'->>'details'
             )
             ELSE NULL
           END,
           delivered_at = CASE
             WHEN best.lvl IN (2, 3)
               THEN coalesce(r.delivered_at, best.delivered_at, best.read_at)
             ELSE r.delivered_at
           END,
           read_at = CASE
             WHEN best.lvl = 3 THEN coalesce(r.read_at, best.read_at)
             ELSE r.read_at
           END
      FROM public.broadcasts b, best
     WHERE b.id = r.broadcast_id
       AND best.account_id = b.account_id
       AND best.message_id = r.whatsapp_message_id
       -- Re-checked at write time: a live receipt may have moved the
       -- row since the CTE read it, and it wins.
       AND (r.status = 'sent' OR (r.status = 'failed' AND best.lvl > 1))
    RETURNING r.broadcast_id
  )
  SELECT coalesce(array_agg(DISTINCT broadcast_id), '{}'::uuid[]), count(*)
    INTO v_bids, v_moved
    FROM changed;

  -- Failures the live handler matched but, before its reason was
  -- stored, recorded as a bare 'failed'.
  UPDATE public.broadcast_recipients r
     SET error_message = public.describe_meta_failure(
           c.raw_status->'errors'->0->>'code',
           c.raw_status->'errors'->0->>'title',
           c.raw_status->'errors'->0->'error_data'->>'details'
         )
    FROM public.broadcasts b, public.whatsapp_message_costs c
   WHERE b.id = r.broadcast_id
     AND c.account_id = b.account_id
     AND c.message_id = r.whatsapp_message_id
     AND c.status = 'failed'
     AND r.status = 'failed'
     AND r.error_message IS NULL
     AND r.sent_at > now() - p_since
     AND (p_broadcast_id IS NULL OR r.broadcast_id = p_broadcast_id);
  GET DIAGNOSTICS v_reasons = ROW_COUNT;

  -- A separate statement, so it sees the rows moved above.
  IF cardinality(v_bids) > 0 THEN
    UPDATE public.broadcasts b
       SET status = 'failed', updated_at = now()
     WHERE b.id = ANY (v_bids)
       AND b.status = 'sent'
       AND EXISTS (
         SELECT 1 FROM public.broadcast_recipients r WHERE r.broadcast_id = b.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.broadcast_recipients r
          WHERE r.broadcast_id = b.id AND r.status <> 'failed'
       );
  END IF;

  -- 291: a campaign that read 'failed' because every recipient had, and
  -- one of them was delivered after all (settleBroadcastAfterCorrection).
  IF cardinality(v_bids) > 0 THEN
    UPDATE public.broadcasts b
       SET status = 'sent', updated_at = now()
     WHERE b.id = ANY (v_bids)
       AND b.status = 'failed'
       AND EXISTS (
         SELECT 1 FROM public.broadcast_recipients r
          WHERE r.broadcast_id = b.id AND r.status <> 'failed'
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.broadcast_recipients r
          WHERE r.broadcast_id = b.id AND r.status = 'pending'
       );
  END IF;

  RETURN v_moved + v_reasons;
END
$$;

-- 2. HR automated messages (restates 226)

CREATE OR REPLACE FUNCTION public.hr_automsg_delivery_apply(
  p_id uuid, p_state text, p_at timestamptz, p_reason text)
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
  v_by_receipt boolean;
BEGIN
  SELECT * INTO o FROM hr_automsg_outbox x WHERE x.id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'unknown_message'; END IF;
  v_by_receipt := o.status = 'failed' AND COALESCE(o.last_error, '') LIKE 'delivery\_failed:%';

  -- Only a delivery overwrites 'failed' (291): the provider reported an
  -- error, retried, and the message arrived. A row that report made
  -- terminal is sent again and its reason goes; one that failed for a
  -- reason of its own keeps its status. One UPDATE, so
  -- hr_automsg_outbox_catch_receipt sees the corrected state.
  IF o.delivery_state = 'failed' THEN
    IF p_state NOT IN ('delivered', 'read') THEN RETURN 'unchanged'; END IF;
    UPDATE hr_automsg_outbox x
       SET delivery_state = p_state,
           delivery_at = LEAST(COALESCE(p_at, now()), now() + interval '1 minute'),
           status = CASE WHEN v_by_receipt THEN 'sent' ELSE x.status END,
           last_error = CASE WHEN v_by_receipt THEN NULL ELSE x.last_error END,
           sent_at = CASE WHEN v_by_receipt THEN COALESCE(x.sent_at, p_at, now()) ELSE x.sent_at END,
           updated_at = now()
     WHERE x.id = o.id;
    IF v_by_receipt THEN
      PERFORM hr_automsg_log(o.account_id, 'outbox_delivery_corrected',
        jsonb_build_object('id', o.id, 'state', p_state, 'was', o.last_error));
    END IF;
    RETURN 'recorded';
  END IF;

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
