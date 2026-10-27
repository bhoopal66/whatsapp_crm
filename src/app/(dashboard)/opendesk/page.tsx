'use client';

// ============================================================
// OpenDesk — contacts the Taamul sales app marked Interested
// (migration 139, docs/taamul-sales.md).
//
// Read-only on purpose: the sales app is the system of record for these
// contacts, and each new mark rewrites the row. They are kept apart from
// the CRM's contacts, as Compass customers are. Writes arrive only
// through POST /api/taamul-sales/webhook.
// ============================================================

import { Fragment, useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { format, formatDistanceToNow } from 'date-fns';
import {
  ChevronDown,
  ChevronRight,
  Headset,
  Loader2,
  Search,
} from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const PAGE_SIZE = 50;

interface OpenDeskContact {
  id: string;
  taamul_contact_id: string;
  customer_name: string | null;
  company_name: string | null;
  phone: string | null;
  phone_raw: string | null;
  additional_phones: string[];
  trade_license_number: string | null;
  industry: string | null;
  area: string | null;
  city: string | null;
  is_existing_customer: boolean | null;
  agent_username: string | null;
  agent_name: string | null;
  agent_email: string | null;
  agent_team: string | null;
  called_at: string | null;
  call_notes: string | null;
  lead_id: string | null;
  lead_status: string | null;
  interested_count: number;
  first_interested_at: string | null;
  last_interested_at: string | null;
}

const COLUMNS =
  'id, taamul_contact_id, customer_name, company_name, phone, phone_raw, additional_phones, trade_license_number, industry, area, city, is_existing_customer, agent_username, agent_name, agent_email, agent_team, called_at, call_notes, lead_id, lead_status, interested_count, first_interested_at, last_interested_at';

// Keep only characters a name, phone or licence number contains, so a
// search term can't break PostgREST's `.or()` grammar.
function sanitizeSearch(raw: string): string {
  return raw.replace(/[^\p{L}\p{N} +@.\-_]/gu, '').trim();
}

const ago = (iso: string) =>
  formatDistanceToNow(new Date(iso), { addSuffix: true });
const when = (iso: string) => format(new Date(iso), 'd MMM yyyy, HH:mm');
const phoneOf = (row: OpenDeskContact) =>
  row.phone ? `+${row.phone}` : (row.phone_raw ?? '—');

export default function OpenDeskPage() {
  const t = useTranslations('OpenDesk');
  const { accountId } = useAuth();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-foreground flex items-center gap-2 text-2xl font-bold">
          <Headset className="h-6 w-6" />
          {t('title')}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('subtitle')}</p>
      </div>
      {accountId && <ContactsList accountId={accountId} />}
    </div>
  );
}

