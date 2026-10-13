/**
 * Deal rooms — what the room screens read (module 014c, migration 088):
 * the room list, one room with its people, and a page of the group's
 * messages. Every read runs as the caller, so RLS decides what comes
 * back: a bank guest reaches people only through `deal_room_roster`
 * (name, role, status), never `deal_room_participants`, and staff get
 * phone numbers and WhatsApp ids only masked (`maskPhone`). Columns are
 * always named: the column grants refuse `select=*`.
 *
 * The service-role reads are the names of the CRM users who posted the
 * messages on a page the caller was already allowed to read, and the
 * room's workspace name for their "Sara · <workspace>" label.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { callingCodeOf } from '@/lib/contacts/phone-validation';

import { isWindowOpen } from './operations';

export type RoomAccess = 'supervisor' | 'staff' | 'guest';

/**
 * The suffix on a staff member's group message ("Sara · Acme Brokers") is
 * the workspace's own name (`accounts.name`), so a fork shows its own
 * business. This neutral word stands in when the name is missing or blank.
 */
export const STAFF_LABEL_FALLBACK = 'Team';

export function staffLabel(accountName: string | null | undefined): string {
  return accountName?.trim() || STAFF_LABEL_FALLBACK;
}

/**
 * A phone number or WhatsApp id with everything but its calling code
 * and last two digits hidden: 971501234512 → "+971 XXXXXXX12".
 */
export function maskPhone(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/\D/g, '');
  if (!digits) return null;
  const code = callingCodeOf(digits);
  const rest = code ? digits.slice(code.length) : digits;
  const shown = rest.slice(-2);
  const hidden = 'X'.repeat(rest.length - shown.length);
  return code ? `+${code} ${hidden}${shown}` : `+${hidden}${shown}`;
}

async function rows<T>(
  query: PromiseLike<{ data: unknown; error: { message: string } | null }>,
  what: string
): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw new Error(`${what} lookup failed: ${error.message}`);
  return (data ?? []) as T[];
}

/** `accounts.name` of the room's workspace, or null when there is none. */
async function workspaceName(
  admin: SupabaseClient,
  accountId: string
): Promise<string | null> {
  const [row] = await rows<{ name: string | null }>(
    admin.from('accounts').select('name').eq('id', accountId).limit(1),
    'account'
  );
  return row?.name ?? null;
}

// The deal and the contact come through their composite FKs, so RLS on
// deals / contacts applies: one the caller cannot see embeds as null.
const EMBEDS =
  'deal:deals!deal_rooms_deal_fkey(title), contact:contacts!deal_rooms_contact_fkey(name)';

interface Embeds {
  deal: { title: string | null } | null;
  contact: { name: string | null } | null;
}

// ============================================================
// The room list
// ============================================================

export const ROOM_LIST_MAX = 500;

export interface RoomSummary {
  id: string;
  channelId: string;
  subject: string;
  status: string;
  participantCount: number;
  windowUntil: string | null;
  dealTitle: string | null;
  contactName: string | null;
  createdAt: string;
}

interface SummaryRow extends Embeds {
  id: string;
  channel_id: string;
  subject: string;
  status: string;
  participant_count: number;
  window_until: string | null;
  created_at: string;
}

/**
 * The newest `ROOM_LIST_MAX` rooms the caller can see, newest first:
 * staff's from `deal_rooms` (RLS), a bank guest's from
 * `deal_room_guest_rooms` (no deal or contact). Each source is empty for
 * the other kind of caller.
 */
export async function listRooms(db: SupabaseClient): Promise<RoomSummary[]> {
  const [staff, guest] = await Promise.all([
    rows<SummaryRow>(
      db
        .from('deal_rooms')
        .select(
          `id, channel_id, subject, status, participant_count, window_until, created_at, ${EMBEDS}`
        )
        .order('created_at', { ascending: false })
        .limit(ROOM_LIST_MAX),
      'room'
    ),
    rows<SummaryRow>(
      db
        .from('deal_room_guest_rooms')
        .select(
          'id, channel_id, subject, status, participant_count, window_until, created_at'
        )
        .order('created_at', { ascending: false })
        .limit(ROOM_LIST_MAX),
      'guest room'
    ),
  ]);
  const list = [...staff, ...guest]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, ROOM_LIST_MAX);
  return list.map((r) => ({
    id: r.id,
    channelId: r.channel_id,
    subject: r.subject,
    status: r.status,
    participantCount: r.participant_count,
    windowUntil: r.window_until,
    dealTitle: r.deal?.title ?? null,
    contactName: r.contact?.name ?? null,
    createdAt: r.created_at,
  }));
}

// ============================================================
// One room
// ============================================================

