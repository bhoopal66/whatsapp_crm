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
 *   kb           — the approved-answers mode (081) decided a person
 *                  must take it: pricing, legal or an angry message,
 *                  or an answer flagged "hand off after"
 */
export type AiHandoffReason =
  | 'keyword'
  | 'no_knowledge'
  | 'model'
  | 'error'
  | 'cap'
  | 'triage'
  | 'guardrail'
  | 'kb';

export const AI_HANDOFF_REASONS: readonly AiHandoffReason[] = [
  'keyword',
  'no_knowledge',
  'model',
  'error',
  'cap',
  'triage',
  'guardrail',
  'kb',
];

/**
 * Why the AI needs a person, in plain words, as one or more sentences a
 * person can act on — e.g. `the customer's message matched the
 * escalation keyword “refund”.` Starts lower case: it follows the
 * note's lead ("🤖 AI needs a person: …"); `upperFirst` it to stand
 * alone (the bell).
 */
export function describeHandoffReason(
  reason: AiHandoffReason,
  detail?: string | null
): string {
  switch (reason) {
    case 'keyword':
      return detail
        ? `the customer's message matched the escalation keyword “${detail}”.`
        : "the customer's message matched an escalation keyword.";
    case 'no_knowledge':
      return detail
        ? `the knowledge base has nothing close enough to answer from (${detail}).`
        : 'the knowledge base has nothing close enough to answer from.';
    case 'error':
      return detail
        ? `the AI provider failed (${truncate(detail, 120)}).`
        : 'the AI provider failed.';
    case 'model':
      return 'the AI was unsure and asked for a person.';
    case 'cap':
      return detail
        ? `the AI reached its reply limit for this chat (${detail}).`
        : 'the AI reached its reply limit for this chat.';
    case 'triage':
      return detail
        ? `the safety check routed the message to a person (${detail}).`
        : 'the safety check routed the message to a person.';
    case 'guardrail':
      // The guardrail gate writes its own plain-English sentence.
      return detail?.trim() || 'the safety check held the drafted reply.';
    case 'kb':
      return detail
        ? `the approved answers need a person here (${detail}).`
        : 'the approved answers need a person here.';
  }
}

/** The first letter upper-cased, for a reason that stands alone. */
export function upperFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
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
 * Leads with what to do, then why, e.g.:
 *   "🤖 AI needs a person after 2 replies: the customer's message
 *    matched the escalation keyword “refund”. Last customer message:
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
      ? 'before replying'
      : `after ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`;

  const why = reasonText?.trim()
    ? reasonText.trim()
    : reason
      ? describeHandoffReason(reason, detail)
      : '';
  const lead = `🤖 AI needs a person ${replies}`;
  const base = why ? `${lead}: ${why}` : `${lead}.`;

  if (!lastCustomer) return base;

  const quote = truncate(lastCustomer.content.trim(), MAX_QUOTE_LEN);
  return `${base} Last customer message: “${quote}”`;
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ');
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}
