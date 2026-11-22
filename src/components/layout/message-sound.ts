// The "new customer message" sound (TabAlerts, off by default). A soft
// two-note blip made with WebAudio, so no asset ships. Browser-only;
// every failure is swallowed: a missing sound never costs anything else.
//
// Only one tab of the browser plays per throttle window: the tab that
// takes MESSAGE_SOUND_LOCK (`ifAvailable`) plays and holds it for the
// window, and a tab that finds it taken stays silent, never queues.
// Without Web Locks every tab plays (each still throttled on its own).
//
// While any tab holds the meeting ringer's busy lock (a meeting or a
// call is live), nobody plays: a blip in someone's call is worse than
// none, and the reminder chime keeps the same rule (alarm-tone.ts).

import { BUSY_LOCK } from '@/components/meetings/invite-ring-tone';
import { audioContextClass } from '@/components/meetings/room/room-sounds';
import { MESSAGE_SOUND_THROTTLE_MS } from '@/lib/tab-alerts/message-sound';

export const MESSAGE_SOUND_LOCK = 'wacrm-message-sound';

const GAIN = 0.2;
const NOTES: ReadonlyArray<{ atMs: number; hz: number; ms: number }> = [
  { atMs: 0, hz: 880, ms: 90 },
  { atMs: 110, hz: 1175, ms: 120 },
];
const SILENT = 0.0001;
const ATTACK_S = 0.01;
const CLOSE_AFTER_MS = 400;

const noop = () => {};

/** Lays the blip on the audio clock up front: nothing to stop. */
function play(): void {
  const Ctx = audioContextClass();
  if (!Ctx) return;
  const ctx = new Ctx();
  const close = () => {
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
    for (const note of NOTES) {
      const at = t0 + note.atMs / 1000;
      end = at + note.ms / 1000;
      osc.frequency.setValueAtTime(note.hz, at);
      amp.gain.setValueAtTime(SILENT, at);
      amp.gain.exponentialRampToValueAtTime(GAIN, at + ATTACK_S);
      amp.gain.exponentialRampToValueAtTime(SILENT, end);
    }
    osc.start(t0);
    osc.stop(end);
    setTimeout(close, (end - ctx.currentTime) * 1000 + CLOSE_AFTER_MS);
  } catch {
    close();
  }
}

/** Whether any tab holds the busy lock; a failed query reads as not busy. */
async function callIsLive(locks: LockManager): Promise<boolean> {
  try {
    const state = await locks.query();
    return !!state.held?.some((l) => l.name === BUSY_LOCK);
  } catch {
    return false;
  }
}

/** Plays the blip in at most one tab per throttle window. */
export function playMessageSound(): void {
  try {
    // The browser would block the sound before any interaction.
    if (navigator.userActivation?.hasBeenActive === false) return;
    const { locks } = navigator;
    if (!locks) {
      play();
      return;
    }
    void (async () => {
      if (await callIsLive(locks)) return;
      await locks.request(MESSAGE_SOUND_LOCK, { ifAvailable: true }, (lock) => {
        if (!lock) return;
        play();
        return new Promise<void>((resolve) => {
          setTimeout(resolve, MESSAGE_SOUND_THROTTLE_MS);
        });
      });
    })().catch(noop);
  } catch {
    // No sound.
  }
}

/** The person's switch on this browser; unreadable storage reads as off. */
export function readMessageSoundOn(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

export function writeMessageSoundOn(key: string, on: boolean): boolean {
  try {
    if (on) window.localStorage.setItem(key, '1');
    else window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
