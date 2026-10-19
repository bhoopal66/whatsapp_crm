'use client';

import { useTranslations } from 'next-intl';

import type { CaseTabProps } from '@/lib/cases/case-page';

/** The case's Timeline tab. Placeholder: a later job builds its content. */
export function TimelineTab(props: CaseTabProps) {
  const t = useTranslations('CasePage');
  void props;
  return (
    <p className="text-muted-foreground py-8 text-center text-sm">
      {t('tabLoading')}
    </p>
  );
}
