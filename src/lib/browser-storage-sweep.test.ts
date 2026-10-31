import { describe, expect, it } from 'vitest';

import {
  recentDialsKey,
  sweepPerUserBrowserStorage,
} from './browser-storage-sweep';
import { draftStorageKey } from './chat/composer';

function fakeStorage(init: Record<string, string>) {
  const m = new Map(Object.entries(init));
  return {
    m,
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
  };
}

describe('browser storage sweep', () => {
  it('removes drafts (old and new keys) and recent dials, keeps the rest', () => {
    const s = fakeStorage({
      'wacrm.chat.draft.ab': '1',
      [draftStorageKey('U1', 'c1', 't1')]: '2',
      'pbx:recent-dials': '3',
      [recentDialsKey('a1', 'u1')]: '4',
      theme: 'dark',
    });
    sweepPerUserBrowserStorage(s);
    expect([...s.m.keys()]).toEqual(['theme']);
  });

  it('never throws when storage does', () => {
    const bad = {
      length: 1,
      key: () => {
        throw new Error('blocked');
      },
      removeItem: () => {},
    };
    expect(() => sweepPerUserBrowserStorage(bad)).not.toThrow();
  });

  it('keys differ per user and account', () => {
    expect(draftStorageKey('A', 'c')).not.toBe(draftStorageKey('B', 'c'));
    expect(recentDialsKey('a', 'u1')).not.toBe(recentDialsKey('a', 'u2'));
    expect(recentDialsKey('a', 'u')).not.toBe(recentDialsKey('b', 'u'));
  });
});
