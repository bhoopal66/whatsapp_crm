import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  caseTimeline: vi.fn(),
  store: {} as Record<string, ReturnType<typeof vi.fn>>,
  admin: { admin: true },
  rls: { rls: true },
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/cases/server', () => ({ caseStore: () => m.store }));
vi.mock('@/lib/cases/timeline', () => ({ caseTimeline: m.caseTimeline }));
vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: () => m.admin,
}));

import { CaseRefusedError } from '@/lib/cases/store';
import { GET } from './route';

const ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  m.getCurrentAccount.mockResolvedValue({
    userId: 'u-me',
    accountId: 'acct-1',
    role: 'agent',
    supabase: m.rls,
  });
  m.store = {
    get: vi.fn(async () => ({ id: ID, accountId: 'acct-1' })),
    role: vi.fn(async () => 'agent'),
  };
  m.caseTimeline.mockResolvedValue([]);
});

const get = (q = '', id = ID) =>
  GET(new Request(`http://x/api/cases/${id}/timeline${q}`), {
    params: Promise.resolve({ id }),
  });

describe('GET /api/cases/[id]/timeline', () => {
  it('is 404 for another account (no role call) and for no role', async () => {
    m.store.get.mockResolvedValue({ id: ID, accountId: 'acct-2' });
    expect((await get()).status).toBe(404);
    expect(m.store.role).not.toHaveBeenCalled();
    m.store.get.mockResolvedValue({ id: ID, accountId: 'acct-1' });
    m.store.role.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
    expect(m.caseTimeline).not.toHaveBeenCalled();
  });

  it('reads calls through the caller RLS client; messages only when asked', async () => {
    const at = new Date('2026-10-01T10:00:00Z');
    m.caseTimeline.mockResolvedValue([
      {
        at,
        kind: 'stage',
        refId: 'r1',
        actor: 'u-1',
        summary: 's',
        source: 'case',
      },
    ]);
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      entries: [
        {
          at: at.toISOString(),
          kind: 'stage',
          refId: 'r1',
          actor: 'u-1',
          summary: 's',
          source: 'case',
        },
      ],
    });
    expect(m.caseTimeline).toHaveBeenCalledWith(
      { db: m.admin, rlsDb: m.rls, store: m.store },
      { caseId: ID, actor: 'u-me', includeMessages: false }
    );
    await get('?messages=1');
    expect(m.caseTimeline.mock.calls[1][1]).toEqual({
      caseId: ID,
      actor: 'u-me',
      includeMessages: true,
    });
  });

  it('maps a timeline refusal', async () => {
    m.caseTimeline.mockRejectedValue(new CaseRefusedError('NOT_ALLOWED'));
    const res = await get();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'NOT_ALLOWED' });
  });
});
