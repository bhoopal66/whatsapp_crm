/**
 * HR automated messages: the row processor. Rows are enqueued in SQL
 * (migration 203); a cron drain hands due rows to `processDue`, which runs
 * each through `processRow`:
 *
 *   a) older than MAX_HELD_HOURS -> cancelled, never sent late;
 *   b) no state -> lost; a personal-number chat -> cancelled;
 *   c) the pure guards: closed / opted out -> cancelled, any other reason
 *      -> held (no write when already held for that reason);
 *   d) the claim is the lock: a lost claim sends nothing;
 *   e) render and send; a send throw -> failed (fail closed), or
 *      failed_terminal when the failure cannot pass on a retry (029a);
 *   f) mark sent; if that write fails the row is settled unconfirmed and
 *      never resent.
 */
import { classifySendFailure } from './failure';
import { decide } from './guards';
import {
  SEND_REQUEST_KEYS,
  type EngineDeps,
  type TemplateSendRequest,
} from './ports';
import {
  NAME_FALLBACK,
  SLOT_FALLBACK,
  placeholders,
  render,
  sanitizeParam,
} from './templates';
import {
  MAX_ATTEMPTS,
  MAX_HELD_HOURS,
  type HoldReason,
  type OutboxRow,
} from './types';

export type RowOutcome =
  | 'sent'
  | 'unconfirmed'
  | 'failed'
  | 'failed_terminal'
  | 'cancelled'
  | 'lost'
  | 'capped'
  | `held:${HoldReason}`
  | 'error';

/** Longest error text stored on a failed row. */
export const MAX_ERROR_LENGTH = 500;

/** Runtime half of "no free-text path": a send request may carry only the template keys. */
export function assertTemplateOnly(req: TemplateSendRequest): void {
  for (const k of Object.keys(req))
    if (!(SEND_REQUEST_KEYS as readonly string[]).includes(k))
      throw new Error(`send request field ${k} is not allowed`);
  for (const k of Object.keys(req.params))
    if (k !== 'name' && k !== 'slot')
      throw new Error(`send request param ${k} is not allowed`);
  if (typeof req.metaTemplateName !== 'string' || req.metaTemplateName === '')
    throw new Error('send request needs a template name');
}

function messageOf(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.slice(0, MAX_ERROR_LENGTH);
}

export async function processRow(
  row: OutboxRow,
  deps: EngineDeps
): Promise<RowOutcome> {
  const { store, clock } = deps;
  const now = clock.now();

  if (
    now.getTime() - new Date(row.createdAt).getTime() >
    MAX_HELD_HOURS * 3_600_000
  ) {
    await store.cancel(row.id);
    return 'cancelled';
  }

  const st = await store.state(row.id);
  if (!st) return 'lost';
  const cur = st.row;
  // Already decided elsewhere (sent, cancelled, in flight, out of attempts).
  if (
    cur.status === 'sent' ||
    cur.status === 'cancelled' ||
    cur.claimState !== null ||
    (cur.status === 'failed' && cur.attempts >= MAX_ATTEMPTS)
  )
    return 'lost';
  if (st.personal) {
    await store.cancel(row.id);
    return 'cancelled';
  }

  const d = decide({
    settings: st.settings,
    trigger: cur.trigger,
    triggerEnabled: st.triggerEnabled,
    template: st.template,
    state: {
      closed: st.closed,
      optedOut: st.optedOut,
      consent: st.consent,
      lastInboundAt: st.lastInboundAt,
      sentToday: st.sentToday,
    },
    now,
    // Dedupe is enforced by the outbox's unique (account_id, dedupe_key) in SQL.
    duplicate: false,
  });
  if (!d.allow) {
    if (d.hold === 'closed' || d.hold === 'opted_out') {
      await store.cancel(row.id);
      return 'cancelled';
    }
    if (!(cur.status === 'held' && cur.holdReason === d.hold))
      await store.hold(row.id, d.hold);
    return `held:${d.hold}`;
  }
  // decide() allowed, so the template is present.
  const tpl = st.template!;

  // One sender per channel, never another channel's (migration 215): an
  // RCS row with no RCS provider waits, it is not sent on WhatsApp.
  const channel = st.channel;
  const sender = channel === 'rcs' ? (deps.senders?.rcs ?? null) : deps.sender;
  if (!sender) {
    if (!(cur.status === 'held' && cur.holdReason === 'channel_not_connected'))
      await store.hold(row.id, 'channel_not_connected');
    return 'held:channel_not_connected';
  }

  const claim = await store.claim(row.id, now);
  if (claim === 'lost') return 'lost';
  if (claim === 'capped') return 'capped';

  const params = {
    name: sanitizeParam(st.contactName, NAME_FALLBACK),
    slot: SLOT_FALLBACK,
  };
  let body: string;
  let sent: { providerMessageId: string | null; messageId: string | null };
  try {
    const used = placeholders(tpl.body);
    const fill: Record<string, string> = {};
    for (const k of used) fill[k] = params[k as keyof typeof params];
    body = render(tpl.body, fill);
    const req: TemplateSendRequest = {
      outboxId: row.id,
      accountId: cur.accountId,
      conversationId: cur.conversationId,
      contactId: cur.contactId,
      templateKind: tpl.kind,
      language: tpl.language,
      metaTemplateName: tpl.metaTemplateName,
      body,
      templateBody: tpl.body,
      params,
    };
    assertTemplateOnly(req);
    sent = await sender.send(req);
  } catch (e) {
    const f = classifySendFailure(e);
    if (!f.retryable) {
      await store.failTerminal(row.id, f.reason);
      return 'failed_terminal';
    }
    await store.markFailed(row.id, messageOf(e));
    return 'failed';
  }

  // An RCS message has no chat message: a null messageId is normal there.
  if (channel === 'whatsapp' && sent.messageId === null) {
    // The gateway accepted it but the chat has no record of it: say so,
    // so the history shows it needs review.
    await store
      .settleUnconfirmed(row.id, sent.providerMessageId)
      .catch(() => undefined);
    return 'unconfirmed';
  }

  try {
    await store.markSent(row.id, {
      providerMessageId: sent.providerMessageId,
      messageId: sent.messageId,
      bodyRendered: body,
    });
    return 'sent';
  } catch {
    // The provider accepted: never a send failure, never resent.
    await store
      .settleUnconfirmed(row.id, sent.providerMessageId)
      .catch(() => undefined);
    return 'unconfirmed';
  }
}

function alreadyDecided(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const o = e as { hint?: unknown; reason?: unknown; message?: unknown };
  return (
    o.hint === 'ALREADY_DECIDED' ||
    o.reason === 'ALREADY_DECIDED' ||
    o.message === 'ALREADY_DECIDED'
  );
}

/**
 * Runs rows in order. One row's unexpected throw is counted as 'error' and
 * the loop goes on; ALREADY_DECIDED (a parallel drain decided the row
 * first) counts as 'lost'. Returns counts per outcome.
 */
export async function processDue(
  rows: readonly OutboxRow[],
  deps: EngineDeps
): Promise<Partial<Record<RowOutcome, number>>> {
  const counts: Partial<Record<RowOutcome, number>> = {};
  for (const row of rows) {
    let o: RowOutcome;
    try {
      o = await processRow(row, deps);
    } catch (e) {
      o = alreadyDecided(e) ? 'lost' : 'error';
    }
    counts[o] = (counts[o] ?? 0) + 1;
  }
  return counts;
}
