import { describe, expect, it } from 'vitest';

import type { Conversation } from '@/types';

import { applyAvatars, avatarRequestBatches } from './avatars';

describe('avatarRequestBatches', () => {
  it('skips already-requested, duplicate and missing ids', () => {
    expect(
      avatarRequestBatches(
        ['a', 'b', 'a', undefined, null, 'c'],
        new Set(['b'])
      )
    ).toEqual([['a', 'c']]);
  });

  it('chunks to the batch size', () => {
    const ids = Array.from({ length: 120 }, (_, i) => `c${i}`);
    const batches = avatarRequestBatches(ids, new Set());
    expect(batches.map((b) => b.length)).toEqual([50, 50, 20]);
    expect(batches.flat()).toEqual(ids);
  });

  it('returns nothing when every id was asked already', () => {
    expect(avatarRequestBatches(['a'], new Set(['a']))).toEqual([]);
  });
});

describe('applyAvatars', () => {
  const conv = (id: string, contactId: string, avatar?: string) =>
    ({
      id,
      contact: { id: contactId, avatar_url: avatar },
    }) as unknown as Conversation;

  it('sets, replaces and clears pictures by contact id', () => {
    const list = [conv('1', 'a'), conv('2', 'b', 'old'), conv('3', 'c', 'x')];
    const next = applyAvatars(list, { a: 'new-a', b: 'new-b', c: null });
    expect(next.map((c) => c.contact?.avatar_url)).toEqual([
      'new-a',
      'new-b',
      undefined,
    ]);
  });

  it('returns the same array when nothing changed', () => {
    const list = [conv('1', 'a', 'same')];
    expect(applyAvatars(list, { a: 'same', z: 'other' })).toBe(list);
  });
});
