-- ============================================================
-- 318_kb_learn_skills.sql — the knowledge base learner's skill library
--
-- Learn from team answers (290) also learns from how admins reviewed its
-- drafts: short general rules are distilled from the reviews and put in
-- the next drafts' prompt. Nothing is approved or sent because of them.
--
--  1. kb_learned_drafts: draft_answer_en (the answer as drafted, screened
--     model output), reviewed_outcome, reviewed_at, distilled_at.
--  2. kb_learn_record_draft(): 290's body, storing draft_answer_en too.
--  3. kb_learn_gaps_deleted(): 290's body; when a subject erase leaves a
--     draft fewer than two chats, the stored drafted answer goes as well.
--  4. kb_learn_skills, kb_learn_settings.last_distilled_at,
--     kb_learn_skill_set_status() and kb_learn_add_skills().
--
-- Re-runnable. 2 and 3 restate functions of 290: RE-RUN 318 AFTER 290.
-- Every refusal comes before the first DDL and turns the session
-- read-only (130's way). Asserted by
-- supabase/ci/verify-kb-learn-skills.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$
DECLARE
  v_refusal text := '';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    v_refusal := '318 must be applied by a superuser or BYPASSRLS role (its functions write tables RLS guards)';
  ELSIF to_regclass('public.kb_learned_drafts') IS NULL
     OR to_regclass('public.kb_learn_settings') IS NULL THEN
    v_refusal := '318: apply 290_kb_learn.sql first';
  END IF;
  PERFORM set_config('kb318.refusal', v_refusal, false);
  IF v_refusal <> '' THEN
    PERFORM set_config('default_transaction_read_only', 'on', false);
  END IF;
END $$;

DO $$ BEGIN
  IF coalesce(current_setting('kb318.refusal', true), '') <> '' THEN
    RAISE EXCEPTION '%', current_setting('kb318.refusal');
  END IF;
END $$;

-- ------------------------------------------------------------
-- 1. The ledger
-- ------------------------------------------------------------
ALTER TABLE public.kb_learned_drafts
  -- The answer as drafted (screened before it was stored): compared with
  -- what the admin approved, it is what the skill library learns from.
  ADD COLUMN IF NOT EXISTS draft_answer_en  text NULL,
  -- How the review went, set by the job. NULL = not yet.
  ADD COLUMN IF NOT EXISTS reviewed_outcome text NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at      timestamptz NULL,
  -- When the skill library learned from this review.
  ADD COLUMN IF NOT EXISTS distilled_at     timestamptz NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.kb_learned_drafts'::regclass
                   AND conname = 'kb_learned_drafts_outcome_check') THEN
    ALTER TABLE public.kb_learned_drafts ADD CONSTRAINT kb_learned_drafts_outcome_check CHECK (
      reviewed_outcome IS NULL OR reviewed_outcome IN ('approved', 'edited', 'removed', 'deleted'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.kb_learned_drafts'::regclass
                   AND conname = 'kb_learned_drafts_draft_len_check') THEN
    ALTER TABLE public.kb_learned_drafts ADD CONSTRAINT kb_learned_drafts_draft_len_check CHECK (
      char_length(coalesce(draft_answer_en, '')) <= 4000);
  END IF;
END $$;

COMMENT ON TABLE public.kb_learned_drafts IS
  'Learn from team answers (290, 318): which gap topic was drafted into which kb_entries row, so a topic is drafted once, and how the review went. Holds gap ids (a deleted gap leaves them), a keyed hash of the topic label and the drafted answer (screened model output, gone with the draft''s second chat), no team or customer message text. Admin+ read; written by kb_learn_record_draft() and the service role.';

-- ------------------------------------------------------------
-- 2. The one writer, storing the drafted answer
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kb_learn_record_draft(
  p_account        uuid,
  p_topic_id       uuid,
  p_topic_key      text,
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
     OR p_topic_key IS NULL OR p_topic_key !~ '^[0-9a-f]{64}$'
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

  IF public.kb_learn_topic_drafted(p_account, v_gaps, p_topic_key) THEN
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
    (account_id, topic_id, topic_key, gap_ids, entry_id, evidence_count, draft_answer_en)
  VALUES
    (p_account, p_topic_id, p_topic_key, v_gaps, v_entry, p_evidence_count,
     btrim(p_answer_en));

  RETURN jsonb_build_object('status', 'drafted', 'entry_id', v_entry);
END $$;

REVOKE ALL ON FUNCTION public.kb_learn_record_draft(uuid, uuid, text, uuid[], text, text, text, text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kb_learn_record_draft(uuid, uuid, text, uuid[], text, text, text, text, text, integer)
  TO service_role;

-- ------------------------------------------------------------
-- 3. A gap deleted (a subject erase does)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kb_learn_gaps_deleted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ids uuid[];
  v_cut uuid[];
BEGIN
  SELECT array_agg(id) INTO v_ids FROM gone;
  IF v_ids IS NULL THEN RETURN NULL; END IF;
  -- Two statements: a ledger row touched twice in one transaction has its
  -- entry key checked again, which must run before the entry goes.
  WITH cut AS (
    UPDATE public.kb_learned_drafts l
       SET gap_ids = coalesce((SELECT array_agg(g) FROM unnest(l.gap_ids) g WHERE g <> ALL (v_ids)), '{}'),
           -- 318: the drafted answer goes by the same rule as the draft.
           draft_answer_en = CASE
             WHEN (SELECT count(DISTINCT k.conversation_id) FROM public.ai_knowledge_gaps k
                    WHERE k.id = ANY (l.gap_ids) AND k.account_id = l.account_id) >= 2
             THEN l.draft_answer_en END
     WHERE l.gap_ids && v_ids
    RETURNING l.id)
  SELECT array_agg(id) INTO v_cut FROM cut;
  IF v_cut IS NULL THEN RETURN NULL; END IF;
  DELETE FROM public.kb_entries e
   USING public.kb_learned_drafts c
   WHERE c.id = ANY (v_cut) AND e.id = c.entry_id AND e.account_id = c.account_id
     AND e.source = 'learned' AND e.status = 'draft' AND e.approved_at IS NULL
     AND (SELECT count(DISTINCT k.conversation_id) FROM public.ai_knowledge_gaps k
           WHERE k.id = ANY (c.gap_ids) AND k.account_id = c.account_id) < 2;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION public.kb_learn_gaps_deleted() FROM PUBLIC, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 4. The skill library (learning from the admin's review)
-- ------------------------------------------------------------
-- After the drafts are reviewed, the job distils short reusable rules
-- from what admins approved, corrected or threw away (the SkillRL idea:
-- general skills, per-category skills, and common mistakes from
-- failures), and the next drafts are written with the relevant ones in
-- the prompt. Skills only shape drafts: a draft is still never approved
-- by the job. Admins see every skill and can retire one.
--
-- Skills are model output and are general rules, never customer data:
-- a CHECK refuses an e-mail, a link, five digits in a row or 9+ digits
-- with separators (any script) and the redactor's masks, whatever the job sends (the TS check comes first,
-- lib/kb/skills.ts, with the account's known names). At most 24 active skills per account.
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
  -- General rules only: no e-mail, link, long number or redaction mask.
  CONSTRAINT kb_learn_skills_no_identifiers CHECK (
    (title || ' ' || principle || ' ' || coalesce(when_to_apply, '')) !~ '@'
    AND (title || ' ' || principle || ' ' || coalesce(when_to_apply, ''))
        !~ '[0-9٠-٩۰-۹０-９]([^0-9٠-٩۰-۹０-９]{0,2}[0-9٠-٩۰-۹０-９]){8,}'
    AND (title || ' ' || principle || ' ' || coalesce(when_to_apply, ''))
        !~* '\[(EMAIL|IBAN|EID|CARD|OTP|ACCT|PASSPORT|PHONE|ID|NAME|CASE|LINK|withheld)'
    AND (title || ' ' || principle || ' ' || coalesce(when_to_apply, ''))
        !~* '[0-9٠-٩۰-۹０-９]{5}|://|www\.'
  )
);

COMMENT ON TABLE public.kb_learn_skills IS
  'Learn from team answers (318): the skill library distilled from admins'' reviews of learned drafts (general, per-category, common mistakes). Admin+ read; retired through kb_learn_skill_set_status(); written by the service role (lib/kb/learn-run.ts).';

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
SET search_path = public, pg_temp
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
-- p_review_ids (this account's, reviewed) are marked distilled, p_skills
-- (at most 3: SkillRL's max_new_skills) are added while the switch is on
-- and the account has fewer than 24 active skills. A skill whose title a
-- skill of the same kind already has, active OR retired, is skipped: an
-- admin's retirement is not undone by the next cycle. One skill a CHECK
-- refuses is skipped, not the whole call. An unknown account has no
-- switch: 0. Answers the number added.
CREATE OR REPLACE FUNCTION public.kb_learn_add_skills(
  p_account    uuid,
  p_skills     jsonb,
  p_review_ids uuid[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_skill  jsonb;
  v_added  integer := 0;
  v_active integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('kb_learn:' || coalesce(p_account::text, '')));
  IF NOT EXISTS (SELECT 1 FROM public.kb_learn_settings WHERE account_id = p_account AND enabled) THEN
    RETURN 0;
  END IF;
  SELECT count(*) INTO v_active FROM public.kb_learn_skills
   WHERE account_id = p_account AND status = 'active';
  FOR v_skill IN SELECT x.value FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(p_skills) = 'array' THEN p_skills ELSE '[]'::jsonb END) x
  LOOP
    EXIT WHEN v_added >= 3 OR v_active >= 24;
    CONTINUE WHEN jsonb_typeof(v_skill) <> 'object' OR EXISTS (
      SELECT 1 FROM public.kb_learn_skills k
       WHERE k.account_id = p_account
         AND k.kind = v_skill->>'kind'
         AND lower(btrim(regexp_replace(k.title, '\s+', ' ', 'g')))
             = lower(btrim(regexp_replace(v_skill->>'title', '\s+', ' ', 'g'))));
    BEGIN
      INSERT INTO public.kb_learn_skills
        (account_id, kind, category, title, principle, when_to_apply, evidence_count)
      VALUES
        (p_account, v_skill->>'kind',
         CASE WHEN v_skill->>'kind' = 'category' THEN v_skill->>'category' END,
         btrim(v_skill->>'title'), btrim(v_skill->>'principle'),
         nullif(btrim(coalesce(v_skill->>'when_to_apply', '')), ''),
         CASE WHEN jsonb_typeof(v_skill->'evidence_count') = 'number'
              THEN greatest(1, least(1000, (v_skill->>'evidence_count')::numeric))::integer
              ELSE 1 END);
      v_added := v_added + 1;
      v_active := v_active + 1;
    EXCEPTION WHEN check_violation OR not_null_violation THEN
      NULL;  -- this one is not stored; the others still are
    END;
  END LOOP;
  UPDATE public.kb_learned_drafts SET distilled_at = now()
   WHERE account_id = p_account AND reviewed_outcome IS NOT NULL
     AND id = ANY (coalesce(p_review_ids, '{}'));
  UPDATE public.kb_learn_settings SET last_distilled_at = now() WHERE account_id = p_account;
  RETURN v_added;
END $$;

REVOKE ALL ON FUNCTION public.kb_learn_add_skills(uuid, jsonb, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kb_learn_add_skills(uuid, jsonb, uuid[]) TO service_role;
