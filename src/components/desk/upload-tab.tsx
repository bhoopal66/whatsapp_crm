'use client';

/**
 * The desk's Upload tab, in three plain steps for office staff: what is
 * it, which case (or which company, for a new case), then the file. The
 * server decides filing exactly as before: nothing here picks a case for
 * the person, and an incomplete upload is still accepted and waits to be
 * sorted (the form only says so). One idempotency key per attempt,
 * reused on retry, as before.
 */
import { useRef, useState } from 'react';
import Link from 'next/link';
import {
  CircleAlert,
  CircleCheck,
  Copy,
  Info,
  type LucideIcon,
  XCircle,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { docTypeLabel, docTypeOptions } from '@/lib/desk/doc-types';
import { newCaseMissing } from '@/lib/desk/form-hints';
import {
  caseBankView,
  fileSizeText,
  quickDocTypes,
  resultLine,
  uploadButtonState,
  visibleUploadSteps,
} from '@/lib/desk/friendly';
import { newIdemKey } from '@/lib/desk/intake-form';
import type { UploadPrefill } from '@/lib/desk/my-uploads';
import type { DeskBank, ItemKind, ItemResult } from '@/lib/desk/store';
import { deskTabHref } from '@/lib/desk/tabs';
import { replayDropsChange, uploadSignature } from '@/lib/desk/upload-replay';

import { CaseRefStatus } from './case-ref-status';
import { deskApi } from './desk-api';
import { DeskFilePicker } from './desk-file-picker';
import { DeskSelect } from './desk-select';
import { DisabledHint } from './disabled-hint';
import {
  EMPTY_DRAFT,
  NewCaseFields,
  draftToTags,
  type TagDraft,
} from './tag-fields';
import { useCaseLookup } from './use-case-lookup';
import { useDocTypes } from './use-doc-types';

const KINDS: ItemKind[] = ['pending_doc', 'new_case', 'info'];

/** Big enough to tap on a phone, the usual size from `sm` up. */
const TAP = 'min-h-11 sm:min-h-9';
const FIELD = 'h-11 sm:h-9';
const FOCUS =
  'outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

function bankName(banks: readonly DeskBank[], code: string | null) {
  if (code === null) return null;
  return banks.find((b) => b.bankCode === code)?.bankName ?? code;
}

/** What was sent with a result: the result itself does not carry it. */
interface SentResult {
  item: ItemResult;
  kind: ItemKind | '';
  docKey: string;
}

export function UploadTab({
  banks,
  initial,
}: {
  banks: readonly DeskBank[];
  /** A rejected upload's kind and case, from My uploads' "Upload a new file". */
  initial?: UploadPrefill | null;
}) {
  const t = useTranslations('Desk');
  const tf = useTranslations('DeskForms');
  const tu = useTranslations('DeskFriendly');
  const locale = useLocale();
  const docTypes = useDocTypes();
  const [draft, setDraft] = useState<TagDraft>(() =>
    initial
      ? { ...EMPTY_DRAFT, kind: initial.kind, caseRef: initial.caseRef }
      : EMPTY_DRAFT
  );
  const [caption, setCaption] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [otherDoc, setOtherDoc] = useState(false);
  const [results, setResults] = useState<SentResult[] | null>(null);
  // One key per upload attempt, reused on retry, so a resend after a
  // timeout returns the first result instead of a second item.
  const idem = useRef(newIdemKey());
  // What the first attempt under this key carried; a replayed answer is
  // that first item, so a different draft now has not been applied.
  const firstSent = useRef<{ sig: string; what: string } | null>(null);
  const [dropped, setDropped] = useState<string | null>(null);

  // Looked up as the number is typed; never chosen for the person.
  const lookup = useCaseLookup(draft.kind === 'new_case' ? '' : draft.caseRef);
  const found = lookup.status === 'found' ? lookup.found : null;
  const set = <K extends keyof TagDraft>(k: K, v: TagDraft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const missing = newCaseMissing({
    legalName: draft.companyName,
    licence: draft.tradeLicence,
    bankCode: draft.bankCode,
    product: draft.product,
    hasContact: draft.contact !== null,
  });
  const button = uploadButtonState({
    kind: draft.kind,
    fileCount: file ? 1 : 0,
    foundCaseNumber: found?.caseNumber ?? null,
    busy,
    caseRef: draft.caseRef,
    caption,
    newCaseMissing: missing,
  });
  const steps = visibleUploadSteps({
    kind: draft.kind,
    step2HasValue:
      draft.caseRef.trim() !== '' ||
      draft.bankCode !== '' ||
      draft.companyName.trim() !== '' ||
      draft.tradeLicence.trim() !== '' ||
      draft.product.trim() !== '' ||
      draft.contact !== null,
    step3HasValue:
      file !== null ||
      draft.docKey !== '' ||
      draft.note.trim() !== '' ||
      caption.trim() !== '',
    showAll,
  });
  const bankView =
    draft.kind === 'new_case'
      ? 'select'
      : caseBankView({
          foundBankCode: found ? found.bankCode : undefined,
          chosenBankCode: draft.bankCode,
        });
  const quick = quickDocTypes(docTypes, draft.docKey);
  const showDocSelect =
    otherDoc ||
    (draft.docKey !== '' && !quick.some((d) => d.key === draft.docKey));

  const submit = async () => {
    setBusy(true);
    const form = new FormData();
    form.set('idemKey', idem.current);
    if (caption.trim()) form.set('caption', caption.trim());
    for (const [k, v] of Object.entries(draftToTags(draft)))
      if (v !== null) form.set(k, v);
    if (file) form.set('file', file);
    const tags = draftToTags(draft);
    const sig = uploadSignature({
      tags,
      caption,
      file: file ? { name: file.name, size: file.size } : null,
    });
    firstSent.current ??= {
      sig,
      what:
        [
          tags.kind ? t(`kind.${tags.kind}`) : null,
          tags.bankCode ? bankName(banks, tags.bankCode) : null,
          caption.trim() || null,
        ]
          .filter(Boolean)
          .join(' · ') || t('result.noDetails'),
    };
    const r = await deskApi.submit(form);
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    const { what } = firstSent.current;
    if (replayDropsChange(r.data.replayed, firstSent.current.sig, sig)) {
      // Keep the draft: the server did not take it. The first attempt is
      // known to be stored, so sending again is a second upload of its own
      // (the only way out for a note without a file).
      idem.current = newIdemKey();
      firstSent.current = null;
      setResults(null);
      setDropped(what);
      return;
    }
    setDropped(null);
    firstSent.current = null;
    setResults([{ item: r.data, kind: draft.kind, docKey: draft.docKey }]);
    idem.current = newIdemKey();
    // "Upload more" starts from the same kind and bank.
    setDraft({ ...EMPTY_DRAFT, kind: draft.kind, bankCode: draft.bankCode });
    setCaption('');
    setFile(null);
    setOtherDoc(false);
  };

  if (results)
    return (
      <Card>
        <CardContent className="space-y-3">
          <h2 className="text-base font-semibold">{tu('result.heading')}</h2>
          {results.map((r) => (
            <ResultCard key={r.item.itemId} sent={r} banks={banks} />
          ))}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button className={TAP} onClick={() => setResults(null)}>
              {tu('actions.uploadMore')}
            </Button>
            <Button
              variant="outline"
              className={TAP}
              nativeButton={false}
              render={<Link href={deskTabHref('mine')} />}
            >
              {tu('actions.seeMine')}
            </Button>
          </div>
        </CardContent>
      </Card>
    );

  const whyId = 'desk-upload-why';
  return (
    <Card>
      <CardContent>
        <form
          className="space-y-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (!button.disabled) void submit();
          }}
        >
          <Step n={1} title={tu('steps.kind')}>
            <div
              role="radiogroup"
              aria-label={tu('steps.kind')}
              className="grid gap-2 sm:grid-cols-3"
            >
              {KINDS.map((k) => {
                const on = draft.kind === k;
                return (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => set('kind', on ? '' : k)}
                    className={`min-h-11 rounded-lg border p-3 text-start transition-colors ${FOCUS} ${
                      on
                        ? 'border-primary bg-primary/10 ring-primary/40 ring-2'
                        : 'border-input bg-card hover:bg-muted'
                    }`}
                  >
                    <span className="block text-sm font-medium">
                      {t(`kind.${k}`)}
                    </span>
                    <span className="text-muted-foreground mt-0.5 block text-xs">
                      {tu(`kindHelp.${k}`)}
                    </span>
                  </button>
                );
              })}
            </div>
            {steps === 1 && (
              <Button
                type="button"
                variant="link"
                className={`${TAP} px-0`}
                onClick={() => setShowAll(true)}
              >
                {tu('steps.showAll')}
              </Button>
            )}
          </Step>

          {steps >= 2 && (
            <Step
              n={2}
              title={
                draft.kind === 'new_case'
                  ? tu('steps.newCase')
                  : tu('steps.case')
              }
            >
              <div className="grid gap-3 sm:grid-cols-2">
                {draft.kind !== 'new_case' && (
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="desk-ref">{t('fields.caseRef')}</Label>
                    <Input
                      id="desk-ref"
                      className={FIELD}
                      value={draft.caseRef}
                      placeholder="4271RAKD / TC-26-04271-RAK"
                      onChange={(e) => set('caseRef', e.target.value)}
                      autoComplete="off"
                    />
                    <CaseRefStatus
                      lookup={lookup}
                      banks={banks}
                      notFoundText={tu('case.notFoundHint')}
                    />
                  </div>
                )}
                {bankView === 'readonly' && found ? (
                  <div className="space-y-1.5">
                    <p className="text-sm font-medium">
                      {tu('case.bankFromCase')}
                    </p>
                    <p className="bg-card-2 rounded-md px-3 py-2 text-sm">
                      {bankName(banks, found.bankCode) ?? '—'}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <Label htmlFor="desk-bank">{t('fields.bank')}</Label>
                    <DeskSelect
                      id="desk-bank"
                      className={`w-full ${FIELD}`}
                      value={draft.bankCode}
                      onChange={(v) => set('bankCode', v)}
                      noneLabel={t('fields.bankNone')}
                      placeholder={t('fields.bankNone')}
                      options={banks.map((b) => ({
                        value: b.bankCode,
                        label: `${b.bankName}${b.shortCode ? ` (${b.shortCode})` : ''}`,
                      }))}
                    />
                    {bankView === 'mismatch' && found && (
                      <p
                        role="status"
                        className="text-warning flex items-start gap-1.5 text-xs"
                      >
                        <CircleAlert
                          aria-hidden
                          className="mt-0.5 size-3.5 shrink-0"
                        />
                        {tu('case.bankMismatch', {
                          caseBank: bankName(banks, found.bankCode) ?? '—',
                          chosen: bankName(banks, draft.bankCode) ?? '—',
                        })}
                      </p>
                    )}
                  </div>
                )}
                {draft.kind === 'new_case' && (
                  <NewCaseFields
                    draft={draft}
                    onChange={setDraft}
                    inputClassName={FIELD}
                  />
                )}
              </div>
            </Step>
          )}

          {steps >= 3 && (
            <Step n={3} title={tu('steps.file')}>
              <div className="space-y-1.5">
                <Label htmlFor="desk-file">{t('fields.file')}</Label>
                <DeskFilePicker
                  id="desk-file"
                  file={file}
                  accept="application/pdf,image/jpeg,image/png"
                  onChange={(f) => {
                    setFile(f);
                    idem.current = newIdemKey();
                    firstSent.current = null;
                    setDropped(null);
                  }}
                />
                {file && (
                  <p className="text-muted-foreground text-xs">
                    {tu('file.size', { size: fileSizeText(file.size, locale) })}
                  </p>
                )}
                <p className="text-muted-foreground text-xs">
                  {t('fields.fileHint')}
                </p>
              </div>

              <fieldset className="space-y-1.5">
                <legend className="mb-1.5 text-sm font-medium">
                  {tu('doc.label')}
                </legend>
                <div className="flex flex-wrap gap-2">
                  {quick.map((d) => {
                    const on = draft.docKey === d.key;
                    return (
                      <Chip
                        key={d.key}
                        on={on}
                        onClick={() => {
                          setOtherDoc(false);
                          set('docKey', on ? '' : d.key);
                        }}
                      >
                        {d.label}
                      </Chip>
                    );
                  })}
                  <Chip
                    on={showDocSelect}
                    onClick={() => setOtherDoc((o) => !o)}
                  >
                    {tu('doc.other')}
                  </Chip>
                </div>
                {showDocSelect && (
                  <div className="space-y-1.5 pt-1">
                    <Label htmlFor="desk-doc">{tu('doc.otherLabel')}</Label>
                    <DeskSelect
                      id="desk-doc"
                      className={`w-full ${FIELD}`}
                      value={draft.docKey}
                      onChange={(v) => set('docKey', v)}
                      noneLabel={tf('docType.none')}
                      placeholder={tf('docType.placeholder')}
                      options={docTypeOptions(docTypes, draft.docKey)}
                    />
                  </div>
                )}
              </fieldset>

              <div className="space-y-1.5">
                <Label htmlFor="desk-note">{t('fields.note')}</Label>
                <Textarea
                  id="desk-note"
                  rows={2}
                  value={draft.note}
                  onChange={(e) => set('note', e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="desk-caption">{t('fields.caption')}</Label>
                <Input
                  id="desk-caption"
                  className={FIELD}
                  value={caption}
                  placeholder="4271RAKD ejari · NEW RAK Kite Trading 123456"
                  onChange={(e) => setCaption(e.target.value)}
                />
                <p className="text-muted-foreground text-xs">
                  {t('fields.captionHint')}
                </p>
              </div>
            </Step>
          )}

          {steps >= 3 && (
            <div className="space-y-2">
              <Button
                type="submit"
                size="lg"
                className={`w-full sm:w-auto ${TAP}`}
                disabled={button.disabled}
                aria-describedby={button.missingKey ? whyId : undefined}
              >
                {tu(button.labelKey, button.values)}
              </Button>
              {button.missingKey && (
                <DisabledHint id={whyId}>{tu(button.missingKey)}</DisabledHint>
              )}
              {!button.missingKey && button.waitKey && (
                <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
                  <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    {tu(button.waitKey, {
                      fields: missing
                        .map((m) => tf(`why.newCase.fields.${m}`))
                        .join(', '),
                    })}
                  </span>
                </p>
              )}
            </div>
          )}
          {dropped && (
            <p role="alert" className="text-warning text-sm">
              {t('result.replayedDifferent', { what: dropped })}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: 1 | 2 | 3;
  title: string;
  children: React.ReactNode;
}) {
  const tu = useTranslations('DeskFriendly');
  const id = `desk-step-${n}`;
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div>
        <p className="text-muted-foreground text-xs font-medium">
          {tu('steps.progress', { step: n })}
        </p>
        <h2 id={id} className="text-base font-semibold">
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
}

function Chip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`min-h-11 rounded-full border px-3 text-sm sm:min-h-8 ${FOCUS} ${
        on
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-input bg-card hover:bg-muted'
      }`}
    >
      {children}
    </button>
  );
}

