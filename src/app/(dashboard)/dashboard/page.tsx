'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { RotateCw } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { AgendaPanel } from '@/components/dashboard/home/agenda-panel';
import { AttentionStrip } from '@/components/dashboard/home/attention-strip';
import { CallsCard } from '@/components/dashboard/home/calls-card';
import { CampaignsCard } from '@/components/dashboard/home/campaigns-card';
import { CasesCard } from '@/components/dashboard/home/cases-card';
import { MessagesCard } from '@/components/dashboard/home/messages-card';
import { NumbersCard } from '@/components/dashboard/home/numbers-card';
import { OutreachCard } from '@/components/dashboard/home/outreach-card';
import { PipelineCard } from '@/components/dashboard/home/pipeline-card';
import { ResponseTimeCard } from '@/components/dashboard/home/response-time-card';
import { TasksPanel } from '@/components/dashboard/home/tasks-panel';
import { TeamCard } from '@/components/dashboard/home/team-card';
import { useWidgetData } from '@/components/dashboard/home/use-widget-data';
import { DownloadCsvButton } from '@/components/reports/download-csv-button';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import type { AccountNumber } from '@/hooks/use-whatsapp-numbers';
import { firstName, greetingKey } from '@/lib/dashboard/home/greeting';
import {
  fetchMyOpenTasks,
  fetchOpenCases,
  HOME_LIST_LIMIT,
} from '@/lib/dashboard/home/sources';
import { isOutreachNumber } from '@/lib/dashboard/home/outreach';
import { homeWidgets } from '@/lib/dashboard/home/widgets';
import { missedCallCount } from '@/lib/dashboard/missed-calls';
import { loadCallsBadge } from '@/lib/pbx/calls-badge';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';

/** A visible tab refreshes itself this often. */
const AUTO_REFRESH_MS = 5 * 60_000;
/** Coming back to the tab refreshes once the figures are this old. */
const STALE_ON_RETURN_MS = 2 * 60_000;

/**
 * The home screen: what needs this person now, their day, their work,
 * and — for leaders and admins — the team and the workspace's health.
 * Which panels appear is `homeWidgets` (role, phone system, phone
 * numbers); every panel loads on its own, so a slow one never holds up
 * the rest. The two lists more than one panel reads (open tasks, open
 * cases) are loaded here once and handed to each.
 */
