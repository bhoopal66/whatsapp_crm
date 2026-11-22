-- Migration 252: broadcasts.draft_state exists, is nullable jsonb, and the
-- write policies (135) still stop below admin. ONE statement (a DO block).
DO $verify$
DECLARE
  v_type text;
  v_null text;
  v_policy text;
BEGIN
  SELECT data_type, is_nullable INTO v_type, v_null
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'broadcasts'
     AND column_name = 'draft_state';
  IF v_type IS DISTINCT FROM 'jsonb' THEN
    RAISE EXCEPTION 'broadcasts.draft_state missing or not jsonb (%)', v_type;
  END IF;
  IF v_null IS DISTINCT FROM 'YES' THEN
    RAISE EXCEPTION 'broadcasts.draft_state must be nullable';
  END IF;

  FOR v_policy IN
    SELECT unnest(ARRAY['broadcasts_insert', 'broadcasts_update', 'broadcasts_delete'])
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'broadcasts'
         AND policyname = v_policy
    ) THEN
      RAISE EXCEPTION 'policy % missing on broadcasts', v_policy;
    END IF;
  END LOOP;
END
$verify$;
