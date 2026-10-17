import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  TALK_BUCKET_KEYS,
  delta,
  formatDuration,
  formatPercent,
  parseCallStats,
} from './call-stats';

const SUMMARY = {
  calls: 12,
  inbound_total: 8,
  inbound_answered: 6,
  outbound_total: 4,
  outbound_answered: 3,
  missed: 2,
  answer_rate: 0.75,
  talk_seconds_total: 900,
  talk_calls: 9,
  avg_talk_seconds: 100,
  longest_talk_seconds: 400,
  ring_seconds_total: 60,
  ring_calls: 6,
  avg_ring_seconds: 10,
  max_ring_seconds: 25,
  unique_numbers: 7,
  with_outcome: 5,
};

const EMPTY = {
  calls: 0,
  inbound_total: 0,
  inbound_answered: 0,
  outbound_total: 0,
  outbound_answered: 0,
  missed: 0,
  answer_rate: null,
  talk_seconds_total: 0,
  talk_calls: 0,
  avg_talk_seconds: null,
  longest_talk_seconds: null,
  ring_seconds_total: 0,
  ring_calls: 0,
  avg_ring_seconds: null,
  max_ring_seconds: null,
  unique_numbers: 0,
  with_outcome: 0,
};

const STATS = {
  summary: SUMMARY,
  previous: EMPTY,
  by_day: [
    {
      day: '2026-10-12',
      calls: 5,
      inbound_answered: 2,
      outbound: 2,
      outbound_answered: 1,
      missed: 1,
      talk_seconds: 300,
    },
    { day: '2026-10-13', calls: 0 },
  ],
  by_hour: [
    { dow: 1, hour: 9, calls: 3, answered: 2, missed: 1, talk_seconds: 200 },
  ],
  talk_buckets: [
    { key: 'under_30s', min_seconds: 0, max_seconds: 30, calls: 2 },
    { key: '15m_plus', min_seconds: 900, max_seconds: null, calls: 1 },
  ],
  outcomes: { interested: 2, none: 3 },
  people: [
    {
      kind: 'person',
      user_id: 'u-1',
      full_name: 'Sara',
      extension: '101',
      ...SUMMARY,
    },
    { kind: 'none', user_id: null, full_name: null, ...EMPTY, missed: 1 },
  ],
  top_numbers: [
    {
      contact_id: 'c-1',
      contact_name: 'Omar',
      remote_number: '+971500000001',
      calls: 4,
      talk_seconds: 320,
      last_call_at: '2026-10-13T09:00:00+00:00',
    },
  ],
  longest: [
    {
      id: 'call-1',
      started_at: '2026-10-12T08:00:00+00:00',
      direction: 'inbound',
      remote_number: '+971500000001',
      contact_id: null,
      contact_name: null,
      talk_seconds: 400,
      user_id: 'u-1',
      user_name: 'Sara',
    },
  ],
  range: {
    from: '2026-10-11T20:00:00+00:00',
    to: '2026-10-13T10:00:00+00:00',
    tz: 'Asia/Dubai',
    previous_from: '2026-10-10T06:00:00+00:00',
    previous_to: '2026-10-11T20:00:00+00:00',
  },
  scope: 'workspace',
  user_id: null,
};

