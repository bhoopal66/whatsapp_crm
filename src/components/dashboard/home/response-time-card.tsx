'use client';

import dynamic from 'next/dynamic';
import { Clock } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { loadResponseTime } from '@/lib/dashboard/queries';
import { createClient } from '@/lib/supabase/client';
import { Skeleton } from '../skeleton';
import { DashboardPanel, PanelEmpty } from './panel';
import { useWidgetData } from './use-widget-data';
import { uiLocale } from '@/i18n/ui-locale';

// recharts is the heaviest dependency on the dashboard and only this
// chart uses it — load it in its own chunk, client-only, behind a
// skeleton sized like the chart so nothing shifts when it arrives.
const BarChart = dynamic(
  () => import('@/components/tremor/bar-chart').then((m) => m.BarChart),
  {
    ssr: false,
    loading: () => <Skeleton className="h-[260px] w-full" />,
  }
);

export interface ResponseTimeCardProps {
  refreshKey: number;
  className?: string;
}

/** Minutes. Shown as a "target" pill: Tremor's BarChart does not expose
 *  recharts primitives, so it is not drawn as a line on the chart. */
const THRESHOLD_MINUTES = 5;

// Single category, single colour: the data is "average minutes per
// weekday". Tremor expects categories as keys of the row object.
const CATEGORY = 'Avg minutes';

export function ResponseTimeCard({
  refreshKey,
  className,
}: ResponseTimeCardProps) {
  const t = useTranslations('Dashboard.responseTimeChart');
  const w = useWidgetData(`response-time:${refreshKey}`, () =>
    loadResponseTime(createClient())
  );
  const data = w.data;
  const hasData = data?.buckets.some((b) => b.avgMinutes != null) ?? false;

  // Null `avgMinutes` (no samples) collapses to 0; the chart renders an
  // empty slot for it. `samples` stays on the row for a future tooltip.
  const weekday = new Intl.DateTimeFormat(uiLocale(), { weekday: 'short' });
  const chartData =
    data?.buckets.map((b, i) => ({
      // 1 January 2024 was a Monday.
      day: weekday.format(new Date(2024, 0, 1 + i)),
      [CATEGORY]: b.avgMinutes ?? 0,
      samples: b.samples,
    })) ?? [];

  return (
    <DashboardPanel
      title={t('title')}
      subtitle={t('description')}
      icon={Clock}
      tone="amber"
      className={className}
      loading={w.loading && !w.data}
      error={w.error && !w.data}
      onRetry={w.reload}
      aside={
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-end text-xs">
          <span className="border-destructive/30 bg-destructive-soft text-destructive rounded-full border px-2 py-0.5 font-medium tabular-nums">
            {t('target', { minutes: THRESHOLD_MINUTES })}
          </span>
          {data && (data.thisWeekAvg != null || data.lastWeekAvg != null) && (
            <div>
              <div className="text-muted-foreground">
                {t('thisWeek')}{' '}
                <span className="text-foreground font-medium tabular-nums">
                  {fmt(data.thisWeekAvg)}
                </span>
              </div>
              <div className="text-muted-foreground">
                {t('lastWeek')}{' '}
                <span className="tabular-nums">{fmt(data.lastWeekAvg)}</span>
              </div>
            </div>
          )}
        </div>
      }
    >
      {data &&
        (!hasData ? (
          <PanelEmpty
            icon={Clock}
            title={t('noReplies')}
            hint={t('noRepliesHint')}
          />
        ) : (
          <BarChart
            data={chartData}
            index="day"
            categories={[CATEGORY]}
            // 'chart1' maps to `fill-chart-1`, the accent's chart token,
            // so the bars follow the workspace accent in both modes.
            colors={['chart1']}
            valueFormatter={(value) => `${value.toFixed(1)}m`}
            showLegend={false}
            yAxisWidth={48}
            // Recharts gives each tick label its own fill and font size, so
            // the axis's own classes never reach them: the labels came out
            // dark on the dark card and big enough to clip "12.0m".
            className="[&_.recharts-cartesian-axis-tick-value]:fill-muted-foreground h-[260px] [&_.recharts-cartesian-axis-tick-value]:text-xs"
          />
        ))}
    </DashboardPanel>
  );
}

function fmt(mins: number | null): string {
  if (mins == null) return '—';
  if (mins < 1) return `${Math.max(1, Math.round(mins * 60))}s`;
  if (mins < 60) return `${mins.toFixed(1)}m`;
  return `${(mins / 60).toFixed(1)}h`;
}
