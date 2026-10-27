-- ============================================================
-- 143 — Team chat: who may direct-message whom
--
-- 087 lets any live non-guest member open a DM with any other. The
-- owner wants normal agents kept out of DMs with each other (they
-- should reach their team leader, admins and coordinators), but as a
-- per-workspace setting an owner / admin changes in Settings, not a
-- hard-coded rule.
--
--  * chat_dm_rules (account, class_a, class_b, scope): one row per
--    pair of classes, written in canonical order (class_a <= class_b).
--    The classes are a person's account role (admin, team_leader,
--    agent, viewer) plus 'coordinator' for a live agent / team_leader
--    holding any coordinator_banks row (133's rule: a row of someone
--    demoted since is ignored). A scope is 'none', 'team' (only people
--    who share a team: members of one team, or a team's leader and
--    its member) or 'all'.
--  * A missing row means 'all'. Deploying 143 therefore changes
--    nothing: a workspace that never saved rules keeps 087's open
--    DMs, and a new class pair is open until someone restricts it.
--    chat_set_dm_rules stores only the restricting rows ('none' and
--    'team'): an 'all' row would mean exactly what its absence means.
--  * A person has several classes (an agent who coordinates is agent
--    and coordinator), so a pair's scope is the MOST permissive over
--    every class combination: being a coordinator makes an agent
--    reachable, it never makes them less reachable.
--  * Owners are exempt both ways: whoever runs the workspace can always
--    be reached and can always reach anyone, so no rule set can lock
--    the person who would have to fix it out of a conversation.
--  * Enforcement sits in the three 087 gates, nowhere else:
--    chat_user_can_read_channel (behind every chat RLS policy, the
--    unread counts, badges, search, cards, bells and push) hides a DM
--    from a member who may no longer DM everyone else in it;
--    chat_assert_can_write refuses posting there; chat_open_dm refuses
--    a DM in which any pair is not allowed, on reopening too. A hidden
--    DM is not deleted: relaxing the rule shows it again, and
--    chat_admin_read_private still reads it (audited).
--  * Written only by chat_set_dm_rules (live owner / admin of that
--    workspace, whole set replaced at once); read by the same people
--    through RLS. chat_dm_peers lists whom the caller may DM.
--  * Not audited in chat_audit_log: its action CHECK (087) admits only
--    four actions and widening it is a schema change of its own. The
--    rows carry updated_by / updated_at instead.
--
-- Re-runnable.
-- ============================================================

-- The rule functions read chat_dm_rules and coordinator_banks, both
-- RLS-forced, as their definer. Applied by a role without BYPASSRLS
-- they would see the CALLER's rows: an agent sees no rules, so every
-- DM would stay open with no error. Refuse, as 087 and 133-142 do.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles r
     WHERE r.rolname = current_user
       AND (r.rolsuper
            OR (r.rolbypassrls
                AND pg_has_role(current_user,
                      (SELECT c.relowner FROM pg_class c WHERE c.oid = 'public.chat_channels'::regclass),
                      'MEMBER')))
  ) THEN
    RAISE EXCEPTION '143 must be applied by a superuser or a BYPASSRLS owner of public.chat_channels';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.chat_dm_rules (
  account_id uuid        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  class_a    text        NOT NULL CHECK (class_a IN ('admin','team_leader','coordinator','agent','viewer')),
  class_b    text        NOT NULL CHECK (class_b IN ('admin','team_leader','coordinator','agent','viewer')),
  scope      text        NOT NULL CHECK (scope IN ('none','team','all')),
  updated_by uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, class_a, class_b),
  CONSTRAINT chat_dm_rules_canonical CHECK (class_a <= class_b)
);

ALTER TABLE public.chat_dm_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_dm_rules FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chat_dm_rules_read ON public.chat_dm_rules;
CREATE POLICY chat_dm_rules_read ON public.chat_dm_rules
  FOR SELECT TO authenticated USING (public.chat_ws_role(account_id) IN ('owner','admin'));

-- TRUNCATE bypasses RLS: blocked, as on every other chat table (087).
DROP TRIGGER IF EXISTS chat_dm_rules_no_truncate ON public.chat_dm_rules;
CREATE TRIGGER chat_dm_rules_no_truncate BEFORE TRUNCATE ON public.chat_dm_rules
  FOR EACH STATEMENT EXECUTE FUNCTION public.chat_block_truncate();

REVOKE ALL ON public.chat_dm_rules FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.chat_dm_rules TO authenticated;

-- ---------- The rule ----------

