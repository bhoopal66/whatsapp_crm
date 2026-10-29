import { describe, expect, it } from 'vitest';
import { makeLayer, makeSim, TEST_ACCOUNT } from './test-helpers';
import {
  buildIntentQuestions,
  INTENT_MATCH_QS_VERSION,
  INTENT_MAX_CANDIDATES,
  INTENT_MAX_DESCRIPTION_CHARS,
  INTENT_MAX_EXAMPLE_CHARS,
} from './questions/intent-match';
import { buildIntentMatchState } from './checks/intent-match';

const text = (q: unknown) => JSON.stringify(q);

describe('intent-match questions', () => {
  it('asks one noul per candidate, keyed by ordinal', () => {
    expect(INTENT_MATCH_QS_VERSION).toBe('qs-intent-match-v1');
    const { questions, keys } = buildIntentQuestions([
      { description: 'The customer wants a loan.' },
      { description: 'The customer asks to stop.', examples: ['stop', 'bas'] },
    ]);
    expect(keys).toEqual(['c1', 'c2']);
    expect(Object.keys(questions)).toEqual(['c1', 'c2']);
    expect(questions.c1!.type).toBe('noul');
    expect(text(questions.c1)).toContain(
      'Does the customer in `message` mean the following? The customer wants a loan.'
    );
    expect(text(questions.c1)).not.toContain('Messages that mean this');
    expect(text(questions.c2)).toContain(
      'Messages that mean this include: \\"stop\\", \\"bas\\".'
    );
    expect(text(questions.c2)).toContain(
      'Use `recent_turns` only to understand what `message` refers to.'
    );
    expect(text(questions.c1)).toContain(
      'The message means this, in any wording or language.'
    );
    expect(text(questions.c1)).toContain(
      'It means something else, or only mentions the topic in passing.'
    );
  });

  it('caps candidates, examples and their lengths', () => {
    const many = Array.from({ length: INTENT_MAX_CANDIDATES + 3 }, (_, i) => ({
      description: `Intent number ${i}`,
    }));
    expect(buildIntentQuestions(many).keys).toHaveLength(INTENT_MAX_CANDIDATES);

    const { questions } = buildIntentQuestions([
      {
        description: 'd'.repeat(INTENT_MAX_DESCRIPTION_CHARS + 50),
        examples: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'x'.repeat(500)],
      },
    ]);
    const q = text(questions.c1);
    expect(q).not.toContain('d'.repeat(INTENT_MAX_DESCRIPTION_CHARS));
    expect(q).toContain('d'.repeat(INTENT_MAX_DESCRIPTION_CHARS - 1));
    expect(q).toContain('e5');
    expect(q).not.toContain('e6');
    expect(q).not.toContain('x'.repeat(INTENT_MAX_EXAMPLE_CHARS));
  });

  it('redacts identifiers in admin-written descriptions and examples', () => {
    const { questions } = buildIntentQuestions([
      {
        description: 'Wants a call back on 0501234567',
        examples: ['mail me at a@b.co'],
      },
    ]);
    const q = text(questions.c1);
    expect(q).not.toContain('0501234567');
    expect(q).not.toContain('a@b.co');
  });

  it('builds a redacted state with at most six earlier turns', () => {
    const s = buildIntentMatchState({
      message: 'call me on 0501234567',
      recentTurns: Array.from({ length: 9 }, (_, i) => ({
        from: i % 2 ? ('business' as const) : ('customer' as const),
        text: `turn ${i}`,
      })),
    });
    expect(s.message).not.toContain('0501234567');
    expect(s.recent_turns).toHaveLength(6);
    expect(s.recent_turns[0]!.text).toBe('turn 3');
  });
});

describe('DecisionLayer.intentMatch (through the real SDK)', () => {
  const input = {
    accountId: TEST_ACCOUNT,
    message: 'I want to apply for a loan',
    candidates: [
      { description: 'The customer wants a loan.' },
      { description: 'The customer asks to stop messages.' },
    ],
  };

  it('returns p per candidate, in candidate order', async () => {
    const sim = makeSim(() => ({ answers: { c1: 0.92, c2: 0.04 } }));
    const { layer } = makeLayer({ sim });
    const r = await layer.intentMatch(input);
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.p).toHaveLength(2);
    expect(r.p[0]).toBeCloseTo(0.92, 6);
    expect(r.p[1]).toBeCloseTo(0.04, 6);
    expect(sim.calls).toHaveLength(1);
    expect(Object.keys(sim.calls[0]!.body.questions)).toEqual(['c1', 'c2']);
  });

  it('treats an answer from another model as a failure', async () => {
    const sim = makeSim(() => ({ model: 'jev-9.9.9' }));
    const { layer } = makeLayer({ sim });
    expect(await layer.intentMatch(input)).toMatchObject({
      ok: false,
      errorCode: 'MODEL_MISMATCH',
    });
  });

  it('never calls TypeSafe for an account outside TS_ACCOUNT_IDS', async () => {
    const sim = makeSim();
    const { layer } = makeLayer({
      sim,
      config: { accounts: ['11111111-1111-4111-8111-111111111111'] },
    });
    expect(await layer.intentMatch(input)).toMatchObject({
      ok: false,
      errorCode: 'DISABLED',
    });
    expect(sim.calls).toHaveLength(0);
  });

  it('asks nothing for no candidates', async () => {
    const sim = makeSim();
    const { layer } = makeLayer({ sim });
    expect(await layer.intentMatch({ ...input, candidates: [] })).toEqual({
      ok: true,
      p: [],
      latencyMs: 0,
    });
    expect(sim.calls).toHaveLength(0);
  });
});
