import { describe, expect, it } from 'vitest';

import {
  isPartialList,
  isWholeSync,
  keepSubmissionRows,
  parseGroupList,
  parseSyncProblems,
} from './ui';

const rows = (...list: Array<[string, string, string]>) =>
  parseGroupList({
    groups: list.map(([id, kind, at]) => ({ id, kind, last_message_at: at })),
  });

describe('a partial list', () => {
  const prev = rows(['s', 'submission', '2026-01-02'], ['old', 'group', '']);
  const next = rows(['a', 'group', '2026-01-03'], ['b', 'group', '2026-01-01']);

  it('keeps the submission rows on screen, by activity', () => {
    expect(isPartialList({ partial: true })).toBe(true);
    expect(keepSubmissionRows(prev, next, true).map((g) => g.id)).toEqual([
      'a',
      's',
      'b',
    ]);
  });

  it('replaces everything when the read was whole', () => {
    expect(isPartialList({})).toBe(false);
    expect(keepSubmissionRows(prev, next, false).map((g) => g.id)).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('what a sync missed', () => {
  const whole = (json: unknown) => isWholeSync(parseSyncProblems(json));

  it('is nothing when every number was read and saved', () => {
    expect(whole({ failedNumbers: [], failedGroups: 0 })).toBe(true);
    expect(whole({ truncated: false })).toBe(true);
  });

  it.each([
    { failedNumbers: ['Sales'] },
    { failedGroups: 1 },
    { truncated: true },
    { truncated: true, incomplete: true },
    null,
  ])('is something for %j', (json) => {
    expect(whole(json)).toBe(false);
  });

  it('says an incomplete list once', () => {
    expect(
      parseSyncProblems({ truncated: true, incomplete: true })
    ).toMatchObject({ incomplete: true, truncated: false });
  });
});
