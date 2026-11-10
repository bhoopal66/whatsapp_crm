'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle2, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  CASE_FILE_ACCEPT,
  buildCaseFilesView,
  caseFileErrorKey,
  checkFailureKey,
  formatFileSize,
  isAttachableDocument,
  parseCaseFiles,
  uploadProblem,
  validExpiry,
  type CaseFileChip,
  type CaseFileDocRow,
  type CaseFileSpecView,
  type CaseFileView,
} from '@/lib/case-files/view';
import {
  parseDocumentsResponse,
  type CustomerDocumentView,
} from '@/lib/customer-docs/view';
import { cn } from '@/lib/utils';

import { sendCaseRequest } from './case-dialogs';
import { TabStatus, useCaseResource, useWhen } from './tab-kit';

const CHIP_TONE: Record<CaseFileChip, string> = {
  missing: 'bg-muted text-muted-foreground',
  checking: 'bg-info-soft text-info',
  passed: 'bg-success-soft text-success',
  failed: 'bg-destructive-soft text-destructive',
};

type Reply = { status: number; ok: boolean; json: unknown };

/** POST multipart; the same shape `sendCaseRequest` answers. */
async function sendForm(url: string, form: FormData): Promise<Reply> {
  try {
    const res = await fetch(url, { method: 'POST', body: form });
    return {
      status: res.status,
      ok: res.ok,
      json: await res.json().catch(() => null),
    };
  } catch {
    return { status: 0, ok: false, json: null };
  }
}

const codeOf = (json: unknown) => (json as { code?: unknown } | null)?.code;

/**
 * The case's document files (migration 181) under the checklist: one row
 * per spec document, the unclassified files, and attach / upload /
 * classify. The server decides who may act; a closed case is read-only.
 */
export function CaseFilesSection({
  caseId,
  contactId,
  closed,
  labelOf,
  onChanged,
}: {
  caseId: string;
  contactId: string | null;
  closed: boolean;
  labelOf: (docKey: string) => string;
  onChanged: () => void;
}) {
  const t = useTranslations('CaseFiles');
  const { data, failed, reload } = useCaseResource(
    `/api/cases/${caseId}/files`,
    parseCaseFiles
  );
  const view = useMemo(() => (data ? buildCaseFilesView(data) : null), [data]);
  const [dialog, setDialog] = useState<{
    kind: 'attach' | 'upload';
    spec: CaseFileSpecView;
  } | null>(null);

  /** Toasts a refusal; on success refetches and tells the page. */
  const settle = (r: Reply, success: string | null): boolean => {
    if (!r.ok) {
      toast.error(t(caseFileErrorKey(r.status, codeOf(r.json))));
      return false;
    }
    if (success) toast.success(success);
    void reload();
    onChanged();
    return true;
  };

  if (!view)
    return (
      <section className="bg-card rounded-lg border p-3">
        <TabStatus
          failed={failed}
          loading={t('loading')}
          error={t('loadFailed')}
          onRetry={() => void reload()}
        />
      </section>
    );

  const canAct = !closed;

  return (
    <section className="bg-card space-y-3 rounded-lg border p-3">
      <div className="space-y-0.5">
        <h2 className="text-sm font-semibold">{t('title')}</h2>
        <p className="text-muted-foreground text-xs">
          {closed ? t('closedReadOnly') : t('hint')}
        </p>
      </div>

      {view.ready && (
        <div
          role="status"
          className="bg-success-soft text-success flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium"
        >
          <CheckCircle2 className="size-4 shrink-0" />
          {t('ready')}
        </div>
      )}

      {view.rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('noSpec')}</p>
      ) : (
        <ul className="divide-y">
          {view.rows.map((row) => (
            <DocRow
              key={row.spec.docKey}
              row={row}
              label={labelOf(row.spec.docKey)}
              canAct={canAct}
              onAttach={() => setDialog({ kind: 'attach', spec: row.spec })}
              onUpload={() => setDialog({ kind: 'upload', spec: row.spec })}
            />
          ))}
        </ul>
      )}

      {view.unclassified.length > 0 && (
        <Unclassified
          caseId={caseId}
          files={view.unclassified}
          specs={view.rows.map((r) => r.spec)}
          labelOf={labelOf}
          canAct={canAct}
          settle={settle}
        />
      )}

      {dialog?.kind === 'attach' && (
        <AttachDialog
          caseId={caseId}
          contactId={contactId}
          spec={dialog.spec}
          label={labelOf(dialog.spec.docKey)}
          onClose={() => setDialog(null)}
          settle={settle}
        />
      )}
      {dialog?.kind === 'upload' && (
        <UploadDialog
          caseId={caseId}
          spec={dialog.spec}
          label={labelOf(dialog.spec.docKey)}
          onClose={() => setDialog(null)}
          settle={settle}
        />
      )}
    </section>
  );
}

