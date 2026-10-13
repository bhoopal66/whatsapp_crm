-- 103_chat_call_cards.sql — call cards in team chat (plan 015 §7.3/§9)
--
-- "Share to chat" posts a card of a phone call into a team channel, a
-- private channel or a deal room's Team notes, on the pattern of 087's
-- shared conversation cards: a card row hangs off an internal message,
-- the sharer must be able to see the call, and what the card says is
-- re-checked at read time. Internal only: nothing here reaches the
-- customer, the WhatsApp chat or a deal room's WhatsApp group.
--
--  * Its own table, not a kind of shared_conversations: the two cards
--    have different access checks (pbx_can_view_call vs the inbox) and
--    different lifetimes, and 087's tested share policy stays as it is.
--  * No snapshot: the card reads the call live (chat_shared_call_cards).
--    So an outcome or note added after the share shows, and an erasure
--    (089's pbx_erase_contact_calls; calls_guard strips the number, file
--    and meta) can leave nothing behind in a card: an erased call's card
--    says only that the record was erased, to someone who may see the
--    call, and nothing at all to anyone else.
--  * Written only by chat_share_call(), a separate function so 087's
--    chat_post_message keeps its signature: it checks the call, then
--    posts through chat_post_message (mentions, bell, team autojoin and
--    every write check stay in one place) and adds the card, in one
--    transaction.
--  * Bank guests: no card where a guest member reads the messages (087's
--    test: a member whose channel role is guest, or whose current role
--    in the workspace is bank_guest). A deal room's Team notes are
--    staff-only (087), so a deal room with guest members is allowed:
--    its guests never read the post. DMs are not refused: they never
--    hold a guest (chat_open_dm), as for conversation cards; the picker
--    offers team and private channels and Team notes only.
--  * The card row goes when its message is deleted or erased (a trigger
--    on internal_messages, so 087's delete and erase functions stay as
--    they are), and with its call (FK, ON DELETE CASCADE).
--
-- Re-runnable: every statement is guarded or replaces in place.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '103 must be applied by a superuser or BYPASSRLS role (the chat functions own RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. The card table ----------

