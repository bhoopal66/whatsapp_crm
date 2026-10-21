'use client';

// ============================================================
// "Create a workspace" (migration 083), opened from the rail's "+".
//
// POST /api/workspaces creates the workspace, makes the caller its
// owner, SWITCHES them into it and adds each invite there. So once it
// answers 201 the app on screen belongs to the old workspace: the only
// way out is a hard navigation into the new one (Continue, or closing
// the dialog), never back to the stale screen.
//
// An invite whose email has no login comes back failed with the API's
// "no login" sentence; the results step offers a "Create a login" form
// for it, which calls POST /api/account/members — the caller is already
// active in the new workspace, so that is where the person lands.
// ============================================================

import { useId, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Loader2, Plus, RefreshCw, X } from 'lucide-react';

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
import { ADDABLE_ROLES, type AddableRole } from '@/lib/account/add-member';
import { clearClientCache } from '@/lib/client-cache';
import { cn } from '@/lib/utils';
import {
  MAX_INVITES,
  MIN_PASSWORD_LENGTH,
  NUMBER_CHOICES,
  afterCreatePath,
  inviteRowsToPayload,
  isNoLoginError,
  shortNameError,
  suggestPassword,
  suggestShortName,
  validateInviteRows,
  workspaceNameError,
  type InvitePayload,
  type InviteRow,
  type NumberChoice,
} from '@/lib/workspaces/form';

interface CreateWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The workspace exists but could not be opened: reload the rail. */
  onCreatedElsewhere?: () => void;
}

interface InviteOutcome {
  invite: InvitePayload;
  ok: boolean;
  error?: string;
  /** The "Create a login" form, for an email with no login. */
  fullName: string;
  password: string;
  saving: boolean;
  loginError?: string;
  loginCreated?: boolean;
}

const NUMBER_LABEL_KEY: Record<NumberChoice, string> = {
  meta: 'numberMeta',
  whapi: 'numberWhapi',
  skip: 'numberSkip',
};

let rowSeq = 0;
function blankRow(): InviteRow {
  rowSeq += 1;
  return { id: `row-${rowSeq}`, email: '', role: 'agent', bankCode: '' };
}

/** Leave this tab's caches behind and load the new workspace. */
function enterNewWorkspace(choice: NumberChoice) {
  clearClientCache();
  window.location.assign(afterCreatePath(choice));
}

