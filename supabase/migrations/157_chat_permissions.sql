-- 157: team chat permissions (087 family): a per-workspace role matrix,
-- edit / delete time windows and per-channel posting rules.
--
-- Nothing changes until an owner or admin saves rules, as with 143's DM
-- rules: no row means allowed, no window means no limit, and a channel
-- posts, threads and @channel-s for 'everyone' by default.
--
--   A. chat_role_permissions (account, role_class, capability): a row
--      means DENIED. role_class is the person's account role (admin,
--      team_leader, agent, viewer, bank_guest); owners are exempt from
--      the matrix and from the windows, so no rule set can lock out the
--      person who would have to fix it. bank_guest rows exist only for
--      the capabilities a guest can have at all; the rest (creating
--      channels, group DMs, sharing cards, adding members) are already
--      impossible for a guest and chat_has_permission answers false.
--      Written only by chat_set_permissions (live owner / admin, whole
--      set replaced, audited 'set_permissions'); chat_my_permissions is
--      what the client reads to grey out controls.
--   B. chat_workspace_settings.edit_window_minutes / delete_window_minutes
--      (NULL = no limit, else 1..10080): an author's own edit or delete
--      later than that after created_at is refused, unless the author is
--      a workspace owner or admin. Deleting someone else's message
--      (owner / admin) is unchanged. Written by
--      chat_set_workspace_settings (audited 'update_settings'). The
--      table is shared with a sibling migration that adds its own
--      columns the same way, so it is created bare and each migration
--      adds its columns.
--   C. chat_channels.posting / thread_replies / mention_everyone
--      ('everyone' | 'admins'), team and private channels only (a CHECK
--      keeps DMs and deal rooms at 'everyone'). 'admins' means a channel
--      admin (chat_channel_members.role) or a live workspace owner /
--      admin; a bank guest never counts. Written by
--      chat_set_channel_policy behind 091's chat_assert_can_manage_channel
--      (audited 'update_policy').
--   D. Enforcement adds checks to the existing RPCs and keeps every
--      existing refusal ahead of them. Every new refusal is 42501 and
--      its message carries the fragment the client maps:
--        'chat: your role may not …'                 (role matrix)
--        'only channel admins can post here'         (posting rule)
--        'only channel admins can reply in threads here'
--        'you may not notify everyone'               (@channel / @here)
--        'the edit window has passed' / 'the delete window has passed'
--      chat_post_system_message is untouched.
--
-- Must be applied by a superuser or BYPASSRLS role, like 087 and 091:
-- the new SECURITY DEFINER functions read and write RLS-forced tables
-- with no write policy. Re-runnable; no BEGIN/COMMIT. Nothing is granted
-- to service_role (verify-internal-chat-admin.sql pins that list).

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '157 must be applied by a superuser or BYPASSRLS role (the chat functions own RLS-forced tables)';
  END IF;
END $$;

-- ---------- E. Audit actions ----------

ALTER TABLE public.chat_audit_log DROP CONSTRAINT IF EXISTS chat_audit_log_action_check;
ALTER TABLE public.chat_audit_log ADD CONSTRAINT chat_audit_log_action_check CHECK (action IN (
  'admin_read_private','erase_person','add_members','set_member_role',
  'update_channel','archive_channel','unarchive_channel','remove_member',
  'set_permissions','update_settings','update_policy'));

-- ---------- A. Role permission matrix ----------

CREATE TABLE IF NOT EXISTS public.chat_role_permissions (
  account_id uuid        NOT NULL REFERENCES public.accounts(id),
  role_class text        NOT NULL CHECK (role_class IN ('admin','team_leader','agent','viewer','bank_guest')),
  capability text        NOT NULL CHECK (capability IN (
                           'create_team_channel','create_private_channel','open_group_dm','mention_everyone',
                           'upload_files','send_voice','pin_messages','forward_messages','share_cards',
                           'add_members','edit_own','delete_own')),
  updated_by uuid        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, role_class, capability),
  CONSTRAINT chat_role_permissions_guest_caps CHECK (
    role_class <> 'bank_guest'
    OR capability IN ('upload_files','send_voice','pin_messages','forward_messages',
                      'mention_everyone','edit_own','delete_own'))
);

ALTER TABLE public.chat_role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_role_permissions FORCE ROW LEVEL SECURITY;

-- Live staff of the workspace read the matrix (the Settings screen and
-- anyone curious why a control is greyed); guests read their own
-- answer through chat_my_permissions.
DROP POLICY IF EXISTS chat_role_permissions_read ON public.chat_role_permissions;
CREATE POLICY chat_role_permissions_read ON public.chat_role_permissions
  FOR SELECT TO authenticated
  USING (coalesce(public.chat_ws_role(account_id), 'bank_guest') <> 'bank_guest');

DROP TRIGGER IF EXISTS chat_role_permissions_no_truncate ON public.chat_role_permissions;
CREATE TRIGGER chat_role_permissions_no_truncate BEFORE TRUNCATE ON public.chat_role_permissions
  FOR EACH STATEMENT EXECUTE FUNCTION public.chat_block_truncate();

REVOKE ALL ON public.chat_role_permissions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.chat_role_permissions TO authenticated;

-- ---------- B. Workspace settings ----------

