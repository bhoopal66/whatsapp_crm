import { describe, expect, it } from 'vitest';
import { makeLayer, makeSim, TEST_ACCOUNT } from './test-helpers';
import { MAX_REQUEST_CHARS } from './client';
import { TRIAGE_QUESTIONS } from './questions/triage';
import { OBJECTION_CODES } from '@/lib/insights/bands';
import {
  INSIGHTS_QS_VERSION,
  MAX_SUB_TAG_QUESTIONS,
  MAX_SUGGEST_MAIN_TAGS,
  MAX_SUGGEST_SUB_TAGS,
  MAX_TAG_HINT_CHARS,
  MAX_TAG_NAME_CHARS,
  MAX_SUB_TAG_HINT_CHARS,
  SIGNAL_QUESTIONS,
  DEEP_QUESTIONS,
  buildTagQuestions,
  type TagCatalogue,
  type TagCatalogueMain,
} from './questions/insights';
import { buildInsightsState } from './checks/insights';

let seq = 0;
/** A fresh v4-shaped UUID, like the real tag ids. */
const uuid = () =>
  `5f0c${String(++seq).padStart(4, '0')}-1a2b-4c3d-8e4f-${String(seq).padStart(12, '0')}`;

const main = (
  name: string,
  over: Partial<Omit<TagCatalogueMain, 'subs'>> & { subs?: string[] } = {}
): TagCatalogueMain => ({
  id: over.id ?? uuid(),
  name,
  hint: over.hint ?? null,
  subTitle: over.subTitle ?? null,
  subs: (over.subs ?? []).map((n) => ({ id: uuid(), name: n, hint: null })),
});

const catalogue = (): TagCatalogue => ({
  mains: [
    main('Not interested'),
    main('Interested', {
      hint: 'Wants to apply',
      subTitle: 'Bank',
      subs: ['ADCB', 'ENBD', 'Mashreq'],
    }),
    main('Follow up', { subs: ['Next week', 'Next month'] }),
  ],
});

const allIds = (c: TagCatalogue) =>
  c.mains.flatMap((m) => [m.id, ...m.subs.map((s) => s.id)]);

const base = {
  accountId: TEST_ACCOUNT,
  message: 'I want a loan',
  askDeep: false,
};

