/**
 * Pure view helpers for the internal Submission Groups read routes
 * (`GET /api/submission-groups` and `GET /api/submission-groups/[id]`):
 * list-query parsing, the search filter, and the row → response mapping.
 * No I/O; who may see what is decided in SQL (RLS for ACTIVE groups,
 * `sg_can_read` for ENDED ones) before anything reaches these functions.
 */
import {
  canReceiveCoordinatorShare,
  hasMinRole,
  type AccountRole,
} from '@/lib/auth/roles';

import { SgHttpError } from './http';
import type { StaffLabel } from './rules';
import type { GroupMessage, SubmissionGroup } from './store';

export const LIST_LIMIT_DEFAULT = 25;
export const LIST_LIMIT_MAX = 50;
export const SEARCH_MAX = 64;
/** The detail route answers at most this many live messages a page, the latest first. */
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

/** A message id: a bigint identity, well inside its range. */
const MESSAGE_ID_RE = /^\d{1,18}$/;

/** Parses an opaque cursor; anything malformed is a 400. */
export function decodeCursor(raw: string): ListCursor {
  return decode(raw, 'cursor', UUID_RE);
}

/** The chat's `?before=`: the same cursor, at a message. */
export function decodeMessageCursor(raw: string): ListCursor {
  return decode(raw, 'before', MESSAGE_ID_RE);
}

function decode(raw: string, param: string, idRe: RegExp): ListCursor {
  const bad = () => new SgHttpError(400, `${param} is not valid`);
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw bad();
  const [at, id, ...extra] = Buffer.from(raw, 'base64url')
    .toString('utf8')
    .split('|');
  if (extra.length || !at || !id || !idRe.test(id)) throw bad();
  if (!TIMESTAMP_RE.test(at) || Number.isNaN(Date.parse(at))) throw bad();
  return { at, id: id.toLowerCase() };
}

/**
 * The keyset `or()` filter for the page after a cursor, matching the
 * (column desc, id desc) order: strictly older, or the same instant with a
 * smaller id. The timestamp passed `TIMESTAMP_RE` (digits, `-`, `:`, `.`,
 * `T`, `Z`, `+`) and the id is a validated UUID or digits, so neither needs
 * quoting.
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
  /** Only groups whose case is at this bank (a `case_banks` code), or null. */
  bank: string | null;
}

/** 122's case_banks_code_check: a `?bank=` that is not a code is a 400. */
const BANK_CODE_RE = /^[A-Z0-9_]{2,32}$/;

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

  const bank = (params.get('bank') ?? '').trim().toUpperCase();
  if (bank && !BANK_CODE_RE.test(bank))
    throw new SgHttpError(400, 'bank is not valid');

  return {
    status,
    search: searchTerm(params.get('q')),
    cursor,
    limit,
    bank: bank || null,
  };
}

/**
 * A bank-filtered ACTIVE list reads candidates on the service role in
 * batches of this many and asks the caller's RLS client which of them it
 * sees, so no request carries more ids than this. (The gateway refused
 * `id=in.(…)` at 900 UUIDs and PostgREST answers at most 1,000 rows, so a
 * whole bank's id list would not fit.)
 */
export const BANK_SCAN_BATCH = 100;
/** Batches one page reads at most before answering with what it found. */
export const BANK_SCAN_ROUNDS = 5;
/**
 * While nothing visible has turned up, a page keeps reading up to this many
 * batches, so a caller who sees only a few old groups of a busy bank is not
 * answered an empty page. All local queries: about 100 in the worst case.
 */
export const BANK_SCAN_ROUNDS_EMPTY = 50;

type Row = Record<string, unknown>;

/** The keyset cursor at a row: its raw sort-column string and id. */
function cursorAt(row: Row, column: string): ListCursor | null {
  const at = row[column];
  return typeof at === 'string' && at ? { at, id: String(row.id) } : null;
}

/**
 * One page of a list scanned on the service role and kept to what the
 * caller may see: `scan(after)` answers up to `batch` candidates after a
 * cursor in (column desc, id desc) order, `visible(ids)` the ones RLS hands
 * the caller. Rows are kept in scan order until `limit` are found, the scan
 * runs out, or `rounds` batches were read (`emptyRounds` while none was
 * kept). `next` is where the next page starts: after the last kept row
 * when the page filled, after the last scanned row when the rounds ran out
 * first, null when nothing is left.
 *
 * That last case hands the caller the position (sort time and id) of a
 * group they may not see, so the next page can move past it; without it a
 * page that read only hidden groups would start again from the same place.
 * A position opens nothing: every read is still RLS'd.
 */
export async function scanVisiblePage(opts: {
  column: string;
  cursor: ListCursor | null;
  limit: number;
  scan: (after: ListCursor | null) => Promise<Row[]>;
  visible: (ids: string[]) => Promise<ReadonlySet<string>>;
  batch?: number;
  rounds?: number;
  emptyRounds?: number;
}): Promise<{ rows: Row[]; next: ListCursor | null }> {
  const batch = opts.batch ?? BANK_SCAN_BATCH;
  const rounds = opts.rounds ?? BANK_SCAN_ROUNDS;
  const emptyRounds = opts.emptyRounds ?? BANK_SCAN_ROUNDS_EMPTY;
  const rows: Row[] = [];
  let after = opts.cursor;
  for (
    let round = 0;
    round < (rows.length ? rounds : Math.max(rounds, emptyRounds));
    round++
  ) {
    const scanned = await opts.scan(after);
    if (!scanned.length) return { rows, next: null };
    const seen = await opts.visible(scanned.map((r) => String(r.id)));
    const last = scanned.length < batch;
    for (let i = 0; i < scanned.length; i++) {
      if (!seen.has(String(scanned[i].id))) continue;
      rows.push(scanned[i]);
      if (rows.length === opts.limit)
        return {
          rows,
          next:
            last && i === scanned.length - 1
              ? null
              : cursorAt(scanned[i], opts.column),
        };
    }
    if (last) return { rows, next: null };
    after = cursorAt(scanned[scanned.length - 1], opts.column);
    if (!after) return { rows, next: null };
  }
  return { rows, next: after };
}

