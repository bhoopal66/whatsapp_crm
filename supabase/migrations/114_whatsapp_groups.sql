-- ============================================================
-- 114_whatsapp_groups.sql — WhatsApp groups on a Whapi number
--
-- Staff create and run WhatsApp groups from a Whapi number. The
-- database caches what Whapi reports (the group, its participants, its
-- invite link) and records the group's messages; Whapi stays the source
-- of truth for membership and settings.
--
--  * Whapi only. whatsapp_groups_guard refuses a channel that is not a
--    Whapi row of the group's own account (the composite FK alone would
--    accept a Meta row). channel_id is SET NULL when the number is
--    removed, so a group's history outlives its number; such a group is
--    read-only (nobody below admin manages it, and there is nothing to
--    send through). An archived workspace gets no new group (105's
--    archived_workspace_connect_guard).
--  * Group traffic never enters conversations / messages / the inbound
--    pipeline: those key on one contact per conversation.
--    whatsapp_group_messages is its own log, idempotent on
--    (group_id, wa_message_id); an inserted row moves the group's
--    last_message_at forward (never back).
--  * Who sees a group (whatsapp_group_can_view, as a set
--    whatsapp_group_visible_ids): in the caller's active workspace, and
--    owner/admin; the creator; a manager; a team leader for a group
--    whose creator or a manager is in a team they lead. A viewer sees
--    the same way and only reads. Bank guests and deactivated rows see
--    nothing (current_account_id() is NULL).
--  * Who manages it (whatsapp_group_can_manage, as a set
--    whatsapp_group_manageable_ids): owner/admin; else an agent or team
--    leader who created it or manages it AND may use its number
--    (can_use_channel). Who creates one (whatsapp_group_can_create):
--    agent and up, on a Whapi number of the active workspace they may
--    use. TS mirror: src/lib/groups/access.ts — change both.
--  * The invite link is in whatsapp_group_invites, readable only by
--    those who manage the group.
--  * Writes: no client writes any of these tables. The API routes check
--    access through the caller's RLS client and write with the service
--    role after Whapi accepts the change.
--  * The policies are set-based (113): a per-row SECURITY DEFINER
--    predicate cannot be inlined and costs every message row its own
--    lookups; the visible and manageable sets are initplans instead.
--
-- The SECURITY DEFINER helpers read RLS-forced tables, so, as in 106,
-- this must be applied by a superuser or BYPASSRLS role.
--
-- Re-runnable: CREATE … IF NOT EXISTS, CREATE OR REPLACE,
-- DROP … IF EXISTS.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '114 must be applied by a superuser or BYPASSRLS role (the group functions read RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. Tables ----------

CREATE TABLE IF NOT EXISTS public.whatsapp_groups (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  channel_id         uuid NULL,
  wa_group_id        text NOT NULL,
  name               text NOT NULL,
  description        text NULL,
  icon_url           text NULL,
  participants_count integer NOT NULL DEFAULT 0,
  settings           jsonb NOT NULL DEFAULT '{}'::jsonb,
  our_role           text NOT NULL DEFAULT 'member',
  created_by         uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  synced_at          timestamptz NULL,
  last_message_at    timestamptz NULL,
  left_at            timestamptz NULL,
  CONSTRAINT whatsapp_groups_wa_group_id_check CHECK (wa_group_id ~ '^[0-9-]{10,31}@g\.us$'),
  CONSTRAINT whatsapp_groups_name_check CHECK (char_length(name) <= 200),
  CONSTRAINT whatsapp_groups_description_check CHECK (
    description IS NULL OR char_length(description) <= 2048),
  CONSTRAINT whatsapp_groups_participants_count_check CHECK (participants_count >= 0),
  CONSTRAINT whatsapp_groups_our_role_check CHECK (our_role IN ('admin', 'member', 'left')),
  -- Known keys only, each 'anyone' or 'admins'; a key not yet synced is absent.
  CONSTRAINT whatsapp_groups_settings_check CHECK (
    jsonb_typeof(settings) = 'object'
    AND settings - ARRAY['send_messages', 'edit_group_info', 'approve_participants', 'add_participants'] = '{}'::jsonb
    AND coalesce(settings ->> 'send_messages', 'anyone') IN ('anyone', 'admins')
    AND coalesce(settings ->> 'edit_group_info', 'anyone') IN ('anyone', 'admins')
    AND coalesce(settings ->> 'approve_participants', 'anyone') IN ('anyone', 'admins')
    AND coalesce(settings ->> 'add_participants', 'anyone') IN ('anyone', 'admins')),
  CONSTRAINT whatsapp_groups_channel_group_key UNIQUE (channel_id, wa_group_id),
  -- The target of the composite FKs below.
  CONSTRAINT whatsapp_groups_id_account_key UNIQUE (id, account_id),
  CONSTRAINT whatsapp_groups_channel_fkey FOREIGN KEY (channel_id, account_id)
    REFERENCES public.whatsapp_config (id, account_id) ON DELETE SET NULL (channel_id)
);