export interface RosterEntry {
  id: string;
  displayName: string;
  role: string | null;
  status: string;
  joinedAt: string | null;
  leftAt: string | null;
}

/** What staff see of a person: the roster plus these, phone masked. */
export interface StaffParticipant extends RosterEntry {
  bankCode: string | null;
  expected: boolean;
  /** A consent is on record for this person. */
  consent: boolean;
  phone: string | null;
  invitedAt: string | null;
}

export interface PendingJoinRequest {
  id: string;
  /** Meta's id: what `POST …/join-requests` takes. */
  joinRequestId: string;
  waId: string | null;
  receivedAt: string;
}

export interface RoomDetail {
  room: {
    id: string;
    channelId: string;
    /** Null for a guest, who never sees the contact, deal or last error. */
    contactId: string | null;
    dealId: string | null;
    subject: string;
    description: string | null;
    joinApprovalMode: string;
    status: string;
    participantCount: number;
    windowUntil: string | null;
    createdAt: string;
    openedAt: string | null;
    closedAt: string | null;
    closeReason: string | null;
    lastError: string | null;
    /** A manager cancelled it while it was being created (096); null for a guest. */
    cancelledAt: string | null;
    dealTitle: string | null;
    contactName: string | null;
    /** The CRM user who opened the room (an auth user id). */
    createdBy: string | null;
  };
  access: RoomAccess;
  canManage: boolean;
  windowOpen: boolean;
  /** Staff: StaffParticipant; a guest: the roster only. */
  participants: (StaffParticipant | RosterEntry)[];
  /** Managers only. */
  joinRequests?: PendingJoinRequest[];
  /** Managers only: people a team leader still has to approve. */
  pendingApprovals?: StaffParticipant[];
}

interface DetailRow extends Partial<Embeds> {
  id: string;
  channel_id: string;
  contact_id: string | null;
  deal_id: string | null;
  subject: string;
  description: string | null;
  join_approval_mode: string;
  status: string;
  participant_count: number;
  window_until: string | null;
  created_at: string;
  opened_at: string | null;
  closed_at: string | null;
  close_reason: string | null;
  last_error: string | null;
  cancelled_at: string | null;
  created_by: string | null;
}

interface RosterRow {
  id: string;
  display_name: string;
  role: string | null;
  status: string;
  joined_at: string | null;
  left_at: string | null;
}

interface ParticipantRow extends RosterRow {
  bank_code: string | null;
  expected: boolean;
  consent_id: string | null;
  phone: string | null;
  invited_at: string | null;
}

const rosterEntry = (p: RosterRow): RosterEntry => ({
  id: p.id,
  displayName: p.display_name,
  role: p.role,
  status: p.status,
  joinedAt: p.joined_at,
  leftAt: p.left_at,
});

/**
 * The room as the caller may see it, or null when they cannot see it at
 * all (`deal_room_access` is NULL). Runs as the caller.
 */
