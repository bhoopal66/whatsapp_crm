import { beforeEach, describe, expect, it, vi } from 'vitest';

// /api/whatsapp/meta/protection — number protection settings and the
// decision log. The database is a fake that records each table read and
// each RPC; the role check is mocked at the module boundary with the
// real error classes.

const reads: string[] = [];
const rpcs: { name: string; args: Record<string, unknown> }[] = [];
const rpcErrors: Record<string, { message: string; hint?: string }> = {};

function makeSupabase() {
  return {
    from(table: string) {
      reads.push(table);
      const b: Record<string, unknown> = {};
      for (const f of ['select', 'eq', 'order', 'limit']) b[f] = () => b;
      b.maybeSingle = async () => {
        if (table === 'meta_protection_settings') {
          return {
            data: { enforce: true, daily_marketing_cap: 40 },
            error: null,
          };
        }
        if (table === 'send_protection_caps') {
          return {
            data: {
              daily_marketing_spend_micros: '5000000',
              daily_ai_spend_micros: null,
            },
            error: null,
          };
        }
        return { data: null, error: null };
      };
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({
          data: [
            {
              id: 9,
              at: '2026-11-28T09:00:00Z',
              decision: 'DENY',
              reason: 'OPTED_OUT',
              template: 'promo',
              enforced: true,
            },
          ],
          error: null,
        });
      return b;
    },
  };
}

const requireRole = vi.fn();
vi.mock('@/lib/auth/account', async () => {
  const real =
    await vi.importActual<typeof import('@/lib/auth/account')>(
      '@/lib/auth/account'
    );
  return {
    ForbiddenError: real.ForbiddenError,
    toErrorResponse: real.toErrorResponse,
    requireRole: (...a: unknown[]) => requireRole(...a),
  };
});

vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args });
      return { data: null, error: rpcErrors[name] ?? null };
    },
  }),
}));

import { ForbiddenError } from '@/lib/auth/account';
import { GET, PATCH } from './route';

function as(role: string) {
  requireRole.mockResolvedValue({
    supabase: makeSupabase(),
    userId: 'user-1',
    accountId: 'acct-1',
    role,
  });
}

function patch(body: unknown) {
  return PATCH(
    new Request('http://x/api/whatsapp/meta/protection', {
      method: 'PATCH',
      body: JSON.stringify(body),
    })
  );
}

const LIMITS = {
  daily_marketing_cap: 100,
  marketing_spend_micros: 2_500_000,
  ai_spend_micros: null,
};

beforeEach(() => {
  reads.length = 0;
  rpcs.length = 0;
  for (const k of Object.keys(rpcErrors)) delete rpcErrors[k];
  requireRole.mockReset();
});

describe('GET', () => {
  it('requires admin and reads on the caller client', async () => {
    as('admin');
    const res = await GET();
    expect(requireRole).toHaveBeenCalledWith('admin');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enforce: true,
      can_set_enforce: false,
      daily_marketing_cap: 40,
      marketing_spend_micros: 5_000_000,
      ai_spend_micros: null,
      decisions: [
        {
          id: 9,
          at: '2026-11-28T09:00:00Z',
          decision: 'DENY',
          reason: 'OPTED_OUT',
          template: 'promo',
          enforced: true,
        },
      ],
    });
    expect(reads.sort()).toEqual([
      'meta_protection_settings',
      'send_protection_caps',
      'send_protection_decisions',
    ]);
  });

  it('tells the owner it may switch enforcement', async () => {
    as('owner');
    expect((await (await GET()).json()).can_set_enforce).toBe(true);
  });

  it('answers 403 below admin', async () => {
    requireRole.mockRejectedValue(new ForbiddenError());
    expect((await GET()).status).toBe(403);
  });
});

describe('PATCH enforce', () => {
  it('lets the owner switch it, as the actor', async () => {
    as('owner');
    const res = await patch({ enforce: true });
    expect(res.status).toBe(200);
    expect(rpcs).toEqual([
      {
        name: 'meta_protection_set_enforce',
        args: { p_actor: 'user-1', p_account: 'acct-1', p_on: true },
      },
    ]);
  });

  it('refuses an admin without calling the setter', async () => {
    as('admin');
    const res = await patch({ enforce: true });
    expect(res.status).toBe(403);
    expect(rpcs).toEqual([]);
  });

  it('maps the database refusal to 403', async () => {
    as('owner');
    rpcErrors.meta_protection_set_enforce = {
      message: 'NOT_ALLOWED',
      hint: 'NOT_ALLOWED',
    };
    expect((await patch({ enforce: false })).status).toBe(403);
  });

  it('refuses a non-boolean', async () => {
    as('owner');
    expect((await patch({ enforce: 'yes' })).status).toBe(400);
    expect(rpcs).toEqual([]);
  });
});

describe('PATCH limits', () => {
  it('lets an admin save all three caps through the setters', async () => {
    as('admin');
    const res = await patch({ limits: LIMITS });
    expect(res.status).toBe(200);
    expect(rpcs).toEqual([
      {
        name: 'meta_protection_set_marketing_cap',
        args: { p_actor: 'user-1', p_account: 'acct-1', p_cap: 100 },
      },
      {
        name: 'send_protection_set_caps',
        args: {
          p_actor: 'user-1',
          p_account: 'acct-1',
          p_marketing_micros: 2_500_000,
          p_ai_micros: null,
        },
      },
    ]);
  });

  it.each([
    [{ ...LIMITS, daily_marketing_cap: -1 }],
    [{ ...LIMITS, marketing_spend_micros: 1.5 }],
    [{ ...LIMITS, ai_spend_micros: '3' }],
    [{ daily_marketing_cap: 1 }],
    [null],
  ])('refuses a bad limits body %#', async (limits) => {
    as('admin');
    expect((await patch({ limits })).status).toBe(400);
    expect(rpcs).toEqual([]);
  });

  it('refuses an empty body', async () => {
    as('admin');
    expect((await patch({})).status).toBe(400);
  });

  it('maps SETTING_INVALID to 400 and other errors to 500', async () => {
    as('admin');
    rpcErrors.send_protection_set_caps = {
      message: 'bad',
      hint: 'SETTING_INVALID',
    };
    expect((await patch({ limits: LIMITS })).status).toBe(400);
    rpcErrors.send_protection_set_caps = { message: 'down' };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await patch({ limits: LIMITS })).status).toBe(500);
  });
});
