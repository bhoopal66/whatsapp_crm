import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, type FakeDb } from './test-db';

const mocks = vi.hoisted(() => ({ ids: vi.fn() }));
vi.mock('./submission-ids', () => ({ submissionGroupIds: mocks.ids }));

import { loadGroupForCaller } from './server';

const G = '22222222-2222-4222-8222-222222222222';
const WAG = '120363021111111111@g.us';
// The caller's own client still hands the row over, as it did before 299.
const db: FakeDb = {
  tables: {
    whatsapp_groups: [{ id: G, account_id: 'acct-1', wa_group_id: WAG }],
  },
  rpc: { whatsapp_group_can_manage: () => ({ data: true }) },
};
const ctx = { supabase: fakeSupabase(db) as never, accountId: 'acct-1' };

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:1');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'k');
  mocks.ids.mockReset().mockResolvedValue(new Set());
});

describe('loadGroupForCaller and submission groups (299)', () => {
  it('loads an ordinary group, for reading and for managing', async () => {
    expect(await loadGroupForCaller(ctx, G)).toMatchObject({ id: G });
    expect(await loadGroupForCaller(ctx, G, { manage: true })).toMatchObject({
      id: G,
    });
    expect(mocks.ids).toHaveBeenCalledWith(expect.anything(), 'acct-1', [WAG]);
  });

  it.each([{}, { manage: true }])(
    'is 404 for a mirror, even one the caller manages (%j)',
    async (opts) => {
      mocks.ids.mockResolvedValue(new Set([WAG]));
      await expect(loadGroupForCaller(ctx, G, opts)).rejects.toMatchObject({
        status: 404,
        code: 'not_found',
      });
    }
  );

  it('is 503 when the check fails, never the group', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.ids.mockRejectedValue(new Error('down'));
    await expect(loadGroupForCaller(ctx, G)).rejects.toMatchObject({
      status: 503,
    });
  });
});
