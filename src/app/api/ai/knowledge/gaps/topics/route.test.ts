import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  recompute: vi.fn(),
}));

vi.mock('@/lib/auth/account', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/auth/account')>(
      '@/lib/auth/account'
    );
  return {
    requireRole: mocks.requireRole,
    ForbiddenError: actual.ForbiddenError,
    toErrorResponse: actual.toErrorResponse,
  };
});
vi.mock('@/lib/kb/gap-recompute', () => ({
  recomputeKbGapTopics: mocks.recompute,
}));

import { ForbiddenError } from '@/lib/auth/account';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { GET, POST } from './route';
import { PATCH } from './[id]/route';

type Result = { data: unknown; error: unknown };

/** A chainable builder per table that records calls and resolves its result. */
function client(results: Record<string, Result>, rpc?: Result) {
  const calls: [string, string, unknown[]][] = [];
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'order', 'limit']) {
      builder[m] = (...args: unknown[]) => {
        calls.push([table, m, args]);
        return builder;
      };
    }
    builder.then = (resolve: (v: unknown) => unknown) =>
      resolve(results[table] ?? { data: [], error: null });
    return builder;
  };
  const rpcFn = vi.fn(() =>
    Promise.resolve(rpc ?? { data: null, error: null })
  );
  return { supabase: { from, rpc: rpcFn }, calls, rpc: rpcFn };
}

const ACCOUNT = 'acc-1';
const T1 = '6f1c2a3b-1d2e-4f50-8a9b-0c1d2e3f4a5b';
const T2 = '7f1c2a3b-1d2e-4f50-8a9b-0c1d2e3f4a5b';
const ENTRY = '8f1c2a3b-1d2e-4f50-8a9b-0c1d2e3f4a5b';

function topicRow(over: Record<string, unknown>) {
  return {
    id: T1,
    label: 'How much is a POS machine?',
    intent: 'pos_terminal',
    question_count: 2,
    first_seen_at: '2026-10-01T00:00:00Z',
    last_seen_at: '2026-10-02T00:00:00Z',
    coverage: 'none',
    covered_by_entry_id: null,
    status: 'open',
    dismissed_at: null,
    computed_at: '2026-10-03T00:00:00Z',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimitForTests();
});

