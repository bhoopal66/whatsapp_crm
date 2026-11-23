'use client';

// "Delete this customer?" for the list (one or the ticked ones) and the
// customer page: what goes with them, what stays, who cannot be deleted
// (migration 280). Without the preview (not applied, or the call failed)
// it is the plain question it always was.

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { loadDeletePreview } from '@/lib/contacts/delete-contacts';
import {
  deleteDialogView,
  reasonsText,
  type DeleteDialogView,
  type PreviewState,
} from '@/lib/contacts/delete-preview';
import { createClient } from '@/lib/supabase/client';

export interface DeleteTarget {
  id: string;
  name: string;
}

interface Props {
  targets: readonly DeleteTarget[];
  /** The list's ticked customers: their own title and wording. */
  bulk?: boolean;
  deleting: boolean;
  onCancel: () => void;
  onDelete: (ids: string[]) => void;
}

export function DeleteContactsDialog({
  open,
  ...props
}: Props & { open: boolean }) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !props.deleting) props.onCancel();
      }}
    >
      <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-md">
        {/* Mounted with the pop-up, so every opening asks again. */}
        <Body key={props.targets.map((c) => c.id).join()} {...props} />
      </DialogContent>
    </Dialog>
  );
}

function Body({ targets, bulk = false, deleting, onCancel, onDelete }: Props) {
  const t = useTranslations('Contacts.page');
  const td = useTranslations('Contacts.deleteDialog');
  const [state, setState] = useState<PreviewState>({ kind: 'loading' });
  // Asked once per mount: the targets are the key.
  useEffect(() => {
    let live = true;
    void loadDeletePreview(
      createClient(),
      targets.map((c) => c.id)
    ).then((s) => {
      if (live) setState(s);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const view = deleteDialogView(
    targets.map((c) => c.id),
    state
  );
  const canDelete = view.deletable.length > 0;
  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-popover-foreground">
          {t(bulk ? 'deleteBulkTitle' : 'deleteContactTitle')}
        </DialogTitle>
        {canDelete && (
          <DialogDescription className="text-muted-foreground">
            {bulk
              ? t('deleteBulkDesc', { count: view.deletable.length })
              : t('deleteContactDesc', { name: targets[0]?.name ?? '' })}
          </DialogDescription>
        )}
      </DialogHeader>
      <DeleteSummary targets={targets} bulk={bulk} view={view} />
      <DialogFooter className="bg-popover border-border">
        <Button
          variant="outline"
          onClick={onCancel}
          disabled={deleting}
          className="border-border text-muted-foreground hover:bg-muted"
        >
          {canDelete ? t('cancel') : td('close')}
        </Button>
        {canDelete && (
          <Button
            variant="destructive"
            onClick={() => onDelete(view.deletable)}
            disabled={deleting || view.loading}
          >
            {deleting && <Loader2 className="size-4 animate-spin" />}
            {t('deleteBtn')}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

/** The dialog's middle, apart from the pop-up so a test can render it. */
export function DeleteSummary({
  targets,
  bulk,
  view,
}: {
  targets: readonly DeleteTarget[];
  bulk: boolean;
  view: DeleteDialogView;
}) {
  const t = useTranslations('Contacts.deleteDialog');
  const locale = useLocale();
  if (view.loading)
    return (
      <p
        role="status"
        className="text-muted-foreground flex items-center gap-2 text-sm"
      >
        <Loader2 className="size-4 animate-spin" />
        {t('checking')}
      </p>
    );
  const nameOf = (id: string) => targets.find((c) => c.id === id)?.name ?? id;
  const count = view.deletable.length;
  const groups = [
    { title: t('deletedTitle', { count }), rows: view.deleted },
    { title: t('keptTitle', { count }), rows: view.kept },
  ];
  return (
    <div className="space-y-3 text-sm">
      {view.blocked.length > 0 && (
        <div className="bg-warning-soft space-y-1 rounded-lg p-3">
          <p className="font-medium">
            {!bulk
              ? t('blockedOne')
              : count === 0
                ? t('blockedAll')
                : t('blockedSome', {
                    count: view.blocked.length + view.blockedMore,
                  })}
          </p>
          <ul className="text-muted-foreground list-disc ps-5">
            {view.blocked.map((b) => (
              <li key={b.id}>
                {bulk
                  ? t('blockedRow', {
                      name: nameOf(b.id),
                      reason: reasonsText(b, t, locale),
                    })
                  : reasonsText(b, t, locale)}
              </li>
            ))}
            {view.blockedMore > 0 && (
              <li>{t('more', { count: view.blockedMore })}</li>
            )}
          </ul>
          <p className="text-muted-foreground">{t('blockedHint')}</p>
        </div>
      )}
      {groups.map(
        (g) =>
          g.rows.length > 0 && (
            <div key={g.title}>
              <p className="font-medium">{g.title}</p>
              <ul className="text-muted-foreground list-disc ps-5">
                {g.rows.map((r) => (
                  <li key={r.kind}>{t(r.kind, { count: r.count })}</li>
                ))}
              </ul>
            </div>
          )
      )}
      {view.optOutNote && (
        <p className="text-muted-foreground text-xs">{t('optOutNote')}</p>
      )}
    </div>
  );
}
