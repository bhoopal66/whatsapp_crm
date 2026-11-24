-- ============================================================
-- 290_kb_learn.sql — learn from the team's answers (knowledge base)
--
-- Once a week, for a workspace whose owner or admin switched it on, the
-- automations cron (src/lib/kb/learn-run.ts) looks at the open
-- knowledge-gap topics (152), finds where a PERSON answered the
-- customer's question in the chat, and drafts one knowledge-base entry
-- from those answers. The entry is a DRAFT: never approved, never sent
-- by the bot until an admin edits and approves it on the existing path
-- (PATCH /api/ai/kb/[id], 081's trigger and CHECK unchanged).
--
--  1. ai_usage_log_mode_check gains 'kb_learn' (the whole list from
--     202, restated). LogAiUsageArgs.mode and the usage route's byMode
--     change with it.
--  2. kb_learn_settings: the switch (OFF by default) and the last run,
--     one row per account. Admin+ reads; the switch is set only through
--     kb_learn_set_enabled() (admin+ of the ACTIVE account); the last
--     run only by kb_learn_claim_run() and kb_learn_finish_run()
--     (service role).
--  3. kb_learned_drafts: the ledger, one row per drafted topic, so a
--     topic is drafted once. Topic ids change on every recompute (152
--     replaces the set), so a topic is "the same" when at least half of
--     a ledger row's gaps are in it, or its label matches (the 152
--     carry-over idea). A topic is drafted again only when its draft was
--     deleted or set to 'remove'. Admin+ reads; service role writes.
--  4. kb_learn_record_draft(): the one writer of a learned entry, service
--     role only. Refuses when the switch is off or the topic already has
--     a live draft, and always writes status 'draft', source 'learned'.
--
-- The functions are SECURITY DEFINER and write kb_entries, which RLS
-- guards: hence the BYPASSRLS check below. Re-runnable: IF NOT EXISTS,
-- guarded constraints, CREATE OR REPLACE, DROP POLICY IF EXISTS.
-- Apply after 202 and 152, in order, once: re-running 202 afterwards
-- would drop 'kb_learn' from the usage CHECK again.
-- Asserted by supabase/ci/verify-kb-learn.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '290 must be applied by a superuser or BYPASSRLS role (its functions write kb_entries, which RLS guards)';
  END IF;
  IF to_regclass('public.kb_gap_topics') IS NULL THEN
    RAISE EXCEPTION '290: apply 152_kb_gap_topics.sql first';
  END IF;
  IF to_regclass('public.hr_agent_settings') IS NULL THEN
    RAISE EXCEPTION '290: apply 202_hr_agents.sql first';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 1. Usage log mode
-- ------------------------------------------------------------
ALTER TABLE public.ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_mode_check;
ALTER TABLE public.ai_usage_log
  ADD CONSTRAINT ai_usage_log_mode_check
  CHECK (mode IN ('auto_reply', 'draft', 'translate', 'hr_agent', 'kb_learn'));

