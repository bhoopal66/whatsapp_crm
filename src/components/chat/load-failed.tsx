'use client';

import { useTranslations } from 'next-intl';
import { RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';

/** A read that failed, which must not look like an empty list. */
export function LoadFailed({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  const t = useTranslations('Chat');
  return (
    <div
      role="alert"
      className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <p className="text-muted-foreground text-sm">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RotateCcw aria-hidden />
        {t('retry')}
      </Button>
    </div>
  );
}
