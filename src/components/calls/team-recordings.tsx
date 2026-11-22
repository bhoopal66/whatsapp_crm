'use client';

// Team call recordings (/calls/recordings): a team leader, an admin or a
// call reviewer (migration 198, treated as an admin here) picks
// a period, team, person, direction, minimum length or a number, and
// gets a per-person summary and the recorded calls by day, each
// playable with the Calls list's player (which logs every play and
// refuses held or expired audio). Browse and listen only: nothing about
// a review is stored. Every filter lives in the URL, so a link opens
// the same view. The route (GET /api/pbx/calls/recordings) scopes the
// people; this page never widens what it gets back.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  AudioLines,
  ChevronLeft,
  ChevronRight,
  PhoneIncoming,
  PhoneOutgoing,
  RefreshCw,
  X,
} from 'lucide-react';

import {
  CallRecordingPanel,
  CallRecordingToggle,
} from '@/components/calls/call-recording';
import { BackLink } from '@/components/layout/back-link';
import { useAuth } from '@/hooks/use-auth';
import { canViewAllCalls } from '@/lib/auth/roles';
import { checkCustomDays } from '@/lib/pbx/call-report';
import { formatDuration } from '@/lib/pbx/call-stats';
import { mergeCalls, periodButtons } from '@/lib/pbx/call-stats-ui';
import { OUTCOMES, newContactPhone } from '@/lib/pbx/call-ui';
import { listPlayerOffered, nextOpenPlayer } from '@/lib/pbx/list-player';
import { clock, dayKey } from '@/lib/pbx/timeline';
import {
  NUMBER_SEARCH_MIN,
  RECORDING_DIRECTIONS,
  TALK_FILTERS,
  type TeamRecordingCall,
  type TeamRecordingsResponse,
} from '@/lib/pbx/team-recordings';
import {
  DEFAULT_SUMMARY_SORT,
  dayHeading,
  groupRecordingsByDay,
  nextSort,
  numberSearch,
  peopleOfTeam,
  readRecordingsParams,
  recordingsQuery,
  recordingsSearch,
  sortSummary,
  summaryRows,
  type RecordingsParams,
  type SummarySortKey,
  dayPeriod,
  pickedDay,
  shiftDay,
} from '@/lib/pbx/team-recordings-ui';
import { cn } from '@/lib/utils';

/** The number box's pause before it narrows the list. */
const SEARCH_DEBOUNCE_MS = 400;

const TALK_LABEL: Record<number, string> = {
  0: 'any',
  30: 's30',
  60: 'm1',
  180: 'm3',
  300: 'm5',
};

const COLUMNS: { key: SummarySortKey; label: string; numeric: boolean }[] = [
  { key: 'name', label: 'person', numeric: false },
  { key: 'calls', label: 'calls', numeric: true },
  { key: 'answered', label: 'answered', numeric: true },
  { key: 'recorded', label: 'recorded', numeric: true },
  { key: 'recordedSeconds', label: 'recordedTime', numeric: true },
  { key: 'avgSeconds', label: 'avgRecording', numeric: true },
  { key: 'longestSeconds', label: 'longest', numeric: true },
  { key: 'lastRecordedAt', label: 'lastRecording', numeric: false },
];

interface Loaded {
  /** The query this answers: a filter change makes it stale. */
  key: string;
  data: TeamRecordingsResponse | null;
  error: 'forbidden' | 'failed' | null;
}

const chip = (on: boolean) =>
  cn(
    'focus-visible:ring-ring/50 rounded-full border px-3 py-1 text-sm transition-colors outline-none focus-visible:ring-3',
    on
      ? 'border-primary/40 bg-primary-soft text-primary font-medium'
      : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground'
  );

const selectClass =
  'border-input bg-card text-foreground dark:bg-input/30 max-w-[14rem] rounded-md border px-2 py-1 text-sm';

