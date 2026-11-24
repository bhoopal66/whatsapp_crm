'use client';

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { pressKeepMine } from '@/lib/flows/save-request';
import { useFlowEditor } from './flow-editor-state';

/**
 * Somebody else saved the flow. Closing it changes nothing: the edits stay
 * in the editor, unsaved.
 */
export function SaveConflictDialog() {
  const t = useTranslations('Flows.editorState');
  const format = useFormatter();
  const { conflict, dismissConflict, save, saving } = useFlowEditor();
  const [armedFor, setArmedFor] = useState<string | null>(null);
  if (!conflict) return null;

  const armed = armedFor === conflict.version;
  const at = format.dateTime(new Date(conflict.at), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const close = () => {
    setArmedFor(null);
    dismissConflict();
  };
  const keepMine = () => {
    const next = pressKeepMine(armedFor, conflict.version);
    setArmedFor(next.armedFor);
    if (next.save) void save(conflict.version);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('changedTitle')}</DialogTitle>
          <DialogDescription>
            {conflict.by
              ? t('changedBy', { name: conflict.by, time: at })
              : t('changedAt', { time: at })}{' '}
            {t('changedChoices')}
          </DialogDescription>
        </DialogHeader>
        {armed && (
          <p role="alert" className="text-destructive text-sm">
            {t('keepMineWarning')}
          </p>
        )}
        <DialogFooter>
          <Button
            variant={armed ? 'destructive' : 'outline'}
            onClick={keepMine}
            disabled={saving}
          >
            {armed ? t('keepMineConfirm') : t('keepMine')}
          </Button>
          <Button onClick={() => window.location.reload()} disabled={saving}>
            {t('reload')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
