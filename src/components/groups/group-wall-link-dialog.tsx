'use client';

import { useEffect, useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { DeskSelect } from '@/components/desk/desk-select';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import type { GroupLink } from '@/lib/desk/group-intake-store';
import type { DeskBank } from '@/lib/desk/store';

const REFUSALS = [
  'NOT_ALLOWED',
  'GROUP_NOT_FOUND',
  'BANK_NOT_FOUND',
  'INVALID',
] as const;

type Banks = { list: DeskBank[]; failed: boolean } | null;

async function fetchBanks(): Promise<DeskBank[]> {
  const res = await fetch('/api/desk/banks', { cache: 'no-store' });
  if (!res.ok) throw new Error(String(res.status));
  return ((await res.json()) as { banks: DeskBank[] }).banks;
}

/**
 * Link a wall group to a bank (team leaders and up; the SQL decides).
 * Mounted only while open, keyed by the group, so it starts from the
 * stored link each time. Replies stay off until filing is on.
 */
export function GroupWallLinkDialog({
  group,
  link,
  onClose,
  onSaved,
}: {
  group: { id: string; name: string };
  link: GroupLink | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('GroupWall.desk.dialog');
  const id = useId();
  const [banks, setBanks] = useState<Banks>(null);
  const [bank, setBank] = useState(link?.bankCode ?? '');
  const [intake, setIntake] = useState(link?.intakeEnabled ?? false);
  const [replies, setReplies] = useState(link?.repliesEnabled ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchBanks().then(
      (list) => {
        if (!cancelled) setBanks({ list, failed: false });
      },
      () => {
        if (!cancelled) setBanks({ list: [], failed: true });
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const linked = bank !== '';

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/desk/group-links', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          groupId: group.id,
          bankCode: linked ? bank : null,
          intakeEnabled: linked && intake,
          repliesEnabled: linked && intake && replies,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          code?: unknown;
        };
        const code = (REFUSALS as readonly unknown[]).includes(body.code)
          ? (body.code as string)
          : 'other';
        setError(t(`refusals.${code}`));
        return;
      }
      toast.success(t('saved'));
      onSaved();
      onClose();
    } catch {
      setError(t('refusals.other'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title', { group: group.name })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor={`${id}-bank`} className="text-sm font-medium">
              {t('bank')}
            </label>
            <DeskSelect
              id={`${id}-bank`}
              value={bank}
              onChange={setBank}
              options={(banks?.list ?? []).map((b) => ({
                value: b.bankCode,
                label: b.shortCode
                  ? `${b.bankName} (${b.shortCode})`
                  : b.bankName,
              }))}
              placeholder={t('bankPlaceholder')}
              noneLabel={t('noBank')}
              disabled={busy || !banks}
            />
            {banks?.failed && (
              <p className="text-destructive text-xs">{t('banksFailed')}</p>
            )}
          </div>
          <SwitchRow
            id={`${id}-intake`}
            label={t('intake')}
            help={t('intakeHelp')}
            checked={linked && intake}
            disabled={busy || !linked}
            onChange={(on) => {
              setIntake(on);
              if (!on) setReplies(false);
            }}
          />
          <SwitchRow
            id={`${id}-replies`}
            label={t('replies')}
            help={t('repliesHelp')}
            checked={linked && intake && replies}
            disabled={busy || !linked || !intake}
            onChange={setReplies}
          />
          <p className="text-muted-foreground text-xs">{t('whapiHelp')}</p>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t('cancel')}
          </Button>
          <Button onClick={() => void save()} disabled={busy || !banks}>
            {busy ? t('saving') : t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SwitchRow({
  id,
  label,
  help,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  help: string;
  checked: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p id={`${id}-label`} className="text-sm font-medium">
          {label}
        </p>
        <p id={`${id}-help`} className="text-muted-foreground text-xs">
          {help}
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
