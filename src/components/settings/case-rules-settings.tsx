'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Info, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';

import { useWorkspaceMembers } from '@/components/meetings/use-workspace-members';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
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
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/ui-ext/confirm-dialog';
import { useCan } from '@/hooks/use-can';
import {
  RULE_ACTIONS_MAX,
  RULE_SLA_TIMERS,
  RULE_TASK_OWNERS,
  RULE_TRIGGERS,
  actionKindsFor,
  describeRule,
  draftBody,
  draftFromRule,
  emptyDraft,
  newDraftAction,
  parseRules,
  parseSavedRule,
  parseTemplateOptions,
  ruleErrorKey,
  templateChoices,
  toggleBody,
  validateDraft,
  withTrigger,
  type DraftAction,
  type PreSubmissionChoice,
  type RuleActionKind,
  type RuleDraft,
  type RuleSlaTimer,
  type RuleTaskOwner,
  type RuleTemplateOption,
  type RuleTrigger,
  type RuleView,
  type RulesT,
} from '@/lib/cases/rules-ui';
import { PRIORITIES, type CasePriority } from '@/lib/cases/types';
import {
  DEFAULT_STAGES,
  parseBanks,
  type CaseBankOption,
} from '@/lib/cases/ui';

const ANY = '__any__';

type Answer = { ok: boolean; body: unknown };

async function call(url: string, init?: RequestInit): Promise<Answer> {
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      ...init,
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    });
    return { ok: res.ok, body: await res.json().catch(() => null) };
  } catch {
    return { ok: false, body: null };
  }
}

/**
 * Settings -> Cases -> Automation rules (migration 187). Owners and
 * admins edit (the route and `case_rule_save` decide); anyone else who
 * reaches the panel reads. With no rules nothing happens.
 */