describe('parseCallStats', () => {
  it('reads every part into camelCase', () => {
    const s = parseCallStats(STATS)!;
    expect(s.summary).toEqual({
      calls: 12,
      inboundTotal: 8,
      inboundAnswered: 6,
      outboundTotal: 4,
      outboundAnswered: 3,
      missed: 2,
      answerRate: 0.75,
      talkSecondsTotal: 900,
      talkCalls: 9,
      avgTalkSeconds: 100,
      longestTalkSeconds: 400,
      ringSecondsTotal: 60,
      ringCalls: 6,
      avgRingSeconds: 10,
      maxRingSeconds: 25,
      uniqueNumbers: 7,
      withOutcome: 5,
    });
    expect(s.previous.answerRate).toBeNull();
    expect(s.previous.avgTalkSeconds).toBeNull();
    expect(s.previous.calls).toBe(0);
    expect(s.byDay).toEqual([
      {
        day: '2026-10-12',
        calls: 5,
        inboundAnswered: 2,
        outbound: 2,
        outboundAnswered: 1,
        missed: 1,
        talkSeconds: 300,
      },
      {
        day: '2026-10-13',
        calls: 0,
        inboundAnswered: 0,
        outbound: 0,
        outboundAnswered: 0,
        missed: 0,
        talkSeconds: 0,
      },
    ]);
    expect(s.byHour).toEqual([
      { dow: 1, hour: 9, calls: 3, answered: 2, missed: 1, talkSeconds: 200 },
    ]);
    expect(s.talkBuckets).toEqual([
      { key: 'under_30s', minSeconds: 0, maxSeconds: 30, calls: 2 },
      { key: '15m_plus', minSeconds: 900, maxSeconds: null, calls: 1 },
    ]);
    expect(s.outcomes).toEqual({
      interested: 2,
      docs_requested: 0,
      call_back: 0,
      not_eligible: 0,
      wrong_number: 0,
      none: 3,
    });
    expect(s.people).toHaveLength(2);
    expect(s.people![0]).toMatchObject({
      kind: 'person',
      userId: 'u-1',
      fullName: 'Sara',
      extension: '101',
      calls: 12,
      answerRate: 0.75,
    });
    expect(s.people![1]).toMatchObject({
      kind: 'none',
      userId: null,
      fullName: null,
      missed: 1,
    });
    expect(s.topNumbers).toEqual([
      {
        contactId: 'c-1',
        contactName: 'Omar',
        remoteNumber: '+971500000001',
        calls: 4,
        talkSeconds: 320,
        lastCallAt: '2026-10-13T09:00:00+00:00',
      },
    ]);
    expect(s.longest).toEqual([
      {
        id: 'call-1',
        startedAt: '2026-10-12T08:00:00+00:00',
        direction: 'inbound',
        remoteNumber: '+971500000001',
        contactId: null,
        contactName: null,
        talkSeconds: 400,
        userId: 'u-1',
        userName: 'Sara',
      },
    ]);
    expect(s.range).toEqual({
      from: '2026-10-11T20:00:00+00:00',
      to: '2026-10-13T10:00:00+00:00',
      tz: 'Asia/Dubai',
      previousFrom: '2026-10-10T06:00:00+00:00',
      previousTo: '2026-10-11T20:00:00+00:00',
    });
    expect(s.scope).toBe('workspace');
    expect(s.userId).toBeNull();
  });

  it('is null for anything that is not an object', () => {
    for (const v of [null, undefined, 'x', 3, [STATS]])
      expect(parseCallStats(v)).toBeNull();
  });

  it('reads bad counts as 0 and bad measures as null', () => {
    const s = parseCallStats({
      summary: {
        calls: 'nonsense',
        missed: -3,
        inbound_total: '4',
        talk_calls: 2.7,
        answer_rate: 1.4,
        avg_talk_seconds: 'x',
        longest_talk_seconds: -1,
        max_ring_seconds: '12.5',
      },
    })!;
    expect(s.summary).toMatchObject({
      calls: 0,
      missed: 0,
      inboundTotal: 4,
      talkCalls: 2,
      answerRate: 1,
      avgTalkSeconds: null,
      longestTalkSeconds: null,
      maxRingSeconds: 12.5,
    });
    expect(parseCallStats({ summary: { answer_rate: -0.2 } })!.summary).toEqual(
      expect.objectContaining({ answerRate: 0 })
    );
  });

  it('reads missing parts as empty, and people as null unless a list', () => {
    const s = parseCallStats({})!;
    expect(s.summary.calls).toBe(0);
    expect(s.summary.answerRate).toBeNull();
    expect(s.byDay).toEqual([]);
    expect(s.byHour).toEqual([]);
    expect(s.talkBuckets).toEqual([]);
    expect(s.topNumbers).toEqual([]);
    expect(s.longest).toEqual([]);
    expect(s.people).toBeNull();
    expect(s.outcomes.none).toBe(0);
    expect(s.range).toEqual({
      from: null,
      to: null,
      tz: null,
      previousFrom: null,
      previousTo: null,
    });
    expect(parseCallStats({ people: [] })!.people).toEqual([]);
    expect(parseCallStats({ by_day: 'x', longest: {} })!.byDay).toEqual([]);
  });

  it('drops rows it cannot place', () => {
    const s = parseCallStats({
      by_day: [{ day: '13/10/2026', calls: 1 }, null, { calls: 2 }],
      by_hour: [
        { dow: 0, hour: 9, calls: 1 },
        { dow: 8, hour: 9, calls: 1 },
        { dow: 2, hour: 24, calls: 1 },
        { dow: 2, hour: 1.5, calls: 1 },
        { dow: '3', hour: '23', calls: 1 },
      ],
      talk_buckets: [{ key: 'forever', calls: 3 }],
      people: [
        { kind: 'person', user_id: null },
        { kind: 'total', user_id: 'u-9' },
        'x',
      ],
      longest: [{ talk_seconds: 10 }, { id: 'c', talk_seconds: 'x' }],
    })!;
    expect(s.byDay).toEqual([]);
    expect(s.byHour).toEqual([
      { dow: 3, hour: 23, calls: 1, answered: 0, missed: 0, talkSeconds: 0 },
    ]);
    expect(s.talkBuckets).toEqual([]);
    expect(s.people).toEqual([]);
    expect(s.longest).toEqual([
      expect.objectContaining({ id: 'c', talkSeconds: 0, direction: null }),
    ]);
  });

  it('reads an unknown scope as the narrowest', () => {
    expect(parseCallStats({ scope: 'galaxy' })!.scope).toBe('self');
    expect(parseCallStats({ scope: 'team' })!.scope).toBe('team');
    expect(parseCallStats({ scope: 'person', user_id: 'u-2' })).toMatchObject({
      scope: 'person',
      userId: 'u-2',
    });
  });
});

