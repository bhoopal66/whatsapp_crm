import Link from 'next/link';

import { cn } from '@/lib/utils';

/** What a figure means: the status tokens, or plain. */
export type StatTone =
  'default' | 'success' | 'warning' | 'destructive' | 'muted';

const VALUE_TONE: Record<StatTone, string> = {
  default: 'text-foreground',
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
  muted: 'text-muted-foreground',
};

interface StatProps {
  label: string;
  /** Pre-formatted, e.g. "12" or "4:05". */
  value: string | number;
  tone?: StatTone;
  /** One small line under the figure, e.g. "+3 vs yesterday". */
  hint?: string;
  /** The figure opens the list it counts. */
  href?: string;
  className?: string;
}

/** One labelled figure inside a panel, on the inner surface. */
export function Stat({
  label,
  value,
  tone = 'default',
  hint,
  href,
  className,
}: StatProps) {
  const body = (
    <>
      <p className="text-muted-foreground truncate text-xs font-medium">
        {label}
      </p>
      <p
        className={cn(
          'mt-1 text-2xl leading-none font-bold tabular-nums',
          VALUE_TONE[tone]
        )}
      >
        {value}
      </p>
      {hint && (
        <p className="text-muted-foreground mt-1.5 truncate text-xs">{hint}</p>
      )}
    </>
  );
  const box = cn('block min-w-0 rounded-lg bg-card-2 px-3 py-2.5', className);
  return href ? (
    <Link href={href} className={cn(box, 'hover:bg-muted transition-colors')}>
      {body}
    </Link>
  ) : (
    <div className={box}>{body}</div>
  );
}
