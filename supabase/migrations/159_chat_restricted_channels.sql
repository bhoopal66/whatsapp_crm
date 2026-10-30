-- ============================================================
-- 159 — Team chat: restricted team channels
--
-- 087 makes a team channel (kind = 'team') readable, joinable and
-- postable by every live staff member of its workspace. A workspace
-- wants some team channels for part of the staff only: leaders and up,
-- or the people of chosen teams.
--
--  * chat_channels.audience_min_role (NULL = all staff): the lowest RAW
--    account role that may have the channel, on the ladder viewer <
--    agent < team_leader < admin < owner. Raw on purpose: chat's own
--    folding (chat_user_role: viewer -> agent, team_leader ->
--    supervisor) would make 'agent' admit viewers. Only a team channel
--    may set it (CHECK).
--  * chat_channel_teams (channel, team): with rows, only a member of a
--    listed team or its leader may have the channel. No rows = no team
--    restriction.
--  * The rule (chat_user_in_channel_audience): workspace owners and
--    admins always; anyone else needs the minimum role (if set) AND one
--    of the teams (if any). The defaults (NULL, no rows) admit every
--    staff member, so deploying 159 changes nothing.
--  * Enforcement sits in 087's gate chat_user_can_read_channel, which
--    chat_can_see_channel, chat_can_read_channel, every chat RLS policy
--    (channels, members, messages, reactions, pins, files, typing,
--    plays, this table), storage reads, unread counts, badges, search,
--    cards, mention / thread / broadcast fan-out, bells and push all go
--    through. A membership row is not an override: a joined member who
--    falls outside the audience loses the channel, and the row stays
--    (like 143's blocked DMs), so widening the audience shows it again.
--  * Writes: chat_assert_can_write checks membership, not reading, and
--    auto-joins a team channel; it is 160's to redefine, so 159 guards
--    the rows instead (chat_audience_guard, BEFORE INSERT): no new
--    team-channel membership for someone outside the audience or added
--    by someone outside it (auto-join, chat_add_members), no message
--    authored by such a person, no typing row from them. Reactions,
--    pins, saves, read marks, plays and mutes already require reading.
--  * Written only by chat_set_channel_audience (the channel's managers,
--    chat_assert_can_manage_channel); audited as 'set_audience'.
--
-- Re-runnable.
-- ============================================================

-- The helpers read chat_channel_teams, teams and team_members (RLS) as
-- their definer: applied by a role without BYPASSRLS they would see the
-- CALLER's rows and every team restriction would hide the channel from
-- its own team. Refuse, as 087 and 143 do.
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
    RAISE EXCEPTION '159 must be applied by a superuser or a BYPASSRLS owner of public.chat_channels';
  END IF;
END $$;

-- ---------- 1. Schema ----------

ALTER TABLE public.chat_channels ADD COLUMN IF NOT EXISTS audience_min_role text NULL
  CONSTRAINT chat_channels_audience_min_role_check
    CHECK (audience_min_role IS NULL OR audience_min_role IN ('viewer','agent','team_leader','admin'));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.chat_channels'::regclass
                    AND conname = 'chat_channels_audience_team_only') THEN
    ALTER TABLE public.chat_channels ADD CONSTRAINT chat_channels_audience_team_only
      CHECK (audience_min_role IS NULL OR kind = 'team');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.chat_channel_teams (
  channel_id uuid NOT NULL REFERENCES public.chat_channels(id),
  team_id    uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.accounts(id),
  PRIMARY KEY (channel_id, team_id)
);
CREATE INDEX IF NOT EXISTS chat_channel_teams_team_idx ON public.chat_channel_teams (team_id);

ALTER TABLE public.chat_channel_teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_channel_teams FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.chat_channel_teams FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.chat_channel_teams TO authenticated;

ALTER TABLE public.chat_audit_log DROP CONSTRAINT IF EXISTS chat_audit_log_action_check;
ALTER TABLE public.chat_audit_log ADD CONSTRAINT chat_audit_log_action_check CHECK (action IN (
  'admin_read_private','erase_person','add_members','set_member_role',
  'update_channel','archive_channel','unarchive_channel','remove_member',
  'set_permissions','update_settings','update_policy','update_sensitive_guard',
  'set_audience','moderate_delete','restrict_member','export_channel'));

