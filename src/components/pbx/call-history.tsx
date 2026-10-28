'use client';

// The in-call window's Previous calls tab: the customer's earlier calls
// the caller may see. The same read as the customer page's timeline
// (GET /api/pbx/calls with the contact and scope=all: RLS decides, and
// the route adds no team filter for a contact's list), so this never
// shows more than that page would. A refused read renders nothing.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { PhoneIncoming, PhoneMissed, PhoneOutgoing, Phone } from 'lucide-react';

import {
  HISTORY_MAX,
  earlierCalls,
  wasAnswered,
  type HistoryCall,
} from '@/lib/pbx/call-context';
import { OUTCOMES, formatTimer, messageWhen } from '@/lib/pbx/call-ui';
import { cn } from '@/lib/utils';

import { useCalls } from './call-provider';

export interface CallHistoryState {
  /** Null while loading, and when the read was refused (403/404). */
  calls: HistoryCall[] | null;
  loading: boolean;
  /** The read failed for another reason: say so quietly. */
  error: boolean;
}

/**
 * The customer's earlier calls, the call in progress left out (by the
 * PBX's call id), newest first, at most ten. `calls.length` is the tab
 * badge.
 */
export function useCallHistory(
  contactId: string,
  currentPbxCallId?: string | null
): CallHistoryState {
  // Keyed by the contact it was read for, so a new contact reads as
  // loading without a state reset inside the effect.
  const [read, setRead] = useState<{
    contactId: string;
    state: 'ready' | 'hidden' | 'error';
    rows: HistoryCall[];
  } | null>(null);

  useEffect(() => {
    let live = true;
    const settle = (
      state: 'ready' | 'hidden' | 'error',
      rows: HistoryCall[] = []
    ) => live && setRead({ contactId, state, rows });
    const q = new URLSearchParams({
      contactId,
      scope: 'all',
      limit: String(HISTORY_MAX + 1),
    });
    void fetch(`/api/pbx/calls?${q}`, { cache: 'no-store' })
      .then(async (r) => {
        if (r.status === 403 || r.status === 404) return settle('hidden');
        if (!r.ok) return settle('error');
        const body = (await r.json().catch(() => null)) as {
          calls?: unknown;
        } | null;
        if (!Array.isArray(body?.calls)) return settle('error');
        settle('ready', body.calls as HistoryCall[]);
      })
      .catch(() => settle('error'));
    return () => {
      live = false;
    };
  }, [contactId]);

  const mine = read?.contactId === contactId ? read : null;
  return {
    calls:
      mine?.state === 'ready'
        ? earlierCalls(mine.rows, currentPbxCallId)
        : null,
    loading: !mine,
    error: mine?.state === 'error',
  };
}

const chip =
  'inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[11px] font-medium';

export function CallHistoryList({
  contactId,
  currentPbxCallId,
}: {
  contactId: string;
  currentPbxCallId?: string | null;
}) {
  const t = useTranslations('CallContext.history');
  const tc = useTranslations('PbxCall');
  const locale = useLocale();
  const names = useCalls()?.names;
  const { calls, loading, error } = useCallHistory(contactId, currentPbxCallId);
  // Read once per render: the list is re-rendered whenever it changes.
  const [now] = useState(() => Date.now());

  if (loading)
    return (
      <ul className="space-y-2" aria-hidden>
        {[0, 1, 2].map((i) => (
          <li key={i} className="bg-muted h-10 animate-pulse rounded-md" />
        ))}
      </ul>
    );
  if (error)
    return <p className="text-muted-foreground text-xs">{t('failed')}</p>;
  if (!calls) return null;

  return (
    <div className="space-y-2">
      {calls.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <ul className="divide-border divide-y">
          {calls.map((c) => {
            const answered = wasAnswered(c);
            const missed = !answered && c.direction === 'inbound';
            const Icon = missed
              ? PhoneMissed
              : c.direction === 'inbound'
                ? PhoneIncoming
                : c.direction === 'outbound'
                  ? PhoneOutgoing
                  : Phone;
            const who =
              (c.userId && names?.[c.userId]) || c.userName?.trim() || null;
            const outcome = (OUTCOMES as readonly string[]).includes(
              c.disposition ?? ''
            )
              ? tc(`outcomes.${c.disposition as (typeof OUTCOMES)[number]}`)
              : null;
            return (
              <li key={c.id} className="flex gap-2 py-2 text-sm">
                <Icon
                  className={cn(
                    'mt-0.5 size-4 shrink-0',
                    missed ? 'text-destructive' : 'text-muted-foreground'
                  )}
                  aria-label={t(
                    c.direction === 'inbound'
                      ? 'inbound'
                      : c.direction === 'outbound'
                        ? 'outbound'
                        : 'internal'
                  )}
                />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                    <span className="font-medium">
                      {messageWhen(c.startedAt, now, { locale })}
                    </span>
                    <span
                      className={cn(
                        chip,
                        answered
                          ? 'bg-success-soft text-success'
                          : 'bg-destructive-soft text-destructive'
                      )}
                    >
                      {answered
                        ? t('answered')
                        : missed
                          ? t('missed')
                          : t('notAnswered')}
                    </span>
                    {outcome && (
                      <span className={cn(chip, 'bg-info-soft text-info')}>
                        {outcome}
                      </span>
                    )}
                  </div>
                  <p className="text-muted-foreground truncate text-xs">
                    {[
                      who,
                      answered && c.talkSeconds
                        ? t('talk', {
                            time: formatTimer(c.talkSeconds * 1000),
                          })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  {c.notes?.trim() && (
                    <p className="text-foreground/80 line-clamp-2 text-xs whitespace-pre-line">
                      {c.notes}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <Link
        href={`/contacts/${contactId}`}
        className="text-primary inline-block text-xs font-medium hover:underline"
      >
        {t('allCalls')}
      </Link>
    </div>
  );
}
