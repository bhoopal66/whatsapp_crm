/**
 * What of a chat the assistant reads: only the messages the caller's own
 * client returns (RLS decides company or personal chat), at most the
 * latest `CHAT_ASSIST_MESSAGE_CAP`, each clipped, oldest first. Team
 * notes (241) are never read here: they live in their own table and
 * stay out of AI context (`notes-isolation.test.ts`).
 *
 * Pure, so the cap is tested without a database.
 */
import type { DraftMessageRow } from '@/lib/ai/draft-prompt';

/** The most recent messages the assistant sees. */
export const CHAT_ASSIST_MESSAGE_CAP = 60;
/** One message's text, at most. */
export const CHAT_ASSIST_MESSAGE_CHARS = 1_000;
/** The whole transcript, at most: the oldest lines go first. */
export const CHAT_ASSIST_TRANSCRIPT_CHARS = 24_000;

/** The columns the route reads (the same as the draft route's). */
export const CHAT_ASSIST_MESSAGE_COLUMNS =
  'sender_type, content_type, content_text, created_at, status';

const clip = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n - 1)}…`;

/**
 * The rows the assistant works from: failed sends dropped, the newest
 * `cap` kept, oldest first, each text clipped. Rows may arrive in any
 * order (the route reads newest first).
 */
export function capChatContext(
  rows: readonly DraftMessageRow[],
  cap: number = CHAT_ASSIST_MESSAGE_CAP
): DraftMessageRow[] {
  const n = Math.max(0, Math.floor(cap));
  return [...rows]
    .filter((r) => r && r.status !== 'failed')
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, n)
    .reverse()
    .map((r) => ({
      ...r,
      content_text:
        typeof r.content_text === 'string'
          ? clip(r.content_text, CHAT_ASSIST_MESSAGE_CHARS)
          : null,
    }));
}

/**
 * Transcript lines kept within `CHAT_ASSIST_TRANSCRIPT_CHARS`, dropping
 * the oldest first. `dropped` says how many were left out.
 */
export function fitTranscript(
  lines: readonly string[],
  maxChars: number = CHAT_ASSIST_TRANSCRIPT_CHARS
): { lines: string[]; dropped: number } {
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i].length + 1;
    if (used + cost > maxChars) break;
    kept.unshift(lines[i]);
    used += cost;
  }
  return { lines: kept, dropped: lines.length - kept.length };
}