-- ---------- 2. Internal helpers (executable by nobody) ----------

-- The raw account-role ladder (roles.ts); bank_guest and unknown are 0.
CREATE OR REPLACE FUNCTION public.chat_audience_rank(p_role text)
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE p_role WHEN 'viewer' THEN 1 WHEN 'agent' THEN 2 WHEN 'team_leader' THEN 3
                     WHEN 'admin' THEN 4 WHEN 'owner' THEN 5 ELSE 0 END
$$;

-- Is p_user inside p_channel's audience? True for every channel that is
-- not a team channel and for an unrestricted team channel; it says
-- nothing about workspace membership, which the callers check.
CREATE OR REPLACE FUNCTION public.chat_user_in_channel_audience(p_channel uuid, p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((
    SELECT c.kind <> 'team'
        OR (c.audience_min_role IS NULL
            AND NOT EXISTS (SELECT 1 FROM public.chat_channel_teams ct WHERE ct.channel_id = c.id))
        OR coalesce(p.account_role::text IN ('owner','admin'), false)
        OR (p.user_id IS NOT NULL
            AND (c.audience_min_role IS NULL
                 OR public.chat_audience_rank(p.account_role::text) >= public.chat_audience_rank(c.audience_min_role))
            AND (NOT EXISTS (SELECT 1 FROM public.chat_channel_teams ct WHERE ct.channel_id = c.id)
                 OR EXISTS (SELECT 1 FROM public.chat_channel_teams ct
                              JOIN public.teams t ON t.id = ct.team_id AND t.account_id = c.account_id
                             WHERE ct.channel_id = c.id
                               AND (t.leader_user_id = p_user
                                    OR EXISTS (SELECT 1 FROM public.team_members tm
                                                WHERE tm.team_id = t.id AND tm.user_id = p_user)))))
      FROM public.chat_channels c
      LEFT JOIN public.profiles p
        ON p.account_id = c.account_id AND p.user_id = p_user AND p.deactivated_at IS NULL
     WHERE c.id = p_channel), false)
$$;

-- Row guard (see the header): a team channel takes no membership,
-- message or typing row from someone outside its audience.
CREATE OR REPLACE FUNCTION public.chat_audience_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user uuid;
BEGIN
  IF TG_TABLE_NAME = 'internal_messages' THEN
    IF NEW.author_kind IS DISTINCT FROM 'user' OR NEW.author_id IS NULL THEN RETURN NEW; END IF;
    v_user := NEW.author_id;
  ELSE
    v_user := NEW.user_id;
  END IF;
  IF NOT public.chat_user_in_channel_audience(NEW.channel_id, v_user)
     OR (TG_TABLE_NAME = 'chat_channel_members' AND auth.uid() IS NOT NULL
         AND NOT public.chat_user_in_channel_audience(NEW.channel_id, auth.uid())) THEN
    RAISE EXCEPTION 'chat: outside this channel''s audience' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS chat_channel_members_audience_guard ON public.chat_channel_members;
CREATE TRIGGER chat_channel_members_audience_guard BEFORE INSERT ON public.chat_channel_members
  FOR EACH ROW EXECUTE FUNCTION public.chat_audience_guard();
DROP TRIGGER IF EXISTS internal_messages_audience_guard ON public.internal_messages;
CREATE TRIGGER internal_messages_audience_guard BEFORE INSERT ON public.internal_messages
  FOR EACH ROW EXECUTE FUNCTION public.chat_audience_guard();
DROP TRIGGER IF EXISTS chat_typing_audience_guard ON public.chat_typing;
CREATE TRIGGER chat_typing_audience_guard BEFORE INSERT OR UPDATE ON public.chat_typing
  FOR EACH ROW EXECUTE FUNCTION public.chat_audience_guard();

-- ---------- 3. The gate (143's body, plus the audience) ----------

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
       AND (c.kind <> 'dm' OR public.chat_dm_user_allowed(c.id, p_user))
       -- 159: a restricted team channel is hidden from everyone outside
       -- its audience, members included (the row stays)
       AND (c.kind <> 'team' OR public.chat_user_in_channel_audience(c.id, p_user)))
$$;

-- ---------- 4. RLS ----------

DROP POLICY IF EXISTS chat_channel_teams_read ON public.chat_channel_teams;
CREATE POLICY chat_channel_teams_read ON public.chat_channel_teams
  FOR SELECT TO authenticated USING (public.chat_can_see_channel(channel_id));

-- ---------- 5. The setter ----------

-- p_min_role NULL = all staff; p_team_ids NULL or '{}' = no team
-- restriction. Replaces the whole setting at once.
CREATE OR REPLACE FUNCTION public.chat_set_channel_audience(p_channel uuid, p_min_role text, p_team_ids uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_ch    public.chat_channels;
  v_teams uuid[];
  v_old   uuid[];
BEGIN
  v_ch := public.chat_assert_can_manage_channel('chat_set_channel_audience', p_channel, false);
  IF v_ch.kind <> 'team' THEN
    RAISE EXCEPTION 'chat_set_channel_audience: only team channels have an audience' USING ERRCODE = '22023';
  END IF;
  IF p_min_role IS NOT NULL AND p_min_role NOT IN ('viewer','agent','team_leader','admin') THEN
    RAISE EXCEPTION 'chat_set_channel_audience: unknown role %', p_min_role USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(DISTINCT t ORDER BY t) INTO v_teams FROM unnest(coalesce(p_team_ids, '{}')) t WHERE t IS NOT NULL;
  v_teams := coalesce(v_teams, '{}');
  IF EXISTS (SELECT 1 FROM unnest(v_teams) t
              WHERE NOT EXISTS (SELECT 1 FROM public.teams tm WHERE tm.id = t AND tm.account_id = v_ch.account_id)) THEN
    RAISE EXCEPTION 'chat_set_channel_audience: every team must belong to this workspace' USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(array_agg(team_id ORDER BY team_id), '{}') INTO v_old
    FROM public.chat_channel_teams WHERE channel_id = p_channel;

  UPDATE public.chat_channels SET audience_min_role = p_min_role WHERE id = p_channel;
  DELETE FROM public.chat_channel_teams WHERE channel_id = p_channel AND team_id <> ALL (v_teams);
  INSERT INTO public.chat_channel_teams (channel_id, team_id, account_id)
  SELECT p_channel, t, v_ch.account_id FROM unnest(v_teams) t
  ON CONFLICT DO NOTHING;

  -- A channel admin who is not a workspace owner / admin may not lock
  -- themselves out: nobody below admin could undo it from inside.
  IF coalesce(public.chat_ws_role(v_ch.account_id), '') NOT IN ('owner','admin')
     AND NOT public.chat_user_in_channel_audience(p_channel, v_uid) THEN
    RAISE EXCEPTION 'chat_set_channel_audience: this setting would hide this channel from you' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.chat_audit_log (account_id, actor_id, action, channel_id, detail)
  VALUES (v_ch.account_id, v_uid, 'set_audience', p_channel,
          jsonb_build_object('from', jsonb_build_object('min_role', v_ch.audience_min_role, 'team_ids', to_jsonb(v_old)),
                             'to',   jsonb_build_object('min_role', p_min_role, 'team_ids', to_jsonb(v_teams))));
END $$;

-- ---------- 6. Realtime ----------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                      WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
                        AND tablename = 'chat_channel_teams') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_channel_teams;
  END IF;
END $$;

-- ---------- 7. Privileges ----------
-- Supabase grants EXECUTE on new functions to PUBLIC, anon,
-- authenticated and service_role. Revoke everything; only the setter
-- is the client's. chat_user_can_read_channel keeps 087's grants.

DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('chat_audience_rank','chat_user_in_channel_audience',
                                'chat_audience_guard','chat_set_channel_audience')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION public.chat_set_channel_audience(uuid, text, uuid[]) TO authenticated;
