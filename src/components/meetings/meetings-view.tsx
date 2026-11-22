'use client';

import { EmptyState } from '@/components/dashboard/empty-state';
import { ErrorState } from '@/components/dashboard/error-state';
import { LoadingState } from '@/components/dashboard/loading-state';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import {
  CalendarDays,
  CalendarPlus,
  ExternalLink,
  Link2,
  Search,
  Video,
} from 'lucide-react';
import { toast } from 'sonner';

import { copyWithToast } from '@/components/context-menu/app-context-menu';
import {
  useContextMenuItems,
  type ContextMenuEntry,
} from '@/components/context-menu/registry';

import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import {
  countdownParts,
  firstName,
  hubSections,
  liveElapsedMs,
  meetingIdFromLink,
  upcomingBadge,
  type CountdownParts,
  type MeetingHubTab,
} from '@/lib/meetings/hub';
import {
  buildMeetingBody,
  defaultMeetingForm,
  durationParts,
  filterMeetings,
  formatMeetingDay,
  formatMeetingWhen,
  groupMeetingsByDay,
  meetingDisplayStatus,
  meetingDurationMs,
  parseMeeting,
  parseMeetingList,
  type MeetingDayGroup,
  type MeetingSummary,
} from '@/lib/meetings/schedule';
import { isInCall } from '@/lib/meetings/session/session';
import { cn } from '@/lib/utils';

import { MeetingFormDialog } from './meeting-form-dialog';
import { LiveDot } from './meeting-status-badge';
import { AvatarStack, type AvatarPerson } from './person-avatars';
import { useActiveCall } from './session/meeting-session-provider';
import {
  useMeetingTimeZone,
  useWorkspaceMembers,
} from './use-workspace-members';

/** How often the default view re-reads who is in each call. */
const LIVE_REFRESH_MS = 20_000;

/** The clock, floored to the minute; null while rendering on the server. */
function subscribeClock(onTick: () => void) {
  const timer = setInterval(onTick, 5_000);
  return () => clearInterval(timer);
}
const minuteNow = () => Math.floor(Date.now() / 60_000) * 60_000;
const noClock = () => null;

interface HubData {
  live: MeetingSummary[];
  upcoming: MeetingSummary[];
  past: MeetingSummary[];
  failed: boolean;
}

async function readScope(scope: string): Promise<MeetingSummary[]> {
  const res = await fetch(`/api/meetings?scope=${scope}`);
  if (!res.ok) throw new Error(String(res.status));
  return parseMeetingList(await res.json());
}

/** What the screens around a card share. */
interface Shared {
  now: Date;
  locale: string;
  timeZone: string;
  activeMeetingId: string | null;
  personOf: (userId: string) => AvatarPerson;
}

