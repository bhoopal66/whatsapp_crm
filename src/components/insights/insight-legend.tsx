'use client';

import { CircleHelp } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  PALETTE_FAMILIES,
  PALETTE_KEYS,
  paletteFor,
  type PaletteFamily,
  type PaletteKey,
} from '@/lib/insights/palette';
import { cn } from '@/lib/utils';

/**
 * "What do the colours mean?": the Smart insights colour system
 * (lib/insights/palette.ts) explained, one section per family, each value
 * as its chip and a one-line meaning. The popover's body is exported on
 * its own so it can be rendered (and tested) without opening it.
 */
export function InsightLegend({ className }: { className?: string }) {
  const t = useTranslations('InsightsUi.legend');
  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          'text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:outline-none',
          className
        )}
      >
        <CircleHelp className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {t('trigger')}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-[min(32rem,calc(100vh-6rem))] w-[min(22rem,calc(100vw-1rem))] overflow-y-auto"
      >
        <PopoverTitle>{t('title')}</PopoverTitle>
        <InsightLegendContent />
      </PopoverContent>
    </Popover>
  );
}

/** The legend's sections, in {@link PALETTE_FAMILIES} order. */
export function InsightLegendContent() {
  const t = useTranslations('InsightsUi.legend');
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-xs">{t('intro')}</p>
      {PALETTE_FAMILIES.map((family) => (
        <LegendSection key={family} family={family} />
      ))}
    </div>
  );
}

function LegendSection({ family }: { family: PaletteFamily }) {
  const t = useTranslations('InsightsUi.legend.families');
  const keys = PALETTE_KEYS[family] as readonly PaletteKey<typeof family>[];
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-semibold">{t(`${family}.title`)}</h3>
      <ul className="flex flex-col gap-1">
        {keys.map((key) => (
          <li key={key} className="flex items-start gap-2 text-xs">
            <span
              className={cn(
                'inline-flex shrink-0 items-center rounded px-1.5 text-[10px] leading-4 font-semibold',
                paletteFor(family, key).chip
              )}
            >
              {t(`${family}.items.${key}.label`)}
            </span>
            <span className="text-muted-foreground">
              {t(`${family}.items.${key}.meaning`)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
