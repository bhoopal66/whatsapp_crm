'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import {
  ArrowLeft,
  ArrowRightLeft,
  Briefcase,
  ExternalLink,
  FileQuestion,
  Hand,
  Lock,
  MessagesSquare,
  Pencil,
  UserRoundCog,
} from 'lucide-react';
import { toast } from 'sonner';

import { useWorkspaceMembers } from '@/components/meetings/use-workspace-members';
import { ConfirmDialog } from '@/components/ui-ext/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { GatedButton } from '@/components/ui/gated-button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  caseLocks,
  caseTabDisabled,
  canTakeOver,
  docRequestKey,
  parseCaseDetail,
  resolveCaseTab,
  runningTimers,
  TAKEOVER_TEMPLATE_APPROVED,
  takeoverNotApproved,
  visibleCaseTabs,
  type CaseDetail,
  type CaseTab,
  type CaseTabProps,
} from '@/lib/cases/case-page';
import { formatAed, stageChipClass } from '@/lib/cases/ui';
import { cn } from '@/lib/utils';

import { AuditTab } from './audit-tab';
import { BankContactsTab } from './bank-contacts-tab';
import {
  EditDetailsDialog,
  MoveStageDialog,
  ReassignDialog,
  sendCaseRequest,
} from './case-dialogs';
import { ConversationTab } from './conversation-tab';
import { DocumentsTab } from './documents-tab';
import { MemoryTab } from './memory-tab';
import { NotesTab } from './notes-tab';
import { OverviewTab } from './overview-tab';
import { SlaChip } from './sla-chip';
import { TasksTab } from './tasks-tab';
import { TimelineTab } from './timeline-tab';

/** Matches the presence TTL's spirit: others show within one poll. */
const PRESENCE_POLL_MS = 20_000;

type State = 'loading' | 'ok' | 'gone' | 'forbidden' | 'error';
type Open = 'move' | 'edit' | 'reassign' | 'docs' | null;

const TAB_BODY: Record<CaseTab, (p: CaseTabProps) => React.ReactNode> = {
  overview: OverviewTab,
  timeline: TimelineTab,
  conversation: ConversationTab,
  tasks: TasksTab,
  documents: DocumentsTab,
  notes: NotesTab,
  'bank-contacts': BankContactsTab,
  memory: MemoryTab,
  audit: AuditTab,
};

