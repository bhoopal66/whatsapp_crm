'use client';

import type { ComponentType } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/**
 * One entry of the composer's "More" menu. Every entry shows an icon
 * and a word; the composer builds the list in one delimited block
 * (`moreMenuItems` in message-composer.tsx), so a new action is a new
 * array entry and nothing else.
 */
export interface ComposerMenuItem {
  /** Stable key, also used as `data-menu-item` for tests and styling. */
  id: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Shows a spinner in place of the icon (work in flight). */
  busy?: boolean;
  /** Leave the entry out (e.g. a feature that is switched off). */
  hidden?: boolean;
}

/**
 * The composer's single "More" menu: a "+" button, labelled "More" on
 * wider screens and by aria-label on a phone, opening every action that
 * is not attach, AI draft or mic/send.
 */
export function ComposerMoreMenu({
  items,
  disabled,
  title,
  className,
}: {
  items: ComposerMenuItem[];
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  const t = useTranslations('ComposerMenu');
  const visible = items.filter((item) => !item.hidden);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled || visible.length === 0}
        title={title}
        aria-label={t('moreLabel')}
        className={cn(
          'text-wa-icon hover:bg-wa-icon-hover inline-flex h-10 min-w-10 shrink-0 items-center justify-center gap-1 rounded-full p-0 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 sm:px-3',
          className
        )}
      >
        <Plus className="h-5 w-5" aria-hidden />
        <span className="max-sm:sr-only">{t('more')}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        className="border-border bg-popover w-auto min-w-52"
      >
        {visible.map((item) => {
          const Icon = item.icon;
          return (
            <DropdownMenuItem
              key={item.id}
              data-menu-item={item.id}
              disabled={item.disabled}
              onClick={item.onSelect}
              className="gap-2 py-2"
            >
              {item.busy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Icon className="h-4 w-4" aria-hidden />
              )}
              {item.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
