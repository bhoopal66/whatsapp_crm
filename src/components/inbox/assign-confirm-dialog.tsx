'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';

import { ConfirmDialog } from '@/components/ui-ext/confirm-dialog';
import { assignChangeKind } from '@/lib/inbox/assign-confirm';

/**
 * The question before a chat changes hands, for every screen that offers
 * Assign. It is worded from the assignee the screen shows NOW
 * (`currentId`), so a realtime change while it is open rewords it, and
 * one that already did what was asked closes it.
 */
export function AssignConfirmDialog({
  open,
  customer,
  currentId,
  currentName,
  nextId,
  nextName,
  meanwhile,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  customer: string;
  currentId: string | null;
  currentName: string;
  nextId: string | null;
  nextName: string;
  /** Asked again: the write found another assignee than the screen's. */
  meanwhile: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations('Inbox.messageThread');
  const tRows = useTranslations('InboxRows');
  const kind = assignChangeKind(currentId, nextId);

  const overtaken = open && kind === null;
  useEffect(() => {
    if (overtaken) onCancel();
  }, [overtaken, onCancel]);

  let title = t('confirmAssignTitle');
  let description = meanwhile
    ? tRows('meanwhileAssign', { name: nextName })
    : t('confirmAssignBody', { customer, name: nextName });
  let confirmLabel = t('assign');
  if (kind === 'reassign') {
    title = t('confirmReassignTitle');
    description = meanwhile
      ? tRows('meanwhileReassign', { current: currentName, name: nextName })
      : t('confirmReassignBody', {
          customer,
          from: currentName,
          to: nextName,
        });
    confirmLabel = t('confirmReassignAction');
  } else if (kind === 'unassign') {
    title = t('confirmUnassignTitle');
    description = meanwhile
      ? tRows('meanwhileUnassign', { current: currentName })
      : t('confirmUnassignBody', { customer, name: currentName });
    confirmLabel = t('unassign');
  }

  return (
    <ConfirmDialog
      open={open && kind !== null}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      title={title}
      description={description}
      cancelLabel={t('confirmAssignCancel')}
      confirmLabel={confirmLabel}
      onConfirm={onConfirm}
    />
  );
}
