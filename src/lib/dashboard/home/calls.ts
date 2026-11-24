import {
  CALL_REPORT_OUTCOMES,
  formatDuration,
  type CallReportOutcome,
} from '@/lib/pbx/call-report';
import {
  delta,
  formatPercent,
  type CallStatsDelta,
  type CallStatsOutcomes,
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

export interface OutcomeBar {
  outcome: Exclude<CallReportOutcome, 'none'>;
  count: number;
  /** Width of its bar, 0–100, against the most common outcome. */
  percent: number;
}

/**
 * What today's answered calls came to, in the call card's fixed order
 * (`none`, answered with no outcome logged, is left out). Empty when no
 * call has an outcome yet, so the card can say so instead of drawing
 * five empty bars.
 */
export function callOutcomes(outcomes: CallStatsOutcomes): OutcomeBar[] {
  const named = CALL_REPORT_OUTCOMES.filter(
    (o): o is Exclude<CallReportOutcome, 'none'> => o !== 'none'
  );
  const max = Math.max(0, ...named.map((o) => outcomes[o] ?? 0));
  if (max === 0) return [];
  return named.map((outcome) => {
    const count = outcomes[outcome] ?? 0;
    return { outcome, count, percent: Math.round((count / max) * 100) };
  });
}
