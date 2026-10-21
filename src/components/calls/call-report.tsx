'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { hasMinRole } from '@/lib/auth/roles';
import {
  CALL_REPORT_PERIODS,
  averageSeconds,
  checkCustomDays,
  formatDuration,
  hasCalls,
  outcomeCounts,
  type CallReport as Report,
  type CallReportFigures,
  type CallReportPeriod,
} from '@/lib/pbx/call-report';
import { cn } from '@/lib/utils';

interface Loaded {
  key: string;
  report?: Report;
  range?: { from: string; to: string; timeZone: string };
  error?: 'forbidden' | 'failed';
}

/** The Calls screen's "By person" tab (module 015, migration 098). */
export function CallReport() {
  const t = useTranslations('CallsPage.report');
  const tOutcome = useTranslations('PbxCall.outcomes');
  const locale = useLocale();
  const { accountRole } = useAuth();
  const viewerZone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    []
  );
  const [period, setPeriod] = useState<CallReportPeriod>('month');
  const [draft, setDraft] = useState({ from: '', to: '' });
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(
    null
  );
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  const query =
    period !== 'custom'
      ? `period=${period}`
      : custom
        ? `period=custom&from=${custom.from}&to=${custom.to}`
        : null;

  useEffect(() => {
    if (!query) return;
    let cancelled = false;
    fetch(`/api/pbx/calls/report?${query}&tz=${encodeURIComponent(viewerZone)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 403 ? 'forbidden' : 'failed');
        return r.json();
      })
      .then((body) => {
        if (!cancelled)
          setLoaded({ key: query, report: body.report, range: body.range });
      })
      .catch((err: Error) => {
        if (!cancelled)
          setLoaded({
            key: query,
            error: err.message === 'forbidden' ? 'forbidden' : 'failed',
          });
      });
    return () => {
      cancelled = true;
    };
  }, [query, viewerZone]);

  const current = query && loaded?.key === query ? loaded : null;
  const problem = checkCustomDays(draft.from, draft.to);
  const day = (iso: string, zone: string) =>
    new Intl.DateTimeFormat(locale, {
      timeZone: zone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(new Date(iso));

  const cells = (f: CallReportFigures) => {
    const outcomes = outcomeCounts(f);
    return (
      <>
        <td className="px-3 py-2 text-right tabular-nums">
          {f.inboundAnswered}
        </td>
        <td className="px-3 py-2 text-right tabular-nums">{f.outbound}</td>
        <td className="px-3 py-2 text-right tabular-nums">{f.missed}</td>
        <td className="px-3 py-2 text-right tabular-nums">
          {formatDuration(f.talkSeconds)}
        </td>
        <td className="px-3 py-2 text-right tabular-nums">
          {formatDuration(averageSeconds(f.talkSeconds, f.talkCalls))}
        </td>
        <td className="px-3 py-2 text-right tabular-nums">
          {formatDuration(averageSeconds(f.ringSeconds, f.ringCalls))}
        </td>
        <td className="text-muted-foreground px-3 py-2">
          {outcomes.length
            ? outcomes
                .map(
                  ({ outcome, count }) =>
                    `${outcome === 'none' ? t('noOutcome') : tOutcome(outcome)} ${count}`
                )
                .join(' · ')
            : '—'}
        </td>
      </>
    );
  };

  const report = current?.report;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {CALL_REPORT_PERIODS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPeriod(p)}
            aria-pressed={period === p}
            className={cn(
              'focus-visible:ring-ring/50 rounded-full border px-3 py-1 text-sm transition-colors outline-none focus-visible:ring-3',
              period === p
                ? 'border-primary/40 bg-primary-soft text-primary font-medium'
                : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            {t(`periods.${p}`)}
          </button>
        ))}
      </div>
      {period === 'custom' && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!problem) setCustom({ ...draft });
          }}
        >
          {(['from', 'to'] as const).map((k) => (
            <label key={k} className="text-muted-foreground text-xs">
              {t(k)}
              <input
                type="date"
                value={draft[k]}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, [k]: e.target.value }))
                }
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
      )}

      {!query ? (
        <p className="text-muted-foreground text-sm">{t('pickDays')}</p>
      ) : !current ? (
        <div className="bg-muted h-24 animate-pulse rounded-xl" aria-hidden />
      ) : current.error ? (
        <p className="text-destructive text-sm">
          {current.error === 'forbidden' ? t('forbidden') : t('loadFailed')}
        </p>
      ) : !report || !hasCalls(report.total) ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <section className="border-border bg-card overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[48rem] text-sm">
            <thead className="text-muted-foreground border-border border-b text-xs">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">
                  {t('columns.person')}
                </th>
                {(
                  [
                    'inboundAnswered',
                    'outbound',
                    'missed',
                    'talkTotal',
                    'talkAverage',
                    'ringAverage',
                  ] as const
                ).map((c) => (
                  <th key={c} className="px-3 py-2 text-right font-semibold">
                    {t(`columns.${c}`)}
                  </th>
                ))}
                <th className="px-3 py-2 text-left font-semibold">
                  {t('columns.outcomes')}
                </th>
              </tr>
            </thead>
            <tbody>
              {report.people.map((p) => (
                <tr key={p.userId} className="border-border border-b">
                  <td className="px-3 py-2">
                    <span className="font-medium">
                      {p.name ?? t('unnamed')}
                    </span>
                    {p.extension && (
                      <span className="text-muted-foreground block text-xs">
                        {t('extension', { extension: p.extension })}
                      </span>
                    )}
                  </td>
                  {cells(p)}
                </tr>
              ))}
              {hasCalls(report.unattributed) && (
                <tr className="border-border border-b">
                  <td className="text-muted-foreground px-3 py-2 italic">
                    {t('noPerson')}
                  </td>
                  {cells(report.unattributed)}
                </tr>
              )}
              <tr className="bg-muted/50 font-semibold">
                <td className="px-3 py-2">{t('total')}</td>
                {cells(report.total)}
              </tr>
            </tbody>
          </table>
        </section>
      )}

      {current?.range && (
        <div className="text-muted-foreground space-y-1 text-xs">
          <p>
            {t('range', {
              from: day(current.range.from, current.range.timeZone),
              to: day(
                new Date(Date.parse(current.range.to) - 1).toISOString(),
                current.range.timeZone
              ),
              zone: current.range.timeZone,
            })}
          </p>
          <p>{t('footnoteMissed')}</p>
          <p>{t('footnoteFigures')}</p>
          {accountRole && !hasMinRole(accountRole, 'admin') && (
            <p>{t('footnoteLeader')}</p>
          )}
        </div>
      )}
    </div>
  );
}
