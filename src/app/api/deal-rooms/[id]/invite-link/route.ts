import { roomInviteLink } from '@/lib/deal-rooms/operations';

import { asManager } from './manager';

/**
 * The group's invite link, fresh from WhatsApp (managers only). It is
 * a bearer secret: never stored in clear, never cached.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return asManager(id, (db, userId) =>
    roomInviteLink(db, { roomId: id, userId, reset: false })
  );
}
