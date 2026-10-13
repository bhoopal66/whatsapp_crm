import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeDb, type FakeDb } from '@/lib/pbx/__tests__/fake-db';

let fake: FakeDb;

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({
    supabase: fake.db,
    accountId: 'acc',
    userId: 'u-admin',
    role: 'admin',
  })),
  toErrorResponse: (err: unknown) =>
    Response.json({ error: String(err) }, { status: 500 }),
}));

import { GET, PUT } from './route';

const SAVED = {
  account_id: 'acc',
  store_recordings: true,
  announcement_required: true,
  exclude_bank_numbers: true,
  retention_days: null,
  retention_confirmed_at: null as string | null,
  missed_call_due_minutes: 30,
  mandatory_disposition: false,
  missed_call_whatsapp_draft: false,
  updated_at: null,
  updated_by: null,
};
const put = (body: unknown) =>
  PUT(
    new Request('http://localhost/api/pbx/settings', {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  );

beforeEach(() => {
  fake = createFakeDb({ pbx_settings: [{ ...SAVED }] });
});

describe('/api/pbx/settings: storing recordings', () => {
  it('answers storeRecordings true before the first save', async () => {
    fake = createFakeDb();
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).settings.storeRecordings).toBe(true);
  });

  it('answers what is kept now, or null when that cannot be read', async () => {
    fake = createFakeDb(
      {},
      {
        pbx_recordings_kept: () => ({
          data: {
            kept: 12,
            legal_hold: 2,
            oldest_call_at: '2026-07-01T09:00:00+00:00',
            expired: 40,
          },
          error: null,
        }),
      }
    );
    expect((await (await GET()).json()).recordings).toEqual({
      kept: 12,
      legalHold: 2,
      oldestCallAt: '2026-07-01T09:00:00+00:00',
      expired: 40,
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fake = createFakeDb();
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).recordings).toBeNull();
  });

  it('round-trips storeRecordings', async () => {
    const res = await put({ storeRecordings: false });
    expect(res.status).toBe(200);
    expect((await res.json()).settings.storeRecordings).toBe(false);
    expect(fake.tables.pbx_settings[0].store_recordings).toBe(false);
    expect((await (await GET()).json()).settings).toMatchObject({
      storeRecordings: false,
      announcementRequired: true,
    });
    await put({ storeRecordings: true });
    expect(fake.tables.pbx_settings[0].store_recordings).toBe(true);
  });

  it('rejects a value that is not true or false', async () => {
    const res = await put({ storeRecordings: 'no' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'storeRecordings must be true or false',
    });
    expect(fake.tables.pbx_settings[0].store_recordings).toBe(true);
  });
});

describe('/api/pbx/settings: the retention period (093)', () => {
  const AT = '2020-01-01T00:00:00.000Z';
  const stored = (days: number | null, confirmedAt: string | null) => {
    fake = createFakeDb({
      pbx_settings: [
        { ...SAVED, retention_days: days, retention_confirmed_at: confirmedAt },
      ],
    });
  };
  const row = () => fake.tables.pbx_settings[0];

  it('refuses a shorter period without the confirmation, and keeps the stored one', async () => {
    // Loaded 30 in one tab; another admin has since saved 3650.
    stored(3650, AT);
    const res = await put({ storeRecordings: false, retentionDays: 30 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'confirm_retention',
      retentionDays: 30,
    });
    expect(row()).toMatchObject({
      retention_days: 3650,
      retention_confirmed_at: AT,
      store_recordings: true,
    });
    // A confirmation of another period is none.
    const other = await put({ retentionDays: 30, confirmRetentionDays: 20 });
    expect(other.status).toBe(409);
    expect(row().retention_days).toBe(3650);
  });

  it('saves a shorter period with its confirmation, and stamps it', async () => {
    stored(3650, AT);
    const res = await put({ retentionDays: 30, confirmRetentionDays: 30 });
    expect(res.status).toBe(200);
    const { settings } = await res.json();
    expect(settings.retentionDays).toBe(30);
    expect(settings.retentionConfirmedAt).toEqual(expect.any(String));
    expect(settings.retentionConfirmedAt).not.toBe(AT);
    expect(row().retention_days).toBe(30);
    expect(row().retention_confirmed_at).toBe(settings.retentionConfirmedAt);
  });

  it('asks for a first period, also over one saved before 093 and never confirmed', async () => {
    stored(null, null);
    expect((await put({ retentionDays: 365 })).status).toBe(409);
    expect(row().retention_days).toBeNull();
    fake = createFakeDb();
    expect((await put({ retentionDays: 365 })).status).toBe(409);
    expect(fake.tables.pbx_settings ?? []).toEqual([]);
    stored(30, null);
    expect((await put({ retentionDays: 30 })).status).toBe(409);
    expect((await put({ retentionDays: 90 })).status).toBe(409);
    expect(row()).toMatchObject({
      retention_days: 30,
      retention_confirmed_at: null,
    });
    const res = await put({ retentionDays: 30, confirmRetentionDays: 30 });
    expect(res.status).toBe(200);
    expect(row().retention_confirmed_at).toEqual(expect.any(String));
  });

  it('lengthens or clears the period without a confirmation', async () => {
    stored(30, AT);
    const res = await put({ retentionDays: 90 });
    expect(res.status).toBe(200);
    expect(row().retention_days).toBe(90);
    expect(row().retention_confirmed_at).toEqual(expect.any(String));
    expect(row().retention_confirmed_at).not.toBe(AT);
    const cleared = await put({ retentionDays: null });
    expect(cleared.status).toBe(200);
    expect(row()).toMatchObject({
      retention_days: null,
      retention_confirmed_at: null,
    });
  });

  it('leaves the stored period alone when the body omits it', async () => {
    stored(3650, AT);
    const res = await put({ storeRecordings: false, missedCallDueMinutes: 45 });
    expect(res.status).toBe(200);
    expect(row()).toMatchObject({
      retention_days: 3650,
      retention_confirmed_at: AT,
      store_recordings: false,
      missed_call_due_minutes: 45,
    });
  });

  it('answers whether the saved period is confirmed', async () => {
    stored(30, null);
    expect((await (await GET()).json()).settings).toMatchObject({
      retentionDays: 30,
      retentionConfirmedAt: null,
    });
    fake = createFakeDb();
    expect(
      (await (await GET()).json()).settings.retentionConfirmedAt
    ).toBeNull();
  });
});
