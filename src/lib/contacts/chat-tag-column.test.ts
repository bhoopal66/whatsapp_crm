import { describe, expect, it } from 'vitest';

import type { ChatTag } from '@/types';
import { buildChatTagTree } from '@/lib/chat-tags/tree';
import {
  CONTACT_ID_CHUNK,
  chatTagFilterChip,
  chatTagsByContact,
  chunkIds,
  contactChatTagChip,
  pageOfContactIds,
} from './chat-tag-column';

function tag(id: string, over: Partial<ChatTag> = {}): ChatTag {
  return {
    id,
    account_id: 'acc',
    parent_id: null,
    name: id,
    color: '#3b82f6',
    sub_tag_title: null,
    position: 0,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    ...over,
  };
}

const tree = buildChatTagTree([
  tag('int', { name: 'Interested customer', color: '#22c55e' }),
  tag('adcb', { name: 'ADCB', parent_id: 'int', color: '#ef4444' }),
  tag('new', { name: 'New customer', position: 1 }),
]);

describe('chunkIds', () => {
  it('splits into chunks of at most the size, keeping order', () => {
    expect(chunkIds(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e'],
    ]);
  });

  it('defaults to 200 ids per chunk', () => {
    const ids = Array.from({ length: 401 }, (_, i) => String(i));
    const chunks = chunkIds(ids);
    expect(CONTACT_ID_CHUNK).toBe(200);
    expect(chunks.map((c) => c.length)).toEqual([200, 200, 1]);
    expect(chunks.flat()).toEqual(ids);
  });

  it('returns no chunks for no ids and refuses a size below one', () => {
    expect(chunkIds([])).toEqual([]);
    expect(() => chunkIds(['a'], 0)).toThrow(RangeError);
  });
});

describe('chatTagsByContact', () => {
  it('keeps the first tagged conversation per contact', () => {
    const map = chatTagsByContact([
      { contact_id: 'c1', chat_tag_id: null, chat_sub_tag_id: null },
      { contact_id: 'c1', chat_tag_id: 'int', chat_sub_tag_id: 'adcb' },
      { contact_id: 'c1', chat_tag_id: 'new', chat_sub_tag_id: null },
      { contact_id: 'c2', chat_tag_id: null, chat_sub_tag_id: null },
    ]);
    expect(map.get('c1')).toEqual({
      chat_tag_id: 'int',
      chat_sub_tag_id: 'adcb',
    });
    expect(map.get('c2')).toEqual({
      chat_tag_id: null,
      chat_sub_tag_id: null,
    });
    expect(map.has('c3')).toBe(false);
  });
});

describe('contactChatTagChip', () => {
  it('labels main · sub in the main tag colour', () => {
    expect(
      contactChatTagChip({ chat_tag_id: 'int', chat_sub_tag_id: 'adcb' }, tree)
    ).toEqual({ label: 'Interested customer · ADCB', color: '#22c55e' });
  });

  it('labels a main tag alone', () => {
    expect(
      contactChatTagChip({ chat_tag_id: 'new', chat_sub_tag_id: null }, tree)
    ).toEqual({ label: 'New customer', color: '#3b82f6' });
  });

  it('is null with no tag, no conversation, or an unknown id', () => {
    expect(
      contactChatTagChip({ chat_tag_id: null, chat_sub_tag_id: null }, tree)
    ).toBeNull();
    expect(contactChatTagChip(undefined, tree)).toBeNull();
    expect(
      contactChatTagChip({ chat_tag_id: 'gone', chat_sub_tag_id: null }, tree)
    ).toBeNull();
  });
});

describe('chatTagFilterChip', () => {
  it('names a main tag, and a sub-tag with its main tag', () => {
    expect(chatTagFilterChip('int', tree)).toEqual({
      label: 'Interested customer',
      color: '#22c55e',
    });
    expect(chatTagFilterChip('adcb', tree)).toEqual({
      label: 'Interested customer · ADCB',
      color: '#ef4444',
    });
    expect(chatTagFilterChip('gone', tree)).toBeNull();
  });
});

describe('pageOfContactIds', () => {
  const rows = [
    { id: 'a', created_at: '2026-10-01T00:00:00+00:00' },
    { id: 'b', created_at: '2026-10-03T00:00:00+00:00' },
    { id: 'c', created_at: '2026-10-02T00:00:00+00:00' },
    { id: 'd', created_at: '2026-10-02T00:00:00+00:00' },
  ];

  it('pages newest first, ties broken by id, with the full total', () => {
    expect(pageOfContactIds(rows, 0, 2)).toEqual({ ids: ['b', 'd'], total: 4 });
    expect(pageOfContactIds(rows, 2, 2)).toEqual({ ids: ['c', 'a'], total: 4 });
    expect(pageOfContactIds(rows, 4, 2)).toEqual({ ids: [], total: 4 });
  });
});
