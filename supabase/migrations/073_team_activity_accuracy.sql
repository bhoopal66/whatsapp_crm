-- ============================================================
-- 073_team_activity_accuracy
--
-- Team activity (068) checked against real data gave figures and
-- warnings that were wrong in ways an owner noticed. This migration
-- redefines the 068 functions — same arguments, same security mode,
-- same grants and error messages, every existing report key kept —
-- with these rules (docs/team-activity.md says the same; change both):
--
--   Number attribution. A message belongs to the number recorded on
--   it (messages.channel_id); its kind of number comes from that row,
--   else from messages.provider. 068 fell back to the conversation's
--   current number and then to "the account's only number of that
--   provider", which (a) let a thread's current number outrank the
--   message's own provider and (b) dropped every old message the day a
--   second Whapi number was connected. Old rows without a number are
--   backfilled ONCE below, with the number that was unambiguous when
--   they were sent; what stays NULL is reported as unattributed and
--   left out of the per-number rows.
--
--   Unanswered in a row counts from the customer's last message, or
--   from the start of the conversation, however long ago — not from a
--   week before the range. A follow-up sent within 10 minutes of the
--   previous one in the same stretch is part of the same "chase" step
--   (longest_chase / chase_new / chase_existing); the ungrouped
--   figures stay as they were.
--
--   A start younger than 24 hours without a reply is PENDING: neither
--   answered nor unanswered yet (mature_* / pending_reply).
--
--   "At the limit" is >= everywhere, and a phone (Whapi) number
--   connected less than 14 days ago has min(10, limit) new chats a day
--   (team_activity_number_limit). Number limits apply to phone numbers
--   only.
--
--   The API and bots get no replies or response times; customers
--   waiting counts only chats whose customer wrote in the last 7 days;
--   failures are split by kind of number; first messages are compared
--   on a normalised text (team_activity_opener_key).
--
-- Idempotent — safe to re-run.
-- ============================================================

SET lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. Helpers
-- ------------------------------------------------------------

-- A number's daily new-chat limit at p_at: during its first 14 days a
-- phone number is warming up and may start at most 10 (Whapi's
-- warm-up guidance). Used by the report, the composer counter, the
-- block and the bell alerts so they agree.
CREATE OR REPLACE FUNCTION public.team_activity_number_limit(
  p_created_at timestamptz,
  p_limit      integer,
  p_at         timestamptz DEFAULT now()
)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_created_at IS NOT NULL AND p_at - p_created_at < interval '14 days'
      THEN least(10, p_limit)
    ELSE p_limit
  END;
$$;

