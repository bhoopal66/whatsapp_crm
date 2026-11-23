import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import en from '../../../messages/en.json';

vi.mock('./message-row', () => ({ MessageRow: () => null }));

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
