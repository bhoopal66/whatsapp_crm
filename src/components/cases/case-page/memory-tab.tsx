'use client';

import { useTranslations } from 'next-intl';

import type { CaseTabProps } from '@/lib/cases/case-page';

/** The case's Memory tab. Placeholder: a later job builds its content. */
export function MemoryTab(props: CaseTabProps) {
  const t = useTranslations('CasePage');
  void props;
  return (
    <p className="text-muted-foreground py-8 text-center text-sm">
      {t('tabLoading')}
    </p>
  );
}
