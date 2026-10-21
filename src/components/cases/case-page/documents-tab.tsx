'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { useWorkspaceMembers } from '@/components/meetings/use-workspace-members';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { GatedButton } from '@/components/ui/gated-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { docStatusLocked, type CaseTabProps } from '@/lib/cases/case-page';
import { toolErrorKey, validFileRef } from '@/lib/cases/case-tools-ui';
import { cn } from '@/lib/utils';

import { sendCaseRequest } from './case-dialogs';
import {
  asList,
  asObj,
  asStr,
  TabStatus,
  useCaseResource,
  useWhen,
} from './tab-kit';

type DocStatus = 'requested' | 'received' | 'rejected';
const DOC_STATUSES: readonly string[] = ['requested', 'received', 'rejected'];

interface DocItem {
  docKey: string;
  label: string;
  position: number;
  status: DocStatus | null;
  fileRef: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

function parse(json: unknown): { items: DocItem[]; missing: number } {
  const root = asObj(json);
  const items = asList(root?.items).flatMap((v) => {
    const r = asObj(v);
    const docKey = asStr(r?.docKey);
    if (!r || !docKey) return [];
    const status = asStr(r.status);
    return [
      {
        docKey,
        label: asStr(r.label) ?? docKey,
        position: typeof r.position === 'number' ? r.position : 0,
        status:
          status && DOC_STATUSES.includes(status)
            ? (status as DocStatus)
            : null,
        fileRef: asStr(r.fileRef),
        updatedBy: asStr(r.updatedBy),
        updatedAt: asStr(r.updatedAt),
      },
    ];
  });
  items.sort((a, b) => a.position - b.position);
  return {
    items,
    missing: Array.isArray(root?.missing)
      ? root.missing.length
      : items.filter((i) => i.status !== 'received').length,
  };
}

/** The bank + product checklist, with per-document status controls. */
export function DocumentsTab({ caseId, detail, onChanged }: CaseTabProps) {
  const t = useTranslations('CasePage');
  const when = useWhen();
  const { nameOf } = useWorkspaceMembers();
  const { data, failed, reload } = useCaseResource(
    `/api/cases/${caseId}/documents`,
    parse
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [receiving, setReceiving] = useState<DocItem | null>(null);

  if (!data)
    return (
      <TabStatus
        failed={failed}
        loading={t('documents.loading')}
        error={t('documents.loadFailed')}
        onRetry={() => void reload()}
      />
    );

  const closed = detail.case.closedAt !== null;
  const canAct = detail.permissions.canWrite && !closed;
  const gate = !detail.permissions.canWrite
    ? t('gate.write')
    : closed
      ? t('gate.closed')
      : undefined;
  // 134: Compass owns received / rejected; a request stays open.
  const lockedTo = (status: DocStatus) =>
    docStatusLocked(status, detail.locked);
  const gateFor = (status: DocStatus) =>
    gate ?? (lockedTo(status) ? t('gate.compass') : undefined);

  /** Saves a status; answers an error message, or null when saved. */
  const save = async (
    doc: DocItem,
    status: DocStatus,
    fileRef?: string
  ): Promise<string | null> => {
    setBusy(`${doc.docKey}:${status}`);
    const r = await sendCaseRequest(`/api/cases/${caseId}/documents`, 'POST', {
      doc_key: doc.docKey,
      status,
      ...(fileRef ? { file_ref: fileRef } : {}),
    });
    setBusy(null);
    if (!r.ok) {
      const code = (r.json as { code?: unknown } | null)?.code;
      return t(toolErrorKey(r.status, code));
    }
    toast.success(t('documents.saved'));
    void reload();
    // A received document can stop the document-chase timer in the header.
    onChanged();
    return null;
  };

  const quick = async (doc: DocItem, status: DocStatus) => {
    const error = await save(doc, status);
    if (error) toast.error(error);
  };

  return (
    <section className="bg-card space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{t('documents.title')}</h2>
        {data.items.length > 0 && (
          <Badge variant={data.missing > 0 ? 'outline' : 'secondary'}>
            {t('documents.missing', { count: data.missing })}
          </Badge>
        )}
      </div>

      {data.items.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {t('documents.noChecklist')}
        </p>
      ) : (
        <ul className="divide-y">
          {data.items.map((doc) => {
            const updated = when(doc.updatedAt);
            return (
              <li
                key={doc.docKey}
                className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium break-words">
                      {doc.label}
                    </span>
                    <Badge
                      variant={
                        doc.status === 'received'
                          ? 'secondary'
                          : doc.status === 'rejected'
                            ? 'destructive'
                            : 'outline'
                      }
                    >
                      {t(`documents.status.${doc.status ?? 'none'}`)}
                    </Badge>
                  </div>
                  {(doc.fileRef || updated) && (
                    <p className="text-muted-foreground text-xs break-all">
                      {[
                        doc.fileRef
                          ? t('documents.file', { ref: doc.fileRef })
                          : null,
                        updated
                          ? t('documents.updated', {
                              when: updated,
                              name: doc.updatedBy
                                ? (nameOf(doc.updatedBy) ?? t('unknownPerson'))
                                : t('system'),
                            })
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {doc.status !== 'requested' && (
                    <GatedButton
                      size="sm"
                      variant="ghost"
                      disabled={!canAct || busy !== null}
                      title={gate}
                      onClick={() => void quick(doc, 'requested')}
                    >
                      {busy === `${doc.docKey}:requested` && (
                        <Loader2 className="size-4 animate-spin" />
                      )}
                      {t('documents.markRequested')}
                    </GatedButton>
                  )}
                  <GatedButton
                    size="sm"
                    variant="ghost"
                    disabled={!canAct || busy !== null || lockedTo('received')}
                    title={gateFor('received')}
                    onClick={() => setReceiving(doc)}
                  >
                    {t('documents.markReceived')}
                  </GatedButton>
                  {doc.status !== 'rejected' && (
                    <GatedButton
                      size="sm"
                      variant="ghost"
                      className={cn(
                        canAct && !lockedTo('rejected') && 'text-destructive'
                      )}
                      disabled={
                        !canAct || busy !== null || lockedTo('rejected')
                      }
                      title={gateFor('rejected')}
                      onClick={() => void quick(doc, 'rejected')}
                    >
                      {busy === `${doc.docKey}:rejected` && (
                        <Loader2 className="size-4 animate-spin" />
                      )}
                      {t('documents.markRejected')}
                    </GatedButton>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {receiving && (
        <ReceiveDialog
          doc={receiving}
          onOpenChange={(o) => !o && setReceiving(null)}
          onSave={(ref) => save(receiving, 'received', ref)}
        />
      )}
    </section>
  );
}

function ReceiveDialog({
  doc,
  onOpenChange,
  onSave,
}: {
  doc: DocItem;
  onOpenChange: (open: boolean) => void;
  onSave: (fileRef: string) => Promise<string | null>;
}) {
  const t = useTranslations('CasePage');
  const [ref, setRef] = useState(doc.fileRef ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = ref.trim();

  const submit = async () => {
    if (!value) return setError(t('documents.errors.fileRefRequired'));
    if (!validFileRef(value))
      return setError(t('documents.errors.fileRefInvalid'));
    setBusy(true);
    setError(null);
    const failed = await onSave(value);
    setBusy(false);
    if (failed) return setError(failed);
    onOpenChange(false);
  };

  return (
    <Dialog open onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('documents.receiveTitle', { label: doc.label })}
          </DialogTitle>
          <DialogDescription>{t('documents.receiveBody')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="case-doc-ref">{t('documents.fileRef')}</Label>
          <Input
            id="case-doc-ref"
            value={ref}
            maxLength={128}
            autoComplete="off"
            aria-invalid={value !== '' && !validFileRef(value)}
            onChange={(e) => setRef(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
          />
          <p className="text-muted-foreground text-xs">
            {t('documents.fileRefHint')}
          </p>
        </div>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {t('cancel')}
          </Button>
          <Button disabled={!value || busy} onClick={() => void submit()}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {t('documents.confirmReceived')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
