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
--    after the persist: the conversation's assignee if live and able to
--    see the chat, else the people allocated to its number
--    (whatsapp_channel_members) who are live and able to see it, else
--    the account's live owners and admins. Allocation grants no
--    visibility (072), so an allocated agent who cannot open the chat
--    is never sent its customer's name and words.
--    kind = whatsapp_message.
--
-- push_eligible is the one gate every writer applies: the person has a
-- device, has not switched push off or that kind off, and is live in
-- the account (a profile there not deactivated, workspace not
-- archived). Quiet hours are stored here but applied by the
-- dispatcher, which knows the clock at send time.
--
-- Access is asked twice: at enqueue, and again by push_claim at send
-- time (push_still_allowed), which settles a row its person may no
-- longer have as 'skipped: access revoked' instead of handing it out.
-- push_settle / push_release take the claimed_at push_claim returned,
-- so a pass that outlived its 2-minute lease cannot settle a row
-- another pass has claimed since. chat_erase_person (087) is redefined
-- here to delete the erased person's queued chat pushes.
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
  -- What push_claim re-checks at send time (a row can wait 12 h in
  -- quiet hours, or be retried): the chat of a whatsapp_message, the
  -- channel of a chat_message; and the chat message's author, whose
  -- queued words chat_erase_person deletes. Plain uuids, no FK: a row
  -- whose chat or channel is gone is skipped, not cascaded.
  conversation_id uuid,
  channel_id      uuid,
  source_user_id  uuid,
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

  INSERT INTO public.push_outbox (user_id, account_id, kind, title, body, url, tag, channel_id, source_user_id)
  SELECT cm.user_id, v_ch.account_id, 'chat_message', left(v_title, 120), v_body, v_url, 'chat:' || v_ch.id,
         v_ch.id, v_msg.author_id
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

-- can_view_conversation (072, the 5-argument form behind
-- conversations_select) asked for an explicit person instead of
-- auth.uid(), which is NULL on the service-role path that pushes. A
-- MIRROR of 072's CASE, branch for branch: admin/owner → everything;
-- not a member → nothing; owner or assignee of the chat → yes; a team
-- leader whose team holds the owner or the assignee (044's
-- leads_teammate) → yes. Change one, change both. The one deliberate
-- difference: is_account_member reads the person's ACTIVE row, and
-- this reads their live (not deactivated, not bank_guest) row in
-- p_account_id whether or not it is active, because a push reaches a
-- person in every workspace they work in (as the bell does) and they
-- see the chat once they switch to it. Private: no client grant.
CREATE OR REPLACE FUNCTION public.can_view_conversation_for_user(
  p_user_id     uuid,
  p_account_id  uuid,
  p_owner_id    uuid,
  p_assigned_id uuid
)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT CASE p.account_role
             WHEN 'owner'       THEN 5
             WHEN 'admin'       THEN 4
             WHEN 'team_leader' THEN 3
             WHEN 'agent'       THEN 2
             WHEN 'viewer'      THEN 1
           END AS rank
      FROM public.profiles p
     WHERE p.user_id = p_user_id
       AND p.account_id = p_account_id
       AND p.deactivated_at IS NULL
       AND p.account_role <> 'bank_guest'
  )
  SELECT CASE
    WHEN p_user_id IS NULL THEN FALSE
    WHEN coalesce((SELECT rank FROM me), 0) >= 4 THEN TRUE
    WHEN NOT EXISTS (SELECT 1 FROM me) THEN FALSE
    WHEN coalesce(p_owner_id = p_user_id, FALSE)
      OR coalesce(p_assigned_id = p_user_id, FALSE) THEN TRUE
    WHEN coalesce((SELECT rank FROM me), 0) >= 3
      AND EXISTS (
        SELECT 1
          FROM public.teams t
          JOIN public.team_members tm ON tm.team_id = t.id
         WHERE t.account_id = p_account_id
           AND t.leader_user_id = p_user_id
           AND tm.user_id IN (p_owner_id, p_assigned_id)
      ) THEN TRUE
    ELSE FALSE
  END
$$;

