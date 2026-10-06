// ============================================================
// WhatsApp profile pictures for contacts (migration 070).
//
// Server-only: it is handed decrypted channel credentials and the
// service-role client.
//
// `contacts.avatar_url` is what `ContactAvatar` renders. The picture
// comes from the Whapi number's contact profile, as a WhatsApp CDN link
// that EXPIRES — so, like inbound media (`mirror-inbound-media.ts`),
// the bytes are copied into `chat-media` and the column holds our copy.
//
// `avatar_checked_at` is the throttle: a contact is looked up at most
// once a week, whatever the answer was. A failed attempt moves neither
// column, so the next inbox load simply tries again. Nothing here ever
// throws — the caller is a fire-and-forget request from the inbox, and
// one bad contact must not cost the rest of the batch their pictures.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { toPublicSupabaseUrl } from '@/lib/supabase/urls';

import type { WhatsAppChannel } from './channels';
import {
  MIRROR_BUCKET,
  normalizeMimeType,
  type MirrorStorage,
} from './mirror-inbound-media';
import {
  downloadMedia as providerDownloadMedia,
  getContactProfilePicture,
  type ChannelProbe,
} from './provider';

/** How long a lookup's answer stands before the contact is asked again. */
export const AVATAR_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * WhatsApp serves a full-size avatar at 640px, well under this. Anything
 * bigger is not a profile picture, and is not worth the bucket space.
 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Stored types. Not `image/*`: the bucket is public, and an SVG served
 * from it can carry script.
 */
const AVATAR_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

/** Contacts per request; the inbox chunks to the same number. */
export const AVATAR_BATCH_LIMIT = 50;

/** Profile lookups in flight at once, per request. */
export const AVATAR_CONCURRENCY = 4;

/** Second path segment, beside the inbound mirror's `inbound/`. */
export const AVATAR_FOLDER = 'avatars';

/**
 * A day: the URL carries `?v=` and changes with every refresh, so a
 * browser never shows a stale picture; this only bounds a cache that
 * ignores the query string.
 */
const AVATAR_CACHE_CONTROL = '86400';

/** True when the contact has never been looked up, or the answer is a week old. */
export function isAvatarDue(
  checkedAt: string | null | undefined,
  now: Date
): boolean {
  if (!checkedAt) return true;
  const at = Date.parse(checkedAt);
  if (Number.isNaN(at)) return true;
  return now.getTime() - at >= AVATAR_REFRESH_MS;
}

/**
 * The object path. One per contact, reused on every refresh (`upsert`),
 * so a changed picture replaces the old one instead of piling up. The
 * FIRST segment must be `account-<id>`: migration 023's RLS matches only
 * that one.
 */
