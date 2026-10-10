/**
 * Approved-answers policy (module 017): turns Jev's selection judgment
 * (lib/typesafe/checks/kb-select.ts) into one of two outcomes — send one
 * approved answer verbatim, or hand the thread to a person. The bot never
 * writes text in this mode, so every doubt resolves to a hand-off.
 *
 * Pure: no I/O, no clock.
 */

/** A shortlisted approved Q&A row. Structural, so the data layer's own
 *  row type can be passed as is. */
export interface KbCandidate {
  id: string;
  ref: string;
  question: string;
  answerEn: string;
  answerAr: string | null;
  /** Send the answer, then hand the thread to a person. */
  handoffAfter: boolean;
}

/** `detectLanguage` (lib/typesafe/redact.ts) of the customer's message. */
export type KbLanguage = 'en' | 'ar' | 'mixed' | 'other' | 'unknown';

/** The figures of a successful selection judgment. */
export interface KbSelectScores {
  handoff: { pricing: number; legal: number; angry: number };
  /** `index` is the candidate's position in the shortlist. */
  candidates: { index: number; answersFully: number; sameIntent: number }[];
}

export type ApprovedAnswerDecision<C extends KbCandidate = KbCandidate> =
  | {
      kind: 'send';
      entry: C;
      /** The approved answer, verbatim, in the customer's language. */
      text: string;
      score: number;
      thenHandOff: boolean;
    }
  | { kind: 'handoff'; reason: 'kb' | 'no_knowledge'; detail: string };

/** A hand-off condition at or above this probability hands off. */
export const KB_HANDOFF_THRESHOLD = 0.5;

const HANDOFF_CONDITIONS = ['pricing', 'legal', 'angry'] as const;

/** Two decimals, rounded down, so a failing score never prints as the
 *  minimum it missed (0.799 is "0.79", not "0.80"). */
const fmt = (n: number): string =>
  (Math.floor(n * 100 + 1e-9) / 100).toFixed(2);

export function decideApprovedAnswer<C extends KbCandidate>(args: {
  language: KbLanguage;
  judgment: KbSelectScores;
  /** The shortlist, in the order the judgment's indices refer to. */
  candidates: readonly C[];
  minScore: number;
}): ApprovedAnswerDecision<C> {
  const { language, judgment, candidates, minScore } = args;

  const raised = HANDOFF_CONDITIONS.filter(
    (k) => judgment.handoff[k] >= KB_HANDOFF_THRESHOLD
  );
  if (raised.length > 0)
    return {
      kind: 'handoff',
      reason: 'kb',
      detail: `Hand-off condition: ${raised
        .map((k) => `${k} (${fmt(judgment.handoff[k])})`)
        .join(', ')}`,
    };

  // An answer must both fit the question the customer asked and fully
  // answer it: the weaker of the two is the candidate's score.
  let best: { entry: C; score: number } | null = null;
  const judged = [...judgment.candidates].sort((a, b) => a.index - b.index);
  for (const j of judged) {
    const entry = candidates[j.index];
    const score = Math.min(j.answersFully, j.sameIntent);
    if (!entry || !Number.isFinite(score)) continue;
    // Strictly greater: a tie keeps the earlier shortlist row.
    if (!best || score > best.score) best = { entry, score };
  }
  if (!best)
    return {
      kind: 'handoff',
      reason: 'no_knowledge',
      detail: 'No approved answer matched',
    };
  if (best.score < minScore)
    return {
      kind: 'handoff',
      reason: 'no_knowledge',
      detail: `Best approved answer ${best.entry.ref} scored ${fmt(best.score)} (needs ${minScore.toFixed(2)})`,
    };

  if (language === 'other')
    return {
      kind: 'handoff',
      reason: 'no_knowledge',
      detail: `No approved answer in the customer's language for ${best.entry.ref}`,
    };
  const text = language === 'ar' ? best.entry.answerAr : best.entry.answerEn;
  if (!text?.trim())
    return {
      kind: 'handoff',
      reason: 'no_knowledge',
      detail:
        language === 'ar'
          ? `No approved Arabic answer for ${best.entry.ref}`
          : `No approved English answer for ${best.entry.ref}`,
    };

  return {
    kind: 'send',
    entry: best.entry,
    text,
    score: best.score,
    thenHandOff: best.entry.handoffAfter,
  };
}

/** One-line outcome detail for a sent approved answer:
 *  "Approved answer KB-010 (0.91)". */
export function describeKbSelection(sent: {
  entry: Pick<KbCandidate, 'ref'>;
  score: number;
}): string {
  return `Approved answer ${sent.entry.ref} (${fmt(sent.score)})`;
}
