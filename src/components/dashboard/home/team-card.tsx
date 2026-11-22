'use client';

import { Activity, CheckCircle2, DatabaseZap } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  LevelIcon,
  useFindingCopy,
  useSenderName,
} from '@/components/team-activity/shared';
import { useAuth } from '@/hooks/use-auth';
import { useNearViewport } from '@/hooks/use-near-viewport';
import { canEditSettings } from '@/lib/auth/roles';
import { loadTeamToday, type TeamFinding } from '@/lib/dashboard/home/team';
import type { Tone } from '@/lib/team-activity/glance';
import { cn } from '@/lib/utils';

import { DashboardPanel, PanelEmpty } from './panel';
import { Stat, type StatTone } from './stat';
import { useWidgetData } from './use-widget-data';

export interface TeamCardProps {
  refreshKey: number;
  className?: string;
}

const REPLY_TONE: Record<Tone, StatTone> = {
  good: 'success',
  warn: 'warning',
  bad: 'destructive',
};

/**
 * Today's team activity at a glance: the Team activity page's four
 * headline figures and its three most urgent findings. The report is
 * the heaviest query on the home screen, so it waits until the card is
 * about to scroll into view.
 */
export function TeamCard({ refreshKey, className }: TeamCardProps) {
  const t = useTranslations('Dashboard.home.team');
  const { accountId, accountRole, profileLoading } = useAuth();
  const { ref, near } = useNearViewport<HTMLDivElement>();
  // Owners and admins also get the owner's findings (API and bot
  // senders), as on the Team activity page.
  const viewer =
    accountRole && canEditSettings(accountRole) ? 'owner' : 'leader';
  const ready = near && !profileLoading && !!accountId;
  const w = useWidgetData(
    ready ? `team:${accountId}:${viewer}:${refreshKey}` : null,
    () => loadTeamToday(viewer)
  );
  const data = w.data;

  return (
    <div ref={ref} className={cn('flex min-w-0', className)}>
      <DashboardPanel
        title={t('title')}
        icon={Activity}
        tone="violet"
        action={{ href: '/team-activity', label: t('action') }}
        loading={w.loading && !data}
        error={w.error && !data}
        onRetry={w.reload}
        className="flex-1"
      >
        {data?.status === 'not_migrated' ? (
          <PanelEmpty
            icon={DatabaseZap}
            title={t('notMigrated')}
            hint={t('notMigratedHint')}
          />
        ) : data?.status === 'ok' ? (
          <div className="flex flex-col gap-4 @5xl:flex-row">
            <div className="grid grid-cols-2 content-start gap-2 @3xl:grid-cols-4 @5xl:flex-[3]">
              <Stat label={t('newChats')} value={data.glance.todayNew} />
              {data.glance.reply ? (
                <Stat
                  label={t('replyRate')}
                  value={t('replyValue', {
                    percent: data.glance.reply.percent,
                    replied: data.glance.reply.replied,
                    total: data.glance.reply.total,
                  })}
                  tone={REPLY_TONE[data.glance.reply.tone]}
                  hint={t('replyAim', { aim: data.glance.reply.aimPercent })}
                />
              ) : (
                <Stat
                  label={t('replyRate')}
                  value="–"
                  tone="muted"
                  hint={t('replyTooFew')}
                />
              )}
              <Stat
                label={t('waiting')}
                value={data.glance.waitingRecent}
                tone={data.glance.waitingRecent > 0 ? 'warning' : 'default'}
                hint={t('waitingHint', {
                  count: data.glance.waitingUnassignedRecent,
                })}
              />
              <Stat
                label={t('pending')}
                value={data.glance.pending}
                hint={t('pendingHint')}
              />
            </div>
            <Findings items={data.findings} />
          </div>
        ) : null}
      </DashboardPanel>
    </div>
  );
}

function Findings({ items }: { items: TeamFinding[] }) {
  const t = useTranslations('Dashboard.home.team');
  const copy = useFindingCopy();
  const senderName = useSenderName();

  if (items.length === 0) {
    return (
      <div className="border-success/30 bg-success-soft text-success flex items-center gap-2 self-start rounded-lg border px-3 py-2.5 text-sm @5xl:flex-[2]">
        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
        {t('noFindings')}
      </div>
    );
  }

  return (
    <section className="min-w-0 @5xl:flex-[2]">
      <h3 className="text-muted-foreground mb-2 text-xs font-medium">
        {t('findings')}
      </h3>
      <ul className="space-y-2">
        {items.map(({ finding, sender, numberName }) => {
          const who = sender
            ? senderName(sender)
            : (numberName ??
              (finding.subject.type === 'account' ? t('wholeTeam') : null));
          return (
            <li
              key={finding.id}
              className="bg-card-2 flex min-w-0 gap-2 rounded-lg px-3 py-2"
            >
              <LevelIcon level={finding.level} className="mt-0.5" />
              <div className="min-w-0">
                <p className="text-foreground text-sm leading-snug font-medium">
                  {copy(finding).title}
                </p>
                {who && (
                  <p className="text-muted-foreground truncate text-xs">
                    {who}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
