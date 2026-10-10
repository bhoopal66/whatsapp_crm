-- ============================================================
-- 081: approved answers (the bot that never writes text)
--
-- A new AI auto-reply mode, ai_configs.answer_mode = 'approved': the
-- bot does not generate. It either sends an admin-approved answer word
-- for word (chosen by a TypeSafe judgment over a shortlist) or hands
-- the chat to a person. The answers live in kb_entries, imported from
-- the review spreadsheet (sheet Knowledge_Base) through kb_import().
--
-- kb_entries is per account. Members read it; admins write it. An
-- answer can only be `approved` while it is usable: a blank answer or
-- one still carrying a "[TO CONFIRM …]" placeholder is refused by the
-- kb_entries_approved_usable CHECK, so a placeholder can never reach a
-- customer. A trigger owns version, updated_at and the approval stamp:
-- editing a question or an answer bumps version; approving (or editing
-- the answer of an approved row) stamps approved_at / approved_by;
-- leaving `approved` clears them.
--
-- kb_shortlist() is the only read the bot makes. It runs as the
-- service role and returns approved rows for the two CLIENT audiences
-- only: internal_staff answers are hard-coded out and never reach a
-- customer whatever the caller asks. Ranking is 047's any-term lexical
-- match; an account with at most 12 approved client answers gets all of
-- them, so a paraphrase sharing no word with the question still reaches
-- the reranker.
--
-- kb_import() upserts a parsed sheet by (account_id, ref) in one
-- transaction, as the calling admin (RLS applies), and writes one
-- kb_imports audit row. Rows missing from the file are left alone; an
-- optional column the file does not have (its key absent from a row)
-- keeps the stored value.
--
-- ai_configs gains answer_mode, approved_min_score (the selection
-- confidence floor) and sensitive_data_reply (NULL = off). The hand-off
-- reason CHECK gains 'kb' (an approved answer needs a person), keeping
-- every 052/054/063 value.
--
-- Re-runnable: CREATE … IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
-- guarded constraints, CREATE OR REPLACE, DROP POLICY IF EXISTS.
-- ============================================================

SET lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. kb_entries
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kb_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  ref             text NOT NULL,
  audience        text NOT NULL,
  category        text NOT NULL DEFAULT '',
  question        text NOT NULL,
  answer_en       text NOT NULL DEFAULT '',
  answer_ar       text NULL,
  status          text NOT NULL DEFAULT 'draft',
  handoff_after   boolean NOT NULL DEFAULT false,
  source          text NULL,
  reviewer_notes  text NULL,
  version         integer NOT NULL DEFAULT 1,
  approved_by     uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at     timestamptz NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  search          tsvector GENERATED ALWAYS AS (
    to_tsvector('simple'::regconfig,
      question || ' ' || category || ' ' || answer_en || ' ' || coalesce(answer_ar, ''))
  ) STORED,
  CONSTRAINT kb_entries_account_ref_key UNIQUE (account_id, ref),
  CONSTRAINT kb_entries_audience_check CHECK (
    audience IN ('prospective_client', 'existing_client', 'internal_staff')),
  CONSTRAINT kb_entries_status_check CHECK (
    status IN ('approved', 'draft', 'to_confirm', 'remove')),
  CONSTRAINT kb_entries_approved_usable CHECK (
    status <> 'approved' OR (
      btrim(answer_en) <> ''
      AND answer_en !~* '\[\s*to confirm'
      AND (answer_ar IS NULL OR answer_ar !~* '\[\s*to confirm')
    ))
);

CREATE INDEX IF NOT EXISTS kb_entries_search_idx
  ON public.kb_entries USING gin (search);
CREATE INDEX IF NOT EXISTS kb_entries_account_status_idx
  ON public.kb_entries (account_id, status);

COMMENT ON TABLE public.kb_entries IS
  'Admin-approved answers for the approved-answers bot mode (migration 081). Only status=approved rows for the two client audiences are ever sent (kb_shortlist).';
