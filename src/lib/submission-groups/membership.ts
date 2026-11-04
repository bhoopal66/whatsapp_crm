/**
 * Is the customer in their submission group (migration 174)? The state is
 * 'joined', 'absent' or 'unknown', and it is only ever written through
 * `sg_note_customer_membership`. A customer's message sets 'joined' in SQL.
 *
 * WhatsApp can hide a number behind an `…@lid` id, and that id matches nobody.
 * A hidden id may be the customer, so it is never evidence of absence: it is
 * reported as 'unsure', which also lifts an 'absent' stored earlier.
 */
import { forms, phoneWasRefused } from './rules';
import type { CustomerMembershipNote, SubmissionGroupStore } from './store';

/**
 * Phone digits of a participant id; null when the id hides its number. Bare
 * digits count only at a phone's length (`parseWhapiIdentity`'s rule), since a
 * longer id reaches us as the raw jid and is no number.
 */
function realNumber(id: string): string | null {
  const [user, domain] = id.split('@');
  if (domain !== undefined && domain !== 's.whatsapp.net' && domain !== 'c.us')
    return null;
  return /^\d{7,15}$/.test(user) ? user : null;
}

/**
 * What a participant list says about the customer (pure). 'absent' needs a
 * list where every id is a real number and none is the customer's; with a
 * hidden id and no match it is 'unsure'. An empty list says nothing (our own
 * number is always in a live group), and neither does any list when no phone
 * is on file.
 */
export function customerMembershipFrom(
  participantIds: readonly string[],
  customerPhones: readonly (string | null)[]
): CustomerMembershipNote {
  const wanted = new Set(customerPhones.flatMap(forms).filter(Boolean));
  if (wanted.size === 0 || participantIds.length === 0) return 'unknown';
  let hidden = false;
  for (const id of participantIds) {
    const phone = realNumber(id);
    if (phone === null) hidden = true;
    else if (forms(phone).some((f) => wanted.has(f))) return 'joined';
  }
  return hidden ? 'unsure' : 'absent';
}

/**
 * Records what the create call proves. A refusal is proof of absence, and a
 * refused hidden id may be the customer. Not being refused proves nothing, and
 * 'joined' is never rechecked, so that case writes nothing at all: 'unknown'
 * would stamp the check and hold the group back six hours, while a group never
 * stamped is due at once and the cron confirms it from the list within minutes.
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
      ? 'unsure'
      : null;
  if (state === null) return;
  try {
    await store.noteCustomerMembership(groupId, state);
  } catch (error) {
    console.error(
      `[submission-groups] membership of new group ${groupId} not recorded:`,
      error instanceof Error ? error.message : 'unknown error'
    );
  }
}
