import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import en from '../../../messages/en.json';
import type { MarkReadInput } from '@/hooks/use-mark-read';

const isFresh = () => false;
const timeline = {
  messages: [
    { id: 'm1', createdAt: '2026-11-24T10:00:00+00:00' },
    { id: 'm2', createdAt: '2026-11-24T10:01:00+00:00' },
  ],
  loading: false,
  isFresh,
  pageMark: 7,
};
const membership = { lastReadAt: null, joinedAt: '2026-11-01T00:00:00+00:00' };
vi.mock('./chat-context', () => ({
  useChatWorkspaceContext: () => ({
    channels: [{ id: 'c', kind: 'team', name: 'c', membership }],
    userId: 'u1',
    peopleById: new Map(),
  }),
}));
vi.mock('@/hooks/use-channel-timeline', () => ({
  useChannelTimeline: () => timeline,
}));
vi.mock('@/hooks/use-channel-members', () => ({ useChannelMembers: () => [] }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({}) }));
vi.mock('./message-marks', () => ({ useMessageMarks: () => ({}) }));
vi.mock('./channel-header', () => ({ ChannelHeader: () => null }));
vi.mock('./message-timeline', () => ({ MessageTimeline: () => null }));
vi.mock('./use-write-block', () => ({ useWriteBlock: () => null }));
vi.mock('./played-by', () => ({
  useVoicePlaysValue: () => null,
  VoicePlaysProvider: (p: { children: React.ReactNode }) => p.children,
}));
vi.mock('./quotes', () => ({
  useQuoteResolver: () => () => null,
  QuoteProvider: (p: { children: React.ReactNode }) => p.children,
}));

let asked: MarkReadInput | undefined;
vi.mock('@/hooks/use-mark-read', () => ({
  useMarkRead: (_ws: unknown, input: MarkReadInput) => void (asked = input),
}));

import { ChannelView } from './channel-view';

const render = () =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <ChannelView channelId="c" />
    </NextIntlClientProvider>
  );

beforeEach(() => {
  asked = undefined;
});

describe("a channel's read mark", () => {
  it('covers its newest shown message, once this visit refreshed it', () => {
    render();
    expect(asked).toEqual({
      channelId: 'c',
      membership,
      at: timeline.messages[1].createdAt,
      ready: true,
      mayMark: isFresh,
      version: 7,
    });
  });
});
