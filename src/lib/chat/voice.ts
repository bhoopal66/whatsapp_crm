import type { ChatAttachment, ChatMessage } from './types';

/**
 * How a team-chat attachment renders. A voice note (migration 156's
 * `kind`) gets the player and a played receipt; any other audio file gets
 * the same player with its name and size and no receipt (it is just
 * audio); an image a thumbnail; everything else a download button.
 */
export type AttachmentDisplay = 'voice' | 'audio' | 'image' | 'file';

export function attachmentDisplay(
  a: Pick<ChatAttachment, 'kind' | 'mime'>
): AttachmentDisplay {
  if (a.kind === 'voice') return 'voice';
  const mime = a.mime.toLowerCase();
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('image/')) return 'image';
  return 'file';
}

/**
 * A voice note's body is the composer's automatic label ("🎤 Voice
 * message (0:42)"), kept for search and bell text; the row shows the
 * player instead. Once someone edited it, it is their words: show it.
 */
export function hidesVoiceBody(
  m: Pick<ChatMessage, 'attachments' | 'editedAt' | 'deletedAt'>
): boolean {
  return (
    !m.deletedAt &&
    !m.editedAt &&
    m.attachments.length === 1 &&
    m.attachments[0].kind === 'voice'
  );
}

/**
 * Below this age a failed signed URL is not an expired one (they live
 * 300 s): the object is gone or unreadable, and minting again would only
 * fail again.
 */
export const REMINT_MIN_AGE_MS = 30_000;

/** Whether a load failure on a URL minted at `mintedAt` deserves a new URL. */
export function shouldRemint(mintedAt: number, now: number): boolean {
  return now - mintedAt >= REMINT_MIN_AGE_MS;
}

/**
 * Claims the one played receipt per message per page session: true the
 * first time a viewer who is not the author plays it (the database
 * ignores an author's own plays anyway, so this only saves the call).
 */
export function claimVoicePlay(
  seen: Set<string>,
  messageId: string,
  viewerId: string | null | undefined,
  authorId: string | null | undefined
): boolean {
  if (!viewerId) return false;
  if (authorId && authorId.toLowerCase() === viewerId.toLowerCase())
    return false;
  if (seen.has(messageId)) return false;
  seen.add(messageId);
  return true;
}
