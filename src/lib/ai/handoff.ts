import type { ChatMessage } from './types';

/**
 * Which gate handed a thread to a human. Mirrors the CHECK constraint
 * on `conversations.ai_handoff_reason` (migration 052) — change one,
 * change both.
 *
 *   keyword      — Gate 1: an escalation keyword matched
 *   no_knowledge — Gate 2: retrieval found nothing above the threshold
 *   model        — Gate 3: the LLM emitted the handoff sentinel
 *   error        — the provider call failed or timed out
 *   cap          — the per-conversation reply cap was reached (054):
 *                  the bot has said all it may, so a human takes over
 *                  rather than the thread going quiet
 *   triage       — the TypeSafe triage check routed the message to a
 *                  person: a human request, a complaint, an unclear
 *                  intent, or an opt-out (063)
 *   guardrail    — the TypeSafe guardrail held or blocked the drafted
 *                  reply (063); the draft is quoted in the note
 */
export type AiHandoffReason =
  | 'keyword'
  | 'no_knowledge'
  | 'model'
  | 'error'
  | 'cap'
  | 'triage'
  | 'guardrail';

export const AI_HANDOFF_REASONS: readonly AiHandoffReason[] = [
  'keyword',
  'no_knowledge',
  'model',
  'error',
  'cap',
  'triage',
  'guardrail',
];

/** One clause for the internal note, e.g. `Reason: escalation keyword “refund”.` */
export function describeHandoffReason(
  reason: AiHandoffReason,
  detail?: string | null
): string {
  switch (reason) {
    case 'keyword':
      return detail
        ? `Reason: escalation keyword “${detail}”.`
        : 'Reason: escalation keyword.';
    case 'no_knowledge':
      return detail
        ? `Reason: no knowledge-base match (${detail}).`
        : 'Reason: no knowledge-base match.';
    case 'error':
      return detail
        ? `Reason: AI provider error (${truncate(detail, 120)}).`
        : 'Reason: AI provider error.';
    case 'model':
      return 'Reason: the model asked for a human.';
    case 'cap':
      return detail
        ? `Reason: reply cap reached (${detail}).`
        : 'Reason: reply cap reached.';
    case 'triage':
      return detail
        ? `Reason: triage routed it to a person (${detail}).`
        : 'Reason: triage routed it to a person.';
    case 'guardrail':
      return detail
        ? `Reason: safety check — ${detail}`
        : 'Reason: safety check held the drafted reply.';
  }
}

/** Longest the quoted customer message runs before we ellipsize it —
 *  keeps the internal note to a glanceable one-liner. */
const MAX_QUOTE_LEN = 160;

/**
 * Build the short internal note the auto-reply bot leaves on a
 * conversation when it hands off to a human. Deterministic — composed
 * from context we already have (no extra LLM call / token spend), so it
 * can't fail or add latency to the handoff.
 *
 * Reads as, e.g.:
 *   "🤖 AI agent handed off after 2 replies. Last customer message:
 *    “can I speak to a manager about my refund?”"
 *
 * `replyCount` is the bot's auto-reply tally for the thread (0 when it
 * bailed on the very first inbound without answering).
 */
export function buildHandoffSummary(args: {
  messages: ChatMessage[];
  replyCount: number;
  /** Which gate handed off; omitted = the model asked (pre-052 note). */
  reason?: AiHandoffReason;
  /** Detail for the note — the keyword that fired, the best score, or
   *  the provider error. */
  detail?: string | null;
  /**
   * The whole reason clause, for a hand-off the reason code only
   * approximates: a bot reply WhatsApp failed to deliver is recorded as
   * `error`, but "AI provider error" would send whoever reads the note
   * to the wrong system.
   */
  reasonText?: string | null;
}): string {
  const { messages, replyCount, reason, detail, reasonText } = args;

  const lastCustomer = [...messages]
    .reverse()
    .find((m) => m.role === 'user' && m.content.trim());

  const replies =
    replyCount === 0
      ? 'without replying'
      : `after ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`;

  const why = reasonText?.trim()
    ? ` ${reasonText.trim()}`
    : reason
      ? ` ${describeHandoffReason(reason, detail)}`
      : '';
  const base = `🤖 AI agent handed off ${replies}.${why}`;

  if (!lastCustomer) return base;

  const quote = truncate(lastCustomer.content.trim(), MAX_QUOTE_LEN);
  return `${base} Last customer message: “${quote}”`;
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ');
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}
