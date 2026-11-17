import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  rpc: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

import { GET, PUT } from './route';

const ID = '3f2c1a9e-1b2c-4d3e-8f4a-5b6c7d8e9f01';
const put = (body: unknown) =>
  new Request('http://localhost/api/team-activity/new-chat-notice', {
    method: 'PUT',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.upsert.mockResolvedValue({ error: null });
  mocks.rpc.mockResolvedValue({
    data: { enabled: true, channel_id: ID, channel_label: 'Mkt' },
    error: null,
  });
  mocks.requireRole.mockResolvedValue({
    userId: 'u-1',
    accountId: 'acc-1',
    supabase: {
      rpc: mocks.rpc,
      from: vi.fn(() => ({ upsert: mocks.upsert })),
    },
  });
});

describe('GET', () => {
  it('needs viewer and returns the parsed notice', async () => {
    const res = await GET();
    expect(mocks.requireRole).toHaveBeenCalledWith('viewer');
    const { notice } = await res.json();
    expect(notice).toMatchObject({
      enabled: true,
      channelId: ID,
      channelLabel: 'Mkt',
    });
  });
  it.each(['42883', 'PGRST202'])(
    'defaults when the function is missing (%s)',
    async (code) => {
      mocks.rpc.mockResolvedValue({
        data: null,
        error: { code, message: 'x' },
      });
      const res = await GET();
      expect(res.status).toBe(200);
      expect((await res.json()).notice).toMatchObject({
        enabled: true,
        channelId: null,
      });
    }
  );
  it('500s on another error', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: 'XX', message: 'x' },
    });
    expect((await GET()).status).toBe(500);
  });
});

describe('PUT', () => {
  it('needs admin, upserts on account_id, returns the notice', async () => {
    const res = await PUT(put({ enabled: false, channelId: ID, text: ' hi ' }));
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(mocks.upsert).toHaveBeenCalledWith(
      {
        account_id: 'acc-1',
        enabled: false,
        marketing_channel_id: ID,
        notice_text: 'hi',
      },
      { onConflict: 'account_id' }
    );
    expect(res.status).toBe(200);
    expect((await res.json()).notice.channelId).toBe(ID);
  });
  it('400s on bad JSON and bad bodies', async () => {
    expect((await PUT(put('{'))).status).toBe(400);
    expect((await PUT(put({ channelId: null }))).status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it.each([
    ['22023', 400],
    ['23503', 400],
    ['42501', 403],
    ['XX000', 500],
  ])('maps %s to %i', async (code, status) => {
    mocks.upsert.mockResolvedValue({ error: { code, message: 'x' } });
    const res = await PUT(put({ enabled: true, channelId: ID, text: null }));
    expect(res.status).toBe(status);
    expect(typeof (await res.json()).error).toBe('string');
  });
});