-- The list: a workspace's groups, latest activity first.
CREATE INDEX IF NOT EXISTS whatsapp_groups_account_activity_idx
  ON public.whatsapp_groups (account_id, last_message_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS whatsapp_groups_created_by_idx
  ON public.whatsapp_groups (created_by) WHERE created_by IS NOT NULL;

COMMENT ON TABLE public.whatsapp_groups IS
  'WhatsApp groups on a Whapi number: a cache of what Whapi reports. Service role writes only. Migration 114; docs/whatsapp-groups.md.';
COMMENT ON COLUMN public.whatsapp_groups.channel_id IS
  'The Whapi whatsapp_config row the group lives on (whatsapp_groups_guard). NULL once that number is removed: the group is then read-only history.';
COMMENT ON COLUMN public.whatsapp_groups.settings IS
  '{send_messages, edit_group_info, approve_participants, add_participants}: ''anyone'' | ''admins''. A key not yet synced is absent.';
COMMENT ON COLUMN public.whatsapp_groups.our_role IS
  'Our number''s role in the group (a WhatsApp superadmin is ''admin''). left_at is stamped by whatsapp_groups_guard on entering ''left''.';
COMMENT ON COLUMN public.whatsapp_groups.created_by IS
  'auth.users id of the person who created the group from the CRM; NULL for a group synced in from WhatsApp.';

CREATE TABLE IF NOT EXISTS public.whatsapp_group_participants (
  group_id   uuid NOT NULL,
  account_id uuid NOT NULL,
  wa_id      text NOT NULL,
  contact_id uuid NULL,
  role       text NOT NULL DEFAULT 'member',
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, wa_id),
  -- Digits; a participant whose number WhatsApp hides is its LID.
  CONSTRAINT whatsapp_group_participants_wa_id_check CHECK (wa_id ~ '^[0-9]{5,25}(@lid)?$'),
  CONSTRAINT whatsapp_group_participants_role_check CHECK (role IN ('member', 'admin', 'superadmin')),
  CONSTRAINT whatsapp_group_participants_group_fkey FOREIGN KEY (group_id, account_id)
    REFERENCES public.whatsapp_groups (id, account_id) ON DELETE CASCADE,
  CONSTRAINT whatsapp_group_participants_contact_fkey FOREIGN KEY (contact_id, account_id)
    REFERENCES public.contacts (id, account_id) ON DELETE SET NULL (contact_id)
);

CREATE INDEX IF NOT EXISTS whatsapp_group_participants_contact_idx
  ON public.whatsapp_group_participants (contact_id) WHERE contact_id IS NOT NULL;

COMMENT ON TABLE public.whatsapp_group_participants IS
  'A group''s participants as Whapi last reported them. contact_id links a CRM contact of the same account. Service role writes only. Migration 114.';

CREATE TABLE IF NOT EXISTS public.whatsapp_group_managers (
  group_id   uuid NOT NULL,
  account_id uuid NOT NULL,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id),
  CONSTRAINT whatsapp_group_managers_group_fkey FOREIGN KEY (group_id, account_id)
    REFERENCES public.whatsapp_groups (id, account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS whatsapp_group_managers_user_idx
  ON public.whatsapp_group_managers (user_id);

COMMENT ON TABLE public.whatsapp_group_managers IS
  'Staff who work a group (auth.users ids): a live, non-guest member of its account (whatsapp_group_managers_guard). Service role writes only. Migration 114.';

CREATE TABLE IF NOT EXISTS public.whatsapp_group_invites (
  group_id    uuid PRIMARY KEY,
  account_id  uuid NOT NULL,
  invite_code text NOT NULL,
  invite_link text NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_group_invites_code_check CHECK (invite_code ~ '^[A-Za-z0-9_-]{6,64}$'),
  CONSTRAINT whatsapp_group_invites_group_fkey FOREIGN KEY (group_id, account_id)
    REFERENCES public.whatsapp_groups (id, account_id) ON DELETE CASCADE
);

COMMENT ON TABLE public.whatsapp_group_invites IS
  'A group''s current invite link, readable only by those who manage the group (whatsapp_group_can_manage). Service role writes only. Migration 114.';

CREATE TABLE IF NOT EXISTS public.whatsapp_group_messages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL,
  group_id       uuid NOT NULL,
  wa_message_id  text NOT NULL,
  direction      text NOT NULL,
  sender_wa_id   text NULL,
  sender_name    text NULL,
  sender_user_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  type           text NOT NULL DEFAULT 'text',
  body           text NULL,
  media          jsonb NULL,
  status         text NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_group_messages_group_message_key UNIQUE (group_id, wa_message_id),
  CONSTRAINT whatsapp_group_messages_direction_check CHECK (direction IN ('in', 'out')),
  CONSTRAINT whatsapp_group_messages_type_check CHECK (char_length(type) BETWEEN 1 AND 32),
  CONSTRAINT whatsapp_group_messages_status_check CHECK (
    status IS NULL OR status IN ('pending', 'sent', 'delivered', 'read', 'failed')),
  CONSTRAINT whatsapp_group_messages_media_check CHECK (media IS NULL OR jsonb_typeof(media) = 'object'),
  CONSTRAINT whatsapp_group_messages_group_fkey FOREIGN KEY (group_id, account_id)
    REFERENCES public.whatsapp_groups (id, account_id) ON DELETE CASCADE
);

