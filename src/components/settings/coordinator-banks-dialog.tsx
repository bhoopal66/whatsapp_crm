'use client';

// Settings -> Members: an admin picks the banks one person coordinates
// (migration 133). Saves through PUT /api/account/members/[userId]/
// coordinator-banks; an empty selection removes the person as a
// coordinator. The RPC decides eligibility again.

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

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
import { invalidateCached } from '@/lib/client-cache';
import { Input } from '@/components/ui/input';
import {
  banksChanged,
  phoneChanged,
  phoneDraftFrom,
  phoneDraftValid,
  toggleBank,
} from '@/lib/coordinators/ui';

interface BankOption {
  code: string;
  name: string;
}

export function CoordinatorBanksDialog({
  member,
  saved,
  savedPhone,
  onOpenChange,
  onSaved,
}: {
  /** The person being edited (`user_id` is the auth user id); null = closed. */
  member: { user_id: string; name: string } | null;
  saved: readonly string[];
  /** Migration 142's number, digits only; null when unset. */
  savedPhone: string | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (userId: string, banks: string[], phone: string | null) => void;
}) {
  const t = useTranslations('Coordinators.members');
  const [banks, setBanks] = useState<BankOption[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [phone, setPhone] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const userId = member?.user_id ?? null;

  // Re-seed the draft each time the dialog opens for a person.
  useEffect(() => {
    if (!userId) return;
    setSelected([...saved]);
    setPhone(phoneDraftFrom(savedPhone));
    setError(null);
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/cases/config/banks', {
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { banks: BankOption[] };
        if (!cancelled) setBanks(data.banks);
      } catch {
        if (!cancelled) {
          setBanks([]);
          setError(t('loadBanksError'));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // `saved` and `savedPhone` are read only to seed the draft when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, t]);

  async function save() {
    if (!member) return;
    setSaving(true);
    setError(null);
    try {
      let nextPhone = savedPhone;
      if (banksChanged(saved, selected)) {
        const res = await fetch(
          `/api/account/members/${member.user_id}/coordinator-banks`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bank_codes: selected }),
          }
        );
        if (!res.ok) {
          const payload = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          setError(payload.error || t('saveError'));
          return;
        }
      }
      if (phoneChanged(savedPhone, phone)) {
        const res = await fetch(
          `/api/account/members/${member.user_id}/coordinator-phone`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: phone.trim() || null }),
          }
        );
        const payload = (await res.json().catch(() => ({}))) as {
          error?: string;
          phone?: string | null;
        };
        if (!res.ok) {
          // The banks may already be saved; reflect that so a retry only
          // resends the number.
          if (banksChanged(saved, selected)) {
            invalidateCached('coordinators:');
            onSaved(member.user_id, selected, savedPhone);
          }
          setError(payload.error || t('saveError'));
          return;
        }
        nextPhone = payload.phone ?? null;
      }
      invalidateCached('coordinators:');
      onSaved(member.user_id, selected, nextPhone);
      onOpenChange(false);
    } catch {
      setError(t('saveError'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={member !== null} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {t('title')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('description', { name: member?.name ?? '' })}
          </DialogDescription>
        </DialogHeader>

        {banks === null ? (
          <div className="flex justify-center py-4">
            <Loader2 className="text-primary size-5 animate-spin" />
          </div>
        ) : banks.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('noBanks')}</p>
        ) : (
          <ul className="max-h-64 space-y-2 overflow-y-auto">
            {banks.map((b) => (
              <li key={b.code}>
                <label className="text-foreground flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox
                    checked={selected.includes(b.code)}
                    onCheckedChange={() =>
                      setSelected((s) => toggleBank(s, b.code))
                    }
                    disabled={saving}
                  />
                  <span className="truncate">{b.name}</span>
                  <span className="text-muted-foreground text-xs">
                    {b.code}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}

        <div className="space-y-1.5">
          <label
            htmlFor="coordinator-phone"
            className="text-foreground text-sm font-medium"
          >
            {t('phoneLabel')}
          </label>
          <Input
            id="coordinator-phone"
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder={t('phonePlaceholder')}
            disabled={saving}
            aria-invalid={!phoneDraftValid(phone)}
          />
          {!phoneDraftValid(phone) ? (
            <p role="alert" className="text-destructive text-xs">
              {t('phoneInvalid')}
            </p>
          ) : (
            <p className="text-muted-foreground text-xs">{t('phoneHelp')}</p>
          )}
        </div>

        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}

        <DialogFooter className="bg-popover border-border">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            {t('cancel')}
          </Button>
          <Button
            onClick={() => void save()}
            disabled={
              saving ||
              banks === null ||
              !phoneDraftValid(phone) ||
              !(
                banksChanged(saved, selected) || phoneChanged(savedPhone, phone)
              )
            }
          >
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('saving')}
              </>
            ) : (
              t('save')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
