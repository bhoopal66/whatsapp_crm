import { cancelCreatingRoom, fail } from '@/lib/deal-rooms/operations';

import { asManager } from '../invite-link/manager';

const REASON_MAX = 500;

/**
 * Cancel a deal room whose group is still being created (managers
 * only): `{ reason? }`. 200 `{ status: 'failed' }`, also when it was
 * already cancelled; 409 `room_not_creating` (with `status`) once the
 * group exists or the room has moved on. A group WhatsApp creates
 * afterwards is deleted, never opened (migration 096).
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
    return cancelCreatingRoom(db, { roomId: id, userId, reason });
  });
}
