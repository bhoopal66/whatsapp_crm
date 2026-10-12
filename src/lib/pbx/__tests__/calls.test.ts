import { describe, expect, it } from 'vitest';
import {
  callDirectionLabel,
  callStatusLabel,
  dncDecision,
  isMissedCall,
  monthStart,
  myLeg,
  parseCallListQuery,
  presenceByUser,
  presenceView,
  recordingFileName,
  recordingRefusal,
  summarizeMonth,
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

  it('maps presence: stale, then on a call, then the chosen status', () => {
    expect(presenceView(row({ updated_at: '2026-10-12T09:49:59Z' }), NOW)).toBe(
      'offline'
    );
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
    expect(recordingRefusal('pending')).toBe('This call has no recording yet');
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

  it('checks a call list query', () => {
    const q = (s: string) => parseCallListQuery(new URLSearchParams(s));
    expect(q('')).toEqual({
      contactId: null,
      scope: 'all',
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
      scope: 'missed',
      from: '2026-09-30T20:00:00.000Z',
      to: null,
      limit: 200,
    });
    expect(q('contactId=x')).toBe('contactId must be an id');
    expect(q('scope=team')).toBe('scope must be one of mine, missed, all');
    expect(q('to=yesterday')).toBe('from and to must be dates');
    for (const limit of ['0', '201', '2.5', 'ten'])
      expect(q(`limit=${limit}`)).toMatch(/^limit must be/);
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
