'use client';

import { useTranslations } from 'next-intl';
import { Landmark } from 'lucide-react';

import { bankTheme } from '@/lib/banks/theme';
import { cn } from '@/lib/utils';

/**
 * A bank as a tag filled with its brand colour (`lib/banks/theme.ts`). The
 * same tag in both themes; in dark mode a faint ring keeps a navy tag from
 * sinking into the card. Screen readers hear "Bank: <name>".
 */
export function BankTag({
  code,
  name,
  size = 'sm',
  className,
}: {
  code: string;
  name: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const t = useTranslations('SubmissionGroups');
  const theme = bankTheme(code);
  const label = t('bank', { bank: name });
  return (
    <span
      className={cn(
        // `relative` anchors the sr-only label to the tag, not the page.
        'relative inline-flex max-w-full min-w-0 shrink-0 items-center gap-1 rounded-full font-semibold dark:ring-1 dark:ring-white/20 dark:ring-inset',
        size === 'sm' ? 'px-1.5 py-px text-[11px]' : 'px-2 py-0.5 text-xs',
        className
      )}
      style={{ backgroundColor: theme.bg, color: theme.fg }}
      title={label}
    >
      <Landmark
        className={cn('shrink-0', size === 'sm' ? 'size-3' : 'size-3.5')}
        style={theme.accent ? { color: theme.accent } : undefined}
        aria-hidden
      />
      <span className="sr-only">{label}</span>
      <span className="truncate" aria-hidden>
        {name}
      </span>
    </span>
  );
}

/** A bank's colour as a dot, for the bank filter's options. */
export function BankSwatch({ code }: { code: string }) {
  return (
    <span
      aria-hidden
      className="size-2.5 shrink-0 self-center rounded-full dark:ring-1 dark:ring-white/25"
      style={{ backgroundColor: bankTheme(code).bg }}
    />
  );
}
