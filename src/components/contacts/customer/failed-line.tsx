'use client';

// The customer page's one line for a part that could not be read, so a
// failed read never looks like an empty one.

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';

export function FailedLine({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('States');
  return (
    <div
      role="alert"
      className="text-muted-foreground space-y-2 text-start text-sm"
    >
      <p>{t('errorMessage')}</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        {t('retry')}
      </Button>
    </div>
  );
}
