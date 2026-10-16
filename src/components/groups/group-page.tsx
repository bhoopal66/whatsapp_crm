'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowLeft, MoreVertical, RefreshCw, UsersRound } from 'lucide-react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/ui-ext/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import {
  parseBlocks,
  reasonKey,
  resolveTab,
  visibleTabs,
  type GroupBlocks,
  type GroupTab,
} from '@/lib/groups/group-page';
import { groupInitials } from '@/lib/groups/ui';
import {
  parseGroupSettings,
  type GroupParticipantRole,
  type WhatsappGroupRow,
} from '@/lib/groups/types';

import { ChatTab } from './group/chat-tab';
import { InviteTab } from './group/invite-tab';
import { ManagersTab } from './group/managers-tab';
import { MembersTab } from './group/members-tab';
import { fetchJoinRequests, RequestsTab } from './group/requests-tab';
import { SettingsTab } from './group/settings-tab';

/** The GET /api/whatsapp/groups/[id] answer, as later tabs read it. */
export interface GroupDetail {
  group: WhatsappGroupRow;
  participants: Array<{
    wa_id: string;
    contact_id: string | null;
    contact_name: string | null;
    role: GroupParticipantRole;
    added_at: string;
  }>;
  managers: Array<{ user_id: string; name: string | null }>;
  canManage: boolean;
  blocks: GroupBlocks;
}

/** What a tab receives; later tabs plug in with exactly these. */
export interface GroupTabProps {
  groupId: string;
  detail: GroupDetail;
  /** Re-read the group (`refresh` also re-fetches it from WhatsApp). */
  reload: (opts?: { refresh?: boolean }) => Promise<void>;
  /** Switch tab (writes `?tab=`), e.g. Members → Invite. */
  onTabChange?: (tab: GroupTab) => void;
  /** The picture changed: the header re-reads it. */
  onIconChange?: () => void;
}

type State = 'loading' | 'ok' | 'gone' | 'error';

