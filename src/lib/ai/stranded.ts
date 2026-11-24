import type { SupabaseClient } from '@supabase/supabase-js';

import { loadAiConfig } from './config';
import { aiBurstWaitMs } from './defaults';
import { isGreetingOrThanks } from './router';

/**
 * A burst's earlier question whose answer nobody owes any more.
 *
 * Message A stands down (`skipped_superseded`) for a newer message B,
 * whose dispatch answers both. When B never reaches the model (an
 * automation, a Flow, a journey or a case rating took it), A's question
 * is nobody's. Both sides look, each after writing its own outcome row,
 * so whichever is later sees the other; the chat is then flagged for a
 * person, which is idempotent, and no second reply can go out.
 *
 * A B that a Flow, a journey or a rating took has no dispatch, hence no
 * row of its own: an ordinary answer must leave none. It looks first and
 * writes only when A's row is there, or may still come (`pending`).
 */

/** A question this much older than the message that took over is not its burst. */
const BURST_MS = 120_000;
/** How long after a message was sent its dispatch may still be starting:
 *  the gateway's delivery and the pipeline before it. */
const DISPATCH_LAG_MS = 10_000;
const SCAN = 10;

/** Outcomes after which an earlier superseded message is taken care of. */
const ANSWERED = ['replied', 'handed_off', 'held_for_review'];

/** Messages something else took, by when. A memory of this process only:
 *  a message it does not know costs at most one outcome row too many. */
const taken = new Map<string, number>();

/** A Flow, a journey or a rating took this message: no dispatch of its
 *  own will ever stand down, so it is nobody's lost question. */
export function noteTaken(messageId: string): void {
  const now = Date.now();
  for (const [id, at] of taken) {
    if (now - at <= 2 * BURST_MS) break;
    taken.delete(id);
  }
  taken.set(messageId, now);
}

async function customerTexts(db: SupabaseClient, conversationId: string) {
  const { data, error } = await db
    .from('messages')
    .select('message_id, created_at, content_text')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .not('content_text', 'is', null)
    .order('created_at', { ascending: false })
    .limit(SCAN);
  if (error) throw new Error(error.message);
  return (
    (data ?? []) as {
      message_id: string | null;
      created_at: string;
      content_text: string;
    }[]
  ).filter((m) => m.content_text?.trim());
}

/**
 * The questions of the burst this message closes: when the oldest was
 * asked, and whether the newest one's dispatch may not have stood down
 * yet. Null for none: a bare greeting or thanks asks nothing, and a
 * message something else took is owed nothing. Never throws.
 */
export async function earlierQuestion(
  db: SupabaseClient,
  conversationId: string,
  messageId: string
): Promise<{ since: string; pending: boolean } | null> {
  try {
    const rows = await customerTexts(db, conversationId);
    const i = rows.findIndex((m) => m.message_id === messageId);
    if (i < 0) return null;
    const at = Date.parse(rows[i]!.created_at);
    const questions = rows
      .slice(i + 1)
      .filter(
        (m) =>
          at - Date.parse(m.created_at) <= BURST_MS &&
          !isGreetingOrThanks(m.content_text) &&
          !(m.message_id && taken.has(m.message_id))
      );
    if (questions.length === 0) return null;
    return {
      since: questions.at(-1)!.created_at,
      pending:
        Date.now() - Date.parse(questions[0]!.created_at) <=
        aiBurstWaitMs() + DISPATCH_LAG_MS,
    };
  } catch (err) {
    console.error('[ai auto-reply] earlier question lookup failed:', err);
    return null;
  }
}

/** Whether the bot has to look at a message something else took. With
 *  auto-reply off nothing is read past that. Never throws. */
export async function closesBurst(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  messageId: string
): Promise<boolean> {
  try {
    const config = await loadAiConfig(db, accountId);
    if (!config?.autoReplyEnabled) return false;
  } catch (err) {
    console.error('[ai auto-reply] consumed message not looked at:', err);
    return false;
  }
  return (await earlierQuestion(db, conversationId, messageId)) !== null;
}

/**
 * Whether the newest `outcome` row since `since` has had no answer after
 * it: `skipped_superseded` asked by the message that was consumed,
 * `skipped_automation` by the one that stood down for it. Never throws;
 * a failed read is no.
 */
export async function unansweredSince(
  db: SupabaseClient,
  args: {
    accountId: string;
    conversationId: string;
    since: string;
    outcome: 'skipped_superseded' | 'skipped_automation';
  }
): Promise<boolean> {
  try {
    const { data, error } = await db
      .from('ai_reply_events')
      .select('outcome, created_at')
      .eq('account_id', args.accountId)
      .eq('conversation_id', args.conversationId)
      .gte('created_at', args.since)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    for (const { outcome } of (data ?? []) as { outcome: string }[]) {
      if (ANSWERED.includes(outcome)) return false;
      if (outcome === args.outcome) return true;
    }
    return false;
  } catch (err) {
    console.error('[ai auto-reply] superseded question lookup failed:', err);
    return false;
  }
}

/** Whether this message is still the customer's newest text. */
export async function isNewestText(
  db: SupabaseClient,
  conversationId: string,
  messageId: string
): Promise<boolean> {
  try {
    return (
      (await customerTexts(db, conversationId))[0]?.message_id === messageId
    );
  } catch {
    return true;
  }
}
