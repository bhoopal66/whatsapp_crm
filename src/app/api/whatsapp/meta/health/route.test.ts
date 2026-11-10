import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/whatsapp/meta/health — the watch-only Meta number health
// read. The database is a fake that records each table read; the role
// check is mocked at the module boundary with the real error classes.

const reads: string[] = [];
const rpcs: string[] = [];
const db = {
  config: null as Record<string, unknown> | null,
};

function makeSupabase() {
  return {
    from(table: string) {
      reads.push(table);
      const b: Record<string, unknown> = {};
      for (const f of ['select', 'eq', 'order', 'limit']) b[f] = () => b;
      b.maybeSingle = async () => {
        if (table === 'whatsapp_config')
          return { data: db.config, error: null };
        if (table === 'meta_number_state') {
          return {
            data: {
              quality_rating: 'YELLOW',
              messaging_limit_tier: 'TIER_1K',
              account_status: null,
              assessed_state: 'THROTTLED',
              reasons: ['quality_yellow'],
              updated_at: '2026-11-10T08:00:00Z',
            },
            error: null,
          };
        }
        if (table === 'meta_protection_settings') {
          return { data: { daily_marketing_cap: 50 }, error: null };
        }
        return { data: null, error: null };
      };
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: [], error: null });
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
    rpc: async (name: string) => {
      rpcs.push(name);
      if (name === 'meta_marketing_sent_today') return { data: 7, error: null };
      return {
        data: {
          won_cases: 2,
          won_spend_usd: 1.5,
          cost_per_won_case_usd: 0.75,
          other_spend_usd: 0.2,
          unknown_cost_messages: 0,
        },
        error: null,
      };
    },
  }),
}));

import { ForbiddenError } from '@/lib/auth/account';
import { GET } from './route';

beforeEach(() => {
  reads.length = 0;
  rpcs.length = 0;
  db.config = null;
  requireRole.mockReset();
  requireRole.mockResolvedValue({
    supabase: makeSupabase(),
    accountId: 'acc-1',
    userId: 'user-1',
    role: 'admin',
  });
});

describe('GET /api/whatsapp/meta/health', () => {
  it('refuses below admin with 403 and reads nothing', async () => {
    requireRole.mockRejectedValue(new ForbiddenError());
    const res = await GET();
    expect(res.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith('admin');
    expect(reads).toEqual([]);
    expect(rpcs).toEqual([]);
  });

  it('answers connected:false when the account has no Meta number', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
    expect(reads).toEqual(['whatsapp_config']);
    expect(rpcs).toEqual([]);
  });

  it('returns the number health and never the enforce switch', async () => {
    db.config = { id: 'cfg-1', label: 'Sales' };
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connected).toBe(true);
    expect(body.state.assessed_state).toBe('THROTTLED');
    expect(body.state.reasons).toEqual(['quality_yellow']);
    expect(body.marketing.sent_today).toBe(7);
    expect(body.marketing.daily_cap).toBe(50);
    expect(body.spend.figures.costPerWonCaseUsd).toBe(0.75);
    expect(JSON.stringify(body)).not.toContain('enforce');
  });
});
