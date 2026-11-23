-- 274: a bell for a customer's or bank's message in a deal room (TC2).
--
-- Nothing rang on an inbound group_messages row, so the group's 24-hour
-- window could close with the message unseen. Modelled on 173's
-- submission_group_message:
--  1. notifications.type gains 'deal_room_message' (the list is read from
--     the live constraint, as 266 does, never restated).
--  2. push_bell_url opens the room. Its body is patched in place, so no
--     later restatement is undone by re-applying this file; change it
--     together with hrefFor in src/lib/notifications/target.ts.
--  3. The trigger: one unread bell per person per room. The room's screen
--     marks it read (src/lib/deal-rooms/bells.ts); until then further
--     messages add none.
--
-- Re-runnable. No client grant.

-- ---------- 1. The type ----------

DO $$
DECLARE
  v_def  text;
  v_list text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.notifications'::regclass AND conname = 'notifications_type_check';
  IF v_def IS NULL THEN
    RAISE EXCEPTION '274: notifications_type_check is missing';
  END IF;
  IF position(quote_literal('deal_room_message') IN v_def) = 0 THEN
    SELECT string_agg(quote_literal(x), ', ') INTO v_list
      FROM (SELECT DISTINCT q.m[1] AS x FROM regexp_matches(v_def, '''([^'']+)''', 'g') AS q(m)
            UNION
            SELECT 'deal_room_message') vals;
    ALTER TABLE public.notifications DROP CONSTRAINT notifications_type_check;
    EXECUTE format('ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (%s)) NOT VALID',
                   v_list);
    ALTER TABLE public.notifications VALIDATE CONSTRAINT notifications_type_check;
  END IF;
END $$;

-- ---------- 2. Where a push opens ----------

DO $$
DECLARE
  v_fn  text := pg_get_functiondef('public.push_bell_url(public.notifications)'::regprocedure);
  v_old text := '(''deal_room_join_request'', ''deal_room_update'')';
BEGIN
  IF position('deal_room_message' IN v_fn) = 0 THEN
    IF position(v_old IN v_fn) = 0 THEN
      RAISE EXCEPTION '274: push_bell_url has no deal room branch to extend';
    END IF;
    EXECUTE replace(v_fn, v_old, '(''deal_room_join_request'', ''deal_room_update'', ''deal_room_message'')');
  END IF;
END $$;

-- ---------- 3. The bell ----------

-- lock_timeout: a blocked notifications must not stall the inbound insert
-- (see 173). Never fails the insert.
CREATE OR REPLACE FUNCTION public.deal_room_ring_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '1s'
AS $$
BEGIN
  BEGIN
    -- Our own number is the 'business' participant.
    IF EXISTS (SELECT 1 FROM public.deal_room_participants p
                WHERE p.id = NEW.sender_participant_id AND p.role = 'business') THEN
      RETURN NULL;
    END IF;

    -- The room's subject, never NEW.body: a bell and its push show on a
    -- lock screen. A cancelled room is 'failed' (096).
    INSERT INTO public.notifications (account_id, user_id, type, title, body, meta)
    SELECT r.account_id, w.user_id, 'deal_room_message',
           'New message in a deal room', r.subject,
           jsonb_build_object('room_id', r.id, 'channel_id', r.channel_id)
      FROM public.deal_rooms r
      CROSS JOIN LATERAL (
        SELECT m.user_id FROM public.chat_channel_members m
         WHERE m.channel_id = r.channel_id
           AND public.deal_room_is_staff(r.account_id, m.user_id)
        UNION
        -- Who opened it, while their role still shows it to them: an agent
        -- who left the room's channel can no longer open it.
        SELECT p.user_id FROM public.profiles p
         WHERE p.user_id = r.created_by AND p.account_id = r.account_id
           AND p.deactivated_at IS NULL
           AND p.account_role::text IN ('owner', 'admin', 'team_leader')) w
     WHERE r.id = NEW.room_id AND r.account_id = NEW.account_id
       AND r.status NOT IN ('failed', 'closed')
       AND NOT EXISTS (
         SELECT 1 FROM public.notifications n
          WHERE n.user_id = w.user_id
            AND n.read_at IS NULL
            AND n.account_id = r.account_id
            AND n.type = 'deal_room_message'
            AND n.meta ->> 'room_id' = r.id::text);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'deal_room_ring_message: room %: % (%)', NEW.room_id, SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.deal_room_ring_message() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.deal_room_ring_message() IS
  'AFTER INSERT on group_messages: one unread deal_room_message bell per person per room for an inbound message, to the live staff in the room''s channel and whoever opened it. A redelivered message inserts no row, so it rings nobody.';

DROP TRIGGER IF EXISTS group_messages_ring ON public.group_messages;
CREATE TRIGGER group_messages_ring
  AFTER INSERT ON public.group_messages
  FOR EACH ROW
  WHEN (NEW.direction = 'in')
  EXECUTE FUNCTION public.deal_room_ring_message();

DO $$
BEGIN
  IF (SELECT pg_get_constraintdef(oid) NOT LIKE '%deal_room_message%' OR NOT convalidated FROM pg_constraint
       WHERE conrelid = 'public.notifications'::regclass AND conname = 'notifications_type_check')
     OR pg_get_functiondef('public.push_bell_url(public.notifications)'::regprocedure) NOT LIKE '%deal_room_message%'
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.group_messages'::regclass
                      AND tgname = 'group_messages_ring' AND tgenabled = 'O') THEN
    RAISE EXCEPTION '274 did not apply completely';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
