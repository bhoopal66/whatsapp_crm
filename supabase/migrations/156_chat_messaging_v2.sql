-- 156: team chat messaging v2 (087 family).
--
-- The database side of voice notes, quote replies, forwarding, typing
-- indicators, voice-note play receipts and a channel's files list.
--
--   A. message_attachments.kind ('file' | 'voice') and duration_ms. A
--      voice note is an audio/* attachment with a duration, and a
--      message carrying one carries nothing else.
--   B. internal_messages.reply_to_id: a quote of a live message in the
--      same channel and thread scope (a top-level message quotes a
--      top-level message; a reply in thread R quotes R or a reply in R).
--      Immutable once written.
--   C. chat_post_message gains p_reply_to (last, DEFAULT NULL), so the
--      positional 5-argument calls (103's chat_share_call, the verify
--      files) keep working. Attachment checks and insert moved into
--      chat_insert_attachments, which forwarding shares.
--   D. chat_forward_message: a top-level copy of a readable message into
--      a channel the caller may post in, in the same workspace, with
--      mentions rendered to plain @Name text (a forward pings nobody but
--      a DM's members) and meta.forwarded naming the source.
--   E. chat_typing + chat_set_typing: one row per person per channel,
--      written at most every 2 seconds per thread, carried by realtime.
--      The gate is chat_assert_can_write(p_channel, false): "could post
--      now" without 087's team-channel autojoin, so typing in a team
--      channel never makes anyone a member.
--   F. chat_voice_plays + chat_mark_voice_played: who has played a voice
--      note (not its author).
--   G. chat_channel_files: SECURITY INVOKER, so 087's RLS on
--      internal_messages and message_attachments decides; no new access
--      path.
--   H. chat_erase_person (109's body, which redefined 087's) also deletes
--      the person's typing and play rows, and erases forwarded copies of
--      the person's messages (forwards of forwards included) the way it
--      erases the person's own: '[erased]', erased_at, attachments deleted
--      and their paths returned with the rest.
--
-- Re-runnable; no BEGIN/COMMIT. Tables are RLS-forced and grant SELECT
-- to authenticated only; every write is a SECURITY DEFINER chat_*
-- function; nothing new is granted to service_role
-- (verify-internal-chat-admin.sql pins that list).

-- ---------- A. Attachment kind ----------

ALTER TABLE public.message_attachments ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'file';
ALTER TABLE public.message_attachments ADD COLUMN IF NOT EXISTS duration_ms integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.message_attachments'::regclass
                    AND conname = 'message_attachments_kind_check') THEN
    ALTER TABLE public.message_attachments
      ADD CONSTRAINT message_attachments_kind_check CHECK (kind IN ('file','voice'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.message_attachments'::regclass
                    AND conname = 'message_attachments_duration_check') THEN
    ALTER TABLE public.message_attachments
      ADD CONSTRAINT message_attachments_duration_check
      CHECK (duration_ms IS NULL OR duration_ms BETWEEN 1 AND 1200000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.message_attachments'::regclass
                    AND conname = 'message_attachments_voice_check') THEN
    ALTER TABLE public.message_attachments
      ADD CONSTRAINT message_attachments_voice_check
      CHECK (kind <> 'voice' OR (duration_ms IS NOT NULL AND mime ILIKE 'audio/%'));
  END IF;
END $$;

-- ---------- B. Quote replies ----------

ALTER TABLE public.internal_messages
  ADD COLUMN IF NOT EXISTS reply_to_id uuid REFERENCES public.internal_messages(id);
CREATE INDEX IF NOT EXISTS internal_messages_reply_to_idx
  ON public.internal_messages (reply_to_id) WHERE reply_to_id IS NOT NULL;

-- 087's body, plus the quote check.
CREATE OR REPLACE FUNCTION public.chat_message_before_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_root  public.internal_messages;
  v_quote public.internal_messages;
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
  -- 156: a quote names a live message of the same channel and thread
  -- scope: top level quotes top level; a reply in thread R quotes R or
  -- another reply in R.
  IF NEW.reply_to_id IS NOT NULL THEN
    SELECT * INTO v_quote FROM public.internal_messages WHERE id = NEW.reply_to_id;
    IF NOT FOUND
       OR v_quote.channel_id <> NEW.channel_id
       OR v_quote.deleted_at IS NOT NULL OR v_quote.erased_at IS NOT NULL
       OR (NEW.thread_root_id IS NULL AND v_quote.thread_root_id IS NOT NULL)
       OR (NEW.thread_root_id IS NOT NULL
           AND v_quote.id <> NEW.thread_root_id
           AND v_quote.thread_root_id IS DISTINCT FROM NEW.thread_root_id) THEN
      RAISE EXCEPTION 'chat: a quoted message must be a live message of the same channel and thread'
        USING ERRCODE = '22023';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS internal_messages_before_insert ON public.internal_messages;
CREATE TRIGGER internal_messages_before_insert BEFORE INSERT ON public.internal_messages
  FOR EACH ROW EXECUTE FUNCTION public.chat_message_before_insert();

-- 087's body; reply_to_id joins the immutable structural columns.
CREATE OR REPLACE FUNCTION public.chat_message_before_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.channel_id <> OLD.channel_id OR NEW.account_id <> OLD.account_id
     OR NEW.author_id IS DISTINCT FROM OLD.author_id OR NEW.author_kind <> OLD.author_kind
     OR NEW.created_at <> OLD.created_at
     OR NEW.thread_root_id IS DISTINCT FROM OLD.thread_root_id
     OR NEW.reply_to_id IS DISTINCT FROM OLD.reply_to_id THEN
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

-- ---------- C. Attachments helper + chat_post_message ----------

-- p_atts: up to 10 {storage_path, name, mime, bytes, kind?, duration_ms?},
-- each an object already uploaded to chat-files under p_ch's prefix.
-- 087's checks, plus: kind 'file' (default) or 'voice'; duration_ms an
-- integer 1..1200000 when given, required for a voice note; a voice note
-- is audio/* and is the message's only attachment. Internal: executable
-- by nobody, called by chat_post_message and chat_forward_message.
CREATE OR REPLACE FUNCTION public.chat_insert_attachments(p_ch public.chat_channels, p_message uuid, p_atts jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_atts   jsonb := coalesce(p_atts, '[]'::jsonb);
  v_att    jsonb;
  v_prefix text;
  v_kind   text;
  v_voice  integer := 0;
BEGIN
  IF jsonb_typeof(v_atts) <> 'array' OR jsonb_array_length(v_atts) > 10 THEN
    RAISE EXCEPTION 'chat: attachments must be an array of at most 10 items' USING ERRCODE = '22023';
  END IF;
  v_prefix := 'account-' || p_ch.account_id || '/channel-' || p_ch.id || '/';
  FOR v_att IN SELECT * FROM jsonb_array_elements(v_atts) LOOP
    IF jsonb_typeof(v_att) <> 'object'
       OR jsonb_typeof(v_att->'storage_path') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_att->'name') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_att->'mime') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_att->'bytes') IS DISTINCT FROM 'number'
       OR char_length(btrim(v_att->>'name')) NOT BETWEEN 1 AND 255
       OR (v_att->>'mime') ~ '^[[:space:]]*$'
       OR (v_att->>'bytes')::numeric NOT BETWEEN 0 AND 26214400
       OR (v_att->>'bytes')::numeric <> trunc((v_att->>'bytes')::numeric) THEN
      RAISE EXCEPTION 'chat: each attachment needs storage_path, name, mime and bytes (at most 25 MB)'
        USING ERRCODE = '22023';
    END IF;
    IF coalesce(jsonb_typeof(v_att->'kind'), 'null') NOT IN ('null','string')
       OR coalesce(v_att->>'kind', 'file') NOT IN ('file','voice') THEN
      RAISE EXCEPTION 'chat: attachment kind must be file or voice' USING ERRCODE = '22023';
    END IF;
    v_kind := coalesce(v_att->>'kind', 'file');
    IF coalesce(jsonb_typeof(v_att->'duration_ms'), 'null') NOT IN ('null','number')
       OR (jsonb_typeof(v_att->'duration_ms') = 'number'
           AND ((v_att->>'duration_ms')::numeric NOT BETWEEN 1 AND 1200000
                OR (v_att->>'duration_ms')::numeric <> trunc((v_att->>'duration_ms')::numeric))) THEN
      RAISE EXCEPTION 'chat: attachment duration_ms must be an integer of 1 to 1200000' USING ERRCODE = '22023';
    END IF;
    IF v_kind = 'voice' THEN
      IF jsonb_typeof(v_att->'duration_ms') IS DISTINCT FROM 'number'
         OR btrim(v_att->>'mime') NOT ILIKE 'audio/%' THEN
        RAISE EXCEPTION 'chat: a voice attachment needs an audio/* mime and duration_ms' USING ERRCODE = '22023';
      END IF;
      v_voice := v_voice + 1;
    END IF;
    IF left(v_att->>'storage_path', length(v_prefix)) <> v_prefix
       OR substr(v_att->>'storage_path', length(v_prefix) + 1)
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[^/]+$' THEN
      RAISE EXCEPTION 'chat: attachment path must be %<uuid>-<name>', v_prefix USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM storage.objects o
                    WHERE o.bucket_id = 'chat-files' AND o.name = v_att->>'storage_path') THEN
      RAISE EXCEPTION 'chat: attachment % was not uploaded', v_att->>'storage_path' USING ERRCODE = 'P0002';
    END IF;
    -- One object, one attachment row: a path already attached (or named
    -- twice in this call) would let a post or forward re-publish a file
    -- the caller never uploaded, and a delete of one row would free an
    -- object another message still shows.
    IF EXISTS (SELECT 1 FROM public.message_attachments a WHERE a.storage_path = v_att->>'storage_path')
       OR (SELECT count(*) FROM jsonb_array_elements(v_atts) x
            WHERE x->>'storage_path' = v_att->>'storage_path') > 1 THEN
      RAISE EXCEPTION 'chat: attachment % already belongs to a message', v_att->>'storage_path'
        USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF v_voice > 0 AND jsonb_array_length(v_atts) <> 1 THEN
    RAISE EXCEPTION 'chat: a voice attachment must be the message''s only attachment' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.message_attachments (message_id, storage_path, name, mime, bytes, kind, duration_ms)
  SELECT p_message, a->>'storage_path', btrim(a->>'name'), btrim(a->>'mime'), (a->>'bytes')::bigint,
         coalesce(a->>'kind', 'file'), (a->>'duration_ms')::numeric::integer
    FROM jsonb_array_elements(v_atts) a;
END $$;

-- The argument list grows, so the 087 signature is dropped first (two
-- overloads would make every positional call ambiguous).
DROP FUNCTION IF EXISTS public.chat_post_message(uuid, text, uuid, uuid, jsonb);

-- 087's body; attachments go through chat_insert_attachments, and
-- p_reply_to quotes a message (checked by the insert trigger).
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

-- ---------- D. Forwarding ----------

-- A top-level copy of a message the caller can read, posted where the
-- caller may post, in the same workspace. Mentions are rendered to
-- '@Name' text (no mention rows, no @channel/@here); no shared card is
-- carried over; p_attachments are copies the client already made under
-- the target channel's prefix. Only a DM target rings (kind 'dm').
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

  INSERT INTO public.internal_messages (channel_id, account_id, author_kind, author_id, body, meta)
  VALUES (p_channel, v_ch.account_id, 'user', v_uid,
          left(public.chat_render_mentions(v_src.body, v_src.account_id), 8000),
          jsonb_build_object('forwarded', jsonb_build_object(
            'message_id', v_src.id, 'author_id', v_src.author_id,
            'author_kind', v_src.author_kind, 'created_at', v_src.created_at)))
  RETURNING id INTO v_id;

  PERFORM public.chat_insert_attachments(v_ch, v_id, p_attachments);
  -- The copies must be the source's own files: each one matches a
  -- distinct attachment of the source on (name, mime, bytes, kind,
  -- duration_ms), so no more of them than the source has. Otherwise a
  -- forward would post any uploaded file without upload_files (157).
  IF EXISTS (
    SELECT 1
      FROM (SELECT a.name, a.mime, a.bytes, a.kind, a.duration_ms, count(*) AS n
              FROM public.message_attachments a WHERE a.message_id = v_id
             GROUP BY 1, 2, 3, 4, 5) f
      LEFT JOIN (SELECT a.name, a.mime, a.bytes, a.kind, a.duration_ms, count(*) AS n
                   FROM public.message_attachments a WHERE a.message_id = v_src.id
                  GROUP BY 1, 2, 3, 4, 5) s
        ON s.name = f.name AND s.mime = f.mime AND s.bytes = f.bytes AND s.kind = f.kind
       AND s.duration_ms IS NOT DISTINCT FROM f.duration_ms
     WHERE s.n IS NULL OR f.n > s.n) THEN
    RAISE EXCEPTION 'chat_forward_message: attachments must be copies of the source message''s attachments'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.chat_notifications (user_id, account_id, message_id, kind)
  SELECT cm.user_id, v_ch.account_id, v_id, 'dm'
    FROM public.chat_channel_members cm
   WHERE v_ch.kind = 'dm' AND cm.channel_id = p_channel AND cm.user_id <> v_uid
     AND public.chat_user_can_read_channel(p_channel, cm.user_id, true);
  RETURN v_id;
END $$;

-- chat_erase_person looks forwarded copies up by their source message
-- and by the source's author (meta.forwarded), recursively.
CREATE INDEX IF NOT EXISTS internal_messages_forwarded_message_idx
  ON public.internal_messages ((meta->'forwarded'->>'message_id')) WHERE meta ? 'forwarded';
CREATE INDEX IF NOT EXISTS internal_messages_forwarded_author_idx
  ON public.internal_messages ((meta->'forwarded'->>'author_id')) WHERE meta ? 'forwarded';

-- ---------- E. Typing ----------

CREATE TABLE IF NOT EXISTS public.chat_typing (
  channel_id     uuid NOT NULL REFERENCES public.chat_channels(id),
  account_id     uuid NOT NULL REFERENCES public.accounts(id),
  user_id        uuid NOT NULL,
  thread_root_id uuid,
  at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);
-- A stop is an UPDATE to stopped = true, never a DELETE: realtime does
-- not RLS-filter DELETE events, so a delete would tell every subscriber
-- of the table who stopped typing where.
ALTER TABLE public.chat_typing ADD COLUMN IF NOT EXISTS stopped boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS chat_typing_account_user_idx ON public.chat_typing (account_id, user_id);

-- Typing is allowed where the caller could post right now:
-- chat_assert_can_write with p_autojoin = false runs every check of a
-- post (workspace role, CH001, archived, guest, membership, DM rules)
-- but never adds a team-channel member. p_typing = false only marks the
-- caller's own row stopped (never a DELETE, see the table) and needs no
-- gate, so a person who lost access can still clear it. A row younger
-- than 2 seconds on the same thread is left alone, stopped or not, which
-- caps the realtime traffic a keyboard produces (stop + start cannot
-- bypass it).
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
    UPDATE public.chat_typing SET stopped = true
     WHERE channel_id = p_channel AND user_id = v_uid AND NOT stopped;
    RETURN;
  END IF;

  v_ch := public.chat_assert_can_write(p_channel, false);
  IF p_thread_root IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.internal_messages m
                      WHERE m.id = p_thread_root AND m.channel_id = p_channel AND m.thread_root_id IS NULL) THEN
    RAISE EXCEPTION 'chat_set_typing: the thread root must be a top-level message of this channel'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.chat_typing AS t (channel_id, account_id, user_id, thread_root_id, at, stopped)
  VALUES (p_channel, v_ch.account_id, v_uid, p_thread_root, now(), false)
  ON CONFLICT (channel_id, user_id) DO UPDATE
     SET account_id = EXCLUDED.account_id, thread_root_id = EXCLUDED.thread_root_id, at = EXCLUDED.at,
         stopped = false
   WHERE NOT (t.at > now() - interval '2 seconds'
              AND t.thread_root_id IS NOT DISTINCT FROM EXCLUDED.thread_root_id);
END $$;

-- ---------- F. Voice plays ----------

CREATE TABLE IF NOT EXISTS public.chat_voice_plays (
  message_id uuid NOT NULL REFERENCES public.internal_messages(id),
  account_id uuid NOT NULL REFERENCES public.accounts(id),
  user_id    uuid NOT NULL,
  played_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS chat_voice_plays_account_user_idx ON public.chat_voice_plays (account_id, user_id);

-- The first play of a voice note by someone other than its author.
CREATE OR REPLACE FUNCTION public.chat_mark_voice_played(p_message uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_m   public.internal_messages;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'chat: no authenticated user' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_m FROM public.internal_messages WHERE id = p_message;
  IF NOT FOUND OR NOT public.chat_can_read_channel(v_m.channel_id) THEN
    RAISE EXCEPTION 'chat_mark_voice_played: message not found' USING ERRCODE = 'P0002';
  END IF;
  -- a write: chat_can_read_channel still lets admins read a disabled
  -- workspace's history
  IF NOT (SELECT a.internal_chat_enabled FROM public.accounts a WHERE a.id = v_m.account_id) THEN
    RAISE EXCEPTION 'chat: internal chat is disabled for this workspace' USING ERRCODE = 'CH001';
  END IF;
  IF v_m.deleted_at IS NOT NULL OR v_m.erased_at IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM public.message_attachments a
                     WHERE a.message_id = v_m.id AND a.kind = 'voice') THEN
    RAISE EXCEPTION 'chat_mark_voice_played: not a live voice note' USING ERRCODE = '22023';
  END IF;
  IF v_m.author_id IS NOT DISTINCT FROM v_uid THEN
    RETURN;
  END IF;
  INSERT INTO public.chat_voice_plays (message_id, account_id, user_id)
  VALUES (v_m.id, v_m.account_id, v_uid)
  ON CONFLICT DO NOTHING;
END $$;

-- ---------- G. Channel files list ----------

-- SECURITY INVOKER: the caller's RLS on internal_messages and
-- message_attachments decides what is listed.
CREATE OR REPLACE FUNCTION public.chat_channel_files(p_channel uuid, p_kind text DEFAULT NULL,
  p_before timestamptz DEFAULT NULL, p_limit integer DEFAULT 60)
RETURNS TABLE (id uuid, message_id uuid, storage_path text, name text, mime text, bytes bigint,
               kind text, duration_ms integer, created_at timestamptz, author_id uuid, thread_root_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  IF p_kind IS NOT NULL AND p_kind NOT IN ('voice','image','video','file') THEN
    RAISE EXCEPTION 'chat_channel_files: kind must be voice, image, video or file' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT a.id, a.message_id, a.storage_path, a.name, a.mime, a.bytes, a.kind, a.duration_ms,
         m.created_at, m.author_id, m.thread_root_id
    FROM public.message_attachments a
    JOIN public.internal_messages m ON m.id = a.message_id
   WHERE m.channel_id = p_channel
     AND m.deleted_at IS NULL AND m.erased_at IS NULL
     AND (p_before IS NULL OR m.created_at < p_before)
     AND (p_kind IS NULL
          OR (p_kind = 'voice' AND a.kind = 'voice')
          OR (p_kind = 'image' AND a.mime ILIKE 'image/%')
          OR (p_kind = 'video' AND a.mime ILIKE 'video/%')
          OR (p_kind = 'file' AND a.kind = 'file'
              AND a.mime NOT ILIKE 'image/%' AND a.mime NOT ILIKE 'video/%'))
   ORDER BY m.created_at DESC, a.id DESC
   LIMIT greatest(1, least(200, coalesce(p_limit, 60)));
END $$;

-- ---------- H. Erasure ----------

-- 109's chat_erase_person (the latest), plus 156: the person's typing
-- and play rows, and forwarded copies of the person's messages. A copy
-- is any message of the workspace whose meta.forwarded names the person
-- as author, or names (transitively) one of the person's messages or
-- another such copy, so a forward of a forward is erased too. Copies are
-- erased like the person's own messages: body '[erased]', erased_at set,
-- edit history, bells and attachments deleted, attachment paths returned
-- with the person's own. The audit row's 'messages' still counts only
-- the person's own messages; 'forwarded_copies' counts the copies.
CREATE OR REPLACE FUNCTION public.chat_erase_person(p_ws uuid, p_user_id uuid, p_reason text)
RETURNS text[] LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_paths  text[];
  v_msgs   integer;
  v_copies uuid[];
  v_ncopy  integer;
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

  -- 156: forwarded copies (not the person's own rows)
  WITH RECURSIVE src(id) AS (
    SELECT m.id FROM public.internal_messages m
     WHERE m.account_id = p_ws AND m.author_id = p_user_id
    UNION
    SELECT c.id FROM public.internal_messages c JOIN src ON c.meta->'forwarded'->>'message_id' = src.id::text
     WHERE c.account_id = p_ws
  )
  SELECT coalesce(array_agg(DISTINCT x.id), '{}') INTO v_copies
    FROM (SELECT s.id FROM src s
          UNION
          SELECT m.id FROM public.internal_messages m
           WHERE m.account_id = p_ws AND m.meta->'forwarded'->>'author_id' = p_user_id::text) x
    JOIN public.internal_messages m ON m.id = x.id
   WHERE m.author_id IS DISTINCT FROM p_user_id;
  UPDATE public.internal_messages m SET body = '[erased]', erased_at = now()
   WHERE m.id = ANY (v_copies) AND m.erased_at IS NULL;
  v_ncopy := cardinality(v_copies);

  SELECT coalesce(array_agg(a.storage_path ORDER BY a.storage_path), '{}') INTO v_paths
    FROM public.message_attachments a JOIN public.internal_messages m ON m.id = a.message_id
   WHERE m.account_id = p_ws AND (m.author_id = p_user_id OR m.id = ANY (v_copies));
  DELETE FROM public.message_attachments a USING public.internal_messages m
   WHERE a.message_id = m.id AND m.account_id = p_ws AND (m.author_id = p_user_id OR m.id = ANY (v_copies));
  DELETE FROM public.shared_conversations s USING public.internal_messages m
   WHERE s.message_id = m.id AND m.account_id = p_ws AND m.author_id = p_user_id;

  PERFORM set_config('chat.erase', 'on', true);
  DELETE FROM public.internal_message_edits x USING public.internal_messages m
   WHERE x.message_id = m.id AND m.account_id = p_ws AND (m.author_id = p_user_id OR m.id = ANY (v_copies));
  PERFORM set_config('chat.erase', 'off', true);

  DELETE FROM public.message_mentions mm USING public.internal_messages m
   WHERE mm.message_id = m.id AND m.account_id = p_ws AND (mm.user_id = p_user_id OR m.author_id = p_user_id);
  DELETE FROM public.message_mentions_broadcast b USING public.internal_messages m
   WHERE b.message_id = m.id AND m.account_id = p_ws AND m.author_id = p_user_id;
  DELETE FROM public.internal_message_reactions r USING public.internal_messages m
   WHERE r.message_id = m.id AND m.account_id = p_ws AND r.user_id = p_user_id;
  DELETE FROM public.saved_messages s USING public.internal_messages m
   WHERE s.message_id = m.id AND m.account_id = p_ws AND s.user_id = p_user_id;
  DELETE FROM public.chat_notifications
   WHERE account_id = p_ws AND (user_id = p_user_id OR message_id = ANY (v_copies));
  -- bell rows: the person's own, and everyone's that quote the person
  -- (156: including the bells of forwarded copies)
  DELETE FROM public.notifications
   WHERE account_id = p_ws
     AND type IN ('chat_mention','chat_dm','chat_thread_reply','chat_broadcast')
     AND (user_id = p_user_id OR actor_user_id = p_user_id
          OR (meta->>'message_id') = ANY (v_copies::text[]));

  -- 109: queued team-chat pushes, sent or not, that carry the person's
  -- words, and the person's own.
  DELETE FROM public.push_outbox
   WHERE account_id = p_ws AND kind = 'chat_message'
     AND (source_user_id = p_user_id OR user_id = p_user_id
          OR message_id = ANY (v_copies));   -- 156: pushes of forwarded copies (message_id since 112)

  -- 156: the person's typing and voice-play rows
  DELETE FROM public.chat_typing WHERE account_id = p_ws AND user_id = p_user_id;
  DELETE FROM public.chat_voice_plays WHERE account_id = p_ws AND user_id = p_user_id;

  INSERT INTO public.chat_audit_log (account_id, actor_id, action, detail)
  VALUES (p_ws, auth.uid(), 'erase_person',
          jsonb_build_object('user_id', p_user_id, 'reason', btrim(p_reason),
                             'messages', v_msgs, 'attachments', cardinality(v_paths),
                             'forwarded_copies', v_ncopy));
  RETURN v_paths;
END $$;

-- ---------- RLS, realtime, privileges ----------

ALTER TABLE public.chat_typing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_typing FORCE ROW LEVEL SECURITY;
ALTER TABLE public.chat_voice_plays ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_voice_plays FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chat_typing_read ON public.chat_typing;
CREATE POLICY chat_typing_read ON public.chat_typing
  FOR SELECT TO authenticated USING (public.chat_can_read_channel(channel_id));
DROP POLICY IF EXISTS chat_voice_plays_read ON public.chat_voice_plays;
CREATE POLICY chat_voice_plays_read ON public.chat_voice_plays
  FOR SELECT TO authenticated USING (public.chat_can_read_message(message_id));

DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH t IN ARRAY ARRAY['chat_typing','chat_voice_plays']
    LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
      END IF;
    END LOOP;
  END IF;
END $$;

REVOKE ALL ON public.chat_typing, public.chat_voice_plays FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.chat_typing, public.chat_voice_plays TO authenticated;

REVOKE ALL ON FUNCTION public.chat_insert_attachments(public.chat_channels, uuid, jsonb),
  public.chat_post_message(uuid, text, uuid, uuid, jsonb, uuid),
  public.chat_forward_message(uuid, uuid, jsonb),
  public.chat_set_typing(uuid, uuid, boolean),
  public.chat_mark_voice_played(uuid),
  public.chat_channel_files(uuid, text, timestamptz, integer),
  public.chat_erase_person(uuid, uuid, text),
  public.chat_message_before_insert(), public.chat_message_before_update()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.chat_post_message(uuid, text, uuid, uuid, jsonb, uuid),
  public.chat_forward_message(uuid, uuid, jsonb),
  public.chat_set_typing(uuid, uuid, boolean),
  public.chat_mark_voice_played(uuid),
  public.chat_channel_files(uuid, text, timestamptz, integer),
  public.chat_erase_person(uuid, uuid, text)
  TO authenticated;
