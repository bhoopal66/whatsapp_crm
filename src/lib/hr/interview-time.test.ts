import { describe, expect, it } from 'vitest';

import {
  INTERVIEW_TIME_ZONE,
  formatInterviewTime,
  fromInterviewInput,
  interviewDraftError,
  interviewInputMin,
  toInterviewInput,
} from './interview-time';

describe('interview time zone', () => {
  it('is the clock the reminder writes {slot} in', () => {
    expect(INTERVIEW_TIME_ZONE).toBe('Asia/Dubai');
  });
});

describe('toInterviewInput', () => {
  it('shows a stored UTC instant as Dubai wall-clock time (UTC+4)', () => {
    expect(toInterviewInput('2026-12-01T06:30:00Z')).toBe('2026-12-01T10:30');
    expect(toInterviewInput('2026-12-01T06:30:00.000+00:00')).toBe(
      '2026-12-01T10:30'
    );
  });

  it('rolls the date over when Dubai is already on the next day', () => {
    expect(toInterviewInput('2026-12-31T21:15:00Z')).toBe('2027-01-01T01:15');
  });

  it('is empty for no time or one that does not parse', () => {
    expect(toInterviewInput(null)).toBe('');
    expect(toInterviewInput(undefined)).toBe('');
    expect(toInterviewInput('')).toBe('');
    expect(toInterviewInput('soon')).toBe('');
  });
});

describe('fromInterviewInput', () => {
  it('reads the input as Dubai time and returns the UTC instant', () => {
    expect(fromInterviewInput('2026-12-01T10:30')).toBe(
      '2026-12-01T06:30:00.000Z'
    );
    expect(fromInterviewInput('2027-01-01T01:15')).toBe(
      '2026-12-31T21:15:00.000Z'
    );
  });

  it('round-trips with toInterviewInput', () => {
    for (const v of [
      '2026-12-01T00:00',
      '2027-06-15T23:59',
      '2028-02-29T12:00',
    ])
      expect(toInterviewInput(fromInterviewInput(v))).toBe(v);
  });

  it('refuses a half-typed or impossible value', () => {
    for (const v of [
      '',
      '2026-12-01',
      '2026-12-01T10',
      '2026-12-01T10:30:00',
      '2026-04-31T10:00',
      '2027-02-29T10:00',
      '2026-12-01T24:00',
      '2026-13-01T10:00',
    ])
      expect(fromInterviewInput(v), v).toBeNull();
  });
});

describe('interviewInputMin', () => {
  it('is now in Dubai time, to the minute', () => {
    expect(interviewInputMin(new Date('2026-11-28T20:05:42Z'))).toBe(
      '2026-11-29T00:05'
    );
  });
});

describe('interviewDraftError', () => {
  const now = new Date('2026-11-28T08:00:00Z'); // 12:00 in Dubai

  it('accepts a time after now', () => {
    expect(interviewDraftError('2026-11-28T12:01', now)).toBeNull();
    expect(interviewDraftError('2026-12-05T09:00', now)).toBeNull();
  });

  it('refuses now and any earlier time, judged in Dubai time', () => {
    expect(interviewDraftError('2026-11-28T12:00', now)).toBe('past');
    expect(interviewDraftError('2026-11-28T11:59', now)).toBe('past');
    // 09:00 would still be ahead in UTC; in Dubai it has passed.
    expect(interviewDraftError('2026-11-28T09:00', now)).toBe('past');
  });

  it('refuses a value that is not a whole date and time', () => {
    expect(interviewDraftError('', now)).toBe('invalid');
    expect(interviewDraftError('2026-11-31T10:00', now)).toBe('invalid');
  });
});

describe('formatInterviewTime', () => {
  it('writes the stored time in Dubai time', () => {
    const text = formatInterviewTime('2026-12-01T06:30:00Z', 'en-GB')!;
    expect(text).toContain('1 Dec 2026');
    expect(text).toContain('10:30');
  });

  it('is null for no time', () => {
    expect(formatInterviewTime(null, 'en')).toBeNull();
    expect(formatInterviewTime('nope', 'en')).toBeNull();
  });
});
