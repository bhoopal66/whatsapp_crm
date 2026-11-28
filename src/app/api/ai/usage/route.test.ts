import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireRole: vi.fn() }));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

import { GET } from './route';

function fakeClient(rows: unknown[]) {
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'order', 'limit']) {
    builder[m] = () => builder;
  }
  builder.then = (resolve: (r: unknown) => unknown) =>
    Promise.resolve({ data: rows, error: null }).then(resolve);
  return { from: () => builder };
}

const row = (mode: string, total: number) => ({
  created_at: new Date().toISOString(),
  mode,
  provider: 'openai',
  model: 'gpt',
  prompt_tokens: total,
  completion_tokens: 0,
  total_tokens: total,
});

beforeEach(() => mocks.requireRole.mockReset());

describe('GET /api/ai/usage', () => {
  it('tallies translate, hr_agent, kb_learn and chat_assist rows in their own buckets', async () => {
    mocks.requireRole.mockResolvedValue({
      supabase: fakeClient([
        row('translate', 7),
        row('translate', 3),
        row('draft', 5),
        row('hr_agent', 4),
        row('kb_learn', 6),
        row('chat_assist', 2),
      ]),
      accountId: 'account-1',
    });
    const res = await GET(new Request('http://localhost/api/ai/usage'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.by_mode).toEqual({
      auto_reply: { calls: 0, tokens: 0 },
      draft: { calls: 1, tokens: 5 },
      translate: { calls: 2, tokens: 10 },
      hr_agent: { calls: 1, tokens: 4 },
      kb_learn: { calls: 1, tokens: 6 },
      chat_assist: { calls: 1, tokens: 2 },
    });
    expect(body.totals.total_tokens).toBe(27);
  });
});
