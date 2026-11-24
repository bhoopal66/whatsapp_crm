import { createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';

import en from '../../../messages/en.json';
import type { MarkReadInput } from '@/hooks/use-mark-read';

let ws: Record<string, unknown> = { channels: [] };
vi.mock('./chat-context', () => ({ useChatWorkspaceContext: () => ws }));
let asked: MarkReadInput | undefined;
const recheck = vi.fn();
vi.mock('@/hooks/use-mark-read', () => ({
  useMarkRead: (_ws: unknown, input: MarkReadInput) => {
    asked = input;
    return recheck;
  },
}));
vi.mock('./message-row', () => ({
  MessageRow: (p: { message: { id: string } }) => <p>{p.message.id}</p>,
}));
vi.mock('./composer', () => ({ Composer: () => <p>composer</p> }));
vi.mock('./typing-indicator', () => ({ TypingIndicator: () => null }));
vi.mock('./use-write-block', () => ({ useWriteBlock: () => null }));
vi.mock('./played-by', () => ({
  useVoicePlaysValue: () => null,
  VoicePlaysProvider: (p: { children: React.ReactNode }) => p.children,
}));
vi.mock('./quotes', () => ({
  useQuoteResolver: () => () => null,
  QuoteProvider: (p: { children: React.ReactNode }) => p.children,
}));
vi.mock('./reply-target', () => ({
  ReplyTargetProvider: (p: { children: React.ReactNode }) => p.children,
}));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({}) }));
vi.mock('@/hooks/use-channel-members', () => ({ useChannelMembers: () => [] }));

let view: ThreadView;
const fresh = { thread: true, unread: true };
const store = { isFresh: () => fresh.thread };
vi.mock('@/hooks/use-thread', () => ({ useThread: () => ({ view, store }) }));

import { openThread, type ThreadView } from '@/lib/chat/thread';

import { ThreadPanel } from './thread-panel';

const REPLIED_AT = '2026-11-24T10:05:00+00:00';
const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
let body = '';
const message = (id: string) =>
  ({
    id,
    body,
    createdAt: REPLIED_AT,
    authorId: 'someone',
    deletedAt: null,
    erasedAt: null,
    forwarded: null,
    thread: null,
  }) as never;
const props = { channelId: 'c', rootId: 'root', onClose: () => {} };
const Panel = () => <ThreadPanel {...props} />;

type State = Partial<ThreadView> & { hasMoreOlder?: boolean };
function render(p: State, panel: () => React.ReactNode = Panel) {
  const empty = openThread('c', 'root');
  const held = (e: ThreadView['root'], id: string) => ({
    ...e,
    timeline: {
      ...e.timeline,
      messages: p.phase === 'ready' ? [message(id)] : [],
      hasMoreOlder: p.hasMoreOlder ?? false,
    },
  });
  view = {
    ...empty,
    root: held(empty.root, 'root'),
    replies: held(empty.replies, 'reply-1'),
    ...p,
  };
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {createElement(panel)}
    </NextIntlClientProvider>
  ).replaceAll('&#x27;', "'");
}
const words = en.Chat.thread;

describe('the thread panel', () => {
  it('offers the older replies only when there are some', () => {
    expect(render({ phase: 'ready' })).not.toContain(words.loadOlder);
    const html = render({ phase: 'ready', hasMoreOlder: true });
    expect(html.indexOf(words.loadOlder)).toBeGreaterThan(0);
    expect(html.indexOf(words.loadOlder)).toBeLessThan(html.indexOf('reply-1'));
  });

  it('cannot be pressed twice', () => {
    const html = render({
      phase: 'ready',
      hasMoreOlder: true,
      loadingOlder: true,
    });
    expect(html).toContain(words.loadingOlder);
    expect(html).toMatch(/<button[^>]* disabled=""/);
  });

  it('a failed first read is not a message that is gone', () => {
    const html = render({ phase: 'failed' });
    expect(html).toContain(en.Chat.timeline.loadFailed);
    expect(html).toContain(en.Chat.retry);
    expect(html).not.toContain(words.gone);
  });

  it('loading, gone and ready are told apart', () => {
    expect(render({ phase: 'loading' })).toContain(words.loading);
    const gone = openThread('c', 'root');
    expect(
      render({ phase: 'ready', root: gone.root, replies: gone.replies })
    ).toContain(words.gone);
    expect(render({ phase: 'ready' })).toContain('composer');
  });
});

