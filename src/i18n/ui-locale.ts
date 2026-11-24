import type { Locale as DateFnsLocale } from 'date-fns';
import { ar, enUS, ko } from 'date-fns/locale';

import { isLocale, type Locale } from './locales';

// The page's language for code outside React (module-level formatters, a
// component that is also rendered without a next-intl provider). The root
// layout writes it on <html lang>. Passing `undefined` to Intl instead
// follows the BROWSER's language, so an Arabic screen showed English dates.

/** The language this page is shown in; undefined on the server. */
export function uiLocale(): Locale | undefined {
  if (typeof document === 'undefined') return undefined;
  const lang = document.documentElement.lang;
  return isLocale(lang) ? lang : undefined;
}

const DATE_FNS: Record<Locale, DateFnsLocale> = { en: enUS, ar, ko };

/** date-fns' words ("3 minutes ago") in the page's language. */
export function dateFnsLocale(
  locale: string | undefined = uiLocale()
): DateFnsLocale {
  return isLocale(locale) ? DATE_FNS[locale] : enUS;
}
