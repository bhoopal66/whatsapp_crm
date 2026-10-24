import { describe, expect, it } from 'vitest';

import type { ChatTag } from '@/types';
import { buildChatTagTree } from '@/lib/chat-tags/tree';
import {
  CONTACT_ID_CHUNK,
  assigneesByContact,
  chatTagFilterChip,
  chatTagsByContact,
  chunkIds,
  contactChatTagChip,
  mapWithConcurrency,
  pageOfContactIds,
  readAllPages,
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

describe('assigneesByContact', () => {
  it('keeps the first assigned conversation per contact', () => {
    const map = assigneesByContact([
      { contact_id: 'c1', assigned_agent_id: null },
      { contact_id: 'c1', assigned_agent_id: 'u1' },
      { contact_id: 'c1', assigned_agent_id: 'u2' },
      { contact_id: 'c2', assigned_agent_id: null },
    ]);
    expect(map.get('c1')).toBe('u1');
    expect(map.has('c2')).toBe(false);
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

describe('readAllPages', () => {
  /** A table of `total` rows behind a PostgREST that caps responses. */
  function table(total: number, maxRows: number) {
    const rows = Array.from({ length: total }, (_, i) => ({ id: i }));
    const calls: [number, number][] = [];
    const fetchPage = async (from: number, to: number) => {
      calls.push([from, to]);
      const end = Math.min(to + 1, from + maxRows);
      return { data: rows.slice(from, end), error: null };
    };
    return { rows, calls, fetchPage };
  }

  it('reads every row when max-rows caps pages below the page size', async () => {
    const { rows, calls, fetchPage } = table(1234, 500);
    const result = await readAllPages(fetchPage, 1000);
    expect(result.error).toBeNull();
    expect(result.data).toEqual(rows);
    expect(calls).toEqual([
      [0, 999],
      [500, 1499],
      [1000, 1999],
      [1234, 2233],
    ]);
  });

  it('reads full pages until an empty one', async () => {
    const { rows, calls, fetchPage } = table(2000, 1000);
    const result = await readAllPages(fetchPage, 1000);
    expect(result.data).toEqual(rows);
    expect(calls).toHaveLength(3);
  });

  it('returns no rows for an empty table, and the error of a failed page', async () => {
    expect(await readAllPages(table(0, 500).fetchPage, 1000)).toEqual({
      data: [],
      error: null,
    });
    let call = 0;
    const failing = async () =>
      call++ === 0
        ? { data: [{ id: 1 }], error: null }
        : { data: null, error: { message: 'boom' } };
    expect(await readAllPages(failing, 1000)).toEqual({
      data: null,
      error: { message: 'boom' },
    });
    await expect(readAllPages(failing, 0)).rejects.toThrow(RangeError);
  });
});

describe('mapWithConcurrency', () => {
  it('keeps at most `limit` calls in flight and the results in order', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 11 }, (_, i) => i);
    const results = await mapWithConcurrency(items, 4, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Later items finish first, so order comes from the index.
      await new Promise((r) => setTimeout(r, (11 - n) % 3));
      inFlight--;
      return n * 10;
    });
    expect(results).toEqual(items.map((n) => n * 10));
    expect(peak).toBe(4);
  });

  it('handles no items, and rejects when a call does', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
    await expect(
      mapWithConcurrency([1, 2], 4, async (n) => {
        if (n === 2) throw new Error('nope');
        return n;
      })
    ).rejects.toThrow('nope');
    await expect(mapWithConcurrency([1], 0, async (n) => n)).rejects.toThrow(
      RangeError
    );
  });
});
