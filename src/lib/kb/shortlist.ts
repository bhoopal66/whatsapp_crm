import type { SupabaseClient } from '@supabase/supabase-js';

import type { KbCandidate } from './types';

/**
 * The approved answers worth showing the selector for `query`: the
 * bot's only read of `kb_entries` (`kb_shortlist`, service role). SQL
 * returns approved, client-audience rows only; an account with at most
 * 8 of them (KB_SELECT_MAX_CANDIDATES, the most the judge reads) gets
 * all, ignoring `limit`.
 *
 * Throws on an RPC error: the caller must hand off rather than treat a
 * failed read as "no answer fits". A row without the fields an answer
 * needs is dropped rather than sent.
 */
export async function shortlistApprovedAnswers(
  db: SupabaseClient,
  accountId: string,
  query: string,
  limit = 8
): Promise<KbCandidate[]> {
  const { data, error } = await db.rpc('kb_shortlist', {
    p_account_id: accountId,
    p_query: query,
    p_limit: limit,
  });
  if (error) throw new Error(`kb_shortlist failed: ${error.message}`);
  if (!Array.isArray(data)) return [];
  return data.flatMap((raw: unknown): KbCandidate[] => {
    if (!raw || typeof raw !== 'object') return [];
    const r = raw as Record<string, unknown>;
    if (
      typeof r.id !== 'string' ||
      typeof r.ref !== 'string' ||
      typeof r.question !== 'string' ||
      typeof r.answer_en !== 'string' ||
      r.answer_en.trim() === '' ||
      typeof r.handoff_after !== 'boolean' ||
      typeof r.rank !== 'number' ||
      !Number.isFinite(r.rank)
    ) {
      return [];
    }
    return [
      {
        id: r.id,
        ref: r.ref,
        question: r.question,
        answer_en: r.answer_en,
        answer_ar:
          typeof r.answer_ar === 'string' && r.answer_ar.trim() !== ''
            ? r.answer_ar
            : null,
        handoff_after: r.handoff_after,
        rank: r.rank,
      },
    ];
  });
}
