'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

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
import { Textarea } from '@/components/ui/textarea';
import {
  allowedNextStages,
  caseLocks,
  detailsErrorKey,
  fromLocalInput,
  groupEndView,
  isFinalStage,
  needsOutcomeReason,
  normaliseAmount,
  outcomeReasonCodes,
  OUTCOME_REASON_TEXT_MAX,
  reasonErrorKey,
  reassignErrorKey,
  stageErrorKey,
  stageMoveBody,
  toLocalInput,
  type CaseDetail,
  type GroupEndView,
  type OutcomeReasonCode,
} from '@/lib/cases/case-page';
import { PRIORITIES, type CasePriority } from '@/lib/cases/types';
import type { Profile } from '@/types';

type ErrBody = { error?: string; code?: string } | null;

/** POST/PATCH JSON; answers the status and the parsed body (or null). */
async function send(
  url: string,
  method: 'POST' | 'PATCH',
  body?: unknown
): Promise<{ status: number; ok: boolean; json: unknown }> {
  try {
    const res = await fetch(url, {
      method,
      headers:
        body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: res.status,
      ok: res.ok,
      json: await res.json().catch(() => null),
    };
  } catch {
    return { status: 0, ok: false, json: null };
  }
}
export { send as sendCaseRequest };

const codeOf = (json: unknown) => (json as ErrBody)?.code;

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: CaseDetail;
  onChanged: () => void;
}

// ---------------------------------------------------------------- Move stage

type MoveStep = 'pick' | 'reason' | 'done';

