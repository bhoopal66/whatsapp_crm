// Who holds the call. The engine outlives the room page: leaving the room
// mid-call keeps it (the float takes over); leaving a lobby or an end
// screen releases it, because attach() opened the camera and the mic.
// Pure and free of the DOM, so every rule below is tested with a fake
// engine; components/meetings/session wires it to React.

import type { TileSize } from '@/lib/meetings/room/contract';

const IN_CALL_PHASES: readonly string[] = ['joining', 'live', 'reconnecting'];

/** Whether this phase holds a seat, or is about to. */
export function isInCall(phase: string): boolean {
  return IN_CALL_PHASES.includes(phase);
}

export interface SessionEngineSnapshot {
  phase: string;
  error: string | null;
  meeting: { title: string } | null;
}

export interface SessionEngine {
  readonly meetingId: string;
  attach(): void;
  detach(): void;
  leave(): Promise<void>;
  subscribe(fn: () => void): () => void;
  getSnapshot(): SessionEngineSnapshot;
}

export interface HeldMeeting {
  meetingId: string;
  title: string;
}

export type OpenResult<E> =
  { kind: 'ready'; engine: E } | { kind: 'busy'; held: HeldMeeting };

/** How a call off the room page finished. */
export interface SessionEnded extends HeldMeeting {
  phase: string;
  error: string | null;
}

export interface SessionSnapshot<E> {
  engine: E | null;
  /** The held meeting's title, once the engine has loaded it. */
  title: string;
  /** Whether a room page is showing the held engine. */
  claimed: boolean;
}

interface Held<E> {
  engine: E;
  unsubscribe: () => void;
  claimed: boolean;
  wasInCall: boolean;
  /** takeOver is leaving this call: its end is not news. */
  replaced: boolean;
}

export interface MeetingSessionOptions {
  /** Runs `fn` on the next tick; the answer cancels it. */
  defer: (fn: () => void) => () => void;
  onEnded?: (ended: SessionEnded) => void;
}

export class MeetingSession<E extends SessionEngine> {
  private readonly defer: MeetingSessionOptions['defer'];
  private onEnded: MeetingSessionOptions['onEnded'];
  private held: Held<E> | null = null;
  private cancelRelease: (() => void) | null = null;
  // The meeting a takeOver is on its way to, while its await runs.
  private takeOverFor: string | null = null;
  private snap: SessionSnapshot<E> = {
    engine: null,
    title: '',
    claimed: false,
  };
  private readonly listeners = new Set<() => void>();

