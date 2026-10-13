'use client'; // Error boundaries must be Client Components

import Link from 'next/link';
import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { House, RotateCw, TriangleAlert } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';

/**
 * The dashboard screens' boundary. An error.tsx wraps its segment's
 * pages and nested layouts but not the layout beside it, so this renders
 * inside (dashboard)/layout.tsx: the sidebar and header stay, and only
 * the crashed screen is replaced. A crash in the shell itself goes to
 * the root error.tsx. Retry, the home link and the hidden error message
 * follow the root boundary; see src/app/error.tsx.
 */
export default function DashboardError({
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
    <div className="flex min-h-[60vh] items-center justify-center py-12">
      <div className="border-border bg-card flex w-full max-w-md flex-col items-center rounded-xl border px-6 py-10 text-center">
        <div className="bg-destructive/10 mb-4 flex size-12 items-center justify-center rounded-xl">
          <TriangleAlert className="text-destructive size-6" aria-hidden />
        </div>
        <h1 className="text-foreground text-lg font-semibold">
          {t('dashboard.title')}
        </h1>
        <p className="text-muted-foreground mt-2 text-sm">
          {t('dashboard.description')}
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
