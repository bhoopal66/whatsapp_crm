/**
 * Pure logic behind one group's page (/groups/[id]): why a control is
 * disabled, which tabs show, chat bubbles grouped by day, status ticks,
 * and the add-members / send-invite result summaries. No I/O, so it is
 * tested in node.
 */
import { identityIds } from './ui';
import type { GroupMessageStatus, GroupSettings } from './types';

// ------------------------------------------------------------
// Codes → wording
// ------------------------------------------------------------

/**
 * Every `code` a group route or a `blocks` entry can carry that has its
 * own sentence (`Groups.page.reasons.<code>`). Anything else (an older
 * server, a new code) reads as `unknown`, never as a raw code.
 */
export const GROUP_REASON_CODES = [
  'not_allowed',
  'not_group_admin',
  'left',
  'number_removed',
  'own_number',
  'rate_limited',
  'invalid_manager',
  'too_large',
  'no_icon',
  'not_admin',
  'group_not_found',
  'channel_disconnected',
  'billing',
  'gateway_unavailable',
  'not_whapi',
  'already_member',
  'invalid_request',
  'request_failed',
  'not_found',
  'unavailable',
  'invalid_body',
  'time_budget',
  'no_participants',
  'saved_failed_run_sync',
  'unknown',
] as const;
export type GroupReasonCode = (typeof GROUP_REASON_CODES)[number];

/** The message key (under `Groups.page.reasons`) for a code. */
export function reasonKey(code: unknown): GroupReasonCode {
  return typeof code === 'string' &&
    (GROUP_REASON_CODES as readonly string[]).includes(code)
    ? (code as GroupReasonCode)
    : 'unknown';
}

// ------------------------------------------------------------
// Blocks and tabs
// ------------------------------------------------------------

export const GROUP_ACTIONS = [
  'send',
  'edit_info',
  'settings',
  'members',
  'invite',
  'join_requests',
  'leave',
] as const;
export type GroupAction = (typeof GROUP_ACTIONS)[number];
export type GroupBlocks = Record<GroupAction, GroupReasonCode | null>;

/**
 * Tolerant read of the GET response's `blocks`. An action the server did
 * not answer for is blocked as `unknown` rather than silently enabled.
 */
export function parseBlocks(raw: unknown): GroupBlocks {
  const obj =
    typeof raw === 'object' && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const out = {} as GroupBlocks;
  for (const action of GROUP_ACTIONS) {
    const v = obj[action];
    out[action] = v === null ? null : reasonKey(v);
  }
  return out;
}

export const GROUP_TABS = [
  'chat',
  'members',
  'settings',
  'invite',
  'requests',
  'managers',
] as const;
export type GroupTab = (typeof GROUP_TABS)[number];

/**
 * The tabs a person sees. Requests only while joining by link needs
 * approval or someone is still waiting; Managers only for an admin and
 * up or the group's creator (who may change the set).
 */
export function visibleTabs(args: {
  settings: GroupSettings;
  pendingRequests: number;
  canEditManagers: boolean;
}): GroupTab[] {
  return GROUP_TABS.filter((tab) => {
    if (tab === 'requests') {
      return (
        args.settings.approve_participants === 'admins' ||
        args.pendingRequests > 0
      );
    }
    if (tab === 'managers') return args.canEditManagers;
    return true;
  });
}

/**
 * The tab the URL names (`?tab=`), else Chat. A name that is not a tab, or
 * a tab this person does not see (Requests while nothing waits, Managers
 * for a non-manager), also reads as Chat.
 */
export function resolveTab(
  raw: string | null | undefined,
  visible: readonly GroupTab[]
): GroupTab {
  const tab = (GROUP_TABS as readonly string[]).includes(raw ?? '')
    ? (raw as GroupTab)
    : 'chat';
  return visible.includes(tab) ? tab : 'chat';
}

// ------------------------------------------------------------
// The info panel
// ------------------------------------------------------------

/** The group-info panel's sections, top to bottom (Leave sits below). */
export const INFO_SECTIONS = [
  'members',
  'invite',
  'requests',
  'settings',
  'managers',
] as const;
export type InfoSection = (typeof INFO_SECTIONS)[number];

/**
 * The sections a person sees: the tabs `visibleTabs` allows, in panel
 * order, with Settings left out when both of its halves (name and
 * picture, the four policies) are blocked, so there is nothing to edit.
 */
export function infoSections(
  visible: readonly GroupTab[],
  blocks: Pick<GroupBlocks, 'edit_info' | 'settings'>
): InfoSection[] {
  return INFO_SECTIONS.filter(
    (s) =>
      visible.includes(s) &&
      !(
        s === 'settings' &&
        blocks.edit_info !== null &&
        blocks.settings !== null
      )
  );
}

/**
 * The section an old `?tab=` link opens (`?tab=requests` from the
 * bell, `?tab=members` …), or null for Chat, an unknown tab, or one
 * this person does not see.
 */
export function infoSectionFromTab(
  raw: string | null | undefined,
  sections: readonly InfoSection[]
): InfoSection | null {
  return (sections as readonly string[]).includes(raw ?? '')
    ? (raw as InfoSection)
    : null;
}

/**
 * Whether a `DELETE …/participants` answer says WhatsApp refused anyone.
 * The route answers 200 `{removed, failed, resynced}` even then.
 */
export function removalFailed(json: unknown): boolean {
  const failed = (json as { failed?: unknown } | null)?.failed;
  return identityIds(failed).length > 0;
}

// ------------------------------------------------------------
// Chat
// ------------------------------------------------------------

export interface DayGroup<T> {
  /** `YYYY-MM-DD` in the given time zone. */
  day: string;
  messages: T[];
}

