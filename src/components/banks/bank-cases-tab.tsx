'use client';

import { useTranslations } from 'next-intl';

/** The bank page's Cases tab: a placeholder a later job fills. */
export function BankCasesTab({ bankWsId }: { bankWsId: string }) {
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
