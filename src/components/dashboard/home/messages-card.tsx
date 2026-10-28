'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { createClient } from '@/lib/supabase/client';
import { loadConversationsSeries } from '@/lib/dashboard/queries';
import type { ConversationsSeriesPoint } from '@/lib/dashboard/types';
import { cn } from '@/lib/utils';
import { DashboardPanel, PanelEmpty } from './panel';
import { useWidgetData } from './use-widget-data';

type RangeDays = 7 | 30 | 90;
const RANGES: RangeDays[] = [7, 30, 90];

export interface MessagesCardProps {
  refreshKey: number;
  className?: string;
}

// VB_W is only the first-paint width: LineSvg re-measures its wrapper
// and draws at 1:1 pixels, so the axis text renders at its real size.
// A fixed 760-wide viewBox scaled a 10px label down to ~8px in a
// narrow card, which read as unreadable grey specks.
const VB_W = 760;
const VB_H = 240;
const PADDING = { top: 16, right: 16, bottom: 30, left: 44 };
const INCOMING_COLOR = 'var(--chart-2)';
const OUTGOING_COLOR = 'var(--chart-1)';

export function MessagesCard({ refreshKey, className }: MessagesCardProps) {
  const t = useTranslations('Dashboard.conversationsChart');
  const [range, setRange] = useState<RangeDays>(30);
  const w = useWidgetData(`messages:${range}:${refreshKey}`, async () => ({
    range,
    series: await loadConversationsSeries(createClient(), range),
  }));
  // Another range's series is not stale data for this one: after a switch
  // the chart shows a skeleton (or the error) until this range answers,
  // never the old range's line under the new button.
  const data = w.data && w.data.range === range ? w.data.series : null;

  // Memoise the max so per-day hover math doesn't recompute it.
  const { maxY, niceTicks } = useMemo(() => {
    const arr = data ?? [];
    const max = arr.reduce((m, p) => Math.max(m, p.incoming, p.outgoing), 0);
    const ceil = niceCeil(max);
    const ticks = [0, ceil / 4, ceil / 2, (3 * ceil) / 4, ceil].map((v) =>
      Math.round(v)
    );
    // De-dupe when the series is flat 0.
    return { maxY: ceil, niceTicks: Array.from(new Set(ticks)) };
  }, [data]);

  return (
    <DashboardPanel
      title={t('title')}
      subtitle={t('description')}
      icon={MessageSquare}
      className={className}
      loading={w.loading && !data}
      error={w.error && !data}
      onRetry={w.reload}
      aside={
        <div className="bg-muted/60 flex items-center gap-1 rounded-lg p-1">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={range === r}
              onClick={() => setRange(r)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                range === r
                  ? 'bg-secondary text-secondary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {t('days', { count: r })}
            </button>
          ))}
        </div>
      }
    >
      {data &&
        (data.every((p) => p.incoming === 0 && p.outgoing === 0) ? (
          <PanelEmpty
            icon={MessageSquare}
            title={t('noActivity')}
            hint={t('noActivityHint')}
          />
        ) : (
          <>
            <LineSvg data={data} maxY={maxY} ticks={niceTicks} t={t} />
            <div className="text-muted-foreground mt-3 flex items-center gap-4 text-xs">
              <LegendDot color={INCOMING_COLOR} label={t('incoming')} />
              <LegendDot color={OUTGOING_COLOR} label={t('outgoing')} />
            </div>
          </>
        ))}
    </DashboardPanel>
  );
}

// ------------------------------------------------------------
// The actual SVG. Two polylines + per-day hit targets for hover.
// ------------------------------------------------------------

