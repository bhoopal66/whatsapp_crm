import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  rpc: vi.fn(),
  enabled: true,
  members: new Set<string>(),
  profileFilters: [] as Array<[string, string, unknown]>,
}));

// A chainable query: every filter returns itself; awaiting it is an empty list.
function chain(single: () => unknown): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  for (const k of [
    'select',
    'eq',
    'neq',
    'is',
    'in',
    'not',
    'or',
    'lt',
    'lte',
    'gt',
    'gte',
    'order',
    'limit',
  ])
    q[k] = () => q;
  q.maybeSingle = async () => single();
  q.then = (ok: (v: unknown) => unknown) => ok({ data: [], error: null });
  return q;
}

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: () => ({
    from: () =>
      chain(() => ({ data: { brain_enabled: m.enabled }, error: null })),
    rpc: m.rpc,
  }),
}));

import { GET } from './route';

const ME = '11111111-1111-4111-8111-111111111111';
const MATE = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';

// The caller's RLS client: answers a profiles row only when every filter
// the route applies matches a member of acct-1.
function rlsClient() {
  return {
    from: (table: string) => {
      const f: Record<string, unknown> = {};
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (k: string, v: unknown) => {
          m.profileFilters.push(['eq', k, v]);
          f[k] = v;
          return q;
        },
        is: (k: string, v: unknown) => {
          m.profileFilters.push(['is', k, v]);
          return q;
        },
        neq: (k: string, v: unknown) => {
          m.profileFilters.push(['neq', k, v]);
          return q;
        },
        maybeSingle: async () => ({
          data:
            table === 'profiles' &&
            f.account_id === 'acct-1' &&
            m.members.has(String(f.user_id))
              ? { user_id: f.user_id }
              : null,
          error: null,
        }),
      };
      return q;
    },
  };
}
const asRole = (role: string, salesRestricted = false) =>
  m.getCurrentAccount.mockResolvedValue({
    userId: ME,
    accountId: 'acct-1',
    role,
    salesRestricted,
    supabase: rlsClient(),
  });
const get = (query = '') =>
  GET(new Request(`http://x/api/brain/digest${query}`));
const actorsSeen = () =>
  m.rpc.mock.calls.map(
    ([, a]) =>
      (a as Record<string, unknown>).p_actor ??
      (a as Record<string, unknown>).p_user
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  m.enabled = true;
  m.members = new Set([ME, MATE]);
  m.profileFilters = [];
  asRole('agent');
  m.rpc.mockResolvedValue({ data: [], error: null });
});

describe('GET /api/brain/digest', () => {
  it('own digest, built as the session, no-store', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(body).toMatchObject({ aiGenerated: true });
    expect(body.sections.map((s: { kind: string }) => s.kind)).toEqual([
      'stale_cases',
      'promises',
      'related',
      'followups',
    ]);
    expect(m.rpc).toHaveBeenCalled();
    expect(new Set(actorsSeen())).toEqual(new Set([ME]));
  });

  it('naming oneself is the own digest for any role', async () => {
    asRole('viewer');
    const res = await get(`?userId=${ME}`);
    expect(res.status).toBe(200);
    expect(new Set(actorsSeen())).toEqual(new Set([ME]));
  });

  it('a non-admin naming someone else is 403, nothing read', async () => {
    for (const role of ['team_leader', 'agent', 'viewer']) {
      asRole(role);
      const res = await get(`?userId=${MATE}`);
      expect(res.status, role).toBe(403);
      expect(await res.json()).toEqual({ error: 'Not allowed' });
    }
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('admin: a non-member is the same 404 as an unknown id', async () => {
    asRole('admin');
    m.members = new Set([ME]);
    const notMember = await get(`?userId=${MATE}`);
    const unknown = await get(`?userId=${STRANGER}`);
    expect(notMember.status).toBe(404);
    const body = await notMember.text();
    expect(body).toBe(await unknown.text());
    expect(JSON.parse(body)).toEqual({ error: 'Not found' });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('admin: the membership check is the live, non-guest row of the active account', async () => {
    asRole('admin');
    await get(`?userId=${MATE}`);
    expect(m.profileFilters).toEqual(
      expect.arrayContaining([
        ['eq', 'user_id', MATE],
        ['eq', 'account_id', 'acct-1'],
        ['is', 'deactivated_at', null],
        ['neq', 'role', 'bank_guest'],
      ])
    );
  });

  it('admin: a member teammate digest is built as the teammate', async () => {
    asRole('owner');
    const res = await get(`?userId=${MATE}`);
    expect(res.status).toBe(200);
    expect(m.rpc).toHaveBeenCalled();
    expect(new Set(actorsSeen())).toEqual(new Set([MATE]));
  });

  it('a malformed or empty userId is 400', async () => {
    asRole('admin');
    for (const q of ['?userId=', '?userId=agentA', '?userId=1234'])
      expect((await get(q)).status, q).toBe(400);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('403 brain_disabled while the switch is off; a restricted department is refused', async () => {
    m.enabled = false;
    const off = await get();
    expect(off.status).toBe(403);
    expect(await off.json()).toEqual({ error: 'brain_disabled' });
    m.enabled = true;
    asRole('agent', true);
    expect((await get()).status).toBe(403);
    expect(m.rpc).not.toHaveBeenCalled();
  });
});
