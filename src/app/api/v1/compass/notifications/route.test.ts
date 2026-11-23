import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  ors: [] as string[],
  eqs: [] as unknown[][],
  rows: [] as Record<string, unknown>[],
}));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: vi.fn(async () => ({
    accountId: 'acct-1',
    supabase: {
      from: () => {
        const q = {
          select: () => q,
          eq: (...args: unknown[]) => {
            state.eqs.push(args);
            return q;
          },
          or: (filter: string) => {
            state.ors.push(filter);
            return q;
          },
          order: () => q,
          limit: () => q,
          then: (resolve: (v: unknown) => void) =>
            resolve({ data: state.rows, error: null }),
        };
        return q;
      },
    },
  })),
}));
vi.mock('@/lib/submission-groups/server', () => ({
  submissionGroupService: vi.fn(),
}));

import { GET } from './route';

const list = (qs: string) =>
  GET(new Request(`http://x/api/v1/compass/notifications${qs}`));

beforeEach(() => {
  state.ors = [];
  state.eqs = [];
  state.rows = [];
});

describe('GET /api/v1/compass/notifications ?status=', () => {
  it('asks for the status the rows are shown with, not the stored column', async () => {
    await list('?status=failed');
    await list('?status=sending');
    await list('?status=sent');
    expect(state.ors).toEqual([
      expect.stringMatching(
        /^status\.eq\.failed,and\(status\.eq\.sending,error_code\.eq\.delivery_unconfirmed,updated_at\.lt\.\S+Z\)$/
      ),
      expect.stringMatching(
        /^and\(status\.eq\.sending,or\(error_code\.is\.null,updated_at\.gte\.\S+Z\)\)$/
      ),
      'status.eq.sent',
    ]);
    // Still the key's own account, and no filter on the raw column.
    expect(state.eqs).toEqual(Array(3).fill(['account_id', 'acct-1']));
  });

  it('keeps the cursor beside the status', async () => {
    const id = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    state.rows = ['09:02', '09:01'].map((at) => ({
      id,
      status: 'sent',
      created_at: `2026-11-23T${at}:00Z`,
    }));
    const page = await (await list('?limit=1')).json();
    await list(`?status=failed&cursor=${page.meta.next_cursor}`);
    expect(state.ors).toHaveLength(2);
    expect(state.ors[1]).toContain('created_at.lt.2026-11-23T09:02:00Z');
  });

  it('refuses an unknown status', async () => {
    expect((await list('?status=stuck')).status).toBe(400);
  });
});