export function TeamRecordings() {
  const t = useTranslations('TeamRecordings');
  const tStats = useTranslations('CallStatsPage');
  const tOutcome = useTranslations('PbxCall.outcomes');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const { accountRole, reviewsAllCalls } = useAuth();
  // Every person's calls: owners, admins and call reviewers (198).
  const seesAll =
    reviewsAllCalls || (!!accountRole && canViewAllCalls(accountRole));

  const params = useMemo(
    () => readRecordingsParams((k) => search.get(k)),
    [search]
  );
  const setParams = useCallback(
    (patch: Partial<RecordingsParams>) => {
      const qs = recordingsSearch({ ...params, ...patch });
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router]
  );

  const [tz] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  );
  const query = recordingsQuery(params, tz);

  // ---------- Loading ----------
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reload, setReload] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [calls, setCalls] = useState<TeamRecordingCall[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const [openPlayer, setOpenPlayer] = useState<string | null>(null);
  // When the last page-1 load settled: the day picker's "today" (read
  // there, not during render, and kept current by Refresh).
  const [settledAt, setSettledAt] = useState<number | null>(null);
  const queryRef = useRef(query);
  useEffect(() => {
    queryRef.current = query;
  }, [query]);
  // Bumped when a page-1 load starts (filters or Refresh) and when a Load
  // more starts: a Load more response is kept only if neither happened since.
  const loadGen = useRef(0);
  const moreGen = useRef(0);

  useEffect(() => {
    if (!query) return;
    let live = true;
    loadGen.current += 1;
    fetch(`/api/pbx/calls/recordings?${query}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 403 ? 'forbidden' : 'failed');
        return (await r.json()) as TeamRecordingsResponse;
      })
      .then(
        (data) => {
          if (!live) return;
          setLoaded({ key: query, data, error: null });
          setCalls(data.calls);
          setNext(data.next);
          setMoreFailed(false);
        },
        (err: Error) => {
          if (!live) return;
          setLoaded({
            key: query,
            data: null,
            error: err.message === 'forbidden' ? 'forbidden' : 'failed',
          });
          setCalls([]);
          setNext(null);
        }
      )
      .finally(() => {
        if (!live) return;
        setRefreshing(false);
        setSettledAt(Date.now());
      });
    return () => {
      live = false;
    };
  }, [query, reload]);

  const current = loaded && loaded.key === query ? loaded : null;
  const data = current?.data ?? null;

  const loadMore = () => {
    if (!next || !query) return;
    const asked = query;
    const gen = loadGen.current;
    const mine = ++moreGen.current;
    const stale = () =>
      queryRef.current !== asked ||
      loadGen.current !== gen ||
      moreGen.current !== mine;
    setLoadingMore(true);
    setMoreFailed(false);
    fetch(`/api/pbx/calls/recordings?${recordingsQuery(params, tz, next)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return (await r.json()) as TeamRecordingsResponse;
      })
      .then(
        (page) => {
          // A filter change, a Refresh or a newer Load more: drop it.
          if (stale()) return;
          setCalls((c) => mergeCalls(c, page.calls));
          setNext(page.next);
        },
        () => {
          if (!stale()) setMoreFailed(true);
        }
      )
      .finally(() => {
        if (moreGen.current === mine) setLoadingMore(false);
      });
  };

  // ---------- Filters ----------
  const [customOpen, setCustomOpen] = useState(false);
  const [draft, setDraft] = useState({
    from: params.from ?? '',
    to: params.to ?? '',
  });
  const shownPeriod = customOpen ? 'custom' : params.period;

  const [box, setBox] = useState(params.q ?? '');
  const boxRef = useRef(params.q);
  useEffect(() => {
    const sendable = numberSearch(box);
    if (sendable === null) return;
    const q = sendable || null;
    if (q === boxRef.current) return;
    const id = setTimeout(() => {
      boxRef.current = q;
      setParams({ q });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [box, setParams]);

  const people = useMemo(() => data?.people ?? [], [data]);
  const teams = useMemo(() => data?.teams ?? [], [data]);
  const pickable = peopleOfTeam(people, teams, params.team);
  const personName = (id: string | null) =>
    people.find((p) => p.userId === id)?.name ?? t('unnamed');

  // ---------- By person ----------
  const [sort, setSort] = useState(DEFAULT_SUMMARY_SORT);
  const rows = useMemo(
    () =>
      data
        ? sortSummary(
            summaryRows(data.summary, data.people, data.teams),
            sort.key,
            sort.dir
          )
        : [],
    [data, sort]
  );

  const days = useMemo(
    () => groupRecordingsByDay(calls, data?.range.timeZone ?? tz),
    [calls, data, tz]
  );

  const at = (iso: string) =>
    new Intl.DateTimeFormat(locale, {
      timeZone: data?.range.timeZone ?? tz,
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));

  // ---------- Pieces ----------
  const header = (
    <div className="space-y-3">
      <BackLink fallbackHref="/calls" fallbackLabel={tStats('back')} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setRefreshing(true);
            setReload((n) => n + 1);
          }}
          disabled={!query || refreshing}
          className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm disabled:opacity-50"
        >
          <RefreshCw
            className={cn('size-4', refreshing && 'animate-spin')}
            aria-hidden
          />
          {refreshing ? tStats('refreshing') : tStats('refresh')}
        </button>
      </div>
    </div>
  );

  const customProblem = checkCustomDays(draft.from, draft.to);
  // The day picker: one day at a time, in the account's zone (the
  // route's answer, else the viewer's until it lands).
  const today =
    settledAt === null ? null : dayKey(settledAt, data?.range.timeZone ?? tz);
  const picked = customOpen || !today ? null : pickedDay(params, today);
  const goToDay = (day: string) => {
    if (!today || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
    setCustomOpen(false);
    setParams(dayPeriod(day, today));
  };
  const dayButton =
    'border-border bg-card hover:bg-accent text-muted-foreground inline-flex size-8 items-center justify-center rounded-md border transition-colors disabled:pointer-events-none disabled:opacity-40';
  const filters = (
    <div className="border-border bg-card space-y-3 rounded-xl border p-3">
      <div className="flex flex-wrap items-center gap-2">
        {periodButtons(params.period).map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={shownPeriod === p}
            onClick={() => {
              if (p === 'custom') return setCustomOpen(true);
              setCustomOpen(false);
              setParams({ period: p, from: null, to: null });
            }}
            className={chip(shownPeriod === p)}
          >
            {tStats(`periods.${p}`)}
          </button>
        ))}
        <div className="flex items-center gap-1 sm:ml-auto">
          <button
            type="button"
            className={dayButton}
            aria-label={t('filters.previousDay')}
            title={t('filters.previousDay')}
            disabled={!today}
            onClick={() => today && goToDay(shiftDay(picked ?? today, -1))}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </button>
          <label className="sr-only" htmlFor="team-recordings-day">
            {t('filters.day')}
          </label>
          <input
            id="team-recordings-day"
            type="date"
            value={picked ?? ''}
            max={today ?? undefined}
            disabled={!today}
            onChange={(e) => goToDay(e.target.value)}
            className={cn(
              'border-input bg-card text-foreground dark:bg-input/30 h-8 rounded-md border px-2 text-sm',
              picked && 'border-primary/40'
            )}
          />
          <button
            type="button"
            className={dayButton}
            aria-label={t('filters.nextDay')}
            title={t('filters.nextDay')}
            disabled={!picked || !today || picked >= today}
            onClick={() => picked && goToDay(shiftDay(picked, 1))}
          >
            <ChevronRight className="size-4" aria-hidden />
          </button>
        </div>
      </div>
      {(customOpen || (params.period === 'custom' && !query)) && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (customProblem) return;
            setCustomOpen(false);
            setParams({ period: 'custom', from: draft.from, to: draft.to });
          }}
        >
          {(['from', 'to'] as const).map((k) => (
            <label key={k} className="text-muted-foreground text-xs">
              {tStats(k)}
              <input
                type="date"
                value={draft[k]}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, [k]: e.target.value }))
                }
                className="border-input bg-card text-foreground dark:bg-input/30 mt-1 block rounded-md border px-2 py-1 text-sm"
              />
            </label>
          ))}
          <button
            type="submit"
            disabled={customProblem !== null}
            className="bg-primary text-primary-foreground hover:bg-primary-hover rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          >
            {tStats('apply')}
          </button>
          {customProblem && customProblem !== 'missing' && (
            <p className="text-destructive w-full text-xs">
              {tStats(`custom.${customProblem}`)}
            </p>
          )}
        </form>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {teams.length > 0 && (
          <label className="text-muted-foreground flex items-center gap-2 text-sm">
            {t('filters.team')}
            <select
              value={params.team ?? ''}
              onChange={(e) => {
                const team = e.target.value || null;
                const keep =
                  params.user &&
                  peopleOfTeam(people, teams, team).some(
                    (p) => p.userId === params.user
                  );
                setParams({ team, user: keep ? params.user : null });
              }}
              className={selectClass}
            >
              <option value="">
                {seesAll ? t('filters.allTeams') : t('filters.allMyTeams')}
              </option>
              {teams.map((tm) => (
                <option key={tm.id} value={tm.id}>
                  {tm.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="text-muted-foreground flex items-center gap-2 text-sm">
          {t('filters.person')}
          <select
            value={params.user ?? ''}
            onChange={(e) => setParams({ user: e.target.value || null })}
            className={selectClass}
          >
            <option value="">{t('filters.everyone')}</option>
            {params.user && !pickable.some((p) => p.userId === params.user) && (
              <option value={params.user}>
                {people.length ? personName(params.user) : '…'}
              </option>
            )}
            {pickable.map((p) => (
              <option key={p.userId} value={p.userId}>
                {p.name ?? t('unnamed')}
              </option>
            ))}
          </select>
        </label>
        <label className="text-muted-foreground flex items-center gap-2 text-sm">
          {t('filters.minTalk')}
          <select
            value={String(params.minTalk)}
            onChange={(e) => setParams({ minTalk: Number(e.target.value) })}
            className={selectClass}
          >
            {TALK_FILTERS.map((s) => (
              <option key={s} value={s}>
                {t(`filters.talk.${TALK_LABEL[s]}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-muted-foreground flex items-center gap-2 text-sm">
          {t('filters.number')}
          <input
            type="search"
            inputMode="tel"
            value={box}
            onChange={(e) => setBox(e.target.value)}
            placeholder={t('filters.numberPlaceholder')}
            className="border-input bg-card text-foreground dark:bg-input/30 w-40 rounded-md border px-2 py-1 text-sm"
          />
        </label>
        {numberSearch(box) === null && (
          <span className="text-muted-foreground text-xs">
            {t('filters.numberHint', { min: NUMBER_SEARCH_MIN })}
          </span>
        )}
      </div>
      <div
        role="group"
        aria-label={t('filters.direction')}
        className="flex flex-wrap items-center gap-2"
      >
        {RECORDING_DIRECTIONS.map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={params.direction === d}
            onClick={() => setParams({ direction: d })}
            className={chip(params.direction === d)}
          >
            {t(`filters.directions.${d}`)}
          </button>
        ))}
        {params.user && (
          <button
            type="button"
            onClick={() => setParams({ user: null })}
            className="border-primary/40 bg-primary-soft text-primary inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm font-medium sm:ml-auto"
            aria-label={t('clearPerson')}
          >
            {t('showing', { name: personName(params.user) })}
            <X className="size-3.5" aria-hidden />
          </button>
        )}
      </div>
    </div>
  );

  const sortIcon = (key: SummarySortKey) =>
    sort.key !== key ? null : sort.dir === 'asc' ? (
      <ArrowUp className="size-3" aria-hidden />
    ) : (
      <ArrowDown className="size-3" aria-hidden />
    );

  const summary = data && (
    <section className="border-border bg-card overflow-hidden rounded-xl border">
      <h2 className="border-border border-b px-4 py-2 text-sm font-semibold">
        {t('summary.title')}
      </h2>
      {data.summaryCapped && (
        <p className="text-muted-foreground border-border border-b px-4 py-2 text-xs">
          {t('summary.capped')}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="text-muted-foreground px-4 py-6 text-center text-sm">
          {t('summary.empty')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] text-sm">
            <thead>
              <tr className="border-border text-muted-foreground border-b text-xs">
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={
                      sort.key === c.key
                        ? sort.dir === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : undefined
                    }
                    className={cn(
                      'px-3 py-2 font-medium',
                      c.numeric ? 'text-right' : 'text-left'
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setSort((s) => nextSort(s, c.key))}
                      className={cn(
                        'hover:text-foreground inline-flex items-center gap-1',
                        sort.key === c.key && 'text-foreground'
                      )}
                    >
                      {t(`summary.columns.${c.label}`)}
                      {sortIcon(c.key)}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const selected = params.user === r.userId;
                return (
                  <tr
                    key={r.userId}
                    onClick={() =>
                      setParams({ user: selected ? null : r.userId })
                    }
                    aria-selected={selected}
                    className={cn(
                      'border-border cursor-pointer border-b tabular-nums last:border-b-0',
                      selected ? 'bg-primary-soft' : 'hover:bg-card-2'
                    )}
                  >
                    <td className="px-3 py-2 text-left">
                      <button
                        type="button"
                        className="text-left font-medium hover:underline"
                        aria-pressed={selected}
                      >
                        {r.name ?? t('unnamed')}
                      </button>
                      {r.teamNames.length > 0 && (
                        <p className="text-muted-foreground text-xs">
                          {r.teamNames.join(', ')}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">{r.calls}</td>
                    <td className="px-3 py-2 text-right">{r.answered}</td>
                    <td className="px-3 py-2 text-right font-medium">
                      {r.recorded}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {r.recorded ? formatDuration(r.recordedSeconds) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {formatDuration(r.avgSeconds)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {r.recorded ? formatDuration(r.longestSeconds) : '—'}
                    </td>
                    <td className="text-muted-foreground px-3 py-2 text-left">
                      {r.lastRecordedAt ? at(r.lastRecordedAt) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );

  const row = (c: TeamRecordingCall) => {
    const kind =
      c.direction === 'inbound' || c.direction === 'outbound'
        ? c.direction
        : 'internal';
    const Icon =
      kind === 'inbound'
        ? PhoneIncoming
        : kind === 'outbound'
          ? PhoneOutgoing
          : ArrowLeftRight;
    // The customer's number is shown whole, beside their name when known.
    const name = c.contactName?.trim() || null;
    const number = c.remoteNumber?.trim()
      ? newContactPhone(c.remoteNumber.trim())
      : null;
    const who = name || number || t('list.unknownNumber');
    const outcome =
      c.disposition && (OUTCOMES as readonly string[]).includes(c.disposition)
        ? tOutcome(c.disposition)
        : c.disposition;
    const playerOpen = openPlayer === c.id && listPlayerOffered(c);
    return (
      <li
        key={c.id}
        className="border-border border-b px-4 py-3 last:border-b-0"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-muted-foreground w-11 shrink-0 text-sm tabular-nums">
            {clock(c.startedAt, data?.range.timeZone ?? tz)}
          </span>
          <span
            className="bg-card-2 text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-lg"
            title={t(`list.direction.${kind}`)}
          >
            <Icon className="size-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1 basis-48">
            <p className="truncate text-sm">
              <span className="font-semibold">
                {c.userName?.trim() || t('unnamed')}
              </span>
              <span className="text-muted-foreground"> · </span>
              {c.contactId ? (
                <Link
                  href={`/contacts/${c.contactId}`}
                  className="hover:underline"
                >
                  {who}
                </Link>
              ) : (
                <span>{who}</span>
              )}
              {name && number && (
                <span className="text-muted-foreground tabular-nums">
                  {' '}
                  · {number}
                </span>
              )}
            </p>
            {c.notes && (
              <p
                className="text-muted-foreground truncate text-xs"
                title={c.notes}
              >
                {c.notes}
              </p>
            )}
          </div>
          <span className="text-sm tabular-nums">
            {formatDuration(c.talkSeconds)}
          </span>
          {outcome && (
            <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs">
              {outcome}
            </span>
          )}
          <CallRecordingToggle
            call={c}
            open={playerOpen}
            onToggle={() => setOpenPlayer((o) => nextOpenPlayer(o, c.id))}
          />
        </div>
        {playerOpen && <CallRecordingPanel call={c} />}
      </li>
    );
  };

  const loadMoreButton = next && (
    <button
      type="button"
      onClick={loadMore}
      disabled={loadingMore}
      className="border-border bg-card hover:bg-accent rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
    >
      {loadingMore ? t('list.loadingMore') : t('list.loadMore')}
    </button>
  );

  const list = data && (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold">{t('list.title')}</h2>
      {calls.length === 0 ? (
        <div className="border-border bg-card flex flex-col items-center gap-3 rounded-xl border border-dashed px-4 py-12 text-center">
          <span className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
            <AudioLines className="size-5" aria-hidden />
          </span>
          <p className="text-muted-foreground text-sm">{t('list.empty')}</p>
          {moreFailed && (
            <p className="text-destructive text-sm">{t('list.moreFailed')}</p>
          )}
          {loadMoreButton}
        </div>
      ) : (
        <>
          {days.map((d) => (
            <section
              key={d.key}
              className="border-border bg-card overflow-hidden rounded-xl border"
            >
              <h3 className="border-border text-muted-foreground border-b px-4 py-2 text-xs font-semibold tracking-wide uppercase">
                {dayHeading(d.key, locale)}
              </h3>
              <ul>{d.items.map(row)}</ul>
            </section>
          ))}
          <div className="flex flex-col items-center gap-2">
            <p className="text-muted-foreground text-xs">
              {t('list.shown', { count: calls.length })}
            </p>
            {moreFailed && (
              <p className="text-destructive text-sm">{t('list.moreFailed')}</p>
            )}
            {loadMoreButton}
          </div>
        </>
      )}
    </section>
  );

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-4 md:p-6">
      {header}
      {filters}
      {!query ? null : !current ? (
        <div className="space-y-4" aria-hidden>
          <div className="bg-muted h-40 animate-pulse rounded-xl" />
          <div className="bg-muted h-64 animate-pulse rounded-xl" />
        </div>
      ) : current.error ? (
        <div className="border-border bg-card flex flex-col items-center gap-3 rounded-xl border px-4 py-12 text-center">
          <p
            className={cn(
              'text-sm',
              current.error === 'forbidden'
                ? 'text-muted-foreground'
                : 'text-destructive'
            )}
          >
            {current.error === 'forbidden' ? t('forbidden') : t('failed')}
          </p>
          {current.error === 'failed' && (
            <button
              type="button"
              onClick={() => {
                setLoaded(null);
                setReload((n) => n + 1);
              }}
              className="border-border bg-card hover:bg-accent rounded-md border px-3 py-1.5 text-sm font-medium"
            >
              {t('retry')}
            </button>
          )}
        </div>
      ) : (
        <>
          {summary}
          {list}
        </>
      )}
    </div>
  );
}
