import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ conversation: vi.fn() }));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: vi.fn(async () => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      maybeSingle: h.conversation,
    };
    return { accountId: 'acct-1', supabase: { from: () => chain } };
  }),
}));

import { GET } from './route';

const get = () =>
  GET(new Request('http://x/api/v1/conversations/cv-1/messages'), {
    params: Promise.resolve({ id: 'cv-1' }),
  });

beforeEach(() => h.conversation.mockReset());

describe('GET /api/v1/conversations/{id}/messages, the ownership read', () => {
  it.each([null, { code: '22P02' }])('is a 404 for %o', async (error) => {
    h.conversation.mockResolvedValue({ data: null, error });
    expect((await get()).status).toBe(404);
  });

  it('is a 503 when it failed', async () => {
    vi.spyOn(console, 'error').mockImplementationOnce(() => {});
    h.conversation.mockResolvedValue({ data: null, error: { code: '57014' } });
    const res = await get();
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('5');
  });
});
