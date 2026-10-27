'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  ArrowDown,
  ArrowUp,
  Info,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConfirmDialog } from '@/components/ui-ext/confirm-dialog';
import { useCan } from '@/hooks/use-can';
import {
  BANK_CODE_RE,
  BANK_SPACE_TEMPLATE_KEY,
  CONFIG_KEY_RE,
  DEFAULT_DUE_SOON_PCT,
  SLA_TIMERS,
  STAGE_NAME_MAX,
  configErrorKey,
  configErrorText,
  groupByProduct,
  keyFromLabel,
  moveStage,
  caseSwitchBody,
  parseCaseSwitches,
  removeStage,
  slaCellLabel,
  slaRowFor,
  stagesBody,
  validateStages,
  type CaseSwitchKey,
  type DocumentRequirement,
  type SlaConfigRow,
  type SlaTimerKey,
  type StageProblem,
} from '@/lib/cases/settings-ui';
import { cn } from '@/lib/utils';

import { SettingsPanelHead } from './settings-panel-head';
import { TABS_TRIGGER_DARK } from './tab-styles';

const WARN = 'border-warning/30 bg-warning-soft text-warning';

interface Bank {
  code: string;
  name: string;
  hasOwnStages: boolean;
}

interface Template {
  templateKey: string;
  title: string;
  position: number;
  dueHours: number | null;
}

type BankTab = 'stages' | 'templates' | 'documents' | 'sla';
const BANK_TABS: BankTab[] = ['stages', 'templates', 'documents', 'sla'];

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

const bankUrl = (code: string, part: string) =>
  `/api/cases/config/banks/${encodeURIComponent(code)}/${part}`;

/** A whole number >= 1 from an input, else null. */
function wholeNumber(raw: string): number | null {
  const n = Number(raw.trim());
  return raw.trim() !== '' && Number.isInteger(n) && n >= 1 ? n : null;
}

type Loaded<T> = { url: string; data: T | null; failed: boolean };

async function readConfig<T>(
  url: string,
  parse: (body: unknown) => T | null
): Promise<Loaded<T>> {
  const answer = await call(url);
  const data = answer.ok ? parse(answer.body) : null;
  return { url, data, failed: data === null };
}

/**
 * One config GET, re-read on `reload()`. State lands only in the fetch's
 * callback, and an answer for another URL (a bank switched mid-flight)
 * is not shown. `parse` must be stable (module level).
 */
function useConfigRead<T>(url: string, parse: (body: unknown) => T | null) {
  const [state, setState] = useState<Loaded<T> | null>(null);
  useEffect(() => {
    let off = false;
    void readConfig(url, parse).then((next) => {
      if (!off) setState(next);
    });
    return () => {
      off = true;
    };
  }, [url, parse]);
  const reload = useCallback(async () => {
    setState(await readConfig(url, parse));
  }, [url, parse]);
  const current = state?.url === url ? state : null;
  return {
    data: current?.data ?? null,
    failed: current?.failed ?? false,
    reload,
  };
}

function field<T>(body: unknown, key: string): T[] | null {
  const value =
    body && typeof body === 'object'
      ? (body as Record<string, unknown>)[key]
      : null;
  return Array.isArray(value) ? (value as T[]) : null;
}

const parseBanks = (body: unknown) => field<Bank>(body, 'banks');
const parseStages = (body: unknown) => {
  const stages = field<string>(body, 'stages');
  return stages
    ? { stages, isDefault: !!(body as { isDefault?: unknown }).isDefault }
    : null;
};
const parseTemplates = (body: unknown) =>
  field<Template>(body, 'templates')?.sort((a, b) => a.position - b.position) ??
  null;
const parseDocuments = (body: unknown) =>
  field<DocumentRequirement>(body, 'requirements');
const parseSla = (body: unknown) => {
  const config = field<SlaConfigRow>(body, 'config');
  const stages = field<string>(body, 'stages');
  return config && stages ? { config, stages } : null;
};

/** The toast for a failed write, in plain words. */
function useFailToast() {
  const t = useTranslations('CaseSettings.errors');
  return useCallback(
    (answer: Answer) => {
      const key = configErrorKey(answer.body);
      toast.error(
        key === 'generic'
          ? t('generic', { error: configErrorText(answer.body, answer.status) })
          : t(key)
      );
    },
    [t]
  );
}

/**
 * The workspace switches, read once: the Compass lock (migration 134) —
 * when on, a submitted case's stage, bank, product, amount and document
 * status are Compass's alone — and (migration 136) whether a Compass
 * submission also opens a WhatsApp group. Owners and admins toggle each
 * (optimistically, reverted on a refusal); anyone else sees them
 * read-only. The PUT route re-checks the role.
 */
