'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';
import { BackLink as SharedBackLink } from '@/components/layout/back-link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import {
  AlertTriangle,
  Archive,
  Briefcase,
  Copy,
  Eye,
  Info,
  Loader2,
  MoreVertical,
  PanelRight,
  RotateCcw,
  ShieldAlert,
  UserRound,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  GroupComposer,
  type GroupMediaSendPayload,
} from '@/components/groups/group-composer';
import { ConfirmDialog } from '@/components/ui-ext/confirm-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useAuth } from '@/hooks/use-auth';
import { useMediaQuery } from '@/hooks/use-media-query';
import { startChatCatchUp } from '@/lib/groups/live-chat';
import {
  EMPTY_CHAT_LOG,
  keptScrollTop,
  withFreshPage,
  withOlderPage,
} from '@/lib/submission-groups/chat-log';
import { isOffline, thrownSendKind } from '@/lib/inbox/failed-send';
import { DOCK_QUERY, relativeActivity } from '@/lib/groups/ui';
import { markSubmissionGroupRead } from '@/lib/submission-groups/mark-read';
import { createClient } from '@/lib/supabase/client';
import {
  avatarTone,
  bankName,
  canAddNumber,
  canResendInvite,
  canRetryCreate,
  endToastKey,
  groupBanners,
  groupContactName,
  groupTitle,
  initialsOf,
  ownSendStored,
  retryToastKey,
  refusedSendOutcome,
  sentAsPreview,
  settleRead,
  shortRef,
  trackerStatusChip,
  type BannerKey,
  type SgDetail,
  type SgGroup,
  type SgMessage,
  type SgOlderPage,
  waModeOf,
} from '@/lib/submission-groups/ui';
import {
  closeRemaining,
  createRefused,
} from '@/lib/submission-groups/wa-errors';
import { cn } from '@/lib/utils';

import { useSubmissionGroupsList } from './list-context';
import { BankTag } from './bank-tag';
import { AddNumberDialog } from './add-number-dialog';
import { GroupDetailsCard } from './group-details-card';
import { MessageList } from './message-list';
import { PeoplePanel } from './people-panel';

/** Realtime bursts (a send and its status update) collapse into one re-read. */
const REFETCH_DEBOUNCE_MS = 400;

type State = 'loading' | 'ok' | 'gone' | 'forbidden' | 'error';
type Confirm = 'end' | 'retry' | 'archive' | null;

const chipClass =
  'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium';

/**
 * Below `lg` the list is hidden on /[id]: this is the way back to it,
 * or to wherever the group was opened from (a case, a customer).
 */
function BackLink({ label, href }: { label: string; href: string }) {
  return (
    <SharedBackLink
      fallbackHref={href}
      fallbackLabel={label}
      iconOnly
      className={cn(
        buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
        'shrink-0 lg:hidden'
      )}
    />
  );
}

/**
 * /submission-groups/[id], the detail pane of the split view: a sticky
 * header, then either the group's chat with a details column, or (no
 * WhatsApp group, migration 136) a details-and-people page. `backHref`
 * is the list it sits beside: /groups/submission/[id] renders it too.
 */
