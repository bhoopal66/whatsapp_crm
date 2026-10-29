import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  makeLayer,
  makeSim,
  type SimReply,
  TEST_ACCOUNT,
} from '@/lib/typesafe/test-helpers';

import {
  clearSuggestionCache,
  knownMappingsFor,
  suggestStages,
  type StatusMapOverview,
} from './status-map';

const overview = (n: number): StatusMapOverview => ({
  stages: ['Submitted', 'Under review', 'Approved'],
  mapped: [
    {
      status_key: 'BANK OK',
      status_label: 'Bank OK',
      stage: 'Approved',
      source: 'admin',
      suggested_p: null,
      open_cases: 2,
      unresolved_open_cases: 0,
    },
  ],
  unmapped: Array.from({ length: n }, (_, i) => ({
    status_key: `STATUS ${i}`,
    sample_label: `Status ${i}`,
    open_cases: i,
  })),
});

beforeEach(() => clearSuggestionCache());
afterEach(() => vi.unstubAllEnvs());

describe('knownMappingsFor', () => {
  it("puts the account's rows first, then name-rule examples whose stage exists", () => {
    expect(knownMappingsFor(overview(0))).toEqual([
      { status: 'Bank OK', stage: 'Approved' },
      { status: 'UNDER_REVIEW', stage: 'Under review' },
    ]);
  });
});

describe('suggestStages', () => {
  it('judges at most 30 statuses, those with the most open cases', async () => {
    const sim = makeSim(() => ({ answers: { stage: 'o2' } }));
    const { layer } = makeLayer({ sim });
    const out = await suggestStages(TEST_ACCOUNT, overview(40), { layer });
    expect(sim.calls).toHaveLength(30);
    expect(Object.keys(out)).toHaveLength(30);
    expect(out['STATUS 39']).toMatchObject({ stage: 'Under review' });
    expect(out['STATUS 9']).toBeUndefined();
    const sent = sim.calls.map(
      (c) => (c.body.state as { status: string }).status
    );
    expect(sent).toContain('Status 39');
    expect(sent).not.toContain('Status 9');
  });

  it('answers a repeat from the cache for an hour, then asks again', async () => {
    const sim = makeSim(() => ({ answers: { stage: 'o1' } }));
    const { layer } = makeLayer({ sim });
    let t = 1_000_000;
    const now = () => t;
    await suggestStages(TEST_ACCOUNT, overview(2), { layer, now });
    expect(sim.calls).toHaveLength(2);
    const again = await suggestStages(TEST_ACCOUNT, overview(2), {
      layer,
      now,
    });
    expect(sim.calls).toHaveLength(2);
    expect(again['STATUS 1']).toMatchObject({ stage: 'Submitted' });
    // a different stage list is a different question
    await suggestStages(
      TEST_ACCOUNT,
      { ...overview(2), stages: ['Submitted', 'Approved'] },
      { layer, now }
    );
    expect(sim.calls).toHaveLength(4);
    t += 60 * 60_000;
    await suggestStages(TEST_ACCOUNT, overview(2), { layer, now });
    expect(sim.calls).toHaveLength(6);
  });

  it('asks again once a new mapping is saved (a new example for Jev)', async () => {
    const sim = makeSim(() => ({ answers: { stage: 'o1' } }));
    const { layer } = makeLayer({ sim });
    const now = () => 1_000_000;
    await suggestStages(TEST_ACCOUNT, overview(2), { layer, now });
    expect(sim.calls).toHaveLength(2);
    const base = overview(2);
    const saved: StatusMapOverview = {
      ...base,
      mapped: [
        ...base.mapped,
        {
          status_key: 'IN REVIEW',
          status_label: 'In Review',
          stage: 'Under review',
          source: 'admin',
          suggested_p: null,
          open_cases: 1,
          unresolved_open_cases: 0,
        },
      ],
    };
    await suggestStages(TEST_ACCOUNT, saved, { layer, now });
    expect(sim.calls).toHaveLength(4);
  });

  it('leaves out a status Jev could not judge, and does not cache it', async () => {
    let down = true;
    const sim = makeSim((): SimReply => (down ? { status: 503 } : {}));
    const { layer } = makeLayer({ sim });
    expect(await suggestStages(TEST_ACCOUNT, overview(1), { layer })).toEqual(
      {}
    );
    down = false;
    const out = await suggestStages(TEST_ACCOUNT, overview(1), { layer });
    expect(Object.keys(out)).toEqual(['STATUS 0']);
  });

  it('is {} when Jev is unavailable', async () => {
    const sim = makeSim();
    expect(
      await suggestStages(TEST_ACCOUNT, overview(3), { layer: null })
    ).toEqual({});
    const { layer } = makeLayer({
      sim,
      config: { accounts: ['11111111-1111-4111-8111-111111111111'] },
    });
    expect(await suggestStages(TEST_ACCOUNT, overview(3), { layer })).toEqual(
      {}
    );
    expect(sim.calls).toHaveLength(0);
  });

  it('never throws', async () => {
    const layer = {
      config: makeLayer({ sim: makeSim() }).layer.config,
      gateway: makeLayer({ sim: makeSim() }).layer.gateway,
      statusMap: () => {
        throw new Error('boom');
      },
    };
    expect(
      await suggestStages(TEST_ACCOUNT, overview(2), { layer: layer as never })
    ).toEqual({});
  });
});
