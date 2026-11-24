import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import en from '../../../messages/en.json';

vi.mock('./chat-context', () => ({
  useChatWorkspaceContext: () => ({ channels: [] }),
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
vi.mock('@/hooks/use-thread', () => ({
  useThread: () => ({ view, store: {} }),
}));

import { openThread, type ThreadView } from '@/lib/chat/thread';

import { ThreadPanel } from './thread-panel';

const message = (id: string) =>
  ({ id, deletedAt: null, thread: null }) as never;

function render(p: Partial<ThreadView> & { hasMoreOlder?: boolean }) {
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
      <ThreadPanel channelId="c" rootId="root" onClose={() => {}} />
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
