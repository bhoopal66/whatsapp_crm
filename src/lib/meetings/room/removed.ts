// Who the host removed (migration 110), as GET /api/meetings/[id] lists
// them for a manager, and the request that lets one back in.

export interface RemovedPerson {
  userId: string;
  removedAt: string;
}

/** The detail GET's `removed` list; absent (not a manager) or malformed → []. */
export function parseRemovedPeople(body: unknown): RemovedPerson[] {
  const list =
    body && typeof body === 'object' && 'removed' in body
      ? (body as { removed: unknown }).removed
      : null;
  if (!Array.isArray(list)) return [];
  return list.flatMap((r) =>
    r &&
    typeof r === 'object' &&
    typeof (r as { user_id?: unknown }).user_id === 'string' &&
    typeof (r as { removed_at?: unknown }).removed_at === 'string'
      ? [
          {
            userId: (r as { user_id: string }).user_id,
            removedAt: (r as { removed_at: string }).removed_at,
          },
        ]
      : []
  );
}

/** POST /api/meetings/[id]/moderate's body for letting someone back in. */
export function readmitRequest(userId: string) {
  return { target: userId, action: 'readmit' as const };
}

/**
 * Whether a realtime INSERT on meeting_removed_users (migration 116) is
 * the viewer's own removal from this meeting. A manager in the room
 * receives everyone's removals; only their own ends the call.
 */
export function isOwnRemoval(
  row: unknown,
  viewerUserId: string | null,
  meetingId: string
): boolean {
  if (!viewerUserId || !row || typeof row !== 'object') return false;
  const r = row as { user_id?: unknown; meeting_id?: unknown };
  return r.user_id === viewerUserId && r.meeting_id === meetingId;
}
