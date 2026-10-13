'use client';

import { useEffect, useMemo, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';

import { dayRange } from '@/lib/audit/consent';
import {
  AUDIT_SOURCES,
  type AuditFact,
  type NamedAuditRow,
} from '@/lib/audit/view';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { SettingsPanelHead } from './settings-panel-head';

const SELECT =
  'h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary';

/**
 * Settings → Audit log (admin+): GET /api/audit's merged list of the
 * team chat, recording, phone and deal room audit tables, newest
 * first, 50 a page, filtered by source, day range and person.
 */
export function AuditLogPanel() {
  const t = useTranslations('Settings.auditLog');
  const format = useFormatter();
  const [source, setSource] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [actor, setActor] = useState('');
  const [page, setPage] = useState(1);
  const [people, setPeople] = useState<
    { user_id: string; full_name: string }[]
  >([]);
  const query = useMemo(() => {
    const range = dayRange(from, to);
    const qs = new URLSearchParams({ page: String(page) });
    if (source !== 'all') qs.set('source', source);
    if (range.from) qs.set('from', range.from);
    if (range.to) qs.set('to', range.to);
    if (actor) qs.set('actor', actor);
    return qs.toString();
  }, [source, from, to, actor, page]);
  // The answer to a query; while it is not the current one, the list is
  // loading.
  const [answer, setAnswer] = useState<{
    query: string;
    result: { rows: NamedAuditRow[]; hasMore: boolean } | 'failed';
  } | null>(null);

  useEffect(() => {
    fetch('/api/account/members')
      .then((res) => res.json())
      .then((json) =>
        setPeople(Array.isArray(json.members) ? json.members : [])
      )
      .catch(() => {});
  }, []);

  useEffect(() => {
    let off = false;
    fetch(`/api/audit?${query}`, { cache: 'no-store' })
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok || !Array.isArray(json.rows)) throw new Error();
        if (!off)
          setAnswer({
            query,
            result: { rows: json.rows, hasMore: !!json.hasMore },
          });
      })
      .catch(() => {
        if (!off) setAnswer({ query, result: 'failed' });
      });
    return () => {
      off = true;
    };
  }, [query]);

  const state =
    answer?.query !== query
      ? ({ kind: 'loading' } as const)
      : answer.result === 'failed'
        ? ({ kind: 'failed' } as const)
        : ({ kind: 'ready', ...answer.result } as const);

  const filter = (set: (v: string) => void) => (v: string) => {
    set(v);
    setPage(1);
  };

  const action = (r: NamedAuditRow) => {
    const key = `actions.${r.source}.${r.action}`;
    return t.has(key as never)
      ? t(key as never)
      : r.action.replaceAll('_', ' ');
  };
  const fact = (f: AuditFact) =>
    f.key === 'change' || f.key === 'rename'
      ? t(`facts.${f.key}`, { from: f.from, to: f.to })
      : f.key === 'topic'
        ? t('facts.topic', {
            from: f.from ?? t('facts.noTopic'),
            to: f.to ?? t('facts.noTopic'),
          })
        : f.key === 'number'
          ? t('facts.number', { value: f.value })
          : t(`facts.${f.key}`, { count: f.count });

  return (
    <section className="animate-in fade-in-50 max-w-5xl space-y-5 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <div className="grid gap-3 sm:grid-cols-4">
        <div className="grid gap-1.5">
          <Label htmlFor="audit-source">{t('filters.source')}</Label>
          <select
            id="audit-source"
            className={SELECT}
            value={source}
            onChange={(e) => filter(setSource)(e.target.value)}
          >
            <option value="all">{t('filters.all')}</option>
            {AUDIT_SOURCES.map((s) => (
              <option key={s} value={s}>
                {t(`sources.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="audit-from">{t('filters.from')}</Label>
          <Input
            id="audit-from"
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => filter(setFrom)(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="audit-to">{t('filters.to')}</Label>
          <Input
            id="audit-to"
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => filter(setTo)(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="audit-person">{t('filters.person')}</Label>
          <select
            id="audit-person"
            className={SELECT}
            value={actor}
            onChange={(e) => filter(setActor)(e.target.value)}
          >
            <option value="">{t('filters.anyone')}</option>
            {people.map((p) => (
              <option key={p.user_id} value={p.user_id}>
                {p.full_name || p.user_id}
              </option>
            ))}
          </select>
        </div>
      </div>

      {state.kind === 'loading' ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" />
          {t('loading')}
        </p>
      ) : state.kind === 'failed' ? (
        <p className="text-destructive text-sm">{t('loadFailed')}</p>
      ) : state.rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <ul className="border-border divide-border divide-y rounded-xl border">
          {state.rows.map((r) => (
            <li key={r.key} className="grid gap-1 px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-muted-foreground tabular-nums">
                  {format.dateTime(new Date(r.at), {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </span>
                <span aria-hidden>·</span>
                <span className="text-foreground font-medium">
                  {r.actorName ??
                    (r.actorId ? t('unknownPerson') : t('system'))}
                </span>
                <span aria-hidden>·</span>
                <span className="text-foreground">{action(r)}</span>
                {r.item && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="text-foreground">
                      {r.itemLabel ?? t(`items.${r.item.kind}`)}
                    </span>
                  </>
                )}
                <span className="bg-muted text-muted-foreground ml-auto rounded px-1.5 py-0.5 text-xs">
                  {t(`sources.${r.source}`)}
                </span>
              </div>
              {(r.reason || r.facts.length > 0) && (
                <p className="text-muted-foreground break-words">
                  {[
                    r.reason ? t('reason', { reason: r.reason }) : null,
                    ...r.facts.map(fact),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center justify-between gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          <ChevronLeft className="size-4" />
          {t('newer')}
        </Button>
        <span className="text-muted-foreground text-sm">
          {t('page', { page })}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={state.kind !== 'ready' || !state.hasMore}
          onClick={() => setPage((p) => p + 1)}
        >
          {t('older')}
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </section>
  );
}
