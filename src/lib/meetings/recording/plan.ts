// Recording a meeting on the host's own computer. Everything here is pure
// so the consent rules can be tested in node. UAE law makes recording
// without consent an offence, so the machine fails closed: nothing is
// captured until the flag that tells everyone has been accepted, and every
// stop clears that flag.

import type { RecordingFlagResult } from '@/lib/meetings/room/recording';

export const FRAME_WIDTH = 1280;
export const FRAME_HEIGHT = 720;
export const FRAME_FPS = 15;

export type RecorderState =
  'idle' | 'confirming' | 'starting' | 'recording' | 'stopping';

export type RecorderRefusal =
  Exclude<RecordingFlagResult, 'ok'> | 'start_failed';

export interface LayoutPerson<T> {
  id: string;
  name: string;
  camera: T | null;
  screen: T | null;
}

export interface LayoutBox<T> {
  personId: string;
  name: string;
  /** Null draws initials on a disc: a camera that is off. */
  track: T | null;
  fit: 'cover' | 'contain';
  x: number;
  y: number;
  w: number;
  h: number;
}

const MAX_GRID = 4;
const GAP = 8;
const CORNER_W = 256;
const CORNER_H = 144;

/** What is drawn: a shared screen, else the speaker, else up to four. */
export function recordingLayout<T>(input: {
  people: LayoutPerson<T>[];
  activeSpeakerId: string | null;
}): LayoutBox<T>[] {
  const { people, activeSpeakerId } = input;
  const speaker = people.find((p) => p.id === activeSpeakerId) ?? null;
  const sharer = people.find((p) => p.screen);
  const full = { x: 0, y: 0, w: FRAME_WIDTH, h: FRAME_HEIGHT };
  const camera = (p: LayoutPerson<T>) => ({
    personId: p.id,
    name: p.name,
    track: p.camera,
    fit: 'cover' as const,
  });
  if (sharer) {
    const screen: LayoutBox<T> = {
      personId: sharer.id,
      name: sharer.name,
      track: sharer.screen,
      fit: 'contain',
      ...full,
    };
    const corner = speaker ?? sharer;
    return [
      screen,
      {
        ...camera(corner),
        x: FRAME_WIDTH - CORNER_W - GAP,
        y: FRAME_HEIGHT - CORNER_H - GAP,
        w: CORNER_W,
        h: CORNER_H,
      },
    ];
  }
  if (speaker) return [{ ...camera(speaker), ...full }];
  const shown = people.slice(0, MAX_GRID);
  if (shown.length <= 1) return shown.map((p) => ({ ...camera(p), ...full }));
  const rows = shown.length > 2 ? 2 : 1;
  const w = FRAME_WIDTH / 2;
  const h = FRAME_HEIGHT / rows;
  return shown.map((p, i) => ({
    ...camera(p),
    x: (i % 2) * w,
    y: Math.floor(i / 2) * h,
    w,
    h,
  }));
}

const MIME_TYPES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function pickMimeType(
  isSupported: (type: string) => boolean
): string | null {
  return MIME_TYPES.find(isSupported) ?? null;
}

export function recordingFileName(title: string, date: Date): string {
  const safe = title
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const stamp = date.toISOString().slice(0, 16).replace(/[T:]/g, '-');
  return `${safe || 'meeting'}-${stamp}.webm`;
}

/** What the More menu offers. `null` hides it from a non-moderator. */
export function recordEntry(input: {
  canModerate: boolean;
  state: RecorderState;
  recordingBy: string | null;
  selfId: string | null;
}): 'start' | 'stop' | 'stopping' | 'taken' | null {
  const { canModerate, state, recordingBy, selfId } = input;
  if (state === 'recording') return 'stop';
  if (!canModerate) return null;
  if (state === 'starting' || state === 'stopping') return 'stopping';
  return recordingBy !== null && recordingBy !== selfId ? 'taken' : 'start';
}

export interface RecorderSink {
  /** Null when the browser chose the place: the downloads folder. */
  fileName: string | null;
  abort(): void;
}

/** Our own flag must read back within this, or nobody can be told. */
export const FLAG_SEEN_WITHIN_MS = 10_000;

/** How long a recorder that stopped itself gets to hand over its last data. */
export const LAST_DATA_WAIT_MS = 2_000;

/**
 * Ends a recording and closes its file. The file closes on every path: a
 * recorder that stopped itself on an error is already `inactive`, and
 * skipping the close there lost the file while the screen said saved. A
 * failed write or close rejects, so the caller can't report a save.
 */
