-- ============================================================
-- 338_migration_ledger.sql — a record of which supabase/migrations files
-- scripts/apply-migrations.sh applied to this database, with the sha256
-- of each file's bytes, so a later run can tell an unchanged file (fine:
-- the files are re-runnable) from one edited since it was applied (the
-- script stops unless ALLOW_DRIFT=1).
--
--  1. migration_ledger: one row per file name. The script upserts it
--     after the file applies (applied_at / applied_by are the LAST
--     apply). Nothing in the app reads or writes it.
--  2. Only a superuser or a BYPASSRLS role reads or writes it: RLS on
--     and forced, no policies, and no privilege for PUBLIC, anon,
--     authenticated or service_role (service_role has BYPASSRLS on
--     Supabase, so the revoke is what keeps it out).
--
-- Re-runnable. The script skips the ledger, with a note, while this
-- table does not exist, so it can apply this file itself; files applied
-- earlier in that same run are recorded once the table appears. Files
-- applied before the ledger existed have no row ("not recorded" in
-- `scripts/apply-migrations.sh --status`).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.migration_ledger (
  file_name  text PRIMARY KEY,
  sha256     text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by text NOT NULL DEFAULT current_user,
  CONSTRAINT migration_ledger_file_name_check CHECK (file_name ~ '^[0-9]{3}_.+\.sql$'),
  CONSTRAINT migration_ledger_sha256_check CHECK (sha256 ~ '^[0-9a-f]{64}$')
);
ALTER TABLE public.migration_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.migration_ledger FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.migration_ledger FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON TABLE public.migration_ledger IS
  'supabase/migrations files applied by scripts/apply-migrations.sh: name, sha256 of the file, last applied at / by. Superuser or BYPASSRLS only. Migration 338.';