describe('GET /api/ai/knowledge/gaps/topics', () => {
  it('answers sorted topics with newest examples and the entry title', async () => {
    const c = client({
      kb_gap_topics: {
        data: [
          topicRow({ id: T2, status: 'dismissed', question_count: 40 }),
          topicRow({
            question_count: 5,
            coverage: 'partial',
            covered_by_entry_id: ENTRY,
            computed_at: '2026-10-04T00:00:00Z',
          }),
        ],
        error: null,
      },
      kb_gap_topic_members: {
        data: [
          {
            topic_id: T1,
            gap: { question: 'old', created_at: '2026-10-01T00:00:00Z' },
          },
          {
            topic_id: T1,
            gap: { question: 'newest', created_at: '2026-10-05T00:00:00Z' },
          },
          {
            topic_id: T1,
            gap: { question: 'mid', created_at: '2026-10-03T00:00:00Z' },
          },
          {
            topic_id: T1,
            gap: { question: 'oldest', created_at: '2026-09-01T00:00:00Z' },
          },
          { topic_id: T1, gap: null },
        ],
        error: null,
      },
      kb_entries: { data: [{ id: ENTRY, question: 'POS fees' }], error: null },
    });
    mocks.requireRole.mockResolvedValue({
      supabase: c.supabase,
      accountId: ACCOUNT,
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.computed_at).toBe('2026-10-04T00:00:00Z');
    expect(body.topics.map((t: { id: string }) => t.id)).toEqual([T1, T2]);
    expect(body.topics[0].examples).toEqual(['newest', 'mid', 'old']);
    expect(body.topics[0].covered_by_title).toBe('POS fees');
    expect(body.topics[0]).not.toHaveProperty('computed_at');
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    // Every read is scoped to the caller's account.
    for (const table of [
      'kb_gap_topics',
      'kb_gap_topic_members',
      'kb_entries',
    ]) {
      expect(c.calls).toContainEqual([table, 'eq', ['account_id', ACCOUNT]]);
    }
  });

  it('answers an empty list without further reads', async () => {
    const c = client({ kb_gap_topics: { data: [], error: null } });
    mocks.requireRole.mockResolvedValue({
      supabase: c.supabase,
      accountId: ACCOUNT,
    });
    const res = await GET();
    expect(await res.json()).toEqual({ topics: [], computed_at: null });
    expect(c.calls.some(([t]) => t !== 'kb_gap_topics')).toBe(false);
  });

  it('is a 500 { error } when a read fails', async () => {
    const c = client({
      kb_gap_topics: { data: null, error: { message: 'x' } },
    });
    mocks.requireRole.mockResolvedValue({
      supabase: c.supabase,
      accountId: ACCOUNT,
    });
    const res = await GET();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to load topics' });
  });

  it('is a 403 below admin', async () => {
    mocks.requireRole.mockRejectedValue(new ForbiddenError('admin only'));
    expect((await GET()).status).toBe(403);
  });
});

describe('POST /api/ai/knowledge/gaps/topics', () => {
  it('runs the recompute and answers its summary', async () => {
    mocks.requireRole.mockResolvedValue({ accountId: ACCOUNT });
    mocks.recompute.mockResolvedValue({
      ok: true,
      topics: 4,
      mode: 'lexical',
      judged: 0,
    });
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ topics: 4, mode: 'lexical', judged: 0 });
    expect(mocks.recompute).toHaveBeenCalledWith(ACCOUNT);
  });

  it('allows one run per account per 10 minutes', async () => {
    mocks.requireRole.mockResolvedValue({ accountId: ACCOUNT });
    mocks.recompute.mockResolvedValue({
      ok: true,
      topics: 1,
      mode: 'lexical',
      judged: 0,
    });
    expect((await POST()).status).toBe(200);
    const second = await POST();
    expect(second.status).toBe(429);
    expect(Number(second.headers.get('Retry-After'))).toBeGreaterThan(500);
    expect(mocks.recompute).toHaveBeenCalledTimes(1);
    // Another account has its own budget.
    mocks.requireRole.mockResolvedValue({ accountId: 'acc-2' });
    expect((await POST()).status).toBe(200);
  });

  it('is a 500 { error } when the recompute fails', async () => {
    mocks.requireRole.mockResolvedValue({ accountId: ACCOUNT });
    mocks.recompute.mockResolvedValue({ ok: false, reason: 'replace failed' });
    const res = await POST();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to refresh topics' });
  });
});

describe('PATCH /api/ai/knowledge/gaps/topics/[id]', () => {
  const params = (id = T1) => ({ params: Promise.resolve({ id }) });
  const req = (body: unknown) =>
    new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) });

  it('calls the RPC on the caller client', async () => {
    const c = client({});
    mocks.requireRole.mockResolvedValue({ supabase: c.supabase, userId: 'u1' });
    const res = await PATCH(req({ status: 'dismissed' }), params());
    expect(res.status).toBe(200);
    expect(c.rpc).toHaveBeenCalledWith('kb_gap_topic_set_status', {
      p_topic: T1,
      p_status: 'dismissed',
    });
  });

  it('maps 42501 to 404 "changed" and 22023 to 400', async () => {
    let c = client({}, { data: null, error: { code: '42501', message: 'no' } });
    mocks.requireRole.mockResolvedValue({ supabase: c.supabase, userId: 'u1' });
    let res = await PATCH(req({ status: 'open' }), params());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'That topic has changed — reload',
    });

    c = client({}, { data: null, error: { code: '22023', message: 'bad' } });
    mocks.requireRole.mockResolvedValue({ supabase: c.supabase, userId: 'u1' });
    res = await PATCH(req({ status: 'open' }), params());
    expect(res.status).toBe(400);
  });

  it('refuses a bad status or id before the RPC', async () => {
    const c = client({});
    mocks.requireRole.mockResolvedValue({ supabase: c.supabase, userId: 'u1' });
    expect((await PATCH(req({ status: 'closed' }), params())).status).toBe(400);
    expect((await PATCH(req({ status: 'open' }), params('nope'))).status).toBe(
      404
    );
    expect(c.rpc).not.toHaveBeenCalled();
  });
});