describe("a thread's read mark", () => {
  const membership = { lastReadAt: null };
  const workspace = (unread: unknown) => ({
    channels: [{ id: 'c', kind: 'team', name: 'c', membership }],
    peopleById: new Map(),
    userId: ME,
    unread,
    isUnreadFresh: () => fresh.unread,
  });
  afterEach(() => {
    ws = { channels: [] };
    body = '';
    Object.assign(fresh, { thread: true, unread: true });
  });
  type Scroll = (e: { currentTarget: object }) => void;
  type Scroller = { onScroll: Scroll; ref: { current: unknown } };
  const scroller = (node: ReactNode): Scroller | undefined => {
    if (Array.isArray(node)) return node.map(scroller).find(Boolean);
    if (!isValidElement(node)) return undefined;
    const p = node.props as Partial<Scroller> & { children?: ReactNode };
    return p.onScroll ? (p as Scroller) : scroller(p.children);
  };
  const list = (scrollTop: number) => ({
    scrollTop,
    scrollHeight: 1000,
    clientHeight: 400,
  });
  /** Whether the mark may move, with the list scrolled there. */
  function mayMark(unread: unknown, scrollTop = 600) {
    let tree: ReactNode = null;
    const Probe = () => {
      tree = ThreadPanel(props);
      return null;
    };
    ws = workspace(unread);
    render({ phase: 'ready' }, Probe);
    scroller(tree)!.ref.current = list(scrollTop);
    return asked!.mayMark();
  }
  const counts = (unread: number, mentions: number) => [
    { channelId: 'c', unread, mentions },
  ];

  it('covers the newest reply', () => {
    ws = workspace(counts(0, 0));
    render({ phase: 'ready' });
    expect(asked).toMatchObject({
      channelId: 'c',
      membership,
      at: REPLIED_AT,
      ready: true,
    });
    // The list is not on screen, so its end is not either.
    expect(asked?.mayMark()).toBe(false);

    render({ phase: 'loading' });
    expect(asked?.ready).toBe(false);
  });

  it('moves at its end, once nothing else in the channel is unread', () => {
    expect(mayMark(counts(0, 0))).toBe(true);
    expect(mayMark(counts(0, 0), 300)).toBe(false);
    expect(mayMark(counts(1, 0))).toBe(false);
    expect(mayMark([])).toBe(false);
    expect(mayMark(undefined)).toBe(false);
  });

  it("does not clear another thread's mention", () => {
    expect(mayMark(counts(0, 1))).toBe(false);
    body = `<@${ME}> see here`;
    expect(mayMark(counts(0, 1))).toBe(true);
    expect(mayMark(counts(0, 2))).toBe(false);
  });

  it('waits for a page and counts read since the gap', () => {
    fresh.thread = false;
    expect(mayMark(counts(0, 0))).toBe(false);
    Object.assign(fresh, { thread: true, unread: false });
    expect(mayMark(counts(0, 0))).toBe(false);
  });

  it('is asked again when the list is scrolled to its end', () => {
    let tree: ReactNode = null;
    const Probe = () => {
      tree = ThreadPanel(props);
      return null;
    };
    render({ phase: 'ready' }, Probe);
    const scrollTo = (scrollTop: number) =>
      scroller(tree)?.onScroll({ currentTarget: list(scrollTop) });
    scrollTo(300);
    expect(recheck).not.toHaveBeenCalled();
    scrollTo(600);
    expect(recheck).toHaveBeenCalledTimes(1);
  });
});
