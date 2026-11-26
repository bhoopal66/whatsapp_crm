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
 * inbound row. Whapi echoes every send, so an echo settles a send whose
 * own settle never landed or said failed because the gateway's answer was
 * lost (`sg_reconcile_echo`, 267): the oldest own row of the group from
 * the last 15 minutes, pending or failed, with no WhatsApp id, not newer
 * than the echo, with exactly that prefixed text or caption (its own kind
 * of attachment first). Of two identical sends the echo may pick the
 * wrong one; `sg_settle_send`, whose id is the gateway's own answer,
 * corrects it. An echo without a text or caption is ignored.
 */
import type { GroupChannel, GroupInboundMessage } from '@/lib/groups/inbound';
import type { WhapiGroupEvent } from '@/lib/whatsapp/whapi-group-events';

import type {
  SenderKind,
  SubmissionGroup,
  SubmissionGroupStore,
} from './store';
import { forms } from './rules';

export type InboundStore = Pick<
  SubmissionGroupStore,
  | 'findByWaGroupId'
  | 'contactConsent'
  | 'recordInbound'
  | 'reconcileEcho'
  | 'inboundMessageId'
>;

/**
 * A document or photo the customer sent into their submission group, to
 * be filed in their documents folder (migration 178). `groupMessageId`
 * is the new `submission_group_messages` row's id.
 */
export interface GroupCustomerDocument {
  accountId: string;
  contactId: string;
  groupId: string;
  groupMessageId: number;
  /** WhatsApp's message id (the mirror's fallback object name). */
  waMessageId: string;
  kind: 'document' | 'image';
  /** `{ id, link, mime_type, filename, file_size }` as the webhook carried it. */
  media: Record<string, unknown>;
  caption: string | null;
  /** ISO time WhatsApp stamped the message with. */
  sentAt: string;
}

/**
 * Takes one customer document; the caller isolates its failures. The
 * webhook's hook only collects it (synchronously) and files it after the
 * delivery's 1:1 messages.
 */
export type GroupCustomerDocumentHook = (doc: GroupCustomerDocument) => unknown;

/** A NEW text with a body the customer sent into their submission group (183's intake). */
export interface GroupCustomerText {
  accountId: string;
  groupId: string;
  waMessageId: string;
  body: string;
}

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

export interface InboundOutcome {
  recorded: number;
  /** Echoes of our own sends that settled an 'out' row. */
  reconciled: number;
  duplicates: number;
  failed: number;
}

/**
 * Who wrote, from the sender's digits. A hidden number (`…@lid`) matches
 * nobody, so it is 'other'.
 */