-- Called by the inbound pipeline once the customer's message is stored
-- (after the idempotency boundary, so a replay never reaches it).
-- Returns how many pushes were queued; a message that is not a
-- customer's queues none.
CREATE OR REPLACE FUNCTION public.push_whatsapp_inbound(p_message_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n integer;
BEGIN
  WITH m AS (
    SELECT cv.id AS conversation_id, cv.account_id, cv.user_id AS owner_id, cv.assigned_agent_id, cv.channel_id,
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
  -- Each tier is the people who should hear of it: live in the account
  -- and able to see the chat (can_view_conversation_for_user checks
  -- both). Whether they have a device is push_eligible's question,
  -- asked last, so a tier never falls through to the next for want of
  -- one.
  ), assignee AS (
    SELECT m.assigned_agent_id AS user_id FROM m
     WHERE m.assigned_agent_id IS NOT NULL
       AND public.can_view_conversation_for_user(m.assigned_agent_id, m.account_id, m.owner_id, m.assigned_agent_id)
  ), allocated AS (
    SELECT w.user_id FROM m
      JOIN public.whatsapp_channel_members w ON w.config_id = m.channel_id AND w.account_id = m.account_id
     WHERE NOT EXISTS (SELECT 1 FROM assignee)
       AND public.can_view_conversation_for_user(w.user_id, m.account_id, m.owner_id, m.assigned_agent_id)
  ), r AS (
    SELECT a.user_id FROM assignee a
    UNION
    SELECT a.user_id FROM allocated a
    UNION
    SELECT p.user_id FROM m
      JOIN public.profiles p ON p.account_id = m.account_id
     WHERE NOT EXISTS (SELECT 1 FROM assignee) AND NOT EXISTS (SELECT 1 FROM allocated)
       AND p.account_role IN ('owner', 'admin') AND p.deactivated_at IS NULL
  )
  INSERT INTO public.push_outbox (user_id, account_id, kind, title, body, url, tag, conversation_id)
  SELECT r.user_id, m.account_id, 'whatsapp_message', left(m.title, 120), m.body,
         '/inbox?c=' || m.conversation_id, 'wa:' || m.conversation_id, m.conversation_id
    FROM m, r
   WHERE public.can_view_conversation_for_user(r.user_id, m.account_id, m.owner_id, m.assigned_agent_id)
     AND public.push_eligible(r.user_id, m.account_id, 'whatsapp_message');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- ---------- 7. The dispatcher's RPCs ----------

-- Would row o still be sent to its person? Asked again at claim time,
-- because access can be lost while a row waits (quiet hours hold it up
-- to 12 h; a failure retries it): push_eligible for every kind (live in
-- the account, device, preferences), and on top for whatsapp_message
-- that the person can still see the chat as it is now (its current
-- owner and assignee), for chat_message that they are still a member
-- of the channel and may read its messages (the chat trigger's test).
-- A row missing its conversation or channel id fails.
CREATE OR REPLACE FUNCTION public.push_still_allowed(o public.push_outbox)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.push_eligible(o.user_id, o.account_id, o.kind)
     AND CASE o.kind
           WHEN 'whatsapp_message' THEN EXISTS (
             SELECT 1 FROM public.conversations cv
              WHERE cv.id = o.conversation_id AND cv.account_id = o.account_id
                AND public.can_view_conversation_for_user(o.user_id, o.account_id, cv.user_id, cv.assigned_agent_id))
           WHEN 'chat_message' THEN EXISTS (
             SELECT 1 FROM public.chat_channel_members cm
               JOIN public.chat_channels ch ON ch.id = cm.channel_id
              WHERE cm.channel_id = o.channel_id AND cm.user_id = o.user_id AND ch.account_id = o.account_id)
             AND coalesce(public.chat_user_can_read_channel(o.channel_id, o.user_id, true), false)
           ELSE true
         END
$$;

-- Up to p_limit (1–500) unsent rows, oldest first, not claimed in the
-- last 2 minutes and tried fewer than 5 times; each is stamped claimed
-- and its attempts bumped. Concurrent dispatchers never share a row.
-- A picked row whose person may no longer have it (push_still_allowed)
-- is settled in the same statement (sent_at stamped, last_error
-- 'skipped: access revoked') and not returned, so a batch can come
-- back shorter than the rows it took.
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
  ), j AS (   -- judged only for the rows taken, not every unsent one
    SELECT o.id, public.push_still_allowed(o) AS allowed
      FROM public.push_outbox o JOIN c ON c.id = o.id
  ), skipped AS (
    UPDATE public.push_outbox o SET sent_at = now(), last_error = 'skipped: access revoked'
      FROM j WHERE o.id = j.id AND NOT j.allowed
    RETURNING o.id
  )
  UPDATE public.push_outbox o SET claimed_at = now(), attempts = o.attempts + 1
    FROM j WHERE o.id = j.id AND j.allowed
  RETURNING o.*
$$;

-- p_ok: sent (sent_at stamped). Otherwise the error is kept and the
-- claim left in place, so the row is retried after the 2-minute lease
-- (until its 5th attempt). With p_claimed_at (the claimed_at push_claim
-- returned) the row is settled only while that claim still holds: a
-- pass that outlived its lease, whose row another pass has claimed
-- since, changes nothing. True when the row was settled.
DROP FUNCTION IF EXISTS public.push_settle(bigint, boolean, text);
CREATE OR REPLACE FUNCTION public.push_settle(
  p_id bigint, p_ok boolean, p_error text, p_claimed_at timestamptz DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.push_outbox
     SET sent_at    = CASE WHEN p_ok THEN now() END,
         last_error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 500) END
   WHERE id = p_id AND sent_at IS NULL
     AND (p_claimed_at IS NULL OR claimed_at = p_claimed_at);
  RETURN FOUND;
END $$;

-- Hand back a claimed row a pass never reached (out of time): unclaimed
-- and its attempt not counted, so the next pass takes it at once. Only
-- while the claim is still the caller's. True when it was released.
CREATE OR REPLACE FUNCTION public.push_release(p_id bigint, p_claimed_at timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.push_outbox
     SET claimed_at = NULL, attempts = greatest(attempts - 1, 0)
   WHERE id = p_id AND sent_at IS NULL AND claimed_at = p_claimed_at;
  RETURN FOUND;
END $$;

-- Rows older than 2 days, sent or not. Returns how many went.
CREATE OR REPLACE FUNCTION public.push_purge()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n integer;
BEGIN
  DELETE FROM public.push_outbox WHERE created_at < now() - interval '2 days';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- ---------- 8. Chat erasure reaches the outbox ----------

-- 087's chat_erase_person, byte for byte, plus the push_outbox DELETE
-- before the audit row. 109 redefines it: a later change starts from
-- here. Replacing keeps 087's owner (the table owner, which the
-- chat.erase history DELETE needs) and grants.
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

  -- 109: queued team-chat pushes, sent or not, that carry the person's
  -- words, and the person's own.
  DELETE FROM public.push_outbox
   WHERE account_id = p_ws AND kind = 'chat_message'
     AND (source_user_id = p_user_id OR user_id = p_user_id);

  INSERT INTO public.chat_audit_log (account_id, actor_id, action, detail)
  VALUES (p_ws, auth.uid(), 'erase_person',
          jsonb_build_object('user_id', p_user_id, 'reason', btrim(p_reason),
                             'messages', v_msgs, 'attachments', cardinality(v_paths)));
  RETURN v_paths;
END $$;

-- ---------- 9. Function grants ----------

REVOKE ALL ON FUNCTION public.push_eligible(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.push_is_uuid(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.push_bell_url(public.notifications) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.push_on_notification() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.push_on_chat_message() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.push_chat_has_device(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.push_enqueue(uuid, uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.push_whatsapp_inbound(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.can_view_conversation_for_user(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.push_claim(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.push_still_allowed(public.push_outbox) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.push_settle(bigint, boolean, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.push_release(bigint, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.push_purge() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.push_enqueue(uuid, uuid, text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.push_whatsapp_inbound(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.push_claim(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.push_settle(bigint, boolean, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.push_release(bigint, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.push_purge() TO service_role;
