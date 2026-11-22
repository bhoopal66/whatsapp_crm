'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { InsightLegend } from '@/components/insights/insight-legend';
import { useCan } from '@/hooks/use-can';
import { useInsightSettings } from '@/hooks/use-insight-settings';
import {
  customerInsightView,
  type CustomerInsightFigures,
  type CustomerInsightView,
  type MoodTag,
} from '@/lib/insights/customer-view';
import { nextBestActions } from '@/lib/insights/next-action';
import { paletteFor, swatchOf, type Swatch } from '@/lib/insights/palette';
import {
  SPARKLINE_MAX,
  SPARKLINE_MIN_POINTS,
  sparklinePath,
  sparklineValues,
  type SparklineScale,
} from '@/lib/insights/sparkline';
import { insightTrends, type InsightEvent } from '@/lib/insights/trends';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';

/**
 * What Jev last judged about a customer (docs/jev-insights.md, "Customer
 * insights"): the pin, what they want, the lead meter and its trend,
 * mood, objections, next best actions and trend lines. Renders nothing
 * unless the workspace has signals on. Every rule lives in lib/insights
 * (`customerInsightView`, `nextBestActions`, `insightTrends`,
 * `sparklinePath`); this only lays it out and colours it from
 * palette.ts. `frame` wraps the block in the host screen's own section
 * (the DealRoomLinks pattern).
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

const MOOD_SWATCH: Record<MoodTag, Swatch> = {
  upset: paletteFor('attention', 'upset'),
  wantsPerson: paletteFor('attention', 'wants_person'),
  calm: paletteFor('sentiment', 'neutral'),
};

const TREND_ARROW = {
  improving: '↑',
  warming: '↑',
  steady: '→',
  worsening: '↓',
  cooling: '↓',
} as const;

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

/**
 * The chat's judged-message history, fetched once per conversation and
 * again when `insight_at` moves. A failure shows nothing (no toast): the
 * trend lines are a nicety. Held with its key so another chat's history
 * is never shown while the next one loads.
 */
