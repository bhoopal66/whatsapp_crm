'use client';

import { BadgeCheck, Loader2, RefreshCw, Smartphone } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { numberBar } from '@/lib/team-activity/glance';
import {
  numberDisplayName,
  type TeamActivityReport,
} from '@/lib/team-activity/report';
import type { NumberAssessment } from '@/lib/team-activity/risk';
import type { SafetyEntry, SafetyScore } from '@/lib/team-activity/safety';
import { cn } from '@/lib/utils';

import { LevelIcon, StatusBadge, TONE_BAR, useFindingCopy } from './shared';

const SCORE_TONE: Record<1 | 2 | 3, string> = {
  1: 'bg-destructive-soft text-destructive',
  2: 'bg-warning-soft text-warning',
  3: 'bg-success-soft text-success',
};

function Score({ label, score }: { label: string; score: SafetyScore }) {
  const t = useTranslations('TeamActivity.numbers');
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          'rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
          score ? SCORE_TONE[score] : 'bg-muted text-muted-foreground'
        )}
      >
        {score ? t(`score${score}`) : t('scoreNone')}
      </span>
    </div>
  );
}

/** One card per number: connected or not, and today's new chats. */
export function NumbersPanel({
  numbers,
  report,
  admin,
  safety,
  safetyLoading,
  recalculating,
  onRecalculate,
}: {
  numbers: NumberAssessment[];
  report: TeamActivityReport;
  admin: boolean;
  safety: Record<string, SafetyEntry>;
  safetyLoading: boolean;
  recalculating: string | null;
  onRecalculate: (channelId: string) => void;
}) {
  const t = useTranslations('TeamActivity.numbers');
  const copy = useFindingCopy();
  if (numbers.length === 0) return null;
  const team = report.scope === 'team';

  return (
    <section className="space-y-3" aria-labelledby="ta-numbers">
      <div>
        <h2 id="ta-numbers" className="text-foreground text-base font-semibold">
          {t('title')}
        </h2>
        <p className="text-muted-foreground mt-0.5 text-sm">
          {t('description')}
        </p>
      </div>
      <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {numbers.map(({ number: n, findings, status }) => {
          const phone = n.kind === 'phone';
          const label = numberDisplayName(n) ?? t('unnamed');
          const digits =
            n.provider === 'whapi' && n.wabaId && n.label
              ? `+${n.wabaId.replace(/^\+/, '')}`
              : null;
          const bar = numberBar(
            n,
            report.scope,
            report.limits.dailyNewChatsPerNumber
          );
          const connected = !n.status || n.status === 'connected';
          const entry = n.channelId ? (safety[n.channelId] ?? null) : null;
          // The bar, the warm-up note and the disconnected line say
          // these already.
          const shown = findings.filter(
            (f) =>
              f.code !== 'number_disconnected' &&
              f.code !== 'number_warming_up' &&
              f.code !== 'number_at_limit' &&
              f.code !== 'number_near_limit'
          );
          return (
            <li
              key={n.channelId ?? label}
              className="border-border bg-card flex flex-col gap-4 rounded-xl border p-4"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="bg-muted text-muted-foreground flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
                    {phone ? (
                      <Smartphone className="h-4 w-4" aria-hidden />
                    ) : (
                      <BadgeCheck className="h-4 w-4" aria-hidden />
                    )}
                  </span>
                  <div className="min-w-0">
                    <p className="text-foreground truncate font-medium">
                      {label}
                    </p>
                    <p className="text-muted-foreground text-sm break-words">
                      {[digits, t(phone ? 'phone' : 'official')]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </div>
                </div>
                {phone && <StatusBadge status={status} />}
              </div>

              <p
                className={cn(
                  'text-sm font-medium',
                  connected ? 'text-success' : 'text-destructive'
                )}
              >
                {t(connected ? 'connected' : 'disconnected')}
              </p>

              {bar ? (
                <div>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-sm">
                    <span className="text-muted-foreground">
                      {t('todayLabel')}
                    </span>
                    <span className="text-foreground font-semibold tabular-nums">
                      {t('todayValue', { count: bar.count, limit: bar.limit })}
                    </span>
                  </div>
                  <div
                    className="bg-muted mt-1.5 h-2.5 overflow-hidden rounded-full"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={bar.limit}
                    aria-valuenow={bar.count}
                    aria-label={t('todayLabel')}
                  >
                    <div
                      className={cn('h-full rounded-full', TONE_BAR[bar.tone])}
                      style={{ width: `${bar.percent}%` }}
                    />
                  </div>
                  {team && bar.team !== null && (
                    <p className="text-muted-foreground mt-1.5 text-sm">
                      {t('teamShare', { team: bar.team, count: bar.count })}
                    </p>
                  )}
                  {n.warmingUp && (
                    <p className="bg-warning-soft text-warning mt-2 rounded-lg px-3 py-2 text-sm">
                      {t('warmingUp', { limit: bar.limit })}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">
                  {t('officialNote')}
                </p>
              )}

              {shown.length > 0 && (
                <ul className="space-y-2">
                  {shown.map((f) => (
                    <li key={f.id} className="flex gap-2 text-sm">
                      <LevelIcon level={f.level} className="mt-0.5" />
                      <span className="text-foreground">{copy(f).body}</span>
                    </li>
                  ))}
                </ul>
              )}

              {admin && phone && n.channelId && (
                <div className="border-border rounded-lg border p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-foreground text-sm font-semibold">
                      {t('meterTitle')}
                    </p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1 px-2 text-xs"
                      disabled={recalculating === n.channelId}
                      onClick={() => onRecalculate(n.channelId!)}
                    >
                      {recalculating === n.channelId ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3 w-3" />
                      )}
                      {t('meterRecalculate')}
                    </Button>
                  </div>
                  {safetyLoading && !entry ? (
                    <p className="text-muted-foreground text-sm">
                      {t('meterLoading')}
                    </p>
                  ) : entry?.rating ? (
                    <div className="space-y-1.5">
                      <Score
                        label={t('meterOverall')}
                        score={entry.rating.riskFactor}
                      />
                      <Score
                        label={t('meterAge')}
                        score={entry.rating.lifeTime}
                      />
                      <Score
                        label={t('meterResponse')}
                        score={entry.rating.riskFactorChats}
                      />
                      <Score
                        label={t('meterContacts')}
                        score={entry.rating.riskFactorContacts}
                      />
                    </div>
                  ) : (
                    <p className="text-muted-foreground text-sm">
                      {entry?.error ? t('meterUnavailable') : t('meterNone')}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