CREATE TABLE IF NOT EXISTS public.shared_calls (
  message_id uuid PRIMARY KEY REFERENCES public.internal_messages(id),
  call_id    uuid NOT NULL,
  account_id uuid NOT NULL,
  shared_by  uuid NOT NULL,
  shared_at  timestamptz NOT NULL DEFAULT now(),
  -- The call is in the card's (= the channel's) workspace.
  CONSTRAINT shared_calls_call_fkey FOREIGN KEY (call_id, account_id)
    REFERENCES public.calls (id, account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS shared_calls_call_idx ON public.shared_calls (call_id);

DROP TRIGGER IF EXISTS shared_calls_no_truncate ON public.shared_calls;
CREATE TRIGGER shared_calls_no_truncate BEFORE TRUNCATE ON public.shared_calls
  FOR EACH STATEMENT EXECUTE FUNCTION public.chat_block_truncate();

-- ---------- 2. Access helpers ----------

-- The calls SELECT policy (pbx_can_view_call: the caller's ACTIVE
-- account, and team leader and up, a party to the call, or able to see
-- its contact), for a call id.
CREATE OR REPLACE FUNCTION public.chat_can_view_call(p_call uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT auth.uid() IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.calls c WHERE c.id = p_call AND public.pbx_can_view_call(c))
$$;

-- The card row's read check (its RLS policy): the message is readable
-- and the caller may see the call now.
CREATE OR REPLACE FUNCTION public.chat_can_read_call_share(p_message uuid, p_call uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.chat_can_read_message(p_message) AND public.chat_can_view_call(p_call)
$$;

-- ---------- 3. Sharing ----------

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

  v_id := public.chat_post_message(p_channel, p_body, NULL, NULL, '[]'::jsonb);
  INSERT INTO public.shared_calls (message_id, call_id, account_id, shared_by)
  VALUES (v_id, p_call, v_ch.account_id, auth.uid());
  RETURN v_id;
END $$;

-- ---------- 4. Reading ----------

-- Call cards of messages the caller can read. Every reader learns that a
-- card is there; the call's details go only to a caller who may see the
-- call now (pbx_can_view_call, re-run here). Anyone else gets
-- can_open = false and NULLs. An erased call gives erased = true and no
-- details, even to someone who may see it. The customer's name and id
-- need the contact too (can_view_contact), as on the Calls screen: a
-- leader sees every call, and an agent the calls they took, without
-- seeing every customer; they get the masked number instead.
CREATE OR REPLACE FUNCTION public.chat_shared_call_cards(p_message_ids uuid[])
RETURNS TABLE (message_id uuid, can_open boolean, erased boolean, call_id uuid, direction text,
               status text, started_at timestamptz, talk_seconds integer, outcome text,
               notes text, agent_name text, contact_id uuid, contact_name text, phone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.message_id,
         v.ok,
         v.ok AND c.erased_at IS NOT NULL,
         CASE WHEN v.ok THEN s.call_id END,
         CASE WHEN x.show THEN c.direction END,
         CASE WHEN x.show THEN c.status END,
         CASE WHEN x.show THEN c.started_at END,
         CASE WHEN x.show THEN c.talk_seconds END,
         CASE WHEN x.show THEN c.disposition END,
         CASE WHEN x.show THEN left(c.notes, 280) END,
         CASE WHEN x.show THEN p.full_name END,
         CASE WHEN cv.see THEN ct.id END,
         CASE WHEN cv.see THEN ct.name END,
         CASE WHEN x.show THEN public.chat_mask_phone(c.remote_number) END
    FROM public.shared_calls s
    JOIN public.internal_messages m ON m.id = s.message_id
    JOIN public.calls c ON c.id = s.call_id
    CROSS JOIN LATERAL (SELECT public.pbx_can_view_call(c) AS ok) v
    CROSS JOIN LATERAL (SELECT v.ok AND c.erased_at IS NULL AS show) x
    LEFT JOIN public.contacts ct ON ct.id = c.contact_id AND ct.account_id = c.account_id
    LEFT JOIN public.profiles p ON p.user_id = c.user_id AND p.account_id = c.account_id
    CROSS JOIN LATERAL (SELECT x.show AND ct.id IS NOT NULL
                          AND public.can_view_contact(ct.account_id, ct.id, ct.user_id) AS see) cv
   WHERE s.message_id = ANY (coalesce(p_message_ids, '{}'))
     AND auth.uid() IS NOT NULL
     AND public.chat_user_can_read_channel(m.channel_id, auth.uid(), true)
   ORDER BY m.created_at, s.message_id
$$;

-- ---------- 5. A deleted or erased message takes its card ----------

CREATE OR REPLACE FUNCTION public.chat_drop_call_card()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM public.shared_calls WHERE message_id = NEW.id;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS internal_messages_drop_call_card ON public.internal_messages;
CREATE TRIGGER internal_messages_drop_call_card
  AFTER UPDATE OF deleted_at, erased_at ON public.internal_messages
  FOR EACH ROW
  WHEN ((NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL)
        OR (NEW.erased_at IS NOT NULL AND OLD.erased_at IS NULL))
  EXECUTE FUNCTION public.chat_drop_call_card();

-- ---------- 6. Row-level security (reads only; chat_share_call writes) ----------

ALTER TABLE public.shared_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shared_calls FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS shared_calls_read ON public.shared_calls;
CREATE POLICY shared_calls_read ON public.shared_calls
  FOR SELECT TO authenticated
  USING (public.chat_can_read_call_share(message_id, call_id));

-- ---------- 7. Privileges ----------

REVOKE ALL ON public.shared_calls FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.shared_calls TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.chat_can_view_call(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.chat_can_read_call_share(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.chat_share_call(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.chat_shared_call_cards(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.chat_drop_call_card() FROM PUBLIC, anon, authenticated, service_role;
-- authenticated: the client API, plus the helper the RLS policy calls.
GRANT EXECUTE ON FUNCTION public.chat_can_read_call_share(uuid, uuid), public.chat_share_call(uuid, uuid, text),
  public.chat_shared_call_cards(uuid[])
  TO authenticated;