  constructor(options: MeetingSessionOptions) {
    this.defer = options.defer;
    this.onEnded = options.onEnded;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = () => this.snap;

  setOnEnded(fn: MeetingSessionOptions['onEnded']) {
    this.onEnded = fn;
  }

  /** A room page wants this meeting's engine. Safe to repeat. */
  open(meetingId: string, create: () => E): OpenResult<E> {
    const held = this.held;
    if (held?.engine.meetingId === meetingId) {
      // React's dev double-mount lands here: open, release, open.
      this.stopRelease();
      held.claimed = true;
      this.publish();
      return { kind: 'ready', engine: held.engine };
    }
    if (held) {
      if (isInCall(held.engine.getSnapshot().phase)) {
        return { kind: 'busy', held: heldMeeting(held.engine) };
      }
      this.drop(held);
    }
    const engine = create();
    const next: Held<E> = {
      engine,
      unsubscribe: () => {},
      claimed: true,
      wasInCall: false,
      replaced: false,
    };
    next.unsubscribe = engine.subscribe(() => this.onEngineChange(next));
    this.held = next;
    engine.attach();
    this.publish();
    return { kind: 'ready', engine };
  }

  /** The room page unmounted. Decided a tick later: it may be back. */
  release(meetingId: string) {
    if (this.takeOverFor === meetingId) this.takeOverFor = null;
    const held = this.held;
    if (!held || held.engine.meetingId !== meetingId || !held.claimed) return;
    this.stopRelease();
    this.cancelRelease = this.defer(() => {
      this.cancelRelease = null;
      held.claimed = false;
      if (isInCall(held.engine.getSnapshot().phase)) this.publish();
      else this.drop(held);
    });
  }

  /**
   * Leave the held call for this meeting. Null when the room page went
   * away during the wait, so nothing opens a camera with no page to show
   * it.
   */
  async takeOver(
    meetingId: string,
    create: () => E
  ): Promise<OpenResult<E> | null> {
    const held = this.held;
    if (held && held.engine.meetingId !== meetingId) {
      this.takeOverFor = meetingId;
      held.replaced = true;
      await held.engine.leave();
      if (this.held === held) this.drop(held);
      if (this.takeOverFor !== meetingId) return null;
      this.takeOverFor = null;
    }
    return this.open(meetingId, create);
  }

  /** The provider unmounted (sign-out): nothing outlives the shell. */
  dispose() {
    this.takeOverFor = null;
    if (this.held) this.drop(this.held);
  }

  private onEngineChange(held: Held<E>) {
    if (this.held !== held || held.replaced) return;
    const snap = held.engine.getSnapshot();
    if (isInCall(snap.phase)) {
      held.wasInCall = true;
    } else if (!held.claimed && held.wasInCall) {
      const finished = heldMeeting(held.engine);
      this.onEnded?.({ ...finished, phase: snap.phase, error: snap.error });
      this.drop(held);
      return;
    }
    this.publish();
  }

  private drop(held: Held<E>) {
    this.stopRelease();
    held.unsubscribe();
    this.held = null;
    held.engine.detach();
    this.publish();
  }

  private stopRelease() {
    this.cancelRelease?.();
    this.cancelRelease = null;
  }

  private publish() {
    const held = this.held;
    const engine = held?.engine ?? null;
    const title = engine?.getSnapshot().meeting?.title ?? '';
    const claimed = held?.claimed ?? false;
    const s = this.snap;
    if (s.engine === engine && s.title === title && s.claimed === claimed) {
      return;
    }
    this.snap = { engine, title, claimed };
    this.listeners.forEach((fn) => fn());
  }
}

function heldMeeting(engine: SessionEngine): HeldMeeting {
  return {
    meetingId: engine.meetingId,
    title: engine.getSnapshot().meeting?.title ?? '',
  };
}

export type EndedNoticeKey =
  'left' | 'ended' | 'removed' | 'elsewhere' | 'lost';

/** The toast for a call that finished off the room page. */
export function endedNotice(ended: Pick<SessionEnded, 'phase' | 'error'>): {
  key: EndedNoticeKey;
  rejoin: boolean;
} {
  if (ended.phase === 'ended' || ended.error === 'meeting_closed') {
    return { key: 'ended', rejoin: false };
  }
  if (ended.phase === 'removed') return { key: 'removed', rejoin: false };
  if (ended.error === 'seat_closed') return { key: 'elsewhere', rejoin: false };
  if (ended.phase === 'left') return { key: 'left', rejoin: true };
  return { key: 'lost', rejoin: true };
}

/**
 * Off the room nothing is drawn large, but nobody may stay frozen at the
 * room's last sizes or at 'hidden'. The real float refines this.
 */
export function offRoomTileSizes(
  participantIds: readonly string[],
  selfId: string | null
): Record<string, TileSize> {
  const sizes: Record<string, TileSize> = {};
  for (const id of participantIds) if (id !== selfId) sizes[id] = 'small';
  return sizes;
}

export const REJOIN_MARKER_KEY = 'meetings:rejoin';
export const REJOIN_MARKER_TTL_MS = 2 * 60 * 60 * 1000;

export interface RejoinMarker extends HeldMeeting {
  userId: string;
  at: number;
}

export function writeRejoinMarker(marker: RejoinMarker): string {
  return JSON.stringify(marker);
}

/** The marker this person may act on; null for anything else. */
export function readRejoinMarker(
  raw: string | null,
  userId: string | null,
  now: number
): RejoinMarker | null {
  if (!raw || !userId) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const m = value as Partial<RejoinMarker>;
  if (
    typeof m.meetingId !== 'string' ||
    !m.meetingId ||
    typeof m.title !== 'string' ||
    m.userId !== userId ||
    typeof m.at !== 'number'
  ) {
    return null;
  }
  const age = now - m.at;
  if (!(age >= 0 && age < REJOIN_MARKER_TTL_MS)) return null;
  return { meetingId: m.meetingId, title: m.title, userId, at: m.at };
}
