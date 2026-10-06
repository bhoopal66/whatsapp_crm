'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ExternalLink, Link2, Loader2, UserPlus } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { createClient } from '@/lib/supabase/client';
import { formatMinutes, percent } from '@/lib/team-activity/format';
import type { TeamActivityLimits } from '@/lib/team-activity/limits';
import type { PersonAssessment } from '@/lib/team-activity/risk';
import { cn } from '@/lib/utils';

import { LevelIcon, StatusBadge, useFindingCopy } from './shared';

type ChatFilter = 'no_reply' | 'all' | 'unanswered';

interface ChatRow {
  conversation_id: string;
  contact_id: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  at: string;
  new_contact: boolean;
  replied: boolean;
  has_link: boolean;
  in_a_row: number;
  preview: string | null;
}

function Fact({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="border-border rounded-lg border px-3 py-2">
      <p className="text-muted-foreground text-[11px]">{label}</p>
      <p
        className={cn(
          'text-foreground text-sm font-semibold tabular-nums',
          tone
        )}
      >
        {value}
      </p>
    </div>
  );
}

/**
 * One person's (or the API's, or the bots') record for the range: what
 * is wrong, what to tell them, and the chats behind the numbers — each
 * a link into the inbox.
 */
export function PersonSheet({
  row,
  name,
  open,
  onOpenChange,
  range,
  channelId,
  limits,
}: {
  row: PersonAssessment | null;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  range: { from: string; to: string } | null;
  channelId: string | null;
  limits: TeamActivityLimits;
}) {
  const t = useTranslations('TeamActivity.sheet');
  const tu = useTranslations('TeamActivity.units');
  const tt = useTranslations('TeamActivity.people');
  const copy = useFindingCopy();
  const [filter, setFilter] = useState<ChatFilter>('no_reply');
  // Focus lands on the heading, so the sheet opens at its top rather
  // than scrolled to the first button inside it.
  const headingRef = useRef<HTMLDivElement>(null);
  // The list is kept with the request it answers, so a stale answer
  // (another person, filter or range) is simply not shown.
  const [result, setResult] = useState<{
    key: string;
    chats: ChatRow[];
    error: boolean;
  } | null>(null);

  const sender = row?.sender ?? null;
  const requestKey =
    open && sender && range
      ? [
          sender.kind,
          sender.userId,
          range.from,
          range.to,
          channelId,
          filter,
        ].join('|')
      : null;
  const current = result && result.key === requestKey ? result : null;
  const chats = current?.chats ?? null;
  const error = current?.error ?? false;

  useEffect(() => {
    if (!requestKey || !sender || !range) return;
    let cancelled = false;
    void createClient()
      .rpc('team_activity_chats', {
        p_from: range.from,
        p_to: range.to,
        p_kind: sender.kind,
        p_user_id: sender.userId,
        p_channel_id: channelId,
        p_filter: filter,
        p_limit: 200,
      })
      .then(({ data, error: rpcError }) => {
        if (cancelled) return;
        if (rpcError) {
          console.error('[team-activity] chats failed:', rpcError.message);
          setResult({ key: requestKey, chats: [], error: true });
          return;
        }
        setResult({
          key: requestKey,
          chats: (data ?? []) as ChatRow[],
          error: false,
        });
      });
    return () => {
      cancelled = true;
    };
    // requestKey captures every input that changes the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey]);

  const unit = (u: 'd' | 'h' | 'm', v: number) => tu(u, { n: v });
  const n = (v: number) => v.toLocaleString();
  const person = sender?.kind === 'person';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="gap-0 overflow-y-auto p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
        initialFocus={headingRef}
      >
        {row && sender && (
          <>
            <SheetHeader className="border-border border-b p-5">
              <div
                ref={headingRef}
                tabIndex={-1}
                className="flex flex-wrap items-center gap-2 pr-8 outline-none"
              >
                <SheetTitle className="text-lg font-semibold">
                  {name}
                </SheetTitle>
                <StatusBadge status={row.status} />
              </div>
              <SheetDescription>
                {sender.kind === 'person'
                  ? [tt(`role.${sender.role ?? 'unknown'}`), sender.email]
                      .filter(Boolean)
                      .join(' · ')
                  : tt(
                      sender.kind === 'bot'
                        ? 'automaticBotHint'
                        : 'automaticApiHint'
                    )}
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-6 p-5">
              {row.findings.length > 0 ? (
                <section className="space-y-3">
                  <h3 className="text-foreground text-sm font-semibold">
                    {t('whatToFix')}
                  </h3>
                  <ul className="space-y-3">
                    {row.findings.map((f) => {
                      const { title, body } = copy(f);
                      return (
                        <li key={f.id} className="flex gap-2.5">
                          <LevelIcon level={f.level} className="mt-0.5" />
                          <div>
                            <p className="text-foreground text-sm font-medium">
                              {title}
                            </p>
                            <p className="text-muted-foreground mt-0.5 text-sm">
                              {body}
                            </p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ) : (
                <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 [[data-mode=dark]_&]:text-emerald-400">
                  {t('allGood')}
                </p>
              )}

              <section className="space-y-3">
                <h3 className="text-foreground text-sm font-semibold">
                  {t('figures')}
                </h3>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <Fact label={t('newChats')} value={n(sender.chatsStarted)} />
                  <Fact label={t('newPeople')} value={n(sender.newContacts)} />
                  <Fact
                    label={t('replied')}
                    value={
                      sender.matureStarted > 0
                        ? t('repliedValue', {
                            replied:
                              sender.matureStarted - sender.matureNoReply,
                            total: sender.matureStarted,
                          })
                        : '–'
                    }
                  />
                  <Fact label={t('tooRecent')} value={n(sender.pendingReply)} />
                  <Fact
                    label={t('today')}
                    value={
                      person
                        ? t('ofLimit', {
                            count: sender.todayStarts,
                            limit: limits.dailyNewChatsPerUser,
                          })
                        : n(sender.todayStarts)
                    }
                  />
                  <Fact label={t('busiestDay')} value={n(sender.peakDay)} />
                  {person && (
                    <Fact
                      label={t('daysAtLimit')}
                      value={n(sender.daysAtLimit)}
                    />
                  )}
                  <Fact label={t('tenMinutes')} value={n(sender.burst10min)} />
                  <Fact
                    label={t('keptMessaging')}
                    value={n(sender.chaseNew + sender.chaseExisting)}
                  />
                  <Fact
                    label={t('mostInARow')}
                    value={n(sender.longestChase)}
                  />
                  <Fact label={t('night')} value={n(sender.nightStarts)} />
                  <Fact label={t('linksFirst')} value={n(sender.linksFirst)} />
                  <Fact
                    label={t('similarFirst')}
                    value={n(sender.similarOpeners)}
                  />
                  <Fact
                    label={t('messagesSent')}
                    value={n(sender.messagesSent)}
                  />
                  <Fact
                    label={t('read')}
                    value={`${percent(sender.read, sender.messagesSent) ?? 0}%`}
                  />
                  <Fact
                    label={t('notDelivered')}
                    value={n(
                      sender.failedPhone + sender.failedOfficial ||
                        sender.failed
                    )}
                  />
                  {person && (
                    <>
                      <Fact
                        label={t('repliesSent')}
                        value={n(sender.replies)}
                      />
                      <Fact
                        label={t('usuallyReplies')}
                        value={
                          formatMinutes(sender.responseMedianMin, unit) ?? '–'
                        }
                      />
                      <Fact
                        label={t('waiting')}
                        value={n(sender.waitingRecent)}
                      />
                      <Fact
                        label={t('waitingLongest')}
                        value={
                          formatMinutes(sender.waitingOldestMin, unit) ?? '–'
                        }
                      />
                    </>
                  )}
                </div>
              </section>

              <section className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-foreground text-sm font-semibold">
                    {t('chats')}
                  </h3>
                  <div className="bg-muted/60 flex items-center gap-1 rounded-lg p-1">
                    {(['no_reply', 'unanswered', 'all'] as const).map((f) => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => setFilter(f)}
                        className={cn(
                          'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                          filter === f
                            ? 'bg-secondary text-secondary-foreground'
                            : 'text-muted-foreground hover:text-foreground'
                        )}
                      >
                        {t(`filter.${f}`)}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="text-muted-foreground text-xs">
                  {t(`filterHint.${filter}`, {
                    max: limits.maxUnansweredInRow,
                  })}
                </p>

                {chats === null ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
                  </div>
                ) : error ? (
                  <p className="text-muted-foreground py-6 text-center text-sm">
                    {t('chatsError')}
                  </p>
                ) : chats.length === 0 ? (
                  <p className="text-muted-foreground py-6 text-center text-sm">
                    {t('noChats')}
                  </p>
                ) : (
                  <ul className="divide-border border-border divide-y rounded-lg border">
                    {chats.map((c) => (
                      <li key={`${c.conversation_id}-${c.at}`} className="p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-foreground truncate text-sm font-medium">
                              {c.contact_name ||
                                c.contact_phone ||
                                t('unknownContact')}
                            </p>
                            <p className="text-muted-foreground text-xs">
                              {[
                                c.contact_name ? c.contact_phone : null,
                                new Date(c.at).toLocaleString(),
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </p>
                          </div>
                          <Link
                            href={`/inbox?c=${c.conversation_id}`}
                            className="text-primary inline-flex shrink-0 items-center gap-1 text-xs font-medium hover:underline"
                          >
                            {t('openChat')}
                            <ExternalLink className="h-3 w-3" />
                          </Link>
                        </div>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {c.new_contact && (
                            <span className="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]">
                              <UserPlus className="h-3 w-3" />
                              {t('badgeNew')}
                            </span>
                          )}
                          {c.has_link && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700 [[data-mode=dark]_&]:text-amber-400">
                              <Link2 className="h-3 w-3" />
                              {t('badgeLink')}
                            </span>
                          )}
                          {c.in_a_row > 1 && (
                            <span
                              className={cn(
                                'rounded-full px-2 py-0.5 text-[11px]',
                                c.in_a_row > limits.maxUnansweredInRow
                                  ? 'bg-red-500/10 text-red-700 [[data-mode=dark]_&]:text-red-400'
                                  : 'bg-muted text-muted-foreground'
                              )}
                            >
                              {t('badgeInARow', { count: c.in_a_row })}
                            </span>
                          )}
                          {c.replied && (
                            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-700 [[data-mode=dark]_&]:text-emerald-400">
                              {t('badgeReplied')}
                            </span>
                          )}
                        </div>
                        {c.preview && (
                          <p className="text-muted-foreground mt-1.5 line-clamp-2 text-xs">
                            “{c.preview}”
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {chats && chats.length >= 200 && (
                  <p className="text-muted-foreground text-xs">{t('capped')}</p>
                )}
              </section>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
