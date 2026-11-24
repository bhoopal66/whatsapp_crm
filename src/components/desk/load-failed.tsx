'use client';

/** A read that failed, with Retry: never shown as an empty or missing card. */
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';

export function LoadFailed({
  title,
  onRetry,
}: {
  title?: string;
  onRetry: () => unknown;
}) {
  const t = useTranslations('States');
  return (
    <div
      role="alert"
      className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm"
    >
      <p>
        {title ? `${title}: ` : null}
        {t('errorMessage')}
      </p>
      <Button size="sm" variant="outline" onClick={() => void onRetry()}>
        {t('retry')}
      </Button>
    </div>
  );
}