function useInsightHistory(
  id: string | undefined,
  at: string | null | undefined
): InsightEvent[] | null {
  const key = id && at ? `${id}|${at}` : null;
  const [state, setState] = useState<{
    key: string;
    events: InsightEvent[];
  } | null>(null);
  useEffect(() => {
    if (!key || !id) return;
    let live = true;
    fetch(`/api/insights/conversations/${encodeURIComponent(id)}/history`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { events?: InsightEvent[] } | null) => {
        if (live && Array.isArray(body?.events))
          setState({ key, events: body.events });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [key, id]);
  return state && state.key === key ? state.events : null;
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
  const canHandle = useCan('send-messages');
  const view = customerInsightView(conversation);
  const c = TONES[tone];
  const events = useInsightHistory(conversation?.id, conversation?.insight_at);
  // The pin stamp marked handled here; a newer pin shows again.
  const [handledAt, setHandledAt] = useState<string | null>(null);

  const pinStamp = conversation?.insight_attention_at ?? null;
  const pinned = view.attention && pinStamp !== handledAt;

  async function markHandled() {
    const id = conversation?.id;
    if (!id || !pinStamp) return;
    setHandledAt(pinStamp);
    const { error } = await createClient().rpc(
      'acknowledge_insight_attention',
      { p_conversation_id: id }
    );
    if (error) {
      console.error('Failed to mark chat handled:', error.message);
      setHandledAt(null);
      toast.error(t('card.handledFailed'));
      return;
    }
    toast.success(t('card.handledToast'));
  }

  const banner = pinned && view.attention && (
    <PinnedBanner
      attention={view.attention}
      canHandle={canHandle && !!conversation?.id}
      onHandled={() => void markHandled()}
    />
  );

  if (!view.judged)
    return (
      <>
        {frame(
          t('card.title'),
          <div className="space-y-2">
            {banner}
            <p className={cn('text-xs', c.sub)}>{t('card.empty')}</p>
          </div>
        )}
      </>
    );

  const trends = insightTrends(events);
  const actions = nextBestActions(conversation);

  const row = (label: string, value: ReactNode) => (
    <div className="space-y-1">
      <p className={cn('text-xs', c.sub)}>{label}</p>
      {value}
    </div>
  );
  const trendWord = (word: string, arrow: string) => (
    <span className={cn('text-xs', c.sub)}>
      <span aria-hidden>{arrow} </span>
      {word}
    </span>
  );

  const body = (
    <div className="space-y-2">
      {banner}
      <div className={cn('space-y-3 rounded-lg px-3 py-2.5', c.inner)}>
        {(view.intent || view.needsReply || view.callback) &&
          row(
            t('card.wants'),
            <div className="flex flex-wrap items-center gap-1.5">
              {view.intent && (
                <Chip className={paletteFor('intent', view.intent).chip}>
                  {t(`intents.${view.intent}`)}
                </Chip>
              )}
              {view.intentPercent !== null && (
                <span className={cn('text-xs', c.sub)}>
                  {t('card.sure', { percent: view.intentPercent })}
                </span>
              )}
              {view.needsReply && (
                <Chip className={paletteFor('urgency', 'soon').chip}>
                  {t('card.needsReply')}
                </Chip>
              )}
              {view.callback && (
                <Chip className={paletteFor('attention', 'callback').chip}>
                  {t('card.callback')}
                </Chip>
              )}
            </div>
          )}
        {view.meter.length > 0 &&
          row(
            t('card.lead'),
            <div className="space-y-1">
              <ol className="flex gap-1" aria-label={t('card.lead')}>
                {view.meter.map((s) => (
                  // A short word on one line, each step as wide as its
                  // word needs (equal quarters cut "Comparing"); the full
                  // band name is the title and what a screen reader
                  // hears ("Just curious" wrapped to two lines).
                  <li
                    key={s.band}
                    aria-current={s.current ? 'step' : undefined}
                    title={t(`bands.lead.${s.band}`)}
                    className={cn(
                      'min-w-0 flex-auto truncate rounded px-1 py-1 text-center text-xs leading-tight whitespace-nowrap',
                      s.current
                        ? cn(paletteFor('lead', s.band).chip, 'font-semibold')
                        : s.reached
                          ? cn(paletteFor('lead', s.band).chip, 'opacity-60')
                          : c.step
                    )}
                  >
                    <span aria-hidden>{t(`card.meterShort.${s.band}`)}</span>
                    <span className="sr-only">{t(`bands.lead.${s.band}`)}</span>
                  </li>
                ))}
              </ol>
              {trends.lead &&
                trendWord(
                  t(`trends.lead.${trends.lead}`),
                  TREND_ARROW[trends.lead]
                )}
            </div>
          )}
        {view.urgency &&
          row(
            t('card.urgency'),
            <Chip className={paletteFor('urgency', view.urgency).chip}>
              {t(`bands.urgency.${view.urgency}`)}
            </Chip>
          )}
        {(view.sentiment || view.mood) &&
          row(
            t('card.mood'),
            <div className="flex flex-wrap items-center gap-1.5">
              {view.sentiment && (
                <Chip className={paletteFor('sentiment', view.sentiment).chip}>
                  {t(`legend.families.sentiment.items.${view.sentiment}.label`)}
                </Chip>
              )}
              {(view.mood ?? [])
                // A known sentiment already says how calm they are.
                .filter((m) => !(m === 'calm' && view.sentiment))
                .map((m) => (
                  <Chip key={m} className={MOOD_SWATCH[m].chip}>
                    {m === 'calm' ? t('card.calm') : t(`bands.mood.${m}`)}
                  </Chip>
                ))}
              {trends.mood &&
                trendWord(
                  t(`trends.mood.${trends.mood}`),
                  TREND_ARROW[trends.mood]
                )}
            </div>
          )}
        {view.objections.length > 0 &&
          row(
            t('card.objections'),
            <div className="flex flex-wrap gap-1.5">
              {view.objections.map((o) => (
                <Chip key={o} className={paletteFor('objection', o).chip}>
                  {t(`legend.families.objection.items.${o}.label`)}
                </Chip>
              ))}
            </div>
          )}
        {actions.length > 0 &&
          row(
            t('actions.title'),
            <ul className="space-y-1.5">
              {actions.map((a) => {
                const sw = swatchOf(a.tone);
                return (
                  <li key={a.code} className={cn('border-l-2 pl-2', sw.stripe)}>
                    <p className={cn('text-sm font-medium', sw.text)}>
                      {t(`actions.codes.${a.code}`)}
                    </p>
                    <p className={cn('text-xs leading-snug', c.sub)}>
                      {t(`actions.hints.${a.code}`)}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        {events &&
          row(
            t('trends.title'),
            <TrendLines view={view} trends={trends} sub={c.sub} />
          )}
        <div className="flex flex-wrap items-center justify-between gap-1">
          {view.basedOnAt && (
            <p className={cn('text-xs', c.sub)}>
              {t('card.basedOn', {
                when: format.relativeTime(view.basedOnAt),
              })}
            </p>
          )}
          <InsightLegend className="-mr-1.5" />
        </div>
      </div>
    </div>
  );
  return <>{frame(t('card.title'), body)}</>;
}

function PinnedBanner({
  attention,
  canHandle,
  onHandled,
}: {
  attention: NonNullable<CustomerInsightView['attention']>;
  canHandle: boolean;
  onHandled: () => void;
}) {
  const t = useTranslations('InsightsUi');
  const format = useFormatter();
  const sw = paletteFor('attention', attention.reason ?? 'urgent');
  const when = format.relativeTime(attention.since);
  return (
    <div
      role="status"
      className={cn(
        'flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-xs',
        sw.chip
      )}
    >
      <p className="min-w-0 font-medium">
        {attention.reason
          ? t('card.pinned', {
              reason: t(
                `legend.families.attention.items.${attention.reason}.label`
              ),
              when,
            })
          : t('card.pinnedNoReason', { when })}
      </p>
      {canHandle && (
        <button
          type="button"
          onClick={onHandled}
          className="bg-card/70 hover:bg-card focus-visible:ring-ring shrink-0 rounded-md px-2 py-1 font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          {t('card.markHandled')}
        </button>
      )}
    </div>
  );
}

const SPARK_W = 96;
const SPARK_H = 20;

export function TrendLines({
  view,
  trends,
  sub,
}: {
  view: CustomerInsightView;
  trends: ReturnType<typeof insightTrends>;
  sub: string;
}) {
  const t = useTranslations('InsightsUi');
  const lines: {
    scale: SparklineScale;
    label: string;
    trend: string | null;
    colour: string;
  }[] = [
    {
      scale: 'sentiment',
      label: 'sparkMood',
      trend: trends.mood && t(`trends.mood.${trends.mood}`),
      colour: paletteFor('sentiment', view.sentiment ?? 'neutral').text,
    },
    {
      scale: 'leadTemp',
      label: 'sparkLead',
      trend: trends.lead && t(`trends.lead.${trends.lead}`),
      colour: paletteFor('lead', view.lead ?? 'cold').text,
    },
  ];
  const drawn = lines.flatMap((l) => {
    const values = sparklineValues(trends.series, l.scale);
    if (values.length < SPARKLINE_MIN_POINTS || !l.trend) return [];
    const d = sparklinePath(values, SPARKLINE_MAX[l.scale], SPARK_W, SPARK_H);
    return d ? [{ ...l, d, count: values.length }] : [];
  });
  if (drawn.length === 0)
    return (
      <p className={cn('text-xs', sub)}>{t('card.notEnoughHistory')}</p>
    );
  return (
    <div className="space-y-1">
      {drawn.map((l) => (
        <div key={l.scale} className="flex items-center gap-2">
          <span className={cn('w-10 shrink-0 text-xs', sub)}>
            {t(
              l.scale === 'sentiment'
                ? 'trends.mood.label'
                : 'trends.lead.label'
            )}
          </span>
          <svg
            role="img"
            aria-label={t(`card.${l.label}`, {
              count: l.count,
              trend: l.trend ?? '',
            })}
            viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
            width={SPARK_W}
            height={SPARK_H}
            className={cn('shrink-0', l.colour)}
          >
            <path
              d={l.d}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className={cn('text-xs', sub)}>{l.trend}</span>
        </div>
      ))}
    </div>
  );
}
