'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  ArrowDown,
  ArrowUp,
  Loader2,
  Pencil,
  Plus,
  Trash2,
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
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/ui-ext/confirm-dialog';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import {
  MACRO_ACTION_KINDS,
  MACRO_ACTIONS_MAX,
  MACRO_DUE_HOURS_MAX,
  MACRO_NAME_MAX,
  MACRO_NOTE_MAX,
  MACRO_NOTE_PLACEHOLDERS,
  MACRO_OUTCOMES,
  MACRO_OWNER_ROLES,
  blankAction,
  macroBody,
  macroErrorKey,
  moveAction,
  parseMacros,
  parseSavedMacro,
  stageAction,
  validateMacroDraft,
  type CaseMacroView,
  type MacroAction,
  type MacroActionKind,
  type MacroOwnerRole,
  type MacroProblem,
} from '@/lib/cases/macros-ui';
import { DEFAULT_STAGES } from '@/lib/cases/ui';

/** Native field fill (CLAUDE.md): a `<select>` styled like `Input`. */
const SELECT =
  'border-input bg-card dark:bg-input/30 h-9 w-full min-w-0 rounded-md border px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50';

type Answer = { ok: boolean; status: number; body: unknown };

/** One macros route call; a network failure is a status-0 answer. */
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

function list(body: unknown, key: string): unknown[] {
  const v =
    body && typeof body === 'object'
      ? (body as Record<string, unknown>)[key]
      : null;
  return Array.isArray(v) ? v : [];
}

function errorCode(body: unknown): unknown {
  const e =
    body && typeof body === 'object'
      ? (body as Record<string, unknown>).error
      : null;
  if (e && typeof e === 'object') return (e as Record<string, unknown>).code;
  if (body && typeof body === 'object')
    return (body as Record<string, unknown>).code;
  return null;
}

interface TemplateOption {
  key: string;
  title: string;
}

/**
 * Every bank's task templates, one option per template key (the first
 * bank's title wins). A failed read is an empty list: the dialog still
 * keeps a stored key, labelled with the key itself.
 */
async function loadTemplateOptions(): Promise<TemplateOption[]> {
  const banks = await call('/api/cases/config/banks');
  if (!banks.ok) return [];
  const codes = list(banks.body, 'banks')
    .map((b) => (b as { code?: unknown }).code)
    .filter((c): c is string => typeof c === 'string');
  const answers = await Promise.all(
    codes.map((code) =>
      call(`/api/cases/config/banks/${encodeURIComponent(code)}/templates`)
    )
  );
  const byKey = new Map<string, TemplateOption>();
  for (const answer of answers) {
    if (!answer.ok) continue;
    const rows = list(answer.body, 'templates') as {
      templateKey?: unknown;
      title?: unknown;
      position?: unknown;
    }[];
    const sorted = [...rows].sort(
      (a, b) => Number(a.position ?? 0) - Number(b.position ?? 0)
    );
    for (const r of sorted) {
      if (typeof r.templateKey !== 'string' || byKey.has(r.templateKey))
        continue;
      byKey.set(r.templateKey, {
        key: r.templateKey,
        title: typeof r.title === 'string' ? r.title : r.templateKey,
      });
    }
  }
  return [...byKey.values()];
}

/**
 * Settings -> Cases -> Macros (migration 186): the caller's own macros and
 * the shared ones. Only the owner edits a macro; the owner or an
 * owner/admin deletes it. The routes (and 186's SQL) are the judge;
 * `lib/cases/macros-ui` holds the rules the dialog warns with.
 */
