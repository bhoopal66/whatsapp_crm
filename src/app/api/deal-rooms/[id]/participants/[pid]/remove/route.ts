import { removeRoomParticipant } from '@/lib/deal-rooms/operations';

import { asManager } from '../../../invite-link/manager';

/**
 * Remove a person from the group (managers only). The response carries
 * `warning`: a removed person cannot rejoin through the invite link.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; pid: string }> }
) {
  const { id, pid } = await params;
  return asManager(id, (db, userId) =>
    removeRoomParticipant(db, { roomId: id, participantId: pid, userId })
  );
}
