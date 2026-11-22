'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { LevelIcon, StatusBadge } from '@/components/team-activity/shared';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { ruleMessage } from '@/lib/team-activity/blocked-send';
import {
  asRestriction,
  blocksByRule,
  isKnownRule,
  myBlocks,
  mySenderRow,
  myUnlocks,
  type MyBlock,
  type MyUnlock,
  type UnlockStatus,
} from '@/lib/team-activity/my-activity';
import type { RangePreset } from '@/lib/team-activity/range';
import type { TeamActivityReport } from '@/lib/team-activity/report';
import {
  findingArgs,
  senderFindings,
  statusOf,
  type Finding,
} from '@/lib/team-activity/risk';
import { cn } from '@/lib/utils';

const PERIODS = [
  'today',
  '7d',
  '30d',
] as const satisfies readonly RangePreset[];

/** At most this many blocked sends are listed one by one. */
const BLOCKS_SHOWN = 50;

type LoadState =
  | { kind: 'loading' }
  | { kind: 'off' }
  | { kind: 'error' }
  | {
      kind: 'ready';
      report: TeamActivityReport;
      blocks: MyBlock[];
      unlocks: MyUnlock[];
    };

const UNLOCK_TONE: Record<UnlockStatus, string> = {
  pending: 'border-warning/30 bg-warning-soft text-warning',
  approved: 'border-success/30 bg-success-soft text-success',
  denied: 'border-destructive/30 bg-destructive-soft text-destructive',
  used: 'border-border bg-card-2 text-muted-foreground',
  expired: 'border-border bg-card-2 text-muted-foreground',
};

function viewerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

async function getJson(url: string) {
  const res = await fetch(url);
  const body = (await res.json().catch(() => null)) as unknown;
  return { res, body };
}

/** `TeamActivity.findings` copy, worded for "you" (MyActivity.findings). */
function useMyFindingCopy() {
  const t = useTranslations('MyActivity.findings');
  return useCallback(
    (f: Finding) => ({
      title: t(f.titleKey as never, findingArgs(f) as never),
      body: t(f.bodyKey as never, findingArgs(f) as never),
    }),
    [t]
  );
}

/** A blocked rule in words; an unknown rule gets a plain fallback. */
function useRuleSentence() {
  const t = useTranslations('TeamActivity.blocked');
  const tp = useTranslations('MyActivity.page');
  return useCallback(
    (row: { id: string; rule: string; detail?: Record<string, unknown> }) => {
      if (!isKnownRule(row.rule)) return tp('unknownRule');
      const m = ruleMessage(asRestriction(row));
      return m.key === null
        ? m.text || tp('unknownRule')
        : t(`rule.${m.key}` as never, m.values as never);
    },
    [t, tp]
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-border bg-card-2 rounded-lg border px-3 py-2">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="text-foreground text-sm font-semibold tabular-nums">
        {value}
      </p>
    </div>
  );
}

