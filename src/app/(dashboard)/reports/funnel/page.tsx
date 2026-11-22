'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import dynamic from 'next/dynamic';
import {
  Download,
  Filter,
  Info,
  Loader2,
  RefreshCw,
  Undo2,
  XCircle,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { EmptyState } from '@/components/dashboard/empty-state';
import { Skeleton, SkeletonCard } from '@/components/dashboard/skeleton';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  FUNNEL_BANK_METRICS,
  FUNNEL_LEAD_SOURCES,
  FUNNEL_METRICS,
  FUNNEL_RANGE_PRESETS,
  DEFAULT_FUNNEL_RANGE,
  NO_LEAD_SOURCE,
  conversionSteps,
  fillFunnelDays,
  funnelQueryString,
  isFunnelLeadSource,
  percentOf,
  zonedDay,
  type FunnelBankRow,
  type FunnelFilters,
  type FunnelLeadSource,
  type FunnelMetric,
  type FunnelOption,
  type FunnelReport,
  type FunnelRow,
} from '@/lib/reports/funnel';
import type { RangePreset } from '@/lib/team-activity/range';
import { cn } from '@/lib/utils';

// recharts is heavy and only the daily chart uses it here: its own
// chunk, client-only, behind a skeleton the chart's size.
const BarChart = dynamic(
  () => import('@/components/tremor/bar-chart').then((m) => m.BarChart),
  { ssr: false, loading: () => <Skeleton className="h-[220px] w-full" /> }
);

interface Loaded {
  report: FunnelReport;
  range: { preset: RangePreset; from: string; to: string; tz: string };
}

type LoadError = 'load' | 'notMigrated';

const ALL = 'all';

function viewerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function shortDay(day: string): string {
  // YYYY-MM-DD → DD/MM, without a time zone round trip.
  const [, m, d] = day.split('-');
  return d && m ? `${d}/${m}` : day;
}

// A fixed locale: the server render and the browser must print the same digits.
const nf = new Intl.NumberFormat('en-US');

