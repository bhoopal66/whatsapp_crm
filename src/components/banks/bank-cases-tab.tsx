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
import {
  parseBankPage,
  slaChip,
  type BankCase,
  type SlaTone,
} from '@/lib/banks/ui';
import { stageChipClass } from '@/lib/cases/ui';
import { cn } from '@/lib/utils';

import { chip } from './banks-list';

const SLA_TONE: Record<SlaTone, string> = {
  bad: 'bg-destructive-soft text-destructive',
  warn: 'bg-warning-soft text-warning',
  muted: 'bg-muted text-muted-foreground',
};

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
    customer: c.contactName ?? t('unknownCustomer'),
    nextDue: shortDay(c.nextDueAt),
  });
  function shortDay(iso: string | null) {
    const d = iso ? new Date(iso) : null;
    return d && Number.isFinite(d.getTime())
      ? d.toLocaleDateString(locale, { day: 'numeric', month: 'short' })
      : null;
  }
}

/**
 * The customer's name, linked to their page when the case has a contact.
 * It sits above the row's stretched case link (`relative z-10`), so a tap
 * on the name opens the customer and anywhere else opens the case.
 */
function Customer({ c, name }: { c: BankCase; name: string }) {
  if (!c.contactId)
    return <span className="text-muted-foreground">{name}</span>;
  return (
    <Link
      href={`/contacts/${c.contactId}`}
      className="relative z-10 font-medium hover:underline focus-visible:underline"
    >
      {name}
    </Link>
  );
}

/** Overdue / Due soon / On track, with the next due date; nothing when closed. */
function SlaChip({ c, nextDue }: { c: BankCase; nextDue: string | null }) {
  const t = useTranslations('Banks.cases');
  const sla = slaChip(c);
  if (!sla) return null;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span className={cn(chip, SLA_TONE[sla.tone])}>
        {t(`sla.${sla.key}`)}
      </span>
      {nextDue && (
        <span className="text-muted-foreground text-xs">
          {t('dueOn', { date: nextDue })}
        </span>
      )}
    </span>
  );
}

function StageChip({ c }: { c: BankCase }) {
  const t = useTranslations('Banks.cases');
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span className={cn(chip, stageChipClass(c.stage))}>
        {c.stage || t('noStage')}
      </span>
      {c.isLead && (
        <span className={cn(chip, 'bg-primary/10 text-primary')}>
          {t('leadChip')}
        </span>
      )}
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
      <p className="text-muted-foreground text-xs">{t('order')}</p>
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
                  <TableHead>{t('columns.customer')}</TableHead>
                  <TableHead>{t('columns.stage')}</TableHead>
                  <TableHead>{t('columns.product')}</TableHead>
                  <TableHead>{t('columns.agent')}</TableHead>
                  <TableHead>{t('columns.coordinator')}</TableHead>
                  <TableHead>{t('columns.sla')}</TableHead>
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
                      className="hover:bg-accent relative align-top"
                    >
                      <TableCell className="max-w-48 text-sm whitespace-normal">
                        <Customer c={c} name={v.customer} />
                      </TableCell>
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
                      <TableCell className="whitespace-normal">
                        <SlaChip c={c} nextDue={v.nextDue} />
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
                // One stretched case link over the card, and the customer
                // link above it: two sibling anchors, never one inside the
                // other.
                <li
                  key={c.caseId}
                  className="border-border bg-card hover:bg-accent relative space-y-2 rounded-xl border p-3 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <Link
                      href={`/cases/${c.caseId}`}
                      aria-label={t('openCase', {
                        stage: c.stage || t('noStage'),
                      })}
                      className="after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:underline"
                    >
                      <StageChip c={c} />
                    </Link>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {v.closed
                        ? t('closedOn', { date: v.closed })
                        : t('openedOn', { date: v.opened })}
                    </span>
                  </div>
                  <p className="truncate text-sm">
                    <Customer c={c} name={v.customer} />
                  </p>
                  <SlaChip c={c} nextDue={v.nextDue} />
                  <p className="truncate text-sm">{v.product}</p>
                  <p className="text-muted-foreground text-xs">
                    {t('agentLabel', { name: v.agent })} ·{' '}
                    {t('coordinatorLabel', { name: v.coordinator })}
                  </p>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
