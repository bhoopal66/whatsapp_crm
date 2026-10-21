'use client'; // Error boundaries must be Client Components

import Link from 'next/link';
import { useEffect, type CSSProperties } from 'react';
import { House, RotateCw, TriangleAlert } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
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
import './globals.css';

// This replaces the root layout, so nothing the layout mounts is here:
// no NextIntlClientProvider, no theme boot script, no Inter font class.
//
// Strings are not next-intl. useTranslations would throw without the
// provider, and the catalogue cannot be imported to feed one: en.json is
// ~230 KB, and this module ships in every route's client bundle. A
// root-layout crash may also be the catalogue failing to load. So this
// file keeps its own copy of ErrorPages (error.title, error.description,
// retry, home, digest) from messages/*.json; change them together.
const COPY = {
  en: {
    title: 'Something went wrong',
    description:
      'An unexpected error stopped this page from loading. Try again, or go back to the home screen.',
    retry: 'Try again',
    home: 'Go to home',
    digest: (id: string) => `Error ID: ${id}`,
  },
  ko: {
    title: '문제가 발생했습니다',
    description:
      '예기치 않은 오류로 이 페이지를 불러오지 못했습니다. 다시 시도하거나 홈 화면으로 돌아가세요.',
    retry: '다시 시도',
    home: '홈으로 이동',
    digest: (id: string) => `오류 ID: ${id}`,
  },
};

// The build-time locale src/i18n/request.ts reads, falling back to
// English for a locale with no copy here, as request.ts does for one
// with no catalogue.
const requested = process.env.NEXT_PUBLIC_APP_LOCALE ?? '';
const LOCALE: keyof typeof COPY = Object.hasOwn(COPY, requested)
  ? (requested as keyof typeof COPY)
  : 'en';

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
  const copy = COPY[LOCALE];

  useEffect(() => {
    console.error(error);
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
      lang={LOCALE}
      data-theme={DEFAULT_THEME}
      data-mode={DEFAULT_MODE}
      className="h-full antialiased"
      style={HTML_STYLE}
      // The effect above rewrites data-theme and data-mode, as the root
      // layout's boot script does; see the note there.
      suppressHydrationWarning
    >
      <head>
        <title>{copy.title}</title>
      </head>
      <body className="bg-background text-foreground min-h-full font-sans">
        <div className="flex min-h-svh items-center justify-center px-4 py-12">
          <div className="flex w-full max-w-md flex-col items-center text-center">
            <div className="bg-destructive-soft mb-4 flex size-12 items-center justify-center rounded-xl">
              <TriangleAlert className="text-destructive size-6" aria-hidden />
            </div>
            <h1 className="text-foreground text-xl font-semibold">
              {copy.title}
            </h1>
            <p className="text-muted-foreground mt-2 text-sm">
              {copy.description}
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
              <Button onClick={() => unstable_retry()}>
                <RotateCw aria-hidden />
                {copy.retry}
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
