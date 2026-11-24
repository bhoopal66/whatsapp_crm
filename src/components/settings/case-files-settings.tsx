'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Info, Loader2, RotateCcw } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/use-auth';
import { isOwner } from '@/lib/auth/roles';
import { ConfirmDialog } from '@/components/ui-ext/confirm-dialog';
import { useCan } from '@/hooks/use-can';
import {
  CASE_FILES_SWITCHES,
  INTAKE_PLACEHOLDERS,
  NAME_PLACEHOLDERS,
  SPEC_MIME_TYPES,
  caseFilesErrorKey,
  caseFilesSettingsBody,
  parseCaseFilesSettings,
  parseFileSpec,
  parseIntakeTemplates,
  readyStageOptions,
  refreshedDrafts,
  refreshedVersions,
  specBody,
  specDraft,
  specExpected,
  specRowsFromDraft,
  templateBodyProblem,
  validateReadyStages,
  validateSpecRows,
  type CaseFilesSettings,
  type CaseFilesSwitchKey,
  type FileSpecView,
  type IntakeKind,
  type IntakeTemplateView,
  type SpecDraft,
  type SpecProblem,
  type SpecRowDraft,
} from '@/lib/case-files/settings-view';
import { cn } from '@/lib/utils';

type Answer = { ok: boolean; status: number; body: unknown };

/** One config route call; a network failure is a status-0 answer. */
async function call(url: string, init?: RequestInit): Promise<Answer> {
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      ...init,
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    });
    return {
      ok: res.ok,
      status: res.status,
      body: await res.json().catch(() => null),
    };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

/** The toast for a failed write, named by its refusal code. */
function useFailToast() {
  const t = useTranslations('CaseFilesSettings.errors');
  return useCallback(
    (answer: Answer) => {
      const key = caseFilesErrorKey(answer.body, answer.status);
      toast.error(
        key === 'generic'
          ? t('generic', { error: `HTTP ${answer.status}` })
          : t(key)
      );
    },
    [t]
  );
}

const SETTINGS_URL = '/api/cases/config/settings';

/**
 * Settings -> Cases -> Case files (migration 181): three workspace
 * switches, all off by default, and the File ready stage pair the move
 * uses. One Save sends only what changed (`caseFilesSettingsBody`);
 * owners and admins edit, anyone else reads. The route re-checks the
 * role and 181 judges the stages.
 */
