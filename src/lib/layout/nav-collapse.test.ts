import { describe, expect, it } from 'vitest';

import {
  activeGroupId,
  isGroupOpen,
  navCollapseKey,
  parseCollapsed,
  readCollapsed,
  toggleCollapsed,
  writeCollapsed,
  type NavStorage,
} from './nav-collapse';

function fakeStorage(initial: Record<string, string> = {}): NavStorage {
  const data = { ...initial };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

const throwing: NavStorage = {
  getItem() {
    throw new Error('blocked');
  },
  setItem() {
    throw new Error('full');
  },
};

describe('navCollapseKey', () => {
  it('names the user so people never share folds', () => {
    expect(navCollapseKey('u1')).not.toBe(navCollapseKey('u2'));
    expect(navCollapseKey('u1')).toContain('u1');
    expect(navCollapseKey(null)).toBe(navCollapseKey(undefined));
  });
});

describe('parseCollapsed', () => {
  it('reads a list, drops junk and duplicates', () => {
    expect(parseCollapsed('["a","b","a",3,null]')).toEqual(['a', 'b']);
  });
  it.each([null, undefined, '', 'not json', '{"a":1}', '"x"', '5'])(
    'reads %j as nothing collapsed',
    (raw) => {
      expect(parseCollapsed(raw)).toEqual([]);
    }
  );
});

describe('toggleCollapsed', () => {
  it('adds then removes, without mutating', () => {
    const start = ['a'];
    expect(toggleCollapsed(start, 'b')).toEqual(['a', 'b']);
    expect(toggleCollapsed(start, 'a')).toEqual([]);
    expect(start).toEqual(['a']);
  });
});

describe('activeGroupId / isGroupOpen', () => {
  const groups = [
    { id: 'main', items: [{ href: '/dashboard' }] },
    { id: 'team', items: [{ href: '/live' }, { href: '/hr' }] },
  ];
  it('finds the group holding the active row', () => {
    expect(activeGroupId(groups, (h) => h === '/hr')).toBe('team');
    expect(activeGroupId(groups, () => false)).toBeNull();
  });
  it('keeps the active group open even when saved as collapsed', () => {
    expect(isGroupOpen('team', ['team'], 'team')).toBe(true);
    expect(isGroupOpen('team', ['team'], 'main')).toBe(false);
    expect(isGroupOpen('team', [], null)).toBe(true);
  });
});

describe('storage round trip', () => {
  it('saves and reads per user', () => {
    const s = fakeStorage();
    expect(writeCollapsed(s, 'u1', ['team'])).toBe(true);
    expect(readCollapsed(s, 'u1')).toEqual(['team']);
    expect(readCollapsed(s, 'u2')).toEqual([]);
  });
  it('survives missing or throwing storage', () => {
    expect(readCollapsed(null, 'u1')).toEqual([]);
    expect(readCollapsed(throwing, 'u1')).toEqual([]);
    expect(writeCollapsed(null, 'u1', ['a'])).toBe(false);
    expect(writeCollapsed(throwing, 'u1', ['a'])).toBe(false);
  });
  it('ignores a corrupt saved value', () => {
    const s = fakeStorage({ [navCollapseKey('u1')]: '{oops' });
    expect(readCollapsed(s, 'u1')).toEqual([]);
  });
});
