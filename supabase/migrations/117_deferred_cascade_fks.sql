-- ============================================================
-- 117_deferred_cascade_fks.sql — make the foreign keys a delete
-- can re-check mid-cascade order-proof (no change to any ON DELETE)
--
-- Deleting one row R can reach a row of table T by two paths at once:
--   f1  T → P, ON DELETE CASCADE / SET NULL, where P is itself
--       cascade-deleted from R (e.g. meeting_removed_users.meeting →
--       meetings, deleted through meetings.host_user_id → auth.users);
--   f2  T → R (or another row R cascade-deletes), ON DELETE SET NULL /
--       SET DEFAULT (meeting_removed_users.removed_by → auth.users).
-- f2's action is an UPDATE of T's row. Postgres skips the FK checks of
-- an UPDATE that leaves a key unchanged, except when the row was
-- inserted by the current transaction: then f1 is re-checked too. The
-- RI action triggers fire in trigger-name order (RI_ConstraintTrigger_
-- a_<oid>), i.e. creation order, and their own actions are queued
-- behind them. So when f2's trigger sorts first, f1 is re-checked
-- after P's row is gone but before f1's own action reaches T's row:
-- 23503 "violates foreign key constraint <f1>". A migration replay
-- creates the triggers in the safe order; a pg_dump restore creates
-- them in another, and there verify-calendar.sql's fixture (insert,
-- then delete the host, in one transaction) failed on
-- meeting_removed_users_meeting_fkey. Deletes in a later transaction
-- than the insert were never affected.
--
-- A DEFERRABLE INITIALLY DEFERRED f1 is checked at commit instead, by
-- which time the cascade has deleted (or nulled) the row and the check
-- is skipped. Only the check triggers change: Postgres never defers
-- the ON DELETE action triggers, so cascades and SET NULLs still run
-- inside the deleting statement, exactly as before.
--
-- The list is every constraint the catalog query in the commit that
-- added this file found on a database built from 001–115 (and on a
-- restored copy of a live install), less two left immediate on purpose:
-- conversations_chat_tag_fkey and conversations_chat_sub_tag_fkey are
-- the chat-tag account wall (075), whose 23503 the chat-tag writers
-- and verify-chat-tags.sql expect at the statement. Neither can fail
-- this way: deleting an account deletes its chats (account_id, one
-- step) before any SET NULL reaches them, and deleting a tag nulls
-- chat_tag_id in an UPDATE where conversations_chat_tag_guard (075)
-- also clears the sub-tag, so nothing is left to re-check.
-- A violation of a deferred FK now surfaces at COMMIT (one request is
-- one transaction under PostgREST, so callers still see 23503).
--
-- ALTER CONSTRAINT rewrites catalog rows only (no table scan), but it
-- takes an ACCESS EXCLUSIVE lock on each table listed, held until the
-- block commits — a moment, unless a long transaction already holds
-- one of them, when lock_timeout gives up after 5 s and nothing is
-- changed: run it again.
--
-- Re-runnable: a constraint already deferred, or absent, is skipped.
-- ============================================================

SET lock_timeout = '5s';

DO $$
DECLARE
  item text[];
BEGIN
  FOREACH item SLICE 1 IN ARRAY ARRAY[
    ['automation_pending_executions', 'automation_pending_executions_log_id_fkey'],
    ['automation_pending_executions', 'automation_pending_executions_parent_step_id_fkey'],
    ['callback_requests',             'callback_requests_journey_file_id_fkey'],
    ['callback_requests',             'callback_requests_outbox_item_id_fkey'],
    ['calls',                         'calls_contact_fkey'],
    ['calls',                         'calls_conversation_fkey'],
    ['calls',                         'calls_deal_id_fkey'],
    ['compass_notifications',         'compass_notifications_conversation_id_fkey'],
    ['compass_notifications',         'compass_notifications_message_id_fkey'],
    ['conversation_events',           'conversation_events_conversation_id_fkey'],
    ['conversation_events',           'conversation_events_from_channel_id_fkey'],
    ['conversation_events',           'conversation_events_to_channel_id_fkey'],
    ['deal_files',                    'deal_files_room_fkey'],
    ['deal_room_participants',        'deal_room_participants_consent_id_fkey'],
    ['deal_room_participants',        'deal_room_participants_room_fkey'],
    ['deal_rooms',                    'deal_rooms_deal_fkey'],
    ['flow_runs',                     'flow_runs_conversation_id_fkey'],
    ['flow_runs',                     'flow_runs_last_prompt_message_id_fkey'],
    ['group_message_receipts',        'group_message_receipts_message_id_fkey'],
    ['meeting_participants',          'meeting_participants_meeting_fkey'],
    ['meeting_removed_users',         'meeting_removed_users_meeting_fkey'],
    ['messages',                      'messages_conversation_id_fkey'],
    ['messages',                      'messages_reply_to_message_id_fkey'],
    ['notifications',                 'notifications_contact_id_fkey'],
    ['notifications',                 'notifications_conversation_id_fkey'],
    ['tasks',                         'tasks_contact_id_fkey'],
    ['tasks',                         'tasks_conversation_id_fkey'],
    ['tasks',                         'tasks_deal_id_fkey'],
    ['whatsapp_groups',               'whatsapp_groups_channel_fkey']
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE contype = 'f' AND conname = item[2]
        AND conrelid = to_regclass(format('public.%I', item[1]))
        AND NOT (condeferrable AND condeferred)
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ALTER CONSTRAINT %I DEFERRABLE INITIALLY DEFERRED',
                     item[1], item[2]);
    END IF;
  END LOOP;
END $$;
