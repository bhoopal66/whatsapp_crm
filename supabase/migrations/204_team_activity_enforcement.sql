-- ============================================================
-- 204: Team activity, hard restrictions.
--
-- 068's optional block refused a person's new chat over the daily
-- limit, off by default, owners and admins exempt. The owner's
-- decision (2026-11-17): restrictions are ON by default and bind
-- everyone except the owner (rank 5), on COMPANY phone numbers only
-- (Whapi and OpenWA, never a personal number, never Meta), and an
-- admin may switch each rule off. So:
--
--   1. team_activity_settings gains one switch per rule plus three
--      numbers; block_over_limit becomes the master switch and is
--      turned on ONCE for existing rows, inside the same "column is
--      missing" block that adds the new columns, so re-running this
--      file never undoes an admin's later "off".
--   2. team_activity_limits returns them (defaults when no row).
--   3. team_activity_blocks records every refused send (never the
--      text), readable by the person, their leader and owners/admins.
--   4. team_activity_start_check(conversation, channel, text) runs
--      the rules in order (chase, quiet hours, daily per person,
--      daily per number, burst, link first, same opener); the 2-arg
--      073/145 signature stays as a wrapper so the build that is live
--      between this migration and the deploy keeps working.
--   5. team_activity_record_block (the Jev cold-pitch block, decided
--      in TypeScript) and team_activity_auto_check (bots, broadcasts,
--      the API: the number's daily limit only).
--   6. team_activity_my_day reports the restrictions in force; the
--      alert sweep purges blocks after 90 days.
--
-- Every check FAILS OPEN on an unexpected error, as 068's did: a
-- guard rail is not a reason for a message to fail. A deliberate
-- block is never swallowed (a failed log insert still blocks).
--
-- Unlocks (one-time approval to send past a block) are 205's table;
-- this file reaches it only behind a to_regclass guard.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Settings
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'team_activity_settings'
      AND column_name = 'enforce_daily_user'
  ) THEN
    ALTER TABLE public.team_activity_settings
      ADD COLUMN enforce_daily_user     boolean NOT NULL DEFAULT true,
      ADD COLUMN enforce_daily_number   boolean NOT NULL DEFAULT true,
      ADD COLUMN enforce_burst          boolean NOT NULL DEFAULT true,
      ADD COLUMN enforce_quiet_hours    boolean NOT NULL DEFAULT true,
      ADD COLUMN enforce_chase          boolean NOT NULL DEFAULT true,
      ADD COLUMN enforce_links_first    boolean NOT NULL DEFAULT true,
      ADD COLUMN enforce_same_opener    boolean NOT NULL DEFAULT true,
      ADD COLUMN enforce_reply_rate     boolean NOT NULL DEFAULT true,
      ADD COLUMN enforce_jev            boolean NOT NULL DEFAULT true,
      ADD COLUMN enforce_auto_senders   boolean NOT NULL DEFAULT true,
      ADD COLUMN allow_unlock_requests  boolean NOT NULL DEFAULT true,
      ADD COLUMN agent_view_enabled     boolean NOT NULL DEFAULT true,
      ADD COLUMN leader_view_enabled    boolean NOT NULL DEFAULT true,
      -- Identical first messages a person may send in a day.
      ADD COLUMN same_opener_max        integer NOT NULL DEFAULT 3
        CONSTRAINT team_activity_settings_same_opener_max_check
        CHECK (same_opener_max BETWEEN 1 AND 50),
      -- Below min_reply_rate the daily limit shrinks to this percent.
      ADD COLUMN reply_rate_throttle_pct integer NOT NULL DEFAULT 50
        CONSTRAINT team_activity_settings_reply_rate_throttle_pct_check
        CHECK (reply_rate_throttle_pct BETWEEN 10 AND 100),
      -- Jev's cold-pitch probability at which a start is refused.
      ADD COLUMN jev_block_min_p        numeric(3,2) NOT NULL DEFAULT 0.85
        CONSTRAINT team_activity_settings_jev_block_min_p_check
        CHECK (jev_block_min_p BETWEEN 0.50 AND 0.99);

    -- Once only: restrictions default to on (the owner's decision).
    UPDATE public.team_activity_settings SET block_over_limit = true;
  END IF;
END
$$;

ALTER TABLE public.team_activity_settings
  ALTER COLUMN block_over_limit SET DEFAULT true;

COMMENT ON COLUMN public.team_activity_settings.block_over_limit IS
  'Hard restrictions master switch (migration 204): on by default; binds everyone but the owner on company phone numbers.';

-- ------------------------------------------------------------
-- 2. team_activity_limits: the new columns, appended after `saved`
--    (callers read by name). The return type changes, so the old
--    function is dropped first, but only while it is the old one.
-- ------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('public.team_activity_limits(uuid)')
      AND NOT ('jev_block_min_p' = ANY (coalesce(p.proargnames, '{}')))
  ) THEN
    DROP FUNCTION public.team_activity_limits(uuid);
  END IF;
