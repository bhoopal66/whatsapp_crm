/**
 * The group wall (`/group-wall`): several WhatsApp groups side by side,
 * live and read-only. Everything here is pure so it can be tested in
 * node; the screen is `components/groups/group-wall.tsx`.
 *
 * The wall never marks a group read: only opening the group does
 * (migration 146). It keeps only the chosen group ids per browser, never
 * messages.
 */

/** At most this many columns: each one is a realtime channel and a read. */
export const WALL_MAX_COLUMNS = 8;

/** Messages a column holds and shows, newest at the bottom. */
export const WALL_PAGE = 30;

/** Within this many pixels of the bottom counts as at the bottom. */
export const WALL_BOTTOM_SLACK = 80;

/**
 * The localStorage key of the chosen ids: per workspace and per person,
 * so two people (or two workspaces) on one browser never share a wall.
 */
export function wallStorageKey(accountId: string, userId: string): string {
  return `group-wall:v1:${accountId}:${userId}`;
}

/**
 * Group ids from `?ids=a,b,c` or the stored string: trimmed, empty and
 * repeated ones dropped, ids `known` does not hold dropped (no access,
 * deleted, left), at most {@link WALL_MAX_COLUMNS}, first ones kept.
 * Pass `known` as null while the list is not loaded yet.
 */
export function parseWallIds(
  raw: string | null | undefined,
  known: ReadonlySet<string> | null = null
): string[] {
  if (typeof raw !== 'string') return [];
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const out = [...new Set(parts)].filter((id) => !known || known.has(id));
  out.splice(WALL_MAX_COLUMNS);
  return out;
}

/** The ids as `?ids=` and the stored value write them. */
export function serializeWallIds(ids: readonly string[]): string {
  return parseWallIds(ids.join(',')).join(',');
}

/**
 * The wall's ids: the URL's when it names any (a shared link wins), else
 * the stored ones, each read through {@link parseWallIds}.
 */
export function resolveWallIds(
  fromUrl: string | null | undefined,
  fromStorage: string | null | undefined,
  known: ReadonlySet<string> | null
): string[] {
  const url = parseWallIds(fromUrl);
  return parseWallIds(url.length > 0 ? url.join(',') : fromStorage, known);
}

/**
 * Ticking or unticking one group in the picker. Ticking one more than
 * the cap changes nothing and says so (`full`).
 */
export function toggleWallId(
  ids: readonly string[],
  id: string
): { ids: string[]; full: boolean } {
  if (ids.includes(id))
    return { ids: ids.filter((x) => x !== id), full: false };
  if (ids.length >= WALL_MAX_COLUMNS) return { ids: [...ids], full: true };
  return { ids: [...ids, id], full: false };
}

/** What the picker offers: real groups we are still in, matching `query`. */
export function pickableGroups<
  T extends { name: string; kind: string; our_role: string },
>(groups: readonly T[], query: string): T[] {
  const q = query.trim().toLocaleLowerCase();
  return groups.filter(
    (g) =>
      g.kind === 'group' &&
      g.our_role !== 'left' &&
      (q === '' || g.name.toLocaleLowerCase().includes(q))
  );
}

/** Message types the "Files only" filter keeps (not stickers or locations). */
export const WALL_FILE_TYPES: readonly string[] = [
  'image',
  'video',
  'audio',
  'voice',
  'document',
];

export type WallFilter = 'all' | 'files';

export function isWallFile(m: { type: string | null | undefined }): boolean {
  return WALL_FILE_TYPES.includes(m.type ?? '');
}

/** What a column shows of the messages it holds. */
export function filterWallMessages<
  T extends { type: string | null | undefined },
>(messages: readonly T[], filter: WallFilter): T[] {
  return filter === 'files' ? messages.filter(isWallFile) : [...messages];
}

/** The newest `limit` of oldest-first messages, still oldest first. */
export function keepLatest<T>(messages: readonly T[], limit = WALL_PAGE): T[] {
  return messages.length > limit
    ? messages.slice(messages.length - limit)
    : [...messages];
}

function dayKey(at: Date, timeZone?: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * A message's time on the wall, `HH:MM` in the reader's locale and time
 * zone (pass `timeZone` undefined in the browser, as the group log does),
 * with a short day label when it is not today there. Null for a bad date.
 */
export function wallTimeLabel(
  iso: string | null | undefined,
  now: Date,
  locale: string,
  timeZone?: string
): { time: string; day: string | null } | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return null;
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(at);
  const day = dayKey(at, timeZone);
  const today = dayKey(now, timeZone);
  if (day === today) return { time, day: null };
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  return {
    time,
    day: new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'short',
      year: sameYear ? undefined : 'numeric',
      timeZone,
    }).format(at),
  };
}

/** Whether a column's reader is at the bottom: new rows then follow. */
export function isAtBottom(
  el: { scrollHeight: number; scrollTop: number; clientHeight: number },
  slack = WALL_BOTTOM_SLACK
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < slack;
}

/**
 * Whether a column scrolls to the bottom after its rows change: on its
 * first fill, and afterwards only when the reader was already there, so
 * reading back is never interrupted.
 */
export function shouldAutoScroll(args: {
  firstFill: boolean;
  wasAtBottom: boolean;
}): boolean {
  return args.firstFill || args.wasAtBottom;
}
