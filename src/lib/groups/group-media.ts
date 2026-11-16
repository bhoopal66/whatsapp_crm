/**
 * What a WhatsApp group message's attachment looks like on screen.
 *
 * Group traffic never enters `messages` (migrations 114/115), so a group
 * message carries its attachment in its own `media` jsonb, written by
 * `lib/groups/inbound.ts` from the normalised Whapi payload:
 * `{ id, link, mime_type, filename, file_size }`, or `{ location }`.
 * `link` is Whapi's own https link to the bytes (auto_download), so the
 * browser can show or open it directly. Pure: no React, no I/O.
 */

export type GroupMediaKind =
  'image' | 'sticker' | 'video' | 'audio' | 'document' | 'location';

export interface GroupMediaView {
  kind: GroupMediaKind;
  /** An https link to the bytes; null when the gateway gave none. */
  url: string | null;
  filename: string | null;
  /** "820 KB", "1.4 MB"; null when the size is unknown. */
  sizeLabel: string | null;
  /** The message text, unless it only repeats the file's name. */
  caption: string | null;
  location: {
    label: string | null;
    mapUrl: string;
  } | null;
}

const KINDS: readonly GroupMediaKind[] = [
  'image',
  'sticker',
  'video',
  'audio',
  'document',
  'location',
];

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** Only an absolute https link is ever put in an href or src. */
export function safeMediaUrl(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function fileSizeLabel(v: unknown): string | null {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * The attachment view of a group message, or null when it has none
 * (plain text, or a type this screen does not draw).
 */
export function groupMediaView(
  type: string | null | undefined,
  media: unknown,
  body: string | null | undefined
): GroupMediaView | null {
  const kind = (KINDS as readonly string[]).includes(type ?? '')
    ? (type as GroupMediaKind)
    : null;
  if (!kind) return null;
  const m = asObject(media) ?? {};
  const text = str(body);

  if (kind === 'location') {
    const loc = asObject(m.location);
    const lat = loc && typeof loc.latitude === 'number' ? loc.latitude : null;
    const lng = loc && typeof loc.longitude === 'number' ? loc.longitude : null;
    if (lat === null || lng === null) return null;
    const label =
      [str(loc?.name), str(loc?.address)].filter(Boolean).join(', ') || null;
    return {
      kind,
      url: null,
      filename: null,
      sizeLabel: null,
      caption: text && text !== label ? text : null,
      location: {
        label,
        mapUrl: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`,
      },
    };
  }

  const filename = str(m.filename);
  return {
    kind,
    url: safeMediaUrl(m.link),
    filename,
    sizeLabel: fileSizeLabel(m.file_size),
    caption: text && text !== filename ? text : null,
    location: null,
  };
}
