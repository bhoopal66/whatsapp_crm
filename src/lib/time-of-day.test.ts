import { describe, expect, it } from 'vitest';

import {
  formatClock,
  hourOptions,
  minuteOptions,
  parseClock,
} from './time-of-day';

describe('parseClock', () => {
  it('reads 24-hour times', () => {
    expect(parseClock('09:05')).toEqual({ hour: 9, minute: 5 });
    expect(parseClock('9:05')).toEqual({ hour: 9, minute: 5 });
    expect(parseClock(' 23:59 ')).toEqual({ hour: 23, minute: 59 });
    expect(parseClock('00:00')).toEqual({ hour: 0, minute: 0 });
  });

  it('rejects anything else', () => {
    for (const v of ['', '24:00', '12:60', '9:5', '0900', 'noon', '-1:00']) {
      expect(parseClock(v)).toBeNull();
    }
    expect(parseClock(null)).toBeNull();
    expect(parseClock(undefined)).toBeNull();
  });
});

describe('formatClock', () => {
  it('zero-pads', () => {
    expect(formatClock(7, 3)).toBe('07:03');
    expect(formatClock(18, 30)).toBe('18:30');
  });
});

describe('options', () => {
  it('lists 24 hours', () => {
    const hours = hourOptions();
    expect(hours).toHaveLength(24);
    expect(hours[0]).toBe('00');
    expect(hours[23]).toBe('23');
  });

  it('lists minutes on the grid', () => {
    expect(minuteOptions(15)).toEqual(['00', '15', '30', '45']);
    expect(minuteOptions()).toHaveLength(12);
  });

  it('keeps an off-grid current minute, in order', () => {
    expect(minuteOptions(15, 7)).toEqual(['00', '07', '15', '30', '45']);
    expect(minuteOptions(15, 30)).toEqual(['00', '15', '30', '45']);
  });

  it('ignores a bad step or current value', () => {
    expect(minuteOptions(0)).toHaveLength(12);
    expect(minuteOptions(15, 75)).toEqual(['00', '15', '30', '45']);
  });
});
