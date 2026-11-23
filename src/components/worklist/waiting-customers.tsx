'use client';

/**
 * "Customers waiting for a reply", the top section of My worklist
 * (Track B item 9). The pure render of `worklist_waiting_chats` rows the
 * page loaded and filtered (`lib/worklist/waiting.ts`): oldest first,
 * each row opening the chat in the inbox. The big figure is clock time
 * since the customer wrote; the business-hours part (237's hours) is
 * underneath, so a wait that ran overnight is not mistaken for a slow
 * reply in office hours. An unassigned chat says so in a word and an
 * icon, not by colour alone.
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Hourglass, MessageCircleCheck, UserRoundX } from 'lucide-react';

import { EmptyState } from '@/components/dashboard/empty-state';
import { ErrorState } from '@/components/dashboard/error-state';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  businessWait,
  waitingChatHref,
  wallWait,
  type WaitingChat,
} from '@/lib/worklist/waiting';

export interface WaitingCustomersProps {
  /** null: still loading. */
  rows: readonly WaitingChat[] | null;
  /** Display name for an auth user id; null when unknown. */
  nameOf: (userId: string) => string | null;
  /** The clock the waits are measured against (epoch ms). */
  now: number;
  /** The load hit the RPC's cap, so older waits may be missing. */
  capped?: number | null;
  /** The read failed and there has never been a good one. */
  failed?: boolean;
}

export function WaitingCustomers({
  rows,
  nameOf,
  now,
  capped = null,
  failed = false,
}: WaitingCustomersProps) {
  const t = useTranslations('WorklistWaiting');

  return (
    <section
      aria-labelledby="worklist-waiting-title"
      className="bg-card rounded-lg border"
      data-testid="worklist-waiting"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b px-4 py-3">
        <h2 id="worklist-waiting-title" className="text-base font-semibold">
          {t('title')}
        </h2>
        {rows !== null && rows.length > 0 && (
          <Badge variant="secondary" data-testid="worklist-waiting-count">
            {t('count', { count: rows.length })}
          </Badge>
        )}
        <p className="text-muted-foreground w-full text-xs">{t('help')}</p>
      </div>

      {rows === null && failed ? (
        <ErrorState className="min-h-32 p-4" />
      ) : rows === null ? (
        <p
          role="status"
          className="text-muted-foreground p-6 text-center text-sm"
        >
          {t('loading')}
        </p>
      ) : rows.length === 0 ? (
        <div className="p-4" data-testid="worklist-waiting-empty">
          <EmptyState
            icon={MessageCircleCheck}
            title={t('empty')}
            hint={t('emptyHint')}
            className="min-h-32"
          />
        </div>
      ) : (
        <>
          <ul aria-label={t('list')} className="divide-y">
            {rows.map((row) => (
              <WaitingRow
                key={row.conversationId}
                row={row}
                nameOf={nameOf}
                now={now}
              />
            ))}
          </ul>
          {capped !== null && rows.length >= capped && (
            <p className="text-muted-foreground border-t px-4 py-2 text-xs">
              {t('capped', { count: capped })}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function WaitingRow({
  row,
  nameOf,
  now,
}: {
  row: WaitingChat;
  nameOf: (userId: string) => string | null;
  now: number;
}) {
  const t = useTranslations('WorklistWaiting');
  const wall = wallWait(row, now);
  const business = businessWait(row);
  const customer = row.contactName ?? row.contactPhone ?? t('unknownCustomer');

  return (
    <li
      data-testid="worklist-waiting-row"
      data-id={row.conversationId}
      data-unassigned={row.unassigned ? 'true' : 'false'}
    >
      <Link
        href={waitingChatHref(row.conversationId)}
        className="hover:bg-muted/50 focus-visible:ring-ring flex flex-col gap-1 px-4 py-3 outline-none focus-visible:ring-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
      >
        <div className="min-w-0">
          <p className="text-primary truncate font-medium">{customer}</p>
          {row.unassigned ? (
            <p className="text-destructive inline-flex items-center gap-1 text-sm font-medium">
              <UserRoundX className="size-3.5 shrink-0" aria-hidden />
              {t('unassigned')}
            </p>
          ) : (
            <p className="text-muted-foreground truncate text-sm">
              {(row.assignedAgentId && nameOf(row.assignedAgentId)) ??
                t('unknownPerson')}
            </p>
          )}
        </div>
        <div className="shrink-0 sm:text-end">
          <p
            data-testid="worklist-waiting-wait"
            className={cn(
              'inline-flex items-center gap-1 text-sm whitespace-nowrap',
              wall.unit === 'minutes' ? 'text-warning' : 'text-destructive',
              'font-medium'
            )}
          >
            <Hourglass className="size-3.5 shrink-0" aria-hidden />
            {t('wait', { unit: wall.unit, n: wall.n })}
          </p>
          <p
            data-testid="worklist-waiting-business"
            className="text-muted-foreground text-xs"
          >
            {business
              ? t('business', { unit: business.unit, n: business.n })
              : t('businessNone')}
          </p>
        </div>
      </Link>
    </li>
  );
}