CREATE TABLE IF NOT EXISTS public.chat_workspace_settings (
  account_id uuid PRIMARY KEY REFERENCES public.accounts(id),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.chat_workspace_settings ADD COLUMN IF NOT EXISTS edit_window_minutes integer NULL
  CONSTRAINT chat_workspace_settings_edit_window_check
  CHECK (edit_window_minutes IS NULL OR edit_window_minutes BETWEEN 1 AND 10080);
ALTER TABLE public.chat_workspace_settings ADD COLUMN IF NOT EXISTS delete_window_minutes integer NULL
  CONSTRAINT chat_workspace_settings_delete_window_check
  CHECK (delete_window_minutes IS NULL OR delete_window_minutes BETWEEN 1 AND 10080);

ALTER TABLE public.chat_workspace_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_workspace_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chat_workspace_settings_read ON public.chat_workspace_settings;
CREATE POLICY chat_workspace_settings_read ON public.chat_workspace_settings
  FOR SELECT TO authenticated USING (public.chat_ws_role(account_id) IS NOT NULL);

DROP TRIGGER IF EXISTS chat_workspace_settings_no_truncate ON public.chat_workspace_settings;
CREATE TRIGGER chat_workspace_settings_no_truncate BEFORE TRUNCATE ON public.chat_workspace_settings
  FOR EACH STATEMENT EXECUTE FUNCTION public.chat_block_truncate();

REVOKE ALL ON public.chat_workspace_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.chat_workspace_settings TO authenticated;

-- ---------- C. Channel posting rules ----------

ALTER TABLE public.chat_channels ADD COLUMN IF NOT EXISTS posting text NOT NULL DEFAULT 'everyone'
  CONSTRAINT chat_channels_posting_check CHECK (posting IN ('everyone','admins'));
ALTER TABLE public.chat_channels ADD COLUMN IF NOT EXISTS thread_replies text NOT NULL DEFAULT 'everyone'
  CONSTRAINT chat_channels_thread_replies_check CHECK (thread_replies IN ('everyone','admins'));
ALTER TABLE public.chat_channels ADD COLUMN IF NOT EXISTS mention_everyone text NOT NULL DEFAULT 'everyone'
  CONSTRAINT chat_channels_mention_everyone_check CHECK (mention_everyone IN ('everyone','admins'));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.chat_channels'::regclass
                    AND conname = 'chat_channels_policy_by_kind') THEN
    ALTER TABLE public.chat_channels ADD CONSTRAINT chat_channels_policy_by_kind CHECK (
      kind IN ('team','private')
      OR (posting = 'everyone' AND thread_replies = 'everyone' AND mention_everyone = 'everyone'));
  END IF;
END $$;

-- ---------- Internal helpers (executable by nobody) ----------

