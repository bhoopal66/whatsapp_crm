import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ requireRole: vi.fn(), rpc: vi.fn() }));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  requireRole: m.requireRole,
}));

import { PUT } from './route';

const STORED = {
  enabled: true,
  token: 'tok',
  allowed_origins: ['https://a.example'],
  updated_at: 'now',
};

function put(body: unknown) {
  return PUT(
    new Request('http://x/api/web-form', {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  m.rpc.mockReset();
  m.rpc.mockResolvedValue({ data: STORED, error: null });
  m.requireRole.mockResolvedValue({ supabase: { rpc: m.rpc } });
});

describe('PUT /api/web-form', () => {
  it('rotate alone keeps the stored switch and origins', async () => {
    const res = await put({ rotate: true });
    expect(res.status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith('web_form_get');
    expect(m.rpc).toHaveBeenLastCalledWith('web_form_set', {
      p_enabled: true,
      p_allowed_origins: ['https://a.example'],
      p_rotate: true,
    });
  });

  it('fills only the field a save left out', async () => {
    await put({ enabled: false });
    expect(m.rpc).toHaveBeenLastCalledWith('web_form_set', {
      p_enabled: false,
      p_allowed_origins: ['https://a.example'],
      p_rotate: false,
    });
    await put({ allowedOrigins: ['https://b.example'] });
    expect(m.rpc).toHaveBeenLastCalledWith('web_form_set', {
      p_enabled: true,
      p_allowed_origins: ['https://b.example'],
      p_rotate: false,
    });
  });

  it('a full body is written as sent, without reading first', async () => {
    await put({ enabled: false, allowedOrigins: [] });
    expect(m.rpc).toHaveBeenCalledTimes(1);
    expect(m.rpc).toHaveBeenCalledWith('web_form_set', {
      p_enabled: false,
      p_allowed_origins: [],
      p_rotate: false,
    });
  });

  it('refuses an empty body and wrong types', async () => {
    for (const body of [
      {},
      { rotate: false },
      { enabled: 'yes' },
      { allowedOrigins: 'x' },
    ]) {
      expect((await put(body)).status).toBe(400);
    }
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('refuses a bad origin', async () => {
    const res = await put({ allowedOrigins: ['http://not-https.example'] });
    expect(res.status).toBe(400);
  });
});
