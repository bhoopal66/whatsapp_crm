import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
import type { ComponentType } from 'react'
import { cn } from '@/lib/utils'

/** Identity colour of a metric's icon tile. Decorative only: a tile's
 *  colour tells the cards apart at a glance and says nothing about
 *  whether the figure is good (the delta row's colour does that). */
export type IconTone = 'primary' | 'violet' | 'emerald' | 'amber'

export const ICON_TONE_CLASSES: Record<IconTone, string> = {
  primary: 'bg-primary-soft text-primary',
  violet: 'bg-violet-500/10 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300',
  emerald: 'bg-emerald-500/10 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300',
  amber: 'bg-amber-500/15 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300',
}

interface MetricCardProps {
  title: string
  /** Pre-formatted value for display (e.g. "42" or "$1,250"). */
  value: string
  icon: ComponentType<{ className?: string }>
  /**
   * Delta-mode secondary row: arrow + delta text. Omit when the metric
   * doesn't have a sensible comparison (e.g. total pipeline value).
   */
  delta?: {
    /** Positive / negative / zero drives arrow + color. */
    sign: number
    /** Pre-formatted delta, e.g. "+3 vs yesterday". */
    label: string
  }
  /** Used instead of `delta` when the metric has a static subtitle. */
  subtitle?: string
  tone?: IconTone
}

export function MetricCard({ title, value, icon: Icon, delta, subtitle, tone = 'primary' }: MetricCardProps) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-xs dark:shadow-none">
      <div className="flex items-start justify-between">
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        <div className={cn('flex h-9 w-9 items-center justify-center rounded-lg', ICON_TONE_CLASSES[tone])}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <p className="mt-3 text-[28px] leading-none font-bold tabular-nums text-foreground">
        {value}
      </p>
      {delta ? <DeltaRow sign={delta.sign} label={delta.label} /> : subtitle ? (
        <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p>
      ) : null}
    </div>
  )
}

function DeltaRow({ sign, label }: { sign: number; label: string }) {
  const tone =
    sign > 0
      ? 'text-success'
      : sign < 0
      ? 'text-destructive'
      : 'text-muted-foreground'
  const Arrow = sign > 0 ? ArrowUp : sign < 0 ? ArrowDown : Minus
  return (
    <div className={cn('mt-2 flex items-center gap-1 text-sm', tone)}>
      <Arrow className="h-4 w-4" aria-hidden />
      <span className="tabular-nums">{label}</span>
    </div>
  )
}