-- p_user's account role in p_ws from a live profile in a workspace that
-- is not archived (105's joins of chat_user_role, without its
-- team_leader / viewer folding: the matrix tells those classes apart).
CREATE OR REPLACE FUNCTION public.chat_role_class(p_ws uuid, p_user uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.account_role::text
    FROM public.profiles p
    JOIN public.accounts a ON a.id = p.account_id AND a.archived_at IS NULL
   WHERE p.account_id = p_ws AND p.user_id = p_user AND p.deactivated_at IS NULL
$$;

-- May p_user use p_cap in p_ws? Owners always; a guest never for a
-- capability a guest cannot have; otherwise allowed unless a row
-- denies it. Someone with no live profile is answered true: the
-- existing membership gates decide for them.
CREATE OR REPLACE FUNCTION public.chat_has_permission(p_ws uuid, p_user uuid, p_cap text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_class text := public.chat_role_class(p_ws, p_user);
BEGIN
  IF v_class IS NULL OR v_class = 'owner' THEN
    RETURN true;
  END IF;
  IF v_class = 'bank_guest'
     AND p_cap IN ('create_team_channel','create_private_channel','open_group_dm','share_cards','add_members') THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS (SELECT 1 FROM public.chat_role_permissions rp
                      WHERE rp.account_id = p_ws AND rp.role_class = v_class AND rp.capability = p_cap);
END $$;

-- The caller's refusal: 'chat: your role may not <what>'.
CREATE OR REPLACE FUNCTION public.chat_assert_permission(p_ws uuid, p_cap text)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.chat_has_permission(p_ws, auth.uid(), p_cap) THEN
    RAISE EXCEPTION 'chat: your role may not %', CASE p_cap
        WHEN 'create_team_channel'    THEN 'create team channels'
        WHEN 'create_private_channel' THEN 'create private channels'
        WHEN 'open_group_dm'          THEN 'open group DMs'
        WHEN 'mention_everyone'       THEN 'notify everyone (@channel / @here)'
        WHEN 'upload_files'           THEN 'upload files'
        WHEN 'send_voice'             THEN 'send voice notes'
        WHEN 'pin_messages'           THEN 'pin messages'
        WHEN 'forward_messages'       THEN 'forward messages'
        WHEN 'share_cards'            THEN 'share cards'
        WHEN 'add_members'            THEN 'add members'
        WHEN 'edit_own'               THEN 'edit messages'
        WHEN 'delete_own'             THEN 'delete messages'
        ELSE p_cap END
      USING ERRCODE = '42501';
  END IF;
END $$;

-- Counts as an admin of the channel for its posting rules: a channel
-- admin, or a live workspace owner / admin. A bank guest never does.
CREATE OR REPLACE FUNCTION public.chat_is_channel_admin(p_channel uuid, p_ws uuid, p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE coalesce(public.chat_user_role(p_ws, p_user), 'bank_guest')
           WHEN 'bank_guest' THEN false
           WHEN 'owner' THEN true
           WHEN 'admin' THEN true
           ELSE EXISTS (SELECT 1 FROM public.chat_channel_members cm
                         WHERE cm.channel_id = p_channel AND cm.user_id = p_user AND cm.role = 'admin')
         END
$$;

-- The channel's posting rule (top level) or thread rule (a reply).
CREATE OR REPLACE FUNCTION public.chat_assert_post_rules(p_ch public.chat_channels, p_thread_root uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_thread_root IS NULL THEN
    IF p_ch.posting = 'admins' AND NOT public.chat_is_channel_admin(p_ch.id, p_ch.account_id, auth.uid()) THEN
      RAISE EXCEPTION 'chat: only channel admins can post here' USING ERRCODE = '42501';
    END IF;
  ELSIF p_ch.thread_replies = 'admins' AND NOT public.chat_is_channel_admin(p_ch.id, p_ch.account_id, auth.uid()) THEN
    RAISE EXCEPTION 'chat: only channel admins can reply in threads here' USING ERRCODE = '42501';
  END IF;
END $$;

-- The edit or delete window for the author's own message. Owners and
-- admins are exempt; no settings row or a NULL window is no limit.
CREATE OR REPLACE FUNCTION public.chat_assert_window(p_msg public.internal_messages, p_kind text)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_minutes integer;
BEGIN
  IF coalesce(public.chat_user_role(p_msg.account_id, p_msg.author_id), '') IN ('owner','admin') THEN
    RETURN;
  END IF;
  SELECT CASE p_kind WHEN 'edit' THEN s.edit_window_minutes ELSE s.delete_window_minutes END
    INTO v_minutes
    FROM public.chat_workspace_settings s WHERE s.account_id = p_msg.account_id;
  IF v_minutes IS NOT NULL AND now() > p_msg.created_at + make_interval(mins => v_minutes) THEN
    RAISE EXCEPTION 'chat: the % window has passed (% minutes)', p_kind, v_minutes USING ERRCODE = '42501';
  END IF;
END $$;

-- ---------- API: the three setters and the caller's answer ----------

-- p_denied: [{role_class, capability}, …], the workspace's whole set.
CREATE OR REPLACE FUNCTION public.chat_set_permissions(p_ws uuid, p_denied jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_denied jsonb;
BEGIN
  IF v_uid IS NULL OR coalesce(public.chat_ws_role(p_ws), '') NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'chat_set_permissions: owner or admin role required' USING ERRCODE = '42501';
  END IF;
  IF p_denied IS NULL OR jsonb_typeof(p_denied) <> 'array' THEN
    RAISE EXCEPTION 'chat_set_permissions: denied must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_denied) e
              WHERE jsonb_typeof(e) <> 'object'
                 OR jsonb_typeof(e->'role_class') IS DISTINCT FROM 'string'
                 OR jsonb_typeof(e->'capability') IS DISTINCT FROM 'string'
                 OR e->>'role_class' NOT IN ('admin','team_leader','agent','viewer','bank_guest')
                 OR e->>'capability' NOT IN ('create_team_channel','create_private_channel','open_group_dm',
                      'mention_everyone','upload_files','send_voice','pin_messages','forward_messages',
                      'share_cards','add_members','edit_own','delete_own')) THEN
    RAISE EXCEPTION 'chat_set_permissions: each item needs role_class (admin, team_leader, agent, viewer, bank_guest) and a known capability'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_denied) e
              WHERE e->>'role_class' = 'bank_guest'
                AND e->>'capability' NOT IN ('upload_files','send_voice','pin_messages','forward_messages',
                                             'mention_everyone','edit_own','delete_own')) THEN
    RAISE EXCEPTION 'chat_set_permissions: bank guests never have that capability; only upload_files, send_voice, pin_messages, forward_messages, mention_everyone, edit_own and delete_own can be denied to them'
      USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('role_class', d.rc, 'capability', d.cap) ORDER BY d.rc, d.cap), '[]'::jsonb)
    INTO v_denied
    FROM (SELECT DISTINCT e->>'role_class' AS rc, e->>'capability' AS cap
            FROM jsonb_array_elements(p_denied) e) d;

  PERFORM pg_advisory_xact_lock(hashtextextended('chat_role_permissions:' || p_ws::text, 0));
  DELETE FROM public.chat_role_permissions WHERE account_id = p_ws;
  INSERT INTO public.chat_role_permissions (account_id, role_class, capability, updated_by, updated_at)
  SELECT p_ws, x->>'role_class', x->>'capability', v_uid, now()
    FROM jsonb_array_elements(v_denied) x;
  INSERT INTO public.chat_audit_log (account_id, actor_id, action, detail)
  VALUES (p_ws, v_uid, 'set_permissions', jsonb_build_object('denied', v_denied));
END $$;

