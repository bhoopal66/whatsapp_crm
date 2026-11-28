import { describe, expect, it } from 'vitest';

import {
  WALL_MAX_COLUMNS,
  filterWallMessages,
  isAtBottom,
  isWallFile,
  keepLatest,
  parseWallIds,
  pickableGroups,
  resolveWallIds,
  serializeWallIds,
  shouldAutoScroll,
  toggleWallId,
  wallStorageKey,
  wallTimeLabel,
} from './wall';

const ten = Array.from({ length: 10 }, (_, i) => `g${i + 1}`);

describe('parseWallIds', () => {
  it('trims, drops empties and repeats, keeps the order', () => {
    expect(parseWallIds(' a, b,,a ,c,')).toEqual(['a', 'b', 'c']);
  });

  it('reads nothing from a missing value', () => {
    expect(parseWallIds(null)).toEqual([]);
    expect(parseWallIds(undefined)).toEqual([]);
    expect(parseWallIds('')).toEqual([]);
  });

  it(`keeps at most ${WALL_MAX_COLUMNS}, the first ones`, () => {
    expect(WALL_MAX_COLUMNS).toBe(8);
    expect(parseWallIds(ten.join(','))).toEqual(ten.slice(0, 8));
  });

  it('drops ids the list does not hold, before the cap', () => {
    const known = new Set([
      'g2',
      'g3',
      'g4',
      'g5',
      'g6',
      'g7',
      'g8',
      'g9',
      'g10',
    ]);
    expect(parseWallIds(ten.join(','), known)).toEqual(ten.slice(1, 9));
    expect(parseWallIds('x,g2', new Set(['g2']))).toEqual(['g2']);
  });
});

describe('serializeWallIds', () => {
  it('writes the parsed form back', () => {
    expect(serializeWallIds(['a', 'b', 'a', ' '])).toBe('a,b');
    expect(serializeWallIds(ten)).toBe(ten.slice(0, 8).join(','));
    expect(parseWallIds(serializeWallIds(['x', 'y']))).toEqual(['x', 'y']);
  });
});

describe('resolveWallIds', () => {
  const known = new Set(['a', 'b', 'c']);

  it('lets the URL win when it names any id', () => {
    expect(resolveWallIds('c,a', 'b', known)).toEqual(['c', 'a']);
  });

  it('falls back to storage when the URL names none', () => {
    expect(resolveWallIds(null, 'b,zz', known)).toEqual(['b']);
    expect(resolveWallIds(' , ', 'a', known)).toEqual(['a']);
  });

  it('drops unknown URL ids silently', () => {
    expect(resolveWallIds('gone,b', null, known)).toEqual(['b']);
  });
});

describe('wallStorageKey', () => {
  it('names the workspace and the person', () => {
    expect(wallStorageKey('acc1', 'u1')).toBe('group-wall:v1:acc1:u1');
    expect(wallStorageKey('acc1', 'u1')).not.toBe(wallStorageKey('acc2', 'u1'));
    expect(wallStorageKey('acc1', 'u1')).not.toBe(wallStorageKey('acc1', 'u2'));
  });
});

describe('toggleWallId', () => {
  it('ticks and unticks', () => {
    expect(toggleWallId(['a'], 'b')).toEqual({ ids: ['a', 'b'], full: false });
    expect(toggleWallId(['a', 'b'], 'a')).toEqual({ ids: ['b'], full: false });
  });

  it('refuses a ninth column and says so', () => {
    const eight = ten.slice(0, 8);
    expect(toggleWallId(eight, 'g9')).toEqual({ ids: eight, full: true });
    expect(toggleWallId(eight, 'g1').full).toBe(false);
  });
});

describe('pickableGroups', () => {
  const groups = [
    { id: '1', name: 'CC Dubai', kind: 'group', our_role: 'member' },
    { id: '2', name: 'CC Sharjah', kind: 'group', our_role: 'left' },
    { id: '3', name: 'CC case', kind: 'submission', our_role: 'member' },
    { id: '4', name: 'Branch team', kind: 'group', our_role: 'admin' },
  ];

  it('offers groups we are in, not left or submission groups', () => {
    expect(pickableGroups(groups, '').map((g) => g.id)).toEqual(['1', '4']);
  });

  it('searches the name, ignoring case', () => {
    expect(pickableGroups(groups, ' cc ').map((g) => g.id)).toEqual(['1']);
  });
});

describe('files-only filter', () => {
  const rows = [
    { id: '1', type: 'text' },
    { id: '2', type: 'image' },
    { id: '3', type: 'document' },
    { id: '4', type: 'sticker' },
    { id: '5', type: 'location' },
    { id: '6', type: 'voice' },
  ];

  it('keeps files only', () => {
    expect(filterWallMessages(rows, 'files').map((r) => r.id)).toEqual([
      '2',
      '3',
      '6',
    ]);
    expect(isWallFile({ type: null })).toBe(false);
  });

  it('keeps everything for all messages', () => {
    expect(filterWallMessages(rows, 'all')).toEqual(rows);
  });
});

describe('keepLatest', () => {
  it('keeps the newest, oldest first', () => {
    expect(keepLatest([1, 2, 3, 4], 2)).toEqual([3, 4]);
    expect(keepLatest([1, 2], 5)).toEqual([1, 2]);
    expect(keepLatest(Array.from({ length: 40 }, (_, i) => i))).toHaveLength(
      30
    );
  });
});

describe('wallTimeLabel', () => {
  const now = new Date('2026-11-28T10:00:00Z');

  it('shows only the time for today', () => {
    expect(wallTimeLabel('2026-11-28T08:05:00Z', now, 'en-GB', 'UTC')).toEqual({
      time: '08:05',
      day: null,
    });
  });

  it('adds a day label for another day', () => {
    expect(wallTimeLabel('2026-11-27T21:30:00Z', now, 'en-GB', 'UTC')).toEqual({
      time: '21:30',
      day: '27 Nov',
    });
  });

  it('judges today in the given time zone', () => {
    // 21:30 UTC on the 27th is 01:30 on the 28th in Dubai.
    expect(
      wallTimeLabel('2026-11-27T21:30:00Z', now, 'en-GB', 'Asia/Dubai')
    ).toEqual({ time: '01:30', day: null });
  });

  it('names the year of an older year', () => {
    expect(
      wallTimeLabel('2025-12-31T12:00:00Z', now, 'en-GB', 'UTC')?.day
    ).toBe('31 Dec 2025');
  });

  it('reads nothing from a bad date', () => {
    expect(wallTimeLabel('nope', now, 'en-GB', 'UTC')).toBeNull();
    expect(wallTimeLabel(null, now, 'en-GB')).toBeNull();
  });
});

describe('auto-scroll', () => {
  it('is at the bottom within the slack', () => {
    expect(
      isAtBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 380 })
    ).toBe(true);
    expect(
      isAtBottom({ scrollHeight: 1000, scrollTop: 300, clientHeight: 380 })
    ).toBe(false);
  });

  it('follows new rows only from the bottom, and on the first fill', () => {
    expect(shouldAutoScroll({ firstFill: false, wasAtBottom: true })).toBe(
      true
    );
    expect(shouldAutoScroll({ firstFill: false, wasAtBottom: false })).toBe(
      false
    );
    expect(shouldAutoScroll({ firstFill: true, wasAtBottom: false })).toBe(
      true
    );
  });
});
