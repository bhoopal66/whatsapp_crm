'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Download,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
} from 'lucide-react';

import { Skeleton } from '@/components/dashboard/skeleton';
import { useAuth } from '@/hooks/use-auth';
import { hasMinRole } from '@/lib/auth/roles';
import {
  CALL_REPORT_OUTCOMES,
  checkCustomDays,
  type CallStatsPeriod,
} from '@/lib/pbx/call-report';
import {
  TALK_BUCKET_KEYS,
  delta,
  formatDuration,
  formatPercent,
  type CallStats,
  type CallStatsPerson,
} from '@/lib/pbx/call-stats';
import {
  CALL_LIST_PAGE,
  DAILY_SERIES,
  DETAIL_KPI_KEYS,
  EVERYONE,
  HERO_TILES,
  KPI_KEYS,
  PEOPLE_SORT_KEYS,
  POINT_DELTA_KEYS,
  callListQuery,
  deltaPoints,
  zoneDay,
  deltaTone,
  heatLevel,
  heatmapMatrix,
  heroTileValue,
  isSingleDay,
  kpiValue,
  mergeCalls,
  nextPageTo,
  periodButtons,
  readReportParams,
  reportSearch,
  reportView,
  sortPeople,
  statsCsvRows,
  statsQuery,
  toCsv,
  type CsvValue,
  type DailyPoint,
  type KpiKey,
  type PeopleSortKey,
  type ReportParams,
  type SortDir,
  type StatsCsvLabels,
} from '@/lib/pbx/call-stats-ui';
import { callTone } from '@/lib/pbx/timeline';
import { cn } from '@/lib/utils';

// recharts is heavy: its own chunk, client-only, behind a skeleton.
const DailyTrendChart = dynamic(
  () => import('./call-stats-charts').then((m) => m.DailyTrendChart),
  { ssr: false, loading: () => <Skeleton className="h-[260px] w-full" /> }
);
const BarChart = dynamic(
  () => import('@/components/tremor/bar-chart').then((m) => m.BarChart),
  { ssr: false, loading: () => <Skeleton className="h-[220px] w-full" /> }
);

interface Range {
  from: string;
  to: string;
  timeZone: string;
}
interface Loaded {
  key: string;
  stats?: CallStats;
  range?: Range;
  error?: 'forbidden' | 'migration' | 'failed';
}
interface ListCall {
  id: string;
  direction: string;
  status: string;
  startedAt: string;
  answeredAt: string | null;
  ringSeconds: number | null;
  talkSeconds: number | null;
  remoteNumber: string | null;
  contactId: string | null;
  contactName: string | null;
  userId: string | null;
  userName: string | null;
  disposition: string | null;
  notes: string | null;
  recordingState: string;
}
interface CallList {
  key: string;
  calls: ListCall[];
  more: boolean;
  failed: boolean;
  loading: boolean;
}

const card = 'border-border bg-card rounded-xl border';
/** localStorage: whether "More details" was left open. */
const DETAILS_KEY = 'callReport.detailsOpen';
const OUTCOME_KEYS = CALL_REPORT_OUTCOMES.filter((o) => o !== 'none');

