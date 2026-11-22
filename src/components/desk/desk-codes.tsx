'use client';

/**
 * Desk codes (migration 220): each bank's three-letter code, which case
 * numbers and caption codes carry. Owners and admins set them, in
 * Settings -> Case desk (they used to be a tab on the desk itself).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import type { DeskBank } from '@/lib/desk/store';

import { deskApi } from './desk-api';

export function DeskCodes() {
  const t = useTranslations('Desk');
  const [banks, setBanks] = useState<DeskBank[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    () =>
      deskApi.banks().then((r) => {
        if (r.ok) setBanks(r.data);
        else {
          toast.error(r.error);
          setBanks([]);
        }
      }),
    []
  );
  useEffect(() => {
    void load();
  }, [load]);

  const save = async (b: DeskBank) => {
    const v = (values[b.bankCode] ?? b.shortCode ?? '').trim().toUpperCase();
    setBusy(b.bankCode);
    const r = await deskApi.setBankCode(b.bankCode, v);
    setBusy(null);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    toast.success(t('codes.saved', { bank: b.bankName }));
    await load();
  };

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <p className="text-muted-foreground text-sm">{t('codes.hint')}</p>
        {banks === null && (
          <p className="text-muted-foreground text-sm">{t('loading')}</p>
        )}
        {banks?.length === 0 && (
          <p className="text-muted-foreground text-sm">{t('codes.noBanks')}</p>
        )}
        {banks?.map((b) => (
          <div key={b.bankCode} className="flex flex-wrap items-center gap-2">
            <span className="min-w-40 text-sm">{b.bankName}</span>
            <Input
              className="w-24 font-mono uppercase"
              maxLength={3}
              value={values[b.bankCode] ?? b.shortCode ?? ''}
              aria-label={t('codes.label', { bank: b.bankName })}
              onChange={(e) =>
                setValues({ ...values, [b.bankCode]: e.target.value })
              }
            />
            <Button
              size="sm"
              variant="outline"
              disabled={busy === b.bankCode}
              onClick={() => save(b)}
            >
              {t('codes.save')}
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