END
$$;

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
  saved                      boolean,
  enforce_daily_user         boolean,
  enforce_daily_number       boolean,
  enforce_burst              boolean,
  enforce_quiet_hours        boolean,
  enforce_chase              boolean,
  enforce_links_first        boolean,
  enforce_same_opener        boolean,
  enforce_reply_rate         boolean,
  enforce_jev                boolean,
  enforce_auto_senders       boolean,
  allow_unlock_requests      boolean,
  agent_view_enabled         boolean,
  leader_view_enabled        boolean,
  same_opener_max            integer,
  reply_rate_throttle_pct    integer,
  jev_block_min_p            numeric
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
    coalesce(s.block_over_limit, true),
    s.account_id IS NOT NULL,
    coalesce(s.enforce_daily_user, true),
    coalesce(s.enforce_daily_number, true),
    coalesce(s.enforce_burst, true),
    coalesce(s.enforce_quiet_hours, true),
    coalesce(s.enforce_chase, true),
    coalesce(s.enforce_links_first, true),
    coalesce(s.enforce_same_opener, true),
    coalesce(s.enforce_reply_rate, true),
    coalesce(s.enforce_jev, true),
    coalesce(s.enforce_auto_senders, true),
    coalesce(s.allow_unlock_requests, true),
    coalesce(s.agent_view_enabled, true),
    coalesce(s.leader_view_enabled, true),
    coalesce(s.same_opener_max, 3),
    coalesce(s.reply_rate_throttle_pct, 50),
    coalesce(s.jev_block_min_p, 0.85)
  FROM (SELECT p_account AS account_id) a
  LEFT JOIN team_activity_settings s ON s.account_id = a.account_id
  WHERE auth.uid() IS NULL
     OR a.account_id = (SELECT current_account_id());
$$;

