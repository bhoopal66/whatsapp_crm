'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  automsgCancel,
  automsgOutbox,
  type AutoMsgOutboxRow,
} from '@/lib/hr/automsg/api';
import {
  HISTORY_FILTERS,
  HISTORY_LIMIT,
  cancelErrorKey,
  historyRowView,
  historyStatusArg,
  type HistoryFilter,
  type HistoryRowView,
} from '@/lib/hr/automsg/history-view';
import type { OutboxStatus } from '@/lib/hr/automsg/types';
import type { AutomsgRole } from '@/lib/hr/automsg/view';
import { createClient } from '@/lib/supabase/client';

const STATUS_CHIP: Readonly<Record<OutboxStatus, string>> = {
  queued: 'bg-info-soft text-info',
  held: 'bg-warning-soft text-warning',
  sent: 'bg-success-soft text-success',
  failed: 'bg-destructive-soft text-destructive',
  cancelled: 'bg-card-2 text-muted-foreground',
};

/**
 * The automated-message history: the newest HISTORY_LIMIT outbox rows,
 * filtered by status. Reloads on mount, on a filter change and whenever
 * `refreshKey` changes (the page bumps it after Run now). Cancel is
 * offered where the view allows it; the database decides.
 */
export function AutomsgHistory({
  role,
  refreshKey,
}: {
  role: AutomsgRole;
  refreshKey: number;
}) {
  const t = useTranslations('Hr.automsg');
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [rows, setRows] = useState<AutoMsgOutboxRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (f: HistoryFilter) => {
    const res = await automsgOutbox(createClient(), {
      status: historyStatusArg(f),
      limit: HISTORY_LIMIT,
    });
    if ('error' in res) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setRows(res.data);
  }, []);

  useEffect(() => {
    void load(filter);
  }, [filter, refreshKey, load]);

  const cancel = async (id: string) => {
    setBusyId(id);
    try {
      const res = await automsgCancel(createClient(), id);
      if ('error' in res) toast.error(t(cancelErrorKey(res.error)));
      else toast.success(t('history.cancelled'));
      await load(filter);
    } finally {
      setBusyId(null);
    }
  };

  const items = (rows ?? []).map((row) => ({
    row,
    view: historyRowView(row, role),
  }));

  return (
    <section className="border-border bg-card space-y-3 rounded-lg border p-4">
      <h2 className="font-medium">{t('history.title')}</h2>
      <div className="flex flex-wrap gap-2">
        {HISTORY_FILTERS.map((f) => (
          <Button
            key={f}
            size="sm"
            variant={filter === f ? 'default' : 'outline'}
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
          >
            {t(`history.filter.${f}`)}
          </Button>
        ))}
      </div>

      {failed ? (
        <div className="space-y-2">
          <p className="text-destructive text-sm">{t('history.loadFailed')}</p>
          <Button variant="outline" size="sm" onClick={() => void load(filter)}>
            {t('history.retry')}
          </Button>
        </div>
      ) : rows === null ? (
        <div className="bg-card-2 h-16 animate-pulse rounded-lg" />
      ) : items.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('history.empty')}</p>
      ) : (
        <>
          <div className="hidden sm:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('history.time')}</TableHead>
                  <TableHead>{t('history.candidate')}</TableHead>
                  <TableHead>{t('history.trigger')}</TableHead>
                  <TableHead>{t('history.statusHead')}</TableHead>
                  <TableHead>{t('history.attempts')}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map(({ row, view }) => (
                  <TableRow key={row.id}>
                    <TableCell className="align-top text-xs whitespace-nowrap">
                      {formatTime(row)}
                    </TableCell>
                    <TableCell className="align-top">
                      <CandidateLink row={row} view={view} />
                    </TableCell>
                    <TableCell className="align-top text-sm whitespace-normal">
                      {t(`triggers.${row.trigger}`)}
                    </TableCell>
                    <TableCell className="align-top whitespace-normal">
                      <StatusCell view={view} />
                    </TableCell>
                    <TableCell className="align-top text-sm">
                      {row.attempts}
                    </TableCell>
                    <TableCell className="text-right align-top">
                      {view.canCancel && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyId !== null}
                          onClick={() => void cancel(row.id)}
                        >
                          {t('history.cancel')}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <ul className="space-y-2 sm:hidden">
            {items.map(({ row, view }) => (
              <li
                key={row.id}
                className="border-border bg-card-2 space-y-1.5 rounded-lg border p-3"
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <CandidateLink row={row} view={view} />
                    <p className="text-muted-foreground text-xs">
                      {formatTime(row)}
                    </p>
                  </div>
                  {view.canCancel && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyId !== null}
                      onClick={() => void cancel(row.id)}
                    >
                      {t('history.cancel')}
                    </Button>
                  )}
                </div>
                <p className="text-sm">{t(`triggers.${row.trigger}`)}</p>
                <StatusCell view={view} />
                <p className="text-muted-foreground text-xs">
                  {t('history.attemptsCount', { count: row.attempts })}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function formatTime(row: AutoMsgOutboxRow): string {
  const d = new Date(row.sentAt ?? row.createdAt);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function CandidateLink({
  row,
  view,
}: {
  row: AutoMsgOutboxRow;
  view: HistoryRowView;
}) {
  const t = useTranslations('Hr.automsg.history');
  return (
    <Link
      href={view.href}
      className="text-sm font-medium underline-offset-2 hover:underline"
    >
      {row.contactName || t('unnamed')}
    </Link>
  );
}

function StatusCell({ view }: { view: HistoryRowView }) {
  const t = useTranslations('Hr.automsg.history');
  return (
    <div className="space-y-1">
      <span
        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CHIP[view.statusKey]}`}
      >
        {t(`status.${view.statusKey}`)}
      </span>
      {view.holdKey && (
        <p className="text-muted-foreground text-xs">
          {t(`hold.${view.holdKey}`)}
        </p>
      )}
      {view.claimKey && (
        <p className="text-warning text-xs">{t(`claim.${view.claimKey}`)}</p>
      )}
    </div>
  );
}
