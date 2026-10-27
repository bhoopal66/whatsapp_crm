'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import {
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  UsersRound,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui-ext/confirm-dialog';
import { useAuth } from '@/hooks/use-auth';
import {
  useAccountNumbers,
  useAllNumberAllocations,
} from '@/hooks/use-whatsapp-numbers';
import { canEditSettings } from '@/lib/auth/roles';
import { canSyncGroups } from '@/lib/groups/access';
import { canCreateGroups, canDeleteGroups } from '@/lib/auth/roles';
import {
  applyGroupFilter,
  avatarToneIndex,
  filterGroups,
  GROUP_LIST_CHIPS,
  groupInitials,
  groupNumbers,
  parseGroupList,
  relativeActivity,
  type GroupListChip,
  type GroupListItem,
} from '@/lib/groups/ui';
import { createClient } from '@/lib/supabase/client';
import { usableNumbers } from '@/lib/whatsapp/channel-management';
import { cn } from '@/lib/utils';

import { CreateGroupDialog } from './create-group-dialog';

/** Keeps each subscription's topic unique (see use-presence.ts). */
let topicSeq = 0;

/** The delete route takes at most this many ids per call. */
const DELETE_CHUNK = 100;

/** Realtime bursts (a sync touches every row) collapse into one re-read. */
const REFETCH_DEBOUNCE_MS = 400;

/**
 * Avatar colours for a group with no picture, picked by
 * `avatarToneIndex(id)`. Each hue carries its dark-mode pair.
 */
export const AVATAR_TONES = [
  'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200',
  'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200',
  'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
  'bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-200',
  'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200',
  'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200',
] as const;

interface Loaded {
  groups: GroupListItem[];
  failed: boolean;
}

/**
 * The list pane of /groups: the account's WhatsApp groups, newest
 * activity first, with search, filters, Sync and New group. Mounted
 * once by `GroupsWorkspace`; `selectedId` marks the open group.
 */
