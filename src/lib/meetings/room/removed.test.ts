import { describe, expect, it } from 'vitest';

import { parseRemovedPeople, readmitRequest } from './removed';

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
