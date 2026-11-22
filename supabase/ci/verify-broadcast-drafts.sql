-- Migrations 252 and 256: a draft's wizard state lives in
-- broadcast_drafts.state (jsonb, NOT NULL), no longer in
-- broadcasts.draft_state (256 dropped it: members could read it), and
-- the broadcasts write policies (135) still stop below admin. The
-- admin-only reads and writes of broadcast_drafts are asserted
-- behaviourally by verify-review-fixes.sql. ONE statement (a DO block).
DO $verify$
DECLARE
  v_type text;
  v_null text;
  v_policy text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'broadcasts'
       AND column_name = 'draft_state') THEN
    RAISE EXCEPTION 'broadcasts.draft_state still exists (256 moves it to broadcast_drafts)';
  END IF;

  SELECT data_type, is_nullable INTO v_type, v_null
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'broadcast_drafts'
     AND column_name = 'state';
  IF v_type IS DISTINCT FROM 'jsonb' THEN
    RAISE EXCEPTION 'broadcast_drafts.state missing or not jsonb (%)', v_type;
  END IF;
  IF v_null IS DISTINCT FROM 'NO' THEN
    RAISE EXCEPTION 'broadcast_drafts.state must be NOT NULL';
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
