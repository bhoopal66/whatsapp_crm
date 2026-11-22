'use client';

/**
 * Customer ratings (CSAT, migration 246) on the Cases screen: the
 * average over the last 90 days, and, opened, per agent and per bank.
 * Only cases the viewer can read count (the API asks per case). Renders
 * nothing while CSAT is off for the workspace or the load failed.
 */
import { useEffect, useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, Star } from 'lucide-react';

import { useWorkspaceMembers } from '@/components/meetings/use-workspace-members';
import { Button } from '@/components/ui/button';
import type { CsatAverage, CsatAverages as Averages } from '@/lib/cases/csat';
import { cn } from '@/lib/utils';

const DAYS = 90;

type Loaded = Averages & { enabled: boolean; days: number };

export function CsatAverages({ className }: { className?: string }) {
  const t = useTranslations('CaseCsat.averages');
  const { nameOf } = useWorkspaceMembers();
  const [data, setData] = useState<Loaded | null>(null);
  const [open, setOpen] = useState(false);
  const panelId = useId();

  useEffect(() => {
    let live = true;
    void fetch(`/api/cases/csat?days=${DAYS}`)
      .then(async (res) => (res.ok ? ((await res.json()) as Loaded) : null))
      .catch(() => null)
      .then((d) => {
        if (live) setData(d);
      });
    return () => {
      live = false;
    };
  }, []);

  if (!data?.enabled) return null;
  const overall = data.overall;

  return (
    <section
      className={cn('bg-card rounded-xl border p-3 text-sm', className)}
      aria-label={t('title')}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Star
            className="size-4 shrink-0 fill-amber-500 text-amber-600 dark:fill-amber-400 dark:text-amber-300"
            aria-hidden
          />
          <h2 className="font-semibold">{t('title')}</h2>
          <span className="text-muted-foreground">
            {overall
              ? t('summary', {
                  average: overall.average,
                  count: overall.count,
                  days: data.days,
                })
              : t('empty', { days: data.days })}
          </span>
        </div>
        {overall && (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? t('hide') : t('show')}
            <ChevronDown
              className={cn(
                'size-4 transition-transform',
                open && 'rotate-180'
              )}
              aria-hidden
            />
          </Button>
        )}
      </div>
      {overall && open && (
        <div id={panelId} className="mt-3 grid gap-4 sm:grid-cols-2">
          <AverageList
            title={t('byAgent')}
            rows={data.byAgent}
            label={(r) =>
              r.key ? (nameOf(r.key) ?? t('unknownAgent')) : t('unknownAgent')
            }
            rowText={(r) => t('row', { average: r.average, count: r.count })}
          />
          <AverageList
            title={t('byBank')}
            rows={data.byBank}
            label={(r) => r.label ?? r.key ?? t('noBank')}
            rowText={(r) => t('row', { average: r.average, count: r.count })}
          />
        </div>
      )}
    </section>
  );
}

function AverageList({
  title,
  rows,
  label,
  rowText,
}: {
  title: string;
  rows: CsatAverage[];
  label: (r: CsatAverage) => string;
  rowText: (r: CsatAverage) => string;
}) {
  return (
    <div className="min-w-0">
      <h3 className="text-muted-foreground mb-1 text-xs font-medium">
        {title}
      </h3>
      <ul className="divide-y">
        {rows.map((r) => (
          <li
            key={r.key ?? '-'}
            className="flex items-center justify-between gap-3 py-1.5"
          >
            <span className="min-w-0 truncate">{label(r)}</span>
            <span className="shrink-0 tabular-nums">{rowText(r)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
