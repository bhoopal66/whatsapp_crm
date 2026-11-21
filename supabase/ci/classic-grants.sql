-- CI only: the default privileges a classic Supabase project gives the
-- API roles on objects `postgres` creates in `public`.
--
-- The production projects were created with these defaults, so every
-- table a migration creates is reachable by `anon`, `authenticated` and
-- `service_role`, and RLS (not grants) decides what each row shows. The
-- migrations rely on that: most create a table and its policies without
-- a GRANT. The CLI's current Postgres image no longer sets these
-- defaults (new tables give the API roles no SELECT, INSERT, UPDATE or
-- DELETE), so without this file a replay is a database production never
-- had and the verify files fail on "permission denied for table ...".
--
-- Applied by .github/workflows/migrations.yml before the first
-- migration. Never apply it to a real project.

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