REVOKE ALL ON FUNCTION public.team_activity_limits(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_activity_limits(uuid) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 3. Refused sends. The text is never stored. Written only by the
--    SECURITY DEFINER functions below; clients read.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.team_activity_blocks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- auth user id; NULL for an automatic sender.
  user_id         uuid,
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  channel_id      uuid REFERENCES public.whatsapp_config(id) ON DELETE SET NULL,
  rule            text NOT NULL CHECK (rule IN (
                    'chase', 'quiet_hours', 'daily_user', 'daily_user_throttled',
                    'daily_number', 'burst', 'link_first', 'same_opener',
                    'jev_cold_pitch')),
  source          text NOT NULL CHECK (source IN ('human', 'auto')),
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS team_activity_blocks_account_created_idx
  ON public.team_activity_blocks (account_id, created_at);
CREATE INDEX IF NOT EXISTS team_activity_blocks_user_created_idx
  ON public.team_activity_blocks (user_id, created_at);

ALTER TABLE public.team_activity_blocks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.team_activity_blocks FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.team_activity_blocks TO authenticated, service_role;

-- Own rows; owners and admins all of the active account; a leader the
-- rows of the people in the teams they lead (074's helper).
DROP POLICY IF EXISTS team_activity_blocks_read ON public.team_activity_blocks;
CREATE POLICY team_activity_blocks_read ON public.team_activity_blocks
  FOR SELECT TO authenticated
  USING (
    account_id = (SELECT public.current_account_id())
    AND (
      user_id = (SELECT auth.uid())
      OR (SELECT public.current_role_rank()) >= 4
      OR (
        (SELECT public.current_role_rank()) = 3
        AND user_id = ANY (coalesce((SELECT public.team_activity_my_team()), '{}'::uuid[]))
      )
    )
  );

-- ------------------------------------------------------------
-- 4. A person's reply rate over the last 7 days: their company
--    phone-number starts older than 24 hours (younger ones are still
--    pending) and how many were replied to (073's definition).
--    Private: the definer functions below call it.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.team_activity_user_reply_rate(
  p_account uuid,
  p_user    uuid
)
RETURNS TABLE (starts integer, replied integer)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT count(*)::integer,
         count(*) FILTER (WHERE s.replied)::integer
  FROM public.team_activity_starts(p_account, now() - interval '7 days', 'infinity') s
  LEFT JOIN public.whatsapp_config w ON w.id = s.channel_id
  WHERE s.sender_type = 'agent'
    AND s.sender_id = p_user
    AND s.provider IN ('whapi', 'openwa')
    AND NOT coalesce(w.is_personal, false)
    AND s.started_at < now() - interval '24 hours';
$$;

REVOKE ALL ON FUNCTION public.team_activity_user_reply_rate(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.team_activity_user_reply_rate(uuid, uuid) TO service_role;

-- ------------------------------------------------------------
-- 5. The send check for a person (3-arg). No parameter defaults, so
--    a 2-arg call can only mean the wrapper below.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.team_activity_start_check(
  p_conversation uuid,
  p_channel_id   uuid,
  p_text         text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_account    uuid;
  v_personal   uuid;
  v_conv_ch    uuid;
  v_ch         uuid;
  v_ch_created timestamptz;
  v_cfg        record;
  v_in_scope   boolean := false;
  v_is_start   boolean := false;
  v_unlock     uuid;
  v_last_by    text;
  v_last_at    timestamptz;
  v_cust_at    timestamptz;
  v_last_out   timestamptz;
  v_steps      integer;
  v_tz         text;
  v_today      timestamptz;
  v_hour       integer;
  v_mine       integer;
  v_number     integer;
  v_burst      integer;
  v_same       integer;
  v_key        text;
  v_limit      integer;
  v_rr_starts  integer;
  v_rr_replied integer;
  v_kth        timestamptz;
  v_rule       text;
  v_detail     jsonb;
  v_block_id   uuid;
  v_min_p      numeric := 0.85;
BEGIN
  IF v_uid IS NULL OR p_conversation IS NULL THEN
    RETURN jsonb_build_object('blocked', false);
  END IF;

  SELECT c.account_id, c.personal_owner_id, coalesce(p_channel_id, c.send_channel_id, c.channel_id)
    INTO v_account, v_personal, v_ch
  FROM public.conversations c
  WHERE c.id = p_conversation;
  IF v_account IS NULL OR v_account IS DISTINCT FROM public.current_account_id() THEN
    RETURN jsonb_build_object('blocked', false);
  END IF;

  SELECT * INTO v_cfg FROM public.team_activity_limits(v_account);
  v_min_p := coalesce(v_cfg.jev_block_min_p, 0.85);

  -- A start: no non-failed message for 24 hours, unless the customer
  -- wrote last (answering them is a reply, however late).
  SELECT m.sender_type, m.created_at INTO v_last_by, v_last_at
  FROM public.messages m
  WHERE m.conversation_id = p_conversation
    AND m.status <> 'failed'
  ORDER BY m.created_at DESC, m.id DESC
  LIMIT 1;
  v_is_start := v_last_at IS NULL
    OR (v_last_at <= now() - interval '24 hours' AND v_last_by IS DISTINCT FROM 'customer');

  -- Scope: master switch on, not the owner, a company chat on a
  -- company phone number of this account.
  SELECT w.created_at INTO v_ch_created
  FROM public.whatsapp_config w
  WHERE w.id = v_ch
    AND w.account_id = v_account
    AND w.provider IN ('whapi', 'openwa')
    AND NOT coalesce(w.is_personal, false);
  v_in_scope := FOUND
    AND v_personal IS NULL
    AND coalesce(v_cfg.block_over_limit, true)
    AND coalesce(public.current_role_rank(), 0) < 5;

  IF NOT v_in_scope THEN
    RETURN jsonb_build_object(
      'blocked', false, 'is_start', v_is_start, 'unlock_used', false,
      'jev', jsonb_build_object('enabled', false, 'min_p', v_min_p));
  END IF;

  -- Rule 0: an approved, unused, unexpired unlock lets this one send
  -- through, past every rule (Jev included). 205's table.
  IF to_regclass('public.team_activity_unlocks') IS NOT NULL THEN
    EXECUTE $q$
      UPDATE public.team_activity_unlocks
         SET status = 'used', used_at = now()
       WHERE id = (
         SELECT u.id FROM public.team_activity_unlocks u
         WHERE u.requester_id = $1
           AND u.conversation_id = $2
           AND u.status = 'approved'
           AND u.used_at IS NULL
           AND u.expires_at > now()
         ORDER BY u.decided_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED)
      RETURNING id
    $q$ INTO v_unlock USING v_uid, p_conversation;
    IF v_unlock IS NOT NULL THEN
      RETURN jsonb_build_object(
        'blocked', false, 'is_start', v_is_start, 'unlock_used', true,
        'jev', jsonb_build_object('enabled', false, 'min_p', v_min_p));
    END IF;
  END IF;

  v_tz := coalesce(v_cfg.timezone, 'UTC');
  v_today := date_trunc('day', now() AT TIME ZONE v_tz) AT TIME ZONE v_tz;

  <<rules>>
  BEGIN
    -- 1. Chasing a customer who has not answered. Outbound messages
    --    since their last message (or ever); messages under 10
    --    minutes after the previous outbound are one step.
    IF v_cfg.enforce_chase AND v_last_by IS DISTINCT FROM 'customer' THEN
      SELECT max(m.created_at) INTO v_cust_at
      FROM public.messages m
      WHERE m.conversation_id = p_conversation
        AND m.sender_type = 'customer';

      SELECT count(*) FILTER (
               WHERE o.prev IS NULL OR o.created_at - o.prev >= interval '10 minutes'),
             max(o.created_at)
        INTO v_steps, v_last_out
      FROM (
        SELECT m.created_at,
               lag(m.created_at) OVER (ORDER BY m.created_at, m.id) AS prev
        FROM public.messages m
        WHERE m.conversation_id = p_conversation
          AND m.sender_type <> 'customer'
          AND m.status <> 'failed'
          AND (v_cust_at IS NULL OR m.created_at > v_cust_at)
      ) o;
      v_steps := coalesce(v_steps, 0);
      IF v_last_out IS NULL OR now() - v_last_out >= interval '10 minutes' THEN
        v_steps := v_steps + 1;
      END IF;
      IF v_steps > v_cfg.max_unanswered_in_row THEN
        v_rule := 'chase';
        v_detail := jsonb_build_object('steps', v_steps, 'limit', v_cfg.max_unanswered_in_row);
        EXIT rules;
      END IF;
    END IF;

    -- The rest concern starting a chat only.
    IF NOT v_is_start THEN
      EXIT rules;
    END IF;

    -- 2. Quiet hours, local time; equal hours = off; wraps midnight.
    IF v_cfg.enforce_quiet_hours AND v_cfg.quiet_hours_start <> v_cfg.quiet_hours_end THEN
      v_hour := extract(hour FROM now() AT TIME ZONE v_tz)::integer;
      IF (v_cfg.quiet_hours_start < v_cfg.quiet_hours_end
            AND v_hour >= v_cfg.quiet_hours_start AND v_hour < v_cfg.quiet_hours_end)
         OR (v_cfg.quiet_hours_start > v_cfg.quiet_hours_end
            AND (v_hour >= v_cfg.quiet_hours_start OR v_hour < v_cfg.quiet_hours_end)) THEN
        v_rule := 'quiet_hours';
        v_detail := jsonb_build_object(
          'start', v_cfg.quiet_hours_start, 'end', v_cfg.quiet_hours_end, 'tz', v_tz);
        EXIT rules;
      END IF;
    END IF;

    -- One scan for today and the last 10 minutes. "Mine" = this
    -- person's starts on company phone numbers.
    v_key := public.team_activity_opener_key(p_text);
    SELECT
      count(*) FILTER (WHERE x.mine AND x.started_at >= v_today),
      count(*) FILTER (WHERE x.channel_id = v_ch AND x.started_at >= v_today),
      count(*) FILTER (WHERE x.mine AND x.started_at > now() - interval '10 minutes'),
      count(*) FILTER (WHERE x.mine AND x.started_at >= v_today AND v_key IS NOT NULL
                         AND public.team_activity_opener_key(x.content_text) = v_key)
      INTO v_mine, v_number, v_burst, v_same
    FROM (
      SELECT s.started_at, s.channel_id, m.content_text,
             (s.sender_type = 'agent' AND s.sender_id = v_uid
              AND s.provider IN ('whapi', 'openwa')
              AND NOT coalesce(w.is_personal, false)) AS mine
      FROM public.team_activity_starts(
             v_account, least(v_today, now() - interval '10 minutes'), 'infinity') s
      LEFT JOIN public.whatsapp_config w ON w.id = s.channel_id
      LEFT JOIN public.messages m ON m.id = s.message_id
    ) x;

    -- 3. The person's daily limit, shrunk while their reply rate is low.
    IF v_cfg.enforce_daily_user THEN
      v_limit := v_cfg.daily_new_chats_per_user;
      v_rule := 'daily_user';
      v_detail := NULL;
      IF v_cfg.enforce_reply_rate
         AND v_mine >= ceil(v_limit * v_cfg.reply_rate_throttle_pct / 100.0) THEN
        SELECT r.starts, r.replied INTO v_rr_starts, v_rr_replied
        FROM public.team_activity_user_reply_rate(v_account, v_uid) r;
        IF v_rr_starts >= 5
           AND v_rr_replied * 100.0 / nullif(v_rr_starts, 0) < v_cfg.min_reply_rate THEN
          v_limit := ceil(v_limit * v_cfg.reply_rate_throttle_pct / 100.0)::integer;
          v_rule := 'daily_user_throttled';
          v_detail := jsonb_build_object(
            'reply_rate', round(v_rr_replied * 100.0 / nullif(v_rr_starts, 0)));
        END IF;
      END IF;
      IF v_mine >= v_limit THEN
        v_detail := coalesce(v_detail, '{}'::jsonb)
          || jsonb_build_object('started', v_mine, 'limit', v_limit);
        EXIT rules;
      END IF;
      v_rule := NULL;
      v_detail := NULL;
    END IF;

    -- 4. The number's daily limit, everyone together (people, bots,
    --    API), lower while it warms up.
    IF v_cfg.enforce_daily_number THEN
      v_limit := public.team_activity_number_limit(v_ch_created, v_cfg.daily_new_chats_per_number);
      IF v_number >= v_limit THEN
        v_rule := 'daily_number';
        v_detail := jsonb_build_object(
          'started', v_number, 'limit', v_limit,
          'warming_up', coalesce(now() - v_ch_created < interval '14 days', false));
        EXIT rules;
      END IF;
    END IF;

    -- 5. Too many starts inside 10 minutes. retry_after_s: when the
    --    oldest start that has to age out does.
    IF v_cfg.enforce_burst AND v_burst >= v_cfg.burst_new_chats_10min THEN
      SELECT y.started_at INTO v_kth
      FROM (
        SELECT s.started_at
        FROM public.team_activity_starts(v_account, now() - interval '10 minutes', 'infinity') s
        LEFT JOIN public.whatsapp_config w ON w.id = s.channel_id
        WHERE s.sender_type = 'agent' AND s.sender_id = v_uid
          AND s.provider IN ('whapi', 'openwa')
          AND NOT coalesce(w.is_personal, false)
          AND s.started_at > now() - interval '10 minutes'
        ORDER BY s.started_at
        OFFSET (v_burst - v_cfg.burst_new_chats_10min)
        LIMIT 1
      ) y;
      v_rule := 'burst';
      v_detail := jsonb_build_object(
        'started', v_burst, 'limit', v_cfg.burst_new_chats_10min,
        'retry_after_s', greatest(1, ceil(extract(epoch FROM
          coalesce(v_kth, now()) + interval '10 minutes' - now()))::integer));
      EXIT rules;
    END IF;

    -- 6. A link in a first message.
    IF v_cfg.enforce_links_first AND p_text ~* '(https?://|www\.|wa\.me/)' THEN
      v_rule := 'link_first';
      v_detail := '{}'::jsonb;
      EXIT rules;
    END IF;

    -- 7. The same opener sent too often today.
    IF v_cfg.enforce_same_opener AND v_key IS NOT NULL
       AND p_text !~ '^[[:space:]]*$'
       AND v_same >= v_cfg.same_opener_max THEN
      v_rule := 'same_opener';
      v_detail := jsonb_build_object('count', v_same, 'limit', v_cfg.same_opener_max);
      EXIT rules;
    END IF;
  END rules;

  IF v_rule IS NULL THEN
    RETURN jsonb_build_object(
      'blocked', false, 'is_start', v_is_start, 'unlock_used', false,
      'jev', jsonb_build_object(
        'enabled', v_cfg.enforce_jev AND v_is_start, 'min_p', v_min_p));
  END IF;

  -- A failed log write never turns a block into an allow.
  BEGIN
    INSERT INTO public.team_activity_blocks
      (account_id, user_id, conversation_id, channel_id, rule, source, detail)
    VALUES (v_account, v_uid, p_conversation, v_ch, v_rule, 'human', v_detail)
    RETURNING id INTO v_block_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'team_activity_start_check: block not recorded: %', SQLERRM;
  END;

  RETURN jsonb_build_object(
    'blocked', true, 'rule', v_rule, 'block_id', v_block_id,
    'unlockable', coalesce(v_cfg.allow_unlock_requests, true),
    'detail', v_detail, 'is_start', v_is_start);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'team_activity_start_check failed: %', SQLERRM;
  RETURN jsonb_build_object('blocked', false);
END
$$;

REVOKE ALL ON FUNCTION public.team_activity_start_check(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_activity_start_check(uuid, uuid, text) TO authenticated;

-- ------------------------------------------------------------
-- 6. The 2-arg check (073/145), kept for the build that is live
--    until the deploy: the 3-arg result plus its old keys.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.team_activity_start_check(
  p_conversation_id uuid,
  p_channel_id      uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_r jsonb;
BEGIN
  v_r := public.team_activity_start_check(p_conversation_id, p_channel_id, NULL::text);
  IF coalesce((v_r ->> 'blocked')::boolean, false) THEN
    v_r := v_r || jsonb_build_object(
      'reason', CASE WHEN v_r ->> 'rule' = 'daily_number' THEN 'number' ELSE 'user' END,
      'started', v_r -> 'detail' -> 'started',
      'limit', v_r -> 'detail' -> 'limit');
  END IF;
  RETURN v_r;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'team_activity_start_check failed: %', SQLERRM;
  RETURN jsonb_build_object('blocked', false);
END
$$;

REVOKE ALL ON FUNCTION public.team_activity_start_check(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_activity_start_check(uuid, uuid) TO authenticated;

-- ------------------------------------------------------------
-- 7. A block decided in TypeScript (Jev's cold-pitch judgment).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.team_activity_record_block(
  p_conversation uuid,
  p_channel_id   uuid,
  p_rule         text,
  p_detail       jsonb
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_account uuid;
  v_ch      uuid;
  v_id      uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;
  IF p_rule IS DISTINCT FROM 'jev_cold_pitch' THEN
    RAISE EXCEPTION 'Only jev_cold_pitch is recorded here' USING ERRCODE = '22023';
  END IF;

  SELECT c.account_id, coalesce(p_channel_id, c.send_channel_id, c.channel_id)
    INTO v_account, v_ch
  FROM public.conversations c
  WHERE c.id = p_conversation;
  IF v_account IS NULL OR v_account IS DISTINCT FROM public.current_account_id() THEN
    RAISE EXCEPTION 'Conversation not found' USING ERRCODE = 'P0002';
  END IF;
  -- Only a number of the same account is recorded.
  IF v_ch IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.whatsapp_config w WHERE w.id = v_ch AND w.account_id = v_account
  ) THEN
    v_ch := NULL;
  END IF;

  INSERT INTO public.team_activity_blocks
    (account_id, user_id, conversation_id, channel_id, rule, source, detail)
  VALUES (v_account, v_uid, p_conversation, v_ch, 'jev_cold_pitch', 'human',
          CASE WHEN jsonb_typeof(p_detail) = 'object' THEN p_detail ELSE '{}'::jsonb END)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

REVOKE ALL ON FUNCTION public.team_activity_record_block(uuid, uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_activity_record_block(uuid, uuid, text, jsonb) TO authenticated;

-- ------------------------------------------------------------
-- 8. Automatic senders (broadcasts, API v1, flows, automations):
--    only the number's daily limit, only for a start. Service role.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.team_activity_auto_check(
  p_account      uuid,
  p_conversation uuid,
  p_channel_id   uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_personal   uuid;
  v_ch         uuid;
  v_ch_created timestamptz;
  v_cfg        record;
  v_last_by    text;
  v_last_at    timestamptz;
  v_tz         text;
  v_today      timestamptz;
  v_number     integer;
  v_limit      integer;
  v_detail     jsonb;
  v_block_id   uuid;
BEGIN
  IF p_account IS NULL THEN
    RETURN jsonb_build_object('blocked', false);
  END IF;

  -- No conversation yet (a broadcast contact with no company chat):
  -- a brand-new chat, a start, on p_channel_id.
  IF p_conversation IS NULL THEN
    v_ch := p_channel_id;
  ELSE
    SELECT c.personal_owner_id, coalesce(p_channel_id, c.send_channel_id, c.channel_id)
      INTO v_personal, v_ch
    FROM public.conversations c
    WHERE c.id = p_conversation AND c.account_id = p_account;
    IF NOT FOUND OR v_personal IS NOT NULL THEN
      RETURN jsonb_build_object('blocked', false);
    END IF;
  END IF;

  SELECT w.created_at INTO v_ch_created
  FROM public.whatsapp_config w
  WHERE w.id = v_ch
    AND w.account_id = p_account
    AND w.provider IN ('whapi', 'openwa')
    AND NOT coalesce(w.is_personal, false);
  IF NOT FOUND THEN
    RETURN jsonb_build_object('blocked', false);
  END IF;

  SELECT * INTO v_cfg FROM public.team_activity_limits(p_account);
  IF NOT (coalesce(v_cfg.block_over_limit, true)
          AND v_cfg.enforce_auto_senders
          AND v_cfg.enforce_daily_number) THEN
    RETURN jsonb_build_object('blocked', false);
  END IF;

  SELECT m.sender_type, m.created_at INTO v_last_by, v_last_at
  FROM public.messages m
  WHERE p_conversation IS NOT NULL
    AND m.conversation_id = p_conversation
    AND m.status <> 'failed'
  ORDER BY m.created_at DESC, m.id DESC
  LIMIT 1;
  IF v_last_at IS NOT NULL
     AND (v_last_at > now() - interval '24 hours' OR v_last_by = 'customer') THEN
    RETURN jsonb_build_object('blocked', false);
  END IF;

  v_tz := coalesce(v_cfg.timezone, 'UTC');
  v_today := date_trunc('day', now() AT TIME ZONE v_tz) AT TIME ZONE v_tz;

  SELECT count(*) INTO v_number
  FROM public.team_activity_starts(p_account, v_today, 'infinity') s
  WHERE s.channel_id = v_ch;

  v_limit := public.team_activity_number_limit(v_ch_created, v_cfg.daily_new_chats_per_number);
  IF v_number < v_limit THEN
    RETURN jsonb_build_object('blocked', false);
  END IF;

  v_detail := jsonb_build_object(
    'started', v_number, 'limit', v_limit,
    'warming_up', coalesce(now() - v_ch_created < interval '14 days', false));
  BEGIN
    INSERT INTO public.team_activity_blocks
      (account_id, user_id, conversation_id, channel_id, rule, source, detail)
    VALUES (p_account, NULL, p_conversation, v_ch, 'daily_number', 'auto', v_detail)
    RETURNING id INTO v_block_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'team_activity_auto_check: block not recorded: %', SQLERRM;
  END;

  RETURN jsonb_build_object(
    'blocked', true, 'rule', 'daily_number', 'block_id', v_block_id,
    'detail', v_detail);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'team_activity_auto_check failed: %', SQLERRM;
  RETURN jsonb_build_object('blocked', false);
END
$$;

REVOKE ALL ON FUNCTION public.team_activity_auto_check(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.team_activity_auto_check(uuid, uuid, uuid) TO service_role;

-- ------------------------------------------------------------
-- 9. The employee's day (145's), plus the restrictions in force.
--    Owners are the only people exempt now.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.team_activity_my_day(p_tz text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_account   uuid := current_account_id();
  v_cfg       record;
  v_tz        text;
  v_today     timestamptz;
  v_result    jsonb;
  v_rr_starts integer;
  v_rr_replied integer;
  v_throttled boolean := false;
  v_effective integer;
BEGIN
  IF v_uid IS NULL OR v_account IS NULL THEN
    RAISE EXCEPTION 'Not a member of an account' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_cfg FROM team_activity_limits(v_account);
  v_tz := coalesce(v_cfg.timezone, team_activity_valid_zone(p_tz), 'UTC');
  v_today := date_trunc('day', now() AT TIME ZONE v_tz) AT TIME ZONE v_tz;

  v_effective := v_cfg.daily_new_chats_per_user;
  IF v_cfg.enforce_reply_rate THEN
    SELECT r.starts, r.replied INTO v_rr_starts, v_rr_replied
    FROM team_activity_user_reply_rate(v_account, v_uid) r;
    IF v_rr_starts >= 5 AND v_rr_replied * 100.0 / nullif(v_rr_starts, 0) < v_cfg.min_reply_rate THEN
      v_throttled := true;
      v_effective := ceil(v_effective * v_cfg.reply_rate_throttle_pct / 100.0)::integer;
    END IF;
  END IF;

  WITH s AS (
    SELECT * FROM team_activity_starts(v_account, v_today, 'infinity')
  ),
  -- The per-person limit protects the phone numbers (Whapi and
  -- OpenWA): only chats this person started on one count towards it.
  mine AS (
    SELECT * FROM s
    WHERE s.sender_type = 'agent' AND s.sender_id = v_uid AND s.provider IN ('whapi', 'openwa')
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
        'warming_up', w.provider IN ('whapi', 'openwa')
                      AND coalesce(now() - w.created_at < interval '14 days', false),
        'effective_daily_limit', CASE WHEN w.provider IN ('whapi', 'openwa') THEN
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
    -- Whether the restrictions apply to this caller at all.
    'blocked_when_over', v_cfg.block_over_limit AND current_role_rank() < 5,
    'restrictions', jsonb_build_object(
      'on', v_cfg.block_over_limit,
      'owner_exempt', coalesce(current_role_rank() >= 5, false),
      'rules', jsonb_build_object(
        'daily_user', v_cfg.enforce_daily_user,
        'daily_number', v_cfg.enforce_daily_number,
        'burst', v_cfg.enforce_burst,
        'quiet_hours', v_cfg.enforce_quiet_hours,
        'chase', v_cfg.enforce_chase,
        'links_first', v_cfg.enforce_links_first,
        'same_opener', v_cfg.enforce_same_opener,
        'reply_rate', v_cfg.enforce_reply_rate,
        'jev', v_cfg.enforce_jev),
      'quiet_hours', jsonb_build_object(
        'start', v_cfg.quiet_hours_start,
        'end', v_cfg.quiet_hours_end,
        'tz', coalesce(v_cfg.timezone, 'UTC')),
      'effective_user_limit', v_effective,
      'throttled', v_throttled,
      'same_opener_max', v_cfg.same_opener_max,
      'burst_limit', v_cfg.burst_new_chats_10min,
      'max_unanswered_in_row', v_cfg.max_unanswered_in_row,
      'unlock_requests', v_cfg.allow_unlock_requests)
  )
  INTO v_result;

  RETURN v_result;
END
$$;

REVOKE ALL ON FUNCTION public.team_activity_my_day(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_activity_my_day(text) TO authenticated;

-- ------------------------------------------------------------
-- 10. The alert sweep (145's body), also purging blocks after 90 days.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.team_activity_alert_sweep()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
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
  v_nil     constant uuid := '00000000-0000-0000-0000-000000000000';
  l         record;
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
      LEFT JOIN profiles p ON p.user_id = s.sender_id AND p.account_id = v_account
      WHERE s.sender_type = 'agent' AND s.sender_id IS NOT NULL AND s.provider IN ('whapi', 'openwa')
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
        ON w.id = s.channel_id AND w.account_id = v_account AND w.provider IN ('whapi', 'openwa')
      GROUP BY w.id
      HAVING count(*) >= team_activity_number_limit(max(w.created_at), v_cfg.daily_new_chats_per_number)
    LOOP
      -- The leaders' copies first: they do not depend on whether the
      -- account-level alert went out on an earlier sweep.
      FOR l IN
        SELECT DISTINCT t.leader_user_id AS uid
        FROM teams t
        JOIN profiles p ON p.user_id = t.leader_user_id AND p.account_id = v_account
        WHERE t.account_id = v_account
          AND t.leader_user_id IS NOT NULL
          AND p.account_role = 'team_leader'
          AND p.deactivated_at IS NULL
          AND t.leader_user_id IS DISTINCT FROM CASE WHEN r.kind = 'user_daily_limit' THEN r.subject_id END
          AND CASE WHEN r.kind = 'user_daily_limit'
                   THEN EXISTS (SELECT 1 FROM team_members tm
                                WHERE tm.team_id = t.id AND tm.user_id = r.subject_id)
                   ELSE EXISTS (SELECT 1 FROM whatsapp_channel_teams ct
                                WHERE ct.team_id = t.id AND ct.config_id = r.subject_id)
              END
      LOOP
        INSERT INTO team_activity_alerts (account_id, kind, subject_id, day, value, threshold, recipient_id)
        VALUES (v_account, r.kind, r.subject_id, v_day, r.n, r.lim, l.uid)
        ON CONFLICT DO NOTHING;
        CONTINUE WHEN NOT FOUND;
        INSERT INTO notifications (account_id, user_id, type, title, body)
        VALUES (
          v_account, l.uid, 'team_activity_alert',
          CASE WHEN r.kind = 'user_daily_limit'
               THEN 'Daily new-chat limit reached'
               ELSE 'A WhatsApp number reached its daily new-chat limit' END,
          CASE WHEN r.kind = 'user_daily_limit'
               THEN format('%s has started %s new chats today; the limit is %s. Unanswered first messages are the main reason WhatsApp restricts a number.', r.who, r.n, r.lim)
               ELSE format('%s has started %s new chats today; the limit is %s. Starting more today raises the risk of WhatsApp restricting this number.', r.who, r.n, r.lim) END);
        v_notes := v_notes + 1;
      END LOOP;
      INSERT INTO team_activity_alerts (account_id, kind, subject_id, day, value, threshold, recipient_id)
      VALUES (v_account, r.kind, r.subject_id, v_day, r.n, r.lim, v_nil)
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
          AND p.deactivated_at IS NULL
          AND p.account_role <> 'bank_guest'
          AND (p.account_role IN ('owner', 'admin') OR p.user_id = r.subject_id);
      ELSE
        INSERT INTO notifications (account_id, user_id, type, title, body)
        SELECT
          v_account, p.user_id, 'team_activity_alert',
          'A WhatsApp number reached its daily new-chat limit',
          format('%s has started %s new chats today; the limit is %s. Starting more today raises the risk of WhatsApp restricting this number.', r.who, r.n, r.lim)
        FROM profiles p
        WHERE p.account_id = v_account
          AND p.deactivated_at IS NULL
          AND p.account_role IN ('owner', 'admin');
      END IF;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_notes := v_notes + v_n;
    END LOOP;
  END LOOP;
  DELETE FROM team_activity_alerts WHERE created_at < now() - interval '90 days';
  DELETE FROM team_activity_blocks WHERE created_at < now() - interval '90 days';
  RETURN jsonb_build_object('alerts', v_alerts, 'notifications', v_notes);
END
$function$
;

REVOKE ALL ON FUNCTION public.team_activity_alert_sweep() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.team_activity_alert_sweep() TO service_role;
