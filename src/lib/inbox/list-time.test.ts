import { describe, expect, it } from 'vitest';

import { formatListTimestamp } from './list-time';

// Local-time constructors throughout, so the day boundaries hold in
// whatever timezone the suite runs in.
const at = (d: number, h = 0, m = 0) => new Date(2026, 8, d, h, m);
const NOW = at(30, 14, 5); // Wednesday 30 September 2026, 14:05
const EN = { locale: 'en', yesterday: 'Yesterday' };

describe('formatListTimestamp', () => {
  it('shows the time of day for today', () => {
    expect(formatListTimestamp(at(30, 9, 7).toISOString(), NOW, EN)).toBe(
      '09:07'
    );
    expect(formatListTimestamp(at(30, 0, 0).toISOString(), NOW, EN)).toBe(
      '00:00'
    );
  });

  it('says Yesterday for the previous calendar day, however recent', () => {
    expect(formatListTimestamp(at(29, 23, 59).toISOString(), NOW, EN)).toBe(
      'Yesterday'
    );
    expect(formatListTimestamp(at(29, 0, 1).toISOString(), NOW, EN)).toBe(
      'Yesterday'
    );
  });

  it('names the weekday within the last week', () => {
    expect(formatListTimestamp(at(28, 12).toISOString(), NOW, EN)).toBe(
      'Monday'
    );
    expect(formatListTimestamp(at(24, 12).toISOString(), NOW, EN)).toBe(
      'Thursday'
    );
  });

  it('switches to the date from a week back', () => {
    expect(formatListTimestamp(at(23, 12).toISOString(), NOW, EN)).toBe(
      '23/09/2026'
    );
    expect(
      formatListTimestamp(new Date(2025, 11, 31, 8).toISOString(), NOW, EN)
    ).toBe('31/12/2025');
  });

  it('localises the weekday and the word for yesterday', () => {
    const ko = { locale: 'ko', yesterday: '어제' };
    expect(formatListTimestamp(at(29, 12).toISOString(), NOW, ko)).toBe('어제');
    expect(formatListTimestamp(at(28, 12).toISOString(), NOW, ko)).toBe(
      '월요일'
    );
  });

  it('reads a slightly future stamp (clock skew) as today', () => {
    expect(formatListTimestamp(at(30, 14, 6).toISOString(), NOW, EN)).toBe(
      '14:06'
    );
  });

  it('returns an empty string when there is no usable timestamp', () => {
    expect(formatListTimestamp(undefined, NOW, EN)).toBe('');
    expect(formatListTimestamp(null, NOW, EN)).toBe('');
    expect(formatListTimestamp('not a date', NOW, EN)).toBe('');
  });
});