describe('insights questions', () => {
  it('reuses the triage question objects for the signals', () => {
    expect(INSIGHTS_QS_VERSION).toBe('qs-insights-v2');
    expect(Object.keys(SIGNAL_QUESTIONS)).toEqual([
      'intent',
      'urgency',
      'lead_temperature',
      'dissatisfied',
      'wants_human',
    ]);
    for (const [k, q] of Object.entries(SIGNAL_QUESTIONS))
      expect(q).toBe(TRIAGE_QUESTIONS[k as keyof typeof TRIAGE_QUESTIONS]);
  });

  it('asks the deep questions as a five-level score and one noul each', () => {
    expect(Object.keys(DEEP_QUESTIONS)).toEqual([
      'sentiment',
      ...OBJECTION_CODES.map((c) => `objection_${c}`),
      'needs_reply',
      'callback_request',
    ]);
    const { sentiment, ...nouls } = DEEP_QUESTIONS;
    expect(sentiment.type).toBe('score');
    expect(sentiment.criteria).toEqual([
      'Very negative: angry, insulting or deeply frustrated.',
      'Negative: annoyed, disappointed or worried.',
      'Neutral: matter-of-fact.',
      'Positive: friendly, pleased or appreciative.',
      'Very positive: enthusiastic or delighted.',
    ]);
    for (const q of Object.values(nouls)) {
      expect(q.type).toBe('noul');
      expect(Object.keys(q.criteria as object)).toEqual(['true', 'false']);
    }
    for (const q of Object.values(DEEP_QUESTIONS)) {
      const text = String(q.instructions);
      expect(text).toContain('`message`');
      expect(text).toContain(
        'Use `recent_turns` only to understand what `message` refers to.'
      );
      // the deep questions are insights-only, never a triage object
      expect(Object.values(TRIAGE_QUESTIONS)).not.toContain(q);
    }
  });

  it('offers main tags as ordinals plus none, with the hint after the name', () => {
    const c = catalogue();
    const { questions, keyMap } = buildTagQuestions(c);
    expect(questions.chat_tag!.criteria).toEqual({
      t1: 'Not interested',
      t2: 'Interested — Wants to apply',
      t3: 'Follow up',
      none: 'None of these tags describes the conversation yet.',
    });
    expect(String(questions.chat_tag!.instructions)).toContain(
      'Which chat tag best describes this conversation?'
    );
    expect(keyMap.mains).toEqual({
      t1: c.mains[0]!.id,
      t2: c.mains[1]!.id,
      t3: c.mains[2]!.id,
    });
    expect(Object.keys(questions)).toEqual(['chat_tag', 'sub_t2', 'sub_t3']);
    expect(Object.keys(questions.sub_t2!.criteria)).toEqual([
      's1',
      's2',
      's3',
      'none',
    ]);
    expect(keyMap.subs.t2).toEqual({
      question: 'sub_t2',
      options: {
        s1: c.mains[1]!.subs[0]!.id,
        s2: c.mains[1]!.subs[1]!.id,
        s3: c.mains[1]!.subs[2]!.id,
      },
    });
    expect(keyMap.subs.t1).toBeUndefined();
  });

  it('states the premise of each sub-tag question', () => {
    const { questions } = buildTagQuestions(catalogue());
    expect(questions.sub_t2!.instructions).toContain(
      'Assume the conversation belongs under the chat tag "Interested". Which Bank fits it best?'
    );
    expect(questions.sub_t3!.instructions).toContain(
      'Assume the conversation belongs under the chat tag "Follow up". Which sub-tag fits it best?'
    );
  });

  it('never puts a tag id into the questions', () => {
    const c = catalogue();
    const json = JSON.stringify(buildTagQuestions(c).questions);
    for (const id of allIds(c)) expect(json).not.toContain(id);
  });

  it('caps main tags, sub-tags and sub-tag questions', () => {
    const mains: TagCatalogueMain[] = Array.from({ length: 20 }, (_, i) =>
      main(`Tag ${i + 1}`, {
        // every other main has sub-tags; the first has 20 of them
        subs:
          i % 2 === 0
            ? Array.from({ length: i === 0 ? 20 : 2 }, (_, j) => `Sub ${j}`)
            : [],
      })
    );
    const { questions, keyMap } = buildTagQuestions({ mains });
    expect(Object.keys(keyMap.mains)).toHaveLength(MAX_SUGGEST_MAIN_TAGS);
    expect(Object.keys(questions.chat_tag!.criteria)).toHaveLength(
      MAX_SUGGEST_MAIN_TAGS + 1
    );
    expect(Object.keys(questions.sub_t1!.criteria)).toHaveLength(
      MAX_SUGGEST_SUB_TAGS + 1
    );
    // mains 1, 3, 5, … have sub-tags: the first eight get a question
    expect(Object.keys(keyMap.subs)).toEqual(
      ['t1', 't3', 't5', 't7', 't9', 't11', 't13', 't15'].slice(
        0,
        MAX_SUB_TAG_QUESTIONS
      )
    );
    expect(Object.keys(questions)).toHaveLength(1 + MAX_SUB_TAG_QUESTIONS);
  });

  it('clips names and hints, drops a blank hint and redacts identifiers', () => {
    const long = 'Name '.repeat(40);
    const { questions } = buildTagQuestions({
      mains: [
        main(long, { hint: 'Hint '.repeat(100), subTitle: long }),
        main('Blank hint', { hint: '  \n' }),
        main('Phone', { hint: 'call 0501234567 first' }),
      ],
    });
    const [n1, n2, n3] = Object.values(
      questions.chat_tag!.criteria
    ) as string[];
    const [name, hint] = n1!.split(' — ');
    expect(name!.length).toBeLessThanOrEqual(MAX_TAG_NAME_CHARS);
    expect(hint!.length).toBeLessThanOrEqual(MAX_TAG_HINT_CHARS);
    expect(n2).toBe('Blank hint');
    expect(n3).not.toContain('0501234567');

    const sub = buildTagQuestions({
      mains: [
        {
          ...main('With sub'),
          subs: [{ id: uuid(), name: 'S', hint: 'Hint '.repeat(100) }],
        },
      ],
    }).questions.sub_t1!.criteria as Record<string, string>;
    expect(sub.s1!.split(' — ')[1]!.length).toBeLessThanOrEqual(
      MAX_SUB_TAG_HINT_CHARS
    );
  });

  it('keeps the largest request well inside the size budget', () => {
    const mains = Array.from({ length: 40 }, (_, i) => ({
      id: uuid(),
      name: `Main ${i} `.repeat(20),
      hint: `Hint "${i}" `.repeat(60),
      subTitle: 'Bank '.repeat(30),
      subs: Array.from({ length: 30 }, (_, j) => ({
        id: uuid(),
        name: `Sub ${j} `.repeat(20),
        hint: `Sub hint ${j} `.repeat(40),
      })),
    }));
    const state = buildInsightsState({
      message: 'word '.repeat(2000),
      recentTurns: Array.from({ length: 10 }, () => ({
        from: 'customer' as const,
        text: 'word '.repeat(500),
      })),
    });
    const size = JSON.stringify({
      state,
      questions: {
        ...SIGNAL_QUESTIONS,
        ...DEEP_QUESTIONS,
        ...buildTagQuestions({ mains }).questions,
      },
    }).length;
    expect(size).toBeLessThan(MAX_REQUEST_CHARS * 0.7);
  });
});

