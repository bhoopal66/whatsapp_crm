/**
 * The case page's Timeline, Conversation and Audit tabs (module 019): the
 * bodies their routes answer, parsed defensively, and the pure rules the
 * tab components share. No React, no I/O.
 */

import type { SgMessage } from '@/lib/submission-groups/ui';

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
const str = (v: unknown): string | null =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// ------------------------------------------------------------ Timeline

/** One entry of GET /api/cases/[id]/timeline (`at` is ISO). */
export interface TimelineEntry {
  at: string;
  kind: string;
  refId: string;
  actor: string | null;
  summary: string;
  source: string;
}

/** `{ entries }`, keeping only entries with a valid time and a kind. */
export function parseTimeline(json: unknown): TimelineEntry[] {
  return list(obj(json)?.entries).flatMap((v) => {
    const r = obj(v);
    const at = str(r?.at);
    const kind = str(r?.kind);
    if (!r || !at || !kind || Number.isNaN(new Date(at).getTime())) return [];
    return [
      {
        at,
        kind,
        refId: str(r.refId) ?? '',
        actor: str(r.actor),
        summary: str(r.summary) ?? '',
        source: str(r.source) ?? '',
      },
    ];
  });
}

export interface TimelineDay {
  /** YYYY-MM-DD in the zone the entries were grouped in. */
  day: string;
  entries: TimelineEntry[];
}