export function avatarObjectPath(accountId: string, contactId: string): string {
  return `account-${accountId}/${AVATAR_FOLDER}/${contactId}.jpg`;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate the route's `{ contactIds }` body: an array of UUID strings,
 * at most `AVATAR_BATCH_LIMIT` once deduplicated. Returns the ids, or
 * the message for a 400.
 */
export function parseAvatarRequest(
  body: unknown
): { ids: string[] } | { error: string } {
  const raw = (body as { contactIds?: unknown } | null)?.contactIds;
  if (!Array.isArray(raw)) return { error: 'contactIds must be an array' };
  if (!raw.every((id) => typeof id === 'string' && UUID_RE.test(id))) {
    return { error: 'contactIds must be contact ids' };
  }
  const ids = [...new Set(raw as string[])];
  if (ids.length > AVATAR_BATCH_LIMIT) {
    return {
      error: `At most ${AVATAR_BATCH_LIMIT} contacts per request`,
    };
  }
  return { ids };
}

/**
 * Which Whapi number to ask. The thread's own number first, because a
 * number that has chatted with the contact is the likeliest to be shown
 * their picture (WhatsApp privacy can limit it to contacts). A contact
 * with no thread, or a thread with no number yet, falls back to the
 * account's primary Whapi number, then the oldest one.
 *
 * A thread whose number is NOT a connected Whapi row (a Meta number, or
 * a Whapi number that is down) is skipped: null, not another number.
 * Meta-only contacts must never be looked up through a Whapi number.
 *
 * Only numbers the health monitor reports `connected`: a wrong token
 * answers 404 on this endpoint, which is indistinguishable from "no
 * picture" and would blank the contact for a week.
 */
export function pickAvatarChannel(
  channels: readonly WhatsAppChannel[],
  conversationChannelId: string | null | undefined
): WhatsAppChannel | null {
  const whapi = channels.filter(
    (c) => c.provider === 'whapi' && c.status === 'connected'
  );
  if (conversationChannelId) {
    return whapi.find((c) => c.id === conversationChannelId) ?? null;
  }
  return whapi.find((c) => c.isPrimary) ?? whapi[0] ?? null;
}

/**
 * A per-request gate over `probeChannel`: one live `/health` probe per
 * channel, and only an `AUTH` answer lets its contacts through. The
 * stored `status` can be a few minutes stale, and a wrong token or a
 * deleted channel answers the profile endpoint with the same 404 as a
 * hidden picture, which would blank contacts for a week. Fails closed:
 * a probe error, or no probe for this provider, is "not healthy".
 */
export function createChannelGate(
  probe: (channel: WhatsAppChannel) => Promise<ChannelProbe | null>
): (channel: WhatsAppChannel) => Promise<boolean> {
  const seen = new Map<string, Promise<boolean>>();
  return (channel) => {
    let verdict = seen.get(channel.id);
    if (!verdict) {
      verdict = probe(channel).then(
        (result) => result?.status === 'AUTH',
        () => false
      );
      seen.set(channel.id, verdict);
    }
    return verdict;
  };
}

/** Run `fn` over `items`, at most `limit` at a time, keeping order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
}

export type AvatarRefreshStatus =
  /** A picture was copied and stored. */
  | 'updated'
  /** No picture to show; `avatar_url` cleared. */
  | 'none'
  /** Not a JPEG/PNG/WebP, or too large: stamped as checked, URL left alone. */
  | 'skipped'
  /** Transient failure: nothing written, so it is retried next load. */
  | 'error';

export interface AvatarRefreshResult {
  contactId: string;
  avatarUrl: string | null;
  status: AvatarRefreshStatus;
}

export interface RefreshContactAvatarArgs {
  /** Service-role client. Every write is confined to `accountId` here. */
  db: SupabaseClient;
  /** Service-role `supabase.storage`. */
  storage: MirrorStorage;
  accountId: string;
  contactId: string;
  phone: string;
  /** A Whapi number on the same account (`pickAvatarChannel`). */
  channel: WhatsAppChannel;
  now?: () => Date;
  /** Injected in tests. */
  getPicture?: typeof getContactProfilePicture;
  /** Injected in tests. */
  download?: typeof providerDownloadMedia;
}

/**
 * Look the contact's picture up, copy it into `chat-media`, and record
 * the answer on the contact. Never throws.
 */
export async function refreshContactAvatar(
  args: RefreshContactAvatarArgs
): Promise<AvatarRefreshResult> {
  const {
    db,
    storage,
    accountId,
    contactId,
    phone,
    channel,
    now = () => new Date(),
    getPicture = getContactProfilePicture,
    download = providerDownloadMedia,
  } = args;

  const save = async (patch: Record<string, string | null>) => {
    const { error } = await db
      .from('contacts')
      .update(patch)
      .eq('id', contactId)
      .eq('account_id', accountId);
    if (error) throw new Error(error.message);
  };

  try {
    const pictureUrl = await getPicture(channel, phone);
    if (!pictureUrl) {
      // They removed the picture or hide it from this number. Clear our
      // copy rather than keep showing one they took down.
      await save({ avatar_url: null, avatar_checked_at: now().toISOString() });
      return { contactId, avatarUrl: null, status: 'none' };
    }

    // pps.whatsapp.net is not Whapi's media host, so the Whapi client
    // fetches it without the channel token and behind the SSRF guard.
    const { buffer, contentType } = await download({
      channel,
      downloadUrl: pictureUrl,
    });
    const mime = normalizeMimeType(contentType);
    if (
      !mime ||
      !AVATAR_MIME_TYPES.has(mime) ||
      buffer.byteLength > AVATAR_MAX_BYTES
    ) {
      console.warn(
        `[contact-avatars] skipping ${contactId}: ${mime ?? 'unknown type'}, ${buffer.byteLength} bytes`
      );
      // Whatever this is, asking again on the next load would fetch the
      // same thing. Wait the week; keep whatever picture we had.
      await save({ avatar_checked_at: now().toISOString() });
      return { contactId, avatarUrl: null, status: 'skipped' };
    }

    const path = avatarObjectPath(accountId, contactId);
    const { error: uploadError } = await storage
      .from(MIRROR_BUCKET)
      .upload(path, buffer, {
        contentType: mime,
        cacheControl: AVATAR_CACHE_CONTROL,
        upsert: true,
      });
    if (uploadError) throw new Error(`upload: ${uploadError.message}`);

    const {
      data: { publicUrl },
    } = storage.from(MIRROR_BUCKET).getPublicUrl(path);
    if (!publicUrl) throw new Error('no public URL for the uploaded avatar');

    const at = now();
    // Server-built, so it names the INTERNAL Supabase origin; the browser
    // needs the public one (lib/supabase/urls). `?v=` because the path is
    // reused: without it a browser keeps showing the previous picture.
    const avatarUrl = `${toPublicSupabaseUrl(publicUrl)}?v=${at.getTime()}`;
    await save({ avatar_url: avatarUrl, avatar_checked_at: at.toISOString() });
    return { contactId, avatarUrl, status: 'updated' };
  } catch (err) {
    console.warn(
      `[contact-avatars] could not refresh ${contactId}:`,
      err instanceof Error ? err.message : err
    );
    return { contactId, avatarUrl: null, status: 'error' };
  }
}