/**
 * The PostgREST `or()` filter for a search: the submission ref or the
 * tracker's customer name (141) contains the term, or the group's contact
 * is one whose name matched it. The term is `searchTerm`'s output, so it
 * carries no `,`, `.`, `(`, `%` or `*`.
 */
export function searchFilter(term: string, contactIds: readonly string[]) {
  const parts = [
    `submission_ref.ilike.*${term}*`,
    `customer_name.ilike.*${term}*`,
  ];
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

/**
 * 163: an ACTIVE group the caller has no open access row on still reads and
 * sends as 'coordinator' when the group's case is of a bank they hold
 * (`coordinator_banks`) and they are an agent or team leader. Admins and
 * owners never need the fallback. An ENDED group is unchanged.
 */
export function bankHolderLabel(
  group: Pick<SubmissionGroup, 'id' | 'status'>,
  role: AccountRole,
  heldBanks: ReadonlySet<string>,
  bankByGroup: ReadonlyMap<string, string>
): StaffLabel | null {
  if (group.status !== 'ACTIVE' || !canReceiveCoordinatorShare(role))
    return null;
  const bank = bankByGroup.get(group.id);
  return bank !== undefined && heldBanks.has(bank) ? 'coordinator' : null;
}

/**
 * The label of an ACTIVE group the caller has no open access row on, in
 * sg_resolve_role's order: 'team_lead' for a leader of the case's agent
 * (173), else the bank fallback. The role gate is the one bankHolderLabel
 * has, which keeps an admin who leads a team unlabelled, as in SQL.
 */
export function impliedLabel(
  group: Pick<SubmissionGroup, 'id' | 'status'>,
  role: AccountRole,
  ledGroups: ReadonlySet<string>,
  heldBanks: ReadonlySet<string>,
  bankByGroup: ReadonlyMap<string, string>
): StaffLabel | null {
  if (
    group.status === 'ACTIVE' &&
    canReceiveCoordinatorShare(role) &&
    ledGroups.has(group.id)
  )
    return 'team_lead';
  return bankHolderLabel(group, role, heldBanks, bankByGroup);
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
/** The bank of a group's case: its code and the workspace's name for it. */
export interface BankRef {
  code: string;
  name: string;
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
  /** 173: the caller's unread messages in this group; list rows only. */
  unread?: number;
  /** Each group's case bank by group id; a group not in it shows none. */
  banks?: ReadonlyMap<string, BankRef>;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/**
 * Waiting for its WhatsApp group. A 'none' row (migration 136) is recorded
 * without one by design and never becomes pending.
 */
export function isPendingCreate(group: SubmissionGroup): boolean {
  return (
    group.waMode !== 'none' &&
    group.status === 'ACTIVE' &&
    group.waGroupId === null
  );
}

/** A list row. A deleted contact or number is null, as is one not loaded. */
export function toListItem(group: SubmissionGroup, refs: ItemRefs) {
  return {
    id: group.id,
    submission_ref: group.submissionRef,
    subject: group.subject,
    /** 141: the company the tracker sent; the screens title a group with it. */
    customer_name: group.customerName ?? null,
    /** The tracker's own status word, untranslated. */
    submission_status: group.submissionStatus,
    /** The case's bank; null with no case yet or a case with no bank. */
    bank: refs.banks?.get(group.id) ?? null,
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
    wa_mode: group.waMode,
    customer_membership: group.customerMembership ?? 'unknown',
    pending: isPendingCreate(group),
    archive: group.status === 'ENDED',
    unread: refs.unread ?? 0,
  };
}

export type ListItem = ReturnType<typeof toListItem>;

/** The detail route's group: a list row plus the WhatsApp side. */
export function toDetailGroup(group: SubmissionGroup, refs: ItemRefs) {
  return {
    ...toListItem(group, refs),
    coordinator_phone: group.coordinatorPhone,
    // 142: every coordinator number in the group, the request's first, each once.
    coordinator_phones: [
      ...new Set(
        [group.coordinatorPhone, ...(group.coordinatorPhones ?? [])].filter(
          (p): p is string => !!p
        )
      ),
    ],
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

/**
 * One page of a live chat out of rows read newest first, one more than the
 * page: oldest first, whether older ones remain, and where those start.
 */
export function messagePage(
  rows: readonly Row[],
  limit = DETAIL_MESSAGE_LIMIT
): { rows: Row[]; hasMore: boolean; olderCursor: string | null } {
  const page = rows.slice(0, limit).reverse();
  const at = rows.length > limit ? cursorAt(page[0], 'created_at') : null;
  return {
    rows: page,
    hasMore: at !== null,
    olderCursor: at && encodeCursor(at),
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
    system_kind: m.systemKind ?? null,
    post_end: m.postEnd,
    type: m.type,
    media: m.media,
    created_at: m.createdAt.toISOString(),
  };
}
