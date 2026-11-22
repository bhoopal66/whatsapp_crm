'use client';

/**
 * The case desk on My worklist (migration 235, design 035 D8): what waits
 * for this person at the desk, with the oldest age, and a link to it.
 * Hidden when nothing waits or the person has no desk access.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/hooks/use-auth';
import { formatAge } from '@/lib/desk/intake-form';
import type { DeskWorklist } from '@/lib/desk/store';

import { deskApi } from './desk-api';

export function DeskWorklistCard() {
  const t = useTranslations('Desk');
  const { accountId } = useAuth();
  const [w, setW] = useState<{
    account: string | null;
    data: DeskWorklist;
  } | null>(null);
  useEffect(() => {
    let live = true;
    void deskApi.worklist().then((r) => {
      if (live && r.ok) setW({ account: accountId, data: r.data });
    });
    return () => {
      live = false;
    };
  }, [accountId]);
  // Another workspace's answer is never shown after a switch.
  if (!w || w.account !== accountId) return null;
  const rows = (['tray', 'queue', 'mine', 'tasks'] as const).filter(
    (k) => w.data[k].count > 0
  );
  if (rows.length === 0) return null;
  return (
    <Card className="mx-auto mb-4 w-full max-w-5xl">
      <CardContent className="space-y-2 text-sm">
        <h2 className="text-foreground text-base font-semibold">
          {t('worklist.title')}
        </h2>
        <ul className="space-y-1">
          {rows.map((k) => (
            <li key={k} className="flex flex-wrap gap-x-2">
              <span className="text-foreground">
                {t(`worklist.${k}`, { count: w.data[k].count })}
              </span>
              {w.data[k].oldestSeconds !== null && (
                <span className="text-muted-foreground">
                  {t('worklist.oldest', {
                    age: formatAge(w.data[k].oldestSeconds),
                  })}
                </span>
              )}
            </li>
          ))}
        </ul>
        <Link
          href="/desk"
          className="text-primary text-sm underline underline-offset-2"
        >
          {t('worklist.open')}
        </Link>
      </CardContent>
    </Card>
  );
}
