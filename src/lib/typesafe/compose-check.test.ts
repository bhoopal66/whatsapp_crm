import { describe, expect, it } from 'vitest';
import { makeLayer, makeSim } from './test-helpers';
import {
  COMPOSE_CHECK_QS_VERSION,
  composeCheckQuestions,
} from './questions/compose-check';
import {
  buildComposeCheckState,
  composeCheckWarnings,
} from './checks/compose-check';

const OTHER_ACCOUNT = '00000000-0000-4000-8000-0000000000b2';
const input = {
  accountId: '00000000-0000-4000-8000-0000000000a1',
  draft: 'Your application looks strong, we will get back to you',
  isStart: false,
};

describe('compose-check questions', () => {
  it('asks cold_pitch only when the draft starts a chat', () => {
    expect(COMPOSE_CHECK_QS_VERSION).toBe('qs-compose-check-v1');
    expect(Object.keys(composeCheckQuestions(false))).toEqual([
      'promise',
      'terms',
      'secrets',
      'tone',
    ]);
    expect(Object.keys(composeCheckQuestions(true))).toEqual([
      'promise',
      'terms',
      'secrets',
      'tone',
      'cold_pitch',
    ]);
    for (const q of Object.values(composeCheckQuestions(true)))
      expect(q.type).toBe('noul');
  });

  it('redacts the draft and turns, keeping at most four turns', () => {
    const s = buildComposeCheckState({
      draft: 'call me on 0501234567',
      recentTurns: Array.from({ length: 6 }, (_, i) => ({
        from: 'customer' as const,
        text: `turn ${i} a@b.co`,
      })),
      isStart: true,
    });
    expect(s.draft).not.toContain('0501234567');
    expect(s.recent_turns).toHaveLength(4);
    expect(s.recent_turns[0]!.text).toContain('turn 2');
    expect(JSON.stringify(s)).not.toContain('a@b.co');
    expect(s.is_start).toBe(true);
  });
});

describe('composeCheckWarnings thresholds', () => {
  it('applies each named threshold', () => {
    expect(
      composeCheckWarnings(
        {
          promise: 0.7,
          terms: 0.74,
          secrets: 0.6,
          tone: 0.74,
          cold_pitch: 0.7,
        },
        'plain words'
      )
    ).toEqual(['promise', 'secrets', 'cold_pitch']);
  });

  it('lowers the terms threshold to 0.5 when the draft carries a figure', () => {
    expect(composeCheckWarnings({ terms: 0.5 }, 'rate is 3.5% flat')).toEqual([
      'terms',
    ]);
    expect(composeCheckWarnings({ terms: 0.5 }, 'up to AED 50,000')).toEqual([
      'terms',
    ]);
    expect(composeCheckWarnings({ terms: 0.5 }, 'rates vary by bank')).toEqual(
      []
    );
  });
});

describe('DecisionLayer.composeCheck (through the real SDK)', () => {
  it('returns P(yes) per question asked', async () => {
    const sim = makeSim(() => ({
      answers: { promise: 0.8, terms: 0.1, secrets: 0.05, tone: 0.2 },
    }));
    const { layer } = makeLayer({ sim });
    const r = await layer.composeCheck(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.figures.promise).toBeCloseTo(0.8);
    expect(r.figures.cold_pitch).toBeUndefined();
    expect(Object.keys(sim.calls[0]!.body.questions)).toEqual([
      'promise',
      'terms',
      'secrets',
      'tone',
    ]);
  });

  it('asks cold_pitch when isStart', async () => {
    const sim = makeSim(() => ({ answers: { cold_pitch: 0.9 } }));
    const { layer } = makeLayer({ sim });
    const r = await layer.composeCheck({ ...input, isStart: true });
    expect(r.ok && r.figures.cold_pitch).toBeCloseTo(0.9);
    expect(Object.keys(sim.calls[0]!.body.questions)).toContain('cold_pitch');
  });

  it('treats an answer from another model as unavailable', async () => {
    const sim = makeSim(() => ({ model: 'jev-9.9.9' }));
    const { layer } = makeLayer({ sim });
    expect(await layer.composeCheck(input)).toMatchObject({
      ok: false,
      errorCode: 'MODEL_MISMATCH',
    });
  });

  it('does not call for an account the install does not allow', async () => {
    const sim = makeSim();
    const { layer } = makeLayer({
      sim,
      config: { accounts: [input.accountId] },
    });
    expect(
      await layer.composeCheck({ ...input, accountId: OTHER_ACCOUNT })
    ).toMatchObject({ ok: false, errorCode: 'DISABLED' });
    expect(sim.calls).toHaveLength(0);
  });

  it('gives up at the deadline: TIMEOUT', async () => {
    const sim = makeSim(() => 'hang');
    const { layer } = makeLayer({ sim, config: { timeoutMs: 5000 } });
    expect(
      await layer.composeCheck({ ...input, deadlineMs: 60 })
    ).toMatchObject({ ok: false, errorCode: 'TIMEOUT' });
  });
});
