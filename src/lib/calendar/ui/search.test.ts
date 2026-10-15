import { describe, expect, it } from 'vitest';

import { itemKey } from './item-time';
import { itemMatches, nextMatch, searchMatches } from './search';
import { aMeeting, aTask, anEvent } from './test-items';

const Z = 'Asia/Dubai';

describe('itemMatches', () => {
  it('matches title or location, ignoring case and spaces', () => {
    expect(
      itemMatches(anEvent({ title: 'Quarterly Review' }), '  review ')
    ).toBe(true);
    expect(itemMatches(anEvent({ location: 'Room 4B' }), 'room 4b')).toBe(true);
    expect(itemMatches(aMeeting({ title: 'Standup' }), 'room')).toBe(false);
    expect(itemMatches(anEvent(), '   ')).toBe(false);
  });
});

describe('searchMatches and nextMatch', () => {
  const a = anEvent({
    id: 'a',
    title: 'Deal A',
    start: '2026-10-14T06:00:00Z',
  });
  const b = aTask({
    id: 'b',
    title: 'Deal B',
    start: '2026-10-16',
    end: '2026-10-17',
  });
  const c = aMeeting({
    id: 'c',
    title: 'Deal C',
    start: '2026-10-15T08:00:00Z',
  });
  const other = anEvent({ id: 'x', title: 'Lunch' });
  const matches = searchMatches([b, other, c, a], 'deal', Z);

  it('orders matches by start', () => {
    expect(matches.map((m) => m.id)).toEqual(['a', 'c', 'b']);
  });

  it('starts at the first match on or after the cursor date', () => {
    expect(
      nextMatch(matches, null, Date.parse('2026-10-15T00:00:00Z'), Z)?.id
    ).toBe('c');
    expect(
      nextMatch(matches, null, Date.parse('2027-01-01T00:00:00Z'), Z)?.id
    ).toBe('a');
  });

  it('steps on from the current match and wraps', () => {
    expect(nextMatch(matches, itemKey(a), 0, Z)?.id).toBe('c');
    expect(nextMatch(matches, itemKey(b), 0, Z)?.id).toBe('a');
    expect(nextMatch([], null, 0, Z)).toBeNull();
  });
});
