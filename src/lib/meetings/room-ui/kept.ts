// What the room's side panels hold for a person across a tab switch and
// past the end of the meeting. The panels unmount on every switch, so the
// text lives here, keyed per person and meeting (two logins can share a
// tab). Memory only: nothing is written to disk.

import { isDirty, type NotesState } from '@/lib/meetings/room-ui/notes';

export const keptKey = (userId: string | null, meetingId: string): string =>
  `${userId}:${meetingId}`;

/** Unsaved minutes, an open conflict and a save in flight. */
export const keptNotes = new Map<string, NotesState>();

/** The meeting chat's unsent line. */
export const chatDrafts = new Map<string, string>();

/**
 * Minutes that never reached the server (a conflict was still open, or
 * the meeting closed first): shown once the meeting is over so they can
 * be copied out. Null when there is nothing worth showing.
 */
export function unsavedMinutes(
  userId: string | null,
  meetingId: string
): string | null {
  const s = keptNotes.get(keptKey(userId, meetingId));
  if (!s || !isDirty(s) || !s.text.trim()) return null;
  return s.text;
}