export function senderKindOf(
  senderWaId: string | null,
  customerPhone: string | null,
  coordinatorPhone: string | null,
  /** 142: the bank's coordinators' numbers on the group. */
  coordinatorPhones: readonly string[] = []
): SenderKind {
  if (!senderWaId || senderWaId.includes('@')) return 'other';
  const sender = new Set(forms(senderWaId));
  const matches = (phone: string | null) =>
    forms(phone).some((f) => sender.has(f));
  if (matches(customerPhone)) return 'customer';
  if ([coordinatorPhone, ...coordinatorPhones].some(matches))
    return 'coordinator';
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
  opts: {
    caseSla?: CaseSlaHook;
    customerDocument?: GroupCustomerDocumentHook;
    /** A NEW customer text with a body (183's intake); never changes the counts. */
    customerText?: (msg: GroupCustomerText) => unknown;
  } = {}
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
    // An echo without a text or caption cannot be matched to a send: ignored.
    if (m.fromMe && !m.body) continue;
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
        if (await reconcileEcho(store, group.id, m)) out.reconciled++;
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
        group.coordinatorPhone,
        group.coordinatorPhones
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
      // Only a NEW customer message files a document, so a redelivery
      // files nothing twice. Exactly 'document' or 'image': a sticker is
      // not a photo.
      if (
        recorded &&
        senderKind === 'customer' &&
        contactId &&
        m.media &&
        (m.type === 'document' || m.type === 'image') &&
        opts.customerDocument
      )
        await fileCustomerDocument(store, opts.customerDocument, {
          accountId: channel.accountId,
          contactId,
          groupId: group.id,
          waMessageId: m.id,
          kind: m.type,
          media: m.media,
          caption: m.body,
          sentAt: m.sentAt,
        });
      if (
        recorded &&
        senderKind === 'customer' &&
        m.type === 'text' &&
        m.body &&
        opts.customerText
      ) {
        try {
          await opts.customerText({
            accountId: channel.accountId,
            groupId: group.id,
            waMessageId: m.id,
            body: m.body,
          });
        } catch (error) {
          console.error(
            `[case-intake] text hook for inbound ${m.id} of group ${group.id} failed:`,
            error instanceof Error ? error.name : 'unknown error'
          );
        }
      }
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

export type MembershipStore = Pick<
  SubmissionGroupStore,
  'findByWaGroupId' | 'contactConsent' | 'noteCustomerMembership'
>;

/**
 * The customer being added to or leaving this number's submission groups
 * (174). Event ids are phone digits; a hidden number is only counted in
 * `unresolved`, so it matches nobody and absence is never inferred from it.
 * An add of a hidden number may be the customer joining, which is 'unsure' and
 * lifts a stale 'absent'; a remove of one may be the customer leaving, so a
 * 'joined' is asked about again ('left_unsure'). Each event is isolated. A failure is logged, never thrown: the cron reads the
 * group again, so this is no reason for Whapi to redeliver. Answers the failures.
 */
export async function recordSubmissionGroupMembership(
  store: MembershipStore,
  channel: Pick<GroupChannel, 'id' | 'accountId'> & { wabaId?: string | null },
  events: readonly WhapiGroupEvent[],
  /**
   * 219: a number other than the customer's and ours was added; a staff
   * member's saved number gets them access (sg_staff_number_joined).
   */
  staffNumberJoined?: (groupId: string, phone: string) => Promise<unknown>
): Promise<number> {
  let failed = 0;
  for (const e of events) {
    if (e.kind !== 'participants') continue;
    if (e.action !== 'add' && e.action !== 'remove') continue;
    try {
      const group = await store.findByWaGroupId(
        channel.accountId,
        channel.id,
        e.groupId
      );
      if (!group) continue;
      const phone = group.contactId
        ? (await store.contactConsent(group.contactId)).phone
        : null;
      const customer = new Set(forms(phone).filter(Boolean));
      const isCustomer = (id: string) =>
        !id.includes('@') && forms(id).some((f) => customer.has(f));
      if (e.action === 'add' && staffNumberJoined) {
        const ours = new Set(forms(channel.wabaId ?? '').filter(Boolean));
        for (const id of e.waIds) {
          if (id.includes('@') || isCustomer(id)) continue;
          if (forms(id).some((f) => ours.has(f))) continue;
          try {
            await staffNumberJoined(group.id, id);
          } catch (error) {
            console.error(
              `[submission-groups] staff number join on channel ${channel.id} failed:`,
              error instanceof Error ? error.message : 'unknown error'
            );
          }
        }
      }
      if (customer.size === 0) continue;
      const named = e.waIds.some(isCustomer);
      const hidden = e.unresolved > 0 || e.waIds.some((id) => id.includes('@'));
      if (named) {
        await store.noteCustomerMembership(
          group.id,
          e.action === 'add' ? 'joined' : 'absent'
        );
      } else if (e.action === 'add' && hidden) {
        await store.noteCustomerMembership(group.id, 'unsure');
      } else if (e.action === 'remove' && hidden) {
        await store.noteCustomerMembership(group.id, 'left_unsure');
      }
    } catch (error) {
      failed++;
      console.error(
        `[submission-groups] membership event on channel ${channel.id} failed:`,
        error instanceof Error ? error.message : 'unknown error'
      );
    }
  }
  return failed;
}

/**
 * Hands a customer's document to the filing hook; never throws, so it
 * never changes the delivery's counts. The log line names ids only: no
 * URL, file name or customer text.
 */
async function fileCustomerDocument(
  store: InboundStore,
  hook: GroupCustomerDocumentHook,
  doc: Omit<GroupCustomerDocument, 'groupMessageId'>
): Promise<void> {
  try {
    const groupMessageId = await store.inboundMessageId(
      doc.groupId,
      doc.waMessageId
    );
    if (groupMessageId === null) return;
    await hook({ ...doc, groupMessageId });
  } catch (error) {
    console.error(
      `[customer-docs] group document for inbound ${doc.waMessageId} of group ${doc.groupId} failed:`,
      error instanceof Error ? error.message : 'unknown error'
    );
  }
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
 * Settles the send this echo is of as sent (267): one still pending, or one
 * settled failed because the gateway's answer was lost. False when none is.
 */
export async function reconcileEcho(
  store: Pick<InboundStore, 'reconcileEcho'>,
  groupId: string,
  m: GroupInboundMessage
): Promise<boolean> {
  const at = Date.parse(m.sentAt);
  return store.reconcileEcho({
    groupId,
    waMessageId: m.id,
    type: m.type,
    text: m.body!,
    sentAt: Number.isFinite(at) ? new Date(at) : null,
  });
}
