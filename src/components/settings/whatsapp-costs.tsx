'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, CircleDollarSign, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/dashboard/skeleton';
import { BarChart } from '@/components/tremor/bar-chart';
import { SettingsPanelHead } from '@/components/settings/settings-panel-head';
import {
  humanizeCategory,
  KNOWN_CATEGORIES,
  orderedCategories,
  type CostReport,
} from '@/lib/whatsapp/message-costs';

/**
 * Meta Cloud API message spend, from the ledger migration 051 keeps.
 *
 * Reads `GET /api/whatsapp/costs`, which is admin-only like the ledger
 * itself; the section is gated to admin+ in `settings-sections.ts`, so
 * this component never has to check the role.
 *
 * Amounts are USD — that is what Meta bills in — with a dirham figure
 * alongside for an AED account, because the peg makes that exact
 * rather than an estimate. `unknown_rate` is the number to watch: it
 * counts delivered messages whose market or category is missing from
 * the rate card, i.e. spend that IS happening but is not in the
 * total. It should be zero once the official card is loaded.
 */

type CostsResponse = CostReport & { meta_connected: boolean };

const WINDOWS = [3, 6, 12] as const;

// Same order as KNOWN_CATEGORIES, one colour each; an unrecognised
// category wraps back round rather than landing on `undefined`, which
// BarChart's legend renders grey.
const CATEGORY_COLORS = [
  'violet',
  'fuchsia',
  'blue',
  'cyan',
  'pink',
  'emerald',
  'gray',
] as const;

