'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  AlertTriangle,
  BadgeCheck,
  Loader2,
  Lock,
  Trash2,
  Upload,
  UserRound,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/ui-ext/confirm-dialog';
import {
  isKbStatus,
  kbEntryDraft,
  kbEntryPatch,
  kbStatusTone,
  parseKbImportHistory,
  parseKbImportResult,
  type KbEntryDraft,
  type KbImportRecord,
  type KbImportResult,
  type KbStatusTone,
} from '@/lib/kb/panel';
import {
  clientReadiness,
  isKbWorkbookName,
  kbEntryMatches,
  summarizeKb,
  type KbFilter,
} from '@/lib/kb/requests';
import {
  KB_AUDIENCES,
  KB_STATUSES,
  type KbAudience,
  type KbEntry,
  type KbStatus,
} from '@/lib/kb/types';
import { cn } from '@/lib/utils';

const TONE_CLASS: Record<KbStatusTone, string> = {
  success: 'bg-success-soft text-success',
  neutral: 'bg-secondary text-secondary-foreground',
  warning: 'bg-warning-soft text-warning',
  muted: 'bg-muted text-muted-foreground',
};

function StatusPill({ status }: { status: KbStatus }) {
  const t = useTranslations('AiApprovedAnswers');
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center rounded-full px-2 text-xs font-medium whitespace-nowrap',
        TONE_CLASS[kbStatusTone(status)]
      )}
    >
      {t(`status.${status}`)}
    </span>
  );
}

/**
 * Settings → AI Agents → Approved answers: the admin-approved Q&A rows
 * (migration 081) the bot sends word for word. Everyone reads; admins
 * import the review workbook and edit or delete rows.
 */
