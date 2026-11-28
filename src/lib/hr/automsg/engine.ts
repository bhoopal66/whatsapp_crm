/**
 * HR automated messages: the row processor. Rows are enqueued in SQL
 * (migration 203); a cron drain hands due rows to `processDue`, which runs
 * each through `processRow`:
 *
 *   a) older than MAX_HELD_HOURS -> cancelled, never sent late;
 *   b) no state -> lost; a personal-number chat -> cancelled;
 *   c) the pure guards: closed / opted out / no longer true (275) ->
 *      cancelled, any other reason -> held (no write when already held
 *      for that reason);
 *   d) the claim is the lock: a lost claim sends nothing;
 *   e) render and send; a send throw -> failed (retried) only when nothing
 *      can have been sent, failed_terminal when the failure cannot pass on
 *      a retry (029a), else unconfirmed: the gateway may have taken it, so
 *      it is never resent;
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
  placeholders,
  render,
  sanitizeParam,
} from './templates';
import { slotFor } from './slot';
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
  /** The channel's sender is at its pace limit: untouched, next pass. */
  | 'deferred'
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

/** Digit runs long enough to be a phone number, for the log. */
const PHONE_LIKE = /\+?\d[\d\s().-]{5,}\d/g;

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
      stale: st.stale,
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
    if (d.hold === null) {
      await store.cancel(row.id, d.cancel);
      return 'cancelled';
    }
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

  // One sender per channel, never another channel's (migrations 215,
  // 226): an RCS or SMS row with no provider waits, it is not sent on
  // WhatsApp. Only 'whatsapp' reaches deps.sender.
  const channel = st.channel;
  const sender =
    channel === 'whatsapp' ? deps.sender : (deps.senders?.[channel] ?? null);
  if (!sender) {
    if (!(cur.status === 'held' && cur.holdReason === 'channel_not_connected'))
      await store.hold(row.id, 'channel_not_connected');
    return 'held:channel_not_connected';
  }
  if (sender.hasCapacity && !sender.hasCapacity()) return 'deferred';

  const claim = await store.claim(row.id, now);
  if (claim === 'lost') return 'lost';
  if (claim === 'capped') return 'capped';
  if (claim === 'cancelled') return 'cancelled';

  const params = {
    name: sanitizeParam(st.contactName, NAME_FALLBACK),
    // An interview reminder names its time (339's params.interview_at),
    // in the template's language; every other row keeps the fallback.
    slot: slotFor(cur, tpl.language),
  };
  let body: string;
  let sent: { providerMessageId: string | null; messageId: string | null };
  // False = the throw came before the sender, so nothing was sent.
  let handed = false;
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
    handed = true;
    sent = await sender.send(req);
  } catch (e) {
    const f = classifySendFailure(e);
    if (f.unconfirmed && handed) {
      // The row keeps no error text for this state, so the log says why.
      console.error(
        `[hr-automsg] send of ${row.id} is unconfirmed: ${f.reason}`
      );
      await store.settleUnconfirmed(row.id, null).catch(() => undefined);
      return 'unconfirmed';
    }
    if (!f.retryable && !f.unconfirmed) {
      await store.failTerminal(row.id, f.reason);
      return 'failed_terminal';
    }
    await store.markFailed(row.id, messageOf(e));
    return 'failed';
  }

  // An RCS or SMS message has no chat message: a null messageId is normal
  // there.
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
      if (o === 'error')
        console.error(
          `[hr-automsg] row ${row.id} failed:`,
          messageOf(e).replace(PHONE_LIKE, '[number]')
        );
    }
    counts[o] = (counts[o] ?? 0) + 1;
  }
  return counts;
}