REVOKE ALL ON FUNCTION public.team_activity_number_limit(timestamptz, integer, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_activity_number_limit(timestamptz, integer, timestamptz) TO authenticated, service_role;

-- A first message reduced to what makes it a template: URLs removed,
-- every word after the first that began with a capital letter dropped
-- (names), then lower case without digits or punctuation, spaces
-- collapsed, first 60 characters. NULL when nothing is left.
CREATE OR REPLACE FUNCTION public.team_activity_opener_key(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT nullif(left(btrim(regexp_replace(
           regexp_replace(lower(coalesce(string_agg(t.w, ' ' ORDER BY t.n), '')),
                          '[[:punct:][:digit:]]+', ' ', 'g'),
           '\s+', ' ', 'g')), 60), '')
  FROM regexp_split_to_table(
         btrim(regexp_replace(coalesce(p_text, ''), '(https?://|www\.|wa\.me/)\S*', ' ', 'gi')),
         '\s+') WITH ORDINALITY AS t(w, n)
  WHERE t.w <> ''
    AND (t.n = 1 OR t.w !~ '^[[:punct:]]*[[:upper:]]');
$$;

REVOKE ALL ON FUNCTION public.team_activity_opener_key(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_activity_opener_key(text) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 2. Backfill the number of old rows, where it was unambiguous then:
--    a message without one gets the account's number of its provider
--    when exactly one such number existed (created_at <=) when it was
--    sent; a conversation without one gets the number its first
--    message would get by the same rule, unless one of its messages
--    already names another. Anything else stays NULL. Only rows from
--    before the account first stamped a number on a message of that
--    provider are filled: after that, every send is stamped at insert
--    (060), so a NULL there means its number was deleted (ON DELETE SET
--    NULL), and giving it to the surviving number would inflate that
--    number's figures and move threads onto it. Re-runnable: it only
--    fills NULLs. Owner-only; the migration runs it once and
--    verify-team-activity.sql runs it on its fixture.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.team_activity_backfill_channels()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_messages      integer;
  v_conversations integer;
BEGIN
  -- Conversations first: both passes judge "before the first stamped
  -- message" against the messages as they were, and the message pass
  -- below would otherwise stamp rows that move that line.
  WITH stamped AS (
    SELECT c.account_id, m.provider, min(m.created_at) AS first_at
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.channel_id IS NOT NULL
      AND m.created_at IS NOT NULL
    GROUP BY c.account_id, m.provider
  ),
  firsts AS (
    SELECT DISTINCT ON (m.conversation_id)
      m.conversation_id, c.account_id, m.provider, m.created_at
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.channel_id IS NULL
    ORDER BY m.conversation_id, m.created_at, m.id
  ),
  pick AS (
    SELECT f.conversation_id, (array_agg(w.id))[1] AS channel_id
    FROM firsts f
    LEFT JOIN stamped st
      ON st.account_id = f.account_id AND st.provider = f.provider
    JOIN whatsapp_config w
      ON w.account_id = f.account_id
     AND w.provider = f.provider
     AND w.created_at <= f.created_at
    WHERE st.first_at IS NULL OR f.created_at < st.first_at
    GROUP BY f.conversation_id
    HAVING count(*) = 1
  )
  UPDATE conversations c
     SET channel_id = p.channel_id
    FROM pick p
   WHERE c.id = p.conversation_id
     AND c.channel_id IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM messages x
       WHERE x.conversation_id = c.id
         AND x.channel_id IS NOT NULL
         AND x.channel_id <> p.channel_id
     );
  GET DIAGNOSTICS v_conversations = ROW_COUNT;

  WITH stamped AS (
    SELECT c.account_id, m.provider, min(m.created_at) AS first_at
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.channel_id IS NOT NULL
    GROUP BY c.account_id, m.provider
  ),
  pick AS (
    SELECT m.id, (array_agg(w.id))[1] AS channel_id
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    LEFT JOIN stamped st
      ON st.account_id = c.account_id AND st.provider = m.provider
    JOIN whatsapp_config w
      ON w.account_id = c.account_id
     AND w.provider = m.provider
     AND w.created_at <= m.created_at
    WHERE m.channel_id IS NULL
      AND (st.first_at IS NULL OR m.created_at < st.first_at)
    GROUP BY m.id
    HAVING count(*) = 1
  )
  UPDATE messages m
     SET channel_id = p.channel_id
    FROM pick p
   WHERE m.id = p.id
     AND m.channel_id IS NULL;
  GET DIAGNOSTICS v_messages = ROW_COUNT;

  RETURN jsonb_build_object('messages', v_messages, 'conversations', v_conversations);
END
$$;

REVOKE ALL ON FUNCTION public.team_activity_backfill_channels() FROM PUBLIC, anon, authenticated, service_role;

SELECT public.team_activity_backfill_channels();

RESET lock_timeout;

-- ------------------------------------------------------------
-- 3. Chat starts. As 068, except the number: the message's own, and
--    its kind from that number, else from the message's provider.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.team_activity_starts(
  p_account uuid,
  p_from    timestamptz,
  p_to      timestamptz
)
RETURNS TABLE (
  message_id      uuid,
  conversation_id uuid,
  sender_type     text,
  sender_id       uuid,
  -- NULL when the message recorded no number (see the backfill).
  channel_id      uuid,
  started_at      timestamptz,
  new_contact     boolean,
  replied         boolean,
  has_link        boolean,
  opener_hash     text,
  preview         text,
  -- 'whapi' / 'meta': the number's, else the message's own provider.
  provider        text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH win AS (
    SELECT
      m.id,
      m.conversation_id,
      m.sender_type,
      m.sender_id,
      m.created_at,
      m.content_text,
      m.channel_id,
      m.provider,
      lag(m.created_at) OVER (
        PARTITION BY m.conversation_id ORDER BY m.created_at, m.id
      ) AS prev_at
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.account_id = p_account
      AND m.created_at >= p_from - interval '24 hours'
      AND m.created_at < p_to
      -- Refused by WhatsApp: reached nobody, so neither a start nor the
      -- message a later one follows.
      AND m.status <> 'failed'
  ),
  candidates AS (
    SELECT w.*
    FROM win w
    WHERE w.sender_type <> 'customer'
      AND w.created_at >= p_from
      AND (w.prev_at IS NULL OR w.prev_at <= w.created_at - interval '24 hours')
  ),
  starts AS (
    SELECT
      cd.*,
      lead(cd.created_at) OVER (
        PARTITION BY cd.conversation_id ORDER BY cd.created_at, cd.id
      ) AS next_start_at
    FROM candidates cd
    -- Answering a customer who wrote last is a reply, however late. The
    -- previous message may be older than the scan, so it is looked up.
    WHERE coalesce((
      SELECT x.sender_type
      FROM messages x
      WHERE x.conversation_id = cd.conversation_id
        AND x.status <> 'failed'
        AND (x.created_at < cd.created_at
             OR (x.created_at = cd.created_at AND x.id < cd.id))
      ORDER BY x.created_at DESC, x.id DESC
      LIMIT 1
    ), '') <> 'customer'
  )
  SELECT
    s.id,
    s.conversation_id,
    s.sender_type,
    s.sender_id,
    s.channel_id,
    s.created_at,
    NOT EXISTS (
      SELECT 1 FROM messages x
      WHERE x.conversation_id = s.conversation_id
        AND x.sender_type = 'customer'
        AND x.created_at < s.created_at
    ),
    EXISTS (
      SELECT 1 FROM messages x
      WHERE x.conversation_id = s.conversation_id
        AND x.sender_type = 'customer'
        AND x.created_at > s.created_at
        AND (s.next_start_at IS NULL OR x.created_at < s.next_start_at)
    ),
    coalesce(s.content_text ~* '(https?://|www\.|wa\.me/)', false),
    -- Identical openers are compared on a whitespace- and case-folded
    -- hash; short texts ("Hi") are too common to mean anything.
    CASE WHEN char_length(btrim(coalesce(s.content_text, ''))) >= 20
         THEN md5(lower(regexp_replace(btrim(s.content_text), '\s+', ' ', 'g')))
    END,
    left(s.content_text, 160),
    coalesce(w.provider, s.provider)
  FROM starts s
  LEFT JOIN whatsapp_config w ON w.id = s.channel_id AND w.account_id = p_account;
$$;

REVOKE ALL ON FUNCTION public.team_activity_starts(uuid, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_activity_starts(uuid, timestamptz, timestamptz) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 4. The admin report. Senders are keyed (kind, user id) and numbers by
--    number id all the way to the final build, so a caller-scoped set
--    of people can filter them later.
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
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_account uuid := current_account_id();
  v_cfg     record;
  v_tz      text;
  v_today   timestamptz;
  v_result  jsonb;
BEGIN
  IF v_account IS NULL OR current_role_rank() < 4 THEN
    RAISE EXCEPTION 'Only owners and admins can view team activity'
      USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from
     OR p_to - p_from > interval '100 days' THEN
    RAISE EXCEPTION 'The range must be shorter than 100 days'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_cfg FROM team_activity_limits(v_account);
  v_tz := coalesce(v_cfg.timezone, team_activity_valid_zone(p_tz), 'UTC');
  v_today := date_trunc('day', now() AT TIME ZONE v_tz) AT TIME ZONE v_tz;

  WITH
  numbers AS (
    SELECT w.id AS channel_id, w.provider, w.label, w.waba_id, w.phone_number_id,
           w.status, w.is_primary, w.created_at, w.connected_at
    FROM whatsapp_config w
    WHERE w.account_id = v_account
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
      m.sender_type = 'customer' AS is_customer
    FROM bounds b
    JOIN messages m ON m.conversation_id = b.conversation_id
    LEFT JOIN whatsapp_config w ON w.id = m.channel_id
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
  ),
  om AS (
    SELECT * FROM om_all
    WHERE p_channel_id IS NULL OR channel_id = p_channel_id
  ),
  inbound AS (
    SELECT * FROM msgs
    WHERE is_customer AND created_at >= p_from
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
  -- The per-person limits protect the Whapi numbers: the busiest day,
  -- the days at the limit, the bursts and today's count are over
  -- chats started on Whapi numbers only.
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
      WHERE provider = 'whapi'
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
      WHERE provider = 'whapi'
    ) b
    GROUP BY kind, key_id
  ),
  s_today AS (
    SELECT kind, key_id, count(*) AS today_starts
    FROM today_starts
    WHERE provider = 'whapi'
      AND (p_channel_id IS NULL OR channel_id = p_channel_id)
    GROUP BY kind, key_id
  ),
  s_msgs AS (
    SELECT
      kind, key_id,
      count(*) AS messages_sent,
      count(DISTINCT conversation_id) AS conversations,
      count(*) FILTER (WHERE status = 'failed') AS failed,
      count(*) FILTER (WHERE status = 'failed' AND provider = 'whapi') AS failed_phone,
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
    SELECT 'person'::text AS kind, user_id AS key_id FROM people
    UNION SELECT kind, key_id FROM s_starts
    UNION SELECT kind, key_id FROM s_msgs
    UNION SELECT kind, key_id FROM s_today
    UNION SELECT 'person', key_id FROM s_broadcasts
    UNION SELECT 'person', key_id FROM s_waiting WHERE key_id IS NOT NULL
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
    WHERE is_customer AND created_at >= p_from AND channel_id IS NOT NULL
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
    'scope', 'account',
    'team_names', '[]'::jsonb,
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
        'kind', CASE nb.provider WHEN 'whapi' THEN 'phone' WHEN 'meta' THEN 'official' END,
        'label', nb.label,
        'waba_id', nb.waba_id,
        'phone_number_id', nb.phone_number_id,
        'status', nb.status,
        'is_primary', nb.is_primary,
        'connected_at', nb.connected_at,
        'created_at', nb.created_at,
        'age_days', floor(extract(epoch FROM now() - nb.created_at) / 86400)::integer,
        'warming_up', nb.provider = 'whapi'
                      AND coalesce(now() - nb.created_at < interval '14 days', false),
        'effective_daily_limit', CASE WHEN nb.provider = 'whapi' THEN
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
        'days_at_limit', CASE WHEN nb.provider = 'whapi' THEN coalesce(nd.days_at_limit, 0) END,
        'burst_10min', coalesce(nbu.burst_10min, 0),
        'today_starts', coalesce(nt.today_starts, 0),
        'today_started', coalesce(nt.today_starts, 0)
      ) ORDER BY nb.is_primary DESC NULLS LAST, nb.provider, nb.created_at, nb.channel_id)
      FROM numbers nb
      LEFT JOIN n_starts ns ON ns.channel_id = nb.channel_id
      LEFT JOIN n_days nd ON nd.channel_id = nb.channel_id
      LEFT JOIN n_burst nbu ON nbu.channel_id = nb.channel_id
      LEFT JOIN n_today nt ON nt.channel_id = nb.channel_id
      LEFT JOIN n_msgs nm ON nm.channel_id = nb.channel_id
      LEFT JOIN n_inbound ni ON ni.channel_id = nb.channel_id
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
-- 5. Drill-down: as 068; 'unanswered' counts runs from their real
--    start and uses the message's own number.
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
SECURITY INVOKER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_account uuid := current_account_id();
  v_max     integer;
  v_limit   integer := least(greatest(coalesce(p_limit, 200), 1), 500);
BEGIN
  IF v_account IS NULL OR current_role_rank() < 4 THEN
    RAISE EXCEPTION 'Only owners and admins can view team activity'
      USING ERRCODE = '42501';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('person', 'api', 'bot')
     OR (p_kind = 'person' AND p_user_id IS NULL) THEN
    RAISE EXCEPTION 'Unknown sender' USING ERRCODE = '22023';
  END IF;
  IF p_filter IS NULL OR p_filter NOT IN ('no_reply', 'all', 'unanswered') THEN
    RAISE EXCEPTION 'Unknown filter' USING ERRCODE = '22023';
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
    LEFT JOIN contacts ct ON ct.id = c.contact_id
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
  LEFT JOIN contacts ct ON ct.id = c.contact_id
  WHERE s.started_at < p_to
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

-- ------------------------------------------------------------
-- 6. The caller's own day: as 068, plus each number's limit today.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.team_activity_my_day(p_tz text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_account uuid := current_account_id();
  v_cfg     record;
  v_tz      text;
  v_today   timestamptz;
  v_result  jsonb;
BEGIN
  IF v_uid IS NULL OR v_account IS NULL THEN
    RAISE EXCEPTION 'Not a member of an account' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_cfg FROM team_activity_limits(v_account);
  v_tz := coalesce(v_cfg.timezone, team_activity_valid_zone(p_tz), 'UTC');
  v_today := date_trunc('day', now() AT TIME ZONE v_tz) AT TIME ZONE v_tz;

  WITH s AS (
    SELECT * FROM team_activity_starts(v_account, v_today, 'infinity')
  ),
  -- The per-person limit protects the Whapi numbers: only chats this
  -- person started on one count towards it.
  mine AS (
    SELECT * FROM s
    WHERE s.sender_type = 'agent' AND s.sender_id = v_uid AND s.provider = 'whapi'
  )
  SELECT jsonb_build_object(
    'tz', v_tz,
    'day', (now() AT TIME ZONE v_tz)::date,
    'started', (SELECT count(*) FROM mine),
    'new_contacts', (SELECT count(*) FROM mine WHERE mine.new_contact),
    'no_reply', (SELECT count(*) FROM mine WHERE NOT mine.replied),
    'numbers', coalesce((
      -- effective_daily_limit: a phone number's limit today (lower
      -- while it warms up); NULL for an official number, which has none.
      SELECT jsonb_agg(jsonb_build_object(
        'channel_id', x.channel_id, 'started', x.n,
        'warming_up', w.provider = 'whapi'
                      AND coalesce(now() - w.created_at < interval '14 days', false),
        'effective_daily_limit', CASE WHEN w.provider = 'whapi' THEN
          team_activity_number_limit(w.created_at, v_cfg.daily_new_chats_per_number) END))
      FROM (
        SELECT s.channel_id, count(*) AS n
        FROM s WHERE s.channel_id IS NOT NULL
        GROUP BY s.channel_id
      ) x
      JOIN whatsapp_config w ON w.id = x.channel_id
    ), '[]'::jsonb),
    'limits', jsonb_build_object(
      'daily_new_chats_per_user', v_cfg.daily_new_chats_per_user,
      'daily_new_chats_per_number', v_cfg.daily_new_chats_per_number,
      'max_unanswered_in_row', v_cfg.max_unanswered_in_row,
      'block_over_limit', v_cfg.block_over_limit
    ),
    -- Whether the block applies to this caller at all.
    'blocked_when_over', v_cfg.block_over_limit AND current_role_rank() < 4
  )
  INTO v_result;

  RETURN v_result;
END
$$;

REVOKE ALL ON FUNCTION public.team_activity_my_day(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_activity_my_day(text) TO authenticated;

-- ------------------------------------------------------------
-- 7. The send check: as 068, the number limit only for phone numbers
--    and at the warm-up limit while one is young.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.team_activity_start_check(
  p_conversation_id uuid,
  p_channel_id      uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_account uuid;
  v_cfg     record;
  v_tz      text;
  v_today   timestamptz;
  v_mine    integer;
  v_number  integer;
  v_last_by text;
  v_last_at timestamptz;
  v_nlimit  integer;
BEGIN
  IF v_uid IS NULL OR p_conversation_id IS NULL THEN
    RETURN jsonb_build_object('blocked', false);
  END IF;

  SELECT c.account_id INTO v_account
  FROM conversations c
  WHERE c.id = p_conversation_id;
  IF v_account IS NULL OR v_account IS DISTINCT FROM current_account_id() THEN
    RETURN jsonb_build_object('blocked', false);
  END IF;

  SELECT * INTO v_cfg FROM team_activity_limits(v_account);
  IF NOT coalesce(v_cfg.block_over_limit, false) OR current_role_rank() >= 4 THEN
    RETURN jsonb_build_object('blocked', false);
  END IF;

  -- A reply, not a new chat: the chat moved in the last 24 hours, or
  -- the customer was the last to write (answering them is never
  -- blocked, however late). Refused sends do not count.
  SELECT m.sender_type, m.created_at INTO v_last_by, v_last_at
  FROM messages m
  WHERE m.conversation_id = p_conversation_id
    AND m.status <> 'failed'
  ORDER BY m.created_at DESC, m.id DESC
  LIMIT 1;
  IF v_last_at IS NOT NULL
     AND (v_last_at > now() - interval '24 hours' OR v_last_by = 'customer') THEN
    RETURN jsonb_build_object('blocked', false);
  END IF;

  v_tz := coalesce(v_cfg.timezone, 'UTC');
  v_today := date_trunc('day', now() AT TIME ZONE v_tz) AT TIME ZONE v_tz;

  SELECT
    count(*) FILTER (
      WHERE s.sender_type = 'agent' AND s.sender_id = v_uid AND s.provider = 'whapi'
    ),
    count(*) FILTER (WHERE p_channel_id IS NOT NULL AND s.channel_id = p_channel_id)
  INTO v_mine, v_number
  FROM team_activity_starts(v_account, v_today, 'infinity') s;

  IF v_mine >= v_cfg.daily_new_chats_per_user THEN
    RETURN jsonb_build_object(
      'blocked', true, 'reason', 'user',
      'started', v_mine, 'limit', v_cfg.daily_new_chats_per_user);
  END IF;
  -- Number limits are for phone (Whapi) numbers only, lower while the
  -- number warms up.
  SELECT team_activity_number_limit(w.created_at, v_cfg.daily_new_chats_per_number)
    INTO v_nlimit
  FROM whatsapp_config w
  WHERE w.id = p_channel_id AND w.account_id = v_account AND w.provider = 'whapi';
  IF v_nlimit IS NOT NULL AND v_number >= v_nlimit THEN
    RETURN jsonb_build_object(
      'blocked', true, 'reason', 'number',
      'started', v_number, 'limit', v_nlimit);
  END IF;
  RETURN jsonb_build_object('blocked', false);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'team_activity_start_check failed: %', SQLERRM;
  RETURN jsonb_build_object('blocked', false);
END
$$;

REVOKE ALL ON FUNCTION public.team_activity_start_check(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_activity_start_check(uuid, uuid) TO authenticated;

-- ------------------------------------------------------------
-- 8. The alert sweep: as 068, "at the limit" (>=) for people too, and
--    a young phone number's warm-up limit.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.team_activity_alert_sweep()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account uuid;
  v_cfg     record;
  v_tz      text;
  v_today   timestamptz;
  v_day     date;
  r         record;
  v_alerts  integer := 0;
  v_notes   integer := 0;
  v_n       integer;
BEGIN
  FOR v_account IN
    SELECT DISTINCT c.account_id
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.created_at > now() - interval '25 hours'
      AND m.sender_type <> 'customer'
  LOOP
    SELECT * INTO v_cfg FROM team_activity_limits(v_account);
    -- Only once an admin has saved the limits: until then nobody has
    -- chosen them, and "today" would be the UTC day.
    CONTINUE WHEN NOT coalesce(v_cfg.saved, false) OR NOT coalesce(v_cfg.notify, true);

    v_tz := coalesce(v_cfg.timezone, 'UTC');
    v_today := date_trunc('day', now() AT TIME ZONE v_tz) AT TIME ZONE v_tz;
    v_day := (now() AT TIME ZONE v_tz)::date;

    FOR r IN
      WITH s AS (
        SELECT * FROM team_activity_starts(v_account, v_today, 'infinity')
      )
      SELECT
        'user_daily_limit'::text AS kind,
        s.sender_id AS subject_id,
        count(*)::integer AS n,
        v_cfg.daily_new_chats_per_user AS lim,
        coalesce(max(nullif(btrim(p.full_name), '')), max(p.email), 'A team member') AS who
      FROM s
      LEFT JOIN profiles p ON p.user_id = s.sender_id
      WHERE s.sender_type = 'agent' AND s.sender_id IS NOT NULL AND s.provider = 'whapi'
      GROUP BY s.sender_id
      HAVING count(*) >= v_cfg.daily_new_chats_per_user
      UNION ALL
      SELECT
        'number_daily_limit',
        w.id,
        count(*)::integer,
        team_activity_number_limit(max(w.created_at), v_cfg.daily_new_chats_per_number),
        coalesce(max(nullif(btrim(w.label), '')), max(w.waba_id), 'A WhatsApp number')
      FROM s
      JOIN whatsapp_config w
        ON w.id = s.channel_id AND w.account_id = v_account AND w.provider = 'whapi'
      GROUP BY w.id
      HAVING count(*) >= team_activity_number_limit(max(w.created_at), v_cfg.daily_new_chats_per_number)
    LOOP
      INSERT INTO team_activity_alerts (account_id, kind, subject_id, day, value, threshold)
      VALUES (v_account, r.kind, r.subject_id, v_day, r.n, r.lim)
      ON CONFLICT DO NOTHING;
      CONTINUE WHEN NOT FOUND;
      v_alerts := v_alerts + 1;

      IF r.kind = 'user_daily_limit' THEN
        INSERT INTO notifications (account_id, user_id, type, title, body)
        SELECT
          v_account, p.user_id, 'team_activity_alert',
          CASE WHEN p.user_id = r.subject_id
               THEN 'You have reached today''s new-chat limit'
               ELSE 'Daily new-chat limit reached' END,
          CASE WHEN p.user_id = r.subject_id
               THEN format('You have started %s new chats today; the limit is %s. Answer the chats you already have and start new ones tomorrow: unanswered first messages are the main reason WhatsApp restricts a number.', r.n, r.lim)
               ELSE format('%s has started %s new chats today; the limit is %s. Unanswered first messages are the main reason WhatsApp restricts a number.', r.who, r.n, r.lim) END
        FROM profiles p
        WHERE p.account_id = v_account
          AND (p.account_role IN ('owner', 'admin') OR p.user_id = r.subject_id);
      ELSE
        INSERT INTO notifications (account_id, user_id, type, title, body)
        SELECT
          v_account, p.user_id, 'team_activity_alert',
          'A WhatsApp number reached its daily new-chat limit',
          format('%s has started %s new chats today; the limit is %s. Starting more today raises the risk of WhatsApp restricting this number.', r.who, r.n, r.lim)
        FROM profiles p
        WHERE p.account_id = v_account
          AND p.account_role IN ('owner', 'admin');
      END IF;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_notes := v_notes + v_n;
    END LOOP;
  END LOOP;

  DELETE FROM team_activity_alerts WHERE created_at < now() - interval '90 days';

  RETURN jsonb_build_object('alerts', v_alerts, 'notifications', v_notes);
END
$$;

REVOKE ALL ON FUNCTION public.team_activity_alert_sweep() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.team_activity_alert_sweep() TO service_role;
