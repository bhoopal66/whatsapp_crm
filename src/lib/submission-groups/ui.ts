/**
 * Submission groups screens (module 018a): the pure decisions behind
 * /submission-groups and /submission-groups/[id]. Client-safe: it imports
 * only the pure rules, never the store or the gateway.
 */
import { canSendMessages, isAccountRole } from '@/lib/auth/roles';

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
}

export interface SgGroup extends SgListItem {
  submission_status: string | null;
  coordinator_phone: string | null;
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
  post_end: boolean;
  type: string | null;
  media: unknown;
  created_at: string;
}

/** GET /api/submission-groups/[id]. */
export interface SgDetail {
  group: SgGroup;
  access: SgAccess[];
  messages: SgMessage[];
  archive_available: boolean;
  can_send: boolean;
  can_manage: boolean;
  /** The group's case, or null when none was opened yet. */
  caseId: string | null;
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

/** The list URL for one tab, search and page. */
export function listUrl(
  status: 'active' | 'ended',
  q: string,
  cursor: string | null,
  limit = 30
): string {
  const qs = new URLSearchParams({ status, limit: String(limit) });
  const query = q.trim();
  if (query) qs.set('q', query);
  if (cursor) qs.set('cursor', cursor);
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
export function inviteNotice(
  g: SgGroup
): { key: 'sent'; at: string } | { key: 'failed' } | null {
  if (g.invite_sent_at) return { key: 'sent', at: g.invite_sent_at };
  if (g.invite_send_error) return { key: 'failed' };
  return null;
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

/** Upper bound of a staff message, as the API enforces it. */
export const SEND_TEXT_MAX = 4096;
