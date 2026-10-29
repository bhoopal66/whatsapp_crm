import { describe, expect, it } from 'vitest';
import { makeLayer, makeSim, TEST_ACCOUNT } from './test-helpers';
import { INTENTS } from './questions/triage';
import {
  KB_GAP_INTENT_QUESTIONS,
  KB_GAP_QS_VERSION,
  buildCoverageQuestions,
} from './questions/kb-gap';
import { buildKbGapState } from './checks/kb-gap';

const input = {
  accountId: TEST_ACCOUNT,
  question: 'How long does opening a business account take?',
  answers: ['About two weeks.', 'Bring your trade licence.'],
};

describe('kb-gap questions', () => {
  it('asks the intent over triage’s own INTENTS', () => {
    expect(KB_GAP_QS_VERSION).toBe('qs-kb-gap-v1');
    expect(KB_GAP_INTENT_QUESTIONS.intent.type).toBe('choice');
    expect(KB_GAP_INTENT_QUESTIONS.intent.criteria).toBe(INTENTS);
  });

  it('builds c1…cn, each a three-level Score naming its answer by path', () => {
    const qs = buildCoverageQuestions(3);
    expect(Object.keys(qs)).toEqual(['c1', 'c2', 'c3']);
    for (const [k, q] of Object.values(qs).entries()) {
      expect(q.type).toBe('score');
      expect(q.criteria).toHaveLength(3);
      for (const c of q.criteria) expect(c).toContain(`\`answers[${k}].text\``);
      expect(q.criteria[0]).toContain('does not answer');
      expect(q.criteria[1]).toContain('answers part of');
      expect(q.criteria[2]).toContain('fully answers');
    }
    expect(buildCoverageQuestions(0)).toEqual({});
  });

  it('builds a redacted state with at most five answers, text only', () => {
    const s = buildKbGapState({
      question: 'call me on 0501234567',
      answers: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
    expect(s.question).not.toContain('0501234567');
    expect(s.answers).toEqual(
      ['a', 'b', 'c', 'd', 'e'].map((text) => ({ text }))
    );
  });
});

describe('DecisionLayer.kbGap (through the real SDK)', () => {
  it('returns the intent and the best-covering answer in one request', async () => {
    const sim = makeSim(() => ({
      answers: {
        intent: { choice: 'account_opening', confidence: 0.8 },
        c1: 0.4,
        c2: 1.7,
      },
    }));
    const { layer } = makeLayer({ sim });
    const r = await layer.kbGap(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent.key).toBe('account_opening');
    // the simulator spreads 0.8 over ten options: (0.8·9+1)/10
    expect(r.intent.p).toBeCloseTo(0.82, 6);
    expect(r.coverage).toEqual({ index: 1, level: 1.7 });
    expect(sim.calls).toHaveLength(1);
    expect(Object.keys(sim.calls[0]!.body.questions)).toEqual([
      'intent',
      'c1',
      'c2',
    ]);
    expect(sim.calls[0]!.body.state).toEqual({
      question: input.question,
      answers: input.answers.map((text) => ({ text })),
    });
  });

  it('judges intent alone when no answer was shortlisted', async () => {
    const sim = makeSim(() => ({ answers: { intent: 'pos_terminal' } }));
    const { layer } = makeLayer({ sim });
    const r = await layer.kbGap({ ...input, answers: [] });
    expect(r).toMatchObject({
      ok: true,
      intent: { key: 'pos_terminal' },
      coverage: { index: null, level: 0 },
    });
    expect(Object.keys(sim.calls[0]!.body.questions)).toEqual(['intent']);
  });

  it('treats an answer from another model as unavailable', async () => {
    const sim = makeSim(() => ({ model: 'jev-9.9.9' }));
    const { layer } = makeLayer({ sim });
    expect(await layer.kbGap(input)).toMatchObject({
      ok: false,
      errorCode: 'MODEL_MISMATCH',
    });
  });

  it('fails without throwing on a gateway error', async () => {
    const sim = makeSim(() => ({ status: 500 }));
    const { layer } = makeLayer({ sim, config: { timeoutMs: 200 } });
    const r = await layer.kbGap({ ...input, deadlineMs: 300 });
    expect(r.ok).toBe(false);
  });

  it('does not call TypeSafe for an account the install does not allow', async () => {
    const sim = makeSim();
    const { layer } = makeLayer({
      sim,
      config: { accounts: ['someone-else'] },
    });
    expect(await layer.kbGap(input)).toMatchObject({
      ok: false,
      errorCode: 'DISABLED',
    });
    expect(sim.calls).toHaveLength(0);
  });
});
