import { describe, expect, it, vi } from 'vitest';

import { formatMention } from '../mentions';
import {
  QUOTE_PREVIEW_MAX,
  QuoteStore,
  quoteIds,
  quotePreview,
  quoteRetryDelay,
  replyTargetAfterEvent,
} from '../quotes';
import type { ChatAttachment, ChatMessage } from '../types';
import { AVATAR_TINTS, QUOTE_TINTS, avatarTint, quoteTint } from '../view';

const ANA = '11111111-1111-4111-8111-111111111111';
const people = [{ userId: ANA, fullName: 'Ana' }];

const msg = (o: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1',
  channelId: 'c1',
  accountId: 'a1',
  threadRootId: null,
  authorKind: 'user',
  authorId: ANA,
  body: 'hello',
  meta: {},
  createdAt: '2026-10-30T09:00:00Z',
  editedAt: null,
  deletedAt: null,
  erasedAt: null,
  deletedBy: null,
  replyToId: null,
  forwarded: null,
  attachments: [],
  reactions: [],
  thread: null,
  ...o,
});

const att = (o: Partial<ChatAttachment> = {}): ChatAttachment => ({
  id: 'f1',
  messageId: 'm1',
  storagePath: 'p',
  name: 'contract.pdf',
  mime: 'application/pdf',
  bytes: 10,
  kind: 'file',
  durationMs: null,
  ...o,
});

describe('quoteIds', () => {
  it('lists distinct quoted ids that are not loaded, of live messages', () => {
    const list = [
      msg({ id: 'a', replyToId: 'old1' }),
      msg({ id: 'b', replyToId: 'a' }),
      msg({ id: 'c', replyToId: 'old1' }),
      msg({ id: 'd', replyToId: 'old2' }),
      msg({ id: 'e', replyToId: 'gone', deletedAt: 'x' }),
      msg({ id: 'f', replyToId: 'erased', erasedAt: 'x' }),
      msg({ id: 'g' }),
    ];
    expect(quoteIds(list)).toEqual(['old1', 'old2']);
    expect(quoteIds([])).toEqual([]);
  });
});

describe('quotePreview', () => {
  it('a text message: one line, markers removed, mentions as names', () => {
    const p = quotePreview(
      msg({ body: `*Hi* ${formatMention(ANA)}\n- one\n- two` }),
      people
    );
    expect(p).toEqual({
      kind: 'text',
      text: 'Hi @Ana • one • two',
      authorId: ANA,
    });
  });
  it(`clips to ${QUOTE_PREVIEW_MAX} characters`, () => {
    const p = quotePreview(msg({ body: 'x'.repeat(500) }), people);
    expect(p.text).toHaveLength(QUOTE_PREVIEW_MAX);
    expect(p.text.endsWith('…')).toBe(true);
  });
  it('a voice note: its m:ss length', () => {
    const v = msg({
      body: '🎤 Voice message (1:05)',
      attachments: [
        att({ kind: 'voice', mime: 'audio/ogg', durationMs: 65_400 }),
      ],
    });
    expect(quotePreview(v, people)).toEqual({
      kind: 'voice',
      text: '1:05',
      authorId: ANA,
    });
    // Once edited the body is someone's words.
    expect(quotePreview({ ...v, editedAt: 'x' }, people).kind).toBe('text');
  });
  it('files only: the first file name', () => {
    const f = msg({
      body: '',
      attachments: [att(), att({ id: 'f2', name: 'b.png' })],
    });
    expect(quotePreview(f, people)).toEqual({
      kind: 'file',
      text: 'contract.pdf',
      authorId: ANA,
    });
  });
  it('deleted, erased and unavailable', () => {
    expect(quotePreview(msg({ deletedAt: 'x', body: '' }), people)).toEqual({
      kind: 'deleted',
      text: '',
      authorId: ANA,
    });
    expect(
      quotePreview(
        msg({ erasedAt: 'x', deletedAt: 'x', body: '[erased]' }),
        people
      ).kind
    ).toBe('erased');
    expect(quotePreview(null, people)).toEqual({
      kind: 'unavailable',
      text: '',
      authorId: null,
    });
  });
  it('a system post: its bold markers dropped, no author', () => {
    expect(
      quotePreview(
        msg({ authorKind: 'system', authorId: null, body: '**Deal** won' }),
        people
      )
    ).toEqual({ kind: 'text', text: 'Deal won', authorId: null });
  });
});

