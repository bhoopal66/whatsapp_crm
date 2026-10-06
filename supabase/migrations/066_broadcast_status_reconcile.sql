-- ============================================================
-- 066_broadcast_status_reconcile
--
-- Replays Meta's delivery receipts from the cost ledger (migration
-- 051, `whatsapp_message_costs`) onto broadcast recipients the live
-- status handler could not match.
--
-- ─── Why ───────────────────────────────────────────────────────────
--
-- The status webhook finds a recipient by `whatsapp_message_id`, and
-- that id is stamped on the row only after Meta has accepted the send.
-- A receipt that beats the stamp matches nothing and is gone: Meta got
-- its 200 and never redelivers. Campaigns sent from the old browser
-- loop lost 330 receipts this way (266 of them failures), so the
-- dashboard showed 1-4 failed where 46-176 had failed, those contacts
-- counted as messaged for the frequency cap, and a later reply from
-- any of them would be credited to a campaign they never received.
--
-- The ledger keeps every raw receipt regardless, keyed by the same
-- wamid, so the lost ones can be applied after the fact. The app calls
-- this at the end of every delivery pass and on every tick of the
-- broadcast cron (both tolerate it not existing yet).
--
-- ─── Rules ─────────────────────────────────────────────────────────
--
--   * Only rows still at 'sent' move, and only forward: to delivered,
--     read, or failed. The live handler's ladder (pending → sent →
--     delivered → read → replied, failed only from pending/sent) is
--     re-checked in the UPDATE's own WHERE, so a receipt the webhook
--     applies meanwhile wins and a replied row is never touched.
--   * Precedence when a wamid has several receipts: failed > read >
--     delivered.
--   * A failed row gets its reason from `describe_meta_failure`, the
--     SQL mirror of src/lib/whatsapp/meta-failure.ts (change one,
--     change both; meta-failure.test.ts compares them). Failed rows
--     whose reason was never stored get it filled in too.
--   * Tenancy: a ledger row applies only to a recipient of a broadcast
--     in the same account. A wamid is only as unique as its gateway.
--   * A campaign left 'sent' whose every recipient has now failed
--     becomes 'failed', the rule finalizeBroadcastStatus applies at the
--     end of a pass.
--   * Scoped to recipients sent within `p_since` (default two days), so
--     the per-minute cron stays cheap. Run once by hand with a wider
--     window to repair older campaigns:
--       SELECT public.reconcile_broadcast_recipient_statuses(NULL, '60 days');
--
-- Meta only: Whapi receipts carry no ledger.
--
-- Idempotent — safe to re-run.
-- ============================================================

SET lock_timeout = '5s';

-- The reconcile probes the ledger by wamid; its only unique index
-- leads with phone_number_id.
CREATE INDEX IF NOT EXISTS idx_whatsapp_message_costs_message
  ON public.whatsapp_message_costs (message_id);

-- ============================================================
-- 1. describe_meta_failure — SQL mirror of describeMetaFailure()
-- ============================================================

CREATE OR REPLACE FUNCTION public.describe_meta_failure(
  p_code    text,
  p_title   text,
  p_details text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE nullif(btrim(p_code), '')
    WHEN '131049' THEN 'Meta is limiting marketing messages to this person to keep engagement healthy. Do not retry soon. (Meta 131049)'
    WHEN '131026' THEN 'Undeliverable: the number is not on WhatsApp, runs an old app version, or has not accepted the latest terms. (Meta 131026)'
    WHEN '130472' THEN 'Not delivered: the person is in a Meta marketing experiment that holds back some messages. (Meta 130472)'
    WHEN '131047' THEN 'The 24-hour service window is closed. Send an approved template instead. (Meta 131047)'
    WHEN '131031' THEN 'The WhatsApp Business Account is locked. Check WhatsApp Manager for restrictions or pending verification. (Meta 131031)'
    ELSE CASE
      WHEN nullif(btrim(p_code), '') IS NOT NULL
       AND coalesce(nullif(btrim(p_title), ''), nullif(btrim(p_details), '')) IS NOT NULL
        THEN format('Meta %s: %s', btrim(p_code),
                    coalesce(nullif(btrim(p_title), ''), nullif(btrim(p_details), '')))
      WHEN nullif(btrim(p_code), '') IS NOT NULL
        THEN 'Meta ' || btrim(p_code)
      WHEN coalesce(nullif(btrim(p_title), ''), nullif(btrim(p_details), '')) IS NOT NULL
        THEN 'Meta: ' || coalesce(nullif(btrim(p_title), ''), nullif(btrim(p_details), ''))
      ELSE 'Meta reported the message as failed without giving a reason.'
    END
  END
$$;

ALTER FUNCTION public.describe_meta_failure(text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.describe_meta_failure(text, text, text) FROM PUBLIC, anon, authenticated;

-- ============================================================
-- 2. reconcile_broadcast_recipient_statuses
-- ============================================================

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
     WHERE r.status = 'sent'
       AND r.sent_at > now() - p_since
       AND (p_broadcast_id IS NULL OR r.broadcast_id = p_broadcast_id)
       AND c.status IN ('delivered', 'read', 'failed')
  ),
  best AS (
    SELECT account_id,
           message_id,
           max(CASE status WHEN 'failed' THEN 3 WHEN 'read' THEN 2 ELSE 1 END) AS lvl,
           min(at) FILTER (WHERE status = 'delivered') AS delivered_at,
           min(at) FILTER (WHERE status = 'read') AS read_at,
           (array_agg(err ORDER BY at) FILTER (WHERE status = 'failed'))[1] AS err
      FROM receipts
     GROUP BY account_id, message_id
  ),
  changed AS (
    UPDATE public.broadcast_recipients r
       SET status = CASE best.lvl WHEN 3 THEN 'failed' WHEN 2 THEN 'read' ELSE 'delivered' END,
           error_message = CASE
             WHEN best.lvl = 3 THEN public.describe_meta_failure(
               best.err->>'code',
               best.err->>'title',
               best.err->'error_data'->>'details'
             )
             ELSE r.error_message
           END,
           delivered_at = CASE
             WHEN best.lvl IN (1, 2)
               THEN coalesce(r.delivered_at, best.delivered_at, best.read_at)
             ELSE r.delivered_at
           END,
           read_at = CASE
             WHEN best.lvl = 2 THEN coalesce(r.read_at, best.read_at)
             ELSE r.read_at
           END
      FROM public.broadcasts b, best
     WHERE b.id = r.broadcast_id
       AND best.account_id = b.account_id
       AND best.message_id = r.whatsapp_message_id
       -- Re-checked at write time: a live receipt may have moved the
       -- row since the CTE read it, and it wins.
       AND r.status = 'sent'
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

  RETURN v_moved + v_reasons;
END
$$;

ALTER FUNCTION public.reconcile_broadcast_recipient_statuses(uuid, interval) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reconcile_broadcast_recipient_statuses(uuid, interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_broadcast_recipient_statuses(uuid, interval) TO service_role;

RESET lock_timeout;
