import { closeRoom, fail } from '@/lib/deal-rooms/operations';

import { asManager } from '../invite-link/manager';

/** Removing everyone, then deleting the group: several round trips. */
export const maxDuration = 60;

const REASON_MAX = 500;

/**
 * Close the deal room (managers only): `{ reason? }`. The room goes to
 * `closing`, the transcript is saved to the deal's files, everyone is
 * removed and the group deleted, then `closed`: 200
 * `{ status: 'closed', transcriptFileId }`. A WhatsApp failure on the
 * way leaves the room `closing` with `last_error` and answers 502
 * `close_incomplete` (`step` names where it stopped); closing again
 * continues from there.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const raw = (body as { reason?: unknown } | null)?.reason;
  return asManager(id, async (db, userId) => {
    if (raw !== undefined && raw !== null && typeof raw !== 'string') {
      return fail(400, 'invalid', 'reason must be text');
    }
    const reason = typeof raw === 'string' ? raw.trim() || null : null;
    if (reason && reason.length > REASON_MAX) {
      return fail(
        400,
        'invalid',
        `A reason is at most ${REASON_MAX} characters`
      );
    }
    return closeRoom(db, { roomId: id, userId, reason });
  });
}
