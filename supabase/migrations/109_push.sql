-- 109: web push, database side.
--
-- A person's devices (push_subscriptions) and preferences
-- (push_preferences), and an outbox (push_outbox) that the server's
-- dispatcher drains with push_claim / push_settle and trims with
-- push_purge. Three writers fill the outbox:
--
--  * every bell row (notifications INSERT) except the four chat_*
--    types, whose message already pushes once (below). kind = the bell
--    type; url = a mirror of hrefFor in src/lib/notifications/target.ts
--    for the common types, else /notifications. Change one, change both.
--  * every team-chat message (internal_messages INSERT, people's only,
--    not deleted): each member of the channel but the author who can
--    read its messages (chat_user_can_read_channel, so a bank guest gets
--    nothing from a deal room's Team notes); a member who muted the
--    channel only when the message @mentions them (087's
--    message_mentions). kind = chat_message.
--  * push_whatsapp_inbound(message id), called by the inbound pipeline
--    after the persist: the conversation's assignee, else the people
--    allocated to its number (whatsapp_channel_members), else (shared or
--    unknown number) the account's live owners and admins.
--    kind = whatsapp_message.
--
-- push_eligible is the one gate every writer applies: the person has a
-- device, has not switched push off or that kind off, and is live in
-- the account (a profile there not deactivated, workspace not
-- archived). Quiet hours are stored here but applied by the
-- dispatcher, which knows the clock at send time.
--
-- The chat trigger is a DEFERRED constraint trigger: chat_post_message
-- inserts the message first and its mentions and attachments after, so
-- an ordinary AFTER INSERT trigger would see none of them. Its WHEN
-- queues an event only when another member has a device. Like the
-- bell, no push failure ever blocks the post, the bell row or the
-- inbound message: each writer turns an error into a WARNING.
--
-- Not account-scoped: a device belongs to a person in every workspace
-- they work in; the outbox row carries the account it is about.
--
-- Re-runnable: every statement is guarded or replaces in place.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '109 must be applied by a superuser or BYPASSRLS role (the push triggers read RLS-forced chat tables)';
  END IF;
END $$;

-- ---------- 1. Tables ----------

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint        text NOT NULL UNIQUE CHECK (endpoint ~ '^https://' AND char_length(endpoint) <= 2048),
  p256dh          text NOT NULL CHECK (char_length(p256dh) BETWEEN 1 AND 256),
  auth            text NOT NULL CHECK (char_length(auth) BETWEEN 1 AND 256),
  user_agent      text CHECK (user_agent IS NULL OR char_length(user_agent) <= 512),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  failure_count   integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON public.push_subscriptions (user_id);

CREATE TABLE IF NOT EXISTS public.push_preferences (
  user_id     uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled     boolean NOT NULL DEFAULT true,
  kinds       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(kinds) = 'object'),  -- kind → bool; missing = on
  quiet_start time,
  quiet_end   time,
  time_zone   text CHECK (time_zone IS NULL OR char_length(time_zone) BETWEEN 1 AND 64),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT push_preferences_quiet_pair CHECK ((quiet_start IS NULL) = (quiet_end IS NULL))
);

CREATE TABLE IF NOT EXISTS public.push_outbox (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL,
  account_id uuid NOT NULL,
  kind       text NOT NULL,
  title      text NOT NULL,
  body       text,
  url        text NOT NULL,
  tag        text,
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  sent_at    timestamptz,
  attempts   integer NOT NULL DEFAULT 0,
  last_error text
);
CREATE INDEX IF NOT EXISTS push_outbox_unsent_idx ON public.push_outbox (created_at) WHERE sent_at IS NULL;

-- ---------- 2. RLS and grants ----------

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_preferences   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_outbox        ENABLE ROW LEVEL SECURITY;   -- no policy: no client row, ever

DROP POLICY IF EXISTS push_subscriptions_select ON public.push_subscriptions;
DROP POLICY IF EXISTS push_subscriptions_insert ON public.push_subscriptions;
DROP POLICY IF EXISTS push_subscriptions_delete ON public.push_subscriptions;
CREATE POLICY push_subscriptions_select ON public.push_subscriptions FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));
CREATE POLICY push_subscriptions_insert ON public.push_subscriptions FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY push_subscriptions_delete ON public.push_subscriptions FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS push_preferences_own ON public.push_preferences;
CREATE POLICY push_preferences_own ON public.push_preferences FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));

REVOKE ALL ON public.push_subscriptions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.push_preferences   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.push_outbox        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.push_outbox_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.push_subscriptions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.push_preferences TO authenticated;
GRANT ALL ON public.push_subscriptions, public.push_preferences, public.push_outbox TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.push_outbox_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.push_preferences_touch()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.push_preferences_touch() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS push_preferences_touch ON public.push_preferences;
CREATE TRIGGER push_preferences_touch BEFORE UPDATE ON public.push_preferences
  FOR EACH ROW EXECUTE FUNCTION public.push_preferences_touch();

