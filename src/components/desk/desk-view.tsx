'use client';

/**
 * The case desk screen (migration 220, package 035c): Upload, My
 * uploads, the Sorting queue (bank holders, team leaders and up), the
 * Tray, Companies and the Overview (team leaders and up). The admin
 * settings (desk codes, routing, digest, bank roles) are in Settings ->
 * Case desk.
 *
 * Misfiling guards from the package's UI rules: no case is pre-selected
 * when sorting; the case's number, bank and company are on screen before
 * filing; a company-name mismatch needs a typed confirmation. Every
 * permission is the server's; tabs a person cannot use only hide.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import {
  ContactPicker,
  type ContactOption,
} from '@/components/pipelines/contact-picker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/use-auth';
import { canLeadTeam } from '@/lib/auth/roles';
import { docTypeLabel, docTypeOptions } from '@/lib/desk/doc-types';
import {
  newCaseMissing,
  rejectBlock,
  sortFileBlock,
  uploadBlock,
} from '@/lib/desk/form-hints';
import {
  formatAge,
  newIdemKey,
  queueReasonKey,
  sameCompany,
} from '@/lib/desk/intake-form';
import {
  DEFAULT_DESK_TAB,
  badgeText,
  deskTabsFor,
  legacyDeskRedirect,
  resolveDeskTab,
} from '@/lib/desk/tabs';
import type {
  CaseLookup,
  DeskBank,
  ItemResult,
  ItemState,
  MyItem,
  OverviewRow,
  QueueItem,
} from '@/lib/desk/store';

import { CaseRefStatus } from './case-ref-status';
import { CompaniesTab } from './companies-tab';
import { CoverCard } from './cover-card';
import { FilePreview, PreviewBeside } from './file-preview';
import { TrayTab } from './tray-tab';
import { deskApi } from './desk-api';
import { DeskFilePicker } from './desk-file-picker';
import { DeskSelect } from './desk-select';
import { DisabledHint } from './disabled-hint';
import { useCaseLookup } from './use-case-lookup';
import { useDocTypes } from './use-doc-types';
import {
  EMPTY_DRAFT,
  TagFields,
  draftToTags,
  type TagDraft,
} from './tag-fields';

const STATE_CLASS: Record<ItemState, string> = {
  filed: 'bg-success-soft text-success',
  untagged: 'bg-warning-soft text-warning',
  rejected: 'bg-destructive-soft text-destructive',
  duplicate: 'bg-info-soft text-info',
};

export function DeskView() {
  const t = useTranslations('Desk');
  const tTabs = useTranslations('DeskTabs');
  const { accountRole, accountId } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  // Registers the workspace's document labels for every tab below.
  useDocTypes();
  const [banks, setBanks] = useState<DeskBank[]>([]);

  const loadBanks = useCallback(
    () =>
      deskApi.banks().then((r) => {
        if (r.ok) setBanks(r.data);
      }),
    []
  );
  useEffect(() => {
    void loadBanks();
  }, [loadBanks, accountId]);

  const isLead = accountRole ? canLeadTeam(accountRole) : false;
  const tabs = deskTabsFor(isLead);
  // The open tab lives in the link (`?tab=`), so a reload, a shared link
  // and the worklist card land on the same tab. Unknown values fall back.
  const rawTab = searchParams.get('tab');
  const tab = resolveDeskTab(rawTab, isLead);
  const legacy = legacyDeskRedirect(rawTab);
  useEffect(() => {
    if (legacy) router.replace(legacy);
  }, [legacy, router]);
  const changeTab = (next: unknown) => {
    const to = resolveDeskTab(String(next), isLead);
    const url = new URL(window.location.href);
    if (to === DEFAULT_DESK_TAB) url.searchParams.delete('tab');
    else url.searchParams.set('tab', to);
    router.replace(`${url.pathname}${url.search}`, { scroll: false });
  };

  // Counts for the Sorting queue and Tray badges: the desk worklist is one
  // cheap call, re-read when the tab changes (a sort or filing just moved
  // them). A person with no queue simply has a count of 0.
  const [counts, setCounts] = useState<{ queue: number; tray: number } | null>(
    null
  );
  useEffect(() => {
    let live = true;
    void deskApi.worklist().then((r) => {
      if (live && r.ok)
        setCounts({ queue: r.data.queue.count, tray: r.data.tray.count });
    });
    return () => {
      live = false;
    };
  }, [tab, accountId]);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-6">
      <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      <Tabs value={tab} onValueChange={changeTab}>
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <TabsList aria-label={t('title')}>
            {tabs.map((id) => {
              const count =
                id === 'queue' || id === 'tray' ? (counts?.[id] ?? 0) : 0;
              const badge = badgeText(count);
              return (
                <TabsTrigger key={id} value={id} className="flex-none">
                  {t(`tabs.${id}`)}
                  {badge && (
                    <span className="bg-warning-soft text-warning ml-1.5 rounded-full px-1.5 text-xs font-semibold">
                      {badge}
                      <span className="sr-only">
                        {' '}
                        {tTabs('waiting', { count })}
                      </span>
                    </span>
                  )}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </div>
      </Tabs>
      {tab === 'upload' && <UploadTab banks={banks} />}
      {tab === 'mine' && <MineTab banks={banks} />}
      {tab === 'queue' && <QueueTab banks={banks} />}
      {tab === 'tray' && <TrayTab key={accountId ?? ''} isLead={isLead} />}
      {/* Keyed by workspace: a switch never shows the last one's companies. */}
      {tab === 'companies' && <CompaniesTab key={accountId ?? ''} />}
      {tab === 'overview' && (
        <div className="space-y-4">
          <OverviewTab />
          <CoverCard key={accountId ?? ''} />
        </div>
      )}
    </div>
  );
}

