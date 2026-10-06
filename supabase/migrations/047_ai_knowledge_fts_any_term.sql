-- ============================================================
-- 047_ai_knowledge_fts_any_term.sql — lexical KB search matches ANY
-- content word of the question, ranked by how many match.
--
-- `plainto_tsquery` ANDs every word, and the 'simple' config keeps stop
-- words, so a natural question ("how many days to get IBAN?") only hit
-- a chunk containing *how*, *many*, *days*, *to*, *get* AND *iban* — in
-- practice nothing, and an account without an embeddings key ran its
-- bot with an empty knowledge base.
--
-- The rewrite keeps the 'simple' tokeniser (the `fts` column is built
-- with it, and it leaves Arabic alone), drops the English stop words
-- by asking the English stemmer whether it has anything to say about
-- each token (it returns '{}' for a stop word and the word itself for
-- anything it doesn't recognise, Arabic included), and ORs what is
-- left so ts_rank orders chunks by term overlap — which is what a
-- lexical fallback should do. A question made only of stop words
-- matches nothing, as before.
--
-- Re-runnable: CREATE OR REPLACE only.
-- ============================================================

CREATE OR REPLACE FUNCTION public.match_ai_knowledge_fts(
  p_account_id  uuid,
  p_query       text,
  p_match_count integer
)
RETURNS TABLE (id uuid, content text, rank real) AS $$
  WITH terms AS (
    SELECT DISTINCT lexeme
    FROM unnest(to_tsvector('simple', p_query))
    WHERE ts_lexize('english_stem', lexeme) <> '{}'
  ),
  q AS (
    SELECT to_tsquery('simple', string_agg(quote_literal(lexeme), ' | ')) AS tsq
    FROM terms
  )
  SELECT c.id,
         c.content,
         ts_rank(c.fts, q.tsq) AS rank
  FROM ai_knowledge_chunks c, q
  WHERE q.tsq IS NOT NULL
    AND c.account_id = p_account_id
    AND c.fts @@ q.tsq
  ORDER BY rank DESC
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
