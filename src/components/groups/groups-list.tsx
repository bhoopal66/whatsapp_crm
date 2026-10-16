'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Plus, RefreshCw, Search, Settings, UsersRound } from 'lucide-react';
import { toast } from 'sonner';

import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/use-auth';
import { useAccountNumbers } from '@/hooks/use-whatsapp-numbers';
import { canEditSettings } from '@/lib/auth/roles';
import { canSyncGroups } from '@/lib/groups/access';
import { canCreateGroups } from '@/lib/auth/roles';
import {
  filterGroups,
  groupInitials,
  parseGroupList,
  relativeActivity,
  type GroupListItem,
} from '@/lib/groups/ui';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';

import { CreateGroupDialog } from './create-group-dialog';

/** Realtime bursts (a sync touches every row) collapse into one re-read. */
const REFETCH_DEBOUNCE_MS = 400;

interface Loaded {
  groups: GroupListItem[];
  failed: boolean;
}

/** /groups — the account's WhatsApp groups, newest activity first. */
export function GroupsList() {
  const t = useTranslations('Groups');
  const { accountId, accountRole } = useAuth();
  const numbers = useAccountNumbers();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [query, setQuery] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [dialogKey, setDialogKey] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const mounted = useRef(true);

  const canCreate = !!accountRole && canCreateGroups(accountRole);
  const canSync = !!accountRole && canSyncGroups(accountRole);
  const isAdmin = !!accountRole && canEditSettings(accountRole);
  const hasWhapi = numbers?.some((n) => n.provider === 'whapi') ?? null;

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp/groups', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const groups = parseGroupList(await res.json());
      if (mounted.current) setLoaded({ groups, failed: false });
    } catch {
      // Keep what is on screen on a failed refresh; fail only a first load.
      if (mounted.current)
        setLoaded((prev) => prev ?? { groups: [], failed: true });
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  // Live: any change to the account's groups (an inbound message bumps
  // last_message_at, a sync or a colleague's edit) re-reads the list,
  // which applies the visibility rules server-side. Focus re-reads too,
  // for a tab that slept through a dropped socket.
  useEffect(() => {
    if (!accountId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), REFETCH_DEBOUNCE_MS);
    };
    const supabase = createClient();
    const channel = supabase
      .channel(`whatsapp-groups:${accountId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'whatsapp_groups',
          filter: `account_id=eq.${accountId}`,
        },
        soon
      )
      .subscribe();
    const onFocus = () => soon();
    window.addEventListener('focus', onFocus);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
      void supabase.removeChannel(channel);
    };
  }, [accountId, load]);

  const sync = async () => {
    setSyncing(true);
    try {
      const res = await fetch('/api/whatsapp/groups/sync', { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(t('syncFailed', { reason: json?.error ?? res.status }));
        return;
      }
      const n = (v: unknown) => (typeof v === 'number' ? v : 0);
      toast.success(
        t('syncDone', {
          synced: n(json.synced),
          created: n(json.created),
          left: n(json.left),
        })
      );
      void load();
    } catch {
      toast.error(t('syncFailed', { reason: 'network' }));
    } finally {
      setSyncing(false);
    }
  };

  const openNew = () => {
    setDialogKey((k) => k + 1);
    setDialogOpen(true);
  };

  const shown = useMemo(
    () => (loaded ? filterGroups(loaded.groups, query) : []),
    [loaded, query]
  );
  const now = new Date();

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canSync && hasWhapi && (
            <Button variant="outline" onClick={sync} disabled={syncing}>
              <RefreshCw
                className={cn('size-4', syncing && 'animate-spin')}
                aria-hidden
              />
              {syncing ? t('syncing') : t('sync')}
            </Button>
          )}
          {canCreate && hasWhapi && (
            <Button onClick={openNew}>
              <Plus className="size-4" aria-hidden />
              {t('newGroup')}
            </Button>
          )}
        </div>
      </div>

      {(loaded?.groups.length ?? 0) > 0 && (
        <div className="relative w-full sm:w-72">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('search')}
            aria-label={t('search')}
            className="pl-8"
          />
        </div>
      )}

      {!loaded || hasWhapi === null ? (
        <ul className="space-y-2" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <li
              key={i}
              className="border-border bg-card flex items-center gap-3 rounded-xl border p-4"
            >
              <span className="bg-muted size-10 shrink-0 animate-pulse rounded-full" />
              <span className="flex-1 space-y-2">
                <span className="bg-muted block h-4 w-1/3 animate-pulse rounded" />
                <span className="bg-muted block h-3 w-1/2 animate-pulse rounded" />
              </span>
            </li>
          ))}
        </ul>
      ) : loaded.failed ? (
        <p className="text-destructive text-sm">{t('loadFailed')}</p>
      ) : loaded.groups.length === 0 ? (
        !hasWhapi ? (
          <EmptyState
            title={t('noWhapiTitle')}
            body={isAdmin ? t('noWhapiAdmin') : t('noWhapiOther')}
            action={
              isAdmin ? (
                <Link
                  href="/settings?tab=whatsapp"
                  className={buttonVariants({ variant: 'outline' })}
                >
                  <Settings className="size-4" aria-hidden />
                  {t('openSettings')}
                </Link>
              ) : null
            }
          />
        ) : (
          <EmptyState
            title={t('emptyTitle')}
            body={canCreate ? t('emptyBody') : t('emptyViewer')}
            action={
              canCreate ? (
                <Button variant="outline" onClick={openNew}>
                  <Plus className="size-4" aria-hidden />
                  {t('newGroup')}
                </Button>
              ) : null
            }
          />
        )
      ) : shown.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {t('noMatches', { query: query.trim() })}
        </p>
      ) : (
        <ul className="space-y-2">
          {shown.map((g) => (
            <GroupRow key={g.id} group={g} now={now} />
          ))}
        </ul>
      )}

      {canCreate && (
        <CreateGroupDialog
          key={dialogKey}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onCreated={() => void load()}
        />
      )}
    </div>
  );
}

function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action: React.ReactNode;
}) {
  return (
    <div className="border-border flex flex-col items-center gap-3 rounded-xl border border-dashed px-4 py-12 text-center">
      <span className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
        <UsersRound className="size-5" aria-hidden />
      </span>
      <p className="font-semibold">{title}</p>
      <p className="text-muted-foreground max-w-md text-sm">{body}</p>
      {action}
    </div>
  );
}

function GroupRow({ group: g, now }: { group: GroupListItem; now: Date }) {
  const t = useTranslations('Groups');
  const locale = useLocale();
  const left = g.our_role === 'left';
  const activity = relativeActivity(g.last_message_at, now);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const activityLabel =
    activity.unit === 'none'
      ? t('activityNone')
      : activity.unit === 'now'
        ? t('activityNow')
        : t('activityAt', {
            when:
              activity.unit === 'date'
                ? activity.date.toLocaleDateString(locale, {
                    day: 'numeric',
                    month: 'short',
                    year:
                      activity.date.getFullYear() === now.getFullYear()
                        ? undefined
                        : 'numeric',
                  })
                : rtf.format(-activity.value, activity.unit),
          });
  const number = g.channel
    ? (g.channel.name ?? g.channel.phone ?? '')
    : t('numberRemoved');

  return (
    <li>
      <Link
        href={`/groups/${g.id}`}
        className={cn(
          'border-border bg-card hover:bg-muted/60 flex items-center gap-3 rounded-xl border p-3 transition-colors sm:p-4',
          left && 'opacity-60'
        )}
      >
        {g.icon_url ? (
          // A WhatsApp-hosted picture; next/image would need its host
          // allow-listed for every gateway.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={g.icon_url}
            alt=""
            className="size-10 shrink-0 rounded-full object-cover"
          />
        ) : (
          <span
            className="bg-wa-green/15 text-wa-green flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
            aria-hidden
          >
            {groupInitials(g.name)}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-semibold">{g.name || '—'}</span>
            {g.our_role === 'admin' && (
              <span className="bg-wa-green/15 text-wa-green shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium">
                {t('adminBadge')}
              </span>
            )}
            {left && (
              <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium">
                {t('leftBadge')}
              </span>
            )}
          </span>
          <span className="text-muted-foreground block truncate text-xs sm:text-sm">
            {[t('members', { count: g.participants_count }), number]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
        <span className="text-muted-foreground hidden shrink-0 text-xs sm:block">
          {activityLabel}
        </span>
      </Link>
    </li>
  );
}