export function CreateWorkspaceDialog({
  open,
  onOpenChange,
  onCreatedElsewhere,
}: CreateWorkspaceDialogProps) {
  const t = useTranslations('Workspaces.create');
  const tRoles = useTranslations('Settings.roles');
  const fieldId = useId();

  const [name, setName] = useState('');
  const [shortName, setShortName] = useState('');
  const [shortNameEdited, setShortNameEdited] = useState(false);
  const [number, setNumber] = useState<NumberChoice>('skip');
  const [rows, setRows] = useState<InviteRow[]>(() => [blankRow()]);
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ name: string } | null>(null);
  const [outcomes, setOutcomes] = useState<InviteOutcome[]>([]);
  const [leaving, setLeaving] = useState(false);

  const nameError = workspaceNameError(name);
  const shortError = shortNameError(shortName);
  const invites = useMemo(() => validateInviteRows(rows), [rows]);
  const canSubmit = !nameError && !shortError && invites.ok && !submitting;

  function reset() {
    setName('');
    setShortName('');
    setShortNameEdited(false);
    setNumber('skip');
    setRows([blankRow()]);
    setAttempted(false);
    setSubmitting(false);
    setFormError(null);
    setCreated(null);
    setOutcomes([]);
    setLeaving(false);
  }

  function leave() {
    setLeaving(true);
    enterNewWorkspace(number);
  }

  function handleOpenChange(next: boolean) {
    if (next) return onOpenChange(true);
    // The caller is already active in the new workspace: closing must
    // load it, not return to the old workspace's screen.
    if (created) return leave();
    if (submitting) return;
    reset();
    onOpenChange(false);
  }

  function updateRow(id: string, patch: Partial<InviteRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function handleCreate() {
    setAttempted(true);
    setFormError(null);
    if (!canSubmit) return;
    const payload = inviteRowsToPayload(rows);
    setSubmitting(true);
    try {
      const res = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          shortName: shortName.trim(),
          invites: payload,
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        accountId?: string;
        invites?: { email: string; ok: boolean; error?: string }[];
      } | null;
      if (!res.ok) {
        setFormError(body?.error || t('failed'));
        // Created but not opened: its tile belongs on the rail anyway.
        if (body?.accountId) onCreatedElsewhere?.();
        return;
      }
      const results = body?.invites ?? [];
      if (results.length === 0) {
        setCreated({ name: name.trim() });
        leave();
        return;
      }
      // The API answers the invites in the order they were sent.
      setOutcomes(
        payload.map((invite, i) => ({
          invite,
          ok: results[i]?.ok === true,
          error: results[i]?.error,
          fullName: '',
          password: suggestPassword(),
          saving: false,
        }))
      );
      setCreated({ name: name.trim() });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('failed'));
    } finally {
      setSubmitting(false);
    }
  }

  function updateOutcome(index: number, patch: Partial<InviteOutcome>) {
    setOutcomes((prev) =>
      prev.map((o, i) => (i === index ? { ...o, ...patch } : o))
    );
  }

  async function createLogin(index: number) {
    const outcome = outcomes[index];
    if (!outcome || outcome.password.length < MIN_PASSWORD_LENGTH) return;
    updateOutcome(index, { saving: true, loginError: undefined });
    try {
      const res = await fetch('/api/account/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: outcome.invite.email,
          role: outcome.invite.role,
          bankCode: outcome.invite.bankCode,
          full_name: outcome.fullName.trim(),
          password: outcome.password,
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok) {
        updateOutcome(index, {
          saving: false,
          loginError: body?.error || t('loginFailed'),
        });
        return;
      }
      updateOutcome(index, { saving: false, ok: true, loginCreated: true });
    } catch (err) {
      updateOutcome(index, {
        saving: false,
        loginError: err instanceof Error ? err.message : t('loginFailed'),
      });
    }
  }

  const roleCards = [
    { title: t('cardAdminTitle'), body: t('cardAdminBody'), guest: false },
    // A team leader has no settings (099: adds agents and viewers only).
    { title: t('cardLeaderTitle'), body: t('cardLeaderBody'), guest: false },
    { title: t('cardAgentTitle'), body: t('cardAgentBody'), guest: false },
    { title: t('cardGuestTitle'), body: t('cardGuestBody'), guest: true },
  ];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className={cn(
          'border-border bg-popover text-popover-foreground',
          // Mobile: a full-screen sheet. sm+: a wide centred dialog.
          'top-0 left-0 h-dvh max-w-full translate-x-0 translate-y-0 content-start gap-5 overflow-y-auto rounded-none p-4',
          'sm:top-1/2 sm:left-1/2 sm:h-auto sm:max-h-[90dvh] sm:max-w-[960px] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:p-6'
        )}
      >
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle className="text-popover-foreground text-lg">
                {t('resultsTitle')}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {t('resultsDescription', { name: created.name })}
              </DialogDescription>
            </DialogHeader>

            <ul className="divide-border border-border divide-y rounded-lg border">
              {outcomes.map((o, i) => {
                const needsLogin =
                  !o.ok && !o.loginCreated && isNoLoginError(o.error);
                return (
                  <li key={o.invite.email} className="space-y-3 px-4 py-3">
                    <div className="flex items-center gap-3">
                      {o.ok ? (
                        <Check className="text-wa-teal size-4 shrink-0" />
                      ) : (
                        <X className="text-destructive size-4 shrink-0" />
                      )}
                      <span className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">
                        {o.invite.email}
                      </span>
                      <span className="text-muted-foreground shrink-0 text-xs">
                        {tRoles(o.invite.role)}
                      </span>
                    </div>
                    {o.ok ? (
                      <p className="text-muted-foreground pl-7 text-xs">
                        {o.loginCreated ? t('loginCreated') : t('inviteAdded')}
                      </p>
                    ) : needsLogin ? (
                      <div className="bg-muted/50 space-y-3 rounded-lg p-3 sm:ml-7">
                        <p className="text-muted-foreground text-xs">
                          {t('noLoginHint')}
                        </p>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="space-y-1.5">
                            <Label
                              htmlFor={`${fieldId}-name-${i}`}
                              className="text-muted-foreground text-xs"
                            >
                              {t('fullNameLabel')}
                            </Label>
                            <Input
                              id={`${fieldId}-name-${i}`}
                              value={o.fullName}
                              placeholder={t('fullNamePlaceholder')}
                              onChange={(e) =>
                                updateOutcome(i, { fullName: e.target.value })
                              }
                              className="bg-background border-border"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label
                              htmlFor={`${fieldId}-pw-${i}`}
                              className="text-muted-foreground text-xs"
                            >
                              {t('passwordLabel')}
                            </Label>
                            <div className="flex gap-2">
                              <Input
                                id={`${fieldId}-pw-${i}`}
                                value={o.password}
                                onChange={(e) =>
                                  updateOutcome(i, { password: e.target.value })
                                }
                                className="bg-background border-border font-mono"
                              />
                              <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                title={t('regenerate')}
                                aria-label={t('regenerate')}
                                onClick={() =>
                                  updateOutcome(i, {
                                    password: suggestPassword(),
                                  })
                                }
                                className="border-border shrink-0"
                              >
                                <RefreshCw className="size-4" />
                              </Button>
                            </div>
                          </div>
                        </div>
                        <p className="text-muted-foreground text-xs">
                          {t('passwordHint', { min: MIN_PASSWORD_LENGTH })}
                        </p>
                        {o.loginError ? (
                          <p className="text-destructive text-xs">
                            {o.loginError}
                          </p>
                        ) : null}
                        <Button
                          size="sm"
                          onClick={() => createLogin(i)}
                          disabled={
                            o.saving || o.password.length < MIN_PASSWORD_LENGTH
                          }
                          className="bg-wa-green text-wa-green-fg hover:bg-wa-green/90"
                        >
                          {o.saving ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : null}
                          {t('createLogin')}
                        </Button>
                      </div>
                    ) : (
                      <p className="text-destructive pl-7 text-xs">
                        {o.error || t('inviteFailed')}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>

            <DialogFooter>
              <Button
                onClick={leave}
                disabled={leaving}
                className="bg-wa-green text-wa-green-fg hover:bg-wa-green/90"
              >
                {leaving ? <Loader2 className="size-4 animate-spin" /> : null}
                {t('continue')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader className="pr-8">
              <DialogTitle className="text-popover-foreground text-lg">
                {t('title')}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {t('description')}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
              <div className="space-y-1.5">
                <Label htmlFor={`${fieldId}-ws-name`}>{t('nameLabel')}</Label>
                <Input
                  id={`${fieldId}-ws-name`}
                  value={name}
                  autoFocus
                  maxLength={120}
                  placeholder={t('namePlaceholder')}
                  aria-invalid={attempted && !!nameError}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (!shortNameEdited) {
                      setShortName(suggestShortName(e.target.value));
                    }
                  }}
                  className="bg-muted border-border"
                />
                {attempted && nameError ? (
                  <p className="text-destructive text-xs">
                    {t(`errors.${nameError}`)}
                  </p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${fieldId}-ws-short`}>
                  {t('shortNameLabel')}
                </Label>
                <Input
                  id={`${fieldId}-ws-short`}
                  value={shortName}
                  maxLength={4}
                  aria-invalid={attempted && !!shortError}
                  onChange={(e) => {
                    setShortNameEdited(true);
                    setShortName(e.target.value.toUpperCase());
                  }}
                  className="bg-muted border-border font-semibold tracking-wider"
                />
                <p
                  className={cn(
                    'text-xs',
                    attempted && shortError
                      ? 'text-destructive'
                      : 'text-muted-foreground'
                  )}
                >
                  {attempted && shortError
                    ? t(`errors.${shortError}`)
                    : t('shortNameHint')}
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>{t('numberLabel')}</Label>
              <Select
                value={number}
                onValueChange={(v) => v && setNumber(v as NumberChoice)}
              >
                <SelectTrigger className="bg-muted border-border w-full">
                  <SelectValue>{t(NUMBER_LABEL_KEY[number])}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {NUMBER_CHOICES.map((choice) => (
                    <SelectItem key={choice} value={choice}>
                      {t(NUMBER_LABEL_KEY[choice])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">{t('numberHint')}</p>
            </div>

            <section className="space-y-3">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-foreground text-sm font-semibold">
                  {t('inviteHeading')}
                </h3>
                <span className="text-muted-foreground text-xs">
                  {t('youAreOwner')}
                </span>
              </div>

              <ul className="space-y-2">
                {rows.map((row) => {
                  const rowError = attempted
                    ? invites.rowErrors[row.id]
                    : undefined;
                  return (
                    <li key={row.id} className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                        <Input
                          type="email"
                          value={row.email}
                          placeholder={t('emailPlaceholder')}
                          aria-label={t('emailLabel')}
                          aria-invalid={
                            rowError === 'email' || rowError === 'duplicate'
                          }
                          onChange={(e) =>
                            updateRow(row.id, { email: e.target.value })
                          }
                          className="bg-muted border-border min-w-0 flex-1 basis-full sm:basis-auto"
                        />
                        <Select
                          value={row.role}
                          onValueChange={(v) =>
                            v && updateRow(row.id, { role: v as AddableRole })
                          }
                        >
                          <SelectTrigger
                            aria-label={t('roleLabel')}
                            className="bg-muted border-border w-36 shrink-0"
                          >
                            <SelectValue>{tRoles(row.role)}</SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {ADDABLE_ROLES.map((r) => (
                              <SelectItem key={r} value={r}>
                                {tRoles(r)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {row.role === 'bank_guest' ? (
                          <Input
                            value={row.bankCode}
                            placeholder={t('bankCodePlaceholder')}
                            aria-label={t('bankCodePlaceholder')}
                            aria-invalid={rowError === 'bankCode'}
                            onChange={(e) =>
                              updateRow(row.id, { bankCode: e.target.value })
                            }
                            className="bg-muted border-border w-40 min-w-0 flex-1 sm:flex-none"
                          />
                        ) : null}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={t('removeRow')}
                          title={t('removeRow')}
                          onClick={() =>
                            setRows((prev) =>
                              prev.length === 1
                                ? [blankRow()]
                                : prev.filter((r) => r.id !== row.id)
                            )
                          }
                          className="text-muted-foreground shrink-0"
                        >
                          <X className="size-4" />
                        </Button>
                      </div>
                      {rowError ? (
                        <p className="text-destructive text-xs">
                          {t(`errors.${rowError}`)}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {attempted && invites.tooMany ? (
                <p className="text-destructive text-xs">
                  {t('errors.tooMany', { max: MAX_INVITES })}
                </p>
              ) : null}
              <button
                type="button"
                onClick={() => setRows((prev) => [...prev, blankRow()])}
                className="text-wa-teal inline-flex items-center gap-1 text-sm font-medium hover:underline"
              >
                <Plus className="size-4" />
                {t('addAnother')}
              </button>

              <div className="grid gap-3 sm:grid-cols-2">
                {roleCards.map((card) => (
                  <div
                    key={card.title}
                    className={cn(
                      'rounded-lg border p-3',
                      card.guest
                        ? 'border-primary/30 bg-primary-soft'
                        : 'border-border bg-muted/40'
                    )}
                  >
                    <p
                      className={cn(
                        'text-sm font-semibold',
                        card.guest ? 'text-primary' : 'text-foreground'
                      )}
                    >
                      {card.title}
                    </p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {card.body}
                    </p>
                  </div>
                ))}
              </div>
            </section>

            {formError ? (
              <p
                role="alert"
                className="border-destructive/30 bg-destructive-soft text-destructive rounded-lg border px-3 py-2 text-sm"
              >
                {formError}
              </p>
            ) : null}

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={submitting}
              >
                {t('cancel')}
              </Button>
              <Button
                onClick={handleCreate}
                disabled={submitting || (attempted && !canSubmit)}
                className="bg-wa-green text-wa-green-fg hover:bg-wa-green/90"
              >
                {submitting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                {submitting ? t('creating') : t('submit')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
