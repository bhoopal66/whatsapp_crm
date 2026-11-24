import { beforeEach, describe, expect, it, vi } from 'vitest';

// A removal asks once more while customer messages still wait (264):
// Meta, OpenWA (admin and personal routes). Whapi is in route.test.ts.

const h = vi.hoisted(() => ({
  waiting: 0,
  counted: [] as string[][],
  deleted: 0,
  disconnect: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({
    supabase: {},
    accountId: 'acc-1',
    userId: 'user-1',
  }),
  getCurrentAccount: async () => ({ accountId: 'acc-1', userId: 'user-1' }),
  toErrorResponse: () => new Response(null, { status: 403 }),
}));
vi.mock('@/lib/whatsapp/waiting-messages', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  waitingMessages: async (_db: unknown, ids: string[]) => {
    h.counted.push(ids);
    return h.waiting;
  },
}));
vi.mock('@/lib/whatsapp/personal-numbers', () => ({
  personalNumbersAdmin: () => ({}),
  promoteOldestToPrimary: async () => {},
}));
vi.mock('@/lib/whatsapp/openwa-number', () => ({
  loadOpenWARow: async () => ({ id: 'cfg-1', phone_number_id: 'sess-1' }),
  disconnectOpenWANumber: h.disconnect,
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    let table = '';
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.delete = () => {
      h.deleted++;
      return b;
    };
    b.maybeSingle = async () => ({
      data: { account_id: 'acc-1' },
      error: null,
    });
    b.then = (r: (v: unknown) => unknown) =>
      r({
        data:
          table === 'profiles'
            ? [{ account_id: 'acc-1', is_active: true }]
            : [{ id: 'meta-1' }],
        error: null,
      });
    return {
      auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
      from: (t: string) => ((table = t), b),
    };
  },
}));

import { DELETE as metaDelete } from './meta/route';
import { DELETE as openwaDelete } from './openwa/[configId]/route';
import { DELETE as personalDelete } from '../personal/[configId]/route';

const ctx = { params: Promise.resolve({ configId: 'cfg-1' }) };
const req = (q = '') =>
  new Request(`https://crm.test/api/whatsapp/x${q}`, { method: 'DELETE' });

beforeEach(() => {
  h.waiting = 3;
  h.counted = [];
  h.deleted = 0;
  h.disconnect.mockReset();
  h.disconnect.mockResolvedValue(Response.json({ ok: true }));
});

describe('Meta number removal', () => {
  it('answers 409 messages_waiting and deletes nothing', async () => {
    const res = await metaDelete(req());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'messages_waiting',
      count: 3,
    });
    expect(h.counted).toEqual([['meta-1']]);
    expect(h.deleted).toBe(0);
  });

  it('removes it with ?force=1', async () => {
    const res = await metaDelete(req('?force=1'));
    expect(res.status).toBe(200);
    expect(h.deleted).toBe(1);
  });
});

describe.each([
  ['OpenWA admin route', openwaDelete],
  ['personal number route', personalDelete],
])('%s', (_name, del) => {
  it('hands the disconnect no force by default, and force with ?force=1', async () => {
    await del(req(), ctx);
    expect(h.disconnect.mock.calls[0][3]).toEqual({ force: false });
    await del(req('?force=1'), ctx);
    expect(h.disconnect.mock.calls[1][3]).toEqual({ force: true });
  });
});
