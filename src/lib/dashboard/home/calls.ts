import { formatDuration } from '@/lib/pbx/call-report';
import {
  delta,
  formatPercent,
  type CallStatsDelta,
  type CallStatsSummary,
} from '@/lib/pbx/call-stats';

// ------------------------------------------------------------
// The home "Calls today" card's figures, from the Call report's own
// stats (GET /api/pbx/calls/stats?period=today). Pure.
// ------------------------------------------------------------

export interface CallsToday {
  calls: number;
  /** Today so far against yesterday up to the same time; null with no figure. */
  callsDelta: CallStatsDelta | null;
  /** Answered both ways: incoming picked up plus outgoing that connected. */
  answered: number;
  /** Incoming answer rate as "73%"; an em dash with no incoming call. */
  answerRate: string;
  missed: number;
  /** Average talk time as "m:ss"; an em dash with no talk. */
  avgTalk: string;
}

export function callsToday(
  summary: CallStatsSummary,
  previous: CallStatsSummary
): CallsToday {
  return {
    calls: summary.calls,
    callsDelta: delta(summary.calls, previous.calls),
    answered: summary.inboundAnswered + summary.outboundAnswered,
    answerRate: formatPercent(summary.answerRate),
    missed: summary.missed,
    avgTalk: formatDuration(summary.avgTalkSeconds),
  };
}

/** The browser's IANA zone, for "today"; UTC when it cannot say. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
