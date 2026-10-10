import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDecisionLayer } from './index';
import {
  approvedDb,
  makeLayer,
  makeSim,
  testConfig,
  type SimCall,
  type SimReply,
  TEST_ACCOUNT,
} from './test-helpers';
import {
  KB_CANDIDATE_QUESTIONS,
  KB_HANDOFF_QUESTIONS,
  KB_SELECT_QS_VERSION,
} from './questions/kb-select';
import { QS_VERSION } from './questions/triage';
import {
  buildKbCandidateState,
  buildKbHandoffState,
  KB_SELECT_CONCURRENCY,
  KB_SELECT_MAX_CANDIDATES,
} from './checks/kb-select';

afterEach(() => vi.unstubAllEnvs());

/** Shortlist rows as the data layer hands them over: the ids and refs
 *  must never reach TypeSafe. */
const rows = [
  {
    id: '6f1c2d3e-4b5a-4c6d-8e7f-0123456789ab',
    ref: 'KB-010',
    question: 'What documents do I need to open a business account?',
    answer: 'A trade licence, passport and Emirates ID of every partner.',
  },
  {
    id: '7a2b3c4d-5e6f-4a7b-8c9d-abcdef012345',
    ref: 'KB-011',
    question: 'How long does account opening take?',
    answer: 'Usually 5 to 10 working days once documents are complete.',
  },
  {
    id: '8b3c4d5e-6f7a-4b8c-9d0e-bcdef0123456',
    ref: 'KB-012',
    question: 'Can I get a POS terminal?',
    answer: 'Yes, through our partner banks.',
  },
];
const candidates = rows.map((r) => ({
  question: r.question,
  answer: r.answer,
}));
const input = {
  accountId: TEST_ACCOUNT,
  message: 'what papers do I need for a company account?',
  candidates,
};

const isHandoffCall = (b: SimCall['body']) => 'pricing_request' in b.questions;
const candidateOf = (b: SimCall['body']) =>
  (b.state as { candidate: { question: string } }).candidate;

/** Per-candidate answers keyed by candidate question; hand-off batch low. */
function simWith(
  byQuestion: Record<string, { answers_fully: number; same_intent: number }>,
  handoff = { pricing_request: 0.1, legal_regulatory: 0.05, angry_tone: 0.02 }
) {
  return makeSim((body): SimReply => {
    if (isHandoffCall(body)) return { answers: handoff };
    const q = candidateOf(body).question;
    return { answers: byQuestion[q] ?? { answers_fully: 0, same_intent: 0 } };
  });
}

describe('kb-select questions', () => {
  it('has its own version and leaves the 013 question set alone', () => {
    expect(KB_SELECT_QS_VERSION).toBe('qs-017-v1');
    expect(QS_VERSION).toBe('qs-013-v0.2');
  });

  it('asks two nouls per candidate and three hand-off nouls', () => {
    expect(Object.keys(KB_CANDIDATE_QUESTIONS)).toEqual([
      'answers_fully',
      'same_intent',
    ]);
    expect(Object.keys(KB_HANDOFF_QUESTIONS)).toEqual([
      'pricing_request',
      'legal_regulatory',
      'angry_tone',
    ]);
    for (const q of [
      ...Object.values(KB_CANDIDATE_QUESTIONS),
      ...Object.values(KB_HANDOFF_QUESTIONS),
    ]) {
      expect(q.type).toBe('noul');
      expect(q.criteria).toMatchObject({
        true: expect.any(String),
        false: expect.any(String),
      });
    }
  });

  it('builds redacted states with at most six earlier turns', () => {
    const base = buildKbHandoffState({
      message: 'call me on 0501234567',
      recentTurns: Array.from({ length: 9 }, (_, i) => ({
        from: i % 2 ? ('business' as const) : ('customer' as const),
        text: `turn ${i}`,
      })),
    });
    expect(base.message).not.toContain('0501234567');
    expect(base.recent_turns).toHaveLength(6);
    expect(base.recent_turns[0]!.text).toBe('turn 3');
    expect(base).not.toHaveProperty('candidate');

    const s = buildKbCandidateState(base, {
      question: 'Who do I write to?',
      answer: 'Email support@example.com',
    });
    expect(Object.keys(s.candidate)).toEqual(['question', 'answer']);
    expect(s.candidate.answer).not.toContain('support@example.com');
  });
});

