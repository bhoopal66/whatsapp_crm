import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasMinRole, type AccountRole } from '@/lib/auth/roles';
import {
  createFakeDb,
  type FakeDb,
  type Row,
} from '@/lib/pbx/__tests__/fake-db';

const mocks = vi.hoisted(() => ({ requireRole: vi.fn() }));
vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'Forbidden' }, { status: 403 })
  ),
}));

import { GET as list } from './route';
import { GET as summary } from './summary/route';

const A = '00000000-0000-4000-8000-00000000000a';
const C1 = '00000000-0000-4000-8000-000000000001';
const C2 = '00000000-0000-4000-8000-000000000002';
let rls: FakeDb;

function as(role: AccountRole) {
  mocks.requireRole.mockImplementation(async (min: AccountRole) => {
    if (!hasMinRole(role, min)) throw new Error('Insufficient role');
    return { accountId: A, userId: 'me', role, supabase: rls.db };
  });
}
let n = 0;
const call = (p: Row): Row => ({
  id: `call-${++n}`,
  account_id: A,
  direction: 'inbound',
  status: 'answered',
  started_at: '2026-10-12T08:00:00.000Z',
  answered_at: null,
  ended_at: null,
  ring_seconds: 5,
  talk_seconds: 60,
  remote_number: '971501234567',
  extension: '201',
  contact_id: C1,
  user_id: 'me',
  peer_user_id: null,
  disposition: null,
  notes: null,
  recording_state: 'none',
  ...p,
});

beforeEach(() => {
  vi.clearAllMocks();
  n = 0;
  rls = createFakeDb({
    calls: [],
    contacts: [{ id: C1, name: 'Ahmed Ali' }],
    profiles: [{ user_id: 'me', account_id: A, full_name: 'Sara' }],
  });
  as('viewer');
});
afterEach(() => vi.useRealTimers());

const get = async (qs = '') => {
  const res = await list(
    new Request(`https://crm.example.com/api/pbx/calls?${qs}`)
  );
  return { status: res.status, body: await res.json() };
};
const ids = async (qs: string) =>
  ((await get(qs)).body.calls as { id: string }[]).map((c) => c.id);

