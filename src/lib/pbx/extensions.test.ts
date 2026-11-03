import { describe, expect, it } from 'vitest';
import { createFakeDb } from './__tests__/fake-db';
import { claimUnassignedCalls } from './extensions';

describe('claimUnassignedCalls', () => {
  it("gives the person only their extension's calls with no person", async () => {
    const { db, tables } = createFakeDb({
      calls: [
        {
          id: 'k1',
          connection_id: 'c1',
          account_id: 'a',
          extension: '2851',
          user_id: null,
        },
        {
          id: 'k2',
          connection_id: 'c1',
          account_id: 'a',
          extension: '2851',
          user_id: null,
        },
        {
          id: 'k3',
          connection_id: 'c1',
          account_id: 'a',
          extension: '2851',
          user_id: 'old',
        },
        {
          id: 'k4',
          connection_id: 'c1',
          account_id: 'a',
          extension: '2852',
          user_id: null,
        },
        {
          id: 'k5',
          connection_id: 'c1',
          account_id: 'b',
          extension: '2851',
          user_id: null,
        },
        {
          id: 'k6',
          connection_id: 'c2',
          account_id: 'a',
          extension: '2851',
          user_id: null,
        },
      ],
    });
    const n = await claimUnassignedCalls(db, {
      connectionId: 'c1',
      accountId: 'a',
      extension: '2851',
      userId: 'krishma',
    });
    expect(n).toBe(2);
    expect(
      Object.fromEntries(tables.calls.map((r) => [r.id, r.user_id]))
    ).toEqual({
      k1: 'krishma',
      k2: 'krishma',
      k3: 'old',
      k4: null,
      k5: null,
      k6: null,
    });
  });
});