export async function loadRoomDetail(
  db: SupabaseClient,
  roomId: string
): Promise<RoomDetail | null> {
  const { data: accessData, error: accessErr } = await db.rpc(
    'deal_room_access',
    { p_room: roomId }
  );
  if (accessErr) throw new Error(`access check failed: ${accessErr.message}`);
  const access = accessData as RoomAccess | null;
  if (access !== 'supervisor' && access !== 'staff' && access !== 'guest') {
    return null;
  }
  // A guest reads the room from deal_room_guest_rooms: deal_rooms is
  // staff-only, and its contact, deal and last error are not theirs.
  const shared =
    'id, channel_id, subject, description, join_approval_mode, status, ' +
    'participant_count, window_until, created_at, opened_at, closed_at, close_reason';
  const { data, error } = await (
    access === 'guest'
      ? db.from('deal_room_guest_rooms').select(shared)
      : db
          .from('deal_rooms')
          .select(
            `${shared}, contact_id, deal_id, last_error, cancelled_at, created_by, ${EMBEDS}`
          )
  )
    .eq('id', roomId)
    .maybeSingle();
  if (error) throw new Error(`room lookup failed: ${error.message}`);
  const g = data as Partial<DetailRow> | null;
  const r: DetailRow | null = g
    ? ({
        contact_id: null,
        deal_id: null,
        last_error: null,
        cancelled_at: null,
        created_by: null,
        ...g,
      } as DetailRow)
    : null;
  if (!r) return null;

  const detail: RoomDetail = {
    room: {
      id: r.id,
      channelId: r.channel_id,
      contactId: r.contact_id,
      dealId: r.deal_id,
      subject: r.subject,
      description: r.description,
      joinApprovalMode: r.join_approval_mode,
      status: r.status,
      participantCount: r.participant_count,
      windowUntil: r.window_until,
      createdAt: r.created_at,
      openedAt: r.opened_at,
      closedAt: r.closed_at,
      closeReason: r.close_reason,
      lastError: r.last_error,
      cancelledAt: r.cancelled_at,
      dealTitle: r.deal?.title ?? null,
      contactName: r.contact?.name ?? null,
      createdBy: r.created_by,
    },
    access,
    canManage: false,
    windowOpen: isWindowOpen(r.window_until),
    participants: [],
  };

  if (access === 'guest') {
    const roster = await rows<RosterRow>(
      db
        .from('deal_room_roster')
        .select('id, display_name, role, status, joined_at, left_at')
        .eq('room_id', roomId),
      'roster'
    );
    detail.participants = roster.map(rosterEntry);
    return detail;
  }

  const people = (
    await rows<ParticipantRow>(
      db
        .from('deal_room_participants')
        .select(
          'id, display_name, role, status, joined_at, left_at, bank_code, expected, consent_id, phone, invited_at'
        )
        .eq('room_id', roomId)
        .order('created_at', { ascending: true }),
      'participant'
    )
  ).map((p): StaffParticipant => ({
    ...rosterEntry(p),
    bankCode: p.bank_code,
    expected: p.expected,
    consent: p.consent_id !== null,
    phone: maskPhone(p.phone),
    invitedAt: p.invited_at,
  }));
  detail.participants = people;

  const { data: canManage, error: manageErr } = await db.rpc(
    'deal_room_can_manage',
    { p_room: roomId }
  );
  if (manageErr) {
    console.error('[deal-rooms] can_manage failed:', manageErr.message);
  }
  if (canManage !== true) return detail;

  const requests = await rows<{
    id: string;
    join_request_id: string;
    wa_id: string;
    received_at: string;
  }>(
    db
      .from('deal_room_join_requests')
      .select('id, join_request_id, wa_id, received_at')
      .eq('room_id', roomId)
      .eq('decision', 'pending')
      .order('received_at', { ascending: true }),
    'join request'
  );
  detail.canManage = true;
  detail.joinRequests = requests.map((q) => ({
    id: q.id,
    joinRequestId: q.join_request_id,
    waId: maskPhone(q.wa_id),
    receivedAt: q.received_at,
  }));
  detail.pendingApprovals = people.filter(
    (p) => p.status === 'pending_approval'
  );
  return detail;
}

// ============================================================
// A page of the group's messages
// ============================================================

export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 100;

/**
 * `?before=<created_at>&limit=`: `before` is passed through as given (a
 * `nextBefore` keeps Postgres's microseconds), once it parses as a time.
 */
export function parsePageQuery(
  params: URLSearchParams
):
  | { ok: true; before: string | null; limit: number }
  | { ok: false; error: string } {
  const before = params.get('before')?.trim() || null;
  if (before !== null && !Number.isFinite(Date.parse(before))) {
    return { ok: false, error: 'before must be a timestamp' };
  }
  const rawLimit = params.get('limit')?.trim();
  const limit = rawLimit ? Number(rawLimit) : PAGE_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) {
    return { ok: false, error: `limit must be 1 to ${PAGE_MAX}` };
  }
  return { ok: true, before, limit };
}

export interface RoomMessage {
  id: string;
  direction: 'in' | 'out';
  type: string;
  body: string | null;
  templateName: string | null;
  fileName: string | null;
  /** Ours only: pending → sent → delivered → read, or failed. */
  status: string | null;
  createdAt: string;
  senderName: string;
  /** A roster role, `staff` (a CRM user), or `bank_guest` (a guest user). */
  senderRole: string | null;
  /** People it reached (a read counts as delivered), from the receipts. */
  deliveredCount: number;
  readCount: number;
}

export interface MessagePage {
  /** Oldest first. */
  messages: RoomMessage[];
  hasMore: boolean;
  /** Pass as `before` for the page of older messages. */
  nextBefore: string | null;
}

interface MessageRow {
  id: string;
  direction: 'in' | 'out';
  sender_participant_id: string | null;
  staff_user_id: string | null;
  type: string;
  body: string | null;
  media: Record<string, unknown> | null;
  template_name: string | null;
  status: string | null;
  created_at: string;
}

interface Poster {
  user_id: string;
  full_name: string | null;
  account_role: string | null;
  bank_code: string | null;
}

/**
 * A page of the room's messages, or null when RLS does not show the
 * caller the room. `db` is the caller's client; `admin` (service role)
 * only resolves the names of the CRM users who posted on this page.
 */