function bankName(banks: readonly DeskBank[], code: string | null) {
  if (code === null) return null;
  return banks.find((b) => b.bankCode === code)?.bankName ?? code;
}

function ResultLine({ item }: { item: ItemResult }) {
  const t = useTranslations('Desk');
  const reason = queueReasonKey(item.queueReason);
  return (
    <div className="bg-card-2 rounded-md p-3 text-sm" role="status">
      <Badge className={STATE_CLASS[item.state]}>
        {t(`state.${item.state}`)}
      </Badge>{' '}
      {item.caseNumber && (
        <span>
          {t('result.case')}{' '}
          <Link className="font-mono underline" href={`/cases/${item.caseId}`}>
            {item.caseNumber}
          </Link>
          {item.captionCode && (
            <>
              {' · '}
              {t('result.code')}{' '}
              <span className="font-mono font-semibold">
                {item.captionCode}
              </span>
            </>
          )}
        </span>
      )}
      {reason && (
        <span className="text-muted-foreground"> {t(`reason.${reason}`)}</span>
      )}
      {item.replayed && (
        <span className="text-muted-foreground"> {t('result.replayed')}</span>
      )}
    </div>
  );
}

// ---------- Upload ----------

function UploadTab({ banks }: { banks: readonly DeskBank[] }) {
  const t = useTranslations('Desk');
  const tf = useTranslations('DeskForms');
  const [draft, setDraft] = useState<TagDraft>(EMPTY_DRAFT);
  const [caption, setCaption] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<ItemResult | null>(null);
  // One key per upload attempt, reused on retry, so a resend after a
  // timeout returns the first result instead of a second item.
  const idem = useRef(newIdemKey());
  const blocked = uploadBlock({ kind: draft.kind, hasFile: file !== null });

  const submit = async () => {
    setBusy(true);
    const form = new FormData();
    form.set('idemKey', idem.current);
    if (caption.trim()) form.set('caption', caption.trim());
    for (const [k, v] of Object.entries(draftToTags(draft)))
      if (v !== null) form.set(k, v);
    if (file) form.set('file', file);
    const r = await deskApi.submit(form);
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    setLast(r.data);
    idem.current = newIdemKey();
    setDraft(EMPTY_DRAFT);
    setCaption('');
    setFile(null);
  };

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="desk-file">{t('fields.file')}</Label>
          <DeskFilePicker
            id="desk-file"
            file={file}
            accept="application/pdf,image/jpeg,image/png"
            onChange={(f) => {
              setFile(f);
              idem.current = newIdemKey();
            }}
          />
          <p className="text-muted-foreground text-xs">
            {t('fields.fileHint')}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="desk-caption">{t('fields.caption')}</Label>
          <Input
            id="desk-caption"
            value={caption}
            placeholder="4271RAKD ejari · NEW RAK Kite Trading 123456"
            onChange={(e) => setCaption(e.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            {t('fields.captionHint')}
          </p>
        </div>
        <TagFields draft={draft} onChange={setDraft} banks={banks} />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={submit}
            disabled={busy || blocked !== null}
            aria-describedby={blocked ? 'desk-upload-why' : undefined}
          >
            {busy ? t('actions.uploading') : t('actions.upload')}
          </Button>
          {blocked && (
            <DisabledHint id="desk-upload-why">
              {tf(`why.upload.${blocked}`)}
            </DisabledHint>
          )}
        </div>
        {last && <ResultLine item={last} />}
      </CardContent>
    </Card>
  );
}

// ---------- My uploads ----------

type MineFilter = 'all' | ItemState;

function MineTab({ banks }: { banks: readonly DeskBank[] }) {
  const t = useTranslations('Desk');
  const [items, setItems] = useState<MyItem[] | null>(null);
  const [filter, setFilter] = useState<MineFilter>('all');
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(
    () =>
      deskApi.mine().then((r) => {
        if (r.ok) setItems(r.data);
        else toast.error(r.error);
      }),
    []
  );
  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(
    () => (items ?? []).filter((i) => filter === 'all' || i.state === filter),
    [items, filter]
  );
  const filters: MineFilter[] = [
    'all',
    'untagged',
    'filed',
    'duplicate',
    'rejected',
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {filters.map((f) => (
          <Button
            key={f}
            size="sm"
            variant={filter === f ? 'default' : 'outline'}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? t('filters.all') : t(`state.${f}`)}
          </Button>
        ))}
      </div>
      {items === null ? (
        <p className="text-muted-foreground text-sm">{t('loading')}</p>
      ) : shown.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty.mine')}</p>
      ) : (
        <div className="space-y-2">
          {shown.map((i) => (
            <Card key={i.itemId}>
              <CardContent className="space-y-2 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className={STATE_CLASS[i.state]}>
                    {t(`state.${i.state}`)}
                  </Badge>
                  <span className="text-muted-foreground">
                    {new Date(i.receivedAt).toLocaleString()}
                  </span>
                  {i.kind && <span>{t(`kind.${i.kind}`)}</span>}
                  {i.originalName && (
                    <span className="truncate">{i.originalName}</span>
                  )}
                  {i.caseNumber && (
                    <Link
                      className="font-mono underline"
                      href={`/cases/${i.caseId}`}
                    >
                      {i.caseNumber}
                    </Link>
                  )}
                </div>
                {i.state === 'untagged' && i.queueReason && (
                  <p className="text-muted-foreground">
                    {t(`reason.${queueReasonKey(i.queueReason)!}`)}
                    {i.queueBankCode &&
                      ` · ${t('queueOf', { bank: bankName(banks, i.queueBankCode)! })}`}
                  </p>
                )}
                {i.state === 'rejected' && i.rejectReason && (
                  <p className="text-destructive">
                    {t('rejectedBecause', { reason: i.rejectReason })}
                  </p>
                )}
                {i.state === 'untagged' &&
                  (editing === i.itemId ? (
                    <RetagForm
                      item={i}
                      banks={banks}
                      onDone={() => {
                        setEditing(null);
                        void load();
                      }}
                    />
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setEditing(i.itemId)}
                    >
                      {t('actions.fixTags')}
                    </Button>
                  ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function RetagForm({
  item,
  banks,
  onDone,
}: {
  item: MyItem;
  banks: readonly DeskBank[];
  onDone: () => void;
}) {
  const t = useTranslations('Desk');
  const [draft, setDraft] = useState<TagDraft>({
    kind: item.kind ?? '',
    bankCode: item.bankCode ?? '',
    caseRef: item.caseRef ?? '',
    companyName: item.companyName ?? '',
    tradeLicence: item.tradeLicence ?? '',
    product: item.product ?? '',
    contact: item.contactId
      ? { id: item.contactId, name: null, phone: '' }
      : null,
    docKey: item.docKey ?? '',
    note: item.note ?? '',
  });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await deskApi.retag(item.itemId, draftToTags(draft));
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    toast.success(t(`state.${r.data.state}`));
    onDone();
  };
  return (
    <div className="space-y-3 border-t pt-3">
      <TagFields draft={draft} onChange={setDraft} banks={banks} />
      <Button size="sm" onClick={save} disabled={busy}>
        {t('actions.saveTags')}
      </Button>
    </div>
  );
}

// ---------- Sorting queue ----------

function QueueTab({ banks }: { banks: readonly DeskBank[] }) {
  const t = useTranslations('Desk');
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [denied, setDenied] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(
    () =>
      deskApi.queue().then((r) => {
        if (r.ok) {
          setItems(r.data);
          setDenied(false);
        } else if (r.code === 'NOT_ALLOWED') {
          setDenied(true);
          setItems([]);
        } else toast.error(r.error);
      }),
    []
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (denied)
    return (
      <p className="text-muted-foreground text-sm">{t('empty.notSorter')}</p>
    );
  if (items === null)
    return <p className="text-muted-foreground text-sm">{t('loading')}</p>;
  if (items.length === 0)
    return <p className="text-muted-foreground text-sm">{t('empty.queue')}</p>;

  return (
    <div className="space-y-2">
      {items.map((i) => (
        <Card key={i.itemId}>
          <CardContent className="space-y-2 py-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">
                {bankName(banks, i.queueBankCode) ?? t('noBankQueue')}
              </Badge>
              <span className="text-muted-foreground">
                {formatAge(i.ageSeconds)}
              </span>
              {i.kind && <span>{t(`kind.${i.kind}`)}</span>}
              {i.originalName && (
                <span className="truncate">{i.originalName}</span>
              )}
              <span className="text-muted-foreground">
                {t(`reason.${queueReasonKey(i.queueReason) ?? 'OTHER'}`)}
              </span>
            </div>
            <dl className="text-muted-foreground grid grid-cols-1 gap-x-4 sm:grid-cols-2">
              {i.caseRef && (
                <Field label={t('fields.caseRef')} value={i.caseRef} />
              )}
              {i.companyName && (
                <Field label={t('fields.company')} value={i.companyName} />
              )}
              {i.tradeLicence && (
                <Field label={t('fields.licence')} value={i.tradeLicence} />
              )}
              {i.product && (
                <Field label={t('fields.product')} value={i.product} />
              )}
              {i.docKey && (
                <Field
                  label={t('fields.docKey')}
                  value={docTypeLabel(i.docKey)}
                />
              )}
              {i.note && <Field label={t('fields.note')} value={i.note} />}
            </dl>
            {openId === i.itemId ? (
              <PreviewBeside
                preview={
                  i.hasFile && (
                    <FilePreview
                      target={{ type: 'intake', id: i.itemId }}
                      mime={i.mime}
                      name={i.originalName}
                      autoLoad
                    />
                  )
                }
              >
                <SortPanel
                  item={i}
                  banks={banks}
                  onDone={() => {
                    setOpenId(null);
                    void load();
                  }}
                />
              </PreviewBeside>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setOpenId(i.itemId)}
              >
                {t('actions.sort')}
              </Button>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1">
      <dt>{label}:</dt>
      <dd className="text-foreground break-all">{value}</dd>
    </div>
  );
}

type SortMode = 'file' | 'new' | 'reject';

function SortPanel({
  item,
  banks,
  onDone,
}: {
  item: QueueItem;
  banks: readonly DeskBank[];
  onDone: () => void;
}) {
  const t = useTranslations('Desk');
  const tf = useTranslations('DeskForms');
  const docTypes = useDocTypes();
  const [mode, setMode] = useState<SortMode>(
    item.kind === 'new_case' ? 'new' : 'file'
  );
  const [busy, setBusy] = useState(false);

  // File: no case is pre-selected; the sorter types the number.
  const [ref, setRef] = useState('');
  // Looked up as the number is typed; a sorter's lookup is already
  // confined to their banks and the cases they may read.
  const lookup = useCaseLookup(ref);
  const found: CaseLookup | null =
    lookup.status === 'found' ? lookup.found : null;
  const [kind, setKind] = useState<'pending_doc' | 'info'>(
    item.hasFile ? 'pending_doc' : 'info'
  );
  const [docKey, setDocKey] = useState(item.docKey ?? '');
  const [confirm, setConfirm] = useState('');

  // New case.
  const [licence, setLicence] = useState(item.tradeLicence ?? '');
  const [legalName, setLegalName] = useState(item.companyName ?? '');
  const [bankCode, setBankCode] = useState(
    item.bankCode ?? item.queueBankCode ?? ''
  );
  const [product, setProduct] = useState(item.product ?? '');
  const [contact, setContact] = useState<ContactOption | null>(null);

  const [reason, setReason] = useState('');

  const mismatch =
    found !== null &&
    item.companyName !== null &&
    found.companyName !== null &&
    !sameCompany(found.companyName, item.companyName);
  const confirmWord = t('sort.confirmWord');
  const fileBlocked = sortFileBlock({
    found: found !== null,
    mismatch,
    confirmed: confirm.trim().toLowerCase() === confirmWord.toLowerCase(),
  });
  const newMissing = newCaseMissing({
    legalName,
    licence,
    bankCode,
    product,
    hasContact: contact !== null,
  });
  const rejectBlocked = rejectBlock(reason);

  const run = async (
    op: () => Promise<{ ok: boolean; error?: string; data?: ItemResult }>
  ) => {
    setBusy(true);
    const r = await op();
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error ?? '');
      return;
    }
    const d = r.data!;
    toast.success(
      d.caseNumber
        ? `${t(`state.${d.state}`)} · ${d.caseNumber}`
        : t(`state.${d.state}`)
    );
    onDone();
  };

  return (
    <div className="space-y-3 border-t pt-3">
      <div className="flex flex-wrap gap-2">
        {(['file', 'new', 'reject'] as SortMode[]).map((m) => (
          <Button
            key={m}
            size="sm"
            variant={mode === m ? 'default' : 'outline'}
            onClick={() => setMode(m)}
          >
            {t(`sort.${m}`)}
          </Button>
        ))}
      </div>

      {mode === 'file' && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor={`sort-ref-${item.itemId}`}>
              {t('fields.caseRef')}
            </Label>
            <Input
              id={`sort-ref-${item.itemId}`}
              value={ref}
              autoComplete="off"
              placeholder="4271RAKD / TC-26-04271-RAK"
              onChange={(e) => {
                setRef(e.target.value);
                setConfirm('');
              }}
            />
            <CaseRefStatus
              lookup={
                lookup.status === 'unavailable'
                  ? { status: 'not_found' }
                  : lookup
              }
              banks={banks}
            />
          </div>
          {found && mismatch && (
            <div className="bg-card-2 space-y-1.5 rounded-md p-3 text-sm">
              <p className="text-warning">
                {t('sort.mismatch', {
                  item: item.companyName ?? '',
                  found: found.companyName ?? '',
                })}
              </p>
              <Input
                value={confirm}
                placeholder={confirmWord}
                aria-label={t('sort.confirmLabel', { word: confirmWord })}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`sort-kind-${item.itemId}`}>
                {t('fields.kind')}
              </Label>
              <DeskSelect
                id={`sort-kind-${item.itemId}`}
                value={kind}
                onChange={(v) => setKind(v === 'info' ? 'info' : 'pending_doc')}
                placeholder={t('fields.kind')}
                options={[
                  { value: 'pending_doc', label: t('kind.pending_doc') },
                  { value: 'info', label: t('kind.info') },
                ]}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`sort-doc-${item.itemId}`}>
                {t('fields.docKey')}
              </Label>
              <DeskSelect
                id={`sort-doc-${item.itemId}`}
                value={docKey}
                onChange={setDocKey}
                noneLabel={tf('docType.none')}
                placeholder={tf('docType.placeholder')}
                options={docTypeOptions(docTypes, docKey)}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={busy || fileBlocked !== null}
              aria-describedby={
                fileBlocked ? `sort-file-why-${item.itemId}` : undefined
              }
              onClick={() =>
                run(() =>
                  deskApi.file(item.itemId, {
                    caseId: found!.caseId,
                    kind,
                    docKey: docKey.trim() || null,
                  })
                )
              }
            >
              {t('sort.fileTo', { number: found?.caseNumber ?? '' })}
            </Button>
            {fileBlocked && (
              <DisabledHint id={`sort-file-why-${item.itemId}`}>
                {tf(`why.sort.${fileBlocked}`)}
              </DisabledHint>
            )}
          </div>
        </div>
      )}

      {mode === 'new' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{t('fields.company')}</Label>
            <Input
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('fields.licence')}</Label>
            <Input
              value={licence}
              onChange={(e) => setLicence(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('fields.bank')}</Label>
            <DeskSelect
              value={bankCode}
              onChange={setBankCode}
              noneLabel={t('fields.bankNone')}
              placeholder={t('fields.bankNone')}
              options={banks.map((b) => ({
                value: b.bankCode,
                label: `${b.bankName}${b.shortCode ? ` (${b.shortCode})` : ''}`,
              }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('fields.product')}</Label>
            <Input
              value={product}
              onChange={(e) => setProduct(e.target.value)}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>{t('fields.contact')}</Label>
            <ContactPicker
              selected={contact}
              onChange={setContact}
              placeholder={t('fields.contactPlaceholder')}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <Button
              disabled={busy || newMissing.length > 0}
              aria-describedby={
                newMissing.length > 0
                  ? `sort-new-why-${item.itemId}`
                  : undefined
              }
              onClick={() =>
                run(() =>
                  deskApi.newCase(item.itemId, {
                    tradeLicence: licence.trim(),
                    legalName: legalName.trim(),
                    bankCode,
                    product: product.trim(),
                    contactId: contact!.id,
                  })
                )
              }
            >
              {t('sort.openCase')}
            </Button>
            {newMissing.length > 0 && (
              <DisabledHint id={`sort-new-why-${item.itemId}`}>
                {tf('why.newCase.missing', {
                  fields: newMissing
                    .map((f) => tf(`why.newCase.fields.${f}`))
                    .join(', '),
                })}
              </DisabledHint>
            )}
          </div>
        </div>
      )}

      {mode === 'reject' && (
        <div className="space-y-2">
          <Textarea
            rows={2}
            value={reason}
            placeholder={t('sort.reasonPlaceholder')}
            onChange={(e) => setReason(e.target.value)}
          />
          {rejectBlocked && (
            <DisabledHint id={`sort-reject-why-${item.itemId}`}>
              {tf('why.reject.reason')}
            </DisabledHint>
          )}
          <Button
            variant="destructive"
            disabled={busy || rejectBlocked !== null}
            aria-describedby={
              rejectBlocked ? `sort-reject-why-${item.itemId}` : undefined
            }
            onClick={() =>
              run(() => deskApi.reject(item.itemId, reason.trim()))
            }
          >
            {t('sort.reject')}
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------- Overview ----------

function OverviewTab() {
  const t = useTranslations('Desk');
  const [rows, setRows] = useState<OverviewRow[] | null>(null);
  useEffect(() => {
    void deskApi.overview().then((r) => {
      if (r.ok) setRows(r.data);
      else toast.error(r.error);
    });
  }, []);
  if (rows === null)
    return <p className="text-muted-foreground text-sm">{t('loading')}</p>;
  const alertClass: Record<OverviewRow['alert'], string> = {
    none: 'text-muted-foreground',
    second: 'text-warning',
    lead: 'text-destructive',
    no_coordinator: 'text-destructive',
  };
  return (
    <Card>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('overview.bank')}</TableHead>
              <TableHead>{t('overview.holders')}</TableHead>
              <TableHead>{t('overview.toSort')}</TableHead>
              <TableHead>{t('overview.oldest')}</TableHead>
              <TableHead>{t('overview.alert')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.bankCode ?? '-'}>
                <TableCell>
                  {r.bankName ?? t('noBankQueue')}
                  {r.shortCode ? ` (${r.shortCode})` : ''}
                </TableCell>
                <TableCell>{r.bankCode === null ? '—' : r.holders}</TableCell>
                <TableCell>{r.toSort}</TableCell>
                <TableCell>{formatAge(r.oldestAgeSeconds)}</TableCell>
                <TableCell className={alertClass[r.alert]}>
                  {t(`overview.alerts.${r.alert}`)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