function usd(n: number, digits = 2): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function WhatsAppCosts() {
  const { accountId, defaultCurrency } = useAuth();
  const t = useTranslations('Settings.costs');

  const [months, setMonths] = useState<number>(6);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<CostsResponse | null>(null);
  const loadedRef = useRef<string | null>(null);

  const load = useCallback(
    async (window: number) => {
      setLoading(true);
      try {
        const res = await fetch(`/api/whatsapp/costs?months=${window}`, {
          cache: 'no-store',
        });
        const json = await res.json().catch(() => null);
        if (!res.ok) {
          toast.error(json?.error ?? t('loadFailed'));
          setData(null);
          return;
        }
        setData(json as CostsResponse);
      } catch {
        toast.error(t('loadFailed'));
        setData(null);
      } finally {
        setLoading(false);
      }
    },
    [t]
  );

  useEffect(() => {
    if (!accountId) return;
    const key = `${accountId}:${months}`;
    if (loadedRef.current === key) return;
    loadedRef.current = key;
    void load(months);
  }, [accountId, months, load]);

  const showAed = defaultCurrency === 'AED';
  const aed = (n: number) =>
    new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'AED',
      maximumFractionDigits: 2,
    }).format(n * (data?.usd_aed_peg ?? 3.6725));

  const categoryLabel = useCallback(
    (c: string) =>
      t.has(`category.${c}`) ? t(`category.${c}`) : humanizeCategory(c),
    [t]
  );

  const categoriesSeen = data ? orderedCategories(data.by_category) : [];
  const chartData =
    data?.by_month.map((m) => {
      const row: Record<string, string | number> = {
        month: monthLabel(m.month),
      };
      for (const c of categoriesSeen) {
        row[categoryLabel(c)] = m.by_category[c] ?? 0;
      }
      return row;
    }) ?? [];
  const chartCategories = categoriesSeen.map(categoryLabel);
  const chartColors = categoriesSeen.map((c, i) => {
    const known = (KNOWN_CATEGORIES as readonly string[]).indexOf(c);
    return CATEGORY_COLORS[(known === -1 ? i : known) % CATEGORY_COLORS.length];
  });

  const hasSpend = (data?.totals.delivered ?? 0) > 0;

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          <Select
            value={String(months)}
            onValueChange={(v) => setMonths(Number(v))}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WINDOWS.map((w) => (
                <SelectItem key={w} value={String(w)}>
                  {t('lastMonths', { count: w })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      {loading || !data ? (
        <div className="space-y-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-[260px] w-full" />
        </div>
      ) : !hasSpend ? (
        <Card>
          <CardContent className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-12 text-center text-sm">
            <CircleDollarSign className="h-8 w-8 opacity-40" />
            <p className="text-foreground font-medium">
              {data.meta_connected ? t('emptyTitle') : t('noMetaTitle')}
            </p>
            <p className="max-w-[48ch] text-xs">
              {data.meta_connected ? t('emptyBody') : t('noMetaBody')}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {data.totals.unknown_rate > 0 && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>
                {t('unknownRateTitle', { count: data.totals.unknown_rate })}
              </AlertTitle>
              <AlertDescription>{t('unknownRateBody')}</AlertDescription>
            </Alert>
          )}

          {/* Headline tiles — the current billing month */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label={t('thisMonth', { month: monthLabel(data.current.month) })}
              value={usd(data.current.cost_usd)}
              sub={showAed ? aed(data.current.cost_usd) : undefined}
            />
            <Stat
              label={t('windowTotal', { count: data.months.length })}
              value={usd(data.totals.cost_usd)}
              sub={showAed ? aed(data.totals.cost_usd) : undefined}
            />
            <Stat
              label={t('deliveredThisMonth')}
              value={data.current.delivered.toLocaleString()}
              sub={t('billedCount', { count: data.current.billed })}
            />
            <Stat
              label={t('freeTierUsed')}
              value={data.current.service_delivered.toLocaleString()}
              sub={t('freeTierHint')}
            />
          </div>

          {/* Spend per month, stacked by category */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('perMonth')}</CardTitle>
              <CardDescription>{t('perMonthDesc')}</CardDescription>
            </CardHeader>
            <CardContent>
              <BarChart
                data={chartData}
                index="month"
                categories={chartCategories}
                colors={[...chartColors]}
                type="stacked"
                valueFormatter={(v) => usd(v)}
                yAxisWidth={64}
                className="h-[240px]"
              />
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            {/* Per number, with the free service tier */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('byNumber')}</CardTitle>
                <CardDescription>{t('byNumberDesc')}</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="divide-border border-border divide-y rounded-md border">
                  {data.by_number.map((n) => {
                    const used = n.service_delivered;
                    const tier = used + n.free_remaining;
                    const pct =
                      tier > 0
                        ? Math.min(100, Math.round((used / tier) * 100))
                        : 0;
                    return (
                      <li
                        key={n.phone_number_id}
                        className="px-3 py-2.5 text-sm"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="min-w-0 truncate">
                            <span className="text-foreground">
                              {n.label || t('unnamedNumber')}
                            </span>{' '}
                            <span className="text-muted-foreground text-xs">
                              ({n.phone_number_id})
                            </span>
                          </span>
                          <span className="text-foreground shrink-0 tabular-nums">
                            {usd(n.cost_usd)}
                          </span>
                        </div>
                        <div className="text-muted-foreground mt-1.5 flex items-center justify-between gap-3 text-xs">
                          <span>
                            {t('serviceQuota', {
                              used,
                              remaining: n.free_remaining,
                            })}
                          </span>
                          {n.unknown_rate > 0 ? (
                            <Badge
                              variant="outline"
                              className="border-warning/30 bg-warning-soft text-warning"
                            >
                              {t('unknownRateBadge', { count: n.unknown_rate })}
                            </Badge>
                          ) : null}
                        </div>
                        <div className="bg-muted mt-1.5 h-1.5 w-full overflow-hidden rounded-full">
                          <div
                            className="bg-primary h-full rounded-full"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>

            {/* Per category + per market */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('byCategory')}</CardTitle>
                <CardDescription>{t('byCategoryDesc')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <BreakdownList
                  rows={data.by_category.map((c) => ({
                    key: c.category,
                    label: categoryLabel(c.category),
                    delivered: c.delivered,
                    billed: c.billed,
                    cost: c.cost_usd,
                  }))}
                  countLabel={(r) =>
                    t('deliveredBilled', {
                      delivered: r.delivered,
                      billed: r.billed,
                    })
                  }
                />
                <div>
                  <p className="text-muted-foreground mb-2 text-xs font-medium">
                    {t('byMarket')}
                  </p>
                  <BreakdownList
                    rows={data.by_market.map((m) => ({
                      key: m.market,
                      label:
                        m.market === 'UNKNOWN' ? t('unknownMarket') : m.market,
                      delivered: m.delivered,
                      billed: m.billed,
                      cost: m.cost_usd,
                    }))}
                    countLabel={(r) =>
                      t('deliveredBilled', {
                        delivered: r.delivered,
                        billed: r.billed,
                      })
                    }
                  />
                </div>
              </CardContent>
            </Card>
          </div>

          <p className="text-muted-foreground text-xs">{t('footnote')}</p>
        </div>
      )}

      {loading && data ? (
        <div className="text-muted-foreground mt-3 flex items-center gap-2 text-xs">
          <Loader2 className="size-3 animate-spin" /> {t('refreshing')}
        </div>
      ) : null}
    </section>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="border-border bg-card rounded-md border p-3">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="text-foreground mt-1 text-lg font-semibold tabular-nums">
        {value}
      </p>
      {sub ? (
        <p className="text-muted-foreground mt-0.5 text-xs tabular-nums">
          {sub}
        </p>
      ) : null}
    </div>
  );
}

function BreakdownList({
  rows,
  countLabel,
}: {
  rows: {
    key: string;
    label: string;
    delivered: number;
    billed: number;
    cost: number;
  }[];
  countLabel: (r: { delivered: number; billed: number }) => string;
}) {
  if (rows.length === 0) return null;
  return (
    <ul className="divide-border border-border divide-y rounded-md border">
      {rows.map((r) => (
        <li
          key={r.key}
          className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
        >
          <span className="min-w-0 truncate">
            <span className="text-foreground">{r.label}</span>{' '}
            <span className="text-muted-foreground text-xs">
              {countLabel(r)}
            </span>
          </span>
          <span className="text-muted-foreground shrink-0 tabular-nums">
            {usd(r.cost)}
          </span>
        </li>
      ))}
    </ul>
  );
}
