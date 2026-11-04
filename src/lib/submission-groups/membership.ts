/**
 * Is the customer in their submission group (migration 174)? The state is
 * 'joined', 'absent' or 'unknown', and it is only ever written through
 * `sg_note_customer_membership`. A customer's message sets 'joined' in SQL.
 *
 * WhatsApp can hide a number behind an `…@lid` id, and that id matches nobody.
 * A hidden id may be the customer, so it is never evidence of absence.
 */
import { phoneWasRefused } from './api-input';
import { forms } from './inbound';
import type { CustomerMembership, SubmissionGroupStore } from './store';

/** Phone digits of a participant id; null when the id hides its number. */
function realNumber(id: string): string | null {
  const [user, domain] = id.split('@');
  if (domain !== undefined && domain !== 's.whatsapp.net' && domain !== 'c.us')
    return null;
  return /^\d+$/.test(user) ? user : null;
}

/**
 * What a participant list says about the customer (pure). 'absent' needs a
 * list where every id is a real number and none is the customer's. An empty
 * list says nothing (our own number is always in a live group), and neither
 * does any list when no phone is on file.
 */
export function customerMembershipFrom(
  participantIds: readonly string[],
  customerPhones: readonly (string | null)[]
): CustomerMembership {
  const wanted = new Set(customerPhones.flatMap(forms).filter(Boolean));
  if (wanted.size === 0 || participantIds.length === 0) return 'unknown';
  let hidden = false;
  for (const id of participantIds) {
    const phone = realNumber(id);
    if (phone === null) hidden = true;
    else if (forms(phone).some((f) => wanted.has(f))) return 'joined';
  }
  return hidden ? 'unknown' : 'absent';
}

/**
 * Records who WhatsApp added when the group was created. A refused entry with
 * a hidden id could be the customer, so that case is left for the cron to read.
 * Never throws: the group exists, and the cron checks it again.
 */
export async function noteCreatedMembership(
  store: Pick<SubmissionGroupStore, 'noteCustomerMembership'>,
  groupId: string,
  customerPhone: string,
  refused: readonly string[]
): Promise<void> {
  const state = phoneWasRefused(refused, customerPhone)
    ? 'absent'
    : refused.some((r) => r.includes('@') && realNumber(r) === null)
      ? 'unknown'
      : 'joined';
  try {
    await store.noteCustomerMembership(groupId, state);
  } catch (error) {
    console.error(
      `[submission-groups] membership of new group ${groupId} not recorded:`,
      error instanceof Error ? error.message : 'unknown error'
    );
  }
}
