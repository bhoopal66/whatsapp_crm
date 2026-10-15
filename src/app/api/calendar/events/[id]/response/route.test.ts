import { beforeEach, describe, expect, it, vi } from 'vitest';

// An invitee answers on their own attendee row only. The fake database
// holds every row (as an admin's client would), so a missing
// `user_id = me` filter would answer for someone else.

import { fakeSupabase, type FakeDb } from '../../../test-db';

const mocks = vi.hoisted(() => ({ getCurrentAccount: vi.fn() }));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));

import { PUT } from './route';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const E = '33333333-3333-4333-8333-333333333333';
const E2 = '44444444-4444-4444-8444-444444444444';

let db: FakeDb;
const respond = (body: unknown, id = E) =>
  PUT(new Request('http://x', { method: 'PUT', body: JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  });
const row = (event_id: string, user_id: string) =>
  db.tables.calendar_event_attendees.find(
    (r) => r.event_id === event_id && r.user_id === user_id
  );

describe('PUT /api/calendar/events/[id]/response', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    db = {
      tables: {
        calendar_event_attendees: [
          { event_id: E, user_id: ME, response: 'pending', reminders: null },
          { event_id: E, user_id: OTHER, response: 'pending', reminders: null },
          {
            event_id: E2,
            user_id: OTHER,
            response: 'pending',
            reminders: null,
          },
        ],
      },
    };
    mocks.getCurrentAccount.mockResolvedValue({
      role: 'admin',
      userId: ME,
      accountId: 'acct-1',
      supabase: fakeSupabase(db),
    });
  });

  it('answers on the caller’s own row only', async () => {
    const res = await respond({ response: 'accepted', reminders: [30, 5] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, response: 'accepted' });
    expect(row(E, ME)).toMatchObject({
      response: 'accepted',
      reminders: [5, 30],
    });
    expect(row(E, OTHER)).toMatchObject({ response: 'pending' });
  });

  it('answers 404 for an event the caller is not invited to, changing nothing', async () => {
    const res = await respond({ response: 'declined' }, E2);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'You are not invited to this event',
    });
    expect(row(E2, OTHER)).toMatchObject({ response: 'pending' });
  });

  it('clears personal reminders with null and keeps them when absent', async () => {
    row(E, ME)!.reminders = [15];
    await respond({ response: 'tentative' });
    expect(row(E, ME)).toMatchObject({
      response: 'tentative',
      reminders: [15],
    });
    await respond({ response: 'tentative', reminders: null });
    expect(row(E, ME)!.reminders).toBeNull();
  });

  it('refuses a bad answer, bad reminders or a bad id', async () => {
    expect((await respond({ response: 'pending' })).status).toBe(400);
    expect((await respond({ response: 'organizer' })).status).toBe(400);
    expect(
      (await respond({ response: 'accepted', reminders: [1, 2, 3, 4, 5, 6] }))
        .status
    ).toBe(400);
    expect(
      (await respond({ response: 'accepted', reminders: [40321] })).status
    ).toBe(400);
    expect((await respond({ response: 'accepted' }, 'nope')).status).toBe(400);
    expect(row(E, ME)).toMatchObject({ response: 'pending' });
  });
});
