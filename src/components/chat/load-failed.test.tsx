import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import en from '../../../messages/en.json';

vi.mock('./message-row', () => ({
  MessageRow: (p: { message: { id: string }; onRetryFiles?: () => void }) => (
    <p>{`${p.message.id}:${p.onRetryFiles ? 'lost' : 'whole'}`}</p>
  ),
}));

import { MessageTimeline } from './message-timeline';

const render = (state: { loading: boolean; failed: boolean }) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <MessageTimeline
        messages={[]}
        cards={{}}
        callCards={{}}
        hasMoreOlder={false}
        loadingOlder={false}
        onLoadOlder={() => {}}
        onToggleReaction={() => {}}
        onRetry={() => {}}
        {...state}
      />
    </NextIntlClientProvider>
  );

describe('a channel whose messages could not be read', () => {
  it('says so with a Retry, not that it is empty', () => {
    const html = render({ loading: true, failed: true }).replaceAll(
      '&#x27;',
      "'"
    );
    expect(html).toContain(en.Chat.timeline.loadFailed);
    expect(html).toContain(en.Chat.retry);
    expect(html).not.toContain(en.Chat.channel.empty);
  });

  it('is told apart from loading and from empty', () => {
    expect(render({ loading: true, failed: false })).toContain('aria-busy');
    expect(render({ loading: false, failed: false })).toContain(
      en.Chat.channel.empty
    );
  });
});

describe('a message whose files could not be read', () => {
  it('is offered a Retry, and no other is', () => {
    const at = { channelId: 'c', createdAt: '2026-11-24T08:00:00+00:00' };
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
        <MessageTimeline
          messages={[
            { id: 'm1', ...at } as never,
            { id: 'm2', ...at } as never,
          ]}
          cards={{}}
          callCards={{}}
          hasMoreOlder={false}
          loading={false}
          failed={false}
          loadingOlder={false}
          onLoadOlder={() => {}}
          onToggleReaction={() => {}}
          onRetry={() => {}}
          missingFiles={new Set(['m2'])}
          onRetryFiles={() => {}}
        />
      </NextIntlClientProvider>
    );
    expect(html).toContain('m1:whole');
    expect(html).toContain('m2:lost');
  });
});
