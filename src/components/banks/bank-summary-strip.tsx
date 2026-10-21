'use client';

import { useLocale, useTranslations } from 'next-intl';

import type { BankSummary } from '@/lib/banks/ui';
import { cn } from '@/lib/utils';

import { chip } from './banks-list';

/**
 * The bank page header's figures (migration 131's bank_ws_summary). The
 * page renders it only when the summary loaded; a failure hides it.
 */
export function BankSummaryStrip({ summary }: { summary: BankSummary }) {
  const t = useTranslations('Banks.summary');
  const locale = useLocale();
  const n = (v: number) => v.toLocaleString(locale);
  const { members } = summary;
  return (
    <dl
      aria-label={t('label')}
      className="border-border bg-card/60 flex flex-wrap gap-x-6 gap-y-2 rounded-xl border px-4 py-3 text-sm"
    >
      <Item label={t('openCases')}>
        <span className="font-semibold tabular-nums">
          {n(summary.openCases)}
        </span>
      </Item>
      <Item label={t('members')}>
        <span className="tabular-nums">
          {t('membersValue', {
            total: members.total,
            agents: members.agents,
            coordinators: members.coordinators,
            teamLeads: members.teamLeads,
          })}
        </span>
      </Item>
      <Item label={t('actions')}>
        <span
          className={cn(
            chip,
            summary.openActions > 0
              ? 'bg-warning-soft text-warning'
              : 'bg-muted text-muted-foreground'
          )}
        >
          {t('actionsValue', { count: summary.openActions })}
        </span>
      </Item>
      {summary.myRole && (
        <Item label={t('role')}>
          <span className="font-medium">{t(`roles.${summary.myRole}`)}</span>
        </Item>
      )}
    </dl>
  );
}

function Item({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}
