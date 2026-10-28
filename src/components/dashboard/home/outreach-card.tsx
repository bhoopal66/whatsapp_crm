'use client';

import { MessageSquarePlus, ShieldAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { useAccountNumbers } from '@/hooks/use-whatsapp-numbers';
import { browserTimeZone } from '@/lib/dashboard/home/calls';
import {
  outreachBars,
  type OutreachBar,
  type OutreachTone,
} from '@/lib/dashboard/home/outreach';
import { createClient } from '@/lib/supabase/client';
import {
  parseMyOutreachDay,
  type MyOutreachDay,
} from '@/lib/team-activity/thread-guard';
import { cn } from '@/lib/utils';
import { DashboardPanel } from './panel';
import { useWidgetData } from './use-widget-data';

export interface OutreachCardProps {
  refreshKey: number;
  className?: string;
}

const BAR_TONE: Record<OutreachTone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
};

const TEXT_TONE: Record<OutreachTone, string> = {
  success: 'text-foreground',
  warning: 'text-warning',
  destructive: 'text-destructive',
};

/**
 * Unlike `useMyOutreach`, which hides a failure as null for the
 * composer's warnings, a failed read here is the panel's error.
 */
async function loadMyDay(): Promise<MyOutreachDay> {
  const { data, error } = await createClient().rpc('team_activity_my_day', {
    p_tz: browserTimeZone(),
  });
  if (error) throw new Error(error.message);
  const day = parseMyOutreachDay(data);
  if (!day) throw new Error('team_activity_my_day sent nothing readable');
  return day;
}

/**
 * The chats this person started today against their daily limit, and
 * each phone number's against its own (Team activity's limits, the ones
 * the composer warns about), so they can pace their outreach.
 */
export function OutreachCard({ refreshKey, className }: OutreachCardProps) {
  const t = useTranslations('Dashboard.home.outreach');
  const { user, accountId } = useAuth();
  const userId = user?.id ?? null;
  const w = useWidgetData(
    userId && accountId
      ? `outreach:${accountId}:${userId}:${refreshKey}`
      : null,
    loadMyDay
  );
  const numbers = useAccountNumbers(true, refreshKey);
  const bars = w.data ? outreachBars(w.data, numbers ?? []) : null;

  return (
    <DashboardPanel
      title={t('title')}
      icon={MessageSquarePlus}
      tone="emerald"
      loading={w.loading && !w.data}
      error={w.error && !w.data}
      onRetry={w.reload}
      className={className}
    >
      {bars && w.data && (
        <div className="space-y-4">
          <BarRow bar={bars.me} label={t('you')} strong />
          {bars.numbers.length > 0 && (
            <div className="space-y-2.5">
              <h3 className="text-muted-foreground text-xs font-semibold">
                {t('perNumber')}
              </h3>
              {bars.numbers.map((b) => (
                <BarRow key={b.key} bar={b} label={b.name ?? t('unnamed')} />
              ))}
            </div>
          )}
          {w.data.blockedWhenOver && (
            <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
              <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
              {t('blocked')}
            </p>
          )}
        </div>
      )}
    </DashboardPanel>
  );
}

function BarRow({
  bar,
  label,
  strong = false,
}: {
  bar: OutreachBar;
  label: string;
  strong?: boolean;
}) {
  const t = useTranslations('Dashboard.home.outreach');
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span
          className={cn(
            'min-w-0 truncate',
            strong
              ? 'text-foreground text-sm font-semibold'
              : 'text-foreground text-xs font-medium'
          )}
        >
          {label}
          {bar.warmingUp && (
            <span className="text-info bg-info-soft ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium">
              {t('warmingUp')}
            </span>
          )}
        </span>
        <span
          className={cn(
            'shrink-0 text-xs font-medium tabular-nums',
            TEXT_TONE[bar.tone]
          )}
        >
          {bar.limit === null
            ? t('noLimit', { started: bar.started })
            : t('ofLimit', { started: bar.started, limit: bar.limit })}
        </span>
      </div>
      {bar.limit !== null && (
        <div
          className={cn(
            'bg-card-2 mt-1.5 overflow-hidden rounded-full',
            strong ? 'h-2.5' : 'h-1.5'
          )}
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={bar.limit}
          aria-valuenow={Math.min(bar.started, bar.limit)}
        >
          <div
            className={cn('h-full rounded-full', BAR_TONE[bar.tone])}
            style={{ width: `${bar.percent}%` }}
          />
        </div>
      )}
    </div>
  );
}