export async function listRoomMessages(
  db: SupabaseClient,
  admin: SupabaseClient,
  args: { roomId: string; before: string | null; limit: number }
): Promise<MessagePage | null> {
  // Staff find the room in deal_rooms, a bank guest in deal_room_guest_rooms.
  let { data: room, error: roomErr } = await db
    .from('deal_rooms')
    .select('id, account_id')
    .eq('id', args.roomId)
    .maybeSingle();
  if (!room && !roomErr) {
    ({ data: room, error: roomErr } = await db
      .from('deal_room_guest_rooms')
      .select('id, account_id')
      .eq('id', args.roomId)
      .maybeSingle());
  }
  if (roomErr) throw new Error(`room lookup failed: ${roomErr.message}`);
  if (!room) return null;
  const accountId = (room as { account_id: string }).account_id;

  let query = db
    .from('group_messages')
    .select(
      'id, direction, sender_participant_id, staff_user_id, type, body, media, template_name, status, created_at'
    )
    .eq('room_id', args.roomId);
  if (args.before) query = query.lt('created_at', args.before);
  const newest = await rows<MessageRow>(
    query.order('created_at', { ascending: false }).limit(args.limit + 1),
    'message'
  );
  const hasMore = newest.length > args.limit;
  const page = newest.slice(0, args.limit).reverse();

  const roster = new Map(
    (
      await rows<{ id: string; display_name: string; role: string | null }>(
        db
          .from('deal_room_roster')
          .select('id, display_name, role')
          .eq('room_id', args.roomId),
        'roster'
      )
    ).map((p) => [p.id, p])
  );

  const posterIds = [
    ...new Set(
      page
        .filter((m) => m.direction === 'out' && m.staff_user_id)
        .map((m) => m.staff_user_id as string)
    ),
  ];
  // The workspace's name labels our side of the page; an inbound-only
  // page has no use for it.
  const [posterRows, accountName] = await Promise.all([
    posterIds.length
      ? rows<Poster>(
          admin
            .from('profiles')
            .select('user_id, full_name, account_role, bank_code')
            .eq('account_id', accountId)
            .in('user_id', posterIds),
          'profile'
        )
      : Promise.resolve([] as Poster[]),
    page.some((m) => m.direction === 'out')
      ? workspaceName(admin, accountId)
      : Promise.resolve(null),
  ]);
  const posters = new Map(posterRows.map((p) => [p.user_id, p]));
  const label = staffLabel(accountName);

  const outIds = page.filter((m) => m.direction === 'out').map((m) => m.id);
  const receipts = outIds.length
    ? await rows<{
        message_id: string;
        participant_id: string | null;
        status: string;
      }>(
        db
          .from('group_message_receipts')
          .select('message_id, participant_id, status')
          .in('message_id', outIds),
        'receipt'
      )
    : [];
  const reached = new Map<
    string,
    { delivered: Set<string>; read: Set<string> }
  >();
  receipts.forEach((r, i) => {
    if (r.status !== 'delivered' && r.status !== 'read') return;
    const counts = reached.get(r.message_id) ?? {
      delivered: new Set<string>(),
      read: new Set<string>(),
    };
    // A receipt nobody could be matched to counts on its own.
    const who = r.participant_id ?? `unmatched:${i}`;
    counts.delivered.add(who);
    if (r.status === 'read') counts.read.add(who);
    reached.set(r.message_id, counts);
  });

  const sender = (m: MessageRow): { name: string; role: string | null } => {
    if (m.direction === 'out' && m.staff_user_id) {
      const p = posters.get(m.staff_user_id);
      const name = p?.full_name?.trim() || 'Staff';
      return p?.account_role === 'bank_guest'
        ? {
            name: p.bank_code ? `${name} · ${p.bank_code}` : name,
            role: 'bank_guest',
          }
        : { name: `${name} · ${label}`, role: 'staff' };
    }
    const p = m.sender_participant_id
      ? roster.get(m.sender_participant_id)
      : undefined;
    if (p) return { name: p.display_name, role: p.role };
    return m.direction === 'out'
      ? { name: label, role: 'business' }
      : { name: 'Unknown', role: null };
  };

  const fileName = (media: MessageRow['media']): string | null => {
    const name = media?.filename ?? media?.name;
    return typeof name === 'string' && name ? name : null;
  };

  return {
    messages: page.map((m) => {
      const who = sender(m);
      const counts = reached.get(m.id);
      return {
        id: m.id,
        direction: m.direction,
        type: m.type,
        body: m.body,
        templateName: m.template_name,
        fileName: fileName(m.media),
        status: m.status,
        createdAt: m.created_at,
        senderName: who.name,
        senderRole: who.role,
        deliveredCount: counts?.delivered.size ?? 0,
        readCount: counts?.read.size ?? 0,
      };
    }),
    hasMore,
    nextBefore: hasMore && page.length ? page[0].created_at : null,
  };
}
