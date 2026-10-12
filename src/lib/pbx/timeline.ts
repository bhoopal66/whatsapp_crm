import type { PresenceView } from './calls';
import { isMissedCall } from './calls';

// The customer page, the Calls page and the chat sidebar's CALLS rows
// (module 015). Pure: the screens read the rows, these decide what they
// say. Wording is returned as message descriptors ({ key, values } in
// the CustomerTimeline catalogue) so en/ko stay in the catalogues; a
// plain string is literal text (a clock, a channel name).

export interface Msg {
  key: string;
  values?: Record<string, string | number>;
}
export type Part = Msg | string;

// ---------- Entries ----------

/** A row of GET /api/pbx/calls, as far as the timeline reads it. */
export interface TimelineCall {
  id: string;
  direction: string;
  status: string;
  startedAt: string;
  answeredAt: string | null;
  ringSeconds: number | null;
  talkSeconds: number | null;
  userId: string | null;
  userName: string | null;
  disposition: string | null;
  notes: string | null;
  recordingState: string;
}
export interface TimelineMessage {
  id: string;
  senderType: string;
  senderId: string | null;
  senderName: string | null;
  text: string | null;
  contentType: string;
  createdAt: string;
}
export interface TimelineNote {
  id: string;
  text: string;
  authorName: string | null;
  createdAt: string;
}
/** An internal-chat message that shared this customer's chat. */
export interface TimelineInternal {
  id: string;
  channelId: string;
  channelName: string;
  authorName: string | null;
  body: string;
  createdAt: string;
}

export type TimelineEntry =
  | { kind: 'call'; id: string; at: string; call: TimelineCall }
  | { kind: 'whatsapp'; id: string; at: string; message: TimelineMessage }
  | { kind: 'note'; id: string; at: string; note: TimelineNote }
  | { kind: 'internal'; id: string; at: string; post: TimelineInternal };
export type EntryKind = TimelineEntry['kind'];

const time = (at: string) => Date.parse(at);

/** The four sources as one list, newest first; an undated row is dropped. */
export function mergeTimeline(src: {
  calls?: TimelineCall[];
  messages?: TimelineMessage[];
  notes?: TimelineNote[];
  internal?: TimelineInternal[];
}): TimelineEntry[] {
  const out: TimelineEntry[] = [
    ...(src.calls ?? []).map(
      (call) =>
        ({ kind: 'call', id: call.id, at: call.startedAt, call }) as const
    ),
    ...(src.messages ?? []).map(
      (message) =>
        ({
          kind: 'whatsapp',
          id: message.id,
          at: message.createdAt,
          message,
        }) as const
    ),
    ...(src.notes ?? []).map(
      (note) =>
        ({ kind: 'note', id: note.id, at: note.createdAt, note }) as const
    ),
    ...(src.internal ?? []).map(
      (post) =>
        ({ kind: 'internal', id: post.id, at: post.createdAt, post }) as const
    ),
  ];
  return out
    .filter((e) => Number.isFinite(time(e.at)))
    .sort(
      (a, b) =>
        time(b.at) - time(a.at) ||
        (a.kind + a.id < b.kind + b.id
          ? -1
          : a.kind + a.id > b.kind + b.id
            ? 1
            : 0)
    );
}

export const TIMELINE_FILTERS = ['all', 'calls', 'whatsapp', 'notes'] as const;
export type TimelineFilter = (typeof TIMELINE_FILTERS)[number];

/** Notes are the staff-only kinds: contact notes and internal-chat posts. */
const FILTER_KINDS: Record<TimelineFilter, readonly EntryKind[] | null> = {
  all: null,
  calls: ['call'],
  whatsapp: ['whatsapp'],
  notes: ['note', 'internal'],
};

export function isTimelineFilter(v: string | null): v is TimelineFilter {
  return (TIMELINE_FILTERS as readonly string[]).includes(v ?? '');
}

export function filterTimeline(
  entries: TimelineEntry[],
  filter: TimelineFilter
): TimelineEntry[] {
  const kinds = FILTER_KINDS[filter];
  return kinds ? entries.filter((e) => kinds.includes(e.kind)) : entries;
}

// ---------- Days and clocks ----------

/** 'YYYY-MM-DD' of an instant in a time zone. */
export function dayKey(at: string | number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(at));
}

