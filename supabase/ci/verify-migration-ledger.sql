-- Regression suite for migration 338 (the migration ledger that
-- scripts/apply-migrations.sh writes).
--
-- public.migration_ledger exists with RLS on and forced and no policies;
-- PUBLIC, anon, authenticated and service_role hold no privilege on it,
-- and a SELECT or INSERT as anon, authenticated or service_role is
-- refused; the migration role inserts a row, reads it back (applied_by
-- is the role, applied_at set), upserts it the way the script does, and
-- a malformed sha256 or file name is refused. Without 338 the first
-- check raises (no table). ONE statement on purpose, rolled back on
-- success (see verify-hr-automsg-rcs.sql).

DO $verify$
DECLARE
  t_name  CONSTANT text := '999_verify_migration_ledger.sql';
  rl      text;
  pv      text;
  r       record;
  c       text[] := '{}';
  failed  text[];
  n       int := 0;
BEGIN
  IF to_regclass('public.migration_ledger') IS NULL THEN
    RAISE EXCEPTION 'verify-migration-ledger: public.migration_ledger is missing (apply 338)';
  END IF;

  BEGIN
  -- 1. RLS on and forced, no policies.
  SELECT relrowsecurity, relforcerowsecurity INTO r
    FROM pg_class WHERE oid = 'public.migration_ledger'::regclass;
  c := c || CASE WHEN r.relrowsecurity AND r.relforcerowsecurity THEN NULL
                 ELSE 'RLS is not enabled and forced' END;
  c := c || CASE WHEN NOT EXISTS (SELECT 1 FROM pg_policies
                                   WHERE schemaname = 'public' AND tablename = 'migration_ledger')
                 THEN NULL ELSE 'the ledger has a policy' END;

  -- 2. No privilege for PUBLIC or the API roles.
  FOREACH rl IN ARRAY ARRAY['public', 'anon', 'authenticated', 'service_role'] LOOP
    IF rl <> 'public' AND to_regrole(rl) IS NULL THEN
      c := c || format('role %s does not exist', rl);
      CONTINUE;
    END IF;
    FOREACH pv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      c := c || CASE WHEN has_table_privilege(rl, 'public.migration_ledger', pv)
                     THEN format('%s holds %s', rl, pv) END;
    END LOOP;
  END LOOP;

  -- 3. The API roles are refused a read and a write. Each attempt runs in
  --    its own subtransaction, so the SET LOCAL ROLE ends with it.
  FOREACH rl IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    CONTINUE WHEN to_regrole(rl) IS NULL;
    BEGIN
      EXECUTE format('SET LOCAL ROLE %I', rl);
      PERFORM 1 FROM public.migration_ledger LIMIT 1;
      RAISE EXCEPTION 'read' USING ERRCODE = 'P0098';
    EXCEPTION
      WHEN insufficient_privilege THEN NULL;
      WHEN SQLSTATE 'P0098' THEN c := c || format('%s can read the ledger', rl);
    END;
    BEGIN
      EXECUTE format('SET LOCAL ROLE %I', rl);
      INSERT INTO public.migration_ledger (file_name, sha256) VALUES (t_name, repeat('c', 64));
      RAISE EXCEPTION 'write' USING ERRCODE = 'P0098';
    EXCEPTION
      WHEN insufficient_privilege THEN NULL;
      WHEN SQLSTATE 'P0098' THEN c := c || format('%s can write the ledger', rl);
    END;
  END LOOP;

  -- 4. The migration role writes and reads back (separate statements).
  INSERT INTO public.migration_ledger (file_name, sha256) VALUES (t_name, repeat('a', 64));
  SELECT * INTO r FROM public.migration_ledger WHERE file_name = t_name;
  c := c || CASE WHEN r.sha256 = repeat('a', 64) AND r.applied_by = current_user
                      AND r.applied_at IS NOT NULL
                 THEN NULL ELSE format('readback after insert: %s', row_to_json(r)) END;

  -- The script's upsert replaces the hash of an existing row.
  INSERT INTO public.migration_ledger (file_name, sha256) VALUES (t_name, repeat('b', 64))
  ON CONFLICT (file_name) DO UPDATE
    SET sha256 = EXCLUDED.sha256, applied_at = now(), applied_by = current_user;
  SELECT * INTO r FROM public.migration_ledger WHERE file_name = t_name;
  c := c || CASE WHEN r.sha256 = repeat('b', 64) THEN NULL
                 ELSE format('readback after upsert: %s', row_to_json(r)) END;
  c := c || CASE WHEN (SELECT count(*) FROM public.migration_ledger WHERE file_name = t_name) = 1
                 THEN NULL ELSE 'the upsert added a second row' END;

  -- 5. Malformed values are refused.
  BEGIN
    INSERT INTO public.migration_ledger (file_name, sha256) VALUES ('998_bad_hash.sql', 'XYZ');
    c := c || 'a malformed sha256 was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.migration_ledger (file_name, sha256) VALUES ('notes.txt', repeat('d', 64));
    c := c || 'a malformed file name was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  RAISE EXCEPTION 'verify-migration-ledger rollback' USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN
    NULL;
  END;

  n := cardinality(c);
  SELECT array_agg(x) INTO failed FROM unnest(c) x WHERE x IS NOT NULL;
  IF failed IS NOT NULL THEN
    RAISE EXCEPTION 'verify-migration-ledger: % of % checks failed: %', cardinality(failed), n,
      array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'verify-migration-ledger: all % checks passed', n;
END
$verify$;
