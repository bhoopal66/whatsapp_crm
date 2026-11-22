// Reminder alarms: which bell rows ring, and the queue of ringing cards.
//
// The reminder sweep (migration 197) writes these `notifications` rows:
//   - task_due, meta {task_id, offset: 15}: the quiet heads-up. A bell
//     row only, never an alarm.
//   - task_due, meta {task_id, offset: 0}: the task falls due. An alarm.
//   - meeting_reminder, meta {meeting_id, offset: 10 | 0} (rows from
//     before 197 have no offset). Both are alarms.
//   - event_reminder, meta {event_id, occurrence_start, offset}. Alarms.
//
// Pure and free of the DOM, modelled on lib/meetings/invite-ring.ts, so
// every rule is tested with fake timers. For the card's builder:
//
//   const queue = new AlarmQueue({ chime: playAlarmChime });
//     // components/reminders/alarm-tone.ts; one queue per mounted shell
//   queue.seed(unreadRowsReadOnLoad, Date.now());
//   onBellChange((change) => queue.handle(change));
//     // the NotificationChange the bell provider already emits
//   const alarms = useSyncExternalStore(queue.subscribe, queue.getSnapshot,
//     queue.getSnapshot);   // newest first, a stable array
//   visibleAlarms(alarms)  // { shown: first ALARM_MAX_VISIBLE, hidden: n }
//   queue.setBusy(inMeetingOrPhoneCall);  // card shows, chime does not
//   Done / Snooze / dismiss: mark the row read (the UPDATE removes it on
//     every tab), and queue.remove(alarm.id) for this tab at once.
//     Snooze moves the task's due_at to snoozeUntil(option, new Date()).
//   While the tab is hidden: flashTitle(tabTitle.base(), alarms[0].title,
//     tick++) on an interval through lib/tab-alerts/title-owner.ts (the
//     unread tab title stands down meanwhile); its current title comes
//     back when visible.
//   Unmount: queue.close().
//
// Alarms of every workspace the person belongs to arrive (the bell covers
// them all, `my_live_account_ids`); `accountId` lets the card tell them
// apart. The queue does not filter by workspace.

import type { NotificationChange } from '@/lib/notifications/store';
import { isUuid } from '@/lib/meetings/requests';
import type { Notification } from '@/types';

export const ALARM_TYPES = [
  'task_due',
  'event_reminder',
  'meeting_reminder',
] as const;
export type AlarmType = (typeof ALARM_TYPES)[number];

/** A row older than this is left to the bell. */
export const ALARM_MAX_AGE_MS = 2 * 60 * 60 * 1000;
/** A row read on page load chimes only if it is younger than this. */
export const ALARM_CHIME_FRESH_MS = 2 * 60 * 1000;
/** Cards the stack shows at once; the rest are counted. */
export const ALARM_MAX_VISIBLE = 3;
/** The chime repeats this often while the alarm stays. */
export const ALARM_REPEAT_MS = 60_000;
/** At most this many chimes per alarm. */
export const ALARM_MAX_CHIMES = 3;

export type AlarmKind = 'task' | 'event' | 'meeting';

export interface Alarm {
  /** The notification id. */
  id: string;
  kind: AlarmKind;
  title: string;
  body: string | null;
  accountId: string;
  taskId: string | null;
  eventId: string | null;
  meetingId: string | null;
  contactId: string | null;
  conversationId: string | null;
  /** created_at, epoch ms. */
  createdAt: number;
  /** Minutes before the start/due time; null on a pre-197 meeting row. */
  offset: number | null;
  /** Read on page load too late to chime: shown silently. */
  missed: boolean;
  row: Notification;
}

export interface AlarmDeps {
  /**
   * Plays the chime once. `n` is the repeat number (0, 1, 2), so the
   * tone can hand each repeat to exactly one tab of the browser.
   */
  chime: (alarmId: string, n: number) => void;
}

const KIND_OF: Record<AlarmType, AlarmKind> = {
  task_due: 'task',
  event_reminder: 'event',
  meeting_reminder: 'meeting',
};

const uuidOrNull = (v: unknown): string | null => (isUuid(v) ? v : null);

/** The alarm an unread bell row rings, or null if it does not ring. */
export function alarmFor(row: Notification, now: number): Alarm | null {
  if (!row || row.read_at || !row.id) return null;
  if (!(ALARM_TYPES as readonly string[]).includes(row.type)) return null;
  const type = row.type as AlarmType;
  const meta = row.meta ?? {};
  const offset = typeof meta.offset === 'number' ? meta.offset : null;
  const taskId = uuidOrNull(meta.task_id);
  const eventId = uuidOrNull(meta.event_id);
  const meetingId = uuidOrNull(meta.meeting_id);
  switch (type) {
    case 'task_due':
      // No offset, or 15: the quiet heads-up.
      if (offset !== 0 || !taskId) return null;
      break;
    case 'meeting_reminder':
      if (!meetingId) return null;
      break;
    case 'event_reminder':
      if (!eventId) return null;
      break;
    default: {
      const never: never = type;
      return never;
    }
  }
  const createdAt = Date.parse(row.created_at);
  if (!Number.isFinite(createdAt) || now - createdAt > ALARM_MAX_AGE_MS) {
    return null;
  }
  return {
    id: row.id,
    kind: KIND_OF[type],
    title: row.title,
    body: row.body ?? null,
    accountId: row.account_id,
    taskId: type === 'task_due' ? taskId : null,
    eventId: type === 'event_reminder' ? eventId : null,
    meetingId: type === 'meeting_reminder' ? meetingId : null,
    contactId: uuidOrNull(row.contact_id),
    conversationId: uuidOrNull(row.conversation_id),
    createdAt,
    offset,
    missed: false,
    row,
  };
}

