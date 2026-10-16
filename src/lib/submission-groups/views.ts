/**
 * Pure view helpers for the internal Submission Groups read routes
 * (`GET /api/submission-groups` and `GET /api/submission-groups/[id]`):
 * list-query parsing, the search filter, and the row → response mapping.
 * No I/O; who may see what is decided in SQL (RLS for ACTIVE groups,
 * `sg_can_read` for ENDED ones) before anything reaches these functions.
 */
import { hasMinRole, type AccountRole } from '@/lib/auth/roles';

import { SgHttpError } from './http';
import type { StaffLabel } from './rules';
import type { GroupMessage, SubmissionGroup } from './store';

export const LIST_LIMIT_DEFAULT = 25;
export const LIST_LIMIT_MAX = 50;
export const SEARCH_MAX = 64;
/** The detail route answers at most this many of the latest live messages. */
export const DETAIL_MESSAGE_LIMIT = 200;

export type ListStatus = 'ACTIVE' | 'ENDED';

export interface ListCursor {
  /**
   * The last row's sort column exactly as PostgREST returned it
   * (`2026-10-16T10:00:00.123456+00:00`). Never re-formatted: the column
   * carries microseconds, and a millisecond `toISOString()` copy neither
   * equals a tied row nor excludes rows between the two instants.
   */
  at: string;
  id: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A timestamptz as PostgREST writes it: ISO date-time, 0–6 fractional
 * digits, `Z` or a `±HH:MM` offset. Nothing else passes, so no comma,
 * parenthesis or space can reach the raw `or()` interpolation.
 */
const TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/** The opaque `next_cursor`: base64url of `<timestamp>|<id>`. */
export function encodeCursor(c: ListCursor): string {
  return Buffer.from(`${c.at}|${c.id}`, 'utf8').toString('base64url');
}

/** Parses an opaque cursor; anything malformed is a 400. */
export function decodeCursor(raw: string): ListCursor {
  const bad = () => new SgHttpError(400, 'cursor is not valid');
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw bad();
  const [at, id, ...extra] = Buffer.from(raw, 'base64url')
    .toString('utf8')
    .split('|');
  if (extra.length || !at || !id || !UUID_RE.test(id)) throw bad();
  if (!TIMESTAMP_RE.test(at) || Number.isNaN(Date.parse(at))) throw bad();
  return { at, id: id.toLowerCase() };
}

/**
 * The keyset `or()` filter for the page after a cursor, matching the
 * (column desc, id desc) order: strictly older, or the same instant with a
 * smaller id. The timestamp passed `TIMESTAMP_RE` (digits, `-`, `:`, `.`,
 * `T`, `Z`, `+`) and the id is a validated UUID, so neither needs quoting.
 */
export function cursorFilter(column: string, c: ListCursor): string {
  return `${column}.lt.${c.at},and(${column}.eq.${c.at},id.lt.${c.id})`;
}

export interface ListQuery {
  status: ListStatus;
  /** The sanitised search term, or null for no search. */
  search: string | null;
  /** Rows strictly after this (sort time, id) in (column desc, id desc) order. */
  cursor: ListCursor | null;
  limit: number;
}

/** The column a status's list is sorted (and paged) by, newest first. */
export function sortColumn(
  status: ListStatus
): 'last_activity_at' | 'ended_at' {
  return status === 'ACTIVE' ? 'last_activity_at' : 'ended_at';
}

/**
 * `?q=` reduced to a term that is safe inside a PostgREST `or()` filter
 * and an `ilike` pattern: anything but letters, digits, spaces and `-`
 * becomes `_` (a one-character wildcard, so "SUB/12" still matches), runs
 * of whitespace collapse. A term with no letter or digit is no search.
 */
export function searchTerm(q: string | null): string | null {
  const term = (q ?? '')
    .trim()
    .slice(0, SEARCH_MAX)
    .replace(/[^\p{L}\p{N}\s-]/gu, '_')
    .replace(/\s+/g, ' ');
  return /[\p{L}\p{N}]/u.test(term) ? term : null;
}

/** `?status=active|ended&q=&cursor=&limit=`; a bad status or cursor is a 400. */
export function parseListQuery(params: URLSearchParams): ListQuery {
  const rawStatus = (params.get('status') ?? '').trim().toLowerCase();
  let status: ListStatus;
  if (rawStatus === '' || rawStatus === 'active') status = 'ACTIVE';
  else if (rawStatus === 'ended') status = 'ENDED';
  else throw new SgHttpError(400, 'status must be active or ended');

  const rawCursor = (params.get('cursor') ?? '').trim();
  const cursor = rawCursor ? decodeCursor(rawCursor) : null;

  const n = Number.parseInt(params.get('limit') ?? '', 10);
  const limit = Number.isFinite(n)
    ? Math.min(Math.max(n, 1), LIST_LIMIT_MAX)
    : LIST_LIMIT_DEFAULT;

  return { status, search: searchTerm(params.get('q')), cursor, limit };
}

/**
 * The PostgREST `or()` filter for a search: the submission ref contains the
 * term, or the group's contact is one whose name matched it.
 */
export function searchFilter(term: string, contactIds: readonly string[]) {
  const parts = [`submission_ref.ilike.*${term}*`];
  if (contactIds.length) parts.push(`contact_id.in.(${contactIds.join(',')})`);
  return parts.join(',');
}

/**
 * The next page's cursor when the page was full: the last scanned row's
 * raw sort-column string (not its parsed `Date`, which drops the
 * microseconds) and id.
 */
export function nextCursor(
  scanned: readonly Record<string, unknown>[],
  limit: number,
  status: ListStatus
): string | null {
  if (scanned.length < limit) return null;
  const last = scanned[scanned.length - 1];
  const at = last[sortColumn(status)];
  return typeof at === 'string' && at
    ? encodeCursor({ at, id: String(last.id) })
    : null;
}

/** Owner / admin manage every group's access list and see every group. */
export function canManageSubmissionGroups(role: AccountRole): boolean {
  return hasMinRole(role, 'admin');
}

export interface AccessRow {
  group_id?: unknown;
  user_id?: unknown;
  label?: unknown;
  added_at?: unknown;
  removed_at?: unknown;
}

/**
 * The caller's label on a group from their access rows: the open row on an
 * ACTIVE group, the row closed at the end on an ENDED one.
 */
export function myLabelOf(
  group: Pick<SubmissionGroup, 'id' | 'status' | 'endedAt'>,
  rows: readonly AccessRow[]
): StaffLabel | null {
  const endedAt = group.endedAt?.getTime() ?? null;
  const hit = rows.find((r) => {
    if (String(r.group_id) !== group.id) return false;
    const removed = r.removed_at === null || r.removed_at === undefined;
    if (group.status === 'ACTIVE') return removed;
    return (
      !removed &&
      endedAt !== null &&
      new Date(String(r.removed_at)).getTime() === endedAt
    );
  });
  return hit ? (hit.label as StaffLabel) : null;
}

export interface ContactRef {
  id: string;
  name: string | null;
  phone: string | null;
}
export interface ChannelRef {
  id: string;
  label: string;
}

const text = (v: unknown): string | null => {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s || null;
};

export function toContactRef(r: Record<string, unknown>): ContactRef {
  return { id: String(r.id), name: text(r.name), phone: text(r.phone) };
}

/** A number's display: its admin label, else the phone a Whapi row keeps in `waba_id`. */
export function toChannelRef(r: Record<string, unknown>): ChannelRef {
  return {
    id: String(r.id),
    label: text(r.label) ?? text(r.waba_id) ?? 'Number',
  };
}

export interface ItemRefs {
  contacts: ReadonlyMap<string, ContactRef>;
  channels: ReadonlyMap<string, ChannelRef>;
  myLabel: StaffLabel | null;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** A list row. A deleted contact or number is null, as is one not loaded. */
export function toListItem(group: SubmissionGroup, refs: ItemRefs) {
  return {
    id: group.id,
    submission_ref: group.submissionRef,
    subject: group.subject,
    status: group.status,
    contact: group.contactId
      ? (refs.contacts.get(group.contactId) ?? null)
      : null,
    channel: group.channelId
      ? (refs.channels.get(group.channelId) ?? null)
      : null,
    my_label: refs.myLabel,
    last_activity_at: group.lastActivityAt.toISOString(),
    created_at: group.createdAt.toISOString(),
    ended_at: iso(group.endedAt),
    end_reason: group.endReason,
    pending: group.status === 'ACTIVE' && group.waGroupId === null,
    archive: group.status === 'ENDED',
  };
}

export type ListItem = ReturnType<typeof toListItem>;

/** The detail route's group: a list row plus the WhatsApp side. */
export function toDetailGroup(group: SubmissionGroup, refs: ItemRefs) {
  return {
    ...toListItem(group, refs),
    submission_status: group.submissionStatus,
    coordinator_phone: group.coordinatorPhone,
    invite_link: group.inviteLink,
    wa_group_id: group.waGroupId,
    wa_create_error: group.waCreateError,
    wa_close_error: group.waCloseError,
    wa_closed_at: iso(group.waClosedAt),
    invite_sent_at: iso(group.inviteSentAt),
    invite_send_error: group.inviteSendError,
  };
}

export function toAccessView(
  entry: { userId: string; label: StaffLabel; addedAt: Date },
  names: ReadonlyMap<string, string | null>
) {
  return {
    user_id: entry.userId,
    name: names.get(entry.userId) ?? null,
    label: entry.label,
    added_at: entry.addedAt.toISOString(),
  };
}

/** A message; the staff sender's name on 'out' rows, `sender_kind` alone on 'in' rows. */
export function toMessageView(
  m: GroupMessage,
  names: ReadonlyMap<string, string | null>
) {
  return {
    id: m.id,
    direction: m.direction,
    sender_user_id: m.senderUserId,
    sender_name:
      m.direction === 'out' && m.senderUserId
        ? (names.get(m.senderUserId) ?? null)
        : null,
    sender_wa_id: m.senderWaId,
    sender_kind: m.senderKind,
    body: m.body,
    prefixed_body: m.prefixedBody,
    send_status: m.sendStatus,
    post_end: m.postEnd,
    type: m.type,
    media: m.media,
    created_at: m.createdAt.toISOString(),
  };
}