/** /meetings — the Schedule (default) and Past views. */
export function MeetingsView({ tab }: { tab: MeetingHubTab }) {
  const t = useTranslations('Meetings');
  const locale = useLocale();
  const timeZone = useMeetingTimeZone();
  const router = useRouter();
  const { user, profile } = useAuth();
  // Agents and viewers attend; team leaders and up create (111).
  const canCreate = useCan('create-meetings');
  const { nameOf, avatarOf } = useWorkspaceMembers();
  const active = useActiveCall();
  const inCall = active && isInCall(active.call.phase) ? active : null;
  const clock = useSyncExternalStore(subscribeClock, minuteNow, noClock);
  const [data, setData] = useState<HubData | null>(null);
  const [loadedTab, setLoadedTab] = useState<MeetingHubTab | null>(null);
  const [query, setQuery] = useState('');
  const [dialogKey, setDialogKey] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const readId = useRef(0);

  const load = useCallback(async () => {
    const id = ++readId.current;
    const scopes = tab === 'past' ? ['past'] : ['live', 'upcoming'];
    const reads = await Promise.allSettled(scopes.map(readScope));
    // A slower older read must not overwrite a newer one.
    if (id !== readId.current) return;
    const failed = reads.some((r) => r.status === 'rejected');
    const value = (i: number) => {
      const r = reads[i];
      return r.status === 'fulfilled' ? r.value : null;
    };
    setLoadedTab(tab);
    // A failed re-read keeps what is on screen: a blip must not blank it.
    setData((prev) => ({
      live: (tab === 'past' ? null : value(0)) ?? prev?.live ?? [],
      upcoming: (tab === 'past' ? null : value(1)) ?? prev?.upcoming ?? [],
      past: (tab === 'past' ? value(0) : null) ?? prev?.past ?? [],
      failed,
    }));
  }, [tab]);

  useEffect(() => {
    void load();
    const timer =
      tab === 'past' ? null : setInterval(() => void load(), LIVE_REFRESH_MS);
    return () => {
      readId.current += 1;
      if (timer) clearInterval(timer);
    };
  }, [load, tab]);

  const personOf = useCallback(
    (userId: string): AvatarPerson => ({
      userId,
      name:
        userId === user?.id ? t('you') : (nameOf(userId) ?? t('unknownPerson')),
      avatarUrl: avatarOf(userId),
    }),
    [user?.id, nameOf, avatarOf, t]
  );

  const now = useMemo(() => new Date(clock ?? 0), [clock]);
  const current = loadedTab === tab ? data : null;
  const sections = useMemo(
    () =>
      hubSections(
        filterMeetings(current?.live ?? [], query, nameOf),
        filterMeetings(current?.upcoming ?? [], query, nameOf),
        now
      ),
    [current, query, nameOf, now]
  );
  const past = useMemo(
    () => filterMeetings(current?.past ?? [], query, nameOf),
    [current, query, nameOf]
  );

  const openSchedule = () => {
    setDialogKey((k) => k + 1);
    setDialogOpen(true);
  };

  const startNow = async () => {
    const name = firstName(profile?.full_name);
    const built = buildMeetingBody(
      {
        ...defaultMeetingForm(new Date(), timeZone),
        title: name ? t('instantTitle', { name }) : t('instantTitlePlain'),
        startNow: true,
      },
      { timeZone, now: new Date() }
    );
    if (!built.ok) return;
    setStarting(true);
    try {
      const res = await fetch('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(built.body),
      });
      if (!res.ok) throw new Error(String(res.status));
      const json = (await res.json()) as { meeting?: unknown };
      const saved = parseMeeting(json.meeting);
      if (!saved) throw new Error('no meeting');
      router.push(`/meetings/${saved.id}/room`);
    } catch {
      toast.error(t('startFailed'));
      setStarting(false);
    }
  };

  const shared: Shared = {
    now,
    locale,
    timeZone,
    activeMeetingId: inCall?.meetingId ?? null,
    personOf,
  };
  const startButton = (
    <Button
      onClick={() => void startNow()}
      disabled={starting || !!inCall}
      title={inCall ? t('alreadyInCall') : undefined}
    >
      <Video className="size-4" aria-hidden />
      {t('startNow')}
    </Button>
  );
  const scheduleButton = (
    <Button variant="outline" onClick={openSchedule}>
      <CalendarPlus className="size-4" aria-hidden />
      {t('schedule')}
    </Button>
  );
  const searching = query.trim().length > 0;
  const nothingAtAll =
    !!current &&
    current.live.length + current.upcoming.length === 0 &&
    !current.failed;
  const noMatches =
    searching &&
    (tab === 'past'
      ? past.length === 0
      : sections.live.length + sections.upcoming.length === 0);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 p-4 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
          <p className="text-muted-foreground min-h-5 text-sm">
            {clock !== null &&
              new Intl.DateTimeFormat(locale, {
                timeZone,
                dateStyle: 'full',
              }).format(now)}
          </p>
        </div>
        {canCreate && (
          <div className="flex flex-wrap gap-2">
            {startButton}
            {scheduleButton}
          </div>
        )}
      </header>

      {inCall && (
        <div className="border-success/40 bg-card dark:bg-success-soft flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3">
          <LiveDot />
          <p className="min-w-0 flex-1 truncate text-sm font-medium">
            {t('inCallBanner', { title: inCall.call.meeting?.title ?? '' })}
          </p>
          <Link
            href={`/meetings/${inCall.meetingId}/room`}
            className={buttonVariants({ size: 'sm' })}
          >
            {t('returnToMeeting')}
          </Link>
        </div>
      )}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <nav
          className="bg-card-2 flex gap-1 rounded-lg p-1"
          aria-label={t('title')}
        >
          {(['schedule', 'past'] as const).map((k) => (
            <Link
              key={k}
              href={k === 'past' ? '/meetings?scope=past' : '/meetings'}
              aria-current={tab === k ? 'page' : undefined}
              className={cn(
                'focus-visible:ring-ring/50 rounded-md px-3 py-1 text-sm transition-colors outline-none focus-visible:ring-3',
                tab === k
                  ? 'bg-primary-soft text-primary font-medium'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {t(`tabs.${k}`)}
            </Link>
          ))}
        </nav>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          <JoinByLink />
          <div className="relative w-full sm:w-56">
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
      </div>

      {current?.failed && (
        <ErrorState
          message={t('loadFailed')}
          onRetry={() => void load()}
          className="min-h-0 py-4"
        />
      )}

      {!current ? (
        <LoadingState />
      ) : noMatches ? (
        <p className="text-muted-foreground text-sm">
          {t('noMatches', { query: query.trim() })}
        </p>
      ) : tab === 'past' ? (
        past.length === 0 ? (
          !current.failed && <EmptyState icon={Video} title={t('emptyPast')} />
        ) : (
          <ul className="space-y-2">
            {past.map((m) => (
              <PastRow key={m.id} meeting={m} shared={shared} />
            ))}
          </ul>
        )
      ) : nothingAtAll ? (
        <EmptyState
          icon={Video}
          title={t('welcomeTitle')}
          hint={canCreate ? t('welcomeBody') : t('welcomeGuest')}
          className="bg-card rounded-xl border-solid py-14"
        >
          {canCreate && (
            <div className="flex flex-wrap justify-center gap-2">
              {startButton}
              {scheduleButton}
            </div>
          )}
        </EmptyState>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="min-w-0 space-y-6">
            {sections.live.length > 0 && (
              <Section title={t('happeningNow')}>
                <ul
                  className={cn(
                    'grid grid-cols-1 gap-3',
                    sections.live.length > 1 && 'xl:grid-cols-2'
                  )}
                >
                  {sections.live.map((m) => (
                    <LiveCard key={m.id} meeting={m} shared={shared} />
                  ))}
                </ul>
              </Section>
            )}
            {sections.upcoming.length > 0 && (
              <Section title={t('comingUp')}>
                <div className="space-y-4">
                  {groupMeetingsByDay(sections.upcoming, now, timeZone).map(
                    (g) => (
                      <DayGroup
                        key={g.kind + (g.date ?? '')}
                        group={g}
                        shared={shared}
                      />
                    )
                  )}
                </div>
              </Section>
            )}
          </div>
          <NextUp
            meeting={sections.nextUp}
            shared={shared}
            action={canCreate ? scheduleButton : null}
          />
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

/** "2 h 15 min" from a countdown. */
function useSpanLabel() {
  const t = useTranslations('Meetings');
  return ({ days, hours, minutes }: CountdownParts) =>
    t('span', { days, hours, minutes });
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function JoinByLink() {
  const t = useTranslations('Meetings');
  const router = useRouter();
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const id = meetingIdFromLink(text);
    setInvalid(!id);
    if (id) router.push(`/meetings/${id}/room`);
  };

  return (
    <form onSubmit={submit} className="w-full space-y-1 sm:w-72">
      <div className="flex gap-2">
        <Input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setInvalid(false);
          }}
          placeholder={t('linkPlaceholder')}
          aria-label={t('linkPlaceholder')}
          aria-invalid={invalid}
        />
        <Button type="submit" variant="outline" disabled={!text.trim()}>
          {t('join')}
        </Button>
      </div>
      {invalid && (
        <p role="alert" className="text-destructive text-xs">
          {t('linkInvalid')}
        </p>
      )}
    </form>
  );
}

/** Join, or Return for the meeting this tab is already in. */
function JoinLink({ id, shared }: { id: string; shared: Shared }) {
  const t = useTranslations('Meetings');
  return (
    <Link
      href={`/meetings/${id}/room`}
      className={cn(buttonVariants({ size: 'sm' }), 'relative z-10 shrink-0')}
    >
      <Video className="size-4" aria-hidden />
      {shared.activeMeetingId === id ? t('return') : t('join')}
    </Link>
  );
}

/** Cancel and End stay on the detail page, which owns their confirm. */
function useMeetingMenu(
  ref: RefObject<HTMLLIElement | null>,
  id: string,
  joinable: boolean
) {
  const t = useTranslations('Meetings');
  const td = useTranslations('Meetings.detail');
  const tMenu = useTranslations('ContextMenu');
  const router = useRouter();
  useContextMenuItems(ref, (): ContextMenuEntry[] => [
    ...(joinable
      ? [
          {
            id: 'join',
            label: t('join'),
            icon: Video,
            onSelect: () => router.push(`/meetings/${id}/room`),
          },
        ]
      : []),
    {
      id: 'open',
      label: tMenu('schedule.openDetails'),
      icon: ExternalLink,
      onSelect: () => router.push(`/meetings/${id}`),
    },
    {
      id: 'copyLink',
      label: td('copyLink'),
      icon: Link2,
      onSelect: () =>
        void copyWithToast(`${window.location.origin}/meetings/${id}`, {
          copied: td('linkCopied'),
          failed: td('copyFailed'),
        }),
    },
  ]);
}

function LiveCard({
  meeting: m,
  shared,
}: {
  meeting: MeetingSummary;
  shared: Shared;
}) {
  const t = useTranslations('Meetings');
  const ref = useRef<HTMLLIElement>(null);
  useMeetingMenu(ref, m.id, true);
  const people = m.present.map((p) => shared.personOf(p.userId));
  const elapsed = liveElapsedMs(m, shared.now);
  const hidden = m.presentCount - Math.min(2, people.length);
  const names = people
    .slice(0, 2)
    .map((p) => p.name)
    .join(', ');
  return (
    <li
      ref={ref}
      className="bg-card border-success/40 relative flex min-w-0 flex-col gap-3 rounded-xl border p-4"
    >
      <div className="flex items-start gap-2">
        <span className="mt-1.5">
          <LiveDot />
        </span>
        <Link
          href={`/meetings/${m.id}`}
          className="min-w-0 flex-1 truncate font-semibold after:absolute after:inset-0"
        >
          {m.title}
        </Link>
        {elapsed !== null && (
          <span className="text-success shrink-0 text-sm font-medium tabular-nums">
            {t('duration', durationParts(elapsed))}
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        <AvatarStack
          people={people}
          moreLabel={(n) => t('more', { count: n })}
        />
        <p className="text-muted-foreground min-w-0 flex-1 truncate text-sm">
          {names}
          {hidden > 0 && ` ${t('more', { count: hidden })}`}
        </p>
        <JoinLink id={m.id} shared={shared} />
      </div>
    </li>
  );
}

function DayGroup({
  group: g,
  shared,
}: {
  group: MeetingDayGroup;
  shared: Shared;
}) {
  const t = useTranslations('Meetings');
  const title =
    g.kind === 'date' && g.date
      ? formatMeetingDay(g.date, shared.locale)
      : t(`groups.${g.kind === 'date' ? 'unscheduled' : g.kind}`);
  return (
    <div className="space-y-2">
      <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
        {title}
      </h3>
      <ul className="space-y-2">
        {g.meetings.map((m) => (
          <UpcomingRow key={m.id} meeting={m} shared={shared} />
        ))}
      </ul>
    </div>
  );
}

function UpcomingRow({
  meeting: m,
  shared,
}: {
  meeting: MeetingSummary;
  shared: Shared;
}) {
  const t = useTranslations('Meetings');
  const spanLabel = useSpanLabel();
  const ref = useRef<HTMLLIElement>(null);
  const badge = upcomingBadge(m, shared.now);
  const due = badge === 'due';
  useMeetingMenu(ref, m.id, due);
  const clock = new Intl.DateTimeFormat(shared.locale, {
    timeZone: shared.timeZone,
    hour: '2-digit',
    minute: '2-digit',
  });
  const length =
    m.scheduledStart && m.scheduledEnd
      ? Date.parse(m.scheduledEnd) - Date.parse(m.scheduledStart)
      : null;
  return (
    <li
      ref={ref}
      className="bg-card hover:border-primary/40 relative flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border p-3 transition-colors sm:flex-nowrap"
    >
      <div className="w-20 shrink-0 text-center">
        {m.scheduledStart ? (
          <p className="text-base leading-tight font-semibold whitespace-nowrap tabular-nums">
            {clock.format(new Date(m.scheduledStart))}
          </p>
        ) : (
          <Video className="text-muted-foreground mx-auto size-5" aria-hidden />
        )}
        {length !== null && length > 0 && (
          <p className="text-muted-foreground text-xs">
            {t('duration', durationParts(length))}
          </p>
        )}
      </div>
      <div className="min-w-40 flex-1">
        <Link
          href={`/meetings/${m.id}`}
          className="block truncate font-medium after:absolute after:inset-0"
        >
          {m.title}
        </Link>
        <p className="text-muted-foreground truncate text-sm">
          {t('hostedBy', { name: shared.personOf(m.hostUserId).name })}
        </p>
      </div>
      <AvatarStack
        people={m.inviteeUserIds.map(shared.personOf)}
        moreLabel={(n) => t('more', { count: n })}
      />
      {badge === 'soon' && m.scheduledStart && (
        <span className="bg-primary-soft text-primary shrink-0 rounded-full px-2 py-0.5 text-xs font-medium">
          {t('startsIn', {
            span: spanLabel(countdownParts(m.scheduledStart, shared.now)),
          })}
        </span>
      )}
      {due && (
        <>
          <span className="bg-warning-soft text-warning shrink-0 rounded-full px-2 py-0.5 text-xs font-medium">
            {t('due')}
          </span>
          <JoinLink id={m.id} shared={shared} />
        </>
      )}
    </li>
  );
}

function NextUp({
  meeting: m,
  shared,
  action,
}: {
  meeting: MeetingSummary | null;
  shared: Shared;
  action: ReactNode;
}) {
  const t = useTranslations('Meetings');
  const spanLabel = useSpanLabel();
  const left = m?.scheduledStart
    ? countdownParts(m.scheduledStart, shared.now)
    : null;
  return (
    <aside className="bg-card h-fit space-y-3 rounded-xl border p-4">
      <h2 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
        {t('nextUp')}
      </h2>
      {!m || !left ? (
        <div className="space-y-3 py-2 text-center">
          <CalendarDays
            className="text-muted-foreground mx-auto size-5"
            aria-hidden
          />
          <p className="text-muted-foreground text-sm">{t('nothingNext')}</p>
          {action}
        </div>
      ) : (
        <>
          <p className="text-primary text-2xl font-bold tracking-tight">
            {left.past ? t('due') : t('countdown', { span: spanLabel(left) })}
          </p>
          <div>
            <p className="truncate font-medium">{m.title}</p>
            <p className="text-muted-foreground text-sm">
              {formatMeetingWhen(m, shared)}
            </p>
          </div>
          <AvatarStack
            people={[m.hostUserId, ...m.inviteeUserIds].map(shared.personOf)}
            moreLabel={(n) => t('more', { count: n })}
          />
          {meetingDisplayStatus(m, shared.now) === 'due' ? (
            <JoinLink id={m.id} shared={shared} />
          ) : (
            <Link
              href={`/meetings/${m.id}`}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              {t('open')}
            </Link>
          )}
        </>
      )}
    </aside>
  );
}

function PastRow({
  meeting: m,
  shared,
}: {
  meeting: MeetingSummary;
  shared: Shared;
}) {
  const t = useTranslations('Meetings');
  const ref = useRef<HTMLLIElement>(null);
  useMeetingMenu(ref, m.id, false);
  const ms = meetingDurationMs(m);
  const day = m.scheduledStart ?? m.endedAt ?? m.createdAt;
  const facts = [
    day &&
      new Intl.DateTimeFormat(shared.locale, {
        timeZone: shared.timeZone,
        dateStyle: 'medium',
      }).format(new Date(day)),
    ms !== null && t('duration', durationParts(ms)),
    m.attendedCount !== undefined && t('attended', { count: m.attendedCount }),
  ].filter(Boolean);
  return (
    <li
      ref={ref}
      className="bg-card flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border p-3"
    >
      <div className="min-w-40 flex-1">
        <p className="truncate font-medium">{m.title}</p>
        <p className="text-muted-foreground truncate text-sm">
          {facts.join(' · ')}
        </p>
      </div>
      <Link
        href={`/meetings/${m.id}`}
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'sm' }),
          'shrink-0'
        )}
      >
        {t('viewSummary')}
      </Link>
    </li>
  );
}