export function GroupsList({ selectedId }: { selectedId: string | null }) {
  const t = useTranslations('Groups');
  const router = useRouter();
  const { user, accountId, accountRole } = useAuth();
  const numbers = useAccountNumbers();
  const allocations = useAllNumberAllocations();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [query, setQuery] = useState('');
  const [chip, setChip] = useState<GroupListChip>('all');
  const [channelId, setChannelId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [dialogKey, setDialogKey] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const mounted = useRef(true);

  const canCreate = !!accountRole && canCreateGroups(accountRole);
  const canSync = !!accountRole && canSyncGroups(accountRole);
  const canDelete = !!accountRole && canDeleteGroups(accountRole);
  const isAdmin = !!accountRole && canEditSettings(accountRole);
  const hasWhapi = numbers?.some((n) => n.provider === 'whapi') ?? null;
  // New group needs a number this person may send from (the wizard's filter).
  const canUseWhapi =
    numbers && allocations
      ? usableNumbers(
          numbers.filter((n) => n.provider === 'whapi'),
          allocations,
          user?.id ?? null,
          isAdmin
        ).length > 0
      : null;

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
      .channel(`whatsapp-groups:${accountId}:${++topicSeq}`)
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

  // Deletes from the CRM the left groups the Left filter shows, in
  // chunks the route accepts. Rows also vanish through the realtime
  // re-read; the explicit load covers a dropped socket.
  const deleteLeft = async (ids: string[]) => {
    setDeleteOpen(false);
    setDeleting(true);
    const deleted: string[] = [];
    let failure: string | null = null;
    try {
      for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
        const res = await fetch('/api/whatsapp/groups/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: ids.slice(i, i + DELETE_CHUNK) }),
        });
        const json = await res.json().catch(() => null);
        if (!res.ok) {
          failure = json?.error ?? String(res.status);
          break;
        }
        if (Array.isArray(json?.deleted)) deleted.push(...json.deleted);
      }
    } catch {
      failure = 'network';
    }
    if (failure) toast.error(t('deleteLeftFailed', { reason: failure }));
    if (deleted.length > 0 || !failure) {
      toast.success(t('deleteLeftDone', { count: deleted.length }));
    }
    if (mounted.current) setDeleting(false);
    void load();
    if (selectedId && deleted.includes(selectedId)) router.push('/groups');
  };

  const retry = () => {
    setLoaded(null);
    void load();
  };

  const openNew = () => {
    setDialogKey((k) => k + 1);
    setDialogOpen(true);
  };

  // The dialog stays open over the new group (it is portalled, and this
  // list stays mounted), so its result summary is still readable.
  const onCreated = (groupId: string | null) => {
    void load();
    if (groupId) router.push(`/groups/${groupId}`);
  };

  const all = loaded?.groups;
  const numberOptions = useMemo(() => groupNumbers(all ?? []), [all]);
  // A number filter only while there is a choice, and only a number
  // still listed (a refresh may drop the one picked).
  const activeChannelId =
    numberOptions.length > 1 && numberOptions.some((n) => n.id === channelId)
      ? channelId
      : null;
  const shown = useMemo(
    () =>
      applyGroupFilter(filterGroups(all ?? [], query), {
        chip,
        channelId: activeChannelId,
      }),
    [all, query, chip, activeChannelId]
  );
  const filtering = chip !== 'all' || activeChannelId !== null;
  const leftShown = useMemo(
    () =>
      chip === 'left'
        ? shown.filter((g) => g.our_role === 'left').map((g) => g.id)
        : [],
    [chip, shown]
  );
  const now = new Date();

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <header className="bg-wa-panel-header flex h-14 shrink-0 items-center gap-2 px-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-wa-text truncate text-base leading-5 font-semibold">
            {t('title')}
          </h1>
          {all && !loaded?.failed && (
            <p className="text-wa-text-secondary text-xs">
              {t('listCount', { count: all.length })}
            </p>
          )}
        </div>
        {canSync && hasWhapi && (
          <Button
            variant="ghost"
            size="icon"
            onClick={sync}
            disabled={syncing}
            aria-label={syncing ? t('syncing') : t('sync')}
            title={syncing ? t('syncing') : t('sync')}
            className="text-wa-icon"
          >
            <RefreshCw
              className={cn('size-4', syncing && 'animate-spin')}
              aria-hidden
            />
          </Button>
        )}
        {canCreate && canUseWhapi && (
          <Button
            variant="ghost"
            size="icon"
            onClick={openNew}
            aria-label={t('newGroup')}
            title={t('newGroup')}
            className="text-wa-icon"
          >
            <Plus className="size-5" aria-hidden />
          </Button>
        )}
      </header>

      {(all?.length ?? 0) > 0 && (
        <div className="shrink-0 space-y-2 px-3 pt-3 pb-2">
          <div className="relative">
            <Search
              className="text-wa-icon pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2"
              aria-hidden
            />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('search')}
              aria-label={t('search')}
              className="bg-wa-search text-wa-text placeholder:text-wa-text-secondary focus-visible:ring-wa-teal/40 h-9 rounded-lg border-0 pl-11 text-sm shadow-none focus-visible:ring-2"
            />
          </div>
          <div className="flex items-center gap-1">
            <div
              role="radiogroup"
              aria-label={t('filters.label')}
              className="flex min-w-0 gap-1"
            >
              {GROUP_LIST_CHIPS.map((value) => {
                const active = chip === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setChip(value)}
                    className={cn(
                      'h-7 shrink-0 rounded-full px-2.5 text-[12.5px] whitespace-nowrap transition-colors',
                      active
                        ? 'bg-wa-chip-active text-wa-teal font-medium'
                        : 'bg-wa-search text-wa-text-secondary hover:text-wa-text'
                    )}
                  >
                    {t(`filters.${value}`)}
                  </button>
                );
              })}
            </div>
            {numberOptions.length > 1 && (
              <select
                value={activeChannelId ?? ''}
                onChange={(e) => setChannelId(e.target.value || null)}
                aria-label={t('filters.number')}
                title={t('filters.number')}
                className={cn(
                  'bg-wa-search focus-visible:ring-wa-teal/40 ml-auto h-7 max-w-[9rem] min-w-0 truncate rounded-full border-0 px-2.5 text-[12.5px] outline-none focus-visible:ring-2',
                  activeChannelId
                    ? 'text-wa-teal font-medium'
                    : 'text-wa-text-secondary'
                )}
              >
                <option value="">{t('filters.allNumbers')}</option>
                {numberOptions.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.label}
                  </option>
                ))}
              </select>
            )}
          </div>
          {canDelete && leftShown.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeleteOpen(true)}
              disabled={deleting}
              className="text-destructive hover:text-destructive w-full"
            >
              <Trash2 className="size-4" aria-hidden />
              {deleting
                ? t('deletingLeft')
                : t('deleteLeft', { count: leftShown.length })}
            </Button>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!loaded || hasWhapi === null ? (
          <ul aria-hidden>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <li key={i} className="flex items-center gap-3 pl-3">
                <span className="bg-wa-search size-12 shrink-0 animate-pulse rounded-full" />
                <span className="border-wa-divider flex-1 space-y-2 border-b py-4 pr-3">
                  <span className="bg-wa-search block h-3.5 w-2/5 animate-pulse rounded" />
                  <span className="bg-wa-search block h-3 w-3/5 animate-pulse rounded" />
                </span>
              </li>
            ))}
          </ul>
        ) : loaded.failed ? (
          <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <p className="text-destructive text-sm">{t('loadFailed')}</p>
            <Button variant="outline" size="sm" onClick={retry}>
              <RefreshCw aria-hidden />
              {t('page.retry')}
            </Button>
          </div>
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
          <p className="text-wa-text-secondary px-6 py-12 text-center text-sm">
            {query.trim() && !filtering
              ? t('noMatches', { query: query.trim() })
              : t('noFilterMatches')}
          </p>
        ) : (
          <ul>
            {shown.map((g) => (
              <GroupRow
                key={g.id}
                group={g}
                now={now}
                selected={g.id === selectedId}
              />
            ))}
          </ul>
        )}
      </div>

      {canCreate && (
        <CreateGroupDialog
          key={dialogKey}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onCreated={onCreated}
        />
      )}
      {canDelete && (
        <ConfirmDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title={t('deleteLeftTitle', { count: leftShown.length })}
          description={t('deleteLeftBody', { count: leftShown.length })}
          cancelLabel={t('page.cancel')}
          confirmLabel={t('deleteLeftConfirm')}
          onConfirm={() => void deleteLeft(leftShown)}
          destructive
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
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <span className="bg-wa-search text-wa-icon flex size-12 items-center justify-center rounded-full">
        <UsersRound className="size-5" aria-hidden />
      </span>
      <p className="text-wa-text font-semibold">{title}</p>
      <p className="text-wa-text-secondary text-sm">{body}</p>
      {action}
    </div>
  );
}

