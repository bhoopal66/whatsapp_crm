'use client';

/** One line above a list that could not be (fully) read, with Retry. */
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function LoadNote({
  text,
  tone = 'quiet',
  onRetry,
  retrying = false,
}: {
  text: string;
  tone?: 'quiet' | 'error';
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const t = useTranslations('States');
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      data-testid="worklist-load-note"
      data-tone={tone}
      className={cn(
        'flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2 text-sm',
        tone === 'error'
          ? 'bg-destructive-soft text-foreground'
          : 'text-muted-foreground'
      )}
    >
      <span>{text}</span>
      {onRetry && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={retrying}
          onClick={onRetry}
        >
          {t('retry')}
        </Button>
      )}
    </div>
  );
}
