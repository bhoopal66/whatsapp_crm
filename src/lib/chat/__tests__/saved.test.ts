import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { ChatError } from '../errors';
import {
  countSaved,
  emitSavedChange,
  isSavedPath,
  listSaved,
  onSavedChange,
  SAVED_LIMIT,
  SAVED_SELECT,
  savedHref,
  savedTombstone,
  toSavedItem,
} from '../saved';

const WS = 'a0000000-0000-4000-8000-00000000000a';
const CH = 'c0000000-0000-4000-8000-000000000001';
const M = 'e0000000-0000-4000-8000-00000000000e';
const ROOT = 'e0000000-0000-4000-8000-0000000000aa';

type Result = { data?: unknown; count?: number | null; error: unknown };

function fakeSb(result: Result) {
  const chain: { op: string; args: unknown[] }[] = [];
  const b: Record<string, unknown> = {
    then: (res: (r: Result) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej),
  };
  for (const op of ['select', 'eq', 'order', 'limit'])
    b[op] = (...args: unknown[]) => (chain.push({ op, args }), b);
  const sb = {
    from: (table: string) => (chain.push({ op: 'from', args: [table] }), b),
  } as unknown as SupabaseClient;
  return { sb, chain };
}

const messageRow = (over: Record<string, unknown> = {}) => ({
  id: M,
  channel_id: CH,
  account_id: WS,
  thread_root_id: null,
  author_kind: 'user',
  author_id: 'u1',
  body: 'hi @[Sara](u2)',
  meta: {},
  created_at: '2026-10-01T10:00:00Z',
  edited_at: null,
  deleted_at: null,
  erased_at: null,
  channel: { id: CH, account_id: WS, kind: 'team', name: 'credit-review' },
  ...over,
});

describe('listSaved', () => {
  it('reads the workspace’s saves, newest first, with message and channel', async () => {
    const { sb, chain } = fakeSb({
      data: [
        {
          message_id: M,
          saved_at: '2026-10-02T09:00:00Z',
          message: messageRow(),
        },
      ],
      error: null,
    });
    const items = await listSaved(sb, WS);
    expect(chain).toEqual([
      { op: 'from', args: ['saved_messages'] },
      { op: 'select', args: [SAVED_SELECT] },
      { op: 'eq', args: ['message.account_id', WS] },
      { op: 'order', args: ['saved_at', { ascending: false }] },
      { op: 'order', args: ['message_id', { ascending: false }] },
      { op: 'limit', args: [SAVED_LIMIT] },
    ]);
    expect(SAVED_SELECT).toContain('message:internal_messages!inner(');
    // An unnamed chat_channels embed is ambiguous (message_pins).
    expect(SAVED_SELECT).toContain(
      'channel:chat_channels!internal_messages_channel_id_fkey('
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      messageId: M,
      savedAt: '2026-10-02T09:00:00Z',
      message: { id: M, channelId: CH, body: 'hi @[Sara](u2)' },
      channel: { id: CH, kind: 'team', name: 'credit-review' },
    });
  });

  it('drops a row without its message and throws a ChatError', async () => {
    expect(toSavedItem({ message_id: M, saved_at: 'x', message: null })).toBe(
      null
    );
    expect(
      toSavedItem({
        message_id: M,
        saved_at: 'x',
        message: messageRow({ channel: null }),
      })?.channel
    ).toBeNull();
    const { sb } = fakeSb({
      data: null,
      error: { code: '42501', message: 'no' },
    });
    await expect(listSaved(sb, WS)).rejects.toBeInstanceOf(ChatError);
  });
});

describe('countSaved', () => {
  it('counts the workspace’s readable saves, head only', async () => {
    const { sb, chain } = fakeSb({ count: 4, error: null });
    await expect(countSaved(sb, WS)).resolves.toBe(4);
    expect(chain[1]).toEqual({
      op: 'select',
      args: [
        'message_id,message:internal_messages!inner(account_id)',
        { count: 'exact', head: true },
      ],
    });
    expect(chain[2]).toEqual({ op: 'eq', args: ['message.account_id', WS] });
    await expect(
      countSaved(fakeSb({ count: null, error: null }).sb, WS)
    ).resolves.toBe(0);
  });
});

describe('saved links and tombstones', () => {
  it('opens a top-level message in place and a reply in its thread', () => {
    expect(savedHref({ id: M, channelId: CH, threadRootId: null })).toBe(
      `/chat/${CH}?message=${M}`
    );
    expect(savedHref({ id: M, channelId: CH, threadRootId: ROOT })).toBe(
      `/chat/${CH}?thread=${ROOT}`
    );
  });

  it('tells deleted from erased', () => {
    expect(savedTombstone({ deletedAt: null, erasedAt: null })).toBeNull();
    expect(savedTombstone({ deletedAt: 'x', erasedAt: 'y' })).toBe('deleted');
    expect(savedTombstone({ deletedAt: null, erasedAt: 'y' })).toBe('erased');
  });

  it('knows the Saved path', () => {
    expect(isSavedPath('/chat/saved')).toBe(true);
    expect(isSavedPath('/chat/saved-x')).toBe(false);
    expect(isSavedPath(null)).toBe(false);
  });

  it('notifies listeners until they unsubscribe', () => {
    const fn = vi.fn();
    const off = onSavedChange(fn);
    emitSavedChange();
    off();
    emitSavedChange();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
