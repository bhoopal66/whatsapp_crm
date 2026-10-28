'use client';

import { Phone } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { browserTimeZone, callsToday } from '@/lib/dashboard/home/calls';
import type { CallStats } from '@/lib/pbx/call-stats';
import { DashboardPanel } from './panel';
import { Stat } from './stat';
import { useWidgetData } from './use-widget-data';

export interface CallsCardProps {
  refreshKey: number;
  className?: string;
}

async function loadCallsToday(): Promise<CallStats> {
  const tz = encodeURIComponent(browserTimeZone());
  const res = await fetch(`/api/pbx/calls/stats?period=today&tz=${tz}`, {
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`/api/pbx/calls/stats answered ${res.status}`);
  const body = (await res.json()) as { stats?: CallStats };
  if (!body.stats) throw new Error('/api/pbx/calls/stats sent no stats');
  return body.stats;
}

/**
 * Today's calls so far, from the Call report's own figures: whose calls
 * they are is `pbx_call_stats`'s decision (the person's, their team's,
 * or the workspace's), and the comparison is yesterday up to the same
 * time.
 */
export function CallsCard({ refreshKey, className }: CallsCardProps) {
  const t = useTranslations('Dashboard.home.calls');
  const { accountId, user } = useAuth();
  const w = useWidgetData(
    accountId && user
      ? `calls-today:${accountId}:${user.id}:${refreshKey}`
      : null,
    loadCallsToday
  );
  const today = w.data ? callsToday(w.data.summary, w.data.previous) : null;
  const d = today?.callsDelta;

  return (
    <DashboardPanel
      title={t('title')}
      icon={Phone}
      tone="sky"
      subtitle={w.data ? t(`scope.${w.data.scope}`) : undefined}
      action={{ href: '/calls/report', label: t('action') }}
      loading={w.loading && !w.data}
      error={w.error && !w.data}
      onRetry={w.reload}
      className={className}
    >
      {today && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 @2xl:grid-cols-4">
            <Stat
              label={t('calls')}
              value={today.calls}
              hint={
                !d
                  ? undefined
                  : d.direction === 'up'
                    ? t('vsYesterdayUp', { count: d.abs })
                    : d.direction === 'down'
                      ? t('vsYesterdayDown', { count: -d.abs })
                      : t('vsYesterdayFlat')
              }
            />
            <Stat
              label={t('answered')}
              value={today.answered}
              hint={t('answerRate', { rate: today.answerRate })}
            />
            <Stat
              label={t('missed')}
              value={today.missed}
              tone={today.missed > 0 ? 'destructive' : 'default'}
              href="/calls"
            />
            <Stat label={t('avgTalk')} value={today.avgTalk} />
          </div>
          {today.calls === 0 && (
            <p className="text-muted-foreground text-xs">{t('noCalls')}</p>
          )}
        </div>
      )}
    </DashboardPanel>
  );
}
