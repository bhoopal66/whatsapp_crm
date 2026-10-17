'use client';

// The Call report page's recharts chart (module 015). Loaded in its own
// chunk by call-stats-report.tsx, as Team activity loads its charts.

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { DAILY_SERIES, type DailyPoint } from '@/lib/pbx/call-stats-ui';

/** Stacked bars per day (answered in, out, missed), talk minutes as a line. */
export function DailyTrendChart({
  data,
  labels,
}: {
  data: DailyPoint[];
  labels: Record<keyof Omit<DailyPoint, 'day'>, string>;
}) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={data} margin={{ top: 5, right: 0, left: 0 }}>
        <CartesianGrid className="stroke-border stroke-1" vertical={false} />
        <XAxis
          dataKey="day"
          tickLine={false}
          axisLine={false}
          fill=""
          stroke=""
          className="fill-muted-foreground text-xs"
          minTickGap={8}
        />
        <YAxis
          yAxisId="calls"
          width={32}
          allowDecimals={false}
          tickLine={false}
          axisLine={false}
          fill=""
          stroke=""
          className="fill-muted-foreground text-xs"
        />
        <YAxis
          yAxisId="talk"
          orientation="right"
          width={40}
          tickLine={false}
          axisLine={false}
          fill=""
          stroke=""
          className="fill-muted-foreground text-xs"
        />
        <Tooltip
          cursor={{ fill: 'var(--muted)', opacity: 0.4 }}
          content={({ active, payload, label }) =>
            active && payload?.length ? (
              <div className="border-border bg-popover rounded-md border text-sm shadow-md">
                <p className="text-popover-foreground border-border border-b px-3 py-1.5 font-medium">
                  {label}
                </p>
                <div className="space-y-0.5 px-3 py-1.5">
                  {payload.map((p) => (
                    <p
                      key={String(p.dataKey)}
                      className="flex justify-between gap-6"
                    >
                      <span className="text-muted-foreground">
                        {labels[p.dataKey as keyof typeof labels]}
                      </span>
                      <span className="text-popover-foreground font-medium tabular-nums">
                        {p.value}
                      </span>
                    </p>
                  ))}
                </div>
              </div>
            ) : null
          }
        />
        {DAILY_SERIES.map((s) => (
          <Bar
            key={s.key}
            yAxisId="calls"
            dataKey={s.key}
            stackId="calls"
            fill=""
            className={s.fill}
            isAnimationActive={false}
          />
        ))}
        <Line
          yAxisId="talk"
          dataKey="talkMinutes"
          type="monotone"
          stroke=""
          className="stroke-violet-500"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
