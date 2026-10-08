import { beforeEach, describe, expect, it, vi } from 'vitest';

const { update, from } = vi.hoisted(() => {
  const update = vi.fn();
  const from = vi.fn(() => ({ update }));
  return { update, from };
});

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: vi.fn(async () => ({
    accountId: 'acct-1',
    supabase: { from },
  })),
}));

vi.mock('@/lib/api/v1/contacts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/v1/contacts')>();
  return {
    ...actual,
    getContactById: vi.fn(async (_db: unknown, _acct: string, id: string) => ({
      id,
      phone: '971501234567',
      tags: [],
    })),
  };
});

import { PATCH } from './route';

const patch = (body: unknown) =>
  PATCH(
    new Request('http://x/api/v1/contacts/c1', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'c1' }) }
  );

beforeEach(() => {
  from.mockClear();
  update.mockReset();
  update.mockImplementation(() => {
    const chain = { eq: vi.fn(() => chain), error: null };
    return chain;
  });
});

describe('PATCH /api/v1/contacts/{id}', () => {
  it('accepts and ignores a tags-only body', async () => {
    const res = await patch({ tags: ['vip'] });
    expect(res.status).toBe(200);
    expect((await res.json()).data.id).toBe('c1');
    expect(from).not.toHaveBeenCalled();
  });

  it('updates the other fields and leaves tags out', async () => {
    const res = await patch({ name: 'Jane', tags: ['vip'] });
    expect(res.status).toBe(200);
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith('contacts');
    const [updates] = update.mock.calls[0];
    expect(updates).toMatchObject({ name: 'Jane' });
    expect(updates).not.toHaveProperty('tags');
  });
});
