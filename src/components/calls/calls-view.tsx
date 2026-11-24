'use client';

import { EmptyState } from '@/components/dashboard/empty-state';
import { ErrorState } from '@/components/dashboard/error-state';
import { LoadingState } from '@/components/dashboard/loading-state';
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { AudioLines, BarChart3, Phone, PhoneMissed } from 'lucide-react';

import { CallReport } from '@/components/calls/call-report';
import {
  CallRecordingPanel,
  CallRecordingToggle,
} from '@/components/calls/call-recording';
import { ShareCallButton } from '@/components/chat/share-to-chat-dialog';
import { Colleagues } from '@/components/calls/colleagues';
import { Keypad } from '@/components/calls/keypad';
import { GroupsPanel } from '@/components/pbx/groups-panel';
import { VoicemailPanel } from '@/components/pbx/voicemail-panel';
import { MyStatus } from '@/components/calls/my-status';
import { CallButton } from '@/components/pbx/call-button';
import { useCalls } from '@/components/pbx/call-provider';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { canLeadTeam } from '@/lib/auth/roles';
import { PBX_ROUTES_HREF } from '@/lib/pbx/admin-ui';
import {
  UNROUTED_SUMMARY_DAYS,
  callBackFor,
  callsReach,
  callsTabLabel,
  messageWhen,
  shownCallsTab,
  visibleCallTabs,
  callsListReady,
  internalCallParty,
  liveKey,
  type CallsTab,
  type CallSides,
  type InternalSide,
} from '@/lib/pbx/call-ui';
import {
  callLeft,
  listReducer,
  loadCallsList,
  startCallsRefresh,
  type ListAction,
  type ListView,
} from '@/lib/pbx/calls-list';
import { listPlayerOffered, nextOpenPlayer } from '@/lib/pbx/list-player';
import {
  callHeading,
  callTone,
  splitCallLog,
  type Part,
  type TimelineCall,
} from '@/lib/pbx/timeline';
import { missedBadge, type MissedCallTask } from '@/lib/pbx/missed-tasks';
import { cn } from '@/lib/utils';

type CallRow = TimelineCall & {
  contactId: string | null;
  contactName: string | null;
  remoteNumber: string | null;
  doNotContactAt: string | null;
  doNotContactReason: string | null;
  /** The number the customer dialled (calls.did_number). */
  didNumber?: string | null;
  /** Internal calls only: both extensions and their people. */
  party?: CallSides;
  /** Missed calls only: the callback task, whoever holds it. */
  task?: MissedCallTask | null;
};
const getJson = (url: string) =>
  fetch(url, { cache: 'no-store' }).then((r) => {
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  });

