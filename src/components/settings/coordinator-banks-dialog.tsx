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
import { banksChanged, toggleBank } from '@/lib/coordinators/ui';

interface BankOption {
  code: string;
  name: string;
}

export function CoordinatorBanksDialog({
  member,
  saved,
  onOpenChange,
  onSaved,
}: {
  /** The person being edited (`user_id` is the auth user id); null = closed. */
  member: { user_id: string; name: string } | null;
  saved: readonly string[];
  onOpenChange: (open: boolean) => void;
  onSaved: (userId: string, banks: string[]) => void;
}) {
  const t = useTranslations('Coordinators.members');
  const [banks, setBanks] = useState<BankOption[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const userId = member?.user_id ?? null;

  // Re-seed the draft each time the dialog opens for a person.
  useEffect(() => {
    if (!userId) return;
    setSelected([...saved]);
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
    // `saved` is read only to seed the draft when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, t]);

  async function save() {
    if (!member) return;
    setSaving(true);
    setError(null);
    try {
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
      invalidateCached('coordinators:');
      onSaved(member.user_id, selected);
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
              saving || banks === null || !banksChanged(saved, selected)
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