describe('insights state', () => {
  it('redacts, keeps six turns and defaults the journey stage', () => {
    const s = buildInsightsState({
      message: 'call me on 0501234567',
      recentTurns: Array.from({ length: 9 }, (_, i) => ({
        from: i % 2 ? ('taamul' as const) : ('customer' as const),
        text: `turn ${i}`,
      })),
    });
    expect(s.message).not.toContain('0501234567');
    expect(s.recent_turns).toHaveLength(6);
    expect(s.recent_turns[0]!.text).toBe('turn 3');
    expect(s.journey_stage).toBe('unknown');
    expect(s).not.toHaveProperty('partner_banks');
  });
});

describe('DecisionLayer.insights (through the real SDK)', () => {
  // the simulator spreads 0.9 confidence over n options: (0.9·(n−1)+1)/n
  const peak = (n: number) => (0.9 * (n - 1) + 1) / n;

  it('maps the signals and the tag back to ids, reading only the chosen main’s sub-tag', async () => {
    const c = catalogue();
    const sim = makeSim(() => ({
      answers: {
        intent: 'business_loan',
        urgency: 1.2,
        lead_temperature: 2.5,
        dissatisfied: 0.3,
        wants_human: 0.85,
        chat_tag: 't2',
        sub_t2: 's3',
        sub_t3: 's1',
      },
    }));
    const { layer } = makeLayer({ sim });
    const r = await layer.insights({ ...base, askSignals: true, tags: c });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.signals).toEqual({
      intent: { key: 'business_loan', p: expect.closeTo(peak(10), 6) },
      urgency: expect.closeTo(1.2, 6),
      leadTemp: expect.closeTo(2.5, 6),
      upset: expect.closeTo(0.3, 6),
      wantsHuman: expect.closeTo(0.85, 6),
    });
    expect(r.tag).toEqual({
      mainId: c.mains[1]!.id,
      mainP: expect.closeTo(peak(4), 6),
      subId: c.mains[1]!.subs[2]!.id,
      subP: expect.closeTo(peak(4), 6),
    });
    expect(sim.calls).toHaveLength(1);
    const raw = sim.calls[0]!.raw;
    for (const id of allIds(c)) expect(raw).not.toContain(id);
    expect(Object.keys(sim.calls[0]!.body.questions)).toEqual([
      'intent',
      'urgency',
      'lead_temperature',
      'dissatisfied',
      'wants_human',
      'chat_tag',
      'sub_t2',
      'sub_t3',
    ]);
  });

  it('gives no sub-tag for a main tag without a sub-tag question', async () => {
    const c = catalogue();
    const sim = makeSim(() => ({
      answers: { chat_tag: 't1', sub_t2: 's1', sub_t3: 's1' },
    }));
    const { layer } = makeLayer({ sim });
    const r = await layer.insights({ ...base, askSignals: false, tags: c });
    expect(r).toMatchObject({
      ok: true,
      signals: null,
      tag: { mainId: c.mains[0]!.id, subId: null, subP: null },
    });
  });

  it('reads none as no tag, and a sub-tag none as no sub-tag', async () => {
    const c = catalogue();
    const none = makeSim(() => ({
      answers: { chat_tag: 'none', sub_t2: 's1', sub_t3: 's1' },
    }));
    const r1 = await makeLayer({ sim: none }).layer.insights({
      ...base,
      askSignals: false,
      tags: c,
    });
    expect(r1).toMatchObject({
      ok: true,
      tag: { mainId: null, subId: null, subP: null },
    });
    if (r1.ok) expect(r1.tag!.mainP).toBeCloseTo(peak(4), 6);

    const subNone = makeSim(() => ({
      answers: { chat_tag: 't3', sub_t2: 's1', sub_t3: 'none' },
    }));
    const r2 = await makeLayer({ sim: subNone }).layer.insights({
      ...base,
      askSignals: false,
      tags: c,
    });
    expect(r2).toMatchObject({
      ok: true,
      tag: { mainId: c.mains[2]!.id, subId: null },
    });
    if (r2.ok) expect(r2.tag!.subP).toBeCloseTo(peak(3), 6);
  });

  it('leaves the signal questions out when triage already answered them', async () => {
    const sim = makeSim(() => ({
      answers: { chat_tag: 't1', sub_t2: 's1', sub_t3: 's1' },
    }));
    const { layer } = makeLayer({ sim });
    const r = await layer.insights({
      ...base,
      askSignals: false,
      tags: catalogue(),
    });
    expect(r).toMatchObject({ ok: true, signals: null });
    expect(Object.keys(sim.calls[0]!.body.questions)).toEqual([
      'chat_tag',
      'sub_t2',
      'sub_t3',
    ]);
  });

  it('asks only the signals when there are no tags', async () => {
    const sim = makeSim(() => ({ answers: { intent: 'complaint' } }));
    const { layer } = makeLayer({ sim });
    const r = await layer.insights({ ...base, askSignals: true, tags: null });
    expect(r).toMatchObject({
      ok: true,
      tag: null,
      signals: { intent: { key: 'complaint' } },
    });
    expect(Object.keys(sim.calls[0]!.body.questions)).toEqual(
      Object.keys(SIGNAL_QUESTIONS)
    );
  });

  it('maps the deep answers, alongside the signals and the tag', async () => {
    const c = catalogue();
    const sim = makeSim(() => ({
      answers: {
        intent: 'business_loan',
        sentiment: 0.6,
        objection_price: 0.82,
        objection_documents: 0.1,
        objection_eligibility: 0.2,
        objection_trust: 0.3,
        objection_timing: 0.4,
        objection_comparing: 0.71,
        needs_reply: 0.93,
        callback_request: 0.77,
        chat_tag: 't1',
      },
    }));
    const { layer } = makeLayer({ sim });
    const r = await layer.insights({
      ...base,
      askSignals: true,
      askDeep: true,
      tags: c,
    });
    expect(r).toMatchObject({
      ok: true,
      signals: { intent: { key: 'business_loan' } },
      tag: { mainId: c.mains[0]!.id },
    });
    if (!r.ok) return;
    expect(r.deep).toEqual({
      sentiment: expect.closeTo(0.6, 6),
      objections: {
        price: expect.closeTo(0.82, 6),
        documents: expect.closeTo(0.1, 6),
        eligibility: expect.closeTo(0.2, 6),
        trust: expect.closeTo(0.3, 6),
        timing: expect.closeTo(0.4, 6),
        comparing: expect.closeTo(0.71, 6),
      },
      needsReply: expect.closeTo(0.93, 6),
      callback: expect.closeTo(0.77, 6),
    });
    expect(Object.keys(sim.calls[0]!.body.questions)).toEqual([
      ...Object.keys(SIGNAL_QUESTIONS),
      ...Object.keys(DEEP_QUESTIONS),
      'chat_tag',
      'sub_t2',
      'sub_t3',
    ]);
  });

  it('asks only the deep and tag questions when triage answered the signals', async () => {
    const sim = makeSim(() => ({ answers: { chat_tag: 't1' } }));
    const { layer } = makeLayer({ sim });
    const r = await layer.insights({
      ...base,
      askSignals: false,
      askDeep: true,
      tags: catalogue(),
    });
    expect(r).toMatchObject({ ok: true, signals: null });
    if (r.ok) expect(r.deep).not.toBeNull();
    expect(Object.keys(sim.calls[0]!.body.questions)).toEqual([
      ...Object.keys(DEEP_QUESTIONS),
      'chat_tag',
      'sub_t2',
      'sub_t3',
    ]);
  });

  it('asks the deep questions alone when nothing else is wanted', async () => {
    const sim = makeSim();
    const { layer } = makeLayer({ sim });
    const r = await layer.insights({
      ...base,
      askSignals: false,
      askDeep: true,
    });
    expect(r).toMatchObject({ ok: true, signals: null, tag: null });
    expect(sim.calls).toHaveLength(1);
    expect(Object.keys(sim.calls[0]!.body.questions)).toEqual(
      Object.keys(DEEP_QUESTIONS)
    );
  });

  it('leaves the deep questions out unless asked', async () => {
    const sim = makeSim();
    const { layer } = makeLayer({ sim });
    const r = await layer.insights({
      ...base,
      askSignals: true,
      tags: catalogue(),
    });
    expect(r).toMatchObject({ ok: true, deep: null });
    const asked = Object.keys(sim.calls[0]!.body.questions);
    for (const k of Object.keys(DEEP_QUESTIONS)) expect(asked).not.toContain(k);
  });

  it('makes no request when there is nothing to ask', async () => {
    const sim = makeSim();
    const { layer } = makeLayer({ sim });
    expect(await layer.insights({ ...base, askSignals: false })).toEqual({
      ok: true,
      signals: null,
      deep: null,
      tag: null,
      latencyMs: 0,
    });
    expect(
      await layer.insights({ ...base, askSignals: false, tags: { mains: [] } })
    ).toMatchObject({ ok: true, signals: null, deep: null, tag: null });
    expect(sim.calls).toHaveLength(0);
  });

  it('treats an answer from another model as unavailable', async () => {
    const sim = makeSim(() => ({ model: 'jev-9.9.9' }));
    const { layer } = makeLayer({ sim });
    expect(
      await layer.insights({ ...base, askSignals: false, askDeep: true })
    ).toMatchObject({ ok: false, errorCode: 'MODEL_MISMATCH' });
    expect(await layer.insights({ ...base, askSignals: true })).toMatchObject({
      ok: false,
      errorCode: 'MODEL_MISMATCH',
    });
  });

  it('fails without throwing on a 503', async () => {
    const sim = makeSim(() => ({ status: 503 }));
    const { layer } = makeLayer({ sim });
    const r = await layer.insights({
      ...base,
      askSignals: true,
      tags: catalogue(),
    });
    expect(r.ok).toBe(false);
  });

  it('runs only for accounts the install allows', async () => {
    const sim = makeSim();
    const { layer } = makeLayer({
      sim,
      config: { accounts: ['someone-else'] },
    });
    expect(await layer.insights({ ...base, askSignals: true })).toEqual({
      ok: false,
      errorCode: 'DISABLED',
      latencyMs: 0,
    });
    expect(sim.calls).toHaveLength(0);
  });
});
