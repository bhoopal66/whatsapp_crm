// Connection quality from RTCPeerConnection.getStats(), sampled every
// 2 s. Coarse on purpose: the room shows three bars, not numbers.

import type { ParticipantId, Quality } from './contract';

export const QUALITY_INTERVAL_MS = 2_000;
/** Our own link must stay poor this long before the room says so … */
export const POOR_NOTICE_AFTER_MS = 10_000;
/** … and says so at most this often. */
export const POOR_NOTICE_EVERY_MS = 120_000;

export interface QualitySample {
  /** Round-trip time in ms. */
  rttMs?: number;
  /** Fraction of packets lost since the previous sample, 0..1. */
  loss?: number;
  /** Jitter in ms. */
  jitterMs?: number;
}

/** Worst of the three measures: good, fair or poor; unknown without any. */
export function classifyQuality(s: QualitySample): Quality {
  const { rttMs, loss, jitterMs } = s;
  if (rttMs === undefined && loss === undefined && jitterMs === undefined) {
    return 'unknown';
  }
  if ((rttMs ?? 0) > 400 || (loss ?? 0) > 0.08 || (jitterMs ?? 0) > 100) {
    return 'poor';
  }
  if ((rttMs ?? 0) > 150 || (loss ?? 0) > 0.02 || (jitterMs ?? 0) > 30) {
    return 'fair';
  }
  return 'good';
}

/** Cumulative counters of one inbound stream, kept between samples. */
export interface LossCounters {
  lost: number;
  received: number;
}

/** A stats report, without the DOM lib. */
export type StatLike = Record<string, unknown> & { type?: unknown };

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/**
 * One getStats() pass. Ours: the selected candidate pair's RTT plus the
 * loss the SFU reports for what we send (remote-inbound-rtp). Each
 * remote participant: loss (from counter deltas) and jitter of their
 * inbound streams, matched to them by transceiver mid.
 */
export function summarizeStats(
  reports: Iterable<StatLike>,
  participantByMid: Readonly<Record<string, ParticipantId>>,
  prev: Readonly<Record<string, LossCounters>>
): {
  self: QualitySample;
  remote: Record<ParticipantId, QualitySample>;
  counters: Record<string, LossCounters>;
} {
  const self: QualitySample = {};
  const remote: Record<ParticipantId, QualitySample> = {};
  const counters: Record<string, LossCounters> = {};
  const worse = (a: number | undefined, b: number | undefined) =>
    a === undefined ? b : b === undefined ? a : Math.max(a, b);
  for (const r of reports) {
    if (r.type === 'candidate-pair') {
      const rtt = num(r.currentRoundTripTime);
      if (rtt !== undefined && (r.nominated === true || r.selected === true)) {
        self.rttMs = rtt * 1000;
      }
    } else if (r.type === 'remote-inbound-rtp') {
      self.loss = worse(self.loss, num(r.fractionLost));
    } else if (r.type === 'inbound-rtp') {
      const mid = typeof r.mid === 'string' ? r.mid : null;
      const pid = mid !== null ? participantByMid[mid] : undefined;
      if (!pid || mid === null) continue;
      const s = (remote[pid] ??= {});
      const jitter = num(r.jitter);
      if (jitter !== undefined) s.jitterMs = worse(s.jitterMs, jitter * 1000);
      const lost = num(r.packetsLost);
      const received = num(r.packetsReceived);
      if (lost === undefined || received === undefined) continue;
      counters[mid] = { lost, received };
      const before = prev[mid];
      if (!before) continue;
      const dLost = Math.max(0, lost - before.lost);
      const total = dLost + Math.max(0, received - before.received);
      if (total > 0) s.loss = worse(s.loss, dLost / total);
    }
  }
  return { self, remote, counters };
}

export interface PoorTracker {
  poorSince: number | null;
  lastNotice: number | null;
}

export const INITIAL_POOR_TRACKER: PoorTracker = {
  poorSince: null,
  lastNotice: null,
};

/** Whether this sample of our own quality should raise `quality_poor`. */
export function stepPoorTracker(
  prev: PoorTracker,
  quality: Quality,
  now: number
): { state: PoorTracker; notify: boolean } {
  if (quality !== 'poor') {
    return { state: { ...prev, poorSince: null }, notify: false };
  }
  const poorSince = prev.poorSince ?? now;
  const notify =
    now - poorSince >= POOR_NOTICE_AFTER_MS &&
    (prev.lastNotice === null || now - prev.lastNotice >= POOR_NOTICE_EVERY_MS);
  return {
    state: { poorSince, lastNotice: notify ? now : prev.lastNotice },
    notify,
  };
}
