import { beforeEach, describe, expect, it, vi } from 'vitest';

// RLS shows an owner or admin every event and meeting in the workspace,
// so the feed selects each source explicitly. The fake database here
// answers like an admin's client: everything is visible, and only the
// route's own filters keep someone else's private event out.

import { fakeSupabase, type FakeDb } from '../test-db';

const mocks = vi.hoisted(() => ({ getCurrentAccount: vi.fn() }));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));

import type { FeedItem } from '@/lib/calendar/feed';

import { GET } from './route';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ACCT = 'acct-1';

const event = (id: string, over: Record<string, unknown>) => ({
  id,
  account_id: ACCT,
  created_by: OTHER,
  title: id,
  location: null,
  start_at: '2026-10-10T09:00:00.000Z',
  end_at: '2026-10-10T10:00:00.000Z',
  all_day: false,
  time_zone: 'Asia/Dubai',
  color: 'blue',
  rrule: null,
  exdates: [],
  visibility: 'private',
  status: 'confirmed',
  ...over,
});
const meeting = (id: string, over: Record<string, unknown>) => ({
  id,
  account_id: ACCT,
  title: id,
  scheduled_start: '2026-10-12T09:00:00.000Z',
  scheduled_end: '2026-10-12T09:30:00.000Z',
  host_user_id: OTHER,
  open_to_workspace: false,
  status: 'scheduled',
  ...over,
});

let db: FakeDb;

function seed(): FakeDb {
  return {
    tables: {
      calendar_events: [
        event('mine', { created_by: ME }),
        event('invited', {}),
        event('workspace', { visibility: 'workspace' }),
        event('someone-elses', {}),
        event('mine-cancelled', { created_by: ME, status: 'cancelled' }),
        event('invited-cancelled', { status: 'cancelled' }),
        event('workspace-cancelled', {
          visibility: 'workspace',
          status: 'cancelled',
        }),
        // A weekly series that began before the range still shows.
        event('series', {
          created_by: ME,
          start_at: '2026-09-01T09:00:00.000Z',
          end_at: '2026-09-01T10:00:00.000Z',
          rrule: 'FREQ=WEEKLY',
        }),
      ],
      calendar_event_attendees: [
        {
          event_id: 'mine',
          user_id: OTHER,
          account_id: ACCT,
          response: 'pending',
        },
        {
          event_id: 'invited',
          user_id: ME,
          account_id: ACCT,
          response: 'accepted',
        },
        {
          event_id: 'invited-cancelled',
          user_id: ME,
          account_id: ACCT,
          response: 'accepted',
        },
        {
          event_id: 'someone-elses',
          user_id: OTHER,
          account_id: ACCT,
          response: 'accepted',
        },
      ],
      meetings: [
        meeting('hosted', { host_user_id: ME }),
        meeting('invited-ended', { status: 'ended' }),
        meeting('open', { open_to_workspace: true }),
        meeting('closed', {}),
        meeting('hosted-cancelled', { host_user_id: ME, status: 'cancelled' }),
        meeting('hosted-unscheduled', {
          host_user_id: ME,
          scheduled_start: null,
        }),
        meeting('hosted-later', {
          host_user_id: ME,
          scheduled_start: '2026-12-01T09:00:00.000Z',
          scheduled_end: '2026-12-01T10:00:00.000Z',
        }),
      ],
      meeting_invitees: [
        { meeting_id: 'invited-ended', user_id: ME, account_id: ACCT },
        { meeting_id: 'closed', user_id: OTHER, account_id: ACCT },
      ],
      tasks: [
        {
          id: 'task',
          account_id: ACCT,
          title: 't',
          due_at: '2026-10-15T09:00:00.000Z',
          status: 'open',
          assigned_to: ME,
          contact_id: null,
        },
        {
          id: 'task-other',
          account_id: ACCT,
          title: 't',
          due_at: '2026-10-15T09:00:00.000Z',
          status: 'open',
          assigned_to: OTHER,
          contact_id: null,
        },
        {
          id: 'task-done',
          account_id: ACCT,
          title: 't',
          due_at: '2026-10-15T09:00:00.000Z',
          status: 'done',
          assigned_to: ME,
          contact_id: null,
        },
        {
          id: 'task-later',
          account_id: ACCT,
          title: 't',
          due_at: '2026-12-15T09:00:00.000Z',
          status: 'open',
          assigned_to: ME,
          contact_id: null,
        },
      ],
    },
  };
}

