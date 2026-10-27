'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowLeft, Info, MoreVertical, RefreshCw } from 'lucide-react';
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
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useAuth } from '@/hooks/use-auth';
import { useMediaQuery } from '@/hooks/use-media-query';
import { useAccountNumbers } from '@/hooks/use-whatsapp-numbers';
import { canDeleteGroups, canEditSettings } from '@/lib/auth/roles';
import { cn } from '@/lib/utils';
import {
  infoSectionFromTab,
  infoSections,
  parseBlocks,
  reasonKey,
  visibleTabs,
  type GroupBlocks,
  type GroupTab,
  type InfoSection,
} from '@/lib/groups/group-page';
import {
  parseGroupSettings,
  type GroupParticipantRole,
  type WhatsappGroupRow,
} from '@/lib/groups/types';
import { DOCK_QUERY } from '@/lib/groups/ui';

import {
  GroupAvatar,
  GroupInfoPanel,
  type InfoFocus,
} from './group-info-panel';
import { ChatTab } from './group/chat-tab';
import { fetchJoinRequests } from './group/requests-tab';

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
  /** Open a section of the info panel, e.g. Members → Invite. */
  onTabChange?: (tab: GroupTab) => void;
  /** The picture changed: the header re-reads it. */
  onIconChange?: () => void;
}

type State = 'loading' | 'ok' | 'gone' | 'error';

/**
 * /groups/[id] — the group's chat with a "Group info" panel, filling the
 * pane it is given (the groups list sits beside it on wide screens).
 * `?tab=<section>` (the bell's `?tab=requests`, older links) opens the
 * panel on that section; the URL is then cleared so the same link works
 * again.
 */
