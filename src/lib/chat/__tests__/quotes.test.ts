import { describe, expect, it, vi } from 'vitest';

import { formatMention } from '../mentions';
import {
  QUOTE_PREVIEW_MAX,
  QuoteStore,
  quoteIds,
  quotePreview,
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

describe('quoteTint', () => {
  it('picks the hue of the avatar tint', () => {
    for (const id of [ANA, 'x', null])
      expect(QUOTE_TINTS.indexOf(quoteTint(id) as never)).toBe(
        AVATAR_TINTS.indexOf(avatarTint(id) as never)
      );
  });
});
