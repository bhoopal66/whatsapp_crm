'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CheckCircle2, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Textarea } from '@/components/ui/textarea';
import { useWorkspaceMembers } from '@/components/meetings/use-workspace-members';
import { useAuth } from '@/hooks/use-auth';
import {
  predictNumber,
  useAccountNumbers,
  useAllNumberAllocations,
  useMyNumberIds,
} from '@/hooks/use-whatsapp-numbers';
import { canEditSettings, hasMinRole } from '@/lib/auth/roles';
import { GROUP_SETTINGS } from '@/lib/groups/types';
import {
  buildCreateBody,
  contactSearchFilter,
  DEFAULT_TOGGLES,
  firstInvalidStep,
  formatWaId,
  GROUP_ADD_BATCH,
  GROUP_DESCRIPTION_MAX,
  GROUP_MEMBERS_PER_OPERATION,
  GROUP_NAME_MAX,
  mergeMembers,
  nameLength,
  parseCreateResult,
  parsePhoneList,
  summarizeResult,
  validateStep,
  WIZARD_STEPS,
  type PickedContact,
  type ResultPerson,
  type ResultSummary,
  type WizardError,
  type WizardValues,
} from '@/lib/groups/ui';
import { createClient } from '@/lib/supabase/client';
import { usableNumbers } from '@/lib/whatsapp/channel-management';
import { cn } from '@/lib/utils';

type Phase =
  | { kind: 'form' }
  | { kind: 'creating' }
  | { kind: 'done'; groupId: string | null; summary: ResultSummary };

/**
 * New WhatsApp group (POST /api/whatsapp/groups) in three steps: number
 * and name, members, settings. Give it a new `key` each time it opens.
 */