function DocRow({
  row,
  label,
  canAct,
  onAttach,
  onUpload,
}: {
  row: CaseFileDocRow;
  label: string;
  canAct: boolean;
  onAttach: () => void;
  onUpload: () => void;
}) {
  const t = useTranslations('CaseFiles');
  const [open, setOpen] = useState(false);
  const { current, history } = row;
  const versions = history.length + (current ? 1 : 0);

  return (
    <li className="space-y-1.5 py-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium break-words">{label}</span>
            <Badge variant="outline">
              {row.spec.required ? t('required') : t('optional')}
            </Badge>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-xs font-medium',
                CHIP_TONE[row.chip]
              )}
            >
              {t(`chip.${row.chip}`)}
            </span>
          </div>
          {current && (
            <p className="text-muted-foreground text-xs break-all">
              {[
                current.renamedName ?? current.originalName ?? t('unnamed'),
                current.pages !== null
                  ? t('pages', { count: current.pages })
                  : null,
                formatFileSize(current.sizeBytes),
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
          {row.failures.length > 0 && (
            <ul className="text-destructive space-y-0.5 text-xs">
              {row.failures.map((c, i) => (
                <li key={`${c.name}:${i}`}>{t(checkFailureKey(c))}</li>
              ))}
            </ul>
          )}
          {versions > 0 && (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
              aria-expanded={open}
              disabled={history.length === 0}
              onClick={() => setOpen((o) => !o)}
            >
              {history.length > 0 &&
                (open ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronRight className="size-3.5" />
                ))}
              {t('versions', { count: versions })}
            </button>
          )}
        </div>
        {canAct && (
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="ghost" onClick={onAttach}>
              {t('attach')}
            </Button>
            <Button size="sm" variant="ghost" onClick={onUpload}>
              {t('upload')}
            </Button>
          </div>
        )}
      </div>
      {open && history.length > 0 && (
        <ul className="bg-card-2 space-y-1 rounded-md border p-2">
          {history.map((f) => (
            <HistoryLine key={f.id} file={f} />
          ))}
        </ul>
      )}
    </li>
  );
}

function HistoryLine({ file }: { file: CaseFileView }) {
  const t = useTranslations('CaseFiles');
  const when = useWhen();
  return (
    <li className="text-muted-foreground text-xs break-all">
      {[
        file.version !== null ? t('version', { n: file.version }) : null,
        file.renamedName ?? file.originalName ?? t('unnamed'),
        t(`status.${file.status}`),
        formatFileSize(file.sizeBytes),
        when(file.registeredAt),
      ]
        .filter(Boolean)
        .join(' · ')}
    </li>
  );
}

function Unclassified({
  caseId,
  files,
  specs,
  labelOf,
  canAct,
  settle,
}: {
  caseId: string;
  files: CaseFileView[];
  specs: CaseFileSpecView[];
  labelOf: (docKey: string) => string;
  canAct: boolean;
  settle: (r: Reply, success: string | null) => boolean;
}) {
  const t = useTranslations('CaseFiles');
  const when = useWhen();
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [expiry, setExpiry] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const classify = async (file: CaseFileView) => {
    const docKey = picked[file.id];
    const expiresOn = expiry[file.id] ?? '';
    if (!docKey) return;
    if (!validExpiry(expiresOn)) return toast.error(t('expiryInvalid'));
    setBusy(file.id);
    const r = await sendCaseRequest(
      `/api/cases/${caseId}/files/${file.id}/classify`,
      'POST',
      { docKey, ...(expiresOn ? { expiresOn } : {}) }
    );
    setBusy(null);
    const result = (r.json as { result?: { status?: unknown } } | null)?.result;
    if (r.ok && result?.status === 'failed') {
      toast.error(t('checkedFailed', { label: labelOf(docKey) }));
      settle(r, null);
      return;
    }
    settle(r, t('checkedPassed', { label: labelOf(docKey) }));
  };

  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold">{t('unclassifiedTitle')}</h3>
        <p className="text-muted-foreground text-xs">{t('unclassifiedHint')}</p>
      </div>
      <ul className="space-y-2">
        {files.map((f) => {
          const docKey = picked[f.id] ?? '';
          const spec = specs.find((s) => s.docKey === docKey);
          return (
            <li
              key={f.id}
              className="bg-card-2 flex flex-col gap-2 rounded-md border p-2 sm:flex-row sm:items-center"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm break-all">
                  {f.originalName ?? t('unnamed')}
                </p>
                <p className="text-muted-foreground text-xs">
                  {[formatFileSize(f.sizeBytes), when(f.registeredAt)]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              {canAct && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <Select
                    value={docKey}
                    onValueChange={(v) =>
                      setPicked((p) => ({ ...p, [f.id]: String(v ?? '') }))
                    }
                  >
                    <SelectTrigger
                      size="sm"
                      className="w-44"
                      aria-label={t('pickDoc')}
                    >
                      <SelectValue>
                        {docKey ? labelOf(docKey) : t('pickDoc')}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {specs.map((s) => (
                        <SelectItem key={s.docKey} value={s.docKey}>
                          {labelOf(s.docKey)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {spec?.minValidDays != null && (
                    <Input
                      type="date"
                      className="h-8 w-40"
                      aria-label={t('expiresOn')}
                      value={expiry[f.id] ?? ''}
                      onChange={(e) =>
                        setExpiry((x) => ({ ...x, [f.id]: e.target.value }))
                      }
                    />
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!docKey || busy !== null}
                    onClick={() => void classify(f)}
                  >
                    {busy === f.id && (
                      <Loader2 className="size-4 animate-spin" />
                    )}
                    {docKey
                      ? t('checkAs', { label: labelOf(docKey) })
                      : t('checkAsEmpty')}
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The optional expiry field, shown for a document the expiry check needs. */
function ExpiryField({
  id,
  spec,
  value,
  onChange,
}: {
  id: string;
  spec: CaseFileSpecView;
  value: string;
  onChange: (v: string) => void;
}) {
  const t = useTranslations('CaseFiles');
  if (spec.minValidDays === null) return null;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{t('expiresOn')}</Label>
      <Input
        id={id}
        type="date"
        value={value}
        aria-invalid={!validExpiry(value)}
        onChange={(e) => onChange(e.target.value)}
      />
      <p className="text-muted-foreground text-xs">
        {t('expiryHint', { days: spec.minValidDays })}
      </p>
    </div>
  );
}

function AttachDialog({
  caseId,
  contactId,
  spec,
  label,
  onClose,
  settle,
}: {
  caseId: string;
  contactId: string | null;
  spec: CaseFileSpecView;
  label: string;
  onClose: () => void;
  settle: (r: Reply, success: string | null) => boolean;
}) {
  const t = useTranslations('CaseFiles');
  const when = useWhen();
  const [docs, setDocs] = useState<CustomerDocumentView[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [expiresOn, setExpiresOn] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!contactId) return;
    let live = true;
    void fetch(`/api/contacts/${encodeURIComponent(contactId)}/documents`, {
      cache: 'no-store',
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!live) return;
        const parsed = parseDocumentsResponse(json);
        if (!parsed) return setLoadFailed(true);
        setDocs(parsed.documents.filter(isAttachableDocument));
      })
      .catch(() => live && setLoadFailed(true));
    return () => {
      live = false;
    };
  }, [contactId]);

  const submit = async () => {
    if (!picked || !validExpiry(expiresOn)) return;
    setBusy(true);
    const r = await sendCaseRequest(
      `/api/cases/${caseId}/files/attach`,
      'POST',
      {
        customerDocumentId: picked,
        docKey: spec.docKey,
        ...(expiresOn ? { expiresOn } : {}),
      }
    );
    setBusy(false);
    if (settle(r, t('attached', { label }))) onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('attachTitle', { label })}</DialogTitle>
          <DialogDescription>{t('attachBody')}</DialogDescription>
        </DialogHeader>
        {!contactId ? (
          <p className="text-muted-foreground text-sm">
            {t('errors.NO_CONTACT')}
          </p>
        ) : loadFailed ? (
          <p className="text-muted-foreground text-sm">
            {t('attachLoadFailed')}
          </p>
        ) : !docs ? (
          <p className="text-muted-foreground text-sm" aria-busy="true">
            {t('attachLoading')}
          </p>
        ) : docs.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('attachEmpty')}</p>
        ) : (
          <ul
            role="radiogroup"
            aria-label={t('attachTitle', { label })}
            className="max-h-72 space-y-1 overflow-y-auto"
          >
            {docs.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={picked === d.id}
                  onClick={() => setPicked(d.id)}
                  className={cn(
                    'bg-card-2 hover:bg-muted w-full rounded-md border px-3 py-2 text-left',
                    picked === d.id && 'border-primary ring-primary/30 ring-2'
                  )}
                >
                  <span className="block text-sm break-all">
                    {d.name ?? t('unnamed')}
                  </span>
                  <span className="text-muted-foreground block text-xs">
                    {[formatFileSize(d.sizeBytes), when(d.receivedAt)]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <ExpiryField
          id="case-file-attach-expiry"
          spec={spec}
          value={expiresOn}
          onChange={setExpiresOn}
        />
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            disabled={!picked || busy || !validExpiry(expiresOn)}
            onClick={() => void submit()}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {t('attachConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UploadDialog({
  caseId,
  spec,
  label,
  onClose,
  settle,
}: {
  caseId: string;
  spec: CaseFileSpecView;
  label: string;
  onClose: () => void;
  settle: (r: Reply, success: string | null) => boolean;
}) {
  const t = useTranslations('CaseFiles');
  const [file, setFile] = useState<File | null>(null);
  const [expiresOn, setExpiresOn] = useState('');
  const [busy, setBusy] = useState(false);
  const problem = file ? uploadProblem(file) : null;

  const submit = async () => {
    if (!file || problem || !validExpiry(expiresOn)) return;
    const form = new FormData();
    form.append('file', file);
    form.append('docKey', spec.docKey);
    if (expiresOn) form.append('expiresOn', expiresOn);
    setBusy(true);
    const r = await sendForm(`/api/cases/${caseId}/files`, form);
    setBusy(false);
    if (settle(r, t('uploaded', { label }))) onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('uploadTitle', { label })}</DialogTitle>
          <DialogDescription>{t('uploadBody')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="case-file-upload">{t('pickFile')}</Label>
          <Input
            id="case-file-upload"
            type="file"
            accept={CASE_FILE_ACCEPT}
            aria-invalid={problem !== null}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          {problem && (
            <p role="alert" className="text-destructive text-xs">
              {problem === 'size' ? t('uploadTooLarge') : t('uploadWrongType')}
            </p>
          )}
        </div>
        <ExpiryField
          id="case-file-upload-expiry"
          spec={spec}
          value={expiresOn}
          onChange={setExpiresOn}
        />
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            disabled={
              !file || problem !== null || busy || !validExpiry(expiresOn)
            }
            onClick={() => void submit()}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {t('uploadConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