COMMENT ON COLUMN public.kb_entries.handoff_after IS
  'Send the answer, then hand the chat to a person.';

CREATE OR REPLACE FUNCTION public.kb_entries_stamp()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  answers_changed boolean;
BEGIN
  IF NEW.answer_ar IS NOT NULL AND btrim(NEW.answer_ar) = '' THEN
    NEW.answer_ar := NULL;
  END IF;
  NEW.updated_at := now();

  IF TG_OP = 'INSERT' THEN
    NEW.version := 1;
    IF NEW.status = 'approved' THEN
      NEW.approved_at := now();
      NEW.approved_by := auth.uid();
    ELSE
      NEW.approved_at := NULL;
      NEW.approved_by := NULL;
    END IF;
    RETURN NEW;
  END IF;

  answers_changed := NEW.answer_en IS DISTINCT FROM OLD.answer_en
                  OR NEW.answer_ar IS DISTINCT FROM OLD.answer_ar;
  -- version is trigger-owned: a client cannot set it.
  NEW.version := OLD.version
    + CASE WHEN answers_changed OR NEW.question IS DISTINCT FROM OLD.question
           THEN 1 ELSE 0 END;

  IF NEW.status = 'approved' THEN
    IF OLD.status IS DISTINCT FROM 'approved' OR answers_changed THEN
      NEW.approved_at := now();
      NEW.approved_by := auth.uid();
    ELSE
      NEW.approved_at := OLD.approved_at;
      NEW.approved_by := OLD.approved_by;
    END IF;
  ELSE
    NEW.approved_at := NULL;
    NEW.approved_by := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS kb_entries_stamp ON public.kb_entries;
CREATE TRIGGER kb_entries_stamp
  BEFORE INSERT OR UPDATE ON public.kb_entries
  FOR EACH ROW EXECUTE FUNCTION public.kb_entries_stamp();

ALTER TABLE public.kb_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kb_entries_select ON public.kb_entries;
CREATE POLICY kb_entries_select ON public.kb_entries FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS kb_entries_insert ON public.kb_entries;
CREATE POLICY kb_entries_insert ON public.kb_entries FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS kb_entries_update ON public.kb_entries;
CREATE POLICY kb_entries_update ON public.kb_entries FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS kb_entries_delete ON public.kb_entries;
CREATE POLICY kb_entries_delete ON public.kb_entries FOR DELETE
  USING (is_account_member(account_id, 'admin'));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.kb_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.kb_entries TO service_role;
REVOKE ALL ON public.kb_entries FROM anon;

-- ------------------------------------------------------------
-- 2. kb_imports (audit log; append-only for clients)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kb_imports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  imported_by  uuid NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  file_name    text NULL,
  total        integer NOT NULL DEFAULT 0,
  inserted     integer NOT NULL DEFAULT 0,
  updated      integer NOT NULL DEFAULT 0,
  unchanged    integer NOT NULL DEFAULT 0,
  skipped      integer NOT NULL DEFAULT 0,
  approved     integer NOT NULL DEFAULT 0,
  issues       jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kb_imports_account_created_idx
  ON public.kb_imports (account_id, created_at DESC);

ALTER TABLE public.kb_imports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kb_imports_select ON public.kb_imports;
CREATE POLICY kb_imports_select ON public.kb_imports FOR SELECT
  USING (is_account_member(account_id, 'admin'));

-- An audit row names its own importer: an admin cannot log an import
-- in someone else's name.
DROP POLICY IF EXISTS kb_imports_insert ON public.kb_imports;
CREATE POLICY kb_imports_insert ON public.kb_imports FOR INSERT
  WITH CHECK (
    is_account_member(account_id, 'admin')
    AND imported_by IS NOT DISTINCT FROM auth.uid()
  );

GRANT SELECT, INSERT ON public.kb_imports TO authenticated;
GRANT SELECT, INSERT ON public.kb_imports TO service_role;
REVOKE ALL ON public.kb_imports FROM anon;

