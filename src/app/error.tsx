'use client'; // Error boundaries must be Client Components

import Link from 'next/link';
import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { House, RotateCw, TriangleAlert } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';

/**
 * Root route-segment boundary. It catches a render crash anywhere the
 * dashboard's own boundary does not: the sign-in pages, /join, and the
 * dashboard shell itself (a crashed sidebar cannot be kept). It renders
 * inside the root layout, so the catalogue and the theme are still
 * mounted; a crash in the root layout goes to global-error.tsx.
 *
 * - "Try again" is `unstable_retry` (Next 16.2): it re-fetches and
 *   re-renders the segment. `reset` only clears the error state, which
 *   does not help a Server Component that failed on the server.
 * - `error.message` is never shown. A Server Component's is replaced by
 *   a generic one in production anyway, and a Client Component's can
 *   carry anything. The digest is what matches the server log.
 * - Home is `/`, which redirects a signed-in user to /dashboard. A
 *   boundary resets when the pathname changes, so on /dashboard itself
 *   that link ends where it started and "Try again" is the way out.
 */
export default function RootError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  const t = useTranslations('ErrorPages');

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-svh items-center justify-center px-4 py-12">
      <div className="flex w-full max-w-md flex-col items-center text-center">
        <div className="bg-destructive-soft mb-4 flex size-12 items-center justify-center rounded-xl">
          <TriangleAlert className="text-destructive size-6" aria-hidden />
        </div>
        <h1 className="text-foreground text-xl font-semibold">
          {t('error.title')}
        </h1>
        <p className="text-muted-foreground mt-2 text-sm">
          {t('error.description')}
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <Button onClick={() => unstable_retry()}>
            <RotateCw aria-hidden />
            {t('retry')}
          </Button>
          <Link href="/" className={buttonVariants({ variant: 'outline' })}>
            <House aria-hidden />
            {t('home')}
          </Link>
        </div>
        {error.digest && (
          <p className="text-muted-foreground mt-6 font-mono text-xs">
            {t('digest', { digest: error.digest })}
          </p>
        )}
      </div>
    </div>
  );
}
