'use client';

import Link from 'next/link';
import { useId, type ComponentType, type ReactNode } from 'react';
import { ArrowRight, CircleAlert, RotateCw } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Skeleton } from '../skeleton';

/**
 * Identity colour of a panel's icon tile. Decorative: it tells panels
 * apart at a glance and says nothing about whether a figure is good —
 * figures carry the status tokens (`Stat`'s tone) for that.
 */
export type PanelTone =
  'primary' | 'violet' | 'emerald' | 'amber' | 'sky' | 'rose';

export const PANEL_TONE_CLASSES: Record<PanelTone, string> = {
  primary: 'bg-primary-soft text-primary',
  violet:
    'bg-violet-500/10 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300',
  emerald:
    'bg-emerald-500/10 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300',
  amber:
    'bg-amber-500/15 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300',
  sky: 'bg-sky-500/10 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300',
  rose: 'bg-rose-500/10 text-rose-700 dark:bg-rose-400/15 dark:text-rose-300',
};

type IconType = ComponentType<{ className?: string }>;

interface DashboardPanelProps {
  title: string;
  icon: IconType;
  tone?: PanelTone;
  /** One quiet line under the title, e.g. whose figures these are. */
  subtitle?: string;
  /** The header's link to the screen that owns this data. */
  action?: { href: string; label: string };
  /** Header controls left of the link, e.g. a range switch. */
  aside?: ReactNode;
  /** Nothing to show yet: a skeleton body. Pass `loading && !data`. */
  loading?: boolean;
  /** The load failed with nothing to show: an error body with Retry. */
  error?: boolean;
  onRetry?: () => void;
  id?: string;
  className?: string;
  children?: ReactNode;
}

/**
 * The card every home widget sits in: an icon tile, a title, an
 * optional link to the owning screen, then the body — or a skeleton
 * while nothing has loaded, or an error with Retry. A widget whose
 * refresh fails while older data is on screen keeps showing that data
 * (pass `error` only when there is nothing else to show).
 *
 * The body is a size container: a panel can sit in a third of the row
 * or span all of it depending on the role, so lay its figures out with
 * container variants (`@md:grid-cols-4`), not viewport ones.
 */
export function DashboardPanel({
  title,
  icon: Icon,
  tone = 'primary',
  subtitle,
  action,
  aside,
  loading = false,
  error = false,
  onRetry,
  id,
  className,
  children,
}: DashboardPanelProps) {
  const headingId = useId();
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cn(
        'border-border bg-card flex min-w-0 flex-col rounded-xl border p-5 shadow-xs dark:shadow-none',
        className
      )}
    >
      {/* Wraps rather than squeezing the title: on a phone a range switch
          or a pair of averages would otherwise cut it to a few letters. */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 basis-44 items-center gap-3">
          <div
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
              PANEL_TONE_CLASSES[tone]
            )}
          >
            <Icon className="h-4 w-4" aria-hidden />
          </div>
          <div className="min-w-0">
            <h2
              id={headingId}
              className="text-foreground truncate text-sm font-semibold"
            >
              {title}
            </h2>
            {subtitle && (
              <p className="text-muted-foreground truncate text-xs">
                {subtitle}
              </p>
            )}
          </div>
        </div>
        {(aside || action) && (
          <div className="flex shrink-0 items-center gap-3">
            {aside}
            {action && (
              <Link
                href={action.href}
                className="text-primary inline-flex items-center gap-1 rounded-md text-xs font-medium hover:underline"
              >
                {action.label}
                <ArrowRight className="h-3.5 w-3.5 rtl:rotate-180" aria-hidden />
              </Link>
            )}
          </div>
        )}
      </header>
      <div className="@container mt-4 flex min-h-0 flex-1 flex-col">
        {loading ? (
          <PanelSkeleton />
        ) : error ? (
          <PanelError onRetry={onRetry} />
        ) : (
          children
        )}
      </div>
    </section>
  );
}

export function PanelSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton
          key={i}
          className={cn('h-9', i === rows - 1 ? 'w-2/3' : 'w-full')}
        />
      ))}
    </div>
  );
}

export function PanelError({ onRetry }: { onRetry?: () => void }) {
  const t = useTranslations('Dashboard.home.panel');
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-6 text-center">
      <CircleAlert className="text-destructive h-5 w-5" aria-hidden />
      <p className="text-muted-foreground text-sm">{t('loadFailed')}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCw className="h-3.5 w-3.5" aria-hidden />
          {t('retry')}
        </Button>
      )}
    </div>
  );
}

/** A widget with nothing to list: one calm line, an optional way on. */
export function PanelEmpty({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon: IconType;
  title: string;
  hint?: string;
  action?: { href: string; label: string };
}) {
  return (
    <div className="bg-card-2 flex flex-1 flex-col items-center justify-center gap-1.5 rounded-lg px-4 py-6 text-center">
      <Icon className="text-muted-foreground h-5 w-5" aria-hidden />
      <p className="text-foreground text-sm font-medium">{title}</p>
      {hint && <p className="text-muted-foreground max-w-xs text-xs">{hint}</p>}
      {action && (
        <Link
          href={action.href}
          className="text-primary mt-1 text-xs font-medium hover:underline"
        >
          {action.label}
        </Link>
      )}
    </div>
  );
}
