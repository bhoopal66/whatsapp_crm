'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export type ScopePurpose = 'edit' | 'delete' | 'move';
export type ScopeAnswer = 'this' | 'all' | null;

export interface ScopeQuestion {
  purpose: ScopePurpose;
  /**
   * A recurring event asks "This event / All events"; a single one only
   * confirms a delete, answering 'all'.
   */
  recurring: boolean;
}

/** "This event / All events" for edit, delete and drag; plain delete confirm. */
export function ScopeDialog({
  question,
  onAnswer,
}: {
  question: ScopeQuestion | null;
  onAnswer: (answer: ScopeAnswer) => void;
}) {
  const t = useTranslations('Calendar.scope');
  const purpose = question?.purpose ?? 'edit';
  const recurring = question?.recurring ?? true;
  return (
    <Dialog
      open={question !== null}
      onOpenChange={(open) => {
        if (!open) onAnswer(null);
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {recurring ? t(`title.${purpose}`) : t('confirmDeleteTitle')}
          </DialogTitle>
          {!recurring && (
            <DialogDescription>{t('confirmDeleteBody')}</DialogDescription>
          )}
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onAnswer(null)}>
            {t('cancel')}
          </Button>
          {recurring ? (
            <>
              <Button variant="outline" onClick={() => onAnswer('this')}>
                {t('this')}
              </Button>
              <Button
                variant={purpose === 'delete' ? 'destructive' : 'default'}
                onClick={() => onAnswer('all')}
              >
                {t('all')}
              </Button>
            </>
          ) : (
            <Button variant="destructive" onClick={() => onAnswer('all')}>
              {t('confirmDelete')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
