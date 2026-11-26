/**
 * Deal rooms — what the members panel tells a manager after "Re-send
 * invites" and after a join decision, kept pure so it can be tested
 * (the test environment mounts no components). The texts are
 * `Chat.rooms.members.*`.
 */

/** Why a person was passed over; `other` is a refusal this build has no words for. */
export type ResendReason =
  | 'already'
  | 'waiting'
  | 'opted_out'
  | 'no_consent'
  | 'bank_guests_off'
  | 'other';

export type ResendNotice =
  /** Some invites failed to go: an error, even when others went. */
  | { level: 'error'; sent: number; failed: number }
  /** Nothing went and nothing failed: say who was skipped and why. */
  | { level: 'warning'; reasons: ResendReason[] }
  | { level: 'success'; sent: number };

const num = (v: unknown) => (typeof v === 'number' && v > 0 ? v : 0);

export function resendNotice(body: Record<string, unknown>): ResendNotice {
  const sent = num(body.sent);
  const failed = num(body.failed);
  if (failed > 0) return { level: 'error', sent, failed };
  if (sent > 0) return { level: 'success', sent };
  const reasons: ResendReason[] = [];
  if (num(body.alreadyInvited) > 0) reasons.push('already');
  if (num(body.waiting) > 0) reasons.push('waiting');
  const blocked = Array.isArray(body.blocked) ? body.blocked : [];
  for (const code of blocked) {
    const known =
      code === 'opted_out' ||
      code === 'no_consent' ||
      code === 'bank_guests_off'
        ? code
        : 'other';
    if (!reasons.includes(known)) reasons.push(known);
  }
  return { level: 'warning', reasons };
}

/**
 * A join decision answered 200 with some requests skipped: they were
 * not pending, so someone else decided them first.
 */
export const decisionSkipped = (body: Record<string, unknown>): boolean =>
  Array.isArray(body.skipped) && body.skipped.length > 0;
