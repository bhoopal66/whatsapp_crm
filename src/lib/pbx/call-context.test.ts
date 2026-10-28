import { describe, expect, it } from 'vitest';

import {
  HISTORY_MAX,
  earlierCalls,
  isOverdue,
  wasAnswered,
  type HistoryCall,
} from './call-context';

const call = (i: number, pbxCallId: string | null = `pbx-${i}`) =>
  ({
    id: `call-${i}`,
    pbxCallId,
    direction: 'inbound',
    status: 'answered',
    startedAt: '2026-10-28T08:00:00.000Z',
    answeredAt: null,
    ringSeconds: null,
    talkSeconds: 30,
    userId: null,
    userName: null,
    disposition: null,
    notes: null,
    recordingState: 'none',
  }) satisfies HistoryCall;

describe('earlierCalls', () => {
  const eleven = Array.from({ length: 11 }, (_, i) => call(i + 1));

  it('leaves the call in progress out and keeps ten', () => {
    const out = earlierCalls(eleven, 'pbx-1');
    expect(out.map((c) => c.id)).toEqual(eleven.slice(1).map((c) => c.id));
  });

  it('keeps the ten newest when the current call is not among them', () => {
    const out = earlierCalls(eleven, 'pbx-other');
    expect(out).toHaveLength(HISTORY_MAX);
    expect(out[0].id).toBe('call-1');
    expect(out.at(-1)?.id).toBe('call-10');
  });

  it('drops nothing without a current call, even rows with no PBX id', () => {
    const rows = [call(1, null), call(2)];
    expect(earlierCalls(rows, null)).toEqual(rows);
    expect(earlierCalls(rows, '  ')).toEqual(rows);
  });
});

describe('wasAnswered', () => {
  it('reads the status or the answer stamp', () => {
    expect(wasAnswered({ status: 'answered', answeredAt: null })).toBe(true);
    expect(
      wasAnswered({ status: 'no_answer', answeredAt: '2026-10-28T08:00:00Z' })
    ).toBe(true);
    expect(wasAnswered({ status: 'no_answer', answeredAt: null })).toBe(false);
  });
});

describe('isOverdue', () => {
  const now = Date.parse('2026-10-28T10:00:00Z');
  it('is a due time before now', () => {
    expect(isOverdue('2026-10-28T09:59:00Z', now)).toBe(true);
    expect(isOverdue('2026-10-28T10:01:00Z', now)).toBe(false);
  });
  it('is never an undated or unreadable task', () => {
    expect(isOverdue(null, now)).toBe(false);
    expect(isOverdue('soon', now)).toBe(false);
  });
});
