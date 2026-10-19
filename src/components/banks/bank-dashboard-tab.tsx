'use client';

import { useTranslations } from 'next-intl';

/** The bank page's Dashboard tab: a placeholder a later job fills. */
export function BankDashboardTab({ bankWsId }: { bankWsId: string }) {
  const t = useTranslations('Banks');
  return (
    <p
      className="text-muted-foreground py-8 text-center text-sm"
      data-bank={bankWsId}
    >
      {t('loading')}
    </p>
  );
}
