'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Info,
  Percent,
  RefreshCw,
  Undo2,
  Wallet,
  XCircle,
} from 'lucide-react';

import { BarChart, type TooltipProps } from '@/components/tremor/bar-chart';
import type { AvailableChartColorsKeys } from '@/components/tremor/chart-colors';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  avgDaysSeries,
  parseDashboard,
  percent,
  REASON_CODES,
  reasonSeries,
  stageSeries,
} from '@/lib/banks/dashboard-ui';
import type {
  BankDashboardData,
  OutcomeReasonCode,
} from '@/lib/cases/dashboard';
import { DEFAULT_STAGES, formatAed } from '@/lib/cases/ui';

/** Bar height per row of a horizontal chart, plus room for the axis. */
const chartHeight = (rows: number) => ({ height: rows * 36 + 40 });

/** The bank page's Dashboard tab: the bank's figures (018c, migration 127). */
export function BankDashboardTab({ bankWsId }: { bankWsId: string }) {
  const t = useTranslations('Banks.dashboard');
  const tb = useTranslations('Banks');
  const locale = useLocale();
  const [data, setData] = useState<BankDashboardData | null | 'error'>(null);
  const [refreshing, setRefreshing] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setRefreshing(true);
    try {
      const res = await fetch(`/api/banks/${bankWsId}/dashboard`, {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(String(res.status));
      const d = parseDashboard(await res.json());
      if (!d) throw new Error('unusable');
      if (mine === seq.current) setData(d);
    } catch {
      if (mine === seq.current) setData('error');
    } finally {
      if (mine === seq.current) setRefreshing(false);
    }
  }, [bankWsId]);
  useEffect(() => {
    void load();
  }, [load]);

  const labels = useMemo(
    () =>
      Object.fromEntries(
        REASON_CODES.map((c) => [c, t(`reasons.${c}`)])
      ) as Record<OutcomeReasonCode, string>,
    [t]
  );

  if (data === null)
    return <div className="bg-muted mt-2 h-40 animate-pulse rounded-xl" />;
  if (data === 'error')
    return (
      <div className="flex items-center gap-3 py-4">
        <p className="text-destructive text-sm">{tb('loadFailed')}</p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          {tb('retry')}
        </Button>
      </div>
    );

  const count = (n: number) => n.toLocaleString(locale);
  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-muted-foreground text-sm">
        {t(`scope.${data.scope}`)}
      </p>
      <Button
        variant="outline"
        size="sm"
        disabled={refreshing}
        onClick={() => void load()}
      >
        <RefreshCw
          className={refreshing ? 'size-4 animate-spin' : 'size-4'}
          aria-hidden
        />
        {t('refresh')}
      </Button>
    </div>
  );

  if (data.totalCases === 0)
    return (
      <div className="space-y-3 pt-2">
        {header}
        <div className="border-border text-muted-foreground flex flex-col items-center gap-2 rounded-xl border border-dashed py-10 text-center text-sm">
          <BarChart3 className="size-8 opacity-40" aria-hidden />
          <p className="text-foreground font-medium">{t('emptyTitle')}</p>
          <p>{t('emptyBody')}</p>
        </div>
      </div>
    );

  const { approval } = data;
  const stages = stageSeries(data.casesByStage, DEFAULT_STAGES);
  const days = avgDaysSeries(data.avgDaysPerStage, DEFAULT_STAGES);
  const declined = reasonSeries(data.declinedReasons, labels);
  const withdrawn = reasonSeries(data.withdrawnReasons, labels);
  const casesKey = t('series.cases');
  const daysKey = t('series.days');

  return (
    <TooltipProvider>
      <div className="space-y-4 pt-2">
        {header}
        <div className="border-border bg-card/60 grid grid-cols-2 gap-3 rounded-xl border p-3 sm:grid-cols-4 sm:p-4">
          <Tile
            icon={<BarChart3 className="text-muted-foreground size-4" />}
            label={t('tiles.total')}
            value={count(data.totalCases)}
          />
          <Tile
            icon={<Percent className="text-primary size-4" />}
            label={t('tiles.approvalRate')}
            value={percent(approval.rate, locale)}
            tooltip={t('tiles.approvalRateHint')}
          />
          <Tile
            icon={<CheckCircle2 className="text-primary size-4" />}
            label={t('tiles.approved')}
            value={count(approval.approved)}
          />
          <Tile
            icon={<XCircle className="text-destructive size-4" />}
            label={t('tiles.declined')}
            value={count(approval.declined)}
          />
          <Tile
            icon={<Undo2 className="text-muted-foreground size-4" />}
            label={t('tiles.withdrawn')}
            value={count(approval.withdrawn)}
          />
          <Tile
            icon={<AlertTriangle className="text-destructive size-4" />}
            label={t('tiles.overdue')}
            value={count(data.overdueCount)}
            tooltip={t('tiles.overdueHint')}
          />
          <Tile
            className="col-span-2"
            icon={<Wallet className="text-primary size-4" />}
            label={t('tiles.amount')}
            value={formatAed(Number(data.amountInPipeline), locale) ?? '—'}
            tooltip={t('tiles.amountHint')}
          />
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCard title={t('charts.byStage')} empty={stages.length === 0}>
            <BarChart
              data={stages.map((s) => ({
                stage: s.stage,
                [casesKey]: s.count,
              }))}
              index="stage"
              categories={[casesKey]}
              colors={['blue']}
              layout="vertical"
              valueFormatter={count}
              allowDecimals={false}
              showLegend={false}
              yAxisWidth={120}
              style={chartHeight(stages.length)}
            />
          </ChartCard>
          <ChartCard title={t('charts.avgDays')} empty={days.length === 0}>
            <BarChart
              data={days.map((d) => ({
                stage: d.stage,
                [daysKey]: d.avgDays,
                intervals: d.intervals,
              }))}
              index="stage"
              categories={[daysKey]}
              colors={['violet']}
              layout="vertical"
              valueFormatter={(v) => t('daysValue', { days: v })}
              showLegend={false}
              yAxisWidth={120}
              customTooltip={AvgDaysTooltip}
              style={chartHeight(days.length)}
            />
          </ChartCard>
          <ReasonChart
            title={t('charts.declined')}
            rows={declined}
            series={casesKey}
            color="pink"
            format={count}
          />
          <ReasonChart
            title={t('charts.withdrawn')}
            rows={withdrawn}
            series={casesKey}
            color="amber"
            format={count}
          />
        </div>
      </div>
    </TooltipProvider>
  );
}

