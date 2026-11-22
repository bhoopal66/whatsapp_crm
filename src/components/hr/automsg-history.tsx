'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
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

  const seq = useRef(0);

  const load = useCallback(async (f: HistoryFilter) => {
    const mine = ++seq.current;
    const res = await automsgOutbox(createClient(), {
      status: historyStatusArg(f),
      limit: HISTORY_LIMIT,
    });
    if (mine !== seq.current) return;
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
      <div className="flex flex-wrap gap-1">
        {HISTORY_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${
              filter === f
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-input bg-card dark:bg-input/30 hover:bg-card-2'
            }`}
          >
            {t(`history.filter.${f}`)}
          </button>
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
        <AutomsgHistoryList
          items={items}
          busy={busyId !== null}
          onCancel={(id) => void cancel(id)}
        />
      )}
    </section>
  );
}

/**
 * The history rows: a table on wider screens (Time, Contact, Trigger,
 * Status, Hold reason, Attempts, Cancel), stacked cards on phones.
 */
export function AutomsgHistoryList({
  items,
  busy,
  onCancel,
}: {
  items: readonly { row: AutoMsgOutboxRow; view: HistoryRowView }[];
  busy: boolean;
  onCancel: (id: string) => void;
}) {
  const t = useTranslations('Hr.automsg');
  const cancelButton = (id: string) => (
    <Button size="xs" disabled={busy} onClick={() => onCancel(id)}>
      {t('history.cancel')}
    </Button>
  );
  return (
    <>
      <div className="hidden sm:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('history.time')}</TableHead>
              <TableHead>{t('history.contact')}</TableHead>
              <TableHead>{t('history.trigger')}</TableHead>
              <TableHead>{t('history.channel')}</TableHead>
              <TableHead>{t('history.statusHead')}</TableHead>
              <TableHead>{t('history.holdHead')}</TableHead>
              <TableHead>{t('history.attempts')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map(({ row, view }) => (
              <TableRow key={row.id}>
                <TableCell className="text-sm whitespace-nowrap">
                  {formatTime(row)}
                </TableCell>
                <TableCell>
                  <CandidateLink row={row} view={view} />
                </TableCell>
                <TableCell className="text-sm whitespace-normal">
                  {t(`triggers.${row.trigger}`)}
                </TableCell>
                <TableCell className="text-sm whitespace-nowrap">
                  {t(view.channelKey)}
                </TableCell>
                <TableCell className="whitespace-normal">
                  <StatusCell view={view} />
                </TableCell>
                <TableCell className="text-sm whitespace-normal">
                  {view.holdKey
                    ? t(`history.hold.${view.holdKey}`)
                    : t('history.noHold')}
                </TableCell>
                <TableCell className="text-sm tabular-nums">
                  {row.attempts}
                </TableCell>
                <TableCell className="text-end">
                  {view.canCancel && cancelButton(row.id)}
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
              {view.canCancel && cancelButton(row.id)}
            </div>
            <p className="text-sm">
              {t(`triggers.${row.trigger}`)}
              <span className="text-muted-foreground"> · </span>
              <span className="text-muted-foreground">
                {t(view.channelKey)}
              </span>
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <StatusCell view={view} />
              {view.holdKey && (
                <span className="text-muted-foreground text-xs">
                  {t(`history.hold.${view.holdKey}`)}
                </span>
              )}
            </div>
            <p className="text-muted-foreground text-xs">
              {t('history.attemptsCount', { count: row.attempts })}
            </p>
          </li>
        ))}
      </ul>
    </>
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
      {view.claimKey && (
        <p className="text-warning text-xs">{t(`claim.${view.claimKey}`)}</p>
      )}
    </div>
  );
}
