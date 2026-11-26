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
--  1. ai_usage_log_mode_check gains 'kb_learn' (the list as it stands,
--     read from the catalog). LogAiUsageArgs.mode and the usage route's byMode
--     change with it.
--  2. kb_learn_settings: the switch (OFF by default) and the last run,
--     one row per account. Admin+ reads; the switch is set only through
--     kb_learn_set_enabled() (admin+ of the ACTIVE account); the last
--     run only by kb_learn_claim_run() and kb_learn_finish_run()
--     (service role). A claim marks the row 'running' and due again in
--     50 minutes (at most 3 attempts in 24 hours), so a crash, a missing
--     AI key or a failed read is retried, and only a finished run starts
--     the 7-day wait. kb_learn_asked_this_week() counts the ledger's last
--     7 days, so retries never ask about more than ten topics a week.
--  3. kb_learned_drafts: the ledger, one row per drafted topic, so a
--     topic is drafted once. Topic ids change on every recompute (152
--     replaces the set), so a topic is "the same" when at least half of
--     a ledger row's gaps are in it, or its label's hash matches (the 152
--     carry-over idea; the label is a customer's message, so only a
--     HMAC of it is kept, with a secret the database does not hold). A
--     topic is drafted again only when its draft was deleted or set to 'remove', and one whose draft was
--     discarded (the model's text carried a name or an identifier), or
--     that the model declined or answered malformed, only after 28 days. Admin+ reads; service role writes.
--  4. kb_learn_record_draft(): the one writer of a learned entry, service
--     role only. Refuses when the switch is off or the topic already has
--     a live draft, and always writes status 'draft', source 'learned'.
--     kb_learn_record_discard() notes a discarded draft;
--     kb_learn_case_names() lists names to mask (service role only).
--
-- The functions are SECURITY DEFINER and write kb_entries, which RLS
-- guards: hence the BYPASSRLS check below. Re-runnable: IF NOT EXISTS,
-- guarded constraints, CREATE OR REPLACE, DROP POLICY IF EXISTS.
-- Apply after 202 and 152, in order, once: re-running 202 afterwards
-- would drop 'kb_learn' from the usage CHECK again. Every refusal comes
-- before the first DDL and turns the session read-only, so a plain
-- `psql -f`, which goes on after an error, applies nothing either.
-- Asserted by supabase/ci/verify-kb-learn.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$
DECLARE
  v_refusal text := '';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    v_refusal := '290 must be applied by a superuser or BYPASSRLS role (its functions write kb_entries, which RLS guards)';
  ELSIF to_regclass('public.kb_gap_topics') IS NULL THEN
    v_refusal := '290: apply 152_kb_gap_topics.sql first';
  ELSIF to_regclass('public.hr_agent_settings') IS NULL THEN
    v_refusal := '290: apply 202_hr_agents.sql first';
  ELSIF to_regclass('public.case_bank_contacts') IS NULL THEN
    v_refusal := '290: apply 124 (case_bank_contacts) first';
  ELSIF to_regclass('public.desk_customers') IS NULL THEN
    v_refusal := '290: apply 220 (desk_customers) first';
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = 'public.kb_entries'::regclass AND c.contype IN ('u', 'p')
       AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
              FROM unnest(c.conkey) k JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k)
           = ARRAY['account_id', 'id']) THEN
    v_refusal := '290: kb_entries has no (id, account_id) key; apply 152_kb_gap_topics.sql first';
  ELSIF (SELECT count(*) FROM pg_constraint
          WHERE conrelid = 'public.ai_usage_log'::regclass
            AND conname = 'ai_usage_log_mode_check' AND contype = 'c'
            AND pg_get_constraintdef(oid) LIKE '%hr_agent%') <> 1 THEN
    v_refusal := '290: ai_usage_log_mode_check is not the list 202 leaves; look at it first';
  END IF;
  PERFORM set_config('kb290.refusal', v_refusal, false);
  IF v_refusal <> '' THEN
    -- Outlives the error below: what follows cannot half-apply (130's way).
    PERFORM set_config('default_transaction_read_only', 'on', false);
  END IF;
END $$;

DO $$ BEGIN
  IF coalesce(current_setting('kb290.refusal', true), '') <> '' THEN
    RAISE EXCEPTION '%', current_setting('kb290.refusal');
  END IF;
END $$;

-- ------------------------------------------------------------
-- 1. Usage log mode
-- ------------------------------------------------------------
-- One statement, so the table is never without the CHECK; every value the
-- constraint has now is kept. NOT VALID, then VALIDATE (no long lock).
DO $$
DECLARE
  v_def text := (SELECT pg_get_constraintdef(oid) FROM pg_constraint
                  WHERE conrelid = 'public.ai_usage_log'::regclass
                    AND conname = 'ai_usage_log_mode_check');
  v_modes text;
BEGIN
  SELECT string_agg(quote_literal(x.mode), ', ' ORDER BY x.n) INTO v_modes
    FROM (SELECT m[1] AS mode, n
            FROM regexp_matches(v_def, '''([^'']+)''', 'g') WITH ORDINALITY AS r(m, n)
          UNION ALL SELECT 'kb_learn', 1000000) x
   WHERE x.n = 1000000 OR x.mode <> 'kb_learn';
  EXECUTE format('ALTER TABLE public.ai_usage_log
    DROP CONSTRAINT ai_usage_log_mode_check,
    ADD CONSTRAINT ai_usage_log_mode_check CHECK (mode IN (%s)) NOT VALID', v_modes);
END $$;
ALTER TABLE public.ai_usage_log VALIDATE CONSTRAINT ai_usage_log_mode_check;

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

-- NULL on a row that has last_run_at only: due a week after that run.
ALTER TABLE public.kb_learn_settings
  ADD COLUMN IF NOT EXISTS next_run_at    timestamptz NULL,
  ADD COLUMN IF NOT EXISTS attempts       integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN IF NOT EXISTS attempts_since timestamptz NULL,
  -- 'running' from the claim until the run ends (a crash leaves it); the
  -- others are KB_LEARN_RUN_ERRORS in src/lib/kb/learn-settings.ts.
  ADD COLUMN IF NOT EXISTS last_run_error text NULL
    CHECK (last_run_error IN ('running', 'no_ai', 'read_failed', 'out_of_time', 'model', 'failed'));

COMMENT ON TABLE public.kb_learn_settings IS
  'Learn from team answers (290): off by default. Set through kb_learn_set_enabled(); the run columns through kb_learn_claim_run() and kb_learn_finish_run(). Mirrored by KB_LEARN_DEFAULT_ENABLED in src/lib/kb/learn.ts.';

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
  topic_key      text NOT NULL,   -- HMAC of account and label, keyed by the app; never the label
  gap_ids        uuid[] NOT NULL DEFAULT '{}',
  entry_id       uuid NULL,
  evidence_count integer NOT NULL,
  -- The model's text was thrown away, or it declined: no entry, not asked
  -- again for 28 days.
  discarded_at   timestamptz NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kb_learned_drafts_key_check CHECK (topic_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT kb_learned_drafts_evidence_check CHECK (evidence_count BETWEEN 1 AND 50),
  -- The column list keeps account_id when the draft is deleted: the row
  -- stays, and a NULL entry is what lets the topic be drafted again.
  CONSTRAINT kb_learned_drafts_entry_fkey
    FOREIGN KEY (entry_id, account_id)
    REFERENCES public.kb_entries (id, account_id)
    ON DELETE SET NULL (entry_id)
);

COMMENT ON TABLE public.kb_learned_drafts IS
  'Learn from team answers (290): which gap topic was drafted into which kb_entries row, so a topic is drafted once. Holds gap ids (a deleted gap leaves them) and a keyed hash of the topic label, no team or customer message text. Admin+ read; written by kb_learn_record_draft() only.';

-- When a topic was last looked at, kept per gap (topic ids change on every
-- recompute) and gone with it. Service role only.
CREATE TABLE IF NOT EXISTS public.kb_learn_looks (
  gap_id         uuid PRIMARY KEY REFERENCES public.ai_knowledge_gaps(id) ON DELETE CASCADE,
  account_id     uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  looked_at      timestamptz NOT NULL DEFAULT now(),
  model_failures integer NOT NULL DEFAULT 0 CHECK (model_failures >= 0)
);
ALTER TABLE public.kb_learn_looks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.kb_learn_looks FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.kb_learn_looks TO service_role;

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

-- The switch, for an admin+ of the caller's ACTIVE account. Going from
-- off to on forgets the last run, so it starts at the next hourly check
-- (the week's ten topics still count, they are in the ledger).
CREATE OR REPLACE FUNCTION public.kb_learn_set_enabled(p_enabled boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account uuid := current_account_id();
  v_row     public.kb_learn_settings;
  v_was_on  boolean;
BEGIN
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'enabled must be true or false' USING ERRCODE = '22023';
  END IF;
  IF v_account IS NULL OR NOT is_account_member(v_account, 'admin') THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  SELECT s.enabled INTO v_was_on FROM public.kb_learn_settings s
   WHERE s.account_id = v_account FOR UPDATE;
  v_was_on := coalesce(v_was_on, false);
  INSERT INTO public.kb_learn_settings AS s (account_id, enabled, updated_at, updated_by)
  VALUES (v_account, p_enabled, now(), auth.uid())
  ON CONFLICT (account_id) DO UPDATE
    SET enabled = EXCLUDED.enabled, updated_at = now(), updated_by = EXCLUDED.updated_by
  RETURNING * INTO v_row;
  IF p_enabled AND NOT v_was_on THEN
    UPDATE public.kb_learn_settings
       SET last_run_at = NULL, last_run_drafted = NULL, last_run_error = NULL,
           next_run_at = NULL, attempts = 0, attempts_since = NULL
     WHERE account_id = v_account
    RETURNING * INTO v_row;
  END IF;
  RETURN jsonb_build_object('enabled', v_row.enabled, 'last_run_at', v_row.last_run_at,
                            'last_run_drafted', v_row.last_run_drafted,
                            'last_run_error', v_row.last_run_error,
                            'next_run_at', v_row.next_run_at,
                            'updated_at', v_row.updated_at);
END $$;

REVOKE ALL ON FUNCTION public.kb_learn_set_enabled(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kb_learn_set_enabled(boolean) TO authenticated, service_role;

-- The claim: true only while the switch is on and the account is due.
-- It marks the row 'running' and due again in 50 minutes, so a run that
-- crashes is simply retried at the next hourly check; the third attempt
-- waits until 24 hours after the first, and the one after it starts a new
-- count. Two crons in the same minute: one wins.
DROP FUNCTION IF EXISTS public.kb_learn_claim_run(uuid, interval);
CREATE OR REPLACE FUNCTION public.kb_learn_claim_run(p_account uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row   public.kb_learn_settings;
  v_count integer;
  v_since timestamptz;
BEGIN
  SELECT * INTO v_row FROM public.kb_learn_settings s
   WHERE s.account_id = p_account
     AND s.enabled
     AND coalesce(s.next_run_at, s.last_run_at + interval '7 days', '-infinity') <= now()
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_row.attempts_since IS NULL OR v_row.attempts >= 3
     OR v_row.attempts_since <= now() - interval '24 hours' THEN
    v_count := 1;
    v_since := now();
  ELSE
    v_count := v_row.attempts + 1;
    v_since := v_row.attempts_since;
  END IF;
  UPDATE public.kb_learn_settings
     SET last_run_at = now(), last_run_drafted = NULL, last_run_error = 'running',
         attempts = v_count, attempts_since = v_since,
         next_run_at = CASE WHEN v_count < 3 THEN now() + interval '50 minutes'
                            ELSE greatest(v_since + interval '24 hours',
                                          now() + interval '50 minutes') END
   WHERE account_id = p_account;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.kb_learn_claim_run(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kb_learn_claim_run(uuid) TO service_role;

-- The run's result. No error: done for 7 days from NOW, not from the
-- claim, so every ledger row of this run is out of the weekly count by
-- then. An error keeps the claim's retry. Only a row still 'running' is
-- touched: a switch turned off and on meanwhile starts afresh. Service
-- role.
DROP FUNCTION IF EXISTS public.kb_learn_finish_run(uuid, integer);
CREATE OR REPLACE FUNCTION public.kb_learn_finish_run(
  p_account uuid,
  p_drafted integer,
  p_error   text DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.kb_learn_settings
     SET last_run_drafted = greatest(coalesce(p_drafted, 0), 0),
         last_run_error = CASE
           WHEN p_error IS NULL THEN NULL
           WHEN p_error IN ('no_ai', 'read_failed', 'out_of_time', 'model') THEN p_error
           ELSE 'failed' END,
         next_run_at    = CASE WHEN p_error IS NULL THEN now() + interval '7 days' ELSE next_run_at END,
         attempts       = CASE WHEN p_error IS NULL THEN 0 ELSE attempts END,
         attempts_since = CASE WHEN p_error IS NULL THEN NULL ELSE attempts_since END
   WHERE account_id = p_account
     AND last_run_error = 'running';
$$;

REVOKE ALL ON FUNCTION public.kb_learn_finish_run(uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kb_learn_finish_run(uuid, integer, text) TO service_role;

-- The topics asked in the last 7 days: every ledger row (drafted,
-- discarded, backed off). They count toward the run's ten, so a run
-- retried every hour still asks about at most ten topics a week.
CREATE OR REPLACE FUNCTION public.kb_learn_asked_this_week(p_account uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*)::integer FROM public.kb_learned_drafts
   WHERE account_id = p_account AND created_at > now() - interval '7 days';
$$;

REVOKE ALL ON FUNCTION public.kb_learn_asked_this_week(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kb_learn_asked_this_week(uuid) TO service_role;

-- Whether a topic already has a live draft: a ledger row whose entry
-- still exists and is not 'remove', and that is the same topic (half or
-- more of its gaps are in this one, or the same label hash); or a draft
-- of it was discarded within the last 28 days.
CREATE OR REPLACE FUNCTION public.kb_learn_topic_drafted(
  p_account uuid,
  p_gap_ids uuid[],
  p_topic_key text
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
      LEFT JOIN public.kb_entries e ON e.id = l.entry_id AND e.account_id = l.account_id
     WHERE l.account_id = p_account
       AND (e.status <> 'remove' OR l.discarded_at > now() - interval '28 days')
       AND (
         l.topic_key = p_topic_key
         OR (cardinality(l.gap_ids) > 0
             AND 2 * (SELECT count(*) FROM unnest(l.gap_ids) g
                       WHERE g = ANY (coalesce(p_gap_ids, '{}')))
                 >= cardinality(l.gap_ids))
       )
  );
$$;

REVOKE ALL ON FUNCTION public.kb_learn_topic_drafted(uuid, uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kb_learn_topic_drafted(uuid, uuid[], text) TO service_role;

-- The topics' looks: stamped after each, the model's failures in a row.
CREATE OR REPLACE FUNCTION public.kb_learn_note_look(
  p_account uuid, p_gap_ids uuid[], p_model_failed boolean
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.kb_learn_looks AS l (gap_id, account_id, looked_at, model_failures)
  SELECT g.id, g.account_id, now(), CASE WHEN p_model_failed THEN 1 ELSE 0 END
    FROM public.ai_knowledge_gaps g
   WHERE g.account_id = p_account AND g.id = ANY (coalesce(p_gap_ids, '{}'))
  ON CONFLICT (gap_id) DO UPDATE
    SET looked_at = now(),
        model_failures = CASE WHEN p_model_failed THEN l.model_failures + 1 ELSE 0 END;
$$;

REVOKE ALL ON FUNCTION public.kb_learn_note_look(uuid, uuid[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kb_learn_note_look(uuid, uuid[], boolean) TO service_role;

-- A gap deleted (a subject erase does): its id leaves the ledger, and an
-- unapproved learned draft left with fewer than two chats goes.
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
       SET gap_ids = coalesce((SELECT array_agg(g) FROM unnest(l.gap_ids) g WHERE g <> ALL (v_ids)), '{}')
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
DROP TRIGGER IF EXISTS kb_learn_gaps_deleted ON public.ai_knowledge_gaps;
CREATE TRIGGER kb_learn_gaps_deleted AFTER DELETE ON public.ai_knowledge_gaps
  REFERENCING OLD TABLE AS gone FOR EACH STATEMENT
  EXECUTE FUNCTION public.kb_learn_gaps_deleted();

-- The open topics worth asking about, each with its gap ids newest first:
-- never looked at first, then the longest ago (by day), the most asked
-- first within. Covered, drafted (by gaps; the run checks the label's key,
-- which only the app can make) and backed-off topics are left out, so they
-- never use up the limit; three model failures in a row wait 28 days.
CREATE OR REPLACE FUNCTION public.kb_learn_open_topics(
  p_account uuid,
  p_limit   integer DEFAULT 200
)
RETURNS TABLE (id uuid, label text, coverage text, gap_ids uuid[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT t.id, t.label, t.coverage, g.ids
    FROM public.kb_gap_topics t
    CROSS JOIN LATERAL (
      SELECT array_agg(k.id ORDER BY k.created_at DESC, k.id) AS ids
        FROM public.kb_gap_topic_members m
        JOIN public.ai_knowledge_gaps k ON k.id = m.gap_id AND k.account_id = m.account_id
       WHERE m.topic_id = t.id AND m.account_id = t.account_id) g
    LEFT JOIN LATERAL (
      SELECT max(x.looked_at) AS looked_at, max(x.model_failures) AS failures
        FROM public.kb_learn_looks x WHERE x.gap_id = ANY (g.ids)) lk ON true
   WHERE t.account_id = p_account
     AND t.status = 'open'
     AND t.coverage NOT IN ('full', 'partial')
     AND g.ids IS NOT NULL
     AND NOT public.kb_learn_topic_drafted(p_account, g.ids, NULL)
     AND NOT (coalesce(lk.failures, 0) >= 3 AND lk.looked_at > now() - interval '28 days')
   ORDER BY (lk.looked_at AT TIME ZONE 'UTC')::date NULLS FIRST, t.question_count DESC, t.id
   LIMIT least(greatest(coalesce(p_limit, 200), 1), 500);
$$;

REVOKE ALL ON FUNCTION public.kb_learn_open_topics(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kb_learn_open_topics(uuid, integer) TO service_role;

-- The one writer. Answers {status}: 'drafted' (with entry_id), or the
-- refusal: 'disabled', 'already', 'invalid', 'ref_taken'. The entry is
-- always status 'draft': a person approves it, never this function.
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
    (account_id, topic_id, topic_key, gap_ids, entry_id, evidence_count)
  VALUES
    (p_account, p_topic_id, p_topic_key, v_gaps, v_entry, p_evidence_count);

  RETURN jsonb_build_object('status', 'drafted', 'entry_id', v_entry);
END $$;

REVOKE ALL ON FUNCTION public.kb_learn_record_draft(uuid, uuid, text, uuid[], text, text, text, text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kb_learn_record_draft(uuid, uuid, text, uuid[], text, text, text, text, text, integer)
  TO service_role;

-- The model's text carried a name or an identifier, or it declined or
-- answered malformed: remember the topic (gap ids and hash only), so it is
-- not asked again for 28 days. Nothing is
-- written while the switch is off.
CREATE OR REPLACE FUNCTION public.kb_learn_record_discard(
  p_account        uuid,
  p_topic_id       uuid,
  p_topic_key      text,
  p_gap_ids        uuid[],
  p_evidence_count integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_gaps uuid[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.kb_learn_settings
                  WHERE account_id = p_account AND enabled) THEN
    RETURN false;
  END IF;
  SELECT coalesce(array_agg(DISTINCT g.id), '{}') INTO v_gaps
    FROM public.ai_knowledge_gaps g
   WHERE g.account_id = p_account AND g.id = ANY (coalesce(p_gap_ids, '{}'));
  IF cardinality(v_gaps) = 0 THEN
    RETURN false;
  END IF;
  INSERT INTO public.kb_learned_drafts
    (account_id, topic_id, topic_key, gap_ids, evidence_count, discarded_at)
  VALUES
    (p_account, p_topic_id, p_topic_key, v_gaps, p_evidence_count, now());
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.kb_learn_record_discard(uuid, uuid, text, uuid[], integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kb_learn_record_discard(uuid, uuid, text, uuid[], integer)
  TO service_role;

-- Names the service role may not read as tables (the bank contact log of
-- 124, the case desk's companies of 220), for masking only: one distinct
-- list in order, paged by the last name seen. Names only, nothing else.
CREATE OR REPLACE FUNCTION public.kb_learn_case_names(
  p_account uuid,
  p_after   text DEFAULT NULL,
  p_limit   integer DEFAULT 1000
)
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT x.name
    FROM (SELECT b.contact_name COLLATE "C" AS name FROM public.case_bank_contacts b
           WHERE b.account_id = p_account
          UNION
          SELECT d.legal_name COLLATE "C" FROM public.desk_customers d
           WHERE d.account_id = p_account) x
   WHERE x.name <> '' AND (p_after IS NULL OR x.name > p_after COLLATE "C")
   ORDER BY x.name
   LIMIT least(greatest(coalesce(p_limit, 1000), 1), 1000);
$$;

REVOKE ALL ON FUNCTION public.kb_learn_case_names(uuid, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kb_learn_case_names(uuid, text, integer) TO service_role;
