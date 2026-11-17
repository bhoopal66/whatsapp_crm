-- ============================================================
-- 206 — Team activity: agents read their own report
--
-- 074 opened the report to team leaders (scope 'team'); owners and
-- admins read the whole account (scope 'account'). 204 added two
-- switches to team_activity_settings, agent_view_enabled and
-- leader_view_enabled (both default on; no row means on). Here:
--
--   * an agent (rank 2) reads scope 'self' while agent_view_enabled
--     is on: the people list is the caller alone; starts, messages,
--     runs and replies are the caller's own sends (sender_id =
--     auth.uid(), the same auth user id 074's team list holds); the
--     numbers listed are those the caller started chats on in the
--     range, with figures from the caller's starts only (no
--     whole-number count); no bot/API senders, no unassigned waiting,
--     waiting counts only chats assigned to the caller. Every other
--     output key is still present (zeros / empty arrays).
--   * a team leader keeps 074's 'team' scope, unchanged, while
--     leader_view_enabled is on.
--   * either switch off: 42501 with HINT 'agent_view_off' /
--     'leader_view_off'. Viewers and bank guests are refused as before.
--   * team_activity_chats (the drill-down): an agent may open only
--     their own starts (p_kind 'person', p_user_id = auth.uid()), in
--     the conversations their RLS shows them, under the same switch.
--
-- Each function is its latest definition (report: 145; chats: 074)
-- copied verbatim apart from the scope logic: same signature,
-- SECURITY DEFINER (074, for speed), search_path, volatility, and
-- every read still filtered by current_account_id(). Independent of
-- 205.
--
-- Re-runnable: CREATE OR REPLACE plus REVOKE/GRANT. No data changes.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The report (145's) with the agent's self scope.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.team_activity_report(
  p_from       timestamptz,
  p_to         timestamptz,
  p_tz         text DEFAULT NULL,
  p_channel_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account uuid := current_account_id();
  v_uid     uuid := auth.uid();
  v_rank    integer := current_role_rank();
  -- Self scope (206): an agent's own figures only.
  v_self    boolean := false;
  v_cfg     record;
  v_tz      text;
  v_today   timestamptz;
  v_result  jsonb;
  -- Team scope: the people counted, the teams' names, and today's new
  -- chats per number on the whole number (number id -> count).
  v_team       uuid[];
  v_team_names jsonb := '[]'::jsonb;
  v_nums       jsonb;
  -- Team scope: the conversations the leader's RLS shows them.
  v_convs      uuid[];
BEGIN
  IF v_account IS NULL OR v_uid IS NULL OR v_rank IS NULL OR v_rank < 2 THEN
    RAISE EXCEPTION 'Only owners and admins (team leaders for their team, agents for themselves) can view team activity'
      USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from
     OR p_to - p_from > interval '100 days' THEN
    RAISE EXCEPTION 'The range must be shorter than 100 days'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_cfg FROM team_activity_limits(v_account);
  -- The admin's switches (204); no settings row means on.
  IF v_rank = 3 AND NOT coalesce(v_cfg.leader_view_enabled, true) THEN
    RAISE EXCEPTION 'Team activity is turned off for team leaders'
      USING ERRCODE = '42501', HINT = 'leader_view_off';
  END IF;
  IF v_rank = 2 AND NOT coalesce(v_cfg.agent_view_enabled, true) THEN
    RAISE EXCEPTION 'Team activity is turned off for agents'
      USING ERRCODE = '42501', HINT = 'agent_view_off';
  END IF;
  v_tz := coalesce(v_cfg.timezone, team_activity_valid_zone(p_tz), 'UTC');
  v_today := date_trunc('day', now() AT TIME ZONE v_tz) AT TIME ZONE v_tz;

  IF v_rank = 2 THEN
    -- Self scope: the caller is the only person counted, in the
    -- conversations their RLS shows them (as 074 does for a leader).
    -- v_nums stays NULL: no whole-number figure; the numbers listed
    -- are cut to those the caller started chats on, below.
    v_self := true;
    v_team := ARRAY[v_uid];
    SELECT coalesce(array_agg(c.id), '{}'::uuid[]) INTO v_convs
    FROM conversations c
    WHERE c.account_id = v_account
      AND can_view_conversation(c.account_id, c.user_id, c.assigned_agent_id,
                                c.channel_id, c.send_channel_id);
  ELSIF v_rank = 3 THEN
    v_team := team_activity_my_team();
    SELECT coalesce(jsonb_agg(t.name ORDER BY t.name), '[]'::jsonb) INTO v_team_names
    FROM teams t
    WHERE t.account_id = v_account AND t.leader_user_id = auth.uid();
    SELECT coalesce(jsonb_object_agg(x.channel_id::text, x.today_started), '{}'::jsonb)
      INTO v_nums
    FROM team_activity_team_number_counts(p_from, p_to, p_tz) x;
    -- What conversations_select / messages_select would show them.
    SELECT coalesce(array_agg(c.id), '{}'::uuid[]) INTO v_convs
    FROM conversations c
    WHERE c.account_id = v_account
      AND can_view_conversation(c.account_id, c.user_id, c.assigned_agent_id,
                                c.channel_id, c.send_channel_id);
  END IF;

  WITH
  numbers AS (
    SELECT w.id AS channel_id, w.provider, w.label, w.waba_id, w.phone_number_id,
           w.status, w.is_primary, w.created_at, w.connected_at
    FROM whatsapp_config w
    WHERE w.account_id = v_account
      -- Team scope: the numbers the team used or is allocated to.
      AND (v_nums IS NULL OR v_nums ? w.id::text)
  ),
  all_starts AS (
    SELECT
      s.*,
      CASE
        WHEN s.sender_type = 'bot' THEN 'bot'
        WHEN s.sender_id IS NULL THEN 'api'
        ELSE 'person'
      END AS kind,
      CASE WHEN s.sender_type = 'agent' THEN s.sender_id END AS key_id,
      (s.started_at AT TIME ZONE v_tz)::date AS local_day,
      extract(hour FROM s.started_at AT TIME ZONE v_tz)::int AS local_hour,
      -- Younger than a day and not answered yet: too early to tell.
      (NOT s.replied AND s.started_at > now() - interval '24 hours') AS pending,
      team_activity_opener_key(mm.content_text) AS opener_key
    FROM team_activity_starts(v_account, least(p_from, v_today), 'infinity') s
    LEFT JOIN messages mm ON mm.id = s.message_id
    -- Team scope: chats the team's people started, nobody else's, in
    -- conversations the leader can see.
    WHERE v_team IS NULL
       OR (s.sender_type = 'agent' AND s.sender_id = ANY (v_team)
           AND s.conversation_id = ANY (v_convs))
  ),
  -- Same text opening five or more chats on one number.
  openers AS (
    SELECT channel_id, opener_hash, count(DISTINCT conversation_id) AS chats
    FROM all_starts
    WHERE opener_hash IS NOT NULL AND started_at >= p_from AND started_at < p_to
    GROUP BY channel_id, opener_hash
  ),
  -- The same normalised first message from the same sender at least
  -- twice in the range.
  similars AS (
    SELECT kind, key_id, opener_key, count(*) AS n
    FROM all_starts
    WHERE opener_key IS NOT NULL AND started_at >= p_from AND started_at < p_to
    GROUP BY kind, key_id, opener_key
  ),
  rs_all AS (
    SELECT
      a.*,
      coalesce(o.chats, 0) >= 5 AS identical,
      coalesce(si.n, 0) >= 2 AS is_similar,
      CASE
        WHEN v_cfg.quiet_hours_start = v_cfg.quiet_hours_end THEN false
        WHEN v_cfg.quiet_hours_start < v_cfg.quiet_hours_end
          THEN a.local_hour >= v_cfg.quiet_hours_start AND a.local_hour < v_cfg.quiet_hours_end
        ELSE a.local_hour >= v_cfg.quiet_hours_start OR a.local_hour < v_cfg.quiet_hours_end
      END AS night
    FROM all_starts a
    LEFT JOIN openers o
      ON o.opener_hash = a.opener_hash
     AND o.channel_id IS NOT DISTINCT FROM a.channel_id
    LEFT JOIN similars si
      ON si.kind = a.kind
     AND si.key_id IS NOT DISTINCT FROM a.key_id
     AND si.opener_key = a.opener_key
    WHERE a.started_at >= p_from AND a.started_at < p_to
  ),
  rs AS (
    SELECT * FROM rs_all
    WHERE p_channel_id IS NULL OR channel_id = p_channel_id
  ),
  today_starts AS (
    SELECT * FROM all_starts WHERE started_at >= v_today
  ),
  -- Messages of every conversation that moved in the range, from where
  -- its current stretch began: the start of the customer's stretch
  -- that ended with their last message before the range (the message
  -- before that stretch is included as its boundary), or the start of
  -- the conversation when the customer never wrote before the range.
  -- So an unanswered run or a wait is counted from its real start,
  -- however long ago.
  conv_in AS (
    SELECT DISTINCT m.conversation_id
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.account_id = v_account
      AND (v_convs IS NULL OR c.id = ANY (v_convs))
      AND m.created_at >= p_from
      AND m.created_at < p_to
  ),
  bounds AS (
    SELECT
      ci.conversation_id,
      (SELECT max(o.created_at)
         FROM messages o
        WHERE o.conversation_id = ci.conversation_id
          AND o.sender_type <> 'customer'
          AND o.status <> 'failed'
          AND o.created_at < lc.at) AS lb
    FROM conv_in ci
    CROSS JOIN LATERAL (
      SELECT max(x.created_at) AS at
      FROM messages x
      WHERE x.conversation_id = ci.conversation_id
        AND x.sender_type = 'customer'
        AND x.status <> 'failed'
        AND x.created_at < p_from
    ) lc
  ),
  msgs AS (
    SELECT
      m.id,
      m.conversation_id,
      m.sender_type,
      m.sender_id,
      m.status,
      m.created_at,
      m.channel_id,
      coalesce(w.provider, m.provider) AS provider,
      m.sender_type = 'customer' AS is_customer,
      -- Team scope: the chat's handler (assignee, else owner) is one of
      -- the team's people. Decides which customer messages count.
      (v_team IS NULL OR EXISTS (
        SELECT 1 FROM conversations hc
        WHERE hc.id = m.conversation_id
          AND coalesce(hc.assigned_agent_id, hc.user_id) = ANY (v_team)
      )) AS in_team
    FROM bounds b
    JOIN messages m ON m.conversation_id = b.conversation_id
    LEFT JOIN whatsapp_config w ON w.id = m.channel_id AND w.account_id = v_account
    WHERE m.created_at >= coalesce(b.lb, '-infinity'::timestamptz)
      AND m.created_at < p_to
  ),
  -- Runs and response times count what reached WhatsApp: a refused
  -- send is no reply and no part of a run.
  seq AS (
    SELECT
      msgs.*,
      lag(is_customer) OVER w AS prev_customer,
      lag(created_at) OVER w AS prev_at,
      sum(is_customer::int) OVER w AS grp
    FROM msgs
    WHERE status <> 'failed'
    WINDOW w AS (PARTITION BY conversation_id ORDER BY created_at, id)
  ),
  seq2 AS (
    SELECT
      seq.*,
      -- When the customer's current unanswered stretch began (058's rule).
      max(CASE WHEN is_customer AND prev_customer IS NOT TRUE THEN created_at END)
        OVER (PARTITION BY conversation_id ORDER BY created_at, id) AS cust_run_start,
      -- 1 for the first message after the customer last wrote, 2 for the next…
      CASE WHEN NOT is_customer THEN
        count(*) FILTER (WHERE NOT is_customer)
          OVER (PARTITION BY conversation_id, grp ORDER BY created_at, id)
      END AS run_pos,
      -- The same, with a follow-up sent within 10 minutes of the
      -- previous message of the stretch counted as part of it.
      CASE WHEN NOT is_customer THEN
        count(*) FILTER (
          WHERE NOT is_customer
            AND (prev_customer IS NOT FALSE OR created_at - prev_at > interval '10 minutes')
        ) OVER (PARTITION BY conversation_id, grp ORDER BY created_at, id)
      END AS chase_pos
    FROM seq
  ),
  -- Every outbound message in the range. Refused sends are added back
  -- here: they count as sent and as failed, with no run position.
  om_all AS (
    SELECT
      CASE
        WHEN s2.sender_type = 'bot' THEN 'bot'
        WHEN s2.sender_id IS NULL THEN 'api'
        ELSE 'person'
      END AS kind,
      CASE WHEN s2.sender_type = 'agent' THEN s2.sender_id END AS key_id,
      s2.channel_id,
      s2.provider,
      s2.conversation_id,
      s2.status,
      s2.created_at,
      s2.run_pos,
      s2.chase_pos,
      -- 0 while the customer has never written in the conversation.
      s2.grp,
      s2.prev_customer,
      s2.cust_run_start
    FROM seq2 s2
    WHERE NOT s2.is_customer AND s2.created_at >= p_from
      AND (v_team IS NULL OR (s2.sender_type = 'agent' AND s2.sender_id = ANY (v_team)))
    UNION ALL
    SELECT
      CASE
        WHEN f.sender_type = 'bot' THEN 'bot'
        WHEN f.sender_id IS NULL THEN 'api'
        ELSE 'person'
      END,
      CASE WHEN f.sender_type = 'agent' THEN f.sender_id END,
      f.channel_id,
      f.provider,
      f.conversation_id,
      f.status,
      f.created_at,
      NULL::bigint,
      NULL::bigint,
      NULL::bigint,
      NULL::boolean,
      NULL::timestamptz
    FROM msgs f
    WHERE f.status = 'failed' AND NOT f.is_customer AND f.created_at >= p_from
      AND (v_team IS NULL OR (f.sender_type = 'agent' AND f.sender_id = ANY (v_team)))
  ),
  om AS (
    SELECT * FROM om_all
    WHERE p_channel_id IS NULL OR channel_id = p_channel_id
  ),
  inbound AS (
    SELECT * FROM msgs
    WHERE is_customer AND created_at >= p_from AND in_team
      AND (p_channel_id IS NULL OR channel_id = p_channel_id)
  ),
  -- ---------------- per sender ----------------
  s_starts AS (
    SELECT
      kind, key_id,
      count(*) AS chats_started,
      count(*) FILTER (WHERE new_contact) AS new_contacts,
      count(*) FILTER (WHERE NOT replied) AS no_reply,
      count(*) FILTER (WHERE NOT pending) AS mature_started,
      count(*) FILTER (WHERE NOT replied AND NOT pending) AS mature_no_reply,
      count(*) FILTER (WHERE pending) AS pending_reply,
      count(*) FILTER (WHERE new_contact AND NOT replied) AS new_contacts_no_reply,
      count(*) FILTER (WHERE new_contact AND has_link) AS links_first,
      count(*) FILTER (WHERE identical) AS identical_openers,
      count(*) FILTER (WHERE is_similar) AS similar_openers,
      count(*) FILTER (WHERE night) AS night_starts
    FROM rs
    GROUP BY kind, key_id
  ),
  -- The per-person limits protect the phone numbers (Whapi and
  -- OpenWA): the busiest day, the days at the limit, the bursts and
  -- today's count are over chats started on phone numbers only.
  s_days AS (
    SELECT
      kind, key_id,
      max(n) AS peak_day,
      count(*) FILTER (
        WHERE kind = 'person' AND n > v_cfg.daily_new_chats_per_user
      ) AS days_over_limit,
      count(*) FILTER (
        WHERE kind = 'person' AND n >= v_cfg.daily_new_chats_per_user
      ) AS days_at_limit
    FROM (
      SELECT kind, key_id, local_day, count(*) AS n
      FROM rs
      WHERE provider IN ('whapi', 'openwa')
      GROUP BY kind, key_id, local_day
    ) d
    GROUP BY kind, key_id
  ),
  s_burst AS (
    SELECT kind, key_id, max(n) AS burst_10min
    FROM (
      SELECT
        kind, key_id,
        count(*) OVER (
          PARTITION BY kind, key_id ORDER BY started_at
          RANGE BETWEEN interval '10 minutes' PRECEDING AND CURRENT ROW
        ) AS n
      FROM rs
      WHERE provider IN ('whapi', 'openwa')
    ) b
    GROUP BY kind, key_id
  ),
  s_today AS (
    SELECT kind, key_id, count(*) AS today_starts
    FROM today_starts
    WHERE provider IN ('whapi', 'openwa')
      AND (p_channel_id IS NULL OR channel_id = p_channel_id)
    GROUP BY kind, key_id
  ),
  s_msgs AS (
    SELECT
      kind, key_id,
      count(*) AS messages_sent,
      count(DISTINCT conversation_id) AS conversations,
      count(*) FILTER (WHERE status = 'failed') AS failed,
      count(*) FILTER (WHERE status = 'failed' AND provider IN ('whapi', 'openwa')) AS failed_phone,
      count(*) FILTER (WHERE status = 'failed' AND provider = 'meta') AS failed_official,
      count(*) FILTER (WHERE status IN ('delivered', 'read')) AS delivered,
      count(*) FILTER (WHERE status = 'read') AS read,
      count(*) FILTER (WHERE run_pos > v_cfg.max_unanswered_in_row) AS unanswered_over_limit,
      count(DISTINCT conversation_id) FILTER (
        WHERE run_pos > v_cfg.max_unanswered_in_row
      ) AS unanswered_chats,
      coalesce(max(run_pos), 0) AS max_unanswered_run,
      coalesce(max(chase_pos), 0) AS longest_chase,
      count(DISTINCT (created_at AT TIME ZONE v_tz)::date) AS active_days
    FROM om
    GROUP BY kind, key_id
  ),
  -- Chats this sender kept writing to past the limit (follow-ups
  -- within 10 minutes counted once): to someone who never wrote in the
  -- conversation, or to someone who did.
  s_chase AS (
    SELECT
      kind, key_id,
      count(*) FILTER (WHERE is_new) AS chase_new,
      count(*) FILTER (WHERE NOT is_new) AS chase_existing
    FROM (
      SELECT kind, key_id, conversation_id, bool_or(grp = 0) AS is_new
      FROM om
      WHERE chase_pos > v_cfg.max_unanswered_in_row
      GROUP BY kind, key_id, conversation_id
    ) x
    GROUP BY kind, key_id
  ),
  s_replies AS (
    SELECT
      kind, key_id,
      count(*) AS replies,
      percentile_cont(0.5) WITHIN GROUP (
        ORDER BY extract(epoch FROM created_at - cust_run_start) / 60.0
      ) AS response_median_min
    FROM om
    WHERE kind = 'person'
      AND prev_customer IS TRUE
      AND cust_run_start IS NOT NULL
      AND created_at >= cust_run_start
    GROUP BY kind, key_id
  ),
  -- Customers waiting now: the customer wrote last, in the last 7
  -- days (older waits are ignored). Recent = under 24 hours.
  waits AS (
    SELECT
      c.assigned_agent_id AS key_id,
      lm.created_at,
      lm.created_at > now() - interval '24 hours' AS recent
    FROM conversations c
    CROSS JOIN LATERAL (
      -- A refused reply leaves the customer waiting.
      SELECT m.sender_type, m.created_at
      FROM messages m
      WHERE m.conversation_id = c.id
        AND m.status <> 'failed'
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT 1
    ) lm
    WHERE c.account_id = v_account
      AND c.status <> 'closed'
      AND c.last_message_at > now() - interval '7 days'
      AND lm.sender_type = 'customer'
      AND lm.created_at > now() - interval '7 days'
      AND (p_channel_id IS NULL OR c.channel_id = p_channel_id)
      AND (v_team IS NULL OR coalesce(c.assigned_agent_id, c.user_id) = ANY (v_team))
      AND (v_convs IS NULL OR c.id = ANY (v_convs))
      -- Self scope: chats assigned to the caller; nothing unassigned.
      AND (NOT v_self OR c.assigned_agent_id = v_uid)
  ),
  s_waiting AS (
    SELECT
      key_id,
      count(*) AS waiting,
      count(*) FILTER (WHERE recent) AS waiting_recent,
      count(*) FILTER (WHERE NOT recent) AS waiting_older,
      max(extract(epoch FROM now() - created_at) / 60.0) AS oldest_min
    FROM waits
    GROUP BY key_id
  ),
  s_broadcasts AS (
    SELECT
      b.user_id AS key_id,
      count(DISTINCT b.id) AS broadcasts,
      count(*) FILTER (WHERE r.status IN ('sent', 'delivered', 'read', 'replied')) AS sent,
      count(*) FILTER (WHERE r.status = 'failed') AS failed,
      count(*) FILTER (WHERE r.status = 'replied' OR r.replied_at IS NOT NULL) AS replied
    FROM broadcasts b
    JOIN broadcast_recipients r ON r.broadcast_id = b.id
    WHERE b.account_id = v_account
      AND p_channel_id IS NULL
      -- Every recipient change touches its broadcast (the aggregate
      -- trigger), so one untouched since the range began has nothing in
      -- it; this keeps old campaigns' recipients out of the scan.
      AND b.updated_at >= p_from
      AND r.status <> 'pending'
      AND coalesce(r.sent_at, r.created_at) >= p_from
      AND coalesce(r.sent_at, r.created_at) < p_to
    GROUP BY b.user_id
  ),
  people AS (
    SELECT p.user_id, p.full_name, p.email, p.account_role::text AS role, p.avatar_url
    FROM profiles p
    WHERE p.account_id = v_account
  ),
  keys AS (
    SELECT * FROM (
      SELECT 'person'::text AS kind, user_id AS key_id FROM people
      UNION SELECT kind, key_id FROM s_starts
      UNION SELECT kind, key_id FROM s_msgs
      UNION SELECT kind, key_id FROM s_today
      UNION SELECT 'person', key_id FROM s_broadcasts
      UNION SELECT 'person', key_id FROM s_waiting WHERE key_id IS NOT NULL
    ) k
    -- Team scope: the team's people only.
    WHERE v_team IS NULL OR (k.kind = 'person' AND k.key_id = ANY (v_team))
  ),
  -- ---------------- per number ----------------
  -- Only the account's numbers: starts with no number recorded are
  -- counted once, in unattributed_starts.
  n_starts AS (
    SELECT
      channel_id,
      count(*) AS chats_started,
      count(*) FILTER (WHERE new_contact) AS new_contacts,
      count(*) FILTER (WHERE NOT replied) AS no_reply,
      count(*) FILTER (WHERE NOT pending) AS mature_started,
      count(*) FILTER (WHERE NOT replied AND NOT pending) AS mature_no_reply,
      count(*) FILTER (WHERE pending) AS pending_reply,
      count(*) FILTER (WHERE new_contact AND has_link) AS links_first,
      count(*) FILTER (WHERE identical) AS identical_openers,
      count(*) FILTER (WHERE night) AS night_starts
    FROM rs_all
    WHERE channel_id IS NOT NULL
    GROUP BY channel_id
  ),
  -- days_at_limit: phone numbers only, against the limit that applied
  -- that day (a warming-up number's lower one).
  n_days AS (
    SELECT
      d.channel_id,
      max(d.n) AS peak_day,
      count(*) FILTER (WHERE d.n > v_cfg.daily_new_chats_per_number) AS days_over_limit,
      count(*) FILTER (
        WHERE d.n >= team_activity_number_limit(
          nb.created_at, v_cfg.daily_new_chats_per_number,
          least(now(), (d.local_day + 1)::timestamp AT TIME ZONE v_tz))
      ) AS days_at_limit
    FROM (
      SELECT channel_id, local_day, count(*) AS n
      FROM rs_all
      WHERE channel_id IS NOT NULL
      GROUP BY channel_id, local_day
    ) d
    JOIN numbers nb ON nb.channel_id = d.channel_id
    GROUP BY d.channel_id
  ),
  n_burst AS (
    SELECT channel_id, max(n) AS burst_10min
    FROM (
      SELECT
        channel_id,
        count(*) OVER (
          PARTITION BY channel_id ORDER BY started_at
          RANGE BETWEEN interval '10 minutes' PRECEDING AND CURRENT ROW
        ) AS n
      FROM rs_all
      WHERE channel_id IS NOT NULL
    ) b
    GROUP BY channel_id
  ),
  n_today AS (
    SELECT channel_id, count(*) AS today_starts
    FROM today_starts
    WHERE channel_id IS NOT NULL
    GROUP BY channel_id
  ),
  n_msgs AS (
    SELECT
      channel_id,
      count(*) AS messages_sent,
      count(DISTINCT conversation_id) AS conversations,
      count(*) FILTER (WHERE status = 'failed') AS failed,
      count(*) FILTER (WHERE status IN ('delivered', 'read')) AS delivered,
      count(*) FILTER (WHERE status = 'read') AS read,
      count(*) FILTER (WHERE run_pos > v_cfg.max_unanswered_in_row) AS unanswered_over_limit
    FROM om_all
    WHERE channel_id IS NOT NULL
    GROUP BY channel_id
  ),
  n_inbound AS (
    SELECT channel_id, count(*) AS received
    FROM msgs
    WHERE is_customer AND created_at >= p_from AND channel_id IS NOT NULL AND in_team
    GROUP BY channel_id
  ),
  -- ---------------- over time ----------------
  days AS (
    SELECT d::date AS day
    FROM generate_series(
      (p_from AT TIME ZONE v_tz)::date::timestamp,
      ((p_to - interval '1 microsecond') AT TIME ZONE v_tz)::date::timestamp,
      interval '1 day'
    ) d
  ),
  d_starts AS (
    SELECT local_day AS day,
           count(*) AS started,
           count(*) FILTER (WHERE NOT replied) AS no_reply,
           count(*) FILTER (WHERE pending) AS pending_reply,
           count(*) FILTER (WHERE new_contact) AS new_contacts
    FROM rs GROUP BY local_day
  ),
  d_out AS (
    SELECT (created_at AT TIME ZONE v_tz)::date AS day, count(*) AS sent
    FROM om GROUP BY 1
  ),
  d_in AS (
    SELECT (created_at AT TIME ZONE v_tz)::date AS day, count(*) AS received
    FROM inbound GROUP BY 1
  ),
  hours AS (
    SELECT h FROM generate_series(0, 23) h
  ),
  h_starts AS (
    SELECT local_hour AS h, count(*) AS started FROM rs GROUP BY local_hour
  ),
  h_out AS (
    SELECT extract(hour FROM created_at AT TIME ZONE v_tz)::int AS h, count(*) AS sent
    FROM om GROUP BY 1
  )
  SELECT jsonb_build_object(
    'tz', v_tz,
    'today', (now() AT TIME ZONE v_tz)::date,
    'from', p_from,
    'to', p_to,
    'channel_id', p_channel_id,
    'generated_at', now(),
    'scope', CASE WHEN v_self THEN 'self'
                  WHEN v_team IS NULL THEN 'account' ELSE 'team' END,
    'team_names', v_team_names,
    'limits', jsonb_build_object(
      'daily_new_chats_per_user', v_cfg.daily_new_chats_per_user,
      'daily_new_chats_per_number', v_cfg.daily_new_chats_per_number,
      'min_reply_rate', v_cfg.min_reply_rate,
      'max_unanswered_in_row', v_cfg.max_unanswered_in_row,
      'burst_new_chats_10min', v_cfg.burst_new_chats_10min,
      'quiet_hours_start', v_cfg.quiet_hours_start,
      'quiet_hours_end', v_cfg.quiet_hours_end,
      'timezone', v_cfg.timezone,
      'notify', v_cfg.notify,
      'block_over_limit', v_cfg.block_over_limit,
      'saved', v_cfg.saved
    ),
    'waiting_unassigned', coalesce(
      (SELECT waiting FROM s_waiting WHERE key_id IS NULL), 0),
    'waiting_unassigned_recent', coalesce(
      (SELECT waiting_recent FROM s_waiting WHERE key_id IS NULL), 0),
    'waiting_recent', (SELECT count(*) FROM waits WHERE recent),
    'waiting_older', (SELECT count(*) FROM waits WHERE NOT recent),
    'unattributed_starts', (SELECT count(*) FROM rs_all WHERE channel_id IS NULL),
    'senders', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'kind', k.kind,
        'user_id', k.key_id,
        'name', pe.full_name,
        'email', pe.email,
        'role', pe.role,
        'avatar_url', pe.avatar_url,
        'messages_sent', coalesce(sm.messages_sent, 0),
        'conversations', coalesce(sm.conversations, 0),
        'failed', coalesce(sm.failed, 0),
        'failed_phone', coalesce(sm.failed_phone, 0),
        'failed_official', coalesce(sm.failed_official, 0),
        'delivered', coalesce(sm.delivered, 0),
        'read', coalesce(sm.read, 0),
        'active_days', coalesce(sm.active_days, 0),
        'chats_started', coalesce(ss.chats_started, 0),
        'new_contacts', coalesce(ss.new_contacts, 0),
        'no_reply', coalesce(ss.no_reply, 0),
        'mature_started', coalesce(ss.mature_started, 0),
        'mature_no_reply', coalesce(ss.mature_no_reply, 0),
        'pending_reply', coalesce(ss.pending_reply, 0),
        'new_contacts_no_reply', coalesce(ss.new_contacts_no_reply, 0),
        'links_first', coalesce(ss.links_first, 0),
        'identical_openers', coalesce(ss.identical_openers, 0),
        'similar_openers', coalesce(ss.similar_openers, 0),
        'night_starts', coalesce(ss.night_starts, 0),
        'peak_day', coalesce(sd.peak_day, 0),
        'days_over_limit', coalesce(sd.days_over_limit, 0),
        'days_at_limit', coalesce(sd.days_at_limit, 0),
        'today_starts', coalesce(st.today_starts, 0),
        'burst_10min', coalesce(sb.burst_10min, 0),
        'unanswered_over_limit', coalesce(sm.unanswered_over_limit, 0),
        'unanswered_chats', coalesce(sm.unanswered_chats, 0),
        'max_unanswered_run', coalesce(sm.max_unanswered_run, 0),
        'longest_chase', coalesce(sm.longest_chase, 0),
        'chase_new', coalesce(sc.chase_new, 0),
        'chase_existing', coalesce(sc.chase_existing, 0),
        -- The API and bots do not "reply": no figures rather than 0.
        'replies', CASE WHEN k.kind = 'person' THEN coalesce(sr.replies, 0) END,
        'response_median_min', CASE WHEN k.kind = 'person'
                                    THEN round(sr.response_median_min::numeric, 1) END,
        'waiting', coalesce(sw.waiting, 0),
        'waiting_recent', coalesce(sw.waiting_recent, 0),
        'waiting_older', coalesce(sw.waiting_older, 0),
        'waiting_oldest_min', round(sw.oldest_min::numeric, 0),
        'broadcasts', coalesce(bc.broadcasts, 0),
        'broadcast_sent', coalesce(bc.sent, 0),
        'broadcast_failed', coalesce(bc.failed, 0),
        'broadcast_replied', coalesce(bc.replied, 0)
      ) ORDER BY coalesce(ss.chats_started, 0) DESC, coalesce(sm.messages_sent, 0) DESC,
                 pe.full_name NULLS LAST, k.kind)
      FROM keys k
      LEFT JOIN people pe ON k.kind = 'person' AND pe.user_id = k.key_id
      LEFT JOIN s_starts ss ON ss.kind = k.kind AND ss.key_id IS NOT DISTINCT FROM k.key_id
      LEFT JOIN s_days sd ON sd.kind = k.kind AND sd.key_id IS NOT DISTINCT FROM k.key_id
      LEFT JOIN s_burst sb ON sb.kind = k.kind AND sb.key_id IS NOT DISTINCT FROM k.key_id
      LEFT JOIN s_today st ON st.kind = k.kind AND st.key_id IS NOT DISTINCT FROM k.key_id
      LEFT JOIN s_msgs sm ON sm.kind = k.kind AND sm.key_id IS NOT DISTINCT FROM k.key_id
      LEFT JOIN s_chase sc ON sc.kind = k.kind AND sc.key_id IS NOT DISTINCT FROM k.key_id
      LEFT JOIN s_replies sr ON sr.kind = k.kind AND sr.key_id IS NOT DISTINCT FROM k.key_id
      LEFT JOIN s_waiting sw ON k.kind = 'person' AND sw.key_id = k.key_id
      LEFT JOIN s_broadcasts bc ON k.kind = 'person' AND bc.key_id = k.key_id
    ), '[]'::jsonb),
    'numbers', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'channel_id', nb.channel_id,
        'provider', nb.provider,
        'kind', CASE nb.provider WHEN 'whapi' THEN 'phone' WHEN 'openwa' THEN 'phone' WHEN 'meta' THEN 'official' END,
        'label', nb.label,
        'waba_id', nb.waba_id,
        'phone_number_id', nb.phone_number_id,
        'status', nb.status,
        'is_primary', nb.is_primary,
        'connected_at', nb.connected_at,
        'created_at', nb.created_at,
        'age_days', floor(extract(epoch FROM now() - nb.created_at) / 86400)::integer,
        'warming_up', nb.provider IN ('whapi', 'openwa')
                      AND coalesce(now() - nb.created_at < interval '14 days', false),
        'effective_daily_limit', CASE WHEN nb.provider IN ('whapi', 'openwa') THEN
          team_activity_number_limit(nb.created_at, v_cfg.daily_new_chats_per_number) END,
        'messages_sent', coalesce(nm.messages_sent, 0),
        'received', coalesce(ni.received, 0),
        'conversations', coalesce(nm.conversations, 0),
        'failed', coalesce(nm.failed, 0),
        'delivered', coalesce(nm.delivered, 0),
        'read', coalesce(nm.read, 0),
        'unanswered_over_limit', coalesce(nm.unanswered_over_limit, 0),
        'chats_started', coalesce(ns.chats_started, 0),
        'new_contacts', coalesce(ns.new_contacts, 0),
        'no_reply', coalesce(ns.no_reply, 0),
        'mature_started', coalesce(ns.mature_started, 0),
        'mature_no_reply', coalesce(ns.mature_no_reply, 0),
        'pending_reply', coalesce(ns.pending_reply, 0),
        'links_first', coalesce(ns.links_first, 0),
        'identical_openers', coalesce(ns.identical_openers, 0),
        'night_starts', coalesce(ns.night_starts, 0),
        'peak_day', coalesce(nd.peak_day, 0),
        'days_over_limit', coalesce(nd.days_over_limit, 0),
        'days_at_limit', CASE WHEN nb.provider IN ('whapi', 'openwa') THEN coalesce(nd.days_at_limit, 0) END,
        'burst_10min', coalesce(nbu.burst_10min, 0),
        'today_starts', coalesce(nt.today_starts, 0),
        'today_started', coalesce(nt.today_starts, 0)
      )
      -- Team scope: today's new chats on the whole number, everyone's.
      || CASE WHEN v_nums IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
           'number_today_started', coalesce((v_nums ->> nb.channel_id::text)::integer, 0)) END
      ORDER BY nb.is_primary DESC NULLS LAST, nb.provider, nb.created_at, nb.channel_id)
      FROM numbers nb
      LEFT JOIN n_starts ns ON ns.channel_id = nb.channel_id
      LEFT JOIN n_days nd ON nd.channel_id = nb.channel_id
      LEFT JOIN n_burst nbu ON nbu.channel_id = nb.channel_id
      LEFT JOIN n_today nt ON nt.channel_id = nb.channel_id
      LEFT JOIN n_msgs nm ON nm.channel_id = nb.channel_id
      LEFT JOIN n_inbound ni ON ni.channel_id = nb.channel_id
      -- Self scope: only the numbers the caller started chats on.
      WHERE NOT v_self
         OR EXISTS (SELECT 1 FROM rs_all ra WHERE ra.channel_id = nb.channel_id)
    ), '[]'::jsonb),
    'daily', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'day', d.day,
        'started', coalesce(ds.started, 0),
        'no_reply', coalesce(ds.no_reply, 0),
        'pending_reply', coalesce(ds.pending_reply, 0),
        'new_contacts', coalesce(ds.new_contacts, 0),
        'sent', coalesce(dout.sent, 0),
        'received', coalesce(din.received, 0)
      ) ORDER BY d.day)
      FROM days d
      LEFT JOIN d_starts ds ON ds.day = d.day
      LEFT JOIN d_out dout ON dout.day = d.day
      LEFT JOIN d_in din ON din.day = d.day
    ), '[]'::jsonb),
    'hourly', (
      SELECT jsonb_agg(jsonb_build_object(
        'hour', hr.h,
        'started', coalesce(hs.started, 0),
        'sent', coalesce(ho.sent, 0)
      ) ORDER BY hr.h)
      FROM hours hr
      LEFT JOIN h_starts hs ON hs.h = hr.h
      LEFT JOIN h_out ho ON ho.h = hr.h
    )
  )
  INTO v_result;

  RETURN v_result;
