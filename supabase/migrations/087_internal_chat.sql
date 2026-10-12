-- 087_internal_chat.sql — internal chat (module 014b), database layer
--
-- Slack-style chat between the people of a workspace: team channels,
-- private channels, DMs (2–8 people), one level of threads, mentions,
-- reactions, pins, saved messages, attachments, shared conversation
-- cards and an audited admin read. Internal only: no table here has a
-- WhatsApp column and nothing here can reach a gateway.
--
-- Ported from the tested 014b package. The browser calls the chat_*
-- RPCs directly with the user's session; every one is SECURITY DEFINER
-- and re-checks the caller. RLS is enabled AND forced on every chat
-- table and grants only SELECT, so the RPCs are the only write path.
--
-- Adaptations to this repo:
--  * Workspace = `accounts` row; membership = a NON-deactivated profiles
--    row of that account (any row, not only the active one, so the
--    workspace rail can show every workspace's unread badges).
--    chat_user_role() maps account roles onto the package's vocabulary:
--    owner→owner, admin→admin, team_leader→supervisor, agent→agent,
--    viewer→agent, bank_guest→bank_guest. The package's role logic and
--    decision D-B1 (channel membership is managed by channel admins)
--    are otherwise unchanged. No workspaces / workspace_members /
--    chat_migration_meta tables; accounts.internal_chat_enabled.
--  * Columns are `account_id` (repo convention); RPC parameters keep
--    the package names (p_ws, …) because the client calls them by name.
--  * Table names: `message_reactions` already exists (WhatsApp
--    reactions, 009), and "channel" means a WhatsApp number across this
--    schema (channel_id, set_channel_members), so the package's
--    channels / channel_members / message_reactions are chat_channels /
--    chat_channel_members / internal_message_reactions.
--  * chat_can_view_conversation(id): the conversation is in the caller's
--    ACTIVE account and conversations_select's predicate holds for the
--    caller. Sharing also requires the conversation's account to be the
--    channel's, so the package's pre-014a cross-workspace caveat is gone.
--  * Channel kind `deal_room` (created by a later migration's functions;
--    chat_create_channel refuses it). Its internal messages are the
--    staff-only Team notes: read and posted by non-guest channel
--    members only. A bank guest may be a member (role guest) and sees
--    the channel row and its members, never its internal messages.
--    chat_add_members / chat_set_member_role refuse deal rooms (the
--    deal-room functions own that membership); chat_admin_read_private
--    accepts them (audited).
--  * System posts: internal_messages.author_kind 'system' with a NULL
--    author_id and a jsonb `meta` (cards), written only by
--    chat_post_system_message (service_role). No notifications. Every
--    author comparison is NULL-safe (IS DISTINCT FROM): a plain <> on a
--    NULL author would let anyone edit or delete a system post.
--  * shared_conversations.snapshot: frozen at share time (contact name,
--    masked phone, company, chat tag, owner, last two messages).
--    chat_shared_cards() adds live fields only for a caller who can
--    open the conversation.
--  * Attachments: private bucket `chat-files` (25 MB), objects at
--    account-<ws>/channel-<ch>/<uuid>-<name>; upload needs the right to
--    post in that channel, download the right to read its messages.
--    chat_post_message(p_attachments) checks each object exists.
--  * Bell: each chat_notifications row inserts the matching
--    notifications row (types chat_*, 085's CHECK) with
--    notifications.meta = {channel_id, message_id, thread_root_id}.
--    Deleting a message drops its bell rows; erasure drops the person's
--    and those quoting them.
--  * chat_people(ws) and chat_workspace_badges() for the UI.
--
-- Re-runnable: every statement is guarded or replaces in place.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '087 must be applied by a superuser or BYPASSRLS role (the chat functions own RLS-forced tables)';
  END IF;
END $$;

ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS internal_chat_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ---------- 1. Role and conversation adapters ----------

-- p_user's chat role in account p_ws, from a non-deactivated membership.
CREATE OR REPLACE FUNCTION public.chat_user_role(p_ws uuid, p_user uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE p.account_role::text
           WHEN 'team_leader' THEN 'supervisor'
           WHEN 'viewer'      THEN 'agent'
           ELSE p.account_role::text
         END
    FROM public.profiles p
   WHERE p.account_id = p_ws AND p.user_id = p_user AND p.deactivated_at IS NULL
$$;

CREATE OR REPLACE FUNCTION public.chat_ws_role(ws uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.chat_user_role(ws, auth.uid())
$$;

-- conversations_select's predicate, for the caller, in the ACTIVE account.
CREATE OR REPLACE FUNCTION public.chat_can_view_conversation(p_conversation_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.conversations cv
     WHERE cv.id = p_conversation_id
       AND cv.account_id = public.current_account_id()
       AND (public.current_role_rank() >= 4
            OR public.can_view_conversation(cv.account_id, cv.user_id, cv.assigned_agent_id,
                                            cv.channel_id, cv.send_channel_id)))
$$;

-- Arabic-Indic and Extended Arabic-Indic digits → ASCII (as 013).
CREATE OR REPLACE FUNCTION public.chat_normalize_digits(t text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public, pg_temp AS $$
  SELECT translate(t, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹٬٫', '01234567890123456789,.')
$$;

-- '971501234512' → '+971 XXXXXXX12': the country code (ITU codes are
-- prefix-free: 1 and 7 are one digit, the listed ones two, the rest
-- three) and the last two digits; every other digit is an X.
CREATE OR REPLACE FUNCTION public.chat_mask_phone(p_phone text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  d  text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  cc text;
BEGIN
  IF d = '' THEN RETURN NULL; END IF;
  IF length(d) < 7 THEN RETURN repeat('X', greatest(length(d) - 2, 0)) || right(d, 2); END IF;
  cc := CASE
          WHEN left(d, 1) IN ('1', '7') THEN left(d, 1)
          WHEN left(d, 2) IN ('20','27','30','31','32','33','34','36','39','40','41','43','44','45',
                              '46','47','48','49','51','52','53','54','55','56','57','58','60','61',
                              '62','63','64','65','66','81','82','84','86','90','91','92','93','94',
                              '95','98') THEN left(d, 2)
          ELSE left(d, 3)
        END;
  RETURN '+' || cc || ' ' || repeat('X', length(d) - length(cc) - 2) || right(d, 2);
END $$;

-- The card frozen into shared_conversations.snapshot.
CREATE OR REPLACE FUNCTION public.chat_conversation_snapshot(p_conversation_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
           'contact_name', ct.name,
           'phone', public.chat_mask_phone(ct.phone),
           'company', ct.company,
           'chat_tag', CASE WHEN t.id IS NOT NULL THEN jsonb_build_object('name', t.name, 'color', t.color) END,
           'owner', (SELECT p.full_name FROM public.profiles p
                      WHERE p.user_id = cv.assigned_agent_id AND p.account_id = cv.account_id),
           'last_messages', coalesce((
              SELECT jsonb_agg(jsonb_build_object('sender_type', x.sender_type,
                                                  'content_text', left(x.content_text, 200),
                                                  'created_at', x.created_at)
                               ORDER BY x.created_at, x.id)
                FROM (SELECT m.id, m.sender_type, m.content_text, m.created_at
                        FROM public.messages m WHERE m.conversation_id = cv.id
                       ORDER BY m.created_at DESC, m.id DESC LIMIT 2) x), '[]'::jsonb),
           'taken_at', now())
    FROM public.conversations cv
    JOIN public.contacts ct ON ct.id = cv.contact_id
    LEFT JOIN public.chat_tags t ON t.id = cv.chat_tag_id
   WHERE cv.id = p_conversation_id
$$;

-- '<@uuid>' tokens → '@Full Name' (bell text).
CREATE OR REPLACE FUNCTION public.chat_render_mentions(p_body text, p_ws uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_out text := p_body;
  r     record;
BEGIN
  FOR r IN SELECT DISTINCT t[1] AS id
             FROM regexp_matches(coalesce(p_body, ''),
                    '<@([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})>', 'g') t
  LOOP
    v_out := replace(v_out, '<@' || r.id || '>', '@' || coalesce(
      (SELECT p.full_name FROM public.profiles p WHERE p.user_id = r.id::uuid AND p.account_id = p_ws),
      'someone'));
  END LOOP;
  RETURN v_out;
END $$;

-- ---------- 2. Tables ----------

CREATE TABLE IF NOT EXISTS public.chat_channels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES public.accounts(id),
  kind        text NOT NULL CHECK (kind IN ('team','private','dm','deal_room')),
  name        text CHECK (name IS NULL OR char_length(btrim(name)) BETWEEN 1 AND 80),
  topic       text CHECK (topic IS NULL OR char_length(topic) <= 250),
  dm_key      text,   -- sorted member ids; identifies a DM member set
  created_by  uuid NOT NULL,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_channels_name_by_kind CHECK (
    (kind = 'dm' AND name IS NULL AND dm_key IS NOT NULL)
    OR (kind <> 'dm' AND name IS NOT NULL AND dm_key IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS chat_channels_name_uq
  ON public.chat_channels (account_id, lower(name)) WHERE kind IN ('team','private') AND archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS chat_channels_dm_uq
  ON public.chat_channels (account_id, dm_key) WHERE kind = 'dm';

CREATE TABLE IF NOT EXISTS public.chat_channel_members (
  channel_id   uuid NOT NULL REFERENCES public.chat_channels(id),
  user_id      uuid NOT NULL,
  role         text NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member','guest')),
  joined_at    timestamptz NOT NULL DEFAULT now(),
  last_read_at timestamptz,
  muted        boolean NOT NULL DEFAULT false,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS chat_channel_members_user_idx ON public.chat_channel_members (user_id);

CREATE TABLE IF NOT EXISTS public.internal_messages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id     uuid NOT NULL REFERENCES public.chat_channels(id),
  account_id     uuid NOT NULL REFERENCES public.accounts(id),
  thread_root_id uuid REFERENCES public.internal_messages(id),
  author_kind    text NOT NULL DEFAULT 'user' CHECK (author_kind IN ('user','system')),
  author_id      uuid,
  body           text NOT NULL,
  meta           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(meta) = 'object'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  edited_at      timestamptz,
  deleted_at     timestamptz,
  erased_at      timestamptz,
  search         tsvector GENERATED ALWAYS AS (
                   CASE WHEN deleted_at IS NULL AND erased_at IS NULL
                        THEN to_tsvector('simple'::regconfig, public.chat_normalize_digits(body)) END
                 ) STORED,
  CONSTRAINT internal_messages_body_len CHECK (
    char_length(body) <= 8000 AND (char_length(body) >= 1 OR deleted_at IS NOT NULL)),
  CONSTRAINT internal_messages_not_self_thread CHECK (thread_root_id IS NULL OR thread_root_id <> id),
  CONSTRAINT internal_messages_author_by_kind CHECK ((author_id IS NULL) = (author_kind = 'system'))
);
CREATE INDEX IF NOT EXISTS internal_messages_channel_idx ON public.internal_messages (channel_id, created_at);
CREATE INDEX IF NOT EXISTS internal_messages_thread_idx  ON public.internal_messages (thread_root_id) WHERE thread_root_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS internal_messages_author_idx  ON public.internal_messages (account_id, author_id);
CREATE INDEX IF NOT EXISTS internal_messages_search_idx  ON public.internal_messages USING gin (search);

CREATE TABLE IF NOT EXISTS public.internal_message_edits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    uuid NOT NULL REFERENCES public.internal_messages(id),
  previous_body text NOT NULL,
  edited_at     timestamptz NOT NULL DEFAULT now(),
  edited_by     uuid NOT NULL
);
CREATE INDEX IF NOT EXISTS internal_message_edits_msg_idx ON public.internal_message_edits (message_id);

CREATE TABLE IF NOT EXISTS public.message_mentions (
  message_id uuid NOT NULL REFERENCES public.internal_messages(id),
  user_id    uuid NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS message_mentions_user_idx ON public.message_mentions (user_id);

CREATE TABLE IF NOT EXISTS public.message_mentions_broadcast (
  message_id uuid NOT NULL REFERENCES public.internal_messages(id),
  kind       text NOT NULL CHECK (kind IN ('channel','here')),
  PRIMARY KEY (message_id, kind)
);

CREATE TABLE IF NOT EXISTS public.internal_message_reactions (
  message_id uuid NOT NULL REFERENCES public.internal_messages(id),
  user_id    uuid NOT NULL,
  emoji      text NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS public.message_pins (
  channel_id uuid NOT NULL REFERENCES public.chat_channels(id),
  message_id uuid NOT NULL REFERENCES public.internal_messages(id),
  pinned_by  uuid NOT NULL,
  pinned_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, message_id)
);

CREATE TABLE IF NOT EXISTS public.saved_messages (
  user_id    uuid NOT NULL,
  message_id uuid NOT NULL REFERENCES public.internal_messages(id),
  saved_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, message_id)
);

CREATE TABLE IF NOT EXISTS public.message_attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id   uuid NOT NULL REFERENCES public.internal_messages(id),
  storage_path text NOT NULL,
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
  mime         text NOT NULL,
  bytes        bigint NOT NULL CHECK (bytes BETWEEN 0 AND 26214400),
  scanned      boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS message_attachments_msg_idx ON public.message_attachments (message_id);

-- conversation_id has no FK on purpose: the snapshot outlives the chat.
CREATE TABLE IF NOT EXISTS public.shared_conversations (
  message_id      uuid NOT NULL REFERENCES public.internal_messages(id),
  conversation_id uuid NOT NULL,
  shared_by       uuid NOT NULL,
  snapshot        jsonb NOT NULL,
  snapshot_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, conversation_id)
);

CREATE TABLE IF NOT EXISTS public.chat_notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES public.accounts(id),
  message_id uuid NOT NULL REFERENCES public.internal_messages(id),
  kind       text NOT NULL CHECK (kind IN ('mention','dm','thread_reply','broadcast')),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz,
  UNIQUE (user_id, message_id)
);
CREATE INDEX IF NOT EXISTS chat_notifications_user_idx ON public.chat_notifications (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.chat_audit_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id),
  actor_id   uuid NOT NULL,
  action     text NOT NULL CHECK (action IN ('admin_read_private','erase_person','add_members','set_member_role')),
  channel_id uuid REFERENCES public.chat_channels(id),
  at         timestamptz NOT NULL DEFAULT now(),
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS chat_audit_log_account_idx ON public.chat_audit_log (account_id, at DESC);

-- ---------- 3. Integrity triggers ----------

-- Pins account_id to the channel's; one level of threading, same channel.
CREATE OR REPLACE FUNCTION public.chat_message_before_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_root public.internal_messages;
BEGIN
  SELECT c.account_id INTO NEW.account_id FROM public.chat_channels c WHERE c.id = NEW.channel_id;
  IF NEW.thread_root_id IS NOT NULL THEN
    SELECT * INTO v_root FROM public.internal_messages WHERE id = NEW.thread_root_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'thread root % not found', NEW.thread_root_id USING ERRCODE = 'P0002';
    END IF;
    IF v_root.channel_id <> NEW.channel_id THEN
      RAISE EXCEPTION 'thread reply must be in the same channel as its root' USING ERRCODE = '23514';
    END IF;
    IF v_root.thread_root_id IS NOT NULL THEN
      RAISE EXCEPTION 'cannot reply to a thread reply (one level of threading)' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS internal_messages_before_insert ON public.internal_messages;
CREATE TRIGGER internal_messages_before_insert BEFORE INSERT ON public.internal_messages
  FOR EACH ROW EXECUTE FUNCTION public.chat_message_before_insert();

-- Every body change (edit or soft delete) keeps the previous body;
-- erasure (erased_at set) writes none. Structural columns are immutable.
CREATE OR REPLACE FUNCTION public.chat_message_before_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.channel_id <> OLD.channel_id OR NEW.account_id <> OLD.account_id
     OR NEW.author_id IS DISTINCT FROM OLD.author_id OR NEW.author_kind <> OLD.author_kind
     OR NEW.created_at <> OLD.created_at
     OR NEW.thread_root_id IS DISTINCT FROM OLD.thread_root_id THEN
    RAISE EXCEPTION 'internal_messages: structural columns are immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.body IS DISTINCT FROM OLD.body AND NEW.erased_at IS NULL THEN
    INSERT INTO public.internal_message_edits (message_id, previous_body, edited_at, edited_by)
    VALUES (OLD.id, OLD.body, now(), coalesce(auth.uid(), OLD.author_id));
    IF NEW.deleted_at IS NULL THEN
      NEW.edited_at := now();
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS internal_messages_before_update ON public.internal_messages;
CREATE TRIGGER internal_messages_before_update BEFORE UPDATE ON public.internal_messages
  FOR EACH ROW EXECUTE FUNCTION public.chat_message_before_update();

-- Append-only. The one exception: DELETE on internal_message_edits from
-- inside chat_erase_person (table owner with chat.erase = on). The GUC
-- alone is not enough: a client can set it, but is not the owner.
CREATE OR REPLACE FUNCTION public.chat_append_only_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'internal_message_edits'
     AND current_setting('chat.erase', true) = 'on'
     AND current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only (% blocked)', TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
END $$;
DROP TRIGGER IF EXISTS internal_message_edits_append_only ON public.internal_message_edits;
CREATE TRIGGER internal_message_edits_append_only BEFORE UPDATE OR DELETE ON public.internal_message_edits
  FOR EACH ROW EXECUTE FUNCTION public.chat_append_only_guard();
DROP TRIGGER IF EXISTS chat_audit_log_append_only ON public.chat_audit_log;
CREATE TRIGGER chat_audit_log_append_only BEFORE UPDATE OR DELETE ON public.chat_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.chat_append_only_guard();

-- TRUNCATE bypasses RLS and row triggers: blocked on every chat table.
CREATE OR REPLACE FUNCTION public.chat_block_truncate()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% cannot be truncated', TG_TABLE_NAME USING ERRCODE = '42501';
END $$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['chat_channels','chat_channel_members','internal_messages','internal_message_edits',
    'message_mentions','message_mentions_broadcast','internal_message_reactions','message_pins','saved_messages',
    'message_attachments','shared_conversations','chat_notifications','chat_audit_log']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.chat_block_truncate()',
                   t || '_no_truncate', t);
  END LOOP;
END $$;

-- ---------- 4. Access helpers ----------

-- Can p_user read channel p_channel? p_messages = true asks about its
-- messages (and everything hanging off them); false about the channel
-- row and member list. The two differ only for a guest in a deal room.
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
                             WHERE cm.channel_id = c.id AND cm.user_id = p_user))))
$$;

CREATE OR REPLACE FUNCTION public.chat_can_see_channel(p_channel uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT auth.uid() IS NOT NULL AND public.chat_user_can_read_channel(p_channel, auth.uid(), false)
$$;

CREATE OR REPLACE FUNCTION public.chat_can_read_channel(p_channel uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT auth.uid() IS NOT NULL AND public.chat_user_can_read_channel(p_channel, auth.uid(), true)
$$;

CREATE OR REPLACE FUNCTION public.chat_can_read_message(p_message uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.internal_messages m
                  WHERE m.id = p_message AND public.chat_can_read_channel(m.channel_id))
$$;

-- Write gate of the posting-type functions. Returns the channel; with
-- p_autojoin a non-guest posting in a team channel becomes a member.
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
  RETURN v_ch;
END $$;

-- ---------- 5. API functions ----------

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

-- p_attachments: up to 10 {storage_path, name, mime, bytes}, each an
-- object already uploaded to chat-files under this channel's prefix.
CREATE OR REPLACE FUNCTION public.chat_post_message(
  p_channel uuid, p_body text, p_thread_root uuid DEFAULT NULL, p_share_conversation uuid DEFAULT NULL,
  p_attachments jsonb DEFAULT '[]'::jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_ch        public.chat_channels;
  v_id        uuid;
  v_broadcast boolean := false;
  v_atts      jsonb := coalesce(p_attachments, '[]'::jsonb);
  v_att       jsonb;
  v_prefix    text;
BEGIN
  v_ch := public.chat_assert_can_write(p_channel, true);

  IF p_share_conversation IS NOT NULL
     AND (NOT public.chat_can_view_conversation(p_share_conversation)
          OR NOT EXISTS (SELECT 1 FROM public.conversations cv
                          WHERE cv.id = p_share_conversation AND cv.account_id = v_ch.account_id)) THEN
    RAISE EXCEPTION 'chat_post_message: you cannot share this conversation' USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(v_atts) <> 'array' OR jsonb_array_length(v_atts) > 10 THEN
    RAISE EXCEPTION 'chat_post_message: attachments must be an array of at most 10 items' USING ERRCODE = '22023';
  END IF;
  v_prefix := 'account-' || v_ch.account_id || '/channel-' || v_ch.id || '/';
  FOR v_att IN SELECT * FROM jsonb_array_elements(v_atts) LOOP
    IF jsonb_typeof(v_att) <> 'object'
       OR jsonb_typeof(v_att->'storage_path') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_att->'name') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_att->'mime') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_att->'bytes') IS DISTINCT FROM 'number'
       OR char_length(btrim(v_att->>'name')) NOT BETWEEN 1 AND 255
       OR btrim(v_att->>'mime') = ''
       OR (v_att->>'bytes')::numeric NOT BETWEEN 0 AND 26214400
       OR (v_att->>'bytes')::numeric <> trunc((v_att->>'bytes')::numeric) THEN
      RAISE EXCEPTION 'chat_post_message: each attachment needs storage_path, name, mime and bytes (at most 25 MB)'
        USING ERRCODE = '22023';
    END IF;
    IF left(v_att->>'storage_path', length(v_prefix)) <> v_prefix
       OR substr(v_att->>'storage_path', length(v_prefix) + 1)
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[^/]+$' THEN
      RAISE EXCEPTION 'chat_post_message: attachment path must be %<uuid>-<name>', v_prefix USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM storage.objects o
                    WHERE o.bucket_id = 'chat-files' AND o.name = v_att->>'storage_path') THEN
      RAISE EXCEPTION 'chat_post_message: attachment % was not uploaded', v_att->>'storage_path' USING ERRCODE = 'P0002';
    END IF;
  END LOOP;

  INSERT INTO public.internal_messages (channel_id, account_id, thread_root_id, author_kind, author_id, body)
  VALUES (p_channel, v_ch.account_id, p_thread_root, 'user', v_uid, p_body)
  RETURNING id INTO v_id;

  INSERT INTO public.message_attachments (message_id, storage_path, name, mime, bytes)
  SELECT v_id, a->>'storage_path', btrim(a->>'name'), btrim(a->>'mime'), (a->>'bytes')::bigint
    FROM jsonb_array_elements(v_atts) a;

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

-- Automations, the journey bot and the phone system post as
-- "wacrm · automation": no author, no mentions, no notifications.
CREATE OR REPLACE FUNCTION public.chat_post_system_message(p_channel uuid, p_body text, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_ch public.chat_channels;
  v_id uuid;
BEGIN
  SELECT * INTO v_ch FROM public.chat_channels WHERE id = p_channel;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat_post_system_message: channel not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT (SELECT a.internal_chat_enabled FROM public.accounts a WHERE a.id = v_ch.account_id) THEN
    RAISE EXCEPTION 'chat_post_system_message: internal chat is disabled for this workspace' USING ERRCODE = 'CH001';
  END IF;
  IF v_ch.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'chat_post_system_message: channel is archived' USING ERRCODE = '42501';
  END IF;
  IF p_meta IS NULL OR jsonb_typeof(p_meta) <> 'object' THEN
    RAISE EXCEPTION 'chat_post_system_message: meta must be a JSON object' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.internal_messages (channel_id, account_id, author_kind, author_id, body, meta)
  VALUES (p_channel, v_ch.account_id, 'system', NULL, p_body, p_meta)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

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
  UPDATE public.internal_messages SET body = p_body WHERE id = p_message;
END $$;

-- Soft delete. Also removes the message's mentions, shared cards, bell
-- rows and attachment metadata; returns the storage paths to delete.
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

CREATE OR REPLACE FUNCTION public.chat_mark_read(p_channel uuid, p_at timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_at timestamptz := least(coalesce(p_at, now()), now());
BEGIN
  UPDATE public.chat_channel_members SET last_read_at = v_at
   WHERE channel_id = p_channel AND user_id = auth.uid() AND public.chat_can_read_channel(p_channel);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat_mark_read: not a member of this channel' USING ERRCODE = '42501';
  END IF;
  UPDATE public.chat_notifications n SET read_at = now()
    FROM public.internal_messages m
   WHERE n.message_id = m.id AND m.channel_id = p_channel
     AND n.user_id = auth.uid() AND n.read_at IS NULL AND m.created_at <= v_at;
END $$;

-- Per channel: unread top-level messages and unread mentions (thread
-- replies count for mentions only). Own and deleted messages excluded.
CREATE OR REPLACE FUNCTION public.chat_unread_counts(p_ws uuid)
RETURNS TABLE (channel_id uuid, unread integer, mentions integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id,
    (SELECT count(*) FROM public.internal_messages m
      WHERE m.channel_id = c.id AND m.thread_root_id IS NULL
        AND m.author_id IS DISTINCT FROM auth.uid() AND m.deleted_at IS NULL AND m.erased_at IS NULL
        AND m.created_at > greatest(cm.last_read_at, cm.joined_at))::integer,
    (SELECT count(*) FROM public.internal_messages m
       JOIN public.message_mentions mm ON mm.message_id = m.id AND mm.user_id = auth.uid()
      WHERE m.channel_id = c.id
        AND m.author_id IS DISTINCT FROM auth.uid() AND m.deleted_at IS NULL AND m.erased_at IS NULL
        AND m.created_at > greatest(cm.last_read_at, cm.joined_at))::integer
    FROM public.chat_channel_members cm
    JOIN public.chat_channels c ON c.id = cm.channel_id
   WHERE cm.user_id = auth.uid() AND c.account_id = p_ws AND c.archived_at IS NULL
     AND public.chat_user_can_read_channel(c.id, auth.uid(), true)
   ORDER BY c.created_at, c.id
$$;

-- The workspace rail: totals for every workspace the caller belongs to.
CREATE OR REPLACE FUNCTION public.chat_workspace_badges()
RETURNS TABLE (account_id uuid, unread integer, mentions integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.account_id, coalesce(sum(u.unread), 0)::integer, coalesce(sum(u.mentions), 0)::integer
    FROM public.profiles p
    LEFT JOIN LATERAL public.chat_unread_counts(p.account_id) u ON true
   WHERE p.user_id = auth.uid() AND p.deactivated_at IS NULL
   GROUP BY p.account_id
   ORDER BY p.account_id
$$;

CREATE OR REPLACE FUNCTION public.chat_search(p_ws uuid, p_q text, p_limit integer DEFAULT 50)
RETURNS TABLE (message_id uuid, channel_id uuid, thread_root_id uuid, author_id uuid,
               body text, created_at timestamptz, rank real)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.id, m.channel_id, m.thread_root_id, m.author_id, m.body, m.created_at, ts_rank(m.search, q)
    FROM public.internal_messages m,
         websearch_to_tsquery('simple'::regconfig, public.chat_normalize_digits(coalesce(p_q, ''))) q
   WHERE m.account_id = p_ws
     AND m.search @@ q
     AND public.chat_user_can_read_channel(m.channel_id, auth.uid(), true)
   ORDER BY 7 DESC, m.created_at DESC
   LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
$$;

CREATE OR REPLACE FUNCTION public.chat_toggle_reaction(p_message uuid, p_emoji text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_msg public.internal_messages;
BEGIN
  SELECT * INTO v_msg FROM public.internal_messages WHERE id = p_message;
  IF NOT FOUND OR NOT public.chat_can_read_channel(v_msg.channel_id) THEN
    RAISE EXCEPTION 'chat_toggle_reaction: message not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.chat_assert_can_write(v_msg.channel_id, true);
  DELETE FROM public.internal_message_reactions WHERE message_id = p_message AND user_id = auth.uid() AND emoji = p_emoji;
  IF FOUND THEN RETURN false; END IF;
  INSERT INTO public.internal_message_reactions (message_id, user_id, emoji) VALUES (p_message, auth.uid(), p_emoji);
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.chat_set_pin(p_message uuid, p_pinned boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_msg public.internal_messages;
BEGIN
  SELECT * INTO v_msg FROM public.internal_messages WHERE id = p_message;
  IF NOT FOUND OR NOT public.chat_can_read_channel(v_msg.channel_id) THEN
    RAISE EXCEPTION 'chat_set_pin: message not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.chat_assert_can_write(v_msg.channel_id, true);
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

CREATE OR REPLACE FUNCTION public.chat_set_saved(p_message uuid, p_saved boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.chat_can_read_message(p_message) THEN
    RAISE EXCEPTION 'chat_set_saved: message not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_saved THEN
    INSERT INTO public.saved_messages (user_id, message_id) VALUES (auth.uid(), p_message) ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM public.saved_messages WHERE user_id = auth.uid() AND message_id = p_message;
  END IF;
END $$;

-- Shared cards of messages the caller can read: the frozen snapshot for
-- everyone, live fields and can_open only for a caller who may open the
-- conversation itself.
CREATE OR REPLACE FUNCTION public.chat_shared_cards(p_message_ids uuid[])
RETURNS TABLE (message_id uuid, conversation_id uuid, snapshot jsonb, can_open boolean,
               chat_tag jsonb, status text, last_message_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.message_id, s.conversation_id, s.snapshot, v.ok,
         CASE WHEN v.ok AND t.id IS NOT NULL THEN jsonb_build_object('name', t.name, 'color', t.color) END,
         CASE WHEN v.ok THEN cv.status END,
         CASE WHEN v.ok THEN cv.last_message_at END
    FROM public.shared_conversations s
    JOIN public.internal_messages m ON m.id = s.message_id
    CROSS JOIN LATERAL (SELECT public.chat_can_view_conversation(s.conversation_id) AS ok) v
    LEFT JOIN public.conversations cv ON cv.id = s.conversation_id
    LEFT JOIN public.chat_tags t ON t.id = cv.chat_tag_id
   WHERE s.message_id = ANY (coalesce(p_message_ids, '{}'))
     AND public.chat_user_can_read_channel(m.channel_id, auth.uid(), true)
   ORDER BY m.created_at, s.message_id
$$;

-- The people picker: staff see every non-deactivated member of the
-- workspace; a guest sees only the people of channels they belong to.
CREATE OR REPLACE FUNCTION public.chat_people(p_ws uuid)
RETURNS TABLE (user_id uuid, full_name text, avatar_url text, role text, bank_code text,
               presence_status text, last_seen_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.user_id, p.full_name, p.avatar_url, p.account_role::text, p.bank_code, mp.status, mp.last_seen_at
    FROM (SELECT public.chat_ws_role(p_ws) AS role) me
    JOIN public.profiles p ON p.account_id = p_ws AND p.deactivated_at IS NULL
    LEFT JOIN public.member_presence mp ON mp.user_id = p.user_id AND mp.account_id = p.account_id
   WHERE me.role IS NOT NULL
     AND (me.role <> 'bank_guest'
          OR EXISTS (SELECT 1 FROM public.chat_channel_members mine
                       JOIN public.chat_channels c ON c.id = mine.channel_id AND c.account_id = p_ws
                       JOIN public.chat_channel_members theirs ON theirs.channel_id = mine.channel_id
                      WHERE mine.user_id = auth.uid() AND theirs.user_id = p.user_id))
   ORDER BY p.full_name, p.user_id
$$;

-- Add members to a team or private channel (DMs are fixed sets; deal
-- rooms belong to the deal-room functions). D-B1: team channels — any
-- non-guest member may add non-guests; private — the caller must be a
-- channel member, channel admins add non-guests, and bank guests are
-- added by a member who is owner/admin/supervisor. Returns the count added.
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

-- Leave a channel. The last member of a DM and the last (non-guest)
-- admin of a private channel or deal room cannot leave.
CREATE OR REPLACE FUNCTION public.chat_leave_channel(p_channel uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_ch  public.chat_channels;
  v_me  public.chat_channel_members;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'chat_leave_channel: no authenticated user' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_ch FROM public.chat_channels WHERE id = p_channel FOR UPDATE;  -- serialise the last-member checks
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat_leave_channel: channel not found' USING ERRCODE = 'P0002';
  END IF;
  IF public.chat_ws_role(v_ch.account_id) IS NULL THEN
    RAISE EXCEPTION 'chat_leave_channel: not a member of this workspace' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_me FROM public.chat_channel_members WHERE channel_id = p_channel AND user_id = v_uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat_leave_channel: not a member of this channel' USING ERRCODE = '42501';
  END IF;
  IF v_ch.kind = 'dm'
     AND NOT EXISTS (SELECT 1 FROM public.chat_channel_members WHERE channel_id = p_channel AND user_id <> v_uid) THEN
    RAISE EXCEPTION 'chat_leave_channel: the last member cannot leave a DM' USING ERRCODE = '22023';
  END IF;
  IF v_ch.kind IN ('private','deal_room') AND v_me.role = 'admin'
     AND NOT EXISTS (SELECT 1 FROM public.chat_channel_members cm2
                      WHERE cm2.channel_id = p_channel AND cm2.user_id <> v_uid AND cm2.role = 'admin'
                        AND coalesce(public.chat_user_role(v_ch.account_id, cm2.user_id), 'bank_guest') <> 'bank_guest') THEN
    RAISE EXCEPTION 'chat_leave_channel: the last admin of a private channel cannot leave' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.chat_channel_members WHERE channel_id = p_channel AND user_id = v_uid;
END $$;

-- Owner/admin read of a private channel, DM or deal room; audited first.
CREATE OR REPLACE FUNCTION public.chat_admin_read_private(p_channel uuid, p_reason text)
RETURNS SETOF public.internal_messages LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_ch public.chat_channels;
BEGIN
  SELECT * INTO v_ch FROM public.chat_channels WHERE id = p_channel;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat_admin_read_private: channel not found' USING ERRCODE = 'P0002';
  END IF;
  IF auth.uid() IS NULL OR coalesce(public.chat_ws_role(v_ch.account_id), '') NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'chat_admin_read_private: owner or admin role required' USING ERRCODE = '42501';
  END IF;
  IF v_ch.kind NOT IN ('private','dm','deal_room') THEN
    RAISE EXCEPTION 'chat_admin_read_private: only private channels, DMs and deal rooms' USING ERRCODE = '22023';
  END IF;
  IF char_length(btrim(coalesce(p_reason, ''))) < 5 THEN
    RAISE EXCEPTION 'chat_admin_read_private: a reason of at least 5 characters is required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.chat_audit_log (account_id, actor_id, action, channel_id, detail)
  VALUES (v_ch.account_id, auth.uid(), 'admin_read_private', p_channel, jsonb_build_object('reason', btrim(p_reason)));
  RETURN QUERY SELECT * FROM public.internal_messages WHERE channel_id = p_channel ORDER BY created_at, id;
END $$;

-- Lawful erasure of one person's chat data in one workspace (owner
-- only), the only path that deletes edit history. Returns the storage
-- paths of the removed attachments for the caller to delete.
CREATE OR REPLACE FUNCTION public.chat_erase_person(p_ws uuid, p_user_id uuid, p_reason text)
RETURNS text[] LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_paths text[];
  v_msgs  integer;
BEGIN
  IF auth.uid() IS NULL OR coalesce(public.chat_ws_role(p_ws), '') <> 'owner' THEN
    RAISE EXCEPTION 'chat_erase_person: workspace owner role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR char_length(btrim(coalesce(p_reason, ''))) < 5 THEN
    RAISE EXCEPTION 'chat_erase_person: user and a reason of at least 5 characters are required' USING ERRCODE = '22023';
  END IF;

  -- Bodies FIRST: the UPDATE waits for an in-flight edit and holds the
  -- rows to commit, so no edit slips in after it; the history DELETE
  -- below then sees every history row committed before.
  UPDATE public.internal_messages m SET body = '[erased]', erased_at = now()
   WHERE m.account_id = p_ws AND m.author_id = p_user_id AND m.erased_at IS NULL;
  GET DIAGNOSTICS v_msgs = ROW_COUNT;

  SELECT coalesce(array_agg(a.storage_path ORDER BY a.storage_path), '{}') INTO v_paths
    FROM public.message_attachments a JOIN public.internal_messages m ON m.id = a.message_id
   WHERE m.account_id = p_ws AND m.author_id = p_user_id;
  DELETE FROM public.message_attachments a USING public.internal_messages m
   WHERE a.message_id = m.id AND m.account_id = p_ws AND m.author_id = p_user_id;
  DELETE FROM public.shared_conversations s USING public.internal_messages m
   WHERE s.message_id = m.id AND m.account_id = p_ws AND m.author_id = p_user_id;

  PERFORM set_config('chat.erase', 'on', true);
  DELETE FROM public.internal_message_edits x USING public.internal_messages m
   WHERE x.message_id = m.id AND m.account_id = p_ws AND m.author_id = p_user_id;
  PERFORM set_config('chat.erase', 'off', true);

  DELETE FROM public.message_mentions mm USING public.internal_messages m
   WHERE mm.message_id = m.id AND m.account_id = p_ws AND (mm.user_id = p_user_id OR m.author_id = p_user_id);
  DELETE FROM public.message_mentions_broadcast b USING public.internal_messages m
   WHERE b.message_id = m.id AND m.account_id = p_ws AND m.author_id = p_user_id;
  DELETE FROM public.internal_message_reactions r USING public.internal_messages m
   WHERE r.message_id = m.id AND m.account_id = p_ws AND r.user_id = p_user_id;
  DELETE FROM public.saved_messages s USING public.internal_messages m
   WHERE s.message_id = m.id AND m.account_id = p_ws AND s.user_id = p_user_id;
  DELETE FROM public.chat_notifications WHERE account_id = p_ws AND user_id = p_user_id;
  -- bell rows: the person's own, and everyone's that quote the person
  DELETE FROM public.notifications
   WHERE account_id = p_ws
     AND type IN ('chat_mention','chat_dm','chat_thread_reply','chat_broadcast')
     AND (user_id = p_user_id OR actor_user_id = p_user_id);

  INSERT INTO public.chat_audit_log (account_id, actor_id, action, detail)
  VALUES (p_ws, auth.uid(), 'erase_person',
          jsonb_build_object('user_id', p_user_id, 'reason', btrim(p_reason),
                             'messages', v_msgs, 'attachments', cardinality(v_paths)));
  RETURN v_paths;
END $$;

-- Promote/demote a member of a team or private channel. Team: channel
-- admins and workspace owner/admin. Private: channel admins only
-- (D-B1). Never on DMs or deal rooms, never by a bank guest; a guest's
-- role is fixed; the last admin of a private channel cannot be demoted.
CREATE OR REPLACE FUNCTION public.chat_set_member_role(p_channel uuid, p_user_id uuid, p_role text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_ch     public.chat_channels;
  v_role   text;
  v_target public.chat_channel_members;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'chat_set_member_role: no authenticated user' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_ch FROM public.chat_channels WHERE id = p_channel FOR UPDATE;  -- serialise the last-admin check
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat_set_member_role: channel not found' USING ERRCODE = 'P0002';
  END IF;
  v_role := public.chat_ws_role(v_ch.account_id);
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'chat_set_member_role: not a member of this workspace' USING ERRCODE = '42501';
  END IF;
  IF p_role IS NULL OR p_role NOT IN ('admin','member') THEN
    RAISE EXCEPTION 'chat_set_member_role: role must be admin or member' USING ERRCODE = '22023';
  END IF;
  IF v_ch.kind IN ('dm','deal_room') THEN
    RAISE EXCEPTION 'chat_set_member_role: DM and deal room members have no settable roles' USING ERRCODE = '22023';
  END IF;
  IF NOT (SELECT a.internal_chat_enabled FROM public.accounts a WHERE a.id = v_ch.account_id) THEN
    RAISE EXCEPTION 'chat_set_member_role: internal chat is disabled for this workspace' USING ERRCODE = 'CH001';
  END IF;
  IF v_ch.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'chat_set_member_role: channel is archived' USING ERRCODE = '42501';
  END IF;
  IF v_role = 'bank_guest' THEN
    RAISE EXCEPTION 'chat_set_member_role: bank guests cannot change roles' USING ERRCODE = '42501';
  END IF;
  IF v_ch.kind = 'private'
     AND NOT EXISTS (SELECT 1 FROM public.chat_channel_members cm
                      WHERE cm.channel_id = p_channel AND cm.user_id = v_uid AND cm.role = 'admin') THEN
    RAISE EXCEPTION 'chat_set_member_role: only channel admins can change roles in a private channel' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('owner','admin')
     AND NOT EXISTS (SELECT 1 FROM public.chat_channel_members cm
                      WHERE cm.channel_id = p_channel AND cm.user_id = v_uid AND cm.role = 'admin') THEN
    RAISE EXCEPTION 'chat_set_member_role: only channel admins or workspace owner/admin can change roles' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_target FROM public.chat_channel_members WHERE channel_id = p_channel AND user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat_set_member_role: user is not a member of this channel' USING ERRCODE = 'P0002';
  END IF;
  IF v_target.role = 'guest' THEN
    RAISE EXCEPTION 'chat_set_member_role: a guest''s role cannot be changed (guests are never admins)' USING ERRCODE = '22023';
  END IF;
  IF v_ch.kind = 'private' AND v_target.role = 'admin' AND p_role = 'member'
     AND NOT EXISTS (SELECT 1 FROM public.chat_channel_members cm2
                      WHERE cm2.channel_id = p_channel AND cm2.user_id <> p_user_id AND cm2.role = 'admin'
                        AND coalesce(public.chat_user_role(v_ch.account_id, cm2.user_id), 'bank_guest') <> 'bank_guest') THEN
    RAISE EXCEPTION 'chat_set_member_role: the last admin of a private channel cannot be demoted' USING ERRCODE = '22023';
  END IF;

  UPDATE public.chat_channel_members SET role = p_role WHERE channel_id = p_channel AND user_id = p_user_id;
  INSERT INTO public.chat_audit_log (account_id, actor_id, action, channel_id, detail)
  VALUES (v_ch.account_id, v_uid, 'set_member_role', p_channel,
          jsonb_build_object('user_id', p_user_id, 'from', v_target.role, 'to', p_role));
END $$;

-- ---------- 6. The bell ----------

-- Each chat notification becomes a notifications row. Like 004's
-- assignment notice, a failure here never blocks the post.
CREATE OR REPLACE FUNCTION public.chat_notification_to_bell()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_msg   public.internal_messages;
  v_ch    public.chat_channels;
  v_actor text;
  v_where text;
BEGIN
  SELECT * INTO v_msg FROM public.internal_messages WHERE id = NEW.message_id;
  SELECT * INTO v_ch FROM public.chat_channels WHERE id = v_msg.channel_id;
  SELECT nullif(btrim(p.full_name), '') INTO v_actor
    FROM public.profiles p WHERE p.user_id = v_msg.author_id AND p.account_id = v_ch.account_id;
  v_actor := coalesce(v_actor, 'Someone');
  v_where := CASE WHEN v_ch.kind = 'dm' THEN 'a direct message' ELSE '#' || v_ch.name END;
  INSERT INTO public.notifications (account_id, user_id, type, actor_user_id, title, body, meta)
  VALUES (v_ch.account_id, NEW.user_id, 'chat_' || NEW.kind, v_msg.author_id,
          CASE NEW.kind
            WHEN 'mention'      THEN v_actor || ' mentioned you in ' || v_where
            WHEN 'dm'           THEN v_actor || ' sent you a direct message'
            WHEN 'thread_reply' THEN v_actor || ' replied to a thread in ' || v_where
            ELSE v_actor || ' notified everyone in ' || v_where
          END,
          left(public.chat_render_mentions(v_msg.body, v_ch.account_id), 140),
          jsonb_build_object('channel_id', v_ch.id, 'message_id', v_msg.id, 'thread_root_id', v_msg.thread_root_id));
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'chat: bell notification for message % failed: %', NEW.message_id, SQLERRM;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS chat_notifications_to_bell ON public.chat_notifications;
CREATE TRIGGER chat_notifications_to_bell AFTER INSERT ON public.chat_notifications
  FOR EACH ROW EXECUTE FUNCTION public.chat_notification_to_bell();

-- ---------- 7. Attachments: the private chat-files bucket ----------

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('chat-files', 'chat-files', false, 26214400)
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 26214400;

-- account-<ws>/channel-<ch>/<uuid>-<name> → (ws, ch), else NULLs.
CREATE OR REPLACE FUNCTION public.chat_storage_channel(p_name text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id
    FROM (SELECT regexp_match(coalesce(p_name, ''),
            '^account-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/channel-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[^/]+$',
            'i') AS m) x
    JOIN public.chat_channels c ON c.id = (x.m)[2]::uuid AND c.account_id = (x.m)[1]::uuid
$$;

-- Upload: the caller may post in the path's channel.
CREATE OR REPLACE FUNCTION public.chat_storage_can_write(p_name text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_ch uuid := public.chat_storage_channel(p_name);
BEGIN
  IF v_ch IS NULL THEN RETURN false; END IF;
  PERFORM public.chat_assert_can_write(v_ch, false);
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END $$;

-- Download: the caller may read the path's channel's messages.
CREATE OR REPLACE FUNCTION public.chat_storage_can_read(p_name text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(public.chat_can_read_channel(public.chat_storage_channel(p_name)), false)
$$;

DROP POLICY IF EXISTS "Chat members can upload chat files" ON storage.objects;
CREATE POLICY "Chat members can upload chat files" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'chat-files' AND public.chat_storage_can_write(name));
DROP POLICY IF EXISTS "Chat members can read chat files" ON storage.objects;
CREATE POLICY "Chat members can read chat files" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'chat-files' AND public.chat_storage_can_read(name));

-- ---------- 8. Row-level security (reads only; writes go through the RPCs) ----------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['chat_channels','chat_channel_members','internal_messages','internal_message_edits',
    'message_mentions','message_mentions_broadcast','internal_message_reactions','message_pins','saved_messages',
    'message_attachments','shared_conversations','chat_notifications','chat_audit_log']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['message_mentions','message_mentions_broadcast','internal_message_reactions',
    'message_pins','message_attachments','shared_conversations']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.chat_can_read_message(message_id))',
                   t || '_read', t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS chat_channels_read ON public.chat_channels;
CREATE POLICY chat_channels_read ON public.chat_channels
  FOR SELECT TO authenticated USING (public.chat_can_see_channel(id));

DROP POLICY IF EXISTS chat_channel_members_read ON public.chat_channel_members;
CREATE POLICY chat_channel_members_read ON public.chat_channel_members
  FOR SELECT TO authenticated USING (public.chat_can_see_channel(channel_id));

DROP POLICY IF EXISTS internal_messages_read ON public.internal_messages;
CREATE POLICY internal_messages_read ON public.internal_messages
  FOR SELECT TO authenticated USING (public.chat_can_read_channel(channel_id));

-- owner/admin, and only for messages they can read directly (private
-- history stays behind chat_admin_read_private)
DROP POLICY IF EXISTS internal_message_edits_read ON public.internal_message_edits;
CREATE POLICY internal_message_edits_read ON public.internal_message_edits
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.internal_messages m
             WHERE m.id = message_id
               AND public.chat_ws_role(m.account_id) IN ('owner','admin')
               AND public.chat_can_read_channel(m.channel_id)));

DROP POLICY IF EXISTS saved_messages_read ON public.saved_messages;
CREATE POLICY saved_messages_read ON public.saved_messages
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS chat_notifications_read ON public.chat_notifications;
CREATE POLICY chat_notifications_read ON public.chat_notifications
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS chat_audit_log_read ON public.chat_audit_log;
CREATE POLICY chat_audit_log_read ON public.chat_audit_log
  FOR SELECT TO authenticated USING (public.chat_ws_role(account_id) IN ('owner','admin'));

-- Realtime: the tables a client subscribes to.
DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH t IN ARRAY ARRAY['chat_channels','chat_channel_members','internal_messages',
                             'internal_message_reactions','message_pins','chat_notifications']
    LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
      END IF;
    END LOOP;
  END IF;
END $$;

-- ---------- 9. Privileges ----------
-- Supabase grants ALL on new tables and EXECUTE on new functions to
-- anon / authenticated / service_role (and EXECUTE to PUBLIC): revoke
-- everything, then grant the minimum.

REVOKE ALL ON public.chat_channels, public.chat_channel_members, public.internal_messages,
  public.internal_message_edits, public.message_mentions, public.message_mentions_broadcast,
  public.internal_message_reactions, public.message_pins, public.saved_messages, public.message_attachments,
  public.shared_conversations, public.chat_notifications, public.chat_audit_log
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.chat_channels, public.chat_channel_members, public.internal_messages,
  public.internal_message_edits, public.message_mentions, public.message_mentions_broadcast,
  public.internal_message_reactions, public.message_pins, public.saved_messages, public.message_attachments,
  public.shared_conversations, public.chat_notifications, public.chat_audit_log
  TO authenticated, service_role;

DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('chat_user_role','chat_ws_role','chat_can_view_conversation','chat_normalize_digits',
                'chat_mask_phone','chat_conversation_snapshot','chat_render_mentions','chat_message_before_insert',
                'chat_message_before_update','chat_append_only_guard','chat_block_truncate',
                'chat_user_can_read_channel','chat_can_see_channel','chat_can_read_channel','chat_can_read_message',
                'chat_assert_can_write','chat_create_channel','chat_open_dm','chat_post_message',
                'chat_post_system_message','chat_edit_message','chat_delete_message','chat_mark_read',
                'chat_unread_counts','chat_workspace_badges','chat_search','chat_toggle_reaction','chat_set_pin',
                'chat_set_saved','chat_shared_cards','chat_people','chat_add_members','chat_leave_channel',
                'chat_admin_read_private','chat_erase_person','chat_set_member_role','chat_notification_to_bell',
                'chat_storage_channel','chat_storage_can_write','chat_storage_can_read')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
  END LOOP;
END $$;

-- authenticated: the client API, plus the helpers RLS and storage
-- policies call. Internal helpers and trigger functions stay revoked.
GRANT EXECUTE ON FUNCTION
  public.chat_ws_role(uuid),
  public.chat_can_see_channel(uuid), public.chat_can_read_channel(uuid), public.chat_can_read_message(uuid),
  public.chat_storage_can_write(text), public.chat_storage_can_read(text),
  public.chat_create_channel(uuid, text, text, text, uuid[]), public.chat_open_dm(uuid, uuid[]),
  public.chat_post_message(uuid, text, uuid, uuid, jsonb), public.chat_edit_message(uuid, text),
  public.chat_delete_message(uuid), public.chat_mark_read(uuid, timestamptz),
  public.chat_unread_counts(uuid), public.chat_workspace_badges(), public.chat_search(uuid, text, integer),
  public.chat_toggle_reaction(uuid, text), public.chat_set_pin(uuid, boolean),
  public.chat_set_saved(uuid, boolean), public.chat_shared_cards(uuid[]), public.chat_people(uuid),
  public.chat_add_members(uuid, uuid[]), public.chat_leave_channel(uuid),
  public.chat_admin_read_private(uuid, text), public.chat_erase_person(uuid, uuid, text),
  public.chat_set_member_role(uuid, uuid, text)
  TO authenticated;

-- service_role: SELECT (above) and system posts only.
GRANT EXECUTE ON FUNCTION public.chat_post_system_message(uuid, text, jsonb) TO service_role;
