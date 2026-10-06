import { describe, expect, it } from 'vitest';

import { formatMinutes, hourLabel, percent, splitMinutes } from './format';

const unit = (u: 'd' | 'h' | 'm', n: number) => `${n}${u}`;

describe('formatMinutes', () => {
  it('keeps the two largest units', () => {
    expect(formatMinutes(45, unit)).toBe('45m');
    expect(formatMinutes(80, unit)).toBe('1h 20m');
    expect(formatMinutes(60, unit)).toBe('1h');
    expect(formatMinutes(3060, unit)).toBe('2d 3h');
    expect(formatMinutes(2880, unit)).toBe('2d');
  });

  it('rounds sub-minute times up to a minute and handles nothing', () => {
    expect(formatMinutes(0.4, unit)).toBe('1m');
    expect(formatMinutes(0, unit)).toBe('0m');
    expect(formatMinutes(null, unit)).toBeNull();
    expect(formatMinutes(Number.NaN, unit)).toBeNull();
  });
});

describe('helpers', () => {
  it('splits minutes', () => {
    expect(splitMinutes(1501)).toEqual({ d: 1, h: 1, m: 1 });
  });

  it('computes percentages', () => {
    expect(percent(1, 3)).toBe(33);
    expect(percent(1, 0)).toBeNull();
  });

  it('labels hours', () => {
    expect(hourLabel(7)).toBe('07:00');
    expect(hourLabel(22)).toBe('22:00');
  });
});