describe('DecisionLayer.kbSelect (through the real SDK)', () => {
  it('returns the hand-off figures and each candidate by position', async () => {
    const sim = simWith(
      {
        [rows[0]!.question]: { answers_fully: 0.92, same_intent: 0.95 },
        [rows[1]!.question]: { answers_fully: 0.2, same_intent: 0.3 },
      },
      { pricing_request: 0.6, legal_regulatory: 0.1, angry_tone: 0.05 }
    );
    const { layer } = makeLayer({ sim });
    const r = await layer.kbSelect(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.handoff.pricing).toBeCloseTo(0.6);
    expect(r.handoff.legal).toBeCloseTo(0.1);
    expect(r.handoff.angry).toBeCloseTo(0.05);
    expect(r.candidates).toHaveLength(3);
    expect(r.candidates[0]).toMatchObject({ index: 0 });
    expect(r.candidates[0]!.answersFully).toBeCloseTo(0.92);
    expect(r.candidates[0]!.sameIntent).toBeCloseTo(0.95);
    expect(r.candidates[1]).toMatchObject({ index: 1 });
    expect(r.candidates[1]!.sameIntent).toBeCloseTo(0.3);
    expect(r.candidates[2]).toMatchObject({ index: 2 });
    // one hand-off batch + one request per candidate
    expect(sim.calls).toHaveLength(4);
    expect(sim.calls.filter((c) => isHandoffCall(c.body))).toHaveLength(1);
    expect(
      sim.calls
        .filter((c) => !isHandoffCall(c.body))
        .map((c) => Object.keys(c.body.questions))
    ).toEqual(Array(3).fill(['answers_fully', 'same_intent']));
  });

  it('never sends a candidate id or ref to TypeSafe', async () => {
    const sim = simWith({});
    const { layer } = makeLayer({ sim });
    await layer.kbSelect(input);
    expect(sim.calls).toHaveLength(4);
    for (const c of sim.calls)
      for (const r of rows) {
        expect(c.raw).not.toContain(r.id);
        expect(c.raw).not.toContain(r.ref);
      }
  });

  it('judges at most eight candidates', async () => {
    const sim = simWith({});
    const { layer } = makeLayer({ sim });
    const many = Array.from({ length: 11 }, (_, i) => ({
      question: `question ${i}`,
      answer: `answer ${i}`,
    }));
    const r = await layer.kbSelect({ ...input, candidates: many });
    expect(KB_SELECT_MAX_CANDIDATES).toBe(8);
    expect(r.ok && r.candidates.map((c) => c.index)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(sim.calls).toHaveLength(9);
  });

  it('keeps at most four requests in flight', async () => {
    const sim = simWith({});
    let inFlight = 0;
    let peak = 0;
    const fetch = async (url: string, init?: RequestInit) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 10));
      try {
        return await sim.fetch(url, init);
      } finally {
        inFlight--;
      }
    };
    const { layer } = makeLayer({
      sim: { ...sim, fetch },
      config: { timeoutMs: 2000 },
    });
    const many = Array.from({ length: 8 }, (_, i) => ({
      question: `q${i}`,
      answer: `a${i}`,
    }));
    expect((await layer.kbSelect({ ...input, candidates: many })).ok).toBe(
      true
    );
    expect(KB_SELECT_CONCURRENCY).toBe(4);
    expect(peak).toBe(4);
  });

  it('fails the whole judgment when only the hand-off batch fails', async () => {
    const sim = makeSim((body): SimReply =>
      isHandoffCall(body) ? { status: 503 } : {}
    );
    const { layer } = makeLayer({ sim });
    expect(await layer.kbSelect(input)).toMatchObject({
      ok: false,
      errorCode: 'SERVER',
    });
  });

  it('fails the whole judgment when one candidate fails', async () => {
    const sim = makeSim((body): SimReply =>
      !isHandoffCall(body) && candidateOf(body).question === rows[2]!.question
        ? { status: 400 }
        : {}
    );
    const { layer } = makeLayer({ sim });
    expect(await layer.kbSelect(input)).toMatchObject({
      ok: false,
      errorCode: 'BAD_REQUEST',
    });
  });

  it('treats an answer from another model as unavailable', async () => {
    const sim = makeSim((body): SimReply =>
      !isHandoffCall(body) && candidateOf(body).question === rows[1]!.question
        ? { model: 'jev-9.9.9' }
        : {}
    );
    const { layer } = makeLayer({ sim });
    expect(await layer.kbSelect(input)).toMatchObject({
      ok: false,
      errorCode: 'MODEL_MISMATCH',
    });
  });

  it('gives up at one overall deadline: ok false, TIMEOUT', async () => {
    const sim = makeSim(() => 'hang');
    const { layer } = makeLayer({ sim, config: { timeoutMs: 5000 } });
    const many = Array.from({ length: 8 }, (_, i) => ({
      question: `q${i}`,
      answer: `a${i}`,
    }));
    const started = Date.now();
    const r = await layer.kbSelect({
      ...input,
      candidates: many,
      deadlineMs: 80,
    });
    expect(r).toMatchObject({ ok: false, errorCode: 'TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(2000);
    // the requests queued behind the timed-out ones were never sent
    expect(sim.calls).toHaveLength(KB_SELECT_CONCURRENCY);
  });

  it('runs whatever the account switches say, and writes no log row', async () => {
    const sim = makeSim();
    const db = approvedDb();
    const layer = createDecisionLayer({
      config: testConfig({
        enabled: {
          triage: false,
          guardrail: false,
          passages: false,
          eligibility: false,
        },
      }),
      apiKey: 'test-key',
      fetch: sim.fetch,
      alert: () => {},
      store: { ...db.store, accountSwitches: async () => null },
    });
    expect((await layer.kbSelect(input)).ok).toBe(true);
    expect(sim.calls).toHaveLength(4);
    expect(db.inserts).toHaveLength(0);
  });

  it('never calls TypeSafe for an account outside TS_ACCOUNT_IDS', async () => {
    const sim = makeSim();
    const { layer } = makeLayer({
      sim,
      config: { accounts: ['11111111-1111-4111-8111-111111111111'] },
    });
    expect(await layer.kbSelect(input)).toMatchObject({
      ok: false,
      errorCode: 'DISABLED',
    });
    expect(sim.calls).toHaveLength(0);
  });

  it('never calls TypeSafe on an install without an API key', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', '');
    const sim = makeSim();
    const layer = createDecisionLayer({
      config: testConfig(),
      fetch: sim.fetch,
      alert: () => {},
    });
    expect(await layer.kbSelect(input)).toMatchObject({
      ok: false,
      errorCode: 'DISABLED',
    });
    expect(sim.calls).toHaveLength(0);
  });

  it('has its own breaker: a kb_select outage pauses neither route nor triage', async () => {
    let down = true;
    const sim = makeSim((): SimReply => (down ? { status: 503 } : {}));
    const { layer } = makeLayer({ sim });
    for (let i = 0; i < 5; i++) await layer.kbSelect(input);
    expect(layer.gateway.available('kb_select')).toBe(false);
    expect(layer.gateway.available('route')).toBe(true);
    expect(layer.gateway.available('triage')).toBe(true);
    down = false;
    expect(
      (await layer.triage({ message: 'hi', journeyStage: 'x' })).errorCode
    ).toBeNull();
  });
});
