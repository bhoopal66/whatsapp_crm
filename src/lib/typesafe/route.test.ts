import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDecisionLayer } from './index';
import {
  approvedDb,
  makeLayer,
  makeSim,
  testConfig,
  type SimReply,
  TEST_ACCOUNT,
} from './test-helpers';
import {
  ROUTE_KINDS,
  ROUTE_QS_VERSION,
  ROUTE_QUESTIONS,
} from './questions/route';
import { buildRouteState } from './checks/route';

const input = {
  accountId: TEST_ACCOUNT,
  message: 'hello!',
  journeyStage: 'open_conversation',
};

afterEach(() => vi.unstubAllEnvs());

describe('route questions', () => {
  it('asks kind (six options), a four-level complexity and one noul', () => {
    expect(ROUTE_QS_VERSION).toBe('qs-route-v1');
    expect(ROUTE_QUESTIONS.kind.type).toBe('choice');
    expect(Object.keys(ROUTE_KINDS)).toEqual([
      'greeting_or_thanks',
      'simple_question',
      'detailed_question',
      'multi_part_or_reasoning',
      'sensitive_or_negotiation',
      'unclear',
    ]);
    expect(ROUTE_QUESTIONS.complexity.type).toBe('score');
    expect(ROUTE_QUESTIONS.complexity.criteria).toHaveLength(4);
    expect(ROUTE_QUESTIONS.needs_business_facts.type).toBe('noul');
  });

  it('builds a redacted state with at most six earlier turns', () => {
    const s = buildRouteState({
      message: 'call me on 0501234567',
      recentTurns: Array.from({ length: 9 }, (_, i) => ({
        from: i % 2 ? ('business' as const) : ('customer' as const),
        text: `turn ${i}`,
      })),
      journeyStage: 'in_flow',
    });
    expect(s.message).not.toContain('0501234567');
    expect(s.recent_turns).toHaveLength(6);
    expect(s.recent_turns[0]!.text).toBe('turn 3');
    expect(s.journey_stage).toBe('in_flow');
  });
});

describe('DecisionLayer.route (through the real SDK)', () => {
  it('returns the kind with its probabilities, complexity and needsFacts', async () => {
    const sim = makeSim(() => ({
      answers: {
        kind: { choice: 'greeting_or_thanks', confidence: 0.9 },
        complexity: 0.2,
        needs_business_facts: 0.1,
      },
    }));
    const { layer } = makeLayer({ sim });
    const r = await layer.route(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind.label).toBe('greeting_or_thanks');
    // the simulator spreads 0.9 confidence over six options: (0.9·5+1)/6
    expect(r.kind.p.greeting_or_thanks).toBeCloseTo(5.5 / 6, 6);
    expect(Object.keys(r.kind.p)).toHaveLength(6);
    expect(r.complexity).toBeCloseTo(0.2);
    expect(r.needsFacts).toBeCloseTo(0.1);
    expect(sim.calls).toHaveLength(1);
    expect(Object.keys(sim.calls[0]!.body.questions)).toEqual([
      'kind',
      'complexity',
      'needs_business_facts',
    ]);
  });

  it('gives up at the hard deadline: ok false, TIMEOUT', async () => {
    const sim = makeSim(() => 'hang');
    const { layer } = makeLayer({ sim, config: { timeoutMs: 5000 } });
    const started = Date.now();
    const r = await layer.route({ ...input, deadlineMs: 60 });
    expect(r).toMatchObject({ ok: false, errorCode: 'TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('refuses locally when an identifier survives redaction', async () => {
    const sim = makeSim();
    const { layer, alerts } = makeLayer({ sim });
    // journey_stage is host-supplied and not redacted: the last-line
    // guard still catches it.
    const r = await layer.route({ ...input, journeyStage: 'x a@b.co' });
    expect(r).toMatchObject({ ok: false, errorCode: 'PII_BLOCKED' });
    expect(sim.calls).toHaveLength(0);
    expect(alerts).toContainEqual(
      expect.objectContaining({ code: 'TS_PII_BLOCKED', check: 'route' })
    );
  });

  it('treats an answer from another model as unavailable', async () => {
    const sim = makeSim(() => ({ model: 'jev-9.9.9' }));
    const { layer } = makeLayer({ sim });
    expect(await layer.route(input)).toMatchObject({
      ok: false,
      errorCode: 'MODEL_MISMATCH',
    });
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
    expect((await layer.route(input)).ok).toBe(true);
    expect(sim.calls).toHaveLength(1);
    expect(db.inserts).toHaveLength(0);
  });

  it('never calls TypeSafe for an account outside TS_ACCOUNT_IDS', async () => {
    const sim = makeSim();
    const { layer } = makeLayer({
      sim,
      config: { accounts: ['11111111-1111-4111-8111-111111111111'] },
    });
    expect(await layer.route(input)).toMatchObject({
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
    expect(await layer.route(input)).toMatchObject({
      ok: false,
      errorCode: 'DISABLED',
    });
    expect(sim.calls).toHaveLength(0);
  });

  it('has its own breaker: a route outage does not pause triage', async () => {
    let down = true;
    const sim = makeSim((): SimReply => (down ? { status: 503 } : {}));
    const { layer } = makeLayer({ sim });
    for (let i = 0; i < 5; i++) await layer.route(input);
    expect(layer.gateway.available('route')).toBe(false);
    expect(layer.gateway.available('triage')).toBe(true);
    down = false;
    expect(
      (await layer.triage({ message: 'hi', journeyStage: 'x' })).errorCode
    ).toBeNull();
  });
});
