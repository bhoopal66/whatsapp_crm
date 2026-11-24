'use client';

import { useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import {
  insertContacts,
  planImport,
  type ImportPlan,
  type ImportProblem,
  type SavedElsewhere,
} from '@/lib/contacts/import-contacts';
import type {
  ParsedContactRow,
  ReadContactCsvResult,
} from '@/lib/contacts/parse-contact-csv';
import {
  CONTACT_FILE_ACCEPT,
  contactFileProblem,
  readContactFile,
} from '@/lib/contacts/read-contact-file';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Upload,
  FileText,
  Loader2,
  CheckCircle,
  XCircle,
  AlertTriangle,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

const PREVIEW_LIMIT = 5;
/** Rows listed by name; the rest are counted. */
const PROBLEM_LIMIT = 200;
const SAVED_ELSEWHERE_LIMIT = 20;

/** The rows that gave no contact, each with its line and reason. */
function ProblemList({ problems }: { problems: ImportProblem[] }) {
  const t = useTranslations('Contacts.importModal');
  if (problems.length === 0) return null;
  return (
    <div className="space-y-1 text-xs">
      <p className="text-foreground font-medium">
        {t('problemsTitle', { count: problems.length })}
      </p>
      <ul className="border-border divide-border/70 max-h-48 divide-y overflow-y-auto rounded-lg border">
        {problems.slice(0, PROBLEM_LIMIT).map((p, i) => (
          <li key={i} className="text-muted-foreground px-3 py-1.5">
            <span className="text-foreground font-medium">
              {p.line === null ? '—' : t('problemLine', { line: p.line })}
            </span>{' '}
            {p.phone && (
              <span dir="ltr" className="font-mono">
                {p.phone}
              </span>
            )}{' '}
            {p.reason === 'unreadable'
              ? t('problemUnreadable')
              : p.reason === 'no_phone'
                ? t('problemNoPhone')
                : p.reason === 'save'
                  ? t('problemNotSaved', { reason: p.detail ?? '' })
                  : p.detail}
          </li>
        ))}
      </ul>
      {problems.length > PROBLEM_LIMIT && (
        <p className="text-muted-foreground">
          {t('problemsMore', { count: problems.length - PROBLEM_LIMIT })}
        </p>
      )}
    </div>
  );
}

/** Numbers already a customer under another spelling of the number. */
function SavedElsewhereList({ items }: { items: SavedElsewhere[] }) {
  const t = useTranslations('Contacts.importModal');
  if (items.length === 0) return null;
  return (
    <div className="space-y-1 text-xs">
      <ul className="border-border divide-border/70 max-h-48 divide-y overflow-y-auto rounded-lg border">
        {items.slice(0, SAVED_ELSEWHERE_LIMIT).map((item, i) => (
          <li key={i} className="text-muted-foreground px-3 py-1.5">
            {item.line !== null && (
              <span className="text-foreground font-medium">
                {t('problemLine', { line: item.line })}
              </span>
            )}{' '}
            <span dir="ltr" className="font-mono">
              {item.phone}
            </span>{' '}
            {t('savedAs', { savedAs: item.savedAs })}
          </li>
        ))}
      </ul>
      {items.length > SAVED_ELSEWHERE_LIMIT && (
        <p className="text-muted-foreground">
          {t('problemsMore', { count: items.length - SAVED_ELSEWHERE_LIMIT })}
        </p>
      )}
    </div>
  );
}

function truncateFilename(name: string, max = 48): string {
  if (name.length <= max) return name;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  const base = name.slice(0, name.length - ext.length);
  const keep = max - ext.length - 1;
  return `${base.slice(0, Math.max(keep, 12))}…${ext}`;
}

function PreviewCell({
  value,
  mono,
  maxWidth = 'max-w-[9rem]',
}: {
  value: string;
  mono?: boolean;
  maxWidth?: string;
}) {
  return (
    <span
      className={cn('block truncate', maxWidth, mono && 'font-mono text-xs')}
      title={value}
    >
      {value}
    </span>
  );
}

interface ImportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}

