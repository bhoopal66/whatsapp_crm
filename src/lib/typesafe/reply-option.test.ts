import { describe, expect, it } from 'vitest';
import { makeLayer, makeSim, TEST_ACCOUNT } from './test-helpers';
import {
  buildReplyOptionQuestions,
  REPLY_OPTION_MAX_OPTIONS,
  REPLY_OPTION_NONE,
  REPLY_OPTION_QS_VERSION,
} from './questions/reply-option';
import {
  buildReplyOptionState,
  REPLY_OPTION_DEADLINE_MS,
} from './checks/reply-option';

const text = (q: unknown) => JSON.stringify(q);

describe('reply-option questions', () => {
  it('asks one choice over o1…oN plus none', () => {
    expect(REPLY_OPTION_QS_VERSION).toBe('qs-reply-option-v1');
    expect(REPLY_OPTION_DEADLINE_MS).toBe(2000);
    const { questions, keys } = buildReplyOptionQuestions([
      { title: 'Get a quote' },
      { title: 'Personal', description: 'Up to 250k' },
    ]);
    expect(keys).toEqual(['o1', 'o2']);
    const q = questions.option as { type: string; criteria: object };
    expect(q.type).toBe('choice');
    expect(Object.keys(q.criteria)).toEqual(['o1', 'o2', 'none']);
    expect(text(q)).toContain(
      "Which of the offered options does the customer's reply in `message` choose? `prompt` is the question the business asked."
    );
    expect(text(q)).toContain('Get a quote');
    expect(text(q)).toContain('Up to 250k');
    expect((q.criteria as Record<string, string>).none).toBe(REPLY_OPTION_NONE);
  });

  it('caps the options and redacts identifiers in labels', () => {
    const many = Array.from(
      { length: REPLY_OPTION_MAX_OPTIONS + 2 },
      (_, i) => ({ title: `Row ${i}` })
    );
    expect(buildReplyOptionQuestions(many).keys).toHaveLength(
      REPLY_OPTION_MAX_OPTIONS
    );
    const q = text(
      buildReplyOptionQuestions([{ title: 'Call 0501234567' }]).questions
    );
    expect(q).not.toContain('0501234567');
  });

  it('builds a redacted state of prompt and message', () => {
    const s = buildReplyOptionState({
      prompt: 'Which one? Or mail a@b.co',
      message: 'the second, call 0501234567',
    });
    expect(Object.keys(s)).toEqual(['prompt', 'message']);
    expect(s.prompt).not.toContain('a@b.co');
    expect(s.message).not.toContain('0501234567');
  });
});

describe('DecisionLayer.replyOption (through the real SDK)', () => {
  const input = {
    accountId: TEST_ACCOUNT,
    prompt: 'Quote or comparison?',
    message: 'yes the second one',
    options: [{ title: 'Get a quote' }, { title: 'Compare' }],
  };

  it('returns the chosen option index and its p', async () => {
    const sim = makeSim(() => ({
      answers: { option: { choice: 'o2', confidence: 0.9 } },
    }));
    const { layer } = makeLayer({ sim });
    const r = await layer.replyOption(input);
    expect(r).toMatchObject({ ok: true, index: 1 });
    if (!r.ok) return;
    // The sim's peak for 3 labels at confidence 0.9: (0.9 * 2 + 1) / 3.
    expect(r.p).toBeCloseTo((0.9 * 2 + 1) / 3, 6);
    expect(sim.calls).toHaveLength(1);
    expect(Object.keys(sim.calls[0]!.body.questions)).toEqual(['option']);
    expect(sim.calls[0]!.body.state).toEqual({
      prompt: 'Quote or comparison?',
      message: 'yes the second one',
    });
  });

  it('returns index null for none', async () => {
    const sim = makeSim(() => ({ answers: { option: 'none' } }));
    const { layer } = makeLayer({ sim });
    expect(await layer.replyOption(input)).toMatchObject({
      ok: true,
      index: null,
    });
  });

  it('treats an answer from another model as a failure', async () => {
    const sim = makeSim(() => ({
      model: 'jev-9.9.9',
      answers: { option: 'o1' },
    }));
    const { layer } = makeLayer({ sim });
    expect(await layer.replyOption(input)).toMatchObject({
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
    expect(await layer.replyOption(input)).toMatchObject({
      ok: false,
      errorCode: 'DISABLED',
    });
    expect(sim.calls).toHaveLength(0);
  });

  it('asks nothing when no options are offered', async () => {
    const sim = makeSim();
    const { layer } = makeLayer({ sim });
    expect(await layer.replyOption({ ...input, options: [] })).toMatchObject({
      ok: true,
      index: null,
    });
    expect(sim.calls).toHaveLength(0);
  });
});
