import { roomInviteLink } from '@/lib/deal-rooms/operations';

import { asManager } from '../manager';

/**
 * A new invite link (managers only): every earlier link stops working.
 * Its hash is stored and the reset audited; the link itself is returned.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return asManager(id, (db, userId) =>
    roomInviteLink(db, { roomId: id, userId, reset: true })
  );
}
