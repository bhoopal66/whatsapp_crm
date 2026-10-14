'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Phone, PhoneMissed } from 'lucide-react';

import { CallReport } from '@/components/calls/call-report';
import { ShareCallButton } from '@/components/chat/share-to-chat-dialog';
import { Colleagues } from '@/components/calls/colleagues';
import { Keypad } from '@/components/calls/keypad';
import { MyStatus } from '@/components/calls/my-status';
import { CallButton } from '@/components/pbx/call-button';
import { useCalls } from '@/components/pbx/call-provider';
import { useAuth } from '@/hooks/use-auth';
import { PBX_ROUTES_HREF } from '@/lib/pbx/admin-ui';
import {
  UNROUTED_SUMMARY_DAYS,
  callBackFor,
  messageWhen,
  shownCallsTab,
  visibleCallTabs,
  callsListReady,
  type CallsTab,
} from '@/lib/pbx/call-ui';
import type { UnroutedNumber } from '@/lib/pbx/calls';
import {
  callHeading,
  callTone,
  missedTaskFor,
  missedWindowStart,
  splitCallLog,
  type Part,
  type TimelineCall,
  type TimelineTask,
} from '@/lib/pbx/timeline';
import { cn } from '@/lib/utils';

type CallRow = TimelineCall & {
  contactId: string | null;
  contactName: string | null;
  remoteNumber: string | null;
  doNotContactAt: string | null;
  doNotContactReason: string | null;
  /** The number the customer dialled (calls.did_number). */
  didNumber?: string | null;
};
interface Loaded {
  tab: CallsTab;
  calls: CallRow[];
  tasks: TimelineTask[];
  /** Unrouted: the dialled numbers, summed over every such call. */
  numbers: UnroutedNumber[];
  failed: boolean;
}

const getJson = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  });

