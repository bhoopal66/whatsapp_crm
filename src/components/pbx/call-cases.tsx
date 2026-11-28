'use client';

// The in-call window's Cases block: a compact copy of the customer
// page's Cases card (GET /api/cases/leads is agent and up). Read-only,
// and nothing at all when there are none or the read was refused.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';

import { useStageLabel } from '@/hooks/use-stage-label';
import { useAuth } from '@/hooks/use-auth';
import { canSendMessages } from '@/lib/auth/roles';
import {
  LEAD_CHIP,
  parseContactCases,
  type ContactCase,
} from '@/lib/cases/lead-form';
import {
  caseStatusView,
  formatAed,
  parseBanks,
  type CaseBankOption,
} from '@/lib/cases/ui';
import { cn } from '@/lib/utils';

const chip =
  'inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-xs font-medium';

export function ContactCasesMini({ contactId }: { contactId: string }) {
  const t = useTranslations('CallContext.cases');
  const showStage = useStageLabel();
  const locale = useLocale();
  const { accountRole, salesRestricted } = useAuth();
  const allowed =
    !!accountRole && canSendMessages(accountRole) && !salesRestricted;
  const [banks, setBanks] = useState<CaseBankOption[] | null>(null);
  const [read, setRead] = useState<{
    contactId: string;
    cases: ContactCase[];
  } | null>(null);

  useEffect(() => {
    if (!allowed) return;
    let live = true;
    void fetch('/api/cases/config/banks', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: unknown) => live && setBanks(parseBanks(j)))
      .catch(() => live && setBanks([]));
    return () => {
      live = false;
    };
  }, [allowed]);

  useEffect(() => {
    if (!allowed) return;
    let live = true;
    void fetch(`/api/cases/leads?contactId=${encodeURIComponent(contactId)}`, {
      cache: 'no-store',
    })
      .then(async (r) => {
        if (!live) return;
        // Refused or failed: render nothing, as for none.
        const cases = r.ok
          ? parseContactCases(await r.json().catch(() => null))
          : [];
        setRead({ contactId, cases });
      })
      .catch(() => live && setRead({ contactId, cases: [] }));
    return () => {
      live = false;
    };
  }, [allowed, contactId]);

  const cases = read?.contactId === contactId ? read.cases : [];
  if (!allowed || cases.length === 0) return null;

  const bankName = (code: string | null) =>
    code ? (banks?.find((b) => b.code === code)?.name ?? code) : t('noBank');

  return (
    <div className="space-y-1">
      <h3 className="text-sm font-semibold">{t('title')}</h3>
      <ul className="divide-border divide-y">
        {cases.map((c) => {
          const amount = formatAed(c.amount, locale);
          const status = caseStatusView(c, showStage);
          return (
            <li key={c.id}>
              <Link
                href={`/cases/${c.id}`}
                className="hover:bg-muted/60 -mx-2 block space-y-1 rounded-md px-2 py-2 text-sm transition-colors"
              >
                <span className="block truncate font-medium">
                  {[bankName(c.bankCode), c.product, amount]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className={cn(chip, status.chipClass)}>
                    {status.text}
                  </span>
                  {c.isLead && (
                    <span className={cn(chip, LEAD_CHIP)}>{t('lead')}</span>
                  )}
                  {c.closedAt && (
                    <span
                      className={cn(chip, 'bg-muted text-muted-foreground')}
                    >
                      {t('closed')}
                    </span>
                  )}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
