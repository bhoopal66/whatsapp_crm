'use client';

import { useEffect, useState } from 'react';
import { Activity, Loader2 } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useCan } from '@/hooks/use-can';
import {
  TONE_CLASS,
  assessedTone,
  marketingUsage,
  qualityTone,
  otherSpendFigure,
  wonSpendFigures,
  type AssessedState,
  type CostPerWonCase,
  type HealthTone,
  type SpendFigure,
} from '@/lib/whatsapp/meta-health/view';

/**
 * Meta number health (migration 188): what Meta reports about the
 * account's Cloud API number and templates, and what we derive from it.
 * Read-only; the enforce switch and caps are on SendProtectionCard.
 * Owners and admins only, like the tables' RLS.
 */

interface HealthResponse {
  connected: boolean;
  state?: {
    quality_rating: string | null;
    messaging_limit_tier: string | null;
    account_status: string | null;
    assessed_state: AssessedState;
    reasons: string[];
    updated_at: string | null;
  } | null;
  templates?: {
    template_name: string;
    language: string;
    quality: string | null;
    status: string | null;
    paused_until: string | null;
  }[];
  events?: { id: number; kind: string; received_at: string }[];
  marketing?: { sent_today: number | null; daily_cap: number | null };
  spend?: { days: number; figures: CostPerWonCase | null };
}

function Pill({ tone, children }: { tone: HealthTone; children: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASS[tone]}`}
    >
      {children}
    </span>
  );
}

export function MetaHealthCard() {
  const canView = useCan('edit-settings');
  const t = useTranslations('Settings.metaHealth');
  const format = useFormatter();
  const [data, setData] = useState<HealthResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!canView) return;
    let live = true;
    fetch('/api/whatsapp/meta/health')
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as HealthResponse;
        if (live) setData(body);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [canView]);

  if (!canView) return null;
  // No Meta number: the connect panel above says so already.
  if (data && !data.connected) return null;

  const when = (iso: string | null | undefined) =>
    iso
      ? format.dateTime(new Date(iso), {
          dateStyle: 'medium',
          timeStyle: 'short',
        })
      : t('none');
  const usd = (n: number | null | undefined) =>
    n === null || n === undefined
      ? t('none')
      : format.number(n, { style: 'currency', currency: 'USD' });
  const figure = (f: SpendFigure) =>
    f.kind === 'usd'
      ? usd(f.usd)
      : f.kind === 'noRate'
        ? t('noRate')
        : t('none');

  const state = data?.state ?? null;
  const usage = marketingUsage(
    data?.marketing?.sent_today ?? null,
    data?.marketing?.daily_cap ?? null
  );
  const spend = data?.spend?.figures ?? null;
  const spendFigures = spend ? wonSpendFigures(spend) : null;
  const events = data?.events ?? [];
  const templates = data?.templates ?? [];

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className="text-foreground flex items-center gap-2">
          <Activity className="size-4" />
          {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
        <p className="text-info text-sm font-medium">{t('watchOnly')}</p>
      </CardHeader>
      <CardContent className="space-y-6">
        {failed ? (
          <p className="text-destructive text-sm">{t('loadFailed')}</p>
        ) : !data ? (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" />
            {t('loading')}
          </div>
        ) : (
          <>
            <section className="bg-card-2 space-y-3 rounded-lg p-4">
              {state ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{t('assessed')}</span>
                    <Pill tone={assessedTone(state.assessed_state)}>
                      {t(`states.${state.assessed_state}`)}
                    </Pill>
                  </div>
                  {state.reasons.length > 0 && (
                    <ul className="text-muted-foreground list-disc space-y-0.5 ps-5 text-sm">
                      {state.reasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  )}
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
                    <div>
                      <dt className="text-muted-foreground">{t('quality')}</dt>
                      <dd>
                        <Pill tone={qualityTone(state.quality_rating)}>
                          {state.quality_rating ?? t('none')}
                        </Pill>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">{t('tier')}</dt>
                      <dd>{state.messaging_limit_tier ?? t('none')}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">
                        {t('accountStatus')}
                      </dt>
                      <dd>{state.account_status ?? t('none')}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">{t('updated')}</dt>
                      <dd>{when(state.updated_at)}</dd>
                    </div>
                  </dl>
                </>
              ) : (
                <p className="text-muted-foreground text-sm">{t('noState')}</p>
              )}
            </section>

            <section className="grid gap-4 sm:grid-cols-2">
              <div className="bg-card-2 space-y-1 rounded-lg p-4">
                <p className="text-muted-foreground text-sm">
                  {t('marketingToday')}
                </p>
                <p className="text-lg font-semibold">
                  {data.marketing?.sent_today === null
                    ? t('unavailable')
                    : usage.cap === null
                      ? t('sentNoCap', { sent: usage.sent })
                      : t('sentOfCap', { sent: usage.sent, cap: usage.cap })}
                </p>
                {usage.atCap && (
                  <p className="text-warning text-xs">{t('atCap')}</p>
                )}
              </div>
              <div className="bg-card-2 space-y-1 rounded-lg p-4">
                <p className="text-muted-foreground text-sm">
                  {t('spendPerWon', { days: data.spend?.days ?? 30 })}
                </p>
                {spend && spendFigures ? (
                  <>
                    <p className="text-lg font-semibold">
                      {figure(spendFigures.perCase)}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {t('spendDetail', {
                        cases: spend.wonCases,
                        won: figure(spendFigures.won),
                        other: figure(otherSpendFigure(spend)),
                      })}
                    </p>
                    {spend.unknownCostMessages > 0 && (
                      <p className="text-warning text-xs">
                        {t('unknownCost', {
                          count: spend.unknownCostMessages,
                        })}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-lg font-semibold">{t('unavailable')}</p>
                )}
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-medium">{t('templates')}</h3>
              {templates.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  {t('noTemplates')}
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('colName')}</TableHead>
                      <TableHead>{t('colLanguage')}</TableHead>
                      <TableHead>{t('colQuality')}</TableHead>
                      <TableHead>{t('colStatus')}</TableHead>
                      <TableHead>{t('colPausedUntil')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {templates.map((row) => (
                      <TableRow key={`${row.template_name}:${row.language}`}>
                        <TableCell className="font-medium">
                          {row.template_name}
                        </TableCell>
                        <TableCell>{row.language}</TableCell>
                        <TableCell>
                          <Pill tone={qualityTone(row.quality)}>
                            {row.quality ?? t('none')}
                          </Pill>
                        </TableCell>
                        <TableCell>{row.status ?? t('none')}</TableCell>
                        <TableCell>{when(row.paused_until)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-medium">{t('events')}</h3>
              {events.length === 0 ? (
                <p className="text-muted-foreground text-sm">{t('noEvents')}</p>
              ) : (
                <ul className="divide-border bg-card-2 divide-y rounded-lg text-sm">
                  {events.map((e) => (
                    <li
                      key={e.id}
                      className="flex items-center justify-between gap-4 px-4 py-2"
                    >
                      <span>{t(`kinds.${e.kind}`)}</span>
                      <span className="text-muted-foreground">
                        {when(e.received_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );
}
