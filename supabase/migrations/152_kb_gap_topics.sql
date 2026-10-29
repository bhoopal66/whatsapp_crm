-- ============================================================
-- 152: knowledge-gap topics
--
-- Every question the AI bot could not answer lands in
-- ai_knowledge_gaps (052), one row per question. Reviewed as a flat
-- list that is dozens of near-identical rows; reviewed as topics it is
-- "POS without a trade licence x37". The grouping, Jev's intent and
-- "is it covered by an approved answer" judgments, and the carry-over
-- of an admin's dismissal into a recompute are all decided in
-- TypeScript (src/lib/kb/gap-topics.ts, carryOverStatus). This
-- migration only stores the result:
--
--   kb_gap_topics        one row per topic, per account
--   kb_gap_topic_members which gaps a topic groups
--
-- Writers. A recompute replaces an account's whole topic set through
-- kb_gap_topics_replace() (service role only), in one transaction under
-- a per-account advisory lock: a failed insert leaves the previous
-- topics in place, and two recomputes never interleave. The recompute
-- passes the statuses it read before working (p_expected); if a person
-- dismissed or reopened a topic meanwhile, or the set changed, the call
-- refuses (40001, HINT STALE) and the recompute carries the new
-- statuses over and tries again. The one thing a
-- person changes is a topic's status (dismiss / reopen), through
-- kb_gap_topic_set_status(); there is no client INSERT, UPDATE or
-- DELETE policy or grant.
--
-- Readers. Admin+ of the topic's account, the same rule as the gaps
-- themselves (052): customer questions are conversation content and the
-- review is a settings-class task.
--
-- Same account by construction. Every reference is a composite FK on
-- (id, account_id) (the 062 idiom), so a topic can never group another
-- account's gap or point at another account's approved answer, whatever
-- the recompute passes in. That needs UNIQUE (id, account_id) on
-- ai_knowledge_gaps and kb_entries, added here when missing. Deleting a
-- gap drops its member rows; deleting an approved answer nulls
-- covered_by_entry_id only (the column list on SET NULL keeps
-- account_id).
--
-- Re-runnable: CREATE ... IF NOT EXISTS, guarded constraints, CREATE OR
-- REPLACE, DROP POLICY IF EXISTS.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Composite-FK targets
-- ------------------------------------------------------------
-- Guarded by column set, not name: any unique or primary key on exactly
-- (id, account_id) already serves a composite FK.
DO $$
DECLARE
  t regclass;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.ai_knowledge_gaps'::regclass,
                           'public.kb_entries'::regclass]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint c
      WHERE c.conrelid = t
        AND c.contype IN ('u', 'p')
        AND c.conkey @> ARRAY[
              (SELECT attnum FROM pg_attribute WHERE attrelid = t AND attname = 'id'),
              (SELECT attnum FROM pg_attribute WHERE attrelid = t AND attname = 'account_id')]
        AND array_length(c.conkey, 1) = 2
    ) THEN
      EXECUTE format(
        'ALTER TABLE %s ADD CONSTRAINT %I UNIQUE (id, account_id)',
        t, (SELECT relname FROM pg_class WHERE oid = t) || '_id_account_id_key');
    END IF;
  END LOOP;
END
$$;

-- ------------------------------------------------------------
-- 2. Topics
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kb_gap_topics (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  label               text NOT NULL,
  intent              text NULL,
  question_count      integer NOT NULL,
  first_seen_at       timestamptz NOT NULL,
  last_seen_at        timestamptz NOT NULL,
  coverage            text NOT NULL DEFAULT 'unknown',
  covered_by_entry_id uuid NULL,
  coverage_p          real NULL,
  status              text NOT NULL DEFAULT 'open',
  dismissed_at        timestamptz NULL,
  computed_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kb_gap_topics_id_account_id_key UNIQUE (id, account_id),
  CONSTRAINT kb_gap_topics_label_check CHECK (
    char_length(label) BETWEEN 1 AND 500 AND label !~ '^[[:space:]]*$'),
  CONSTRAINT kb_gap_topics_intent_check CHECK (
    intent IS NULL OR char_length(intent) <= 64),
  CONSTRAINT kb_gap_topics_question_count_check CHECK (question_count >= 0),
  CONSTRAINT kb_gap_topics_seen_check CHECK (first_seen_at <= last_seen_at),
  CONSTRAINT kb_gap_topics_coverage_check CHECK (
    coverage IN ('unknown', 'none', 'partial', 'full')),
  CONSTRAINT kb_gap_topics_coverage_p_check CHECK (
    coverage_p IS NULL OR (coverage_p >= 0 AND coverage_p <= 1)),
  CONSTRAINT kb_gap_topics_status_check CHECK (status IN ('open', 'dismissed')),
  CONSTRAINT kb_gap_topics_dismissed_check CHECK (
    (status = 'dismissed') = (dismissed_at IS NOT NULL)),
  -- The column list keeps account_id when the answer is deleted.
  CONSTRAINT kb_gap_topics_covered_by_entry_fkey
    FOREIGN KEY (covered_by_entry_id, account_id)
    REFERENCES public.kb_entries (id, account_id)
    ON DELETE SET NULL (covered_by_entry_id)
);

