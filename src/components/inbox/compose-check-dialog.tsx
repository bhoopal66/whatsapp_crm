'use client';

import type { RefObject } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Send, ShieldAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  warningTone,
  type ComposeCheckCode,
} from '@/lib/insights/compose-check-view';
import { cn } from '@/lib/utils';

/** One plain-words line per warning, most serious first. */
export function ComposeCheckWarningList({
  warnings,
}: {
  warnings: readonly ComposeCheckCode[];
}) {
  const t = useTranslations('ComposeCheck');
  return (
    <ul className="space-y-2">
      {warnings.map((code) => {
        const tone = warningTone(code);
        const Icon = tone === 'destructive' ? ShieldAlert : AlertTriangle;
        return (
          <li
            key={code}
            className={cn(
              'text-foreground flex items-start gap-2 rounded-lg border p-2.5 text-sm',
              tone === 'destructive'
                ? 'border-destructive/30 bg-destructive-soft'
                : 'border-warning/30 bg-warning-soft'
            )}
          >
            <Icon
              aria-hidden
              className={cn(
                'mt-0.5 size-4 shrink-0',
                tone === 'destructive' ? 'text-destructive' : 'text-warning'
              )}
            />
            <span>{t(`warning.${code}`)}</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * "Check this message before sending". Nothing has gone out while it
 * is open; closing it any other way than Send anyway is an edit.
 */
export function ComposeCheckDialog({
  warnings,
  onEdit,
  onSendAnyway,
  focusOnClose,
}: {
  /** Null keeps the dialog closed. */
  warnings: readonly ComposeCheckCode[] | null;
  onEdit: () => void;
  onSendAnyway: () => void;
  /** Where focus goes when the dialog closes (the text box or caption). */
  focusOnClose: RefObject<HTMLElement | null>;
}) {
  const t = useTranslations('ComposeCheck');
  return (
    <Dialog
      open={warnings !== null}
      onOpenChange={(open) => {
        if (!open) onEdit();
      }}
    >
      <DialogContent className="sm:max-w-md" finalFocus={focusOnClose}>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {warnings && <ComposeCheckWarningList warnings={warnings} />}
        <DialogFooter>
          <Button variant="outline" onClick={onEdit}>
            {t('edit')}
          </Button>
          <Button onClick={onSendAnyway}>
            <Send className="mr-1 size-4" />
            {t('sendAnyway')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
