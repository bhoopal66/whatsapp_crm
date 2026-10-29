import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDecisionLayer } from './index';
import { makeLayer, makeSim, testConfig, TEST_ACCOUNT } from './test-helpers';
import {
  buildStatusMapQuestions,
  NO_STAGE_KEY,
  STATUS_MAP_QS_VERSION,
} from './questions/status-map';
import { buildStatusMapState } from './checks/status-map';

const stages = ['Submitted', 'Under review', 'Approved'];
const input = {
  accountId: TEST_ACCOUNT,
  status: 'With credit team',
  stages,
  knownMappings: [{ status: 'UNDER_REVIEW', stage: 'Under review' }],
};

afterEach(() => vi.unstubAllEnvs());

describe('status-map questions', () => {
  it('offers the stages under ordinal keys, plus no_stage', () => {
    expect(STATUS_MAP_QS_VERSION).toBe('qs-status-map-v1');
    const { questions, keyMap } = buildStatusMapQuestions(stages);
    expect(questions.stage.type).toBe('choice');
    expect(questions.stage.criteria).toEqual({
      o1: 'Submitted',
      o2: 'Under review',
      o3: 'Approved',
      no_stage:
        "The status does not say where the application is in the bank's process; keep the case where it is.",
    });
    expect(keyMap).toEqual({
      o1: 'Submitted',
      o2: 'Under review',
      o3: 'Approved',
    });
  });

  it('builds a redacted state with at most twelve examples', () => {
    const s = buildStatusMapState({
      status: 'call 0501234567',
      knownMappings: Array.from({ length: 15 }, (_, i) => ({
        status: `S${i}`,
        stage: 'Submitted',
      })),
    });
    expect(s.status).not.toContain('0501234567');
    expect(s.known_mappings).toHaveLength(12);
  });
});

describe('DecisionLayer.statusMap (through the real SDK)', () => {
  it('maps the chosen ordinal back to the stage, with a runner-up', async () => {
    const sim = makeSim(() => ({
      answers: { stage: { choice: 'o2', confidence: 0.8 } },
    }));
    const { layer } = makeLayer({ sim });
    const r = await layer.statusMap(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stage).toBe('Under review');
    // the simulator spreads 0.8 over four options: (0.8·3+1)/4
    expect(r.p).toBeCloseTo(3.4 / 4, 6);
    expect(r.runnerUp).not.toBeNull();
    // the rest shares what is left: (1 − 0.85)/3
    expect(r.runnerUp!.p).toBeCloseTo(0.05, 6);
    const body = sim.calls[0]!.body;
    expect(Object.keys(body.questions.stage!.criteria as object)).toEqual([
      'o1',
      'o2',
      'o3',
      NO_STAGE_KEY,
    ]);
    expect(body.state).toEqual({
      status: 'With credit team',
      known_mappings: [{ status: 'UNDER_REVIEW', stage: 'Under review' }],
    });
  });

  it('answers stage null for no_stage', async () => {
    const sim = makeSim(() => ({ answers: { stage: 'no_stage' } }));
    const { layer } = makeLayer({ sim });
    expect(await layer.statusMap(input)).toMatchObject({
      ok: true,
      stage: null,
    });
  });

  it('treats an answer from another model as unavailable', async () => {
    const sim = makeSim(() => ({ model: 'jev-9.9.9' }));
    const { layer } = makeLayer({ sim });
    expect(await layer.statusMap(input)).toMatchObject({
      ok: false,
      errorCode: 'MODEL_MISMATCH',
    });
  });

  it('is ok false, never a throw, on a 503', async () => {
    const sim = makeSim(() => ({ status: 503 }));
    const { layer } = makeLayer({ sim });
    const r = await layer.statusMap(input);
    expect(r.ok).toBe(false);
  });

  it('never calls TypeSafe without stages, for a disallowed account or without a key', async () => {
    const sim = makeSim();
    const { layer } = makeLayer({ sim });
    expect(await layer.statusMap({ ...input, stages: [] })).toMatchObject({
      ok: false,
      errorCode: 'NO_STAGES',
    });
    const other = makeLayer({
      sim,
      config: { accounts: ['11111111-1111-4111-8111-111111111111'] },
    }).layer;
    expect(await other.statusMap(input)).toMatchObject({
      ok: false,
      errorCode: 'DISABLED',
    });
    vi.stubEnv('TYPESAFE_API_KEY', '');
    const keyless = createDecisionLayer({
      config: testConfig(),
      fetch: sim.fetch,
      alert: () => {},
    });
    expect(await keyless.statusMap(input)).toMatchObject({
      ok: false,
      errorCode: 'DISABLED',
    });
    expect(sim.calls).toHaveLength(0);
  });
});