export function CaseMacrosSettingsCard() {
  const t = useTranslations('CaseMacros');
  const { user } = useAuth();
  const canAdmin = useCan('edit-settings');
  const [macros, setMacros] = useState<CaseMacroView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<CaseMacroView | 'new' | null>(null);
  const [deleting, setDeleting] = useState<CaseMacroView | null>(null);

  const read = useCallback(async () => {
    const answer = await call('/api/cases/macros');
    const parsed = answer.ok ? parseMacros(answer.body) : null;
    return parsed;
  }, []);

  useEffect(() => {
    let off = false;
    void read().then((parsed) => {
      if (off) return;
      setMacros(parsed);
      setFailed(parsed === null);
    });
    return () => {
      off = true;
    };
  }, [read]);

  const reload = useCallback(async () => {
    const parsed = await read();
    setMacros(parsed);
    setFailed(parsed === null);
  }, [read]);

  async function remove(macro: CaseMacroView) {
    const answer = await call(
      `/api/cases/macros/${encodeURIComponent(macro.id)}`,
      { method: 'DELETE' }
    );
    if (!answer.ok) {
      toast.error(
        t(`errors.${macroErrorKey(answer.status, errorCode(answer.body))}`)
      );
      return;
    }
    toast.success(t('deleted'));
    await reload();
  }

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <h3 className="text-foreground text-sm font-medium">
              {t('title')}
            </h3>
            <p className="text-muted-foreground text-sm">{t('description')}</p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            disabled={!macros}
            onClick={() => setEditing('new')}
          >
            <Plus className="size-4" />
            {t('add')}
          </Button>
        </div>

        {failed ? (
          <p className="text-destructive text-sm" role="alert">
            {t('loadFailed')}
          </p>
        ) : !macros ? (
          <div className="bg-muted/50 h-24 animate-pulse rounded-lg" />
        ) : macros.length === 0 ? (
          <p className="text-muted-foreground py-4 text-center text-sm">
            {t('empty')}
          </p>
        ) : (
          <ul className="divide-border border-border divide-y rounded-lg border">
            {macros.map((m) => {
              const own = !!user && m.ownerUserId === user.id;
              return (
                <li key={m.id} className="flex items-center gap-2 px-3 py-2">
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-foreground truncate text-sm font-medium">
                      {m.name}
                    </span>
                    {m.shared ? (
                      <Badge variant="secondary" className="text-xs">
                        {t('shared')}
                      </Badge>
                    ) : null}
                    <span className="text-muted-foreground text-xs">
                      {t('actionCount', { count: m.actions.length })}
                    </span>
                  </div>
                  {own ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('editLabel', { name: m.name })}
                      onClick={() => setEditing(m)}
                    >
                      <Pencil className="size-4" />
                    </Button>
                  ) : null}
                  {own || canAdmin ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('deleteLabel', { name: m.name })}
                      onClick={() => setDeleting(m)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      {editing ? (
        <MacroDialog
          macro={editing === 'new' ? null : editing}
          canShare={canAdmin}
          onClose={() => setEditing(null)}
          onSaved={reload}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={t('deleteTitle')}
        description={t('deleteBody', { name: deleting?.name ?? '' })}
        cancelLabel={t('dialog.cancel')}
        confirmLabel={t('deleteConfirm')}
        onConfirm={() => {
          const m = deleting;
          setDeleting(null);
          if (m) void remove(m);
        }}
        destructive
      />
    </Card>
  );
}

function MacroDialog({
  macro,
  canShare,
  onClose,
  onSaved,
}: {
  macro: CaseMacroView | null;
  canShare: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const t = useTranslations('CaseMacros');
  const [name, setName] = useState(macro?.name ?? '');
  const [actions, setActions] = useState<MacroAction[]>(macro?.actions ?? []);
  const [shared, setShared] = useState(macro?.shared ?? false);
  const [adding, setAdding] = useState<MacroActionKind>('add_task');
  const [templates, setTemplates] = useState<TemplateOption[] | null>(null);
  const [problem, setProblem] = useState<MacroProblem | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let off = false;
    void loadTemplateOptions().then((opts) => {
      if (!off) setTemplates(opts);
    });
    return () => {
      off = true;
    };
  }, []);

  const problemText = (p: MacroProblem): string =>
    p.kind === 'action'
      ? t('problems.action', {
          step: p.index + 1,
          problem: t(`problems.actions.${p.problem}`),
        })
      : t(`problems.${p.kind}`);

  const update = (i: number, next: MacroAction) => {
    setProblem(null);
    setActions(actions.map((a, j) => (j === i ? next : a)));
  };

  async function submit() {
    const draft = { name, actions, shared };
    const found = validateMacroDraft(draft);
    setProblem(found);
    if (found) return;
    setBusy(true);
    const answer = await call('/api/cases/macros', {
      method: 'POST',
      body: JSON.stringify(macroBody(draft, macro?.id ?? null, canShare)),
    });
    setBusy(false);
    if (!answer.ok || !parseSavedMacro(answer.body)) {
      toast.error(
        t(`errors.${macroErrorKey(answer.status, errorCode(answer.body))}`)
      );
      return;
    }
    toast.success(t('saved'));
    onClose();
    await onSaved();
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {macro ? t('dialog.editTitle') : t('dialog.newTitle')}
            </DialogTitle>
            <DialogDescription>{t('dialog.description')}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-1.5">
            <Label htmlFor="case-macro-name">{t('dialog.nameLabel')}</Label>
            <Input
              id="case-macro-name"
              value={name}
              onChange={(e) => {
                setProblem(null);
                setName(e.target.value);
              }}
              maxLength={MACRO_NAME_MAX}
              disabled={busy}
              autoComplete="off"
            />
          </div>

          <div className="space-y-2">
            <p className="text-foreground text-sm font-medium">
              {t('dialog.actionsLabel')}
            </p>
            <ol className="space-y-2">
              {actions.map((action, i) => (
                <li
                  key={i}
                  className="border-border bg-card-2 space-y-3 rounded-lg border p-3"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-foreground min-w-0 flex-1 text-sm font-medium">
                      {t('dialog.step', { step: i + 1 })} ·{' '}
                      {t(`kinds.${action.kind}`)}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={busy || i === 0}
                      aria-label={t('dialog.moveUp', { step: i + 1 })}
                      onClick={() => setActions(moveAction(actions, i, -1))}
                    >
                      <ArrowUp className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={busy || i === actions.length - 1}
                      aria-label={t('dialog.moveDown', { step: i + 1 })}
                      onClick={() => setActions(moveAction(actions, i, 1))}
                    >
                      <ArrowDown className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={busy}
                      aria-label={t('dialog.remove', { step: i + 1 })}
                      onClick={() => {
                        setProblem(null);
                        setActions(actions.filter((_, j) => j !== i));
                      }}
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                  <ActionFields
                    action={action}
                    index={i}
                    templates={templates}
                    busy={busy}
                    onChange={(next) => update(i, next)}
                  />
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap gap-2">
              <select
                aria-label={t('dialog.addAction')}
                className={`${SELECT} w-auto`}
                value={adding}
                onChange={(e) => setAdding(e.target.value as MacroActionKind)}
                disabled={busy || actions.length >= MACRO_ACTIONS_MAX}
              >
                {MACRO_ACTION_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`kinds.${k}`)}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || actions.length >= MACRO_ACTIONS_MAX}
                onClick={() => {
                  setProblem(null);
                  setActions([
                    ...actions,
                    blankAction(
                      adding,
                      templates?.[0]?.key ?? '',
                      DEFAULT_STAGES[0] ?? ''
                    ),
                  ]);
                }}
              >
                <Plus className="size-4" />
                {t('dialog.addAction')}
              </Button>
            </div>
          </div>

          {canShare ? (
            <div className="flex items-start gap-2">
              <input
                id="case-macro-shared"
                type="checkbox"
                className="border-input accent-primary mt-0.5 size-4 shrink-0"
                checked={shared}
                onChange={(e) => setShared(e.target.checked)}
                disabled={busy}
                aria-describedby="case-macro-shared-help"
              />
              <div className="space-y-0.5">
                <Label htmlFor="case-macro-shared">
                  {t('dialog.shareLabel')}
                </Label>
                <p
                  id="case-macro-shared-help"
                  className="text-muted-foreground text-xs"
                >
                  {t('dialog.shareHelp')}
                </p>
              </div>
            </div>
          ) : null}

          {problem ? (
            <p className="text-destructive text-sm" role="alert">
              {problemText(problem)}
            </p>
          ) : null}

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={busy}
            >
              {t('dialog.cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('dialog.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ActionFields({
  action,
  index,
  templates,
  busy,
  onChange,
}: {
  action: MacroAction;
  index: number;
  templates: TemplateOption[] | null;
  busy: boolean;
  onChange: (next: MacroAction) => void;
}) {
  const t = useTranslations('CaseMacros.fields');
  const id = (part: string) => `case-macro-${index}-${part}`;

  switch (action.kind) {
    case 'add_task': {
      const options = templates ?? [];
      const known = options.some((o) => o.key === action.templateKey);
      return (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1.5 sm:col-span-3">
            <Label htmlFor={id('template')}>{t('template')}</Label>
            <select
              id={id('template')}
              className={SELECT}
              value={action.templateKey}
              onChange={(e) =>
                onChange({ ...action, templateKey: e.target.value })
              }
              disabled={busy || templates === null}
            >
              {action.templateKey === '' ? <option value="" /> : null}
              {action.templateKey !== '' && !known ? (
                <option value={action.templateKey}>{action.templateKey}</option>
              ) : null}
              {options.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.title}
                </option>
              ))}
            </select>
            {templates !== null && options.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                {t('templateNone')}
              </p>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={id('due')}>{t('dueHours')}</Label>
            <Input
              id={id('due')}
              type="number"
              inputMode="numeric"
              min={1}
              max={MACRO_DUE_HOURS_MAX}
              step={1}
              value={action.dueHours ?? ''}
              onChange={(e) => {
                const raw = e.target.value.trim();
                const rest = {
                  kind: 'add_task' as const,
                  templateKey: action.templateKey,
                  ownerRole: action.ownerRole,
                };
                onChange(
                  raw === '' ? rest : { ...rest, dueHours: Number(raw) }
                );
              }}
              disabled={busy}
            />
            <p className="text-muted-foreground text-xs">{t('dueHoursHint')}</p>
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor={id('owner')}>{t('ownerRole')}</Label>
            <select
              id={id('owner')}
              className={SELECT}
              value={action.ownerRole}
              onChange={(e) =>
                onChange({
                  ...action,
                  ownerRole: e.target.value as MacroOwnerRole,
                })
              }
              disabled={busy}
            >
              {MACRO_OWNER_ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`owner.${r}`)}
                </option>
              ))}
            </select>
          </div>
        </div>
      );
    }
    case 'add_note':
      return (
        <div className="grid gap-1.5">
          <Label htmlFor={id('body')}>{t('body')}</Label>
          <Textarea
            id={id('body')}
            value={action.body}
            onChange={(e) =>
              onChange({ kind: 'add_note', body: e.target.value })
            }
            maxLength={MACRO_NOTE_MAX}
            rows={3}
            disabled={busy}
          />
          <p className="text-muted-foreground flex flex-wrap items-center gap-1 text-xs">
            <span>{t('placeholdersHint')}</span>
            {MACRO_NOTE_PLACEHOLDERS.map((p) => (
              <code key={p} className="bg-muted rounded px-1 font-mono">
                {p}
              </code>
            ))}
          </p>
        </div>
      );
    case 'set_stage': {
      const known = DEFAULT_STAGES.includes(action.stage);
      const outcome = (MACRO_OUTCOMES as readonly string[]).includes(
        action.stage
      )
        ? action.stage
        : null;
      return (
        <div className="grid gap-1.5">
          <Label htmlFor={id('stage')}>{t('stage')}</Label>
          <select
            id={id('stage')}
            className={SELECT}
            value={action.stage}
            onChange={(e) => onChange(stageAction(e.target.value))}
            disabled={busy}
          >
            {action.stage !== '' && !known ? (
              <option value={action.stage}>{action.stage}</option>
            ) : null}
            {DEFAULT_STAGES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          {outcome ? (
            <p className="text-muted-foreground text-xs">
              {t('outcomeHint', { outcome })}
            </p>
          ) : null}
        </div>
      );
    }
    case 'request_documents':
      return (
        <p className="text-muted-foreground text-xs">
          {t('requestDocumentsHint')}
        </p>
      );
  }
}
