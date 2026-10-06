'use client';

import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';

import { Skeleton } from '@/components/dashboard/skeleton';
import { hourLabel } from '@/lib/team-activity/format';
import {
  inQuietHours,
  type TeamActivityLimits,
} from '@/lib/team-activity/limits';
import type { DailyActivity, HourlyActivity } from '@/lib/team-activity/report';

// recharts is heavy and only these charts use it on this page: load it
// in its own chunk, client-only, behind a skeleton the chart's size.
const BarChart = dynamic(
  () => import('@/components/tremor/bar-chart').then((m) => m.BarChart),
  { ssr: false, loading: () => <Skeleton className="h-[240px] w-full" /> }
);

function shortDay(day: string): string {
  // YYYY-MM-DD → DD/MM, without a time zone round trip.
  const [, m, d] = day.split('-');
  return d && m ? `${d}/${m}` : day;
}

/** New chats per day: answered, not answered, too recent to tell. */
export function DailyChart({ daily }: { daily: DailyActivity[] }) {
  const t = useTranslations('TeamActivity.charts');
  const replied = t('replied');
  const noReply = t('noReply');
  const pending = t('tooRecent');
  // Chats less than a day old may still be answered (D3): their own
  // colour, not "no reply".
  const data = daily.map((d) => ({
    day: shortDay(d.day),
    [replied]: Math.max(0, d.started - d.noReply),
    [noReply]: Math.max(0, d.noReply - d.pendingReply),
    [pending]: d.pendingReply,
  }));
  const empty = daily.every((d) => d.started === 0);

  return (
    <section className="border-border bg-card flex h-full flex-col rounded-xl border">
      <header className="border-border border-b px-5 py-4">
        <h2 className="text-foreground text-sm font-semibold">
          {t('dailyTitle')}
        </h2>
        <p className="text-muted-foreground mt-0.5 text-xs">
          {t('dailyDescription')}
        </p>
      </header>
      <div className="p-5">
        {empty ? (
          <p className="text-muted-foreground py-16 text-center text-sm">
            {t('empty')}
          </p>
        ) : (
          <BarChart
            data={data}
            index="day"
            categories={[replied, noReply, pending]}
            colors={['emerald', 'amber', 'gray']}
            type="stacked"
            allowDecimals={false}
            yAxisWidth={32}
            className="h-[240px]"
          />
        )}
      </div>
    </section>
  );
}

/** New chats by local hour, with the night hours in their own colour. */
export function HourlyChart({
  hourly,
  limits,
}: {
  hourly: HourlyActivity[];
  limits: TeamActivityLimits;
}) {
  const t = useTranslations('TeamActivity.charts');
  const day = t('dayHours');
  const night = t('quietHours');
  const data = hourly.map((h) => {
    const quiet = inQuietHours(
      h.hour,
      limits.quietHoursStart,
      limits.quietHoursEnd
    );
    return {
      hour: hourLabel(h.hour).slice(0, 2),
      [day]: quiet ? 0 : h.started,
      [night]: quiet ? h.started : 0,
    };
  });
  const empty = hourly.every((h) => h.started === 0);
  const quietOff = limits.quietHoursStart === limits.quietHoursEnd;

  return (
    <section className="border-border bg-card flex h-full flex-col rounded-xl border">
      <header className="border-border border-b px-5 py-4">
        <h2 className="text-foreground text-sm font-semibold">
          {t('hourlyTitle')}
        </h2>
        <p className="text-muted-foreground mt-0.5 text-xs">
          {quietOff
            ? t('hourlyDescriptionNoQuiet')
            : t('hourlyDescription', {
                start: hourLabel(limits.quietHoursStart),
                end: hourLabel(limits.quietHoursEnd),
              })}
        </p>
      </header>
      <div className="p-5">
        {empty ? (
          <p className="text-muted-foreground py-16 text-center text-sm">
            {t('empty')}
          </p>
        ) : (
          <BarChart
            data={data}
            index="hour"
            categories={quietOff ? [day] : [day, night]}
            colors={['blue', 'violet']}
            type="stacked"
            allowDecimals={false}
            yAxisWidth={32}
            className="h-[240px]"
          />
        )}
      </div>
    </section>
  );
}
