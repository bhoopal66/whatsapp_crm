-- ============================================================
-- 254_funnel_report.sql — the sales funnel report (Reports → Funnel).
--
-- funnel_report(p_from, p_to, p_tz, p_lead_source, p_agent, p_bank,
-- p_channel) returns the whole page as one jsonb, like
-- team_activity_report (one round trip: the page sits behind a tunnel).
-- Owners and admins only, of the caller's ACTIVE account.
--
-- The stages are a COHORT: the company chats that STARTED in
-- [p_from, p_to), followed to wherever they have got by now.
--
--   new_chats   company chats (personal_owner_id IS NULL) created in
--               the period.
--   interested  of those, chats whose main chat tag is the account's
--               "Interested" tag (a main tag named Interested, any
--               case), or that ever arrived at it (chat_tag_history,
--               migration 255, when present), or whose contact has a
--               case (a case opens at Interested, so it implies it).
--   case_opened of those, contacts with a case (a lead, migration 130,
--               or a submitted case) opened at or after the chat began.
--   submitted   of those, a case that left the pre-submission stages:
--               it has a submission group, or a stage-history row into
--               a stage that is not pre-submission, Withdrawn or
--               Closed, or an Approved / Declined outcome.
--   approved    of those, a case with outcome Approved.
--   declined    a case with outcome Declined (beside the funnel).
--   withdrawn   a case with outcome Withdrawn (beside the funnel).
--
-- A contact counts once per stage however many cases it has. Filters:
-- p_lead_source = contacts.lead_source ('none' = no source recorded),
-- p_agent = conversations.assigned_agent_id (an auth user id),
-- p_channel = conversations.channel_id, p_bank = cases.bank_code (the
-- case stages only: a chat has no bank). docs/funnel-report.md is the
-- contract; change both together.
--
-- Re-runnable: CREATE OR REPLACE, REVOKE/GRANT.
-- ============================================================

CREATE INDEX IF NOT EXISTS conversations_account_created_idx
  ON public.conversations (account_id, created_at)
  WHERE personal_owner_id IS NULL;

