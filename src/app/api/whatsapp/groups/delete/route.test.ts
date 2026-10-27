import { beforeEach, describe, expect, it, vi } from 'vitest';

// Deleting from the CRM is owner/admin only and touches nothing but
// groups our number has LEFT in the caller's active account. Both
// filters sit on the DELETE itself, so a group re-joined between the
// read and the delete survives.

type Row = { id: string; account_id: string; our_role: string };
type Op = { kind: 'select' | 'delete'; calls: Array<[string, unknown[]]> };

/** An in-memory `whatsapp_groups` that applies eq/in like PostgREST. */
function fakeDb(rows: Row[], log: Op[], afterRead?: () => void) {
  return {
    from(table: string) {
      expect(table).toBe('whatsapp_groups');
      const op: Op = { kind: 'select', calls: [] };
      log.push(op);
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in']) {
        q[m] = (...args: unknown[]) => (op.calls.push([m, args]), q);
      }
      q.delete = () => ((op.kind = 'delete'), q);
      q.then = (ok: (v: unknown) => unknown) => {
        const hit = rows.filter((r) =>
          op.calls.every(([m, args]) => {
            const col = args[0] as keyof Row;
            if (m === 'eq') return r[col] === args[1];
            if (m === 'in') return (args[1] as string[]).includes(r[col]);
            return true;
          })
        );
        if (op.kind === 'delete') {
          for (const r of hit) rows.splice(rows.indexOf(r), 1);
        } else {
          afterRead?.();
        }
        return Promise.resolve({
          data: hit.map((r) => ({ id: r.id })),
          error: null,
        }).then(ok);
      };
      return q;
    },
  };
}

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  admin: null as unknown,
}));

// `requireRole` calls `getCurrentAccount` inside its own module, so it
// is re-implemented over the mock with the real role ladder and error.
vi.mock('@/lib/auth/account', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth/account')>();
  const { hasMinRole } = await import('@/lib/auth/roles');
  return {
    ...real,
    requireRole: async (min: Parameters<typeof hasMinRole>[1]) => {
      const ctx = await mocks.getCurrentAccount();
      if (!hasMinRole(ctx.role, min)) {
        throw new real.ForbiddenError('Insufficient role');
      }
      return ctx;
    },
  };
});
vi.mock('@/lib/groups/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/groups/server')>()),
  supabaseAdmin: () => mocks.admin,
}));

import { POST } from './route';

const LEFT = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const OTHER_ACCT = '33333333-3333-4333-8333-333333333333';
const LEFT2 = '44444444-4444-4444-8444-444444444444';
const MISSING = '55555555-5555-4555-8555-555555555555';

let rows: Row[];
let log: Op[];

const post = (body: unknown) =>
  POST(
    new Request('http://x/api/whatsapp/groups/delete', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );

function asRole(role: string) {
  mocks.getCurrentAccount.mockResolvedValue({
    supabase: {},
    userId: 'u-1',
    accountId: 'acct-1',
    role,
    account: { id: 'acct-1', name: 'A' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rows = [
    { id: LEFT, account_id: 'acct-1', our_role: 'left' },
    { id: LEFT2, account_id: 'acct-1', our_role: 'left' },
    { id: MEMBER, account_id: 'acct-1', our_role: 'member' },
    { id: OTHER_ACCT, account_id: 'acct-2', our_role: 'left' },
  ];
  log = [];
  mocks.admin = fakeDb(rows, log);
  asRole('admin');
});

describe('POST /api/whatsapp/groups/delete', () => {
  it('refuses a team leader before touching the database', async () => {
    asRole('team_leader');
    const res = await post({ ids: [LEFT] });
    expect(res.status).toBe(403);
    expect(await res.json()).toHaveProperty('error');
    expect(log).toEqual([]);
    expect(rows).toHaveLength(4);
  });

  it.each([
    ['no body', null],
    ['no ids', {}],
    ['empty ids', { ids: [] }],
    ['a non-uuid', { ids: [LEFT, 'nope'] }],
    ['over 100 ids', { ids: Array.from({ length: 101 }, () => LEFT) }],
  ])('answers 400 for %s', async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.any(String) });
    expect(log).toEqual([]);
  });

  it('deletes only the left groups of the caller account', async () => {
    const res = await post({
      ids: [LEFT, MEMBER, OTHER_ACCT, LEFT2, MISSING],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted.sort()).toEqual([LEFT, LEFT2].sort());
    expect(body.skipped.sort()).toEqual([MEMBER, OTHER_ACCT, MISSING].sort());
    expect(rows.map((r) => r.id).sort()).toEqual([MEMBER, OTHER_ACCT].sort());
  });

  it('owners may delete too', async () => {
    asRole('owner');
    const res = await post({ ids: [LEFT] });
    expect(await res.json()).toEqual({ deleted: [LEFT], skipped: [] });
  });

  it('puts the account and left filters on the delete query itself', async () => {
    await post({ ids: [LEFT] });
    const del = log.find((op) => op.kind === 'delete');
    expect(del?.calls).toEqual(
      expect.arrayContaining([
        ['eq', ['account_id', 'acct-1']],
        ['eq', ['our_role', 'left']],
      ])
    );
  });

  it('keeps a group re-joined between the read and the delete', async () => {
    mocks.admin = fakeDb(rows, log, () => {
      rows.find((r) => r.id === LEFT)!.our_role = 'member';
    });
    const res = await post({ ids: [LEFT, LEFT2] });
    expect(await res.json()).toEqual({ deleted: [LEFT2], skipped: [LEFT] });
    expect(rows.some((r) => r.id === LEFT)).toBe(true);
  });

  it('runs no delete when none of the ids is a left group', async () => {
    const res = await post({ ids: [MEMBER] });
    expect(await res.json()).toEqual({ deleted: [], skipped: [MEMBER] });
    expect(log.some((op) => op.kind === 'delete')).toBe(false);
  });
});
