-- ============================================================
-- 189_followups.sql — two follow-ups to 187 and 188, which are
-- already applied in production (so they are restated here, not
-- edited there).
--
-- 1. meta_cost_per_won_case (188). other_spend_usd summed with
--    coalesce(sum(cost_usd), 0), so a billed message with no rate on
--    file (cost NULL, 051) read as $0 and the figure was understated.
--    051's rule is that an unknown rate is NULL, never 0: other_spend_usd
--    is now NULL when any non-won message in the window has a NULL
--    cost, and 0 when there are no such messages, the way won_spend_usd
--    already was. Nothing else in the body changes.
--
-- 2. case_rule_validate (187).
--    (a) The days check cast (p_conditions ->> k)::int in an OR beside
--        the type and pattern tests; SQL does not promise OR
--        short-circuits, so a non-integer could reach the cast and
--        raise 22P02 instead of RULE_INVALID. The cast now sits in a
--        CASE that only reaches it once the type and pattern pass.
--    (b) amount_min / amount_max had no upper bound, and cases.amount
--        is numeric(18,2) (122): a bound above 9999999999999999.99 can
--        never match and is refused, with the numeric cast guarded the
--        same way. amount_min > amount_max can never match either and
--        is refused after the loop. Both refusals are RULE_INVALID,
--        the function's existing shape.
--
-- Signatures, volatility, SECURITY DEFINER (188's function only; 187's
-- validator never had it), search_path and privileges are exactly the
-- originals'. Re-runnable: CREATE OR REPLACE. Like 187 and 188, apply
-- as a superuser or BYPASSRLS role.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '189 must be applied by a superuser or BYPASSRLS role (its functions write RLS-forced tables and read cases)';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 1. Meta spend per won case: other spend is NULL when a rate is unknown
-- ------------------------------------------------------------

