-- 082_account_role_bank_guest.sql — a role for a partner bank's guest
--
-- Workspaces (083) let one person belong to several accounts. A bank
-- that works our cases gets `bank_guest` rows: a membership that sees
-- nothing of the existing tables (083 ranks it 0, keeps it out of
-- is_account_member and gives it no current_account_id()). What a guest
-- may see is added later, table by table, on purpose.
--
-- Its own file because a new enum value cannot be used in the
-- transaction that adds it, and 083 uses it.

ALTER TYPE public.account_role_enum ADD VALUE IF NOT EXISTS 'bank_guest';
