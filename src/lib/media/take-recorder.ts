/**
 * One voice recording, from the mic press to the encoded file: shared by
 * the inbox, group and team-chat composers and the saved voice notes
 * dialog (through `hooks/use-voice-recorder.ts`). No React and no DOM, so
 * it is tested with a fake recorder.
 *
 * What opus-recorder leaves to its caller:
 * - stop() while start() still waits (the permission prompt, the encoder
 *   download) does nothing, and the mic opens afterwards anyway: a start
 *   cancelled meanwhile is released when it settles.
 * - stop() leaves its AudioContext open. Each one keeps an audio thread
 *   running, and Safari refuses new ones after a few: it is closed after
 *   every take.
 * - the file comes in a callback after stop(), so it carries what the
 *   person pressed: listen first, or send.
 */

/** `finishing`: the mic is closed, the file is being encoded. */
export type RecordingPhase = 'idle' | 'starting' | 'recording' | 'finishing';

/** What ends a take: it is listened to first, or sent as it is. */
export type TakeIntent = 'review' | 'send';

/** Why there is no recording, as the person can act on it. */
export type MicProblem =
  | 'unsupported'
  | 'blocked'
  | 'missing'
  | 'inUse'
  | 'failed'
  /** Recorded, but the encoder gave no file. */
  | 'lost';

/** The part of opus-recorder used here. */
export interface RecorderLike {
  ondataavailable: ((bytes: Uint8Array) => void) | null;
  start(): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
}

export interface RecordedTake<M> {
  /** The whole Ogg/Opus file; never empty. */
  bytes: Uint8Array;
  durationMs: number;
  intent: TakeIntent;
  meta: M;
}

/**
 * Send and Stop stand where the mic was, so the second tap of a double
 * tap on the mic lands on them: a take this short is not ended by it.
 */
export const MIN_TAKE_MS = 700;

/** An encoder that never answers must not hold the composer for ever. */
export const STOP_TIMEOUT_MS = 10_000;

/** A refused getUserMedia (or encoder load) in terms a person can act on. */
export function micProblem(err: unknown): MicProblem {
  const name =
    typeof err === 'object' && err !== null && 'name' in err
      ? String((err as { name: unknown }).name)
      : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'blocked';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'missing';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'inUse';
    default:
      return 'failed';
  }
}

/** Resolves when `p` settles, or after `ms`. */
function settled(p: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const id = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(id);
      resolve();
    };
    p.then(done, done);
  });
}

/** Frees the mic, then the audio graph. Never throws. */
async function release(recorder: RecorderLike): Promise<void> {
  try {
    await settled(recorder.stop(), STOP_TIMEOUT_MS);
  } catch {
    // stop() threw: close() below still frees the mic.
  }
  try {
    await recorder.close();
  } catch {
    // Already closed.
  }
}

interface Session<M, R> {
  meta: M;
  recorder: R | null;
  cancelled: boolean;
  delivered: boolean;
  intent: TakeIntent;
  startedAt: number;
  durationMs: number;
}

export interface TakeRecorderDeps<M, R extends RecorderLike> {
  /** Loads the encoder and builds a recorder. */
  create: () => Promise<R>;
  /** Milliseconds on a clock that never jumps (performance.now). */
  now: () => number;
  onPhase: (phase: RecordingPhase) => void;
  onTake: (take: RecordedTake<M>) => void;
  onProblem: (problem: MicProblem) => void;
}

/** One recording at a time; `meta` travels with the take to its file. */
export class TakeRecorder<M, R extends RecorderLike = RecorderLike> {
  private readonly deps: TakeRecorderDeps<M, R>;
  private session: Session<M, R> | null = null;
  private current: RecordingPhase = 'idle';

  constructor(deps: TakeRecorderDeps<M, R>) {
    this.deps = deps;
  }

  get phase(): RecordingPhase {
    return this.current;
  }

  /** The open recorder, for the level meter; null unless recording. */
  get live(): R | null {
    return this.current === 'recording'
      ? (this.session?.recorder ?? null)
      : null;
  }

  /** How long the mic has been open; 0 unless recording. */
  elapsedMs(): number {
    return this.current === 'recording' && this.session
      ? this.deps.now() - this.session.startedAt
      : 0;
  }

  /** Opens the mic. False when one is open already, or it did not open. */
  async start(meta: M): Promise<boolean> {
    if (this.current !== 'idle') return false;
    const s: Session<M, R> = {
      meta,
      recorder: null,
      cancelled: false,
      delivered: false,
      intent: 'review',
      startedAt: 0,
      durationMs: 0,
    };
    this.session = s;
    this.setPhase('starting');
    let recorder: R | null = null;
    try {
      recorder = await this.deps.create();
      if (!s.cancelled) {
        s.recorder = recorder;
        recorder.ondataavailable = (bytes) => this.deliver(s, bytes);
        await recorder.start();
      }
    } catch (err) {
      if (recorder) void release(recorder);
      if (s.cancelled) return false;
      this.end(s);
      this.deps.onProblem(micProblem(err));
      return false;
    }
    if (s.cancelled) {
      void release(recorder);
      return false;
    }
    s.startedAt = this.deps.now();
    this.setPhase('recording');
    return true;
  }

  /**
   * Ends the take; its file arrives through `onTake` with `intent` and
   * `meta`. False when nothing is being recorded, or only just began.
   */
  finish(intent: TakeIntent, meta?: Partial<M>): boolean {
    const s = this.session;
    if (!s?.recorder || this.current !== 'recording') return false;
    const ms = this.elapsedMs();
    if (ms < MIN_TAKE_MS) return false;
    s.intent = intent;
    s.durationMs = ms;
    if (meta) s.meta = { ...s.meta, ...meta };
    this.setPhase('finishing');
    void release(s.recorder).then(() => {
      const lost = !s.delivered && !s.cancelled;
      this.end(s);
      if (lost) this.deps.onProblem('lost');
    });
    return true;
  }

  /** Throws the take away and frees the mic. */
  cancel(): void {
    const s = this.session;
    if (!s) return;
    s.cancelled = true;
    // While starting there is nothing to stop yet: start() frees it.
    if (this.current === 'recording' && s.recorder) void release(s.recorder);
    this.end(s);
  }

  /** Its chat is left: the take ends there, to be listened to. */
  leave(): void {
    if (this.current === 'finishing') return;
    if (!this.finish('review')) this.cancel();
  }

  /** The composer is going away. What was already sent still goes out. */
  dispose(): void {
    if (this.current === 'finishing' && this.session?.intent === 'send') return;
    this.cancel();
  }

  private deliver(s: Session<M, R>, bytes: Uint8Array): void {
    if (s.cancelled || s.delivered || bytes.byteLength === 0) return;
    s.delivered = true;
    this.deps.onTake({
      bytes,
      durationMs: s.durationMs,
      intent: s.intent,
      meta: s.meta,
    });
  }

  private end(s: Session<M, R>): void {
    if (this.session !== s) return;
    this.session = null;
    this.setPhase('idle');
  }

  private setPhase(phase: RecordingPhase): void {
    if (this.current === phase) return;
    this.current = phase;
    this.deps.onPhase(phase);
  }
}