-- ------------------------------------------------------------
-- 3. kb_import(): one transaction, as the calling admin
--
-- p_rows: [{ ref, audience, question, answer_en,
--            category?, answer_ar?, status?, handoff_after?,
--            source?, reviewer_notes?, row? }]
--   An absent optional key keeps the stored value (insert: default).
-- p_issues: [{ row, ref, message, skipped }] from the parser; the
--   ones with skipped=true count towards total and skipped.
-- A row this function cannot use (bad audience/status, no ref or
-- question) is skipped with an issue rather than failing the import;
-- an approved row whose answer is unusable is downgraded to to_confirm
-- with an issue, mirroring kb_entries_approved_usable.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kb_import(
  p_account_id uuid,
  p_file_name  text,
  p_rows       jsonb,
  p_issues     jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  r          jsonb;
  cur        public.kb_entries%ROWTYPE;
  v_ref      text;
  v_aud      text;
  v_cat      text;
  v_q        text;
  v_en       text;
  v_ar       text;
  v_status   text;
  v_handoff  boolean;
  v_source   text;
  v_notes    text;
  v_row      jsonb;
  new_id     uuid;
  n_ins      int := 0;
  n_upd      int := 0;
  n_same     int := 0;
  n_skip     int := 0;
  n_appr     int := 0;
  n_parser_skipped int := 0;
  issues     jsonb := '[]'::jsonb;
  import_id  uuid;
BEGIN
  IF p_account_id IS NULL OR NOT is_account_member(p_account_id, 'admin') THEN
    RAISE EXCEPTION 'only an admin of this account may import answers'
      USING ERRCODE = '42501';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'p_rows must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF p_issues IS NOT NULL AND jsonb_typeof(p_issues) = 'array' THEN
    issues := p_issues;
    SELECT count(*) INTO n_parser_skipped
      FROM jsonb_array_elements(p_issues) i
     WHERE jsonb_typeof(i) = 'object' AND (i->>'skipped') = 'true';
  END IF;

  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_row := CASE WHEN jsonb_typeof(r) = 'object' THEN r->'row' END;
    IF jsonb_typeof(r) <> 'object' THEN
      n_skip := n_skip + 1;
      issues := issues || jsonb_build_array(jsonb_build_object(
        'row', NULL, 'ref', NULL, 'message', 'Not a row object', 'skipped', true));
      CONTINUE;
    END IF;
    v_ref := upper(btrim(coalesce(r->>'ref', '')));
    v_aud := r->>'audience';
    v_q   := btrim(coalesce(r->>'question', ''));
    IF v_ref = '' OR v_q = ''
       OR v_aud IS NULL OR v_aud NOT IN ('prospective_client', 'existing_client', 'internal_staff')
       OR (r ? 'status' AND coalesce(r->>'status', '') NOT IN ('approved', 'draft', 'to_confirm', 'remove')) THEN
      n_skip := n_skip + 1;
      issues := issues || jsonb_build_array(jsonb_build_object(
        'row', v_row, 'ref', nullif(v_ref, ''),
        'message', 'Missing ID or question, or an unknown audience or status', 'skipped', true));
      CONTINUE;
    END IF;

    SELECT * INTO cur FROM kb_entries
     WHERE account_id = p_account_id AND ref = v_ref
     FOR UPDATE;

    -- Effective values: an absent optional key keeps the stored value.
    v_en := btrim(coalesce(r->>'answer_en', ''));
    v_cat := CASE WHEN r ? 'category' THEN btrim(coalesce(r->>'category', ''))
                  ELSE coalesce(cur.category, '') END;
    v_ar := CASE WHEN r ? 'answer_ar' THEN nullif(btrim(coalesce(r->>'answer_ar', '')), '')
                 ELSE cur.answer_ar END;
    v_status := CASE WHEN r ? 'status' THEN r->>'status'
                     ELSE coalesce(cur.status, 'draft') END;
    v_handoff := CASE WHEN r ? 'handoff_after' THEN coalesce((r->>'handoff_after')::boolean, false)
                      ELSE coalesce(cur.handoff_after, false) END;
    v_source := CASE WHEN r ? 'source' THEN nullif(btrim(coalesce(r->>'source', '')), '')
                     ELSE cur.source END;
    v_notes := CASE WHEN r ? 'reviewer_notes' THEN nullif(btrim(coalesce(r->>'reviewer_notes', '')), '')
                    ELSE cur.reviewer_notes END;

    IF v_status = 'approved' AND NOT (
         v_en <> '' AND v_en !~* '\[\s*to confirm'
         AND (v_ar IS NULL OR v_ar !~* '\[\s*to confirm')) THEN
      v_status := 'to_confirm';
      issues := issues || jsonb_build_array(jsonb_build_object(
        'row', v_row, 'ref', v_ref,
        'message', 'Marked Approved but the answer is empty or still says [TO CONFIRM]; imported as To confirm',
        'skipped', false));
    END IF;

    IF cur.id IS NULL THEN
      INSERT INTO kb_entries (account_id, ref, audience, category, question, answer_en,
                              answer_ar, status, handoff_after, source, reviewer_notes)
      VALUES (p_account_id, v_ref, v_aud, v_cat, v_q, v_en,
              v_ar, v_status, v_handoff, v_source, v_notes)
      RETURNING id INTO new_id;
      n_ins := n_ins + 1;
    ELSIF cur.audience = v_aud AND cur.category = v_cat AND cur.question = v_q
          AND cur.answer_en = v_en AND cur.answer_ar IS NOT DISTINCT FROM v_ar
          AND cur.status = v_status AND cur.handoff_after = v_handoff
          AND cur.source IS NOT DISTINCT FROM v_source
          AND cur.reviewer_notes IS NOT DISTINCT FROM v_notes THEN
      n_same := n_same + 1;
    ELSE
      UPDATE kb_entries
         SET audience = v_aud, category = v_cat, question = v_q, answer_en = v_en,
             answer_ar = v_ar, status = v_status, handoff_after = v_handoff,
             source = v_source, reviewer_notes = v_notes
       WHERE id = cur.id;
      n_upd := n_upd + 1;
    END IF;
    IF v_status = 'approved' THEN
      n_appr := n_appr + 1;
    END IF;
    cur := NULL;
  END LOOP;

  INSERT INTO kb_imports (account_id, file_name, total, inserted, updated, unchanged,
                          skipped, approved, issues)
  VALUES (p_account_id, nullif(btrim(coalesce(p_file_name, '')), ''),
          jsonb_array_length(p_rows) + n_parser_skipped, n_ins, n_upd, n_same,
          n_skip + n_parser_skipped, n_appr, issues)
  RETURNING id INTO import_id;

  RETURN jsonb_build_object(
    'inserted', n_ins, 'updated', n_upd, 'unchanged', n_same,
    'skipped', n_skip + n_parser_skipped, 'approved', n_appr,
    'import_id', import_id);
END;
$$;

REVOKE ALL ON FUNCTION public.kb_import(uuid, text, jsonb, jsonb) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.kb_import(uuid, text, jsonb, jsonb) TO authenticated;

-- ------------------------------------------------------------
-- 4. kb_shortlist(): the bot's only read (service role)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kb_shortlist(
  p_account_id uuid,
  p_query      text,
  p_limit      integer DEFAULT 8
)
RETURNS TABLE (
  id uuid, ref text, question text, answer_en text, answer_ar text,
  handoff_after boolean, rank real
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH pool AS (
    -- Hard-coded: approved, client audiences only. internal_staff is
    -- never returned, whatever the caller passes.
    SELECT e.*
      FROM kb_entries e
     WHERE e.account_id = p_account_id
       AND e.status = 'approved'
       AND e.audience IN ('prospective_client', 'existing_client')
  ),
  terms AS (
    SELECT DISTINCT lexeme
      FROM unnest(to_tsvector('simple', coalesce(p_query, '')))
     WHERE ts_lexize('english_stem', lexeme) <> '{}'
  ),
  q AS (
    SELECT to_tsquery('simple', string_agg(quote_literal(lexeme), ' | ')) AS tsq
      FROM terms
  ),
  small AS (
    SELECT count(*) <= 12 AS is_small FROM pool
  )
  SELECT p.id, p.ref, p.question, p.answer_en, p.answer_ar, p.handoff_after,
         (CASE WHEN q.tsq IS NULL THEN 0 ELSE ts_rank(p.search, q.tsq) END)::real AS rank
    FROM pool p, q, small
   WHERE small.is_small OR (q.tsq IS NOT NULL AND p.search @@ q.tsq)
   ORDER BY rank DESC, p.ref
   LIMIT (SELECT CASE WHEN count(*) <= 12 THEN NULL
                      ELSE GREATEST(coalesce(p_limit, 8), 0) END
            FROM pool);
$$;

REVOKE ALL ON FUNCTION public.kb_shortlist(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kb_shortlist(uuid, text, integer) TO service_role;

-- ------------------------------------------------------------
-- 5. ai_configs: the mode and its settings
-- ------------------------------------------------------------
ALTER TABLE public.ai_configs
  ADD COLUMN IF NOT EXISTS answer_mode text NOT NULL DEFAULT 'generate';
ALTER TABLE public.ai_configs
  ADD COLUMN IF NOT EXISTS approved_min_score real NOT NULL DEFAULT 0.8;
ALTER TABLE public.ai_configs
  ADD COLUMN IF NOT EXISTS sensitive_data_reply text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_configs_answer_mode_check'
  ) THEN
    ALTER TABLE public.ai_configs
      ADD CONSTRAINT ai_configs_answer_mode_check
      CHECK (answer_mode IN ('generate', 'approved'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_configs_approved_min_score_range'
  ) THEN
    ALTER TABLE public.ai_configs
      ADD CONSTRAINT ai_configs_approved_min_score_range
      -- real literals: a numeric 0.99 compares as a double, and the real
      -- 0.99 (0.9900000095…) would fail its own upper bound.
      CHECK (approved_min_score BETWEEN 0.5::real AND 0.99::real);
  END IF;
END $$;

COMMENT ON COLUMN public.ai_configs.answer_mode IS
  'generate = the model writes replies; approved = only send an approved kb_entries answer word for word, or hand off. Migration 081.';
COMMENT ON COLUMN public.ai_configs.approved_min_score IS
  'Approved-answers mode: the selection confidence an answer must reach to be sent (0.5-0.99). Migration 081.';
COMMENT ON COLUMN public.ai_configs.sensitive_data_reply IS
  'Reply sent when a customer message carries an Emirates ID, card number or IBAN; NULL = feature off. Migration 081.';

-- ------------------------------------------------------------
-- 6. Hand-off reason 'kb' (keeps every 052/054/063 value)
-- ------------------------------------------------------------
DO $$
DECLARE
  current_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO current_def
    FROM pg_constraint
   WHERE conname = 'conversations_ai_handoff_reason_check';
  IF current_def IS NOT NULL AND current_def NOT LIKE '%''kb''%' THEN
    ALTER TABLE conversations
      DROP CONSTRAINT conversations_ai_handoff_reason_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_ai_handoff_reason_check'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_ai_handoff_reason_check
      CHECK (ai_handoff_reason IS NULL OR ai_handoff_reason IN (
        'keyword', 'no_knowledge', 'model', 'error', 'cap', 'triage', 'guardrail', 'kb'
      ));
  END IF;
END $$;

COMMENT ON COLUMN conversations.ai_handoff_reason IS
  'Which AI gate handed this thread to a human: keyword (escalation list), no_knowledge (retrieval below threshold), model (the LLM asked), error (provider failure), cap (per-conversation reply cap reached), triage (TypeSafe triage routed it to a person, 063), guardrail (TypeSafe held or blocked the draft reply, 063), kb (approved-answers mode: no approved answer fits, or the answer hands off, 081). Mirrors AiHandoffReason in lib/ai/handoff.ts.';

RESET lock_timeout;
