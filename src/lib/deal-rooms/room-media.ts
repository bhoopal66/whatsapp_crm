/**
 * Deal rooms — a file staff send to the group (module 014c): which files
 * the composer offers and the route accepts. Pure, so the client checks a
 * file before uploading it and the server repeats the same check.
 *
 * Images and documents only, the types Meta's Cloud API takes for them
 * (an image is JPEG or PNG: WebP is a sticker there). The ceilings:
 *  - image: Meta's own 5 MB;
 *  - document: Meta takes 100 MB, but the file reaches the route as the
 *    request body, and the middleware (Next's `proxyClientMaxBodySize`,
 *    10 MB by default) buffers only the first 10 MB of a body and
 *    silently drops the rest. 9 MB leaves room for the multipart framing
 *    and the caption.
 */

export type RoomMediaKind = 'image' | 'document';

export const ROOM_MEDIA_TYPES: Record<RoomMediaKind, readonly string[]> = {
  image: ['image/jpeg', 'image/png'],
  document: [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
  ],
};

const MB = 1024 * 1024;

export const ROOM_MEDIA_MAX_BYTES: Record<RoomMediaKind, number> = {
  image: 5 * MB,
  document: 9 * MB,
};

/** Meta's caption ceiling for images and documents. */
export const ROOM_MEDIA_CAPTION_MAX = 1024;

/** The file picker's `accept`: exactly what the route takes. */
export const ROOM_MEDIA_ACCEPT = [
  ...ROOM_MEDIA_TYPES.image,
  ...ROOM_MEDIA_TYPES.document,
].join(',');

export function roomMediaKind(mime: string): RoomMediaKind | null {
  const type = mime.split(';')[0].trim().toLowerCase();
  if (ROOM_MEDIA_TYPES.image.includes(type)) return 'image';
  if (ROOM_MEDIA_TYPES.document.includes(type)) return 'document';
  return null;
}

export type RoomMediaCheck =
  | { ok: true; kind: RoomMediaKind }
  | { ok: false; code: 'media_type' }
  | { ok: false; code: 'media_size'; maxBytes: number };

export function checkRoomMedia(file: {
  type: string;
  size: number;
}): RoomMediaCheck {
  const kind = roomMediaKind(file.type);
  if (!kind) return { ok: false, code: 'media_type' };
  const maxBytes = ROOM_MEDIA_MAX_BYTES[kind];
  if (file.size <= 0 || file.size > maxBytes) {
    return { ok: false, code: 'media_size', maxBytes };
  }
  return { ok: true, kind };
}

/**
 * Where a sent file lives in the private `deal-files` bucket: under the
 * room, so `deal_files_storage_can_read` (088) shows it to the room's
 * staff, with the time first so two sends of one name never collide.
 */
export function roomMediaPath(
  accountId: string,
  roomId: string,
  fileName: string,
  now = Date.now()
): string {
  const safe =
    fileName
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 120) || 'file';
  return `account-${accountId}/room-${roomId}/out-${now}-${safe}`;
}
