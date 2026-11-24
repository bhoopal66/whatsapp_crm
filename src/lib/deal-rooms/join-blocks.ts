/**
 * Why a join request is not approved, in the CRM's words: the answers of
 * `deal_room_admit_block` (088), the two waiting or refused states of a
 * listed officer, and a check that could not be made. The screen's texts
 * are `Chat.rooms.members.joinBlocks`.
 */
export const JOIN_BLOCKS = {
  pending_approval: 'A team leader has to let this person in first',
  rejected: 'A team leader refused this person',
  opted_out: 'This person opted out or is marked do-not-contact',
  no_consent: 'This customer has no recorded consent',
  bank_guests_off: 'Officers of this bank cannot join customer groups',
  room_not_open: 'The room is not open',
  check_failed: 'It could not be checked whether this person may join',
} as const;

export type JoinBlock = keyof typeof JOIN_BLOCKS;

const isJoinBlock = (v: unknown): v is JoinBlock =>
  typeof v === 'string' && Object.hasOwn(JOIN_BLOCKS, v);

/** An answer of the rule this build does not know blocks all the same. */
export const joinBlockOf = (v: unknown): JoinBlock =>
  isJoinBlock(v) ? v : 'check_failed';

/** The first refused request's code, when the screen has words for it. */
export function failedJoinBlock(failed: unknown): JoinBlock | null {
  const first = Array.isArray(failed)
    ? (failed[0] as { code?: unknown } | undefined)
    : undefined;
  return isJoinBlock(first?.code) ? first.code : null;
}
