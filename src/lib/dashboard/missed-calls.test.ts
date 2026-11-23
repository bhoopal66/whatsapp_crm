import { describe, expect, it } from 'vitest';

import { missedCallCount } from './missed-calls';

describe('missedCallCount', () => {
  it.each<[string, number | undefined, boolean, number | null, number | null]>([
    ['nothing read: unknown, not none', undefined, false, null, null],
    ['no list yet: the head count', undefined, false, 3, 3],
    ['the list follows a tick at once', 2, false, 3, 2],
    ['a whole list needs no head count', 0, false, null, 0],
    ['a cut list: the head count is the floor', 1, true, 9, 9],
    ['a cut list, no head count: what it shows', 4, true, null, 4],
    ['a cut list with none, no head count: unknown', 0, true, null, null],
  ])('%s', (_name, listed, full, badge, count) => {
    expect(missedCallCount(listed, full, badge)).toBe(count);
  });
});
