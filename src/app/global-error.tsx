'use client'; // Error boundaries must be Client Components

import Link from 'next/link';
import { useEffect, useSyncExternalStore, type CSSProperties } from 'react';
import { House, RotateCw, TriangleAlert } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { useStaleBuild } from '@/hooks/use-stale-build';
import { reportClientError } from '@/lib/browser-reports/send';
import {
  DEFAULT_MODE,
  DEFAULT_THEME,
  LEGACY_MODE_STORAGE_KEY,
  LEGACY_STORAGE_KEY,
  MODE_STORAGE_KEY,
  STORAGE_KEY,
  isMode,
  isThemeId,
} from '@/lib/themes';
import {
  localeDir,
  readLocaleCookie,
  workspaceDefaultLocale,
} from '@/i18n/locales';
import './globals.css';

// This replaces the root layout, so nothing the layout mounts is here:
// no NextIntlClientProvider, no theme boot script, no Inter font class.
//
// Strings are not next-intl. useTranslations would throw without the
// provider, and the catalogue cannot be imported to feed one: en.json is
// ~230 KB, and this module ships in every route's client bundle. A
// root-layout crash may also be the catalogue failing to load. So this
// file keeps its own copy of ErrorPages (error.title, error.description,
// update, retry, home, digest) from messages/*.json; change them together.
const COPY = {
  en: {
    title: 'Something went wrong',
    description:
      'An unexpected error stopped this page from loading. Try again, or go back to the home screen.',
    update: {
      title: 'A new version is available',
      description:
        'This screen needs a part of the app that this tab could not load, usually because the app was updated. Reload to continue. Reloading drops text you have not sent: to finish it first, go to home and open its chat again.',
      reload: 'Reload',
    },
    retry: 'Try again',
    home: 'Go to home',
    digest: (id: string) => `Error ID: ${id}`,
  },
  ar: {
    title: 'حدث خطأ ما',
    description:
      'أوقف خطأ غير متوقع تحميل هذه الصفحة. حاول مرة أخرى، أو ارجع إلى الشاشة الرئيسية.',
    update: {
      title: 'يتوفر إصدار جديد',
      description:
        'تحتاج هذه الشاشة إلى جزء من التطبيق لم يتمكن هذا التبويب من تحميله، غالبًا لأن التطبيق حُدِّث. أعد التحميل للمتابعة. إعادة التحميل تحذف النص الذي لم ترسله: لإكماله أولًا، انتقل إلى الرئيسية وافتح محادثته من جديد.',
      reload: 'إعادة التحميل',
    },
    retry: 'حاول مرة أخرى',
    home: 'الانتقال إلى الرئيسية',
    digest: (id: string) => `معرّف الخطأ: ${id}`,
  },
  ko: {
    title: '문제가 발생했습니다',
    description:
      '예기치 않은 오류로 이 페이지를 불러오지 못했습니다. 다시 시도하거나 홈 화면으로 돌아가세요.',
    update: {
      title: '새 버전이 있습니다',
      description:
        '이 탭에서 화면에 필요한 앱의 일부를 불러오지 못했습니다. 보통 앱이 업데이트되었기 때문입니다. 계속하려면 새로 고치세요. 새로 고치면 보내지 않은 텍스트가 사라집니다. 먼저 마무리하려면 홈으로 이동한 뒤 해당 대화를 다시 여세요.',
      reload: '새로 고침',
    },
    retry: '다시 시도',
    home: '홈으로 이동',
    digest: (id: string) => `오류 ID: ${id}`,
  },
};

// The locale src/i18n/request.ts would pick: the person's NEXT_LOCALE
// cookie, else the build-time workspace default, else English. The
// server render cannot read the cookie here (this module is a client
// component), so it renders the default and switches to the cookie's
// language after hydration.
function copyLocale(requested: string | undefined): keyof typeof COPY {
  return requested && Object.hasOwn(COPY, requested)
    ? (requested as keyof typeof COPY)
    : 'en';
}
/** The cookie does not change while this page is up. */
const noSubscription = () => () => {};

const DEFAULT_COPY_LOCALE = copyLocale(
  workspaceDefaultLocale(process.env.NEXT_PUBLIC_APP_LOCALE)
);

// Inter reaches the app as the --font-sans variable on the root
// layout's <html>. Unset, `font-sans` would fall back to the browser's
// serif default, so name a system stack rather than load Inter twice.
const HTML_STYLE = {
  '--font-sans': 'ui-sans-serif, system-ui, sans-serif',
} as CSSProperties;

/**
 * Last-resort boundary for a crash in the root layout (or in a boundary
 * below it). Retry and the hidden error message follow src/app/error.tsx.
 * This boundary sits outside the app router, so Link finds no router and
 * leaves the click to the browser: home is a full page load, which also
 * re-runs the root layout.
 */
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  // The cookie is read on the client only; the server render (and
  // hydration) use the workspace default, then React re-renders.
  const locale = useSyncExternalStore(
    noSubscription,
    () => copyLocale(readLocaleCookie(document.cookie) ?? undefined),
    () => DEFAULT_COPY_LOCALE
  );
  const copy = COPY[locale];
  const stale = useStaleBuild(error);
  const words = stale ? copy.update : copy;

  useEffect(() => {
    console.error(error);
    reportClientError('global', error);
  }, [error]);

  // The layout's boot script applied the saved accent and mode before
  // first paint; it is gone with the layout, so apply them the same way
  // here. Server-rendered, this page shows the defaults until hydration.
  useEffect(() => {
    const root = document.documentElement;
    try {
      const theme =
        localStorage.getItem(STORAGE_KEY) ||
        localStorage.getItem(LEGACY_STORAGE_KEY);
      const mode =
        localStorage.getItem(MODE_STORAGE_KEY) ||
        localStorage.getItem(LEGACY_MODE_STORAGE_KEY);
      if (isThemeId(theme)) root.dataset.theme = theme;
      if (isMode(mode)) root.dataset.mode = mode;
    } catch {
      // Storage blocked: keep the defaults.
    }
  }, []);

  return (
    <html
      lang={locale}
      dir={localeDir(locale)}
      data-theme={DEFAULT_THEME}
      data-mode={DEFAULT_MODE}
      className="h-full antialiased"
      style={HTML_STYLE}
      // The effect above rewrites data-theme and data-mode, as the root
      // layout's boot script does; see the note there.
      suppressHydrationWarning
    >
      <head>
        <title>{words.title}</title>
      </head>
      <body className="bg-background text-foreground min-h-full font-sans">
        <div className="flex min-h-svh items-center justify-center px-4 py-12">
          <div className="flex w-full max-w-md flex-col items-center text-center">
            <div className="bg-destructive-soft mb-4 flex size-12 items-center justify-center rounded-xl">
              <TriangleAlert className="text-destructive size-6" aria-hidden />
            </div>
            <h1 className="text-foreground text-xl font-semibold">
              {words.title}
            </h1>
            <p className="text-muted-foreground mt-2 text-sm">
              {words.description}
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
              <Button
                onClick={() =>
                  stale ? window.location.reload() : unstable_retry()
                }
              >
                <RotateCw aria-hidden />
                {stale ? copy.update.reload : copy.retry}
              </Button>
              <Link href="/" className={buttonVariants({ variant: 'outline' })}>
                <House aria-hidden />
                {copy.home}
              </Link>
            </div>
            {error.digest && (
              <p className="text-muted-foreground mt-6 font-mono text-xs">
                {copy.digest(error.digest)}
              </p>
            )}
          </div>
        </div>
      </body>
    </html>
  );
}
