import { describe, expect, it } from 'vitest';
import { ACCOUNT_ROLES } from '@/lib/auth/roles';
import {
  callDirectionLabel,
  callStatusLabel,
  canListCallScope,
  dncDecision,
  isMissedCall,
  monthStart,
  myLeg,
  myCallsFilter,
  parseCallListQuery,
  presenceByUser,
  presenceView,
  recordingFileName,
  recordingRefusal,
  recordingRefusalCode,
  summarizeMonth,
  unroutedNumbers,
  visibleCall,
} from '../calls';

const NOW = Date.parse('2026-10-12T10:00:00Z');
const row = (p: Partial<Parameters<typeof presenceView>[0]>) => ({
  user_id: 'u1',
  extension: '201',
  presence: null,
  call_state: null,
  updated_at: '2026-10-12T09:55:00Z',
  ...p,
});

describe('pbx call helpers', () => {
  it('labels statuses and directions, passing unknown values through', () => {
    expect(callStatusLabel('no_answer')).toBe('No answer');
    expect(callDirectionLabel('inbound')).toBe('Incoming');
    expect(callStatusLabel('weird')).toBe('weird');
  });

  it('never expires the chosen status: Yeastar sends it only when it changes', () => {
    const old = '2026-10-10T08:00:00Z'; // two days without a change
    expect(
      presenceView(row({ presence: 'do_not_disturb', updated_at: old }), NOW)
    ).toBe('dnd');
    expect(presenceView(row({ presence: 'lunch', updated_at: old }), NOW)).toBe(
      'away'
    );
    expect(
      presenceView(row({ presence: 'business_trip', updated_at: old }), NOW)
    ).toBe('away');
    expect(
      presenceView(row({ presence: 'off_work', updated_at: old }), NOW)
    ).toBe('off_work');
    expect(
      presenceView(row({ presence: 'available', updated_at: old }), NOW)
    ).toBe('available');
  });

  it('lets a call state lapse after ten minutes, to the chosen status underneath', () => {
    const fresh = '2026-10-12T09:50:00Z'; // exactly ten minutes
    const lapsed = '2026-10-12T09:49:59Z';
    expect(
      presenceView(row({ call_state: 'busy', updated_at: fresh }), NOW)
    ).toBe('on_call');
    expect(
      presenceView(row({ call_state: 'ringing', updated_at: fresh }), NOW)
    ).toBe('on_call');
    expect(
      presenceView(
        row({
          presence: 'do_not_disturb',
          call_state: 'busy',
          updated_at: lapsed,
        }),
        NOW
      )
    ).toBe('dnd');
    expect(
      presenceView(row({ call_state: 'busy', updated_at: lapsed }), NOW)
    ).toBe('available');
    expect(
      presenceView(
        row({ presence: 'away', call_state: 'busy', updated_at: 'garbage' }),
        NOW
      )
    ).toBe('away');
  });

  it('a missed call is an unanswered inbound one', () => {
    expect(isMissedCall({ direction: 'inbound', status: 'voicemail' })).toBe(
      true
    );
    expect(isMissedCall({ direction: 'outbound', status: 'no_answer' })).toBe(
      false
    );
    expect(isMissedCall({ direction: 'inbound', status: 'answered' })).toBe(
      false
    );
  });

  it('maps presence: on a call, then the chosen status', () => {
    expect(
      presenceView(row({ presence: 'do_not_disturb', call_state: 'busy' }), NOW)
    ).toBe('on_call');
    expect(presenceView(row({ presence: 'lunch' }), NOW)).toBe('away');
    expect(presenceView(row({ presence: 'do_not_disturb' }), NOW)).toBe('dnd');
    expect(
      presenceView(row({ presence: 'off_work', call_state: 'idle' }), NOW)
    ).toBe('off_work');
    expect(presenceView(row({}), NOW)).toBe('available');
    const by = presenceByUser(
      [
        row({ presence: 'away', updated_at: '2026-10-12T09:58:00Z' }),
        row({ extension: '301', presence: 'available' }),
        row({ user_id: null }),
      ],
      NOW
    );
    expect(by).toEqual({
      u1: {
        state: 'away',
        extension: '201',
        updatedAt: '2026-10-12T09:58:00Z',
      },
    });
  });

  it('starts the month at local midnight on the 1st', () => {
    const now = new Date('2026-10-31T21:00:00Z'); // 1 Nov 01:00 in Dubai
    expect(monthStart(now, 'Asia/Dubai').toISOString()).toBe(
      '2026-10-31T20:00:00.000Z'
    );
    expect(monthStart(now).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(
      monthStart(
        new Date('2026-04-15T12:00:00Z'),
        'Europe/London'
      ).toISOString()
    ).toBe('2026-03-31T23:00:00.000Z');
  });

  it('summarises a month of calls', () => {
    expect(
      summarizeMonth([
        { direction: 'inbound', status: 'answered', talk_seconds: 60 },
        {
          direction: 'outbound',
          status: 'in_progress',
          answered_at: 'x',
          talk_seconds: null,
        },
        { direction: 'inbound', status: 'no_answer' },
        { direction: 'outbound', status: 'busy' },
      ])
    ).toEqual({ total: 4, answered: 2, missed: 1, talkSeconds: 60 });
  });

  it('refuses a do-not-contact call unless an admin gives a reason', () => {
    expect(dncDecision({ doNotContact: false, rank: 2 })).toEqual({
      kind: 'allow',
    });
    expect(
      dncDecision({ doNotContact: true, rank: 3, overrideReason: 'asked' })
    ).toEqual({
      kind: 'refuse',
    });
    expect(
      dncDecision({ doNotContact: true, rank: 4, overrideReason: '  ' })
    ).toEqual({
      kind: 'refuse',
    });
    expect(
      dncDecision({
        doNotContact: true,
        rank: 4,
        overrideReason: ' court order ',
      })
    ).toEqual({
      kind: 'override',
      reason: 'court order',
    });
  });

  it('words a refused recording by state', () => {
    expect(recordingRefusal('held')).toBe(
      'Recording held until the notice is confirmed'
    );
    expect(recordingRefusal('erased')).toBe('This recording was erased');
    expect(recordingRefusal('not_stored')).toBe(
      'This recording was not stored in the CRM'
    );
    expect(recordingRefusal('pending')).toBe('This call has no recording yet');
  });

  it('says the retention period deleted the audio, whatever the call says', () => {
    expect(recordingRefusal('fetched', true)).toBe(
      'This recording was deleted under the retention period'
    );
    expect(recordingRefusalCode('fetched', true)).toBe('expired');
    expect(recordingRefusalCode('fetched')).toBe('held');
    expect(recordingRefusalCode('erased')).toBe('erased');
    expect(recordingRefusalCode('not_stored')).toBe('not_stored');
    expect(recordingRefusalCode('pending')).toBe('none');
  });

  it('names an attached recording by its Dubai day and who was called', () => {
    // 22:30 UTC on the 11th is already the 12th in Dubai.
    expect(recordingFileName('2026-10-11T22:30:00Z', ' Ahmed Ali ')).toBe(
      'Call recording 2026-10-12 Ahmed Ali'
    );
    expect(recordingFileName('2026-10-11T22:30:00Z', null, 'UTC')).toBe(
      'Call recording 2026-10-11'
    );
    const long = recordingFileName('2026-10-12T08:00:00Z', '😀'.repeat(300));
    expect(Array.from(long)).toHaveLength(255);
    expect(long.endsWith('😀')).toBe(true);
  });

  it('counts a call that rang me as mine, in the or-filter', () => {
    const me = '00000000-0000-4000-8000-0000000000aa';
    expect(myCallsFilter(me)).toBe(
      `user_id.eq.${me},peer_user_id.eq.${me},meta->rang_user_ids.cs.["${me}"]`
    );
  });

  it('checks a call list query', () => {
    const q = (s: string) => parseCallListQuery(new URLSearchParams(s));
    expect(q('')).toEqual({
      contactId: null,
      userId: null,
      scope: 'mine',
      from: null,
      to: null,
      limit: 50,
    });
    expect(
      q(
        'contactId=00000000-0000-4000-8000-000000000001&scope=missed&from=2026-10-01T00:00:00%2B04:00&limit=200'
      )
    ).toEqual({
      contactId: '00000000-0000-4000-8000-000000000001',
      userId: null,
      scope: 'missed',
      from: '2026-09-30T20:00:00.000Z',
      to: null,
      limit: 200,
    });
    expect(q('contactId=x')).toBe('contactId must be an id');
    expect(q('userId=x')).toBe('userId must be an id');
    expect(q('userId=00000000-0000-4000-8000-0000000000aa')).toMatchObject({
      userId: '00000000-0000-4000-8000-0000000000aa',
    });
    expect(q('scope=team')).toBe(
      'scope must be one of mine, my_missed, missed, all, unrouted'
    );
    expect(q('scope=unrouted')).toMatchObject({ scope: 'unrouted' });
    expect(q('to=yesterday')).toBe('from and to must be dates');
    for (const limit of ['0', '201', '2.5', 'ten'])
      expect(q(`limit=${limit}`)).toMatch(/^limit must be/);
  });

  it('lists unrouted calls to owners and admins only', () => {
    for (const role of ACCOUNT_ROLES) {
      expect(canListCallScope(role, 'unrouted')).toBe(
        role === 'owner' || role === 'admin'
      );
      for (const scope of ['mine', 'missed', 'all'] as const)
        expect(canListCallScope(role, scope)).toBe(true);
    }
  });

  it('sums up unrouted calls by dialled number', () => {
    const r = (did_number: string | null, started_at: string) => ({
      did_number,
      started_at,
    });
    expect(
      unroutedNumbers([
        r('97142000002', '2026-10-12T07:00:00Z'),
        r('97142000001', '2026-10-12T09:00:00Z'),
        r(null, '2026-10-12T10:00:00Z'),
        r('97142000001', '2026-10-12T06:00:00Z'),
        r('97142000003', '2026-10-12T08:00:00Z'),
      ])
    ).toEqual([
      { didNumber: '97142000001', calls: 2, lastAt: '2026-10-12T09:00:00Z' },
      { didNumber: '97142000003', calls: 1, lastAt: '2026-10-12T08:00:00Z' },
      { didNumber: '97142000002', calls: 1, lastAt: '2026-10-12T07:00:00Z' },
    ]);
    expect(unroutedNumbers([])).toEqual([]);
  });

  it('puts the number called most recently first, whatever its count', () => {
    const r = (did_number: string, started_at: string) => ({
      did_number,
      started_at,
    });
    // 001 took three calls and was fixed; 002 only just began to fail.
    const numbers = unroutedNumbers([
      r('97142000001', '2026-09-20T09:00:00Z'),
      r('97142000001', '2026-09-20T10:00:00Z'),
      r('97142000001', '2026-09-20T11:00:00Z'),
      r('97142000002', '2026-10-12T07:00:00Z'),
    ]);
    expect(numbers.map((n) => [n.didNumber, n.calls])).toEqual([
      ['97142000002', 1],
      ['97142000001', 3],
    ]);
    // The same latest call: more calls first, then the number itself.
    expect(
      unroutedNumbers([
        r('97142000003', '2026-10-12T07:00:00Z'),
        r('97142000002', '2026-10-12T07:00:00Z'),
        r('97142000001', '2026-10-12T07:00:00.000Z'),
        r('97142000001', '2026-10-11T07:00:00Z'),
      ]).map((n) => n.didNumber)
    ).toEqual(['97142000001', '97142000002', '97142000003']);
  });

  it('finds the caller’s own leg only on a call that lists their extension', () => {
    const calls = [
      {
        callId: 'c1',
        members: [
          {
            kind: 'extension' as const,
            channelId: 'ch-201',
            number: '201',
            status: 'ANSWERED',
          },
          {
            kind: 'outbound' as const,
            channelId: 'ch-out',
            status: 'ANSWERED',
          },
          {
            kind: 'extension' as const,
            channelId: 'ch-old',
            number: '202',
            status: 'BYE',
          },
        ],
      },
    ];
    const leg = myLeg(calls, 'c1', '201');
    expect(leg?.mine.channelId).toBe('ch-201');
    expect(leg?.others.map((m) => m.channelId)).toEqual(['ch-out']);
    expect(myLeg(calls, 'c1', '202')).not.toBeNull();
    expect(myLeg(calls, 'c1', '203')).toBeNull();
    expect(myLeg(calls, 'c2', '201')).toBeNull();
  });
});

describe('visibleCall', () => {
  it('reads both clocks a call is aged by for retention', async () => {
    // A client that answers only the columns asked for, as PostgREST does.
    const row: Record<string, unknown> = {
      id: 'c1',
      account_id: 'a1',
      recording_state: 'fetched',
      started_at: '2026-09-01T10:00:00Z',
      created_at: '2026-10-13T10:00:00Z',
      contact_id: null,
      remote_number: null,
      recording_file: 'x.wav',
    };
    const rls = {
      from: () => ({
        select: (cols: string) => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: Object.fromEntries(
                cols.split(',').map((c) => [c.trim(), row[c.trim()]])
              ),
              error: null,
            }),
          }),
        }),
      }),
    };
    const call = await visibleCall(rls as never, 'c1');
    // The later of the two is the age (093's pbx_recording_age_from):
    // without created_at a wrong PBX clock would warn about a deletion
    // the run never makes.
    expect(call).toMatchObject({
      started_at: '2026-09-01T10:00:00Z',
      created_at: '2026-10-13T10:00:00Z',
    });
    expect(call).not.toHaveProperty('recording_file');
  });
});
