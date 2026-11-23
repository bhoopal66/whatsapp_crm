import { expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ rows: [] as { id: string }[] }));
vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({ accountId: 'acc-1', userId: 'u-1' }),
  toErrorResponse: vi.fn(),
}));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const q = {
        update: () => q,
        eq: () => q,
        select: () => q,
        then: (resolve: (v: unknown) => void) =>
          resolve({ data: db.rows, error: null }),
      };
      return q;
    },
  }),
}));

import { PATCH } from './route';

const save = () =>
  PATCH(
    new Request('http://x', {
      method: 'PATCH',
      body: JSON.stringify({
        title: 'Hi',
        kind: 'text',
        content_text: 'Hello',
      }),
    }),
    { params: Promise.resolve({ id: 'qr-1' }) }
  );

it('a quick reply that was removed answers 404, not success', async () => {
  db.rows = [];
  expect((await save()).status).toBe(404);
});

it('one that is there is saved', async () => {
  db.rows = [{ id: 'qr-1' }];
  expect((await save()).status).toBe(200);
});