COMMENT ON TABLE public.kb_gap_topics IS
  'Knowledge-gap topics (152): ai_knowledge_gaps grouped by src/lib/kb/gap-topics.ts. Written only by kb_gap_topics_replace() (service role) and kb_gap_topic_set_status(); admin+ read.';
COMMENT ON COLUMN public.kb_gap_topics.label IS
  'The representative question (the medoid), raw customer text as the gaps list shows it (not redacted), clipped to 500 characters by the recompute.';
COMMENT ON COLUMN public.kb_gap_topics.intent IS
  'Jev''s intent judgment for the topic, NULL when not judged.';
COMMENT ON COLUMN public.kb_gap_topics.coverage IS
  'Whether an approved answer (kb_entries) covers the topic: unknown until judged.';
COMMENT ON COLUMN public.kb_gap_topics.covered_by_entry_id IS
  'The approved answer judged to cover it; nulled when that answer is deleted.';
COMMENT ON COLUMN public.kb_gap_topics.coverage_p IS
  'The coverage judgment''s probability, 0..1.';
COMMENT ON COLUMN public.kb_gap_topics.dismissed_at IS
  'Set exactly while status = dismissed; carried over a recompute by carryOverStatus().';

CREATE INDEX IF NOT EXISTS idx_kb_gap_topics_account_status_count
  ON public.kb_gap_topics (account_id, status, question_count DESC);

-- ------------------------------------------------------------
-- 3. Members
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kb_gap_topic_members (
  topic_id   uuid NOT NULL,
  account_id uuid NOT NULL,
  gap_id     uuid NOT NULL,
  PRIMARY KEY (topic_id, gap_id),
  CONSTRAINT kb_gap_topic_members_topic_fkey
    FOREIGN KEY (topic_id, account_id)
    REFERENCES public.kb_gap_topics (id, account_id) ON DELETE CASCADE,
  CONSTRAINT kb_gap_topic_members_gap_fkey
    FOREIGN KEY (gap_id, account_id)
    REFERENCES public.ai_knowledge_gaps (id, account_id) ON DELETE CASCADE
);

COMMENT ON TABLE public.kb_gap_topic_members IS
  'Which ai_knowledge_gaps rows a kb_gap_topics row groups (152). Same-account composite FKs; a deleted gap or topic drops its rows.';

-- Deleting a gap looks its member rows up by gap.
CREATE INDEX IF NOT EXISTS idx_kb_gap_topic_members_gap
  ON public.kb_gap_topic_members (gap_id, account_id);

-- ------------------------------------------------------------
-- 4. RLS and grants
-- ------------------------------------------------------------
ALTER TABLE public.kb_gap_topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kb_gap_topic_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kb_gap_topics_select ON public.kb_gap_topics;
CREATE POLICY kb_gap_topics_select ON public.kb_gap_topics FOR SELECT
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS kb_gap_topic_members_select ON public.kb_gap_topic_members;
CREATE POLICY kb_gap_topic_members_select ON public.kb_gap_topic_members FOR SELECT
  USING (is_account_member(account_id, 'admin'));

