import type { AttachmentInput, ChatAttachment, ChatMessage } from './types';

/**
 * How a team-chat attachment renders. A voice note (migration 156's
 * `kind`) gets the player and a played receipt; any other audio file gets
 * the same player with its name and size and no receipt (it is just
 * audio); an image a thumbnail; a video an inline player; everything
 * else a file chip.
 */
export type AttachmentDisplay = 'voice' | 'audio' | 'image' | 'video' | 'file';

export function attachmentDisplay(
  a: Pick<ChatAttachment, 'kind' | 'mime'>
): AttachmentDisplay {
  if (a.kind === 'voice') return 'voice';
  const mime = a.mime.toLowerCase();
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
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

/**
 * The composer's recording cap. A forgotten recording stops itself here,
 * well inside migration 156's 1..1,200,000 ms duration and the 25 MB file
 * cap (Opus speech runs about 2-3 MB for 15 minutes).
 */
export const CHAT_VOICE_MAX_SECONDS = 15 * 60;

/** Migration 156's bounds on a voice note's duration_ms. */
const VOICE_MIN_MS = 1;
const VOICE_MAX_MS = 1_200_000;

/**
 * A take's length from two performance.now() readings, clamped to what
 * the database accepts: a near-instant stop is still 1 ms, never 0.
 */
export function voiceDurationMs(startedAt: number, stoppedAt: number): number {
  const ms = Math.round(stoppedAt - startedAt);
  if (!Number.isFinite(ms) || ms < VOICE_MIN_MS) return VOICE_MIN_MS;
  return Math.min(ms, VOICE_MAX_MS);
}

const pad = (n: number) => n.toString().padStart(2, '0');

/** voice-<yyyyMMdd-HHmmss>.ogg in the recorder's local time. */
export function voiceFileName(now: Date): string {
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `voice-${date}-${time}.ogg`;
}

/**
 * The uploaded take as a voice-note attachment. 156 requires an audio/*
 * mime, so one the browser left blank (uploadChatFile then stores
 * application/octet-stream) is sent as the Ogg/Opus the recorder writes.
 */
export function voiceAttachment(
  upload: AttachmentInput,
  durationMs: number
): AttachmentInput {
  const mime = /^audio\//i.test(upload.mime.trim())
    ? upload.mime.trim()
    : 'audio/ogg';
  return { ...upload, mime, kind: 'voice', duration_ms: durationMs };
}