export function CaseRulesSettingsCard() {
  const t = useTranslations('CaseRules');
  const tr = t as unknown as RulesT;
  const locale = useLocale();
  const canEdit = useCan('edit-settings');
  const { members, nameOf } = useWorkspaceMembers();
  const [rules, setRules] = useState<RuleView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [banks, setBanks] = useState<CaseBankOption[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<RuleDraft | null>(null);
  const [deleting, setDeleting] = useState<RuleView | null>(null);

  const load = useCallback(async () => {
    const answer = await call('/api/cases/rules');
    const parsed = answer.ok ? parseRules(answer.body) : null;
    setRules(parsed);
    setFailed(parsed === null);
  }, []);

  useEffect(() => {
    let off = false;
    void call('/api/cases/rules').then((answer) => {
      if (off) return;
      const parsed = answer.ok ? parseRules(answer.body) : null;
      setRules(parsed);
      setFailed(parsed === null);
    });
    void call('/api/cases/config/banks').then((answer) => {
      if (off || !answer.ok) return;
      setBanks(parseBanks(answer.body));
    });
    return () => {
      off = true;
    };
  }, []);

  const failToast = (body: unknown) =>
    toast.error(t(`errors.${ruleErrorKey(body)}`));

  // Every bank's task templates: the create_task picker, and the titles the
  // list shows for a create_task rule. Read only when one of those needs
  // them (a dialog is open, or a saved rule creates a task), once per page
  // view, one request per bank. A bank whose read fails is left out and
  // said so; nothing is read while a workspace has no such rule.
  const [templates, setTemplates] = useState<ReadonlyMap<
    string,
    RuleTemplateOption[]
  > | null>(null);
  const needTemplates =
    editing !== null ||
    (rules ?? []).some((r) => r.actions.some((a) => a.kind === 'create_task'));
  useEffect(() => {
    if (!needTemplates || templates !== null || banks.length === 0) return;
    let off = false;
    void Promise.all(
      banks.map((b) =>
        call(
          `/api/cases/config/banks/${encodeURIComponent(b.code)}/templates`
        ).then((a) => [b.code, a] as const)
      )
    ).then((lists) => {
      if (off) return;
      const bad = lists.find(([, a]) => !a.ok);
      if (bad) toast.error(t(`errors.${ruleErrorKey(bad[1].body)}`));
      setTemplates(
        new Map(
          lists
            .filter(([, a]) => a.ok)
            .map(([code, a]) => [code, parseTemplateOptions(a.body)])
        )
      );
    });
    return () => {
      off = true;
    };
  }, [needTemplates, templates, banks, t]);

  const bankName = (code: string) =>
    banks.find((b) => b.code === code)?.name ?? code;
  const personName = (id: string) => nameOf(id) ?? t('dialog.pickPerson');
  // The list names a task by its template title (any bank's), else its key.
  const templateName = (key: string) =>
    templateChoices(templates ?? new Map(), '', []).find((o) => o.key === key)
      ?.title ?? key;

  async function toggle(rule: RuleView, enabled: boolean) {
    setBusy(rule.ruleId);
    const answer = await call('/api/cases/rules', {
      method: 'POST',
      body: JSON.stringify(toggleBody(rule, enabled)),
    });
    setBusy(null);
    const saved = answer.ok ? parseSavedRule(answer.body) : null;
    if (!saved) {
      failToast(answer.body);
      return;
    }
    setRules((list) =>
      list ? list.map((r) => (r.ruleId === saved.ruleId ? saved : r)) : list
    );
    toast.success(
      saved.enabled ? t('settings.turnedOn') : t('settings.turnedOff')
    );
  }

  async function remove(rule: RuleView) {
    setBusy(rule.ruleId);
    const answer = await call(
      `/api/cases/rules/${encodeURIComponent(rule.ruleId)}`,
      { method: 'DELETE' }
    );
    setBusy(null);
    if (!answer.ok) {
      failToast(answer.body);
      return;
    }
    toast.success(t('settings.deleted'));
    await load();
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <CardTitle>{t('settings.title')}</CardTitle>
          <CardDescription>{t('settings.description')}</CardDescription>
        </div>
        {canEdit && rules && (
          <Button size="sm" onClick={() => setEditing(emptyDraft())}>
            <Plus className="size-4" />
            {t('settings.add')}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="border-info/30 bg-info-soft text-info flex items-start gap-2 rounded-md border px-3 py-2 text-sm">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          {t('settings.note')}
        </p>
        {failed ? (
          <p className="text-destructive text-sm" role="alert">
            {t('settings.loadFailed')}
          </p>
        ) : !rules ? (
          <div
            className="bg-muted/50 h-16 w-full animate-pulse rounded-lg"
            aria-busy="true"
          />
        ) : rules.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('settings.empty')}</p>
        ) : (
          <ol className="divide-y rounded-lg border">
            {rules.map((r, i) => (
              <li
                key={r.ruleId}
                className="bg-card-2 flex items-start gap-3 px-3 py-2.5 first:rounded-t-lg last:rounded-b-lg"
              >
                <span className="text-muted-foreground w-5 pt-0.5 text-xs tabular-nums">
                  {i + 1}.
                </span>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <span className="truncate">{r.name}</span>
                    {!r.enabled && (
                      <Badge variant="secondary">{t('settings.off')}</Badge>
                    )}
                  </p>
                  <p className="text-muted-foreground text-xs break-words">
                    {describeRule(r, {
                      t: tr,
                      locale,
                      bankName,
                      personName,
                      templateName,
                    })}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {busy === r.ruleId && (
                    <Loader2 className="text-muted-foreground size-4 animate-spin" />
                  )}
                  <Switch
                    checked={r.enabled}
                    disabled={!canEdit || busy !== null}
                    onCheckedChange={(v) => void toggle(r, !!v)}
                    aria-label={t('settings.toggle', { name: r.name })}
                  />
                  {canEdit && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('settings.edit')}
                        onClick={() => setEditing(draftFromRule(r))}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('settings.delete')}
                        disabled={busy !== null}
                        onClick={() => setDeleting(r)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
        {rules && !canEdit && (
          <p className="text-muted-foreground text-xs">
            {t('settings.readOnly')}
          </p>
        )}
      </CardContent>

      {editing && (
        <RuleDialog
          key={editing.ruleId ?? 'new'}
          initial={editing}
          banks={banks}
          templates={templates}
          members={members.filter((m) => !m.deactivated_at)}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            toast.success(t('settings.saved'));
            await load();
          }}
          onFailed={failToast}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('settings.deleteTitle')}
        description={t('settings.deleteBody', { name: deleting?.name ?? '' })}
        cancelLabel={t('dialog.cancel')}
        confirmLabel={t('settings.deleteConfirm')}
        destructive
        onConfirm={() => {
          const r = deleting;
          setDeleting(null);
          if (r) void remove(r);
        }}
      />
    </Card>
  );
}

function RuleDialog({
  initial,
  banks,
  templates,
  members,
  onClose,
  onSaved,
  onFailed,
}: {
  initial: RuleDraft;
  banks: CaseBankOption[];
  /** Every bank's task templates; null while they load (the card reads them). */
  templates: ReadonlyMap<string, RuleTemplateOption[]> | null;
  members: { user_id: string; full_name: string | null; email: string }[];
  onClose: () => void;
  onSaved: () => Promise<void>;
  onFailed: (body: unknown) => void;
}) {
  const t = useTranslations('CaseRules');
  const [d, setD] = useState<RuleDraft>(initial);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const problems = validateDraft(d);

  const set = (patch: Partial<RuleDraft>) => setD((x) => ({ ...x, ...patch }));
  const setAction = (i: number, patch: Partial<DraftAction>) =>
    setD((x) => ({
      ...x,
      actions: x.actions.map((a, j) => (j === i ? { ...a, ...patch } : a)),
    }));
  const personLabel = (id: string) => {
    const m = members.find((p) => p.user_id === id);
    return m ? m.full_name || m.email : t('dialog.pickPerson');
  };
  const stages =
    d.stage && !DEFAULT_STAGES.includes(d.stage)
      ? [...DEFAULT_STAGES, d.stage]
      : DEFAULT_STAGES;
  const bankOptions =
    d.bankCode && !banks.some((b) => b.code === d.bankCode)
      ? [...banks, { code: d.bankCode, name: d.bankCode }]
      : banks;
  const kinds = actionKindsFor(d.trigger);
  const stageRequired = d.trigger === 'stage_entered';
  // last_required_doc_received carries exactly one, preset advance_stage.
  const fixedActions = d.trigger === 'last_required_doc_received';
  const taskOptions = templateChoices(
    templates ?? new Map(),
    d.bankCode,
    d.actions.map((a) => a.templateKey)
  );
  const taskLabel = (key: string) => {
    const o = taskOptions.find((x) => x.key === key);
    return o ? `${o.title} (${o.key})` : t('dialog.pickTemplate');
  };

  async function save() {
    setTried(true);
    const body = draftBody(d);
    if (!body) return;
    setSaving(true);
    const answer = await call('/api/cases/rules', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    setSaving(false);
    if (!answer.ok || !parseSavedRule(answer.body)) {
      onFailed(answer.body);
      return;
    }
    await onSaved();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {d.ruleId ? t('dialog.editTitle') : t('dialog.newTitle')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-end gap-3">
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label htmlFor="case-rule-name">{t('dialog.name')}</Label>
              <Input
                id="case-rule-name"
                value={d.name}
                maxLength={80}
                onChange={(e) => set({ name: e.target.value })}
              />
            </div>
            <div className="flex items-center gap-2 pb-2">
              <Switch
                id="case-rule-enabled"
                checked={d.enabled}
                onCheckedChange={(v) => set({ enabled: !!v })}
              />
              <Label htmlFor="case-rule-enabled">{t('dialog.enabled')}</Label>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="case-rule-trigger">{t('dialog.trigger')}</Label>
            <Select
              value={d.trigger}
              onValueChange={(v) =>
                v && setD((x) => withTrigger(x, v as RuleTrigger))
              }
            >
              <SelectTrigger id="case-rule-trigger" className="w-full">
                <SelectValue>{t(`trigger.${d.trigger}`)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {RULE_TRIGGERS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {t(`trigger.${k}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {d.trigger === 'no_activity' && (
            <div className="space-y-1.5">
              <Label htmlFor="case-rule-days">{t('dialog.days')}</Label>
              <Input
                id="case-rule-days"
                inputMode="numeric"
                value={d.days}
                onChange={(e) => set({ days: e.target.value })}
                className="w-32"
              />
            </div>
          )}

          <fieldset className="bg-card-2 space-y-3 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">
              {t('dialog.conditions')}
            </legend>
            <p className="text-muted-foreground text-xs">
              {t('dialog.conditionsHelp')}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="case-rule-bank">{t('dialog.bank')}</Label>
                <Select
                  value={d.bankCode || ANY}
                  onValueChange={(v) =>
                    set({ bankCode: !v || v === ANY ? '' : String(v) })
                  }
                >
                  <SelectTrigger id="case-rule-bank" className="w-full">
                    <SelectValue>
                      {d.bankCode
                        ? (bankOptions.find((b) => b.code === d.bankCode)
                            ?.name ?? d.bankCode)
                        : t('dialog.any')}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>{t('dialog.any')}</SelectItem>
                    {bankOptions.map((b) => (
                      <SelectItem key={b.code} value={b.code}>
                        {b.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="case-rule-stage">
                  {t('dialog.stage')}
                  {stageRequired && ' *'}
                </Label>
                <Select
                  value={d.stage || ANY}
                  onValueChange={(v) =>
                    set({ stage: !v || v === ANY ? '' : String(v) })
                  }
                >
                  <SelectTrigger id="case-rule-stage" className="w-full">
                    <SelectValue>
                      {d.stage ||
                        (stageRequired
                          ? t('dialog.pickStage')
                          : t('dialog.any'))}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {!stageRequired && (
                      <SelectItem value={ANY}>{t('dialog.any')}</SelectItem>
                    )}
                    {stages.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="case-rule-product">{t('dialog.product')}</Label>
                <Input
                  id="case-rule-product"
                  value={d.product}
                  placeholder={t('dialog.any')}
                  onChange={(e) => set({ product: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="case-rule-pre">
                  {t('dialog.preSubmission')}
                </Label>
                <Select
                  value={d.preSubmission}
                  onValueChange={(v) =>
                    v && set({ preSubmission: v as PreSubmissionChoice })
                  }
                >
                  <SelectTrigger id="case-rule-pre" className="w-full">
                    <SelectValue>{preLabel(t, d.preSubmission)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {(['any', 'yes', 'no'] as const).map((p) => (
                      <SelectItem key={p} value={p}>
                        {preLabel(t, p)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="case-rule-min">{t('dialog.amountMin')}</Label>
                <Input
                  id="case-rule-min"
                  inputMode="decimal"
                  value={d.amountMin}
                  onChange={(e) => set({ amountMin: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="case-rule-max">{t('dialog.amountMax')}</Label>
                <Input
                  id="case-rule-max"
                  inputMode="decimal"
                  value={d.amountMax}
                  onChange={(e) => set({ amountMax: e.target.value })}
                />
              </div>
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">
              {t('dialog.actions')}
            </legend>
            {d.actions.map((a, i) => (
              <div
                key={i}
                className="bg-card-2 space-y-2 rounded-lg border p-3"
              >
                {fixedActions ? (
                  <p className="text-sm font-medium">{t(`kind.${a.kind}`)}</p>
                ) : (
                  <div className="flex items-center gap-2">
                    <Select
                      value={a.kind}
                      onValueChange={(v) =>
                        v && setAction(i, { kind: v as RuleActionKind })
                      }
                    >
                      <SelectTrigger
                        className="min-w-0 flex-1"
                        aria-label={t('dialog.kind')}
                      >
                        <SelectValue>{t(`kind.${a.kind}`)}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {kinds.map((k) => (
                          <SelectItem key={k} value={k}>
                            {t(`kind.${k}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('dialog.removeAction')}
                      disabled={d.actions.length <= 1}
                      onClick={() =>
                        set({ actions: d.actions.filter((_, j) => j !== i) })
                      }
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                )}
                {a.kind === 'create_task' ? (
                  <div className="space-y-2">
                    {templates !== null && taskOptions.length === 0 ? (
                      <p className="text-muted-foreground text-xs">
                        {t('dialog.noTemplates')}
                      </p>
                    ) : (
                      <Select
                        value={a.templateKey}
                        onValueChange={(v) =>
                          setAction(i, { templateKey: String(v ?? '') })
                        }
                      >
                        <SelectTrigger
                          className="w-full"
                          aria-label={t('dialog.template')}
                        >
                          <SelectValue>{taskLabel(a.templateKey)}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {taskOptions.map((o) => (
                            <SelectItem key={o.key} value={o.key}>
                              {`${o.title} (${o.key})`}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    {!d.bankCode && (
                      <p className="text-muted-foreground text-xs">
                        {t('dialog.templateAnyBankHelp')}
                      </p>
                    )}
                    <div className="grid grid-cols-2 gap-2">
                      <Select
                        value={a.ownerRole}
                        onValueChange={(v) =>
                          v && setAction(i, { ownerRole: v as RuleTaskOwner })
                        }
                      >
                        <SelectTrigger
                          className="w-full"
                          aria-label={t('dialog.owner')}
                        >
                          <SelectValue>
                            {t(`dialog.ownerOption.${a.ownerRole}`)}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {RULE_TASK_OWNERS.map((o) => (
                            <SelectItem key={o} value={o}>
                              {t(`dialog.ownerOption.${o}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        aria-label={t('dialog.dueHours')}
                        placeholder={t('dialog.dueHours')}
                        value={a.dueHours}
                        onChange={(e) =>
                          setAction(i, { dueHours: e.target.value })
                        }
                      />
                    </div>
                    <p className="text-muted-foreground text-xs">
                      {t('dialog.dueHoursHelp')}
                    </p>
                  </div>
                ) : a.kind === 'start_sla' ? (
                  <Select
                    value={a.timer}
                    onValueChange={(v) =>
                      v && setAction(i, { timer: v as RuleSlaTimer })
                    }
                  >
                    <SelectTrigger
                      className="w-full"
                      aria-label={t('dialog.timer')}
                    >
                      <SelectValue>
                        {t(`describe.timer.${a.timer}`)}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {RULE_SLA_TIMERS.map((k) => (
                        <SelectItem key={k} value={k}>
                          {t(`describe.timer.${k}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : a.kind === 'advance_stage' ? (
                  <p className="text-muted-foreground text-xs">
                    {t('dialog.advanceHelp')}
                  </p>
                ) : a.kind === 'assign_agent' ||
                  a.kind === 'assign_coordinator' ? (
                  <Select
                    value={a.userId}
                    onValueChange={(v) =>
                      setAction(i, { userId: String(v ?? '') })
                    }
                  >
                    <SelectTrigger
                      className="w-full"
                      aria-label={t('dialog.person')}
                    >
                      <SelectValue>{personLabel(a.userId)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {members.map((m) => (
                        <SelectItem key={m.user_id} value={m.user_id}>
                          {m.full_name || m.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : a.kind === 'add_note' ? (
                  <div className="space-y-1">
                    <Textarea
                      aria-label={t('dialog.note')}
                      value={a.body}
                      rows={3}
                      onChange={(e) => setAction(i, { body: e.target.value })}
                    />
                    <p className="text-muted-foreground text-xs">
                      {t.raw('dialog.noteHelp') as string}
                    </p>
                  </div>
                ) : (
                  <Select
                    value={a.priority}
                    onValueChange={(v) =>
                      v && setAction(i, { priority: v as CasePriority })
                    }
                  >
                    <SelectTrigger
                      className="w-full"
                      aria-label={t('dialog.priority')}
                    >
                      <SelectValue>{t(`priority.${a.priority}`)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {PRIORITIES.map((p) => (
                        <SelectItem key={p} value={p}>
                          {t(`priority.${p}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            ))}
            {!fixedActions && d.actions.length < RULE_ACTIONS_MAX && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  set({ actions: [...d.actions, newDraftAction()] })
                }
              >
                <Plus className="size-4" />
                {t('dialog.addAction')}
              </Button>
            )}
          </fieldset>

          {tried && problems.length > 0 && (
            <ul className="text-destructive space-y-0.5 text-sm" role="alert">
              {problems.map((p) => (
                <li key={p}>{t(`problem.${p}`)}</li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t('dialog.cancel')}
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            {t('dialog.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function preLabel(
  t: ReturnType<typeof useTranslations<'CaseRules'>>,
  p: PreSubmissionChoice
) {
  return p === 'any'
    ? t('dialog.preAny')
    : p === 'yes'
      ? t('dialog.preYes')
      : t('dialog.preNo');
}
