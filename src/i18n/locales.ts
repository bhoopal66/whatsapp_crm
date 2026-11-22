/**
 * The languages the app is offered in, and how one is chosen for a
 * request. Pure: no next/headers, so client components, route handlers
 * and tests share it.
 *
 * A request's locale is, in order:
 *   1. the person's own choice, carried in the `NEXT_LOCALE` cookie
 *      (written at sign-in from `profiles.preferred_language`, migration
 *      259, and when they change it in Settings → Appearance);
 *   2. the workspace default, `NEXT_PUBLIC_APP_LOCALE` (build time);
 *   3. English.
 * Anything that is not a supported locale is ignored at every step, so a
 * forged cookie can only pick one of these catalogues.
 *
 * `LOCALES` mirrors the CHECK on `profiles.preferred_language` (259):
 * change both. `locales.test.ts` reads the migration.
 */
export const LOCALES = ['en', 'ar', 'ko'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/** next-intl's own cookie name, so its tooling recognises it. */
export const LOCALE_COOKIE = 'NEXT_LOCALE';

/** One year: a language choice outlives sessions. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Languages read right to left. */
const RTL_LOCALES: ReadonlySet<Locale> = new Set(['ar']);

/** Each language's own name for itself, for the picker. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  ar: 'العربية',
  ko: '한국어',
};

export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
  );
}

export function localeDir(locale: string): 'rtl' | 'ltr' {
  return isLocale(locale) && RTL_LOCALES.has(locale) ? 'rtl' : 'ltr';
}

/** The build-time workspace default, if it names a supported locale. */
export function workspaceDefaultLocale(
  env: string | undefined = process.env.NEXT_PUBLIC_APP_LOCALE
): Locale {
  return isLocale(env) ? env : DEFAULT_LOCALE;
}

/** The locale for a request carrying `cookieValue` (or none). */
export function resolveLocale(
  cookieValue: string | undefined | null,
  env: string | undefined = process.env.NEXT_PUBLIC_APP_LOCALE
): Locale {
  return isLocale(cookieValue) ? cookieValue : workspaceDefaultLocale(env);
}

/**
 * Attributes of the language cookie, shared by the routes that write it
 * and the browser-side sync (`syncLocaleCookie`). Not httpOnly: the
 * browser rewrites it when the signed-in person's saved language differs
 * from this device's, and a language is not a secret.
 */
export const LOCALE_COOKIE_OPTIONS = {
  path: '/',
  maxAge: LOCALE_COOKIE_MAX_AGE,
  sameSite: 'lax' as const,
  httpOnly: false,
};

/** The language cookie's value in a `document.cookie` string. */
export function readLocaleCookie(cookieHeader: string): Locale | null {
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === LOCALE_COOKIE) {
      const value = rest.join('=');
      return isLocale(value) ? value : null;
    }
  }
  return null;
}

/**
 * Browser only: aligns this device's cookie with the person's saved
 * language (`profiles.preferred_language`). Returns true when the cookie
 * changed, so the caller reloads to render in it. `saved` NULL (no
 * choice) removes the cookie, so the workspace default applies, as it
 * would on a new device; `undefined` (a database before 259, no column)
 * changes nothing.
 */
export function syncLocaleCookie(saved: string | null | undefined): boolean {
  if (typeof document === 'undefined' || saved === undefined) return false;
  const current = readLocaleCookie(document.cookie);
  const wanted = isLocale(saved) ? saved : null;
  if (current === wanted) return false;
  if (wanted) {
    document.cookie = `${LOCALE_COOKIE}=${wanted}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; samesite=lax`;
  } else {
    document.cookie = `${LOCALE_COOKIE}=; path=/; max-age=0; samesite=lax`;
  }
  // Only a cookie that took counts: with cookies blocked a "changed"
  // answer would reload the page forever.
  return readLocaleCookie(document.cookie) === wanted;
}