export function CallsView({ tab: requested }: { tab: CallsTab }) {
  const t = useTranslations('CallsPage');
  const tl = useTranslations('CustomerTimeline');
  const locale = useLocale();
  const { accountRole, user, reviewsAllCalls } = useAuth();
  const phone = useCalls();
  const hasPhone = Boolean(phone?.me);
  // A direct link to a tab this role is not offered (the API would
  // refuse it, or it is not theirs) shows My calls, as an unknown ?tab=
  // does.
  const tab = shownCallsTab(requested, accountRole, undefined, reviewsAllCalls);
  // Missed calls are the viewer's own unless a leader, an admin or a
  // call reviewer (migration 198) turns the toggle to their team's or
  // everyone's.
  const reach = callsReach(accountRole, reviewsAllCalls);
  const tabs = visibleCallTabs(
    accountRole,
    hasPhone,
    undefined,
    reviewsAllCalls
  );
  const [wideToggle, setWide] = useState(false);
  const wide = wideToggle && reach !== 'mine';
  const timeZone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    []
  );
  const [view, dispatch] = useReducer(
    listReducer as (
      v: ListView<CallRow> | null,
      a: ListAction<CallRow>
    ) => ListView<CallRow> | null,
    null
  );
  // The one row whose recording player is open (lib/pbx/list-player).
  const [openPlayer, setOpenPlayer] = useState<string | null>(null);

  const listReady = callsListReady(tab, accountRole);
  const key = `${tab}:${wide}`;
  // One count for every read of the screen (listReducer).
  const seqRef = useRef(0);
  const refresh = useCallback(() => {
    // The report tab loads its own figures; Unrouted waits for the role.
    if (!listReady) return;
    const seq = ++seqRef.current;
    loadCallsList<CallRow>(tab, wide, Date.now(), getJson)
      .then((list) => list && dispatch({ type: 'loaded', key, seq, list }))
      .catch(() => dispatch({ type: 'failed', key, seq }));
  }, [key, listReady, tab, wide]);
  const refresher = useRef<ReturnType<typeof startCallsRefresh> | null>(null);
  useEffect(() => {
    refresh();
    const r = startCallsRefresh(refresh, document, window);
    refresher.current = r;
    return () => {
      refresher.current = null;
      r.stop();
    };
  }, [refresh]);

  // The caller's calls in progress, as the call layer follows call_live:
  // the one ringing and the panel's. Answering moves a call from the
  // first to the second, so only one that ended leaves.
  const ringing = phone?.ringing;
  const panel = phone?.panel;
  const liveKeys = [
    ...(ringing ? [liveKey(ringing)] : []),
    ...(panel && panel.endedAt === null ? [panel.key] : []),
  ].join('\n');
  const liveBefore = useRef(liveKeys);
  useEffect(() => {
    const split = (k: string) => (k ? k.split('\n') : []);
    if (callLeft(split(liveBefore.current), split(liveKeys)))
      refresher.current?.soon();
    liveBefore.current = liveKeys;
  }, [liveKeys]);

  const say = (p: Part) =>
    typeof p === 'string' ? p : tl(p.key as never, p.values as never);
  const current = view?.key === key ? view : null;
  const shown = current?.list ?? null;
  const last = shown?.calls.at(-1);
  const loadOlder = () => {
    if (!last || current?.older === 'loading') return;
    dispatch({ type: 'olderStarted', key });
    loadCallsList<CallRow>(tab, wide, Date.now(), getJson, last)
      .then(
        (list) => list && dispatch({ type: 'older', key, after: last.id, list })
      )
      .catch(() => dispatch({ type: 'olderFailed', key, after: last.id }));
  };

  const row = (c: CallRow) => {
    const h = callHeading(c, { timeZone, locale });
    const badge = c.task ? missedBadge(c.task) : null;
    const missed = callTone(c) === 'missed';
    const Icon = missed ? PhoneMissed : Phone;
    const internal =
      c.direction === 'internal'
        ? internalCallParty(c.party, user?.id ?? null)
        : null;
    const sideText = (s: InternalSide) =>
      'name' in s
        ? s.name
        : t('colleagueExtension', { extension: s.extension });
    const who =
      c.contactName ||
      c.remoteNumber ||
      (internal &&
        (internal.kind === 'one'
          ? sideText(internal.who)
          : t('colleaguePair', {
              from: sideText(internal.from),
              to: sideText(internal.to),
            }))) ||
      t('unknownCaller');
    const back = missed ? callBackFor(c, accountRole) : null;
    const details = [say(h.label), ...h.details.map(say)];
    // An erased call keeps the number dialled, not the caller's.
    if (tab === 'unrouted' && c.didNumber)
      details.push(t('unrouted.dialled', { number: c.didNumber }));
    const playerOpen = openPlayer === c.id && listPlayerOffered(c);
    return (
      <li
        key={c.id}
        className="border-border border-b px-4 py-3 last:border-b-0"
      >
        <div className="flex items-center gap-3">
          <span
            className={cn(
              'flex size-9 shrink-0 items-center justify-center rounded-xl',
              missed
                ? 'bg-destructive-soft text-destructive'
                : 'bg-success-soft text-success'
            )}
          >
            <Icon className="size-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            {c.contactId ? (
              <Link
                href={`/contacts/${c.contactId}`}
                className="font-semibold hover:underline"
              >
                {who}
              </Link>
            ) : (
              <span className="font-semibold">{who}</span>
            )}
            <p className="text-muted-foreground truncate text-sm">
              {details.join(' · ')}
            </p>
          </div>
          {badge && (
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-xs',
                c.task?.status === 'open'
                  ? 'bg-warning-soft text-warning font-medium'
                  : 'bg-muted text-muted-foreground'
              )}
            >
              {t(badge.key, { name: badge.name })}
            </span>
          )}
          {back && (
            <CallButton
              {...(back.kind === 'contact'
                ? { contact: back.contact }
                : { number: back.number })}
              label={tl('callBack')}
            />
          )}
          <CallRecordingToggle
            call={c}
            open={playerOpen}
            onToggle={() => setOpenPlayer((o) => nextOpenPlayer(o, c.id))}
          />
          <ShareCallButton callId={c.id} recordingState={c.recordingState} />
        </div>
        {playerOpen && <CallRecordingPanel call={c} />}
      </li>
    );
  };

  const list = (calls: CallRow[], title?: string) =>
    calls.length > 0 && (
      <section className="border-border bg-card overflow-hidden rounded-xl border">
        {title && (
          <h2 className="border-border text-muted-foreground border-b px-4 py-2 text-xs font-semibold tracking-wide uppercase">
            {title}
          </h2>
        )}
        <ul>{calls.map(row)}</ul>
      </section>
    );

  const split =
    shown && (tab === 'mine' || tab === 'log' || tab === 'unrouted')
      ? splitCallLog(shown.calls, Date.now(), timeZone)
      : null;

  // Which numbers want a route, with a way to add one (admins only see
  // this tab, and only they edit routes).
  const numbers = tab === 'unrouted' && shown && shown.numbers.length > 0 && (
    <section className="border-border bg-card overflow-hidden rounded-xl border">
      <h2 className="border-border text-muted-foreground flex flex-wrap items-baseline justify-between gap-x-3 border-b px-4 py-2 text-xs font-semibold tracking-wide uppercase">
        {t('unrouted.numbersTitle')}
        <span className="font-normal tracking-normal normal-case">
          {t('unrouted.numbersWindow', { days: UNROUTED_SUMMARY_DAYS })}
        </span>
      </h2>
      <ul>
        {shown.numbers.map((n) => (
          <li
            key={n.didNumber}
            className="border-border flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-3 last:border-b-0"
          >
            <div className="min-w-0 flex-1">
              <p className="font-semibold tabular-nums">{n.didNumber}</p>
              <p className="text-muted-foreground text-sm">
                {t('unrouted.numberCalls', {
                  count: n.calls,
                  last: messageWhen(n.lastAt, Date.now(), {
                    locale,
                    timeZone,
                  }),
                })}
              </p>
            </div>
            <Link
              href={PBX_ROUTES_HREF}
              className="text-primary text-sm font-medium hover:underline"
            >
              {t('unrouted.addRoute')}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/calls/report"
            className="border-border bg-card hover:bg-accent inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors"
          >
            <BarChart3 className="size-4" aria-hidden />
            {t('reportLink')}
          </Link>
          {accountRole && (canLeadTeam(accountRole) || reviewsAllCalls) && (
            <Link
              href="/calls/recordings"
              className="border-border bg-card hover:bg-accent inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors"
            >
              <AudioLines className="size-4" aria-hidden />
              {t('teamRecordingsLink')}
            </Link>
          )}
          <MyStatus />
        </div>
      </div>
      <nav className="flex flex-wrap gap-2" aria-label={t('title')}>
        {tabs.map((k) => (
          <Link
            key={k}
            href={k === 'mine' ? '/calls' : `/calls?tab=${k}`}
            aria-current={tab === k ? 'page' : undefined}
            className={cn(
              'focus-visible:ring-ring/50 rounded-full border px-3 py-1 text-sm transition-colors outline-none focus-visible:ring-3',
              tab === k
                ? 'border-primary/40 bg-primary-soft text-primary font-medium'
                : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            {t(`tabs.${callsTabLabel(k, accountRole, reviewsAllCalls)}`)}
          </Link>
        ))}
      </nav>
      {tab === 'mine' && (
        <p className="text-muted-foreground text-sm">{t('mineHint')}</p>
      )}
      {tab === 'missed' && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-muted-foreground text-sm">{t('missedHint')}</p>
          {reach !== 'mine' && (
            <div
              role="group"
              aria-label={t('missedWho.label')}
              className="border-border bg-card flex rounded-full border p-0.5 text-sm"
            >
              {([false, true] as const).map((w) => (
                <button
                  key={String(w)}
                  type="button"
                  aria-pressed={wide === w}
                  onClick={() => setWide(w)}
                  className={cn(
                    'rounded-full px-3 py-0.5',
                    wide === w
                      ? 'bg-primary-soft text-primary font-medium'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  )}
                >
                  {t(`missedWho.${w ? reach : 'mine'}`)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {tab === 'unrouted' && (
        <p className="text-muted-foreground text-sm">{t('unrouted.hint')}</p>
      )}
      {tab === 'keypad' ? (
        <Keypad />
      ) : tab === 'colleagues' ? (
        <Colleagues />
      ) : tab === 'voicemail' ? (
        <VoicemailPanel />
      ) : tab === 'groups' ? (
        <GroupsPanel />
      ) : tab === 'people' ? (
        <CallReport />
      ) : !current ? (
        <LoadingState />
      ) : !shown ? (
        <ErrorState message={t('loadFailed')} onRetry={refresh} />
      ) : shown.calls.length === 0 ? (
        <EmptyState
          icon={tab === 'missed' ? PhoneMissed : Phone}
          title={
            tab === 'missed'
              ? t(wide ? 'emptyMissed' : 'emptyMyMissed')
              : tab === 'unrouted'
                ? t('unrouted.empty')
                : t('emptyLog')
          }
          className="bg-card rounded-xl py-12"
        />
      ) : split ? (
        <>
          {numbers}
          {list(split.today, t('today'))}
          {list(split.older, t('older'))}
        </>
      ) : (
        list(shown.calls)
      )}
      {current?.stale && (
        <p role="status" className="text-muted-foreground text-sm">
          {t('refreshFailed')}
        </p>
      )}
      {shown?.truncated && (
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={current?.older === 'loading'}
            onClick={loadOlder}
          >
            {t(current?.older === 'loading' ? 'loadingOlder' : 'loadOlder')}
          </Button>
          {current?.older === 'failed' && (
            <p role="status" className="text-muted-foreground text-sm">
              {t('loadOlderFailed')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
