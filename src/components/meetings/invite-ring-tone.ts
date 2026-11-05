// The invite's ringtone. Browser-only; every failure is swallowed (a
// missing sound must never cost the person the pop-up).

import { RING_GAIN, ringNotes } from '@/lib/meetings/invite-ring';

import { audioContextClass } from './room/room-sounds';

// Exclusive: the one tab of the browser that rings.
const RING_LOCK = 'meeting-invite-ring';
// Shared: every tab in a call. A ring gets past it before it plays. Tabs
// must never take this one from each other: when one call ended, another
// tab's call would be left unprotected.
const BUSY_LOCK = 'meeting-invite-busy';
/**
 * How long a tab keeps the ring lock after it stops. The tabs waiting
 * behind it hear the same answer a moment later, over realtime, and must
 * not play a note in between. Over a slow tunnel that takes over a second.
 */
export const LINGER_MS = 3_000;
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
    let stopped = false;
    let turn: AbortController | null = null;
    let stopPlaying = noop;
    let release: (() => void) | null = null;
    const takeTurn = () => {
      const mine = new AbortController();
      turn = mine;
      locks
        .request(RING_LOCK, { signal: mine.signal }, async () => {
          // Waits out every tab in a call, then lets go at once: a tab must
          // be able to go into a call during the ring.
          await locks.request(BUSY_LOCK, { signal: mine.signal }, noop);
          if (mine.signal.aborted) return;
          stopPlaying = play();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        })
        .catch((err: unknown) => {
          mine.abort();
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
      turn?.abort();
      stopPlaying();
      stopPlaying = noop;
      if (release) setTimeout(release, LINGER_MS);
    };
  } catch {
    return noop;
  }
}

/**
 * While this tab is in a meeting or on a call, no tab of the browser rings:
 * a meeting lives in one tab, and the others cannot see it. Answers how to
 * let go.
 */
export function holdRingSilent(): () => void {
  try {
    const { locks } = navigator;
    if (!locks) return noop;
    let done = false;
    let release = noop;
    void locks
      .request(BUSY_LOCK, { mode: 'shared' }, () => {
        if (done) return;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      })
      .catch(noop);
    // Cuts off a ring already going. It queues again, and comes back once
    // every tab has let go.
    void locks.request(RING_LOCK, { steal: true }, noop).catch(noop);
    return () => {
      done = true;
      release();
    };
  } catch {
    return noop;
  }
}