/** The calendar day of an ISO time in `timeZone` (else the runtime's). */
function dayKey(iso: string, timeZone?: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * Entries into one group per calendar day in `timeZone` (else the
 * runtime's). Days come in the order they first appear and entries keep
 * their input order, so newest-first input gives newest-first days.
 */
export function groupTimelineByDay(
  entries: readonly TimelineEntry[],
  timeZone?: string
): TimelineDay[] {
  const days = new Map<string, TimelineEntry[]>();
  for (const e of entries) {
    const key = dayKey(e.at, timeZone);
    const day = days.get(key);
    if (day) day.push(e);
    else days.set(key, [e]);
  }
  return [...days].map(([day, list]) => ({ day, entries: list }));
}

/** lucide icon names the Timeline tab draws (it maps each to a component). */
export type TimelineIconName =
  | 'ArrowRightLeft'
  | 'ListPlus'
  | 'ListChecks'
  | 'StickyNote'
  | 'FileText'
  | 'Timer'
  | 'Landmark'
  | 'Users'
  | 'UserX'
  | 'Archive'
  | 'MessageSquare'
  | 'Phone'
  | 'Circle';

const TIMELINE_ICONS: Record<string, TimelineIconName> = {
  stage: 'ArrowRightLeft',
  task: 'ListPlus',
  task_status: 'ListChecks',
  note: 'StickyNote',
  document: 'FileText',
  sla: 'Timer',
  bank_contact: 'Landmark',
  group_open: 'Users',
  group_end: 'UserX',
  conversation_archived: 'Archive',
  group_message: 'MessageSquare',
  message: 'MessageSquare',
  call: 'Phone',
};

/** The icon for a timeline kind; an unknown kind gets a plain dot. */
export function timelineIcon(kind: string): TimelineIconName {
  return Object.hasOwn(TIMELINE_ICONS, kind) ? TIMELINE_ICONS[kind] : 'Circle';
}

export interface CallSummary {
  direction: string;
  status: string;
  /** Talk time in seconds, when the call had one. */
  seconds: number | null;
}

/**
 * A call entry's summary as timeline.ts writes it:
 * `<direction> call: <status>[ (<n>s)]`. Null when it is not one.
 */
export function parseCallSummary(summary: string): CallSummary | null {
  const m = /^(\S+) call: (\S+)(?: \((\d+)s\))?$/.exec(summary);
  if (!m) return null;
  return {
    direction: m[1],
    status: m[2],
    seconds: m[3] === undefined ? null : Number(m[3]),
  };
}

/** Seconds as `m:ss` (or `h:mm:ss` from an hour). */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// ------------------------------------------------------------ Conversation

export interface CaseConversation {
  groupId: string | null;
  archived: boolean;
  /** 136: 'none' = no WhatsApp group for this submission (show no composer); NULL without a group. */
  waMode: 'group' | 'none' | null;
  /** Oldest first, as the route answers. */
  messages: SgMessage[];
}

/** `{ groupId, archived, waMode, messages }`; messages need an id and a time. */
export function parseConversation(json: unknown): CaseConversation {
  const root = obj(json);
  return {
    groupId: str(root?.groupId),
    archived: root?.archived === true,
    waMode:
      root?.waMode === 'none'
        ? 'none'
        : root?.waMode === 'group'
          ? 'group'
          : null,
    messages: list(root?.messages).filter((v): v is SgMessage => {
      const m = obj(v);
      return !!m && !!str(m.id) && !!str(m.created_at);
    }),
  };
}

/** CasePage.conversation.send.* keys. */
export type SendResultKey =
  | 'sent'
  | 'sentNotRecorded'
  | 'optedOut'
  | 'notOnList'
  | 'notReady'
  | 'noGroup'
  | 'numberRemoved'
  | 'contactRemoved'
  | 'rateLimited'
  | 'notAllowed'
  | 'notFound'
  | 'invalid'
  | 'failed';

/** 115's send refusals and the consent block, by the route's `code`. */
const SEND_CODES: Record<string, SendResultKey> = {
  SEND_BLOCKED: 'optedOut',
  SEND_NOT_ALLOWED: 'notOnList',
  UNKNOWN_USER: 'notOnList',
  GROUP_NOT_READY: 'notReady',
  GROUP_NOT_FOUND: 'noGroup',
  NUMBER_REMOVED: 'numberRemoved',
  CONTACT_REMOVED: 'contactRemoved',
  SEND_RATE_LIMITED: 'rateLimited',
};

/**
 * The toast for a POST /api/cases/[id]/conversation answer: 201 sent;
 * 200 sent but not recorded (WhatsApp has it: never invite a resend);
 * otherwise the refusal by code, then by status. Status 0 is a network
 * failure.
 */
export function sendResultMessageKey(
  status: number,
  code: unknown
): SendResultKey {
  if (status === 200) return 'sentNotRecorded';
  if (status >= 200 && status < 300) return 'sent';
  if (typeof code === 'string' && Object.hasOwn(SEND_CODES, code))
    return SEND_CODES[code];
  if (status === 429) return 'rateLimited';
  if (status === 409) return 'notReady';
  if (status === 403) return 'notAllowed';
  if (status === 404) return 'notFound';
  if (status === 400) return 'invalid';
  return 'failed';
}

/**
 * Whether the composer gets the text back: only when the server refused
 * it outright (4xx) or never answered. After a 5xx WhatsApp may already
 * hold the message, so the text is not offered for a resend.
 */
export function shouldRestoreText(status: number): boolean {
  return status === 0 || (status >= 400 && status < 500);
}

// ------------------------------------------------------------ Audit

export interface CaseAuditRow {
  id: string;
  viewerId: string;
  viewerRole: string;
  viewedAt: string;
}

/** `{ rows }`, newest first. */
export function parseAuditRows(json: unknown): CaseAuditRow[] {
  return list(obj(json)?.rows)
    .flatMap((v) => {
      const r = obj(v);
      const id = str(r?.id);
      const viewedAt = str(r?.viewedAt);
      if (!r || !id || !viewedAt || Number.isNaN(new Date(viewedAt).getTime()))
        return [];
      return [
        {
          id,
          viewerId: str(r.viewerId) ?? '',
          viewerRole: str(r.viewerRole) ?? '',
          viewedAt,
        },
      ];
    })
    .sort(
      (a, b) => new Date(b.viewedAt).getTime() - new Date(a.viewedAt).getTime()
    );
}