CREATE INDEX IF NOT EXISTS cases_account_contact_idx
  ON public.cases (account_id, contact_id)
  WHERE contact_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.funnel_report(
  p_from        timestamptz,
  p_to          timestamptz,
  p_tz          text DEFAULT 'UTC',
  p_lead_source text DEFAULT NULL,
  p_agent       uuid DEFAULT NULL,
  p_bank        text DEFAULT NULL,
  p_channel     uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account    uuid := public.current_account_id();
  v_tz         text := coalesce(nullif(p_tz, ''), 'UTC');
  v_interested uuid;
  v_history    boolean := to_regclass('public.chat_tag_history') IS NOT NULL;
  v_result     jsonb;
BEGIN
  IF v_account IS NULL OR public.current_role_rank() < 4 THEN
    RAISE EXCEPTION 'Only owners and admins can open the funnel report'
      USING ERRCODE = '42501', HINT = 'NOT_ALLOWED';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from THEN
    RAISE EXCEPTION 'The period is not valid'
      USING ERRCODE = '22023', HINT = 'BAD_RANGE';
  END IF;
  IF p_to - p_from > interval '400 days' THEN
    RAISE EXCEPTION 'The period is longer than 400 days'
      USING ERRCODE = '22023', HINT = 'BAD_RANGE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = v_tz) THEN
    v_tz := 'UTC';
  END IF;
  IF p_lead_source IS NOT NULL AND p_lead_source NOT IN (
       'none', 'ad', 'web_form', 'broadcast', 'manual', 'import', 'compass', 'other') THEN
    RAISE EXCEPTION 'Unknown lead source'
      USING ERRCODE = '22023', HINT = 'BAD_FILTER';
  END IF;

  SELECT t.id INTO v_interested
    FROM public.chat_tags t
   WHERE t.account_id = v_account
     AND t.parent_id IS NULL
     AND lower(t.name) = 'interested'
   ORDER BY t.position, t.created_at
   LIMIT 1;

  WITH base AS (
    SELECT c.id AS conversation_id,
           c.contact_id,
           c.created_at,
           c.channel_id,
           c.assigned_agent_id,
           c.chat_tag_id,
           coalesce(ct.lead_source, 'none') AS lead_source
      FROM public.conversations c
      JOIN public.contacts ct ON ct.id = c.contact_id
     WHERE c.account_id = v_account
       AND c.personal_owner_id IS NULL
       AND c.created_at >= p_from
       AND c.created_at <  p_to
       AND (p_channel IS NULL OR c.channel_id = p_channel)
       AND (p_agent IS NULL OR c.assigned_agent_id = p_agent)
       AND (p_lead_source IS NULL OR coalesce(ct.lead_source, 'none') = p_lead_source)
  ),
  kase AS (
    -- Every case of a base contact opened once its chat had begun.
    SELECT b.conversation_id,
           k.bank_code,
           k.outcome,
           (k.group_id IS NOT NULL
             OR k.outcome IN ('Approved', 'Declined')
             OR EXISTS (
               SELECT 1 FROM public.case_stage_history h
                WHERE h.case_id = k.id
                  AND h.account_id = v_account
                  AND NOT public.case_stage_is_presub(h.to_stage)
                  AND h.to_stage NOT IN ('Withdrawn', 'Closed'))) AS submitted
      FROM base b
      JOIN public.cases k
        ON k.account_id = v_account
       AND k.contact_id = b.contact_id
       AND k.opened_at >= b.created_at
     WHERE (p_bank IS NULL OR k.bank_code = p_bank)
  ),
  per_chat AS (
    SELECT b.*,
           EXISTS (SELECT 1 FROM kase k WHERE k.conversation_id = b.conversation_id) AS has_case,
           EXISTS (SELECT 1 FROM kase k WHERE k.conversation_id = b.conversation_id AND k.submitted) AS is_submitted,
           EXISTS (SELECT 1 FROM kase k WHERE k.conversation_id = b.conversation_id AND k.outcome = 'Approved') AS is_approved,
           EXISTS (SELECT 1 FROM kase k WHERE k.conversation_id = b.conversation_id AND k.outcome = 'Declined') AS is_declined,
           EXISTS (SELECT 1 FROM kase k WHERE k.conversation_id = b.conversation_id AND k.outcome = 'Withdrawn') AS is_withdrawn,
           (v_interested IS NOT NULL AND b.chat_tag_id = v_interested) AS tagged_now
      FROM base b
  ),
  staged AS (
    SELECT p.*,
           (p.tagged_now OR p.has_case OR (
              v_history AND v_interested IS NOT NULL
              AND public.funnel_chat_reached_tag(p.conversation_id, v_interested)
           )) AS is_interested
      FROM per_chat p
  )
  SELECT jsonb_build_object(
    'interested_tag_id', v_interested,
    'tag_history', v_history,
    'totals', (
      SELECT jsonb_build_object(
        'new_chats',   count(*),
        'interested',  count(*) FILTER (WHERE is_interested),
        'case_opened', count(*) FILTER (WHERE has_case),
        'submitted',   count(*) FILTER (WHERE is_submitted),
        'approved',    count(*) FILTER (WHERE is_approved),
        'declined',    count(*) FILTER (WHERE is_declined),
        'withdrawn',   count(*) FILTER (WHERE is_withdrawn))
      FROM staged),
    'by_source', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'key', s.lead_source,
               'new_chats', s.n, 'interested', s.i, 'case_opened', s.c,
               'submitted', s.s, 'approved', s.a, 'declined', s.d,
               'withdrawn', s.w) ORDER BY s.n DESC, s.lead_source)
        FROM (SELECT lead_source, count(*) n,
                     count(*) FILTER (WHERE is_interested) i,
                     count(*) FILTER (WHERE has_case) c,
                     count(*) FILTER (WHERE is_submitted) s,
                     count(*) FILTER (WHERE is_approved) a,
                     count(*) FILTER (WHERE is_declined) d,
                     count(*) FILTER (WHERE is_withdrawn) w
                FROM staged GROUP BY lead_source) s), '[]'::jsonb),
    'by_agent', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'key', s.agent, 'name', s.name,
               'new_chats', s.n, 'interested', s.i, 'case_opened', s.c,
               'submitted', s.s, 'approved', s.a, 'declined', s.d,
               'withdrawn', s.w) ORDER BY s.n DESC, s.name NULLS LAST)
        FROM (SELECT st.assigned_agent_id AS agent,
                     (SELECT pr.full_name FROM public.profiles pr
                       WHERE pr.user_id = st.assigned_agent_id
                         AND pr.account_id = v_account) AS name,
                     count(*) n,
                     count(*) FILTER (WHERE is_interested) i,
                     count(*) FILTER (WHERE has_case) c,
                     count(*) FILTER (WHERE is_submitted) s,
                     count(*) FILTER (WHERE is_approved) a,
                     count(*) FILTER (WHERE is_declined) d,
                     count(*) FILTER (WHERE is_withdrawn) w
                FROM staged st GROUP BY st.assigned_agent_id) s), '[]'::jsonb),
    'by_number', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'key', s.channel, 'name', s.name,
               'new_chats', s.n, 'interested', s.i, 'case_opened', s.c,
               'submitted', s.s, 'approved', s.a, 'declined', s.d,
               'withdrawn', s.w) ORDER BY s.n DESC, s.name NULLS LAST)
        FROM (SELECT st.channel_id AS channel,
                     (SELECT coalesce(nullif(w.label, ''), w.waba_id)
                        FROM public.whatsapp_config w
                       WHERE w.id = st.channel_id
                         AND w.account_id = v_account) AS name,
                     count(*) n,
                     count(*) FILTER (WHERE is_interested) i,
                     count(*) FILTER (WHERE has_case) c,
                     count(*) FILTER (WHERE is_submitted) s,
                     count(*) FILTER (WHERE is_approved) a,
                     count(*) FILTER (WHERE is_declined) d,
                     count(*) FILTER (WHERE is_withdrawn) w
                FROM staged st GROUP BY st.channel_id) s), '[]'::jsonb),
    'by_bank', coalesce((
      -- Case stages only, per bank; a contact counts once per bank.
      SELECT jsonb_agg(jsonb_build_object(
               'key', s.bank_code, 'name', s.name,
               'case_opened', s.c, 'submitted', s.s, 'approved', s.a,
               'declined', s.d, 'withdrawn', s.w) ORDER BY s.c DESC, s.bank_code NULLS LAST)
        FROM (SELECT k.bank_code,
                     (SELECT cb.name FROM public.case_banks cb
                       WHERE cb.account_id = v_account AND cb.code = k.bank_code) AS name,
                     count(DISTINCT k.conversation_id) c,
                     count(DISTINCT k.conversation_id) FILTER (WHERE k.submitted) s,
                     count(DISTINCT k.conversation_id) FILTER (WHERE k.outcome = 'Approved') a,
                     count(DISTINCT k.conversation_id) FILTER (WHERE k.outcome = 'Declined') d,
                     count(DISTINCT k.conversation_id) FILTER (WHERE k.outcome = 'Withdrawn') w
                FROM kase k GROUP BY k.bank_code) s), '[]'::jsonb),
    'daily', coalesce((
      SELECT jsonb_agg(jsonb_build_object('day', s.day, 'new_chats', s.n,
               'interested', s.i, 'case_opened', s.c) ORDER BY s.day)
        FROM (SELECT to_char((created_at AT TIME ZONE v_tz)::date, 'YYYY-MM-DD') AS day,
                     count(*) n,
                     count(*) FILTER (WHERE is_interested) i,
                     count(*) FILTER (WHERE has_case) c
                FROM staged GROUP BY 1) s), '[]'::jsonb),
    'options', jsonb_build_object(
      'agents', coalesce((
        SELECT jsonb_agg(jsonb_build_object('id', pr.user_id, 'name', pr.full_name)
                         ORDER BY pr.full_name)
          FROM public.profiles pr
         WHERE pr.account_id = v_account
           AND pr.account_role IN ('owner', 'admin', 'team_leader', 'agent')), '[]'::jsonb),
      'numbers', coalesce((
        SELECT jsonb_agg(jsonb_build_object('id', w.id,
                 'name', coalesce(nullif(w.label, ''), w.waba_id)) ORDER BY w.created_at)
          FROM public.whatsapp_config w
         WHERE w.account_id = v_account
           AND NOT coalesce(w.is_personal, false)), '[]'::jsonb),
      'banks', coalesce((
        SELECT jsonb_agg(jsonb_build_object('id', cb.code, 'name', cb.name) ORDER BY cb.name)
          FROM public.case_banks cb
         WHERE cb.account_id = v_account), '[]'::jsonb))
  ) INTO v_result
  FROM (SELECT 1) one;

  RETURN v_result;
END;
$$;

-- Did this chat ever arrive at the tag? Reads 255's log behind a
-- to_regclass guard (dynamic SQL), so 254 applies before 255 and keeps
-- working if 255 is never applied.
CREATE OR REPLACE FUNCTION public.funnel_chat_reached_tag(p_conversation uuid, p_tag uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_hit boolean := false;
BEGIN
  IF to_regclass('public.chat_tag_history') IS NULL THEN
    RETURN false;
  END IF;
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.chat_tag_history h
                           WHERE h.conversation_id = $1 AND h.to_tag_id = $2)'
     INTO v_hit USING p_conversation, p_tag;
  RETURN coalesce(v_hit, false);
END;
$$;

REVOKE ALL ON FUNCTION public.funnel_report(timestamptz, timestamptz, text, text, uuid, text, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.funnel_report(timestamptz, timestamptz, text, text, uuid, text, uuid)
  TO authenticated;
REVOKE ALL ON FUNCTION public.funnel_chat_reached_tag(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
