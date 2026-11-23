import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import ForgotPasswordPage from '@/app/(auth)/forgot-password/page';

import ar from '../../../messages/ar.json';
import en from '../../../messages/en.json';
import ko from '../../../messages/ko.json';

describe('the forgot-password page', () => {
  it.each([
    ['en', en],
    ['ar', ar],
    ['ko', ko],
  ])(
    'sends the person to their administrator (%s), with no form',
    (locale, messages) => {
      const html = renderToStaticMarkup(
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ForgotPasswordPage />
        </NextIntlClientProvider>
      );
      expect(html).toContain(messages.ForgotPasswordPage.description);
      expect(html).toContain(messages.ForgotPasswordPage.steps);
      expect(html).toContain('href="/login"');
      expect(html).not.toMatch(/<(form|input)/);
    }
  );
});
