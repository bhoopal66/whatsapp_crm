/**
 * Submission groups screens (module 018a): the pure decisions behind
 * /submission-groups and /submission-groups/[id]. Client-safe: it imports
 * only the pure rules, never the store or the gateway.
 */
import { canSendMessages, isAccountRole } from '@/lib/auth/roles';
import { caseStatusView, contactPersonLine } from '@/lib/cases/ui';

import {
  prefixMessage,
  ROLE_LABELS,
  STAFF_LABELS,
  isStaffLabel,
  type StaffLabel,
} from './rules';

export { STAFF_LABELS, type StaffLabel };

export type SgStatus = 'ACTIVE' | 'ENDED';

/** Migration 136: 'none' is a submission recorded without a WhatsApp group. */
export type SgWaMode = 'group' | 'none';

/** A missing or unknown value is 'group': older payloads predate 136. */
export function waModeOf(v: { wa_mode?: unknown }): SgWaMode {
  return v.wa_mode === 'none' ? 'none' : 'group';
}

/** One row of GET /api/submission-groups. */
export interface SgListItem {
  id: string;
  submission_ref: string;
  subject: string | null;
  /** 141: the company the tracker sent; absent on older payloads. */
  customer_name?: string | null;
  /** The tracker's own status word, untranslated. */
  submission_status?: string | null;
  /** The case's bank; null or absent (older payloads) shows none. */
  bank?: { code: string; name: string } | null;
  status: SgStatus;
  contact: { id: string; name: string | null; phone: string | null } | null;
  channel: { id: string; label: string | null } | null;
  my_label: StaffLabel | null;
  last_activity_at: string | null;
  created_at: string;
  ended_at: string | null;
  end_reason: string | null;
  /** Absent on payloads from before 136; read it through `waModeOf`. */
  wa_mode?: SgWaMode;
  pending: boolean;
  archive: boolean;
  /** 173: the caller's unread messages; absent on older payloads. */
  unread?: number;
  /** 174: absent on older payloads, which read as 'unknown'. */
  customer_membership?: 'unknown' | 'joined' | 'absent';
}

/** 174: the warning chip. Only a known absence on a live WhatsApp group; 'unknown' shows nothing. */
export function customerNotInGroup(
  g: Pick<SgListItem, 'status' | 'wa_mode' | 'customer_membership'>
): boolean {
  return (
    g.customer_membership === 'absent' &&
    g.status === 'ACTIVE' &&
    waModeOf(g) === 'group'
  );
}

export interface SgGroup extends SgListItem {
  coordinator_phone: string | null;
  /** 142: every coordinator number in the group (the request's and the bank's), deduped. */
  coordinator_phones?: string[];
  invite_link: string | null;
  wa_group_id: string | null;
  wa_create_error: string | null;
  wa_close_error: string | null;
  wa_closed_at: string | null;
  invite_sent_at: string | null;
  invite_send_error: string | null;
}

export interface SgAccess {
  user_id: string;
  name: string | null;
  label: StaffLabel;
  added_at: string;
}

export type SgSendStatus = 'pending' | 'sent' | 'blocked' | 'failed';

export interface SgMessage {
  id: string;
  direction: 'in' | 'out';
  sender_user_id: string | null;
  sender_name: string | null;
  sender_wa_id: string | null;
  sender_kind: 'customer' | 'coordinator' | 'other' | null;
  body: string | null;
  prefixed_body: string | null;
  send_status: SgSendStatus | null;
  /** 170: an automatic message (welcome, tracker update); no staff sender. */
  system_kind?: 'welcome' | 'status_update' | null;
  post_end: boolean;
  type: string | null;
  media: unknown;
  created_at: string;
}

/** GET /api/submission-groups/[id]. */
export interface SgDetail {
  group: SgGroup;
  access: SgAccess[];
  /** The newest page, oldest first. */
  messages: SgMessage[];
  has_more: boolean;
  /** Where the page before this one starts, for `?before=`. */
  older_cursor: string | null;
  archive_available: boolean;
  can_send: boolean;
  can_manage: boolean;
  /** The group's case, or null when none was opened yet. */
  caseId: string | null;
}

/** GET /api/submission-groups/[id]?before=<older_cursor>. */
export interface SgOlderPage extends Pick<
  SgDetail,
  'messages' | 'has_more' | 'older_cursor'
> {
  status: SgGroup['status'];
}

