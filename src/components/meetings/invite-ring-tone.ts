// The invite's ringtone. Browser-only; every failure is swallowed (a
// missing sound must never cost the person the pop-up).

import { RING_GAIN, ringNotes } from '@/lib/meetings/invite-ring';

import { audioContextClass } from './room/room-sounds';

const LOCK_NAME = 'meeting-invite-ring';
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

/** Starts the ring in this tab, if it may; answers how to stop it. */
export function startRingTone(): () => void {
  try {
    // The browser would block the sound, and holding the lock would then
    // silence a tab that could ring.
    if (navigator.userActivation?.hasBeenActive === false) return noop;
    if (!navigator.locks) return play();
    // One tab of the browser rings: the rest find the lock taken.
    let stopped = false;
    let stopPlaying = noop;
    let release = noop;
    void navigator.locks
      .request(LOCK_NAME, { ifAvailable: true }, (lock) => {
        if (!lock || stopped) return;
        stopPlaying = play();
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      })
      .catch(noop);
    return () => {
      stopped = true;
      stopPlaying();
      release();
    };
  } catch {
    return noop;
  }
}
