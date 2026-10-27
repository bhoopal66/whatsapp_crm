import { describe, expect, it } from 'vitest';

import { importWindowError, planCdrImport } from '../cdr-import';

const NOW = new Date('2026-10-27T12:00:00Z');
const at = (iso: string) => new Date(iso);

// Two legs of one inbound call (same uid, as Yeastar sends them), one
// answered outbound call, and one already stored by the live webhook.
const leg = (o: Record<string, unknown>) => ({
  uid: 'u-1',
  call_id: 'c-1',
  call_type: 'Inbound',
  call_from_number: '0501234567',
  call_to_number: '1001',
  timestamp: 1793087400,
  duration: 30,
  talk_duration: 0,
  disposition: 'NO ANSWER',
  ...o,
});
const noAnswer = leg({});
const answered = leg({
  call_to_number: '1002',
  timestamp: 1793087420,
  talk_duration: 90,
  disposition: 'ANSWERED',
});
const outbound = leg({
  uid: 'u-2',
  call_id: 'c-2',
  call_type: 'Outbound',
  call_from_number: '1001',
  call_to_number: '0509999999',
  talk_duration: 60,
  disposition: 'ANSWERED',
});
const live = leg({ uid: 'u-3', call_id: 'c-3' });

describe('importWindowError', () => {
  it('takes a past window of at most 24 hours', () => {
    expect(
      importWindowError(
        at('2026-10-26T12:00:00Z'),
        at('2026-10-27T12:00:00Z'),
        NOW
      )
    ).toBeNull();
  });

  it('refuses a longer window, one ending in the future, or a bad one', () => {
    expect(
      importWindowError(
        at('2026-10-26T11:59:59Z'),
        at('2026-10-27T12:00:00Z'),
        NOW
      )
    ).toMatch(/24 hours/);
    expect(
      importWindowError(
        at('2026-10-27T11:00:00Z'),
        at('2026-10-27T12:00:01Z'),
        NOW
      )
    ).toMatch(/future/);
    expect(importWindowError(NOW, NOW, NOW)).toMatch(/before/);
    expect(importWindowError(at('soon'), NOW, NOW)).toMatch(/--from/);
  });
});

describe('planCdrImport', () => {
  it('skips stored calls, keeps every leg, drops repeats and counts', () => {
    const plan = planCdrImport(
      [noAnswer, answered, { ...noAnswer }, outbound, live, { uid: '' }],
      new Set(['c-3'])
    );
    expect(plan).toMatchObject({
      rows: 6,
      distinctRows: 5,
      unparsed: 1,
      calls: 3,
      existing: ['c-3'],
      importCalls: ['c-1', 'c-2'],
      toImport: [noAnswer, answered, outbound],
    });
    expect(Object.fromEntries(plan.perExtension)).toEqual({
      '1001': { calls: 2, answered: 1, talkSeconds: 60 },
      '1002': { calls: 1, answered: 1, talkSeconds: 90 },
    });
  });
});