-- May p_a and p_b share a DM in p_ws? Someone with no live non-guest
-- profile there is answered true: the other gates (membership,
-- chat_open_dm's guest check, chat_user_role) already decide for them.
CREATE OR REPLACE FUNCTION public.chat_dm_pair_allowed(p_ws uuid, p_a uuid, p_b uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_ra    text;
  v_rb    text;
  v_ca    text[];
  v_cb    text[];
  v_scope integer;
BEGIN
  IF p_a IS NULL OR p_b IS NULL OR p_a = p_b THEN
    RETURN true;
  END IF;
  SELECT p.account_role::text INTO v_ra FROM public.profiles p
   WHERE p.account_id = p_ws AND p.user_id = p_a AND p.deactivated_at IS NULL;
  SELECT p.account_role::text INTO v_rb FROM public.profiles p
   WHERE p.account_id = p_ws AND p.user_id = p_b AND p.deactivated_at IS NULL;
  IF v_ra IS NULL OR v_rb IS NULL OR v_ra = 'bank_guest' OR v_rb = 'bank_guest' THEN
    RETURN true;
  END IF;
  IF v_ra = 'owner' OR v_rb = 'owner' THEN
    RETURN true;   -- owners are exempt (see the header)
  END IF;

  v_ca := ARRAY[v_ra];
  IF v_ra IN ('agent','team_leader')
     AND EXISTS (SELECT 1 FROM public.coordinator_banks cb WHERE cb.account_id = p_ws AND cb.user_id = p_a) THEN
    v_ca := v_ca || 'coordinator'::text;
  END IF;
  v_cb := ARRAY[v_rb];
  IF v_rb IN ('agent','team_leader')
     AND EXISTS (SELECT 1 FROM public.coordinator_banks cb WHERE cb.account_id = p_ws AND cb.user_id = p_b) THEN
    v_cb := v_cb || 'coordinator'::text;
  END IF;

  -- Most permissive over every class combination; a missing row is 'all'.
  SELECT max(CASE coalesce(r.scope, 'all') WHEN 'all' THEN 2 WHEN 'team' THEN 1 ELSE 0 END)
    INTO v_scope
    FROM unnest(v_ca) x(c)
   CROSS JOIN unnest(v_cb) y(c)
    LEFT JOIN public.chat_dm_rules r
      ON r.account_id = p_ws AND r.class_a = least(x.c, y.c) AND r.class_b = greatest(x.c, y.c);

  IF v_scope = 2 THEN
    RETURN true;
  ELSIF v_scope = 0 THEN
    RETURN false;
  END IF;
  -- 'team': both in one team, or one leads the team the other is in.
  RETURN EXISTS (SELECT 1 FROM public.team_members ma
                   JOIN public.team_members mb ON mb.team_id = ma.team_id
                  WHERE ma.account_id = p_ws AND ma.user_id = p_a AND mb.user_id = p_b)
      OR EXISTS (SELECT 1 FROM public.teams t
                   JOIN public.team_members m ON m.team_id = t.id
                  WHERE t.account_id = p_ws
                    AND ((t.leader_user_id = p_a AND m.user_id = p_b)
                         OR (t.leader_user_id = p_b AND m.user_id = p_a)));
END $$;

-- Is p_user allowed a DM with every other member of DM p_channel? Any
-- other kind of channel: true. A workspace with no restricting rule
-- answers without looking at the members (the common case, and this
-- runs per row behind every chat read policy).
CREATE OR REPLACE FUNCTION public.chat_dm_user_allowed(p_channel uuid, p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((
    SELECT c.kind <> 'dm'
        OR NOT EXISTS (SELECT 1 FROM public.chat_dm_rules r WHERE r.account_id = c.account_id AND r.scope <> 'all')
        OR NOT EXISTS (SELECT 1 FROM public.chat_channel_members cm
                        WHERE cm.channel_id = c.id AND cm.user_id <> p_user
                          AND NOT public.chat_dm_pair_allowed(c.account_id, p_user, cm.user_id))
      FROM public.chat_channels c WHERE c.id = p_channel), true)
$$;

-- ---------- Gates (087's bodies, plus the DM rule) ----------

CREATE OR REPLACE FUNCTION public.chat_user_can_read_channel(p_channel uuid, p_user uuid, p_messages boolean DEFAULT true)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.chat_channels c
      JOIN public.accounts a ON a.id = c.account_id
      JOIN LATERAL (SELECT public.chat_user_role(c.account_id, p_user) AS role) r ON r.role IS NOT NULL
     WHERE c.id = p_channel
       AND (a.internal_chat_enabled OR r.role IN ('owner','admin'))   -- disabled: history for admins only
       AND NOT (p_messages AND c.kind = 'deal_room' AND r.role = 'bank_guest')   -- Team notes are staff-only
       -- a current role of bank_guest is a guest everywhere: private
       -- channels and deal rooms they are a member of only
       AND ((c.kind = 'team' AND r.role <> 'bank_guest')
            OR ((c.kind IN ('private','deal_room') OR r.role <> 'bank_guest')
                AND EXISTS (SELECT 1 FROM public.chat_channel_members cm
                             WHERE cm.channel_id = c.id AND cm.user_id = p_user)))
       -- 143: a DM this member may no longer have is hidden, not deleted
       AND (c.kind <> 'dm' OR public.chat_dm_user_allowed(c.id, p_user)))
$$;

CREATE OR REPLACE FUNCTION public.chat_assert_can_write(p_channel uuid, p_autojoin boolean)
RETURNS public.chat_channels LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_ch   public.chat_channels;
  v_role text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'chat: no authenticated user' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_ch FROM public.chat_channels WHERE id = p_channel;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat: channel not found' USING ERRCODE = 'P0002';
  END IF;
  v_role := public.chat_ws_role(v_ch.account_id);
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'chat: not a member of this workspace' USING ERRCODE = '42501';
  END IF;
  IF NOT (SELECT a.internal_chat_enabled FROM public.accounts a WHERE a.id = v_ch.account_id) THEN
    RAISE EXCEPTION 'chat: internal chat is disabled for this workspace' USING ERRCODE = 'CH001';
  END IF;
  IF v_ch.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'chat: channel is archived' USING ERRCODE = '42501';
  END IF;
  IF v_role = 'bank_guest' AND v_ch.kind <> 'private' THEN
    -- guests post in private channels only (never a deal room's Team notes)
    RAISE EXCEPTION 'chat: not a member of this channel' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.chat_channel_members WHERE channel_id = p_channel AND user_id = v_uid) THEN
    IF v_ch.kind = 'team' AND v_role <> 'bank_guest' THEN
      IF p_autojoin THEN
        INSERT INTO public.chat_channel_members (channel_id, user_id, role) VALUES (p_channel, v_uid, 'member')
        ON CONFLICT DO NOTHING;
      END IF;
    ELSE
      RAISE EXCEPTION 'chat: not a member of this channel' USING ERRCODE = '42501';
    END IF;
  END IF;
  -- 143: the src/lib/chat error mapper keys on this phrase
  IF v_ch.kind = 'dm' AND NOT public.chat_dm_user_allowed(p_channel, v_uid) THEN
    RAISE EXCEPTION 'chat: direct messages between these people are turned off' USING ERRCODE = '42501';
  END IF;
  RETURN v_ch;
END $$;

CREATE OR REPLACE FUNCTION public.chat_open_dm(p_ws uuid, p_member_ids uuid[])
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_role    text := public.chat_ws_role(p_ws);
  v_members uuid[];
  v_key     text;
  v_id      uuid;
BEGIN
  IF v_uid IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'chat_open_dm: not a member of this workspace' USING ERRCODE = '42501';
  END IF;
  IF v_role = 'bank_guest' THEN
    RAISE EXCEPTION 'chat_open_dm: bank guests cannot open DMs' USING ERRCODE = '42501';
  END IF;
  IF NOT (SELECT a.internal_chat_enabled FROM public.accounts a WHERE a.id = p_ws) THEN
    RAISE EXCEPTION 'chat_open_dm: internal chat is disabled for this workspace' USING ERRCODE = 'CH001';
  END IF;
  SELECT array_agg(DISTINCT m ORDER BY m) INTO v_members
    FROM unnest(array_append(coalesce(p_member_ids, '{}'), v_uid)) m WHERE m IS NOT NULL;
  IF cardinality(v_members) NOT BETWEEN 2 AND 8 THEN
    RAISE EXCEPTION 'chat_open_dm: a DM has 2 to 8 members (got %)', cardinality(v_members) USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_members) m
              WHERE coalesce(public.chat_user_role(p_ws, m), 'bank_guest') = 'bank_guest') THEN
    RAISE EXCEPTION 'chat_open_dm: every member must be an active non-guest member of this workspace'
      USING ERRCODE = '42501';
  END IF;
  -- 143: every pair, the caller included, on the new and the reopen path
  -- (the src/lib/chat error mapper keys on this phrase)
  IF EXISTS (SELECT 1 FROM unnest(v_members) x(a) JOIN unnest(v_members) y(b) ON x.a < y.b
              WHERE NOT public.chat_dm_pair_allowed(p_ws, x.a, y.b)) THEN
    RAISE EXCEPTION 'chat_open_dm: direct messages between these people are turned off' USING ERRCODE = '42501';
  END IF;

  v_key := array_to_string(v_members, ',');
  INSERT INTO public.chat_channels (account_id, kind, name, dm_key, created_by)
  VALUES (p_ws, 'dm', NULL, v_key, v_uid)
  ON CONFLICT (account_id, dm_key) WHERE kind = 'dm' DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.chat_channels WHERE account_id = p_ws AND kind = 'dm' AND dm_key = v_key;
    -- reopening a DM the caller had left brings the caller back (only the caller)
    INSERT INTO public.chat_channel_members (channel_id, user_id, role) VALUES (v_id, v_uid, 'member')
    ON CONFLICT DO NOTHING;
    RETURN v_id;
  END IF;
  INSERT INTO public.chat_channel_members (channel_id, user_id, role)
  SELECT v_id, m, 'member' FROM unnest(v_members) m;
  RETURN v_id;
END $$;

-- ---------- Client API ----------

-- Replace p_ws's whole rule set: a JSON array of
-- {"class_a", "class_b", "scope"}, the classes in either order. Works
-- while internal chat is disabled (the rules are set up before it is
-- switched on). 'all' rows are validated and then dropped (see the
-- header); an empty array opens every DM again.
CREATE OR REPLACE FUNCTION public.chat_set_dm_rules(p_ws uuid, p_rules jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR coalesce(public.chat_ws_role(p_ws), '') NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'chat_set_dm_rules: owner or admin role required' USING ERRCODE = '42501';
  END IF;
  IF p_rules IS NULL OR jsonb_typeof(p_rules) <> 'array' THEN
    RAISE EXCEPTION 'chat_set_dm_rules: rules must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rules) e
              WHERE jsonb_typeof(e) <> 'object'
                 OR jsonb_typeof(e->'class_a') IS DISTINCT FROM 'string'
                 OR jsonb_typeof(e->'class_b') IS DISTINCT FROM 'string'
                 OR jsonb_typeof(e->'scope') IS DISTINCT FROM 'string'
                 OR e->>'class_a' NOT IN ('admin','team_leader','coordinator','agent','viewer')
                 OR e->>'class_b' NOT IN ('admin','team_leader','coordinator','agent','viewer')
                 OR e->>'scope' NOT IN ('none','team','all')) THEN
    RAISE EXCEPTION 'chat_set_dm_rules: each rule needs class_a and class_b (admin, team_leader, coordinator, agent, viewer) and scope (none, team, all)'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rules) e
              GROUP BY least(e->>'class_a', e->>'class_b'), greatest(e->>'class_a', e->>'class_b')
             HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'chat_set_dm_rules: a pair of classes appears more than once' USING ERRCODE = '22023';
  END IF;

  -- Two admins saving at once would otherwise both DELETE first and
  -- leave the union of their sets (or a 23505): one save at a time.
  PERFORM pg_advisory_xact_lock(hashtextextended('chat_dm_rules:' || p_ws::text, 0));
  DELETE FROM public.chat_dm_rules WHERE account_id = p_ws;
  INSERT INTO public.chat_dm_rules (account_id, class_a, class_b, scope, updated_by, updated_at)
  SELECT p_ws, least(e->>'class_a', e->>'class_b'), greatest(e->>'class_a', e->>'class_b'), e->>'scope', v_uid, now()
    FROM jsonb_array_elements(p_rules) e
   WHERE e->>'scope' <> 'all';
