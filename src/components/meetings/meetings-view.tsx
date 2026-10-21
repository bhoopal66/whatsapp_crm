'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { CalendarDays, Plus, Search, Video } from 'lucide-react';

import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import {
  filterMeetings,
  formatMeetingDay,
  formatMeetingWhen,
  groupMeetingsByDay,
  MEETING_SCOPES,
  meetingDisplayStatus,
  parseMeetingList,
  type MeetingDayGroup,
  type MeetingScope,
  type MeetingSummary,
} from '@/lib/meetings/schedule';
import { cn } from '@/lib/utils';

import { MeetingFormDialog } from './meeting-form-dialog';
import { MeetingStatusBadge } from './meeting-status-badge';
import { AvatarStack, type AvatarPerson } from './person-avatars';
import {
  useMeetingTimeZone,
  useWorkspaceMembers,
} from './use-workspace-members';

/** How often Live now re-reads who is in each call. */
const LIVE_REFRESH_MS = 20_000;

interface Loaded {
  scope: MeetingScope;
  meetings: MeetingSummary[];
  failed: boolean;
}

/** /meetings — Live now (default), Upcoming (?scope=upcoming), Past. */
export function MeetingsView({ scope }: { scope: MeetingScope }) {
  const t = useTranslations('Meetings');
  const locale = useLocale();
  const timeZone = useMeetingTimeZone();
  const { user } = useAuth();
  // Agents and viewers attend; team leaders and up create (111).
  const canCreate = useCan('create-meetings');
  const { nameOf, avatarOf } = useWorkspaceMembers();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [query, setQuery] = useState('');
  const [dialogKey, setDialogKey] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(
    (signal?: { cancelled: boolean }) =>
      fetch(`/api/meetings?scope=${scope}`)
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        })
        .then((json) => {
          if (!signal?.cancelled)
            setLoaded({
              scope,
              meetings: parseMeetingList(json),
              failed: false,
            });
        })
        .catch(() => {
          if (!signal?.cancelled)
            setLoaded({ scope, meetings: [], failed: true });
        }),
    [scope]
  );

  useEffect(() => {
    const signal = { cancelled: false };
    void load(signal);
    const timer =
      scope === 'live'
        ? setInterval(() => void load(signal), LIVE_REFRESH_MS)
        : null;
    return () => {
      signal.cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [load, scope]);

  const nameFor = useCallback(
    (userId: string) =>
      userId === user?.id ? t('you') : (nameOf(userId) ?? t('unknownPerson')),
    [user?.id, nameOf, t]
  );
  const personOf = useCallback(
    (userId: string): AvatarPerson => ({
      userId,
      name: nameFor(userId),
      avatarUrl: avatarOf(userId),
    }),
    [nameFor, avatarOf]
  );

  const current = loaded?.scope === scope ? loaded : null;
  const shown = useMemo(
    () => (current ? filterMeetings(current.meetings, query, nameOf) : []),
    [current, query, nameOf]
  );
  const now = new Date();
  const groups: MeetingDayGroup[] =
    scope === 'upcoming'
      ? groupMeetingsByDay(shown, now, timeZone)
      : [{ kind: 'date', date: null, meetings: shown }];

  const openNew = () => {
    setDialogKey((k) => k + 1);
    setDialogOpen(true);
  };

  const groupTitle = (g: MeetingDayGroup) =>
    g.kind === 'unscheduled'
      ? t('groups.unscheduled')
      : g.kind === 'today'
        ? t('groups.today')
        : g.kind === 'tomorrow'
          ? t('groups.tomorrow')
          : g.date
            ? formatMeetingDay(g.date, locale)
            : null;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        {canCreate && (
          <Button onClick={openNew}>
            <Plus className="size-4" aria-hidden />
            {t('newMeeting')}
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap gap-2" aria-label={t('title')}>
          {MEETING_SCOPES.map((k) => (
            <Link
              key={k}
              href={k === 'live' ? '/meetings' : `/meetings?scope=${k}`}
              aria-current={scope === k ? 'page' : undefined}
              className={cn(
                'focus-visible:ring-ring/50 rounded-full border px-3 py-1 text-sm transition-colors outline-none focus-visible:ring-3',
                scope === k
                  ? 'border-primary/40 bg-primary-soft text-primary font-medium'
                  : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              {t(`tabs.${k}`)}
            </Link>
          ))}
        </nav>
        <div className="relative w-full sm:w-64">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('search')}
            aria-label={t('search')}
            className="pl-8"
          />
        </div>
      </div>

      {!current ? (
        <div className="space-y-3" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className="bg-muted h-24 animate-pulse rounded-xl" />
          ))}
        </div>
      ) : current.failed ? (
        <p className="text-destructive text-sm">{t('loadFailed')}</p>
      ) : current.meetings.length === 0 ? (
        <div className="border-border bg-card flex flex-col items-center gap-3 rounded-xl border border-dashed px-4 py-12 text-center">
          <span className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
            {scope === 'upcoming' ? (
              <CalendarDays className="size-5" aria-hidden />
            ) : (
              <Video className="size-5" aria-hidden />
            )}
          </span>
          <p className="text-muted-foreground text-sm">{t(`empty.${scope}`)}</p>
          {scope !== 'past' && canCreate && (
            <Button variant="outline" onClick={openNew}>
              <Plus className="size-4" aria-hidden />
              {t('newMeeting')}
            </Button>
          )}
        </div>
      ) : shown.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {t('noMatches', { query: query.trim() })}
        </p>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => {
            const title = groupTitle(g);
            return (
              <section key={g.kind + (g.date ?? '')} className="space-y-2">
                {title && (
                  <h2 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                    {title}
                  </h2>
                )}
                <ul className="space-y-2">
                  {g.meetings.map((m) => (
                    <MeetingCard
                      key={m.id}
                      meeting={m}
                      now={now}
                      when={
                        formatMeetingWhen(m, { locale, timeZone }) ??
                        t('instant')
                      }
                      personOf={personOf}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      <MeetingFormDialog
        key={dialogKey}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        timeZone={timeZone}
        onSaved={() => void load()}
      />
    </div>
  );
}

function MeetingCard({
  meeting: m,
  now,
  when,
  personOf,
}: {
  meeting: MeetingSummary;
  now: Date;
  when: string;
  personOf: (userId: string) => AvatarPerson;
}) {
  const t = useTranslations('Meetings');
  const status = meetingDisplayStatus(m, now);
  const live = status === 'live';
  // Join straight from the list once the meeting is on or due; earlier
  // than that, the detail page is the way in.
  const joinable = live || status === 'due';
  const invitees = [m.hostUserId, ...m.inviteeUserIds].map(personOf);
  const inCall = m.present.map((p) => personOf(p.userId));

  return (
    <li
      className={cn(
        'border-border bg-card flex flex-wrap items-center gap-3 rounded-xl border p-4 sm:flex-nowrap',
        live && 'border-success/40'
      )}
    >
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-xl',
          live
            ? 'bg-success-soft text-success'
            : 'bg-muted text-muted-foreground'
        )}
      >
        <Video className="size-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Link
            href={`/meetings/${m.id}`}
            className="truncate font-semibold hover:underline"
          >
            {m.title}
          </Link>
          <MeetingStatusBadge status={status} />
        </div>
        <p className="text-muted-foreground truncate text-sm">
          {[when, t('hostedBy', { name: personOf(m.hostUserId).name })].join(
            ' · '
          )}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <AvatarStack
            people={invitees}
            moreLabel={(n) => t('more', { count: n })}
          />
          {live && (
            <span className="text-success text-xs font-medium">
              {inCall.length > 0
                ? t('whoIsIn', {
                    names: inCall
                      .slice(0, 2)
                      .map((p) => p.name)
                      .join(', '),
                    more: Math.max(0, inCall.length - 2),
                  })
                : t('inCallNow', { count: m.presentCount })}
            </span>
          )}
        </div>
      </div>
      {joinable && (
        <Link
          href={`/meetings/${m.id}/room`}
          className={cn(buttonVariants({ size: 'sm' }), 'shrink-0')}
        >
          <Video className="size-4" aria-hidden />
          {t('join')}
        </Link>
      )}
    </li>
  );
}
