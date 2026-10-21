'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import {
  Briefcase,
  FileX,
  Hourglass,
  Loader2,
  MessageCircleQuestion,
  Plus,
  SlidersHorizontal,
  TriangleAlert,
  X,
} from 'lucide-react';

import { useWorkspaceMembers } from '@/components/meetings/use-workspace-members';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { OpenLeadDialog } from '@/components/cases/open-lead-dialog';
import { useAuth } from '@/hooks/use-auth';
import { canSendMessages } from '@/lib/auth/roles';
import { cachedQuery, REFERENCE_CACHE_TTL_MS } from '@/lib/client-cache';
import { LEAD_CHIP } from '@/lib/cases/lead-form';
import {
  activeFilterCount,
  appendRows,
  EMPTY_FILTERS,
  filtersFromSearch,
  filtersToSearch,
  formatAed,
  stageFilterOptions,
  inboxUrl,
  INBOX_SORTS,
  NO_ACTIVITY_DAYS_DEFAULT,
  NO_ACTIVITY_DAYS_MAX,
  parseBanks,
  parseDays,
  parseInboxPage,
  PRIORITIES,
  SLA_STATES,
  type CaseBankOption,
  type InboxFilters,
  type InboxRow,
  type InboxSlaState,
} from '@/lib/cases/ui';
import type { CasePriority } from '@/lib/cases/types';
import { relativeActivity } from '@/lib/groups/ui';
import { cn } from '@/lib/utils';

/** The Select's value for "no filter" (an item value cannot be empty). */
const ALL = '__all__';

interface Loaded {
  rows: InboxRow[];
  next: string | null;
  error: null | 'invalid' | 'failed';
}

const SLA_CHIP: Record<InboxSlaState, string> = {
  on_track: 'bg-success-soft text-success ring-1 ring-success/30 ring-inset',
  due_soon: 'bg-warning-soft text-warning ring-1 ring-warning/30 ring-inset',
  overdue:
    'bg-destructive-soft text-destructive ring-1 ring-destructive/30 ring-inset',
};

/** Only the raised priorities get a chip; low and normal stay quiet. */
const PRIORITY_CHIP: Partial<Record<CasePriority, string>> = {
  high: 'bg-warning-soft text-warning ring-1 ring-warning/30 ring-inset',
  urgent:
    'bg-destructive-soft text-destructive ring-1 ring-destructive/30 ring-inset',
};

/** The shared Switch's unchecked track (bg-muted) vanishes on a white
 * card; the filter bar gives it the input line colour instead. */
const SWITCH_OFF = 'data-[unchecked]:bg-input';

const chip =
  'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium';

