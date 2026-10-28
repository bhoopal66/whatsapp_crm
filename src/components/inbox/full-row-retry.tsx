'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

/**
 * Shown where a section waits for the open chat's full row (the AI
 * banner, the contact panel) once every retry of that read has missed
 * (lib/inbox/open-conversation.ts): a quiet line with a Retry, instead
 * of a section that stays busy or absent for good.
 */
export function FullRowRetry({
  onRetry,
  className,
}: {
  onRetry: () => void;
  className?: string;
}) {
  const t = useTranslations('Inbox.fullRow');
  return (
    <p role="status" className={cn('text-muted-foreground text-xs', className)}>
      {t('failed')}{' '}
      <button
        type="button"
        onClick={onRetry}
        className="text-foreground underline underline-offset-2 hover:no-underline"
      >
        {t('retry')}
      </button>
    </p>
  );
}