-- No client write policy, and no client write grant either (the
-- platform's default privileges would otherwise grant them).
REVOKE ALL ON public.kb_gap_topics, public.kb_gap_topic_members FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.kb_gap_topics, public.kb_gap_topic_members TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.kb_gap_topics, public.kb_gap_topic_members TO service_role;

-- ------------------------------------------------------------
-- 5. Dismiss / reopen (a person)
-- ------------------------------------------------------------
-- The caller must be a live admin+ of the topic's account and have it
-- active: is_account_member() reads only the active, live, non-guest
-- profile row (083). A missing topic and someone else's are the same
-- 42501, so the answer does not say which ids exist. Re-dismissing a
-- dismissed topic keeps its dismissed_at: carryOverStatus counts the
-- questions that arrived after it. Takes the recompute's lock, so a
-- status change never lands inside a replace.
CREATE OR REPLACE FUNCTION public.kb_gap_topic_set_status(
  p_topic  uuid,
  p_status text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account uuid;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('open', 'dismissed') THEN
    RAISE EXCEPTION 'unknown topic status: %', p_status USING ERRCODE = '22023';
  END IF;

  SELECT account_id INTO v_account FROM kb_gap_topics WHERE id = p_topic;
  IF v_account IS NULL OR NOT is_account_member(v_account, 'admin') THEN
    RAISE EXCEPTION 'not allowed to manage this topic' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('kb_gap_topics:' || v_account));

  UPDATE kb_gap_topics
  SET status = p_status,
      dismissed_at = CASE
        WHEN p_status = 'open' THEN NULL
        WHEN status = 'dismissed' THEN dismissed_at
        ELSE now()
      END
  WHERE id = p_topic AND account_id = v_account;

  -- A recompute replaced the topic while we waited for the lock.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not allowed to manage this topic' USING ERRCODE = '42501';
  END IF;
END
$$;

COMMENT ON FUNCTION public.kb_gap_topic_set_status(uuid, text) IS
  'Dismiss or reopen a knowledge-gap topic (152). Admin+ of the topic''s account, active workspace only; 22023 unknown status, 42501 otherwise refused.';

REVOKE ALL ON FUNCTION public.kb_gap_topic_set_status(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kb_gap_topic_set_status(uuid, text) TO authenticated;

-- ------------------------------------------------------------
-- 6. Replace an account's topics (the recompute)
-- ------------------------------------------------------------
-- The signature gained p_expected while 152 was unreleased; drop the
-- two-argument form so a re-run never leaves an unchecked overload.
DROP FUNCTION IF EXISTS public.kb_gap_topics_replace(uuid, jsonb);

-- p_topics is a JSON array of
--   { label, intent, question_count, first_seen_at, last_seen_at,
--     coverage, covered_by_entry_id, coverage_p, status, dismissed_at,
--     gap_ids: [uuid] }
-- coverage defaults to 'unknown' and status to 'open' when absent;
-- every other rule is the tables' CHECKs and FKs. A covered_by_entry_id
-- naming an answer that no longer exists anywhere (deleted while the
-- recompute ran) is stored as NULL; one that exists in another account
-- still fails the FK. Every row is written
-- with account_id = p_account, so the composite FKs refuse a gap or an
-- answer of another account (23503). One function call is one
-- transaction: any failure undoes the DELETE as well. Returns the number
-- of topics inserted. Topic ids are new on every call.
--
-- p_expected is the account's topics as the caller read them, a JSON
-- object { "<topic id>": "<status>" } ('{}' for none). Under the lock,
-- if the stored set differs (a topic's status changed, or a topic was
-- added or removed) the call raises 40001 with HINT 'STALE' and changes
-- nothing: a dismissal made while a recompute was working is never lost.
CREATE OR REPLACE FUNCTION public.kb_gap_topics_replace(
  p_account  uuid,
  p_topics   jsonb,
  p_expected jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_elem  jsonb;
  v_topic uuid;
  v_count integer := 0;
  v_entry uuid;
BEGIN
  IF p_account IS NULL THEN
    RAISE EXCEPTION 'p_account is required' USING ERRCODE = '22023';
  END IF;
  IF p_topics IS NULL OR jsonb_typeof(p_topics) <> 'array' THEN
    RAISE EXCEPTION 'p_topics must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF p_expected IS NULL OR jsonb_typeof(p_expected) <> 'object' THEN
    RAISE EXCEPTION 'p_expected must be a JSON object' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('kb_gap_topics:' || p_account));

  IF (SELECT coalesce(jsonb_object_agg(id::text, status), '{}'::jsonb)
      FROM kb_gap_topics WHERE account_id = p_account) IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'the account''s topics changed since they were read'
      USING ERRCODE = '40001', HINT = 'STALE';
  END IF;

  DELETE FROM kb_gap_topics WHERE account_id = p_account;

  FOR v_elem IN SELECT e FROM jsonb_array_elements(p_topics) AS t(e)
  LOOP
    IF jsonb_typeof(v_elem) <> 'object'
       OR (v_elem ? 'gap_ids' AND jsonb_typeof(v_elem->'gap_ids') NOT IN ('array', 'null')) THEN
      RAISE EXCEPTION 'each topic must be an object whose gap_ids is an array'
        USING ERRCODE = '22023';
    END IF;

    v_entry := (v_elem->>'covered_by_entry_id')::uuid;
    IF v_entry IS NOT NULL AND NOT EXISTS (SELECT 1 FROM kb_entries WHERE id = v_entry) THEN
      v_entry := NULL;
    END IF;

    INSERT INTO kb_gap_topics (
      account_id, label, intent, question_count, first_seen_at, last_seen_at,
      coverage, covered_by_entry_id, coverage_p, status, dismissed_at
    ) VALUES (
      p_account,
      v_elem->>'label',
      v_elem->>'intent',
      (v_elem->>'question_count')::integer,
      (v_elem->>'first_seen_at')::timestamptz,
      (v_elem->>'last_seen_at')::timestamptz,
      coalesce(v_elem->>'coverage', 'unknown'),
      v_entry,
      (v_elem->>'coverage_p')::real,
      coalesce(v_elem->>'status', 'open'),
      (v_elem->>'dismissed_at')::timestamptz
    )
    RETURNING id INTO v_topic;

    IF jsonb_typeof(v_elem->'gap_ids') = 'array' THEN
      INSERT INTO kb_gap_topic_members (topic_id, account_id, gap_id)
      SELECT DISTINCT v_topic, p_account, g::uuid
      FROM jsonb_array_elements_text(v_elem->'gap_ids') AS t(g);
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END
$$;

COMMENT ON FUNCTION public.kb_gap_topics_replace(uuid, jsonb, jsonb) IS
  'Replace an account''s knowledge-gap topics in one transaction (152). Service role only; 40001 HINT STALE when the stored statuses differ from p_expected; same-account composite FKs refuse foreign gap or answer ids.';

REVOKE ALL ON FUNCTION public.kb_gap_topics_replace(uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kb_gap_topics_replace(uuid, jsonb, jsonb) TO service_role;