describe('GET /api/pbx/calls', () => {
  it('lists visible calls newest first, with names and the outcome', async () => {
    rls.tables.calls.push(
      call({ started_at: '2026-10-11T08:00:00.000Z', notes: 'Wants a card' }),
      call({ contact_id: C2, user_id: 'other', disposition: 'call_back' }),
      call({ account_id: 'elsewhere' })
    );
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(mocks.requireRole).toHaveBeenCalledWith('viewer');
    expect(body.calls).toEqual([
      expect.objectContaining({
        id: 'call-2',
        contactId: C2,
        contactName: null, // a contact the caller cannot see
        userId: 'other',
        userName: null,
        disposition: 'call_back',
      }),
      {
        id: 'call-1',
        direction: 'inbound',
        status: 'answered',
        startedAt: '2026-10-11T08:00:00.000Z',
        answeredAt: null,
        endedAt: null,
        ringSeconds: 5,
        talkSeconds: 60,
        remoteNumber: '971501234567',
        extension: '201',
        contactId: C1,
        contactName: 'Ahmed Ali',
        doNotContactAt: null,
        doNotContactReason: null,
        userId: 'me',
        userName: 'Sara',
        rangNames: [],
        disposition: null,
        notes: 'Wants a card',
        recordingState: 'none',
        recordingDeleted: false,
        legalHold: false,
      },
    ]);
  });

  it('names everyone a missed call rang, as profiled in this workspace', async () => {
    rls.tables.profiles.push(
      { user_id: 'faisal', account_id: A, full_name: 'Faisal' },
      // The same login's profile in another workspace is not this one's.
      { user_id: 'faisal', account_id: 'elsewhere', full_name: 'F. Other' },
      { user_id: 'omar', account_id: 'elsewhere', full_name: 'Omar' }
    );
    rls.tables.calls.push(
      call({
        status: 'no_answer',
        user_id: null,
        meta: { rang_user_ids: ['me', 'faisal', 'omar'] },
      })
    );
    const { body } = await get();
    expect(body.calls[0]).toMatchObject({
      userName: null,
      rangNames: ['Sara', 'Faisal'],
    });
  });

  it('carries a visible contact’s do-not-contact stamp and reason, so Call back is disabled', async () => {
    const C3 = '00000000-0000-4000-8000-000000000003';
    rls.tables.contacts = [
      {
        id: C1,
        name: 'Ahmed Ali',
        do_not_contact_at: '2026-10-01T09:00:00.000Z',
        do_not_contact_reason: 'Asked on the phone',
      },
      // A reason left behind without a stamp is not do-not-contact.
      {
        id: C3,
        name: 'Mona',
        do_not_contact_at: null,
        do_not_contact_reason: 'Old note',
      },
    ];
    rls.tables.calls.push(
      call({ status: 'no_answer', talk_seconds: 0 }),
      call({ contact_id: C3, status: 'no_answer', talk_seconds: 0 }),
      // The caller cannot see C2: nothing of its consent comes back.
      call({ contact_id: C2, status: 'no_answer', talk_seconds: 0 }),
      call({ contact_id: null, status: 'no_answer', talk_seconds: 0 })
    );
    const { status, body } = await get('scope=missed');
    expect(status).toBe(200);
    const pick = (c: Record<string, unknown>) => ({
      id: c.id,
      contactId: c.contactId,
      doNotContactAt: c.doNotContactAt,
      doNotContactReason: c.doNotContactReason,
    });
    expect((body.calls as Record<string, unknown>[]).map(pick)).toEqual([
      {
        id: 'call-1',
        contactId: C1,
        doNotContactAt: '2026-10-01T09:00:00.000Z',
        doNotContactReason: 'Asked on the phone',
      },
      {
        id: 'call-2',
        contactId: C3,
        doNotContactAt: null,
        doNotContactReason: null,
      },
      {
        id: 'call-3',
        contactId: C2,
        doNotContactAt: null,
        doNotContactReason: null,
      },
      {
        id: 'call-4',
        contactId: null,
        doNotContactAt: null,
        doNotContactReason: null,
      },
    ]);
  });

  it("says whether a fetched call's audio was deleted or is on legal hold", async () => {
    rls.tables.calls.push(
      call({ id: 'k-kept', recording_state: 'fetched' }),
      call({ id: 'k-gone', recording_state: 'fetched' }),
      call({ id: 'k-held', recording_state: 'fetched' })
    );
    rls.tables.call_recordings = [
      { call_id: 'k-kept', legal_hold: false, erased_at: null },
      {
        call_id: 'k-gone',
        legal_hold: false,
        erased_at: '2026-10-12T00:00:00Z',
      },
      { call_id: 'k-held', legal_hold: true, erased_at: null },
    ];
    as('agent');
    const res = await list(new Request('http://x/api/pbx/calls'));
    const byId = Object.fromEntries(
      ((await res.json()).calls as Record<string, unknown>[]).map((c) => [
        c.id,
        [c.recordingDeleted, c.legalHold],
      ])
    );
    expect(byId).toEqual({
      'k-kept': [false, false],
      'k-gone': [true, false],
      'k-held': [false, true],
    });
  });

  it('filters by scope, contact, dates and limit', async () => {
    rls.tables.calls.push(
      call({
        user_id: 'other',
        peer_user_id: 'me',
        started_at: '2026-10-01T00:00:00.000Z',
      }),
      call({ user_id: 'other', status: 'no_answer' }),
      call({
        user_id: 'other',
        status: 'voicemail',
        answered_at: '2026-10-12T08:00:05Z',
      }),
      call({ direction: 'outbound', status: 'no_answer', contact_id: C2 })
    );
    expect(await ids('scope=mine')).toEqual(['call-4', 'call-1']);
    expect(await ids('scope=missed')).toEqual(['call-2']);
    expect(await ids(`contactId=${C2}`)).toEqual(['call-4']);
    expect(await ids('to=2026-10-02T00:00:00Z')).toEqual(['call-1']);
    expect(await ids('from=2026-10-02T00:00:00Z&limit=1')).toHaveLength(1);
    expect((await get('scope=team')).status).toBe(400);
    expect((await get('limit=500')).status).toBe(400);
  });

  it('refuses a bank guest', async () => {
    as('bank_guest');
    expect((await get()).status).toBe(403);
  });

  describe('scope=unrouted', () => {
    const D1 = '97142000001';
    const D2 = '97142000002';
    beforeEach(() => {
      rls.tables.calls.push(
        call({
          did_number: D1,
          meta: { unrouted: true },
          started_at: '2026-10-12T06:00:00.000Z',
        }),
        call({
          did_number: D2,
          meta: { unrouted: true, contact_candidates: [C1, C2] },
          started_at: '2026-10-12T07:00:00.000Z',
        }),
        // Erased: calls_guard keeps the flag and the dialled number only.
        call({
          did_number: D1,
          meta: { unrouted: true },
          remote_number: null,
          erased_at: '2026-10-12T09:30:00.000Z',
          started_at: '2026-10-12T09:00:00.000Z',
        }),
        // Routed calls, the newest of all.
        call({ did_number: '97142000003', started_at: '2026-10-12T10:00:00Z' }),
        call({ meta: { unrouted: false }, started_at: '2026-10-12T11:00:00Z' })
      );
    });

    it('is refused below admin', async () => {
      for (const role of ['viewer', 'agent', 'team_leader'] as const) {
        as(role);
        expect((await get('scope=unrouted')).status).toBe(403);
        expect((await get('scope=all')).status).toBe(200);
      }
      for (const role of ['admin', 'owner'] as const) {
        as(role);
        expect((await get('scope=unrouted')).status).toBe(200);
      }
    });

    it('filters the flag in the query, so the limit counts unrouted calls only', async () => {
      as('admin');
      const { body } = await get('scope=unrouted&limit=3');
      expect((body.calls as { id: string }[]).map((c) => c.id)).toEqual([
        'call-3',
        'call-2',
        'call-1',
      ]);
      expect(body.calls[0]).toMatchObject({
        remoteNumber: null,
        didNumber: D1,
        contactName: 'Ahmed Ali',
      });
      expect(await ids('scope=unrouted&limit=1')).toEqual(['call-3']);
    });

    it('sums up every unrouted call by dialled number, past the listed page', async () => {
      as('owner');
      const numbers = [
        { didNumber: D1, calls: 2, lastAt: '2026-10-12T09:00:00.000Z' },
        { didNumber: D2, calls: 1, lastAt: '2026-10-12T07:00:00.000Z' },
      ];
      expect((await get('scope=unrouted')).body.numbers).toEqual(numbers);
      expect((await get('scope=unrouted&limit=1')).body.numbers).toEqual(
        numbers
      );
      expect(
        (await get('scope=unrouted&from=2026-10-12T08:00:00Z')).body.numbers
      ).toEqual([
        { didNumber: D1, calls: 1, lastAt: '2026-10-12T09:00:00.000Z' },
      ]);
      expect((await get('scope=all')).body.numbers).toBeUndefined();
    });
  });
});