/** The workspace's case banks; null while loading, [] on any failure. */
function useCaseBanks(): CaseBankOption[] | null {
  const { accountId } = useAuth();
  const [banks, setBanks] = useState<CaseBankOption[] | null>(null);
  useEffect(() => {
    if (!accountId) return;
    let live = true;
    cachedQuery(`case-banks:${accountId}`, REFERENCE_CACHE_TTL_MS, async () => {
      const res = await fetch('/api/cases/config/banks', {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(String(res.status));
      return parseBanks(await res.json());
    })
      .catch(() => [] as CaseBankOption[])
      .then((list) => {
        if (live) setBanks(list);
      });
    return () => {
      live = false;
    };
  }, [accountId]);
  return banks;
}

/** /cases — the coordinator inbox (module 019). */
export function CasesInbox() {
  const t = useTranslations('Cases');
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const filters = useMemo(
    () => filtersFromSearch((k) => search.get(k)),
    [search]
  );
  const setFilters = (next: Partial<InboxFilters>) => {
    const qs = filtersToSearch({ ...filters, ...next });
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const banks = useCaseBanks();
  const { members, nameOf } = useWorkspaceMembers();
  const agents = useMemo(
    () =>
      members
        .filter((m) => !m.deactivated_at)
        .map((m) => ({ id: m.user_id, name: m.full_name || m.email }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [members]
  );

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [newLeadOpen, setNewLeadOpen] = useState(false);
  const { accountRole } = useAuth();
  const canOpenLead = !!accountRole && canSendMessages(accountRole);
  const seq = useRef(0);

  const apiUrl = inboxUrl(filters, null);
  const load = useCallback(async (url: string) => {
    const mine = ++seq.current;
    setLoaded(null);
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.status === 422) {
        if (mine === seq.current)
          setLoaded({ rows: [], next: null, error: 'invalid' });
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const page = parseInboxPage(await res.json());
      if (mine === seq.current)
        setLoaded({ rows: page.rows, next: page.nextCursor, error: null });
    } catch {
      if (mine === seq.current)
        setLoaded({ rows: [], next: null, error: 'failed' });
    }
  }, []);

  useEffect(() => {
    void load(apiUrl);
  }, [load, apiUrl]);

  const loadMore = async () => {
    if (!loaded?.next) return;
    const mine = seq.current;
    setLoadingMore(true);
    try {
      const res = await fetch(inboxUrl(filters, loaded.next), {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(String(res.status));
      const page = parseInboxPage(await res.json());
      if (mine === seq.current)
        setLoaded((prev) =>
          prev
            ? {
                rows: appendRows(prev.rows, page.rows),
                next: page.nextCursor,
                error: null,
              }
            : prev
        );
    } catch {
      // Keep what is listed; the button stays for another try.
    } finally {
      setLoadingMore(false);
    }
  };

  const narrowed = activeFilterCount(filters);
  const now = new Date();

  return (
    <div className="w-full space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canOpenLead && (
            <Button size="sm" onClick={() => setNewLeadOpen(true)}>
              <Plus className="size-4" aria-hidden />
              {t('newLead')}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="md:hidden"
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((o) => !o)}
          >
            <SlidersHorizontal className="size-4" aria-hidden />
            {t('filtersButton')}
            {narrowed > 0 && (
              <span className="bg-primary text-primary-foreground rounded-full px-1.5 text-[11px]">
                {narrowed}
              </span>
            )}
          </Button>
        </div>
      </div>
      <OpenLeadDialog
        open={newLeadOpen}
        onOpenChange={setNewLeadOpen}
        banks={banks}
      />

      <FilterBar
        className={cn(filtersOpen ? 'block' : 'hidden', 'md:block')}
        filters={filters}
        setFilters={setFilters}
        banks={banks ?? []}
        agents={agents}
        narrowed={narrowed}
        rows={loaded?.rows ?? []}
      />

      {!loaded ? (
        <ul className="space-y-2" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <li
              key={i}
              className="border-border bg-card space-y-2 rounded-xl border p-4"
            >
              <span className="bg-muted block h-4 w-1/3 animate-pulse rounded" />
              <span className="bg-muted block h-3 w-2/3 animate-pulse rounded" />
            </li>
          ))}
        </ul>
      ) : loaded.error ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-destructive text-sm">
            {loaded.error === 'invalid' ? t('invalidFilters') : t('loadFailed')}
          </p>
          {loaded.error === 'invalid' ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFilters(EMPTY_FILTERS)}
            >
              {t('clearFilters')}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load(apiUrl)}
            >
              {t('retry')}
            </Button>
          )}
        </div>
      ) : loaded.rows.length === 0 ? (
        <div className="border-border flex flex-col items-center gap-3 rounded-xl border border-dashed px-4 py-12 text-center">
          <span className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
            <Briefcase className="size-5" aria-hidden />
          </span>
          <p className="font-semibold">
            {narrowed > 0 ? t('noMatchesTitle') : t('emptyTitle')}
          </p>
          <p className="text-muted-foreground max-w-md text-sm">
            {narrowed > 0 ? t('noMatchesBody') : t('emptyBody')}
          </p>
          {narrowed > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFilters(EMPTY_FILTERS)}
            >
              {t('clearFilters')}
            </Button>
          )}
        </div>
      ) : (
        <>
          <CasesTable rows={loaded.rows} now={now} nameOf={nameOf} />
          <ul className="space-y-2 md:hidden">
            {loaded.rows.map((r) => (
              <CaseCard key={r.caseId} row={r} now={now} nameOf={nameOf} />
            ))}
          </ul>
          {loaded.next && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore && (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                )}
                {t('loadMore')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------
// Filters
// ------------------------------------------------------------

function FilterSelect({
  label,
  allLabel,
  value,
  options,
  onChange,
}: {
  label: string;
  /** Null: the select always holds a value (the sort). */
  allLabel: string | null;
  value: string | null;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (v: string | null) => void;
}) {
  const current = value ?? ALL;
  const shown =
    value === null
      ? (allLabel ?? '')
      : (options.find((o) => o.value === value)?.label ?? value);
  // A value from a shared link that is not (yet) an option still shows.
  const all =
    value !== null && !options.some((o) => o.value === value)
      ? [...options, { value, label: value }]
      : options;
  return (
    <div className="min-w-0 space-y-1">
      <Label className="text-muted-foreground text-xs">{label}</Label>
      <Select
        value={current}
        onValueChange={(v) => {
          if (typeof v !== 'string') return;
          onChange(v === ALL ? null : v);
        }}
      >
        <SelectTrigger aria-label={label} className="w-full">
          <SelectValue>{shown}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {allLabel !== null && <SelectItem value={ALL}>{allLabel}</SelectItem>}
          {all.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function Toggle({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={(v) => onChange(!!v)}
        className={SWITCH_OFF}
      />
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
    </div>
  );
}

function FilterBar({
  className,
  filters: f,
  setFilters,
  banks,
  agents,
  narrowed,
  rows,
}: {
  className?: string;
  filters: InboxFilters;
  setFilters: (next: Partial<InboxFilters>) => void;
  banks: CaseBankOption[];
  agents: Array<{ id: string; name: string }>;
  narrowed: number;
  rows: readonly { stage: string }[];
}) {
  const t = useTranslations('Cases');

  // The day count being typed; it reaches the URL on blur or Enter.
  const urlDays = f.noActivityDays === null ? '' : String(f.noActivityDays);
  const [daysDraft, setDaysDraft] = useState(urlDays);
  const [daysSeen, setDaysSeen] = useState(urlDays);
  if (daysSeen !== urlDays) {
    setDaysSeen(urlDays);
    setDaysDraft(urlDays);
  }
  const commitDays = () => {
    const days = parseDays(daysDraft);
    if (days === null) setDaysDraft(urlDays);
    else if (days !== f.noActivityDays) setFilters({ noActivityDays: days });
  };

  return (
    <div
      className={cn(
        'border-border bg-card space-y-3 rounded-xl border p-3',
        className
      )}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <FilterSelect
          label={t('filters.bank')}
          allLabel={t('filters.allBanks')}
          value={f.bank}
          options={banks.map((b) => ({ value: b.code, label: b.name }))}
          onChange={(bank) => setFilters({ bank })}
        />
        <FilterSelect
          label={t('filters.stage')}
          allLabel={t('filters.allStages')}
          value={f.stage}
          options={stageFilterOptions(rows, f.stage).map((s) => ({
            value: s,
            label: s,
          }))}
          onChange={(stage) => setFilters({ stage })}
        />
        <FilterSelect
          label={t('filters.agent')}
          allLabel={t('filters.allAgents')}
          value={f.agent}
          options={agents.map((a) => ({ value: a.id, label: a.name }))}
          onChange={(agent) => setFilters({ agent })}
        />
        <FilterSelect
          label={t('filters.priority')}
          allLabel={t('filters.allPriorities')}
          value={f.priority}
          options={PRIORITIES.map((p) => ({
            value: p,
            label: t(`priorities.${p}`),
          }))}
          onChange={(p) => setFilters({ priority: p as CasePriority | null })}
        />
        <FilterSelect
          label={t('filters.sla')}
          allLabel={t('filters.allSla')}
          value={f.slaState}
          options={SLA_STATES.map((s) => ({ value: s, label: t(`sla.${s}`) }))}
          onChange={(s) => setFilters({ slaState: s as InboxSlaState | null })}
        />
        <FilterSelect
          label={t('filters.sort')}
          allLabel={null}
          value={f.sort}
          options={INBOX_SORTS.map((s) => ({
            value: s,
            label: t(`sorts.${s}`),
          }))}
          onChange={(s) =>
            setFilters({ sort: (s ?? 'most_overdue') as InboxFilters['sort'] })
          }
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <Toggle
          id="cases-customer-waiting"
          label={t('filters.customerWaiting')}
          checked={f.customerWaiting}
          onChange={(customerWaiting) => setFilters({ customerWaiting })}
        />
        <Toggle
          id="cases-documents-missing"
          label={t('filters.documentsMissing')}
          checked={f.documentsMissing}
          onChange={(documentsMissing) => setFilters({ documentsMissing })}
        />
        <Toggle
          id="cases-bank-query"
          label={t('filters.bankQueryOpen')}
          checked={f.bankQueryOpen}
          onChange={(bankQueryOpen) => setFilters({ bankQueryOpen })}
        />
        <div className="flex items-center gap-2">
          <Switch
            id="cases-no-activity"
            checked={f.noActivityDays !== null}
            className={SWITCH_OFF}
            onCheckedChange={(on) =>
              setFilters({
                noActivityDays: on
                  ? (parseDays(daysDraft) ?? NO_ACTIVITY_DAYS_DEFAULT)
                  : null,
              })
            }
          />
          <Label htmlFor="cases-no-activity" className="text-sm font-normal">
            {t('filters.noActivity')}
          </Label>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={NO_ACTIVITY_DAYS_MAX}
            aria-label={`${t('filters.noActivity')} (${t('filters.noActivityDays')})`}
            className="disabled:bg-muted h-8 w-20 disabled:opacity-70"
            disabled={f.noActivityDays === null}
            value={f.noActivityDays === null ? '' : daysDraft}
            onChange={(e) => setDaysDraft(e.target.value)}
            onBlur={commitDays}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitDays();
            }}
          />
          <span className="text-muted-foreground text-sm">
            {t('filters.noActivityDays')}
          </span>
        </div>
        <Toggle
          id="cases-include-closed"
          label={t('filters.includeClosed')}
          checked={f.includeClosed}
          onChange={(includeClosed) => setFilters({ includeClosed })}
        />
        {narrowed > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => setFilters({ ...EMPTY_FILTERS, sort: f.sort })}
          >
            <X className="size-4" aria-hidden />
            {t('clearFilters')}
          </Button>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Rows
// ------------------------------------------------------------

type NameOf = (userId: string) => string | null;

/** "3 hours ago" / "just now" / "12 Oct", or null when unknown. */
function useRelative() {
  const t = useTranslations('Cases');
  const locale = useLocale();
  return (iso: string | null, now: Date): string | null => {
    const a = relativeActivity(iso, now);
    if (a.unit === 'none') return null;
    if (a.unit === 'now') return t('justNow');
    if (a.unit === 'date')
      return a.date.toLocaleDateString(locale, {
        day: 'numeric',
        month: 'short',
        year:
          a.date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
      });
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(
      -a.value,
      a.unit
    );
  };
}

/** The pieces both layouts show, worded once. */
function useRowView(row: InboxRow, now: Date, nameOf: NameOf) {
  const t = useTranslations('Cases');
  const locale = useLocale();
  const relative = useRelative();
  const when = relative(row.lastActivityAt, now);
  const who = row.lastTouchedBy ? nameOf(row.lastTouchedBy) : null;
  const due = row.dueAt ? new Date(row.dueAt) : null;
  return {
    customer: row.contactName ?? t('noCustomer'),
    bank: row.bankName ?? row.bankCode ?? t('noBank'),
    product: [row.product, formatAed(row.amount, locale)]
      .filter(Boolean)
      .join(' · '),
    agent: row.agentId
      ? (nameOf(row.agentId) ?? t('unknownPerson'))
      : t('unassigned'),
    coordinator: row.coordinatorId
      ? (nameOf(row.coordinatorId) ?? t('unknownPerson'))
      : t('noCoordinator'),
    lastActivity: when && who ? t('byWhom', { when, name: who }) : when,
    due:
      due && Number.isFinite(due.getTime())
        ? due.toLocaleString(locale, {
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
          })
        : null,
  };
}

function Chips({ row }: { row: InboxRow }) {
  const t = useTranslations('Cases');
  const priority = PRIORITY_CHIP[row.priority];
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span className={cn(chip, 'bg-secondary text-secondary-foreground')}>
        {row.stage}
      </span>
      {row.isLead && (
        <span className={cn(chip, LEAD_CHIP)}>{t('leadChip')}</span>
      )}
      {row.slaState && (
        <span className={cn(chip, SLA_CHIP[row.slaState])}>
          {t(`sla.${row.slaState}`)}
        </span>
      )}
      {priority && (
        <span className={cn(chip, priority)}>
          {t(`priorities.${row.priority}`)}
        </span>
      )}
      {row.closedAt && (
        <span className={cn(chip, 'bg-muted text-muted-foreground')}>
          {t('closed')}
        </span>
      )}
    </span>
  );
}

function Flags({ row }: { row: InboxRow }) {
  const t = useTranslations('Cases');
  const flags: Array<{
    key: string;
    icon: typeof Hourglass;
    text: string;
    urgent?: boolean;
  }> = [];
  if (row.customerWaiting)
    flags.push({
      key: 'waiting',
      icon: Hourglass,
      text: t('flags.customerWaiting'),
    });
  if (row.documentsMissing > 0)
    flags.push({
      key: 'docs',
      icon: FileX,
      text: t('flags.documentsMissing', { count: row.documentsMissing }),
    });
  if (row.bankQueryOpen)
    flags.push({
      key: 'query',
      icon: MessageCircleQuestion,
      text: t('flags.bankQuery'),
    });
  if (row.openTaskOverdueCount > 0)
    flags.push({
      key: 'tasks',
      icon: TriangleAlert,
      text: t('flags.overdueTasks', { count: row.openTaskOverdueCount }),
      urgent: true,
    });
  if (flags.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs font-medium">
      {flags.map(({ key, icon: Icon, text, urgent }) => (
        <span
          key={key}
          className={cn(
            'inline-flex items-center gap-1',
            urgent ? 'text-destructive' : 'text-warning'
          )}
        >
          <Icon className="size-3.5" aria-hidden />
          {text}
        </span>
      ))}
    </span>
  );
}

function CasesTable({
  rows,
  now,
  nameOf,
}: {
  rows: InboxRow[];
  now: Date;
  nameOf: NameOf;
}) {
  const t = useTranslations('Cases');
  return (
    <div className="border-border bg-card hidden rounded-xl border md:block">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('columns.customer')}</TableHead>
            <TableHead>{t('columns.bank')}</TableHead>
            <TableHead>{t('columns.stage')}</TableHead>
            <TableHead>{t('columns.people')}</TableHead>
            <TableHead>{t('columns.lastActivity')}</TableHead>
            <TableHead>{t('columns.due')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRowView key={r.caseId} row={r} now={now} nameOf={nameOf} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function TableRowView({
  row,
  now,
  nameOf,
}: {
  row: InboxRow;
  now: Date;
  nameOf: NameOf;
}) {
  const t = useTranslations('Cases');
  const v = useRowView(row, now, nameOf);
  return (
    // The customer link is stretched over the whole row.
    <TableRow className="hover:bg-accent relative align-top">
      <TableCell className="max-w-64 whitespace-normal">
        <Link
          href={`/cases/${row.caseId}`}
          className="font-semibold after:absolute after:inset-0 after:content-[''] focus-visible:underline"
        >
          {v.customer}
        </Link>
        {row.submissionRef && (
          <span className="text-muted-foreground block text-xs">
            {row.submissionRef}
          </span>
        )}
        <span className="mt-1 block">
          <Flags row={row} />
        </span>
      </TableCell>
      <TableCell className="max-w-56 whitespace-normal">
        <span className="block">{v.bank}</span>
        {v.product && (
          <span className="text-muted-foreground block text-xs">
            {v.product}
          </span>
        )}
      </TableCell>
      <TableCell className="whitespace-normal">
        <Chips row={row} />
      </TableCell>
      <TableCell className="text-xs whitespace-normal">
        <span className="block">{t('agentLabel', { name: v.agent })}</span>
        <span className="text-muted-foreground block">
          {t('coordinatorLabel', { name: v.coordinator })}
        </span>
      </TableCell>
      <TableCell className="text-muted-foreground text-xs whitespace-normal">
        {v.lastActivity ?? '—'}
      </TableCell>
      <TableCell className="text-xs">{v.due ?? t('noDue')}</TableCell>
    </TableRow>
  );
}

function CaseCard({
  row,
  now,
  nameOf,
}: {
  row: InboxRow;
  now: Date;
  nameOf: NameOf;
}) {
  const t = useTranslations('Cases');
  const v = useRowView(row, now, nameOf);
  return (
    <li>
      <Link
        href={`/cases/${row.caseId}`}
        className="border-border bg-card hover:bg-accent block space-y-2 rounded-xl border p-3 transition-colors"
      >
        <span className="flex items-start justify-between gap-2">
          <span className="min-w-0">
            <span className="block truncate font-semibold">{v.customer}</span>
            {row.submissionRef && (
              <span className="text-muted-foreground block truncate text-xs">
                {row.submissionRef}
              </span>
            )}
          </span>
          <span className="text-muted-foreground shrink-0 text-xs">
            {v.due ? t('dueOn', { date: v.due }) : t('noDue')}
          </span>
        </span>
        <span className="text-muted-foreground block truncate text-sm">
          {[v.bank, v.product].filter(Boolean).join(' · ')}
        </span>
        <Chips row={row} />
        <Flags row={row} />
        <span className="text-muted-foreground block text-xs">
          {t('agentLabel', { name: v.agent })} ·{' '}
          {t('coordinatorLabel', { name: v.coordinator })}
        </span>
        {v.lastActivity && (
          <span className="text-muted-foreground block text-xs">
            {v.lastActivity}
          </span>
        )}
      </Link>
    </li>
  );
}
