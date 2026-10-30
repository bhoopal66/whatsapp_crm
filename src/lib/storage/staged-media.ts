/**
 * Composer attachments staged in chat-media before they are sent, and how
 * long they last. Dependency-free on purpose: the server sweep
 * (staged-media-sweep.ts) and the composer (a client component) both
 * import it, and a Supabase client here would drag one into the other's
 * bundle (the same reason as lib/whatsapp/interactive-limits.ts).
 */

/**
 * Subfolder of `account-<id>` that holds inbox-composer attachments, so
 * migration 155's `chat_media_staged_orphans` can find the ones never
 * sent. The cron sweep deletes any object here that no message, template
 * or broadcast header references once it is STAGED_MEDIA_MAX_AGE_DAYS
 * old, so nothing that keeps a file without a message (a template or
 * broadcast header, a flow) may upload here.
 */
export const STAGED_MEDIA_SUBFOLDER = 'staged';

/**
 * Age at which the server sweep deletes an unreferenced staged object.
 * A long-lived tab can hold a staged attachment longer than that (parked
 * for a chat, left in an open composer, kept for a failed send's Retry),
 * so the client checks isExpiredStagedMedia before using one again.
 */
export const STAGED_MEDIA_MAX_AGE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One day under the server's age: the client stops using an attachment
 * before the sweep can have deleted it, whatever the clock skew between
 * the browser and the database. The stamp in the name is taken before the
 * upload starts, so it is never younger than the object's created_at the
 * sweep compares.
 */
const CLIENT_MAX_AGE_MS = (STAGED_MEDIA_MAX_AGE_DAYS - 1) * DAY_MS;

/** `account-<uuid>/staged/<epoch ms>-<name>`, bare or ending a URL path. */
const STAGED_NAME =
  /(?:^|\/)account-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/staged\/(\d+)-[^/]+$/i;

/**
 * Whether `pathOrUrl` names a staged composer attachment older than the
 * client's limit, i.e. one the server sweep may already have deleted.
 * Anything else (inbound/ mirrors, template media, a name without a
 * readable stamp) is false: only the staged folder is swept.
 */
export function isExpiredStagedMedia(
  pathOrUrl: string,
  now: number = Date.now()
): boolean {
  const path = pathOrUrl.split(/[?#]/, 1)[0];
  const match = STAGED_NAME.exec(path);
  if (!match) return false;
  const stamp = Number(match[1]);
  if (!Number.isSafeInteger(stamp) || stamp <= 0) return false;
  return now - stamp > CLIENT_MAX_AGE_MS;
}
