import { describe, expect, it } from 'vitest';

import {
  EMPTY_CHAT_LOG,
  keptScrollTop,
  withFreshPage,
  withOlderPage,
  type SgChatLog,
} from './chat-log';
import type { SgMessage } from './ui';

const rows = (from: number, to: number, body = 'x') =>
  Array.from(
    { length: to - from + 1 },
    (_, i) => ({ id: String(from + i), body }) as SgMessage
  );
const page = (from: number, to: number, cursor: string | null, body = 'x') => ({
  messages: rows(from, to, body),
  older_cursor: cursor,
});
const log = (from: number, to: number, cursor: string | null): SgChatLog => ({
  messages: rows(from, to),
  olderCursor: cursor,
});
const ids = (l: SgChatLog) => l.messages.map((m) => Number(m.id));
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('withFreshPage', () => {
  it('is the page on a first load', () => {
    expect(withFreshPage(EMPTY_CHAT_LOG, page(8, 12, 'c8'))).toEqual(
      log(8, 12, 'c8')
    );
  });

  it('keeps the older pages the reader loaded, and where they end', () => {
    const l = withFreshPage(log(3, 12, 'c3'), page(9, 13, 'c9', 'new'));
    expect(ids(l)).toEqual(range(3, 13));
    expect(l.olderCursor).toBe('c3');
    // The page's copy of a row wins: a status update re-reads the chat.
    expect(l.messages.find((m) => m.id === '9')?.body).toBe('new');
    // The start of the chat stays reached.
    expect(
      withFreshPage(log(1, 12, null), page(9, 13, 'c9')).olderCursor
    ).toBeNull();
  });

  it('keeps the database order of ids of different lengths', () => {
    expect(ids(withFreshPage(log(7, 11, 'c7'), page(9, 12, 'c9')))).toEqual(
      range(7, 12)
    );
  });

  it('replaces what is held when messages are missing in between', () => {
    expect(withFreshPage(log(1, 12, null), page(20, 24, 'c20'))).toEqual(
      log(20, 24, 'c20')
    );
  });

  it('drops a message that is gone from the page', () => {
    const held = log(3, 12, 'c3');
    const fresh = page(9, 13, 'c9');
    fresh.messages = fresh.messages.filter((m) => m.id !== '11');
    expect(ids(withFreshPage(held, fresh))).not.toContain(11);
  });

  it('is the page when the page is the whole chat', () => {
    expect(withFreshPage(log(1, 3, 'c1'), page(2, 4, null))).toEqual(
      log(2, 4, null)
    );
  });

  it('keeps nothing once the group ended', () => {
    expect(
      withFreshPage(log(1, 12, 'c1'), { messages: [], older_cursor: null })
    ).toEqual(EMPTY_CHAT_LOG);
  });
});

describe('withOlderPage', () => {
  it('goes in above what is held', () => {
    const l = withOlderPage(log(8, 12, 'c8'), 'c8', page(3, 7, 'c3'));
    expect(ids(l)).toEqual(range(3, 12));
    expect(l.olderCursor).toBe('c3');
  });

  it('still joins when a live refresh landed during the read', () => {
    const held = withFreshPage(log(8, 12, 'c8'), page(10, 13, 'c10'));
    expect(ids(withOlderPage(held, 'c8', page(3, 7, 'c3')))).toEqual(
      range(3, 13)
    );
  });

  it('is left out when the log was replaced during the read', () => {
    const held = withFreshPage(log(8, 12, 'c8'), page(20, 24, 'c20'));
    expect(withOlderPage(held, 'c8', page(3, 7, 'c3'))).toBe(held);
  });
});

describe('keptScrollTop', () => {
  it('moves down by what was put in above', () => {
    expect(keptScrollTop({ top: 40, height: 1000 }, 1600)).toBe(640);
    expect(keptScrollTop({ top: 40, height: 1000 }, 1000)).toBe(40);
  });
});
