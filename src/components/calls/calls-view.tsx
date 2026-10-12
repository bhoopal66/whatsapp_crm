'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Phone, PhoneMissed } from 'lucide-react';

import { Button } from '@/components/ui/button';
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

import { dialContact } from './dial';

type CallRow = TimelineCall & {
  contactId: string | null;
  contactName: string | null;
  remoteNumber: string | null;
};
type Tab = 'missed' | 'log';
interface Loaded {
  tab: Tab;
  calls: CallRow[];
  tasks: TimelineTask[];
  failed: boolean;
}

const getJson = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  });

export function CallsView({ tab }: { tab: Tab }) {
  const t = useTranslations('CallsPage');
  const tl = useTranslations('CustomerTimeline');
  const locale = useLocale();
  const timeZone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    []
  );
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let cancelled = false;
    const calls =
      tab === 'missed'
        ? `/api/pbx/calls?scope=missed&limit=200&from=${encodeURIComponent(
            missedWindowStart(Date.now())
          )}`
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
            failed: false,
          });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ tab, calls: [], tasks: [], failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [tab]);

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
            {[say(h.label), ...h.details.map(say)].join(' · ')}
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
        {missed && c.contactId && (
          <Button
            size="sm"
            className="bg-emerald-600 text-white hover:bg-emerald-700"
            onClick={() => dialContact(c.contactId as string, (k) => tl(k))}
          >
            {tl('callBack')}
          </Button>
        )}
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
    current && tab === 'log'
      ? splitCallLog(current.calls, Date.now(), timeZone)
      : null;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-4 md:p-6">
      <h1 className="text-xl font-bold">{t('title')}</h1>
      <nav className="flex gap-2" aria-label={t('title')}>
        {(['missed', 'log'] as const).map((k) => (
          <Link
            key={k}
            href={k === 'log' ? '/calls?tab=log' : '/calls'}
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
      {!current ? (
        <div className="bg-muted h-24 animate-pulse rounded-xl" aria-hidden />
      ) : current.failed ? (
        <p className="text-destructive text-sm">{t('loadFailed')}</p>
      ) : current.calls.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {tab === 'missed' ? t('emptyMissed') : t('emptyLog')}
        </p>
      ) : split ? (
        <>
          {list(split.today, t('today'))}
          {list(split.older, t('older'))}
        </>
      ) : (
        list(current.calls)
      )}
    </div>
  );
}
