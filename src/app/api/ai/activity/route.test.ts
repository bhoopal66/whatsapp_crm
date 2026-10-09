import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireRole: vi.fn() }));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

import { GET } from './route';

/** A chainable query builder that records its calls and resolves `result`. */
function query(result: { data: unknown; error: unknown }) {
  const calls: [string, unknown[]][] = [];
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'order', 'limit']) {
    builder[m] = (...args: unknown[]) => {
      calls.push([m, args]);
      return builder;
    };
  }
  builder.then = (resolve: (v: unknown) => unknown) => resolve(result);
  return { builder, calls };
}

function setup(
  events: { data: unknown; error: unknown },
  usage: { data: unknown; error: unknown }
) {
  const q = { ai_reply_events: query(events), ai_usage_log: query(usage) };
  const from = vi.fn((table: keyof typeof q) => q[table].builder);
  mocks.requireRole.mockResolvedValue({
    supabase: { from },
    accountId: 'account-1',
  });
  return { q, from };
}

describe('GET /api/ai/activity', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads both tables for the account, auto-reply usage only, bounded', async () => {
    const { q } = setup(
      {
        data: [
          {
            outcome: 'replied',
            tier: 'small',
            model: 'gpt-5.4-nano',
            route_source: 'jev',
            escalated: false,
          },
        ],
        error: null,
      },
      {
        data: [
          {
            model: 'gpt-5.4-nano',
            prompt_tokens: 3,
            completion_tokens: 2,
            total_tokens: 5,
          },
        ],
        error: null,
      }
    );

    const res = await GET(
      new Request('http://localhost/api/ai/activity?days=500')
    );
    const body = await res.json();

    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(res.status).toBe(200);
    expect(body.window_days).toBe(90);
    expect(body.truncated).toBe(false);
    expect(body.replied).toBe(1);
    expect(body.tokens_by_model[0].total_tokens).toBe(5);

    expect(q.ai_reply_events.calls).toContainEqual([
      'eq',
      ['account_id', 'account-1'],
    ]);
    expect(q.ai_reply_events.calls).toContainEqual(['limit', [5001]]);
    expect(q.ai_usage_log.calls).toContainEqual(['eq', ['mode', 'auto_reply']]);
    expect(q.ai_usage_log.calls).toContainEqual([
      'eq',
      ['account_id', 'account-1'],
    ]);
  });

  it('answers 500 when a read fails', async () => {
    setup(
      { data: null, error: { message: 'boom' } },
      { data: [], error: null }
    );
    const res = await GET(new Request('http://localhost/api/ai/activity'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to load AI activity' });
  });

  it('answers the auth error without reading when the role is too low', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));
    const res = await GET(new Request('http://localhost/api/ai/activity'));
    expect(res.status).toBe(403);
  });
});