/** /groups/[id] — header, tabs and the chat. */
export function GroupPage({
  groupId,
  initialTab,
}: {
  groupId: string;
  initialTab?: string;
}) {
  const t = useTranslations('Groups.page');
  const router = useRouter();
  const { user, accountRole } = useAuth();
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [state, setState] = useState<State>('loading');
  const searchParams = useSearchParams();
  const [refreshing, setRefreshing] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [iconOk, setIconOk] = useState(true);
  const [iconVersion, setIconVersion] = useState(0);
  const [pendingRequests, setPendingRequests] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(
    async (opts?: { refresh?: boolean }) => {
      try {
        const res = await fetch(
          `/api/whatsapp/groups/${groupId}${opts?.refresh ? '?refresh=1' : ''}`,
          { cache: 'no-store' }
        );
        if (!mounted.current) return;
        if (res.status === 404 || res.status === 403) {
          if (opts?.refresh && res.status === 403) {
            toast.error(t(`reasons.${reasonKey('not_allowed')}`));
            return;
          }
          setDetail(null);
          return setState('gone');
        }
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as GroupDetail;
        if (!mounted.current) return;
        setDetail({ ...json, blocks: parseBlocks(json.blocks) });
        setState('ok');
      } catch {
        if (!mounted.current) return;
        if (opts?.refresh) toast.error(t('refreshFailed'));
        else setState((s) => (s === 'ok' ? s : 'error'));
      }
    },
    [groupId, t]
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  // The pending count drives the tab's visibility and badge, so it is read
  // here once rather than only when the tab is open (bell deep links).
  const requestsBlocked = detail ? detail.blocks.join_requests : 'loading';
  useEffect(() => {
    if (!detail || requestsBlocked !== null || !detail.canManage) return;
    let live = true;
    void fetchJoinRequests(groupId).then((list) => {
      if (live && list) setPendingRequests(list.length);
    });
    return () => {
      live = false;
    };
  }, [detail, requestsBlocked, groupId]);

  const tabs = useMemo(
    () =>
      detail
        ? visibleTabs({
            settings: parseGroupSettings(detail.group.settings),
            pendingRequests,
            canEditManagers:
              (!!accountRole && canEditSettings(accountRole)) ||
              detail.group.created_by === user?.id,
          })
        : [],
    [detail, accountRole, user?.id, pendingRequests]
  );
  // The URL is the one source of truth, so a link or Open invite that only
  // changes `?tab=` while the page is open switches tabs too.
  const activeTab: GroupTab = resolveTab(
    searchParams.get('tab') ?? initialTab,
    tabs
  );

  const goToTab = (value: GroupTab) => {
    const url = new URL(window.location.href);
    if (value === 'chat') url.searchParams.delete('tab');
    else url.searchParams.set('tab', value);
    router.replace(`${url.pathname}${url.search}`, { scroll: false });
  };
  const changeTab = (next: unknown) => goToTab(resolveTab(String(next), tabs));
  const bumpIcon = () => {
    setIconVersion((v) => v + 1);
    setIconOk(true);
  };

  const refresh = async () => {
    setRefreshing(true);
    await reload({ refresh: true });
    if (mounted.current) setRefreshing(false);
  };

  const leave = async () => {
    setLeaveOpen(false);
    try {
      const res = await fetch(`/api/whatsapp/groups/${groupId}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          code?: string;
        } | null;
        toast.error(t(`reasons.${reasonKey(body?.code)}`));
        return;
      }
      router.push('/groups');
    } catch {
      toast.error(t('reasons.unknown'));
    }
  };

  const back = (
    <Link
      href="/groups"
      className={buttonVariants({ variant: 'ghost', size: 'sm' })}
    >
      <ArrowLeft className="size-4" />
      {t('back')}
    </Link>
  );

  if (state === 'loading') {
    return (
      <div className="space-y-4 p-4" aria-busy="true">
        <div className="flex items-center gap-3">
          <div className="bg-muted size-12 animate-pulse rounded-full" />
          <div className="space-y-2">
            <div className="bg-muted h-4 w-48 animate-pulse rounded" />
            <div className="bg-muted h-3 w-32 animate-pulse rounded" />
          </div>
        </div>
        <div className="bg-muted h-[50vh] animate-pulse rounded-lg" />
      </div>
    );
  }

  if (state !== 'ok' || !detail) {
    return (
      <div className="flex flex-col items-start gap-3 p-4">
        {back}
        <p className="text-muted-foreground text-sm">
          {state === 'gone' ? t('notFound') : t('loadFailed')}
        </p>
        {state === 'error' && (
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            {t('retry')}
          </Button>
        )}
      </div>
    );
  }

  const { group } = detail;
  const roleLabel =
    group.our_role === 'left'
      ? t('roleLeft')
      : group.our_role === 'admin'
        ? t('roleAdmin')
        : t('roleMember');
  const tabProps: GroupTabProps = {
    groupId,
    detail,
    reload,
    onTabChange: goToTab,
    onIconChange: bumpIcon,
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3 sm:p-4">
      <header className="flex items-start gap-3">
        <Link
          href="/groups"
          aria-label={t('back')}
          className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
        >
          <ArrowLeft className="size-4" />
        </Link>
        <div className="bg-muted text-muted-foreground flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-full text-sm font-medium">
          {iconOk ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/whatsapp/groups/${groupId}/icon?v=${iconVersion}`}
              alt=""
              className="size-full object-cover"
              onError={() => setIconOk(false)}
            />
          ) : (
            groupInitials(group.name)
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-base font-semibold sm:text-lg">
              {group.name}
            </h1>
            <Badge
              variant={group.our_role === 'left' ? 'outline' : 'secondary'}
            >
              {roleLabel}
            </Badge>
          </div>
          {group.description && (
            <p className="text-muted-foreground line-clamp-2 text-sm">
              {group.description}
            </p>
          )}
          <p className="text-muted-foreground mt-0.5 flex items-center gap-1 text-xs">
            <UsersRound className="size-3.5" />
            {t('members', { count: group.participants_count })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {detail.canManage && (
            <Button
              variant="outline"
              size="sm"
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              <RefreshCw
                className={refreshing ? 'size-4 animate-spin' : 'size-4'}
              />
              <span className="hidden sm:inline">
                {refreshing ? t('refreshing') : t('refresh')}
              </span>
            </Button>
          )}
          {detail.blocks.leave === null && (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={t('more')}
                className={buttonVariants({
                  variant: 'ghost',
                  size: 'icon-sm',
                })}
              >
                <MoreVertical className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setLeaveOpen(true)}
                >
                  {t('leave')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>

      <Tabs
        value={activeTab}
        onValueChange={changeTab}
        className="min-h-0 flex-1"
      >
        <TabsList className="max-w-full justify-start overflow-x-auto">
          {tabs.map((name) => (
            <TabsTrigger key={name} value={name}>
              {t(`tabs.${name}`)}
              {name === 'requests' && pendingRequests > 0 && (
                <Badge variant="secondary" className="ml-1.5">
                  {pendingRequests}
                </Badge>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="chat" className="min-h-0 flex-1">
          <ChatTab {...tabProps} />
        </TabsContent>
        {/* Filled by later jobs; they receive GroupTabProps. */}
        <TabsContent value="members" className="min-h-0 flex-1">
          <MembersTab {...tabProps} />
        </TabsContent>
        <TabsContent
          value="settings"
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <SettingsTab {...tabProps} />
        </TabsContent>
        <TabsContent value="invite" className="min-h-0 flex-1 overflow-y-auto">
          <InviteTab {...tabProps} />
        </TabsContent>
        <TabsContent
          value="requests"
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <RequestsTab {...tabProps} onCount={setPendingRequests} />
        </TabsContent>
        <TabsContent
          value="managers"
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <ManagersTab {...tabProps} />
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={leaveOpen}
        onOpenChange={setLeaveOpen}
        title={t('leaveTitle')}
        description={t('leaveBody', { name: group.name })}
        cancelLabel={t('cancel')}
        confirmLabel={t('leave')}
        onConfirm={() => void leave()}
        destructive
      />
    </div>
  );
}
