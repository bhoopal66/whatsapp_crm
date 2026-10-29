'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  parseComposeCheckStats,
  topCodes,
  type ComposeCheckStats,
} from '@/lib/insights/compose-check-view';

/** The last 7 days of message-check warnings; nothing when none or on error. */
export function ComposeCheckStatsView({
  stats,
}: {
  stats: ComposeCheckStats | null;
}) {
  const t = useTranslations('ComposeCheck.stats');
  if (!stats || stats.total === 0) return null;
  const top = topCodes(stats.byCode);
  return (
    <div
      role="status"
      className="bg-card-2 text-muted-foreground rounded-lg border px-4 py-3 text-sm"
    >
      <p>
        <span className="text-foreground font-medium">{t('title')}</span>
        {' · '}
        {t('summary', {
          total: stats.total,
          sentAnyway: stats.sentAnyway,
          edited: stats.edited,
        })}
      </p>
      {top.length > 0 && (
        <p className="mt-1">
          {t('top', {
            list: top
              .map((c) => `${t(`code.${c.code}`)} (${c.count})`)
              .join(', '),
          })}
        </p>
      )}
    </div>
  );
}

/** Fetches once when shown (admins only: the route answers 403 otherwise). */
export function ComposeCheckStatsCard() {
  const [stats, setStats] = useState<ComposeCheckStats | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/insights/compose-check/stats?days=7', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((json: unknown) => {
        if (!cancelled) setStats(parseComposeCheckStats(json));
      })
      .catch(() => {
        // Hidden on error.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return <ComposeCheckStatsView stats={stats} />;
}
