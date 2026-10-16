-- ============================================================
-- 117_deferred_cascade_fks.sql — make the meeting foreign keys a delete
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
-- Scope: only the two meeting foreign keys of that failure, on small,
-- low-traffic tables. A catalog walk finds ~29 other FKs with the same
-- two-path shape (messages, conversations, tasks, notifications, …),
-- but none can fail in real use (the re-check needs the row inserted in
-- the deleting transaction), and deferring FKs on the busiest tables
-- would take an ACCESS EXCLUSIVE lock on them at deploy and move a
-- genuine violation from the statement to COMMIT, where an EXCEPTION
-- block in a SQL function can no longer catch it. Add one here only
-- with a reproduction.
--
-- ALTER CONSTRAINT rewrites catalog rows only (no table scan), but it
-- takes an ACCESS EXCLUSIVE lock on the two tables, held until the
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
    ['meeting_participants',          'meeting_participants_meeting_fkey'],
    ['meeting_removed_users',         'meeting_removed_users_meeting_fkey']
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
