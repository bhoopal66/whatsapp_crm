'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { colorVar, paletteCss } from '@/lib/calendar/ui/colors';
import { feedUrl, parseFeedResponse } from '@/lib/calendar/ui/feed-cache';
import {
  agendaFor,
  agendaRange,
  type AgendaEntry,
} from '@/lib/dashboard/home/agenda';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { DashboardPanel, PanelEmpty } from './panel';
import { useWidgetData } from './use-widget-data';

export interface AgendaPanelProps {
  refreshKey: number;
  className?: string;
}

const SCOPE = '.home-agenda';
const AGENDA_CSS = paletteCss(SCOPE);

function viewerZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/**
 * "Today's agenda": today's calendar events and meetings in time order
 * (finished ones dimmed, the running one badged, a Join link while a
 * meeting is joinable), then the first item after today.
 */
export function AgendaPanel({ refreshKey, className }: AgendaPanelProps) {
  const t = useTranslations('Dashboard.home.agenda');
  const locale = useLocale();
  const { user } = useAuth();
  const userId = user?.id;
  const zone = viewerZone();

  const w = useWidgetData(
    userId ? `agenda:${userId}:${refreshKey}` : null,
    async () => {
      const { fromIso, toIso } = agendaRange(Date.now(), zone);
      const res = await fetch(feedUrl(fromIso, toIso, false), {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`feed ${res.status}`);
      return parseFeedResponse(await res.json());
    }
  );

  // "Now" is retaken on each refresh and every minute, so Join appears
  // and "Now" clears on time between refreshes.
  const [clock, setClock] = useState({ refreshKey, now: new Date().getTime() });
  if (clock.refreshKey !== refreshKey)
    setClock({ refreshKey, now: new Date().getTime() });
  useEffect(() => {
    const timer = window.setInterval(
      () => setClock((c) => ({ ...c, now: Date.now() })),
      60_000
    );
    return () => window.clearInterval(timer);
  }, []);

  const agenda = w.data ? agendaFor(w.data, clock.now, zone) : null;
  const timeFmt = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
  });
  const whenFmt = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const dayFmt = new Intl.DateTimeFormat(locale, { weekday: 'short' });

  const next = agenda?.next ?? null;
  const nextWhen = next
    ? (next.item.allDay ? dayFmt : whenFmt).format(next.startMs)
    : '';

  return (
    <DashboardPanel
      title={t('title')}
      icon={CalendarDays}
      tone="sky"
      action={{ href: '/calendar', label: t('openCalendar') }}
      loading={w.loading && !w.data}
      error={w.error && !w.data}
      onRetry={w.reload}
      className={cn('home-agenda', className)}
    >
      <style>{AGENDA_CSS}</style>
      {agenda?.empty ? (
        <PanelEmpty
          icon={CalendarDays}
          title={t('emptyTitle')}
          hint={t('emptyHint')}
          action={{ href: '/calendar', label: t('openCalendar') }}
        />
      ) : (
        agenda && (
          <div className="space-y-3">
            {agenda.today.length > 0 && (
              <ul className="divide-border divide-y">
                {agenda.today.map((e, i) => (
                  <AgendaRow
                    key={`${e.item.id}:${i}`}
                    entry={e}
                    timeFmt={timeFmt}
                  />
                ))}
              </ul>
            )}
            {agenda.leftToday === 0 && (
              <p className="text-muted-foreground text-sm">
                {t('nothingElse')}
              </p>
            )}
            {next && agenda.leftToday === 0 && (
              <div className="bg-card-2 rounded-lg px-3 py-2">
                <p className="text-muted-foreground text-xs font-medium">
                  {t('next', { when: nextWhen })}
                </p>
                <p className="text-foreground truncate text-sm">
                  {next.item.title}
                </p>
              </div>
            )}
          </div>
        )
      )}
    </DashboardPanel>
  );
}

function AgendaRow({
  entry,
  timeFmt,
}: {
  entry: AgendaEntry;
  timeFmt: Intl.DateTimeFormat;
}) {
  const t = useTranslations('Dashboard.home.agenda');
  const { item } = entry;
  const location = item.kind === 'event' ? item.location : null;
  return (
    <li
      className={cn(
        'flex items-center gap-2.5 py-2',
        entry.state === 'past' && 'opacity-60'
      )}
    >
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: colorVar(item.color, 'solid') }}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="text-foreground truncate text-sm">{item.title}</p>
        <p className="text-muted-foreground truncate text-xs tabular-nums">
          {item.allDay
            ? t('allDay')
            : `${timeFmt.format(entry.startMs)}–${timeFmt.format(entry.endMs)}`}
          {location ? ` · ${location}` : ''}
        </p>
      </div>
      {entry.state === 'now' && (
        <span className="bg-info-soft text-info shrink-0 rounded-full px-2 py-0.5 text-xs font-medium">
          {t('now')}
        </span>
      )}
      {entry.joinMeetingId && (
        <Button
          size="sm"
          variant="outline"
          render={<Link href={`/meetings/${entry.joinMeetingId}`} />}
        >
          {t('join')}
        </Button>
      )}
    </li>
  );
}
