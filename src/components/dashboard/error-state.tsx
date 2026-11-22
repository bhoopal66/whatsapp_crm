import { AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Shared error panel for list screens: icon, plain message and an
 * optional Retry button. The icon and the heading carry the status,
 * not colour alone.
 */
export function ErrorState({
  message,
  onRetry,
  className,
}: {
  message?: string;
  onRetry?: () => void;
  className?: string;
}) {
  const t = useTranslations('States');
  return (
    <div
      role="alert"
      className={cn(
        'border-destructive/40 bg-destructive-soft flex min-h-40 flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-4 py-8 text-center',
        className
      )}
    >
      <AlertTriangle className="text-destructive h-6 w-6" aria-hidden="true" />
      <div className="space-y-1">
        <p className="text-foreground text-sm font-medium">{t('errorTitle')}</p>
        <p className="text-muted-foreground max-w-sm text-sm">
          {message || t('errorMessage')}
        </p>
      </div>
      {onRetry && (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t('retry')}
        </Button>
      )}
    </div>
  );
}
