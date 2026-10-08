import { describe, expect, it } from 'vitest';

import { buildChatTagTree } from '@/lib/chat-tags/tree';
import type { ChatTag } from '@/types';
import { liveChatTagIds } from './chat-tag-audience';

function tag(id: string, parent_id: string | null = null): ChatTag {
  return {
    id,
    account_id: 'acc-1',
    parent_id,
    name: id,
    color: '#f59e0b',
    sub_tag_title: null,
    position: 0,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
  };
}

const TREE = buildChatTagTree([
  tag('main-a'),
  tag('main-b'),
  tag('sub-a1', 'main-a'),
  // A sub-tag whose main tag is gone: the picker does not draw it.
  tag('orphan', 'main-gone'),
]);

describe('liveChatTagIds', () => {
  it('keeps main tags and the sub-tags drawn under them', () => {
    const ids = ['main-a', 'sub-a1', 'main-b'];
    expect(liveChatTagIds(ids, TREE, true)).toBe(ids);
  });

  it('drops ids deleted meanwhile, keeping the order of the rest', () => {
    expect(liveChatTagIds(['gone', 'main-b', 'sub-a1'], TREE, true)).toEqual([
      'main-b',
      'sub-a1',
    ]);
  });

  it('drops a sub-tag the picker cannot draw', () => {
    expect(liveChatTagIds(['orphan', 'main-a'], TREE, true)).toEqual([
      'main-a',
    ]);
  });

  it('leaves nothing when every picked tag is gone', () => {
    expect(liveChatTagIds(['gone-1', 'gone-2'], TREE, true)).toEqual([]);
  });

  it('passes the ids through until the tags have loaded', () => {
    const ids = ['gone', 'main-a'];
    expect(liveChatTagIds(ids, buildChatTagTree([]), false)).toBe(ids);
  });

  it('keeps an absent list absent', () => {
    expect(liveChatTagIds(undefined, TREE, true)).toBeUndefined();
  });
});