/** /cases/[id] — header, actions, and the Overview plus the case's tabs. */
export function CasePage({ caseId }: { caseId: string }) {
  const t = useTranslations('CasePage');
  const locale = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { members, nameOf } = useWorkspaceMembers();
  const [state, setState] = useState<State>('loading');
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [open, setOpen] = useState<Open>(null);
  const [acting, setActing] = useState(false);
  const [viewers, setViewers] = useState<string[]>([]);
  const mounted = useRef(true);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    // An older reload answering after a newer one must not overwrite it.
    const mine = ++seq.current;
    const current = () => mounted.current && mine === seq.current;
    try {
      const res = await fetch(`/api/cases/${caseId}`, { cache: 'no-store' });
      if (!current()) return;
      if (res.status === 404) return setState('gone');
      if (res.status === 403) return setState('forbidden');
      if (!res.ok) throw new Error(String(res.status));
      const parsed = parseCaseDetail(await res.json());
      if (!parsed) throw new Error('shape');
      if (!current()) return;
      setDetail(parsed);
      setState('ok');
    } catch {
      // Keep what is on screen on a failed refresh; fail only a first load.
      if (current()) setState((s) => (s === 'ok' ? s : 'error'));
    }
  }, [caseId]);

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  // "Also viewing": a hint only, polled while the tab is visible; a
  // failure just leaves the line out.
  useEffect(() => {
    if (state !== 'ok') return;
    let cancelled = false;
    const touch = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const res = await fetch(`/api/cases/${caseId}/presence`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: 'viewing' }),
        });
        const json = (await res.json().catch(() => null)) as {
          viewers?: unknown;
        } | null;
        if (!cancelled && res.ok && Array.isArray(json?.viewers))
          setViewers(
            json.viewers.filter((v): v is string => typeof v === 'string')
          );
      } catch {
        /* presence is best-effort */
      }
    };
    void touch();
    const timer = setInterval(() => void touch(), PRESENCE_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void touch();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [caseId, state]);

  const canSeeAudit = detail?.permissions.canSeeAudit ?? false;
  const isLead = detail?.case.isLead ?? false;
  const activeTab = resolveCaseTab(
    searchParams.get('tab'),
    canSeeAudit,
    isLead
  );
  const changeTab = (next: unknown) => {
    const tab = resolveCaseTab(String(next), canSeeAudit, isLead);
    const url = new URL(window.location.href);
    if (tab === 'overview') url.searchParams.delete('tab');
    else url.searchParams.set('tab', tab);
    router.replace(`${url.pathname}${url.search}`, { scroll: false });
  };

  const requestDocs = async () => {
    setOpen(null);
    setActing(true);
    const r = await sendCaseRequest(
      `/api/cases/${caseId}/documents/request`,
      'POST'
    );
    setActing(false);
    if (r.ok) {
      const res = r.json as { recorded?: boolean } | null;
      if (res?.recorded === false) toast.warning(t('docs.sentNotRecorded'));
      else toast.success(t('docs.sent'));
      void reload();
      return;
    }
    const res = r.json as { code?: unknown; refusal?: unknown } | null;
    const key = docRequestKey(r.status, res?.code, res?.refusal);
    if (key === 'nothingMissing') toast.info(t(`docs.${key}`));
    else toast.error(t(`docs.${key}`));
  };

  // Kept for when the hand-over template is approved; the button stays
  // disabled until TAKEOVER_TEMPLATE_APPROVED is flipped.
  const takeOver = async () => {
    setActing(true);
    const r = await sendCaseRequest(`/api/cases/${caseId}/takeover`, 'POST');
    setActing(false);
    if (r.ok) {
      toast.success(t('takeover.done'));
      void reload();
    } else if (
      takeoverNotApproved(r.status, (r.json as { code?: unknown } | null)?.code)
    ) {
      toast.info(t('takeover.awaiting'));
    } else toast.error(t('takeover.failed'));
  };

  const back = (
    <Link
      href="/cases"
      aria-label={t('back')}
      className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
    >
      <ArrowLeft className="size-4" />
    </Link>
  );

  if (state === 'loading') {
    return (
      <div className="space-y-4 p-4" aria-busy="true">
        <div className="bg-muted h-12 w-64 animate-pulse rounded" />
        <div className="bg-muted h-[40vh] animate-pulse rounded-lg" />
      </div>
    );
  }

  if (state !== 'ok' || !detail) {
    return (
      <div className="flex flex-col items-start gap-3 p-4">
        <Link
          href="/cases"
          className={buttonVariants({ variant: 'ghost', size: 'sm' })}
        >
          <ArrowLeft className="size-4" />
          {t('back')}
        </Link>
        <p className="text-muted-foreground text-sm">
          {state === 'gone'
            ? t('notFound')
            : state === 'forbidden'
              ? t('forbidden')
              : t('loadFailed')}
        </p>
        {state === 'error' && (
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            {t('retry')}
          </Button>
        )}
      </div>
    );
  }

  const c = detail.case;
  const { canWrite, canReassign } = detail.permissions;
  const closed = c.closedAt !== null;
  const person = (id: string | null) =>
    id ? (nameOf(id) ?? t('unknownPerson')) : t('nobody');
  const dateLabel = (iso: string | null) =>
    iso && !Number.isNaN(new Date(iso).getTime())
      ? new Intl.DateTimeFormat(locale, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(iso))
      : null;
  const amount =
    c.amount !== null && c.amount !== '' ? formatAed(c.amount, locale) : null;
  const due = dateLabel(c.dueAt);
  const timers = runningTimers(detail.timers);
  const others = viewers.map((v) => nameOf(v)).filter((n): n is string => !!n);
  const noWrite = t('gate.write');
  const closedGate = t('gate.closed');
  const noGroup = t('gate.noGroup');
  const locks = caseLocks(detail);
  const compassGate = t('gate.compass');
  const synced = dateLabel(c.externalChangedAt);
  const tabProps: CaseTabProps = {
    caseId,
    detail,
    onChanged: () => void reload(),
  };
  const title = c.contactName || c.submissionRef || t('untitled');

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3 sm:p-4">
      {detail.locked && (
        <div
          role="note"
          className="bg-info-soft border-info/30 flex flex-wrap items-start gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-sm"
        >
          <Lock className="text-info mt-0.5 size-4 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-info font-medium">{t('compass.title')}</p>
            <p className="text-muted-foreground text-xs">
              {t('compass.body')}
              {synced ? ` · ${t('compass.synced', { time: synced })}` : ''}
            </p>
          </div>
          {c.externalUrl && (
            <a
              href={c.externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-info inline-flex items-center gap-1 text-xs font-medium hover:underline"
            >
              {t('compass.open')}
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          )}
        </div>
      )}
      <header className="bg-card flex flex-col gap-3 rounded-lg border p-3 sm:p-4">
        <div className="flex items-start gap-3">
          {back}
          <span className="bg-wa-green/15 text-wa-green hidden size-12 shrink-0 items-center justify-center rounded-full sm:flex">
            <Briefcase className="size-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-base font-semibold sm:text-lg">
                {c.contactId && c.contactName ? (
                  <Link
                    href={`/contacts/${c.contactId}`}
                    className="hover:underline"
                  >
                    {c.contactName}
                  </Link>
                ) : (
                  title
                )}
              </h1>
              <span
                className={cn(
                  'inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
                  stageChipClass(c.stage)
                )}
              >
                {c.stage}
              </span>
              {closed && (
                <Badge variant="outline">
                  {c.outcome
                    ? t('closedWith', { outcome: c.outcome })
                    : t('closed')}
                </Badge>
              )}
              <Badge
                variant={
                  c.priority === 'urgent' || c.priority === 'high'
                    ? 'destructive'
                    : 'outline'
                }
              >
                {t(`priority.${c.priority}`)}
              </Badge>
            </div>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {[
                c.submissionRef ? t('ref', { ref: c.submissionRef }) : null,
                c.bankName ?? c.bankCode,
                c.product,
                amount,
                due ? t('due', { when: due }) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {t('people', {
                agent: person(c.agentId),
                coordinator: person(c.coordinatorId),
              })}
            </p>
            {(timers.length > 0 || c.groupId) && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {timers.map((tm, i) => (
                  <SlaChip
                    key={`${tm.timer}-${i}`}
                    state={tm.state}
                    label={
                      t.has(`timers.${tm.timer}`)
                        ? t(`timers.${tm.timer}`)
                        : tm.timer
                    }
                  />
                ))}
                {c.groupId && (
                  <Link
                    href={`/submission-groups/${c.groupId}`}
                    className="text-primary inline-flex items-center gap-1 text-xs hover:underline"
                  >
                    <MessagesSquare className="size-3.5" aria-hidden />
                    {t('group')}
                  </Link>
                )}
              </div>
            )}
            {c.isLead && (
              <p
                role="note"
                className="bg-info-soft text-muted-foreground border-info/30 mt-1.5 rounded-md border px-2 py-1 text-xs"
              >
                <span className="text-foreground font-medium">
                  {t('lead.banner')}
                </span>
                {c.leadSource
                  ? ` · ${t('lead.source', { source: c.leadSource })}`
                  : ''}
              </p>
            )}
            {closed && c.outcome && detail.outcomeReason && (
              <p className="text-muted-foreground mt-1 text-xs">
                {t('reasonLine', {
                  reason: t.has(`reasons.${detail.outcomeReason.reasonCode}`)
                    ? t(`reasons.${detail.outcomeReason.reasonCode}`)
                    : detail.outcomeReason.reasonCode,
                })}
                {detail.outcomeReason.reasonText
                  ? ` — ${detail.outcomeReason.reasonText}`
                  : ''}
              </p>
            )}
            {others.length > 0 && (
              <p className="text-muted-foreground mt-1 text-xs" role="status">
                {t('alsoViewing', { names: others.join(', ') })}
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <GatedButton
            size="sm"
            variant="outline"
            disabled={!canWrite || closed || acting || locks.stage}
            title={
              !canWrite
                ? noWrite
                : closed
                  ? closedGate
                  : locks.stage
                    ? compassGate
                    : undefined
            }
            onClick={() => setOpen('move')}
          >
            <ArrowRightLeft className="size-4" aria-hidden />
            {t('actions.move')}
          </GatedButton>
          <GatedButton
            size="sm"
            variant="outline"
            disabled={!canWrite || closed || acting}
            title={!canWrite ? noWrite : closed ? closedGate : undefined}
            onClick={() => setOpen('edit')}
          >
            <Pencil className="size-4" aria-hidden />
            {t('actions.edit')}
          </GatedButton>
          <GatedButton
            size="sm"
            variant="outline"
            disabled={!canReassign || closed || acting}
            title={
              !canReassign
                ? t('gate.reassign')
                : closed
                  ? closedGate
                  : undefined
            }
            onClick={() => setOpen('reassign')}
          >
            <UserRoundCog className="size-4" aria-hidden />
            {t('actions.reassign')}
          </GatedButton>
          <GatedButton
            size="sm"
            variant="outline"
            disabled={!canWrite || closed || acting || c.isLead}
            title={
              c.isLead
                ? noGroup
                : !canWrite
                  ? noWrite
                  : closed
                    ? closedGate
                    : undefined
            }
            onClick={() => setOpen('docs')}
          >
            <FileQuestion className="size-4" aria-hidden />
            {t('actions.docs')}
          </GatedButton>
          {canTakeOver(detail.role) && (
            <GatedButton
              size="sm"
              variant="outline"
              disabled={
                !TAKEOVER_TEMPLATE_APPROVED || closed || acting || c.isLead
              }
              title={
                c.isLead
                  ? noGroup
                  : !TAKEOVER_TEMPLATE_APPROVED
                    ? t('takeover.awaiting')
                    : closed
                      ? closedGate
                      : undefined
              }
              onClick={() => void takeOver()}
            >
              <Hand className="size-4" aria-hidden />
              {t('actions.takeover')}
            </GatedButton>
          )}
        </div>
        {c.isLead && (
          <p className="text-muted-foreground -mt-1 text-xs">{noGroup}</p>
        )}
        {canTakeOver(detail.role) && !TAKEOVER_TEMPLATE_APPROVED && (
          <p className="text-muted-foreground -mt-1 text-xs">
            {t('takeover.awaiting')}
          </p>
        )}
      </header>

      <Tabs
        value={activeTab}
        onValueChange={changeTab}
        className="min-h-0 flex-1"
      >
        <TabsList className="max-w-full justify-start overflow-x-auto">
          {visibleCaseTabs(canSeeAudit).map((name) => (
            <TabsTrigger
              key={name}
              value={name}
              className="flex-none"
              disabled={caseTabDisabled(name, c.isLead)}
              title={caseTabDisabled(name, c.isLead) ? noGroup : undefined}
            >
              {t(`tabs.${name}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        {visibleCaseTabs(canSeeAudit).map((name) => {
          const Body = TAB_BODY[name];
          return (
            <TabsContent key={name} value={name} className="min-h-0 flex-1">
              {activeTab === name && <Body {...tabProps} />}
            </TabsContent>
          );
        })}
      </Tabs>

      {open === 'move' && (
        <MoveStageDialog
          open={open === 'move'}
          onOpenChange={(o) => !o && setOpen(null)}
          detail={detail}
          onChanged={() => void reload()}
        />
      )}
      {open === 'edit' && (
        <EditDetailsDialog
          open={open === 'edit'}
          onOpenChange={(o) => !o && setOpen(null)}
          detail={detail}
          onChanged={() => void reload()}
        />
      )}
      {open === 'reassign' && (
        <ReassignDialog
          open={open === 'reassign'}
          onOpenChange={(o) => !o && setOpen(null)}
          detail={detail}
          onChanged={() => void reload()}
          members={members}
        />
      )}
      <ConfirmDialog
        open={open === 'docs'}
        onOpenChange={(o) => !o && setOpen(null)}
        title={t('docs.title')}
        description={t('docs.body')}
        cancelLabel={t('cancel')}
        confirmLabel={t('docs.confirm')}
        onConfirm={() => void requestDocs()}
      />
    </div>
  );
}