/** The cards to show and how many more are waiting behind them. */
export function visibleAlarms(alarms: readonly Alarm[]): {
  shown: Alarm[];
  hidden: number;
} {
  return {
    shown: alarms.slice(0, ALARM_MAX_VISIBLE),
    hidden: Math.max(0, alarms.length - ALARM_MAX_VISIBLE),
  };
}

interface Entry {
  alarm: Alarm;
  chimes: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * The ringing alarms, an external store for useSyncExternalStore. Each
 * alarm chimes on arrival and again every ALARM_REPEAT_MS while it stays,
 * at most ALARM_MAX_CHIMES times. While busy (in a meeting or on a phone
 * call) the cards show but nothing chimes, and a skipped chime is not
 * counted: it comes on a later repeat. Repeats stop once the row is older
 * than ALARM_MAX_AGE_MS.
 */
export class AlarmQueue {
  private readonly deps: AlarmDeps;
  private readonly listeners = new Set<() => void>();
  private readonly entries = new Map<string, Entry>();
  private snapshot: Alarm[] = [];
  private busy = false;

  constructor(deps: AlarmDeps) {
    this.deps = deps;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  /** Newest first; the same array until something changes. */
  getSnapshot = (): Alarm[] => this.snapshot;

  /** A realtime change on the reader's bell rows. */
  handle(change: NotificationChange): void {
    if (change.type === 'insert') {
      const alarm = alarmFor(change.row, Date.now());
      if (alarm && this.add(alarm, true)) this.emit();
      return;
    }
    if (change.type === 'update' && !change.row.read_at) return;
    if (change.row.id) this.remove(change.row.id);
  }

  /**
   * Unread rows read on page load. Only those younger than
   * ALARM_CHIME_FRESH_MS chime; the rest show silently, flagged missed.
   */
  seed(rows: readonly Notification[], now: number): void {
    let changed = false;
    for (const row of rows) {
      const alarm = alarmFor(row, now);
      if (!alarm) continue;
      const fresh = now - alarm.createdAt <= ALARM_CHIME_FRESH_MS;
      if (this.add(fresh ? alarm : { ...alarm, missed: true }, fresh)) {
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.clearTimer(entry);
    this.entries.delete(id);
    this.emit();
  }

  /** In a meeting or on a phone call: no chime, the card still shows. */
  setBusy(busy: boolean): void {
    this.busy = busy;
  }

  close(): void {
    for (const entry of this.entries.values()) this.clearTimer(entry);
    if (this.entries.size === 0) return;
    this.entries.clear();
    this.emit();
  }

  private add(alarm: Alarm, chime: boolean): boolean {
    if (this.entries.has(alarm.id)) return false;
    const entry: Entry = { alarm, chimes: 0, timer: null };
    this.entries.set(alarm.id, entry);
    if (chime) this.ring(entry);
    return true;
  }

  private ring(entry: Entry): void {
    entry.timer = null;
    if (this.entries.get(entry.alarm.id) !== entry) return;
    if (!this.busy) {
      this.deps.chime(entry.alarm.id, entry.chimes);
      entry.chimes += 1;
    }
    if (entry.chimes >= ALARM_MAX_CHIMES) return;
    if (Date.now() - entry.alarm.createdAt >= ALARM_MAX_AGE_MS) return;
    entry.timer = setTimeout(() => this.ring(entry), ALARM_REPEAT_MS);
  }

  private clearTimer(entry: Entry): void {
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
  }

  private emit(): void {
    this.snapshot = [...this.entries.values()]
      .map((e) => e.alarm)
      .sort((a, b) => b.createdAt - a.createdAt);
    for (const fn of this.listeners) fn();
  }
}

export const SNOOZE_OPTIONS = ['10m', '1h', 'tomorrow'] as const;
export type SnoozeOption = (typeof SNOOZE_OPTIONS)[number];

/** When a snoozed alarm comes back. Tomorrow is 09:00 local time. */
export function snoozeUntil(option: SnoozeOption, now: Date): Date {
  switch (option) {
    case '10m':
      return new Date(now.getTime() + 10 * 60 * 1000);
    case '1h':
      return new Date(now.getTime() + 60 * 60 * 1000);
    case 'tomorrow':
      return new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
        9,
        0,
        0,
        0
      );
    default: {
      const never: never = option;
      throw new Error(`Unknown snooze option: ${String(never)}`);
    }
  }
}

/** The tab title on a given tick of the flash: even ticks restore it. */
export function flashTitle(
  original: string,
  alarmTitle: string,
  tick: number
): string {
  return tick % 2 === 0 ? original : `⏰ ${alarmTitle}`;
}