-- NULL = no limit, else 1..10080 minutes.
CREATE OR REPLACE FUNCTION public.chat_set_workspace_settings(p_ws uuid, p_edit_window_minutes integer,
  p_delete_window_minutes integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_old public.chat_workspace_settings;
BEGIN
  IF v_uid IS NULL OR coalesce(public.chat_ws_role(p_ws), '') NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'chat_set_workspace_settings: owner or admin role required' USING ERRCODE = '42501';
  END IF;
  IF p_edit_window_minutes NOT BETWEEN 1 AND 10080 OR p_delete_window_minutes NOT BETWEEN 1 AND 10080 THEN
    RAISE EXCEPTION 'chat_set_workspace_settings: a window is empty (no limit) or 1 to 10080 minutes'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_old FROM public.chat_workspace_settings WHERE account_id = p_ws FOR UPDATE;
  INSERT INTO public.chat_workspace_settings AS s
         (account_id, edit_window_minutes, delete_window_minutes, updated_by, updated_at)
  VALUES (p_ws, p_edit_window_minutes, p_delete_window_minutes, v_uid, now())
  ON CONFLICT (account_id) DO UPDATE
     SET edit_window_minutes = EXCLUDED.edit_window_minutes,
         delete_window_minutes = EXCLUDED.delete_window_minutes,
         updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
  INSERT INTO public.chat_audit_log (account_id, actor_id, action, detail)
  VALUES (p_ws, v_uid, 'update_settings', jsonb_build_object(
    'old', jsonb_build_object('edit_window_minutes', v_old.edit_window_minutes,
                              'delete_window_minutes', v_old.delete_window_minutes),
    'new', jsonb_build_object('edit_window_minutes', p_edit_window_minutes,
                              'delete_window_minutes', p_delete_window_minutes)));
END $$;

-- NULL keeps a field. No change, no audit row.
CREATE OR REPLACE FUNCTION public.chat_set_channel_policy(p_channel uuid, p_posting text, p_thread_replies text,
  p_mention_everyone text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_ch public.chat_channels;
  v_p  text;
  v_t  text;
  v_m  text;
BEGIN
  v_ch := public.chat_assert_can_manage_channel('chat_set_channel_policy', p_channel, false);
  IF p_posting NOT IN ('everyone','admins') OR p_thread_replies NOT IN ('everyone','admins')
     OR p_mention_everyone NOT IN ('everyone','admins') THEN
    RAISE EXCEPTION 'chat_set_channel_policy: each rule is everyone or admins' USING ERRCODE = '22023';
  END IF;
  v_p := coalesce(p_posting, v_ch.posting);
  v_t := coalesce(p_thread_replies, v_ch.thread_replies);
  v_m := coalesce(p_mention_everyone, v_ch.mention_everyone);
  IF v_p = v_ch.posting AND v_t = v_ch.thread_replies AND v_m = v_ch.mention_everyone THEN
    RETURN;
  END IF;
  UPDATE public.chat_channels SET posting = v_p, thread_replies = v_t, mention_everyone = v_m WHERE id = p_channel;
  INSERT INTO public.chat_audit_log (account_id, actor_id, action, channel_id, detail)
  VALUES (v_ch.account_id, auth.uid(), 'update_policy', p_channel, jsonb_build_object(
    'old', jsonb_build_object('posting', v_ch.posting, 'thread_replies', v_ch.thread_replies,
                              'mention_everyone', v_ch.mention_everyone),
    'new', jsonb_build_object('posting', v_p, 'thread_replies', v_t, 'mention_everyone', v_m)));
END $$;

-- The caller's answer in p_ws, for the client to grey out controls.
CREATE OR REPLACE FUNCTION public.chat_my_permissions(p_ws uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_class text := public.chat_role_class(p_ws, auth.uid());
  v_set   public.chat_workspace_settings;
BEGIN
  IF v_uid IS NULL OR v_class IS NULL THEN
    RAISE EXCEPTION 'chat_my_permissions: not a member of this workspace' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_set FROM public.chat_workspace_settings WHERE account_id = p_ws;
  RETURN jsonb_build_object(
    'role_class', v_class,
    'capabilities', (SELECT jsonb_object_agg(c, public.chat_has_permission(p_ws, v_uid, c))
                       FROM unnest(ARRAY['create_team_channel','create_private_channel','open_group_dm',
                                         'mention_everyone','upload_files','send_voice','pin_messages',
                                         'forward_messages','share_cards','add_members','edit_own',
                                         'delete_own']) c),
    'edit_window_minutes', v_set.edit_window_minutes,
    'delete_window_minutes', v_set.delete_window_minutes,
    'windows_apply', v_class NOT IN ('owner','admin'));
END $$;

REVOKE ALL ON FUNCTION public.chat_role_class(uuid, uuid), public.chat_has_permission(uuid, uuid, text),
  public.chat_assert_permission(uuid, text), public.chat_is_channel_admin(uuid, uuid, uuid),
  public.chat_assert_post_rules(public.chat_channels, uuid),
  public.chat_assert_window(public.internal_messages, text),
  public.chat_set_permissions(uuid, jsonb), public.chat_set_workspace_settings(uuid, integer, integer),
  public.chat_set_channel_policy(uuid, text, text, text), public.chat_my_permissions(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.chat_set_permissions(uuid, jsonb),
  public.chat_set_workspace_settings(uuid, integer, integer),
  public.chat_set_channel_policy(uuid, text, text, text), public.chat_my_permissions(uuid)
  TO authenticated;

-- ---------- D. Enforcement in the existing RPCs ----------
-- Each function below is its latest body (file named above it) with the
-- 157 checks added after its existing refusals; signatures and grants
-- are unchanged (CREATE OR REPLACE keeps the ACL).

-- chat_create_channel (087_internal_chat.sql): create_team_channel / create_private_channel. The initial p_member_ids are part of creating, not add_members.
CREATE OR REPLACE FUNCTION public.chat_create_channel(
  p_ws uuid, p_kind text, p_name text, p_topic text DEFAULT NULL, p_member_ids uuid[] DEFAULT '{}')
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_role text := public.chat_ws_role(p_ws);
  v_id   uuid;
  v_bad  uuid;
BEGIN
  IF v_uid IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'chat_create_channel: not a member of this workspace' USING ERRCODE = '42501';
  END IF;
  IF v_role = 'bank_guest' THEN
    RAISE EXCEPTION 'chat_create_channel: bank guests cannot create channels' USING ERRCODE = '42501';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('team','private') THEN
    RAISE EXCEPTION 'chat_create_channel: kind must be team or private (deal rooms are opened from a deal)'
      USING ERRCODE = '22023';
  END IF;
  IF NOT (SELECT a.internal_chat_enabled FROM public.accounts a WHERE a.id = p_ws) THEN
    RAISE EXCEPTION 'chat_create_channel: internal chat is disabled for this workspace' USING ERRCODE = 'CH001';
  END IF;
  -- 157: the role matrix.
  PERFORM public.chat_assert_permission(p_ws,
    CASE p_kind WHEN 'team' THEN 'create_team_channel' ELSE 'create_private_channel' END);
  SELECT m INTO v_bad FROM unnest(coalesce(p_member_ids, '{}')) m
   WHERE public.chat_user_role(p_ws, m) IS NULL LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'chat_create_channel: % is not an active member of this workspace', v_bad USING ERRCODE = '42501';
  END IF;
  -- bank guests: private channels only, added by owner/admin/supervisor only
  IF EXISTS (SELECT 1 FROM unnest(coalesce(p_member_ids, '{}')) m WHERE public.chat_user_role(p_ws, m) = 'bank_guest')
     AND (p_kind <> 'private' OR v_role NOT IN ('owner','admin','supervisor')) THEN
    RAISE EXCEPTION 'chat_create_channel: bank guests can only be added to private channels by owner/admin/supervisor'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.chat_channels (account_id, kind, name, topic, created_by)
  VALUES (p_ws, p_kind, btrim(p_name), p_topic, v_uid)
  RETURNING id INTO v_id;
  INSERT INTO public.chat_channel_members (channel_id, user_id, role) VALUES (v_id, v_uid, 'admin');
  INSERT INTO public.chat_channel_members (channel_id, user_id, role)
  SELECT DISTINCT v_id, m, CASE public.chat_user_role(p_ws, m) WHEN 'bank_guest' THEN 'guest' ELSE 'member' END
    FROM unnest(coalesce(p_member_ids, '{}')) m
   WHERE m <> v_uid
  ON CONFLICT DO NOTHING;
  RETURN v_id;
END $$;

-- chat_open_dm (143_chat_dm_rules.sql): open_group_dm for a set of 3 or more.
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
  -- 157: a group DM (3+ people, the opener included), on reopening too.
  IF cardinality(v_members) >= 3 THEN
    PERFORM public.chat_assert_permission(p_ws, 'open_group_dm');
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

-- chat_post_message (156_chat_messaging_v2.sql): posting / thread rules, @channel, upload_files, send_voice, share_cards.
CREATE OR REPLACE FUNCTION public.chat_post_message(
  p_channel uuid, p_body text, p_thread_root uuid DEFAULT NULL, p_share_conversation uuid DEFAULT NULL,
  p_attachments jsonb DEFAULT '[]'::jsonb, p_reply_to uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_ch        public.chat_channels;
  v_id        uuid;
  v_broadcast boolean := false;
BEGIN
  v_ch := public.chat_assert_can_write(p_channel, true);

  IF p_share_conversation IS NOT NULL
     AND (NOT public.chat_can_view_conversation(p_share_conversation)
          OR NOT EXISTS (SELECT 1 FROM public.conversations cv
                          WHERE cv.id = p_share_conversation AND cv.account_id = v_ch.account_id)) THEN
    RAISE EXCEPTION 'chat_post_message: you cannot share this conversation' USING ERRCODE = '42501';
  END IF;
  -- A card is customer data and bank guests never see the inbox: no
  -- share into a channel with a guest member (role guest, or a current
  -- account role of bank_guest). Reads re-check access anyway.
  IF p_share_conversation IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.chat_channel_members cm
                  WHERE cm.channel_id = p_channel
                    AND (cm.role = 'guest'
                         OR public.chat_user_role(v_ch.account_id, cm.user_id) = 'bank_guest')) THEN
    RAISE EXCEPTION 'chat_post_message: a conversation cannot be shared into a channel with a bank guest'
      USING ERRCODE = '42501';
  END IF;

  -- 157: the channel's posting / thread rule, then the role matrix.
  -- @channel / @here is the regex message_mentions_broadcast uses below.
  PERFORM public.chat_assert_post_rules(v_ch, p_thread_root);
  IF p_body ~* '(?:^|[^[:alnum:]_])@(channel|here)(?![[:alnum:]_])' THEN
    PERFORM public.chat_assert_permission(v_ch.account_id, 'mention_everyone');
    IF v_ch.mention_everyone = 'admins' AND NOT public.chat_is_channel_admin(v_ch.id, v_ch.account_id, v_uid) THEN
      RAISE EXCEPTION 'chat: you may not notify everyone in this channel (only channel admins can)'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  IF jsonb_typeof(p_attachments) = 'array' THEN
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_attachments) a
                WHERE jsonb_typeof(a) = 'object' AND coalesce(a->>'kind', 'file') = 'file') THEN
      PERFORM public.chat_assert_permission(v_ch.account_id, 'upload_files');
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_attachments) a
                WHERE jsonb_typeof(a) = 'object' AND a->>'kind' = 'voice') THEN
      PERFORM public.chat_assert_permission(v_ch.account_id, 'send_voice');
    END IF;
  END IF;
  IF p_share_conversation IS NOT NULL THEN
    PERFORM public.chat_assert_permission(v_ch.account_id, 'share_cards');
  END IF;

  INSERT INTO public.internal_messages (channel_id, account_id, thread_root_id, author_kind, author_id, body, reply_to_id)
  VALUES (p_channel, v_ch.account_id, p_thread_root, 'user', v_uid, p_body, p_reply_to)
  RETURNING id INTO v_id;

  -- validates every attachment; a refusal rolls the message back with it
  PERFORM public.chat_insert_attachments(v_ch, v_id, p_attachments);

  -- <@uuid> mentions; anyone who cannot read the channel's messages is dropped
  INSERT INTO public.message_mentions (message_id, user_id)
  SELECT DISTINCT v_id, (t[1])::uuid
    FROM regexp_matches(p_body, '<@([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})>', 'g') t
   WHERE public.chat_user_can_read_channel(p_channel, (t[1])::uuid, true)
  ON CONFLICT DO NOTHING;

  -- @channel / @here (no presence check: both notify every channel member)
  INSERT INTO public.message_mentions_broadcast (message_id, kind)
  SELECT DISTINCT v_id, lower(t[1])
    FROM regexp_matches(p_body, '(?:^|[^[:alnum:]_])@(channel|here)(?![[:alnum:]_])', 'gi') t
  ON CONFLICT DO NOTHING;
  v_broadcast := FOUND;

  -- one notification per recipient; precedence mention > dm > thread_reply > broadcast
  INSERT INTO public.chat_notifications (user_id, account_id, message_id, kind)
  SELECT DISTINCT ON (r.uid) r.uid, v_ch.account_id, v_id, r.kind
    FROM (
      SELECT mm.user_id AS uid, 'mention'::text AS kind, 1 AS prio
        FROM public.message_mentions mm WHERE mm.message_id = v_id
      UNION ALL
      SELECT cm.user_id, 'dm', 2
        FROM public.chat_channel_members cm WHERE v_ch.kind = 'dm' AND cm.channel_id = p_channel
      UNION ALL
      SELECT x.author_id, 'thread_reply', 3
        FROM public.internal_messages x
       WHERE p_thread_root IS NOT NULL AND x.author_id IS NOT NULL
         AND (x.id = p_thread_root OR (x.thread_root_id = p_thread_root AND x.id <> v_id))
      UNION ALL
      SELECT cm.user_id, 'broadcast', 4
        FROM public.chat_channel_members cm WHERE v_broadcast AND cm.channel_id = p_channel
    ) r
   WHERE r.uid <> v_uid AND public.chat_user_can_read_channel(p_channel, r.uid, true)
   ORDER BY r.uid, r.prio;

  IF p_share_conversation IS NOT NULL THEN
    INSERT INTO public.shared_conversations (message_id, conversation_id, shared_by, snapshot)
    VALUES (v_id, p_share_conversation, v_uid, public.chat_conversation_snapshot(p_share_conversation));
  END IF;
  RETURN v_id;
