// ============================================================
// PUT /api/profile/language — { locale: 'en' | 'ar' | 'ko' | null }
//   → 200 { locale }
//
// Saves the caller's interface language on every one of their profiles
// rows (`set_my_language`, migration 259) and sets this device's
// NEXT_LOCALE cookie, which src/i18n/request.ts reads on the next
// request; null clears both, so the workspace default applies.
//
// Any signed-in person, bank guests and viewers included: it is their
// own preference. Authenticated by the session alone, like
// /api/workspaces/switch.
// ============================================================

import { NextResponse } from 'next/server';

import { isLocale, LOCALE_COOKIE, LOCALE_COOKIE_OPTIONS } from '@/i18n/locales';
import { toErrorResponse } from '@/lib/auth/account';
import { createClient } from '@/lib/supabase/server';

export async function PUT(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json().catch(() => null)) as {
      locale?: unknown;
    } | null;
    const locale = body?.locale;
    if (locale !== null && !isLocale(locale)) {
      return NextResponse.json(
        { error: "'locale' must be a supported language or null" },
        { status: 400 }
      );
    }

    const { error } = await supabase.rpc('set_my_language', {
      p_language: locale,
    });
    if (error) {
      console.error(
        '[PUT /api/profile/language] set_my_language failed:',
        error
      );
      return NextResponse.json(
        { error: 'Could not save the language' },
        { status: 500 }
      );
    }

    const response = NextResponse.json({ locale });
    if (locale) {
      response.cookies.set(LOCALE_COOKIE, locale, LOCALE_COOKIE_OPTIONS);
    } else {
      response.cookies.delete(LOCALE_COOKIE);
    }
    return response;
  } catch (err) {
    return toErrorResponse(err);
  }
}