export interface SgListPage {
  groups: SgListItem[];
  next_cursor: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

/** The list response, tolerant of a missing or malformed body. */
export function parseSgList(json: unknown): SgListPage {
  if (!isObj(json)) return { groups: [], next_cursor: null };
  const groups = Array.isArray(json.groups)
    ? (
        json.groups.filter(
          (g) => isObj(g) && typeof g.id === 'string'
        ) as SgListItem[]
      ).map((g) => ({ ...g, wa_mode: waModeOf(g) }))
    : [];
  const next =
    typeof json.next_cursor === 'string' && json.next_cursor
      ? json.next_cursor
      : null;
  return { groups, next_cursor: next };
}

/** The list URL for one tab, search, bank filter and page. */
export function listUrl(
  status: 'active' | 'ended',
  q: string,
  cursor: string | null,
  { bank = null, limit = 30 }: { bank?: string | null; limit?: number } = {}
): string {
  const qs = new URLSearchParams({ status, limit: String(limit) });
  const query = q.trim();
  if (query) qs.set('q', query);
  if (cursor) qs.set('cursor', cursor);
  if (bank) qs.set('bank', bank);
  return `/api/submission-groups?${qs}`;
}

/** Appends a next page, keeping one row per id (a row can shift pages). */
export function appendPage(
  current: readonly SgListItem[],
  next: readonly SgListItem[]
): SgListItem[] {
  const seen = new Set(current.map((g) => g.id));
  return [...current, ...next.filter((g) => !seen.has(g.id))];
}

export type BubbleKind = 'staff' | 'customer' | 'coordinator' | 'other';

/** Which bubble a message gets: ours (staff), the customer, the coordinator's own phone, anyone else. */
export function bubbleKind(
  m: Pick<SgMessage, 'direction' | 'sender_kind'>
): BubbleKind {
  if (m.direction === 'out') return 'staff';
  if (m.sender_kind === 'customer') return 'customer';
  if (m.sender_kind === 'coordinator') return 'coordinator';
  return 'other';
}

/**
 * An automatic message (170). The archive read has no `system_kind`, but
 * 170's CHECK makes every other outgoing row name its staff sender, so an
 * outgoing row without one is automatic there too.
 */
export function isAutomatic(
  m: Pick<SgMessage, 'direction' | 'sender_user_id' | 'system_kind'>
): boolean {
  return !!m.system_kind || (m.direction === 'out' && !m.sender_user_id);
}

/** The send status shown under a staff bubble; inbound messages have none. */
export function sendStatusOf(
  m: Pick<SgMessage, 'direction' | 'send_status'>
): SgSendStatus | null {
  if (m.direction !== 'out') return null;
  return m.send_status ?? 'pending';
}

/**
 * The "Name (Label)" a staff bubble is headed with: the prefix of what
 * WhatsApp actually received when the stored prefixed body carries the
 * body, else the stored sender name.
 */
export function staffSenderLine(
  m: Pick<SgMessage, 'body' | 'prefixed_body' | 'sender_name'>
): string | null {
  const body = m.body ?? '';
  const full = m.prefixed_body ?? '';
  if (full.length > body.length && full.endsWith(body)) {
    const head = full
      .slice(0, full.length - body.length)
      .replace(/:\s*$/, '')
      .trim();
    if (head) return head;
  }
  return m.sender_name?.trim() || null;
}

/**
 * The composer's "Sent as" preview — exactly the prefix the server puts
 * in front of the text (the label stays English: it is what the
 * customer reads in WhatsApp). Null when it cannot be known.
 */
export function sentAsPreview(
  name: string | null | undefined,
  label: StaffLabel | null | undefined
): string | null {
  if (!name || !name.trim() || !label || !isStaffLabel(label)) return null;
  return prefixMessage(name, ROLE_LABELS[label], '').replace(/: $/, '');
}

export type EndReasonView =
  | { key: 'finalStatus'; status: string }
  | { key: 'idle' }
  | { key: 'manual' }
  | { key: 'other'; raw: string }
  | { key: 'none' };

/** end_reason as written by the service: FINAL_STATUS:<status>, IDLE, MANUAL. */
export function endReasonView(
  reason: string | null | undefined
): EndReasonView {
  const r = (reason ?? '').trim();
  if (!r) return { key: 'none' };
  if (r.startsWith('FINAL_STATUS:'))
    return { key: 'finalStatus', status: r.slice('FINAL_STATUS:'.length) };
  if (r === 'IDLE') return { key: 'idle' };
  if (r === 'MANUAL') return { key: 'manual' };
  return { key: 'other', raw: r };
}

export type SendErrorKey =
  | 'optedOut'
  | 'doNotContact'
  | 'blocked'
  | 'notReady'
  | 'notAllowed'
  | 'notFound'
  | 'rateLimited'
  | 'gateway'
  | 'tooLong'
  | 'unknown';

/** A failed POST /messages, as the toast's message key. */
export function sendErrorKey(
  status: number,
  reason?: string | null
): SendErrorKey {
  if (status === 409) {
    if (reason === 'opted_out') return 'optedOut';
    if (reason === 'do_not_contact') return 'doNotContact';
    return reason ? 'blocked' : 'notReady';
  }
  if (status === 429) return 'rateLimited';
  if (status === 502) return 'gateway';
  if (status === 403) return 'notAllowed';
  if (status === 404) return 'notFound';
  if (status === 400 || status === 413) return 'tooLong';
  return 'unknown';
}

/**
 * After a send nobody answered for (a dropped connection, a proxy's 5xx):
 * whether its row is in the log. The row is stored before WhatsApp is
 * asked, so without a new one of this person's nothing can have gone out.
 */
export function ownSendStored(
  before: readonly SgMessage[],
  after: readonly SgMessage[],
  userId: string | null
): boolean {
  const known = new Set(before.map((m) => m.id));
  return after.some(
    (m) =>
      m.direction === 'out' &&
      !m.system_kind &&
      m.sender_user_id === userId &&
      !known.has(m.id)
  );
}

export type BannerKey =
  | 'noWhatsapp'
  | 'pending'
  | 'createError'
  | 'closeError'
  | 'numberRemoved'
  | 'contactRemoved';

/** The notices above a group's chat, most urgent first. */
export function groupBanners(g: SgGroup): BannerKey[] {
  const out: BannerKey[] = [];
  // 'none': no group and no hosting number by design, so neither the
  // pending nor the number-removed notice applies.
  const noGroup = waModeOf(g) === 'none';
  if (noGroup) out.push('noWhatsapp');
  if (g.status === 'ACTIVE' && !noGroup) {
    if (g.wa_create_error) out.push('createError');
    else if (g.pending || !g.wa_group_id) out.push('pending');
  }
  if (g.status === 'ENDED' && g.wa_close_error && !g.wa_closed_at)
    out.push('closeError');
  if (!g.channel && !noGroup) out.push('numberRemoved');
  if (!g.contact) out.push('contactRemoved');
  return out;
}

/**
 * The 1:1 invite link's outcome (migration 118). A send that went out is
 * shown even if a later attempt failed: the customer has the link.
 */
/** 142: the coordinator numbers to show, the request's first, each once (older payloads carry only coordinator_phone). */
export function coordinatorPhonesOf(
  g: Pick<SgGroup, 'coordinator_phone' | 'coordinator_phones'>
): string[] {
  const out: string[] = [];
  for (const p of [g.coordinator_phone, ...(g.coordinator_phones ?? [])])
    if (p && !out.includes(p)) out.push(p);
  return out;
}

export function inviteNotice(
  g: SgGroup
): { key: 'sent'; at: string } | { key: 'failed' } | null {
  if (g.invite_sent_at) return { key: 'sent', at: g.invite_sent_at };
  if (g.invite_send_error) return { key: 'failed' };
  return null;
}

/**
 * Resend invite is offered on an ACTIVE group whose WhatsApp group exists and
 * still has its number and contact. Consent and the 10-minute limit are the
 * route's to refuse: the page knows neither.
 */
export function canResendInvite(g: SgGroup): boolean {
  return (
    waModeOf(g) === 'group' &&
    g.status === 'ACTIVE' &&
    !!g.wa_group_id &&
    !!g.channel &&
    !!g.contact &&
    g.customer_membership !== 'joined'
  );
}

/**
 * 211: Add number is offered on an ACTIVE group's WhatsApp group that
 * exists on a connected number (the customer need not be in it).
 */
export function canAddNumber(g: SgGroup): boolean {
  return (
    waModeOf(g) === 'group' &&
    g.status === 'ACTIVE' &&
    !!g.wa_group_id &&
    !!g.channel
  );
}

/** Retry create is offered while an ACTIVE group has no WhatsApp group yet. */
export function canRetryCreate(g: SgGroup): boolean {
  return (
    waModeOf(g) === 'group' &&
    g.status === 'ACTIVE' &&
    !g.wa_group_id &&
    !!g.wa_create_error
  );
}

/**
 * Staff an admin may add to the list: live agents and up (the same rule
 * as the groups managers picker), not already on it, by name.
 */
export function addableStaff(
  members: ReadonlyArray<{
    user_id: string;
    full_name?: string | null;
    email?: string | null;
    account_role?: string | null;
    deactivated_at?: string | null;
  }>,
  onList: ReadonlyArray<{ user_id: string }>
): Array<{ id: string; name: string }> {
  const taken = new Set(onList.map((a) => a.user_id));
  return members
    .filter(
      (p) =>
        !taken.has(p.user_id) &&
        p.deactivated_at == null &&
        isAccountRole(p.account_role) &&
        canSendMessages(p.account_role)
    )
    .map((p) => ({
      id: p.user_id,
      name: p.full_name?.trim() || p.email?.trim() || p.user_id,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Where a group's read marker stands. `sg_mark_read` also clears the
 * customer's bell, so a read only happens with the page on screen: one
 * that falls due while it is hidden stays owed until it is shown again.
 */
export function settleRead(
  owed: boolean,
  visible: boolean
): { mark: boolean; owed: boolean } {
  return visible ? { mark: owed, owed: false } : { mark: false, owed };
}

type Named = Pick<SgListItem, 'customer_name' | 'contact'>;

/**
 * What a group is called on screen: the company the tracker sent (141),
 * else the CRM contact's name, else its phone. Null when none is known.
 */
export function groupTitle(g: Named): string | null {
  return (
    g.customer_name?.trim() ||
    g.contact?.name?.trim() ||
    g.contact?.phone?.trim() ||
    null
  );
}

/** The bank tag's text: the bank's name, else its code; null for none. */
export function bankName(g: Pick<SgListItem, 'bank'>): string | null {
  return g.bank?.name?.trim() || g.bank?.code?.trim() || null;
}

/** The contact person under the title, or null when it adds nothing. */
export function groupContactName(g: Named): string | null {
  return contactPersonLine(groupTitle(g), g.contact?.name ?? null);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A submission ref as a short code: a UUID's first 8 characters, else the ref. */
export function shortRef(ref: string): string {
  const r = ref.trim();
  return UUID_RE.test(r) ? r.slice(0, 8) : r;
}

/** Up to two initials of a name (letters or digits), for an avatar. */
export function initialsOf(name: string | null | undefined): string {
  const words = (name ?? '')
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
  if (!words.length) return '?';
  const pick = words.length === 1 ? [words[0]] : [words[0], words[1]];
  return pick
    .map((w) => [...w][0])
    .join('')
    .toLocaleUpperCase();
}

/** Avatar colours, each with its dark-mode pair. */
export const AVATAR_TONES: readonly string[] = [
  'bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-200',
  'bg-violet-100 text-violet-800 dark:bg-violet-900/50 dark:text-violet-200',
  'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200',
  'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200',
  'bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-200',
  'bg-teal-100 text-teal-800 dark:bg-teal-900/50 dark:text-teal-200',
  'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-200',
  'bg-orange-100 text-orange-800 dark:bg-orange-900/50 dark:text-orange-200',
];

/** The same name always gets the same avatar colour. */
export function avatarTone(name: string | null | undefined): string {
  const key = (name ?? '').trim().toLocaleLowerCase();
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length];
}

/**
 * The tracker status chip: the status word for word, coloured as the
 * case screens colour it (`caseStatusView`). Null when none was sent.
 */
export function trackerStatusChip(
  status: string | null | undefined
): { text: string; chipClass: string } | null {
  if (!status?.trim()) return null;
  return caseStatusView({ stage: '', submissionStatus: status });
}

/** An inbound sender's WhatsApp id (`9715…@c.us`) as a phone, `+9715…`. */
export function waIdPhone(id: string | null | undefined): string | null {
  const digits = (id ?? '').split('@')[0].replace(/\D/g, '');
  return digits ? `+${digits}` : null;
}

/** A row's unread badge text; null when there is nothing to show. */
export function unreadBadgeText(unread: number | undefined): string | null {
  if (!unread || unread <= 0) return null;
  return unread > 99 ? '99+' : String(unread);
}

/** The rows with the given groups' unread counts cleared. */
export function clearUnread<T extends { id: string; unread?: number }>(
  groups: readonly T[],
  ids: ReadonlySet<string>
): T[] {
  return groups.map((g) => (ids.has(g.id) ? { ...g, unread: 0 } : g));
}

/** "My groups": the rows the caller holds a label on. */
export function onlyMine(groups: readonly SgListItem[]): SgListItem[] {
  return groups.filter((g) => g.my_label !== null);
}
