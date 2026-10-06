import { beforeEach, describe, expect, it, vi } from 'vitest';

const upserts: Array<{ rows: unknown[]; opts: unknown }> = [];

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: vi.fn(async () => ({
    accountId: 'acct-1',
    supabase: {
      from: () => ({
        upsert: (rows: unknown[], opts: unknown) => {
          upserts.push({ rows, opts });
          return {
            select: async () => ({
              data: rows.map((_, i) => ({ id: `r${i}` })),
              error: null,
            }),
          };
        },
      }),
    },
  })),
}));

import { POST } from './route';

const post = (body: unknown) =>
  POST(
    new Request('http://x/api/v1/compass/contacts', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );

beforeEach(() => {
  upserts.length = 0;
});

describe('POST /api/v1/compass/contacts', () => {
  it('rejects a body without a contacts array', async () => {
    const res = await post({ contact: {} });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_request');
  });

  it('rejects an oversized batch outright', async () => {
    const res = await post({
      contacts: Array.from({ length: 501 }, (_, i) => ({ compass_id: i })),
    });
    expect(res.status).toBe(400);
    expect(upserts).toHaveLength(0);
  });

  it('stores the good records scoped to the key account and reports the bad ones', async () => {
    const res = await post({
      contacts: [
        { compass_id: 'A', phone: '+971501234567', name: 'Jane' },
        { compass_id: 'B', phone: '0501234567' },
      ],
    });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({ received: 2, upserted: 1 });
    expect(data.rejected).toEqual([
      { index: 1, compass_id: 'B', error: expect.stringMatching(/country/) },
    ]);
    expect(upserts[0].opts).toEqual({ onConflict: 'account_id,compass_id' });
    expect(upserts[0].rows).toEqual([
      expect.objectContaining({
        account_id: 'acct-1',
        compass_id: 'A',
        phone: '971501234567',
      }),
    ]);
    // The CRM link is never part of a sync write, so it survives re-syncs.
    expect(upserts[0].rows[0]).not.toHaveProperty('contact_id');
  });

  it('accepts an empty batch as a no-op', async () => {
    const res = await post({ contacts: [] });
    expect(res.status).toBe(200);
    expect(upserts).toHaveLength(0);
  });
});
