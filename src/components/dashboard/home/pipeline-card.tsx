'use client';

import { GitBranch } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { currencyTotalParts, currencyTotals } from '@/lib/currency-totals';
import { donutSegments, isMixed } from '@/lib/dashboard/home/donut';
import { loadPipelineDonut } from '@/lib/dashboard/queries';
import type { PipelineDonutData } from '@/lib/dashboard/types';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import { DashboardPanel, PanelEmpty } from './panel';
import { useWidgetData } from './use-widget-data';

export interface PipelineCardProps {
  refreshKey: number;
  className?: string;
}

export function PipelineCard({ refreshKey, className }: PipelineCardProps) {
  const t = useTranslations('Dashboard.pipelineDonut');
  const { defaultCurrency } = useAuth();
  const w = useWidgetData(`pipeline:${refreshKey}`, () =>
    loadPipelineDonut(createClient())
  );
  const data = w.data;

  return (
    <DashboardPanel
      title={t('title')}
      subtitle={t('description')}
      icon={GitBranch}
      tone="emerald"
      action={{ href: '/pipelines', label: t('viewPipelines') }}
      className={className}
      loading={w.loading && !w.data}
      error={w.error && !w.data}
      onRetry={w.reload}
    >
      {data &&
        (data.stages.length === 0 ? (
          <PanelEmpty
            icon={GitBranch}
            title={t('noOpenDeals')}
            hint={t('noOpenDealsHint')}
          />
        ) : (
          <>
            <Donut data={data} currency={defaultCurrency} />
            <ul className="mt-5 space-y-2">
              {data.stages.map((s) => (
                <li key={s.id} className="flex items-center gap-3 text-xs">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: s.color }}
                    aria-hidden
                  />
                  <span className="text-muted-foreground flex-1 truncate">
                    {s.name}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {t('dealCount', { count: s.dealCount })}
                  </span>
                  <span className="text-muted-foreground min-w-20 text-end tabular-nums">
                    {currencyTotalParts(
                      currencyTotals(s.totals, defaultCurrency),
                      'short'
                    ).map((part) => (
                      <span key={part} className="block">
                        {part}
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ))}
    </DashboardPanel>
  );
}

// ------------------------------------------------------------
// SVG ring. 200×200 viewBox, 18px ring width, one arc per stage
// (`lib/dashboard/home/donut.ts`).
// ------------------------------------------------------------
function Donut({
  data,
  currency,
}: {
  data: PipelineDonutData;
  currency: string;
}) {
  const t = useTranslations('Dashboard.pipelineDonut');
  const size = 200;
  const r = 80;
  const ringWidth = 18;
  const cx = size / 2;
  const cy = size / 2;
  const mixed = isMixed(data.stages, currency);
  const segments = donutSegments(data.stages, mixed, cx, cy, r);
  const total = currencyTotalParts(
    currencyTotals(
      data.stages.flatMap((s) => s.totals),
      currency
    ),
    'short'
  );

  return (
    <div className="flex flex-col items-center justify-center">
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className="h-48 w-48"
        role="img"
        aria-label={t('ariaLabel')}
      >
        {/* background ring */}
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="var(--muted)"
          strokeWidth={ringWidth}
        />
        {segments.map((seg) => (
          <path
            key={seg.id}
            d={seg.path}
            fill="none"
            stroke={seg.color}
            strokeWidth={ringWidth}
            strokeLinecap="butt"
          />
        ))}
        {/* center label: one line per currency, the block centred */}
        <text
          x={cx}
          y={cy - 6 - (total.length - 1) * 8}
          textAnchor="middle"
          className="fill-muted-foreground text-xs"
        >
          {t('total')}
        </text>
        {total.map((line, i) => (
          <text
            key={line}
            x={cx}
            y={cy + 14 - (total.length - 1) * 8 + i * 17}
            textAnchor="middle"
            className={cn(
              'fill-foreground font-semibold tabular-nums',
              mixed ? 'text-[14px]' : 'text-[18px]'
            )}
          >
            {line}
          </text>
        ))}
      </svg>
      {mixed && (
        <p className="text-muted-foreground mt-2 text-center text-xs">
          {t('mixedCurrencies')}
        </p>
      )}
    </div>
  );
}
