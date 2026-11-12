// The reminder alarm's chime (lib/reminders/alarm.ts). Browser-only;
// every failure is swallowed (a missing sound must never cost the person
// the card). Fits AlarmQueue's `deps.chime`:
//
//   new AlarmQueue({ chime: playAlarmChime })
//
// Only one tab of the browser plays a given repeat of a given alarm: each
// repeat is its own Web Lock, taken with `ifAvailable`, and the tab that
// gets it holds it for CHIME_LOCK_HOLD_MS after playing, long past the
// moment the other tabs hear the same realtime row. A tab that finds the
// lock taken stays silent; it never queues, or it would play the chime
// again once the first tab let go. Without Web Locks every tab plays.

import { audioContextClass } from '@/components/meetings/room/room-sounds';

export const CHIME_LOCK_PREFIX = 'wacrm-reminder-chime:';
/** How long the playing tab keeps a repeat's lock. */
export const CHIME_LOCK_HOLD_MS = 20_000;
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
    void locks
      .request(chimeLockName(alarmId, n), { ifAvailable: true }, (lock) => {
        if (!lock) return;
        play();
        return new Promise<void>((resolve) => {
          setTimeout(resolve, CHIME_LOCK_HOLD_MS);
        });
      })
      .catch(noop);
  } catch {
    // No sound; the card still shows.
  }
}
