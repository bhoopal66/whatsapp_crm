'use client';

import { useLocale, useTranslations } from 'next-intl';

import { useWorkspaceMembers } from '@/components/meetings/use-workspace-members';
import type { CaseTabProps } from '@/lib/cases/case-page';

import { SlaChip } from './sla-chip';

const DETAIL_FIELDS = ['bank_code', 'product', 'amount', 'priority', 'due_at'];

/** Overview: SLA timers, then stage, reassignment and detail history. */
export function OverviewTab({ detail }: CaseTabProps) {
  const t = useTranslations('CasePage');
  const locale = useLocale();
  const { nameOf } = useWorkspaceMembers();
  const when = (iso: string | null) =>
    iso && !Number.isNaN(new Date(iso).getTime())
      ? new Intl.DateTimeFormat(locale, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(iso))
      : '—';
  const who = (id: string | null) =>
    id ? (nameOf(id) ?? t('unknownPerson')) : t('system');
  const { stages, reassignments, details } = detail.history;
  const byTime = <T extends { changedAt: string }>(rows: T[]) =>
    [...rows].sort((a, b) => b.changedAt.localeCompare(a.changedAt));

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Section title={t('overview.timers')} empty={t('overview.noTimers')}>
        {detail.timers.map((tm, i) => (
          <li key={`${tm.timer}-${i}`} className="flex flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium">
                {t.has(`timers.${tm.timer}`)
                  ? t(`timers.${tm.timer}`)
                  : tm.timer}
              </span>
              {tm.stoppedAt ? (
                <span className="text-muted-foreground text-xs">
                  {t('overview.stopped', { when: when(tm.stoppedAt) })}
                </span>
              ) : (
                <SlaChip state={tm.state} />
              )}
            </span>
            <span className="text-muted-foreground text-xs">
              {t('overview.timerLine', {
                stage: tm.stage,
                due: when(tm.dueAt),
                soon: when(tm.dueSoonAt),
              })}
            </span>
          </li>
        ))}
      </Section>

      <Section title={t('overview.stages')} empty={t('overview.noStages')}>
        {byTime(stages).map((s, i) => (
          <li key={i} className="flex flex-col gap-0.5">
            <span>
              {s.fromStage
                ? t('overview.stageMove', { from: s.fromStage, to: s.toStage })
                : t('overview.stageStart', { to: s.toStage })}
            </span>
            <span className="text-muted-foreground text-xs">
              {when(s.changedAt)} · {who(s.actorId)}
            </span>
          </li>
        ))}
      </Section>

      <Section
        title={t('overview.reassignments')}
        empty={t('overview.noReassignments')}
      >
        {byTime(reassignments).map((r, i) => (
          <li key={i} className="flex flex-col gap-0.5">
            <span>
              {t('overview.reassigned', {
                field: t(`roles.${r.field}`),
                from: r.fromUser ? who(r.fromUser) : t('nobody'),
                to: r.toUser ? who(r.toUser) : t('nobody'),
              })}
            </span>
            <span className="text-muted-foreground text-xs">
              {when(r.changedAt)} · {who(r.actorId)}
            </span>
          </li>
        ))}
      </Section>

      <Section title={t('overview.details')} empty={t('overview.noDetails')}>
        {byTime(details).map((d, i) => {
          const value = (v: string | null) =>
            v === null || v === ''
              ? t('empty')
              : d.field === 'due_at'
                ? when(v)
                : d.field === 'priority' && t.has(`priority.${v}`)
                  ? t(`priority.${v}`)
                  : v;
          return (
            <li key={i} className="flex flex-col gap-0.5">
              <span>
                {t('overview.detailChange', {
                  field: DETAIL_FIELDS.includes(d.field)
                    ? t(`fields.${d.field}`)
                    : d.field,
                  from: value(d.fromValue),
                  to: value(d.toValue),
                })}
              </span>
              <span className="text-muted-foreground text-xs">
                {when(d.changedAt)} · {who(d.actorId)}
              </span>
            </li>
          );
        })}
      </Section>
    </div>
  );
}

function Section({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode[];
}) {
  return (
    <section className="bg-card rounded-lg border p-3">
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      {children.length === 0 ? (
        <p className="text-muted-foreground text-sm">{empty}</p>
      ) : (
        <ol className="space-y-2 border-l pl-3 text-sm">{children}</ol>
      )}
    </section>
  );
}
