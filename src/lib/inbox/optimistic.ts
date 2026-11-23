// ============================================================
// Optimistic (`temp-`) bubbles and the rows that replace them.
//
// A bubble is shown before POST /api/whatsapp/send answers and must be
// replaced by exactly its own row: an INSERT of some other message (a
// customer's, the bot's, a second send) leaves it alone. The route's
// answer names the row (`message_id`), kept on the bubble as
// `sent_row_id`. The realtime INSERT usually lands before that answer,
// so a row nobody claimed yet is matched to the oldest bubble of this
// user's with the same type and text.
// ============================================================

import type { Message } from '@/types';

let tempCount = 0;

/** A new bubble's id: the counter keeps two in one millisecond apart. */
export function nextTempId(now: number = Date.now()): string {
  tempCount += 1;
  return `temp-${now}-${tempCount}`;
}

export function isTempId(id: string): boolean {
  return id.startsWith('temp-');
}

/** This user's own saved message. */
export function isOwnRow(
  m: Pick<Message, 'id' | 'sender_type' | 'sender_id'>,
  viewerId: string | null | undefined
): boolean {
  return (
    !!viewerId &&
    !isTempId(m.id) &&
    m.sender_type === 'agent' &&
    m.sender_id === viewerId
  );
}

/** The bubble `row` replaces among `temps` (oldest first), if any. */
function tempFor(
  temps: readonly Message[],
  row: Message,
  viewerId: string | null | undefined
): Message | undefined {
  const named = temps.find((m) => m.sent_row_id === row.id);
  if (named) return named;
  if (!isOwnRow(row, viewerId)) return undefined;
  const alike = temps.filter(
    (m) =>
      !m.sent_row_id &&
      m.content_type === row.content_type &&
      (m.content_text ?? '') === (row.content_text ?? '')
  );
  // A failed bubble last: it usually never went out. Among the rest the
  // same upload first, which tells two captionless photos apart.
  const live = alike.filter((m) => m.status !== 'failed');
  const pool = live.length > 0 ? live : alike;
  return (
    pool.find((m) => !!m.media_url && m.media_url === row.media_url) ?? pool[0]
  );
}

/** A realtime INSERT: append `row`, in place of the one bubble it is. */
export function appendInsertedMessage(
  list: Message[],
  row: Message,
  viewerId: string | null | undefined
): Message[] {
  if (list.some((m) => m.id === row.id)) return list;
  const temp = tempFor(
    list.filter((m) => isTempId(m.id)),
    row,
    viewerId
  );
  if (!temp) return [...list, row];
  // Above the bubbles still in flight, so a later send stays below.
  const rest = list.filter((m) => m !== temp);
  let at = rest.length;
  while (at > 0 && isTempId(rest[at - 1].id)) at -= 1;
  return [...rest.slice(0, at), row, ...rest.slice(at)];
}

/**
 * Apply `updates` to the message `id`. The same array when the list
 * does not hold it: an UPDATE in another chat must not look like a
 * change of this one. A bubble told its row (`sent_row_id`) goes when
 * that row is already here.
 */
export function patchMessage(
  list: Message[],
  id: string,
  updates: Partial<Message>
): Message[] {
  if (!list.some((m) => m.id === id)) return list;
  const rowId = updates.sent_row_id;
  if (rowId && isTempId(id) && list.some((m) => m.id === rowId)) {
    return list.filter((m) => m.id !== id);
  }
  return list.map((m) => (m.id === id ? { ...m, ...updates } : m));
}

/** The row id in a successful /api/whatsapp/send answer. */
export function sentRowId(payload: unknown): string | undefined {
  const id = (payload as { message_id?: unknown } | null)?.message_id;
  return typeof id === 'string' && id ? id : undefined;
}

function time(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/**
 * The bubbles of `existing` still worth showing beside a page read from
 * the server: in flight, or sent so recently that the page misses their
 * row, and not among the page's rows themselves.
 *
 * Text alone may only claim a row newer than the saved message above
 * the bubble, so yesterday's "ok" never takes the place of this one.
 */
export function unsettledTemps(
  existing: readonly Message[],
  page: readonly Message[],
  viewerId: string | null | undefined
): Message[] {
  const held = new Set(existing.map((m) => m.id));
  const inPage = new Set(page.map((m) => m.id));
  const above = new Map<string, number>();
  let last: number | null = null;
  let temps: Message[] = [];
  for (const m of existing) {
    if (!isTempId(m.id)) {
      last = time(m.created_at);
      continue;
    }
    if (last !== null) above.set(m.id, last);
    temps.push(m);
  }
  for (const row of page) {
    if (held.has(row.id)) continue;
    const t = time(row.created_at);
    const temp = tempFor(
      temps.filter(
        (m) => m.sent_row_id === row.id || (above.get(m.id) ?? Infinity) < t
      ),
      row,
      viewerId
    );
    if (temp) temps = temps.filter((m) => m !== temp);
  }
  const newest = time(page[page.length - 1]?.created_at);
  return temps.filter((m) => {
    const rowId = m.sent_row_id;
    if (rowId && (held.has(rowId) || inPage.has(rowId))) return false;
    if (m.status === 'sending') return true;
    return m.status === 'sent' && !!rowId && time(m.created_at) > newest;
  });
}

/**
 * A page that replaces the thread (a first load, a manual refresh, a
 * gap), with what this user is still sending kept below it.
 */
export function pageWithUnsettled(
  existing: readonly Message[],
  page: Message[],
  viewerId: string | null | undefined
): Message[] {
  const kept = unsettledTemps(existing, page, viewerId);
  return kept.length === 0 ? page : [...page, ...kept];
}
