import { beforeEach, describe, expect, it, vi } from 'vitest';

const ctx = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  writes: [] as Record<string, unknown>[],
  /** What another request did to the row between our read and write. */
  meanwhile: null as Record<string, unknown> | null,
  role: 'admin' as string,
  /** What a DELETE ... RETURNING answers. */
  deleted: { data: [{ id: 'x' }], error: null } as {
    data: { id: string }[] | null;
    error: { message: string } | null;
  },
}));
vi.mock('@/lib/auth/account', () => {
  class E extends Error {}
  const query = () => {
    let updating = false;
    let deleting = false;
    const q = {
      // Only the columns asked for come back, as from PostgREST.
      columns: [] as string[],
      delete: () => {
        deleting = true;
        return q;
      },
      select: (columns = '') => {
        if (deleting) return Promise.resolve(ctx.deleted);
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
      role: ctx.role,
    }),
    toErrorResponse: (e: Error) =>
      Response.json({ error: e.message }, { status: 403 }),
    ForbiddenError: E,
    UnauthorizedError: E,
  };
});

import { DELETE, PATCH } from './route';

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

const del = () =>
  DELETE(new Request('http://x', { method: 'DELETE' }), {
    params: Promise.resolve({ id: ID }),
  });

describe('who may edit or delete a template', () => {
  beforeEach(() => {
    ctx.role = 'admin';
    ctx.row = { id: ID, meta_template_id: null, status: 'APPROVED' };
    ctx.writes = [];
    ctx.meanwhile = null;
    ctx.deleted = { data: [{ id: ID }], error: null };
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it.each(['agent', 'viewer'])(
    '%s PATCH answers 403, writes nothing',
    async (role) => {
      ctx.role = role;
      const res = await patch();
      expect(res.status).toBe(403);
      expect(ctx.writes).toEqual([]);
    }
  );

  it.each(['agent', 'viewer'])('%s DELETE answers 403', async (role) => {
    ctx.role = role;
    const res = await del();
    expect(res.status).toBe(403);
  });

  it('an admin delete succeeds', async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it('a delete that matched no row answers 404, not success', async () => {
    ctx.deleted = { data: [], error: null };
    const res = await del();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Template not found.' });
  });

  it('a database error answers a fixed message with no database text', async () => {
    ctx.deleted = { data: null, error: { message: 'relation secret_tbl fk' } };
    const res = await del();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'Failed to delete template.' });
    expect(JSON.stringify(body)).not.toContain('secret_tbl');
    expect(console.error).toHaveBeenCalled();
  });
});