export function AiApprovedAnswers({
  accountId,
  canEdit,
}: {
  accountId: string | null;
  canEdit: boolean;
}) {
  const t = useTranslations('AiApprovedAnswers');
  const [entries, setEntries] = useState<KbEntry[]>([]);
  const [imports, setImports] = useState<KbImportRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<KbFilter>({
    audience: 'all',
    status: 'all',
    query: '',
  });
  const [uploading, setUploading] = useState(false);
  const [lastImport, setLastImport] = useState<KbImportResult | null>(null);
  const [editing, setEditing] = useState<KbEntry | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/kb', { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        setEntries(Array.isArray(data?.entries) ? data.entries : []);
        setImports(parseKbImportHistory(data?.imports));
      } else {
        toast.error(data?.error ?? t('loadFailed'));
      }
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    setLastImport(null);
    void fetchEntries();
  }, [accountId, fetchEntries]);

  // Counted from the list rather than the GET's `summary`, so an edit
  // or delete updates the strip without a reload.
  const summary = useMemo(() => summarizeKb(entries), [entries]);
  const readiness = clientReadiness(summary);
  const shown = useMemo(
    () => entries.filter((e) => kbEntryMatches(e, filter)),
    [entries, filter]
  );

  const uploadFile = async (file: File | undefined) => {
    if (!file) return;
    if (!isKbWorkbookName(file.name)) {
      toast.error(t('import.wrongType'));
      return;
    }
    setUploading(true);
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await fetch('/api/ai/kb/import', { method: 'POST', body });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(data?.error ?? t('import.failed'));
        return;
      }
      setLastImport(parseKbImportResult(data));
      toast.success(t('import.done'));
      await fetchEntries();
    } catch {
      toast.error(t('import.failed'));
    } finally {
      setUploading(false);
    }
  };

  const onSaved = (entry: KbEntry) => {
    setEntries((list) => list.map((e) => (e.id === entry.id ? entry : e)));
    setEditing(null);
  };
  const onDeleted = (id: string) => {
    setEntries((list) => list.filter((e) => e.id !== id));
    setEditing(null);
  };
  // The row changed since the dialog opened (a 409): close it and load
  // the current rows, so nobody approves text they have not seen.
  const onStale = () => {
    setEditing(null);
    void fetchEntries();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BadgeCheck className="text-primary h-4 w-4" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {loading && entries.length === 0 ? (
          <div className="text-muted-foreground flex items-center py-4 text-sm">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
          </div>
        ) : (
          <>
            <section className="border-border bg-muted/30 space-y-2 rounded-md border p-3">
              <p className="text-foreground text-sm font-medium">
                {t('readiness.headline', readiness)}
              </p>
              <ul className="text-muted-foreground space-y-0.5 text-xs">
                {KB_AUDIENCES.map((a) => (
                  <li key={a} className="flex flex-wrap gap-x-1.5">
                    <span className="text-foreground">
                      {t(`audience.${a}`)}:
                    </span>
                    <span>
                      {t('readiness.audienceLine', {
                        approved: summary[a].approved,
                        draft: summary[a].draft,
                        toConfirm: summary[a].to_confirm,
                        remove: summary[a].remove,
                      })}
                    </span>
                  </li>
                ))}
              </ul>
              {readiness.approved === 0 ? (
                <p className="bg-warning-soft text-warning flex items-start gap-2 rounded-md px-2.5 py-2 text-xs">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {t('readiness.noneApproved')}
                </p>
              ) : null}
            </section>

            {canEdit ? (
              <section className="space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    className="hidden"
                    onChange={(e) => {
                      void uploadFile(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                  >
                    {uploading ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Upload className="mr-2 h-4 w-4" />
                    )}
                    {uploading ? t('import.uploading') : t('import.button')}
                  </Button>
                  <p className="text-muted-foreground min-w-0 flex-1 text-xs">
                    {t('import.hint')}
                  </p>
                </div>
                {lastImport ? (
                  <ImportResultPanel
                    result={lastImport}
                    onDismiss={() => setLastImport(null)}
                  />
                ) : null}
                {imports.length > 0 ? (
                  <ImportHistory imports={imports} />
                ) : null}
              </section>
            ) : null}

            <section className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)]">
                <Select
                  value={filter.audience}
                  onValueChange={(v) =>
                    setFilter((f) => ({
                      ...f,
                      audience:
                        v && (KB_AUDIENCES as readonly string[]).includes(v)
                          ? (v as KbAudience)
                          : 'all',
                    }))
                  }
                >
                  <SelectTrigger
                    className="w-full"
                    aria-label={t('filters.audience')}
                  >
                    <SelectValue>
                      {filter.audience === 'all'
                        ? t('audience.all')
                        : t(`audience.${filter.audience}`)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('audience.all')}</SelectItem>
                    {KB_AUDIENCES.map((a) => (
                      <SelectItem key={a} value={a}>
                        {t(`audience.${a}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={filter.status}
                  onValueChange={(v) =>
                    setFilter((f) => ({
                      ...f,
                      status: isKbStatus(v) ? v : 'all',
                    }))
                  }
                >
                  <SelectTrigger
                    className="w-full"
                    aria-label={t('filters.status')}
                  >
                    <SelectValue>
                      {filter.status === 'all'
                        ? t('status.all')
                        : t(`status.${filter.status}`)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('status.all')}</SelectItem>
                    {KB_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {t(`status.${s}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  type="search"
                  value={filter.query}
                  onChange={(e) =>
                    setFilter((f) => ({ ...f, query: e.target.value }))
                  }
                  placeholder={t('filters.searchPlaceholder')}
                  aria-label={t('filters.search')}
                />
              </div>

              {entries.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  {canEdit ? t('table.emptyAdmin') : t('table.empty')}
                </p>
              ) : shown.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  {t('table.noMatch')}
                </p>
              ) : (
                <>
                  <p className="text-muted-foreground text-xs">
                    {t('table.count', {
                      shown: shown.length,
                      total: entries.length,
                    })}
                  </p>
                  <div className="border-border rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t('table.ref')}</TableHead>
                          <TableHead>{t('table.audience')}</TableHead>
                          <TableHead>{t('table.category')}</TableHead>
                          <TableHead>{t('table.question')}</TableHead>
                          <TableHead>{t('table.status')}</TableHead>
                          <TableHead>
                            <span className="sr-only">
                              {t('table.handoff')}
                            </span>
                            <UserRound className="h-3.5 w-3.5" aria-hidden />
                          </TableHead>
                          <TableHead>{t('table.version')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {shown.map((e) => (
                          <EntryRow
                            key={e.id}
                            entry={e}
                            onOpen={() => setEditing(e)}
                          />
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </>
              )}
            </section>
          </>
        )}
      </CardContent>

      {editing ? (
        <EditEntryDialog
          key={editing.id}
          entry={editing}
          canEdit={canEdit}
          onClose={() => setEditing(null)}
          onSaved={onSaved}
          onDeleted={onDeleted}
          onStale={onStale}
        />
      ) : null}
    </Card>
  );
}

function EntryRow({ entry, onOpen }: { entry: KbEntry; onOpen: () => void }) {
  const t = useTranslations('AiApprovedAnswers');
  const internal = entry.audience === 'internal_staff';
  return (
    <TableRow
      className="cursor-pointer"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          onOpen();
        }
      }}
    >
      <TableCell className="font-mono text-xs">{entry.ref}</TableCell>
      <TableCell className="text-xs">
        <span>{t(`audience.${entry.audience}`)}</span>
        {internal ? (
          <span className="text-muted-foreground mt-0.5 flex items-center gap-1 whitespace-nowrap">
            <Lock className="h-3 w-3" aria-hidden />
            {t('table.neverSent')}
          </span>
        ) : null}
      </TableCell>
      <TableCell className="text-muted-foreground text-xs">
        {entry.category}
      </TableCell>
      <TableCell className="max-w-[22rem] min-w-[14rem] whitespace-normal">
        <span className="line-clamp-2">{entry.question}</span>
      </TableCell>
      <TableCell>
        <StatusPill status={entry.status} />
      </TableCell>
      <TableCell>
        {entry.handoff_after ? (
          <span title={t('table.handoffTitle')}>
            <UserRound className="text-muted-foreground h-3.5 w-3.5" />
            <span className="sr-only">{t('table.handoffTitle')}</span>
          </span>
        ) : null}
      </TableCell>
      <TableCell className="text-muted-foreground text-xs">
        {t('table.versionValue', { version: entry.version })}
      </TableCell>
    </TableRow>
  );
}

function ImportResultPanel({
  result,
  onDismiss,
}: {
  result: KbImportResult;
  onDismiss: () => void;
}) {
  const t = useTranslations('AiApprovedAnswers');
  return (
    <div className="border-border space-y-2 rounded-md border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-foreground text-sm font-medium">
            {t('import.resultTitle')}
          </p>
          <p className="text-muted-foreground text-xs">
            {t('import.resultCounts', {
              inserted: result.inserted,
              updated: result.updated,
              unchanged: result.unchanged,
              skipped: result.skipped,
              approved: result.approved,
            })}
            {result.approved_internal > 0
              ? ` · ${t('import.approvedInternal', { count: result.approved_internal })}`
              : ''}
            {result.sheet
              ? ` · ${t('import.sheet', { sheet: result.sheet })}`
              : ''}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 shrink-0 p-0"
          onClick={onDismiss}
          aria-label={t('import.dismiss')}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      {result.issues.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t('import.noIssues')}</p>
      ) : (
        <div className="space-y-1">
          <p className="text-foreground text-xs font-medium">
            {t('import.issuesTitle', { count: result.issues.length })}
          </p>
          <div className="border-border max-h-64 overflow-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('import.issueRow')}</TableHead>
                  <TableHead>{t('import.issueRef')}</TableHead>
                  <TableHead>{t('import.issueMessage')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.issues.map((issue, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-xs">
                      {issue.row ?? '—'}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {issue.ref ?? '—'}
                    </TableCell>
                    <TableCell className="min-w-[16rem] text-xs whitespace-normal">
                      {issue.message}
                      {issue.skipped ? (
                        <span className="text-muted-foreground">
                          {' '}
                          · {t('import.issueSkipped')}
                        </span>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}

function ImportHistory({ imports }: { imports: KbImportRecord[] }) {
  const t = useTranslations('AiApprovedAnswers');
  const format = useFormatter();
  return (
    <div className="space-y-1">
      <p className="text-foreground text-xs font-medium">
        {t('history.title')}
      </p>
      <ul className="divide-border border-border divide-y rounded-md border text-xs">
        {imports.map((imp) => (
          <li key={imp.id} className="space-y-0.5 px-3 py-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="text-foreground min-w-0 truncate font-medium">
                {imp.file_name ?? t('history.untitled')}
              </span>
              <span className="text-muted-foreground shrink-0">
                {format.dateTime(new Date(imp.created_at), {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </span>
            </div>
            <p className="text-muted-foreground">
              {t('history.counts', {
                total: imp.total,
                inserted: imp.inserted,
                updated: imp.updated,
                unchanged: imp.unchanged,
                skipped: imp.skipped,
                approved: imp.approved,
              })}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EditEntryDialog({
  entry,
  canEdit,
  onClose,
  onSaved,
  onDeleted,
  onStale,
}: {
  entry: KbEntry;
  canEdit: boolean;
  onClose: () => void;
  onSaved: (entry: KbEntry) => void;
  onDeleted: (id: string) => void;
  onStale: () => void;
}) {
  const t = useTranslations('AiApprovedAnswers');
  const [draft, setDraft] = useState<KbEntryDraft>(() => kbEntryDraft(entry));
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const readOnly = !canEdit || busy;
  const set = <K extends keyof KbEntryDraft>(key: K, value: KbEntryDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const save = async () => {
    const patch = kbEntryPatch(entry, draft);
    if (!patch) {
      onClose();
      return;
    }
    if (patch.question === '') {
      toast.error(t('edit.questionRequired'));
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/ai/kb/${entry.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.entry) {
        toast.success(t('edit.saved'));
        onSaved(data.entry as KbEntry);
      } else if (res.status === 409) {
        toast.error(data?.error ?? t('edit.stale'));
        onStale();
      } else {
        toast.error(data?.error ?? t('edit.saveFailed'));
      }
    } catch {
      toast.error(t('edit.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setConfirmDelete(false);
    setBusy(true);
    try {
      const res = await fetch(`/api/ai/kb/${entry.id}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('edit.deleted'));
        onDeleted(entry.id);
        return;
      }
      const data = await res.json().catch(() => null);
      toast.error(data?.error ?? t('edit.deleteFailed'));
    } catch {
      toast.error(t('edit.deleteFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !busy) onClose();
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {canEdit
                ? t('edit.title', { ref: entry.ref })
                : t('edit.viewTitle', { ref: entry.ref })}
            </DialogTitle>
          </DialogHeader>

          {!canEdit ? (
            <p className="border-border bg-muted/40 text-muted-foreground rounded-md border px-3 py-2 text-xs">
              {t('edit.readOnly')}
            </p>
          ) : null}
          {entry.audience === 'internal_staff' ? (
            <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <Lock className="h-3 w-3" aria-hidden />
              {t('table.neverSent')}
            </p>
          ) : null}

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="kb-question">{t('edit.question')}</Label>
              <Textarea
                id="kb-question"
                value={draft.question}
                onChange={(e) => set('question', e.target.value)}
                rows={2}
                disabled={readOnly}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="kb-category">{t('edit.category')}</Label>
                <Input
                  id="kb-category"
                  value={draft.category}
                  onChange={(e) => set('category', e.target.value)}
                  disabled={readOnly}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t('edit.status')}</Label>
                <Select
                  value={draft.status}
                  onValueChange={(v) => {
                    if (isKbStatus(v)) set('status', v);
                  }}
                  disabled={readOnly}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue>{t(`status.${draft.status}`)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {KB_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {t(`status.${s}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="kb-answer-en">{t('edit.answerEn')}</Label>
              <Textarea
                id="kb-answer-en"
                value={draft.answer_en}
                onChange={(e) => set('answer_en', e.target.value)}
                rows={5}
                disabled={readOnly}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="kb-answer-ar">{t('edit.answerAr')}</Label>
              <Textarea
                id="kb-answer-ar"
                dir="rtl"
                lang="ar"
                value={draft.answer_ar}
                onChange={(e) => set('answer_ar', e.target.value)}
                rows={5}
                disabled={readOnly}
              />
            </div>
            <label className="text-foreground flex items-start gap-2 text-sm">
              <Checkbox
                checked={draft.handoff_after}
                onCheckedChange={(next) => set('handoff_after', next === true)}
                disabled={readOnly}
                className="mt-0.5"
              />
              <span>{t('edit.handoff')}</span>
            </label>
            <div className="space-y-1.5">
              <Label htmlFor="kb-notes">{t('edit.notes')}</Label>
              <Textarea
                id="kb-notes"
                value={draft.reviewer_notes}
                onChange={(e) => set('reviewer_notes', e.target.value)}
                rows={2}
                disabled={readOnly}
              />
            </div>
          </div>

          <DialogFooter className="sm:justify-between">
            {canEdit ? (
              <Button
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => setConfirmDelete(true)}
                disabled={busy}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {t('edit.delete')}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                {canEdit ? t('edit.cancel') : t('edit.close')}
              </Button>
              {canEdit ? (
                <Button onClick={() => void save()} disabled={busy}>
                  {busy ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {t('edit.saving')}
                    </>
                  ) : (
                    t('edit.save')
                  )}
                </Button>
              ) : null}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('edit.deleteTitle')}
        description={t('edit.deleteDescription', { ref: entry.ref })}
        cancelLabel={t('edit.cancel')}
        confirmLabel={t('edit.delete')}
        onConfirm={() => void remove()}
        destructive
      />
    </>
  );
}
