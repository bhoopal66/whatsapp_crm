'use client';

// ============================================================
// Taamul Compass — what the ERP has synced and sent (migration 056).
//
// Read-only on purpose: Compass is the system of record for these
// customers, so editing them here would only be overwritten by the
// next sync. Writes arrive through /api/v1/compass/* (docs/compass.md).
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { Building2, Loader2, Search } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const PAGE_SIZE = 50;

interface CompassContact {
  id: string;
  compass_id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  company: string | null;
  contact_id: string | null;
  updated_at: string;
}

interface CompassNotification {
  id: string;
  idempotency_key: string;
  compass_id: string | null;
  event: string | null;
  reference: string | null;
  phone: string | null;
  content_text: string | null;
  status: 'sending' | 'sent' | 'failed';
  error_message: string | null;
  created_at: string;
  message: { status: string | null } | null;
}

// Keep only characters a name, phone or ERP id contains, so a search
// term can't break PostgREST's `.or()` grammar.
function sanitizeSearch(raw: string): string {
  return raw.replace(/[^\p{L}\p{N} +@.\-_]/gu, '').trim();
}

function ago(iso: string) {
  return formatDistanceToNow(new Date(iso), { addSuffix: true });
}

export default function CompassPage() {
  const t = useTranslations('Compass');
  const { accountId } = useAuth();
  const [tab, setTab] = useState<'customers' | 'notifications' | 'submissions'>(
    'customers'
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-foreground flex items-center gap-2 text-2xl font-bold">
          <Building2 className="h-6 w-6" />
          {t('title')}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('subtitle')}</p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList>
          <TabsTrigger value="customers">{t('tabs.customers')}</TabsTrigger>
          <TabsTrigger value="notifications">
            {t('tabs.notifications')}
          </TabsTrigger>
          <TabsTrigger value="submissions">{t('tabs.submissions')}</TabsTrigger>
        </TabsList>
        <TabsContent value="customers" className="mt-4">
          {accountId && <CustomersTab accountId={accountId} />}
        </TabsContent>
        <TabsContent value="notifications" className="mt-4">
          {accountId && <NotificationsTab accountId={accountId} />}
        </TabsContent>
        <TabsContent value="submissions" className="mt-4">
          {accountId && <SubmissionsTab />}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function CustomersTab({ accountId }: { accountId: string }) {
  const t = useTranslations('Compass');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<CompassContact[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (offset: number) => {
      const supabase = createClient();
      let query = supabase
        .from('compass_contacts')
        .select(
          'id, compass_id, name, phone, email, company, contact_id, updated_at',
          { count: 'exact' }
        )
        .eq('account_id', accountId);
      const term = sanitizeSearch(search);
      if (term) {
        query = query.or(
          `name.ilike.*${term}*,phone.ilike.*${term}*,compass_id.ilike.*${term}*`
        );
      }
      const {
        data,
        error: err,
        count,
      } = await query
        .order('updated_at', { ascending: false })
        .order('id', { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);
      if (err) {
        setError(err.message);
        return;
      }
      setError(null);
      setTotal(count ?? null);
      setHasMore((data ?? []).length === PAGE_SIZE);
      setRows((prev) =>
        offset === 0
          ? ((data ?? []) as CompassContact[])
          : [...(prev ?? []), ...((data ?? []) as CompassContact[])]
      );
    },
    [accountId, search]
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
            {t('totalCustomers', { count: total })}
          </p>
        )}
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}

      {rows === null ? (
        <Loader2 className="text-muted-foreground mx-auto h-6 w-6 animate-spin" />
      ) : rows.length === 0 ? (
        <div className="border-border bg-card text-muted-foreground rounded-xl border p-10 text-center text-sm">
          {search ? t('noMatches') : t('noCustomers')}
        </div>
      ) : (
        <div className="border-border bg-card overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead>{t('table.compassId')}</TableHead>
                <TableHead>{t('table.name')}</TableHead>
                <TableHead>{t('table.phone')}</TableHead>
                <TableHead className="hidden md:table-cell">
                  {t('table.email')}
                </TableHead>
                <TableHead className="hidden lg:table-cell">
                  {t('table.company')}
                </TableHead>
                <TableHead>{t('table.chat')}</TableHead>
                <TableHead className="hidden sm:table-cell">
                  {t('table.synced')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} className="border-border">
                  <TableCell className="font-mono text-xs">
                    {row.compass_id}
                  </TableCell>
                  <TableCell className="text-foreground font-medium">
                    {row.name ?? '—'}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {row.phone ? `+${row.phone}` : '—'}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {row.email ?? '—'}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    {row.company ?? '—'}
                  </TableCell>
                  <TableCell>
                    {row.contact_id ? (
                      <Badge variant="secondary">{t('linked')}</Badge>
                    ) : (
                      <span className="text-muted-foreground text-xs">
                        {t('notYet')}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden text-xs sm:table-cell">
                    {ago(row.updated_at)}
                  </TableCell>
                </TableRow>
              ))}
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

function NotificationsTab({ accountId }: { accountId: string }) {
  const t = useTranslations('Compass');
  const [rows, setRows] = useState<CompassNotification[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error: err } = await createClient()
        .from('compass_notifications')
        .select(
          'id, idempotency_key, compass_id, event, reference, phone, content_text, status, error_message, created_at, message:messages(status)'
        )
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(100);
      if (cancelled) return;
      if (err) setError(err.message);
      else setRows((data ?? []) as unknown as CompassNotification[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  if (error) return <p className="text-destructive text-sm">{error}</p>;
  if (rows === null) {
    return (
      <Loader2 className="text-muted-foreground mx-auto h-6 w-6 animate-spin" />
    );
  }
  if (rows.length === 0) {
    return (
      <div className="border-border bg-card text-muted-foreground rounded-xl border p-10 text-center text-sm">
        {t('noNotifications')}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs">{t('latest100')}</p>
      <div className="border-border bg-card overflow-x-auto rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead>{t('table.when')}</TableHead>
              <TableHead>{t('table.recipient')}</TableHead>
              <TableHead>{t('table.message')}</TableHead>
              <TableHead className="hidden md:table-cell">
                {t('table.reference')}
              </TableHead>
              <TableHead>{t('table.status')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} className="border-border align-top">
                <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                  {ago(row.created_at)}
                </TableCell>
                <TableCell className="text-xs">
                  <div className="font-mono">
                    {row.phone ? `+${row.phone}` : '—'}
                  </div>
                  {row.compass_id && (
                    <div className="text-muted-foreground">
                      {row.compass_id}
                    </div>
                  )}
                </TableCell>
                <TableCell className="max-w-md text-sm">
                  <p className="line-clamp-2">{row.content_text ?? '—'}</p>
                  {row.status === 'failed' && row.error_message && (
                    <p className="text-destructive mt-1 text-xs">
                      {row.error_message}
                    </p>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground hidden text-xs md:table-cell">
                  {row.reference ?? row.event ?? row.idempotency_key}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={
                      row.status === 'failed'
                        ? 'destructive'
                        : row.status === 'sent'
                          ? 'secondary'
                          : 'outline'
                    }
                  >
                    {row.status === 'sent' && row.message?.status
                      ? t(`delivery.${deliveryKey(row.message.status)}`)
                      : t(`status.${row.status}`)}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

interface Submission {
  submissionRef: string;
  status: string;
  createdAt: string;
  endedAt: string | null;
  customer: string | null;
  caseId: string | null;
  stage: string | null;
  bankCode: string | null;
  externalChangedAt: string | null;
}

interface WebhookCount {
  event: string;
  delivered: number;
  pending: number;
}

// Submission groups with their case (stage, bank, last Compass sync),
// and the webhook outbox over 7 days. Server-side (GET
// /api/compass/submissions): the outbox is service-role only.
function SubmissionsTab() {
  const t = useTranslations('Compass');
  const [data, setData] = useState<{
    submissions: Submission[];
    webhooks: WebhookCount[];
  } | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/compass/submissions', {
          cache: 'no-store',
        });
        const body = res.ok ? await res.json() : null;
        if (cancelled) return;
        if (!body) setError(true);
        else setData(body);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <p className="text-destructive text-sm" role="alert">
        {t('submissions.loadFailed')}
      </p>
    );
  }
  if (data === null) {
    return (
      <Loader2 className="text-muted-foreground mx-auto h-6 w-6 animate-spin" />
    );
  }

  return (
    <div className="space-y-6">
      {data.submissions.length === 0 ? (
        <div className="border-border bg-card text-muted-foreground rounded-xl border p-10 text-center text-sm">
          {t('submissions.empty')}
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-muted-foreground text-xs">
            {t('submissions.latest100')}
          </p>
          <div className="border-border bg-card overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead>{t('submissions.table.submission')}</TableHead>
                  <TableHead>{t('submissions.table.customer')}</TableHead>
                  <TableHead>{t('submissions.table.bank')}</TableHead>
                  <TableHead>{t('submissions.table.stage')}</TableHead>
                  <TableHead>{t('submissions.table.group')}</TableHead>
                  <TableHead>{t('submissions.table.synced')}</TableHead>
                  <TableHead>{t('submissions.table.case')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.submissions.map((row) => (
                  <TableRow key={row.submissionRef} className="border-border">
                    <TableCell className="font-mono text-xs">
                      {row.submissionRef}
                    </TableCell>
                    <TableCell className="text-sm">
                      {row.customer ?? '—'}
                    </TableCell>
                    <TableCell className="text-xs">
                      {row.bankCode ?? '—'}
                    </TableCell>
                    <TableCell className="text-sm">
                      {row.stage ?? '—'}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          row.status === 'ENDED' ? 'outline' : 'secondary'
                        }
                      >
                        {row.status === 'ENDED'
                          ? t('submissions.groupStatus.ended')
                          : t('submissions.groupStatus.active')}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                      {row.externalChangedAt
                        ? ago(row.externalChangedAt)
                        : t('submissions.never')}
                    </TableCell>
                    <TableCell className="text-xs">
                      {row.caseId ? (
                        <Link
                          href={`/cases/${row.caseId}`}
                          className="text-primary hover:underline"
                        >
                          {t('submissions.openCase')}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <h2 className="text-foreground text-sm font-semibold">
          {t('submissions.webhooks.title')}
        </h2>
        <div className="border-border bg-card overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead>{t('submissions.webhooks.event')}</TableHead>
                <TableHead className="text-right">
                  {t('submissions.webhooks.delivered')}
                </TableHead>
                <TableHead className="text-right">
                  {t('submissions.webhooks.pending')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.webhooks.map((row) => (
                <TableRow key={row.event} className="border-border">
                  <TableCell className="font-mono text-xs">
                    {row.event}
                  </TableCell>
                  <TableCell className="text-right text-sm tabular-nums">
                    {row.delivered}
                  </TableCell>
                  <TableCell
                    className={
                      row.pending > 0
                        ? 'text-warning text-right text-sm tabular-nums'
                        : 'text-right text-sm tabular-nums'
                    }
                  >
                    {row.pending}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

// `messages.status` values the webhooks write, mapped onto catalogue
// keys; anything unexpected reads as plain "sent".
function deliveryKey(status: string): 'sent' | 'delivered' | 'read' | 'failed' {
  return status === 'delivered' || status === 'read' || status === 'failed'
    ? status
    : 'sent';
}
