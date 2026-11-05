// The invite's ringtone. Browser-only; every failure is swallowed (a
// missing sound must never cost the person the pop-up).

import { RING_GAIN, ringNotes } from '@/lib/meetings/invite-ring';

import { audioContextClass } from './room/room-sounds';

const LOCK_NAME = 'meeting-invite-ring';
/**
 * How long a tab keeps the lock after it stops ringing. The tabs waiting
 * behind it hear the same answer a moment later, over realtime, and must
 * not play a note in between.
 */
export const LINGER_MS = 1_500;
const SILENT = 0.0001;
const ATTACK_S = 0.02;

const noop = () => {};

/**
 * Lays the whole ring on the audio clock up front. No setInterval: hidden
 * tabs throttle timers, and a schedule that ends by itself is the safety
 * net if nothing ever stops it.
 */
function play(): () => void {
  const Ctx = audioContextClass();
  if (!Ctx) return noop;
  const ctx = new Ctx();
  const stop = () => {
    void ctx.close().catch(noop);
  };
  try {
    // Not awaited: while blocked this promise may never settle.
    void ctx.resume().catch(noop);
    const amp = ctx.createGain();
    amp.gain.value = SILENT;
    amp.connect(ctx.destination);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.connect(amp);
    const t0 = ctx.currentTime + ATTACK_S;
    let end = t0;
    for (const note of ringNotes()) {
      const at = t0 + note.atMs / 1000;
      end = at + note.ms / 1000;
      osc.frequency.setValueAtTime(note.hz, at);
      amp.gain.setValueAtTime(SILENT, at);
      amp.gain.exponentialRampToValueAtTime(RING_GAIN, at + ATTACK_S);
      amp.gain.exponentialRampToValueAtTime(SILENT, end);
    }
    osc.start(t0);
    osc.stop(end);
  } catch {
    stop();
    return noop;
  }
  return stop;
}

/**
 * Starts the ring, if this tab may; answers how to stop it. One tab of the
 * browser rings and the others wait in line, so the ring moves on if that
 * tab closes, and comes back when a call ends (holdRingSilent).
 */
export function startRingTone(): () => void {
  try {
    // The browser would block the sound, and a place in the line would
    // then silence a tab that could ring.
    if (navigator.userActivation?.hasBeenActive === false) return noop;
    const { locks } = navigator;
    if (!locks) return play();
    const waiting = new AbortController();
    let stopped = false;
    let stopPlaying = noop;
    let release: (() => void) | null = null;
    const takeTurn = () => {
      locks
        .request(LOCK_NAME, { signal: waiting.signal }, () => {
          if (stopped) return;
          stopPlaying = play();
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        })
        .catch((err: unknown) => {
          stopPlaying();
          stopPlaying = noop;
          release = null;
          // Only a steal comes back: a tab went into a call. Anything else
          // would fail the same way again.
          const stolen = (err as Error | null)?.name === 'AbortError';
          if (stolen && !stopped) takeTurn();
        });
    };
    takeTurn();
    return () => {
      stopped = true;
      waiting.abort();
      stopPlaying();
      stopPlaying = noop;
      if (release) setTimeout(release, LINGER_MS);
    };
  } catch {
    return noop;
  }
}

/**
 * While this tab is in a meeting or on a call it holds the ring's lock, so
 * no tab of the browser rings: a meeting lives in one tab, and the others
 * cannot see it. It steals the lock, which stops a ring already going in
 * another tab; that ring takes its place in line again. Answers how to let
 * go.
 */
export function holdRingSilent(): () => void {
  try {
    if (!navigator.locks) return noop;
    let done = false;
    let release = noop;
    void navigator.locks
      .request(LOCK_NAME, { steal: true }, () => {
        if (done) return;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      })
      .catch(noop);
    return () => {
      done = true;
      release();
    };
  } catch {
    return noop;
  }
}