END $$;

-- chat_forward_message (156_chat_messaging_v2.sql): forward_messages and the posting rule.
CREATE OR REPLACE FUNCTION public.chat_forward_message(p_message uuid, p_channel uuid,
  p_attachments jsonb DEFAULT '[]'::jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_src public.internal_messages;
  v_ch  public.chat_channels;
  v_id  uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'chat: no authenticated user' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_src FROM public.internal_messages WHERE id = p_message;
  IF NOT FOUND OR NOT public.chat_can_read_channel(v_src.channel_id) THEN
    RAISE EXCEPTION 'chat_forward_message: message not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_src.deleted_at IS NOT NULL OR v_src.erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'chat_forward_message: a deleted message cannot be forwarded' USING ERRCODE = '22023';
  END IF;

  v_ch := public.chat_assert_can_write(p_channel, true);
  IF v_ch.account_id <> v_src.account_id THEN
    RAISE EXCEPTION 'chat_forward_message: a message can only be forwarded within its workspace'
      USING ERRCODE = '42501';
  END IF;
  -- 157: a forward is a top-level post; its copied attachments need no upload_files.
  PERFORM public.chat_assert_permission(v_ch.account_id, 'forward_messages');
  PERFORM public.chat_assert_post_rules(v_ch, NULL);

  INSERT INTO public.internal_messages (channel_id, account_id, author_kind, author_id, body, meta)
  VALUES (p_channel, v_ch.account_id, 'user', v_uid,
          left(public.chat_render_mentions(v_src.body, v_src.account_id), 8000),
          jsonb_build_object('forwarded', jsonb_build_object(
            'message_id', v_src.id, 'author_id', v_src.author_id,
            'author_kind', v_src.author_kind, 'created_at', v_src.created_at)))
  RETURNING id INTO v_id;

  PERFORM public.chat_insert_attachments(v_ch, v_id, p_attachments);

  INSERT INTO public.chat_notifications (user_id, account_id, message_id, kind)
  SELECT cm.user_id, v_ch.account_id, v_id, 'dm'
    FROM public.chat_channel_members cm
   WHERE v_ch.kind = 'dm' AND cm.channel_id = p_channel AND cm.user_id <> v_uid
     AND public.chat_user_can_read_channel(p_channel, cm.user_id, true);
  RETURN v_id;
END $$;

-- chat_set_typing (156_chat_messaging_v2.sql): the posting / thread rule (stopping typing is never refused).
CREATE OR REPLACE FUNCTION public.chat_set_typing(p_channel uuid, p_thread_root uuid DEFAULT NULL,
  p_typing boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_ch  public.chat_channels;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'chat: no authenticated user' USING ERRCODE = '42501';
  END IF;
  IF NOT coalesce(p_typing, false) THEN
    DELETE FROM public.chat_typing WHERE channel_id = p_channel AND user_id = v_uid;
    RETURN;
  END IF;

  v_ch := public.chat_assert_can_write(p_channel, false);
  IF p_thread_root IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.internal_messages m
                      WHERE m.id = p_thread_root AND m.channel_id = p_channel AND m.thread_root_id IS NULL) THEN
    RAISE EXCEPTION 'chat_set_typing: the thread root must be a top-level message of this channel'
      USING ERRCODE = '22023';
  END IF;
  -- 157: typing where one could not post is refused the same way.
  PERFORM public.chat_assert_post_rules(v_ch, p_thread_root);

  INSERT INTO public.chat_typing AS t (channel_id, account_id, user_id, thread_root_id, at)
  VALUES (p_channel, v_ch.account_id, v_uid, p_thread_root, now())
  ON CONFLICT (channel_id, user_id) DO UPDATE
     SET account_id = EXCLUDED.account_id, thread_root_id = EXCLUDED.thread_root_id, at = EXCLUDED.at
   WHERE t.at < now() - interval '2 seconds'
      OR t.thread_root_id IS DISTINCT FROM EXCLUDED.thread_root_id;
END $$;

-- chat_share_call (103_chat_call_cards.sql): share_cards and the posting rule.
CREATE OR REPLACE FUNCTION public.chat_share_call(p_channel uuid, p_call uuid, p_body text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_ch   public.chat_channels;
  v_call public.calls;
  v_id   uuid;
BEGIN
  -- 087's write gate, without the team autojoin (chat_post_message
  -- joins below, once every check here has passed).
  v_ch := public.chat_assert_can_write(p_channel, false);

  SELECT * INTO v_call FROM public.calls WHERE id = p_call;
  IF NOT FOUND
     OR v_call.account_id IS DISTINCT FROM v_ch.account_id
     OR NOT public.pbx_can_view_call(v_call)
     OR v_call.erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'chat_share_call: you cannot share this call' USING ERRCODE = '42501';
  END IF;
  IF v_ch.kind <> 'deal_room'
     AND EXISTS (SELECT 1 FROM public.chat_channel_members cm
                  WHERE cm.channel_id = p_channel
                    AND (cm.role = 'guest'
                         OR public.chat_user_role(v_ch.account_id, cm.user_id) = 'bank_guest')) THEN
    RAISE EXCEPTION 'chat_share_call: a call cannot be shared into a channel with a bank guest'
      USING ERRCODE = '42501';
  END IF;
  -- 157: share_cards and the posting rule (chat_post_message below
  -- checks the rule again, and @channel in p_body).
  PERFORM public.chat_assert_permission(v_ch.account_id, 'share_cards');
  PERFORM public.chat_assert_post_rules(v_ch, NULL);

  v_id := public.chat_post_message(p_channel, p_body, NULL, NULL, '[]'::jsonb);
  INSERT INTO public.shared_calls (message_id, call_id, account_id, shared_by)
  VALUES (v_id, p_call, v_ch.account_id, auth.uid());
  RETURN v_id;
END $$;

-- chat_set_pin (087_internal_chat.sql): pin_messages, for pinning and unpinning.
CREATE OR REPLACE FUNCTION public.chat_set_pin(p_message uuid, p_pinned boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_msg public.internal_messages;
BEGIN
  SELECT * INTO v_msg FROM public.internal_messages WHERE id = p_message;
  IF NOT FOUND OR NOT public.chat_can_read_channel(v_msg.channel_id) THEN
    RAISE EXCEPTION 'chat_set_pin: message not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.chat_assert_can_write(v_msg.channel_id, true);
  PERFORM public.chat_assert_permission(v_msg.account_id, 'pin_messages');  -- 157: pin and unpin
  PERFORM 1 FROM public.chat_channels WHERE id = v_msg.channel_id FOR UPDATE;  -- serialise the 100 cap
  IF p_pinned THEN
    IF (SELECT count(*) FROM public.message_pins WHERE channel_id = v_msg.channel_id) >= 100 THEN
      RAISE EXCEPTION 'chat_set_pin: a channel can have at most 100 pins' USING ERRCODE = '23514';
    END IF;
    INSERT INTO public.message_pins (channel_id, message_id, pinned_by)
    VALUES (v_msg.channel_id, p_message, auth.uid()) ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM public.message_pins WHERE channel_id = v_msg.channel_id AND message_id = p_message;
  END IF;
END $$;

-- chat_add_members (087_internal_chat.sql): add_members.
CREATE OR REPLACE FUNCTION public.chat_add_members(p_channel uuid, p_user_ids uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_ch    public.chat_channels;
  v_role  text;
  v_users uuid[];
  v_added uuid[];
  v_guest boolean;
  v_my_cm text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'chat_add_members: no authenticated user' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_ch FROM public.chat_channels WHERE id = p_channel;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat_add_members: channel not found' USING ERRCODE = 'P0002';
  END IF;
  v_role := public.chat_ws_role(v_ch.account_id);
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'chat_add_members: not a member of this workspace' USING ERRCODE = '42501';
  END IF;
  IF v_ch.kind = 'dm' THEN
    RAISE EXCEPTION 'chat_add_members: members cannot be added to a DM (open a new DM instead)' USING ERRCODE = '22023';
  END IF;
  IF v_ch.kind = 'deal_room' THEN
    RAISE EXCEPTION 'chat_add_members: deal room members are managed from the deal' USING ERRCODE = '22023';
  END IF;
  IF NOT (SELECT a.internal_chat_enabled FROM public.accounts a WHERE a.id = v_ch.account_id) THEN
    RAISE EXCEPTION 'chat_add_members: internal chat is disabled for this workspace' USING ERRCODE = 'CH001';
  END IF;
  IF v_ch.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'chat_add_members: channel is archived' USING ERRCODE = '42501';
  END IF;
  IF v_role = 'bank_guest' THEN
    RAISE EXCEPTION 'chat_add_members: bank guests cannot add members' USING ERRCODE = '42501';
  END IF;
  PERFORM public.chat_assert_permission(v_ch.account_id, 'add_members');  -- 157

  SELECT array_agg(DISTINCT u ORDER BY u) INTO v_users FROM unnest(coalesce(p_user_ids, '{}')) u WHERE u IS NOT NULL;
  IF v_users IS NULL THEN
    RAISE EXCEPTION 'chat_add_members: no users given' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_users) u WHERE public.chat_user_role(v_ch.account_id, u) IS NULL) THEN
    RAISE EXCEPTION 'chat_add_members: every user must be an active member of this workspace' USING ERRCODE = '42501';
  END IF;
  v_guest := EXISTS (SELECT 1 FROM unnest(v_users) u WHERE public.chat_user_role(v_ch.account_id, u) = 'bank_guest');

  IF v_ch.kind = 'team' THEN
    IF v_guest THEN
      RAISE EXCEPTION 'chat_add_members: bank guests cannot be added to team channels' USING ERRCODE = '42501';
    END IF;
  ELSE
    SELECT cm.role INTO v_my_cm FROM public.chat_channel_members cm WHERE cm.channel_id = p_channel AND cm.user_id = v_uid;
    IF v_my_cm IS NULL THEN
      RAISE EXCEPTION 'chat_add_members: only members of a private channel can add to it (owner/admin: use chat_admin_read_private to read it)'
        USING ERRCODE = '42501';
    END IF;
    IF v_my_cm <> 'admin'
       AND EXISTS (SELECT 1 FROM unnest(v_users) u WHERE public.chat_user_role(v_ch.account_id, u) <> 'bank_guest') THEN
      RAISE EXCEPTION 'chat_add_members: only channel admins can add members to a private channel' USING ERRCODE = '42501';
    END IF;
    IF v_guest AND v_role NOT IN ('owner','admin','supervisor') THEN
      RAISE EXCEPTION 'chat_add_members: only owner/admin/supervisor can add bank guests' USING ERRCODE = '42501';
    END IF;
  END IF;

  WITH ins AS (
    INSERT INTO public.chat_channel_members (channel_id, user_id, role)
    SELECT p_channel, u, CASE public.chat_user_role(v_ch.account_id, u) WHEN 'bank_guest' THEN 'guest' ELSE 'member' END
      FROM unnest(v_users) u
    ON CONFLICT DO NOTHING
    RETURNING user_id)
  SELECT coalesce(array_agg(user_id ORDER BY user_id), '{}') INTO v_added FROM ins;

  INSERT INTO public.chat_audit_log (account_id, actor_id, action, channel_id, detail)
  VALUES (v_ch.account_id, v_uid, 'add_members', p_channel,
          jsonb_build_object('user_ids', to_jsonb(v_added), 'requested', cardinality(v_users)));
  RETURN cardinality(v_added);
END $$;

-- chat_edit_message (087_internal_chat.sql): edit_own and the edit window.
CREATE OR REPLACE FUNCTION public.chat_edit_message(p_message uuid, p_body text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_msg public.internal_messages;
BEGIN
  SELECT * INTO v_msg FROM public.internal_messages WHERE id = p_message FOR UPDATE;
  IF NOT FOUND OR NOT public.chat_can_read_channel(v_msg.channel_id) THEN
    RAISE EXCEPTION 'chat_edit_message: message not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_msg.author_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'chat_edit_message: only the author can edit' USING ERRCODE = '42501';
  END IF;
  IF v_msg.deleted_at IS NOT NULL OR v_msg.erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'chat_edit_message: message was deleted' USING ERRCODE = '42501';
  END IF;
  PERFORM public.chat_assert_can_write(v_msg.channel_id, false);
  -- 157: only the author edits, so edit_own and the edit window always apply.
  PERFORM public.chat_assert_permission(v_msg.account_id, 'edit_own');
  PERFORM public.chat_assert_window(v_msg, 'edit');
  UPDATE public.internal_messages SET body = p_body WHERE id = p_message;
  -- The bell rows keep a copy of the body: rebuild it from the new text,
  -- or a recipient keeps reading what was edited away (the edit history
  -- is owner/admin only).
  UPDATE public.notifications
     SET body = public.chat_bell_body(p_body, v_msg.account_id)
   WHERE account_id = v_msg.account_id
     AND type IN ('chat_mention','chat_dm','chat_thread_reply','chat_broadcast')
     AND meta->>'message_id' = p_message::text;
END $$;

-- chat_delete_message (087_internal_chat.sql): delete_own and the delete window for the author's own message.
CREATE OR REPLACE FUNCTION public.chat_delete_message(p_message uuid)
RETURNS text[] LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_msg   public.internal_messages;
  v_paths text[];
BEGIN
  SELECT * INTO v_msg FROM public.internal_messages WHERE id = p_message FOR UPDATE;
  IF NOT FOUND OR NOT public.chat_can_read_channel(v_msg.channel_id) THEN
    RAISE EXCEPTION 'chat_delete_message: message not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_msg.author_id IS DISTINCT FROM auth.uid()
     AND coalesce(public.chat_ws_role(v_msg.account_id), '') NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'chat_delete_message: only the author or a workspace owner/admin can delete' USING ERRCODE = '42501';
  END IF;
  IF v_msg.deleted_at IS NOT NULL THEN
    RETURN '{}';
  END IF;
  -- 157: an author deleting their own message needs delete_own and the
  -- delete window; an owner / admin deleting someone else's is unchanged.
  IF auth.uid() IS NOT NULL AND v_msg.author_id = auth.uid() THEN
    PERFORM public.chat_assert_permission(v_msg.account_id, 'delete_own');
    PERFORM public.chat_assert_window(v_msg, 'delete');
  END IF;
  UPDATE public.internal_messages SET body = '', deleted_at = now() WHERE id = p_message;
  WITH d AS (DELETE FROM public.message_attachments WHERE message_id = p_message RETURNING storage_path)
  SELECT coalesce(array_agg(storage_path ORDER BY storage_path), '{}') INTO v_paths FROM d;
  DELETE FROM public.shared_conversations WHERE message_id = p_message;
  DELETE FROM public.message_mentions WHERE message_id = p_message;
  DELETE FROM public.message_mentions_broadcast WHERE message_id = p_message;
  DELETE FROM public.notifications
   WHERE account_id = v_msg.account_id
     AND type IN ('chat_mention','chat_dm','chat_thread_reply','chat_broadcast')
     AND meta->>'message_id' = p_message::text;
  RETURN v_paths;
END $$;

-- chat_storage_can_write (087_internal_chat.sql): upload_files or send_voice, and the posting rules.
CREATE OR REPLACE FUNCTION public.chat_storage_can_write(p_name text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_ch  uuid := public.chat_storage_channel(p_name);
  v_row public.chat_channels;
BEGIN
  IF v_ch IS NULL THEN RETURN false; END IF;
  v_row := public.chat_assert_can_write(v_ch, false);
  -- 157: an upload is a file or a voice note, and only someone who may
  -- post in the channel (top level or in a thread) uploads into it.
  IF NOT (public.chat_has_permission(v_row.account_id, auth.uid(), 'upload_files')
          OR public.chat_has_permission(v_row.account_id, auth.uid(), 'send_voice')) THEN
    RETURN false;
  END IF;
  IF NOT (v_row.posting = 'everyone' OR v_row.thread_replies = 'everyone'
          OR public.chat_is_channel_admin(v_row.id, v_row.account_id, auth.uid())) THEN
    RETURN false;
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END $$;
