-- ============================================================
-- 068_team_activity
--
-- Team activity: an admin view of who starts WhatsApp chats, how many
-- of them get an answer, and the sending patterns that get a Whapi
-- number restricted; plus the limits behind the warnings employees see
-- in the composer, the bell alerts, and the optional block on new
-- chats.
--
-- Why
--
--   A Whapi number is an ordinary WhatsApp account driven through a
--   linked device, and WhatsApp restricts such numbers on what the
--   recipients do with their messages: unanswered first messages,
--   blocks and reports. Whapi's own guidance (docs/team-activity.md)
--   comes down to: at least ~30 replies per 100 chats started, ramp new
--   chats up slowly, no bursts, no links or identical text in a first
--   message. None of that was visible per employee or per number.
--
-- Definitions (docs/team-activity.md says the same — change both)
--
--   A chat is STARTED by whoever sends a message (a person, the API or
--   a bot) into a conversation that had no message from anyone in the
--   previous 24 hours (WhatsApp's own business-initiated conversation),
--   unless the customer was the last to write: answering them, however
--   late, is a reply. It is to a NEW CONTACT when the customer had never
--   written to us before it, and it is REPLIED when the customer writes
--   back before the next start in the same conversation.
--
--   An UNANSWERED RUN is the outbound messages since the customer last
--   wrote (or since the beginning, when they never did); a message
--   whose position in the run is above max_unanswered_in_row is one
--   too many.
--
--   A message WhatsApp refused (status 'failed') reached nobody: it is
--   counted as a failure, never as a start or as part of a run.
--
--   The per-person limits (the day's new chats, bursts) protect the
--   Whapi numbers, so they count chats started on Whapi numbers only;
--   a Meta number cannot start a chat without an approved template.
--
-- Security
--
--   The admin report and the drill-down are SECURITY INVOKER, so the
--   messages' RLS still applies, and they refuse anyone below admin.
--   The employee's own counter and the send check are SECURITY DEFINER
--   — RLS can hide a chat an agent started that was reassigned since,
--   which would undercount them — and return only the caller's own
--   figures plus per-number totals. The alert sweep is service role
--   only.
--
-- Idempotent — safe to re-run.
-- ============================================================

SET lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. Limits. One row per account; no row means the defaults below.
--    The defaults live in four places — these column defaults,
--    team_activity_limits(), TEAM_ACTIVITY_DEFAULTS in
--    lib/team-activity/limits.ts and docs/team-activity.md — and
--    limits.test.ts keeps the first three equal.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.team_activity_settings (
  account_id                  uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- New chats one person may start in a local day.
  daily_new_chats_per_user    integer NOT NULL DEFAULT 20
                              CHECK (daily_new_chats_per_user BETWEEN 1 AND 1000),
  -- New chats one Whapi number may start in a local day, everyone together.
  daily_new_chats_per_number  integer NOT NULL DEFAULT 50
                              CHECK (daily_new_chats_per_number BETWEEN 1 AND 5000),
  -- Percent of started chats that should get a reply.
  min_reply_rate              integer NOT NULL DEFAULT 30
                              CHECK (min_reply_rate BETWEEN 0 AND 100),
  -- Messages in a row a contact may receive without answering.
  max_unanswered_in_row       integer NOT NULL DEFAULT 3
                              CHECK (max_unanswered_in_row BETWEEN 1 AND 50),
  -- New chats one person may start inside any 10 minutes.
  burst_new_chats_10min       integer NOT NULL DEFAULT 10
                              CHECK (burst_new_chats_10min BETWEEN 1 AND 500),
  -- Local hours in which starting a chat counts as a night start.
  -- start = end turns the check off; start > end wraps past midnight.
  quiet_hours_start           smallint NOT NULL DEFAULT 22
                              CHECK (quiet_hours_start BETWEEN 0 AND 23),
  quiet_hours_end             smallint NOT NULL DEFAULT 8
                              CHECK (quiet_hours_end BETWEEN 0 AND 23),
  -- What "today" means for the limits, the alerts and the block.
  timezone                    text NOT NULL DEFAULT 'UTC'
                              CHECK (char_length(timezone) BETWEEN 1 AND 64),
  -- Bell alerts to owners, admins and the person over the limit.
  notify                      boolean NOT NULL DEFAULT true,
  -- Refuse a person's new chat once they, or the number, are at the
  -- daily limit. Owners and admins are never refused.
  block_over_limit            boolean NOT NULL DEFAULT false,
  updated_by                  uuid,
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.team_activity_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.team_activity_settings FROM PUBLIC, anon, authenticated, service_role;

-- Who changed it and when is the database's to say. The time zone must
-- be a named zone: Postgres also takes POSIX strings such as '+04', but
-- reads their sign the opposite way to the browser, which would put
-- "today" eight hours out.
CREATE OR REPLACE FUNCTION public.team_activity_settings_stamp()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = new.timezone) THEN
    RAISE EXCEPTION 'Unknown time zone: %', new.timezone
      USING ERRCODE = '22023';
  END IF;
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  RETURN new;
END
$$;

DROP TRIGGER IF EXISTS team_activity_settings_stamp ON public.team_activity_settings;
CREATE TRIGGER team_activity_settings_stamp
  BEFORE INSERT OR UPDATE ON public.team_activity_settings
  FOR EACH ROW EXECUTE FUNCTION public.team_activity_settings_stamp();

DROP POLICY IF EXISTS team_activity_settings_read   ON public.team_activity_settings;
DROP POLICY IF EXISTS team_activity_settings_insert ON public.team_activity_settings;
DROP POLICY IF EXISTS team_activity_settings_update ON public.team_activity_settings;
CREATE POLICY team_activity_settings_read ON public.team_activity_settings
  FOR SELECT TO authenticated
  USING (
    account_id = (SELECT public.current_account_id())
    AND (SELECT public.current_role_rank()) >= 4
  );
CREATE POLICY team_activity_settings_insert ON public.team_activity_settings
  FOR INSERT TO authenticated
  WITH CHECK (
    account_id = (SELECT public.current_account_id())
    AND (SELECT public.current_role_rank()) >= 4
  );
CREATE POLICY team_activity_settings_update ON public.team_activity_settings
  FOR UPDATE TO authenticated
  USING (
    account_id = (SELECT public.current_account_id())
    AND (SELECT public.current_role_rank()) >= 4
  )
  WITH CHECK (
    account_id = (SELECT public.current_account_id())
    AND (SELECT public.current_role_rank()) >= 4
  );

REVOKE ALL ON FUNCTION public.team_activity_settings_stamp() FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.team_activity_settings TO authenticated;
GRANT SELECT ON public.team_activity_settings TO service_role;

-- ------------------------------------------------------------
-- 2. Alerts already sent: one per (kind, person or number, local day),
--    so a sweep every few minutes alerts once. Kept 90 days.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.team_activity_alerts (
  account_id  uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('user_daily_limit', 'number_daily_limit')),
  -- The person (auth user id) or the number (whatsapp_config id).
  subject_id  uuid NOT NULL,
  day         date NOT NULL,
  value       integer NOT NULL,
  threshold   integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, kind, subject_id, day)
);
ALTER TABLE public.team_activity_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.team_activity_alerts FROM PUBLIC, anon, authenticated, service_role;

