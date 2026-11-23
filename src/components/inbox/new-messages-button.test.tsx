import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider, type AbstractIntlMessages } from 'next-intl';

import ar from '../../../messages/ar.json';
import en from '../../../messages/en.json';
import ko from '../../../messages/ko.json';
import { NewMessagesButton } from './new-messages-button';

function render(messages: AbstractIntlMessages, locale: string, count: number) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
      <NewMessagesButton count={count} onClick={vi.fn()} />
    </NextIntlClientProvider>
  );
}

describe('NewMessagesButton', () => {
  it('is a button named by its count, and placed logically', () => {
    const html = render(en, 'en', 3);
    expect(html).toMatch(/<button[^>]*>.*3 new messages<\/button>/);
    expect(html).toContain('end-4');
    expect(render(en, 'en', 1)).toContain('1 new message<');
    expect(render(ar, 'ar', 3)).toContain('رسائل جديدة');
    expect(render(ko, 'ko', 3)).toContain('새 메시지 3개');
  });

  it('is absent with nothing below', () => {
    expect(render(en, 'en', 0)).toBe('');
  });
});