-- Meta spend per won case. Won = the account's cases with outcome
-- 'Approved' closed in [p_from, p_to). A won case's spend is the billed
-- cost (051: delivered, billable) of every Meta message to its customer
-- (cases.contact_id, else its submission group's contact) delivered up
-- to the case's win, however long before p_from. The link from a ledger
-- row to a customer is the message: ledger wamid -> messages.message_id
-- -> its conversation's contact, in the same account. other_spend_usd
-- is the billed cost delivered in the window that went to anyone else
-- or could not be linked (a deal-room group message has no messages
-- row). A customer with two won cases counts its spend once and both
-- cases. A billed message whose rate is unknown (cost NULL, 051) is
-- never counted as 0: it is reported in unknown_cost_messages, and one
-- such message on a won customer makes won_spend_usd and
-- cost_per_won_case_usd NULL (no rate on file) rather than understated;
-- one such message among the others makes other_spend_usd NULL (189).
CREATE OR REPLACE FUNCTION public.meta_cost_per_won_case(p_account uuid, p_from timestamptz, p_to timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v jsonb;
BEGIN
  IF p_account IS NULL OR p_from IS NULL OR p_to IS NULL OR p_from >= p_to THEN
    RAISE EXCEPTION 'RANGE_INVALID: an account and a range with from before to are required'
      USING ERRCODE = 'check_violation', HINT = 'RANGE_INVALID';
  END IF;
  WITH won AS (
    SELECT c.id, coalesce(c.contact_id, g.contact_id) AS contact_id, c.closed_at
      FROM public.cases c
      LEFT JOIN public.submission_groups g ON g.id = c.group_id AND g.account_id = c.account_id
     WHERE c.account_id = p_account AND c.outcome = 'Approved'
       AND c.closed_at >= p_from AND c.closed_at < p_to
  ), won_contacts AS (
    SELECT w.contact_id, max(w.closed_at) AS won_at
      FROM won w WHERE w.contact_id IS NOT NULL GROUP BY w.contact_id
  ), billed AS (
    SELECT l.id, l.cost_usd, l.delivered_at,
           (SELECT v.contact_id
              FROM public.messages m
              JOIN public.conversations v ON v.id = m.conversation_id
             WHERE m.message_id = l.message_id AND v.account_id = l.account_id
             ORDER BY m.created_at, m.id
             LIMIT 1) AS contact_id
      FROM public.whatsapp_message_costs l
     WHERE l.account_id = p_account AND l.status = 'delivered' AND l.billable
       AND l.delivered_at < p_to
  ), tagged AS (
    SELECT b.*, (wc.contact_id IS NOT NULL) AS for_won,
           (b.delivered_at >= p_from) AS in_window
      FROM billed b
      LEFT JOIN won_contacts wc ON wc.contact_id = b.contact_id AND b.delivered_at <= wc.won_at
  ), won_spend AS (
    -- NULL, never a partial sum, when any won-case message has no rate
    -- (051: unknown rates are NULL, never 0); 0 when there is none.
    SELECT CASE WHEN bool_or(t.cost_usd IS NULL) THEN NULL
                ELSE coalesce(sum(t.cost_usd), 0) END AS usd
      FROM tagged t WHERE t.for_won
  ), other_spend AS (
    -- The same rule for everything else in the window (189).
    SELECT CASE WHEN bool_or(t.cost_usd IS NULL) THEN NULL
                ELSE coalesce(sum(t.cost_usd), 0) END AS usd
      FROM tagged t WHERE NOT t.for_won AND t.in_window
  )
  SELECT jsonb_build_object(
           'won_cases', (SELECT count(*) FROM won),
           'won_spend_usd', (SELECT ws.usd FROM won_spend ws),
           'cost_per_won_case_usd', CASE WHEN (SELECT count(*) FROM won) = 0 THEN NULL
             ELSE round((SELECT ws.usd FROM won_spend ws) / (SELECT count(*) FROM won), 6) END,
           'other_spend_usd', (SELECT os.usd FROM other_spend os),
           'unknown_cost_messages', (SELECT count(*) FROM tagged t
                                      WHERE t.cost_usd IS NULL AND (t.for_won OR t.in_window)))
    INTO v;
  RETURN v;
END;
$$;

REVOKE ALL ON FUNCTION
  public.meta_cost_per_won_case(uuid, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.meta_cost_per_won_case(uuid, timestamptz, timestamptz)
  TO service_role;

-- ------------------------------------------------------------
-- 2. Case rule conditions: guarded casts, amount bound, min <= max
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.case_rule_validate(p_trigger text, p_conditions jsonb, p_actions jsonb)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  a         jsonb;
  k         text;
  v_kind    text;
  v_allowed text[];
  v_uuid    text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  IF p_trigger IS NULL
     OR p_trigger NOT IN ('case_opened', 'stage_changed', 'sla_overdue', 'no_activity', 'submission_attached') THEN
    PERFORM public.case_rule_refuse(format('unknown trigger %s', p_trigger));
  END IF;
  IF p_conditions IS NULL OR jsonb_typeof(p_conditions) <> 'object' THEN
    PERFORM public.case_rule_refuse('conditions must be an object');
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_conditions) LOOP
    IF k IN ('bank_code', 'stage', 'product') THEN
      IF jsonb_typeof(p_conditions -> k) <> 'string' OR (p_conditions ->> k) ~ '^[[:space:]]*$'
         OR char_length(p_conditions ->> k) > 200 THEN
        PERFORM public.case_rule_refuse(format('condition %s must be 1..200 characters', k));
      END IF;
    ELSIF k IN ('amount_min', 'amount_max') THEN
      -- cases.amount is numeric(18,2) (122); the cast is reached only
      -- for a JSON number (189).
      -- Parenthesised: plpgsql ends an IF condition at the first bare THEN.
      IF (CASE WHEN jsonb_typeof(p_conditions -> k) <> 'number' THEN true
               ELSE (p_conditions ->> k)::numeric NOT BETWEEN 0 AND 9999999999999999.99 END) THEN
        PERFORM public.case_rule_refuse(format('condition %s must be a number 0..9999999999999999.99', k));
      END IF;
    ELSIF k = 'pre_submission' THEN
      IF jsonb_typeof(p_conditions -> k) <> 'boolean' THEN
        PERFORM public.case_rule_refuse('condition pre_submission must be true or false');
      END IF;
    ELSIF k = 'days' THEN
      IF p_trigger <> 'no_activity' THEN
        PERFORM public.case_rule_refuse('condition days is for no_activity only');
      END IF;
      -- The cast is reached only once the type and pattern pass (189).
      IF (CASE WHEN jsonb_typeof(p_conditions -> k) <> 'number' OR (p_conditions ->> k) !~ '^[0-9]{1,3}$' THEN true
               ELSE (p_conditions ->> k)::int NOT BETWEEN 1 AND 365 END) THEN
        PERFORM public.case_rule_refuse('condition days must be an integer 1..365');
      END IF;
    ELSE
      PERFORM public.case_rule_refuse(format('unknown condition %s', k));
    END IF;
  END LOOP;
  IF p_trigger = 'no_activity' AND NOT (p_conditions ? 'days') THEN
    PERFORM public.case_rule_refuse('no_activity needs days');
  END IF;
  -- Both bounds passed the loop, so both are numbers here (189).
  IF p_conditions ? 'amount_min' AND p_conditions ? 'amount_max'
     AND (p_conditions ->> 'amount_min')::numeric > (p_conditions ->> 'amount_max')::numeric THEN
    PERFORM public.case_rule_refuse('condition amount_min must not exceed amount_max');
  END IF;

  IF p_actions IS NULL OR jsonb_typeof(p_actions) <> 'array'
     OR jsonb_array_length(p_actions) NOT BETWEEN 1 AND 5 THEN
    PERFORM public.case_rule_refuse('actions must be an array of 1..5');
  END IF;
  FOR a IN SELECT x FROM jsonb_array_elements(p_actions) x LOOP
    IF jsonb_typeof(a) <> 'object' OR jsonb_typeof(a -> 'kind') IS DISTINCT FROM 'string' THEN
      PERFORM public.case_rule_refuse('an action is an object with a string kind');
    END IF;
    v_kind := a ->> 'kind';
    v_allowed := CASE v_kind
      WHEN 'assign_coordinator' THEN ARRAY['kind', 'userId']
      WHEN 'assign_agent'       THEN ARRAY['kind', 'userId']
      WHEN 'add_note'           THEN ARRAY['kind', 'body']
      WHEN 'set_priority'       THEN ARRAY['kind', 'priority']
    END;
    IF v_allowed IS NULL THEN
      PERFORM public.case_rule_refuse(format('unknown action %s', v_kind));
    END IF;
    FOR k IN SELECT jsonb_object_keys(a) LOOP
      IF NOT (k = ANY (v_allowed)) THEN
        PERFORM public.case_rule_refuse(format('unknown key %s for %s', k, v_kind));
      END IF;
    END LOOP;
    IF v_kind IN ('assign_coordinator', 'assign_agent') THEN
      IF jsonb_typeof(a -> 'userId') IS DISTINCT FROM 'string' OR (a ->> 'userId') !~ v_uuid THEN
        PERFORM public.case_rule_refuse(format('%s needs a userId (a uuid)', v_kind));
      END IF;
    ELSIF v_kind = 'add_note' THEN
      IF jsonb_typeof(a -> 'body') IS DISTINCT FROM 'string' OR (a ->> 'body') ~ '^[[:space:]]*$'
         OR char_length(a ->> 'body') > 4000 THEN
        PERFORM public.case_rule_refuse('body must be 1..4000 characters');
      END IF;
    ELSIF v_kind = 'set_priority' THEN
      IF jsonb_typeof(a -> 'priority') IS DISTINCT FROM 'string'
         OR (a ->> 'priority') NOT IN ('low', 'normal', 'high', 'urgent') THEN
        PERFORM public.case_rule_refuse('priority must be low, normal, high or urgent');
      END IF;
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION
  public.case_rule_validate(text, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
