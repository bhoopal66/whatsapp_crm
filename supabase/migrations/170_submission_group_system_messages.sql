-- ============================================================
-- 170_submission_group_system_messages.sql — automatic messages in a
-- submission group (115 / 136).
--
-- Until now every 'out' row of submission_group_messages had a staff
-- sender. Two automatic messages now go into the group:
--
--  * welcome        one per group, posted right after the WhatsApp
--                   group is created;
--  * status_update  the submission tracker's case updates
--                   (POST /api/v1/compass/notifications, one per
--                   idempotency key), which used to go out 1:1.
--
-- A system row is direction 'out' with sender_user_id NULL, system_kind
-- and system_key set, and prefixed_body = body (no name prefix). The
-- key is unique per group, so a retried call never posts twice.
--
-- Close hold: a group ENDED by a final status (end_reason
-- 'FINAL_STATUS:%' or 'CASE_%') stays open on WhatsApp for
-- sg_close_hold() (2 days) after ended_at, so the customer still gets
-- the last updates. The DB status is ENDED at once (case logic is
-- untouched); only status_update may still be posted in the hold,
-- never a welcome and never a staff message. Any other end reason
-- ('MANUAL', idle, ...) gets no hold. The app closes the WhatsApp group
-- only once sg_close_hold_until() is NULL or past now(), so the send
-- and the close share one rule on the database clock.
--
-- sg_send_begin_system(group, kind, key, body) -> jsonb:
--   {"id": n}                                  a new pending row
--   {"refused": "DUPLICATE", "id": n, "send_status": s}
--   {"refused": "<CODE>"}  BAD_INPUT, NOT_FOUND, NO_WHATSAPP_GROUP,
--     GROUP_NOT_READY, NUMBER_REMOVED, CONTACT_REMOVED, WA_CLOSED, ENDED
-- The row is then settled by 115's sg_settle_send like a staff send.
--
-- No read path changes: sg_settle_send, sg_fail_stale_pending,
-- sg_count_pending_out and sg_read_archive never join sender_user_id,
-- and the read policy does not look at it.
--
-- Must be applied as a superuser or BYPASSRLS role (115's rule).
-- Re-runnable.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '170 must be applied by a superuser or BYPASSRLS role (the sg_* functions read RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. Columns and shape ----------

ALTER TABLE public.submission_group_messages
  ADD COLUMN IF NOT EXISTS system_kind text NULL,
  ADD COLUMN IF NOT EXISTS system_key  text NULL;

COMMENT ON COLUMN public.submission_group_messages.system_kind IS
  'An automatic out row: welcome | status_update (sender_user_id NULL). NULL for staff and inbound rows. Migration 170.';
COMMENT ON COLUMN public.submission_group_messages.system_key IS
  'Idempotency key of an automatic out row, unique per group. Migration 170.';

ALTER TABLE public.submission_group_messages
  DROP CONSTRAINT IF EXISTS submission_group_messages_system_check;
ALTER TABLE public.submission_group_messages
  ADD CONSTRAINT submission_group_messages_system_check CHECK (
    (system_kind IS NULL) = (system_key IS NULL)
    AND (system_kind IS NULL OR (direction = 'out' AND system_kind IN ('welcome', 'status_update')))
    AND (system_key IS NULL
         OR (char_length(system_key) BETWEEN 1 AND 240 AND system_key !~ '^[[:space:]]*$')));

-- A staff out row keeps 115's rule; a system out row has no sender.
ALTER TABLE public.submission_group_messages
  DROP CONSTRAINT IF EXISTS submission_group_messages_out_attributed;
ALTER TABLE public.submission_group_messages
  ADD CONSTRAINT submission_group_messages_out_attributed CHECK (
    direction = 'in'
    OR (body IS NOT NULL AND prefixed_body IS NOT NULL
        AND sender_wa_id IS NULL AND sender_kind IS NULL
        AND ((sender_user_id IS NOT NULL AND system_kind IS NULL AND system_key IS NULL)
             OR (sender_user_id IS NULL AND system_kind IS NOT NULL AND system_key IS NOT NULL))));

CREATE UNIQUE INDEX IF NOT EXISTS submission_group_messages_system_key
  ON public.submission_group_messages (group_id, system_key)
  WHERE system_key IS NOT NULL;

-- ---------- 2. The close hold: one rule ----------

-- The hold, named once (the app pins it by reading this file).
CREATE OR REPLACE FUNCTION public.sg_close_hold()
RETURNS interval
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$ SELECT interval '2 days' $$;

-- End of the hold of a group in this state, else NULL (no hold). A
-- caller comparing it with now() must coalesce: NULL < x is NULL.
CREATE OR REPLACE FUNCTION public.sg_close_hold_end(p_status text, p_ended_at timestamptz, p_end_reason text)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_status = 'ENDED' AND p_ended_at IS NOT NULL
         AND (p_end_reason LIKE 'FINAL_STATUS:%' OR p_end_reason LIKE 'CASE\_%')
    THEN p_ended_at + public.sg_close_hold()
  END
$$;

-- ended_at + sg_close_hold() when the hold applies, else NULL. The app
-- closes the WhatsApp group only when this is NULL or past now().
CREATE OR REPLACE FUNCTION public.sg_close_hold_until(p_group uuid)
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.sg_close_hold_end(g.status, g.ended_at, g.end_reason)
    FROM public.submission_groups g WHERE g.id = p_group
$$;

-- ---------- 3. The insert guard: status_update in the hold ----------

-- 115's guard, plus: a status_update row may go into an ENDED group
-- while now() is inside its close hold.
CREATE OR REPLACE FUNCTION public.submission_group_messages_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_ended  timestamptz;
  v_reason text;
BEGIN
  IF NEW.direction = 'out' THEN
    IF NEW.send_status IS DISTINCT FROM 'pending' OR NEW.wa_message_id IS NOT NULL THEN
      RAISE EXCEPTION 'submission group message: an out row is inserted pending, without wa_message_id'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT g.status, g.ended_at, g.end_reason INTO v_status, v_ended, v_reason
      FROM public.submission_groups g WHERE g.id = NEW.group_id FOR SHARE;
    IF v_status IS DISTINCT FROM 'ACTIVE'
       AND NOT coalesce(NEW.system_kind = 'status_update'
                        AND now() < public.sg_close_hold_end(v_status, v_ended, v_reason), false) THEN
      RAISE EXCEPTION 'submission group % is %: sending refused', NEW.group_id, coalesce(v_status, 'missing')
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.post_end := false;
  ELSE
    SELECT g.status INTO v_status FROM public.submission_groups g WHERE g.id = NEW.group_id FOR NO KEY UPDATE;
    NEW.post_end := v_status IS DISTINCT FROM 'ACTIVE';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------- 4. sg_send_begin_system ----------

CREATE OR REPLACE FUNCTION public.sg_send_begin_system(p_group uuid, p_kind text, p_key text, p_body text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  g      public.submission_groups%ROWTYPE;
  v_id   bigint;
  v_send text;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('welcome', 'status_update')
     OR p_key IS NULL OR p_key ~ '^[[:space:]]*$' OR char_length(p_key) > 240
     OR p_body IS NULL OR p_body ~ '^[[:space:]]*$' THEN
    RETURN jsonb_build_object('refused', 'BAD_INPUT');
  END IF;
  -- sg_send_begin's lock: sg_end (FOR UPDATE) waits for this begin.
  SELECT * INTO g FROM public.submission_groups WHERE id = p_group FOR SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('refused', 'NOT_FOUND');
  END IF;
  SELECT m.id, m.send_status INTO v_id, v_send
    FROM public.submission_group_messages m WHERE m.group_id = p_group AND m.system_key = p_key;
  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('refused', 'DUPLICATE', 'id', v_id, 'send_status', v_send);
  END IF;
  IF g.wa_mode IS DISTINCT FROM 'group' THEN
    RETURN jsonb_build_object('refused', 'NO_WHATSAPP_GROUP');
  ELSIF g.wa_group_id IS NULL THEN
    RETURN jsonb_build_object('refused', 'GROUP_NOT_READY');
  ELSIF g.channel_id IS NULL THEN
    RETURN jsonb_build_object('refused', 'NUMBER_REMOVED');
  ELSIF g.contact_id IS NULL THEN
    RETURN jsonb_build_object('refused', 'CONTACT_REMOVED');
  ELSIF g.wa_closed_at IS NOT NULL THEN
    RETURN jsonb_build_object('refused', 'WA_CLOSED');
  ELSIF g.status <> 'ACTIVE'
        AND NOT coalesce(p_kind = 'status_update'
                         AND now() < public.sg_close_hold_end(g.status, g.ended_at, g.end_reason), false) THEN
    RETURN jsonb_build_object('refused', 'ENDED');
  END IF;
  -- A concurrent call with the same key: the loser inserts nothing.
  INSERT INTO public.submission_group_messages
    (group_id, account_id, direction, body, prefixed_body, send_status, system_kind, system_key)
  VALUES (p_group, g.account_id, 'out', p_body, p_body, 'pending', p_kind, p_key)
  ON CONFLICT (group_id, system_key) WHERE system_key IS NOT NULL DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT m.id, m.send_status INTO v_id, v_send
      FROM public.submission_group_messages m WHERE m.group_id = p_group AND m.system_key = p_key;
    RETURN jsonb_build_object('refused', 'DUPLICATE', 'id', v_id, 'send_status', v_send);
  END IF;
  RETURN jsonb_build_object('id', v_id);
END;
$$;

-- ---------- 5. Privileges ----------

REVOKE ALL ON FUNCTION
  public.sg_close_hold(),
  public.sg_close_hold_end(text, timestamptz, text),
  public.sg_close_hold_until(uuid),
  public.sg_send_begin_system(uuid, text, text, text),
  public.submission_group_messages_guard()
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.sg_close_hold_until(uuid),
  public.sg_send_begin_system(uuid, text, text, text)
  TO service_role;


-- ---------- 6. Compass notifications sent into a group ----------
-- A tracker update goes into the customer's submission group when there
-- is a live one (lib/compass/notify.ts). The log row then names the group
-- and its message instead of a 1:1 messages row.

ALTER TABLE public.compass_notifications
  ADD COLUMN IF NOT EXISTS submission_group_id uuid
    REFERENCES public.submission_groups(id) ON DELETE SET NULL;
ALTER TABLE public.compass_notifications
  ADD COLUMN IF NOT EXISTS group_message_id bigint;

COMMENT ON COLUMN public.compass_notifications.submission_group_id IS
  'Set when the update went into this submission group instead of the 1:1 chat (170).';
COMMENT ON COLUMN public.compass_notifications.group_message_id IS
  'submission_group_messages.id of the group post (170); no FK, the log outlives the message.';

RESET lock_timeout;
