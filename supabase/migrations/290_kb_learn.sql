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
--  5. kb_learn_skills: a small skill library distilled from how admins
--     reviewed the drafts (SkillRL's general / per-category / mistakes),
--     used in the next drafts' prompt. Admin-visible, retirable, capped,
--     and CHECKed to hold no identifiers.
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
  -- The answer as drafted (model output, checked for identifiers before
  -- it was stored): compared with what the admin approved, it is what
  -- the skill library learns from (section 5).
  draft_answer_en text NULL,
  -- How the admin's review went, set by the job: approved as drafted,
  -- approved after editing, set to remove, or deleted. NULL = not yet.
  reviewed_outcome text NULL,
  reviewed_at      timestamptz NULL,
  -- When the skill library last learned from this review.
  distilled_at     timestamptz NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kb_learned_drafts_outcome_check CHECK (
    reviewed_outcome IS NULL OR reviewed_outcome IN ('approved', 'edited', 'removed', 'deleted')),
  CONSTRAINT kb_learned_drafts_draft_len_check CHECK (char_length(coalesce(draft_answer_en, '')) <= 4000),
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
  'Learn from team answers (290): which gap topic was drafted into which kb_entries row, so a topic is drafted once, and how the review went. Holds gap ids, the redacted topic label and the drafted answer (model output checked for identifiers), no team or customer message text. Admin+ read; written by kb_learn_record_draft() and the service role.';

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
    (account_id, topic_id, topic_label, gap_ids, entry_id, evidence_count, draft_answer_en)
  VALUES
    (p_account, p_topic_id, left(btrim(p_topic_label), 500), v_gaps, v_entry, p_evidence_count,
     btrim(p_answer_en));

  RETURN jsonb_build_object('status', 'drafted', 'entry_id', v_entry);
END $$;

REVOKE ALL ON FUNCTION public.kb_learn_record_draft(uuid, uuid, text, uuid[], text, text, text, text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kb_learn_record_draft(uuid, uuid, text, uuid[], text, text, text, text, text, integer)
  TO service_role;

-- ------------------------------------------------------------
-- 5. The skill library (learning from the admin's review)
-- ------------------------------------------------------------
-- After the drafts are reviewed, the job distils short reusable rules
-- from what admins approved, corrected or threw away (the SkillRL idea:
-- general skills, per-category skills, and common mistakes from
-- failures), and the next drafts are written with the relevant ones in
-- the prompt. Skills only shape drafts: a draft is still never approved
-- by the job. Admins see every skill and can retire one.
--
-- Skills are model output and are general rules, never customer data:
-- a CHECK refuses an e-mail, a run of 9+ digits (any script) and the
-- redactor's masks, whatever the job sends (the TS check comes first,
-- lib/kb/skills.ts). At most 24 active skills per account.
CREATE TABLE IF NOT EXISTS public.kb_learn_skills (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  category      text NULL,
  title         text NOT NULL,
  principle     text NOT NULL,
  when_to_apply text NULL,
  status        text NOT NULL DEFAULT 'active',
  -- How many reviews it was distilled from.
  evidence_count integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  retired_by    uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT kb_learn_skills_kind_check CHECK (kind IN ('general', 'category', 'mistake')),
  CONSTRAINT kb_learn_skills_category_check CHECK (
    (kind = 'category') = (category IS NOT NULL)
    AND (category IS NULL OR category ~ '^[a-z_]{1,32}$')),
  CONSTRAINT kb_learn_skills_status_check CHECK (status IN ('active', 'retired')),
  CONSTRAINT kb_learn_skills_len_check CHECK (
    char_length(title) BETWEEN 1 AND 120
    AND char_length(principle) BETWEEN 1 AND 600
    AND char_length(coalesce(when_to_apply, '')) <= 300),
  CONSTRAINT kb_learn_skills_evidence_check CHECK (evidence_count BETWEEN 1 AND 1000),
  -- General rules only: no e-mail, no long number, no redaction mask.
  CONSTRAINT kb_learn_skills_no_identifiers CHECK (
    (title || ' ' || principle || ' ' || coalesce(when_to_apply, '')) !~ '@'
    AND (title || ' ' || principle || ' ' || coalesce(when_to_apply, ''))
        !~ '[0-9٠-٩۰-۹０-９]([^0-9٠-٩۰-۹０-９]{0,2}[0-9٠-٩۰-۹０-９]){8,}'
    AND (title || ' ' || principle || ' ' || coalesce(when_to_apply, ''))
        !~* '\[(EMAIL|IBAN|EID|CARD|OTP|ACCT|PASSPORT|PHONE|ID|NAME|withheld)'
  )
);

COMMENT ON TABLE public.kb_learn_skills IS
  'Learn from team answers (290): the skill library distilled from admins'' reviews of learned drafts (general, per-category, common mistakes). Admin+ read; retired through kb_learn_skill_set_status(); written by the service role (lib/kb/learn-run.ts).';

CREATE INDEX IF NOT EXISTS idx_kb_learn_skills_account
  ON public.kb_learn_skills (account_id, status, kind);

ALTER TABLE public.kb_learn_settings
  ADD COLUMN IF NOT EXISTS last_distilled_at timestamptz NULL;

ALTER TABLE public.kb_learn_skills ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kb_learn_skills_select ON public.kb_learn_skills;
CREATE POLICY kb_learn_skills_select ON public.kb_learn_skills FOR SELECT
  USING (is_account_member(account_id, 'admin'));

REVOKE ALL ON public.kb_learn_skills FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.kb_learn_skills TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.kb_learn_skills TO service_role;

-- An admin+ of the skill's account (the active one) retires or restores
-- it. A missing skill and someone else's are the same 42501. Restoring
-- respects the cap of 24 active skills.
CREATE OR REPLACE FUNCTION public.kb_learn_skill_set_status(p_skill uuid, p_status text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account uuid;
  v_row     public.kb_learn_skills;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('active', 'retired') THEN
    RAISE EXCEPTION 'unknown skill status: %', p_status USING ERRCODE = '22023';
  END IF;
  SELECT account_id INTO v_account FROM public.kb_learn_skills WHERE id = p_skill;
  IF v_account IS NULL OR v_account IS DISTINCT FROM current_account_id()
     OR NOT is_account_member(v_account, 'admin') THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('kb_learn:' || v_account::text));
  IF p_status = 'active' AND (
       SELECT count(*) FROM public.kb_learn_skills
        WHERE account_id = v_account AND status = 'active' AND id <> p_skill) >= 24 THEN
    RAISE EXCEPTION 'too many active skills' USING ERRCODE = '23514', HINT = 'SKILL_CAP';
  END IF;
  UPDATE public.kb_learn_skills
     SET status = p_status, updated_at = now(),
         retired_by = CASE WHEN p_status = 'retired' THEN auth.uid() ELSE NULL END
   WHERE id = p_skill
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('id', v_row.id, 'status', v_row.status, 'updated_at', v_row.updated_at);
END $$;

REVOKE ALL ON FUNCTION public.kb_learn_skill_set_status(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kb_learn_skill_set_status(uuid, text) TO authenticated, service_role;

-- The job's one write of a library update, under the account's lock:
-- p_review_ids are marked distilled, p_skills (at most 3: SkillRL's
-- max_new_skills) are added while the switch is on and the account has
-- fewer than 24 active skills. A skill whose title a skill of the same
-- kind already has, active OR retired, is skipped: an admin's retirement
-- is not undone by the next cycle. Answers the number added.
CREATE OR REPLACE FUNCTION public.kb_learn_add_skills(
  p_account    uuid,
  p_skills     jsonb,
  p_review_ids uuid[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_skill jsonb;
  v_added integer := 0;
  v_active integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('kb_learn:' || coalesce(p_account::text, '')));
  IF NOT EXISTS (SELECT 1 FROM public.kb_learn_settings WHERE account_id = p_account AND enabled) THEN
    RETURN 0;
  END IF;
  SELECT count(*) INTO v_active FROM public.kb_learn_skills
   WHERE account_id = p_account AND status = 'active';
  FOR v_skill IN SELECT * FROM jsonb_array_elements(coalesce(p_skills, '[]'::jsonb)) LIMIT 3
  LOOP
    EXIT WHEN v_active >= 24;
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.kb_learn_skills k
       WHERE k.account_id = p_account
         AND k.kind = v_skill->>'kind'
         AND lower(btrim(k.title)) = lower(btrim(v_skill->>'title')));
    INSERT INTO public.kb_learn_skills
      (account_id, kind, category, title, principle, when_to_apply, evidence_count)
    VALUES
      (p_account, v_skill->>'kind',
       CASE WHEN v_skill->>'kind' = 'category' THEN v_skill->>'category' END,
       btrim(v_skill->>'title'), btrim(v_skill->>'principle'),
       nullif(btrim(coalesce(v_skill->>'when_to_apply', '')), ''),
       greatest(1, least(1000, coalesce((v_skill->>'evidence_count')::integer, 1))));
    v_added := v_added + 1;
    v_active := v_active + 1;
  END LOOP;
  UPDATE public.kb_learned_drafts SET distilled_at = now()
   WHERE account_id = p_account AND id = ANY (coalesce(p_review_ids, '{}'));
  UPDATE public.kb_learn_settings SET last_distilled_at = now() WHERE account_id = p_account;
  RETURN v_added;
END $$;

REVOKE ALL ON FUNCTION public.kb_learn_add_skills(uuid, jsonb, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kb_learn_add_skills(uuid, jsonb, uuid[]) TO service_role;
