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

const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const JPEG = [0xff, 0xd8, 0xff];
const RTF = [0x7b, 0x5c, 0x72, 0x74, 0x66]; // {\rtf

/** A file's leading bytes: one of these signatures, or plain text. */
type RoomMediaMagic = readonly (readonly number[])[] | 'text';

/**
 * What a file of each accepted type looks like: the extensions its name
 * may end in, and its leading bytes. Legacy Office files are OLE2
 * compound files; the newer ones are ZIP archives, or OLE2 when
 * password-protected (the encrypted package sits in a compound file).
 * Windows labels a .csv with Excel's type and an .rtf with Word's, so
 * those pairs pass on their own content. Plain text has no signature,
 * so it passes when its first {@link TEXT_SNIFF_BYTES} bytes hold no NUL
 * byte (git's own binary test), or, after a UTF-16 byte order mark (as
 * Notepad's "Unicode" saves Arabic), no NUL character.
 */
export const ROOM_MEDIA_FORMATS: Record<
  string,
  readonly { extensions: readonly string[]; magic: RoomMediaMagic }[]
> = {
  'image/jpeg': [{ extensions: ['jpg', 'jpeg', 'jpe', 'jfif'], magic: [JPEG] }],
  'image/png': [
    {
      extensions: ['png'],
      magic: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    },
  ],
  'application/pdf': [
    { extensions: ['pdf'], magic: [[0x25, 0x50, 0x44, 0x46, 0x2d]] }, // %PDF-
  ],
  'application/msword': [
    { extensions: ['doc'], magic: [OLE2] },
    { extensions: ['rtf'], magic: [RTF] },
  ],
  'application/vnd.ms-excel': [
    { extensions: ['xls'], magic: [OLE2] },
    { extensions: ['csv'], magic: 'text' },
  ],
  'application/vnd.ms-powerpoint': [{ extensions: ['ppt'], magic: [OLE2] }],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [
    { extensions: ['docx'], magic: [ZIP, OLE2] },
  ],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': [
    { extensions: ['xlsx'], magic: [ZIP, OLE2] },
  ],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': [
    { extensions: ['pptx'], magic: [ZIP, OLE2] },
  ],
  'text/plain': [{ extensions: ['txt'], magic: 'text' }],
};

export const TEXT_SNIFF_BYTES = 8000;

function isText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  const head = bytes.subarray(0, TEXT_SNIFF_BYTES);
  const utf16 =
    (head[0] === 0xff && head[1] === 0xfe) ||
    (head[0] === 0xfe && head[1] === 0xff);
  if (!utf16) return !head.includes(0);
  // UTF-16: half the bytes of Latin text are NUL, a NUL character never.
  for (let i = 2; i + 1 < head.length; i += 2)
    if (head[i] === 0 && head[i + 1] === 0) return false;
  return true;
}

export type RoomMediaContentCheck =
  { ok: true } | { ok: false; code: 'media_name' | 'media_content' };

/**
 * The server's check of a file's name and bytes, once it has passed
 * {@link checkRoomMedia}: the type is the browser's claim, so the name
 * must end in one of that type's extensions (`media_name`) and the bytes
 * must start as that extension's do (`media_content`).
 */
export function checkRoomMediaContent(
  file: { type: string; name: string },
  bytes: Uint8Array
): RoomMediaContentCheck {
  const formats =
    ROOM_MEDIA_FORMATS[file.type.split(';')[0].trim().toLowerCase()];
  if (!formats) return { ok: false, code: 'media_content' };
  const ext = /\.([A-Za-z0-9]+)$/.exec(file.name)?.[1].toLowerCase();
  const format = ext && formats.find((f) => f.extensions.includes(ext));
  if (!format) return { ok: false, code: 'media_name' };
  const { magic } = format;
  const fits =
    magic === 'text'
      ? isText(bytes)
      : magic.some(
          (sig) =>
            bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b)
        );
  return fits ? { ok: true } : { ok: false, code: 'media_content' };
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
