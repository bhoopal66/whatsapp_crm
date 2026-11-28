'use client';

import { useEffect, useMemo, useState } from 'react';
import { Download, Info, Loader2, RefreshCw, Tags } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { EmptyState } from '@/components/dashboard/empty-state';
import { SkeletonCard } from '@/components/dashboard/skeleton';
import { ReportAccessCard } from '@/components/reports/report-access-card';
import { BarChart } from '@/components/tremor/bar-chart';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { isLeadSource } from '@/lib/leads/lead-source';
import {
  SPLITS,
  dailySeries,
  groupsTotal,
  isSplitKind,
  splitFor,
  splitName,
  splitRows,
  tagGroups,
  tagLabel,
  type ChatTagReport,
  type ReportTag,
  type SplitKind,
  type TagGroup,
} from '@/lib/reports/tag-report';
import { RANGE_PRESETS, type RangePreset } from '@/lib/team-activity/range';
import { cn } from '@/lib/utils';

interface Loaded {
  report: ChatTagReport;
  range: { preset: RangePreset; from: string; to: string; tz: string };
  canManageAccess: boolean;
}

function viewerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** A stored tag colour, only when it is a plain hex value. */
function safeColor(color: string | null | undefined): string | undefined {
  return color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : undefined;
}

function TagDot({ tag }: { tag: ReportTag | null }) {
  return (
    <span
      aria-hidden
      className="border-border bg-muted inline-block h-2.5 w-2.5 shrink-0 rounded-full border"
      style={{ backgroundColor: safeColor(tag?.color) }}
    />
  );
}

