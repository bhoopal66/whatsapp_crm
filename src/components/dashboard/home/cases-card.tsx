'use client';

import Link from 'next/link';
import { Briefcase } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { hasMinRole, type AccountRole } from '@/lib/auth/roles';
import {
  caseStatusView,
  formatAed,
  stageChipClass,
  type InboxRow,
  type InboxSlaState,
} from '@/lib/cases/ui';
import {
  casesHref,
  formatFigure,
  summarizeCases,
  type CaseStageCount,
} from '@/lib/dashboard/home/cases';
import type { OpenCases } from '@/lib/dashboard/home/sources';
import { cn } from '@/lib/utils';
import { DashboardPanel, PanelEmpty } from './panel';
import { Stat } from './stat';
import type { WidgetData } from './use-widget-data';

export interface CasesCardProps {
  cases: WidgetData<OpenCases>;
  /** Whose cases these are: an agent's own, a leader's team's, or all. */
  role: AccountRole;
  className?: string;
}

const CHIP =
  'inline-flex max-w-full items-center truncate rounded-full px-2 py-0.5 text-xs font-medium';

/** The cases inbox's SLA chip colours. */
const SLA_CHIP: Record<InboxSlaState, string> = {
  on_track: 'bg-success-soft text-success ring-1 ring-success/30 ring-inset',
  due_soon: 'bg-warning-soft text-warning ring-1 ring-warning/30 ring-inset',
  overdue:
    'bg-destructive-soft text-destructive ring-1 ring-destructive/30 ring-inset',
};

/**
 * The open cases this person may read (the page's one list, scoped by
 * the server to their role): the inbox's flag counts, each opening the
 * inbox filtered to it, the most urgent five, and — for leaders and up
 * on a wide enough card — how the cases spread over the stages.
 */
export function CasesCard({ cases, role, className }: CasesCardProps) {
  const t = useTranslations('Dashboard.home.cases');
  const title = hasMinRole(role, 'admin')
    ? t('titleAll')
    : role === 'team_leader'
      ? t('titleTeam')
      : t('titleMine');
  const s = cases.data
    ? summarizeCases(cases.data.rows, cases.data.truncated)
    : null;
  const showStages = hasMinRole(role, 'team_leader');

  return (
    <DashboardPanel
      title={title}
      icon={Briefcase}
      tone="violet"
      action={{ href: '/cases', label: t('action') }}
      loading={cases.loading && !cases.data}
      error={cases.error && !cases.data}
      onRetry={cases.reload}
      className={className}
    >
      {s && cases.data && cases.data.rows.length === 0 ? (
        <PanelEmpty icon={Briefcase} title={t('empty')} hint={t('emptyHint')} />
      ) : s ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 @md:grid-cols-3 @3xl:grid-cols-6">
            <Stat
              label={t('open')}
              value={formatFigure(s.open)}
              hint={
                s.leads.count > 0
                  ? t('leads', {
                      count: s.leads.count,
                      shown: formatFigure(s.leads),
                    })
                  : undefined
              }
              href={casesHref()}
            />
            <Stat
              label={t('overdue')}
              value={formatFigure(s.overdue)}
              tone={s.overdue.count > 0 ? 'destructive' : 'default'}
              href={casesHref({ slaState: 'overdue' })}
            />
            <Stat
              label={t('dueSoon')}
              value={formatFigure(s.dueSoon)}
              tone={s.dueSoon.count > 0 ? 'warning' : 'default'}
              href={casesHref({ slaState: 'due_soon' })}
            />
            <Stat
              label={t('customerWaiting')}
              value={formatFigure(s.customerWaiting)}
              href={casesHref({ customerWaiting: true })}
            />
            <Stat
              label={t('documentsMissing')}
              value={formatFigure(s.documentsMissing)}
              href={casesHref({ documentsMissing: true })}
            />
            <Stat
              label={t('bankQueries')}
              value={formatFigure(s.bankQueries)}
              href={casesHref({ bankQueryOpen: true })}
            />
          </div>
          <div
            className={cn(
              'grid grid-cols-1 gap-4',
              showStages && '@2xl:grid-cols-2'
            )}
          >
            <UrgentList rows={s.urgent} />
            {showStages && (
              <StageBars stages={s.byStage} className="hidden @2xl:block" />
            )}
          </div>
        </div>
      ) : null}
    </DashboardPanel>
  );
}

function UrgentList({ rows }: { rows: InboxRow[] }) {
  const t = useTranslations('Dashboard.home.cases');
  const tCases = useTranslations('Cases');
  const locale = useLocale();
  return (
    <div className="min-w-0">
      <h3 className="text-muted-foreground mb-2 text-xs font-semibold">
        {t('urgent')}
      </h3>
      <ul className="space-y-1.5">
        {rows.map((r) => {
          const amount = formatAed(r.amount, locale);
          return (
            <li key={r.caseId}>
              <Link
                href={`/cases/${r.caseId}`}
                className="bg-card-2 hover:bg-muted flex min-w-0 items-center gap-3 rounded-lg px-3 py-2 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-foreground truncate text-sm font-medium">
                    {r.contactName ?? r.contactOwnName ?? t('noCustomer')}
                  </p>
                  <p className="text-muted-foreground truncate text-xs">
                    {r.bankName ?? r.bankCode ?? t('noBank')} ·{' '}
                    {caseStatusView(r).text}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {r.slaState && (
                    <span className={cn(CHIP, SLA_CHIP[r.slaState])}>
                      {tCases(`sla.${r.slaState}`)}
                    </span>
                  )}
                  {amount && (
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {amount}
                    </span>
                  )}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function StageBars({
  stages,
  className,
}: {
  stages: CaseStageCount[];
  className?: string;
}) {
  const t = useTranslations('Dashboard.home.cases');
  return (
    <div className={cn('min-w-0', className)}>
      <h3 className="text-muted-foreground mb-2 text-xs font-semibold">
        {t('byStage')}
      </h3>
      <ul className="space-y-2">
        {stages.map((s) => (
          <li key={s.stage} className="flex items-center gap-2">
            <span
              className={cn(CHIP, 'w-36 shrink-0', stageChipClass(s.stage))}
            >
              {s.stage}
            </span>
            <span className="bg-card-2 h-2 min-w-0 flex-1 overflow-hidden rounded-full">
              <span
                className="bg-primary block h-full rounded-full"
                style={{ width: `${Math.max(4, s.share * 100)}%` }}
              />
            </span>
            <span className="text-foreground w-8 shrink-0 text-right text-xs font-semibold tabular-nums">
              {s.count}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
