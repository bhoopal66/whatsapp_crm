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
