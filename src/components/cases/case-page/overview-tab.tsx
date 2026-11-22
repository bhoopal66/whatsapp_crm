'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import {
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  FileText,
  MessageSquare,
} from 'lucide-react';

import { useWorkspaceMembers } from '@/components/meetings/use-workspace-members';
import type { CaseTabProps } from '@/lib/cases/case-page';
import {
  nextStep,
  parseLastMessage,
  summariseDocs,
} from '@/lib/cases/overview';
import { formatAed } from '@/lib/cases/ui';

import { SlaChip } from './sla-chip';
import { useCaseResource } from './tab-kit';

const DETAIL_FIELDS = ['bank_code', 'product', 'amount', 'priority', 'due_at'];

/**
 * Overview: what needs doing first (document checklist, next step, the
 * customer's last message), then SLA timers and the stage, reassignment
 * and detail history, each only when it has something to show.
 */
export function OverviewTab({ caseId, detail }: CaseTabProps) {
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

  const docsRes = useCaseResource(
    `/api/cases/${caseId}/documents`,
    summariseDocs
  );
  const lastRes = useCaseResource(
    `/api/cases/${caseId}/last-message`,
    parseLastMessage
  );
  const docs = docsRes.data;
  const step = nextStep(detail.case, detail.stages, docs);
  const last = lastRes.data;

  const sections: React.ReactNode[] = [];
  if (detail.timers.length > 0)
    sections.push(
      <Section key="timers" title={t('overview.timers')}>
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
    );
  if (stages.length > 0)
    sections.push(
      <Section key="stages" title={t('overview.stages')}>
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
    );
  if (reassignments.length > 0)
    sections.push(
      <Section key="reassign" title={t('overview.reassignments')}>
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
    );
  if (details.length > 0)
    sections.push(
      <Section key="details" title={t('overview.details')}>
        {byTime(details).map((d, i) => {
          const value = (v: string | null) =>
            v === null || v === ''
              ? t('empty')
              : d.field === 'due_at'
                ? when(v)
                : d.field === 'amount'
                  ? (formatAed(v, locale) ?? v)
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
    );

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title={t('overview.docsTitle')} icon={FileText}>
          {docsRes.failed && !docs ? (
            <p className="text-muted-foreground text-sm">
              {t('overview.docsFailed')}
            </p>
          ) : !docs ? (
            <p className="text-muted-foreground text-sm" aria-busy="true">
              {t('tabLoading')}
            </p>
          ) : docs.required === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t('overview.docsNone')}
            </p>
          ) : (
            <>
              <p className="flex items-center gap-1.5 text-sm font-medium">
                {docs.missing.length === 0 ? (
                  <CheckCircle2
                    className="text-success size-4 shrink-0"
                    aria-hidden
                  />
                ) : (
                  <CircleAlert
                    className="text-warning size-4 shrink-0"
                    aria-hidden
                  />
                )}
                {docs.missing.length === 0
                  ? t('overview.docsComplete', { total: docs.required })
                  : t('overview.docsProgress', {
                      received: docs.received,
                      total: docs.required,
                    })}
              </p>
              {docs.missing.length > 0 && (
                <p className="text-muted-foreground text-sm">
                  {t('overview.docsMissing', {
                    list: docs.missing.slice(0, 4).join(', '),
                    more: Math.max(0, docs.missing.length - 4),
                  })}
                </p>
              )}
              <TabLink tab="documents" label={t('overview.openDocuments')} />
            </>
          )}
        </Card>

        <Card title={t('overview.nextTitle')} icon={ArrowRight}>
          <p className="text-sm font-medium">
            {step.kind === 'closed'
              ? t('overview.nextClosed')
              : step.kind === 'documents'
                ? t('overview.nextDocuments', { count: step.missing })
                : step.kind === 'move'
                  ? t('overview.nextMove', { stage: step.stage })
                  : t('overview.nextNone')}
          </p>
          {step.kind === 'documents' && step.rejected > 0 && (
            <p className="text-muted-foreground text-sm">
              {t('overview.nextRejected', { count: step.rejected })}
            </p>
          )}
          {step.kind === 'move' && (
            <p className="text-muted-foreground text-sm">
              {t('overview.nextMoveHint')}
            </p>
          )}
        </Card>

        <Card title={t('overview.lastTitle')} icon={MessageSquare}>
          {lastRes.failed && !last ? (
            <p className="text-muted-foreground text-sm">
              {t('overview.lastFailed')}
            </p>
          ) : lastRes.loadedAt === 0 ? (
            <p className="text-muted-foreground text-sm" aria-busy="true">
              {t('tabLoading')}
            </p>
          ) : !last ? (
            <p className="text-muted-foreground text-sm">
              {t('overview.lastNone')}
            </p>
          ) : (
            <>
              <p className="text-sm break-words">
                {last.text ?? t('overview.lastMedia')}
              </p>
              <p className="text-muted-foreground text-xs">{when(last.at)}</p>
              <Link
                href={`/inbox?c=${last.conversationId}`}
                className="text-info inline-flex min-h-8 items-center gap-1 text-sm font-medium hover:underline"
              >
                {t('overview.openChat')}
                <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            </>
          )}
        </Card>
      </div>

      {sections.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">{sections}</div>
      )}
    </div>
  );
}

function TabLink({ tab, label }: { tab: string; label: string }) {
  return (
    <Link
      href={`?tab=${tab}`}
      scroll={false}
      className="text-info inline-flex min-h-8 items-center gap-1 text-sm font-medium hover:underline"
    >
      {label}
      <ArrowRight className="size-3.5" aria-hidden />
    </Link>
  );
}

function Card({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof FileText;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-card flex flex-col gap-1.5 rounded-lg border p-3">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold">
        <Icon className="text-muted-foreground size-4" aria-hidden />
        {title}
      </h2>
      {children}
    </section>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode[];
}) {
  return (
    <section className="bg-card rounded-lg border p-3">
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      <ol className="space-y-2 border-l pl-3 text-sm">{children}</ol>
    </section>
  );
}
