import { fail, loadRoom } from '@/lib/deal-rooms/operations';
import { saveTranscript } from '@/lib/deal-rooms/transcript';

import { asManager } from '../invite-link/manager';

/**
 * Save the group's transcript to the deal's files now (managers only):
 * every group message, the files shared and the membership history, as
 * HTML in the private `deal-files` bucket. Team notes are not in it.
 * 200 `{ fileId, name }`.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return asManager(id, async (db, userId) => {
    const room = await loadRoom(db, id);
    if (!room) return fail(404, 'not_found', 'Deal room not found');
    const saved = await saveTranscript(db, room, userId);
    return { ok: true, fileId: saved.id, name: saved.name };
  });
}