const TONE: Record<
  'success' | 'warning' | 'info' | 'destructive',
  { box: string; icon: LucideIcon; text: string }
> = {
  success: { box: 'bg-success-soft', icon: CircleCheck, text: 'text-success' },
  warning: { box: 'bg-warning-soft', icon: CircleAlert, text: 'text-warning' },
  info: { box: 'bg-info-soft', icon: Info, text: 'text-info' },
  destructive: {
    box: 'bg-destructive-soft',
    icon: XCircle,
    text: 'text-destructive',
  },
};

function ResultCard({
  sent,
  banks,
}: {
  sent: SentResult;
  banks: readonly DeskBank[];
}) {
  const tu = useTranslations('DeskFriendly');
  const codeRef = useRef<HTMLSpanElement>(null);
  const { item } = sent;
  const line = resultLine(item, {
    kind: sent.kind,
    docTypeLabel: sent.docKey ? docTypeLabel(sent.docKey) : null,
    bankName: bankName(banks, item.queueBankCode),
  });
  const tone = TONE[line.tone];
  const Icon = tone.icon;

  const copyCode = async () => {
    const code = item.captionCode ?? '';
    try {
      // Called inside the click, as the clipboard requires.
      await navigator.clipboard.writeText(code);
      toast.success(tu('actions.copied'));
    } catch {
      // No clipboard (an insecure origin, a refusal): select it instead.
      const el = codeRef.current;
      const sel = typeof window !== 'undefined' ? window.getSelection() : null;
      if (el && sel) sel.selectAllChildren(el);
      toast(tu('actions.copyFailed'));
    }
  };

  return (
    <div
      role="status"
      className={`${tone.box} space-y-2 rounded-lg p-3 text-sm`}
    >
      <p className="flex items-start gap-2">
        <Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${tone.text}`} />
        <span className="text-foreground font-medium">
          {tu(line.key, line.values)}
        </span>
      </p>
      {line.reason && (
        <p className="text-foreground ps-6">
          {tu(line.reason.key, line.reason.values)}
        </p>
      )}
      {item.replayed && (
        <p className="text-muted-foreground ps-6 text-xs">
          {tu('result.replayed')}
        </p>
      )}
      {line.actions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 ps-6">
          {line.actions.includes('copyCode') && item.captionCode && (
            <>
              <span
                ref={codeRef}
                className="bg-card rounded px-2 py-1 font-mono font-semibold select-all"
              >
                {item.captionCode}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className={TAP}
                onClick={() => void copyCode()}
              >
                <Copy aria-hidden className="size-3.5" />
                {tu('actions.copyCode')}
              </Button>
            </>
          )}
          {line.actions.includes('openCase') && item.caseId && (
            <Button
              size="sm"
              variant="outline"
              className={TAP}
              nativeButton={false}
              render={<Link href={`/cases/${item.caseId}`} />}
            >
              {tu('actions.openCase')}
            </Button>
          )}
          {line.actions.includes('fixInMine') && (
            <Button
              size="sm"
              variant="outline"
              className={TAP}
              nativeButton={false}
              render={<Link href={deskTabHref('mine')} />}
            >
              {tu('actions.fixInMine')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