const RANGE = 'from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z';
const feed = (query = RANGE) =>
  GET(new Request(`http://x/api/calendar/feed?${query}`));
const keys = (items: FeedItem[]) =>
  [...new Set(items.map((i) => `${i.kind}:${i.id}`))].sort();

describe('GET /api/calendar/feed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    db = seed();
    mocks.getCurrentAccount.mockResolvedValue({
      role: 'admin',
      userId: ME,
      accountId: ACCT,
      supabase: fakeSupabase(db),
    });
  });

  it('shows an admin only their own, invited and workspace items', async () => {
    const res = await feed();
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: FeedItem[] };
    expect(keys(items)).toEqual([
      'event:invited',
      'event:mine',
      'event:series',
      'event:workspace',
      'meeting:hosted',
      'meeting:invited-ended',
      'task:task',
    ]);
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get('mine')).toMatchObject({
      myResponse: 'organizer',
      attendeeCount: 1,
    });
    expect(byId.get('invited')).toMatchObject({ myResponse: 'accepted' });
    expect(byId.get('workspace')).toMatchObject({ myResponse: null });
    expect(items.filter((i) => i.id === 'series')).toHaveLength(4);
  });

  it('reads the attendees of many events in batches of 100, merged', async () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      event(`bulk-${i}`, { created_by: ME })
    );
    db.tables.calendar_events = many;
    db.tables.calendar_event_attendees = many.map((e) => ({
      event_id: e.id,
      account_id: ACCT,
      user_id: OTHER,
      response: 'accepted',
    }));
    const res = await feed();
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: FeedItem[] };
    const bulk = items.filter((i) => i.id.startsWith('bulk-'));
    expect(bulk).toHaveLength(250);
    // Every batch's rows reach the feed: one invitee each.
    expect(bulk.every((i) => i.kind === 'event' && i.attendeeCount === 1)).toBe(
      true
    );
    expect(db.inSizes?.['calendar_event_attendees:in']).toEqual([100, 100, 50]);
  });

  it('adds open-to-workspace meetings only when asked', async () => {
    const res = await feed(`${RANGE}&includeWorkspaceMeetings=1`);
    const { items } = (await res.json()) as { items: FeedItem[] };
    expect(keys(items)).toContain('meeting:open');
    expect(keys(items)).not.toContain('meeting:closed');
  });

  it('refuses a missing, reversed or over-long range', async () => {
    expect((await feed('from=2026-10-01T00:00:00Z')).status).toBe(400);
    expect((await feed('from=nope&to=2026-10-01T00:00:00Z')).status).toBe(400);
    expect(
      (await feed('from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z')).status
    ).toBe(400);
    expect(
      (await feed('from=2026-01-01T00:00:00Z&to=2027-02-06T00:00:00Z')).status
    ).toBe(400);
    expect(
      (await feed('from=2026-01-01T00:00:00Z&to=2027-02-05T00:00:00Z')).status
    ).toBe(200);
  });

  it('answers 503 when a read fails', async () => {
    db.errors = { 'tasks:select': { code: '57014' } };
    const res = await feed();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'temporarily_unavailable' });
  });

  it('refuses a bank guest', async () => {
    mocks.getCurrentAccount.mockResolvedValue({ role: 'bank_guest' });
    const res = await feed();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'The calendar is for staff only',
    });
  });
});
