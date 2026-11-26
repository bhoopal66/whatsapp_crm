import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';

import en from '../../../messages/en.json';
import type { Message } from '@/types';
import { MessageActions } from './message-actions';

describe('MessageActions', () => {
  it('keeps the hidden toolbar out of reach of a tap', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={en}>
        <MessageActions
          message={
            {
              id: 'm1',
              sender_type: 'customer',
              content_text: 'Hello',
            } as Message
          }
          onReply={() => {}}
          onReact={() => {}}
        >
          <p>Hello</p>
        </MessageActions>
      </NextIntlClientProvider>
    );
    const toolbar = /<div[^>]*data-message-toolbar[^>]*>/.exec(html)?.[0] ?? '';
    expect(toolbar).toMatch(/[" ]pointer-events-none[" ]/);
    expect(toolbar).not.toContain('data-touch-open=');
    // Wherever it is shown it can be pressed.
    expect(toolbar).toContain('group-hover/actions:pointer-events-auto');
    expect(toolbar).toContain('data-[touch-open=true]:pointer-events-auto');
  });
});
