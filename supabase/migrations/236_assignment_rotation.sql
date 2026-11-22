-- ============================================================
-- 236 — Assignment rotation, chat limits and assignment settings
--
-- Who gets an unassigned chat, decided in one place:
--
--  * assignment_rotate_assign() is the engine. A caller (the automation
--    step `assign_conversation` in round_robin mode, the first reply to
--    a broadcast) names a pool (`automation:<automation>:<step>`,
--    `broadcast`) and, optionally, the people in it in order. The engine
--    hands the chat to the next person after the pool's last pick who
--    is eligible: a live profile of the account (not deactivated), not a
--    bank guest or a viewer, present (member_presence seen in the last
--    75 seconds, online or away: OFFLINE_AFTER_MS in lib/presence.ts),
--    and, while chat limits are on, under their limit of open company
--    chats. Nobody eligible = no assignment and the pool's state is left
--    as it was.
--
--  * Race safety: a transaction-scoped advisory lock per ACCOUNT (not
--    per pool, so a person's limit holds across every pool), then the
--    conversation row FOR UPDATE. A chat that already has an assignee,
--    that a person is working (human_engaged_at, 067), or that is a
--    personal chat (191) is never touched.
--
--  * assignment_settings: one optional row per account; no row = every
--    default (everything off, default limit 30). Members read; only an
--    owner/admin of the ACTIVE account writes, through
--    assignment_settings_set(). assignment_chat_limits holds per-person
--    overrides (assignment_chat_limit_set()).
--
--  * assignment_compass_assign() (Compass, item 5): when the account's
--    compass_assign_enabled is on and the chat has no assignee, the
--    case's agent takes the chat and the case's coordinator gets an open
--    coordinator share, inserted the way share_conversation_with_
--    coordinator (133/191) inserts one (that function is not replaced:
--    it needs a signed-in sharer). Off = nothing changes.
--
--  * assignment_member_loads(): open company chats per person of the
--    caller's active account, with their limit while limits are on, for
--    the Assign menu ("Ravi Kumar · 12/30").
--
-- Assigning moves the contact's owner (169) and rings
-- conversation_assigned (027), as any assignment does.
--
-- Grants: the engine, compass and load functions are service_role
-- only; member_loads and the two *_set functions are for authenticated
-- callers. Asserted by supabase/ci/verify-assignment-rotation.sql.
-- Re-runnable.
-- ============================================================

-- ---------- 1. Settings ----------

CREATE TABLE IF NOT EXISTS public.assignment_settings (
  account_id                 uuid        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  broadcast_rotation_enabled boolean     NOT NULL DEFAULT false,
  broadcast_pool             uuid[]      NOT NULL DEFAULT '{}',
  compass_assign_enabled     boolean     NOT NULL DEFAULT false,
  limits_enabled             boolean     NOT NULL DEFAULT false,
  default_chat_limit         integer     NOT NULL DEFAULT 30,
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  updated_by                 uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT assignment_settings_pkey PRIMARY KEY (account_id),
  CONSTRAINT assignment_settings_default_chat_limit_check
    CHECK (default_chat_limit BETWEEN 1 AND 500),
  CONSTRAINT assignment_settings_broadcast_pool_size
    CHECK (cardinality(broadcast_pool) <= 500)
);

ALTER TABLE public.assignment_settings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.assignment_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.assignment_settings TO authenticated;
GRANT SELECT ON public.assignment_settings TO service_role;

DROP POLICY IF EXISTS assignment_settings_select ON public.assignment_settings;
CREATE POLICY assignment_settings_select ON public.assignment_settings
  FOR SELECT
  USING (account_id = (SELECT public.current_account_id()));

COMMENT ON TABLE public.assignment_settings IS
  'Per-account assignment switches: broadcast first-reply rotation and its pool (auth user ids; empty = all live agents and team leaders), Compass assignment, chat limits. No row = all defaults (off, limit 30). Written only by assignment_settings_set(). Migration 236.';

CREATE TABLE IF NOT EXISTS public.assignment_chat_limits (
  account_id uuid        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  max_open   integer     NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT assignment_chat_limits_pkey PRIMARY KEY (account_id, user_id),
  CONSTRAINT assignment_chat_limits_max_open_check CHECK (max_open BETWEEN 1 AND 500)
);

ALTER TABLE public.assignment_chat_limits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.assignment_chat_limits FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.assignment_chat_limits TO authenticated;
GRANT SELECT ON public.assignment_chat_limits TO service_role;

DROP POLICY IF EXISTS assignment_chat_limits_select ON public.assignment_chat_limits;
CREATE POLICY assignment_chat_limits_select ON public.assignment_chat_limits
  FOR SELECT
  USING (account_id = (SELECT public.current_account_id()));

COMMENT ON TABLE public.assignment_chat_limits IS
  'A person''s own limit of open company chats, overriding assignment_settings.default_chat_limit while limits are on. Written only by assignment_chat_limit_set(). Migration 236.';

-- ---------- 2. Rotation state ----------

CREATE TABLE IF NOT EXISTS public.assignment_rotation_state (
  account_id   uuid        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  pool_key     text        NOT NULL,
  last_user_id uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assignment_rotation_state_pkey PRIMARY KEY (account_id, pool_key),
  CONSTRAINT assignment_rotation_state_pool_key_check
    CHECK (char_length(pool_key) BETWEEN 1 AND 200 AND pool_key !~ '^[[:space:]]*$')
);

-- RLS on, no policy and no client grant: only the engine (SECURITY
-- DEFINER) reads and writes it.
ALTER TABLE public.assignment_rotation_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.assignment_rotation_state FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.assignment_rotation_state IS
  'Last person each rotation pool handed a chat to. Read and written only by assignment_rotate_assign(). Migration 236.';

-- Open company chats per assignee: the limit check and the Assign menu.
CREATE INDEX IF NOT EXISTS idx_conversations_open_assignee
  ON public.conversations (account_id, assigned_agent_id)
  WHERE assigned_agent_id IS NOT NULL AND status <> 'closed' AND personal_owner_id IS NULL;

-- ---------- 3. Helpers ----------

-- Open company chats assigned to a person in an account.
CREATE OR REPLACE FUNCTION public.assignment_open_load(p_account_id uuid, p_user_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT count(*)::integer
    FROM public.conversations c
   WHERE c.account_id = p_account_id
     AND c.assigned_agent_id = p_user_id
     AND c.status <> 'closed'
     AND c.personal_owner_id IS NULL;
$$;

REVOKE ALL ON FUNCTION public.assignment_open_load(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assignment_open_load(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.assignment_open_load(uuid, uuid) IS
  'Open (status <> closed) company chats assigned to the person in the account. Migration 236.';

-- May this person take a chat from the rotation right now? Live staff
-- of the account (not a bank guest or a viewer), present (seen within
-- 75 s in that account: OFFLINE_AFTER_MS), and under their limit while
-- limits are on.
CREATE OR REPLACE FUNCTION public.assignment_is_eligible(
  p_account_id     uuid,
  p_user_id        uuid,
  p_limits_enabled boolean,
  p_default_limit  integer
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.profiles p
      JOIN public.member_presence mp
        ON mp.user_id = p.user_id
       AND mp.account_id = p.account_id
     WHERE p.account_id = p_account_id
       AND p.user_id = p_user_id
       AND p.deactivated_at IS NULL
       AND p.account_role::text NOT IN ('bank_guest', 'viewer')
       AND mp.last_seen_at > now() - interval '75 seconds'
  )
  AND (
    NOT coalesce(p_limits_enabled, false)
    OR public.assignment_open_load(p_account_id, p_user_id) < coalesce(
         (SELECT l.max_open FROM public.assignment_chat_limits l
           WHERE l.account_id = p_account_id AND l.user_id = p_user_id),
         p_default_limit, 30)
  );
$$;

REVOKE ALL ON FUNCTION public.assignment_is_eligible(uuid, uuid, boolean, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assignment_is_eligible(uuid, uuid, boolean, integer) TO service_role;

COMMENT ON FUNCTION public.assignment_is_eligible(uuid, uuid, boolean, integer) IS
  'Rotation eligibility: live non-guest non-viewer profile, present within 75 s (OFFLINE_AFTER_MS), under the chat limit while limits are on. Migration 236.';

-- ---------- 4. The engine ----------

CREATE OR REPLACE FUNCTION public.assignment_rotate_assign(
  p_account_id      uuid,
  p_conversation_id uuid,
  p_pool_key        text,
  p_candidates      uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_conv    record;
  v_limits  boolean := false;
  v_default integer := 30;
  v_list    uuid[];
  v_last    uuid;
  v_start   integer;
  v_n       integer;
  v_cand    uuid;
  v_pick    uuid;
BEGIN
  IF p_account_id IS NULL OR p_conversation_id IS NULL THEN
    RETURN jsonb_build_object('assigned_to', NULL, 'reason', 'not_found');
  END IF;
  IF p_pool_key IS NULL OR p_pool_key ~ '^[[:space:]]*$' OR char_length(p_pool_key) > 200 THEN
    RAISE EXCEPTION 'A rotation pool key is required (1-200 characters)'
      USING ERRCODE = '22023', HINT = 'bad_pool_key';
  END IF;

  -- One rotation at a time per account: limits count across pools.
  PERFORM pg_advisory_xact_lock(hashtextextended('assignment_rotation:' || p_account_id::text, 0));

  SELECT c.id, c.account_id, c.personal_owner_id, c.assigned_agent_id, c.human_engaged_at
    INTO v_conv
    FROM public.conversations c
   WHERE c.id = p_conversation_id
   FOR UPDATE;
  IF NOT FOUND OR v_conv.account_id IS DISTINCT FROM p_account_id THEN
    RETURN jsonb_build_object('assigned_to', NULL, 'reason', 'not_found');
  END IF;
  IF v_conv.personal_owner_id IS NOT NULL THEN
    RETURN jsonb_build_object('assigned_to', NULL, 'reason', 'personal');
  END IF;
  IF v_conv.assigned_agent_id IS NOT NULL THEN
    RETURN jsonb_build_object('assigned_to', NULL, 'reason', 'already_assigned');
  END IF;
  IF v_conv.human_engaged_at IS NOT NULL THEN
    RETURN jsonb_build_object('assigned_to', NULL, 'reason', 'engaged');
  END IF;

  SELECT s.limits_enabled, s.default_chat_limit
    INTO v_limits, v_default
    FROM public.assignment_settings s
   WHERE s.account_id = p_account_id;
  v_limits := coalesce(v_limits, false);
  v_default := coalesce(v_default, 30);

  IF p_candidates IS NULL OR cardinality(p_candidates) = 0 THEN
    SELECT coalesce(array_agg(p.user_id ORDER BY p.user_id), '{}')
      INTO v_list
      FROM public.profiles p
     WHERE p.account_id = p_account_id
       AND p.deactivated_at IS NULL
       AND p.account_role::text IN ('agent', 'team_leader');
  ELSE
    -- The given order, first occurrence of each person kept.
    SELECT coalesce(array_agg(d.u ORDER BY d.o), '{}')
      INTO v_list
      FROM (SELECT x.u, min(x.o) AS o
              FROM unnest(p_candidates) WITH ORDINALITY x(u, o)
             WHERE x.u IS NOT NULL
             GROUP BY x.u) d;
  END IF;

  v_n := coalesce(cardinality(v_list), 0);
  IF v_n = 0 THEN
    RETURN jsonb_build_object('assigned_to', NULL, 'reason', 'nobody_eligible');
  END IF;

  SELECT r.last_user_id INTO v_last
    FROM public.assignment_rotation_state r
   WHERE r.account_id = p_account_id AND r.pool_key = p_pool_key;
  -- Start right after the last pick; from the top when they are gone.
  v_start := coalesce(array_position(v_list, v_last), 0);

  FOR i IN 1..v_n LOOP
    v_cand := v_list[((v_start + i - 1) % v_n) + 1];
    IF public.assignment_is_eligible(p_account_id, v_cand, v_limits, v_default) THEN
      v_pick := v_cand;
      EXIT;
    END IF;
  END LOOP;

  IF v_pick IS NULL THEN
    RETURN jsonb_build_object('assigned_to', NULL, 'reason', 'nobody_eligible');
  END IF;

  UPDATE public.conversations
     SET assigned_agent_id = v_pick
   WHERE id = p_conversation_id;

  INSERT INTO public.assignment_rotation_state (account_id, pool_key, last_user_id, updated_at)
  VALUES (p_account_id, p_pool_key, v_pick, now())
  ON CONFLICT (account_id, pool_key) DO UPDATE
    SET last_user_id = excluded.last_user_id,
        updated_at   = excluded.updated_at;

  RETURN jsonb_build_object('assigned_to', v_pick, 'reason', 'assigned');
END;
$$;

REVOKE ALL ON FUNCTION public.assignment_rotate_assign(uuid, uuid, text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assignment_rotate_assign(uuid, uuid, text, uuid[]) TO service_role;

COMMENT ON FUNCTION public.assignment_rotate_assign(uuid, uuid, text, uuid[]) IS
  'Hand an unassigned, unengaged company chat to the next eligible person of a rotation pool (candidates in order; NULL/empty = live agents and team leaders by user id). Returns {assigned_to, reason: assigned | already_assigned | engaged | personal | not_found | nobody_eligible}. Service role only. Migration 236.';

-- ---------- 5. Compass: the case's agent and coordinator ----------

CREATE OR REPLACE FUNCTION public.assignment_compass_assign(
  p_account_id          uuid,
  p_conversation_id     uuid,
  p_agent_user_id       uuid,
  p_coordinator_user_id uuid DEFAULT NULL,
  p_bank_code           text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_on       boolean;
  v_conv     record;
  v_assigned uuid;
  v_bank     text := nullif(btrim(coalesce(p_bank_code, '')), '');
  v_open     public.conversation_coordinator_shares%ROWTYPE;
  v_share    uuid;
  v_shared   boolean := false;
  v_share_reason text;
  v_name     text;
BEGIN
  SELECT s.compass_assign_enabled INTO v_on
    FROM public.assignment_settings s WHERE s.account_id = p_account_id;
  IF NOT coalesce(v_on, false) THEN
    RETURN jsonb_build_object('enabled', false, 'assigned_to', NULL,
                              'shared_with', NULL, 'reason', 'off');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('assignment_rotation:' || p_account_id::text, 0));

  SELECT c.id, c.account_id, c.contact_id, c.personal_owner_id, c.assigned_agent_id
    INTO v_conv
    FROM public.conversations c
   WHERE c.id = p_conversation_id
   FOR UPDATE;
  IF NOT FOUND OR v_conv.account_id IS DISTINCT FROM p_account_id THEN
    RETURN jsonb_build_object('enabled', true, 'assigned_to', NULL,
                              'shared_with', NULL, 'reason', 'not_found');
  END IF;
  IF v_conv.personal_owner_id IS NOT NULL THEN
    RETURN jsonb_build_object('enabled', true, 'assigned_to', NULL,
                              'shared_with', NULL, 'reason', 'personal');
  END IF;
  IF v_conv.assigned_agent_id IS NOT NULL THEN
    RETURN jsonb_build_object('enabled', true, 'assigned_to', NULL,
                              'shared_with', NULL, 'reason', 'already_assigned');
  END IF;

  -- The agent: live staff of this account (not a guest or a viewer).
  IF p_agent_user_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.profiles p
        WHERE p.account_id = p_account_id
          AND p.user_id = p_agent_user_id
          AND p.deactivated_at IS NULL
          AND p.account_role::text NOT IN ('bank_guest', 'viewer')) THEN
    UPDATE public.conversations
       SET assigned_agent_id = p_agent_user_id
     WHERE id = p_conversation_id;
    v_assigned := p_agent_user_id;
  END IF;

  -- The coordinator's share, inserted as share_conversation_with_
  -- coordinator (133/191) inserts one, with no sharer (shared_by NULL).
  IF p_coordinator_user_id IS NULL THEN
    v_share_reason := 'no_coordinator';
  ELSIF p_coordinator_user_id IS NOT DISTINCT FROM v_assigned THEN
    v_share_reason := 'coordinator_is_assignee';
  ELSE
    IF v_bank IS NULL THEN
      -- No bank named: the coordinator's only bank, if they have one.
      SELECT CASE WHEN count(*) = 1 THEN min(b.bank_code) END INTO v_bank
        FROM public.coordinator_banks b
       WHERE b.account_id = p_account_id AND b.user_id = p_coordinator_user_id;
    END IF;

    IF v_bank IS NULL OR NOT EXISTS (
         SELECT 1 FROM public.coordinator_banks b
           JOIN public.profiles p ON p.user_id = b.user_id AND p.account_id = b.account_id
          WHERE b.account_id = p_account_id
            AND b.user_id = p_coordinator_user_id
            AND b.bank_code = v_bank
            AND p.deactivated_at IS NULL
            AND p.account_role::text IN ('agent', 'team_leader')) THEN
      v_share_reason := 'not_coordinator';
    ELSE
      SELECT * INTO v_open FROM public.conversation_coordinator_shares s
       WHERE s.conversation_id = p_conversation_id
         AND s.coordinator_user_id = p_coordinator_user_id
         AND s.revoked_at IS NULL;
      IF FOUND AND v_open.bank_code = v_bank THEN
        v_share := v_open.id;  -- already shared: no second bell
        v_share_reason := 'already_shared';
      ELSE
        IF FOUND THEN
          -- Shared before under another bank: that share is replaced.
          UPDATE public.conversation_coordinator_shares
             SET revoked_at = now()
           WHERE id = v_open.id;
        END IF;

        INSERT INTO public.conversation_coordinator_shares
          (account_id, conversation_id, coordinator_user_id, bank_code, shared_by)
        VALUES (p_account_id, p_conversation_id, p_coordinator_user_id, v_bank, NULL)
        RETURNING id INTO v_share;
        v_shared := true;
        v_share_reason := 'shared';

        SELECT coalesce(nullif(btrim(ct.name), ''), ct.phone) INTO v_name
          FROM public.contacts ct WHERE ct.id = v_conv.contact_id;

        INSERT INTO public.notifications
          (account_id, user_id, type, conversation_id, contact_id, actor_user_id, title, body, meta)
        VALUES (p_account_id, p_coordinator_user_id, 'conversation_shared', p_conversation_id,
                v_conv.contact_id, NULL,
                left('Chat shared with you' || coalesce(': ' || v_name, ''), 200),
                'Bank: ' || v_bank,
                jsonb_build_object('share_id', v_share, 'bank_code', v_bank, 'source', 'compass'));
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'enabled', true,
    'assigned_to', v_assigned,
    'reason', CASE WHEN v_assigned IS NOT NULL THEN 'assigned' ELSE 'agent_not_eligible' END,
    'shared_with', CASE WHEN v_share IS NOT NULL THEN p_coordinator_user_id END,
    'share_id', v_share,
    'share_created', v_shared,
    'share_reason', v_share_reason,
    'bank_code', v_bank);
END;
$$;

REVOKE ALL ON FUNCTION public.assignment_compass_assign(uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assignment_compass_assign(uuid, uuid, uuid, uuid, text) TO service_role;

COMMENT ON FUNCTION public.assignment_compass_assign(uuid, uuid, uuid, uuid, text) IS
  'Compass: when compass_assign_enabled and the company chat has no assignee, assign it to the case''s agent (live staff only) and open a coordinator share for the case''s coordinator (bank = p_bank_code, else their only bank). Off = nothing changes. Service role only. Migration 236.';

-- ---------- 6. Loads for the Assign menu ----------

CREATE OR REPLACE FUNCTION public.assignment_member_loads()
RETURNS TABLE (user_id uuid, open_count integer, chat_limit integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH acct AS (
    SELECT public.current_account_id() AS id
  ), cfg AS (
    SELECT coalesce(s.limits_enabled, false) AS limits_on,
           coalesce(s.default_chat_limit, 30) AS default_limit
      FROM acct
      LEFT JOIN public.assignment_settings s ON s.account_id = acct.id
  ), loads AS (
    SELECT c.assigned_agent_id AS uid, count(*)::integer AS n
      FROM public.conversations c, acct
     WHERE c.account_id = acct.id
       AND c.assigned_agent_id IS NOT NULL
       AND c.status <> 'closed'
       AND c.personal_owner_id IS NULL
     GROUP BY c.assigned_agent_id
  )
  SELECT p.user_id,
         coalesce(l.n, 0),
         CASE WHEN cfg.limits_on THEN coalesce(cl.max_open, cfg.default_limit) END
    FROM acct
    CROSS JOIN cfg
    JOIN public.profiles p
      ON p.account_id = acct.id
     AND p.deactivated_at IS NULL
     AND p.account_role::text <> 'bank_guest'
    LEFT JOIN loads l ON l.uid = p.user_id
    LEFT JOIN public.assignment_chat_limits cl
      ON cl.account_id = acct.id AND cl.user_id = p.user_id
   WHERE acct.id IS NOT NULL
     AND auth.uid() IS NOT NULL
   ORDER BY p.user_id;
$$;

REVOKE ALL ON FUNCTION public.assignment_member_loads() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assignment_member_loads() TO authenticated, service_role;

COMMENT ON FUNCTION public.assignment_member_loads() IS
  'Open company chats per live staff member of the caller''s active account, and their chat limit (NULL while limits are off). Nothing for a bank guest or a caller with no active account. Migration 236.';

-- ---------- 7. Writers ----------

-- NULL = keep the current value (or the default when there is no row).
CREATE OR REPLACE FUNCTION public.assignment_settings_set(
  p_broadcast_rotation_enabled boolean DEFAULT NULL,
  p_broadcast_pool             uuid[]  DEFAULT NULL,
  p_compass_assign_enabled     boolean DEFAULT NULL,
  p_limits_enabled             boolean DEFAULT NULL,
  p_default_chat_limit         integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_acct uuid := public.current_account_id();
  v_pool uuid[];
  v_bad  uuid;
  v_row  public.assignment_settings%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_acct IS NULL OR public.current_role_rank() < 4 THEN
    RAISE EXCEPTION 'Only an owner or admin can change assignment settings'
      USING ERRCODE = '42501';
  END IF;
  IF p_default_chat_limit IS NOT NULL AND p_default_chat_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'The chat limit must be between 1 and 500'
      USING ERRCODE = '22023', HINT = 'bad_limit';
  END IF;

  IF p_broadcast_pool IS NOT NULL THEN
    SELECT coalesce(array_agg(d.u ORDER BY d.o), '{}') INTO v_pool
      FROM (SELECT x.u, min(x.o) AS o
              FROM unnest(p_broadcast_pool) WITH ORDINALITY x(u, o)
             WHERE x.u IS NOT NULL
             GROUP BY x.u) d;
    IF cardinality(v_pool) > 500 THEN
      RAISE EXCEPTION 'The pool holds at most 500 people'
        USING ERRCODE = '22023', HINT = 'pool_too_large';
    END IF;
    SELECT u INTO v_bad FROM unnest(v_pool) u
     WHERE NOT EXISTS (
       SELECT 1 FROM public.profiles p
        WHERE p.account_id = v_acct AND p.user_id = u
          AND p.deactivated_at IS NULL
          AND p.account_role::text NOT IN ('bank_guest', 'viewer'))
     LIMIT 1;
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'Everyone in the pool must be live staff of this workspace'
        USING ERRCODE = '22023', HINT = 'pool_member_invalid';
    END IF;
  END IF;

  INSERT INTO public.assignment_settings AS s
    (account_id, broadcast_rotation_enabled, broadcast_pool, compass_assign_enabled,
     limits_enabled, default_chat_limit, updated_at, updated_by)
  VALUES (v_acct,
          coalesce(p_broadcast_rotation_enabled, false),
          coalesce(v_pool, '{}'),
          coalesce(p_compass_assign_enabled, false),
          coalesce(p_limits_enabled, false),
          coalesce(p_default_chat_limit, 30),
          now(), auth.uid())
  ON CONFLICT (account_id) DO UPDATE SET
    broadcast_rotation_enabled = coalesce(p_broadcast_rotation_enabled, s.broadcast_rotation_enabled),
    broadcast_pool             = coalesce(v_pool, s.broadcast_pool),
    compass_assign_enabled     = coalesce(p_compass_assign_enabled, s.compass_assign_enabled),
    limits_enabled             = coalesce(p_limits_enabled, s.limits_enabled),
    default_chat_limit         = coalesce(p_default_chat_limit, s.default_chat_limit),
    updated_at                 = now(),
    updated_by                 = auth.uid()
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'broadcast_rotation_enabled', v_row.broadcast_rotation_enabled,
    'broadcast_pool', to_jsonb(v_row.broadcast_pool),
    'compass_assign_enabled', v_row.compass_assign_enabled,
    'limits_enabled', v_row.limits_enabled,
    'default_chat_limit', v_row.default_chat_limit,
    'updated_at', v_row.updated_at,
    'updated_by', v_row.updated_by);
END;
$$;

REVOKE ALL ON FUNCTION public.assignment_settings_set(boolean, uuid[], boolean, boolean, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assignment_settings_set(boolean, uuid[], boolean, boolean, integer) TO authenticated;

COMMENT ON FUNCTION public.assignment_settings_set(boolean, uuid[], boolean, boolean, integer) IS
  'Owner/admin of the active account: save assignment settings (NULL keeps a value). Pool members must be live non-guest non-viewer staff. Returns the saved settings. Migration 236.';

-- NULL removes the person's own limit (the default applies again).
CREATE OR REPLACE FUNCTION public.assignment_chat_limit_set(
  p_user_id  uuid,
  p_max_open integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_acct uuid := public.current_account_id();
BEGIN
  IF auth.uid() IS NULL OR v_acct IS NULL OR public.current_role_rank() < 4 THEN
    RAISE EXCEPTION 'Only an owner or admin can set chat limits'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.profiles p
        WHERE p.account_id = v_acct AND p.user_id = p_user_id
          AND p.account_role::text <> 'bank_guest') THEN
    RAISE EXCEPTION 'No such member in this workspace'
      USING ERRCODE = 'P0002', HINT = 'no_such_member';
  END IF;

  IF p_max_open IS NULL THEN
    DELETE FROM public.assignment_chat_limits
     WHERE account_id = v_acct AND user_id = p_user_id;
    RETURN true;
  END IF;
  IF p_max_open NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'The chat limit must be between 1 and 500'
      USING ERRCODE = '22023', HINT = 'bad_limit';
  END IF;

  INSERT INTO public.assignment_chat_limits (account_id, user_id, max_open, updated_at, updated_by)
  VALUES (v_acct, p_user_id, p_max_open, now(), auth.uid())
  ON CONFLICT (account_id, user_id) DO UPDATE
    SET max_open = excluded.max_open,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.assignment_chat_limit_set(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assignment_chat_limit_set(uuid, integer) TO authenticated;

COMMENT ON FUNCTION public.assignment_chat_limit_set(uuid, integer) IS
  'Owner/admin of the active account: set (1-500) or remove (NULL) a member''s own chat limit. Migration 236.';