-- A group's chat, newest first.
CREATE INDEX IF NOT EXISTS whatsapp_group_messages_group_created_idx
  ON public.whatsapp_group_messages (group_id, created_at DESC);

COMMENT ON TABLE public.whatsapp_group_messages IS
  'A group''s messages, idempotent on (group_id, wa_message_id). Never in conversations/messages or the inbound pipeline. sender_user_id: the staff member who sent an outbound message. Service role writes only. Migration 114.';

-- ---------- 2. Who sees, manages and creates a group ----------

-- The groups of the active workspace the caller sees. Owner/admin: all.
-- Below: created or managed by the caller or, for a team leader, by a
-- person in a team they lead. Empty for a guest or deactivated row.
CREATE OR REPLACE FUNCTION public.whatsapp_group_visible_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH ctx AS (
    SELECT current_account_id() AS acct, current_role_rank() AS rnk
  ), ppl AS (
    SELECT auth.uid() AS user_id
    UNION
    SELECT tm.user_id
      FROM teams t
      JOIN team_members tm ON tm.team_id = t.id, ctx
     WHERE ctx.rnk = 3
       AND t.account_id = ctx.acct
       AND t.leader_user_id = auth.uid()
  )
  SELECT g.id FROM whatsapp_groups g, ctx
   WHERE g.account_id = ctx.acct AND ctx.rnk >= 4
  UNION
  SELECT g.id FROM whatsapp_groups g, ctx
   WHERE g.account_id = ctx.acct AND ctx.rnk BETWEEN 1 AND 3
     AND g.created_by IN (SELECT user_id FROM ppl)
  UNION
  SELECT m.group_id FROM whatsapp_group_managers m, ctx
   WHERE m.account_id = ctx.acct AND ctx.rnk BETWEEN 1 AND 3
     AND m.user_id IN (SELECT user_id FROM ppl)
$$;
COMMENT ON FUNCTION public.whatsapp_group_visible_ids() IS
  'The groups of the active workspace the caller sees: owner/admin all; else created or managed by the caller or, for a team leader, by a person in a team they lead. Read once per query by the policies. Migration 114.';

-- The groups the caller manages: owner/admin all; an agent or team
-- leader those they created or manage, on a number they may use.
CREATE OR REPLACE FUNCTION public.whatsapp_group_manageable_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH ctx AS (
    SELECT current_account_id() AS acct, current_role_rank() AS rnk
  )
  SELECT g.id FROM whatsapp_groups g, ctx
   WHERE g.account_id = ctx.acct AND ctx.rnk >= 4
  UNION
  SELECT g.id FROM whatsapp_groups g, ctx
   WHERE g.account_id = ctx.acct AND ctx.rnk IN (2, 3)
     AND g.channel_id IS NOT NULL
     AND (g.created_by = auth.uid()
          OR EXISTS (SELECT 1 FROM whatsapp_group_managers m
                      WHERE m.group_id = g.id AND m.user_id = auth.uid()))
     AND can_use_channel(g.account_id, g.channel_id)
$$;
COMMENT ON FUNCTION public.whatsapp_group_manageable_ids() IS
  'The groups of the active workspace the caller manages (edit, members, invite link, send): owner/admin all; an agent or team leader the ones they created or manage, on a number can_use_channel allows. Migration 114.';

