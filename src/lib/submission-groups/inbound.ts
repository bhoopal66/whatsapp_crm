/**
 * Submission-group traffic from the Whapi webhook. The route extracts
 * group messages once (`extractWhapiGroupMessages`, 114); those whose
 * chat is a submission group of the number the webhook SECRET resolved
 * are recorded through `sg_record_inbound`. 114's `persistGroupMessages`
 * only knows `whatsapp_groups`, so it counts these chats as unknown and
 * nothing is stored twice.
 *
 * Our own sends (fromMe) are skipped: a CRM send is already recorded by
 * `sg_send_begin`, and an echo must not come back as an inbound row.
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
  'findByWaGroupId' | 'contactConsent' | 'recordInbound'
>;

export interface InboundOutcome {
  recorded: number;
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
  messages: readonly GroupInboundMessage[]
): Promise<InboundOutcome> {
  const out: InboundOutcome = { recorded: 0, duplicates: 0, failed: 0 };
  const groups = new Map<string, Promise<SubmissionGroup | null>>();
  const phones = new Map<string, Promise<string | null>>();
  for (const m of messages) {
    if (m.fromMe) continue;
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
      let phone = phones.get(group.contactId);
      if (!phone) {
        phone = store.contactConsent(group.contactId).then((c) => c.phone);
        phones.set(group.contactId, phone);
      }
      const recorded = await store.recordInbound({
        groupId: group.id,
        waMessageId: m.id,
        senderWaId: m.senderWaId,
        senderKind: senderKindOf(
          m.senderWaId,
          await phone,
          group.coordinatorPhone
        ),
        type: m.type,
        body: m.body,
        media: m.media,
        waTimestamp: new Date(m.sentAt),
      });
      if (recorded) out.recorded++;
      else out.duplicates++;
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