export async function finishRecording(input: {
  recorder: { readonly state: string; stop(): void };
  /** Settles on the recorder's `stop` event. */
  ended: Promise<void>;
  /** Settles once every chunk reached the sink. */
  flushed: () => Promise<void>;
  sink: { close(): Promise<void> };
}): Promise<void> {
  const { recorder, ended, flushed, sink } = input;
  if (recorder.state !== 'inactive') {
    recorder.stop();
    await ended;
  } else {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, LAST_DATA_WAIT_MS);
    });
    await Promise.race([ended, late]);
    clearTimeout(timer);
  }
  try {
    await flushed();
  } finally {
    await sink.close();
  }
}

export interface RecorderDeps<S extends RecorderSink> {
  setFlag(on: boolean): Promise<RecordingFlagResult>;
  /** Null: the person cancelled the save dialog. */
  pickSink(): Promise<S | null>;
  /** Starts capture; the promise it returns from `stop` has saved the file. */
  begin(sink: S): Promise<{ stop(): Promise<void> }>;
  onChange(): void;
  onRefused(reason: RecorderRefusal): void;
  onSaved(fileName: string | null): void;
  onSaveFailed(): void;
  /** It ended by itself and the file is safe, but nobody chose to stop. */
  onInterrupted(): void;
  now(): number;
}

export interface RecorderMachine {
  readonly state: RecorderState;
  readonly startedAt: number | null;
  request(): void;
  cancel(): void;
  confirm(): Promise<void>;
  stop(opts?: { clearFlag?: boolean; interrupted?: boolean }): Promise<void>;
  /** The capture failed by itself: stop, save and say so. */
  interrupted(): void;
  /** Every change of who `call.recording` names, while we may record. */
  flagIs(holder: 'us' | 'nobody' | 'other'): void;
}

export function createRecorderMachine<S extends RecorderSink>(
  deps: RecorderDeps<S>
): RecorderMachine {
  let state: RecorderState = 'idle';
  let startedAt: number | null = null;
  let capture: { stop(): Promise<void> } | null = null;
  let flagSeen = false;
  let savedName: string | null = null;
  let stopWhileStarting = false;
  let flagCheck: ReturnType<typeof setTimeout> | undefined;
  const go = (next: RecorderState) => {
    state = next;
    deps.onChange();
  };
  const clearFlag = () => deps.setFlag(false).catch(() => 'failed' as const);

  const stop: RecorderMachine['stop'] = async (opts) => {
    if (state === 'starting') stopWhileStarting = true;
    if (state === 'confirming') go('idle');
    if (state !== 'recording') return;
    clearTimeout(flagCheck);
    go('stopping');
    let saved = true;
    try {
      await capture?.stop();
    } catch {
      saved = false;
    }
    // Whatever became of the file: the flag must not outlive the capture.
    if (opts?.clearFlag !== false) await clearFlag();
    capture = null;
    startedAt = null;
    go('idle');
    if (!saved) deps.onSaveFailed();
    else if (opts?.interrupted) deps.onInterrupted();
    else deps.onSaved(savedName);
  };

  return {
    get state() {
      return state;
    },
    get startedAt() {
      return startedAt;
    },
    request() {
      if (state === 'idle') go('confirming');
    },
    cancel() {
      if (state === 'confirming') go('idle');
    },
    async confirm() {
      if (state !== 'confirming') return;
      go('starting');
      stopWhileStarting = false;
      let sink: S | null = null;
      const refuse = (reason: RecorderRefusal) => {
        sink?.abort();
        go('idle');
        deps.onRefused(reason);
      };
      try {
        // First: the save dialog needs the click's user activation.
        sink = await deps.pickSink();
      } catch {
        return refuse('start_failed');
      }
      if (!sink) return go('idle');
      if (stopWhileStarting) {
        sink.abort();
        return go('idle');
      }
      const answer = await deps.setFlag(true).catch(() => 'failed' as const);
      if (answer !== 'ok') return refuse(answer);
      if (stopWhileStarting) {
        sink.abort();
        await clearFlag();
        return go('idle');
      }
      try {
        capture = await deps.begin(sink);
        savedName = sink.fileName;
      } catch {
        await clearFlag();
        return refuse('start_failed');
      }
      flagSeen = false;
      startedAt = deps.now();
      // A flag cleared while the capture was starting never reads as
      // ours, and a vanished flag only stops a recording once it was seen.
      flagCheck = setTimeout(() => {
        if (!flagSeen) void stop({ interrupted: true });
      }, FLAG_SEEN_WITHIN_MS);
      go('recording');
      if (stopWhileStarting) await stop();
    },
    stop,
    interrupted() {
      void stop({ interrupted: true });
    },
    flagIs(holder) {
      if (state !== 'recording') return;
      if (holder === 'us') {
        flagSeen = true;
        return;
      }
      // People were told it stopped, so it stops. Someone else's new
      // recording keeps its own flag.
      if (holder === 'other') void stop({ clearFlag: false });
      else if (flagSeen) void stop();
    },
  };
}
