/**
 * Who a close takes out of a submission group (`closeGroup`). Pure.
 *
 * Our own number must never be removed: it is the number on file, and in any
 * case the group's creator (we made the group), so a missing or placeholder
 * wabaId never makes the close try to remove ourselves and fail on every
 * retry. WhatsApp can hide a member behind an `…@lid` id, and one of those
 * may be us: they are removed only once we were found among the others.
 */
import type { WhapiGroupParticipant } from '@/lib/whatsapp/whapi-api';

const LID_RE = /^\d{5,25}@lid$/;

export interface ClosePlan {
  /** Phone digits. */
  phones: string[];
  /** Hidden members' `…@lid` ids. */
  hidden: string[];
  /** In the group, with nothing we may send: an unusable id, or a hidden one that could be us. */
  unreachable: number;
}

/** `ours`: our number's digits, or null when it is not on file. */
export function planClose(
  participants: readonly WhapiGroupParticipant[],
  ours: string | null
): ClosePlan {
  const phones: string[] = [];
  const hidden: string[] = [];
  let unreachable = 0;
  let foundUs = false;
  let creatorSeen = false;
  for (const p of participants) {
    // OpenWA answers a hidden member's id as its waId too.
    const phone = p.waId && !p.waId.includes('@') ? p.waId : null;
    const isUs = phone !== null && phone === ours;
    if (p.role === 'superadmin') {
      creatorSeen = true;
      // A creator showing another number than the one on file proves nothing.
      foundUs ||= isUs || phone === null || ours === null;
    } else if (isUs) foundUs = true;
    else if (phone !== null) phones.push(phone);
    else if (LID_RE.test(p.jid)) hidden.push(p.jid);
    else unreachable += 1;
  }
  if (foundUs) return { phones, hidden, unreachable };
  // Our number is on file and nobody shows it: one of the hidden is us.
  const us = ours !== null && !creatorSeen && hidden.length > 0 ? 1 : 0;
  return {
    phones,
    hidden: [],
    unreachable: unreachable + hidden.length - us,
  };
}
