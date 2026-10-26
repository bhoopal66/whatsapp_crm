'use client';

// The customer page's Cases card (migration 130): the contact's cases the
// caller may read. GET /api/cases/leads is agent and up, so the page mounts
// this only for them. Read-only: cases come only from the submission
// tracker, so nobody opens one here.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';

import {
  LEAD_CHIP,
  parseContactCases,
  type ContactCase,
} from '@/lib/cases/lead-form';
import {
  formatAed,
  parseBanks,
  stageChipClass,
  type CaseBankOption,
} from '@/lib/cases/ui';
import { cn } from '@/lib/utils';

import { SideCard } from './customer-cards';

const chip =
  'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium';

function useCaseBanks(): CaseBankOption[] | null {
  const [banks, setBanks] = useState<CaseBankOption[] | null>(null);
  useEffect(() => {
    let live = true;
    void fetch('/api/cases/config/banks', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: unknown) => live && setBanks(parseBanks(j)))
      .catch(() => live && setBanks([]));
    return () => {
      live = false;
    };
  }, []);
  return banks;
}

export function CasesCard({ contactId }: { contactId: string }) {
  const t = useTranslations('CustomerCases');
  const locale = useLocale();
  const banks = useCaseBanks();
  const [cases, setCases] = useState<ContactCase[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void fetch(`/api/cases/leads?contactId=${encodeURIComponent(contactId)}`, {
      cache: 'no-store',
    })
      .then(async (r) => {
        if (!live) return;
        if (!r.ok) return setFailed(true);
        setCases(parseContactCases(await r.json().catch(() => null)));
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [contactId]);

  const bankName = (code: string | null) =>
    code ? (banks?.find((b) => b.code === code)?.name ?? code) : t('noBank');

  return (
    <SideCard title={t('title')}>
      {failed ? (
        <p className="text-muted-foreground text-sm">{t('loadFailed')}</p>
      ) : cases === null ? (
        <div className="bg-muted h-10 animate-pulse rounded" aria-hidden />
      ) : cases.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <ul className="space-y-2">
          {cases.map((c) => {
            const amount = formatAed(c.amount, locale);
            return (
              <li key={c.id}>
                <Link
                  href={`/cases/${c.id}`}
                  className="hover:bg-muted/60 -mx-2 block space-y-1 rounded-md px-2 py-1.5 text-sm transition-colors"
                >
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className={cn(chip, stageChipClass(c.stage))}>
                      {c.stage}
                    </span>
                    {c.isLead && (
                      <span className={cn(chip, LEAD_CHIP)}>
                        {t('leadChip')}
                      </span>
                    )}
                    {c.closedAt && (
                      <span
                        className={cn(chip, 'bg-muted text-muted-foreground')}
                      >
                        {t('closed')}
                      </span>
                    )}
                  </span>
                  <span className="block truncate font-medium">
                    {bankName(c.bankCode)}
                    {c.product ? ` · ${c.product}` : ''}
                  </span>
                  {amount && (
                    <span className="text-muted-foreground block text-xs">
                      {amount}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </SideCard>
  );
}