export function CaseFilesSettingsCard() {
  const t = useTranslations('CaseFilesSettings');
  const failToast = useFailToast();
  const canEdit = useCan('edit-settings');
  const [saved, setSaved] = useState<CaseFilesSettings | null>(null);
  const [draft, setDraft] = useState<CaseFilesSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let off = false;
    void call(SETTINGS_URL).then((answer) => {
      if (off) return;
      const read = answer.ok ? parseCaseFilesSettings(answer.body) : null;
      setFailed(!read);
      setSaved(read);
      setDraft(read);
    });
    return () => {
      off = true;
    };
  }, []);

  const body = saved && draft ? caseFilesSettingsBody(saved, draft) : null;
  const problem = draft
    ? validateReadyStages(
        draft.readyFromStage,
        draft.readyToStage,
        draft.readyMove
      )
    : null;
  const stages = readyStageOptions();

  async function save() {
    if (!body || problem) return;
    setBusy(true);
    const answer = await call(SETTINGS_URL, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    setBusy(false);
    const stored = answer.ok ? parseCaseFilesSettings(answer.body) : null;
    if (!stored) return failToast(answer);
    setSaved(stored);
    setDraft(stored);
    toast.success(t('saved'));
  }

  const set = (patch: Partial<CaseFilesSettings>) =>
    setDraft((d) => (d ? { ...d, ...patch } : d));

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-foreground text-sm font-semibold">
            {t('title')}
          </h3>
          <p className="text-muted-foreground text-sm">{t('description')}</p>
        </div>
        <div className="border-info/30 bg-info-soft text-info flex gap-2 rounded-lg border px-3 py-2 text-sm">
          <Info className="mt-0.5 size-4 shrink-0" />
          <p>{t('compassNote')}</p>
        </div>
        {failed ? (
          <p className="text-destructive text-sm" role="alert">
            {t('loadFailed')}
          </p>
        ) : !draft ? (
          <div
            className="bg-muted/50 h-32 animate-pulse rounded-lg"
            aria-busy="true"
          />
        ) : (
          <>
            <ul className="divide-border border-border divide-y rounded-lg border">
              {CASE_FILES_SWITCHES.map((key) => (
                <li key={key} className="space-y-3 px-3 py-3">
                  <SwitchRow
                    id={`case-files-${key}`}
                    which={key}
                    checked={draft[key]}
                    disabled={!canEdit || busy}
                    onChange={(on) => set({ [key]: on })}
                  />
                  {key === 'readyMove' && draft.readyMove ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <StagePick
                        label={t('fromStage')}
                        value={draft.readyFromStage}
                        stages={stages}
                        disabled={!canEdit || busy}
                        onChange={(v) => set({ readyFromStage: v })}
                      />
                      <StagePick
                        label={t('toStage')}
                        value={draft.readyToStage}
                        stages={stages}
                        disabled={!canEdit || busy}
                        onChange={(v) => set({ readyToStage: v })}
                      />
                      {problem ? (
                        <p className="text-warning text-sm sm:col-span-2">
                          {t(`stageProblems.${problem}`)}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  {key === 'intakePrompts' ? (
                    <IntakeWording canEdit={canEdit} />
                  ) : null}
                </li>
              ))}
            </ul>
            {canEdit ? (
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!body || busy}
                  onClick={() => setDraft(saved)}
                >
                  {t('discard')}
                </Button>
                <Button
                  size="sm"
                  disabled={!body || !!problem || busy}
                  onClick={() => void save()}
                >
                  {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                  {t('save')}
                </Button>
              </div>
            ) : (
              <p className="text-muted-foreground text-xs">{t('readOnly')}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

const INTAKE_URL = '/api/cases/config/intake-templates';

/**
 * The WhatsApp intake wording: one message per kind, each saved on its
 * own (any edit withdraws its approval) and approved by an owner other
 * than whoever last edited it. Independent of the card's Save.
 */
export function LoadFailed({
  text,
  retry,
  onRetry,
}: {
  text: string;
  retry: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="alert">
      <p className="text-destructive text-sm">{text}</p>
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>
        {retry}
      </Button>
    </div>
  );
}

interface IntakeForm {
  drafts: Record<string, string>;
  /** The stored version each draft may be saved over. */
  versions: Record<string, string | null>;
}

export function IntakeWording({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations('CaseFilesSettings.wording');
  const tc = useTranslations('CaseSettings');
  const failToast = useFailToast();
  const { accountRole } = useAuth();
  const owner = !!accountRole && isOwner(accountRole);
  const [open, setOpen] = useState(false);
  // A failed first read is not "no wording", which could be saved over.
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [saved, setSaved] = useState<IntakeTemplateView[] | null>(null);
  const [{ drafts, versions }, setForm] = useState<IntakeForm>({
    drafts: {},
    versions: {},
  });
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open || saved) return;
    let off = false;
    void call(INTAKE_URL).then((answer) => {
      if (off) return;
      setLoadFailed(!answer.ok);
      if (!answer.ok) return;
      const rows = parseIntakeTemplates(answer.body);
      setSaved(rows);
      setForm({
        drafts: Object.fromEntries(rows.map((r) => [r.kind, r.body ?? ''])),
        versions: Object.fromEntries(rows.map((r) => [r.kind, r.updatedAt])),
      });
    });
    return () => {
      off = true;
    };
  }, [open, saved, attempt]);

  function patch(kind: IntakeKind, change: Partial<IntakeTemplateView>) {
    setSaved((rows) =>
      rows ? rows.map((r) => (r.kind === kind ? { ...r, ...change } : r)) : rows
    );
  }

  async function save(kind: IntakeKind) {
    const text = drafts[kind] ?? '';
    if (templateBodyProblem(text)) return;
    setBusy(kind);
    const answer = await call(`${INTAKE_URL}/${kind}`, {
      method: 'PUT',
      body: JSON.stringify({ body: text, updatedAt: versions[kind] ?? null }),
    });
    // Somebody else's wording is shown beside what is typed here.
    if (answer.status === 409) await refresh(saved ?? [], kind);
    if (answer.ok) {
      // The version an approval names is the server's: without it, the
      // saver's own approve would read as somebody else's change.
      const now = (saved ?? []).map((r) =>
        r.kind === kind
          ? { ...r, body: text, approved: false, updatedAt: null }
          : r
      );
      setSaved(now);
      await refresh(now);
    }
    setBusy(null);
    if (!answer.ok) return failToast(answer);
    toast.success(t('saved'));
  }

  /** Re-reads the list; a failed read leaves what is shown. */
  async function refresh(before: IntakeTemplateView[], seen?: IntakeKind) {
    const answer = await call(INTAKE_URL);
    if (!answer.ok) return;
    const rows = parseIntakeTemplates(answer.body);
    setSaved(rows);
    setForm((f) => ({
      drafts: refreshedDrafts(before, rows, f.drafts),
      versions: refreshedVersions(before, rows, f.drafts, f.versions, seen),
    }));
  }

  async function approve(kind: IntakeKind, updatedAt: string) {
    setBusy(kind);
    const answer = await call(`${INTAKE_URL}/${kind}/approve`, {
      method: 'POST',
      body: JSON.stringify({ updatedAt }),
    });
    // Refused over a change: show the wording as it is now.
    if (answer.status === 409) await refresh(saved ?? []);
    setBusy(null);
    if (!answer.ok) return failToast(answer);
    const row = answer.body as Partial<IntakeTemplateView> | null;
    const body = typeof row?.body === 'string' ? row.body : null;
    patch(kind, {
      approved: true,
      ...(body !== null ? { body } : {}),
      ...(typeof row?.updatedAt === 'string'
        ? { updatedAt: row.updatedAt }
        : {}),
    });
    if (body !== null)
      setForm((f) => ({
        drafts: { ...f.drafts, [kind]: body },
        versions:
          typeof row?.updatedAt === 'string'
            ? { ...f.versions, [kind]: row.updatedAt }
            : f.versions,
      }));
    toast.success(t('approvedToast'));
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        className="text-foreground text-sm font-medium underline-offset-4 hover:underline"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {t('title')}
      </button>
      {open ? (
        <div className="space-y-4">
          <p className="text-muted-foreground text-xs">{t('note')}</p>
          {!saved && loadFailed ? (
            <LoadFailed
              text={tc('loadFailed')}
              retry={tc('reload')}
              onRetry={() => setAttempt((n) => n + 1)}
            />
          ) : saved ? (
            saved.map((row) => {
              const text = drafts[row.kind] ?? '';
              const problem = templateBodyProblem(text);
              const changed = text !== (row.body ?? '');
              return (
                <div key={row.kind} className="space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label htmlFor={`intake-${row.kind}`}>
                      {t(`kinds.${row.kind}`)}
                    </Label>
                    {row.body === null ? (
                      <Badge variant="outline">{t('noWording')}</Badge>
                    ) : row.approved ? (
                      <Badge className="bg-success-soft text-success">
                        {t('approved')}
                      </Badge>
                    ) : (
                      <Badge className="bg-warning-soft text-warning">
                        {t('waiting')}
                      </Badge>
                    )}
                  </div>
                  <Textarea
                    id={`intake-${row.kind}`}
                    rows={4}
                    value={text}
                    readOnly={!canEdit}
                    disabled={busy !== null}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        drafts: { ...f.drafts, [row.kind]: e.target.value },
                      }))
                    }
                  />
                  <p className="text-muted-foreground text-xs">
                    {t('placeholders', {
                      list: INTAKE_PLACEHOLDERS[row.kind].join(' '),
                    })}
                  </p>
                  {changed && row.body !== null ? (
                    <p className="text-muted-foreground text-xs whitespace-pre-wrap">
                      {t('storedNow', { body: row.body })}
                    </p>
                  ) : null}
                  {changed && problem ? (
                    <p className="text-warning text-xs">
                      {t(`problems.${problem}`)}
                    </p>
                  ) : null}
                  <div className="flex justify-end gap-2">
                    {owner && row.updatedAt && !row.approved && !changed ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() =>
                          row.updatedAt && void approve(row.kind, row.updatedAt)
                        }
                      >
                        {busy === row.kind ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : null}
                        {t('approve')}
                      </Button>
                    ) : null}
                    {canEdit ? (
                      <Button
                        size="sm"
                        disabled={!changed || !!problem || busy !== null}
                        onClick={() => void save(row.kind)}
                      >
                        {t('save')}
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })
          ) : (
            <div
              className="bg-muted/50 h-24 animate-pulse rounded-lg"
              aria-busy="true"
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

function SwitchRow({
  id,
  which,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  which: CaseFilesSwitchKey;
  checked: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
}) {
  const t = useTranslations(`CaseFilesSettings.${which}`);
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <p id={`${id}-label`} className="text-foreground text-sm font-medium">
          {t('label')}
        </p>
        <p id={`${id}-help`} className="text-muted-foreground text-sm">
          {t('help')}
        </p>
      </div>
      <Switch
        className="shrink-0"
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-help`}
      />
    </div>
  );
}

function StagePick({
  label,
  value,
  stages,
  disabled,
  onChange,
}: {
  label: string;
  value: string | null;
  stages: readonly string[];
  disabled: boolean;
  onChange: (v: string | null) => void;
}) {
  const t = useTranslations('CaseFilesSettings');
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <Select
        value={value}
        onValueChange={(v) => onChange(typeof v === 'string' ? v : null)}
        disabled={disabled}
      >
        <SelectTrigger className="w-full" aria-label={label}>
          <SelectValue>{value ?? t('pickStage')}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {stages.map((s) => (
            <SelectItem key={s} value={s}>
              {s}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

const MIME_LABEL: Record<string, string> = {
  'application/pdf': 'PDF',
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
};

function useSpecProblemText() {
  const t = useTranslations('CaseFilesSettings.spec.problems');
  return (problem: SpecProblem, labelOf: (key: string) => string) =>
    problem.kind === 'merged'
      ? t('merged')
      : problem.kind === 'duplicatePosition'
        ? t('duplicatePosition', { position: problem.position })
        : t(problem.kind, { doc: labelOf(problem.docKey) });
}

/** Somebody else saved the list on screen; what was typed stays until Reload. */
export function ChangedNotice({
  text,
  busy,
  onReload,
}: {
  text: string;
  busy: boolean;
  onReload: () => Promise<void>;
}) {
  const t = useTranslations('CaseSettings');
  return (
    <div
      role="alert"
      className="border-warning/30 bg-warning-soft text-warning flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm"
    >
      <p>{text}</p>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => void onReload()}
      >
        {t('reload')}
      </Button>
    </div>
  );
}

/**
 * One bank + product's file spec (migration 181), under the bank's
 * required documents: per document its position, whether it is
 * required, size and type limits, minimum validity and file name, plus
 * one merged / index-only choice. Save replaces the whole spec; Reset
 * removes it (`rows: []`), so the cases fall back to the defaults.
 * `products` and `version` come from the documents list, so a change
 * there re-reads the spec.
 */
export function FileSpecEditor({
  code,
  products,
  version,
}: {
  code: string;
  products: readonly string[];
  version: string;
}) {
  const t = useTranslations('CaseFilesSettings.spec');
  const tc = useTranslations('CaseSettings');
  const te = useTranslations('CaseFilesSettings.errors');
  const failToast = useFailToast();
  const problemText = useSpecProblemText();
  const canEdit = useCan('edit-settings');
  const [picked, setPicked] = useState<string | null>(null);
  const product =
    picked && products.includes(picked) ? picked : (products[0] ?? null);
  const [loaded, setLoaded] = useState<{
    key: string;
    view: FileSpecView | null;
    expected: unknown[] | undefined;
  } | null>(null);
  // The load another admin's save made stale (SPEC_CHANGED).
  const [changedKey, setChangedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<SpecDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const url = product
    ? `/api/cases/config/banks/${encodeURIComponent(code)}/file-specs?${new URLSearchParams({ product })}`
    : null;
  const loadKey = url ? `${url}#${version}` : null;

  const keyRef = useRef(loadKey);
  useEffect(() => {
    keyRef.current = loadKey;
  }, [loadKey]);
  const load = useCallback(async (u: string, key: string) => {
    const answer = await call(u);
    // Another product or bank is shown by now.
    if (keyRef.current !== key) return;
    const view = answer.ok ? parseFileSpec(answer.body) : null;
    setLoaded({ key, view, expected: specExpected(answer.body) });
    setDraft(view ? specDraft(view) : null);
  }, []);

  useEffect(() => {
    if (!url || !loadKey) return;
    let off = false;
    void call(url).then((answer) => {
      if (off) return;
      const view = answer.ok ? parseFileSpec(answer.body) : null;
      setLoaded({ key: loadKey, view, expected: specExpected(answer.body) });
      setChangedKey(null);
      setDraft(view ? specDraft(view) : null);
    });
    return () => {
      off = true;
    };
  }, [url, loadKey]);

  if (products.length === 0) return null;

  const current = loaded?.key === loadKey ? loaded : null;
  const view = current?.view ?? null;
  const rows = draft ? specRowsFromDraft(draft) : [];
  const problem =
    view && draft ? validateSpecRows(rows, view.requirements) : null;
  const labelOf = (key: string) =>
    view?.requirements.find((r) => r.docKey === key)?.label ?? key;

  async function put(send: ReturnType<typeof specBody>, reset: boolean) {
    if (!url || !loadKey) return;
    setBusy(true);
    const answer = await call(
      `/api/cases/config/banks/${encodeURIComponent(code)}/file-specs`,
      {
        method: 'PUT',
        body: JSON.stringify({ ...send, expected: current?.expected }),
      }
    );
    setBusy(false);
    if (!answer.ok) {
      const code = (answer.body as { code?: unknown } | null)?.code;
      if (code === 'SPEC_CHANGED') return setChangedKey(loadKey);
      return failToast(answer);
    }
    toast.success(reset ? t('resetDone') : t('saved'));
    await load(url, loadKey);
  }

  const patchRow = (docKey: string, patch: Partial<SpecRowDraft>) =>
    setDraft((d) =>
      d
        ? {
            ...d,
            rows: d.rows.map((r) =>
              r.docKey === docKey ? { ...r, ...patch } : r
            ),
          }
        : d
    );

  const lock = !canEdit || busy;

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <h4 className="text-foreground flex flex-wrap items-center gap-2 text-sm font-semibold">
              {t('title')}
              {view ? (
                <Badge variant="outline" className="text-xs">
                  {view.usesDefaults ? t('usesDefaults') : t('custom')}
                </Badge>
              ) : null}
            </h4>
            <p className="text-muted-foreground text-sm">{t('help')}</p>
          </div>
          <div className="w-full shrink-0 space-y-1.5 sm:w-56">
            <Label className="text-xs">{t('product')}</Label>
            <Select
              value={product}
              onValueChange={(v) => typeof v === 'string' && setPicked(v)}
            >
              <SelectTrigger className="w-full" aria-label={t('product')}>
                <SelectValue>{product}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {products.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {current && !view ? (
          <p className="text-destructive text-sm" role="alert">
            {t('loadFailed')}
          </p>
        ) : !view || !draft ? (
          <div
            className="bg-muted/50 h-32 animate-pulse rounded-lg"
            aria-busy="true"
          />
        ) : draft.rows.length === 0 ? (
          <p className="text-muted-foreground py-4 text-center text-sm">
            {t('empty')}
          </p>
        ) : (
          <>
            <div className="border-border relative overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[56rem] text-sm">
                <thead className="bg-card-2 text-muted-foreground text-xs">
                  <tr className="text-start">
                    <th className="px-3 py-2 font-medium">{t('document')}</th>
                    <th className="px-2 py-2 font-medium">{t('position')}</th>
                    <th className="px-2 py-2 font-medium">{t('required')}</th>
                    <th className="px-2 py-2 font-medium">{t('maxMb')}</th>
                    <th className="px-2 py-2 font-medium">{t('types')}</th>
                    <th className="px-2 py-2 font-medium">
                      {t('minValidDays')}
                    </th>
                    <th className="px-3 py-2 font-medium">
                      {t('namePattern')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {draft.rows.map((r) => (
                    <tr key={r.docKey} className="align-top">
                      <td className="px-3 py-2">
                        <p className="text-foreground break-words">{r.label}</p>
                        <code className="text-muted-foreground font-mono text-xs">
                          {r.docKey}
                        </code>
                      </td>
                      <td className="px-2 py-2">
                        <Input
                          className="w-20"
                          inputMode="numeric"
                          value={r.position}
                          disabled={lock}
                          aria-label={t('positionOf', { doc: r.label })}
                          onChange={(e) =>
                            patchRow(r.docKey, { position: e.target.value })
                          }
                        />
                      </td>
                      <td className="px-2 py-2">
                        <Checkbox
                          className="mt-2"
                          checked={r.required}
                          disabled={lock}
                          aria-label={t('requiredOf', { doc: r.label })}
                          onCheckedChange={(on) =>
                            patchRow(r.docKey, { required: on === true })
                          }
                        />
                      </td>
                      <td className="px-2 py-2">
                        <Input
                          className="w-20"
                          inputMode="numeric"
                          value={r.maxMb}
                          disabled={lock}
                          aria-label={t('maxMbOf', { doc: r.label })}
                          onChange={(e) =>
                            patchRow(r.docKey, { maxMb: e.target.value })
                          }
                        />
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex flex-col gap-1.5 pt-1">
                          {SPEC_MIME_TYPES.map((m) => (
                            <label
                              key={m}
                              className="text-foreground flex items-center gap-2 text-xs"
                            >
                              <Checkbox
                                checked={r.allowedMime.includes(m)}
                                disabled={lock}
                                onCheckedChange={(on) =>
                                  patchRow(r.docKey, {
                                    allowedMime: on
                                      ? [...r.allowedMime, m]
                                      : r.allowedMime.filter((x) => x !== m),
                                  })
                                }
                              />
                              {MIME_LABEL[m] ?? m}
                            </label>
                          ))}
                        </div>
                      </td>
                      <td className="px-2 py-2">
                        <Input
                          className="w-24"
                          inputMode="numeric"
                          placeholder={t('noMinimum')}
                          value={r.minValidDays}
                          disabled={lock}
                          aria-label={t('minValidDaysOf', { doc: r.label })}
                          onChange={(e) =>
                            patchRow(r.docKey, {
                              minValidDays: e.target.value,
                            })
                          }
                        />
                      </td>
                      <td className="px-3 py-2">
                        <Input
                          className="min-w-56 font-mono text-xs"
                          value={r.namePattern}
                          disabled={lock}
                          aria-label={t('namePatternOf', { doc: r.label })}
                          onChange={(e) =>
                            patchRow(r.docKey, {
                              namePattern: e.target.value,
                            })
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-muted-foreground text-xs">
              {t('placeholders')}{' '}
              {NAME_PLACEHOLDERS.map((p) => (
                <code key={p} className="bg-card-2 me-1 rounded px-1 font-mono">
                  {p}
                </code>
              ))}
            </p>

            <div
              role="radiogroup"
              aria-label={t('mergedLabel')}
              className="flex flex-wrap items-center gap-2"
            >
              <span className="text-foreground text-sm font-medium">
                {t('mergedLabel')}
              </span>
              {[true, false].map((merged) => (
                <Button
                  key={String(merged)}
                  type="button"
                  size="sm"
                  role="radio"
                  aria-checked={draft.merged === merged}
                  variant={draft.merged === merged ? 'default' : 'outline'}
                  disabled={lock}
                  onClick={() => setDraft({ ...draft, merged })}
                >
                  {merged ? t('mergedOne') : t('indexOnly')}
                </Button>
              ))}
            </div>

            {problem ? (
              <p
                className={cn(
                  'rounded-lg border px-3 py-2 text-sm',
                  'border-warning/30 bg-warning-soft text-warning'
                )}
              >
                {problemText(problem, labelOf)}
              </p>
            ) : null}

            {changedKey !== null && changedKey === loadKey ? (
              <ChangedNotice
                text={te('specChanged')}
                busy={busy}
                onReload={async () => {
                  if (!url) return;
                  setBusy(true);
                  await load(url, loadKey);
                  setChangedKey(null);
                  setBusy(false);
                }}
              />
            ) : null}

            {canEdit ? (
              <div className="flex flex-wrap justify-end gap-2">
                {!view.usesDefaults ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setConfirmReset(true)}
                  >
                    <RotateCcw className="size-4" />
                    {t('reset')}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  disabled={busy || !!problem || !product}
                  onClick={() =>
                    product && void put(specBody(product, rows), false)
                  }
                >
                  {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                  {t('save')}
                </Button>
              </div>
            ) : (
              <p className="text-muted-foreground text-xs">{t('readOnly')}</p>
            )}
          </>
        )}
      </CardContent>
      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title={t('resetTitle')}
        description={t('resetBody', { product: product ?? '' })}
        cancelLabel={tc('cancel')}
        confirmLabel={t('reset')}
        onConfirm={() => {
          setConfirmReset(false);
          if (product) void put(specBody(product, []), true);
        }}
        destructive
      />
    </Card>
  );
}
