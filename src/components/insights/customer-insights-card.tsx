'use client';

import { type ReactNode } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { useInsightSettings } from '@/hooks/use-insight-settings';
import {
  customerInsightView,
  type CustomerInsightFigures,
  type MoodTag,
} from '@/lib/insights/customer-view';
import type { UrgencyBand } from '@/lib/insights/bands';
import { cn } from '@/lib/utils';

/**
 * What Jev last judged about a customer (docs/jev-insights.md, "Customer
 * insights"): what they want, the lead meter, urgency and mood. Renders
 * nothing unless the workspace has signals on. Every rule is
 * `customerInsightView`'s; this only lays it out. `frame` wraps the block
 * in the host screen's own section (the DealRoomLinks pattern).
 */

/** `default` on the customer page, `wa` in the inbox's WhatsApp panel. */
type Tone = 'default' | 'wa';

const TONES: Record<
  Tone,
  { inner: string; text: string; sub: string; step: string }
> = {
  default: {
    inner: 'bg-card-2',
    text: 'text-foreground',
    sub: 'text-muted-foreground',
    step: 'bg-muted text-muted-foreground',
  },
  wa: {
    inner: 'bg-wa-search',
    text: 'text-wa-text',
    sub: 'text-wa-text-secondary',
    step: 'bg-wa-row-hover text-wa-text-secondary',
  },
};

const URGENCY_TONE: Record<UrgencyBand, string | null> = {
  none: null,
  soon: 'bg-warning-soft text-warning',
  urgent: 'bg-destructive-soft text-destructive',
};

const MOOD_TONE: Record<MoodTag, string> = {
  upset: 'bg-warning-soft text-warning',
  wantsPerson: 'bg-info-soft text-info',
  calm: 'bg-success-soft text-success',
};

function Chip({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        className
      )}
    >
      {children}
    </span>
  );
}

export function CustomerInsightsCard({
  conversation,
  tone = 'default',
  frame,
}: {
  /** The customer's conversation row; null when there is none. */
  conversation: CustomerInsightFigures | null;
  tone?: Tone;
  frame: (title: string, body: ReactNode) => ReactNode;
}) {
  const { settings } = useInsightSettings();
  if (!settings?.signalsEnabled) return null;
  return <CardBody conversation={conversation} tone={tone} frame={frame} />;
}

function CardBody({
  conversation,
  tone,
  frame,
}: {
  conversation: CustomerInsightFigures | null;
  tone: Tone;
  frame: (title: string, body: ReactNode) => ReactNode;
}) {
  const t = useTranslations('InsightsUi');
  const format = useFormatter();
  const view = customerInsightView(conversation);
  const c = TONES[tone];

  if (!view.judged)
    return (
      <>
        {frame(
          t('card.title'),
          <p className={cn('text-xs', c.sub)}>{t('card.empty')}</p>
        )}
      </>
    );

  const row = (label: string, value: ReactNode) => (
    <div className="space-y-1">
      <p className={cn('text-xs', c.sub)}>{label}</p>
      {value}
    </div>
  );

  const body = (
    <div className={cn('space-y-3 rounded-lg px-3 py-2.5', c.inner)}>
      {view.intent &&
        row(
          t('card.wants'),
          <p className={cn('text-sm font-medium', c.text)}>
            {t(`intents.${view.intent}`)}
            {view.intentPercent !== null && (
              <span className={cn('ml-1.5 text-xs font-normal', c.sub)}>
                {t('card.sure', { percent: view.intentPercent })}
              </span>
            )}
          </p>
        )}
      {view.meter.length > 0 &&
        row(
          t('card.lead'),
          <ol className="grid grid-cols-4 gap-1" aria-label={t('card.lead')}>
            {view.meter.map((s) => (
              <li
                key={s.band}
                aria-current={s.current ? 'step' : undefined}
                className={cn(
                  'rounded px-1 py-1 text-center text-[10px] leading-tight',
                  s.current
                    ? 'bg-success-soft text-success ring-success/60 font-semibold ring-1 ring-inset'
                    : s.reached
                      ? 'bg-success-soft/60 text-success'
                      : c.step
                )}
              >
                {t(`bands.lead.${s.band}`)}
              </li>
            ))}
          </ol>
        )}
      {view.urgency &&
        row(
          t('card.urgency'),
          URGENCY_TONE[view.urgency] ? (
            <Chip className={URGENCY_TONE[view.urgency]!}>
              {t(`bands.urgency.${view.urgency}`)}
            </Chip>
          ) : (
            <p className={cn('text-sm', c.text)}>
              {t(`bands.urgency.${view.urgency}`)}
            </p>
          )
        )}
      {view.mood &&
        row(
          t('card.mood'),
          <div className="flex flex-wrap gap-1.5">
            {view.mood.map((m) => (
              <Chip key={m} className={MOOD_TONE[m]}>
                {m === 'calm' ? t('card.calm') : t(`bands.mood.${m}`)}
              </Chip>
            ))}
          </div>
        )}
      {view.basedOnAt && (
        <p className={cn('text-[11px]', c.sub)}>
          {t('card.basedOn', { when: format.relativeTime(view.basedOnAt) })}
        </p>
      )}
    </div>
  );
  return <>{frame(t('card.title'), body)}</>;
}