/** The calendar day before 'YYYY-MM-DD' (no zone: no DST to trip on). */
export function previousDay(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

export interface DayGroup<T> {
  key: string;
  label: 'today' | 'yesterday' | 'date';
  items: T[];
}

/** Consecutive runs of one day, in the input's order (newest first). */
export function groupByDay<T>(
  items: T[],
  atOf: (item: T) => string,
  now: number,
  timeZone: string
): DayGroup<T>[] {
  const today = dayKey(now, timeZone);
  const yesterday = previousDay(today);
  const groups: DayGroup<T>[] = [];
  for (const item of items) {
    const key = dayKey(atOf(item), timeZone);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else
      groups.push({
        key,
        label:
          key === today ? 'today' : key === yesterday ? 'yesterday' : 'date',
        items: [item],
      });
  }
  return groups;
}

/** '11:40': 24-hour wall clock in the zone. */
export function clock(at: string | number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(at));
}

/** '6:18' for the player; '0:00' for nothing. */
export function playerClock(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.floor(seconds ?? 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** '24 s', '6 min 18 s', '6 min'. */
export function duration(seconds: number | null | undefined): Msg {
  const s = Math.max(0, Math.round(seconds ?? 0));
  const min = Math.floor(s / 60);
  const sec = s % 60;
  if (min === 0) return { key: 'durationSec', values: { sec } };
  if (sec === 0) return { key: 'durationMin', values: { min } };
  return { key: 'durationMinSec', values: { min, sec } };
}

/** 'Sara and Faisal' in the locale's own conjunction. */
export function joinNames(names: string[], locale: string): string {
  return new Intl.ListFormat(locale, {
    style: 'long',
    type: 'conjunction',
  }).format(names);
}

// ---------- Headings ----------

export interface Heading {
  label: Part;
  details: Part[];
}

export type CallTone = 'missed' | 'ok';

export function callTone(call: TimelineCall): CallTone {
  return isMissedCall(call) && !call.answeredAt ? 'missed' : 'ok';
}

/** 'rang Sara and Faisal for 24 s' (whoever is known of it). */
export function rangPart(
  names: string[],
  ringSeconds: number | null,
  locale: string
): Msg | null {
  const who = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  const seconds = ringSeconds == null ? null : Math.max(0, ringSeconds);
  if (who.length && seconds != null)
    return {
      key: 'rangFor',
      values: { names: joinNames(who, locale), seconds },
    };
  if (who.length)
    return { key: 'rangNames', values: { names: joinNames(who, locale) } };
  if (seconds != null) return { key: 'rangSeconds', values: { seconds } };
  return null;
}

const DISPOSITION_KEYS: Record<string, string> = {
  interested: 'disposition.interested',
  docs_requested: 'disposition.docsRequested',
  call_back: 'disposition.callBack',
  not_eligible: 'disposition.notEligible',
  wrong_number: 'disposition.wrongNumber',
};
const STATUS_KEYS: Record<string, string> = {
  ringing: 'status.ringing',
  in_progress: 'status.inProgress',
  answered: 'status.answered',
  no_answer: 'status.noAnswer',
  busy: 'status.busy',
  voicemail: 'status.voicemail',
  abandoned: 'status.abandoned',
  failed: 'status.failed',
};

export function callHeading(
  call: TimelineCall,
  ctx: { timeZone: string; locale: string; rang?: string[] }
): Heading {
  const at = clock(call.startedAt, ctx.timeZone);
  const name = call.userName?.trim() || null;
  if (callTone(call) === 'missed') {
    const rang = rangPart(
      ctx.rang ?? (name ? [name] : []),
      call.ringSeconds,
      ctx.locale
    );
    return {
      label: { key: 'missedCall' },
      details: [{ key: 'incoming' }, at, ...(rang ? [rang] : [])],
    };
  }
  const answered = call.status === 'answered' || !!call.answeredAt;
  const disposition = call.disposition && DISPOSITION_KEYS[call.disposition];
  const tail: Part[] = [
    at,
    answered
      ? duration(call.talkSeconds)
      : { key: STATUS_KEYS[call.status] ?? call.status },
    ...(disposition ? [{ key: disposition }] : []),
  ];
  let label: Msg;
  if (call.direction === 'inbound')
    label = answered
      ? name
        ? { key: 'incomingAnsweredBy', values: { name } }
        : { key: 'incomingAnswered' }
      : { key: 'incomingCall' };
  else if (call.direction === 'outbound')
    label = name
      ? { key: 'outgoingBy', values: { name } }
      : { key: 'outgoingCall' };
  else label = { key: 'internalCall' };
  return { label, details: tail };
}

export function entryHeading(
  entry: TimelineEntry,
  ctx: {
    timeZone: string;
    locale: string;
    contactName?: string | null;
    rang?: string[];
  }
): Heading {
  const at = clock(entry.at, ctx.timeZone);
  switch (entry.kind) {
    case 'call':
      return callHeading(entry.call, ctx);
    case 'whatsapp': {
      const m = entry.message;
      const who =
        m.senderType === 'customer'
          ? ctx.contactName?.trim() || null
          : m.senderType === 'bot'
            ? null
            : m.senderName?.trim() || null;
      const from: Msg =
        m.senderType === 'bot'
          ? { key: 'fromBot' }
          : who
            ? { key: 'from', values: { name: who } }
            : m.senderType === 'customer'
              ? { key: 'fromCustomer' }
              : { key: 'fromTeam' };
      return { label: { key: 'whatsapp' }, details: [at, from] };
    }
    case 'note':
      return {
        label: { key: 'note' },
        details: [
          at,
          ...(entry.note.authorName ? [entry.note.authorName] : []),
        ],
      };
    case 'internal':
      return {
        label: `#${entry.post.channelName}`,
        details: [
          at,
          ...(entry.post.authorName ? [entry.post.authorName] : []),
          { key: 'internal' },
        ],
      };
  }
}

// ---------- Missed-call tasks ----------

export interface TimelineTask {
  id: string;
  kind: string;
  title: string;
  status: string;
  due_at: string | null;
  assigned_to: string | null;
  source_ref: string | null;
  meta: Record<string, unknown> | null;
}

/** The task the PBX opened for this missed call (source_ref call:<id>). */
export function missedTaskFor<T extends TimelineTask>(
  callId: string,
  tasks: T[]
): T | null {
  return (
    tasks.find(
      (t) =>
        t.kind === 'missed_call' &&
        (t.meta?.call_id === callId || t.source_ref === `call:${callId}`)
    ) ?? null
  );
}

/** 'Task for Sara: call back by 12:10'. */
export function taskStrip(
  task: Pick<TimelineTask, 'due_at'>,
  assigneeName: string | null,
  timeZone: string
): Msg {
  const name = assigneeName?.trim() || null;
  const due =
    task.due_at && Number.isFinite(time(task.due_at))
      ? clock(task.due_at, timeZone)
      : null;
  if (name && due) return { key: 'taskFor', values: { name, time: due } };
  if (name) return { key: 'taskForNoDue', values: { name } };
  if (due) return { key: 'taskDue', values: { time: due } };
  return { key: 'taskNoDue' };
}

/** "Call back Khalid — due 12:10" in Open tasks. */
export function openTaskLine(
  task: Pick<TimelineTask, 'title' | 'due_at'>,
  timeZone: string
): Msg {
  return task.due_at && Number.isFinite(time(task.due_at))
    ? {
        key: 'openTaskDue',
        values: { title: task.title, time: clock(task.due_at, timeZone) },
      }
    : { key: 'openTask', values: { title: task.title } };
}

/** Open missed-call tasks assigned to this person (the sidebar's pill). */
export function openMissedTasks(
  tasks: Pick<TimelineTask, 'kind' | 'status' | 'assigned_to'>[],
  userId: string | null
): number {
  if (!userId) return 0;
  return tasks.filter(
    (t) =>
      t.kind === 'missed_call' &&
      t.status === 'open' &&
      t.assigned_to === userId
  ).length;
}

// ---------- Right column ----------

export interface MonthTotals {
  total: number;
  answered: number;
  missed: number;
  talkSeconds: number;
}

/** '5 calls · 3 answered · 2 missed' and 'Talk time 17 min'. */
export function monthSummaryParts(s: MonthTotals): { counts: Msg; talk: Msg } {
  return {
    counts: {
      key: 'monthCounts',
      values: { total: s.total, answered: s.answered, missed: s.missed },
    },
    talk: {
      key: 'talkTime',
      values: { minutes: Math.round(Math.max(0, s.talkSeconds) / 60) },
    },
  };
}

export type DotTone = 'green' | 'red' | 'ring';
export type AppPresence = 'online' | 'away' | 'offline';

/**
 * The PBX's state first (a person with an extension); the app's own
 * presence only for someone the PBX has no row for.
 */
export function presenceDotState(
  pbx: PresenceView | null | undefined,
  app: AppPresence | null | undefined
): { tone: DotTone; key: string } {
  switch (pbx) {
    case 'available':
      return { tone: 'green', key: 'presence.available' };
    case 'on_call':
      return { tone: 'red', key: 'presence.onCall' };
    case 'dnd':
      return { tone: 'red', key: 'presence.dnd' };
    case 'away':
      return { tone: 'ring', key: 'presence.away' };
    case 'off_work':
      return { tone: 'ring', key: 'presence.offWork' };
    case 'offline':
      return { tone: 'ring', key: 'presence.offline' };
  }
  if (app === 'online') return { tone: 'green', key: 'presence.available' };
  if (app === 'away') return { tone: 'ring', key: 'presence.away' };
  return { tone: 'ring', key: 'presence.offline' };
}

export type TeamRole = 'ownerRm' | 'assignee' | 'recent';

/** Owner RM, then the chat's assignee, then the recent callers/senders. */
export function teamOnCustomer(input: {
  ownerId: string | null;
  assigneeId: string | null;
  recent: (string | null)[];
  max?: number;
}): { userId: string; role: TeamRole }[] {
  const out: { userId: string; role: TeamRole }[] = [];
  const add = (userId: string | null, role: TeamRole) => {
    if (userId && !out.some((p) => p.userId === userId))
      out.push({ userId, role });
  };
  add(input.ownerId, 'ownerRm');
  add(input.assigneeId, 'assignee');
  for (const id of input.recent) add(id, 'recent');
  return out.slice(0, input.max ?? 6);
}

/** People who called or wrote to the customer, newest first. */
export function recentPeople(entries: TimelineEntry[]): string[] {
  const ids: string[] = [];
  for (const e of entries) {
    const id =
      e.kind === 'call'
        ? e.call.userId
        : e.kind === 'whatsapp' && e.message.senderType === 'agent'
          ? e.message.senderId
          : null;
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** '+971 XXXXXXX12', as chat_mask_phone (087) masks a shared card. */
export function maskPhone(phone: string | null | undefined): string {
  const d = (phone ?? '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length < 7) return 'X'.repeat(Math.max(d.length - 2, 0)) + d.slice(-2);
  const two = [
    '20',
    '27',
    '30',
    '31',
    '32',
    '33',
    '34',
    '36',
    '39',
    '40',
    '41',
    '43',
    '44',
    '45',
    '46',
    '47',
    '48',
    '49',
    '51',
    '52',
    '53',
    '54',
    '55',
    '56',
    '57',
    '58',
    '60',
    '61',
    '62',
    '63',
    '64',
    '65',
    '66',
    '81',
    '82',
    '84',
    '86',
    '90',
    '91',
    '92',
    '93',
    '94',
    '95',
    '98',
  ];
  const cc = ['1', '7'].includes(d[0])
    ? d[0]
    : two.includes(d.slice(0, 2))
      ? d.slice(0, 2)
      : d.slice(0, 3);
  return `+${cc} ${'X'.repeat(d.length - cc.length - 2)}${d.slice(-2)}`;
}

// ---------- Calls page and sidebar ----------

export const MISSED_WINDOW_DAYS = 7;

/** ISO start of the missed-calls window. */
export function missedWindowStart(now: number, days = MISSED_WINDOW_DAYS) {
  return new Date(now - days * 86_400_000).toISOString();
}

export function splitCallLog<T extends { startedAt: string }>(
  calls: T[],
  now: number,
  timeZone: string
): { today: T[]; older: T[] } {
  const today = dayKey(now, timeZone);
  const out = { today: [] as T[], older: [] as T[] };
  for (const c of calls)
    (dayKey(c.startedAt, timeZone) === today ? out.today : out.older).push(c);
  return out;
}

/** The start of today in the zone, as an instant (for ?from=). */
export function startOfDay(now: number, timeZone: string): string {
  const key = dayKey(now, timeZone);
  // Walk back from now to the first instant whose day is still today.
  let lo = now - 26 * 3_600_000;
  let hi = now;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (dayKey(mid, timeZone) === key) hi = mid;
    else lo = mid;
  }
  return new Date(hi).toISOString();
}

export interface MyPhone {
  extension: string | null;
  softphoneEnabled?: boolean;
  softphoneAvailable?: boolean;
}

/**
 * Staff only, and only with an extension of their own or a PBX in the
 * workspace. The status line needs an extension.
 */
export function callsSidebar(input: {
  isBankGuest: boolean;
  me: MyPhone | null;
  workspaceHasPbx: boolean;
}): {
  visible: boolean;
  line: { kind: 'softphone' | 'desk'; extension: string } | null;
} {
  const ext = input.me?.extension ?? null;
  if (input.isBankGuest || (!ext && !input.workspaceHasPbx))
    return { visible: false, line: null };
  if (!ext) return { visible: true, line: null };
  const soft = !!(input.me?.softphoneEnabled && input.me?.softphoneAvailable);
  return {
    visible: true,
    line: { kind: soft ? 'softphone' : 'desk', extension: ext },
  };
}

/** The inbox composer's one-shot prefill ("Draft WhatsApp"); never sent. */
export const COMPOSER_PREFILL_PREFIX = 'wacrm:composer-prefill:';

export function takeComposerPrefill(
  storage: Pick<Storage, 'getItem' | 'removeItem'> | null,
  conversationId: string
): string | null {
  if (!storage) return null;
  try {
    const key = COMPOSER_PREFILL_PREFIX + conversationId;
    const text = storage.getItem(key);
    if (text !== null) storage.removeItem(key);
    return text || null;
  } catch {
    return null;
  }
}
