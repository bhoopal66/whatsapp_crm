-- ============================================================
-- 261_report_counting.sql — counting fixes for the two reports (254,
-- 255), from the Track F branch's last commit, which the release branch
-- had left out.
--
--  1. funnel_report (254) asked chat_tag_history once per chat of the
--     cohort (funnel_chat_reached_tag). It now reads the Interested
--     tag's log once, and the helper is dropped. An unlabelled Meta
--     number shows as unnamed: its waba_id is an account id, not a name.
--     RESTATES 254's body: apply in order, once.
--  2. chat_tag_report (255, restated by 256): an arrival is a change of
--     MAIN tag. Moving only the sub-tag (Interested · ADCB to
--     Interested · HSBC) counted as a second arrival at Interested, and
--     a chat seen under two sub-tags was counted twice. Each chat now
--     counts once per main tag, under its last sub-tag there. 256's rule
--     for an unlabelled number ("Unnamed number ending NN") is kept.
--     RESTATES 256's body: apply in order, once.
--
-- (The same commit's third fix, a report grant ending with its holder's
-- membership, is 256's profiles_drop_report_access.)
--
-- Apply as a superuser or BYPASSRLS role (both read RLS-forced tables as
-- their owner). Re-runnable. Asserted by verify-funnel-report.sql and
-- verify-chat-tag-report.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '261 must be applied by a superuser or BYPASSRLS role';
  END IF;
  IF to_regprocedure('public.profiles_drop_report_access()') IS NULL THEN
    RAISE EXCEPTION '261: apply 256_review_fixes.sql first';
  END IF;
END $$;

-- ---------- 1. The funnel: one read of the tag log ----------

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
  v_reached    uuid[] := '{}';
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

  -- Chats that ever arrived at the Interested tag since the period
  -- began, read once from 255's log behind a to_regclass guard
  -- (dynamic SQL), so 254 applies before 255 and works without it.
  IF v_history AND v_interested IS NOT NULL THEN
    EXECUTE 'SELECT coalesce(array_agg(DISTINCT h.conversation_id), ''{}'')
               FROM public.chat_tag_history h
              WHERE h.account_id = $1 AND h.to_tag_id = $2 AND h.changed_at >= $3'
       INTO v_reached USING v_account, v_interested, p_from;
  END IF;

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
           (v_interested IS NOT NULL AND b.chat_tag_id = v_interested) AS tagged_now,
           -- Interest ignores the bank filter: a case at any bank implies it.
           EXISTS (SELECT 1 FROM public.cases k2
                    WHERE k2.account_id = v_account
                      AND k2.contact_id = b.contact_id
                      AND k2.opened_at >= b.created_at) AS has_any_case
      FROM base b
  ),
  staged AS (
    SELECT p.*,
           (p.tagged_now OR p.has_any_case
            OR p.conversation_id = ANY (v_reached)) AS is_interested
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
                     (SELECT coalesce(nullif(w.label, ''),
                                      CASE WHEN w.provider <> 'meta' THEN w.waba_id END)
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
           AND pr.deactivated_at IS NULL
           AND pr.account_role IN ('owner', 'admin', 'team_leader', 'agent')), '[]'::jsonb),
      'numbers', coalesce((
        SELECT jsonb_agg(jsonb_build_object('id', w.id,
                 'name', coalesce(nullif(w.label, ''),
                                  CASE WHEN w.provider <> 'meta' THEN w.waba_id END))
               ORDER BY w.created_at)
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

DROP FUNCTION IF EXISTS public.funnel_chat_reached_tag(uuid, uuid);

REVOKE ALL ON FUNCTION public.funnel_report(timestamptz, timestamptz, text, text, uuid, text, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.funnel_report(timestamptz, timestamptz, text, text, uuid, text, uuid)
  TO authenticated;

-- ---------- 2. The tag report: true arrivals ----------

CREATE OR REPLACE FUNCTION public.chat_tag_report(
  p_from timestamptz,
  p_to   timestamptz,
  p_tz   text DEFAULT 'UTC'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid := public.current_account_id();
  v_tz      text := coalesce(nullif(p_tz, ''), 'UTC');
  v_since   timestamptz := public.chat_tag_history_since();
BEGIN
  IF v_account IS NULL OR NOT public.report_can_open('chat_tags') THEN
    RAISE EXCEPTION 'You do not have access to the chat tag report'
      USING ERRCODE = '42501', HINT = 'NOT_ALLOWED';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from
     OR p_to - p_from > interval '400 days' THEN
    RAISE EXCEPTION 'The period is not valid'
      USING ERRCODE = '22023', HINT = 'BAD_RANGE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = v_tz) THEN
    v_tz := 'UTC';
  END IF;

  RETURN (
    WITH chats AS (
      SELECT c.id, c.chat_tag_id, c.chat_sub_tag_id, c.assigned_agent_id,
             c.channel_id, coalesce(ct.lead_source, 'none') AS lead_source
        FROM public.conversations c
        JOIN public.contacts ct ON ct.id = c.contact_id
       WHERE c.account_id = v_account
         AND c.personal_owner_id IS NULL
         AND c.chat_tag_id IS NOT NULL
    ),
    moves AS (
      SELECT h.id, h.conversation_id, h.from_tag_id, h.to_tag_id,
             h.to_sub_tag_id, h.changed_at
        FROM public.chat_tag_history h
        JOIN public.conversations c ON c.id = h.conversation_id
       WHERE h.account_id = v_account
         AND c.account_id = v_account
         AND c.personal_owner_id IS NULL
         AND h.changed_at >= p_from
         AND h.changed_at <  p_to
         AND h.to_tag_id IS NOT NULL
    ),
    -- An arrival is a change of MAIN tag (a sub-tag-only move within the
    -- same main tag is not one). Each chat counts once per main tag,
    -- under the sub-tag it held at its last change at that tag in the
    -- period, so the sub-tag rows of a tag add up to its arrivals.
    -- One sort over the moves, not a lookup per move: the log only grows,
    -- and a per-row lookup took 7.3 s at 10,000 moves.
    placed AS (
      SELECT m.conversation_id, m.from_tag_id, m.to_tag_id,
             first_value(m.to_sub_tag_id) OVER (
               PARTITION BY m.conversation_id, m.to_tag_id
               ORDER BY m.changed_at DESC, m.id DESC) AS last_sub_tag_id
        FROM moves m
    ),
    arrived AS (
      SELECT DISTINCT ON (p.conversation_id, p.to_tag_id)
             p.conversation_id, p.to_tag_id,
             p.last_sub_tag_id AS to_sub_tag_id
        FROM placed p
       WHERE p.from_tag_id IS DISTINCT FROM p.to_tag_id
       ORDER BY p.conversation_id, p.to_tag_id
    )
    SELECT jsonb_build_object(
      'history_since', v_since,
      'tags', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
                 'id', t.id, 'parent_id', t.parent_id, 'name', t.name,
                 'color', t.color, 'sub_tag_title', t.sub_tag_title,
                 'position', t.position)
               ORDER BY t.parent_id NULLS FIRST, t.position, t.name)
          FROM public.chat_tags t WHERE t.account_id = v_account), '[]'::jsonb),
      'current', coalesce((
        SELECT jsonb_agg(jsonb_build_object('tag_id', s.chat_tag_id,
                 'sub_tag_id', s.chat_sub_tag_id, 'chats', s.n)
               ORDER BY s.n DESC)
          FROM (SELECT chat_tag_id, chat_sub_tag_id, count(*) n
                  FROM chats GROUP BY 1, 2) s), '[]'::jsonb),
      'by_agent', coalesce((
        SELECT jsonb_agg(jsonb_build_object('tag_id', s.chat_tag_id,
                 'key', s.agent, 'name', s.name, 'chats', s.n) ORDER BY s.n DESC)
          FROM (SELECT ch.chat_tag_id, ch.assigned_agent_id AS agent,
                       (SELECT pr.full_name FROM public.profiles pr
                         WHERE pr.user_id = ch.assigned_agent_id
                           AND pr.account_id = v_account) AS name,
                       count(*) n
                  FROM chats ch GROUP BY 1, 2) s), '[]'::jsonb),
      'by_number', coalesce((
        SELECT jsonb_agg(jsonb_build_object('tag_id', s.chat_tag_id,
                 'key', s.channel, 'name', s.name, 'chats', s.n) ORDER BY s.n DESC)
          FROM (SELECT ch.chat_tag_id, ch.channel_id AS channel,
                       (SELECT coalesce(nullif(btrim(w.label), ''),
                                       'Unnamed number' || coalesce(
                                         ' ending ' || nullif(right(regexp_replace(coalesce(w.waba_id, ''), '\D', '', 'g'), 2), ''),
                                         ''))
                          FROM public.whatsapp_config w
                         WHERE w.id = ch.channel_id AND w.account_id = v_account) AS name,
                       count(*) n
                  FROM chats ch GROUP BY 1, 2) s), '[]'::jsonb),
      'by_source', coalesce((
        SELECT jsonb_agg(jsonb_build_object('tag_id', s.chat_tag_id,
                 'key', s.lead_source, 'chats', s.n) ORDER BY s.n DESC)
          FROM (SELECT chat_tag_id, lead_source, count(*) n
                  FROM chats GROUP BY 1, 2) s), '[]'::jsonb),
      'arrivals', coalesce((
        -- Chats that arrived at each main tag in the period, once per
        -- chat however often it came back (see `arrived`).
        SELECT jsonb_agg(jsonb_build_object('tag_id', s.to_tag_id,
                 'sub_tag_id', s.to_sub_tag_id, 'chats', s.n) ORDER BY s.n DESC)
          FROM (SELECT to_tag_id, to_sub_tag_id, count(*) n
                  FROM arrived GROUP BY 1, 2) s), '[]'::jsonb),
      'arrivals_daily', coalesce((
        SELECT jsonb_agg(jsonb_build_object('day', s.day, 'tag_id', s.to_tag_id,
                 'chats', s.n) ORDER BY s.day)
          FROM (SELECT to_char((changed_at AT TIME ZONE v_tz)::date, 'YYYY-MM-DD') AS day,
                       to_tag_id, count(DISTINCT conversation_id) n
                  FROM moves
                 WHERE from_tag_id IS DISTINCT FROM to_tag_id
                 GROUP BY 1, 2) s), '[]'::jsonb)
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.chat_tag_report(timestamptz, timestamptz, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_tag_report(timestamptz, timestamptz, text)
  TO authenticated;
