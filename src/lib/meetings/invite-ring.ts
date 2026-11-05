// When a meeting invite rings. A realtime `meeting_invite` bell row turns
// into the shell's ringing card only for a meeting happening now: an
// instant one, or a scheduled one someone is already in. Pure and free of
// the DOM, so every rule is tested with fake timers;
// components/meetings/meeting-invite-card.tsx wires it to React.

import type { NotificationChange } from '@/lib/notifications/store';
import type { Notification } from '@/types';

import { isUuid } from './requests';
import { canJoinMeeting, type MeetingDetailData } from './schedule';
import { isInCall } from './session/session';

/** Rings this long, then leaves the invite to the bell. */
export const RING_MS = 60_000;
/** Re-reads the meeting this often while ringing. */
export const RING_CHECK_MS = 5_000;
export const RING_GAIN = 0.25;
/** What migration 106's trigger writes for an instant meeting. */
export const STARTING_NOW_BODY = 'Starting now';

const RING_EVERY_MS = 2_200;
const LOW_NOTE = { hz: 880, ms: 180 };
const HIGH_NOTE = { hz: 1175, ms: 260 };

export interface RingNote {
  atMs: number;
  hz: number;
  ms: number;
}

/**
 * The whole ring, laid out in advance. It is finite and ends by RING_MS,
 * so a tab frozen before its timer fires cannot ring forever.
 */
export function ringNotes(): RingNote[] {
  const notes: RingNote[] = [];
  const length = LOW_NOTE.ms + HIGH_NOTE.ms;
  for (let at = 0; at + length <= RING_MS; at += RING_EVERY_MS) {
    notes.push({ atMs: at, ...LOW_NOTE });
    notes.push({ atMs: at + LOW_NOTE.ms, ...HIGH_NOTE });
  }
  return notes;
}

/** 'gone' is a 404; null is a failed read, which says nothing. */
export type MeetingRead = MeetingDetailData | 'gone' | null;

export interface RingerContext {
  activeWorkspaceId: string | null;
  pathname: string;
  heldMeetingId: string | null;
  /** In a meeting or on a phone call: the card shows, the tone does not. */
  busy: boolean;
}

export interface RingerDeps {
  readMeeting: (meetingId: string) => Promise<MeetingRead>;
  /** Starts the tone and answers how to stop it. */
  startTone: () => () => void;
}

/** The meeting an unread invite row is for, or null if it is not one. */
export function inviteMeetingId(row: Notification): string | null {
  if (row.type !== 'meeting_invite' || row.read_at) return null;
  const id = row.meta?.meeting_id;
  return isUuid(id) ? id : null;
}

/** Where Join goes: the lobby, never straight into the call. */
export function meetingRoomPath(meetingId: string): string {
  return `/meetings/${meetingId}/room`;
}

/** In a meeting or on a phone call, as this tab can see. */
export function isRingerBusy(
  meetingPhase: string | null,
  phone: { ringing: unknown; panel: { endedAt: unknown } | null } | null
): boolean {
  if (meetingPhase !== null && isInCall(meetingPhase)) return true;
  if (!phone) return false;
  return !!phone.ringing || (!!phone.panel && phone.panel.endedAt === null);
}

function canEnter(read: MeetingRead): read is MeetingDetailData {
  return (
    read !== null &&
    read !== 'gone' &&
    canJoinMeeting(read.meeting) &&
    !read.lockedAt
  );
}

export class InviteRinger {
  private readonly deps: RingerDeps;
  private readonly listeners = new Set<() => void>();
  private ctx: RingerContext = {
    activeWorkspaceId: null,
    pathname: '',
    heldMeetingId: null,
    busy: false,
  };
  private ringing: { row: Notification; meetingId: string } | null = null;
  private stopTone: (() => void) | null = null;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  /** Scheduled invites whose first read is out: row id → arrival order. */
  private readonly pending = new Map<string, number>();
  private arrivals = 0;
  private ringingArrival = 0;

  constructor(deps: RingerDeps) {
    this.deps = deps;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): Notification | null => this.ringing?.row ?? null;

  setContext(ctx: RingerContext): void {
    this.ctx = ctx;
    if (!this.ringing) return;
    if (this.alreadyThere(this.ringing.meetingId)) this.end();
    else this.syncTone();
  }

  handle(change: NotificationChange): void {
    if (change.type === 'insert') {
      this.invited(change.row);
      return;
    }
    if (change.type === 'update' && !change.row.read_at) return;
    const { id } = change.row;
    if (!id) return;
    this.pending.delete(id);
    if (this.ringing?.row.id === id) this.end();
  }

  close(): void {
    this.pending.clear();
    this.end();
  }

  private invited(row: Notification): void {
    const meetingId = inviteMeetingId(row);
    if (!meetingId || this.alreadyThere(meetingId)) return;
    const arrival = ++this.arrivals;
    if (row.body === STARTING_NOW_BODY) {
      this.ring(row, meetingId, arrival);
      return;
    }
    if (this.inOtherWorkspace(row)) return;
    this.pending.set(row.id, arrival);
    void this.deps.readMeeting(meetingId).then((read) => {
      if (!this.pending.delete(row.id)) return;
      if (arrival < this.ringingArrival) return;
      if (!canEnter(read) || read.meeting.presentCount === 0) return;
      if (!this.alreadyThere(meetingId)) this.ring(row, meetingId, arrival);
    });
  }

  private ring(row: Notification, meetingId: string, arrival: number): void {
    this.clearRing();
    this.ringing = { row, meetingId };
    this.ringingArrival = arrival;
    this.syncTone();
    this.endTimer = setTimeout(() => this.end(), RING_MS);
    this.checkTimer = setInterval(() => this.check(), RING_CHECK_MS);
    this.emit();
    this.check();
  }

  /** A closed meeting must not go on ringing. */
  private check(): void {
    const ringing = this.ringing;
    if (!ringing) return;
    // The endpoint reads the active workspace: its 404 means nothing here.
    if (this.inOtherWorkspace(ringing.row)) return;
    void this.deps.readMeeting(ringing.meetingId).then((read) => {
      if (this.ringing !== ringing || read === null) return;
      if (!canEnter(read)) this.end();
    });
  }

  private end(): void {
    if (!this.ringing) return;
    this.clearRing();
    this.ringing = null;
    this.emit();
  }

  private clearRing(): void {
    if (this.endTimer !== null) clearTimeout(this.endTimer);
    if (this.checkTimer !== null) clearInterval(this.checkTimer);
    this.endTimer = null;
    this.checkTimer = null;
    this.silence();
  }

  private syncTone(): void {
    if (this.ctx.busy) this.silence();
    else if (!this.stopTone) this.stopTone = this.deps.startTone();
  }

  private silence(): void {
    this.stopTone?.();
    this.stopTone = null;
  }

  private alreadyThere(meetingId: string): boolean {
    return (
      this.ctx.heldMeetingId === meetingId ||
      this.ctx.pathname === meetingRoomPath(meetingId)
    );
  }

  /** As notificationRow: an unknown active workspace counts as the same. */
  private inOtherWorkspace(row: Notification): boolean {
    const active = this.ctx.activeWorkspaceId;
    return !!active && !!row.account_id && row.account_id !== active;
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