function CaseSwitchCards() {
  const { data, failed } = useConfigRead(
    '/api/cases/config/settings',
    parseCaseSwitches
  );
  return (
    <>
      <CaseSwitchCard
        setting="managedExternally"
        ns="compass"
        id="cases-compass-lock"
        loaded={data?.managedExternally ?? null}
        failed={failed}
      />
      <CaseSwitchCard
        setting="submissionWhatsappGroups"
        ns="whatsappGroups"
        id="cases-whatsapp-groups"
        loaded={data?.submissionWhatsappGroups ?? null}
        failed={failed}
      />
    </>
  );
}

/** One switch; its save sends only its own key. */
function CaseSwitchCard({
  setting,
  ns,
  id,
  loaded,
  failed,
}: {
  setting: CaseSwitchKey;
  ns: 'compass' | 'whatsappGroups';
  id: string;
  /** The read value; null until (or unless) it loads. */
  loaded: boolean | null;
  failed: boolean;
}) {
  const t = useTranslations(`CaseSettings.${ns}`);
  const failToast = useFailToast();
  const canEdit = useCan('edit-settings');
  // The value shown while (and after) a save; null follows the read.
  const [override, setOverride] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const on = override ?? loaded ?? false;

  async function change(next: boolean) {
    const before = on;
    setOverride(next);
    setSaving(true);
    const answer = await call('/api/cases/config/settings', {
      method: 'PUT',
      body: JSON.stringify(caseSwitchBody(setting, next)),
    });
    setSaving(false);
    const saved = answer.ok ? parseCaseSwitches(answer.body) : null;
    if (!saved) {
      setOverride(before);
      failToast(answer);
      return;
    }
    setOverride(saved[setting]);
    toast.success(saved[setting] ? t('turnedOn') : t('turnedOff'));
  }

  return (
    <Card>
      <CardContent className="space-y-2">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <p
              id={`${id}-label`}
              className="text-foreground text-sm font-medium"
            >
              {t('label')}
            </p>
            <p id={`${id}-help`} className="text-muted-foreground text-sm">
              {t('help')}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {saving && (
              <Loader2 className="text-muted-foreground size-4 animate-spin" />
            )}
            <Switch
              checked={on}
              onCheckedChange={(next) => void change(next)}
              disabled={!canEdit || loaded === null || saving}
              aria-labelledby={`${id}-label`}
              aria-describedby={`${id}-help`}
            />
          </div>
        </div>
        {failed ? (
          <p className="text-destructive text-sm" role="alert">
            {t('loadFailed')}
          </p>
        ) : loaded !== null && !canEdit ? (
          <p className="text-muted-foreground text-xs">{t('readOnly')}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * Settings -> Cases (module 018c, admin+): the workspace's banks and, per
 * bank, its stage list, task templates, required documents and SLA
 * timers. Every write goes to `/api/cases/config/*`, which (with the SQL
 * under it) is the judge; `lib/cases/settings-ui` holds the rules the
 * screen warns with before sending.
 */
export function CasesSettingsPanel() {
  const t = useTranslations('CaseSettings');
  const failToast = useFailToast();
  const {
    data: banks,
    failed: loadFailed,
    reload: load,
  } = useConfigRead('/api/cases/config/banks', parseBanks);
  const [picked, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<BankTab>('stages');
  const [editing, setEditing] = useState<Bank | 'new' | null>(null);

  // The picked bank while it exists, else the first one.
  const selected =
    picked && banks?.some((b) => b.code === picked)
      ? picked
      : (banks?.[0]?.code ?? null);

  const bank = banks?.find((b) => b.code === selected) ?? null;

  async function saveBank(code: string, name: string): Promise<boolean> {
    const answer = await call('/api/cases/config/banks', {
      method: 'POST',
      body: JSON.stringify({ code, name }),
    });
    if (!answer.ok) {
      failToast(answer);
      return false;
    }
    toast.success(t('banks.saved'));
    setSelected(code);
    await load();
    return true;
  }

  return (
    <section className="animate-in fade-in-50 max-w-4xl space-y-6 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          banks ? (
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus className="size-4" />
              {t('banks.add')}
            </Button>
          ) : null
        }
      />

      <CaseSwitchCards />

      {loadFailed ? (
        <p className="text-destructive text-sm" role="alert">
          {t('loadFailed')}
        </p>
      ) : !banks ? (
        <div
          className="bg-muted/50 h-40 w-full animate-pulse rounded-xl"
          aria-busy="true"
        />
      ) : (
        <>
          <Card>
            <CardContent className="space-y-3">
              <div className="text-muted-foreground flex gap-2 text-sm">
                <Info className="mt-0.5 size-4 shrink-0" />
                <p>{t('banks.codeHelp')}</p>
              </div>
              {banks.length === 0 ? (
                <p className="text-muted-foreground py-4 text-center text-sm">
                  {t('banks.empty')}
                </p>
              ) : (
                <ul className="divide-border border-border divide-y rounded-lg border">
                  {banks.map((b) => (
                    <li
                      key={b.code}
                      className={cn(
                        'flex items-center gap-2 px-3 py-2',
                        b.code === selected && 'bg-muted/60'
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => setSelected(b.code)}
                        aria-pressed={b.code === selected}
                        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-left"
                      >
                        <span className="text-foreground truncate text-sm font-medium">
                          {b.name}
                        </span>
                        <code className="text-muted-foreground font-mono text-xs">
                          {b.code}
                        </code>
                        <Badge variant="outline" className="text-xs">
                          {b.hasOwnStages
                            ? t('banks.ownStages')
                            : t('banks.defaultStages')}
                        </Badge>
                      </button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('banks.renameLabel', { name: b.name })}
                        onClick={() => setEditing(b)}
                      >
                        <Pencil className="size-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {bank ? (
            <div className="space-y-4">
              <h3 className="text-foreground text-base font-semibold">
                {t('bankHeading', { name: bank.name })}
              </h3>
              <Tabs value={tab} onValueChange={(v) => setTab(v as BankTab)}>
                <div className="-mx-1 overflow-x-auto px-1 pb-1">
                  <TabsList aria-label={t('bankHeading', { name: bank.name })}>
                    {BANK_TABS.map((id) => (
                      <TabsTrigger
                        key={id}
                        value={id}
                        className={cn('flex-none', TABS_TRIGGER_DARK)}
                      >
                        {t(`tabs.${id}`)}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </div>
              </Tabs>
              {tab === 'stages' ? (
                <StagesEditor key={bank.code} code={bank.code} onSaved={load} />
              ) : tab === 'templates' ? (
                <TemplatesTab key={bank.code} code={bank.code} />
              ) : tab === 'documents' ? (
                <DocumentsTab key={bank.code} code={bank.code} />
              ) : (
                <SlaTab key={bank.code} code={bank.code} />
              )}
            </div>
          ) : null}
        </>
      )}

      {editing ? (
        <BankDialog
          bank={editing === 'new' ? null : editing}
          taken={(banks ?? []).map((b) => b.code)}
          onClose={() => setEditing(null)}
          onSave={saveBank}
        />
      ) : null}
    </section>
  );
}

function FormDialog({
  title,
  description,
  busy,
  canSave,
  onClose,
  onSubmit,
  extra,
  children,
}: {
  title: string;
  description?: string;
  busy: boolean;
  canSave: boolean;
  onClose: () => void;
  onSubmit: () => void;
  extra?: ReactNode;
  children: ReactNode;
}) {
  const t = useTranslations('CaseSettings');
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave && !busy) onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? (
              <DialogDescription>{description}</DialogDescription>
            ) : null}
          </DialogHeader>
          <div className="space-y-4">{children}</div>
          <DialogFooter className="gap-2">
            {extra}
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={busy}
            >
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={!canSave || busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
      {error ? <p className="text-destructive text-xs">{error}</p> : null}
    </div>
  );
}

function BankDialog({
  bank,
  taken,
  onClose,
  onSave,
}: {
  bank: Bank | null;
  taken: string[];
  onClose: () => void;
  onSave: (code: string, name: string) => Promise<boolean>;
}) {
  const t = useTranslations('CaseSettings.banks');
  const [code, setCode] = useState(bank?.code ?? '');
  const [name, setName] = useState(bank?.name ?? '');
  const [busy, setBusy] = useState(false);
  const codeError =
    code && !BANK_CODE_RE.test(code)
      ? t('codeInvalid')
      : !bank && taken.includes(code)
        ? t('codeTaken')
        : null;
  const canSave =
    BANK_CODE_RE.test(code) &&
    !codeError &&
    name.trim().length > 0 &&
    name.trim().length <= 100 &&
    (!bank || name.trim() !== bank.name);

  return (
    <FormDialog
      title={bank ? t('renameTitle') : t('addTitle')}
      description={t('codeHelp')}
      busy={busy}
      canSave={canSave}
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        const ok = await onSave(code, name.trim());
        setBusy(false);
        if (ok) onClose();
      }}
    >
      <Field id="case-bank-code" label={t('code')} error={codeError}>
        <Input
          id="case-bank-code"
          value={code}
          onChange={(e) =>
            setCode(e.target.value.toUpperCase().replace(/[\s-]/g, '_'))
          }
          disabled={!!bank || busy}
          maxLength={32}
          autoComplete="off"
          spellCheck={false}
          dir="ltr"
          className="font-mono"
          placeholder="ADCB"
        />
      </Field>
      <Field id="case-bank-name" label={t('name')}>
        <Input
          id="case-bank-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
          maxLength={100}
          autoComplete="off"
        />
      </Field>
    </FormDialog>
  );
}

// ---------- Stages ----------

function useStageProblemText() {
  const t = useTranslations('CaseSettings.stages.problems');
  return (p: StageProblem): string => {
    switch (p.kind) {
      case 'empty':
        return t('empty');
      case 'tooMany':
        return t('tooMany', { max: p.max });
      case 'blank':
        return t('blank', { position: p.position });
      case 'tooLong':
        return t('tooLong', { position: p.position, max: p.max });
      case 'duplicate':
        return t('duplicate', { stage: p.stage });
      case 'presubRequired':
        return t('presubRequired');
      case 'firstFinal':
        return t('firstFinal', { stage: p.stage });
      case 'finalSpelling':
        return t('finalSpelling', { stage: p.stage });
      case 'missingFinal':
        return t('missingFinal', { stage: p.stage });
    }
  };
}

function StagesEditor({
  code,
  onSaved,
}: {
  code: string;
  onSaved: () => void;
}) {
  const t = useTranslations('CaseSettings.stages');
  const tc = useTranslations('CaseSettings');
  const failToast = useFailToast();
  const problemText = useStageProblemText();
  const {
    data: stored,
    failed: loadFailed,
    reload: load,
  } = useConfigRead(bankUrl(code, 'stages'), parseStages);
  // null: no edits, the stored list is shown.
  const [edits, setEdits] = useState<string[] | null>(null);
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  if (loadFailed)
    return (
      <p className="text-destructive text-sm" role="alert">
        {tc('loadFailed')}
      </p>
    );
  if (!stored)
    return <div className="bg-muted/50 h-40 animate-pulse rounded-xl" />;

  const draft = edits ?? stored.stages;
  const setDraft = (next: string[]) => setEdits(next);
  const problem = validateStages(draft);
  const dirty =
    JSON.stringify(stagesBody(draft).stages) !== JSON.stringify(stored.stages);

  async function put(stages: string[], reset: boolean) {
    setBusy(true);
    const answer = await call(bankUrl(code, 'stages'), {
      method: 'PUT',
      body: JSON.stringify({ stages }),
    });
    setBusy(false);
    if (!answer.ok) {
      failToast(answer);
      return;
    }
    toast.success(reset ? t('resetDone') : t('saved'));
    await load();
    setEdits(null);
    onSaved();
  }

  function add() {
    const name = adding.trim();
    if (!name) return;
    // New stages go before the first final stage, where work happens.
    const finalAt = draft.findIndex((s) =>
      ['approved', 'declined', 'withdrawn', 'closed'].includes(
        s.trim().toLowerCase()
      )
    );
    const at = finalAt < 0 ? draft.length : finalAt;
    setDraft([...draft.slice(0, at), name, ...draft.slice(at)]);
    setAdding('');
  }

  return (
    <Card>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-sm">{t('help')}</p>
        {stored.isDefault ? (
          <Badge variant="secondary">{t('usingDefaults')}</Badge>
        ) : null}

        <ol className="space-y-2">
          {draft.map((stage, i) => (
            <li key={i} className="flex items-center gap-1.5">
              <span className="text-muted-foreground w-6 shrink-0 text-right text-xs tabular-nums">
                {i + 1}
              </span>
              <Input
                value={stage}
                onChange={(e) =>
                  setDraft(draft.map((s, j) => (j === i ? e.target.value : s)))
                }
                maxLength={STAGE_NAME_MAX}
                disabled={busy}
                aria-label={t('stageLabel', { position: i + 1 })}
                className="min-w-0 flex-1"
              />
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={busy || i === 0}
                aria-label={t('moveUp', { stage })}
                onClick={() => setDraft(moveStage(draft, i, -1))}
              >
                <ArrowUp className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={busy || i === draft.length - 1}
                aria-label={t('moveDown', { stage })}
                onClick={() => setDraft(moveStage(draft, i, 1))}
              >
                <ArrowDown className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={busy}
                aria-label={t('remove', { stage })}
                onClick={() => setDraft(removeStage(draft, i))}
              >
                <X className="size-4" />
              </Button>
            </li>
          ))}
        </ol>

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <Input
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            placeholder={t('addPlaceholder')}
            maxLength={STAGE_NAME_MAX}
            disabled={busy}
            aria-label={t('addPlaceholder')}
            className="min-w-0 flex-1"
          />
          <Button
            type="submit"
            variant="outline"
            disabled={busy || !adding.trim()}
          >
            <Plus className="size-4" />
            {t('add')}
          </Button>
        </form>

        {problem && dirty ? (
          <div
            className={cn('flex gap-2 rounded-lg border p-3 text-sm', WARN)}
            role="status"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <p>{problemText(problem)}</p>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy || !dirty || !!problem}
            onClick={() => void put(stagesBody(draft).stages, false)}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {tc('save')}
          </Button>
          <Button
            variant="outline"
            disabled={busy || !dirty}
            onClick={() => setEdits(null)}
          >
            {t('discard')}
          </Button>
          <Button
            variant="ghost"
            disabled={busy || stored.isDefault}
            onClick={() => setConfirmReset(true)}
          >
            <RotateCcw className="size-4" />
            {t('reset')}
          </Button>
        </div>
      </CardContent>

      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title={t('resetTitle')}
        description={t('resetBody')}
        cancelLabel={tc('cancel')}
        confirmLabel={t('reset')}
        onConfirm={() => {
          setConfirmReset(false);
          void put([], true);
        }}
        destructive
      />
    </Card>
  );
}

// ---------- Task templates ----------

function TemplatesTab({ code }: { code: string }) {
  const t = useTranslations('CaseSettings.templates');
  const tc = useTranslations('CaseSettings');
  const failToast = useFailToast();
  const {
    data: rows,
    failed: loadFailed,
    reload: load,
  } = useConfigRead(bankUrl(code, 'templates'), parseTemplates);
  const [editing, setEditing] = useState<Template | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Template | null>(null);

  async function remove(row: Template) {
    const answer = await call(
      `${bankUrl(code, 'templates')}?key=${encodeURIComponent(row.templateKey)}`,
      { method: 'DELETE' }
    );
    if (!answer.ok) return failToast(answer);
    toast.success(t('deleted'));
    await load();
  }

  if (loadFailed)
    return (
      <p className="text-destructive text-sm" role="alert">
        {tc('loadFailed')}
      </p>
    );
  if (!rows)
    return <div className="bg-muted/50 h-40 animate-pulse rounded-xl" />;

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <p className="text-muted-foreground text-sm">{t('help')}</p>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={() => setEditing('new')}
          >
            <Plus className="size-4" />
            {t('add')}
          </Button>
        </div>
        {rows.length === 0 ? (
          <p className="text-muted-foreground py-4 text-center text-sm">
            {t('empty')}
          </p>
        ) : (
          <ul className="divide-border border-border divide-y rounded-lg border">
            {rows.map((row) => {
              const locked = row.templateKey === BANK_SPACE_TEMPLATE_KEY;
              return (
                <li
                  key={row.templateKey}
                  className="flex items-start gap-2 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-foreground text-sm font-medium break-words">
                      {row.title}
                    </p>
                    <p className="text-muted-foreground flex flex-wrap gap-x-2 text-xs">
                      <code className="font-mono">{row.templateKey}</code>
                      <span>
                        {row.dueHours
                          ? t('dueIn', { hours: row.dueHours })
                          : t('noDue')}
                      </span>
                      {locked ? <span>{t('usedByBankSpaces')}</span> : null}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('editLabel', { title: row.title })}
                    onClick={() => setEditing(row)}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  {locked ? null : (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('deleteLabel', { title: row.title })}
                      onClick={() => setDeleting(row)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      {editing ? (
        <TemplateDialog
          code={code}
          row={editing === 'new' ? null : editing}
          taken={rows.map((r) => r.templateKey)}
          onClose={() => setEditing(null)}
          onSaved={load}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={t('deleteTitle')}
        description={t('deleteBody', { title: deleting?.title ?? '' })}
        cancelLabel={tc('cancel')}
        confirmLabel={tc('delete')}
        onConfirm={() => {
          const row = deleting;
          setDeleting(null);
          if (row) void remove(row);
        }}
        destructive
      />
    </Card>
  );
}

function TemplateDialog({
  code,
  row,
  taken,
  onClose,
  onSaved,
}: {
  code: string;
  row: Template | null;
  taken: string[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const t = useTranslations('CaseSettings.templates');
  const tc = useTranslations('CaseSettings');
  const failToast = useFailToast();
  const [title, setTitle] = useState(row?.title ?? '');
  const [key, setKey] = useState(row?.templateKey ?? '');
  const [keyTouched, setKeyTouched] = useState(!!row);
  const [due, setDue] = useState(row?.dueHours ? String(row.dueHours) : '');
  const [position, setPosition] = useState(row ? String(row.position) : '');
  const [busy, setBusy] = useState(false);

  const shownKey = keyTouched ? key : keyFromLabel(title);
  const keyError =
    shownKey && !CONFIG_KEY_RE.test(shownKey)
      ? tc('keyInvalid')
      : !row && taken.includes(shownKey)
        ? tc('keyTaken')
        : null;
  const dueOk = due.trim() === '' || wholeNumber(due) !== null;
  const positionOk = position.trim() === '' || wholeNumber(position) !== null;
  const canSave =
    title.trim().length > 0 &&
    CONFIG_KEY_RE.test(shownKey) &&
    !keyError &&
    dueOk &&
    positionOk;

  return (
    <FormDialog
      title={row ? t('editTitle') : t('addTitle')}
      busy={busy}
      canSave={canSave}
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        const answer = await call(bankUrl(code, 'templates'), {
          method: 'POST',
          body: JSON.stringify({
            template_key: shownKey,
            title: title.trim(),
            position: wholeNumber(position) ?? undefined,
            due_hours: wholeNumber(due),
          }),
        });
        setBusy(false);
        if (!answer.ok) return failToast(answer);
        toast.success(t('saved'));
        onClose();
        await onSaved();
      }}
    >
      <Field id="case-template-title" label={t('titleLabel')}>
        <Input
          id="case-template-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          disabled={busy}
          autoComplete="off"
        />
      </Field>
      <Field
        id="case-template-key"
        label={tc('key')}
        hint={tc('keyHelp')}
        error={keyError}
      >
        <Input
          id="case-template-key"
          value={shownKey}
          onChange={(e) => {
            setKeyTouched(true);
            setKey(e.target.value.toLowerCase());
          }}
          maxLength={64}
          disabled={!!row || busy}
          autoComplete="off"
          spellCheck={false}
          dir="ltr"
          className="font-mono"
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="case-template-due"
          label={t('dueHours')}
          hint={t('dueHoursHelp')}
          error={dueOk ? null : tc('wholeNumber')}
        >
          <Input
            id="case-template-due"
            inputMode="numeric"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            disabled={busy}
          />
        </Field>
        <Field
          id="case-template-position"
          label={tc('position')}
          hint={tc('positionHelp')}
          error={positionOk ? null : tc('wholeNumber')}
        >
          <Input
            id="case-template-position"
            inputMode="numeric"
            value={position}
            onChange={(e) => setPosition(e.target.value)}
            disabled={busy}
          />
        </Field>
      </div>
    </FormDialog>
  );
}

// ---------- Required documents ----------

function DocumentsTab({ code }: { code: string }) {
  const t = useTranslations('CaseSettings.documents');
  const tc = useTranslations('CaseSettings');
  const failToast = useFailToast();
  const {
    data: rows,
    failed: loadFailed,
    reload: load,
  } = useConfigRead(bankUrl(code, 'documents'), parseDocuments);
  const [editing, setEditing] = useState<
    DocumentRequirement | { product: string } | null
  >(null);
  const [deleting, setDeleting] = useState<DocumentRequirement | null>(null);

  async function remove(row: DocumentRequirement) {
    const q = new URLSearchParams({ product: row.product, key: row.docKey });
    const answer = await call(`${bankUrl(code, 'documents')}?${q}`, {
      method: 'DELETE',
    });
    if (!answer.ok) return failToast(answer);
    toast.success(t('deleted'));
    await load();
  }

  if (loadFailed)
    return (
      <p className="text-destructive text-sm" role="alert">
        {tc('loadFailed')}
      </p>
    );
  if (!rows)
    return <div className="bg-muted/50 h-40 animate-pulse rounded-xl" />;

  const groups = groupByProduct(rows);

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <p className="text-muted-foreground text-sm">{t('help')}</p>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={() => setEditing({ product: '' })}
          >
            <Plus className="size-4" />
            {t('add')}
          </Button>
        </div>
        {groups.length === 0 ? (
          <p className="text-muted-foreground py-4 text-center text-sm">
            {t('empty')}
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.product} className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-foreground text-sm font-semibold break-words">
                  {group.product}
                </h4>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditing({ product: group.product })}
                >
                  <Plus className="size-4" />
                  {t('addToProduct')}
                </Button>
              </div>
              <ul className="divide-border border-border divide-y rounded-lg border">
                {group.documents.map((doc) => (
                  <li
                    key={doc.docKey}
                    className="flex items-start gap-2 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-foreground text-sm break-words">
                        {doc.label}
                      </p>
                      <code className="text-muted-foreground font-mono text-xs">
                        {doc.docKey}
                      </code>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('editLabel', { label: doc.label })}
                      onClick={() => setEditing(doc)}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('deleteLabel', { label: doc.label })}
                      onClick={() => setDeleting(doc)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </CardContent>

      {editing ? (
        <DocumentDialog
          code={code}
          row={'docKey' in editing ? editing : null}
          product={editing.product}
          rows={rows}
          onClose={() => setEditing(null)}
          onSaved={load}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={t('deleteTitle')}
        description={t('deleteBody', {
          label: deleting?.label ?? '',
          product: deleting?.product ?? '',
        })}
        cancelLabel={tc('cancel')}
        confirmLabel={tc('delete')}
        onConfirm={() => {
          const row = deleting;
          setDeleting(null);
          if (row) void remove(row);
        }}
        destructive
      />
    </Card>
  );
}

function DocumentDialog({
  code,
  row,
  product: initialProduct,
  rows,
  onClose,
  onSaved,
}: {
  code: string;
  row: DocumentRequirement | null;
  product: string;
  rows: DocumentRequirement[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const t = useTranslations('CaseSettings.documents');
  const tc = useTranslations('CaseSettings');
  const failToast = useFailToast();
  const [product, setProduct] = useState(initialProduct);
  const [label, setLabel] = useState(row?.label ?? '');
  const [key, setKey] = useState(row?.docKey ?? '');
  const [keyTouched, setKeyTouched] = useState(!!row);
  const [position, setPosition] = useState(row ? String(row.position) : '');
  const [busy, setBusy] = useState(false);

  const shownKey = keyTouched ? key : keyFromLabel(label);
  // Products match case- and space-insensitively (the documents route).
  const sameProduct = (p: string) =>
    p.trim().replace(/\s+/g, ' ').toLowerCase() ===
    product.trim().replace(/\s+/g, ' ').toLowerCase();
  const keyError =
    shownKey && !CONFIG_KEY_RE.test(shownKey)
      ? tc('keyInvalid')
      : !row &&
          rows.some((r) => sameProduct(r.product) && r.docKey === shownKey)
        ? tc('keyTaken')
        : null;
  const positionOk = position.trim() === '' || wholeNumber(position) !== null;
  const canSave =
    product.trim().length > 0 &&
    label.trim().length > 0 &&
    CONFIG_KEY_RE.test(shownKey) &&
    !keyError &&
    positionOk;

  return (
    <FormDialog
      title={row ? t('editTitle') : t('addTitle')}
      busy={busy}
      canSave={canSave}
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        const answer = await call(bankUrl(code, 'documents'), {
          method: 'POST',
          body: JSON.stringify({
            product: product.trim(),
            doc_key: shownKey,
            label: label.trim(),
            position: wholeNumber(position) ?? undefined,
          }),
        });
        setBusy(false);
        if (!answer.ok) return failToast(answer);
        toast.success(t('saved'));
        onClose();
        await onSaved();
      }}
    >
      <Field id="case-doc-product" label={t('product')} hint={t('productHelp')}>
        <Input
          id="case-doc-product"
          value={product}
          onChange={(e) => setProduct(e.target.value)}
          maxLength={200}
          disabled={!!row || busy}
          autoComplete="off"
        />
      </Field>
      <Field id="case-doc-label" label={t('label')}>
        <Input
          id="case-doc-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={200}
          disabled={busy}
          autoComplete="off"
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="case-doc-key"
          label={tc('key')}
          hint={tc('keyHelp')}
          error={keyError}
        >
          <Input
            id="case-doc-key"
            value={shownKey}
            onChange={(e) => {
              setKeyTouched(true);
              setKey(e.target.value.toLowerCase());
            }}
            maxLength={64}
            disabled={!!row || busy}
            autoComplete="off"
            spellCheck={false}
            dir="ltr"
            className="font-mono"
          />
        </Field>
        <Field
          id="case-doc-position"
          label={tc('position')}
          hint={tc('positionHelp')}
          error={positionOk ? null : tc('wholeNumber')}
        >
          <Input
            id="case-doc-position"
            inputMode="numeric"
            value={position}
            onChange={(e) => setPosition(e.target.value)}
            disabled={busy}
          />
        </Field>
      </div>
    </FormDialog>
  );
}

// ---------- SLA ----------

function useSlaCellText() {
  const t = useTranslations('CaseSettings.sla');
  return (row: SlaConfigRow | null): string => {
    const label = slaCellLabel(row);
    if (label.kind === 'none') return '—';
    const amount =
      label.unit === 'days'
        ? t('days', { count: label.amount })
        : t('minutes', { count: label.amount });
    const dueSoon =
      label.dueSoon.kind === 'pct'
        ? t('dueSoonPct', { pct: label.dueSoon.pct })
        : t('dueSoonMinutes', { count: label.dueSoon.minutes });
    return t('cell', { amount, dueSoon });
  };
}

function SlaTab({ code }: { code: string }) {
  const t = useTranslations('CaseSettings.sla');
  const tc = useTranslations('CaseSettings');
  const cellText = useSlaCellText();
  const {
    data,
    failed: loadFailed,
    reload: load,
  } = useConfigRead(bankUrl(code, 'sla'), parseSla);
  const [editing, setEditing] = useState<{
    stage: string;
    timer: SlaTimerKey;
  } | null>(null);

  if (loadFailed)
    return (
      <p className="text-destructive text-sm" role="alert">
        {tc('loadFailed')}
      </p>
    );
  if (!data)
    return <div className="bg-muted/50 h-40 animate-pulse rounded-xl" />;

  return (
    <Card>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-sm">{t('help')}</p>
        <div className="border-border overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[36rem] text-sm">
            <thead className="bg-muted/50 text-muted-foreground text-xs">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  {t('stage')}
                </th>
                {SLA_TIMERS.map((timer) => (
                  <th
                    key={timer}
                    scope="col"
                    className="px-3 py-2 text-left font-medium"
                  >
                    {t(`timers.${timer}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-border divide-y">
              {data.stages.map((stage) => (
                <tr key={stage}>
                  <th
                    scope="row"
                    className="text-foreground px-3 py-2 text-left font-medium"
                  >
                    {stage}
                  </th>
                  {SLA_TIMERS.map((timer) => {
                    const row = slaRowFor(data.config, stage, timer);
                    return (
                      <td key={timer} className="px-1 py-1">
                        <button
                          type="button"
                          onClick={() => setEditing({ stage, timer })}
                          aria-label={t('editCell', {
                            stage,
                            timer: t(`timers.${timer}`),
                          })}
                          className={cn(
                            'hover:bg-muted w-full rounded-md px-2 py-1.5 text-left',
                            row ? 'text-foreground' : 'text-muted-foreground'
                          )}
                        >
                          {cellText(row)}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>

      {editing ? (
        <SlaDialog
          code={code}
          stage={editing.stage}
          timer={editing.timer}
          row={slaRowFor(data.config, editing.stage, editing.timer)}
          onClose={() => setEditing(null)}
          onSaved={load}
        />
      ) : null}
    </Card>
  );
}

function SlaDialog({
  code,
  stage,
  timer,
  row,
  onClose,
  onSaved,
}: {
  code: string;
  stage: string;
  timer: SlaTimerKey;
  row: SlaConfigRow | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const t = useTranslations('CaseSettings.sla');
  const tc = useTranslations('CaseSettings');
  const failToast = useFailToast();
  const [amount, setAmount] = useState(row ? String(row.amount) : '');
  const [unit, setUnit] = useState<'minutes' | 'days'>(row?.unit ?? 'days');
  const [pct, setPct] = useState(
    String(row?.dueSoonPct ?? DEFAULT_DUE_SOON_PCT)
  );
  const [minutes, setMinutes] = useState(
    row?.dueSoonMinutes ? String(row.dueSoonMinutes) : ''
  );
  const [busy, setBusy] = useState(false);

  const amountN = wholeNumber(amount);
  const pctN = wholeNumber(pct);
  const pctOk = pctN !== null && pctN <= 99;
  const minutesOk = minutes.trim() === '' || wholeNumber(minutes) !== null;
  const canSave = amountN !== null && pctOk && minutesOk;

  async function clear() {
    setBusy(true);
    const q = new URLSearchParams({ stage, timer });
    const answer = await call(`${bankUrl(code, 'sla')}?${q}`, {
      method: 'DELETE',
    });
    setBusy(false);
    if (!answer.ok) return failToast(answer);
    toast.success(t('cleared'));
    onClose();
    await onSaved();
  }

  return (
    <FormDialog
      title={t('dialogTitle', { stage })}
      description={t(`timers.${timer}`)}
      busy={busy}
      canSave={canSave}
      onClose={onClose}
      extra={
        row ? (
          <Button
            type="button"
            variant="ghost"
            className="text-destructive sm:mr-auto"
            onClick={() => void clear()}
            disabled={busy}
          >
            <Trash2 className="size-4" />
            {t('clear')}
          </Button>
        ) : null
      }
      onSubmit={async () => {
        setBusy(true);
        const answer = await call(bankUrl(code, 'sla'), {
          method: 'POST',
          body: JSON.stringify({
            stage,
            timer,
            amount: amountN,
            unit,
            due_soon_pct: pctN,
            due_soon_minutes: wholeNumber(minutes),
          }),
        });
        setBusy(false);
        if (!answer.ok) return failToast(answer);
        toast.success(t('saved'));
        onClose();
        await onSaved();
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="case-sla-amount">{t('amount')}</Label>
        <div className="flex gap-2">
          <Input
            id="case-sla-amount"
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={busy}
            className="w-24"
          />
          <div
            role="radiogroup"
            aria-label={t('unit')}
            className="border-border inline-flex rounded-lg border p-0.5"
          >
            {(['minutes', 'days'] as const).map((u) => (
              <button
                key={u}
                type="button"
                role="radio"
                aria-checked={unit === u}
                disabled={busy}
                onClick={() => setUnit(u)}
                className={cn(
                  'rounded-md px-3 text-sm',
                  unit === u
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t(`units.${u}`)}
              </button>
            ))}
          </div>
        </div>
        {amount && amountN === null ? (
          <p className="text-destructive text-xs">{tc('wholeNumber')}</p>
        ) : null}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="case-sla-pct"
          label={t('dueSoonPctLabel')}
          hint={t('dueSoonPctHelp')}
          error={pctOk ? null : t('pctRange')}
        >
          <Input
            id="case-sla-pct"
            inputMode="numeric"
            value={pct}
            onChange={(e) => setPct(e.target.value)}
            disabled={busy}
          />
        </Field>
        <Field
          id="case-sla-minutes"
          label={t('dueSoonMinutesLabel')}
          hint={t('dueSoonMinutesHelp')}
          error={minutesOk ? null : tc('wholeNumber')}
        >
          <Input
            id="case-sla-minutes"
            inputMode="numeric"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            disabled={busy}
          />
        </Field>
      </div>
    </FormDialog>
  );
}
