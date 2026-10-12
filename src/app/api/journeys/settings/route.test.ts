import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb, type Reply } from '@/lib/journeys/host/fake-db';
import { DEFAULT_COPY } from '@/lib/journeys/host/copy';

const h = vi.hoisted(() => ({ requireRole: vi.fn() }));

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: (err: { message: string; status?: number }) =>
    Response.json({ error: err.message }, { status: err.status ?? 500 }),
}));

import { GET, PUT } from './route';

const ROW = {
  enabled: true,
  workflow_key: 'taamul_welcome_to_close.v1',
  start_on_first_inbound: false,
  taamul_did: '+97141234567',
  copy: { titles: { POS: 'POS machine' } },
  updated_at: '2026-10-12T10:00:00Z',
};
const SETTINGS = {
  enabled: true,
  workflowKey: 'taamul_welcome_to_close.v1',
  startOnFirstInbound: false,
  taamulDid: '+97141234567',
  copy: { titles: { POS: 'POS machine' } },
  updatedAt: '2026-10-12T10:00:00Z',
};

function setup(...replies: Reply[]) {
  const { db, queries } = fakeDb(...replies);
  h.requireRole.mockResolvedValue({
    supabase: db,
    userId: 'user-1',
    accountId: 'acc-1',
    role: 'admin',
  });
  return queries;
}

const put = (body: unknown) =>
  PUT(
    new Request('http://localhost/api/journeys/settings', {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  );

describe('/api/journeys/settings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET: any member reads the settings and the default copy', async () => {
    const queries = setup({ data: ROW });
    const res = await GET();
    expect(h.requireRole).toHaveBeenCalledWith('viewer');
    expect(await res.json()).toEqual({
      settings: SETTINGS,
      defaultCopy: DEFAULT_COPY,
    });
    expect(queries[0]).toContainEqual(['eq', 'account_id', 'acc-1']);
  });

  it('GET: no row reads as switched off', async () => {
    setup({ data: null });
    const { settings } = await (await GET()).json();
    expect(settings).toEqual({
      enabled: false,
      workflowKey: null,
      startOnFirstInbound: false,
      taamulDid: null,
      copy: {},
      updatedAt: null,
    });
  });

  it('PUT needs an admin', async () => {
    h.requireRole.mockRejectedValue(
      Object.assign(new Error('forbidden'), { status: 403 })
    );
    expect((await put({ enabled: true })).status).toBe(403);
    expect(h.requireRole).toHaveBeenCalledWith('admin');
  });

  it('PUT upserts only the fields sent', async () => {
    const queries = setup({ data: ROW });
    const copy = {
      messages: {
        callback_ack: { body: 'Hi', variants: { IN_HOURS: 'Soon' } },
      },
      titles: { POS: 'POS machine' },
    };
    const res = await put({
      enabled: true,
      startOnFirstInbound: false,
      taamulDid: ' +971 4 123-4567 ',
      copy,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ settings: SETTINGS });
    expect(queries[0]).toContainEqual([
      'upsert',
      {
        account_id: 'acc-1',
        enabled: true,
        start_on_first_inbound: false,
        taamul_did: '+97141234567',
        copy,
      },
      { onConflict: 'account_id' },
    ]);

    const q2 = setup({ data: ROW });
    await put({ taamulDid: '' });
    expect(q2[0]).toContainEqual([
      'upsert',
      { account_id: 'acc-1', taamul_did: null },
      { onConflict: 'account_id' },
    ]);
  });

  it('PUT validates every field', async () => {
    for (const body of [
      null,
      {},
      { enabled: 'yes' },
      { startOnFirstInbound: 1 },
      { taamulDid: '0501234567' },
      { taamulDid: 9714 },
      { copy: [] },
      { copy: { footer: {} } },
      { copy: { titles: { POS: 3 } } },
      { copy: { messages: { welcome_menu: 'Hi' } } },
      { copy: { messages: { welcome_menu: { body: 1 } } } },
      { copy: { messages: { welcome_menu: { emoji: 'x' } } } },
    ]) {
      const queries = setup();
      expect((await put(body)).status, JSON.stringify(body)).toBe(400);
      expect(queries).toEqual([]);
    }
  });
});