export default function DashboardPage() {
  const t = useTranslations('Dashboard.home');
  const locale = useLocale();
  const {
    user,
    profile,
    account,
    accountId,
    accountRole,
    profileLoading,
    isBankGuest,
    salesRestricted,
  } = useAuth();
  const userId = user?.id ?? null;
  const role = profileLoading ? null : accountRole;
  const staff = !!role && !isBankGuest;

  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshedAt, setRefreshedAt] = useState(() => new Date());
  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setRefreshedAt(new Date());
  }, []);
  useAutoRefresh(refreshedAt, refresh);

  // Whether the phone system is in use, and this person's open missed
  // calls: the same two head counts as the sidebar's Calls row.
  const callsBadge = useWidgetData(
    staff && userId ? `calls-badge:${userId}:${refreshKey}` : null,
    () => loadCallsBadge(createClient(), userId ?? '')
  );
  // Read afresh each refresh and not cached: a failed read must show as
  // an error, not as "no number connected".
  const numbers = useWidgetData(
    staff && accountId ? `numbers:${accountId}:${refreshKey}` : null,
    async (): Promise<AccountNumber[]> => {
      const { data, error } = await createClient()
        .from('whatsapp_config')
        .select(
          'id, provider, label, waba_id, phone_number_id, is_primary, status, is_personal, user_id'
        )
        .eq('account_id', accountId ?? '')
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as AccountNumber[];
    }
  );
  const widgets = homeWidgets(role, {
    pbx: callsBadge.data?.hasPbx ?? false,
    phoneNumbers: (numbers.data ?? []).some(isOutreachNumber),
    salesRestricted,
  });
  const show = widgets.has.bind(widgets);

  // Tasks ticked off whose PATCH was sent: a refresh already in flight
  // may carry the old list, so the loader leaves these out.
  const completing = useRef(new Set<string>());
  const onCompleting = useCallback((id: string, pending: boolean) => {
    if (pending) completing.current.add(id);
    else completing.current.delete(id);
  }, []);
  const tasks = useWidgetData(
    show('tasks') && userId ? `tasks:${userId}:${refreshKey}` : null,
    () =>
      fetchMyOpenTasks().then((list) =>
        list.filter((t) => !completing.current.has(t.id))
      )
  );
  // The open missed-call tasks are the badge's rule; once the list is
  // loaded it follows a tick at once.
  // From the shared list, so ticking one off moves the tile at once. A
  // full list may have been cut at the cap: then the badge's exact head
  // count is the floor.
  const listedMissed = tasks.data?.filter(
    (t) => t.kind === 'missed_call'
  ).length;
  const missedCalls = missedCallCount(
    listedMissed,
    (tasks.data?.length ?? 0) >= HOME_LIST_LIMIT,
    callsBadge.data?.missed ?? null
  );
  const cases = useWidgetData(
    show('cases') && accountId ? `cases:${accountId}:${refreshKey}` : null,
    fetchOpenCases
  );

  const name = firstName(profile?.full_name, profile?.email ?? user?.email);
  const greeting = t(`greeting.${greetingKey(refreshedAt.getHours())}`);
  const date = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(refreshedAt);
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(refreshedAt);

  const hasWork = show('cases') || show('calls');
  const hasTeam = show('team') || show('numbers') || show('campaigns');
  const adminRow = show('numbers') || show('campaigns');

  return (
    <div className="mx-auto w-full max-w-screen-2xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-foreground truncate text-2xl font-bold">
            {name ? t('greeting.withName', { greeting, name }) : greeting}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {account?.name
              ? t('subtitle', { date, workspace: account.name })
              : date}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-muted-foreground text-xs tabular-nums">
            {t('updated', { time })}
          </span>
          <Button variant="outline" size="sm" onClick={refresh}>
            <RotateCw className="h-3.5 w-3.5" aria-hidden />
            {t('refresh')}
          </Button>
          {/* The owner's CSV of these figures (owner only, server-checked). */}
          <DownloadCsvButton
            size="sm"
            options={[{ label: '', url: dashboardExportUrl() }]}
          />
        </div>
      </header>

      {show('attention') && (
        <AttentionStrip
          refreshKey={refreshKey}
          tasks={show('tasks') ? tasks : null}
          cases={show('cases') ? cases : null}
          missedCalls={
            show('tasks') && show('calls')
              ? {
                  count: missedCalls,
                  error:
                    missedCalls === null &&
                    !tasks.loading &&
                    !callsBadge.loading,
                }
              : null
          }
        />
      )}

      {(show('tasks') || show('agenda')) && (
        <Zone title={t('sections.today')}>
          {show('tasks') && (
            <TasksPanel
              tasks={tasks}
              onCompleting={onCompleting}
              className="lg:col-span-2"
            />
          )}
          {/* Without a tasks panel (a viewer) the agenda takes the row. */}
          <div
            className={cn(
              'grid min-w-0 content-start gap-4',
              !show('tasks') && 'lg:col-span-3'
            )}
          >
            {show('agenda') && <AgendaPanel refreshKey={refreshKey} />}
            {show('outreach') && (
              <OutreachCard refreshKey={refreshKey} numbers={numbers.data} />
            )}
          </div>
        </Zone>
      )}

      {hasWork && (
        <Zone title={t('sections.work')}>
          {show('cases') && role && (
            <CasesCard
              cases={cases}
              role={role}
              className={show('calls') ? 'lg:col-span-2' : 'lg:col-span-3'}
            />
          )}
          {show('calls') && (
            <CallsCard
              refreshKey={refreshKey}
              className={show('cases') ? undefined : 'lg:col-span-3'}
            />
          )}
        </Zone>
      )}

      {hasTeam && (
        <Zone title={t('sections.team')}>
          {show('team') && (
            <TeamCard
              refreshKey={refreshKey}
              className={adminRow ? undefined : 'lg:col-span-3'}
            />
          )}
          {show('numbers') && (
            <NumbersCard
              numbers={numbers.data}
              error={numbers.error && !numbers.data}
              onRetry={numbers.reload}
            />
          )}
          {show('campaigns') && <CampaignsCard refreshKey={refreshKey} />}
        </Zone>
      )}

      {show('trends') && (
        <Zone title={t('sections.trends')}>
          <MessagesCard refreshKey={refreshKey} className="lg:col-span-2" />
          <PipelineCard refreshKey={refreshKey} />
          <ResponseTimeCard refreshKey={refreshKey} className="lg:col-span-3" />
        </Zone>
      )}
    </div>
  );
}

/** The owner's CSV, its windows computed in the browser's zone. */
function dashboardExportUrl(): string {
  let tz = 'UTC';
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    // keep UTC
  }
  return `/api/dashboard/export?${new URLSearchParams({ tz })}`;
}

/** A titled band of panels: three columns on a wide screen, one on a phone. */
function Zone({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
        {title}
      </h2>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">{children}</div>
    </section>
  );
}

/**
 * Refresh every few minutes while the tab is visible, and on coming back
 * to it once the figures have gone stale. A hidden tab never asks.
 */
function useAutoRefresh(refreshedAt: Date, refresh: () => void) {
  useEffect(() => {
    const age = () => Date.now() - refreshedAt.getTime();
    const visible = () => document.visibilityState === 'visible';
    const timer = window.setInterval(() => {
      if (visible() && age() >= AUTO_REFRESH_MS) refresh();
    }, 30_000);
    const onVisibility = () => {
      if (visible() && age() >= STALE_ON_RETURN_MS) refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refreshedAt, refresh]);
}