export function GroupPage({ groupId }: { groupId: string }) {
  const t = useTranslations('Groups.page');
  const router = useRouter();
  const { user, accountRole } = useAuth();
  const numbers = useAccountNumbers();
  const docked = useMediaQuery(DOCK_QUERY);
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [state, setState] = useState<State>('loading');
  const searchParams = useSearchParams();
  const [refreshing, setRefreshing] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [iconVersion, setIconVersion] = useState(0);
  const [pendingRequests, setPendingRequests] = useState(0);
  // Open by default where it docks; a sheet waits to be asked for.
  const [dockOpen, setDockOpen] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [openSections, setOpenSections] = useState<InfoSection[]>(['members']);
  const [focus, setFocus] = useState<InfoFocus | null>(null);
  const [handledTab, setHandledTab] = useState<string | null>(null);
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

  // The pending count drives the section's visibility and badge, so it is
  // read here once rather than only when the section is open (bell links).
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

  const sections = useMemo(
    () =>
      detail
        ? infoSections(
            visibleTabs({
              settings: parseGroupSettings(detail.group.settings),
              pendingRequests,
              canEditManagers:
                (!!accountRole && canEditSettings(accountRole)) ||
                detail.group.created_by === user?.id,
            }),
            detail.blocks
          )
        : [],
    [detail, accountRole, user?.id, pendingRequests]
  );

  const panelOpen = docked ? dockOpen : sheetOpen;
  const setPanelOpen = (open: boolean) => {
    // A reopened panel should not jump back to the last section asked for.
    if (!open) setFocus(null);
    if (docked) setDockOpen(open);
    else setSheetOpen(open);
  };
  const showSection = (section: InfoSection) => {
    setPanelOpen(true);
    setOpenSections((prev) =>
      prev.includes(section) ? prev : [...prev, section]
    );
    setFocus((f) => ({ section, n: (f?.n ?? 0) + 1 }));
  };

  // A `?tab=` link: open its section once it is visible (Requests waits
  // for the pending count), adjusted during render rather than in an
  // effect. The effect below then drops `tab` from the URL.
  const rawTab = searchParams.get('tab');
  const linked = infoSectionFromTab(rawTab, sections);
  if (!rawTab && handledTab !== null) setHandledTab(null);
  if (linked && rawTab !== handledTab) {
    setHandledTab(rawTab);
    showSection(linked);
  }
  useEffect(() => {
    if (!handledTab || handledTab !== rawTab) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('tab');
    router.replace(`${url.pathname}${url.search}`, { scroll: false });
  }, [handledTab, rawTab, router]);

  const goToTab = (tab: GroupTab) => {
    const section = infoSectionFromTab(tab, sections);
    if (section) showSection(section);
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

  // Removes a group our number has left from the CRM; WhatsApp is not
  // touched. The route deletes only `left` groups and reports the rest.
  const deleteFromCrm = async () => {
    setDeleteOpen(false);
    try {
      const res = await fetch('/api/whatsapp/groups/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [groupId] }),
      });
      const body = (await res.json().catch(() => null)) as {
        deleted?: string[];
        error?: string;
      } | null;
      if (!res.ok || !body?.deleted?.includes(groupId)) {
        toast.error(
          t('deleteFailed', { reason: body?.error ?? String(res.status) })
        );
        return;
      }
      toast.success(t('deleted'));
      router.push('/groups');
    } catch {
      toast.error(t('deleteFailed', { reason: 'network' }));
    }
  };

  const back = (
    <Link
      href="/groups"
      aria-label={t('back')}
      className={cn(
        buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
        'shrink-0 lg:hidden'
      )}
    >
      <ArrowLeft className="size-4" />
    </Link>
  );

  if (state === 'loading') {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1" aria-busy="true">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="bg-wa-panel-header border-wa-divider flex h-16 shrink-0 items-center gap-3 border-b px-3">
            <div className="bg-muted size-10 animate-pulse rounded-full" />
            <div className="space-y-2">
              <div className="bg-muted h-4 w-48 animate-pulse rounded" />
              <div className="bg-muted h-3 w-32 animate-pulse rounded" />
            </div>
          </div>
          <div className="flex-1 space-y-3 p-4">
            <div className="bg-muted h-10 w-2/5 animate-pulse rounded-lg" />
            <div className="bg-muted ml-auto h-10 w-1/3 animate-pulse rounded-lg" />
            <div className="bg-muted h-10 w-1/2 animate-pulse rounded-lg" />
          </div>
        </div>
        <div className="bg-wa-panel border-wa-divider hidden w-[22rem] shrink-0 flex-col items-center gap-3 border-l p-6 min-[1440px]:flex">
          <div className="bg-muted size-20 animate-pulse rounded-full" />
          <div className="bg-muted h-4 w-40 animate-pulse rounded" />
          <div className="bg-muted h-3 w-24 animate-pulse rounded" />
        </div>
      </div>
    );
  }

  if (state !== 'ok' || !detail) {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <div className="bg-wa-panel-header border-wa-divider flex h-16 shrink-0 items-center gap-2 border-b px-3 lg:hidden">
          {back}
          <span className="text-wa-text text-sm font-medium">{t('back')}</span>
        </div>
        <div
          role={state === 'error' ? 'alert' : undefined}
          className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
        >
          <p className="text-muted-foreground text-sm">
            {state === 'gone' ? t('notFound') : t('loadFailed')}
          </p>
          {state === 'error' && (
            <Button variant="outline" size="sm" onClick={() => void reload()}>
              {t('retry')}
            </Button>
          )}
        </div>
      </div>
    );
  }

  const { group } = detail;
  const channel = numbers?.find((n) => n.id === group.channel_id);
  const numberLabel = channel
    ? [channel.label, channel.waba_id].filter(Boolean).join(' · ') || null
    : null;
  const subLine = [t('members', { count: group.participants_count })]
    .concat(numberLabel ? [numberLabel] : [])
    .join(' · ');
  const canLeave = detail.blocks.leave === null;
  const canDelete =
    group.our_role === 'left' && !!accountRole && canDeleteGroups(accountRole);
  const tabProps: GroupTabProps = {
    groupId,
    detail,
    reload,
    onTabChange: goToTab,
    onIconChange: () => setIconVersion((v) => v + 1),
  };

  const panel = (heading: ReactNode) => (
    <GroupInfoPanel
      heading={heading}
      onClose={() => setPanelOpen(false)}
      tabProps={tabProps}
      sections={sections}
      open={openSections}
      onOpenChange={setOpenSections}
      focus={focus}
      pendingRequests={pendingRequests}
      onRequestsCount={setPendingRequests}
      numberLabel={numberLabel}
      iconVersion={iconVersion}
      canLeave={canLeave}
      onLeave={() => {
        // The confirm is its own dialog: close the sheet first.
        setSheetOpen(false);
        setLeaveOpen(true);
      }}
      canDelete={canDelete}
      onDelete={() => {
        setSheetOpen(false);
        setDeleteOpen(true);
      }}
    />
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1">
      <section
        aria-label={group.name}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        <header className="bg-wa-panel-header border-wa-divider sticky top-0 z-10 flex h-16 shrink-0 items-center gap-2 border-b px-2 sm:px-3">
          {back}
          <button
            type="button"
            onClick={() => setPanelOpen(!panelOpen)}
            aria-label={t('info')}
            className="focus-visible:ring-ring/50 flex min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-3"
          >
            <GroupAvatar
              key={iconVersion}
              groupId={groupId}
              name={group.name}
              version={iconVersion}
              className="size-10 text-sm"
            />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className="text-wa-text truncate text-sm font-semibold sm:text-base"
                  title={group.name}
                >
                  {group.name}
                </span>
                {group.our_role === 'admin' && (
                  <Badge className="bg-success-soft text-success shrink-0">
                    {t('roleAdmin')}
                  </Badge>
                )}
                {group.our_role === 'left' && (
                  <Badge className="bg-warning-soft text-warning shrink-0">
                    {t('roleLeft')}
                  </Badge>
                )}
              </span>
              <span
                className="text-wa-text-secondary block truncate text-xs"
                title={subLine}
              >
                {subLine}
              </span>
            </span>
          </button>
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={panelOpen ? t('closeInfo') : t('info')}
              aria-pressed={panelOpen}
              title={t('info')}
              className="aria-pressed:bg-wa-row-active"
              onClick={() => setPanelOpen(!panelOpen)}
            >
              <Info className="size-4" />
            </Button>
            {detail.canManage && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={refreshing ? t('refreshing') : t('refresh')}
                title={t('refresh')}
                disabled={refreshing}
                onClick={() => void refresh()}
              >
                <RefreshCw
                  className={refreshing ? 'size-4 animate-spin' : 'size-4'}
                />
              </Button>
            )}
            {(canLeave || canDelete) && (
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
                  {canLeave && (
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => setLeaveOpen(true)}
                    >
                      {t('leave')}
                    </DropdownMenuItem>
                  )}
                  {canDelete && (
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => setDeleteOpen(true)}
                    >
                      {t('deleteFromCrm')}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </header>

        <ChatTab {...tabProps} />
      </section>

      {docked && dockOpen && (
        <aside
          aria-label={t('info')}
          className="border-wa-divider flex w-[22rem] shrink-0 flex-col border-l"
        >
          {panel(
            <h2 className="text-wa-text text-sm font-semibold">{t('info')}</h2>
          )}
        </aside>
      )}
      {!docked && (
        <Sheet open={sheetOpen} onOpenChange={(open) => setPanelOpen(open)}>
          <SheetContent
            side="right"
            showCloseButton={false}
            className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[22rem]"
          >
            {panel(
              <SheetTitle className="text-wa-text text-sm font-semibold">
                {t('info')}
              </SheetTitle>
            )}
          </SheetContent>
        </Sheet>
      )}

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
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('deleteTitle')}
        description={t('deleteBody', { name: group.name })}
        cancelLabel={t('cancel')}
        confirmLabel={t('deleteFromCrm')}
        onConfirm={() => void deleteFromCrm()}
        destructive
      />
    </div>
  );
}
