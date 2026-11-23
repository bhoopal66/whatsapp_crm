import type { SharedContact } from '@/lib/whatsapp/contact-card';

/**
 * What a WhatsApp group message's attachment looks like on screen.
 *
 * Group traffic never enters `messages` (migrations 114/115), so a group
 * message carries its attachment in its own `media` jsonb, written by
 * `lib/groups/inbound.ts` from the normalised Whapi payload:
 * `{ id, link, mime_type, filename, file_size }`, `{ location }`, or
 * `{ contacts }` (a shared contact card, `groupContactCards`).
 * `link` is our own https link once `inbound-media.ts` has copied the
 * bytes into `chat-media`. Until then, or when the copy failed, it is
 * Whapi's own link (about 30 days) or null on an OpenWA number; a
 * submission group always keeps Whapi's. Pure: no React, no I/O.
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

/**
 * Only an absolute https link is ever put in an href or src: our public
 * storage origin or Whapi's. (A development stack on plain http shows its
 * copies as unavailable.)
 */
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

/**
 * The link a document's download button opens. A browser ignores the
 * anchor's `download` name on another origin, so for a file in our own
 * storage the name goes into the URL, which makes the storage API answer
 * it as an attachment of that name.
 */
export function groupDownloadUrl(url: string, filename: string | null): string {
  if (!filename) return url;
  const u = new URL(url);
  if (!u.pathname.includes('/storage/v1/object/public/')) return url;
  u.searchParams.set('download', filename);
  return u.toString();
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

function strings(v: unknown): string[] {
  return Array.isArray(v)
    ? v.map(str).filter((x): x is string => x !== null)
    : [];
}

/** The `Contact: ` prefix of `contactCardsText`, which the body carries. */
const CARD_PREFIX = /^Contact:\s*/;

/**
 * The contact card(s) a group message shared, or null when it is not a
 * `contacts` message. Since the card is kept in `media.contacts`; an
 * older message kept only the preview text (`Contact: <name>`), so it
 * comes back as a name-only card rather than as plain text.
 */
export function groupContactCards(
  type: string | null | undefined,
  media: unknown,
  body: string | null | undefined
): SharedContact[] | null {
  if (type !== 'contacts') return null;
  const raw = asObject(media)?.contacts;
  const cards: SharedContact[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const c = asObject(item);
      if (!c) continue;
      const phones = strings(c.phones);
      const name = str(c.name) ?? phones[0] ?? null;
      if (!name) continue;
      cards.push({ name, phones, emails: strings(c.emails), org: str(c.org) });
    }
  }
  if (cards.length > 0) return cards;
  const text = str(body);
  const name = text ? str(text.replace(CARD_PREFIX, '')) : null;
  return [
    {
      // `Contact card` is the preview of a card with no names on it.
      name: name && name !== 'Contact card' ? name : '',
      phones: [],
      emails: [],
      org: null,
    },
  ];
}