describe('formatters', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(35)).toBe('35s');
    expect(formatDuration(59.6)).toBe('1m 00s');
    expect(formatDuration(245)).toBe('4m 05s');
    expect(formatDuration(3600)).toBe('1h 00m');
    expect(formatDuration(3720)).toBe('1h 02m');
    expect(formatDuration(3759)).toBe('1h 02m');
    expect(formatDuration(90061)).toBe('25h 01m');
    for (const v of [null, undefined, NaN, -1, Infinity])
      expect(formatDuration(v)).toBe('—');
  });

  it('formats a ratio as a percentage', () => {
    expect(formatPercent(0.75)).toBe('75%');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(0.1234, 1)).toBe('12.3%');
    expect(formatPercent(-0.25)).toBe('-25%');
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(undefined)).toBe('—');
    expect(formatPercent(NaN)).toBe('—');
  });

  it('measures a change against the previous period', () => {
    expect(delta(12, 8)).toEqual({ abs: 4, pct: 0.5, direction: 'up' });
    expect(delta(6, 8)).toEqual({ abs: -2, pct: -0.25, direction: 'down' });
    expect(delta(8, 8)).toEqual({ abs: 0, pct: 0, direction: 'flat' });
    // Nothing to compare a percentage against.
    expect(delta(5, 0)).toEqual({ abs: 5, pct: null, direction: 'up' });
    expect(delta(0, 0)).toEqual({ abs: 0, pct: null, direction: 'flat' });
    // Float noise on ratios is no change.
    expect(delta(0.1 + 0.2, 0.3)).toEqual({
      abs: 0,
      pct: 0,
      direction: 'flat',
    });
    expect(delta(null, 3)).toBeNull();
    expect(delta(3, null)).toBeNull();
    expect(delta(undefined, 3)).toBeNull();
    expect(delta(NaN, 3)).toBeNull();
  });
});

describe('agrees with the database', () => {
  const sql = readFileSync(
    join(process.cwd(), 'supabase/migrations/119_pbx_call_stats.sql'),
    'utf8'
  );

  it('the talk buckets are the ones 119 builds', () => {
    for (const key of TALK_BUCKET_KEYS) expect(sql).toContain(`'${key}'`);
  });
});