-- ---------- 3. The gate and the generic enqueue ----------

-- Would a push of p_kind about p_account reach p_user at all? Device
-- first: it is the cheap test that fails for almost everyone.
CREATE OR REPLACE FUNCTION public.push_eligible(p_user uuid, p_account uuid, p_kind text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.push_subscriptions s WHERE s.user_id = p_user)
     AND NOT EXISTS (SELECT 1 FROM public.push_preferences pp
                      WHERE pp.user_id = p_user
                        AND (NOT pp.enabled OR pp.kinds -> p_kind = 'false'::jsonb))
     AND EXISTS (SELECT 1 FROM public.profiles p
                   JOIN public.accounts a ON a.id = p.account_id
                  WHERE p.user_id = p_user AND p.account_id = p_account
                    AND p.deactivated_at IS NULL AND a.archived_at IS NULL)
$$;

-- One push for one person; true when it was queued. Service role only.
CREATE OR REPLACE FUNCTION public.push_enqueue(
  p_user uuid, p_account uuid, p_kind text, p_title text, p_body text, p_url text, p_tag text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_user IS NULL OR p_account IS NULL OR p_kind IS NULL
     OR NOT public.push_eligible(p_user, p_account, p_kind) THEN
    RETURN false;
  END IF;
  INSERT INTO public.push_outbox (user_id, account_id, kind, title, body, url, tag)
  VALUES (p_user, p_account, p_kind, left(coalesce(nullif(btrim(p_title), ''), 'Notification'), 120),
          left(p_body, 400), coalesce(nullif(btrim(p_url), ''), '/notifications'), left(p_tag, 120));
  RETURN true;
END $$;

-- ---------- 4. Bell rows ----------

CREATE OR REPLACE FUNCTION public.push_is_uuid(p text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(p ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false)
$$;

-- hrefFor (src/lib/notifications/target.ts) for one bell row, with
-- /notifications where hrefFor opens nothing. Change both together.
CREATE OR REPLACE FUNCTION public.push_bell_url(n public.notifications)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_role    text;
  v_chat    text := CASE WHEN n.conversation_id IS NOT NULL THEN '/inbox?c=' || n.conversation_id END;
  v_contact text;
BEGIN
  SELECT p.account_role::text INTO v_role FROM public.profiles p
   WHERE p.user_id = n.user_id AND p.account_id = n.account_id AND p.deactivated_at IS NULL;
  CASE
    WHEN n.type IN ('conversation_assigned', 'ai_handoff') THEN
      RETURN coalesce(v_chat, '/notifications');
    WHEN n.type IN ('task_assigned', 'task_due') THEN
      RETURN coalesce('/contacts/' || n.contact_id, v_chat, '/calls');
    WHEN n.type IN ('call_missed', 'callback_requested', 'call_outcome_due') THEN
      v_contact := coalesce(n.contact_id::text, n.meta ->> 'contact_id');
      RETURN CASE WHEN public.push_is_uuid(v_contact) THEN '/contacts/' || v_contact ELSE '/calls' END;
    WHEN n.type IN ('deal_room_join_request', 'deal_room_update') THEN
      RETURN CASE WHEN public.push_is_uuid(n.meta ->> 'room_id')
                  THEN '/chat/rooms/' || (n.meta ->> 'room_id') ELSE '/notifications' END;
    WHEN n.type IN ('channel_disconnected', 'channel_reconnected') THEN
      RETURN CASE WHEN v_role IN ('owner', 'admin') THEN '/settings?tab=whatsapp' ELSE '/notifications' END;
    WHEN n.type IN ('pbx_connection_silent', 'pbx_connection_restored') THEN
      RETURN CASE WHEN v_role IN ('owner', 'admin') THEN '/settings?tab=phone-system' ELSE '/notifications' END;
    WHEN n.type = 'team_activity_alert' THEN
      RETURN CASE WHEN v_role IN ('owner', 'admin', 'team_leader') THEN '/team-activity' ELSE '/notifications' END;
    WHEN n.type = 'meeting_invite' THEN
      RETURN CASE WHEN public.push_is_uuid(n.meta ->> 'meeting_id')
                  THEN '/meetings/' || (n.meta ->> 'meeting_id') ELSE '/notifications' END;
    ELSE
      RETURN '/notifications';
  END CASE;
END $$;

CREATE OR REPLACE FUNCTION public.push_on_notification()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.push_enqueue(NEW.user_id, NEW.account_id, NEW.type, NEW.title, NEW.body,
                              public.push_bell_url(NEW), 'bell:' || NEW.id);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'push: bell row % not queued: %', NEW.id, SQLERRM;
  RETURN NULL;
END $$;
-- The chat_* bell types are pushed by their message (section 5): one push per message.
DROP TRIGGER IF EXISTS push_on_notification ON public.notifications;
CREATE TRIGGER push_on_notification AFTER INSERT ON public.notifications
  FOR EACH ROW
  WHEN (NEW.type NOT IN ('chat_mention', 'chat_dm', 'chat_thread_reply', 'chat_broadcast'))
  EXECUTE FUNCTION public.push_on_notification();

-- ---------- 5. Team chat ----------

-- Does anyone in the channel but the author have a device? The chat
-- trigger's WHEN: when nobody does (the usual case) no deferred event
-- is even queued, so a post costs one probe and its transaction carries
-- no pending trigger event (which would, among other things, refuse a
-- later TRUNCATE in it). Inserts into internal_messages come only from
-- SECURITY DEFINER functions, so clients need no EXECUTE.
CREATE OR REPLACE FUNCTION public.push_chat_has_device(p_channel uuid, p_author uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.chat_channel_members cm
                   JOIN public.push_subscriptions s ON s.user_id = cm.user_id
                  WHERE cm.channel_id = p_channel AND cm.user_id IS DISTINCT FROM p_author)
$$;

CREATE OR REPLACE FUNCTION public.push_on_chat_message()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_msg    public.internal_messages;
  v_ch     public.chat_channels;
  v_author text;
  v_title  text;
  v_body   text;
  v_files  integer;
  v_fnames integer;
  v_url    text;
BEGIN
  -- Deferred to commit: read the row as it is now (deleted in the meantime → nothing).
  SELECT * INTO v_msg FROM public.internal_messages WHERE id = NEW.id;
  IF NOT FOUND OR v_msg.author_kind <> 'user' OR v_msg.author_id IS NULL
     OR v_msg.deleted_at IS NOT NULL OR v_msg.erased_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_ch FROM public.chat_channels WHERE id = v_msg.channel_id;

  SELECT nullif(btrim(p.full_name), '') INTO v_author
    FROM public.profiles p WHERE p.user_id = v_msg.author_id AND p.account_id = v_ch.account_id;
  v_author := coalesce(v_author, 'Someone');
  v_title := CASE WHEN v_ch.kind = 'dm' THEN v_author ELSE v_author || ' in #' || v_ch.name END;

  -- A files-only post's body is its file names joined by ', ' (composer.ts filesOnlyBody).
  SELECT count(*), coalesce(sum(char_length(btrim(a.name))), 0)
         + 2 * greatest(count(*) - 1, 0)
    INTO v_files, v_fnames
    FROM public.message_attachments a WHERE a.message_id = v_msg.id;
  v_body := public.chat_render_mentions(v_msg.body, v_ch.account_id);
  IF v_files > 0 THEN
    v_body := CASE
      WHEN char_length(btrim(v_msg.body)) = v_fnames
           AND NOT EXISTS (SELECT 1 FROM public.message_attachments a
                            WHERE a.message_id = v_msg.id AND position(btrim(a.name) IN v_msg.body) = 0)
        THEN '📎 Attachment'
      ELSE '📎 ' || v_body
    END;
  END IF;
  v_body := left(v_body, 140);
  v_url := '/chat/' || v_ch.id
           || CASE WHEN v_msg.thread_root_id IS NOT NULL THEN '?thread=' || v_msg.thread_root_id ELSE '' END;

  INSERT INTO public.push_outbox (user_id, account_id, kind, title, body, url, tag)
  SELECT cm.user_id, v_ch.account_id, 'chat_message', left(v_title, 120), v_body, v_url, 'chat:' || v_ch.id
    FROM public.chat_channel_members cm
   WHERE cm.channel_id = v_ch.id
     AND cm.user_id <> v_msg.author_id
     AND EXISTS (SELECT 1 FROM public.push_subscriptions s WHERE s.user_id = cm.user_id)
     AND (NOT cm.muted
          OR EXISTS (SELECT 1 FROM public.message_mentions mm
                      WHERE mm.message_id = v_msg.id AND mm.user_id = cm.user_id))
     AND public.push_eligible(cm.user_id, v_ch.account_id, 'chat_message')
     AND public.chat_user_can_read_channel(v_ch.id, cm.user_id, true);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'push: chat message % not queued: %', NEW.id, SQLERRM;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS push_on_chat_message ON public.internal_messages;
CREATE CONSTRAINT TRIGGER push_on_chat_message AFTER INSERT ON public.internal_messages
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.author_kind = 'user' AND public.push_chat_has_device(NEW.channel_id, NEW.author_id))
  EXECUTE FUNCTION public.push_on_chat_message();

-- ---------- 6. WhatsApp inbound ----------

-- Called by the inbound pipeline once the customer's message is stored
-- (after the idempotency boundary, so a replay never reaches it).
-- Returns how many pushes were queued; a message that is not a
-- customer's queues none.
CREATE OR REPLACE FUNCTION public.push_whatsapp_inbound(p_message_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n integer;
BEGIN
  WITH m AS (
    SELECT cv.id AS conversation_id, cv.account_id, cv.assigned_agent_id, cv.channel_id,
           coalesce(nullif(btrim(ct.name), ''), nullif(btrim(ct.phone), ''), 'WhatsApp') AS title,
           left(CASE
             WHEN msg.content_type IN ('image', 'video', 'audio', 'document', 'location', 'contacts') THEN
               CASE msg.content_type
                 WHEN 'image'    THEN '📷 Photo'
                 WHEN 'video'    THEN '🎥 Video'
                 WHEN 'audio'    THEN '🎤 Voice message'
                 WHEN 'document' THEN '📎 Document'
                 WHEN 'location' THEN '📍 Location'
                 ELSE '👤 Contact'
               END || coalesce(': ' || nullif(btrim(msg.content_text), ''), '')
             ELSE coalesce(nullif(btrim(msg.content_text), ''), '💬 Message')
           END, 140) AS body
      FROM public.messages msg
      JOIN public.conversations cv ON cv.id = msg.conversation_id
      LEFT JOIN public.contacts ct ON ct.id = cv.contact_id
     WHERE msg.id = p_message_id AND msg.sender_type = 'customer'
  ), allocated AS (
    SELECT w.user_id FROM m
      JOIN public.whatsapp_channel_members w ON w.config_id = m.channel_id AND w.account_id = m.account_id
  ), r AS (
    SELECT m.assigned_agent_id AS user_id FROM m WHERE m.assigned_agent_id IS NOT NULL
    UNION
    SELECT a.user_id FROM m, allocated a WHERE m.assigned_agent_id IS NULL
    UNION
    SELECT p.user_id FROM m
      JOIN public.profiles p ON p.account_id = m.account_id
     WHERE m.assigned_agent_id IS NULL AND NOT EXISTS (SELECT 1 FROM allocated)
       AND p.account_role IN ('owner', 'admin') AND p.deactivated_at IS NULL
  )
  INSERT INTO public.push_outbox (user_id, account_id, kind, title, body, url, tag)
  SELECT r.user_id, m.account_id, 'whatsapp_message', left(m.title, 120), m.body,
         '/inbox?c=' || m.conversation_id, 'wa:' || m.conversation_id
    FROM m, r
   WHERE public.push_eligible(r.user_id, m.account_id, 'whatsapp_message');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- ---------- 7. The dispatcher's RPCs ----------

-- Up to p_limit (1–500) unsent rows, oldest first, not claimed in the
-- last 2 minutes and tried fewer than 5 times; each is stamped claimed
-- and its attempts bumped. Concurrent dispatchers never share a row.
CREATE OR REPLACE FUNCTION public.push_claim(p_limit integer)
RETURNS SETOF public.push_outbox LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH c AS (
    SELECT o.id FROM public.push_outbox o
     WHERE o.sent_at IS NULL
       AND o.attempts < 5
       AND (o.claimed_at IS NULL OR o.claimed_at < now() - interval '2 minutes')
     ORDER BY o.created_at, o.id
     LIMIT least(greatest(coalesce(p_limit, 0), 0), 500)
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.push_outbox o SET claimed_at = now(), attempts = o.attempts + 1
    FROM c WHERE o.id = c.id
  RETURNING o.*
$$;

-- p_ok: sent (sent_at stamped). Otherwise the error is kept and the
-- claim left in place, so the row is retried after the 2-minute lease
-- (until its 5th attempt).
CREATE OR REPLACE FUNCTION public.push_settle(p_id bigint, p_ok boolean, p_error text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE public.push_outbox
     SET sent_at    = CASE WHEN p_ok THEN now() END,
         last_error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 500) END
   WHERE id = p_id AND sent_at IS NULL
$$;

-- Rows older than 2 days, sent or not. Returns how many went.
CREATE OR REPLACE FUNCTION public.push_purge()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n integer;
BEGIN
  DELETE FROM public.push_outbox WHERE created_at < now() - interval '2 days';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- ---------- 8. Function grants ----------

REVOKE ALL ON FUNCTION public.push_eligible(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.push_is_uuid(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.push_bell_url(public.notifications) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.push_on_notification() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.push_on_chat_message() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.push_chat_has_device(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.push_enqueue(uuid, uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.push_whatsapp_inbound(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.push_claim(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.push_settle(bigint, boolean, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.push_purge() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.push_enqueue(uuid, uuid, text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.push_whatsapp_inbound(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.push_claim(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.push_settle(bigint, boolean, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.push_purge() TO service_role;
