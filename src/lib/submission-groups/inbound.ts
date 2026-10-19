/**
 * Submission-group traffic from the Whapi webhook. The route extracts
 * group messages once (`extractWhapiGroupMessages`, 114); those whose
 * chat is a submission group of the number the webhook SECRET resolved
 * are recorded through `sg_record_inbound`. 114's `persistGroupMessages`
 * only knows `whatsapp_groups`, so it counts these chats as unknown and
 * nothing is stored twice.
 *
 * Our own sends (fromMe) are never stored: a CRM send is already
 * recorded by `sg_send_begin`, and an echo must not come back as an
 * inbound row. Whapi echoes every send, so a text echo reconciles a send
 * whose own settle never landed (the sender's 202 "sent, not recorded"):
 * when no row of the group carries the echo's id yet and exactly one
 * pending 'out' row of the group, created in the last 15 minutes and not
 * after the echo's own timestamp, has exactly that prefixed text, it is
 * settled 'sent' with the echo's id before the cron would sweep it
 * failed. Two such rows (the same sender resending the same text) are
 * ambiguous and left alone: settling the wrong one would show an unsent
 * message as sent. The sender's own settle, or the cron, decides them.
 */
import type { GroupChannel, GroupInboundMessage } from '@/lib/groups/inbound';
import { normalizePhone, phoneVariants } from '@/lib/whatsapp/phone-utils';

import type {
  SenderKind,
  SubmissionGroup,
  SubmissionGroupStore,
} from './store';

export type InboundStore = Pick<
  SubmissionGroupStore,
  | 'findByWaGroupId'
  | 'contactConsent'
  | 'recordInbound'
  | 'hasWaMessage'
  | 'pendingOutMatching'
  | 'settleSend'
>;

/**
 * The case SLA hook (module 018c): a NEW message from the customer is the
 * case's `customer_message` event. Best effort: a failure is logged, never
 * counted against the delivery (the message is stored; a redelivery would
 * be a duplicate and fire nothing).
 */
export interface CaseSlaHook {
  caseIdForGroup(groupId: string): Promise<string | null>;
  customerMessage(caseId: string): Promise<unknown>;
}

/** How far back an echo may reconcile a pending send (the cron sweeps at 10 minutes). */
export const ECHO_RECONCILE_WINDOW_MS = 15 * 60_000;

export interface InboundOutcome {
  recorded: number;
  /** Echoes of our own sends that settled a pending 'out' row. */
  reconciled: number;
  duplicates: number;
  failed: number;
}

/** Every trunk-0 form of a phone, for comparing a sender with a number on file. */
function forms(phone: string | null | undefined): string[] {
  const digits = normalizePhone(phone ?? '').replace(/^00/, '');
  return phoneVariants(digits);
}

/**
 * Who wrote, from the sender's digits. A hidden number (`…@lid`) matches
 * nobody, so it is 'other'.
 */
export function senderKindOf(
  senderWaId: string | null,
  customerPhone: string | null,
  coordinatorPhone: string | null
): SenderKind {
  if (!senderWaId || senderWaId.includes('@')) return 'other';
  const sender = new Set(forms(senderWaId));
  const matches = (phone: string | null) =>
    forms(phone).some((f) => sender.has(f));
  if (matches(customerPhone)) return 'customer';
  if (matches(coordinatorPhone)) return 'coordinator';
  return 'other';
}

/**
 * Record the inbound messages of this number's submission groups. Each
 * message is isolated: a failure is logged and counted, never thrown.
 */
export async function recordSubmissionGroupInbound(
  store: InboundStore,
  channel: Pick<GroupChannel, 'id' | 'accountId'>,
  messages: readonly GroupInboundMessage[],
  opts: { now?: () => Date; caseSla?: CaseSlaHook } = {}
): Promise<InboundOutcome> {
  const out: InboundOutcome = {
    recorded: 0,
    reconciled: 0,
    duplicates: 0,
    failed: 0,
  };
  const groups = new Map<string, Promise<SubmissionGroup | null>>();
  const phones = new Map<string, Promise<string | null>>();
  const caseIds = new Map<string, Promise<string | null>>();
  for (const m of messages) {
    // A media or empty echo cannot be matched to a send: ignored.
    if (m.fromMe && (m.type !== 'text' || !m.body)) continue;
    try {
      let lookup = groups.get(m.waGroupId);
      if (!lookup) {
        lookup = store.findByWaGroupId(
          channel.accountId,
          channel.id,
          m.waGroupId
        );
        groups.set(m.waGroupId, lookup);
      }
      const group = await lookup;
      if (!group) continue;
      if (m.fromMe) {
        if (await reconcileEcho(store, group.id, m, opts.now?.() ?? new Date()))
          out.reconciled++;
        continue;
      }
      const contactId = group.contactId;
      let phone = contactId ? phones.get(contactId) : Promise.resolve(null);
      if (!phone && contactId) {
        phone = store.contactConsent(contactId).then((c) => c.phone);
        phones.set(contactId, phone);
      }
      const senderKind = senderKindOf(
        m.senderWaId,
        (await phone) ?? null,
        group.coordinatorPhone
      );
      const recorded = await store.recordInbound({
        groupId: group.id,
        waMessageId: m.id,
        senderWaId: m.senderWaId,
        senderKind,
        type: m.type,
        body: m.body,
        media: m.media,
        waTimestamp: new Date(m.sentAt),
      });
      if (recorded) out.recorded++;
      else out.duplicates++;
      if (recorded && senderKind === 'customer' && opts.caseSla)
        await customerMessageSla(opts.caseSla, caseIds, group.id, m.id);
    } catch (error) {
      out.failed++;
      console.error(
        `[submission-groups] inbound ${m.id} on channel ${channel.id} failed:`,
        error
      );
    }
  }
  return out;
}

/** The customer_message SLA event on the group's case, if any; never throws. */
async function customerMessageSla(
  hook: CaseSlaHook,
  caseIds: Map<string, Promise<string | null>>,
  groupId: string,
  messageId: string
): Promise<void> {
  try {
    let lookup = caseIds.get(groupId);
    if (!lookup) {
      lookup = hook.caseIdForGroup(groupId);
      caseIds.set(groupId, lookup);
    }
    const caseId = await lookup;
    if (caseId) await hook.customerMessage(caseId);
  } catch (error) {
    console.error(
      `[submission-groups] case SLA for inbound ${messageId} of group ${groupId} failed:`,
      error instanceof Error ? error.message : 'unknown error'
    );
  }
}

/**
 * Settles the pending send this echo is of; false when there is none, or
 * more than one candidate (the echo is ignored).
 */
export async function reconcileEcho(
  store: Pick<
    InboundStore,
    'hasWaMessage' | 'pendingOutMatching' | 'settleSend'
  >,
  groupId: string,
  m: GroupInboundMessage,
  now: Date
): Promise<boolean> {
  if (await store.hasWaMessage(groupId, m.id)) return false;
  const since = new Date(now.getTime() - ECHO_RECONCILE_WINDOW_MS);
  // WhatsApp timestamps are whole seconds: a row created later in that same second still qualifies.
  const at = Date.parse(m.sentAt);
  const until = Number.isFinite(at) ? new Date(at + 999) : null;
  const ids = await store.pendingOutMatching(groupId, m.body!, since, until);
  if (ids.length !== 1) {
    if (ids.length > 1)
      console.warn(
        `[submission-groups] echo ${m.id} matches several pending sends of group ${groupId}; left to the sender's settle`
      );
    return false;
  }
  return store.settleSend(ids[0], 'sent', m.id);
}
