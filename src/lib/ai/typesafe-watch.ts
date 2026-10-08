import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { getDecisionLayer } from '@/lib/typesafe';
import { messageHash } from '@/lib/typesafe/log';
import { supabaseAdmin } from './admin-client';
import { buildConversationContext } from './context';
import { markOptedOut } from './opt-out';
import { turnsBefore } from './typesafe-gates';

/** How many earlier turns the triage state carries (the layer caps at 6). */
const TRIAGE_TURNS = 6;

/**
 * The TypeSafe watch on every conversation (Settings → AI safety checks →
 * "Watch conversations your team handles", migration 064).
 *
 * The bot's own triage (typesafe-gates.ts) only sees messages the bot is
 * about to answer. Most conversations are handled by people, and a
 * customer who writes "please stop messaging me" to an agent must still
 * be kept out of the next broadcast. So every inbound text the bot's
 * triage did not judge is triaged here too, and the only thing done with
 * the answer is the opt-out: the contact is marked opted-out
 * (`contacts.opted_out_at`, in Live mode), which every broadcast skips. A request for a person or a complaint is logged, not acted on —
 * a person already owns the thread, or an automation or flow answered it.
 *
 * Runs at the end of the inbound pipeline, inside the webhook's after(),
 * so it adds nothing to the customer's reply. Never throws.
 */
export async function watchInboundMessage(args: {
  accountId: string;
  conversationId: string;
  contactId: string;
  /** Gateway id of the inbound message. */
  messageId: string;
  /** The inbound's text (a media caption included). */
  text: string;
  /**
   * Owner of the WhatsApp config. Unused since the opt-out became a
   * contact column (076) rather than a tag this user created; kept so
   * the inbound pipeline's call stays as it is.
   */
  configOwnerUserId: string;
}): Promise<void> {
  const { accountId, conversationId, contactId, messageId, text } = args;
  if (!text.trim()) return;
  try {
    const ts = getDecisionLayer();
    if (!ts || !ts.config.enabled.triage) return;
    const [sw, state] = await Promise.all([
      ts.switches.get(accountId),
      ts.state('triage', accountId),
    ]);
    if (!state.on || !sw.watchHumanThreads) return;
    // After the switches, so an account that is off spends no budget.
    if (
      !checkRateLimit(`ts-watch:${accountId}`, RATE_LIMITS.typesafeWatchAccount)
        .success
    )
      return;

    const db = supabaseAdmin();
    // Already judged by the bot's triage for this very message: once is
    // enough (and the bot's decision is the one that acted).
    const { data: seen, error: seenErr } = await db
      .from('ts_decision_log')
      .select('id')
      .eq('account_id', accountId)
      .eq('check_name', 'triage')
      .eq('message_id', messageHash(messageId, ts.config.logHashKey))
      .limit(1);
    if (seenErr) throw new Error(seenErr.message);
    if ((seen ?? []).length > 0) return;

    const messages = await buildConversationContext(db, conversationId);
    const before = turnsBefore(messages, text);
    const d = await ts.triage({
      accountId,
      conversationId,
      contactId,
      messageId,
      message: text,
      recentTurns: before.slice(-TRIAGE_TURNS).map((m) => ({
        from: m.role === 'user' ? 'customer' : 'taamul',
        text: m.content,
      })),
      journeyStage: 'open_conversation',
      source: 'watch',
    });
    if (d.act && d.optOut === 'record') {
      await markOptedOut(db, { accountId, contactId });
    }
  } catch (err) {
    console.error('[ts013] watch failed:', err);
  }
}