export function CreateGroupDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const t = useTranslations('Groups.create');
  const router = useRouter();
  const { user, accountRole, accountId } = useAuth();
  const numbers = useAccountNumbers(open);
  const allocations = useAllNumberAllocations();
  const myIds = useMyNumberIds();
  const { members: staff } = useWorkspaceMembers();

  // Only the Whapi numbers this person may send from (can_use_channel).
  const options = useMemo(
    () =>
      usableNumbers(
        (numbers ?? []).filter((n) => n.provider === 'whapi'),
        allocations ?? [],
        user?.id ?? null,
        !!accountRole && canEditSettings(accountRole)
      ),
    [numbers, allocations, user?.id, accountRole]
  );

  const [step, setStep] = useState(0);
  const [values, setValues] = useState<WizardValues>({
    channelId: null,
    name: '',
    description: '',
    contacts: [],
    typedText: '',
    toggles: DEFAULT_TOGGLES,
    managerIds: [],
  });
  const [error, setError] = useState<WizardError | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const set = <K extends keyof WizardValues>(k: K, v: WizardValues[K]) => {
    setValues((prev) => ({ ...prev, [k]: v }));
    setError(null);
  };

  // Preselect the number a new chat would start from: one the person is
  // allocated to, else the default, else the oldest (pickChannelForUser).
  const preselected = useMemo(
    () => predictNumber(options, 'whapi', myIds ?? [])?.id ?? null,
    [options, myIds]
  );
  const channelId = values.channelId ?? preselected;
  const current: WizardValues = { ...values, channelId };

  const typed = useMemo(
    () => parsePhoneList(values.typedText),
    [values.typedText]
  );
  const merged = useMemo(
    () => mergeMembers(values.contacts, typed),
    [values.contacts, typed]
  );

  const stepKey = WIZARD_STEPS[step];
  const next = () => {
    const e = validateStep(stepKey, current);
    if (e) return setError(e);
    setStep((s) => s + 1);
  };

  const submit = async () => {
    const bad = firstInvalidStep(current);
    if (bad) {
      setStep(WIZARD_STEPS.indexOf(bad.step));
      return setError(bad.error);
    }
    setPhase({ kind: 'creating' });
    try {
      const res = await fetch('/api/whatsapp/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildCreateBody(current)),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(t('failed', { reason: json?.error ?? res.status }));
        setPhase({ kind: 'form' });
        return;
      }
      const result = parseCreateResult(json);
      onCreated();
      setPhase({
        kind: 'done',
        groupId: result.groupId,
        summary: summarizeResult(result, merged.members),
      });
    } catch {
      toast.error(t('failed', { reason: 'network' }));
      setPhase({ kind: 'form' });
    }
  };

  const errorText = (e: WizardError) =>
    t(`errors.${e}`, { max: GROUP_NAME_MAX });

  return (
    <Dialog
      open={open}
      // A create in flight must not be dismissed half-way.
      onOpenChange={(o) => phase.kind !== 'creating' && onOpenChange(o)}
    >
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-lg"
        showCloseButton={phase.kind !== 'creating'}
      >
        <DialogHeader>
          <DialogTitle>
            {phase.kind === 'done' ? t('resultTitle') : t('title')}
          </DialogTitle>
          {phase.kind === 'form' && (
            <DialogDescription>
              {t('stepOf', { step: step + 1, total: WIZARD_STEPS.length })}
              {' · '}
              {t(`steps.${stepKey}`)}
            </DialogDescription>
          )}
        </DialogHeader>

        {phase.kind === 'creating' ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <Loader2
              className="text-wa-green size-8 animate-spin"
              aria-hidden
            />
            <p className="font-medium">{t('creating')}</p>
            <p className="text-muted-foreground text-sm">{t('creatingHint')}</p>
          </div>
        ) : phase.kind === 'done' ? (
          <ResultView
            summary={phase.summary}
            onOpen={
              phase.groupId
                ? () => {
                    onOpenChange(false);
                    router.push(`/groups/${phase.groupId}`);
                  }
                : null
            }
            onDone={() => onOpenChange(false)}
          />
        ) : (
          <form
            className="flex min-h-0 flex-1 flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (step < WIZARD_STEPS.length - 1) next();
              else void submit();
            }}
          >
            <div className="-mx-1 min-h-0 flex-1 space-y-4 overflow-y-auto px-1">
              {stepKey === 'basics' && (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="group-number">{t('number')}</Label>
                    {numbers && options.length === 0 ? (
                      <p className="text-muted-foreground text-sm">
                        {t('noNumbers')}
                      </p>
                    ) : (
                      <select
                        id="group-number"
                        className="border-input bg-background h-9 w-full rounded-lg border px-2 text-sm"
                        value={channelId ?? ''}
                        onChange={(e) => set('channelId', e.target.value)}
                      >
                        {options.map((n) => (
                          <option key={n.id} value={n.id}>
                            {[n.label, n.waba_id].filter(Boolean).join(' · ') ||
                              n.phone_number_id}
                            {n.status !== 'connected'
                              ? ` (${t('disconnected')})`
                              : ''}
                          </option>
                        ))}
                      </select>
                    )}
                    <p className="text-muted-foreground text-xs">
                      {t('numberHint')}
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <Label htmlFor="group-name">{t('name')}</Label>
                      <span
                        className={cn(
                          'text-xs tabular-nums',
                          nameLength(values.name) > GROUP_NAME_MAX
                            ? 'text-destructive'
                            : 'text-muted-foreground'
                        )}
                      >
                        {t('nameCounter', {
                          count: nameLength(values.name),
                          max: GROUP_NAME_MAX,
                        })}
                      </span>
                    </div>
                    <Input
                      id="group-name"
                      value={values.name}
                      placeholder={t('namePlaceholder')}
                      onChange={(e) => set('name', e.target.value)}
                      autoFocus
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="group-description">
                      {t('description')}
                    </Label>
                    <Textarea
                      id="group-description"
                      rows={2}
                      maxLength={GROUP_DESCRIPTION_MAX}
                      value={values.description}
                      placeholder={t('descriptionPlaceholder')}
                      onChange={(e) => set('description', e.target.value)}
                    />
                  </div>
                </>
              )}

              {stepKey === 'members' && (
                <MembersStep
                  accountId={accountId}
                  values={values}
                  set={set}
                  merged={merged}
                  typedInvalid={typed.filter((x) => !x.waId)}
                />
              )}

              {stepKey === 'settings' && (
                <>
                  {GROUP_SETTINGS.map((key) => (
                    <div
                      key={key}
                      className="flex items-start justify-between gap-3"
                    >
                      <div>
                        <Label htmlFor={`group-${key}`}>
                          {t(`toggles.${key}`)}
                        </Label>
                        <p className="text-muted-foreground text-xs">
                          {t(`toggleHints.${key}`)}
                        </p>
                      </div>
                      <Switch
                        id={`group-${key}`}
                        checked={values.toggles[key]}
                        onCheckedChange={(v) =>
                          set('toggles', { ...values.toggles, [key]: !!v })
                        }
                      />
                    </div>
                  ))}
                  <ManagersPicker
                    staff={staff
                      .filter(
                        (p) =>
                          p.user_id !== user?.id &&
                          !!p.account_role &&
                          hasMinRole(p.account_role, 'agent')
                      )
                      .map((p) => ({
                        id: p.user_id,
                        name: p.full_name || p.email,
                      }))}
                    selected={values.managerIds}
                    onChange={(ids) => set('managerIds', ids)}
                  />
                </>
              )}
            </div>

            {error && (
              <p className="text-destructive text-sm" role="alert">
                {errorText(error)}
              </p>
            )}

            <DialogFooter>
              {step === 0 ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                >
                  {t('cancel')}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setError(null);
                    setStep((s) => s - 1);
                  }}
                >
                  {t('back')}
                </Button>
              )}
              <Button
                type="submit"
                disabled={stepKey === 'basics' && options.length === 0}
              >
                {step < WIZARD_STEPS.length - 1 ? t('next') : t('submit')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MembersStep({
  accountId,
  values,
  set,
  merged,
  typedInvalid,
}: {
  accountId: string | null;
  values: WizardValues;
  set: <K extends keyof WizardValues>(k: K, v: WizardValues[K]) => void;
  merged: ReturnType<typeof mergeMembers>;
  typedInvalid: { input: string }[];
}) {
  const t = useTranslations('Groups.create');
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<PickedContact[] | null>(null);
  const filter = contactSearchFilter(search);

  useEffect(() => {
    if (!filter || !accountId) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const { data } = await createClient()
        .from('contacts')
        .select('id, name, phone')
        .eq('account_id', accountId)
        .or(filter)
        .order('name')
        .limit(20);
      if (!cancelled) setHits((data ?? []) as PickedContact[]);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setHits(null);
    };
  }, [filter, accountId]);

  const picked = new Set(values.contacts.map((c) => c.id));
  const count = merged.members.length;
  const over = count > GROUP_MEMBERS_PER_OPERATION;

  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor="group-contact-search">{t('contactsLabel')}</Label>
        {values.contacts.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {values.contacts.map((c) => {
              const name = c.name || c.phone || c.id;
              return (
                <li
                  key={c.id}
                  className="bg-muted flex max-w-full items-center gap-1 rounded-full py-0.5 pr-1 pl-2.5 text-xs"
                >
                  <span className="max-w-40 truncate">{name}</span>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground rounded-full p-0.5"
                    aria-label={t('removeMember', { name })}
                    onClick={() =>
                      set(
                        'contacts',
                        values.contacts.filter((x) => x.id !== c.id)
                      )
                    }
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <Input
          id="group-contact-search"
          type="search"
          value={search}
          placeholder={t('contactsSearch')}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
        />
        {search.trim() && (
          <ul className="border-border max-h-44 overflow-y-auto rounded-lg border">
            {!filter ? (
              <li className="text-muted-foreground px-3 py-2 text-xs">
                {t('contactsTypeMore')}
              </li>
            ) : hits === null ? (
              <li className="text-muted-foreground px-3 py-2 text-xs">
                {t('contactsSearching')}
              </li>
            ) : hits.length === 0 ? (
              <li className="text-muted-foreground px-3 py-2 text-xs">
                {t('contactsNone')}
              </li>
            ) : (
              hits.map((c) => (
                <li key={c.id}>
                  <label className="hover:bg-muted flex cursor-pointer items-center gap-2 px-3 py-1.5">
                    <Checkbox
                      checked={picked.has(c.id)}
                      onCheckedChange={(v) =>
                        set(
                          'contacts',
                          v
                            ? [...values.contacts, c]
                            : values.contacts.filter((x) => x.id !== c.id)
                        )
                      }
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {c.name || c.phone}
                      {c.name && c.phone && (
                        <span className="text-muted-foreground ml-1.5 text-xs">
                          {c.phone}
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              ))
            )}
          </ul>
        )}
        {merged.unusableContacts.map((c) => (
          <p
            key={c.id}
            className="text-xs text-amber-700 [[data-mode=dark]_&]:text-amber-300"
          >
            {t('noPhone', { name: c.name || c.id })}
          </p>
        ))}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="group-phones">{t('phonesLabel')}</Label>
        <Textarea
          id="group-phones"
          rows={3}
          value={values.typedText}
          placeholder={t('phonesPlaceholder')}
          onChange={(e) => set('typedText', e.target.value)}
        />
        <p className="text-muted-foreground text-xs">{t('phonesHint')}</p>
        {typedInvalid.map((x) => (
          <p key={x.input} className="text-destructive text-xs">
            {t('invalidNumber', { input: x.input })}
          </p>
        ))}
      </div>

      <div
        className={cn(
          'space-y-1 rounded-lg border p-3 text-xs',
          over
            ? 'border-amber-300 bg-amber-50 text-amber-900 [[data-mode=dark]_&]:border-amber-900 [[data-mode=dark]_&]:bg-amber-950 [[data-mode=dark]_&]:text-amber-200'
            : 'border-border bg-muted/40 text-muted-foreground'
        )}
      >
        <p className="text-foreground font-medium tabular-nums">
          {t('memberCount', { count, max: GROUP_MEMBERS_PER_OPERATION })}
        </p>
        {over && <p>{t('overCap', { max: GROUP_MEMBERS_PER_OPERATION })}</p>}
        <p>{t('pacingNote', { batch: GROUP_ADD_BATCH })}</p>
      </div>
    </>
  );
}

function ManagersPicker({
  staff,
  selected,
  onChange,
}: {
  staff: { id: string; name: string }[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const t = useTranslations('Groups.create');
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();
  const shown = staff.filter((p) => !q || p.name.toLowerCase().includes(q));
  return (
    <div className="space-y-1.5">
      <Label htmlFor="group-manager-search">{t('managers')}</Label>
      <p className="text-muted-foreground text-xs">{t('managersHint')}</p>
      <Input
        id="group-manager-search"
        type="search"
        value={search}
        placeholder={t('managersSearch')}
        onChange={(e) => setSearch(e.target.value)}
      />
      <ul className="border-border max-h-40 overflow-y-auto rounded-lg border">
        {shown.length === 0 ? (
          <li className="text-muted-foreground px-3 py-2 text-xs">
            {t('managersNone')}
          </li>
        ) : (
          shown.map((p) => (
            <li key={p.id}>
              <label className="hover:bg-muted flex cursor-pointer items-center gap-2 px-3 py-1.5">
                <Checkbox
                  checked={selected.includes(p.id)}
                  onCheckedChange={(v) =>
                    onChange(
                      v
                        ? [...selected, p.id]
                        : selected.filter((id) => id !== p.id)
                    )
                  }
                />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
              </label>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

function ResultView({
  summary,
  onOpen,
  onDone,
}: {
  summary: ResultSummary;
  onOpen: (() => void) | null;
  onDone: () => void;
}) {
  const t = useTranslations('Groups.create');
  const label = (p: ResultPerson) =>
    p.name ? `${p.name} (${formatWaId(p.waId)})` : formatWaId(p.waId);
  const pending = [
    ...summary.refused.map((p) => label(p)),
    ...summary.notAttempted.map(
      (p) => `${label(p)} · ${t('resultNotAttempted')}`
    ),
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="-mx-1 min-h-0 flex-1 space-y-4 overflow-y-auto px-1 text-sm">
        {summary.added.length === 0 ? (
          <p className="text-muted-foreground">{t('resultNone')}</p>
        ) : (
          <section className="space-y-1">
            <h3 className="text-wa-green flex items-center gap-1.5 font-semibold">
              <CheckCircle2 className="size-4" aria-hidden />
              {t('resultAdded', { count: summary.added.length })}
            </h3>
            <ul className="text-muted-foreground space-y-0.5">
              {summary.added.map((p) => (
                <li key={p.waId} className="truncate">
                  {label(p)}
                </li>
              ))}
            </ul>
          </section>
        )}
        {pending.length > 0 && (
          <section className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900 [[data-mode=dark]_&]:border-amber-900 [[data-mode=dark]_&]:bg-amber-950 [[data-mode=dark]_&]:text-amber-200">
            <h3 className="font-semibold">
              {t('resultRefused', { count: pending.length })}
            </h3>
            <ul className="space-y-0.5">
              {pending.map((s) => (
                <li key={s} className="truncate">
                  {s}
                </li>
              ))}
            </ul>
            <p className="text-xs">{t('resultInviteNote')}</p>
          </section>
        )}
        {summary.invalid.length > 0 && (
          <section className="text-destructive space-y-1">
            <h3 className="font-semibold">
              {t('resultInvalid', { count: summary.invalid.length })}
            </h3>
            <ul className="space-y-0.5">
              {summary.invalid.map((p) => (
                <li key={p.waId} className="truncate">
                  {label(p)}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          {t('done')}
        </Button>
        {onOpen && (
          <Button type="button" onClick={onOpen}>
            {t('openGroup')}
          </Button>
        )}
      </DialogFooter>
    </div>
  );
}
