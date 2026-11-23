'use client';

import { Search } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useModifierKeyName } from '@/components/command/use-modifier-key';
import { openCommandBar } from '@/lib/command/events';

/**
 * A labelled button that opens the command bar. Icon only on a phone;
 * from `sm` up it also shows the shortcut. Place it in any header.
 */
export function CommandBarTrigger() {
  const t = useTranslations('CommandBar');
  const mod = useModifierKeyName();
  return (
    <button
      type="button"
      onClick={openCommandBar}
      aria-keyshortcuts="Control+K Meta+K"
      aria-haspopup="dialog"
      title={t('trigger', { key: mod })}
      className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-10 items-center justify-center gap-2 rounded-md px-2.5 transition-colors"
    >
      <Search className="h-5 w-5" aria-hidden="true" />
      <kbd className="border-border bg-muted hidden rounded border px-1.5 py-0.5 font-sans text-xs sm:inline">
        {mod} K
      </kbd>
      <span className="sr-only">{t('placeholder')}</span>
    </button>
  );
}
