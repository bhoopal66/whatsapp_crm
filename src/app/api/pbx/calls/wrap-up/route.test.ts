import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb, type FakeDb } from '@/lib/pbx/__tests__/fake-db';
import { WRAPUP_MS, WRAPUP_OWED_MS } from '@/lib/pbx/call-ui';

const mocks = vi.hoisted(() => ({ requireRole: vi.fn() }));
vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'Forbidden' }, { status: 403 })
  ),
}));

import { GET } from './route';

let fake: FakeDb;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const call = (over: Record<string, unknown>) => ({
  account_id: 'acc',
  connection_id: 'conn',
  pbx_call_id: 'p',
  direction: 'inbound',
  user_id: 'me',
  contact_id: 'k1',
  remote_number: '971500000001',
  answered_at: ago(5 * 60_000),
  ended_at: ago(20_000),
  disposition: null,
  erased_at: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRole.mockImplementation(async () => ({
    supabase: fake.db,
    accountId: 'acc',
    userId: 'me',
    role: 'agent',
  }));
});

describe('GET /api/pbx/calls/wrap-up', () => {
  it('answers my newest call still in its wrap-up, timed by the server', async () => {
    fake = createFakeDb({
      calls: [
        call({ pbx_call_id: 'older', ended_at: ago(80_000) }),
        call({ pbx_call_id: 'mine', ended_at: ago(30_000), contact_id: 'k2' }),
        // Newer, but not mine, not this workspace, or already done.
        call({ pbx_call_id: 'theirs', user_id: 'other', ended_at: ago(1000) }),
        call({
          pbx_call_id: 'elsewhere',
          account_id: 'b',
          ended_at: ago(1000),
        }),
        call({
          pbx_call_id: 'done',
          disposition: 'interested',
          ended_at: ago(1000),
        }),
        call({
          pbx_call_id: 'internal',
          direction: 'internal',
          ended_at: ago(1000),
        }),
      ],
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const { call: c } = await res.json();
    expect(c).toMatchObject({
      connectionId: 'conn',
      pbxCallId: 'mine',
      direction: 'inbound',
      contactId: 'k2',
      remoteNumber: '971500000001',
    });
    expect(c.leftMs).toBeGreaterThan(WRAPUP_MS - 31_000);
    expect(c.leftMs).toBeLessThanOrEqual(WRAPUP_MS - 30_000);
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
  });

  it('answers null once the two minutes are up', async () => {
    fake = createFakeDb({
      calls: [call({ pbx_call_id: 'late', ended_at: ago(WRAPUP_MS + 1000) })],
      pbx_settings: [{ account_id: 'acc', mandatory_disposition: false }],
    });
    expect(await (await GET()).json()).toEqual({
      call: null,
      mandatory: false,
    });
  });

  it('re-opens an owed outcome past the two minutes where outcomes are mandatory', async () => {
    fake = createFakeDb({
      calls: [
        call({ pbx_call_id: 'owed', ended_at: ago(10 * 60_000) }),
        call({ pbx_call_id: 'stale', ended_at: ago(WRAPUP_OWED_MS + 1000) }),
      ],
      pbx_settings: [
        { account_id: 'b', mandatory_disposition: false },
        { account_id: 'acc', mandatory_disposition: true },
      ],
    });
    const body = await (await GET()).json();
    expect(body.mandatory).toBe(true);
    expect(body.call).toMatchObject({ pbxCallId: 'owed', leftMs: 0 });

    fake.tables.calls = fake.tables.calls.filter(
      (c) => c.pbx_call_id === 'stale'
    );
    expect(await (await GET()).json()).toEqual({
      call: null,
      mandatory: true,
    });
  });

  it('refuses below agent', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));
    expect((await GET()).status).toBe(403);
  });
});
