import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

import { LOCALE_COOKIE, resolveLocale } from './locales';

/**
 * The person's language (cookie), else the workspace default
 * (NEXT_PUBLIC_APP_LOCALE), else English: see ./locales.ts.
 */
export default getRequestConfig(async () => {
  const store = await cookies();
  let locale = resolveLocale(store.get(LOCALE_COOKIE)?.value);

  let messages;
  try {
    messages = (await import(`../../messages/${locale}.json`)).default;
  } catch {
    // A supported locale whose catalogue is missing from this build:
    // render English rather than fail every page.
    messages = (await import(`../../messages/en.json`)).default;
    locale = 'en';
  }

  return {
    locale,
    messages,
  };
});