export function SubmissionGroupPage({
  groupId,
  backHref = '/submission-groups',
}: {
  groupId: string;
  backHref?: string;
}) {
  const t = useTranslations('SubmissionGroups.page');
  const tDetails = useTranslations('SubmissionGroups.details');
  const tGroups = useTranslations('Groups.page');
  const backLabel = backHref === '/groups' ? tGroups('back') : t('backToList');
  const locale = useLocale();
  const { user, profile } = useAuth();
  const [state, setState] = useState<State>('loading');
  const [detail, setDetail] = useState<SgDetail | null>(null);
  const [log, setLog] = useState(EMPTY_CHAT_LOG);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [archive, setArchive] = useState<SgMessage[] | null>(null);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [acting, setActing] = useState(false);
  const [openingCase, setOpeningCase] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [addingNumber, setAddingNumber] = useState(false);
  const router = useRouter();
  const docked = useMediaQuery(DOCK_QUERY);
  const { refreshList } = useSubmissionGroupsList();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  // The scroll as it was when older rows were put in above it.
  const anchorRef = useRef<{ top: number; height: number } | null>(null);
  const mounted = useRef(true);
  // `reload` runs on every live update; opening a group marks it once.
  const markedRead = useRef<string | null>(null);
  const readOwed = useRef(false);

  // `due`: a read just fell due. Without it, pays one owed from before.
  const settle = useCallback(
    (due: boolean) => {
      const { mark, owed } = settleRead(
        readOwed.current || due,
        document.visibilityState === 'visible'
      );
      readOwed.current = owed;
      if (mark) void markSubmissionGroupRead(groupId);
    },
    [groupId]
  );

  /** Rejects on a failed read; true when the group's chat is live. */
  const refresh = useCallback(async (): Promise<boolean> => {
    const res = await fetch(`/api/submission-groups/${groupId}`, {
      cache: 'no-store',
    });
    if (!mounted.current) return false;
    if (res.status === 404 || res.status === 403) {
      setState(res.status === 404 ? 'gone' : 'forbidden');
      return false;
    }
    if (!res.ok) throw new Error(String(res.status));
    const json = (await res.json()) as SgDetail;
    if (!mounted.current) return false;
    setDetail(json);
    setLog((l) => withFreshPage(l, json));
    setNow(new Date());
    setState('ok');
    const active = json.group.status === 'ACTIVE';
    if (active && markedRead.current !== groupId) {
      markedRead.current = groupId;
      settle(true);
    }
    return active;
  }, [groupId, settle]);

  const reload = useCallback(async () => {
    try {
      await refresh();
    } catch {
      // Keep what is on screen on a failed refresh; fail only a first load.
      if (mounted.current) setState((s) => (s === 'ok' ? s : 'error'));
    }
  }, [refresh]);

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  // Live: a new or updated message row re-reads the group, which applies
  // the access rules server-side. One unique topic per mount.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let readTimer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void reload(), REFETCH_DEBOUNCE_MS);
    };
    // What arrived while the page slept or was cut off came as no event.
    const live = startChatCatchUp({ refresh, settle });
    const supabase = createClient();
    const channel = supabase
      .channel(
        `submission-group-messages:${groupId}:${Math.random().toString(36).slice(2)}`
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'submission_group_messages',
          filter: `group_id=eq.${groupId}`,
        },
        (payload) => {
          soon();
          // Seen as it arrives, so it does not count as unread; judged
          // when the timer fires, since the page may be hidden by then.
          if (payload.new.direction === 'in') {
            if (readTimer) clearTimeout(readTimer);
            readTimer = setTimeout(() => settle(true), 2000);
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'submission_group_messages',
          filter: `group_id=eq.${groupId}`,
        },
        soon
      )
      .subscribe(live.onStatus);
    return () => {
      if (timer) clearTimeout(timer);
      if (readTimer) clearTimeout(readTimer);
      live.stop();
      void supabase.removeChannel(channel);
    };
  }, [groupId, refresh, reload, settle]);

  // The sheet is for the undocked layout only: close it on docking.
  useEffect(() => {
    if (docked) setDetailsOpen(false);
  }, [docked]);

  const shown = archive ?? log.messages;

  // Follow new messages only while the reader is at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (!el) return;
    if (anchor) el.scrollTop = keptScrollTop(anchor, el.scrollHeight);
    else if (stickRef.current) el.scrollTop = el.scrollHeight;
    // `loadingOlder`: an older page that no longer joined changes no log,
    // and its anchor must not wait for the next message.
  }, [archive, detail, log, loadingOlder]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const loadOlder = async () => {
    const before = log.olderCursor;
    if (!before) return;
    setLoadingOlder(true);
    try {
      const res = await fetch(
        `/api/submission-groups/${groupId}?before=${encodeURIComponent(before)}`,
        { cache: 'no-store' }
      );
      if (!mounted.current) return;
      // Ended, or access lost, meanwhile: the page says which.
      if (res.status === 404 || res.status === 403) return void reload();
      if (!res.ok) throw new Error(String(res.status));
      const page = (await res.json()) as SgOlderPage;
      if (!mounted.current) return;
      if (page.status !== 'ACTIVE') return void reload();
      const el = scrollRef.current;
      if (el)
        anchorRef.current = { top: el.scrollTop, height: el.scrollHeight };
      setLog((l) => withOlderPage(l, before, page));
    } catch {
      if (mounted.current) toast.error(tGroups('chat.loadFailed'));
    } finally {
      if (mounted.current) setLoadingOlder(false);
    }
  };

  /**
   * One send into the group (text or an uploaded attachment). False when
   * the composer should give the text back or delete the upload.
   */
  const postMessage = async (
    payload: { text: string } | { media: GroupMediaSendPayload }
  ): Promise<boolean> => {
    if (!detail?.can_send) return false;
    stickRef.current = true;
    const before = log.messages;
    // Nobody answered for it: the log says. Null when it cannot be read.
    const stored = async (): Promise<boolean | null> => {
      try {
        const res = await fetch(`/api/submission-groups/${groupId}`, {
          cache: 'no-store',
        });
        if (!res.ok) return null;
        const { messages } = (await res.json()) as SgDetail;
        return ownSendStored(before, messages, user?.id ?? null);
      } catch {
        return null;
      }
    };
    const offlineBefore = isOffline();
    try {
      const res = await fetch(`/api/submission-groups/${groupId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as Parameters<
          typeof refusedSendOutcome
        >[0]['body'];
        const outcome = await refusedSendOutcome(
          { status: res.status, body: json, media: 'media' in payload },
          stored
        );
        toast.error(t(`sendErrors.${outcome.toast}`));
        return outcome.kept;
      }
      if (res.status === 202) {
        // WhatsApp has it; only the CRM copy is unrecorded (it may later
        // show as failed). Do not resend.
        toast.warning(t('sendErrors.sentNotRecorded'));
      }
      return true;
    } catch {
      // Only a device that was offline throughout is certain.
      const kept =
        thrownSendKind(offlineBefore, isOffline()) === 'offline'
          ? false
          : await stored();
      toast.error(
        t(kept === false ? 'sendErrors.unknown' : 'sendErrors.maybeSent')
      );
      // Unknown: words come back (with the warning), but a file stays
      // where a stored message may point at it.
      return kept ?? 'media' in payload;
    } finally {
      void reload();
    }
  };

  // A group made before cases existed: owner / admin opens its case.
  const openCase = async () => {
    setOpeningCase(true);
    try {
      const res = await fetch('/api/cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_id: groupId }),
      });
      const json = (await res.json().catch(() => null)) as {
        caseId?: unknown;
      } | null;
      if (!res.ok || typeof json?.caseId !== 'string') {
        toast.error(t('openNewCaseFailed'));
        return;
      }
      refreshList();
      router.push(`/cases/${json.caseId}`);
    } catch {
      toast.error(t('openNewCaseFailed'));
    } finally {
      if (mounted.current) setOpeningCase(false);
    }
  };

  const post = async (path: 'end' | 'retry') => {
    setConfirm(null);
    setActing(true);
    try {
      const res = await fetch(`/api/submission-groups/${groupId}/${path}`, {
        method: 'POST',
      });
      const json = (await res.json().catch(() => null)) as
        | (Parameters<typeof endToastKey>[0] &
            Parameters<typeof retryToastKey>[1])
        | null;
      if (path === 'retry') {
        const key = retryToastKey(res.status, json);
        if (key === 'retryDone') toast.success(t(key));
        else if (key === 'retryPending') toast.warning(t(key));
        else toast.error(t(key));
      } else if (!res.ok) toast.error(t('endFailed'));
      else {
        const key = endToastKey(json);
        if (key === 'endDone') toast.success(t(key));
        else toast.warning(t(key));
      }
      if (res.ok) refreshList();
    } catch {
      toast.error(t(path === 'end' ? 'endFailed' : 'retryFailed'));
    } finally {
      setActing(false);
      void reload();
    }
  };

  const resendInvite = async () => {
    setActing(true);
    try {
      const res = await fetch(`/api/submission-groups/${groupId}/invite`, {
        method: 'POST',
      });
      if (res.ok) toast.success(t('inviteResendDone'));
      else {
        const json = (await res.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        toast.error(
          typeof json?.error === 'string' ? json.error : t('inviteResendFailed')
        );
      }
    } catch {
      toast.error(t('inviteResendFailed'));
    } finally {
      setActing(false);
      void reload();
    }
  };

  const openArchive = async () => {
    setConfirm(null);
    setArchiveLoading(true);
    try {
      const res = await fetch(`/api/submission-groups/${groupId}/archive`, {
        method: 'POST',
      });
      if (!res.ok) {
        toast.error(
          t(res.status === 403 ? 'archiveForbidden' : 'archiveFailed')
        );
        return;
      }
      const json = (await res.json()) as { messages?: SgMessage[] };
      stickRef.current = true;
      setArchive(json.messages ?? []);
      // The messages after the end are read here and nowhere else (308).
      void markSubmissionGroupRead(groupId);
    } catch {
      toast.error(t('archiveFailed'));
    } finally {
      setArchiveLoading(false);
    }
  };

  const copyRef = async (ref: string) => {
    try {
      await navigator.clipboard.writeText(ref);
      toast.success(t('refCopied'));
    } catch {
      toast.error(t('copyFailed'));
    }
  };

  if (state === 'loading')
    return <DetailSkeleton backLabel={backLabel} backHref={backHref} />;

  if (state !== 'ok' || !detail) {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <div className="border-b px-3 py-2 lg:hidden">
          <BackLink label={backLabel} href={backHref} />
        </div>
        <div
          role={state === 'error' ? 'alert' : 'status'}
          className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
        >
          <span className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
            <AlertTriangle className="size-5" aria-hidden />
          </span>
          <p className="text-muted-foreground max-w-sm text-sm">
            {state === 'gone'
              ? t('notFound')
              : state === 'forbidden'
                ? t('forbidden')
                : t('loadFailed')}
          </p>
          {state === 'error' && (
            <Button variant="outline" size="sm" onClick={() => void reload()}>
              <RotateCcw aria-hidden />
              {t('retry')}
            </Button>
          )}
        </div>
      </div>
    );
  }

  const { group } = detail;
  const ended = group.status === 'ENDED';
  const noGroup = waModeOf(group) === 'none';
  // 'none' gets its own calm panel instead of the noWhatsapp notice.
  const banners = groupBanners(group).filter(
    (b) => !(noGroup && b === 'noWhatsapp')
  );
  const myName =
    detail.access.find((a) => a.user_id === user?.id)?.name ??
    profile?.full_name ??
    null;
  const sentAs = sentAsPreview(myName, group.my_label);

  const side = (
    <>
      <GroupDetailsCard
        group={group}
        onCopyRef={() => void copyRef(group.submission_ref)}
        onResendInvite={
          (detail.can_manage || detail.can_send) && canResendInvite(group)
            ? () => void resendInvite()
            : undefined
        }
        resendingInvite={acting}
        onAddNumber={
          (detail.can_manage || detail.can_send) && canAddNumber(group)
            ? () => setAddingNumber(true)
            : undefined
        }
      />
      {addingNumber && (
        <AddNumberDialog
          groupId={groupId}
          onClose={() => setAddingNumber(false)}
          onAdded={() => void reload()}
        />
      )}
      <PeoplePanel
        groupId={groupId}
        access={detail.access}
        editable={detail.can_manage && !ended}
        onChanged={() => {
          void reload();
          refreshList();
        }}
      />
    </>
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <DetailHeader
        detail={detail}
        backHref={backHref}
        backLabel={backLabel}
        now={now}
        locale={locale}
        acting={acting}
        openingCase={openingCase}
        showDetailsToggle={!noGroup && !docked}
        onCopyRef={() => void copyRef(group.submission_ref)}
        onOpenCase={() => void openCase()}
        onConfirm={setConfirm}
        onShowDetails={() => setDetailsOpen(true)}
      />

      {noGroup ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-5xl space-y-4 p-3 sm:p-4">
            <Banners banners={banners} group={group} />
            <section className="bg-card flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center">
              <span className="bg-info-soft text-info flex size-10 shrink-0 items-center justify-center rounded-full">
                <Info className="size-5" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold">{t('noGroupTitle')}</h2>
                <p className="text-muted-foreground text-sm">
                  {t('noGroupBody')}
                </p>
              </div>
              {group.contact && (
                <Link
                  href={`/contacts/${group.contact.id}`}
                  className={cn(
                    buttonVariants({ variant: 'outline', size: 'sm' }),
                    'self-start sm:self-center'
                  )}
                >
                  <UserRound aria-hidden />
                  {t('openCustomer')}
                </Link>
              )}
            </section>
            <div className="grid items-start gap-4 md:grid-cols-2">{side}</div>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <section
            aria-label={t('chatRegion')}
            className="bg-wa-panel flex min-w-0 flex-1 flex-col"
          >
            {banners.length > 0 && (
              <div className="space-y-2 px-3 pt-3">
                <Banners banners={banners} group={group} />
              </div>
            )}
            {archive && (
              <div className="bg-warning-soft text-foreground flex items-start gap-2 border-b px-3 py-2 text-xs">
                <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>{t('archiveViewing')}</span>
              </div>
            )}
            <div
              ref={scrollRef}
              onScroll={onScroll}
              className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-4 sm:px-6"
            >
              {ended && !archive ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
                  <span className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
                    <Archive className="size-5" aria-hidden />
                  </span>
                  <p className="font-semibold">{t('endedTitle')}</p>
                  <p className="text-muted-foreground max-w-md text-sm">
                    {detail.archive_available
                      ? t('endedArchiveBody')
                      : t('endedNoArchive')}
                  </p>
                  {detail.archive_available && (
                    <>
                      <Button
                        variant="outline"
                        disabled={archiveLoading}
                        onClick={() => setConfirm('archive')}
                      >
                        {archiveLoading ? (
                          <Loader2 className="animate-spin" aria-hidden />
                        ) : (
                          <Eye aria-hidden />
                        )}
                        {t('viewArchive')}
                      </Button>
                      <p className="text-muted-foreground text-xs">
                        {t('archiveLogged')}
                      </p>
                    </>
                  )}
                </div>
              ) : shown.length === 0 ? (
                <p className="text-muted-foreground py-8 text-center text-sm">
                  {t('empty')}
                </p>
              ) : (
                <>
                  {!archive && log.olderCursor && (
                    <div className="flex justify-center">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={loadingOlder}
                        onClick={() => void loadOlder()}
                      >
                        {loadingOlder
                          ? tGroups('chat.loading')
                          : tGroups('chat.loadOlder')}
                      </Button>
                    </div>
                  )}
                  <MessageList messages={shown} />
                </>
              )}
            </div>

            {!ended && (
              <GroupComposer
                chatKey={`submission:${groupId}`}
                userId={user?.id ?? null}
                onSendText={(text) => postMessage({ text })}
                onSendMedia={(media) => postMessage({ media })}
                disabled={!detail.can_send}
                disabledReason={t('cannotSend')}
                notice={sentAs ? t('sentAs', { who: sentAs }) : null}
                placeholder={t('placeholder')}
              />
            )}
          </section>

          {docked ? (
            <aside
              aria-label={tDetails('title')}
              className="bg-background w-80 shrink-0 space-y-3 overflow-y-auto border-s p-3"
            >
              {side}
            </aside>
          ) : (
            <Sheet open={detailsOpen} onOpenChange={setDetailsOpen}>
              <SheetContent
                side="right"
                className="gap-0 overflow-y-auto p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-sm"
              >
                <SheetHeader className="border-b p-4">
                  <SheetTitle>{tDetails('title')}</SheetTitle>
                </SheetHeader>
                <div className="space-y-3 p-3">{side}</div>
              </SheetContent>
            </Sheet>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirm === 'end'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={t('endTitle')}
        description={t('endBody', { ref: group.submission_ref })}
        cancelLabel={t('cancel')}
        confirmLabel={t('endGroup')}
        onConfirm={() => void post('end')}
        destructive
      />
      <ConfirmDialog
        open={confirm === 'retry'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={t('retryTitle')}
        description={t('retryBody')}
        cancelLabel={t('cancel')}
        confirmLabel={t('retryCreate')}
        onConfirm={() => void post('retry')}
      />
      <ConfirmDialog
        open={confirm === 'archive'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={t('archiveTitle')}
        description={t('archiveBody')}
        cancelLabel={t('cancel')}
        confirmLabel={t('viewArchive')}
        onConfirm={() => void openArchive()}
      />
    </div>
  );
}

/** The sticky header: who, status chips, ref and dates, and the actions. */
function DetailHeader({
  detail,
  backHref,
  backLabel,
  now,
  locale,
  acting,
  openingCase,
  showDetailsToggle,
  onCopyRef,
  onOpenCase,
  onConfirm,
  onShowDetails,
}: {
  detail: SgDetail;
  backHref: string;
  backLabel: string;
  now: Date;
  locale: string;
  acting: boolean;
  openingCase: boolean;
  showDetailsToggle: boolean;
  onCopyRef: () => void;
  onOpenCase: () => void;
  onConfirm: (c: Confirm) => void;
  onShowDetails: () => void;
}) {
  const t = useTranslations('SubmissionGroups.page');
  const tl = useTranslations('SubmissionGroups.labels');
  const { group } = detail;
  const ended = group.status === 'ENDED';
  const noGroup = waModeOf(group) === 'none';
  const title = groupTitle(group) ?? t('untitled');
  const bank = bankName(group);
  const person = groupContactName(group);
  const phone = group.contact?.phone?.trim() || null;
  const chip = trackerStatusChip(group.submission_status);
  const canRetry = detail.can_manage && canRetryCreate(group);
  const canEnd = detail.can_manage && !ended;

  const opened = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
  }).format(new Date(group.created_at));
  const activity = relativeActivity(
    group.last_activity_at ?? group.created_at,
    now
  );
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const lastActive =
    activity.unit === 'none'
      ? null
      : activity.unit === 'now'
        ? t('justNow')
        : activity.unit === 'date'
          ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
              activity.date
            )
          : rtf.format(-activity.value, activity.unit);
  const number = group.channel
    ? group.channel.label || null
    : noGroup
      ? null
      : t('numberRemoved');

  return (
    <header className="bg-card sticky top-0 z-10 border-b px-3 py-3 sm:px-4">
      <div className="flex items-start gap-3">
        <BackLink label={backLabel} href={backHref} />
        <span
          aria-hidden
          className={cn(
            'flex size-11 shrink-0 items-center justify-center rounded-full text-sm font-semibold',
            avatarTone(title)
          )}
        >
          {initialsOf(title)}
        </span>
        <div className="min-w-0 flex-1">
          {/* A long name keeps its line; the bank then wraps below it. */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h1
              className="min-w-0 truncate text-lg leading-tight font-semibold"
              title={title}
            >
              {title}
            </h1>
            {group.bank && bank && (
              <BankTag code={group.bank.code} name={bank} size="md" />
            )}
          </div>
          {(!group.contact || person || phone) && (
            <p className="text-muted-foreground mt-0.5 truncate text-sm">
              {group.contact ? (
                <>
                  {t.rich('contactLine', {
                    name: person ?? phone ?? '',
                    link: (chunks) => (
                      <Link
                        href={`/contacts/${group.contact!.id}`}
                        className="text-foreground focus-visible:ring-ring/50 rounded-sm font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-3"
                      >
                        {chunks}
                      </Link>
                    ),
                  })}
                  {person && phone && <span dir="ltr">{` · ${phone}`}</span>}
                </>
              ) : (
                <span className="text-destructive">{t('contactDeleted')}</span>
              )}
            </p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {chip && (
              <span className={cn(chipClass, chip.chipClass)}>{chip.text}</span>
            )}
            <span
              className={cn(
                chipClass,
                ended
                  ? 'bg-muted text-muted-foreground'
                  : 'bg-success-soft text-success'
              )}
            >
              {ended ? t('statusEnded') : t('statusActive')}
            </span>
            {group.my_label && (
              <span className={cn(chipClass, 'bg-info-soft text-info')}>
                {t('you', { label: tl(group.my_label) })}
              </span>
            )}
          </div>
          <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="inline-flex items-center gap-1">
              {t('refLabel')}
              <code
                className="bg-muted text-foreground rounded px-1 font-mono"
                title={group.submission_ref}
              >
                {shortRef(group.submission_ref)}
              </code>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t('copyRef')}
                title={t('copyRef')}
                onClick={onCopyRef}
              >
                <Copy aria-hidden />
              </Button>
            </span>
            {number && <span>{number}</span>}
            <span>{t('openedOn', { when: opened })}</span>
            {lastActive && (
              <span>{t('lastActivity', { when: lastActive })}</span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {showDetailsToggle && (
            <Button
              variant="outline"
              size="sm"
              aria-label={t('showDetails')}
              onClick={onShowDetails}
            >
              <PanelRight aria-hidden />
              <span className="hidden sm:inline">{t('showDetails')}</span>
            </Button>
          )}
          {detail.caseId ? (
            <Link
              href={`/cases/${detail.caseId}`}
              aria-label={t('openCase')}
              className={buttonVariants({ size: 'sm' })}
            >
              <Briefcase aria-hidden />
              <span className="hidden sm:inline">{t('openCase')}</span>
            </Link>
          ) : (
            detail.can_manage && (
              <Button
                size="sm"
                disabled={openingCase}
                aria-label={t('openNewCase')}
                onClick={onOpenCase}
              >
                {openingCase ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <Briefcase aria-hidden />
                )}
                <span className="hidden sm:inline">{t('openNewCase')}</span>
              </Button>
            )
          )}
          {(canRetry || canEnd) && (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={t('moreActions')}
                disabled={acting}
                className={buttonVariants({
                  variant: 'outline',
                  size: 'icon-sm',
                })}
              >
                {acting ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <MoreVertical className="size-4" aria-hidden />
                )}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-44">
                {canRetry && (
                  <DropdownMenuItem onClick={() => onConfirm('retry')}>
                    <RotateCcw aria-hidden />
                    {t('retryCreate')}
                  </DropdownMenuItem>
                )}
                {canEnd && (
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => onConfirm('end')}
                  >
                    <XCircle aria-hidden />
                    {t('endGroup')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    </header>
  );
}

/** The notices from `groupBanners`, most urgent first. */
function Banners({
  banners,
  group,
}: {
  banners: readonly BannerKey[];
  group: SgGroup;
}) {
  const t = useTranslations('SubmissionGroups.page');
  const stillIn = closeRemaining(group.wa_close_error);
  const refused = createRefused(group.wa_create_error);
  return (
    <>
      {banners.map((b) => (
        <div
          key={b}
          role="status"
          className={
            b === 'pending' || b === 'noWhatsapp'
              ? 'bg-card text-muted-foreground flex items-start gap-2 rounded-lg border px-3 py-2 text-sm'
              : 'border-destructive/30 bg-destructive-soft text-destructive flex items-start gap-2 rounded-lg border px-3 py-2 text-sm'
          }
        >
          {b === 'noWhatsapp' ? (
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          ) : b === 'pending' ? (
            <Loader2
              className="mt-0.5 size-4 shrink-0 animate-spin"
              aria-hidden
            />
          ) : (
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          )}
          <span>
            {t(`banners.${b}`)}
            {b === 'createError' && group.wa_create_error && (
              <span className="block text-xs opacity-80">
                {refused === null
                  ? group.wa_create_error
                  : t(`banners.createRefused.${refused}`)}
              </span>
            )}
            {b === 'closeError' && group.wa_close_error && (
              <span className="block text-xs opacity-80">
                {stillIn === null
                  ? group.wa_close_error
                  : t('banners.closeRemaining', { count: stillIn })}
              </span>
            )}
          </span>
        </div>
      ))}
    </>
  );
}

/** First paint: the header's shape, then a body placeholder. */
function DetailSkeleton({
  backLabel,
  backHref,
}: {
  backLabel: string;
  backHref: string;
}) {
  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
      aria-busy="true"
    >
      <div className="bg-card flex items-start gap-3 border-b px-3 py-3 sm:px-4">
        <BackLink label={backLabel} href={backHref} />
        <div className="bg-muted size-11 shrink-0 animate-pulse rounded-full" />
        <div className="flex-1 space-y-2">
          <div className="bg-muted h-5 w-56 max-w-full animate-pulse rounded" />
          <div className="bg-muted h-4 w-40 animate-pulse rounded" />
          <div className="flex gap-1.5">
            <div className="bg-muted h-5 w-16 animate-pulse rounded-full" />
            <div className="bg-muted h-5 w-14 animate-pulse rounded-full" />
          </div>
        </div>
        <div className="bg-muted h-7 w-24 animate-pulse rounded-md" />
      </div>
      <div className="grid flex-1 gap-4 p-4 md:grid-cols-2">
        <div className="bg-muted h-64 animate-pulse rounded-xl" />
        <div className="bg-muted h-40 animate-pulse rounded-xl" />
      </div>
    </div>
  );
}