function dayKey(iso: string, timeZone?: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return '';
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * Oldest-first messages into runs of one calendar day (in `timeZone`,
 * else the runtime's), keeping their order. A run restarts whenever the
 * day changes, so the output stays chronological even if the input is
 * not strictly sorted.
 */
export function groupMessagesByDay<T extends { created_at: string }>(
  messages: readonly T[],
  timeZone?: string
): DayGroup<T>[] {
  const out: DayGroup<T>[] = [];
  for (const m of messages) {
    const day = dayKey(m.created_at, timeZone);
    const last = out[out.length - 1];
    if (last && last.day === day) last.messages.push(m);
    else out.push({ day, messages: [m] });
  }
  return out;
}

/**
 * Merge freshly arrived rows (a page, a realtime insert, a send reply)
 * into the list: one row per id, a newer copy replacing an older one,
 * sorted oldest first.
 */
export function mergeMessages<T extends { id: string; created_at: string }>(
  current: readonly T[],
  incoming: readonly T[]
): T[] {
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort(
    (a, b) =>
      (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0) ||
      a.id.localeCompare(b.id)
  );
}

export type StatusTick = 'clock' | 'single' | 'double' | 'read' | 'failed';

/** The tick under an outgoing bubble; incoming bubbles have none. */
export function statusTick(
  direction: 'in' | 'out',
  status: GroupMessageStatus | null
): StatusTick | null {
  if (direction !== 'out') return null;
  switch (status) {
    case 'sent':
      return 'single';
    case 'delivered':
      return 'double';
    case 'read':
      return 'read';
    case 'failed':
      return 'failed';
    default:
      return 'clock';
  }
}

/**
 * Who sent a bubble in the chat log. Incoming: the participant, by the
 * name WhatsApp gave, else their number. Outgoing: the member the send
 * route recorded (`sender_user_id`, with their name then), else the
 * name our number carries on a message sent from the phone. A null
 * `name` reads as "Someone" / "Your number".
 */
export function groupMessageSender(
  m: {
    direction: 'in' | 'out';
    sender_name: string | null;
    sender_wa_id: string | null;
    sender_user_id?: string | null;
  },
  currentUserId: string | null
): { name: string | null; isMe: boolean } {
  const out = m.direction === 'out';
  return {
    name: m.sender_name?.trim() || (out ? null : m.sender_wa_id) || null,
    isMe: out && !!currentUserId && m.sender_user_id === currentUserId,
  };
}

/** Composer key handling: Enter sends, Shift+Enter (or IME input) does not. */
export function shouldSendOnKey(e: {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
}): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.isComposing;
}

// ------------------------------------------------------------
// Results
// ------------------------------------------------------------

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];

export interface AddMembersSummary {
  added: string[];
  /** WhatsApp refused or never tried: the invite link is the way in. */
  needInvite: string[];
  invalid: string[];
  /** Left out because they opted out or are on do-not-contact. */
  skipped: string[];
  /** The WhatsApp failure that stopped the run early, if any. */
  error: GroupReasonCode | null;
}

/** `POST …/participants` response in the dialog's terms. */
export function summarizeAddMembers(json: unknown): AddMembersSummary {
  const r = (json ?? {}) as Record<string, unknown>;
  const skipped = Array.isArray(r.skipped)
    ? r.skipped
        .map((s) => (s as { waId?: unknown } | null)?.waId)
        .filter((w): w is string => typeof w === 'string')
    : [];
  return {
    added: identityIds(r.added),
    needInvite: [
      ...new Set([...identityIds(r.refused), ...identityIds(r.notAttempted)]),
    ],
    invalid: strings(r.invalid),
    skipped,
    error: r.error == null ? null : reasonKey(r.error),
  };
}

export type InviteSendStatus =
  'sent' | 'failed' | 'skipped' | 'not_attempted' | 'invalid';

export interface InviteSendRow {
  waId: string;
  contactId: string | null;
  status: InviteSendStatus;
  /** A reason code (`reasonKey`), `opted_out`, `do_not_contact`, `over_limit`, or null. */
  reason: string | null;
}

export interface InviteSendSummary {
  sent: number;
  failed: number;
  skipped: number;
  notAttempted: number;
  invalid: number;
  rows: InviteSendRow[];
}

const SEND_STATUSES: readonly InviteSendStatus[] = [
  'sent',
  'failed',
  'skipped',
  'not_attempted',
  'invalid',
];

/** `POST …/invite {action:'send'}` response, counted from its rows. */
export function summarizeInviteSend(json: unknown): InviteSendSummary {
  const raw = (json as { results?: unknown } | null)?.results;
  const rows: InviteSendRow[] = [];
  for (const x of Array.isArray(raw) ? raw : []) {
    const r = (x ?? {}) as Record<string, unknown>;
    if (typeof r.waId !== 'string') continue;
    const status = SEND_STATUSES.includes(r.status as InviteSendStatus)
      ? (r.status as InviteSendStatus)
      : 'failed';
    rows.push({
      waId: r.waId,
      contactId: typeof r.contactId === 'string' ? r.contactId : null,
      status,
      reason: typeof r.reason === 'string' ? r.reason : null,
    });
  }
  const count = (s: InviteSendStatus) =>
    rows.filter((r) => r.status === s).length;
  return {
    sent: count('sent'),
    failed: count('failed'),
    skipped: count('skipped'),
    notAttempted: count('not_attempted'),
    invalid: count('invalid'),
    rows,
  };
}

/** The invite message as it will go out: `%URL%` appended when absent. */
export function inviteMessagePreview(message: string, link: string): string {
  const body = message.trim();
  if (!body) return link;
  return (body.includes('%URL%') ? body : `${body}\n%URL%`).replaceAll(
    '%URL%',
    link
  );
}
