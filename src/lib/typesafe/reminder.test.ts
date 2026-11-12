import { describe, expect, it } from 'vitest';
import { makeLayer, makeSim, TEST_ACCOUNT } from './test-helpers';
import {
  buildReminderQuestions,
  REMINDER_KIND_OPTIONS,
  REMINDER_QS_VERSION,
} from './questions/reminder';
import { buildReminderState } from './checks/reminder';
import { REMINDER_KINDS } from '@/lib/reminders/types';

const input = {
  accountId: TEST_ACCOUNT,
  text: 'Please call me tomorrow at 3pm about the card',
  side: 'customer' as const,
  times: ['tomorrow at 3pm'],
};

describe('reminder questions', () => {
  it('asks reminder and kind, and when only for 2+ times', () => {
    expect(REMINDER_QS_VERSION).toBe('qs-reminder-v1');
    expect(Object.keys(buildReminderQuestions(['a']))).toEqual([
      'reminder',
      'kind',
    ]);
    const q = buildReminderQuestions(['today', 'Sunday', 'x', 'y', 'z']);
    expect(Object.keys(q)).toEqual(['reminder', 'kind', 'when']);
    const when = (q as unknown as { when: { options: unknown } }).when;
    expect(JSON.stringify(when)).toContain('t4');
    expect(JSON.stringify(when)).not.toContain('t5');
    expect(JSON.stringify(when)).toContain('the time written as \\"Sunday\\"');
  });

  it('kind keys equal REMINDER_KINDS, in order', () => {
    expect(Object.keys(REMINDER_KIND_OPTIONS)).toEqual([...REMINDER_KINDS]);
  });

  it('builds a redacted, clipped state with no ids', () => {
    const s = buildReminderState({
      text: 'call me on 0501234567 ' + 'y'.repeat(2000),
      side: 'agent',
      times: ['t'.repeat(200), 'b', 'c', 'd', 'e'],
    });
    expect(s.message.length).toBeLessThanOrEqual(1000);
    expect(s.message).not.toContain('0501234567');
    expect(s.author).toBe('business');
    expect(s.times).toHaveLength(4);
    expect(s.times[0]!.length).toBeLessThanOrEqual(80);
    expect(Object.keys(s)).toEqual(['message', 'author', 'times']);
  });
});

describe('DecisionLayer.reminder (through the real SDK)', () => {
  it('returns yes with P(yes), the kind and time 0 for one time', async () => {
    const sim = makeSim(() => ({
      answers: {
        reminder: { choice: 'yes', confidence: 0.9 },
        kind: 'call',
      },
    }));
    const { layer } = makeLayer({ sim });
    const r = await layer.reminder(input);
    expect(r).toMatchObject({
      ok: true,
      isReminder: true,
      kind: 'call',
      timeIndex: 0,
    });
    if (!r.ok) return;
    // the simulator spreads 0.9 confidence over two options: (0.9+1)/2
    expect(r.p).toBeCloseTo(0.95, 6);
    expect(sim.calls).toHaveLength(1);
    expect(sim.calls[0]!.body.state).toEqual({
      message: input.text,
      author: 'customer',
      times: ['tomorrow at 3pm'],
    });
  });

  it('a no answer gives P(yes) of the yes option', async () => {
    const sim = makeSim(() => ({
      answers: { reminder: { choice: 'no', confidence: 0.8 }, kind: 'call' },
    }));
    const { layer } = makeLayer({ sim });
    const r = await layer.reminder(input);
    expect(r).toMatchObject({ ok: true, isReminder: false });
    // no at (0.8+1)/2 = 0.9 leaves 0.1 on yes
    if (r.ok) expect(r.p).toBeCloseTo(0.1, 6);
  });

  it('maps the chosen time ordinal to its index', async () => {
    const sim = makeSim(() => ({
      answers: { reminder: 'yes', kind: 'payment', when: 't2' },
    }));
    const { layer } = makeLayer({ sim });
    const r = await layer.reminder({
      ...input,
      times: ['today', 'on Sunday', 'next week'],
    });
    expect(r).toMatchObject({ ok: true, timeIndex: 1, kind: 'payment' });
  });

  it('refuses an empty times list without calling TypeSafe', async () => {
    const sim = makeSim();
    const { layer } = makeLayer({ sim });
    expect(await layer.reminder({ ...input, times: [] })).toMatchObject({
      ok: false,
      errorCode: 'NO_TIMES',
    });
    expect(sim.calls).toHaveLength(0);
  });

  it('treats an answer from another model as unavailable', async () => {
    const sim = makeSim(() => ({ model: 'jev-9.9.9' }));
    const { layer } = makeLayer({ sim });
    expect(await layer.reminder(input)).toMatchObject({
      ok: false,
      errorCode: 'MODEL_MISMATCH',
    });
  });

  it('gives up at the hard deadline: ok false, TIMEOUT', async () => {
    const sim = makeSim(() => 'hang');
    const { layer } = makeLayer({ sim, config: { timeoutMs: 5000 } });
    const r = await layer.reminder({ ...input, deadlineMs: 60 });
    expect(r).toMatchObject({ ok: false, errorCode: 'TIMEOUT' });
  });

  it('never calls TypeSafe for an account outside TS_ACCOUNT_IDS', async () => {
    const sim = makeSim();
    const { layer } = makeLayer({
      sim,
      config: { accounts: ['11111111-1111-4111-8111-111111111111'] },
    });
    expect(await layer.reminder(input)).toMatchObject({
      ok: false,
      errorCode: 'DISABLED',
    });
    expect(sim.calls).toHaveLength(0);
  });

  it('has its own breaker: an outage does not touch route', async () => {
    const sim = makeSim(() => ({ status: 503 }));
    const { layer } = makeLayer({ sim });
    for (let i = 0; i < 5; i++) await layer.reminder(input);
    expect(layer.gateway.available('reminder')).toBe(false);
    expect(layer.gateway.available('route')).toBe(true);
  });
});