export default function ChatTagReportPage() {
  const t = useTranslations('TagReport');
  const locale = useLocale();

  const [preset, setPreset] = useState<RangePreset>('30d');
  const [split, setSplit] = useState<SplitKind>('agent');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<'denied' | 'failed' | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [zone] = useState(viewerZone);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ range: preset, tz: zone });
    void fetch(`/api/reports/tags?${params}`)
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as
          (Loaded & { error?: string }) | null;
        if (cancelled) return;
        if (!res.ok || !body?.report) {
          setError(res.status === 403 ? 'denied' : 'failed');
          return;
        }
        setError(null);
        setLoaded(body);
      })
      .catch(() => {
        if (!cancelled) setError('failed');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [preset, reloadKey, zone]);

  const choosePreset = (next: RangePreset) => {
    if (next === preset) return;
    setLoading(true);
    setPreset(next);
  };
  const reload = () => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  const report = loaded?.report ?? null;
  const tz = loaded?.range.tz ?? zone;
  const current = useMemo(
    () => (report ? tagGroups(report.tags, report.current) : []),
    [report]
  );
  const arrivals = useMemo(
    () => (report ? tagGroups(report.tags, report.arrivals) : []),
    [report]
  );
  const daily = useMemo(
    () =>
      report ? dailySeries(report) : { data: [], categories: [], colors: [] },
    [report]
  );

  const formatDay = (iso: string) => {
    try {
      return new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeZone: tz,
      }).format(new Date(iso));
    } catch {
      return iso.slice(0, 10);
    }
  };
  const chartData = useMemo(() => {
    let fmt: Intl.DateTimeFormat | null = null;
    try {
      fmt = new Intl.DateTimeFormat(locale, {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      });
    } catch {
      fmt = null;
    }
    return daily.data.map((row) => {
      const day = String(row.day);
      return {
        ...row,
        day: fmt ? fmt.format(new Date(`${day}T00:00:00Z`)) : day,
      };
    });
  }, [daily, locale]);

  const sourceLabel = (key: string) =>
    isLeadSource(key) ? t(`sources.${key}`) : t('sources.none');
  const splitLabels = {
    unassigned: t('unassigned'),
    noNumber: t('noNumber'),
    unknownName: t('unknownName'),
    source: sourceLabel,
  };
  const splitItems = Object.fromEntries(
    SPLITS.map((s) => [s, t(`splits.${s}`)])
  ) as Record<SplitKind, string>;

  const exportHref = `/api/reports/tags/export?${new URLSearchParams({
    range: preset,
    tz: zone,
  })}`;

  const tagName = (g: TagGroup) => g.tag?.name || t('unknownTag');
  const subName = (g: TagGroup, row: TagGroup['rows'][number]) =>
    tagLabel(
      tagName(g),
      row.subTagId ? (row.subTagName ?? t('unknownTag')) : t('noSubTag')
    );

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label={t('period')}
          className="border-border bg-card-2 flex max-w-full overflow-x-auto rounded-lg border p-0.5"
        >
          {RANGE_PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={preset === p}
              onClick={() => choosePreset(p)}
              className={cn(
                'shrink-0 rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors',
                preset === p
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {t(`periods.${p}`)}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={reload}
            disabled={loading}
            aria-label={t('refresh')}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            render={<a href={exportHref} download />}
            disabled={!report}
          >
            <Download className="mr-1 h-4 w-4" />
            {t('downloadCsv')}
          </Button>
        </div>
      </div>

      {error === 'denied' ? (
        <EmptyState
          title={t('deniedTitle')}
          hint={t('deniedHint')}
          icon={Tags}
        />
      ) : error === 'failed' && !report ? (
        <EmptyState title={t('loadFailed')} icon={Tags} />
      ) : !report ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <SkeletonCard className="h-64" />
          <SkeletonCard className="h-64" />
          <SkeletonCard className="h-64 lg:col-span-2" />
        </div>
      ) : (
        <>
          {error === 'failed' && (
            <p className="text-destructive text-sm">{t('loadFailed')}</p>
          )}
          <p className="border-border bg-info-soft text-info flex items-start gap-2 rounded-lg border px-3 py-2 text-xs">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {report.historySince
                ? t('historySince', { date: formatDay(report.historySince) })
                : t('historyUnknown')}{' '}
              {t('countsOnly')}
            </span>
          </p>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle className="text-base">
                  {t('current.title')}
                </CardTitle>
                <CardDescription>
                  {t('current.description', { count: groupsTotal(current) })}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {current.length === 0 ? (
                  <EmptyState
                    title={t('current.empty')}
                    hint={t('current.emptyHint')}
                    icon={Tags}
                  />
                ) : (
                  <TagCountList
                    groups={current}
                    tagName={tagName}
                    subName={subName}
                  />
                )}
              </CardContent>
            </Card>

            <Card className="min-w-0">
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle className="text-base">
                      {t('split.title')}
                    </CardTitle>
                    <CardDescription>{t('split.description')}</CardDescription>
                  </div>
                  <Select
                    value={split}
                    onValueChange={(v) => {
                      if (isSplitKind(v)) setSplit(v);
                    }}
                    items={splitItems}
                  >
                    <SelectTrigger
                      className="w-full sm:w-44"
                      aria-label={t('split.choose')}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SPLITS.map((s) => (
                        <SelectItem key={s} value={s}>
                          {splitItems[s]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {current.length === 0 ? (
                  <EmptyState title={t('current.empty')} icon={Tags} />
                ) : (
                  current.map((g) => {
                    const rows = splitFor(splitRows(report, split), g.tagId);
                    return (
                      <div key={g.tagId} className="min-w-0">
                        <p className="text-foreground mb-1 flex items-center gap-2 text-sm font-medium">
                          <TagDot tag={g.tag} />
                          <span className="truncate">{tagName(g)}</span>
                        </p>
                        <div className="border-border overflow-x-auto rounded-lg border">
                          <table className="w-full min-w-64 text-sm">
                            <thead>
                              <tr className="border-border bg-card-2 text-muted-foreground border-b text-xs">
                                <th className="px-3 py-1.5 text-start font-medium">
                                  {splitItems[split]}
                                </th>
                                <th className="px-3 py-1.5 text-end font-medium">
                                  {t('chats')}
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {rows.map((r) => (
                                <tr
                                  key={r.key ?? 'none'}
                                  className="border-border border-b last:border-0"
                                >
                                  <td className="text-foreground px-3 py-1.5">
                                    {splitName(split, r, splitLabels)}
                                  </td>
                                  <td className="px-3 py-1.5 text-end tabular-nums">
                                    {r.chats}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    );
                  })
                )}
              </CardContent>
            </Card>
          </div>

          <Card className="min-w-0">
            <CardHeader>
              <CardTitle className="text-base">{t('movement.title')}</CardTitle>
              <CardDescription>{t('movement.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {arrivals.length === 0 ? (
                <EmptyState
                  title={t('movement.empty')}
                  hint={t('movement.emptyHint')}
                  icon={Tags}
                />
              ) : (
                <>
                  <div className="min-w-0">
                    <p className="text-muted-foreground mb-2 text-xs font-medium">
                      {t('movement.perDay')}
                    </p>
                    <BarChart
                      data={chartData}
                      index="day"
                      categories={daily.categories}
                      colors={daily.colors}
                      type="stacked"
                      valueFormatter={(v) => String(v)}
                      allowDecimals={false}
                      yAxisWidth={32}
                      className="h-56"
                    />
                  </div>
                  <div>
                    <p className="text-muted-foreground mb-2 text-xs font-medium">
                      {t('movement.perTag')}
                    </p>
                    <TagCountList
                      groups={arrivals}
                      tagName={tagName}
                      subName={subName}
                    />
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {loaded?.canManageAccess && <ReportAccessCard report="chat_tags" />}
        </>
      )}
    </div>
  );
}

/** Main tags with their totals, each sub-tag a "Main · Sub" row. */
function TagCountList({
  groups,
  tagName,
  subName,
}: {
  groups: TagGroup[];
  tagName: (g: TagGroup) => string;
  subName: (g: TagGroup, row: TagGroup['rows'][number]) => string;
}) {
  const t = useTranslations('TagReport');
  return (
    <div className="border-border overflow-x-auto rounded-lg border">
      <table className="w-full min-w-64 text-sm">
        <thead>
          <tr className="border-border bg-card-2 text-muted-foreground border-b text-xs">
            <th className="px-3 py-1.5 text-start font-medium">{t('tag')}</th>
            <th className="px-3 py-1.5 text-end font-medium">{t('chats')}</th>
          </tr>
        </thead>
        {groups.map((g) => (
          <tbody key={g.tagId} className="border-border border-b last:border-0">
            <tr>
              <td className="text-foreground px-3 py-1.5 font-medium">
                <span className="flex items-center gap-2">
                  <TagDot tag={g.tag} />
                  <span className="truncate">{tagName(g)}</span>
                </span>
              </td>
              <td className="px-3 py-1.5 text-end font-medium tabular-nums">
                {g.total}
              </td>
            </tr>
            {(g.rows.length > 1 || g.rows[0]?.subTagId) &&
              g.rows.map((r) => (
                <tr
                  key={r.subTagId ?? 'none'}
                  className="text-muted-foreground"
                >
                  <td className="py-1 ps-8 pe-3 text-xs">{subName(g, r)}</td>
                  <td className="px-3 py-1 text-end text-xs tabular-nums">
                    {r.chats}
                  </td>
                </tr>
              ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}
