import { describe, expect, it, vi } from 'vitest';

import { createDecisionLayer } from './index';
import { ROUTE_QUESTIONS } from './questions/route';
import { approvedDb, makeSim, testConfig, TEST_ACCOUNT } from './test-helpers';

function layerWith(
  transferAllowed?: (a: string, c: string, n: number) => Promise<boolean>
) {
  const sim = makeSim();
  const db = approvedDb();
  const layer = createDecisionLayer({
    config: testConfig(),
    apiKey: 'test-key',
    fetch: sim.fetch,
    alert: () => {},
    store: { ...db.store, accountSwitches: async () => null },
    transferAllowed,
  });
  return { layer, sim };
}

describe('AI transfer register on the TypeSafe gateway (migration 224)', () => {
  it('sends nothing when the workspace requires a basis it lacks', async () => {
    const allowed = vi.fn(async () => false);
    const { layer, sim } = layerWith(allowed);
    const r = await layer.gateway.ask(
      'route',
      { text: 'hi' },
      ROUTE_QUESTIONS,
      TEST_ACCOUNT
    );
    expect(r).toMatchObject({ ok: false, errorCode: 'TRANSFER_REFUSED' });
    expect(sim.calls).toHaveLength(0);
    expect(allowed).toHaveBeenCalledWith(
      TEST_ACCOUNT,
      'route',
      expect.any(Number)
    );
  });

  it('sends when allowed, and never asks for the account-less call', async () => {
    const allowed = vi.fn(async () => true);
    const { layer, sim } = layerWith(allowed);
    await layer.gateway.ask(
      'route',
      { text: 'hi' },
      ROUTE_QUESTIONS,
      TEST_ACCOUNT
    );
    expect(sim.calls).toHaveLength(1);
    await layer.gateway.ask('route', { text: 'hi' }, ROUTE_QUESTIONS);
    expect(allowed).toHaveBeenCalledTimes(1);
  });
});
