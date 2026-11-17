'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { MessageSquare } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { RESTRICTION_RULES } from '@/lib/team-activity/blocked-send';
import {
  blockRuleMessage,
  sortBlocks,
  summarizeBlocks,
  type BlockCount,
  type TeamBlock,
} from '@/lib/team-activity/team-blocks';

/** A rule's short name; a rule this build does not know keeps its own. */
export function useRuleName() {
  const t = useTranslations('TeamActivity.blocksTab.rules');
  return (rule: string) =>
    (RESTRICTION_RULES as readonly string[]).includes(rule)
      ? t(rule as never)
      : rule;
}

/** A block's sentence (TeamActivity.blocked.rule), with its figures. */
export function useRuleSentence() {
  const t = useTranslations('TeamActivity.blocked.rule');
  return (rule: string, detail: Record<string, unknown>) => {
    const m = blockRuleMessage(rule, detail);
    return m.key === null ? m.text : t(m.key as never, m.values as never);
  };
}

export function BlocksTab({
  blocks,
  error,
  onRetry,
  nameOf,
  numberOf,
}: {
  blocks: TeamBlock[] | null;
  error: boolean;
  onRetry: () => void;
  /** An auth user id's name; null for an automatic send. */
  nameOf: (userId: string | null, source: TeamBlock['source']) => string;
  numberOf: (channelId: string | null) => string | null;
}) {
  const t = useTranslations('TeamActivity.blocksTab');
  const format = useFormatter();
  const ruleName = useRuleName();
  const sentence = useRuleSentence();

  const summary = useMemo(() => summarizeBlocks(blocks ?? []), [blocks]);
  const rows = useMemo(() => sortBlocks(blocks ?? []), [blocks]);

  if (error) {
    return (
      <div className="border-destructive/30 bg-destructive-soft text-destructive flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm">
        <span>{t('loadFailed')}</span>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t('retry')}
        </Button>
      </div>
    );
  }
  if (!blocks)
    return <div className="bg-card-2 h-40 w-full animate-pulse rounded-xl" />;

  const personLabel = (key: string) =>
    key === 'auto' ? t('automatic') : nameOf(key, 'human');

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">
        {t('total', { count: summary.total })}
      </p>

      {summary.total > 0 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <CountCard
            title={t('byRule')}
            rows={summary.byRule}
            label={ruleName}
          />
          <CountCard
            title={t('byPerson')}
            rows={summary.byPerson}
            label={personLabel}
          />
        </div>
      )}

      <section className="border-border bg-card rounded-xl border">
        <h2 className="text-foreground border-border border-b px-4 py-3 text-base font-semibold">
          {t('listTitle')}
        </h2>
        {rows.length === 0 ? (
          <p className="text-muted-foreground px-4 py-6 text-sm">
            {t('empty')}
          </p>
        ) : (
          <ul className="divide-border divide-y">
            {rows.map((b) => (
              <li
                key={b.id}
                className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:gap-4"
              >
                <div className="text-muted-foreground w-36 shrink-0 text-xs tabular-nums sm:pt-0.5">
                  {format.dateTime(new Date(b.createdAt), {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                    <span className="text-foreground font-medium">
                      {b.source === 'auto'
                        ? t('automatic')
                        : nameOf(b.userId, b.source)}
                    </span>
                    {numberOf(b.channelId) && (
                      <span className="bg-card-2 text-muted-foreground rounded px-1.5 py-0.5 text-xs">
                        {numberOf(b.channelId)}
                      </span>
                    )}
                    <span className="border-warning/30 bg-warning-soft text-warning rounded-full border px-2 py-0.5 text-xs font-medium">
                      {ruleName(b.rule)}
                    </span>
                  </div>
                  <p className="text-muted-foreground text-sm">
                    {sentence(b.rule, b.detail)}
                  </p>
                </div>
                {b.conversationId && (
                  <Link
                    href={`/inbox?c=${encodeURIComponent(b.conversationId)}`}
                    className="text-primary inline-flex shrink-0 items-center gap-1 text-sm font-medium hover:underline"
                  >
                    <MessageSquare className="h-3.5 w-3.5" aria-hidden />
                    {t('openChat')}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function CountCard({
  title,
  rows,
  label,
}: {
  title: string;
  rows: BlockCount<string>[];
  label: (key: string) => string;
}) {
  const max = rows[0]?.count ?? 1;
  return (
    <section className="border-border bg-card rounded-xl border p-4">
      <h3 className="text-foreground mb-3 text-sm font-semibold">{title}</h3>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.key} className="space-y-1">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="text-foreground min-w-0 truncate">
                {label(r.key)}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {r.count}
              </span>
            </div>
            <div className="bg-card-2 h-1.5 overflow-hidden rounded-full">
              <div
                className="bg-warning h-full rounded-full"
                style={{ width: `${Math.max(4, (r.count / max) * 100)}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