END $$;

-- Whom may the caller DM in p_ws: live non-guest members other than the
-- caller. Empty for a non-member and for a bank guest (who cannot open
-- DMs at all).
CREATE OR REPLACE FUNCTION public.chat_dm_peers(p_ws uuid)
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.user_id
    FROM (SELECT public.chat_ws_role(p_ws) AS role) me
    JOIN public.profiles p ON p.account_id = p_ws AND p.deactivated_at IS NULL
   WHERE me.role IS NOT NULL AND me.role <> 'bank_guest'
     AND p.account_role <> 'bank_guest'
     AND p.user_id <> auth.uid()
     AND public.chat_dm_pair_allowed(p_ws, auth.uid(), p.user_id)
   ORDER BY p.user_id
$$;

-- ---------- Privileges ----------
-- As 087: revoke the defaults, grant the minimum. The two helpers stay
-- internal; nothing new reaches service_role (verify-internal-chat-admin
-- pins that list).
REVOKE ALL ON FUNCTION public.chat_dm_pair_allowed(uuid, uuid, uuid), public.chat_dm_user_allowed(uuid, uuid),
  public.chat_set_dm_rules(uuid, jsonb), public.chat_dm_peers(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.chat_set_dm_rules(uuid, jsonb), public.chat_dm_peers(uuid) TO authenticated;
