import { describe, expect, it } from 'vitest';

import type { CallStatsSummary } from '@/lib/pbx/call-stats';
import { callsToday } from './calls';

function summary(over: Partial<CallStatsSummary> = {}): CallStatsSummary {
  return {
    calls: 0,
    inboundTotal: 0,
    inboundAnswered: 0,
    outboundTotal: 0,
    outboundAnswered: 0,
    missed: 0,
    answerRate: null,
    talkSecondsTotal: 0,
    talkCalls: 0,
    avgTalkSeconds: null,
    longestTalkSeconds: null,
    ringSecondsTotal: 0,
    ringCalls: 0,
    avgRingSeconds: null,
    maxRingSeconds: null,
    uniqueNumbers: 0,
    withOutcome: 0,
    ...over,
  };
}

describe('callsToday', () => {
  it('adds both directions to answered and formats rate and talk', () => {
    const t = callsToday(
      summary({
        calls: 12,
        inboundAnswered: 6,
        outboundAnswered: 3,
        missed: 2,
        answerRate: 0.75,
        avgTalkSeconds: 125,
      }),
      summary({ calls: 10 })
    );
    expect(t).toMatchObject({
      calls: 12,
      answered: 9,
      answerRate: '75%',
      missed: 2,
      avgTalk: '2:05',
    });
    expect(t.callsDelta).toMatchObject({ abs: 2, direction: 'up' });
  });

  it('shows dashes with no calls today', () => {
    const t = callsToday(summary(), summary());
    expect(t).toMatchObject({
      calls: 0,
      answered: 0,
      answerRate: '—',
      avgTalk: '—',
    });
    expect(t.callsDelta?.direction).toBe('flat');
  });
});