-- ------------------------------------------------------------
-- 2. The switch
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kb_learn_settings (
  account_id  uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  enabled     boolean NOT NULL DEFAULT false,
  last_run_at timestamptz NULL,
  -- Drafts the last run wrote; NULL while it runs or before the first.
  last_run_drafted integer NULL CHECK (last_run_drafted IS NULL OR last_run_drafted >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.kb_learn_settings IS
  'Learn from team answers (290): off by default. Set through kb_learn_set_enabled(); last_run_at through kb_learn_claim_run(). Mirrored by KB_LEARN_DEFAULT_ENABLED in src/lib/kb/learn.ts.';

ALTER TABLE public.kb_learn_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kb_learn_settings_select ON public.kb_learn_settings;
CREATE POLICY kb_learn_settings_select ON public.kb_learn_settings FOR SELECT
  USING (is_account_member(account_id, 'admin'));

REVOKE ALL ON public.kb_learn_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.kb_learn_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.kb_learn_settings TO service_role;

-- ------------------------------------------------------------
-- 3. The ledger
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kb_learned_drafts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- No foreign key: a recompute replaces every topic (152).
  topic_id       uuid NULL,
  topic_label    text NOT NULL,
  gap_ids        uuid[] NOT NULL DEFAULT '{}',
  entry_id       uuid NULL,
  evidence_count integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kb_learned_drafts_label_check CHECK (char_length(topic_label) BETWEEN 1 AND 500),
  CONSTRAINT kb_learned_drafts_evidence_check CHECK (evidence_count BETWEEN 1 AND 50),
  -- The column list keeps account_id when the draft is deleted: the row
  -- stays, and a NULL entry is what lets the topic be drafted again.
  CONSTRAINT kb_learned_drafts_entry_fkey
    FOREIGN KEY (entry_id, account_id)
    REFERENCES public.kb_entries (id, account_id)
    ON DELETE SET NULL (entry_id)
);

COMMENT ON TABLE public.kb_learned_drafts IS
  'Learn from team answers (290): which gap topic was drafted into which kb_entries row, so a topic is drafted once. Holds gap ids and the topic label, no team or customer message text. Admin+ read; written by kb_learn_record_draft() only.';

CREATE INDEX IF NOT EXISTS idx_kb_learned_drafts_account
  ON public.kb_learned_drafts (account_id, created_at DESC);

ALTER TABLE public.kb_learned_drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kb_learned_drafts_select ON public.kb_learned_drafts;
CREATE POLICY kb_learned_drafts_select ON public.kb_learned_drafts FOR SELECT
  USING (is_account_member(account_id, 'admin'));

REVOKE ALL ON public.kb_learned_drafts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.kb_learned_drafts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.kb_learned_drafts TO service_role;

-- ------------------------------------------------------------
-- 4. Functions
-- ------------------------------------------------------------

-- The switch, for an admin+ of the caller's ACTIVE account.
CREATE OR REPLACE FUNCTION public.kb_learn_set_enabled(p_enabled boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account uuid := current_account_id();
  v_row     public.kb_learn_settings;
BEGIN
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'enabled must be true or false' USING ERRCODE = '22023';
  END IF;
  IF v_account IS NULL OR NOT is_account_member(v_account, 'admin') THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.kb_learn_settings AS s (account_id, enabled, updated_at, updated_by)
  VALUES (v_account, p_enabled, now(), auth.uid())
  ON CONFLICT (account_id) DO UPDATE
    SET enabled = EXCLUDED.enabled, updated_at = now(), updated_by = EXCLUDED.updated_by
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('enabled', v_row.enabled, 'last_run_at', v_row.last_run_at,
                            'last_run_drafted', v_row.last_run_drafted,
                            'updated_at', v_row.updated_at);
END $$;

REVOKE ALL ON FUNCTION public.kb_learn_set_enabled(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kb_learn_set_enabled(boolean) TO authenticated, service_role;

-- The weekly claim: true (and last_run_at stamped) only while the switch
-- is on and the last run is at least p_min_interval old. Two crons in
-- the same minute: one wins.
CREATE OR REPLACE FUNCTION public.kb_learn_claim_run(
  p_account uuid,
  p_min_interval interval DEFAULT interval '7 days'
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hit uuid;
BEGIN
  UPDATE public.kb_learn_settings s
     SET last_run_at = now(), last_run_drafted = NULL
   WHERE s.account_id = p_account
     AND s.enabled
     AND (s.last_run_at IS NULL OR s.last_run_at <= now() - p_min_interval)
  RETURNING s.account_id INTO v_hit;
  RETURN v_hit IS NOT NULL;
END $$;

REVOKE ALL ON FUNCTION public.kb_learn_claim_run(uuid, interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kb_learn_claim_run(uuid, interval) TO service_role;

-- The run's result, for the switch's "last run" line. Service role.
CREATE OR REPLACE FUNCTION public.kb_learn_finish_run(p_account uuid, p_drafted integer)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.kb_learn_settings
     SET last_run_drafted = greatest(coalesce(p_drafted, 0), 0)
   WHERE account_id = p_account;
$$;

REVOKE ALL ON FUNCTION public.kb_learn_finish_run(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kb_learn_finish_run(uuid, integer) TO service_role;

-- Whether a topic already has a live draft: a ledger row whose entry
-- still exists and is not 'remove', and that is the same topic (half or
-- more of its gaps are in this one, or the same label).
CREATE OR REPLACE FUNCTION public.kb_learn_topic_drafted(
  p_account uuid,
  p_gap_ids uuid[],
  p_label text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.kb_learned_drafts l
      JOIN public.kb_entries e ON e.id = l.entry_id AND e.account_id = l.account_id
     WHERE l.account_id = p_account
       AND e.status <> 'remove'
       AND (
         lower(btrim(l.topic_label)) = lower(btrim(coalesce(p_label, '')))
         OR (cardinality(l.gap_ids) > 0
             AND 2 * (SELECT count(*) FROM unnest(l.gap_ids) g
                       WHERE g = ANY (coalesce(p_gap_ids, '{}')))
                 >= cardinality(l.gap_ids))
       )
  );
$$;

REVOKE ALL ON FUNCTION public.kb_learn_topic_drafted(uuid, uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kb_learn_topic_drafted(uuid, uuid[], text) TO service_role;

-- The one writer. Answers {status}: 'drafted' (with entry_id), or the
-- refusal: 'disabled', 'already', 'invalid', 'ref_taken'. The entry is
-- always status 'draft': a person approves it, never this function.
CREATE OR REPLACE FUNCTION public.kb_learn_record_draft(
  p_account        uuid,
  p_topic_id       uuid,
  p_topic_label    text,
  p_gap_ids        uuid[],
  p_ref            text,
  p_question       text,
  p_answer_en      text,
  p_answer_ar      text,
  p_notes          text,
  p_evidence_count integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_gaps  uuid[];
  v_entry uuid;
BEGIN
  -- One writer per account at a time: the "already" check and the
  -- insert cannot interleave with another run's.
  PERFORM pg_advisory_xact_lock(hashtext('kb_learn:' || coalesce(p_account::text, '')));

  IF NOT EXISTS (SELECT 1 FROM public.kb_learn_settings
                  WHERE account_id = p_account AND enabled) THEN
    RETURN jsonb_build_object('status', 'disabled');
  END IF;

  IF p_ref IS NULL OR p_ref !~ '^LRN-[A-Z0-9]{6,12}$'
     OR p_topic_label IS NULL OR btrim(p_topic_label) = '' OR char_length(p_topic_label) > 500
     OR p_question IS NULL OR btrim(p_question) = '' OR char_length(p_question) > 2000
     OR p_answer_en IS NULL OR btrim(p_answer_en) = '' OR char_length(p_answer_en) > 4000
     OR char_length(coalesce(p_answer_ar, '')) > 4000
     OR char_length(coalesce(p_notes, '')) > 1000
     OR p_evidence_count IS NULL OR p_evidence_count NOT BETWEEN 1 AND 50 THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  -- Only this account's gaps count.
  SELECT coalesce(array_agg(DISTINCT g.id), '{}') INTO v_gaps
    FROM public.ai_knowledge_gaps g
   WHERE g.account_id = p_account AND g.id = ANY (coalesce(p_gap_ids, '{}'));
  IF cardinality(v_gaps) = 0 THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  IF public.kb_learn_topic_drafted(p_account, v_gaps, p_topic_label) THEN
    RETURN jsonb_build_object('status', 'already');
  END IF;

  BEGIN
    INSERT INTO public.kb_entries
      (account_id, ref, audience, category, question, answer_en, answer_ar,
       status, handoff_after, source, reviewer_notes)
    VALUES
      (p_account, p_ref, 'prospective_client', '', btrim(p_question), btrim(p_answer_en),
       nullif(btrim(coalesce(p_answer_ar, '')), ''),
       'draft', false, 'learned', nullif(btrim(coalesce(p_notes, '')), ''))
    RETURNING id INTO v_entry;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('status', 'ref_taken');
  END;

  INSERT INTO public.kb_learned_drafts
    (account_id, topic_id, topic_label, gap_ids, entry_id, evidence_count)
  VALUES
    (p_account, p_topic_id, left(btrim(p_topic_label), 500), v_gaps, v_entry, p_evidence_count);

  RETURN jsonb_build_object('status', 'drafted', 'entry_id', v_entry);
END $$;

REVOKE ALL ON FUNCTION public.kb_learn_record_draft(uuid, uuid, text, uuid[], text, text, text, text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kb_learn_record_draft(uuid, uuid, text, uuid[], text, text, text, text, text, integer)
  TO service_role;
