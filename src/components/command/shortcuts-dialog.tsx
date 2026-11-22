'use client';

import { useTranslations } from 'next-intl';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { useModifierKeyName } from '@/components/command/use-modifier-key';
import type { ShortcutRow } from '@/lib/command/shortcuts';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: ShortcutRow[];
}

/** The `?` list: only shortcuts this person can use. */
export function ShortcutsDialog({ open, onOpenChange, rows }: Props) {
  const t = useTranslations('CommandBar');
  const tNav = useTranslations('Sidebar');
  const mod = useModifierKeyName();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogTitle>{t('shortcutsTitle')}</DialogTitle>
        <DialogDescription>{t('shortcutsDescription')}</DialogDescription>
        <ul className="divide-border divide-y">
          {rows.map((row) => (
            <li
              key={row.keys.join('+')}
              className="flex items-center justify-between gap-3 py-2"
            >
              <span className="text-sm">
                {row.commandKey
                  ? t(row.commandKey)
                  : t('goTo', { screen: tNav(row.labelKey as string) })}
              </span>
              <span className="flex shrink-0 items-center gap-1 text-xs">
                {row.keys.map((k, i) => (
                  <span key={`${k}-${i}`} className="flex items-center gap-1">
                    {i > 0 ? (
                      <span className="text-muted-foreground">{t('then')}</span>
                    ) : null}
                    <kbd className="border-border bg-muted rounded border px-1.5 py-0.5 font-sans">
                      {k === 'mod' ? mod : k.length === 1 ? k.toUpperCase() : k}
                    </kbd>
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
