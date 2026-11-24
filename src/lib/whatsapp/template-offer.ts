// Which saved templates a chat may be offered, by what it sends from.
//
// A linked device (Whapi, OpenWA) renders the row here and sends an
// ordinary message, so Meta's verdict on it does not matter. The Cloud
// API number addresses an approved template in Meta's registry by name
// and language, so a row Meta refused fails there whatever its `status`
// says: a save writes APPROVED before Meta answers, and a refused
// submission keeps it (the submit route), with its `submission_error`.
//
// This informs the picker only; the server judges every send.

import {
  sendsOverMeta,
  type LastCustomerMessage,
} from '@/lib/inbox/service-window';
import type { SendChannelPrediction } from '@/lib/contacts/predict-send-channels';
import type { MessageTemplate } from '@/types';

export type TemplateSendsFrom = 'meta' | 'linked' | 'unknown';

/** Why a row shown in a Meta chat cannot be picked. */
export type TemplateBlock = 'not_approved' | 'waiting' | 'paused';

export interface TemplateOffer<T> {
  /** Can be picked, in the order given. */
  offered: T[];
  /** Shown with the reason, cannot be picked. */
  blocked: { template: T; reason: TemplateBlock }[];
  // Anything else is hidden.
}

type OfferRow = Pick<
  MessageTemplate,
  'status' | 'meta_template_id' | 'submission_error'
>;

/**
 * Gone from Meta (or going), and a draft nobody finished: never shown.
 * A row without a status is a draft (migration 014's default).
 */
function isHidden(row: OfferRow): boolean {
  const status = row.status ?? 'DRAFT';
  return (
    status === 'DRAFT' || status === 'DISABLED' || status === 'PENDING_DELETION'
  );
}

function metaBlock(row: OfferRow): TemplateBlock | null {
  if (!row.meta_template_id) {
    // Refused when it was submitted: Meta does not know it. Without a
    // refusal nobody here can tell: a template made in WhatsApp Manager and
    // written here by hand is approved there and was never synced, so it
    // stays on offer and Meta answers.
    return row.status === 'APPROVED' && !row.submission_error
      ? null
      : 'not_approved';
  }
  switch (row.status) {
    case 'APPROVED':
      return null;
    case 'PENDING':
    case 'IN_APPEAL':
      return 'waiting';
    case 'PAUSED':
      return 'paused';
    default:
      return 'not_approved';
  }
}

export function offerTemplates<T extends OfferRow>(
  rows: readonly T[],
  sendsFrom: TemplateSendsFrom
): TemplateOffer<T> {
  const offer: TemplateOffer<T> = { offered: [], blocked: [] };
  for (const row of rows) {
    if (isHidden(row)) continue;
    if (sendsFrom === 'unknown') {
      // Not known which rule holds: what both kinds of number were
      // always offered.
      if (row.status === 'APPROVED') offer.offered.push(row);
      continue;
    }
    const reason = sendsFrom === 'meta' ? metaBlock(row) : null;
    if (reason) offer.blocked.push({ template: row, reason });
    else offer.offered.push(row);
  }
  return offer;
}

/**
 * What a template sent from this chat goes out on, as far as the browser
 * can be certain. Meta is `sendsOverMeta`'s answer; linked needs the
 * same certainty, in the server's order (`resolveSendChannel`): the pin,
 * the number the customer last wrote to, its provider, the chat's own
 * number. Anything short of that is 'unknown'.
 */
export function chatTemplateSendsFrom(
  numbers:
    | readonly { id: string; provider: string; is_personal?: boolean }[]
    | null
    | undefined,
  conversation: {
    personal_owner_id?: string | null;
    channel_id?: string | null;
    send_channel_id?: string | null;
  },
  lastCustomer: LastCustomerMessage | null | undefined
): TemplateSendsFrom {
  if (!numbers || numbers.length === 0) return 'unknown';
  // A personal chat goes out on its owner's own phone or not at all.
  if (conversation.personal_owner_id) return 'linked';
  if (sendsOverMeta(numbers, conversation, lastCustomer)) return 'meta';
  // A company chat never goes out on somebody's own phone.
  const company = numbers.filter((n) => !n.is_personal);
  if (company.length > 0 && company.every((n) => n.provider !== 'meta')) {
    return 'linked';
  }
  const known = (id: string | null | undefined) =>
    id ? company.find((n) => n.id === id) : undefined;
  if (conversation.send_channel_id) {
    // Not Meta, or `sendsOverMeta` had said so. A pin that no longer
    // exists falls through on the server to rules not known here.
    return known(conversation.send_channel_id) ? 'linked' : 'unknown';
  }
  if (lastCustomer === undefined) return 'unknown';
  if (lastCustomer?.channel_id && known(lastCustomer.channel_id)) {
    return 'linked';
  }
  if (lastCustomer?.provider) {
    return lastCustomer.provider !== 'meta' &&
      company.some((n) => n.provider === lastCustomer.provider)
      ? 'linked'
      : 'unknown';
  }
  const own = known(conversation.channel_id);
  return own && own.provider !== 'meta' ? 'linked' : 'unknown';
}

/**
 * The contact screens' template button. It asks the server for Meta, so
 * with a Meta number connected that is the answer; null is "the numbers
 * are not loaded, or there are none".
 */
export function contactTemplateSendsFrom(
  prediction: Pick<SendChannelPrediction, 'templateChannel'>
): TemplateSendsFrom {
  if (!prediction.templateChannel) return 'unknown';
  return prediction.templateChannel.provider === 'meta' ? 'meta' : 'linked';
}