function Tile({
  icon,
  label,
  value,
  tooltip,
  className,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tooltip?: string;
  className?: string;
}) {
  const t = useTranslations('Banks.dashboard');
  return (
    <div className={`bg-muted/50 min-w-0 rounded-lg p-3 ${className ?? ''}`}>
      <div className="text-muted-foreground flex items-center gap-1.5 text-[10px] font-medium tracking-wider uppercase">
        {icon}
        <span className="truncate">{label}</span>
        {tooltip && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={t('howCalculated', { label })}
                  className="text-muted-foreground hover:text-foreground ml-auto focus:outline-none"
                />
              }
            >
              <Info className="size-3" />
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs text-left">
              {tooltip}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      <p className="text-foreground mt-1 truncate text-base font-semibold tabular-nums">
        {value}
      </p>
    </div>
  );
}

function ChartCard({
  title,
  empty,
  children,
}: {
  title: string;
  empty: boolean;
  children: React.ReactNode;
}) {
  const t = useTranslations('Banks.dashboard');
  return (
    <section className="border-border bg-card min-w-0 rounded-xl border p-3 sm:p-4">
      <h3 className="text-muted-foreground mb-2 text-xs font-medium">
        {title}
      </h3>
      {empty ? (
        <p className="text-muted-foreground py-6 text-center text-sm">
          {t('noData')}
        </p>
      ) : (
        children
      )}
    </section>
  );
}

function ReasonChart({
  title,
  rows,
  series,
  color,
  format,
}: {
  title: string;
  rows: ReturnType<typeof reasonSeries>;
  series: string;
  color: AvailableChartColorsKeys;
  format: (n: number) => string;
}) {
  return (
    <ChartCard title={title} empty={rows.length === 0}>
      <BarChart
        data={rows.map((r) => ({ reason: r.label, [series]: r.count }))}
        index="reason"
        categories={[series]}
        colors={[color]}
        layout="vertical"
        valueFormatter={format}
        allowDecimals={false}
        showLegend={false}
        yAxisWidth={140}
        style={chartHeight(rows.length)}
      />
    </ChartCard>
  );
}

/** The average-days tooltip: the figure and how many stays it rests on. */
function AvgDaysTooltip({ active, payload, label }: TooltipProps) {
  const t = useTranslations('Banks.dashboard');
  const item = payload?.[0];
  if (!active || !item) return null;
  const intervals = Number(
    (item.payload as { intervals?: unknown } | undefined)?.intervals ?? 0
  );
  return (
    <div className="border-border bg-popover text-popover-foreground rounded-md border px-3 py-2 text-sm shadow-md">
      <p className="font-medium">{label}</p>
      <p className="tabular-nums">{t('daysValue', { days: item.value })}</p>
      <p className="text-muted-foreground text-xs">
        {t('intervals', { count: intervals })}
      </p>
    </div>
  );
}