CREATE OR REPLACE FUNCTION public.whatsapp_group_can_view(p_group uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM whatsapp_group_visible_ids() v WHERE v = p_group);
$$;
COMMENT ON FUNCTION public.whatsapp_group_can_view(uuid) IS
  'One group: whatsapp_group_visible_ids contains it. TS mirror canViewGroup (src/lib/groups/access.ts). Migration 114.';

CREATE OR REPLACE FUNCTION public.whatsapp_group_can_manage(p_group uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM whatsapp_group_manageable_ids() v WHERE v = p_group);
$$;
COMMENT ON FUNCTION public.whatsapp_group_can_manage(uuid) IS
  'One group: whatsapp_group_manageable_ids contains it. TS mirror canManageGroup (src/lib/groups/access.ts). Migration 114.';

-- Agent and up, on a Whapi number of the active workspace they may use.
CREATE OR REPLACE FUNCTION public.whatsapp_group_can_create(p_channel uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT current_account_id() IS NOT NULL
     AND current_role_rank() >= 2
     AND EXISTS (SELECT 1 FROM whatsapp_config w
                  WHERE w.id = p_channel
                    AND w.account_id = current_account_id()
                    AND w.provider = 'whapi')
     AND can_use_channel(current_account_id(), p_channel);
$$;
COMMENT ON FUNCTION public.whatsapp_group_can_create(uuid) IS
  'May the caller create a group on this number? Agent and up, a Whapi number of the active workspace, can_use_channel. TS mirror canCreateGroup. Migration 114.';

-- ---------- 3. Integrity (every writer, the service role included) ----------

CREATE OR REPLACE FUNCTION public.whatsapp_groups_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account  uuid;
  v_provider text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.wa_group_id IS DISTINCT FROM OLD.wa_group_id
       -- An unowned row may be stamped once: the groups.post webhook for a
       -- group our number just created can land before the create route
       -- stamps its creator. A set creator never changes.
       OR NEW.created_by IS DISTINCT FROM OLD.created_by AND OLD.created_by IS NOT NULL THEN
      RAISE EXCEPTION 'A group''s workspace, WhatsApp id and creator cannot be changed'
        USING ERRCODE = 'check_violation';
    END IF;
    -- The number only goes away (ON DELETE SET NULL); it never moves.
    IF NEW.channel_id IS DISTINCT FROM OLD.channel_id AND NEW.channel_id IS NOT NULL THEN
      RAISE EXCEPTION 'A group cannot move to another number'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW.channel_id IS NULL THEN
      RAISE EXCEPTION 'A group lives on a Whapi number'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT w.account_id, w.provider INTO v_account, v_provider
      FROM whatsapp_config w WHERE w.id = NEW.channel_id;
    IF v_account IS NULL OR v_account IS DISTINCT FROM NEW.account_id THEN
      RAISE EXCEPTION 'That number is not in the group''s workspace'
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_provider IS DISTINCT FROM 'whapi' THEN
      RAISE EXCEPTION 'Groups are only supported on a Whapi number'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- left_at is trigger-owned.
  IF NEW.our_role = 'left' THEN
    NEW.left_at := CASE WHEN TG_OP = 'UPDATE' AND OLD.our_role = 'left'
                        THEN OLD.left_at ELSE now() END;
  ELSE
    NEW.left_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS whatsapp_groups_guard ON public.whatsapp_groups;
CREATE TRIGGER whatsapp_groups_guard
  BEFORE INSERT OR UPDATE ON public.whatsapp_groups
  FOR EACH ROW EXECUTE FUNCTION public.whatsapp_groups_guard();

-- Nothing new in an archived workspace (105).
DROP TRIGGER IF EXISTS whatsapp_groups_archived_guard ON public.whatsapp_groups;
CREATE TRIGGER whatsapp_groups_archived_guard
  BEFORE INSERT OR UPDATE OF account_id ON public.whatsapp_groups
  FOR EACH ROW EXECUTE FUNCTION public.archived_workspace_connect_guard();

-- A manager is a live, non-guest member of the group's account; not
-- necessarily active there (083). The composite FK ties account_id to
-- the group's.
CREATE OR REPLACE FUNCTION public.whatsapp_group_managers_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles p
                  WHERE p.user_id = NEW.user_id
                    AND p.account_id = NEW.account_id
                    AND p.deactivated_at IS NULL
                    AND p.account_role <> 'bank_guest') THEN
    RAISE EXCEPTION 'Only a live staff member of the group''s workspace can manage it'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS whatsapp_group_managers_guard ON public.whatsapp_group_managers;