describe('GET /api/pbx/calls/summary', () => {
  const sum = async (qs = '') => {
    const res = await summary(
      new Request(`https://crm.example.com/api/pbx/calls/summary?${qs}`)
    );
    return { status: res.status, body: await res.json() };
  };

  it('counts this month from midnight on the 1st, Dubai time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 00:30 on 1 October in Dubai, still 30 September in UTC.
    vi.setSystemTime(new Date('2026-09-30T20:30:00.000Z'));
    rls.tables.calls.push(
      call({ started_at: '2026-09-30T19:59:59.000Z' }), // 23:59:59 on the 30th
      call({ started_at: '2026-09-30T20:00:00.000Z', talk_seconds: 30 }),
      call({
        started_at: '2026-09-30T20:10:00.000Z',
        status: 'no_answer',
        talk_seconds: null,
      }),
      call({
        started_at: '2026-09-30T20:20:00.000Z',
        contact_id: C2,
        status: 'busy',
        direction: 'outbound',
        talk_seconds: null,
      })
    );
    expect((await sum()).body).toEqual({
      total: 3,
      answered: 1,
      missed: 1,
      talkSeconds: 30,
    });
    expect((await sum(`contactId=${C1}`)).body).toEqual({
      total: 2,
      answered: 1,
      missed: 1,
      talkSeconds: 30,
    });
    // In UTC it is still September: all four.
    expect((await sum('tz=UTC')).body.total).toBe(4);
    expect((await sum('tz=Mars/Base')).status).toBe(400);
    expect((await sum('contactId=x')).status).toBe(400);
  });

  it('pages past PostgREST’s row cap', async () => {
    for (let i = 0; i < 2500; i++)
      rls.tables.calls.push(call({ started_at: new Date().toISOString() }));
    expect((await sum()).body).toMatchObject({ total: 2500, answered: 2500 });
    expect(rls.log.filter((l) => l.table === 'calls')).toHaveLength(3);
  });
});
