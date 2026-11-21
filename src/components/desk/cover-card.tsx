'use client';

/**
 * Coordinators and cover (migration 232), on the Overview tab for team
 * leaders and up: each bank's primary and second coordinator (owners and
 * admins change them), who covers today, and each holder's leave.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import type { BankCover, CoverHolder } from '@/lib/desk/cover';

import { deskApi } from './desk-api';
import { NATIVE_FIELD } from './tag-fields';

export function CoverCard({ isAdmin }: { isAdmin: boolean }) {
  const t = useTranslations('Desk');
  const [banks, setBanks] = useState<BankCover[] | null>(null);
  const load = useCallback(
    () =>
      deskApi.cover().then((r) => {
        if (r.ok) setBanks(r.data);
        else toast.error(r.error);
      }),
    []
  );
  useEffect(() => {
    void load();
  }, [load]);

  const done = async (r: { ok: boolean; error?: string }) => {
    if (!r.ok) toast.error(r.error ?? '');
    else toast.success(t('cover.saved'));
    await load();
  };

  if (!banks) return null;
  return (
    <Card>
      <CardContent className="space-y-4 pt-6 text-sm">
        <div>
          <h2 className="text-foreground text-base font-semibold">
            {t('cover.title')}
          </h2>
          <p className="text-muted-foreground">{t('cover.intro')}</p>
        </div>
        {banks.length === 0 && (
          <p className="text-muted-foreground">{t('cover.noBanks')}</p>
        )}
        {banks.map((b) => {
          const nameOf = (id: string | null) =>
            b.holders.find((h) => h.userId === id)?.name ?? null;
          return (
            <div key={b.bankCode} className="space-y-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-foreground font-medium">
                  {b.bankName}
                </span>
                <span className="text-muted-foreground text-xs">
                  {t('cover.today', {
                    name: nameOf(b.coverUser) ?? t('cover.lead'),
                  })}{' '}
                  ({t(`cover.levels.${b.coverLevel}`)})
                </span>
              </div>
              <div className="flex flex-wrap gap-3">
                {(['primary', 'second'] as const).map((role) => (
                  <label key={role} className="flex items-center gap-2">
                    <span className="text-muted-foreground">
                      {t(`cover.${role}`)}
                    </span>
                    <select
                      className={`${NATIVE_FIELD} w-auto`}
                      disabled={!isAdmin}
                      value={
                        (role === 'primary' ? b.primaryUser : b.secondUser) ??
                        ''
                      }
                      onChange={async (e) =>
                        done(
                          await deskApi.setBankRole(
                            b.bankCode,
                            role,
                            e.target.value || null
                          )
                        )
                      }
                    >
                      <option value="">{t('cover.none')}</option>
                      {b.holders.map((h) => (
                        <option key={h.userId} value={h.userId}>
                          {h.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <ul className="space-y-1">
                {b.holders.map((h) => (
                  <HolderLeave key={h.userId} holder={h} onDone={done} />
                ))}
              </ul>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function HolderLeave({
  holder,
  onDone,
}: {
  holder: CoverHolder;
  onDone: (r: { ok: boolean; error?: string }) => Promise<void>;
}) {
  const t = useTranslations('Desk');
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  return (
    <li className="flex flex-wrap items-center gap-2">
      <span className="min-w-32">{holder.name}</span>
      {holder.onLeave && (
        <Badge variant="secondary">{t('cover.onLeave')}</Badge>
      )}
      {holder.leave.map((l) => (
        <span
          key={l.id}
          className="text-muted-foreground flex items-center gap-1 text-xs"
        >
          {t('cover.leaveRange', { first: l.firstDay, last: l.lastDay })}
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => onDone(await deskApi.removeLeave(l.id))}
          >
            {t('cover.remove')}
          </Button>
        </span>
      ))}
      <span className="ml-auto flex flex-wrap items-center gap-1">
        <Input
          type="date"
          className="w-36"
          aria-label={t('cover.from')}
          value={first}
          onChange={(e) => setFirst(e.target.value)}
        />
        <Input
          type="date"
          className="w-36"
          aria-label={t('cover.to')}
          value={last}
          onChange={(e) => setLast(e.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!first || !last}
          onClick={async () => {
            await onDone(
              await deskApi.addLeave({
                userId: holder.userId,
                firstDay: first,
                lastDay: last,
              })
            );
            setFirst('');
            setLast('');
          }}
        >
          {t('cover.addLeave')}
        </Button>
      </span>
    </li>
  );
}