CREATE TRIGGER whatsapp_group_managers_guard
  BEFORE INSERT OR UPDATE ON public.whatsapp_group_managers
  FOR EACH ROW EXECUTE FUNCTION public.whatsapp_group_managers_guard();

-- A new message moves the group's last activity forward, never back. A
-- replayed message (ON CONFLICT DO NOTHING) inserts nothing and so
-- bumps nothing.
CREATE OR REPLACE FUNCTION public.whatsapp_group_messages_bump()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE whatsapp_groups
     SET last_message_at = NEW.created_at
   WHERE id = NEW.group_id
     AND (last_message_at IS NULL OR last_message_at < NEW.created_at);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS whatsapp_group_messages_bump ON public.whatsapp_group_messages;
CREATE TRIGGER whatsapp_group_messages_bump
  AFTER INSERT ON public.whatsapp_group_messages
  FOR EACH ROW EXECUTE FUNCTION public.whatsapp_group_messages_bump();

-- ---------- 4. Row-level security ----------

ALTER TABLE public.whatsapp_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_groups FORCE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_group_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_group_participants FORCE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_group_managers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_group_managers FORCE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_group_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_group_invites FORCE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_group_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_group_messages FORCE ROW LEVEL SECURITY;

-- SELECT only; the sets are initplans, so each row costs a hash lookup.
DROP POLICY IF EXISTS whatsapp_groups_select ON public.whatsapp_groups;
CREATE POLICY whatsapp_groups_select ON public.whatsapp_groups FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND id IN (SELECT public.whatsapp_group_visible_ids()));

DROP POLICY IF EXISTS whatsapp_group_participants_select ON public.whatsapp_group_participants;
CREATE POLICY whatsapp_group_participants_select ON public.whatsapp_group_participants FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND group_id IN (SELECT public.whatsapp_group_visible_ids()));

DROP POLICY IF EXISTS whatsapp_group_managers_select ON public.whatsapp_group_managers;
CREATE POLICY whatsapp_group_managers_select ON public.whatsapp_group_managers FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND group_id IN (SELECT public.whatsapp_group_visible_ids()));

DROP POLICY IF EXISTS whatsapp_group_messages_select ON public.whatsapp_group_messages;
CREATE POLICY whatsapp_group_messages_select ON public.whatsapp_group_messages FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND group_id IN (SELECT public.whatsapp_group_visible_ids()));

DROP POLICY IF EXISTS whatsapp_group_invites_select ON public.whatsapp_group_invites;
CREATE POLICY whatsapp_group_invites_select ON public.whatsapp_group_invites FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND group_id IN (SELECT public.whatsapp_group_manageable_ids()));

-- ---------- 5. Privileges ----------

-- A new public table starts with every privilege for anon and
-- authenticated, TRUNCATE (which skips RLS) among them: start from
-- nothing and grant what the policies govern.
REVOKE ALL ON public.whatsapp_groups, public.whatsapp_group_participants,
  public.whatsapp_group_managers, public.whatsapp_group_invites, public.whatsapp_group_messages
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.whatsapp_groups, public.whatsapp_group_participants,
  public.whatsapp_group_managers, public.whatsapp_group_invites, public.whatsapp_group_messages
  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_groups, public.whatsapp_group_participants,
  public.whatsapp_group_managers, public.whatsapp_group_invites, public.whatsapp_group_messages
  TO service_role;

REVOKE ALL ON FUNCTION public.whatsapp_group_visible_ids() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.whatsapp_group_manageable_ids() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.whatsapp_group_can_view(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.whatsapp_group_can_manage(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.whatsapp_group_can_create(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.whatsapp_group_visible_ids(),
  public.whatsapp_group_manageable_ids(),
  public.whatsapp_group_can_view(uuid),
  public.whatsapp_group_can_manage(uuid),
  public.whatsapp_group_can_create(uuid)
  TO authenticated, service_role;

-- Trigger functions are not for calling.
REVOKE ALL ON FUNCTION public.whatsapp_groups_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.whatsapp_group_managers_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.whatsapp_group_messages_bump() FROM PUBLIC, anon, authenticated;

-- ---------- 6. Realtime ----------
-- The group list (last activity) and the chat update live. RLS is
-- replayed per subscriber, so a subscription shows only what a query
-- would.
DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH t IN ARRAY ARRAY['whatsapp_groups', 'whatsapp_group_messages'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
         WHERE pubname = 'supabase_realtime'
           AND schemaname = 'public' AND tablename = t
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
      END IF;
    END LOOP;
  END IF;
END
$$;

RESET lock_timeout;
