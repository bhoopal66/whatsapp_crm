/**
 * Look and limits shared by the inbox composer and the group composer
 * (`components/groups/group-composer.tsx`), so the two stay alike.
 * Pure: no I/O, safe to import from client and test code.
 */

/** Hard cap on a single voice recording so it can't blow the upload/
 *  transcode limits — auto-stops the recorder when reached. */
export const MAX_RECORDING_SECONDS = 5 * 60;

// Mirrors the chat-media bucket's allowed_mime_types (migration 023) for
// the file picker so unsupported files are rejected before upload rather
// than failing with a confusing Storage error. Audio has no picker — it's
// captured via the recorder.
export const PICKER_ACCEPT: Record<'image' | 'video' | 'document', string> = {
  image: 'image/png,image/jpeg,image/webp',
  video: 'video/mp4,video/3gpp',
  document:
    'application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain',
};

/** The composer's round toolbar buttons, in WhatsApp's icon grey. */
export const TOOL_BUTTON =
  'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full p-0 text-wa-icon transition-colors hover:bg-wa-icon-hover hover:text-wa-icon disabled:cursor-not-allowed disabled:opacity-50';

/** A smaller round button that sits inside the inbox composer's text
 *  box (attach, AI draft), so the box keeps its width on a phone. */
export const PILL_BUTTON =
  'inline-flex h-10 w-8 shrink-0 items-center justify-center rounded-full p-0 text-wa-icon transition-colors hover:bg-wa-icon-hover hover:text-wa-icon disabled:cursor-not-allowed disabled:opacity-50 sm:w-10';

/** The round green send button. */
export const SEND_BUTTON =
  'h-10 w-10 shrink-0 rounded-full bg-wa-green p-0 text-wa-green-fg hover:bg-wa-green/90 disabled:opacity-40';

/** Worker that encodes mic input to Ogg/Opus entirely in the browser
 *  (vendored from opus-recorder into /public). Recording client-side in a
 *  Meta-accepted format means no server ffmpeg / transcode step. */
export const OPUS_ENCODER_PATH = '/opus/encoderWorker.min.js';