export function ImportModal({
  open,
  onOpenChange,
  onImported,
}: ImportModalProps) {
  const t = useTranslations('Contacts.importModal');
  const supabase = createClient();
  const { accountId } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [parsedRows, setParsedRows] = useState<ParsedContactRow[]>([]);
  const [hasCompanyColumn, setHasCompanyColumn] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{
    imported: number;
    skipped: number;
    problems: ImportProblem[];
  } | null>(null);
  // What the file would do; null while it is being worked out.
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [planFailed, setPlanFailed] = useState(false);
  const [parsedFile, setParsedFile] = useState<ReadContactCsvResult | null>(
    null
  );
  const [confirmClose, setConfirmClose] = useState(false);
  // One number per file or import shown; an answer for an older one is
  // dropped, and an import whose number has passed stops.
  const run = useRef(0);

  function reset() {
    run.current++;
    setImporting(false);
    setPlan(null);
    setPlanFailed(false);
    setParsedFile(null);
    setConfirmClose(false);
    setFile(null);
    setParsedRows([]);
    setHasCompanyColumn(false);
    setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleOpenChange(next: boolean) {
    if (!next && importing) {
      setConfirmClose(true);
      return;
    }
    if (!next) reset();
    onOpenChange(next);
  }

  function stopAndClose() {
    reset();
    onOpenChange(false);
  }

  async function makePlan(parsed: ReadContactCsvResult) {
    const mine = ++run.current;
    setPlan(null);
    setPlanFailed(false);
    if (!accountId) {
      setPlanFailed(true);
      return;
    }
    try {
      const next = await planImport(parsed, (chunk) =>
        supabase
          .from('contacts')
          .select('phone_normalized')
          .eq('account_id', accountId)
          .in('phone_normalized', chunk)
      );
      if (run.current === mine) setPlan(next);
    } catch (err) {
      console.error('[import-modal] number check failed:', err);
      if (run.current === mine) setPlanFailed(true);
    }
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (!selected) return;

    const mine = ++run.current;
    setFile(selected);
    setResult(null);
    setPlan(null);
    setPlanFailed(false);

    let parsed: ReadContactCsvResult;
    try {
      // A `tags` column is ignored: contact tags are retired, and chat
      // tags belong to a conversation, which an import does not create.
      parsed = await readContactFile(selected);
    } catch (err) {
      if (run.current !== mine) return;
      reset();
      const { key, reason } = contactFileProblem(err);
      toast.error(t(key, { reason }));
      return;
    }
    if (run.current !== mine) return;
    const { rows, hasCompanyColumn: csvHasCompany } = parsed;
    setParsedFile(parsed);
    // The same file can be chosen again once it is corrected.
    e.target.value = '';

    // A file of nothing but problem rows still lists them.
    if (
      parsed.phoneColumn === null ||
      rows.length + parsed.badLines.length + parsed.noPhoneLines.length === 0
    ) {
      setParsedFile(null);
      toast.error(t('toastNoValidRows'));
      setParsedRows([]);
      setHasCompanyColumn(false);
      return;
    }

    setParsedRows(rows);
    setHasCompanyColumn(csvHasCompany);
    await makePlan(parsed);
  }

  async function handleImport() {
    if (!plan || plan.toInsert.length === 0) return;
    const mine = ++run.current;
    setImporting(true);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) throw new Error('Not authenticated');
      if (!accountId)
        throw new Error('Your profile is not linked to an account.');

      const done = await insertContacts(
        plan.toInsert,
        (batch) =>
          supabase.from('contacts').insert(
            batch.map((row) => ({
              user_id: user.id,
              account_id: accountId,
              phone: row.phone,
              name: row.name || null,
              email: row.email || null,
              company: row.company || null,
              // Came from a file (migration 249).
              lead_source: 'import' as const,
            }))
          ),
        () => run.current !== mine
      );

      // Also when the person stopped it: those contacts exist now.
      if (done.imported > 0) {
        toast.success(t('toastImported', { count: done.imported }));
        onImported();
      }
      if (run.current !== mine) return;
      const skipped = plan.alreadyThere + plan.repeats + done.alreadyThere;
      const problems = [...plan.problems, ...done.failed];
      setResult({ imported: done.imported, skipped, problems });
      if (skipped > 0) toast.info(t('toastSkipped', { count: skipped }));
      if (problems.length > 0)
        toast.error(t('toastFailed', { count: problems.length }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('toastError');
      if (run.current === mine) toast.error(message);
    } finally {
      if (run.current === mine) {
        setImporting(false);
        setConfirmClose(false);
      }
    }
  }

  const preview = parsedRows.slice(0, PREVIEW_LIMIT);
  // Company: AND — hide unless the CSV declares it and preview has data,
  // avoiding an all-dash column that wastes horizontal space.
  const previewHasCompany =
    hasCompanyColumn && preview.some((row) => row.company?.trim());

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-border/80 bg-popover text-popover-foreground flex max-h-[min(90vh,720px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <div className="border-border/80 shrink-0 space-y-4 border-b px-6 pt-6 pb-5">
          <DialogHeader className="gap-1.5">
            <DialogTitle className="text-popover-foreground text-lg">
              {t('title')}
            </DialogTitle>
            <DialogDescription
              className="text-muted-foreground leading-relaxed"
              dangerouslySetInnerHTML={{
                __html: t.markup('desc', {
                  phoneCode: (chunks) =>
                    `<code class="rounded bg-muted px-1 py-0.5 text-xs text-muted-foreground">${chunks}</code>`,
                  nameCode: (chunks) =>
                    `<code class="rounded bg-muted px-1 py-0.5 text-xs text-muted-foreground">${chunks}</code>`,
                  emailCode: (chunks) =>
                    `<code class="rounded bg-muted px-1 py-0.5 text-xs text-muted-foreground">${chunks}</code>`,
                  companyCode: (chunks) =>
                    `<code class="rounded bg-muted px-1 py-0.5 text-xs text-muted-foreground">${chunks}</code>`,
                  tagsCode: (chunks) =>
                    `<code class="rounded bg-muted px-1 py-0.5 text-xs text-muted-foreground">${chunks}</code>`,
                }),
              }}
            />
          </DialogHeader>

          <div
            role="button"
            tabIndex={0}
            aria-disabled={importing}
            onClick={() => {
              if (!importing) fileInputRef.current?.click();
            }}
            onKeyDown={(e) => {
              if (importing) return;
              if (e.key === 'Enter' || e.key === ' ')
                fileInputRef.current?.click();
            }}
            className={cn(
              'group flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-5 transition-all',
              file
                ? 'border-primary/35 bg-primary/[0.04]'
                : 'hover:border-primary/40 border-border/80 bg-background/40 hover:bg-background/70'
            )}
          >
            {file ? (
              <>
                <div className="bg-primary/15 ring-primary/25 flex size-10 items-center justify-center rounded-lg ring-1">
                  <FileText className="text-primary size-5" />
                </div>
                <p
                  className="text-popover-foreground max-w-full truncate px-2 text-sm font-medium"
                  title={file.name}
                >
                  {truncateFilename(file.name)}
                </p>
                <span className="bg-muted text-muted-foreground rounded-full px-2.5 py-0.5 text-xs font-medium">
                  {t('rowsReady', { count: parsedRows.length })}
                </span>
              </>
            ) : (
              <>
                <div className="bg-muted/80 ring-border/80 group-hover:bg-muted flex size-10 items-center justify-center rounded-lg ring-1 transition-colors">
                  <Upload className="text-muted-foreground group-hover:text-foreground size-5" />
                </div>
                <p className="text-muted-foreground text-sm">
                  {t('uploadDropzone')}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t('uploadHint')}
                </p>
              </>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept={CONTACT_FILE_ACCEPT}
            onChange={handleFileChange}
            className="hidden"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {parsedFile && !result && (
            <div className="mb-4 space-y-3" aria-live="polite">
              {planFailed ? (
                <div
                  role="alert"
                  className="bg-destructive-soft text-destructive flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm"
                >
                  <span>{t('planFailed')}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void makePlan(parsedFile)}
                  >
                    {t('retry')}
                  </Button>
                </div>
              ) : plan ? (
                <p className="text-foreground text-sm">
                  {t('planNew', { count: plan.toInsert.length })}
                  {' · '}
                  {t('planExisting', { count: plan.alreadyThere })}
                  {plan.repeats > 0 && (
                    <> · {t('planRepeats', { count: plan.repeats })}</>
                  )}
                </p>
              ) : (
                parsedRows.length > 0 && (
                  <p className="text-muted-foreground flex items-center gap-2 text-sm">
                    <Loader2 className="size-4 animate-spin" />
                    {t('planChecking')}
                  </p>
                )
              )}
              {plan && <SavedElsewhereList items={plan.savedElsewhere} />}
              {plan && <ProblemList problems={plan.problems} />}
            </div>
          )}

          {preview.length > 0 && !result && (
            <div className="space-y-3">
              <p className="text-muted-foreground text-xs font-semibold tracking-[0.14em] uppercase">
                {t('preview', { count: preview.length })}
              </p>

              <div className="border-border ring-border/50 overflow-hidden rounded-xl border ring-1">
                <div className="relative overflow-x-auto">
                  <table className="w-full min-w-[32rem] text-xs">
                    <thead>
                      <tr className="border-border bg-background/60 border-b">
                        <th className="text-muted-foreground px-3 py-2 text-start font-medium whitespace-nowrap">
                          {t('columns.phone')}
                        </th>
                        <th className="text-muted-foreground px-3 py-2 text-start font-medium whitespace-nowrap">
                          {t('columns.name')}
                        </th>
                        <th className="text-muted-foreground px-3 py-2 text-start font-medium whitespace-nowrap">
                          {t('columns.email')}
                        </th>
                        {previewHasCompany && (
                          <th className="text-muted-foreground px-3 py-2 text-start font-medium whitespace-nowrap">
                            {t('columns.company')}
                          </th>
                        )}
                      </tr>
                    </thead>
                    <tbody className="divide-border/70 divide-y">
                      {preview.map((row, i) => (
                        <tr
                          key={i}
                          className="bg-popover/40 hover:bg-muted/30 transition-colors"
                        >
                          <td className="text-muted-foreground px-3 py-2 whitespace-nowrap">
                            <PreviewCell
                              value={row.phone}
                              mono
                              maxWidth="max-w-[7.5rem]"
                            />
                          </td>
                          <td className="text-popover-foreground px-3 py-2">
                            <PreviewCell
                              value={row.name || '—'}
                              maxWidth="max-w-[8.5rem]"
                            />
                          </td>
                          <td className="text-muted-foreground px-3 py-2">
                            <PreviewCell
                              value={row.email || '—'}
                              maxWidth="max-w-[10rem]"
                            />
                          </td>
                          {previewHasCompany && (
                            <td className="text-muted-foreground px-3 py-2">
                              <PreviewCell
                                value={row.company || '—'}
                                maxWidth="max-w-[7rem]"
                              />
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {parsedRows.length > PREVIEW_LIMIT && (
                <p className="text-muted-foreground text-center text-xs">
                  {t('moreRows', { count: parsedRows.length - PREVIEW_LIMIT })}
                </p>
              )}
            </div>
          )}

          {result && (
            <div className="border-border bg-background/50 rounded-xl border p-4">
              <p className="text-popover-foreground text-sm font-medium">
                {t('importComplete')}
              </p>
              <div className="mt-3 flex flex-wrap gap-3">
                {result.imported > 0 && (
                  <div className="text-primary flex items-center gap-1.5 text-sm">
                    <CheckCircle className="size-4 shrink-0" />
                    {t('resultImported', { count: result.imported })}
                  </div>
                )}
                {result.skipped > 0 && (
                  <div className="text-warning flex items-center gap-1.5 text-sm">
                    <AlertTriangle className="size-4 shrink-0" />
                    {t('resultSkipped', { count: result.skipped })}
                  </div>
                )}
                {result.problems.length > 0 && (
                  <div className="text-destructive flex items-center gap-1.5 text-sm">
                    <XCircle className="size-4 shrink-0" />
                    {t('resultFailed', { count: result.problems.length })}
                  </div>
                )}
              </div>
              <div className="mt-3">
                <ProblemList problems={result.problems} />
              </div>
            </div>
          )}
        </div>

        {confirmClose && importing && (
          <div
            role="alertdialog"
            aria-label={t('closeConfirm')}
            className="border-border/80 flex shrink-0 flex-wrap items-center justify-between gap-2 border-t px-6 py-3 text-sm"
          >
            <span>{t('closeConfirm')}</span>
            <span className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setConfirmClose(false)}
              >
                {t('keepImporting')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                onClick={stopAndClose}
              >
                {t('stopAndClose')}
              </Button>
            </span>
          </div>
        )}

        <DialogFooter className="border-border/80 bg-background/50 mt-0 shrink-0 gap-2 border-t px-6 py-4 sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {result ? t('close') : t('cancel')}
          </Button>
          {!result && (
            <Button
              type="button"
              disabled={!plan || plan.toInsert.length === 0 || importing}
              onClick={handleImport}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {importing && <Loader2 className="size-4 animate-spin" />}
              {t('importBtn', { count: plan?.toInsert.length ?? 0 })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
