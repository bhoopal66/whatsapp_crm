import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  row: { data: null as unknown, error: null as unknown },
  rpc: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: vi.fn((err: { status?: number }) =>
    Response.json({ error: 'auth' }, { status: err?.status ?? 500 })
  ),
}));

import { GET, PUT } from './route';

function supabase() {
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.eq = () => builder;
  builder.maybeSingle = async () => h.row;
  return { from: () => builder, rpc: h.rpc };
}

const HOURS = { mon: [['09:00', '17:00']] };
const putRaw = (body: unknown) =>
  PUT(
    new Request('http://localhost/api/response-times/settings', {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  );
// The panel sends only changed keys, marked partial.
const put = (body: Record<string, unknown>) =>
  putRaw({ partial: true, ...body });

beforeEach(() => {
  vi.clearAllMocks();
  h.row = { data: null, error: null };
  h.requireRole.mockImplementation(async (min: string) => {
    if (min !== 'admin') throw Object.assign(new Error('min'), { status: 500 });
    return { supabase: supabase(), accountId: 'acc-1', userId: 'u-1' };
  });
  h.rpc.mockResolvedValue({
    data: {
      enabled: true,
      timezone: 'UTC',
      hours: HOURS,
      target_minutes: 20,
    },
    error: null,
  });
});

describe('PUT without partial', () => {
  it('answers 409 reload before reading or writing', async () => {
    const res = await putRaw({ enabled: true, timezone: 'UTC', hours: HOURS });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('reload');
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe('GET /api/response-times/settings', () => {
  it('answers the defaults when never saved', async () => {
    const res = await GET();
    expect(h.requireRole).toHaveBeenCalledWith('admin');
    const body = await res.json();
    expect(body.available).toBe(true);
    expect(body.settings).toMatchObject({
      enabled: false,
      timezone: 'Asia/Dubai',
      targetMinutes: 15,
    });
    expect(body.settings.hours.sun).toEqual([]);
  });

  it('answers available: false before migration 237', async () => {
    h.row = { data: null, error: { code: '42P01', message: 'missing' } };
    const body = await (await GET()).json();
    expect(body.available).toBe(false);
  });

  it('answers 403 below admin', async () => {
    h.requireRole.mockRejectedValue(
      Object.assign(new Error('role'), { status: 403 })
    );
    expect((await GET()).status).toBe(403);
  });
});

describe('PUT /api/response-times/settings', () => {
  it('saves through response_settings_set', async () => {
    const res = await put({
      enabled: true,
      timezone: 'UTC',
      hours: HOURS,
      targetMinutes: 20,
    });
    expect(res.status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith('response_settings_set', {
      p_enabled: true,
      p_timezone: 'UTC',
      p_hours: HOURS,
      p_target_minutes: 20,
    });
    const body = await res.json();
    expect(body.settings).toMatchObject({ enabled: true, targetMinutes: 20 });
  });

  it.each([
    [{}, 400],
    [{ other: 1 }, 400],
    [{ enabled: 'yes' }, 400],
    [{ targetMinutes: null }, 422],
    [{ enabled: true, timezone: '', hours: HOURS, targetMinutes: 20 }, 422],
    [
      {
        enabled: true,
        timezone: 'UTC',
        hours: { mon: [['18:00', '09:00']] },
        targetMinutes: 20,
      },
      422,
    ],
    [{ enabled: true, timezone: 'UTC', hours: HOURS, targetMinutes: 0 }, 422],
  ])('refuses a bad body (%j) before the database', async (body, status) => {
    expect((await put(body)).status).toBe(status);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  const STORED = {
    enabled: true,
    timezone: 'Asia/Kolkata',
    hours: { tue: [['10:00', '14:00']] },
    target_minutes: 45,
  };
  const KEPT_HOURS = {
    mon: [],
    tue: [['10:00', '14:00']],
    wed: [],
    thu: [],
    fri: [],
    sat: [],
    sun: [],
  };

  it('a field left out keeps what is stored at that moment', async () => {
    h.row = { data: STORED, error: null };
    expect((await put({ targetMinutes: 20 })).status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith('response_settings_set', {
      p_enabled: true,
      p_timezone: 'Asia/Kolkata',
      p_hours: KEPT_HOURS,
      p_target_minutes: 20,
    });
  });

  it('switching off keeps the hours', async () => {
    h.row = { data: STORED, error: null };
    expect((await put({ enabled: false })).status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith('response_settings_set', {
      p_enabled: false,
      p_timezone: 'Asia/Kolkata',
      p_hours: KEPT_HOURS,
      p_target_minutes: 45,
    });
  });

  it.each([
    [{ code: '57014', message: 'timeout' }, 500, 'load_failed'],
    [{ code: '42P01', message: 'missing' }, 503, 'not_available'],
  ])('a failed read (%j) saves nothing', async (error, status, code) => {
    h.row = { data: null, error };
    const res = await put({ targetMinutes: 20 });
    expect(res.status).toBe(status);
    await expect(res.json()).resolves.toEqual({ error: code });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('maps the SQL refusals', async () => {
    h.rpc.mockResolvedValue({
      data: null,
      error: { code: '42501', hint: 'not_allowed', message: 'no' },
    });
    const ok = {
      enabled: true,
      timezone: 'UTC',
      hours: HOURS,
      targetMinutes: 5,
    };
    expect((await put(ok)).status).toBe(403);
    h.rpc.mockResolvedValue({
      data: null,
      error: { code: '22023', hint: 'invalid_timezone', message: 'no' },
    });
    const res = await put(ok);
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({ error: 'invalid_timezone' });
  });
});
