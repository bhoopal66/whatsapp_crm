import { describe, expect, it } from 'vitest';

import { isOwnRemoval, parseRemovedPeople, readmitRequest } from './removed';

describe('parseRemovedPeople', () => {
  it('reads the manager-only list, skipping malformed rows', () => {
    expect(
      parseRemovedPeople({
        removed: [
          { user_id: 'u1', removed_at: '2026-10-15T08:00:00Z' },
          { user_id: 2, removed_at: 'x' },
          null,
        ],
      })
    ).toEqual([{ userId: 'u1', removedAt: '2026-10-15T08:00:00Z' }]);
  });

  it('is empty when the key is absent (not a manager)', () => {
    expect(parseRemovedPeople({ meeting: {} })).toEqual([]);
    expect(parseRemovedPeople(null)).toEqual([]);
  });
});

describe('readmitRequest', () => {
  it('targets the person, not a seat', () => {
    expect(readmitRequest('u1')).toEqual({ target: 'u1', action: 'readmit' });
  });
});

describe('isOwnRemoval', () => {
  const row = { meeting_id: 'm1', user_id: 'u1', account_id: 'a1' };

  it("is the viewer's own removal from this meeting", () => {
    expect(isOwnRemoval(row, 'u1', 'm1')).toBe(true);
  });

  it("ignores someone else's removal (a manager hears them all)", () => {
    expect(isOwnRemoval(row, 'u2', 'm1')).toBe(false);
  });

  it('ignores another meeting', () => {
    expect(isOwnRemoval(row, 'u1', 'm2')).toBe(false);
  });

  it('is false with no viewer yet or a malformed payload', () => {
    expect(isOwnRemoval(row, null, 'm1')).toBe(false);
    expect(isOwnRemoval({ meeting_id: 'm1', user_id: null }, null, 'm1')).toBe(
      false
    );
    expect(isOwnRemoval(null, 'u1', 'm1')).toBe(false);
    expect(isOwnRemoval('u1', 'u1', 'm1')).toBe(false);
    expect(isOwnRemoval({}, 'u1', 'm1')).toBe(false);
  });
});