describe('QuoteStore', () => {
  it('asks for each id at most once and remembers unavailable ones', async () => {
    const fetch = vi.fn(async (ids: string[]) =>
      ids.filter((id) => id !== 'hidden').map((id) => msg({ id }))
    );
    const store = new QuoteStore(fetch);
    expect(store.get('a')).toBeUndefined();
    expect(await store.request(['a', 'hidden', 'a'])).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(['a', 'hidden']);
    expect(store.get('a')?.id).toBe('a');
    expect(store.get('hidden')).toBeNull();

    expect(await store.request(['a', 'hidden'])).toBe(false);
    expect(await store.request(['hidden', 'b'])).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith(['b']);
    expect(store.unasked(['a', 'b', 'c'])).toEqual(['c']);
  });
  it('does not ask again while a read is in flight', async () => {
    let release: (rows: ChatMessage[]) => void = () => {};
    const fetch = vi.fn(() => new Promise<ChatMessage[]>((r) => (release = r)));
    const store = new QuoteStore(fetch);
    const first = store.request(['a']);
    expect(await store.request(['a'])).toBe(false);
    release([msg({ id: 'a' })]);
    expect(await first).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('a failed read forgets its ids so they can be asked again', async () => {
    const fetch = vi
      .fn<(ids: string[]) => Promise<ChatMessage[]>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([msg({ id: 'a' })]);
    const store = new QuoteStore(fetch);
    expect(await store.request(['a'])).toBe(false);
    expect(store.get('a')).toBeUndefined();
    expect(await store.request(['a'])).toBe(true);
    expect(store.get('a')?.id).toBe('a');
  });
});

describe('quote retries', () => {
  it('waits 1 s, 3 s, 9 s, then gives up', () => {
    expect([1, 2, 3, 4, 5].map(quoteRetryDelay)).toEqual([
      1000,
      3000,
      9000,
      null,
      null,
    ]);
  });
  it('a store retries a failing id three times, then shows it unavailable', async () => {
    const fetch = vi
      .fn<(ids: string[]) => Promise<ChatMessage[]>>()
      .mockRejectedValue(new Error('offline'));
    const store = new QuoteStore(fetch);
    const waits: (number | null)[] = [];
    for (let i = 0; i < 3; i++) {
      expect(await store.request(['a'])).toBe(false);
      expect(store.get('a')).toBeUndefined();
      waits.push(store.retryDelay(['a']));
    }
    expect(waits).toEqual([1000, 3000, 9000]);
    expect(await store.request(['a'])).toBe(true);
    expect(store.get('a')).toBeNull();
    expect(store.retryDelay(['a'])).toBeNull();
    expect(await store.request(['a'])).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it('a success resets the count', async () => {
    const fetch = vi
      .fn<(ids: string[]) => Promise<ChatMessage[]>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([msg({ id: 'a' })]);
    const store = new QuoteStore(fetch);
    await store.request(['a']);
    expect(store.retryDelay(['a'])).toBe(1000);
    expect(await store.request(['a'])).toBe(true);
    expect(store.retryDelay(['a'])).toBeNull();
  });
});

describe('QuoteStore events', () => {
  const read = async () => {
    const fetch = vi.fn(async (ids: string[]) =>
      ids.map((id) =>
        msg({ id, body: 'original', attachments: [att({ messageId: id })] })
      )
    );
    const store = new QuoteStore(fetch);
    await store.request(['a']);
    return { store, fetch };
  };

  it('patch: an edit shows, attachments kept from the read', async () => {
    const { store } = await read();
    expect(store.patch(msg({ id: 'a', body: 'edited', editedAt: 'x' }))).toBe(
      true
    );
    expect(store.get('a')?.body).toBe('edited');
    expect(store.get('a')?.attachments).toHaveLength(1);
  });
  it('patch: a removal and an erasure show', async () => {
    const { store } = await read();
    store.patch(msg({ id: 'a', deletedAt: 'x', deletedBy: ANA }));
    expect(quotePreview(store.get('a') ?? null, people).kind).toBe('deleted');
    store.patch(msg({ id: 'a', body: '[erased]', erasedAt: 'x' }));
    expect(quotePreview(store.get('a') ?? null, people).kind).toBe('erased');
  });
  it('patch: a message never read is ignored', async () => {
    const { store } = await read();
    expect(store.patch(msg({ id: 'other' }))).toBe(false);
    expect(store.get('other')).toBeUndefined();
  });
  it('invalidate: a deleted row is read again', async () => {
    const { store, fetch } = await read();
    expect(store.invalidate('a')).toBe(true);
    expect(store.get('a')).toBeUndefined();
    expect(store.unasked(['a'])).toEqual(['a']);
    fetch.mockResolvedValueOnce([]);
    expect(await store.request(['a'])).toBe(true);
    expect(store.get('a')).toBeNull();
    expect(store.invalidate('never-asked')).toBe(false);
  });
  it('a change while the read is in flight discards its stale answer', async () => {
    let release: (rows: ChatMessage[]) => void = () => {};
    const fetch = vi.fn(() => new Promise<ChatMessage[]>((r) => (release = r)));
    const store = new QuoteStore(fetch);
    const first = store.request(['a']);
    expect(store.patch(msg({ id: 'a', deletedAt: 'x' }))).toBe(false);
    release([msg({ id: 'a', body: 'original' })]);
    expect(await first).toBe(true);
    expect(store.get('a')).toBeUndefined();
    expect(store.unasked(['a'])).toEqual(['a']);
  });
});

describe('replyTargetAfterEvent', () => {
  const held = msg({ id: 'a', attachments: [att({ messageId: 'a' })] });
  it('takes an edit, a removal and an erasure of the held message', () => {
    const edited = replyTargetAfterEvent(held, {
      type: 'update',
      message: msg({ id: 'a', body: 'edited', editedAt: 'x' }),
    });
    expect(edited?.body).toBe('edited');
    expect(edited?.attachments).toHaveLength(1);
    const removed = replyTargetAfterEvent(held, {
      type: 'update',
      message: msg({ id: 'a', deletedAt: 'x' }),
    });
    expect(quotePreview(removed, people).kind).toBe('deleted');
    const erased = replyTargetAfterEvent(held, {
      type: 'update',
      message: msg({ id: 'a', erasedAt: 'x' }),
    });
    expect(quotePreview(erased, people).kind).toBe('erased');
  });
  it('drops a hard-deleted target', () => {
    expect(replyTargetAfterEvent(held, { type: 'delete', id: 'a' })).toBeNull();
  });
  it('is the same object for other messages and no target', () => {
    const other = { type: 'update', message: msg({ id: 'b' }) } as const;
    expect(replyTargetAfterEvent(held, other)).toBe(held);
    expect(replyTargetAfterEvent(held, { type: 'delete', id: 'b' })).toBe(held);
    expect(replyTargetAfterEvent(null, other)).toBeNull();
  });
});

describe('quoteTint', () => {
  it('picks the hue of the avatar tint', () => {
    for (const id of [ANA, 'x', null])
      expect(QUOTE_TINTS.indexOf(quoteTint(id) as never)).toBe(
        AVATAR_TINTS.indexOf(avatarTint(id) as never)
      );
  });
});
