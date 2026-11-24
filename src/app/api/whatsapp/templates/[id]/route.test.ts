import { describe, expect, it, vi } from 'vitest';

const ctx = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  writes: [] as Record<string, unknown>[],
  /** What another request did to the row between our read and write. */
  meanwhile: null as Record<string, unknown> | null,
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
      values: {} as Record<string, unknown>,
      onlyIfNull: [] as string[],
      is: (column: string) => {
        q.onlyIfNull.push(column);
        return q;
      },
      update: (values: Record<string, unknown>) => {
        updating = true;
        q.values = values;
        return q;
      },
      // An UPDATE answers the row it wrote, or none when its filters
      // left it out.
      write: async () => {
        const now: Record<string, unknown> = { ...ctx.row, ...ctx.meanwhile };
        if (q.onlyIfNull.some((c) => (now[c] ?? null) !== null)) {
          return { data: null, error: null };
        }
        ctx.writes.push(q.values);
        return { data: { ...now, ...q.values }, error: null };
      },
      maybeSingle: async () =>
        updating
          ? q.write()
          : {
              data:
                ctx.row &&
                Object.fromEntries(
                  q.columns.map((c) => [c, ctx.row?.[c] ?? null])
                ),
              error: null,
            },
      single: async () => q.write(),
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
  ctx.meanwhile = null;
  return patch();
};
const patch = () =>
  PATCH(
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

  it('says that nothing went to Meta', async () => {
    const res = await edit({ meta_template_id: null });
    expect((await res.json()).meta).toEqual({
      submitted: false,
      reason: 'edit',
    });
  });

  it('does not lift a refusal: Meta still does not know it', async () => {
    const res = await edit({
      meta_template_id: null,
      status: 'APPROVED',
      submission_error: 'Bad footer',
    });
    expect((await res.json()).template.submission_error).toBe('Bad footer');
  });

  it('a draft kept here goes live with the edit', async () => {
    await edit({ meta_template_id: null, status: 'DRAFT' });
    expect(ctx.writes).toMatchObject([{ status: 'APPROVED' }]);
  });

  it.each([
    'PENDING',
    'REJECTED',
    'PAUSED',
    'DISABLED',
    'IN_APPEAL',
    'PENDING_DELETION',
  ])("a verdict of Meta's (%s) is never raised by an edit", async (status) => {
    const res = await edit({ meta_template_id: null, status });
    expect(res.status).toBe(200);
    expect(ctx.writes).toMatchObject([{ body_text: 'New words' }]);
    expect(ctx.writes[0]).not.toHaveProperty('status');
    expect(ctx.writes[0]).not.toHaveProperty('rejection_reason');
  });

  it('one Meta took between the read and the write answers 409', async () => {
    ctx.row = { id: ID, meta_template_id: null, status: 'APPROVED' };
    ctx.writes = [];
    ctx.meanwhile = { meta_template_id: '987', status: 'PENDING' };
    const res = await patch();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('META_TEMPLATE');
    expect(ctx.writes).toEqual([]);
  });
});
