import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { House, SearchX } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';

/**
 * Every unmatched URL, and any notFound() call without a closer
 * not-found.tsx. A Server Component rendered inside the root layout, so
 * next-intl reads the catalogue through src/i18n/request.ts. It takes no
 * props, so there is nothing to retry. `/` redirects to /dashboard, and
 * the middleware sends a signed-out visitor from there to /login.
 */
export default function NotFound() {
  const t = useTranslations('ErrorPages');

  return (
    <div className="flex min-h-svh items-center justify-center px-4 py-12">
      <div className="flex w-full max-w-md flex-col items-center text-center">
        <div className="bg-muted mb-4 flex size-12 items-center justify-center rounded-xl">
          <SearchX className="text-muted-foreground size-6" aria-hidden />
        </div>
        <h1 className="text-foreground text-xl font-semibold">
          {t('notFound.title')}
        </h1>
        <p className="text-muted-foreground mt-2 text-sm">
          {t('notFound.description')}
        </p>
        <Link href="/" className={buttonVariants({ className: 'mt-6' })}>
          <House aria-hidden />
          {t('home')}
        </Link>
      </div>
    </div>
  );
}