export function MoveStageDialog({
  open,
  onOpenChange,
  detail,
  onChanged,
}: DialogProps) {
  const t = useTranslations('CasePage');
  const c = detail.case;
  const [step, setStep] = useState<MoveStep>('pick');
  const [stage, setStage] = useState('');
  const [busy, setBusy] = useState(false);
  const [group, setGroup] = useState<GroupEndView | null>(null);
  const [moved, setMoved] = useState('');
  const [code, setCode] = useState<OutcomeReasonCode | ''>('');
  const [text, setText] = useState('');

  const choices = allowedNextStages(c, detail.stages);
  const locks = caseLocks(detail);

  const move = async () => {
    if (!stage) return;
    setBusy(true);
    const r = await send(
      `/api/cases/${c.id}/stage`,
      'POST',
      stageMoveBody(stage)
    );
    setBusy(false);
    if (!r.ok) {
      toast.error(t(`errors.${stageErrorKey(r.status, codeOf(r.json))}`));
      return;
    }
    onChanged();
    const res = r.json as { toStage?: string; groupEnd?: unknown } | null;
    const to = res?.toStage ?? stage;
    toast.success(t('move.done', { stage: to }));
    setMoved(to);
    setGroup(isFinalStage(to) ? groupEndView(res?.groupEnd) : null);
    if (needsOutcomeReason(to)) setStep('reason');
    else if (isFinalStage(to)) setStep('done');
    else onOpenChange(false);
  };

  const saveReason = async () => {
    if (!code) return;
    setBusy(true);
    const r = await send(`/api/cases/${c.id}/outcome-reason`, 'POST', {
      code,
      ...(text.trim() ? { text: text.trim() } : {}),
    });
    setBusy(false);
    if (!r.ok) {
      toast.error(t(`errors.${reasonErrorKey(r.status, codeOf(r.json))}`));
      return;
    }
    toast.success(t('move.reasonSaved'));
    onChanged();
    onOpenChange(false);
  };

  const groupLine = group && (
    <p
      role="status"
      className={
        group === 'failed'
          ? 'border-destructive/30 bg-destructive-soft text-destructive rounded-lg border px-3 py-2 text-sm'
          : 'bg-muted text-muted-foreground rounded-lg px-3 py-2 text-sm'
      }
    >
      {t(`move.group.${group}`)}
    </p>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {step === 'pick'
              ? t('move.title')
              : t('move.movedTitle', { stage: moved })}
          </DialogTitle>
          <DialogDescription>
            {step === 'pick'
              ? t('move.body', { stage: c.stage })
              : step === 'reason'
                ? t('move.reasonBody')
                : t('move.doneBody')}
          </DialogDescription>
        </DialogHeader>

        {step === 'pick' && (
          <div className="space-y-2">
            <Label htmlFor="case-move-stage">{t('move.stage')}</Label>
            <Select
              value={stage}
              onValueChange={(v) => setStage(String(v ?? ''))}
            >
              <SelectTrigger id="case-move-stage" className="w-full">
                <SelectValue>{stage || t('move.pick')}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {choices.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {stage && isFinalStage(stage) && (
              <p className="text-muted-foreground text-xs">
                {t('move.finalHint')}
              </p>
            )}
          </div>
        )}

        {step !== 'pick' && groupLine}

        {step === 'reason' && (
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="case-reason-code">{t('move.reason')}</Label>
              <Select
                value={code}
                onValueChange={(v) =>
                  setCode((v ?? '') as OutcomeReasonCode | '')
                }
              >
                <SelectTrigger id="case-reason-code" className="w-full">
                  <SelectValue>
                    {code ? t(`reasons.${code}`) : t('move.pickReason')}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {outcomeReasonCodes(moved).map((r) => (
                    <SelectItem key={r} value={r}>
                      {t(`reasons.${r}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="case-reason-text">{t('move.reasonText')}</Label>
              <Textarea
                id="case-reason-text"
                value={text}
                maxLength={OUTCOME_REASON_TEXT_MAX}
                onChange={(e) => setText(e.target.value)}
                rows={3}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          {step === 'pick' && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t('cancel')}
              </Button>
              <Button disabled={!stage || busy} onClick={() => void move()}>
                {busy && <Loader2 className="size-4 animate-spin" />}
                {t('move.confirm')}
              </Button>
            </>
          )}
          {step === 'reason' && (
            <>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => onOpenChange(false)}
              >
                {t('move.later')}
              </Button>
              <Button
                disabled={!code || busy || locks.outcomeReason}
                onClick={() => void saveReason()}
              >
                {busy && <Loader2 className="size-4 animate-spin" />}
                {t('move.saveReason')}
              </Button>
            </>
          )}
          {step === 'done' && (
            <Button onClick={() => onOpenChange(false)}>{t('close')}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// -------------------------------------------------------------- Edit details

interface Bank {
  code: string;
  name: string;
}

export function EditDetailsDialog({
  open,
  onOpenChange,
  detail,
  onChanged,
}: DialogProps) {
  const t = useTranslations('CasePage');
  const c = detail.case;
  const [banks, setBanks] = useState<Bank[] | null>(null);
  const [bank, setBank] = useState(c.bankCode ?? '');
  const [product, setProduct] = useState(c.product ?? '');
  const [amount, setAmount] = useState(c.amount ?? '');
  const [priority, setPriority] = useState<CasePriority>(c.priority);
  const [due, setDue] = useState(toLocalInput(c.dueAt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 134: Compass owns bank, product and amount; priority and due stay.
  const locked = caseLocks(detail).details;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void fetch('/api/cases/config/banks', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { banks?: Bank[] } | null) => {
        if (!cancelled) setBanks(Array.isArray(j?.banks) ? j.banks : []);
      })
      .catch(() => !cancelled && setBanks([]));
    return () => {
      cancelled = true;
    };
  }, [open]);

  const bankName = (code: string) =>
    banks?.find((b) => b.code === code)?.name ??
    (code === c.bankCode ? c.bankName : null) ??
    code;

  const save = async () => {
    const patch: Record<string, unknown> = {};
    if (!locked && bank && bank !== (c.bankCode ?? '')) patch.bank_code = bank;
    if (!locked && product.trim() && product.trim() !== (c.product ?? ''))
      patch.product = product.trim();
    if (!locked && amount.trim() && amount.trim() !== (c.amount ?? '')) {
      const a = normaliseAmount(amount);
      if (a === null) return setError(t('errors.amountInvalid'));
      if (a !== c.amount) patch.amount = a;
    }
    if (priority !== c.priority) patch.priority = priority;
    const dueIso = fromLocalInput(due);
    if (due && dueIso === null) return setError(t('errors.dueInvalid'));
    if (dueIso !== (c.dueAt ? new Date(c.dueAt).toISOString() : null))
      patch.due_at = dueIso;
    if (Object.keys(patch).length === 0) return onOpenChange(false);

    setBusy(true);
    setError(null);
    const r = await send(`/api/cases/${c.id}`, 'PATCH', patch);
    setBusy(false);
    if (!r.ok) {
      // Fields are applied one by one; a refusal may follow a saved change.
      onChanged();
      return setError(t(`errors.${detailsErrorKey(r.status, codeOf(r.json))}`));
    }
    toast.success(t('edit.saved'));
    onChanged();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('edit.title')}</DialogTitle>
          <DialogDescription>{t('edit.body')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="case-bank">{t('fields.bank_code')}</Label>
            <Select
              value={bank}
              onValueChange={(v) => setBank(String(v ?? ''))}
            >
              <SelectTrigger
                id="case-bank"
                className="w-full"
                disabled={banks === null || locked}
              >
                <SelectValue>
                  {bank ? bankName(bank) : t('edit.pickBank')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(banks ?? []).map((b) => (
                  <SelectItem key={b.code} value={b.code}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="case-product">{t('fields.product')}</Label>
            <Input
              id="case-product"
              value={product}
              disabled={locked}
              maxLength={200}
              onChange={(e) => setProduct(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="case-amount">{t('edit.amountAed')}</Label>
            <Input
              id="case-amount"
              inputMode="decimal"
              disabled={locked}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          {locked && (
            <p className="text-muted-foreground text-xs sm:col-span-2">
              {t('compass.detailsLocked')}
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="case-priority">{t('fields.priority')}</Label>
            <Select
              value={priority}
              onValueChange={(v) => v && setPriority(v as CasePriority)}
            >
              <SelectTrigger id="case-priority" className="w-full">
                <SelectValue>{t(`priority.${priority}`)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {PRIORITIES.map((p) => (
                  <SelectItem key={p} value={p}>
                    {t(`priority.${p}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="case-due">{t('fields.due_at')}</Label>
            <div className="flex gap-1">
              <Input
                id="case-due"
                type="datetime-local"
                value={due}
                onChange={(e) => setDue(e.target.value)}
              />
              {due && (
                <Button variant="ghost" size="sm" onClick={() => setDue('')}>
                  {t('edit.clearDue')}
                </Button>
              )}
            </div>
          </div>
        </div>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {t('cancel')}
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ Reassign

export function ReassignDialog({
  open,
  onOpenChange,
  detail,
  onChanged,
  members,
}: DialogProps & { members: Profile[] }) {
  const t = useTranslations('CasePage');
  const c = detail.case;
  const [field, setField] = useState<'agent' | 'coordinator'>('agent');
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState(false);

  const current = field === 'agent' ? c.agentId : c.coordinatorId;
  const people = members.filter(
    (m) => !m.deactivated_at && m.user_id !== current
  );
  const nameOf = (id: string) => {
    const m = members.find((p) => p.user_id === id);
    return m ? m.full_name || m.email : id;
  };

  const save = async () => {
    if (!userId) return;
    setBusy(true);
    const r = await send(`/api/cases/${c.id}/reassign`, 'POST', {
      field,
      user_id: userId,
    });
    setBusy(false);
    if (!r.ok) {
      toast.error(t(`errors.${reassignErrorKey(r.status, codeOf(r.json))}`));
      return;
    }
    toast.success(t('reassign.done', { name: nameOf(userId) }));
    onChanged();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('reassign.title')}</DialogTitle>
          <DialogDescription>{t('reassign.body')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="case-reassign-field">{t('reassign.field')}</Label>
            <Select
              value={field}
              onValueChange={(v) => {
                if (v === 'agent' || v === 'coordinator') {
                  setField(v);
                  setUserId('');
                }
              }}
            >
              <SelectTrigger id="case-reassign-field" className="w-full">
                <SelectValue>{t(`roles.${field}`)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="agent">{t('roles.agent')}</SelectItem>
                <SelectItem value="coordinator">
                  {t('roles.coordinator')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="case-reassign-user">{t('reassign.person')}</Label>
            <Select
              value={userId}
              onValueChange={(v) => setUserId(String(v ?? ''))}
            >
              <SelectTrigger id="case-reassign-user" className="w-full">
                <SelectValue>
                  {userId ? nameOf(userId) : t('reassign.pick')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {people.map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>
                    {m.full_name || m.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              {t('reassign.current', {
                name: current ? nameOf(current) : t('nobody'),
              })}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {t('cancel')}
          </Button>
          <Button disabled={!userId || busy} onClick={() => void save()}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {t('reassign.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
