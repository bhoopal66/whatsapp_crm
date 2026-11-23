import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import type { Message } from '@/types';
import {
  parkIfFree,
  type ParkedDrafts,
} from '@/lib/insights/compose-check-flow';
import { createFailedSendStore } from './failed-send-store';
import {
  answeredSendKind,
  arrivedSends,
  canRetry,
  copyableText,
  failedSendPlace,
  newestSavedAt,
  ownsUpload,
  thrownSendKind,
  type FailedSend,
} from './failed-send';
import { nextTempId } from './optimistic';

const at = '2026-11-23T09:00:00.000Z';
const maybe: FailedSend = {
  conversationId: 'conv-1',
  kind: 'maybe',
  reason: 'x',
  sentAfter: at,
  restoreText: 'ok',
  body: {},
  message: {
    id: 'temp-1',
    conversation_id: 'conv-1',
    sender_type: 'agent',
    content_type: 'text',
    content_text: 'ok',
    status: 'failed',
    created_at: at,
  } as Message,
};
const row = (over: Partial<Message> = {}): Message => ({
  ...maybe.message,
  id: 'm-1',
  sender_id: 'me',
  status: 'sent',
  created_at: '2026-11-23T09:00:05.000Z',
  ...over,
});

describe('a send that did not certainly succeed', () => {
  it('names the kind of an answer', () => {
    const error = 'x';
    expect(answeredSendKind(502, { error, retryable: true })).toBe('refused');
    expect(answeredSendKind(502, { error })).toBe('maybe');
    expect(answeredSendKind(504, null)).toBe('maybe');
    expect(answeredSendKind(500, { error, code: 'db_error' })).toBe('maybe');
    expect(answeredSendKind(413, null)).toBe('final');
    expect(answeredSendKind(409, { error, code: 'opted_out' })).toBe('barred');
  });

  it('is certain of a thrown fetch only while offline throughout', () => {
    expect(thrownSendKind(true, true)).toBe('offline');
    expect(thrownSendKind(false, true)).toBe('maybe');
    expect(thrownSendKind(true, false)).toBe('maybe');
  });

  it('offers Retry, Copy and the upload delete by kind', () => {
    expect((['refused', 'offline'] as const).every(canRetry)).toBe(true);
    expect((['maybe', 'final', 'barred'] as const).some(canRetry)).toBe(false);
    expect(ownsUpload('maybe')).toBe(false);
    expect(ownsUpload('offline')).toBe(true);
    expect(copyableText(maybe)).toBe('ok');
    expect(copyableText({ ...maybe, kind: 'barred' })).toBeNull();
  });

  it('puts the words back where they are looked for', () => {
    const refused = { ...maybe, kind: 'refused' as const };
    const here = { leftInbox: false, openConversationId: 'conv-1' };
    const gone = { ...here, leftInbox: true };
    expect(failedSendPlace(refused, here)).toBe('composer');
    expect(
      failedSendPlace(refused, { ...here, openConversationId: 'conv-2' })
    ).toBe('row');
    expect(failedSendPlace(refused, gone)).toBe('parked');
    expect(failedSendPlace({ ...maybe, kind: 'offline' }, gone)).toBe('parked');
    expect(failedSendPlace(maybe, gone)).toBe('row');
  });

  it('parks only where no newer draft is', () => {
    const stash: ParkedDrafts = new Map();
    const draft = { text: 'a', reply: null, origin: null, attachment: null };
    expect(parkIfFree(stash, 'c', draft)).toBe(true);
    expect(parkIfFree(stash, 'c', { ...draft, text: 'b' })).toBe(false);
    expect(stash.get('c')?.text).toBe('a');
  });

  it('gives two sends of one millisecond their own ids', () => {
    expect(nextTempId(5)).not.toBe(nextTempId(5));
    expect(nextTempId(5)).toMatch(/^temp-5-/);
  });
});

describe('arrivedSends', () => {
  it('settles the row whose message showed up', () => {
    expect(arrivedSends([maybe], [row()], 'me')).toEqual([maybe]);
    expect(arrivedSends([maybe], [], 'me')).toEqual([]);
  });

  it('not with an older, a colleague’s or a different message', () => {
    for (const other of [
      row({ created_at: at }),
      row({ sender_id: 'other' }),
      row({ content_text: 'okay' }),
      row({ conversation_id: 'conv-2' }),
      row({ id: 'temp-9' }),
    ]) {
      expect(arrivedSends([maybe], [other], 'me')).toEqual([]);
    }
  });

  it('one message settles one row, and never a certain refusal', () => {
    expect(arrivedSends([maybe, { ...maybe }], [row()], 'me')).toHaveLength(1);
    const refused = { ...maybe, kind: 'refused' as const };
    expect(arrivedSends([refused], [row()], 'me')).toEqual([]);
  });

  it('without a watermark allows for a fast device clock only', () => {
    const blind = { ...maybe, sentAfter: null };
    const ago = (s: number) =>
      row({ created_at: new Date(Date.parse(at) - s * 1000).toISOString() });
    expect(arrivedSends([blind], [ago(60)], 'me')).toHaveLength(1);
    expect(arrivedSends([blind], [ago(86_400)], 'me')).toEqual([]);
  });

  it('takes the watermark from the saved messages of the chat', () => {
    const later = '2026-11-23T10:00:00.000Z';
    const list = [
      row({ created_at: at }),
      row({ id: 'temp-1', created_at: later }),
      row({ conversation_id: 'x', created_at: later }),
    ];
    expect(newestSavedAt(list, 'conv-1')).toBe(at);
  });
});

describe('createFailedSendStore', () => {
  it('keeps rows after the inbox is left, for the same login only', () => {
    const store = createFailedSendStore();
    store.claim('me');
    const heard = vi.fn();
    store.subscribe(heard);
    const leave = store.enter();
    expect(store.left()).toBe(false);
    leave();
    expect(store.left()).toBe(true);
    expect(store.add('me', maybe)).toBe(true);
    expect(store.claim('me')).toEqual([]);
    expect(store.get()).toEqual([maybe]);
    expect(store.claim('other')).toEqual([maybe]);
    expect(store.get()).toEqual([]);
    expect(store.add('me', maybe)).toBe(false);
    expect(heard).toHaveBeenCalledTimes(2);
  });
});

// The thread cannot mount here, so its wiring is pinned in the source.
describe('the thread', () => {
  const source = readFileSync(
    'src/components/inbox/message-thread.tsx',
    'utf8'
  );

  it('keeps every failed send, thrown or answered', () => {
    expect(source).toContain('keep(kind, reason)');
    expect(source).toContain('keep(answeredSendKind(res.status, payload)');
    expect(source).not.toContain('`temp-${');
  });

  it('draws no empty chat and no notices from a read that failed', () => {
    expect(source).toContain('loadFailed(prev, conversationId)');
    expect(source).toContain("view === 'empty' ?");
    expect(source).toMatch(/if \(\s*!threadKnown \|\|/);
    expect(source).toContain('threadKnown && wouldStartChat');
    expect(source).toContain('setOlderFailedFor(convId)');
  });
});
