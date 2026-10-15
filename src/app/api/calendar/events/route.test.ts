import { beforeEach, describe, expect, it, vi } from 'vitest';

// Creating an event is the event plus its invitees under the caller's
// RLS client, all or nothing.

import { fakeSupabase, type FakeDb } from '../test-db';

const mocks = vi.hoisted(() => ({ getCurrentAccount: vi.fn() }));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));

import { POST } from './route';

const ME = '11111111-1111-4111-8111-111111111111';
const U1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const valid = {
  title: ' Sync ',
  start: '2026-10-10T09:00:00Z',
  end: '2026-10-10T10:00:00Z',
  allDay: false,
  timeZone: 'Asia/Dubai',
  color: 'blue',
  visibility: 'attendees',
  reminders: [10],
  attendees: [U1],
};

let db: FakeDb;
const create = (body: unknown) =>
  POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }));

describe('POST /api/calendar/events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    db = { tables: {} };
    mocks.getCurrentAccount.mockResolvedValue({
      role: 'agent',
      userId: ME,
      accountId: 'acct-1',
      supabase: fakeSupabase(db),
    });
  });

  it('creates the event with the caller as organiser, then pending invitees', async () => {
    const res = await create(valid);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.event).toMatchObject({
      title: 'Sync',
      account_id: 'acct-1',
      created_by: ME,
      visibility: 'attendees',
      reminders: [10],
      rrule: null,
    });
    expect(body.attendees).toEqual([
      expect.objectContaining({
        event_id: body.event.id,
        account_id: 'acct-1',
        user_id: U1,
        response: 'pending',
      }),
    ]);
  });

  it('stores the end of a bounded series, and none for a one-off', async () => {
    expect((await create(valid)).status).toBe(201);
    const res = await create({ ...valid, rrule: 'FREQ=DAILY;COUNT=3' });
    expect(res.status).toBe(201);
    expect(
      db.tables.calendar_events.map((r) => [r.rrule, r.series_end_at])
    ).toEqual([
      [null, null],
      // 10, 11 and 12 October, 09:00–10:00Z.
      ['FREQ=DAILY;COUNT=3', '2026-10-12T10:00:00.000Z'],
    ]);
  });

  it('removes the event again when an invitee is refused', async () => {
    db.errors = {
      'calendar_event_attendees:insert': {
        code: '23514',
        message: 'Only a live staff member…',
      },
    };
    const res = await create(valid);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Only a live staff member…' });
    expect(db.tables.calendar_events).toEqual([]);
  });

  it('writes no attendee rows for an event with no invitees', async () => {
    const res = await create({ ...valid, attendees: undefined });
    expect(res.status).toBe(201);
    expect((await res.json()).attendees).toEqual([]);
    expect(db.tables.calendar_event_attendees).toBeUndefined();
  });

  it('refuses an invalid body before writing', async () => {
    expect((await create({ ...valid, title: '' })).status).toBe(400);
    expect((await create({ ...valid, timeZone: undefined })).status).toBe(400);
    expect(db.tables.calendar_events).toBeUndefined();
  });

  it('maps a refused write (42501) to 403', async () => {
    db.errors = { 'calendar_events:insert': { code: '42501' } };
    expect((await create(valid)).status).toBe(403);
  });

  it('refuses a bank guest', async () => {
    mocks.getCurrentAccount.mockResolvedValue({ role: 'bank_guest' });
    const res = await create(valid);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'The calendar is for staff only',
    });
  });
});