function LineSvg({
  data,
  maxY,
  ticks,
  t,
}: {
  data: ConversationsSeriesPoint[];
  maxY: number;
  ticks: number[];
  t: ReturnType<typeof useTranslations>;
}) {
  // Hover state: both the snapped index AND the tooltip's pixel
  // offset inside the wrapper div. They're stored together so the
  // tooltip positions against the chart's actual rendered pixels,
  // not against a raw viewBox percentage. See the precision note on
  // the onMove handler below.
  const [hover, setHover] = useState<{
    idx: number;
    tooltipLeftPx: number;
  } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [vbW, setVbW] = useState(VB_W);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (w > 0) setVbW(w);
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  const chartW = vbW - PADDING.left - PADDING.right;
  const chartH = VB_H - PADDING.top - PADDING.bottom;

  // x step can be fractional for 90-day views; points are positioned
  // at the center of each "slot" so the first and last points don't
  // sit right on the axis.
  const stepX = data.length > 1 ? chartW / (data.length - 1) : 0;
  const yFor = (v: number) =>
    maxY === 0
      ? PADDING.top + chartH
      : PADDING.top + chartH - (v / maxY) * chartH;
  const xFor = (i: number) => PADDING.left + i * stepX;

  const incomingPath = data
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${xFor(i)},${yFor(p.incoming)}`)
    .join(' ');
  const outgoingPath = data
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${xFor(i)},${yFor(p.outgoing)}`)
    .join(' ');

  // Mouse-move: use the SVG's current screen-CTM to map clientX
  // back to viewBox coordinates. The previous rect-based math
  // assumed the viewBox filled the SVG DOM box linearly, but
  // `preserveAspectRatio="xMidYMid meet"` (the SVG default)
  // letterboxes the content horizontally when the container is
  // wider than the viewBox aspect — so hover snapped hundreds of
  // pixels off on wide layouts. CTM-inverse correctly accounts for
  // letterboxing, scaling, and any future transform changes.
  useEffect(() => {
    const svg = svgRef.current;
    const wrap = wrapRef.current;
    if (!svg || !wrap) return;
    const onMove = (e: MouseEvent) => {
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      const pt = svg.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const local = pt.matrixTransform(ctm.inverse());
      const xVb = local.x;
      if (xVb < PADDING.left - 8 || xVb > vbW - PADDING.right + 8) {
        setHover(null);
        return;
      }
      const relative = xVb - PADDING.left;
      const idx = Math.max(
        0,
        Math.min(
          data.length - 1,
          Math.round(stepX === 0 ? 0 : relative / stepX)
        )
      );
      // Map the snapped data-point's viewBox x back to screen, then
      // subtract the wrapper's left edge — that pixel offset is what
      // the absolutely-positioned tooltip div consumes. `xFor` is
      // inlined here so the effect deps stay stable (it's a closure
      // that'd otherwise be a new reference every render).
      const dataPointVbX = PADDING.left + idx * stepX;
      const dataPointPt = svg.createSVGPoint();
      dataPointPt.x = dataPointVbX;
      dataPointPt.y = 0;
      const screen = dataPointPt.matrixTransform(ctm);
      const wrapRect = wrap.getBoundingClientRect();
      setHover({ idx, tooltipLeftPx: screen.x - wrapRect.left });
    };
    const onLeave = () => setHover(null);
    svg.addEventListener('mousemove', onMove);
    svg.addEventListener('mouseleave', onLeave);
    return () => {
      svg.removeEventListener('mousemove', onMove);
      svg.removeEventListener('mouseleave', onLeave);
    };
    // xFor + yFor close over stepX, so stepX covers them.
  }, [data, stepX, vbW]);

  const hovered = hover !== null ? data[hover.idx] : null;
  const hoverX = hover !== null ? xFor(hover.idx) : 0;

  // X-axis label strategy: show ~6 evenly-spaced labels regardless
  // of range so the axis never looks crowded.
  const labelStride = Math.max(1, Math.ceil(data.length / 6));

  return (
    <div ref={wrapRef} className="relative w-full">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${vbW} ${VB_H}`}
        className="h-[240px] w-full"
        role="img"
        aria-label={t('ariaLabel')}
      >
        {/* Y-axis gridlines + labels */}
        {ticks.map((t) => {
          const y = yFor(t);
          return (
            <g key={t}>
              <line
                x1={PADDING.left}
                x2={vbW - PADDING.right}
                y1={y}
                y2={y}
                stroke="var(--border)"
                strokeDasharray="3 3"
              />
              <text
                x={PADDING.left - 8}
                y={y}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-muted-foreground text-xs"
              >
                {t}
              </text>
            </g>
          );
        })}

        {/* X-axis labels */}
        {data.map((p, i) =>
          i % labelStride === 0 ? (
            <text
              key={p.day}
              x={xFor(i)}
              y={VB_H - 8}
              textAnchor="middle"
              className="fill-muted-foreground text-xs"
            >
              {shortDayLabel(p.day)}
            </text>
          ) : null
        )}

        {/* Outgoing polyline (the accent, --chart-1) */}
        <path
          d={outgoingPath}
          fill="none"
          stroke={OUTGOING_COLOR}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Incoming polyline (--chart-2) */}
        <path
          d={incomingPath}
          fill="none"
          stroke={INCOMING_COLOR}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Hover crosshair */}
        {hover !== null && (
          <g pointerEvents="none">
            <line
              x1={hoverX}
              x2={hoverX}
              y1={PADDING.top}
              y2={PADDING.top + chartH}
              stroke="var(--muted-foreground)"
              strokeDasharray="3 3"
            />
            <circle
              cx={hoverX}
              cy={yFor(data[hover.idx].incoming)}
              r={3.5}
              fill={INCOMING_COLOR}
            />
            <circle
              cx={hoverX}
              cy={yFor(data[hover.idx].outgoing)}
              r={3.5}
              fill={OUTGOING_COLOR}
            />
          </g>
        )}
      </svg>

      {/* Tooltip — absolute-positioned div so we get crisp text, not
          SVG-rendered text. The left offset comes from the CTM-based
          mapping so it lines up with the actual crosshair pixel, not a
          letterboxed viewBox percentage. */}
      {hovered && hover !== null && (
        <div
          className="border-border bg-popover pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-md border px-2.5 py-1.5 text-xs shadow-lg"
          style={{ left: `${hover.tooltipLeftPx}px` }}
        >
          <div className="text-popover-foreground font-medium">
            {longDayLabel(hovered.day)}
          </div>
          <div className="mt-1 flex flex-col gap-0.5">
            <span className="text-popover-foreground flex items-center gap-1.5">
              <span className="bg-chart-2 inline-block h-2 w-2 rounded-full" />
              {t('tooltipIncoming', { count: hovered.incoming })}
            </span>
            <span className="text-popover-foreground flex items-center gap-1.5">
              <span className="bg-chart-1 inline-block h-2 w-2 rounded-full" />
              {t('tooltipOutgoing', { count: hovered.outgoing })}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: color }}
      />
      {label}
    </span>
  );
}

function shortDayLabel(key: string): string {
  // key is YYYY-MM-DD; return "Apr 17"-style. Using Date with an
  // appended time avoids timezone-shift surprises across midnight.
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function longDayLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Round `max` up to a "nice" number so Y-axis ticks feel natural
 * (1, 2, 5, 10, 20, 50, …). Keeps the chart readable even when the
 * series is small (max=3 becomes ceil=4, not 3).
 */
function niceCeil(max: number): number {
  if (max <= 0) return 4;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  const normalised = max / pow;
  let nice: number;
  if (normalised <= 1) nice = 1;
  else if (normalised <= 2) nice = 2;
  else if (normalised <= 5) nice = 5;
  else nice = 10;
  return nice * pow;
}