export function CallsView({ tab: requested }: { tab: CallsTab }) {
  const t = useTranslations('CallsPage');
  const tl = useTranslations('CustomerTimeline');
  const locale = useLocale();
  const { accountRole } = useAuth();
  const hasPhone = Boolean(useCalls()?.me);
  // A direct link to a tab this role is not offered (the API would
  // refuse it) shows Missed calls, as an unknown ?tab= does.
  const tab = shownCallsTab(requested, accountRole);
  const timeZone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    []
  );
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  const listReady = callsListReady(tab, accountRole);
  useEffect(() => {
    // The report tab loads its own figures; Unrouted waits for the role.
    if (!listReady) return;
    let cancelled = false;
    const calls =
      tab === 'missed'
        ? `/api/pbx/calls?scope=missed&limit=200&from=${encodeURIComponent(
            missedWindowStart(Date.now())
          )}`
        : tab === 'unrouted'
          ? '/api/pbx/calls?scope=unrouted&limit=200'
          : '/api/pbx/calls?scope=all&limit=200';
    Promise.all([
      getJson(calls),
      tab === 'missed'
        ? getJson('/api/tasks?scope=all&status=all&limit=200').catch(() => ({
            tasks: [],
          }))
        : { tasks: [] },
    ])
      .then(([c, k]) => {
        if (!cancelled)
          setLoaded({
            tab,
            calls: c.calls ?? [],
            tasks: k.tasks ?? [],
            numbers: c.numbers ?? [],
            failed: false,
          });
      })
      .catch(() => {
        if (!cancelled)
          setLoaded({ tab, calls: [], tasks: [], numbers: [], failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [tab, listReady]);

  const say = (p: Part) =>
    typeof p === 'string' ? p : tl(p.key as never, p.values as never);
  const current = loaded?.tab === tab ? loaded : null;

  const row = (c: CallRow) => {
    const h = callHeading(c, { timeZone, locale });
    const task =
      tab === 'missed' ? missedTaskFor(c.id, current?.tasks ?? []) : null;
    const missed = callTone(c) === 'missed';
    const Icon = missed ? PhoneMissed : Phone;
    const who = c.contactName || c.remoteNumber || t('unknownCaller');
    const back = missed ? callBackFor(c, accountRole) : null;
    const details = [say(h.label), ...h.details.map(say)];
    // An erased call keeps the number dialled, not the caller's.
    if (tab === 'unrouted' && c.didNumber)
      details.push(t('unrouted.dialled', { number: c.didNumber }));
    return (
      <li
        key={c.id}
        className="border-border flex items-center gap-3 border-b px-4 py-3 last:border-b-0"
      >
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-xl',
            missed
              ? 'bg-red-100 text-red-600 [[data-mode=dark]_&]:bg-red-950 [[data-mode=dark]_&]:text-red-300'
              : 'bg-emerald-100 text-emerald-700 [[data-mode=dark]_&]:bg-emerald-950 [[data-mode=dark]_&]:text-emerald-300'
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
        {task && (
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-xs',
              task.status === 'open'
                ? 'bg-amber-100 text-amber-900 [[data-mode=dark]_&]:bg-amber-950 [[data-mode=dark]_&]:text-amber-200'
                : 'bg-muted text-muted-foreground'
            )}
          >
            {task.status === 'open' ? t('taskOpen') : t('taskDone')}
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
        <ShareCallButton callId={c.id} recordingState={c.recordingState} />
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
    current && (tab === 'log' || tab === 'unrouted')
      ? splitCallLog(current.calls, Date.now(), timeZone)
      : null;

  // Which numbers want a route, with a way to add one (admins only see
  // this tab, and only they edit routes).
  const numbers = tab === 'unrouted' &&
    current &&
    current.numbers.length > 0 && (
      <section className="border-border bg-card overflow-hidden rounded-xl border">
        <h2 className="border-border text-muted-foreground flex flex-wrap items-baseline justify-between gap-x-3 border-b px-4 py-2 text-xs font-semibold tracking-wide uppercase">
          {t('unrouted.numbersTitle')}
          <span className="font-normal tracking-normal normal-case">
            {t('unrouted.numbersWindow', { days: UNROUTED_SUMMARY_DAYS })}
          </span>
        </h2>
        <ul>
          {current.numbers.map((n) => (
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
    <div className="mx-auto w-full max-w-4xl space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">{t('title')}</h1>
        <MyStatus />
      </div>
      <nav className="flex gap-2" aria-label={t('title')}>
        {visibleCallTabs(accountRole, hasPhone).map((k) => (
          <Link
            key={k}
            href={k === 'missed' ? '/calls' : `/calls?tab=${k}`}
            aria-current={tab === k ? 'page' : undefined}
            className={cn(
              'rounded-full border px-3 py-1 text-sm',
              tab === k
                ? 'bg-foreground text-background border-transparent'
                : 'border-border text-muted-foreground hover:bg-muted'
            )}
          >
            {t(`tabs.${k}`)}
          </Link>
        ))}
      </nav>
      {tab === 'missed' && (
        <p className="text-muted-foreground text-sm">{t('missedHint')}</p>
      )}
      {tab === 'unrouted' && (
        <p className="text-muted-foreground text-sm">{t('unrouted.hint')}</p>
      )}
      {tab === 'keypad' ? (
        <Keypad />
      ) : tab === 'colleagues' ? (
        <Colleagues />
      ) : tab === 'people' ? (
        <CallReport />
      ) : !current ? (
        <div className="bg-muted h-24 animate-pulse rounded-xl" aria-hidden />
      ) : current.failed ? (
        <p className="text-destructive text-sm">{t('loadFailed')}</p>
      ) : current.calls.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {tab === 'missed'
            ? t('emptyMissed')
            : tab === 'unrouted'
              ? t('unrouted.empty')
              : t('emptyLog')}
        </p>
      ) : split ? (
        <>
          {numbers}
          {list(split.today, t('today'))}
          {list(split.older, t('older'))}
        </>
      ) : (
        list(current.calls)
      )}
    </div>
  );
}
