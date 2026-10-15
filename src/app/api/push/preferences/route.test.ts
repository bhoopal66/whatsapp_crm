import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  upsert: vi.fn(),
  row: { data: null as unknown, error: null as unknown },
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));

import { GET, PUT } from './route';

function from() {
  const q: Record<string, unknown> = {
    select: () => q,
    eq: () => q,
    maybeSingle: async () => mocks.row,
    upsert: mocks.upsert,
  };
  return q;
}

const put = (body: unknown) =>
  PUT(new Request('http://x', { method: 'PUT', body: JSON.stringify(body) }));

const VALID = {
  enabled: true,
  kinds: { whatsapp_message: false },
  quietStart: '22:00',
  quietEnd: '07:30',
  timeZone: 'Asia/Dubai',
};

describe('/api/push/preferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.row = { data: null, error: null };
    mocks.upsert.mockResolvedValue({ error: null });
    mocks.getCurrentAccount.mockResolvedValue({
      userId: 'user-1',
      supabase: { from },
    });
  });

  it('GET answers the defaults when there is no row', async () => {
    expect(await (await GET()).json()).toEqual({
      enabled: true,
      kinds: {},
      quietStart: null,
      quietEnd: null,
      timeZone: null,
    });
  });

  it('GET maps the stored row, trimming Postgres seconds', async () => {
    mocks.row = {
      data: {
        enabled: false,
        kinds: { call_missed: false },
        quiet_start: '22:00:00',
        quiet_end: '07:30:00',
        time_zone: 'Asia/Dubai',
      },
      error: null,
    };
    expect(await (await GET()).json()).toEqual({
      enabled: false,
      kinds: { call_missed: false },
      quietStart: '22:00',
      quietEnd: '07:30',
      timeZone: 'Asia/Dubai',
    });
  });

  it('PUT upserts the caller’s own row', async () => {
    const res = await put(VALID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(VALID);
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-1',
        enabled: true,
        kinds: { whatsapp_message: false },
        quiet_start: '22:00',
        quiet_end: '07:30',
        time_zone: 'Asia/Dubai',
      }),
      { onConflict: 'user_id' }
    );
  });

  it('PUT accepts no quiet hours and no time zone', async () => {
    const body = { enabled: true, kinds: {}, quietStart: null, quietEnd: null };
    const res = await put(body);
    expect(res.status).toBe(200);
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        quiet_start: null,
        quiet_end: null,
        time_zone: null,
      }),
      { onConflict: 'user_id' }
    );
  });

  it.each([
    ['a non-boolean enabled', { ...VALID, enabled: 'yes' }],
    ['kinds as an array', { ...VALID, kinds: [] }],
    ['an unknown kind', { ...VALID, kinds: { test: false } }],
    ['a non-boolean kind value', { ...VALID, kinds: { call_missed: 0 } }],
    ['a malformed time', { ...VALID, quietStart: '7:00' }],
    ['an impossible time', { ...VALID, quietEnd: '24:00' }],
    ['only a start', { ...VALID, quietEnd: null }],
    ['only an end', { ...VALID, quietStart: null }],
    ['equal start and end', { ...VALID, quietEnd: '22:00' }],
    ['quiet hours without a time zone', { ...VALID, timeZone: null }],
    ['an unknown time zone', { ...VALID, timeZone: 'Mars/Olympus' }],
    ['no body', null],
  ])('PUT refuses %s', async (_label, body) => {
    expect((await put(body)).status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('PUT answers 500 when the save fails', async () => {
    mocks.upsert.mockResolvedValue({ error: { message: 'boom' } });
    expect((await put(VALID)).status).toBe(500);
  });
});
