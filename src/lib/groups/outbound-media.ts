/**
 * An attachment staff send into a WhatsApp group (the group composer).
 *
 * The browser uploads the file into the `chat-media` bucket under
 * `account-<id>/groups/` (never `staged/`: the staged sweep only knows
 * `messages.media_url` and would delete group files) and posts the
 * public URL. The send route hands that URL to the gateway, so it must
 * be this deployment's own object in the caller's folder, never an
 * arbitrary link. It is compared on the URL path only (the public
 * origin changes with the tunnel), so the link actually sent is rebuilt
 * on this deployment's own public origin: the caller's host never
 * reaches the gateway (OpenWA runs beside the app and would fetch an
 * internal address). Pure: no I/O.
 */

export const GROUP_MEDIA_KINDS = [
  'image',
  'video',
  'document',
  'voice',
] as const;
export type GroupOutboundKind = (typeof GROUP_MEDIA_KINDS)[number];

/** WhatsApp's caption ceiling, as the inbox composer's MEDIA_CAPTION_MAX. */
export const GROUP_MEDIA_CAPTION_MAX = 1024;
export const GROUP_MEDIA_FOLDER = 'groups';
const PUBLIC_PREFIX = '/storage/v1/object/public/chat-media/';

export interface GroupOutboundMedia {
  kind: GroupOutboundKind;
  url: string;
  path: string;
  caption: string | null;
  filename: string | null;
  mimeType: string | null;
}

export class GroupMediaInputError extends Error {}

function bad(message: string): never {
  throw new GroupMediaInputError(message);
}

function optText(v: unknown, field: string, max: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') bad(`${field} must be text`);
  const s = v.trim();
  if (s.length > max) bad(`${field} must be at most ${max} characters`);
  return s || null;
}

/** The storage path a public chat-media URL names, or null. */
export function chatMediaPathOf(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.search || u.hash || u.username || u.password) return null;
  if (!u.pathname.startsWith(PUBLIC_PREFIX)) return null;
  try {
    return decodeURIComponent(u.pathname.slice(PUBLIC_PREFIX.length));
  } catch {
    return null;
  }
}

/** Whether a storage path is a group upload of this account. */
export function isGroupMediaPath(path: string, accountId: string): boolean {
  const prefix = `account-${accountId}/${GROUP_MEDIA_FOLDER}/`;
  if (!path.startsWith(prefix)) return false;
  const name = path.slice(prefix.length);
  // One file name, of the characters buildMediaPath produces.
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name);
}

/** The `media` field of a send request, validated for one account. */
export function parseGroupMedia(
  raw: unknown,
  accountId: string,
  /** `publicSupabaseUrl()`: the only origin a sent link may carry. */
  publicOrigin: string
): GroupOutboundMedia {
  const m =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : bad('media must be an object');
  const kind = m.kind;
  if (!(GROUP_MEDIA_KINDS as readonly unknown[]).includes(kind)) {
    bad('media.kind must be image, video, document or voice');
  }
  if (typeof m.url !== 'string' || typeof m.path !== 'string') {
    bad('media.url and media.path are required');
  }
  const urlPath = chatMediaPathOf(m.url);
  if (
    urlPath === null ||
    urlPath !== m.path ||
    !isGroupMediaPath(m.path, accountId)
  ) {
    bad('media.url must be an upload of this workspace');
  }
  return {
    kind: kind as GroupOutboundKind,
    // The path is one checked file name under the account's folder, so
    // it needs no encoding.
    url: `${publicOrigin.replace(/\/+$/, '')}${PUBLIC_PREFIX}${m.path}`,
    path: m.path,
    caption:
      kind === 'voice'
        ? null
        : optText(m.caption, 'media.caption', GROUP_MEDIA_CAPTION_MAX),
    filename: optText(m.filename, 'media.filename', 255),
    mimeType: optText(m.mimeType, 'media.mimeType', 255),
  };
}

/** The row's `type`: a voice note is stored as `audio`, like inbound. */
export function groupMediaRowType(kind: GroupOutboundKind): string {
  return kind === 'voice' ? 'audio' : kind;
}

/** The row's `media` jsonb, in the shape `groupMediaView` reads. */
export function groupMediaRowMedia(m: {
  url: string;
  mimeType?: string | null;
  filename?: string | null;
}): { link: string; mime_type: string | null; filename: string | null } {
  return {
    link: m.url,
    mime_type: m.mimeType ?? null,
    filename: m.filename ?? null,
  };
}
