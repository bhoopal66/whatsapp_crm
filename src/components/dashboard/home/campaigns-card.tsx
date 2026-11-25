'use client';

import Link from 'next/link';
import { Clock, Radio } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import {
  CAMPAIGN_COLUMNS,
  IN_FLIGHT_LIMIT,
  WEEK_MS,
  campaignProgress,
  scheduleDay,
  sortInFlight,
  weekCampaigns,
  weekSummary,
  type CampaignRow,
  type WeekSummary,
} from '@/lib/dashboard/home/campaigns';
import { createClient } from '@/lib/supabase/client';

import { DashboardPanel, PanelEmpty } from './panel';
import { useWidgetData } from './use-widget-data';

export interface CampaignsCardProps {
  refreshKey: number;
  className?: string;
}

interface Campaigns {
  /** The moment the load ran; schedule labels are worded against it. */
  now: Date;
  inFlight: CampaignRow[];
  week: WeekSummary;
}

/**
 * Campaigns sending or scheduled now, and how the last week's sent
 * campaigns did. Read through the browser client: RLS keeps
 * `broadcasts` to the active workspace's admins.
 */
async function loadCampaigns(): Promise<Campaigns> {
  const supabase = createClient();
  const now = new Date();
  const since = new Date(now.getTime() - WEEK_MS).toISOString();
  const [live, sent] = await Promise.all([
    supabase
      .from('broadcasts')
      .select(CAMPAIGN_COLUMNS)
      .in('status', ['sending', 'scheduled'])
      // 'sending' sorts after 'scheduled', so descending puts it first.
      .order('status', { ascending: false })
      .order('scheduled_at', { ascending: true, nullsFirst: false })
      .limit(IN_FLIGHT_LIMIT),
    supabase
      .from('broadcasts')
      .select('status, sent_count, delivered_count, read_count')
      .in('status', ['sent', 'stopped'])
      // A scheduled campaign goes out at `scheduled_at` and `broadcasts`
      // has no sent-at column, so that is its send day; created_at covers the rest.
      .or(
        `scheduled_at.gte.${since},and(scheduled_at.is.null,created_at.gte.${since})`
      ),
  ]);
  if (live.error) throw live.error;
  if (sent.error) throw sent.error;
  return {
    now,
    inFlight: sortInFlight((live.data ?? []) as CampaignRow[]),
    week: weekSummary(
      weekCampaigns((sent.data ?? []) as (CampaignRow & { status: string })[])
    ),
  };
}

export function CampaignsCard({ refreshKey, className }: CampaignsCardProps) {
  const t = useTranslations('Dashboard.home.campaigns');
  const { accountId } = useAuth();
  const w = useWidgetData(
    accountId ? `campaigns:${accountId}:${refreshKey}` : null,
    loadCampaigns
  );
  const data = w.data;

  return (
    <DashboardPanel
      title={t('title')}
      icon={Radio}
      tone="sky"
      action={{ href: '/broadcasts', label: t('action') }}
      loading={w.loading && !data}
      error={w.error && !data}
      onRetry={w.reload}
      className={className}
    >
      {data && (
        <div className="flex flex-1 flex-col gap-3">
          {data.inFlight.length === 0 ? (
            <PanelEmpty
              icon={Radio}
              title={t('empty')}
              action={{ href: '/broadcasts/new', label: t('newBroadcast') }}
            />
          ) : (
            <ul className="space-y-1.5">
              {data.inFlight.map((row) => (
                <CampaignLine key={row.id} row={row} now={data.now} />
              ))}
            </ul>
          )}
          <WeekLine week={data.week} />
        </div>
      )}
    </DashboardPanel>
  );
}

function CampaignLine({ row, now }: { row: CampaignRow; now: Date }) {
  const t = useTranslations('Dashboard.home.campaigns');
  const when = useScheduleLabel(now);
  const sending = row.status === 'sending';
  const progress = campaignProgress(row);
  return (
    <li className="bg-card-2 min-w-0 rounded-lg px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <Link
          href={`/broadcasts/${row.id}`}
          className="text-foreground min-w-0 truncate text-sm font-medium hover:underline"
        >
          {row.name}
        </Link>
        {row.failed_count > 0 && (
          <span className="text-destructive shrink-0 text-xs">
            {t('failed', { count: row.failed_count })}
          </span>
        )}
        <span className="ms-auto shrink-0">
          {sending ? (
            <span className="bg-info-soft text-info rounded px-1.5 py-0.5 text-xs font-medium">
              {t('sending')}
            </span>
          ) : (
            <span className="text-muted-foreground inline-flex items-center gap-1 text-xs tabular-nums">
              <Clock className="h-3 w-3" aria-hidden />
              {row.scheduled_at ? when(row.scheduled_at) : t('scheduled')}
            </span>
          )}
        </span>
      </div>
      {sending && (
        <div className="mt-2 flex items-center gap-2">
          <div
            className="bg-border h-1.5 flex-1 overflow-hidden rounded-full"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.percent}
          >
            <div
              className="bg-info h-full rounded-full"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {t('progress', { sent: progress.sent, total: progress.total })}
          </span>
        </div>
      )}
    </li>
  );
}

/** "Today 18:00", "Tomorrow 09:00", "Thu 09:00", "4 Nov, 09:00". */
function useScheduleLabel(now: Date) {
  const t = useTranslations('Dashboard.home.campaigns');
  const locale = useLocale();
  return (iso: string) => {
    const at = new Date(iso);
    const time = new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
    }).format(at);
    switch (scheduleDay(at, now)) {
      case 'past':
        return t('due', { time });
      case 'today':
        return t('today', { time });
      case 'tomorrow':
        return t('tomorrow', { time });
      case 'week':
        return new Intl.DateTimeFormat(locale, {
          weekday: 'short',
          hour: '2-digit',
          minute: '2-digit',
        }).format(at);
      case 'later':
        return new Intl.DateTimeFormat(locale, {
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        }).format(at);
    }
  };
}

function WeekLine({ week }: { week: WeekSummary }) {
  const t = useTranslations('Dashboard.home.campaigns');
  const parts = [t('week', { count: week.campaigns })];
  if (week.campaigns > 0 && week.deliveredPct !== null) {
    parts.push(t('delivered', { pct: week.deliveredPct }));
  }
  if (week.campaigns > 0 && week.readPct !== null) {
    parts.push(t('read', { pct: week.readPct }));
  }
  return (
    <p className="text-muted-foreground border-border mt-auto border-t pt-3 text-xs">
      {parts.join(' · ')}
    </p>
  );
}
