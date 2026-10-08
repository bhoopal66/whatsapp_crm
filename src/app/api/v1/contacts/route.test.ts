import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findOrCreateContact } = vi.hoisted(() => ({
  findOrCreateContact: vi.fn(),
}));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: vi.fn(async () => ({ accountId: 'acct-1', supabase: {} })),
}));

vi.mock('@/lib/api/v1/contacts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/v1/contacts')>();
  return {
    ...actual,
    resolveAuditUserId: vi.fn(async () => 'owner-1'),
    findOrCreateContact,
    getContactById: vi.fn(async (_db: unknown, _acct: string, id: string) => ({
      id,
      phone: '971501234567',
    })),
  };
});

import { GET, POST } from './route';

const post = (body: unknown) =>
  POST(
    new Request('http://x/api/v1/contacts', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );

beforeEach(() => {
  findOrCreateContact.mockReset();
  findOrCreateContact.mockResolvedValue({ id: 'c1', created: true });
});

describe('POST /api/v1/contacts', () => {
  it.each([
    ['0501234567', /country code/],
    ['50 455 5843', /too short/],
    ['9.71505E+11', /scientific notation/],
    ['97150123456', /UAE/],
  ])(
    'refuses %s with bad_request and creates nothing',
    async (phone, message) => {
      const res = await post({ phone });
      expect(res.status).toBe(400);
      const { error } = await res.json();
      expect(error.code).toBe('bad_request');
      expect(error.message).toMatch(message);
      expect(error.message).toContain('+971 50 123 4567');
      expect(findOrCreateContact).not.toHaveBeenCalled();
    }
  );

  it('creates with the normalized number (trunk 0 after 971 removed)', async () => {
    const res = await post({ phone: '+971 050 123 4567', name: 'Jane' });
    expect(res.status).toBe(201);
    expect(findOrCreateContact).toHaveBeenCalledWith(
      {},
      'acct-1',
      'owner-1',
      expect.objectContaining({ phone: '971501234567', name: 'Jane' })
    );
  });

  it('accepts a non-UAE international number on length alone', async () => {
    const res = await post({ phone: '+961 3 123 456' });
    expect(res.status).toBe(201);
    expect(findOrCreateContact).toHaveBeenCalledWith(
      {},
      'acct-1',
      'owner-1',
      expect.objectContaining({ phone: '9613123456' })
    );
  });

  it('still reports a missing phone as required', async () => {
    const res = await post({ name: 'No phone' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe("'phone' is required");
  });

  // The mocked `supabase` is `{}`: any tag table write would throw.
  it('accepts and ignores a tags field', async () => {
    const res = await post({ phone: '+971 50 123 4567', tags: ['vip'] });
    expect(res.status).toBe(201);
    expect((await res.json()).data.id).toBe('c1');
    expect(findOrCreateContact).toHaveBeenCalledWith(
      {},
      'acct-1',
      'owner-1',
      expect.not.objectContaining({ tags: expect.anything() })
    );
  });
});

describe('GET /api/v1/contacts', () => {
  // `?tag=` used to filter on contact tags; none exist any more, so it
  // answers an empty page without querying (the mocked client is `{}`).
  it('answers an empty page for a tag filter', async () => {
    const res = await GET(new Request('http://x/api/v1/contacts?tag=t1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [],
      meta: { next_cursor: null },
    });
  });
});
