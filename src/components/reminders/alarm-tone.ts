// The reminder alarm's chime (lib/reminders/alarm.ts). Browser-only;
// every failure is swallowed (a missing sound must never cost the person
// the card). Fits AlarmQueue's `deps.chime`:
//
//   new AlarmQueue({ chime: playAlarmChime })
//
// Only one tab of the browser plays a given repeat of a given alarm: each
// repeat is its own Web Lock, taken with `ifAvailable`, and the tab that
// gets it holds it for CHIME_LOCK_HOLD_MS (ALARM_CHIME_FRESH_MS): as long
// as a freshly opened tab's seed could still decide to chime that alarm,
// so no tab can ring a repeat twice. A tab that finds the lock taken
// stays silent; it never queues, or it would play the chime again once
// the first tab let go. Without Web Locks every tab plays.
//
// While any tab holds the meeting ringer's shared busy lock (a meeting or
// a call is live in one tab, and the others cannot see it) nobody chimes.

import { BUSY_LOCK } from '@/components/meetings/invite-ring-tone';
import { audioContextClass } from '@/components/meetings/room/room-sounds';
import { ALARM_CHIME_FRESH_MS } from '@/lib/reminders/alarm';

export const CHIME_LOCK_PREFIX = 'wacrm-reminder-chime:';
/** How long the playing tab keeps a repeat's lock. */
export const CHIME_LOCK_HOLD_MS = ALARM_CHIME_FRESH_MS;
export const CHIME_GAIN = 0.3;

const NOTE_MS = 150;
const RISING_HZ = [1047, 1319, 1568];
/** The second pass starts this long after the first. */
const PASS_MS = 700;
const SILENT = 0.0001;
const ATTACK_S = 0.015;
/** Closes the AudioContext this long after the last note. */
const CLOSE_AFTER_MS = 500;

const noop = () => {};

export interface ChimeNote {
  atMs: number;
  hz: number;
  ms: number;
}

/** A bright rising three-note chime, twice: about 1.15 s, finite. */
export function chimeNotes(): ChimeNote[] {
  const notes: ChimeNote[] = [];
  for (const pass of [0, PASS_MS]) {
    RISING_HZ.forEach((hz, i) => {
      notes.push({ atMs: pass + i * NOTE_MS, hz, ms: NOTE_MS });
    });
  }
  return notes;
}

/** The lock that gives one tab one repeat of one alarm. */
export function chimeLockName(alarmId: string, n: number): string {
  return `${CHIME_LOCK_PREFIX}${alarmId}:${n}`;
}

/**
 * Lays the whole chime on the audio clock up front: nothing to stop, and
 * a frozen tab cannot ring on.
 */
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
    for (const note of chimeNotes()) {
      const at = t0 + note.atMs / 1000;
      end = at + note.ms / 1000;
      osc.frequency.setValueAtTime(note.hz, at);
      amp.gain.setValueAtTime(SILENT, at);
      amp.gain.exponentialRampToValueAtTime(CHIME_GAIN, at + ATTACK_S);
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

/** Plays repeat `n` of an alarm's chime, in at most one tab. */
export function playAlarmChime(alarmId: string, n: number): void {
  try {
    // The browser would block the sound, and holding the lock would then
    // silence a tab that could play it.
    if (navigator.userActivation?.hasBeenActive === false) return;
    const { locks } = navigator;
    if (!locks) {
      play();
      return;
    }
    void (async () => {
      if (await callIsLive(locks)) return;
      await locks.request(
        chimeLockName(alarmId, n),
        { ifAvailable: true },
        (lock) => {
          if (!lock) return;
          play();
          return new Promise<void>((resolve) => {
            setTimeout(resolve, CHIME_LOCK_HOLD_MS);
          });
        }
      );
    })().catch(noop);
  } catch {
    // No sound; the card still shows.
  }
}
