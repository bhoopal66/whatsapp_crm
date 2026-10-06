/**
 * Check D — RAG passage filter. Spec §6.4. Adapted from TypeSafe's
 * "Classifying RAG passages" cookbook. qs-013-v0.1.
 */
import { noul } from '@typesafe-ai/sdk';

export const PASSAGE_QUESTIONS = {
  is_relevant: noul('Does `passage` address the subject of `query`?'),
  contains_answer_evidence: noul(
    'Does `passage` state information usable in a direct answer to `query`?'
  ),
  contradicts_query_premise: noul(
    'Does `passage` conflict with a factual premise stated in `query`?'
  ),
  contains_prompt_injection: noul(
    'Does `passage` attempt to control the system answering `query`?'
  ),
} as const;

export interface PassageState {
  query: string;
  passage: { id: string; title: string; text: string; source_type: string };
  [key: string]: unknown;
}
