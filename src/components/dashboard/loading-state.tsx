import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

/**
 * Shared loading panel for list screens: a spinner plus a plain label,
 * announced to assistive tech through role="status" / aria-busy.
 */
export function LoadingState({
  label,
  className,
}: {
  label?: string;
  className?: string;
}) {
  const t = useTranslations('States');
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={cn(
        'flex min-h-40 flex-col items-center justify-center gap-2 px-4 py-10 text-center',
        className
      )}
    >
      <Loader2
        className="text-muted-foreground h-6 w-6 animate-spin"
        aria-hidden="true"
      />
      <p className="text-muted-foreground text-sm">{label || t('loading')}</p>
    </div>
  );
}