END
$$;

REVOKE ALL ON FUNCTION public.team_activity_report(timestamptz, timestamptz, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_activity_report(timestamptz, timestamptz, text, uuid) TO authenticated;

-- ------------------------------------------------------------
-- 2. Drill-down (074's): an agent opens only their own starts.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.team_activity_chats(
  p_from       timestamptz,
  p_to         timestamptz,
  p_kind       text,
  p_user_id    uuid DEFAULT NULL,
  p_channel_id uuid DEFAULT NULL,
  p_filter     text DEFAULT 'no_reply',
  p_limit      integer DEFAULT 200
)
RETURNS TABLE (
  conversation_id uuid,
  contact_id      uuid,
  contact_name    text,
  contact_phone   text,
  at              timestamptz,
  new_contact     boolean,
  replied         boolean,
  has_link        boolean,
  in_a_row        integer,
  preview         text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_account uuid := current_account_id();
  v_uid     uuid := auth.uid();
  v_rank    integer := current_role_rank();
  v_view    record;
  v_max     integer;
  v_limit   integer := least(greatest(coalesce(p_limit, 200), 1), 500);
  -- Team scope: the conversations the leader's RLS shows them; NULL
  -- (the whole account) for owners and admins.
  v_convs   uuid[];
BEGIN
  IF v_account IS NULL OR v_uid IS NULL OR v_rank IS NULL OR v_rank < 2 THEN
    RAISE EXCEPTION 'Only owners and admins (team leaders for their team, agents for themselves) can view team activity'
      USING ERRCODE = '42501';
  END IF;
  -- The admin's switches (204); no settings row means on.
  IF v_rank IN (2, 3) THEN
    SELECT l.agent_view_enabled, l.leader_view_enabled INTO v_view
    FROM team_activity_limits(v_account) l;
    IF v_rank = 3 AND NOT coalesce(v_view.leader_view_enabled, true) THEN
      RAISE EXCEPTION 'Team activity is turned off for team leaders'
        USING ERRCODE = '42501', HINT = 'leader_view_off';
    END IF;
    IF v_rank = 2 AND NOT coalesce(v_view.agent_view_enabled, true) THEN
      RAISE EXCEPTION 'Team activity is turned off for agents'
        USING ERRCODE = '42501', HINT = 'agent_view_off';
    END IF;
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('person', 'api', 'bot')
     OR (p_kind = 'person' AND p_user_id IS NULL)
     -- An agent opens only their own starts.
     OR (v_rank = 2 AND (p_kind <> 'person' OR p_user_id <> v_uid))
     OR (v_rank = 3
         AND (p_kind <> 'person' OR NOT p_user_id = ANY (team_activity_my_team()))) THEN
    RAISE EXCEPTION 'Unknown sender' USING ERRCODE = '22023';
  END IF;
  IF p_filter IS NULL OR p_filter NOT IN ('no_reply', 'all', 'unanswered') THEN
    RAISE EXCEPTION 'Unknown filter' USING ERRCODE = '22023';
  END IF;
  IF v_rank IN (2, 3) THEN
    SELECT coalesce(array_agg(c.id), '{}'::uuid[]) INTO v_convs
    FROM conversations c
    WHERE c.account_id = v_account
      AND can_view_conversation(c.account_id, c.user_id, c.assigned_agent_id,
                                c.channel_id, c.send_channel_id);
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from
     OR p_to - p_from > interval '100 days' THEN
    RAISE EXCEPTION 'The range must be shorter than 100 days'
      USING ERRCODE = '22023';
  END IF;

  IF p_filter = 'unanswered' THEN
    SELECT l.max_unanswered_in_row INTO v_max FROM team_activity_limits(v_account) l;
    RETURN QUERY
    -- From where each conversation's current stretch began, as in
    -- the report (073): a run is counted from its real start.
    WITH conv_in AS (
      SELECT DISTINCT m.conversation_id
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE c.account_id = v_account
        AND (v_convs IS NULL OR c.id = ANY (v_convs))
        AND m.created_at >= p_from
        AND m.created_at < p_to
    ),
    bounds AS (
      SELECT ci.conversation_id,
        (SELECT max(o.created_at) FROM messages o
          WHERE o.conversation_id = ci.conversation_id
            AND o.sender_type <> 'customer' AND o.status <> 'failed'
            AND o.created_at < lc.at) AS lb
      FROM conv_in ci
      CROSS JOIN LATERAL (
        SELECT max(x.created_at) AS at FROM messages x
        WHERE x.conversation_id = ci.conversation_id
          AND x.sender_type = 'customer' AND x.status <> 'failed'
          AND x.created_at < p_from
      ) lc
    ),
    msgs AS (
      SELECT
        m.id, m.conversation_id, m.sender_type, m.sender_id, m.created_at, m.content_text,
        m.channel_id,
        m.sender_type = 'customer' AS is_customer
      FROM bounds b
      JOIN messages m ON m.conversation_id = b.conversation_id
      WHERE m.created_at >= coalesce(b.lb, '-infinity'::timestamptz)
        AND m.created_at < p_to
        AND m.status <> 'failed'
    ),
    seq AS (
      SELECT msgs.*,
        sum(is_customer::int) OVER (
          PARTITION BY conversation_id ORDER BY created_at, id
        ) AS grp
      FROM msgs
    ),
    pos AS (
      SELECT seq.*,
        CASE WHEN NOT is_customer THEN
          count(*) FILTER (WHERE NOT is_customer)
            OVER (PARTITION BY conversation_id, grp ORDER BY created_at, id)
        END AS run_pos
      FROM seq
    ),
    hits AS (
      SELECT DISTINCT ON (p.conversation_id)
        p.conversation_id, p.created_at, p.run_pos, p.content_text
      FROM pos p
      WHERE NOT p.is_customer
        AND p.created_at >= p_from
        AND p.run_pos > v_max
        AND (p_channel_id IS NULL OR p.channel_id = p_channel_id)
        AND CASE p_kind
              WHEN 'bot' THEN p.sender_type = 'bot'
              WHEN 'api' THEN p.sender_type = 'agent' AND p.sender_id IS NULL
              ELSE p.sender_type = 'agent' AND p.sender_id = p_user_id
            END
      ORDER BY p.conversation_id, p.run_pos DESC, p.created_at DESC
    )
    SELECT
      h.conversation_id, c.contact_id, ct.name, ct.phone, h.created_at,
      NOT EXISTS (
        SELECT 1 FROM messages x
        WHERE x.conversation_id = h.conversation_id AND x.sender_type = 'customer'
      ),
      false,
      coalesce(h.content_text ~* '(https?://|www\.|wa\.me/)', false),
      h.run_pos::integer,
      left(h.content_text, 160)
    FROM hits h
    JOIN conversations c ON c.id = h.conversation_id
    LEFT JOIN contacts ct
      ON ct.id = c.contact_id AND ct.account_id = v_account
     AND (v_convs IS NULL OR can_view_contact(ct.account_id, ct.id, ct.user_id))
    ORDER BY h.run_pos DESC, h.created_at DESC
    LIMIT v_limit;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    s.conversation_id, c.contact_id, ct.name, ct.phone, s.started_at,
    s.new_contact, s.replied, s.has_link,
    -- The opener plus everything that reached WhatsApp after it before
    -- the customer answered.
    (SELECT count(*)::integer
       FROM messages x
      WHERE x.conversation_id = s.conversation_id
        AND x.sender_type <> 'customer'
        AND x.status <> 'failed'
        AND x.created_at >= s.started_at
        AND x.created_at < coalesce((
              SELECT min(y.created_at) FROM messages y
               WHERE y.conversation_id = s.conversation_id
                 AND y.sender_type = 'customer'
                 AND y.created_at > s.started_at
            ), 'infinity'::timestamptz)),
    s.preview
  FROM team_activity_starts(v_account, p_from, 'infinity') s
  JOIN conversations c ON c.id = s.conversation_id
  LEFT JOIN contacts ct
      ON ct.id = c.contact_id AND ct.account_id = v_account
     AND (v_convs IS NULL OR can_view_contact(ct.account_id, ct.id, ct.user_id))
  WHERE s.started_at < p_to
    AND (v_convs IS NULL OR s.conversation_id = ANY (v_convs))
    AND (p_channel_id IS NULL OR s.channel_id = p_channel_id)
    AND (p_filter = 'all' OR NOT s.replied)
    AND CASE p_kind
          WHEN 'bot' THEN s.sender_type = 'bot'
          WHEN 'api' THEN s.sender_type = 'agent' AND s.sender_id IS NULL
          ELSE s.sender_type = 'agent' AND s.sender_id = p_user_id
        END
  ORDER BY s.started_at DESC
  LIMIT v_limit;
END
$$;

REVOKE ALL ON FUNCTION public.team_activity_chats(timestamptz, timestamptz, text, uuid, uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_activity_chats(timestamptz, timestamptz, text, uuid, uuid, text, integer) TO authenticated;