function download(name: string, rows: CsvValue[][]) {
  // The BOM makes Excel read the file as UTF-8 (Korean, Arabic names).
  const blob = new Blob(['﻿', toCsv(rows)], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** YYYY-MM-DD → DD/MM, without a time zone round trip. */
const shortDay = (day: string) => {
  const [, m, d] = day.split('-');
  return d && m ? `${d}/${m}` : day;
};

/** /calls/report: the Call report (module 015, migration 119). */
export function CallStatsReport() {
  const t = useTranslations('CallStatsPage');
  const tOutcome = useTranslations('PbxCall.outcomes');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const { accountRole, user } = useAuth();
  const leader = !!accountRole && hasMinRole(accountRole, 'team_leader');
  const viewerZone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    []
  );
  const ownId = user?.id ?? null;
  // Below team leader there is only me: a shared link to someone else
  // or to everyone still opens on the reader's own calls.
  const params = useMemo(() => {
    const p = readReportParams((k) => search.get(k));
    return leader ? p : { ...p, user: null };
  }, [search, leader]);
  const view = reportView(params, ownId);
  const setParams = (next: Partial<ReportParams>) => {
    const qs = reportSearch({ ...params, ...next });
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  // The custom days being typed, before Apply puts them in the URL.
  const [draft, setDraft] = useState({
    from: params.from ?? '',
    to: params.to ?? '',
  });
  const [customOpen, setCustomOpen] = useState(params.period === 'custom');
  const shownPeriod: CallStatsPeriod = customOpen ? 'custom' : params.period;

  const query = statsQuery(params, viewerZone, ownId);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // The person picker's names: the people of the last load for everyone.
  const [people, setPeople] = useState<CallStatsPerson[]>([]);

  useEffect(() => {
    if (!query) return;
    let cancelled = false;
    fetch(`/api/pbx/calls/stats?${query}`)
      .then(async (r) => {
        if (!r.ok)
          throw new Error(
            r.status === 403
              ? 'forbidden'
              : r.status === 503
                ? 'migration'
                : 'failed'
          );
        return r.json();
      })
      .then((body: { stats: CallStats; range: Range }) => {
        if (cancelled) return;
        setLoaded({ key: query, stats: body.stats, range: body.range });
        if (body.stats.people)
          setPeople(body.stats.people.filter((p) => p.kind === 'person'));
      })
      .catch((err: Error) => {
        if (!cancelled)
          setLoaded({
            key: query,
            error:
              err.message === 'forbidden' || err.message === 'migration'
                ? err.message
                : 'failed',
          });
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  // The "Showing" picker's people, for a leader: one load for everyone
  // (today, the cheapest), since the default view of me has no people.
  useEffect(() => {
    if (!leader) return;
    let cancelled = false;
    const q = new URLSearchParams({ period: 'today', tz: viewerZone });
    fetch(`/api/pbx/calls/stats?${q}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { stats?: CallStats } | null) => {
        if (!cancelled && body?.stats?.people)
          setPeople(body.stats.people.filter((p) => p.kind === 'person'));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [leader, viewerZone]);

  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem(DETAILS_KEY) === '1') setDetailsOpen(true);
    } catch {
      // Storage refused (private mode): start closed.
    }
  }, []);
  const toggleDetails = () => {
    const next = !detailsOpen;
    setDetailsOpen(next);
    try {
      localStorage.setItem(DETAILS_KEY, next ? '1' : '0');
    } catch {
      // Not remembered; the toggle still works.
    }
  };

  const current = query && loaded?.key === query ? loaded : null;
  const stats = current?.stats;
  const range = current?.range;

  // ---------- The call list ----------
  const listKey =
    stats && range
      ? callListQuery(
          stats.scope,
          stats.userId,
          range,
          CALL_LIST_PAGE,
          stats.people,
          user?.id ?? null
        )
      : null;
  const [list, setList] = useState<CallList | null>(null);
  const loadCalls = (key: string, to: string | null, prev: ListCall[]) => {
    const q = new URLSearchParams(key);
    if (to) q.set('to', to);
    setList({ key, calls: prev, more: false, failed: false, loading: true });
    fetch(`/api/pbx/calls?${q}`)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((body: { calls?: ListCall[] }) => {
        const page = body.calls ?? [];
        const calls = mergeCalls(prev, page);
        setList((l) =>
          l?.key === key
            ? {
                key,
                calls,
                more:
                  page.length === CALL_LIST_PAGE && calls.length > prev.length,
                failed: false,
                loading: false,
              }
            : l
        );
      })
      .catch(() =>
        setList((l) =>
          l?.key === key
            ? { key, calls: prev, more: true, failed: true, loading: false }
            : l
        )
      );
  };
  useEffect(() => {
    if (listKey) loadCalls(listKey, null, []);
  }, [listKey]);
  // No key: nothing to list (a team with nobody on it), not a pending load.
  const noCalls = !!stats && !!range && !listKey;
  const shownList = list?.key === listKey ? list : null;

  // ---------- People table sort ----------
  const [sort, setSort] = useState<{ key: PeopleSortKey; dir: SortDir }>({
    key: 'talkTotal',
    dir: 'desc',
  });
  const sortedPeople = useMemo(
    () => (stats?.people ? sortPeople(stats.people, sort.key, sort.dir) : null),
    [stats, sort]
  );

  // ---------- Formatting ----------
  const zone = range?.timeZone ?? viewerZone;
  const dayFmt = (iso: string) =>
    new Intl.DateTimeFormat(locale, {
      timeZone: zone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(new Date(iso));
  // A day, with the time of day only when it is not midnight in the zone.
  const dayTime = (iso: string) => {
    const at = new Date(iso);
    const clock = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(at);
    return clock === '00:00' ? dayFmt(iso) : `${dayFmt(iso)}, ${clock}`;
  };
  const timeFmt = (iso: string | null) =>
    iso
      ? new Intl.DateTimeFormat(locale, {
          timeZone: zone,
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        }).format(new Date(iso))
      : '—';
  const nf = (n: number) => new Intl.NumberFormat(locale).format(n);
  const personName = (p: { kind: string; fullName: string | null }) =>
    p.kind === 'none'
      ? t('people.unassigned')
      : (p.fullName ?? t('people.unnamed'));

  const kpiText = (key: KpiKey, v: number | null) =>
    key === 'answerRate'
      ? formatPercent(v)
      : key === 'talkTotal' ||
          key === 'talkAverage' ||
          key === 'longest' ||
          key === 'ringAverage'
        ? formatDuration(v)
        : v === null
          ? '—'
          : nf(v);

  const title = view === 'me' ? t('myTitle') : t('title');
  const subtitle =
    view === 'me'
      ? t('mySubtitle')
      : !stats
        ? null
        : stats.scope === 'person'
          ? (people.find((p) => p.userId === stats.userId)?.fullName ??
            stats.longest.find((c) => c.userId === stats.userId)?.userName ??
            t('scope.onePerson'))
          : t(`scope.${stats.scope}`);
  const lastDay = (r: Range) =>
    dayFmt(new Date(Date.parse(r.to) - 1).toISOString());

  // ---------- CSV ----------
  const csvName = (what: string) =>
    `${what}-${range ? zoneDay(range.from, range.timeZone) : 'period'}.csv`;
  const exportCsv = () => {
    if (!stats) return;
    const L: StatsCsvLabels = {
      section: {
        summary: t('csv.summary'),
        days: t('csv.days'),
        people: t('csv.people'),
      },
      metric: t('csv.metric'),
      current: t('csv.current'),
      previous: t('csv.previous'),
      kpi: Object.fromEntries(
        KPI_KEYS.map((k) => [k, t(`kpi.${k}`)])
      ) as StatsCsvLabels['kpi'],
      day: t('csv.day'),
      dayColumns: {
        calls: t('people.columns.calls'),
        inboundAnswered: t('charts.inboundAnswered'),
        outbound: t('charts.outbound'),
        outboundAnswered: t('csv.outboundAnswered'),
        missed: t('charts.missed'),
        talkSeconds: t('csv.talkSeconds'),
      },
      person: t('people.columns.name'),
      extension: t('people.columns.extension'),
      peopleColumns: {
        calls: t('people.columns.calls'),
        inboundAnswered: t('people.columns.inboundAnswered'),
        outbound: t('people.columns.outbound'),
        missed: t('people.columns.missed'),
        answerRate: t('people.columns.answerRate'),
        talkTotal: t('people.columns.talkTotal'),
        talkAverage: t('people.columns.talkAverage'),
        longest: t('people.columns.longest'),
        ringAverage: t('people.columns.ringAverage'),
      },
      unassigned: t('people.unassigned'),
      unnamed: t('people.unnamed'),
      total: t('people.total'),
    };
    const calls = shownList?.calls ?? [];
    download(csvName('call-report'), [
      [title, subtitle],
      range ? [dayFmt(range.from), lastDay(range), range.timeZone] : [],
      [t('csv.secondsNote')],
      [],
      ...statsCsvRows(stats, L),
      [],
      [t('csv.calls')],
      [
        t('csv.started'),
        t('list.columns.direction'),
        t('csv.customer'),
        t('csv.number'),
        t('csv.agent'),
        t('list.columns.status'),
        t('csv.ringSeconds'),
        t('csv.talkSeconds'),
        t('list.columns.outcome'),
      ],
      ...calls.map((c) => [
        c.startedAt,
        c.direction,
        c.contactName,
        c.remoteNumber,
        c.userName,
        c.status,
        c.ringSeconds,
        c.talkSeconds,
        c.disposition,
      ]),
    ]);
  };

  // ---------- Pieces ----------
  const header = (
    <div className="space-y-3">
      <Link
        href="/calls"
        className="text-muted-foreground inline-flex items-center gap-1 text-sm hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden />
        {t('back')}
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold">{title}</h1>
          {subtitle && (
            <p className="text-muted-foreground text-sm">{subtitle}</p>
          )}
        </div>
        <button
          type="button"
          onClick={exportCsv}
          disabled={!stats}
          className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm disabled:opacity-50"
        >
          <Download className="size-4" aria-hidden />
          {t('exportCsv')}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {periodButtons(params.period).map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={shownPeriod === p}
            onClick={() => {
              if (p === 'custom') return setCustomOpen(true);
              setCustomOpen(false);
              setParams({ period: p, from: null, to: null });
            }}
            className={cn(
              'focus-visible:ring-ring/50 rounded-full border px-3 py-1 text-sm transition-colors outline-none focus-visible:ring-3',
              shownPeriod === p
                ? 'border-primary/40 bg-primary-soft text-primary font-medium'
                : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            {t(`periods.${p}`)}
          </button>
        ))}
        {leader && (
          <label className="text-muted-foreground flex items-center gap-2 text-sm sm:ml-auto">
            {t('showing')}
            <select
              value={params.user ?? ''}
              onChange={(e) => setParams({ user: e.target.value || null })}
              className="border-input bg-card text-foreground max-w-[14rem] rounded-md border px-2 py-1 text-sm"
            >
              <option value="">{t('me')}</option>
              <option value={EVERYONE}>{t('everyone')}</option>
              {view === 'person' &&
                params.user &&
                !people.some((p) => p.userId === params.user) && (
                  <option value={params.user}>{subtitle ?? '…'}</option>
                )}
              {people
                .filter((p) => p.userId !== ownId)
                .map((p) => (
                  <option key={p.userId} value={p.userId ?? ''}>
                    {personName(p)}
                    {p.extension ? ` (${p.extension})` : ''}
                  </option>
                ))}
            </select>
          </label>
        )}
      </div>
      {shownPeriod === 'custom' && (
        <CustomDays
          draft={draft}
          setDraft={setDraft}
          onApply={() =>
            setParams({ period: 'custom', from: draft.from, to: draft.to })
          }
        />
      )}
    </div>
  );

  const deltaBadge = (
    k: KpiKey,
    now: number | null,
    before: number | null,
    label: string,
    title?: string
  ) => {
    const d = delta(now, before);
    // Under half a point rounds to 0: no arrow, no colour.
    if (
      !d ||
      d.direction === 'flat' ||
      (POINT_DELTA_KEYS.has(k) && deltaPoints(d.abs) === 0)
    )
      return null;
    const tone = deltaTone(k, d);
    return (
      <p
        title={title ?? label}
        className={cn(
          'mt-1 inline-flex items-center gap-0.5 text-xs font-medium',
          tone === 'good' && 'text-success',
          tone === 'bad' && 'text-destructive'
        )}
      >
        {d.direction === 'up' ? (
          <ArrowUp className="size-3" aria-hidden />
        ) : (
          <ArrowDown className="size-3" aria-hidden />
        )}
        {POINT_DELTA_KEYS.has(k)
          ? t(d.direction === 'up' ? 'pointsUp' : 'pointsDown', {
              n: deltaPoints(d.abs),
            })
          : d.pct === null
            ? t('newFigure')
            : formatPercent(Math.abs(d.pct))}
        <span className="text-muted-foreground ml-1 font-normal">{label}</span>
      </p>
    );
  };

  // The previous window, as "Compared with …": a window ending at
  // midnight names its last day; one cut part-way through names the cut.
  const comparedWith =
    stats?.range.previousFrom && stats.range.previousTo
      ? t('comparedWith', {
          from: dayTime(stats.range.previousFrom),
          to:
            dayTime(stats.range.previousTo) === dayFmt(stats.range.previousTo)
              ? dayFmt(
                  new Date(Date.parse(stats.range.previousTo) - 1).toISOString()
                )
              : dayTime(stats.range.previousTo),
        })
      : undefined;

  const hero =
    stats &&
    (() => {
      const s = stats.summary;
      const periodLabel =
        params.period === 'custom' && range
          ? `${dayFmt(range.from)} – ${lastDay(range)}`
          : t(`periods.${params.period}`);
      const hint = (inbound: number, outbound: number) =>
        t('hint.calls', { inbound, outbound });
      return (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
          <div className={cn(card, 'p-5')}>
            <p className="text-muted-foreground text-sm">
              {t('hero.talkTime')}
            </p>
            <p className="mt-1 text-4xl font-bold tracking-tight tabular-nums">
              {formatDuration(s.talkSecondsTotal)}
            </p>
            <p className="text-muted-foreground mt-1 text-xs">
              {t('externalOnly', { period: periodLabel })}
            </p>
            {deltaBadge(
              'talkTotal',
              s.talkSecondsTotal,
              stats.previous.talkSecondsTotal,
              t(`compare.${params.period}`),
              comparedWith
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {HERO_TILES.map((k) => {
              const v = heroTileValue(s, k);
              return (
                <div key={k} className={cn(card, 'p-3')}>
                  <p className="text-muted-foreground text-xs">
                    {k === 'answered' ? t('hero.answered') : t(`kpi.${k}`)}
                  </p>
                  <p className="mt-1 text-xl font-semibold tabular-nums">
                    {k === 'talkAverage'
                      ? formatDuration(v)
                      : v === null
                        ? '—'
                        : nf(v)}
                  </p>
                  {k === 'calls' && (
                    <p className="text-muted-foreground text-xs">
                      {hint(s.inboundTotal, s.outboundTotal)}
                    </p>
                  )}
                  {k === 'answered' && (
                    <p className="text-muted-foreground text-xs">
                      {hint(s.inboundAnswered, s.outboundAnswered)}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      );
    })();

  const tiles = stats && (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {DETAIL_KPI_KEYS.map((k) => {
        const now = kpiValue(stats.summary, k);
        const s = stats.summary;
        const hint =
          k === 'outbound'
            ? t('hint.outbound', {
                answered: s.outboundAnswered,
                total: s.outboundTotal,
              })
            : k === 'answerRate'
              ? t('hint.answerRate', {
                  answered: s.inboundAnswered,
                  total: s.inboundTotal,
                })
              : null;
        return (
          <div key={k} className={cn(card, 'p-3')}>
            <p className="text-muted-foreground text-xs">{t(`kpi.${k}`)}</p>
            <p className="mt-1 text-xl font-semibold tabular-nums">
              {kpiText(k, now)}
            </p>
            {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
            {deltaBadge(
              k,
              now,
              kpiValue(stats.previous, k),
              t('vsPrevious'),
              comparedWith
            )}
          </div>
        );
      })}
    </div>
  );

  const section = (
    title: string,
    description: string | null,
    body: ReactNode,
    className?: string
  ) => (
    <section className={cn(card, 'flex min-w-0 flex-col', className)}>
      <header className="border-border border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && (
          <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>
        )}
      </header>
      <div className="min-w-0 p-4">{body}</div>
    </section>
  );

  const daily =
    stats &&
    section(
      t('charts.dailyTitle'),
      t('charts.dailyDescription'),
      <>
        <DailyTrendChart
          data={stats.byDay.map((d): DailyPoint => ({
            day: shortDay(d.day),
            inboundAnswered: d.inboundAnswered,
            outbound: d.outbound,
            missed: d.missed,
            talkMinutes: Math.round(d.talkSeconds / 6) / 10,
          }))}
          labels={{
            inboundAnswered: t('charts.inboundAnswered'),
            outbound: t('charts.outbound'),
            missed: t('charts.missed'),
            talkMinutes: t('charts.talkMinutes'),
          }}
        />
        <ul className="text-muted-foreground mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {DAILY_SERIES.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span className={cn('size-2 rounded-xs', s.bg)} aria-hidden />
              {t(`charts.${s.key}`)}
            </li>
          ))}
          <li className="flex items-center gap-1.5">
            <span className="h-0.5 w-3 bg-violet-500" aria-hidden />
            {t('charts.talkMinutes')}
          </li>
        </ul>
      </>
    );

  const heat =
    stats &&
    (() => {
      const { rows, max } = heatmapMatrix(stats.byHour);
      const shade = [
        'bg-muted',
        'bg-emerald-500/25',
        'bg-emerald-500/50',
        'bg-emerald-500/75',
        'bg-emerald-500',
      ];
      return section(
        t('charts.heatTitle'),
        t('charts.heatDescription'),
        <div className="overflow-x-auto">
          <div className="min-w-[36rem]">
            <div className="text-muted-foreground ml-9 grid grid-cols-24 gap-0.5 text-[10px]">
              {Array.from({ length: 24 }, (_, h) => (
                <span key={h} className="text-center">
                  {h % 3 === 0 ? h : ''}
                </span>
              ))}
            </div>
            {rows.map((row, i) => (
              <div key={i} className="mt-0.5 flex items-center gap-1">
                <span className="text-muted-foreground w-8 shrink-0 text-xs">
                  {t(`charts.days.${i + 1}` as 'charts.days.1')}
                </span>
                <div className="grid flex-1 grid-cols-24 gap-0.5">
                  {row.map((c) => {
                    const label = t('charts.heatCell', {
                      day: t(`charts.days.${c.dow}` as 'charts.days.1'),
                      hour: String(c.hour).padStart(2, '0'),
                      calls: c.calls,
                      answered: c.answered,
                      missed: c.missed,
                      talk: formatDuration(c.talkSeconds),
                    });
                    return (
                      <span
                        key={c.hour}
                        title={label}
                        aria-label={label}
                        className={cn(
                          'h-5 rounded-sm',
                          shade[heatLevel(c.calls, max)]
                        )}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
            <div className="text-muted-foreground mt-2 flex items-center justify-end gap-1 text-xs">
              {t('charts.less')}
              {shade.map((s) => (
                <span key={s} className={cn('size-3 rounded-sm', s)} />
              ))}
              {t('charts.more')}
            </div>
          </div>
        </div>
      );
    })();

  const callsLabel = t('charts.calls');
  const buckets =
    stats &&
    section(
      t('charts.talkTitle'),
      t('charts.talkDescription'),
      <BarChart
        data={TALK_BUCKET_KEYS.map((k) => ({
          bucket: t(`charts.buckets.${k}`),
          [callsLabel]: stats.talkBuckets.find((b) => b.key === k)?.calls ?? 0,
        }))}
        index="bucket"
        categories={[callsLabel]}
        colors={['blue']}
        allowDecimals={false}
        showLegend={false}
        yAxisWidth={32}
        className="h-[220px]"
      />
    );
  const outcomes =
    stats &&
    section(
      t('charts.outcomesTitle'),
      t('charts.outcomesDescription'),
      <BarChart
        data={[...OUTCOME_KEYS, 'none' as const].map((o) => ({
          outcome: o === 'none' ? t('charts.noOutcome') : tOutcome(o),
          [callsLabel]: stats.outcomes[o],
        }))}
        index="outcome"
        categories={[callsLabel]}
        colors={['violet']}
        layout="vertical"
        allowDecimals={false}
        showLegend={false}
        yAxisWidth={110}
        className="h-[220px]"
      />
    );

  const sortHeader = (k: PeopleSortKey) => {
    const active = sort.key === k;
    return (
      <th
        key={k}
        aria-sort={
          active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'
        }
        className={cn(
          'px-3 py-2 font-semibold whitespace-nowrap',
          k === 'name' || k === 'extension' ? 'text-left' : 'text-right'
        )}
      >
        <button
          type="button"
          onClick={() =>
            setSort({
              key: k,
              dir:
                active && sort.dir === 'desc'
                  ? 'asc'
                  : active
                    ? 'desc'
                    : k === 'name' || k === 'extension'
                      ? 'asc'
                      : 'desc',
            })
          }
          className="hover:text-foreground inline-flex items-center gap-0.5"
        >
          {t(`people.columns.${k}`)}
          {active &&
            (sort.dir === 'asc' ? (
              <ChevronUp className="size-3" aria-hidden />
            ) : (
              <ChevronDown className="size-3" aria-hidden />
            ))}
        </button>
      </th>
    );
  };
  const figures = PEOPLE_SORT_KEYS.filter(
    (k): k is Exclude<PeopleSortKey, 'name' | 'extension'> =>
      k !== 'name' && k !== 'extension'
  );
  const peopleTable = stats && sortedPeople && (
    <section className={cn(card, 'overflow-hidden')}>
      <header className="border-border border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{t('people.title')}</h2>
        <p className="text-muted-foreground mt-0.5 text-xs">
          {t('people.hint')}
        </p>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[56rem] text-sm">
          <thead className="text-muted-foreground border-border border-b text-xs">
            <tr>{PEOPLE_SORT_KEYS.map(sortHeader)}</tr>
          </thead>
          <tbody>
            {sortedPeople.map((p) => (
              <tr
                key={p.userId ?? 'none'}
                className="border-border hover:bg-muted/50 border-b"
              >
                <td className="px-3 py-2">
                  {p.kind === 'person' && p.userId ? (
                    <button
                      type="button"
                      onClick={() => setParams({ user: p.userId })}
                      className="text-left font-medium hover:underline"
                    >
                      {personName(p)}
                    </button>
                  ) : (
                    <span className="text-muted-foreground italic">
                      {personName(p)}
                    </span>
                  )}
                </td>
                <td className="text-muted-foreground px-3 py-2">
                  {p.extension ?? '—'}
                </td>
                {figures.map((k) => (
                  <td key={k} className="px-3 py-2 text-right tabular-nums">
                    {kpiText(k, kpiValue(p, k))}
                  </td>
                ))}
              </tr>
            ))}
            <tr className="bg-muted/50 font-semibold">
              <td className="px-3 py-2" colSpan={2}>
                {t('people.total')}
              </td>
              {figures.map((k) => (
                <td key={k} className="px-3 py-2 text-right tabular-nums">
                  {kpiText(k, kpiValue(stats.summary, k))}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );

  const who = (c: {
    contactId: string | null;
    contactName: string | null;
    remoteNumber: string | null;
  }) => {
    const name = c.contactName || c.remoteNumber || t('unknownNumber');
    return c.contactId ? (
      <Link
        href={`/contacts/${c.contactId}`}
        className="font-medium hover:underline"
      >
        {name}
      </Link>
    ) : (
      <span className="font-medium">{name}</span>
    );
  };
  const top =
    stats &&
    section(
      t('top.title'),
      null,
      stats.topNumbers.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('top.empty')}</p>
      ) : (
        <ol className="space-y-2 text-sm">
          {stats.topNumbers.map((n, i) => (
            <li
              key={`${n.contactId ?? n.remoteNumber}-${i}`}
              className="flex items-baseline justify-between gap-3"
            >
              <span className="min-w-0 truncate">
                {who(n)}
                {n.contactName && n.remoteNumber && (
                  <span className="text-muted-foreground ml-1 text-xs tabular-nums">
                    {n.remoteNumber}
                  </span>
                )}
              </span>
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                {t('top.detail', {
                  count: n.calls,
                  talk: formatDuration(n.talkSeconds),
                })}
              </span>
            </li>
          ))}
        </ol>
      )
    );
  const longest =
    stats &&
    section(
      t('longest.title'),
      null,
      stats.longest.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('longest.empty')}</p>
      ) : (
        <ol className="space-y-2 text-sm">
          {stats.longest.map((c) => (
            <li
              key={c.id}
              className="flex items-baseline justify-between gap-3"
            >
              <span className="min-w-0 truncate">
                {who(c)}
                <span className="text-muted-foreground ml-1 text-xs">
                  {[timeFmt(c.startedAt), stats.scope !== 'self' && c.userName]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <span className="shrink-0 font-medium tabular-nums">
                {formatDuration(c.talkSeconds)}
              </span>
            </li>
          ))}
        </ol>
      )
    );

  const showAgent = view === 'everyone';
  const singleDay = isSingleDay(params);
  // One day: the clock is enough; longer: the day too.
  const listTime = (iso: string) =>
    singleDay
      ? new Intl.DateTimeFormat(locale, {
          timeZone: zone,
          hour: '2-digit',
          minute: '2-digit',
        }).format(new Date(iso))
      : timeFmt(iso);
  const callList = stats && (
    <section className={cn(card, 'overflow-hidden')}>
      <header className="border-border border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{t('list.title')}</h2>
      </header>
      {noCalls ? (
        <p className="text-muted-foreground p-4 text-sm">{t('list.empty')}</p>
      ) : !shownList || (shownList.loading && shownList.calls.length === 0) ? (
        <div className="bg-muted m-4 h-16 animate-pulse rounded-xl" />
      ) : shownList.calls.length === 0 ? (
        <p
          className={cn(
            'p-4 text-sm',
            shownList.failed ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          {shownList.failed ? t('list.loadFailed') : t('list.empty')}
        </p>
      ) : (
        <>
          <ul className="divide-border divide-y text-sm">
            {shownList.calls.map((c) => {
              const missed = callTone(c) === 'missed';
              const answered =
                !missed && (c.answeredAt || (c.talkSeconds ?? 0) > 0);
              const outbound = c.direction === 'outbound';
              const Icon = missed
                ? PhoneMissed
                : outbound
                  ? PhoneOutgoing
                  : PhoneIncoming;
              return (
                <li key={c.id} className="flex items-center gap-3 px-4 py-2.5">
                  <Icon
                    className={cn(
                      'size-4 shrink-0',
                      missed ? 'text-destructive' : 'text-muted-foreground'
                    )}
                    aria-label={t(outbound ? 'list.outbound' : 'list.inbound')}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate">{who(c)}</p>
                    <p className="text-muted-foreground truncate text-xs">
                      {[
                        listTime(c.startedAt),
                        t(
                          missed
                            ? 'list.status.missed'
                            : answered
                              ? 'list.status.answered'
                              : 'list.status.unanswered'
                        ),
                        showAgent && (c.userName ?? '—'),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </div>
                  <span className="shrink-0 font-medium tabular-nums">
                    {formatDuration(c.talkSeconds)}
                  </span>
                </li>
              );
            })}
          </ul>
          {shownList.failed && (
            <p className="text-destructive px-4 pt-3 text-sm">
              {t('list.loadFailed')}
            </p>
          )}
          {shownList.more && listKey && (
            <div className="p-3 text-center">
              <button
                type="button"
                disabled={shownList.loading}
                onClick={() =>
                  loadCalls(
                    listKey,
                    nextPageTo(shownList.calls),
                    shownList.calls
                  )
                }
                className="border-border hover:bg-muted rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
              >
                {t('list.loadMore')}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-4 md:p-6">
      {header}
      {!query ? (
        params.period === 'custom' ? (
          <p className="text-muted-foreground text-sm">{t('pickDays')}</p>
        ) : (
          <div className="bg-muted h-40 animate-pulse rounded-xl" aria-hidden />
        )
      ) : !current ? (
        <div className="bg-muted h-40 animate-pulse rounded-xl" aria-hidden />
      ) : current.error ? (
        <p className="text-destructive text-sm">
          {current.error === 'forbidden'
            ? t('forbidden')
            : current.error === 'migration'
              ? t('needsMigration')
              : t('loadFailed')}
        </p>
      ) : !stats ? null : (
        <>
          {hero}
          {callList}
          {stats.summary.calls > 0 && (
            <>
              <button
                type="button"
                aria-expanded={detailsOpen}
                onClick={toggleDetails}
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm font-medium"
              >
                {detailsOpen ? t('details.hide') : t('details.show')}
                <ChevronDown
                  className={cn(
                    'size-4 transition-transform',
                    detailsOpen && 'rotate-180'
                  )}
                  aria-hidden
                />
              </button>
              {detailsOpen && (
                <div className="space-y-4">
                  {range && (
                    <p className="text-muted-foreground text-xs">
                      {t('range', {
                        from: dayFmt(range.from),
                        to: lastDay(range),
                        zone: range.timeZone,
                      })}
                      {comparedWith && ` · ${comparedWith}`}
                    </p>
                  )}
                  {tiles}
                  {!singleDay && daily}
                  {heat}
                  <div className="grid gap-4 lg:grid-cols-2">
                    {buckets}
                    {outcomes}
                  </div>
                  {showAgent && peopleTable}
                  <div className="grid gap-4 lg:grid-cols-2">
                    {top}
                    {longest}
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function CustomDays({
  draft,
  setDraft,
  onApply,
}: {
  draft: { from: string; to: string };
  setDraft: (f: (d: { from: string; to: string }) => typeof d) => void;
  onApply: () => void;
}) {
  const t = useTranslations('CallStatsPage');
  const problem = checkCustomDays(draft.from, draft.to);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem) onApply();
      }}
    >
      {(['from', 'to'] as const).map((k) => (
        <label key={k} className="text-muted-foreground text-xs">
          {t(k)}
          <input
            type="date"
            value={draft[k]}
            onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
            className="border-input bg-card text-foreground mt-1 block rounded-md border px-2 py-1 text-sm"
          />
        </label>
      ))}
      <button
        type="submit"
        disabled={problem !== null}
        className="bg-primary text-primary-foreground hover:bg-primary-hover rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50"
      >
        {t('apply')}
      </button>
      {problem && problem !== 'missing' && (
        <p className="text-destructive w-full text-xs">
          {t(`custom.${problem}`)}
        </p>
      )}
    </form>
  );
}