function ContactsList({ accountId }: { accountId: string }) {
  const t = useTranslations('OpenDesk');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<OpenDeskContact[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(
    async (offset: number) => {
      let query = createClient()
        .from('taamul_sales_contacts')
        .select(COLUMNS, { count: 'exact' })
        .eq('account_id', accountId);
      const term = sanitizeSearch(search);
      if (term) {
        query = query.or(
          [
            'customer_name',
            'company_name',
            'phone',
            'phone_raw',
            'trade_license_number',
            'agent_name',
            'agent_username',
          ]
            .map((c) => `${c}.ilike.*${term}*`)
            .join(',')
        );
      }
      const {
        data,
        error: err,
        count,
      } = await query
        .order('last_interested_at', { ascending: false, nullsFirst: false })
        .order('id', { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);
      if (err) {
        setError(t('loadFailed'));
        return;
      }
      const page = (data ?? []) as OpenDeskContact[];
      setError(null);
      setTotal(count ?? null);
      setHasMore(page.length === PAGE_SIZE);
      setRows((prev) => (offset === 0 ? page : [...(prev ?? []), ...page]));
    },
    [accountId, search, t]
  );

  useEffect(() => {
    // Debounced so typing a name doesn't fire a query per keystroke.
    const handle = setTimeout(() => void load(0), 250);
    return () => clearTimeout(handle);
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="pl-9"
          />
        </div>
        {total !== null && (
          <p className="text-muted-foreground text-sm">
            {t('totalContacts', { count: total })}
          </p>
        )}
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}

      {rows === null ? (
        !error && (
          <Loader2 className="text-muted-foreground mx-auto h-6 w-6 animate-spin" />
        )
      ) : rows.length === 0 ? (
        <div className="border-border bg-card text-muted-foreground rounded-xl border p-10 text-center text-sm">
          {search ? t('noMatches') : t('noContacts')}
        </div>
      ) : (
        <div className="border-border bg-card overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="w-8" />
                <TableHead>{t('table.customer')}</TableHead>
                <TableHead>{t('table.phone')}</TableHead>
                <TableHead className="hidden lg:table-cell">
                  {t('table.tradeLicense')}
                </TableHead>
                <TableHead className="hidden md:table-cell">
                  {t('table.agent')}
                </TableHead>
                <TableHead className="hidden xl:table-cell">
                  {t('table.notes')}
                </TableHead>
                <TableHead>{t('table.lead')}</TableHead>
                <TableHead className="hidden sm:table-cell">
                  {t('table.interested')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const expanded = open === row.id;
                return (
                  <Fragment key={row.id}>
                    <TableRow
                      className="border-border cursor-pointer"
                      onClick={() => setOpen(expanded ? null : row.id)}
                      aria-expanded={expanded}
                    >
                      <TableCell className="text-muted-foreground">
                        {expanded ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="text-foreground font-medium">
                          {row.customer_name ?? row.company_name ?? '—'}
                        </div>
                        {row.customer_name && row.company_name && (
                          <div className="text-muted-foreground text-xs">
                            {row.company_name}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {phoneOf(row)}
                        {row.additional_phones.length > 0 && (
                          <span className="text-muted-foreground ml-1 font-sans">
                            {t('morePhones', {
                              count: row.additional_phones.length,
                            })}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="hidden font-mono text-xs lg:table-cell">
                        {row.trade_license_number ?? '—'}
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <div>{row.agent_name ?? row.agent_username ?? '—'}</div>
                        {row.agent_team && (
                          <div className="text-muted-foreground text-xs">
                            {row.agent_team}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground hidden max-w-xs truncate text-xs xl:table-cell">
                        {row.call_notes ?? '—'}
                      </TableCell>
                      <TableCell>
                        {row.lead_status ? (
                          <Badge variant="secondary">{row.lead_status}</Badge>
                        ) : (
                          <span className="text-muted-foreground text-xs">
                            {t('noLead')}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground hidden text-xs sm:table-cell">
                        {row.last_interested_at
                          ? ago(row.last_interested_at)
                          : '—'}
                        {row.interested_count > 1 && (
                          <div>
                            {t('times', { count: row.interested_count })}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                    {expanded && (
                      <TableRow className="border-border hover:bg-transparent">
                        <TableCell />
                        <TableCell colSpan={7} className="whitespace-normal">
                          <Details row={row} />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {hasMore && rows && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            disabled={loadingMore}
            onClick={async () => {
              setLoadingMore(true);
              await load(rows.length);
              setLoadingMore(false);
            }}
          >
            {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('loadMore')}
          </Button>
        </div>
      )}
    </div>
  );
}

function Details({ row }: { row: OpenDeskContact }) {
  const t = useTranslations('OpenDesk');
  const location = [row.area, row.city].filter(Boolean).join(', ');
  const agent = [
    row.agent_name,
    row.agent_username && `@${row.agent_username}`,
    row.agent_email,
  ]
    .filter(Boolean)
    .join(' · ');
  const items: [string, string | null][] = [
    [t('details.company'), row.company_name],
    [
      t('details.phones'),
      [phoneOf(row), ...row.additional_phones.map((p) => `+${p}`)].join(', '),
    ],
    [t('details.tradeLicense'), row.trade_license_number],
    [t('details.industry'), row.industry],
    [t('details.location'), location || null],
    [
      t('details.existingCustomer'),
      row.is_existing_customer === null
        ? null
        : row.is_existing_customer
          ? t('yes')
          : t('no'),
    ],
    [t('details.agent'), agent || null],
    [t('details.team'), row.agent_team],
    [t('details.calledAt'), row.called_at && when(row.called_at)],
    [
      t('details.lead'),
      [row.lead_status, row.lead_id].filter(Boolean).join(' · ') || null,
    ],
    [
      t('details.interested'),
      row.first_interested_at &&
        t('interestedSince', {
          count: row.interested_count,
          since: when(row.first_interested_at),
        }),
    ],
    [t('details.openDeskId'), row.taamul_contact_id],
  ];
  return (
    <div className="space-y-3 py-1">
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {items.map(([label, value]) => (
          <div key={label}>
            <dt className="text-muted-foreground text-xs">{label}</dt>
            <dd className="text-foreground break-words">{value ?? '—'}</dd>
          </div>
        ))}
      </dl>
      <div>
        <div className="text-muted-foreground text-xs">
          {t('details.notes')}
        </div>
        <p className="text-foreground text-sm whitespace-pre-wrap">
          {row.call_notes ?? '—'}
        </p>
      </div>
    </div>
  );
}
