import { describe, expect, it, vi } from 'vitest';

const ctx = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  writes: [] as Record<string, unknown>[],
}));
vi.mock('@/lib/auth/account', () => {
  class E extends Error {}
  const query = () => {
    let updating = false;
    const q = {
      // Only the columns asked for come back, as from PostgREST.
      columns: [] as string[],
      select: (columns = '') => {
        if (!updating) q.columns = columns.split(', ');
        return q;
      },
      eq: () => q,
      update: (values: Record<string, unknown>) => {
        updating = true;
        ctx.writes.push(values);
        return q;
      },
      maybeSingle: async () => ({
        data:
          ctx.row &&
          Object.fromEntries(q.columns.map((c) => [c, ctx.row?.[c] ?? null])),
        error: null,
      }),
      single: async () => ({ data: ctx.row, error: null }),
    };
    return q;
  };
  return {
    assertSalesAccess: (x: unknown) => x,
    getCurrentAccount: async () => ({
      supabase: { from: query },
      accountId: 'acc-1',
    }),
    toErrorResponse: vi.fn(),
    ForbiddenError: E,
    UnauthorizedError: E,
  };
});

import { PATCH } from './route';

const ID = '11111111-1111-4111-8111-111111111111';
const edit = (row: Record<string, unknown>) => {
  ctx.row = { id: ID, ...row };
  ctx.writes = [];
  return PATCH(
    new Request('http://x', {
      method: 'PATCH',
      body: JSON.stringify({
        name: 'hello',
        language: 'en_US',
        category: 'Utility',
        body_text: 'New words',
      }),
    }),
    { params: Promise.resolve({ id: ID }) }
  );
};

describe('editing a template', () => {
  it('one synced from Meta answers 409 and writes nothing', async () => {
    const res = await edit({ meta_template_id: '987', status: 'PENDING' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('META_TEMPLATE');
    expect(body.error).toContain('Meta Business Manager');
    expect(ctx.writes).toEqual([]);
  });

  it('one kept here is edited, live at once', async () => {
    const res = await edit({ meta_template_id: null });
    expect(res.status).toBe(200);
    expect(ctx.writes).toMatchObject([
      { body_text: 'New words', status: 'APPROVED' },
    ]);
  });
});
