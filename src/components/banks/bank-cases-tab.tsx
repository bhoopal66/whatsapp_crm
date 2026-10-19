'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';

import { useWorkspaceMembers } from '@/components/meetings/use-workspace-members';
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
  CASE_FILTERS,
  splitCases,
  visibleCases,
  type CaseFilter,
} from '@/lib/banks/dashboard-ui';
import { parseBankPage, type BankCase } from '@/lib/banks/ui';
import { cn } from '@/lib/utils';

import { chip } from './banks-list';

/** The pieces both layouts show, worded once. */
function useRowView() {
  const t = useTranslations('Banks.cases');
  const tb = useTranslations('Banks');
  const locale = useLocale();
  const { nameOf } = useWorkspaceMembers();
  const day = (iso: string | null) => {
    const d = iso ? new Date(iso) : null;
    return d && Number.isFinite(d.getTime())
      ? d.toLocaleDateString(locale, {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        })
      : null;
  };
  return (c: BankCase) => ({
    product: c.product ?? '—',
    agent: c.agentId
      ? (nameOf(c.agentId) ?? tb('unknownPerson'))
      : t('unassigned'),
    coordinator: c.coordinatorId
      ? (nameOf(c.coordinatorId) ?? tb('unknownPerson'))
      : t('noCoordinator'),
    opened: day(c.openedAt) ?? '—',
    closed: c.closedAt ? (day(c.closedAt) ?? '—') : null,
  });
}

function StageChip({ c }: { c: BankCase }) {
  const t = useTranslations('Banks.cases');
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span className={cn(chip, 'bg-muted text-foreground')}>
        {c.stage || t('noStage')}
      </span>
      {c.closedAt && (
        <span className={cn(chip, 'bg-muted text-muted-foreground')}>
          {t('closedChip')}
        </span>
      )}
    </span>
  );
}

/** The bank page's Cases tab: this bank's cases the caller may read. */
export function BankCasesTab({ bankWsId }: { bankWsId: string }) {
  const t = useTranslations('Banks.cases');
  const tb = useTranslations('Banks');
  const view = useRowView();
  const [cases, setCases] = useState<BankCase[] | null | 'error'>(null);
  const [filter, setFilter] = useState<CaseFilter>('all');

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/banks/${bankWsId}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      setCases(parseBankPage(await res.json()).cases);
    } catch {
      setCases('error');
    }
  }, [bankWsId]);
  useEffect(() => {
    void load();
  }, [load]);

  const split = useMemo(
    () => (Array.isArray(cases) ? splitCases(cases) : null),
    [cases]
  );

  if (cases === null)
    return (
      <p className="text-muted-foreground py-6 text-sm">{tb('loading')}</p>
    );
  if (cases === 'error' || !split)
    return (
      <div className="flex items-center gap-3 py-4">
        <p className="text-destructive text-sm">{tb('loadFailed')}</p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          {tb('retry')}
        </Button>
      </div>
    );

  const rows = visibleCases(split, filter);
  const counts = {
    all: split.open.length + split.closed.length,
    open: split.open.length,
    closed: split.closed.length,
  };

  return (
    <div className="space-y-3 pt-2">
      <div
        role="group"
        aria-label={t('filterLabel')}
        className="flex flex-wrap gap-1.5"
      >
        {CASE_FILTERS.map((k) => (
          <Button
            key={k}
            size="sm"
            variant={filter === k ? 'default' : 'outline'}
            aria-pressed={filter === k}
            onClick={() => setFilter(k)}
          >
            {t(`filters.${k}`, { count: counts[k] })}
          </Button>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="text-muted-foreground py-6 text-sm">
          {t(`empty.${filter}`)}
        </p>
      ) : (
        <>
          <div className="border-border bg-card hidden rounded-xl border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.stage')}</TableHead>
                  <TableHead>{t('columns.product')}</TableHead>
                  <TableHead>{t('columns.agent')}</TableHead>
                  <TableHead>{t('columns.coordinator')}</TableHead>
                  <TableHead>{t('columns.opened')}</TableHead>
                  <TableHead>{t('columns.closed')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((c) => {
                  const v = view(c);
                  return (
                    // The stage link is stretched over the whole row.
                    <TableRow
                      key={c.caseId}
                      className="hover:bg-muted/60 relative align-top"
                    >
                      <TableCell className="whitespace-normal">
                        <Link
                          href={`/cases/${c.caseId}`}
                          aria-label={t('openCase', {
                            stage: c.stage || t('noStage'),
                          })}
                          className="after:absolute after:inset-0 after:content-[''] focus-visible:underline"
                        >
                          <StageChip c={c} />
                        </Link>
                      </TableCell>
                      <TableCell className="max-w-56 whitespace-normal">
                        {v.product}
                      </TableCell>
                      <TableCell className="text-xs whitespace-normal">
                        {v.agent}
                      </TableCell>
                      <TableCell className="text-xs whitespace-normal">
                        {v.coordinator}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {v.opened}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {v.closed ?? t('stillOpen')}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <ul className="space-y-2 md:hidden">
            {rows.map((c) => {
              const v = view(c);
              return (
                <li key={c.caseId}>
                  <Link
                    href={`/cases/${c.caseId}`}
                    className="border-border bg-card hover:bg-muted/60 block space-y-2 rounded-xl border p-3 transition-colors"
                  >
                    <span className="flex items-start justify-between gap-2">
                      <StageChip c={c} />
                      <span className="text-muted-foreground shrink-0 text-xs">
                        {v.closed
                          ? t('closedOn', { date: v.closed })
                          : t('openedOn', { date: v.opened })}
                      </span>
                    </span>
                    <span className="block truncate text-sm">{v.product}</span>
                    <span className="text-muted-foreground block text-xs">
                      {t('agentLabel', { name: v.agent })} ·{' '}
                      {t('coordinatorLabel', { name: v.coordinator })}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
