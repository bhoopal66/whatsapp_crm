import { describe, expect, it } from 'vitest';

import { durationParts, timingKey, timingLabel } from './timing';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

describe('durationParts', () => {
  it('uses minutes under an hour, at least one', () => {
    expect(durationParts(0)).toEqual({ unit: 'minutes', n: 1 });
    expect(durationParts(59 * MIN)).toEqual({ unit: 'minutes', n: 59 });
  });

  it('uses hours up to 48, then whole days', () => {
    expect(durationParts(HOUR)).toEqual({ unit: 'hours', n: 1 });
    expect(durationParts(2 * HOUR + 59 * MIN)).toEqual({ unit: 'hours', n: 2 });
    expect(durationParts(47 * HOUR)).toEqual({ unit: 'hours', n: 47 });
    expect(durationParts(48 * HOUR)).toEqual({ unit: 'days', n: 2 });
    expect(durationParts(80 * HOUR)).toEqual({ unit: 'days', n: 3 });
  });

  it('treats a negative or broken span as none', () => {
    expect(durationParts(-5 * HOUR)).toEqual({ unit: 'minutes', n: 1 });
    expect(durationParts(Number.NaN)).toEqual({ unit: 'minutes', n: 1 });
  });
});

describe('timingLabel', () => {
  it('reads "overdue by 2 h"', () => {
    expect(timingLabel({ state: 'overdue', at: NOW - 2 * HOUR }, NOW)).toEqual({
      state: 'overdue',
      unit: 'hours',
      n: 2,
    });
  });

  it('reads how long someone has waited', () => {
    expect(timingLabel({ state: 'waiting', at: NOW - 18 * HOUR }, NOW)).toEqual(
      { state: 'waiting', unit: 'hours', n: 18 }
    );
  });

  it('reads a due time ahead, and one already passed as overdue', () => {
    expect(timingLabel({ state: 'due_in', at: NOW + 30 * MIN }, NOW)).toEqual({
      state: 'due_in',
      unit: 'minutes',
      n: 30,
    });
    expect(timingLabel({ state: 'due_in', at: NOW - 3 * HOUR }, NOW)).toEqual({
      state: 'overdue',
      unit: 'hours',
      n: 3,
    });
  });

  it('has no label without a timing', () => {
    expect(timingLabel(null, NOW)).toBeNull();
    expect(timingLabel({ state: 'overdue', at: Number.NaN }, NOW)).toBeNull();
  });

  it('keys each state under Worklist.timing', () => {
    expect(timingKey('overdue')).toBe('timing.overdue');
    expect(timingKey('due_in')).toBe('timing.due_in');
  });
});
