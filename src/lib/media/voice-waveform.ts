/**
 * The pure half of the voice-note player (`voice-note-player.tsx`): the
 * waveform's bar heights, the clock, and the speed ladder. Kept here so
 * it is testable without a DOM or an AudioContext.
 *
 * A bar height is a fraction in [MIN_PEAK, 1]. The floor keeps silence
 * visible as a row of dots rather than an empty gap, as WhatsApp does.
 */

/** Bars across one bubble's waveform. */
export const WAVEFORM_BARS = 40;

export const MIN_PEAK = 0.12;

/** The speeds the pill cycles through, in order. */
export const PLAYBACK_RATES = [1, 1.5, 2] as const;

export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

/**
 * Bar heights from decoded samples: the RMS of each slice, scaled so the
 * loudest bar is full height. RMS rather than the raw peak because one
 * click would otherwise flatten everything else.
 */
export function peaksFromSamples(
  samples: ArrayLike<number>,
  bars: number = WAVEFORM_BARS
): number[] {
  if (bars <= 0) return [];
  const n = samples.length;
  if (n === 0) return Array.from({ length: bars }, () => MIN_PEAK);

  const rms: number[] = [];
  for (let b = 0; b < bars; b++) {
    const start = Math.floor((b * n) / bars);
    // At least one sample per bar, so a clip shorter than `bars` samples
    // still fills the row.
    const end = Math.max(start + 1, Math.floor(((b + 1) * n) / bars));
    let sum = 0;
    let count = 0;
    for (let i = start; i < end && i < n; i++) {
      const v = samples[i];
      sum += v * v;
      count++;
    }
    rms.push(count ? Math.sqrt(sum / count) : 0);
  }

  const loudest = Math.max(...rms);
  if (!(loudest > 0)) return rms.map(() => MIN_PEAK);
  return rms.map((v) => MIN_PEAK + (1 - MIN_PEAK) * (v / loudest));
}

/**
 * A stand-in waveform until (or unless) the real one decodes: stable for
 * a given seed, so a bubble never reshuffles on re-render, and shaped
 * like speech (phrases that swell and fall) rather than white noise.
 */
export function seededPeaks(
  seed: string,
  bars: number = WAVEFORM_BARS
): number[] {
  // FNV-1a over the seed, then a mulberry32 stream.
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let state = h >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const out: number[] = [];
  for (let b = 0; b < bars; b++) {
    const envelope = 0.55 + 0.45 * Math.sin((b / bars) * Math.PI * 3 + 0.6);
    const v = envelope * (0.35 + 0.65 * next());
    out.push(Math.min(1, Math.max(MIN_PEAK, v)));
  }
  return out;
}

/** `m:ss` for a number of seconds; anything unusable reads 0:00. */
export function formatClock(seconds: number): string {
  const total =
    Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** The speed after `rate` on the pill; an unknown rate restarts at 1×. */
export function nextPlaybackRate(rate: number): PlaybackRate {
  const i = PLAYBACK_RATES.indexOf(rate as PlaybackRate);
  return PLAYBACK_RATES[(i + 1) % PLAYBACK_RATES.length];
}

/** "1×", "1.5×", "2×". */
export function formatRate(rate: number): string {
  return `${rate}×`;
}

/** Position in [0, 1] of a pointer at `clientX` over a box. */
export function seekFraction(
  clientX: number,
  left: number,
  width: number
): number {
  if (!(width > 0)) return 0;
  return Math.min(1, Math.max(0, (clientX - left) / width));
}

/**
 * Loudness in [0, 1] of one analyser frame (`getByteTimeDomainData`,
 * silence = 128). Speech RMS rarely passes a third of full scale, so it
 * is boosted before clamping, or the live meter would barely move.
 */
export function levelFromTimeDomain(frame: ArrayLike<number>): number {
  const n = frame.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = (frame[i] - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / n) * 3);
}

/** Appends `level` to a rolling history, keeping the newest `max`. */
export function pushLevel(
  history: readonly number[],
  level: number,
  max: number
): number[] {
  const next = [...history, level];
  return next.length > max ? next.slice(next.length - max) : next;
}