export default function MyActivityPage() {
  const t = useTranslations('MyActivity.page');
  const ts = useTranslations('TeamActivity.sheet');
  const { user } = useAuth();
  const me = user?.id ?? null;
  const findingCopy = useMyFindingCopy();
  const ruleSentence = useRuleSentence();

  const [preset, setPreset] = useState<RangePreset>('7d');
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!me) return;
    let cancelled = false;
    const params = new URLSearchParams({ range: preset, tz: viewerZone() });
    void (async () => {
      try {
        const { res, body } = await getJson(`/api/team-activity?${params}`);
        if (cancelled) return;
        const b = body as {
          report?: TeamActivityReport;
          range?: { from: string; to: string };
          code?: string;
        } | null;
        if (res.status === 403 && b?.code) {
          setState({ kind: 'off' });
          return;
        }
        if (!res.ok || !b?.report || !b.range) {
          setState({ kind: 'error' });
          return;
        }
        const blockParams = new URLSearchParams({
          from: b.range.from,
          to: b.range.to,
        });
        // The two lists are extras: a failure leaves them empty rather
        // than hiding the figures.
        const [blocks, unlocks] = await Promise.all([
          getJson(`/api/team-activity/blocks?${blockParams}&mine=1`)
            .then(({ res: r, body: x }) => (r.ok ? myBlocks(x, me) : []))
            .catch(() => []),
          getJson('/api/team-activity/unlocks?mine=1')
            .then(({ res: r, body: x }) => (r.ok ? myUnlocks(x, me) : []))
            .catch(() => []),
        ]);
        if (cancelled) return;
        setState({ kind: 'ready', report: b.report, blocks, unlocks });
      } catch {
        if (!cancelled) setState({ kind: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [preset, reloadKey, me]);

  const ready = state.kind === 'ready' ? state : null;
  const mine = useMemo(
    () => (ready ? mySenderRow(ready.report, me) : null),
    [ready, me]
  );
  const findings = useMemo(
    () =>
      ready && mine
        ? senderFindings(mine, ready.report.limits, { audience: 'self' })
        : [],
    [ready, mine]
  );
  const byRule = useMemo(
    () => (ready ? blocksByRule(ready.blocks) : []),
    [ready]
  );

  const reload = () => {
    setState({ kind: 'loading' });
    setReloadKey((k) => k + 1);
  };
  const n = (v: number) => v.toLocaleString();

  return (
    <div className="min-w-0 space-y-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <h1 className="text-foreground text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground mt-1 max-w-[65ch] text-sm">
            {t('description')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="bg-muted/60 flex items-center gap-1 rounded-lg p-1"
            role="group"
            aria-label={t('period')}
          >
            {PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={preset === p}
                onClick={() => {
                  if (p === preset) return;
                  setState({ kind: 'loading' });
                  setPreset(p);
                }}
                className={cn(
                  'rounded-md px-2.5 py-1 text-sm font-medium whitespace-nowrap transition-colors',
                  preset === p
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t(`periods.${p}`)}
              </button>
            ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={reload}
            disabled={state.kind === 'loading'}
          >
            <RefreshCw className="h-4 w-4" />
            {t('refresh')}
          </Button>
        </div>
      </div>

      {state.kind === 'loading' && (
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('loading')}
        </div>
      )}
      {state.kind === 'off' && (
        <div className="border-border bg-card text-muted-foreground rounded-xl border p-6 text-sm">
          {t('turnedOff')}
        </div>
      )}
      {state.kind === 'error' && (
        <div className="border-destructive/30 bg-destructive-soft text-destructive rounded-xl border p-6 text-sm">
          {t('loadFailed')}
        </div>
      )}

      {ready && (
        <>
          <section className="border-border bg-card space-y-3 rounded-xl border p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-foreground text-sm font-semibold">
                {t('figures')}
              </h2>
              {mine && <StatusBadge status={statusOf(findings)} />}
            </div>
            {mine ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                <Fact label={ts('newChats')} value={n(mine.chatsStarted)} />
                <Fact
                  label={ts('replied')}
                  value={
                    mine.matureStarted > 0
                      ? ts('repliedValue', {
                          replied: mine.matureStarted - mine.matureNoReply,
                          total: mine.matureStarted,
                        })
                      : '–'
                  }
                />
                <Fact
                  label={ts('today')}
                  value={ts('ofLimit', {
                    count: mine.todayStarts,
                    limit: ready.report.limits.dailyNewChatsPerUser,
                  })}
                />
                <Fact
                  label={ts('keptMessaging')}
                  value={n(mine.chaseNew + mine.chaseExisting)}
                />
                <Fact label={ts('night')} value={n(mine.nightStarts)} />
                <Fact label={ts('linksFirst')} value={n(mine.linksFirst)} />
                <Fact label={ts('messagesSent')} value={n(mine.messagesSent)} />
                <Fact label={ts('waiting')} value={n(mine.waitingRecent)} />
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">{t('noActivity')}</p>
            )}
          </section>

          <section className="border-border bg-card space-y-3 rounded-xl border p-4">
            <h2 className="text-foreground text-sm font-semibold">
              {t('whatToFix')}
            </h2>
            {findings.length === 0 ? (
              <p className="text-success flex items-center gap-2 text-sm">
                <CheckCircle2 className="h-4 w-4" aria-hidden />
                {t('allGood')}
              </p>
            ) : (
              <ul className="space-y-2">
                {findings.map((f) => {
                  const copy = findingCopy(f);
                  return (
                    <li
                      key={f.id}
                      className="bg-card-2 flex gap-3 rounded-lg p-3"
                    >
                      <LevelIcon level={f.level} className="mt-0.5" />
                      <div className="min-w-0">
                        <p className="text-foreground text-sm font-medium">
                          {copy.title}
                        </p>
                        <p className="text-muted-foreground mt-0.5 text-sm">
                          {copy.body}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="border-border bg-card space-y-3 rounded-xl border p-4">
            <h2 className="text-foreground text-sm font-semibold">
              {t('blockedTitle')}
            </h2>
            {ready.blocks.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {t('blockedNone')}
              </p>
            ) : (
              <>
                <ul className="flex flex-wrap gap-2">
                  {byRule.map((g) => (
                    <li
                      key={g.rule}
                      className="bg-card-2 text-foreground rounded-full px-2.5 py-1 text-xs"
                    >
                      {t(`ruleName.${isKnownRule(g.rule) ? g.rule : 'other'}`)}
                      {' · '}
                      <span className="tabular-nums">
                        {t('times', { count: g.count })}
                      </span>
                    </li>
                  ))}
                </ul>
                <ul className="divide-border divide-y">
                  {ready.blocks.slice(0, BLOCKS_SHOWN).map((b) => (
                    <li
                      key={b.id}
                      className="flex items-start justify-between gap-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <p className="text-foreground text-sm">
                          {ruleSentence(b)}
                        </p>
                        <p className="text-muted-foreground text-xs">
                          {new Date(b.createdAt).toLocaleString()}
                        </p>
                      </div>
                      {b.conversationId && (
                        <Link
                          href={`/inbox?c=${b.conversationId}`}
                          className="text-primary inline-flex shrink-0 items-center gap-1 text-xs font-medium hover:underline"
                        >
                          {t('openChat')}
                          <ExternalLink className="h-3 w-3" />
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
                {ready.blocks.length > BLOCKS_SHOWN && (
                  <p className="text-muted-foreground text-xs">
                    {t('blockedMore', {
                      shown: BLOCKS_SHOWN,
                      total: ready.blocks.length,
                    })}
                  </p>
                )}
              </>
            )}
          </section>

          <section className="border-border bg-card space-y-3 rounded-xl border p-4">
            <h2 className="text-foreground text-sm font-semibold">
              {t('unlocksTitle')}
            </h2>
            {ready.unlocks.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {t('unlocksNone')}
              </p>
            ) : (
              <ul className="space-y-2">
                {ready.unlocks.map((u) => (
                  <li key={u.id} className="bg-card-2 space-y-1 rounded-lg p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-foreground text-sm font-medium">
                        {ruleSentence({ id: u.id, rule: u.rule })}
                      </p>
                      <span
                        className={cn(
                          'rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
                          UNLOCK_TONE[u.status]
                        )}
                      >
                        {t(`unlockStatus.${u.status}`)}
                      </span>
                    </div>
                    <p className="text-muted-foreground text-xs">
                      {new Date(u.createdAt).toLocaleString()}
                    </p>
                    {u.reason && (
                      <p className="text-foreground text-sm">
                        <span className="text-muted-foreground">
                          {t('yourReason')}
                        </span>{' '}
                        {u.reason}
                      </p>
                    )}
                    {u.decisionNote && (
                      <p className="text-foreground text-sm">
                        <span className="text-muted-foreground">
                          {t('decisionNote')}
                        </span>{' '}
                        {u.decisionNote}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