export default function FunnelReportPage() {
  const t = useTranslations('FunnelReport');
  const tSource = useTranslations('ContactsTable.source');

  const [range, setRange] = useState<RangePreset>(DEFAULT_FUNNEL_RANGE);
  const [leadSource, setLeadSource] = useState<string>(ALL);
  const [agent, setAgent] = useState<string>(ALL);
  const [bank, setBank] = useState<string>(ALL);
  const [channel, setChannel] = useState<string>(ALL);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const filters: FunnelFilters = useMemo(
    () => ({
      range,
      leadSource: isFunnelLeadSource(leadSource) ? leadSource : null,
      agent: agent === ALL ? null : agent,
      bank: bank === ALL ? null : bank,
      channel: channel === ALL ? null : channel,
      // The viewer's zone is added at request time (never rendered,
      // so the server and the browser agree on the markup).
      tz: null,
    }),
    [range, leadSource, agent, bank, channel]
  );
  const withZone = useCallback(
    () => funnelQueryString({ ...filters, tz: viewerZone() }),
    [filters]
  );

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/reports/funnel?${withZone()}`)
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as
          (Loaded & { error?: string }) | null;
        if (cancelled) return;
        if (!res.ok || !body?.report) {
          setError(res.status === 503 ? 'notMigrated' : 'load');
          return;
        }
        setError(null);
        setLoaded({ report: body.report, range: body.range });
      })
      .catch(() => {
        if (!cancelled) setError('load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [withZone, reloadKey]);

  const reload = useCallback(() => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  }, []);

  // Every filter change refetches; the spinner shows while it does.
  const change = (set: (v: string) => void) => (v: unknown) => {
    setLoading(true);
    set(typeof v === 'string' && v ? v : ALL);
  };

  const sourceLabel = useCallback(
    (key: string | null): string => {
      const k = key ?? NO_LEAD_SOURCE;
      if (k === NO_LEAD_SOURCE) return t('filters.noSource');
      return isFunnelLeadSource(k) ? tSource(k) : k;
    },
    [t, tSource]
  );

  const report = loaded?.report ?? null;
  const options = report?.options ?? { agents: [], numbers: [], banks: [] };

  const optionItems = (all: string, list: FunnelOption[]) => ({
    [ALL]: all,
    ...Object.fromEntries(
      list.map((o) => [o.id, o.name ?? t('filters.unnamed')])
    ),
  });
  const periodItems = Object.fromEntries(
    FUNNEL_RANGE_PRESETS.map((p) => [p, t(`periods.${p}`)])
  ) as Record<string, string>;
  const sourceItems: Record<string, string> = {
    [ALL]: t('filters.allSources'),
    ...Object.fromEntries(
      FUNNEL_LEAD_SOURCES.map((s: FunnelLeadSource) => [s, sourceLabel(s)])
    ),
  };
  const agentItems = optionItems(t('filters.allAgents'), options.agents);
  const bankItems = optionItems(t('filters.allBanks'), options.banks);
  const numberItems = optionItems(t('filters.allNumbers'), options.numbers);

  const days = useMemo(() => {
    if (!loaded) return [];
    const { from, to, tz } = loaded.range;
    const last = new Date(Math.max(Date.parse(from), Date.parse(to) - 1));
    return fillFunnelDays(
      loaded.report.daily,
      zonedDay(new Date(from), tz),
      zonedDay(last, tz)
    );
  }, [loaded]);

  return (
    <div className="min-w-0 space-y-6">
      {/* Controls */}
      <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <FilterSelect
            label={t('period')}
            value={range}
            items={periodItems}
            onChange={change((v) =>
              setRange(
                (FUNNEL_RANGE_PRESETS as readonly string[]).includes(v)
                  ? (v as RangePreset)
                  : DEFAULT_FUNNEL_RANGE
              )
            )}
          />
          <FilterSelect
            label={t('filters.leadSource')}
            value={leadSource}
            items={sourceItems}
            onChange={change(setLeadSource)}
          />
          <FilterSelect
            label={t('filters.agent')}
            value={agent}
            items={agentItems}
            onChange={change(setAgent)}
          />
          <FilterSelect
            label={t('filters.bank')}
            value={bank}
            items={bankItems}
            onChange={change(setBank)}
          />
          <FilterSelect
            label={t('filters.number')}
            value={channel}
            items={numberItems}
            onChange={change(setChannel)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon-lg"
            onClick={reload}
            disabled={loading}
            aria-label={t('refresh')}
          >
            {loading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="lg"
            onClick={() =>
              window.location.assign(`/api/reports/funnel/export?${withZone()}`)
            }
          >
            <Download className="size-4" />
            {t('download')}
          </Button>
        </div>
      </div>

      {/* Cohort definition */}
      <div className="border-border bg-card text-muted-foreground flex gap-3 rounded-xl border px-4 py-3 text-sm">
        <Info className="text-info mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="min-w-0 space-y-1">
          <p>{t('cohortNote')}</p>
          {report && report.interestedTagId === null && (
            <p className="text-warning">{t('noInterestedTag')}</p>
          )}
          {filters.bank && <p>{t('bankNote')}</p>}
        </div>
      </div>

      {error && (
        <div className="border-destructive/30 bg-destructive-soft text-destructive flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm">
          <span>
            {error === 'notMigrated' ? t('notMigrated') : t('loadFailed')}
          </span>
          {error === 'load' && (
            <Button type="button" variant="outline" onClick={reload}>
              {t('retry')}
            </Button>
          )}
        </div>
      )}

      {!report ? (
        loading ? (
          <FunnelSkeleton />
        ) : null
      ) : report.totals.new_chats === 0 ? (
        <EmptyState
          icon={Filter}
          title={t('empty.title')}
          hint={t('empty.hint')}
        />
      ) : (
        <div
          className={cn(
            'space-y-6 transition-opacity',
            loading && 'opacity-60'
          )}
          aria-busy={loading}
        >
          <div className="grid min-w-0 gap-6 lg:grid-cols-3">
            <FunnelBars report={report} />
            <SideOutcomes report={report} />
          </div>
          <DailyChart days={days} />
          <div className="grid min-w-0 gap-6 2xl:grid-cols-2">
            <BreakdownTable
              title={t('breakdown.bySource')}
              rows={report.bySource}
              nameOf={(r) => sourceLabel(r.key)}
            />
            <BreakdownTable
              title={t('breakdown.byAgent')}
              rows={report.byAgent}
              nameOf={(r) =>
                r.name ??
                (r.key ? t('filters.unnamed') : t('breakdown.unassigned'))
              }
            />
            <BreakdownTable
              title={t('breakdown.byNumber')}
              rows={report.byNumber}
              nameOf={(r) =>
                r.name ??
                (r.key ? t('filters.unnamed') : t('breakdown.noNumber'))
              }
            />
            <BankTable rows={report.byBank} />
          </div>
        </div>
      )}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  items,
  onChange,
}: {
  label: string;
  value: string;
  items: Record<string, string>;
  onChange: (v: unknown) => void;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-muted-foreground text-xs font-medium">{label}</span>
      <Select value={value} onValueChange={onChange} items={items}>
        <SelectTrigger className="w-full min-w-0 lg:w-40" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(items).map(([v, l]) => (
            <SelectItem key={v} value={v}>
              {l}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

function Card({
  title,
  hint,
  className,
  children,
}: {
  title: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        'border-border bg-card min-w-0 rounded-xl border',
        className
      )}
    >
      <header className="border-border border-b px-4 py-3 sm:px-5">
        <h2 className="text-foreground text-sm font-semibold">{title}</h2>
        {hint && <p className="text-muted-foreground mt-0.5 text-xs">{hint}</p>}
      </header>
      {children}
    </section>
  );
}

function FunnelBars({ report }: { report: FunnelReport }) {
  const t = useTranslations('FunnelReport');
  const steps = conversionSteps(report.totals);
  return (
    <Card title={t('funnelTitle')} className="lg:col-span-2">
      <ol className="space-y-4 p-4 sm:p-5">
        {steps.map((s) => (
          <li key={s.stage}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="text-foreground font-medium">
                {t(`stages.${s.stage}`)}
              </span>
              <span className="text-foreground font-semibold tabular-nums">
                {nf.format(s.count)}
              </span>
            </div>
            <div
              className="bg-muted mt-1.5 h-3 overflow-hidden rounded-full"
              aria-hidden
            >
              <div
                className={cn(
                  'bg-primary h-full rounded-full',
                  s.count > 0 && 'min-w-1'
                )}
                style={{ width: `${Math.min(100, s.ofNewChats ?? 0)}%` }}
              />
            </div>
            <p className="text-muted-foreground mt-1 flex flex-wrap gap-x-3 text-xs">
              {s.stage !== 'new_chats' && (
                <span>
                  {s.ofPrevious === null
                    ? t('noRate')
                    : t('ofPrevious', { pct: s.ofPrevious })}
                </span>
              )}
              <span>
                {s.ofNewChats === null
                  ? t('noRate')
                  : t('ofNewChats', { pct: s.ofNewChats })}
              </span>
            </p>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function SideOutcomes({ report }: { report: FunnelReport }) {
  const t = useTranslations('FunnelReport');
  const items = [
    {
      key: 'declined' as const,
      Icon: XCircle,
      tone: 'text-destructive bg-destructive-soft',
    },
    {
      key: 'withdrawn' as const,
      Icon: Undo2,
      tone: 'text-muted-foreground bg-muted',
    },
  ];
  return (
    <Card title={t('sideTitle')} hint={t('sideHint')}>
      <ul className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-1">
        {items.map(({ key, Icon, tone }) => {
          const n = report.totals[key];
          const pct = percentOf(n, report.totals.new_chats);
          return (
            <li
              key={key}
              className="border-border bg-card-2 flex items-center gap-3 rounded-lg border p-3"
            >
              <span
                className={cn(
                  'flex size-9 shrink-0 items-center justify-center rounded-full',
                  tone
                )}
                aria-hidden
              >
                <Icon className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="text-foreground text-sm font-medium">
                  {t(`stages.${key}`)}
                </p>
                <p className="text-muted-foreground text-xs">
                  <span className="text-foreground text-base font-semibold tabular-nums">
                    {nf.format(n)}
                  </span>{' '}
                  {pct === null ? t('noRate') : t('ofNewChats', { pct })}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function DailyChart({ days }: { days: { day: string; newChats: number }[] }) {
  const t = useTranslations('FunnelReport');
  const label = t('stages.new_chats');
  const data = days.map((d) => ({ day: shortDay(d.day), [label]: d.newChats }));
  return (
    <Card title={t('dailyTitle')} hint={t('dailyDescription')}>
      <div className="p-4 sm:p-5">
        <BarChart
          data={data}
          index="day"
          categories={[label]}
          colors={['blue']}
          showLegend={false}
          allowDecimals={false}
          yAxisWidth={32}
          className="h-[220px]"
        />
      </div>
    </Card>
  );
}

const ROW_METRICS: readonly FunnelMetric[] = FUNNEL_METRICS;

function BreakdownTable({
  title,
  rows,
  nameOf,
}: {
  title: string;
  rows: FunnelRow[];
  nameOf: (row: FunnelRow) => string;
}) {
  const t = useTranslations('FunnelReport');
  return (
    <Card title={title}>
      {rows.length === 0 ? (
        <p className="text-muted-foreground px-5 py-8 text-center text-sm">
          {t('breakdown.empty')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-border text-muted-foreground border-b text-left text-xs">
                <th scope="col" className="px-4 py-2 font-medium">
                  {t('breakdown.item')}
                </th>
                {ROW_METRICS.map((m) => (
                  <th
                    key={m}
                    scope="col"
                    className="px-3 py-2 text-right font-medium whitespace-nowrap"
                  >
                    {t(`stages.${m}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={r.key ?? `none-${i}`}
                  className="border-border border-b last:border-0"
                >
                  <th
                    scope="row"
                    className="text-foreground max-w-56 truncate px-4 py-2 text-left font-medium"
                  >
                    {nameOf(r)}
                  </th>
                  {ROW_METRICS.map((m) => (
                    <td
                      key={m}
                      className="text-foreground px-3 py-2 text-right tabular-nums"
                    >
                      {nf.format(r.counts[m])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function BankTable({ rows }: { rows: FunnelBankRow[] }) {
  const t = useTranslations('FunnelReport');
  return (
    <Card title={t('breakdown.byBank')} hint={t('breakdown.bankHint')}>
      {rows.length === 0 ? (
        <p className="text-muted-foreground px-5 py-8 text-center text-sm">
          {t('breakdown.empty')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-border text-muted-foreground border-b text-left text-xs">
                <th scope="col" className="px-4 py-2 font-medium">
                  {t('breakdown.item')}
                </th>
                {FUNNEL_BANK_METRICS.map((m) => (
                  <th
                    key={m}
                    scope="col"
                    className="px-3 py-2 text-right font-medium whitespace-nowrap"
                  >
                    {t(`stages.${m}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={r.key ?? `none-${i}`}
                  className="border-border border-b last:border-0"
                >
                  <th
                    scope="row"
                    className="text-foreground max-w-56 truncate px-4 py-2 text-left font-medium"
                  >
                    {r.name ?? r.key ?? t('breakdown.noBank')}
                  </th>
                  {FUNNEL_BANK_METRICS.map((m) => (
                    <td
                      key={m}
                      className="text-foreground px-3 py-2 text-right tabular-nums"
                    >
                      {nf.format(r.counts[m])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function FunnelSkeleton() {
  return (
    <div className="space-y-6" aria-hidden>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="border-border bg-card space-y-4 rounded-xl border p-5 lg:col-span-2">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-full" />
            </div>
          ))}
        </div>
        <SkeletonCard />
      </div>
      <Skeleton className="h-[280px] w-full rounded-xl" />
    </div>
  );
}
