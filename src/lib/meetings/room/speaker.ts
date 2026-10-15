// Who is speaking, and who the active speaker is, from audio levels the
// engine samples every ~200 ms: `RTCRtpReceiver.getSynchronizationSources()`
// for each remote voice, an AnalyserNode for our own microphone. Both are
// linear 0..1 (1.0 is 0 dBov), so one floor serves both.

import type { ParticipantId } from './contract';

/** A level at or above this is speech; below it is room noise. */
export const SPEAKING_FLOOR = 0.05;

/**
 * Someone else must be the loudest speaker this long before the active
 * speaker switches to them, so a cough or a one-word interjection does
 * not flip the speaker layout back and forth.
 */
export const SPEAKER_HOLD_MS = 1_000;

/**
 * Speech has gaps between words. A speaker stays "speaking" this long
 * after their last sample above the floor, so the ring does not flicker.
 */
export const SPEAKING_HANG_MS = 400;

export interface SpeakerState {
  active: ParticipantId | null;
  /** The loudest speaker other than `active`, and since when. */
  candidate: ParticipantId | null;
  candidateSince: number;
  /** When each participant was last above the floor. */
  lastLoud: Record<ParticipantId, number>;
}

export const INITIAL_SPEAKER_STATE: SpeakerState = {
  active: null,
  candidate: null,
  candidateSince: 0,
  lastLoud: {},
};

export interface SpeakerStep {
  state: SpeakerState;
  activeSpeakerId: ParticipantId | null;
  speaking: Record<ParticipantId, boolean>;
}

/** The loudest level at or above the floor; ties go to the lower id. */
export function loudest(
  levels: Readonly<Record<ParticipantId, number>>,
  floor = SPEAKING_FLOOR
): ParticipantId | null {
  let best: ParticipantId | null = null;
  let bestLevel = -1;
  for (const id of Object.keys(levels).sort()) {
    const level = levels[id];
    if (level >= floor && level > bestLevel) {
      best = id;
      bestLevel = level;
    }
  }
  return best;
}

/**
 * One sample. `levels` holds every participant in the room (ourselves
 * included, under our participant id), silent ones at 0: someone
 * missing from it has left, and stops being the active speaker. With
 * nobody speaking the active speaker stays who it was, as in every
 * meeting app: the big tile does not empty during a pause.
 */
export function stepSpeaker(
  prev: SpeakerState,
  levels: Readonly<Record<ParticipantId, number>>,
  now: number
): SpeakerStep {
  const lastLoud: Record<ParticipantId, number> = {};
  const speaking: Record<ParticipantId, boolean> = {};
  for (const [id, level] of Object.entries(levels)) {
    const loud = level >= SPEAKING_FLOOR;
    const last = loud ? now : prev.lastLoud[id];
    if (last !== undefined) lastLoud[id] = last;
    speaking[id] = last !== undefined && now - last < SPEAKING_HANG_MS;
  }

  const top = loudest(levels);
  let active =
    prev.active !== null && prev.active in levels ? prev.active : null;
  let candidate = prev.candidate;
  let candidateSince = prev.candidateSince;

  if (active === null) {
    // Nobody to hold on to: the first voice takes it at once.
    active = top;
    candidate = null;
  } else if (top === null || top === active) {
    candidate = null;
  } else if (candidate !== top) {
    candidate = top;
    candidateSince = now;
  } else if (now - candidateSince >= SPEAKER_HOLD_MS) {
    active = top;
    candidate = null;
  }

  return {
    state: { active, candidate, candidateSince, lastLoud },
    activeSpeakerId: active,
    speaking,
  };
}

/** Root mean square of time-domain samples (-1..1), clamped to 0..1. */
export function rmsLevel(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.min(1, Math.sqrt(sum / samples.length));
}

/**
 * The level as the snapshot carries it: in steps of 0.05, so a level
 * that wobbles in the third decimal does not re-render the room.
 */
export function quantizeLevel(level: number): number {
  if (!Number.isFinite(level) || level <= 0) return 0;
  return Math.min(1, Math.round(level * 20) / 20);
}

/** Shallow equality of two flat records. */
export function sameRecord<T>(
  a: Readonly<Record<string, T>>,
  b: Readonly<Record<string, T>>
): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => k in b && a[k] === b[k]);
}

export interface LevelView {
  activeSpeakerId: ParticipantId | null;
  speaking: Record<ParticipantId, boolean>;
  localAudioLevel: number;
}

/**
 * What a level sample changes in the snapshot, or null when nothing
 * visible changed. The engine samples five times a second; emitting a
 * fresh snapshot on every sample would re-render the whole room even
 * in silence. Unchanged parts keep their previous object.
 */
export function levelPatch(
  prev: LevelView,
  next: LevelView
): Partial<LevelView> | null {
  const patch: Partial<LevelView> = {};
  if (prev.activeSpeakerId !== next.activeSpeakerId) {
    patch.activeSpeakerId = next.activeSpeakerId;
  }
  if (!sameRecord(prev.speaking, next.speaking)) patch.speaking = next.speaking;
  const level = quantizeLevel(next.localAudioLevel);
  if (level !== prev.localAudioLevel) patch.localAudioLevel = level;
  return Object.keys(patch).length ? patch : null;
}