function GroupRow({
  group: g,
  now,
  selected,
}: {
  group: GroupListItem;
  now: Date;
  selected: boolean;
}) {
  const t = useTranslations('Groups');
  const locale = useLocale();
  const left = g.our_role === 'left';
  const activity = relativeActivity(g.last_message_at, now);
  // The row shows a compact time; the full wording is its tooltip.
  const rtf = new Intl.RelativeTimeFormat(locale, {
    numeric: 'auto',
    style: 'narrow',
  });
  const short =
    activity.unit === 'none'
      ? ''
      : activity.unit === 'now'
        ? rtf.format(0, 'second')
        : activity.unit === 'date'
          ? activity.date.toLocaleDateString(locale, {
              day: 'numeric',
              month: 'short',
              year:
                activity.date.getFullYear() === now.getFullYear()
                  ? undefined
                  : 'numeric',
            })
          : rtf.format(-activity.value, activity.unit);
  const long =
    activity.unit === 'none'
      ? t('activityNone')
      : activity.unit === 'now'
        ? t('activityNow')
        : t('activityAt', { when: short });
  const number = g.channel
    ? (g.channel.name ?? g.channel.phone ?? '')
    : t('numberRemoved');
  const meta = [t('members', { count: g.participants_count }), number]
    .filter(Boolean)
    .join(' · ');

  return (
    <li>
      <Link
        href={`/groups/${g.id}`}
        aria-current={selected ? 'page' : undefined}
        className={cn(
          'flex w-full items-center gap-3 pl-3 text-left transition-colors',
          selected ? 'bg-wa-row-active' : 'hover:bg-wa-row-hover'
        )}
      >
        <span className={cn('shrink-0', left && 'opacity-60')}>
          {g.icon_url ? (
            // A WhatsApp-hosted picture; next/image would need its host
            // allow-listed for every gateway.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={g.icon_url}
              alt=""
              className="size-12 rounded-full object-cover"
            />
          ) : (
            <span
              className={cn(
                'flex size-12 items-center justify-center rounded-full text-sm font-semibold',
                AVATAR_TONES[avatarToneIndex(g.id, AVATAR_TONES.length)]
              )}
              aria-hidden
            >
              {groupInitials(g.name)}
            </span>
          )}
        </span>

        {/* The divider runs under the text only, past the avatar. */}
        <span
          className={cn(
            'border-wa-divider min-w-0 flex-1 self-stretch border-b py-3 pr-3',
            left && 'opacity-60'
          )}
        >
          <span className="flex items-baseline justify-between gap-2">
            <span
              className="text-wa-text truncate text-[15px] leading-5"
              title={g.name || undefined}
            >
              {g.name || '—'}
            </span>
            {short && (
              <span className="text-wa-text-secondary shrink-0 text-xs">
                <span aria-hidden title={long}>
                  {short}
                </span>
                <span className="sr-only">{long}</span>
              </span>
            )}
          </span>
          <span className="mt-0.5 flex items-center gap-2">
            <span
              className="text-wa-text-secondary min-w-0 flex-1 truncate text-[13px] leading-5"
              title={meta}
            >
              {meta}
            </span>
            {g.our_role === 'admin' && (
              <span className="bg-success-soft text-success shrink-0 rounded-full px-1.5 py-px text-[10.5px] font-medium">
                {t('adminBadge')}
              </span>
            )}
            {left && (
              <span className="bg-wa-search text-wa-text-secondary shrink-0 rounded-full px-1.5 py-px text-[10.5px] font-medium">
                {t('leftBadge')}
              </span>
            )}
          </span>
        </span>
      </Link>
    </li>
  );
}