DROP POLICY IF EXISTS team_activity_alerts_read ON public.team_activity_alerts;
CREATE POLICY team_activity_alerts_read ON public.team_activity_alerts
  FOR SELECT TO authenticated
  USING (
    account_id = (SELECT public.current_account_id())
    AND (SELECT public.current_role_rank()) >= 4
  );
GRANT SELECT ON public.team_activity_alerts TO authenticated;
GRANT SELECT ON public.team_activity_alerts TO service_role;

-- ------------------------------------------------------------
-- 3. The bell alert type. 065 is the last list; keep every value.
-- ------------------------------------------------------------
ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'conversation_assigned',
    'channel_disconnected',
    'channel_reconnected',
    'team_activity_alert'
  ));

RESET lock_timeout;

-- ------------------------------------------------------------
-- 4. Helpers
-- ------------------------------------------------------------

-- p_tz when it is a named zone Postgres knows, else NULL. Browsers send
-- IANA names; anything else (including a POSIX '+04', whose sign
-- Postgres reads backwards) falls back rather than failing the report.
CREATE OR REPLACE FUNCTION public.team_activity_valid_zone(p_tz text)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
BEGIN
  IF p_tz IS NULL OR p_tz !~ '^[A-Za-z]' OR char_length(p_tz) > 64 THEN
    RETURN NULL;
  END IF;
  PERFORM now() AT TIME ZONE p_tz;
  RETURN p_tz;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.team_activity_valid_zone(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_activity_valid_zone(text) TO authenticated, service_role;

-- The account's limits with the defaults filled in. `timezone` stays
-- NULL until an admin saves the settings, so callers can fall back to
-- the viewer's zone; `saved` says whether a row exists. SECURITY
-- DEFINER because employees need their own limits and the settings
-- table is admins-only; a signed-in caller only ever gets their own
-- account's row.
CREATE OR REPLACE FUNCTION public.team_activity_limits(p_account uuid)
RETURNS TABLE (
  daily_new_chats_per_user   integer,
  daily_new_chats_per_number integer,
  min_reply_rate             integer,
  max_unanswered_in_row      integer,
  burst_new_chats_10min      integer,
  quiet_hours_start          integer,
  quiet_hours_end            integer,
  timezone                   text,
  notify                     boolean,
  block_over_limit           boolean,
  saved                      boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    coalesce(s.daily_new_chats_per_user, 20),
    coalesce(s.daily_new_chats_per_number, 50),
    coalesce(s.min_reply_rate, 30),
    coalesce(s.max_unanswered_in_row, 3),
    coalesce(s.burst_new_chats_10min, 10),
    coalesce(s.quiet_hours_start, 22)::integer,
    coalesce(s.quiet_hours_end, 8)::integer,
    s.timezone,
    coalesce(s.notify, true),
    coalesce(s.block_over_limit, false),
    s.account_id IS NOT NULL
  FROM (SELECT p_account AS account_id) a
  LEFT JOIN team_activity_settings s ON s.account_id = a.account_id
  WHERE auth.uid() IS NULL
     OR a.account_id = (SELECT current_account_id());
$$;

REVOKE ALL ON FUNCTION public.team_activity_limits(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_activity_limits(uuid) TO authenticated, service_role;

-- Every chat started in [p_from, p_to) on the account, with what
-- happened to it and the kind of number it went out on. Pass
-- p_to = 'infinity' unless the range really ends in the past: the
-- reply window of a start closes at the NEXT start, which has to be
-- inside the scan to be seen.
--
-- SECURITY INVOKER: a signed-in caller sees the starts in chats RLS
-- lets them read and nothing else; the definer functions below call it
-- with the RLS of their owner.
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
  channel_id      uuid,
  started_at      timestamptz,
  new_contact     boolean,
  replied         boolean,
  has_link        boolean,
  opener_hash     text,
  preview         text,
  -- 'whapi' / 'meta' for the number it went out on; NULL when unknown.
  provider        text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH sole AS (
    -- The account's only number of a kind. An older row that recorded
    -- just its provider was carried by it (resolveReplyChannel reads
    -- such rows the same way).
    SELECT w.provider, (array_agg(w.id))[1] AS id
    FROM whatsapp_config w
    WHERE w.account_id = p_account
    GROUP BY w.provider
    HAVING count(*) = 1
  ),
  win AS (
    SELECT
      m.id,
      m.conversation_id,
      m.sender_type,
      m.sender_id,
      m.created_at,
      m.content_text,
      -- Rows older than 046/060 carry no number: then the thread's, then
      -- the account's only number of the row's provider.
      coalesce(m.channel_id, c.channel_id, so.id) AS channel_id,
      lag(m.created_at) OVER (
        PARTITION BY m.conversation_id ORDER BY m.created_at, m.id
      ) AS prev_at
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    LEFT JOIN sole so ON so.provider = m.provider
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
    w.provider
  FROM starts s
  LEFT JOIN whatsapp_config w ON w.id = s.channel_id;
$$;

REVOKE ALL ON FUNCTION public.team_activity_starts(uuid, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_activity_starts(uuid, timestamptz, timestamptz) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 5. The admin report — everything the Team activity page shows, in
--    one round trip (the page sits behind a tunnel). p_channel_id
--    narrows the people, the daily and the hourly figures to one
--    number; the per-number section always covers every number.
--    Broadcasts record no number, so a narrowed report leaves them out.
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
      extract(hour FROM s.started_at AT TIME ZONE v_tz)::int AS local_hour
    FROM team_activity_starts(v_account, least(p_from, v_today), 'infinity') s
  ),
  -- Same text opening five or more chats on one number.
  openers AS (
    SELECT channel_id, opener_hash, count(DISTINCT conversation_id) AS chats
    FROM all_starts
    WHERE opener_hash IS NOT NULL AND started_at >= p_from AND started_at < p_to
    GROUP BY channel_id, opener_hash
  ),
  rs_all AS (
    SELECT
      a.*,
      coalesce(o.chats, 0) >= 5 AS identical,
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
    WHERE a.started_at >= p_from AND a.started_at < p_to
  ),
  rs AS (
    SELECT * FROM rs_all
    WHERE p_channel_id IS NULL OR channel_id = p_channel_id
  ),
  today_starts AS (
    SELECT * FROM all_starts WHERE started_at >= v_today
  ),
  -- The account's only number of a kind, for rows that recorded just
  -- their provider (as in team_activity_starts).
  sole AS (
    SELECT w.provider, (array_agg(w.id))[1] AS id
    FROM whatsapp_config w
    WHERE w.account_id = v_account
    GROUP BY w.provider
    HAVING count(*) = 1
  ),
  -- Messages, with a week before the range so an unanswered run or a
  -- customer wait that began just before it is counted from its start.
  msgs AS (
    SELECT
      m.id,
      m.conversation_id,
      m.sender_type,
      m.sender_id,
      m.status,
      m.created_at,
      coalesce(m.channel_id, c.channel_id, so.id) AS channel_id,
      m.sender_type = 'customer' AS is_customer
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    LEFT JOIN sole so ON so.provider = m.provider
    WHERE c.account_id = v_account
      AND m.created_at >= p_from - interval '7 days'
      AND m.created_at < p_to
  ),
  -- Runs and response times count what reached WhatsApp: a refused
  -- send is no reply and no part of a run.
  seq AS (
    SELECT
      msgs.*,
      lag(is_customer) OVER w AS prev_customer,
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
      END AS run_pos
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
      s2.conversation_id,
      s2.status,
      s2.created_at,
      s2.run_pos,
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
      f.conversation_id,
      f.status,
      f.created_at,
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
      count(*) FILTER (WHERE new_contact AND NOT replied) AS new_contacts_no_reply,
      count(*) FILTER (WHERE new_contact AND has_link) AS links_first,
      count(*) FILTER (WHERE identical) AS identical_openers,
      count(*) FILTER (WHERE night) AS night_starts
    FROM rs
    GROUP BY kind, key_id
  ),
  -- The per-person limits protect the Whapi numbers: the busiest day,
  -- the days over the limit, the bursts and today's count are over
  -- chats started on Whapi numbers only.
  s_days AS (
    SELECT
      kind, key_id,
      max(n) AS peak_day,
      count(*) FILTER (
        WHERE kind = 'person' AND n > v_cfg.daily_new_chats_per_user
      ) AS days_over_limit
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
    SELECT
      CASE
        WHEN sender_type = 'bot' THEN 'bot'
        WHEN sender_id IS NULL THEN 'api'
        ELSE 'person'
      END AS kind,
      CASE WHEN sender_type = 'agent' THEN sender_id END AS key_id,
      count(*) AS today_starts
    FROM today_starts
    WHERE provider = 'whapi'
      AND (p_channel_id IS NULL OR channel_id = p_channel_id)
    GROUP BY 1, 2
  ),
  s_msgs AS (
    SELECT
      kind, key_id,
      count(*) AS messages_sent,
      count(DISTINCT conversation_id) AS conversations,
      count(*) FILTER (WHERE status = 'failed') AS failed,
      count(*) FILTER (WHERE status IN ('delivered', 'read')) AS delivered,
      count(*) FILTER (WHERE status = 'read') AS read,
      count(*) FILTER (WHERE run_pos > v_cfg.max_unanswered_in_row) AS unanswered_over_limit,
      count(DISTINCT conversation_id) FILTER (
        WHERE run_pos > v_cfg.max_unanswered_in_row
      ) AS unanswered_chats,
      coalesce(max(run_pos), 0) AS max_unanswered_run,
      count(DISTINCT (created_at AT TIME ZONE v_tz)::date) AS active_days
    FROM om
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
    WHERE prev_customer IS TRUE
      AND cust_run_start IS NOT NULL
      AND created_at >= cust_run_start
    GROUP BY kind, key_id
  ),
  s_waiting AS (
    SELECT
      c.assigned_agent_id AS key_id,
      count(*) AS waiting,
      max(extract(epoch FROM now() - lm.created_at) / 60.0) AS oldest_min
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
      AND lm.sender_type = 'customer'
      AND (p_channel_id IS NULL OR c.channel_id = p_channel_id)
    GROUP BY c.assigned_agent_id
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
  n_starts AS (
    SELECT
      channel_id,
      count(*) AS chats_started,
      count(*) FILTER (WHERE new_contact) AS new_contacts,
      count(*) FILTER (WHERE NOT replied) AS no_reply,
      count(*) FILTER (WHERE new_contact AND has_link) AS links_first,
      count(*) FILTER (WHERE identical) AS identical_openers,
      count(*) FILTER (WHERE night) AS night_starts
    FROM rs_all
    GROUP BY channel_id
  ),
  n_days AS (
    SELECT
      channel_id,
      max(n) AS peak_day,
      count(*) FILTER (WHERE n > v_cfg.daily_new_chats_per_number) AS days_over_limit
    FROM (
      SELECT channel_id, local_day, count(*) AS n
      FROM rs_all GROUP BY channel_id, local_day
    ) d
    GROUP BY channel_id
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
    ) b
    GROUP BY channel_id
  ),
  n_today AS (
    SELECT channel_id, count(*) AS today_starts
    FROM today_starts
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
    GROUP BY channel_id
  ),
  n_inbound AS (
    SELECT channel_id, count(*) AS received
    FROM msgs
    WHERE is_customer AND created_at >= p_from
    GROUP BY channel_id
  ),
  numbers AS (
    SELECT w.id AS channel_id, w.provider, w.label, w.waba_id, w.phone_number_id,
           w.status, w.is_primary, w.created_at, w.connected_at
    FROM whatsapp_config w
    WHERE w.account_id = v_account
  ),
  n_keys AS (
    SELECT channel_id FROM numbers
    UNION SELECT channel_id FROM n_starts
    UNION SELECT channel_id FROM n_msgs
    UNION SELECT channel_id FROM n_inbound
    UNION SELECT channel_id FROM n_today
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
        'delivered', coalesce(sm.delivered, 0),
        'read', coalesce(sm.read, 0),
        'active_days', coalesce(sm.active_days, 0),
        'chats_started', coalesce(ss.chats_started, 0),
        'new_contacts', coalesce(ss.new_contacts, 0),
        'no_reply', coalesce(ss.no_reply, 0),
        'new_contacts_no_reply', coalesce(ss.new_contacts_no_reply, 0),
        'links_first', coalesce(ss.links_first, 0),
        'identical_openers', coalesce(ss.identical_openers, 0),
        'night_starts', coalesce(ss.night_starts, 0),
        'peak_day', coalesce(sd.peak_day, 0),
        'days_over_limit', coalesce(sd.days_over_limit, 0),
        'today_starts', coalesce(st.today_starts, 0),
        'burst_10min', coalesce(sb.burst_10min, 0),
        'unanswered_over_limit', coalesce(sm.unanswered_over_limit, 0),
        'unanswered_chats', coalesce(sm.unanswered_chats, 0),
        'max_unanswered_run', coalesce(sm.max_unanswered_run, 0),
        'replies', coalesce(sr.replies, 0),
        'response_median_min', round(sr.response_median_min::numeric, 1),
        'waiting', coalesce(sw.waiting, 0),
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
      LEFT JOIN s_replies sr ON sr.kind = k.kind AND sr.key_id IS NOT DISTINCT FROM k.key_id
      LEFT JOIN s_waiting sw ON k.kind = 'person' AND sw.key_id = k.key_id
      LEFT JOIN s_broadcasts bc ON k.kind = 'person' AND bc.key_id = k.key_id
    ), '[]'::jsonb),
    'numbers', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'channel_id', nk.channel_id,
        'provider', nb.provider,
        'label', nb.label,
        'waba_id', nb.waba_id,
        'phone_number_id', nb.phone_number_id,
        'status', nb.status,
        'is_primary', nb.is_primary,
        'connected_at', nb.connected_at,
        'created_at', nb.created_at,
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
        'links_first', coalesce(ns.links_first, 0),
        'identical_openers', coalesce(ns.identical_openers, 0),
        'night_starts', coalesce(ns.night_starts, 0),
        'peak_day', coalesce(nd.peak_day, 0),
        'days_over_limit', coalesce(nd.days_over_limit, 0),
        'burst_10min', coalesce(nbu.burst_10min, 0),
        'today_starts', coalesce(nt.today_starts, 0)
      ) ORDER BY nb.is_primary DESC NULLS LAST, nb.provider, nb.created_at, nk.channel_id)
      FROM n_keys nk
      LEFT JOIN numbers nb ON nb.channel_id = nk.channel_id
      LEFT JOIN n_starts ns ON ns.channel_id IS NOT DISTINCT FROM nk.channel_id
      LEFT JOIN n_days nd ON nd.channel_id IS NOT DISTINCT FROM nk.channel_id
      LEFT JOIN n_burst nbu ON nbu.channel_id IS NOT DISTINCT FROM nk.channel_id
      LEFT JOIN n_today nt ON nt.channel_id IS NOT DISTINCT FROM nk.channel_id
      LEFT JOIN n_msgs nm ON nm.channel_id IS NOT DISTINCT FROM nk.channel_id
      LEFT JOIN n_inbound ni ON ni.channel_id IS NOT DISTINCT FROM nk.channel_id
    ), '[]'::jsonb),
    'daily', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'day', d.day,
        'started', coalesce(ds.started, 0),
        'no_reply', coalesce(ds.no_reply, 0),
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
-- 6. Drill-down: the chats behind a row of the report.
--    p_kind 'person' (with p_user_id), 'api' or 'bot'.
--    p_filter 'no_reply' — started chats still without an answer;
--             'all'      — every chat started;
--             'unanswered' — chats where this sender went past
--                            max_unanswered_in_row.
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
    WITH sole AS (
      SELECT w.provider, (array_agg(w.id))[1] AS id
      FROM whatsapp_config w
      WHERE w.account_id = v_account
      GROUP BY w.provider
      HAVING count(*) = 1
    ),
    msgs AS (
      SELECT
        m.id, m.conversation_id, m.sender_type, m.sender_id, m.created_at, m.content_text,
        coalesce(m.channel_id, c.channel_id, so.id) AS channel_id,
        m.sender_type = 'customer' AS is_customer
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      LEFT JOIN sole so ON so.provider = m.provider
      WHERE c.account_id = v_account
        AND m.created_at >= p_from - interval '7 days'
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
-- 7. The caller's own day — what the composer's warnings read.
--    Any member; only the caller's own counts, plus how many chats
--    each number started today.
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
      SELECT jsonb_agg(jsonb_build_object('channel_id', x.channel_id, 'started', x.n))
      FROM (
        SELECT s.channel_id, count(*) AS n
        FROM s WHERE s.channel_id IS NOT NULL
        GROUP BY s.channel_id
      ) x
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
-- 8. The send check behind block_over_limit. Called by the send path
--    as the signed-in sender, before the gateway: refuses a message
--    that would START a chat once the sender, or the number it goes
--    out on, is at the daily limit. Replies always pass (the chat moved
--    in the last 24 hours, or the customer wrote last), and so do
--    owners and admins. The sender's own count is of chats started on
--    Whapi numbers. Anything unexpected answers "not blocked": this is
--    a guard rail, not a reason for a message to fail.
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
  IF p_channel_id IS NOT NULL AND v_number >= v_cfg.daily_new_chats_per_number THEN
    RETURN jsonb_build_object(
      'blocked', true, 'reason', 'number',
      'started', v_number, 'limit', v_cfg.daily_new_chats_per_number);
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
-- 9. The alert sweep (service role; the automation cron runs it every
--    few minutes). For accounts whose limits an admin has saved, alerts
--    once per person or number per local day when a person goes past
--    their daily limit or a Whapi number reaches its own: the person
--    gets a "you" notice, owners and admins get one naming them.
--    English, like the channel health alerts.
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
      HAVING count(*) > v_cfg.daily_new_chats_per_user
      UNION ALL
      SELECT
        'number_daily_limit',
        w.id,
        count(*)::integer,
        v_cfg.daily_new_chats_per_number,
        coalesce(max(nullif(btrim(w.label), '')), max(w.waba_id), 'A WhatsApp number')
      FROM s
      JOIN whatsapp_config w
        ON w.id = s.channel_id AND w.account_id = v_account AND w.provider = 'whapi'
      GROUP BY w.id
      HAVING count(*) >= v_cfg.daily_new_chats_per_number
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
               THEN 'You are over today''s new-chat limit'
               ELSE 'Daily new-chat limit exceeded' END,
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
