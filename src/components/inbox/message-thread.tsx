'use client';

import {
  Fragment,
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useRef,
  useMemo,
  useReducer,
  useSyncExternalStore,
} from 'react';
import { createClient } from '@/lib/supabase/client';
import { isSendOrigin, type SendOrigin } from '@/lib/whatsapp/send-origin';
import {
  REFERENCE_CACHE_TTL_MS,
  cachedQuery,
  invalidateCached,
  membersCacheKey,
  teamRosterCacheKey,
} from '@/lib/client-cache';
import { useAuth } from '@/hooks/use-auth';
import {
  useAccountNumbers,
  useAllNumberAllocations,
} from '@/hooks/use-whatsapp-numbers';
import { useMyOutreach } from '@/hooks/use-my-outreach';
import { usePageVisible } from '@/hooks/use-page-visible';
import { useNewChatNotice } from '@/hooks/use-new-chat-notice';
import {
  outreachNotices,
  wouldStartChat,
} from '@/lib/team-activity/thread-guard';
import {
  offersMarketingSwitch,
  shouldShowNewChatNotice,
} from '@/lib/team-activity/new-chat-notice';
import { hasMinRole } from '@/lib/auth/roles';
import { usableNumbers } from '@/lib/whatsapp/channel-management';
import { NewChatNoticeCard } from './new-chat-notice';
import { cn } from '@/lib/utils';
import type {
  Conversation,
  Message,
  MessageReaction,
  MessageTemplate,
  Profile,
  InteractiveMessagePayload,
} from '@/types';
import type {
  ConversationListContact,
  ConversationListItem,
} from '@/lib/inbox/conversations';
import { MessageSquare, AlertTriangle } from 'lucide-react';
import { format, isToday, isYesterday } from 'date-fns';
import { useTranslations } from 'next-intl';
import { FullRowRetry } from '@/components/inbox/full-row-retry';
import { MediaLightbox } from './media-lightbox';
import { ThreadMessageRow } from './thread-message-row';
import { useSenderLabels } from './sender-label';
import { memberNames } from '@/lib/inbox/sender';
import { ThreadPresenceScope } from './thread-presence';
import { ThreadHeader } from './thread-header';
import type { ChatTagRowPatch } from './thread-tag-bar';
import { collectMediaGallery } from '@/lib/media/gallery';
import {
  MessageComposer,
  CHAT_MEDIA_BUCKET,
  type ComposerDraftHandle,
  type SendMediaPayload,
  parkUnsentText,
} from './message-composer';
import { FailedSendRow } from './failed-send-row';
import { NewMessagesButton } from './new-messages-button';
import { deleteAccountMedia } from '@/lib/storage/upload-media';
import { TemplatePicker } from './template-picker';
import { AiThreadBanner, type AiBannerPatch } from './ai-thread-banner';
import { NO_DRAFT_MEMORY, draftMemoryReducer } from '@/lib/ai/pending-draft';
import { needsAttention } from '@/lib/inbox/attention';
import { pageWithUnsettled, sentRowId } from '@/lib/inbox/optimistic';
import {
  shouldMarkRead,
  startUnreadReset,
  unreadResetKey,
} from '@/lib/inbox/read-state';
import {
  bottomGap,
  isNearBottom,
  threadScroll,
  threadSnapshot,
  type ThreadSnapshot,
} from '@/lib/inbox/thread-scroll';
import {
  lastAiReplyAt as newestAiReplyAt,
  lastMessageFromCustomer as newestIsCustomer,
} from '@/lib/ai/banner-state';
import { OutreachBanner } from './outreach-banner';
import { ServiceWindowBanner, serviceWindowClosedText } from './service-window';
import { BlockedSendCard } from './blocked-send-card';
import {
  cardFor,
  parseSendRestriction,
  unlockCardReducer,
  type BlockedCards,
  type UnlockCardEvent,
} from '@/lib/team-activity/blocked-send';
import {
  ThreadChannelNote,
  useConversationEvents,
} from './thread-channel-switcher';
import { ThreadAutoTagNote } from './thread-auto-tag-note';
import { ThreadPinNote } from './thread-pin-note';
import { ThreadNote } from './thread-note';
import { NoteComposer } from './note-composer';
import { ComposerModeSwitch } from './composer-mode-switch';
import { useConversationNotes } from './use-conversation-notes';
import { buildTimelineGroups, startsMessageRun } from '@/lib/inbox/timeline';
import { firstUnreadMessageId } from '@/lib/inbox/unread';
import {
  applyReactionEventToPage,
  mergeFreshPage,
  messagesCacheKey,
  type CacheEvent,
  type CachedMessagePage,
} from '@/lib/inbox/message-cache';
import { fetchLatestMessagePage } from '@/lib/inbox/message-page-fetch';
import { prefetchSession, sessionCache } from '@/lib/session-cache';
import { MessageSkeleton } from './message-skeleton';
import {
  forgetKeptUpload,
  hasExpiredUpload,
  answeredSendKind,
  arrivedSends,
  failedSendPlace,
  newestSavedAt,
  ownsUpload,
  thrownSendKind,
  type FailedSendKind,
  consentRefusalOf,
  rememberKeptUpload,
  retryAttempt,
  sendFailureReason,
  shouldWarnMaybeSent,
  supersededBy,
  takeKeptUploads,
  type FailedSend,
  type SendAttempt,
} from '@/lib/inbox/failed-send';
import {
  composerModeFor,
  type ComposerModeState,
} from '@/lib/inbox/composer-mode';
import { predictSendingNumber } from '@/lib/inbox/sending-number';
import { chatTemplateSendsFrom } from '@/lib/whatsapp/template-offer';
import {
  latestCustomerMessage,
  mayNeedServiceWindow,
  sendsOverMeta,
  serviceWindowCountdown,
  serviceWindowState,
  type LastCustomerMessage,
} from '@/lib/inbox/service-window';
import { channelDisplayName } from '@/lib/whatsapp/channel-management';
import { buildReplyPreview } from './reply-quote';
import {
  closeForward,
  forwardDialogKey,
  forwardMessage,
  type ForwardEntry,
} from '@/lib/inbox/forward-entry';
import { ownReaction, rollbackReaction } from '@/lib/inbox/reaction-rollback';
import { ForwardDialog } from './forward-dialog';
import {
  canSendMessages,
  canWriteChatNotes,
  isBankGuest,
} from '@/lib/auth/roles';
import { renderTemplateBody } from '@/lib/whatsapp/template-body';
import { toast } from 'sonner';
import { assignableMembers, assignFromScreen } from '@/lib/inbox/assign';
import {
  isShareOnlyViewer,
  isSharedChatNumberRefusal,
} from '@/lib/coordinators/ui';
import { useInsightSettings } from '@/hooks/use-insight-settings';
import { ReminderDialog } from './chat-reminder-button';
import { useReminderSuggestions } from './use-reminder-suggestions';
import {
  reminderNote,
  reminderTitleKey,
  suggestionActionResult,
  type ReminderChip,
  type SuggestionActionOutcome,
} from '@/lib/reminders/suggestion-view';
import { isPersonalNumberRefusal } from '@/lib/whatsapp/my-whatsapp';
import { resolveConversationHandler } from '@/lib/inbox/handler';
import {
  MESSAGE_PAGE_SELECT,
  MESSAGE_PAGE_SIZE,
  mergeLatestMessages,
  oldestPersisted,
  olderMessagesGroup,
  prependOlderMessages,
  replaceReactionsFor,
  splitEmbeddedReactions,
  toChronological,
  type MessageWithReactions,
} from '@/lib/inbox/pagination';

import { nextTempId } from '@/lib/inbox/optimistic';
import { failedSendStore } from '@/lib/inbox/failed-send-store';
import {
  NO_THREAD,
  isFailed,
  isKnown,
  loadFailed,
  loadStarted,
  loadSucceeded,
  readTwice,
  threadView,
  type ThreadLoad,
} from '@/lib/inbox/thread-load';

interface ReplyDraft {
  id: string;
  authorLabel: string;
  preview: string;
}

interface MessageThreadProps {
  /**
   * The open chat as soon as it is picked: its list row at first, which
   * is enough for the messages read, the header and the composer. Every
   * load here keys on its `id`, so the full row replacing it does not
   * reload anything.
   */
  conversation: ConversationListItem | null;
  /**
   * The same chat's full row once it has been read, else null. The
   * sections that read a full-only field (the AI banner: held draft,
   * hand-off summary, last outcome) wait for it.
   */
  fullConversation?: Conversation | null;
  /**
   * Every retry of the full-row read missed: the place the AI banner
   * would take offers `onRetryFullRow` instead.
   */
  fullRowFailed?: boolean;
  onRetryFullRow?: () => void;
  contact: ConversationListContact | null;
  messages: Message[];
  /**
   * Hands the parent the thread's messages. An updater form is used for
   * prepending an older page and merging a resync, which must apply to
   * the freshest state (realtime may have appended in the meantime).
   */
  onMessagesLoaded: (
    messages: Message[] | ((prev: Message[]) => Message[])
  ) => void;
  onNewMessage: (message: Message) => void;
  onUpdateMessage: (id: string, updates: Partial<Message>) => void;
  /**
   * After a chat tag pick saved (migration 075), with the values the
   * server returned: its trigger may have cleared the sub-tag.
   */
  onChatTagsChange: (conversationId: string, patch: ChatTagRowPatch) => void;
  onAssignChange: (
    conversationId: string,
    assignedAgentId: string | null
  ) => void;
  /** After an AI banner action (take over, resume, a held draft sent or
   *  discarded), with what the route changed on the row. */
  onAiChange: (conversationId: string, patch: AiBannerPatch) => void;
  /**
   * On mobile, the thread is shown full-screen with the conversation list
   * hidden. This callback lets the page deselect the active conversation
   * and reveal the list again. Rendered as a back-arrow in the header on
   * mobile only.
   */
  onBack?: () => void;
  /**
   * Increment to reload the thread's latest page (and its reactions)
   * from scratch — the manual refresh. Optional so existing callers
   * keep working.
   */
  resyncToken?: number;
  /**
   * Increment to re-read the latest page and MERGE it — new messages
   * appended, missed status ticks applied, older pages the user
   * scrolled back through kept. The parent bumps it on realtime
   * reconnect and on returning to a long-hidden tab.
   */
  deltaSyncToken?: number;
  /**
   * Fired by the manual-refresh button in the thread header. The parent
   * typically bumps the same `resyncToken` it controls — this gives the
   * user a way to force a refetch when they suspect realtime missed an
   * event (or they're impatient). Optional so existing callers keep
   * working; the button is only rendered when this is provided.
   */
  onRefresh?: () => void;
  /**
   * Desktop-only contact-panel toggle. The page owns the open/closed
   * state (it's the one that renders the sidebar), so the thread just
   * reflects it and asks the page to flip it. Both optional so existing
   * callers keep working; the toggle button only renders when
   * `onToggleContactPanel` is wired up.
   */
  contactPanelOpen?: boolean;
  /** The bank this chat was shared with the viewer under (migration 133). */
  sharedBank?: string | null;
  onToggleContactPanel?: () => void;
}

function formatDateSeparator(
  dateStr: string,
  t: ReturnType<typeof useTranslations>
): string {
  const date = new Date(dateStr);
  if (isToday(date)) return t('today');
  if (isYesterday(date)) return t('yesterday');
  return format(date, 'MMMM d, yyyy');
}

/**
 * The messages area's side padding, which the full-width unread band
 * cancels with matching negative margins — change one, change both.
 * Keyed on the thread's own width (`@container/thread`), not the
 * viewport: beside the list and the contact panel a wide screen still
 * leaves a narrow thread.
 */
const THREAD_GUTTER = 'px-3 @lg/thread:px-8 @3xl/thread:px-16';
const THREAD_GUTTER_BLEED = '-mx-3 @lg/thread:-mx-8 @3xl/thread:-mx-16';

/** The shadow WhatsApp puts under bubbles and the date chips. */
const CHIP_SHADOW = 'shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]';

/** The tab's sessionStorage, or null where touching it throws. */
function tabStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** The device says it has no network: the one answer that is reliable. */
function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/**
 * Delete an upload that no failed send will use any more, and take it
 * off the tab's kept list (lib/inbox/failed-send.ts). Best effort.
 */
function deleteKeptUpload(path: string) {
  forgetKeptUpload(tabStorage(), path);
  void deleteAccountMedia(CHAT_MEDIA_BUCKET, path).catch(() => {});
}

/**
 * The latest page of a thread, newest first, with each message's
 * reactions embedded — one round trip for what used to be two
 * unbounded ones (every message, every reaction in the conversation).
 * `id` breaks created_at ties so the keyset cursor can't skip a row.
 */
function messagesPageQuery(conversationId: string) {
  return createClient()
    .from('messages')
    .select(MESSAGE_PAGE_SELECT)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(MESSAGE_PAGE_SIZE);
}

export function MessageThread({
  conversation,
  fullConversation = null,
  fullRowFailed = false,
  onRetryFullRow,
  contact,
  messages,
  onMessagesLoaded,
  onNewMessage,
  onUpdateMessage,
  onChatTagsChange,
  onAssignChange,
  onAiChange,
  onBack,
  resyncToken = 0,
  deltaSyncToken = 0,
  onRefresh,
  contactPanelOpen,
  onToggleContactPanel,
  sharedBank = null,
}: MessageThreadProps) {
  const t = useTranslations('Inbox.messageThread');
  const tQuote = useTranslations('Inbox.replyQuote');
  const tFailedSend = useTranslations('Inbox.failedSend');

  const { user, profile, profileLoading, accountRole, accountId } = useAuth();
  // The session cache's key half (lib/inbox/message-cache.ts).
  const viewerId = user?.id ?? null;
  const [loading, setLoading] = useState(false);
  // The AI banner's typed text: it outlives the banner, which changes slot.
  const [draftMemory, rememberDraft] = useReducer(
    draftMemoryReducer,
    NO_DRAFT_MEMORY
  );
  // Whether the open chat's history is known (lib/inbox/thread-load.ts).
  const [threadLoad, setThreadLoad] = useState<ThreadLoad>(NO_THREAD);
  const [reloadToken, setReloadToken] = useState(0);
  const threadLoadRef = useRef(threadLoad);
  useEffect(() => {
    threadLoadRef.current = threadLoad;
  }, [threadLoad]);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Older-page state. The thread opens on its latest page; scrolling to
  // the top pulls the page before it.
  // Tagged with the conversation it describes and read back through
  // that check (like `openMedia` below), so a switch can't briefly
  // inherit the previous thread's answer before its own page lands.
  const [olderState, setOlderState] = useState<{
    conversationId: string;
    hasOlder: boolean;
  } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // The chat whose last older page could not be read.
  const [olderFailedFor, setOlderFailedFor] = useState<string | null>(null);
  const loadingOlderRef = useRef(false);
  // Bumped per older page so the top sentinel re-observes (see below).
  const [olderPageCount, setOlderPageCount] = useState(0);
  // Scroll geometry captured just before an older page is prepended, so
  // the layout effect can keep the same message under the reader's eye
  // instead of jumping to the bottom.
  const prependAnchorRef = useRef<{ height: number; top: number } | null>(null);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  // Until then a bubble from someone else waits for their name rather
  // than call them unknown (lib/inbox/sender.ts).
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  /** Users this person leads — empty unless they lead a team. */
  const [leadableUserIds, setLeadableUserIds] = useState<Set<string>>(
    new Set()
  );
  const [reactions, setReactions] = useState<MessageReaction[]>([]);
  // Purely visual spin state for the manual-refresh button. The actual
  // refetch is fire-and-forget through `onRefresh` (which bumps the
  // parent's resyncToken); the 700ms spin is just feedback so the click
  // doesn't feel like a no-op. Cleared via the timer ref on unmount.
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);
  const handleRefreshClick = useCallback(() => {
    if (isRefreshing || !onRefresh) return;
    setIsRefreshing(true);
    onRefresh();
    refreshTimerRef.current = setTimeout(() => {
      setIsRefreshing(false);
      refreshTimerRef.current = null;
    }, 700);
  }, [isRefreshing, onRefresh]);
  const [replyTo, setReplyTo] = useState<ReplyDraft | null>(null);
  // The message the Forward dialog is open for. Paired with its
  // conversation like `openMedia` below, so switching threads closes it.
  const [forwarding, setForwarding] = useState<ForwardEntry | null>(null);
  const forwardSeqRef = useRef(0);
  // Which attachment the media viewer is showing. Lives here rather than in
  // the bubble so the viewer can page through every image/video in the
  // thread (issue #373). Paired with the conversation it belongs to and read
  // back through that check below, so switching threads closes the viewer
  // without an effect racing the messages refetch.
  const [openMedia, setOpenMedia] = useState<{
    conversationId: string;
    messageId: string;
  } | null>(null);

  // Replies that did not certainly go out, kept for every chat until the
  // person acts: a chat switch, a resync or leaving the inbox does not
  // lose them. Memory only (lib/inbox/failed-send-store.ts).
  const failedSends = useSyncExternalStore(
    failedSendStore.subscribe,
    failedSendStore.get,
    failedSendStore.get
  );
  // A send a team-activity rule refused (204-205), per chat: switching
  // chats shows that chat's card, never another's.
  const [blockedCards, setBlockedCards] = useState<BlockedCards>({});
  const dispatchBlockedCard = useCallback(
    (conversationId: string, event: UnlockCardEvent) =>
      setBlockedCards((prev) => {
        const card = prev[conversationId];
        if (!card) return prev;
        const state = unlockCardReducer(card.state, event);
        return state === card.state
          ? prev
          : { ...prev, [conversationId]: { ...card, state } };
      }),
    []
  );
  const dismissBlockedCard = useCallback(
    (conversationId: string) =>
      setBlockedCards((prev) => {
        if (!prev[conversationId]) return prev;
        const next = { ...prev };
        delete next[conversationId];
        return next;
      }),
    []
  );
  // Their optimistic bubbles in the inbox's own list. Those are hidden
  // and <FailedSendRow> draws them instead, also after a Retry, when
  // the old bubble may still be in the list with status 'failed'.
  const [hiddenTempIds, setHiddenTempIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  // Guards Retry against a double click sending the same body twice
  // before the re-render removes the button.
  const retriedRef = useRef(new WeakSet<FailedSend>());
  const composerDraftRef = useRef<ComposerDraftHandle>(null);

  // A media send that failed for certain keeps its upload for a Retry.
  // Once nobody can send it, it is deleted: on Discard, or when another
  // login takes the tab over. React runs no cleanup when the page
  // unloads, so a reload is covered by the tab's kept list instead: this
  // mount deletes what the last page left on it, except the uploads of
  // rows that survived (the inbox was only left).
  // A layout effect, so another login's rows are gone before a paint.
  useLayoutEffect(() => {
    if (!viewerId) return;
    for (const f of failedSendStore.claim(viewerId)) {
      if (f.uploadPath && ownsUpload(f.kind)) deleteKeptUpload(f.uploadPath);
    }
  }, [viewerId]);
  useEffect(() => {
    const held = new Set(failedSendStore.get().map((f) => f.uploadPath));
    for (const path of takeKeptUploads(tabStorage())) {
      if (held.has(path)) rememberKeptUpload(tabStorage(), path);
      else deleteKeptUpload(path);
    }
    return failedSendStore.enter();
  }, []);
  // A row whose message turns out to be in the chat removes itself.
  useEffect(() => {
    const arrived = arrivedSends(failedSends, messages, viewerId);
    for (const f of arrived) {
      if (f.uploadPath) forgetKeptUpload(tabStorage(), f.uploadPath);
    }
    failedSendStore.remove(arrived);
  }, [failedSends, messages, viewerId]);

  // Bumped after a failed send so the numbers are re-read at once. The
  // number's `status` drives the warning above the composer.
  const [numbersRefresh, setNumbersRefresh] = useState(0);

  // Profiles are bounded by RLS to rows the current user is allowed to
  // see — today that's just the current user, but the dropdown keeps the
  // shape ready for shared-team workspaces without a refactor.
  //
  // Cached across mounts — this component remounts every time the user
  // opens the inbox or switches conversation, and the member list is
  // the same answer each time. Through the tunnel that repeat was a
  // few hundred milliseconds of the delay before the thread was usable.
  //
  // Scoped to the active workspace (RLS also returns the caller's own row
  // in every other one), and a bank guest is never listed.
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    (async () => {
      const data = await cachedQuery(
        membersCacheKey(accountId),
        REFERENCE_CACHE_TTL_MS,
        async () => {
          const supabase = createClient();
          const { data, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('account_id', accountId)
            .order('full_name');
          if (error) {
            console.error('Failed to fetch profiles:', error);
            // Thrown, not answered with [], so the cache drops it and the
            // next thread opened asks again: a cached empty list called
            // every colleague's message "Unknown agent" for the whole TTL.
            throw error;
          }
          return ((data as Profile[] | null) ?? []).filter(
            (p) => !isBankGuest(p.account_role)
          );
        }
      ).catch(() => [] as Profile[]);
      if (!cancelled) {
        setProfiles(data);
        setProfilesLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  // Who this user leads. Only a team leader needs it: admins can
  // already assign to anyone, and everyone else can only self-assign,
  // so neither pays for the query.
  useEffect(() => {
    if (accountRole !== 'team_leader' || !user?.id) {
      setLeadableUserIds(new Set());
      return;
    }
    let cancelled = false;
    const leaderId = user.id;
    (async () => {
      // Cached per leader: team membership changes rarely, and this
      // effect otherwise re-ran on every remount of the thread.
      const ids = await cachedQuery(
        teamRosterCacheKey(leaderId),
        REFERENCE_CACHE_TTL_MS,
        async () => {
          const supabase = createClient();
          const { data, error } = await supabase
            .from('teams')
            .select('team_members(user_id)')
            .eq('leader_user_id', leaderId);
          if (error || !data) return null;
          const found = new Set<string>();
          for (const team of data as {
            team_members: { user_id: string }[] | null;
          }[]) {
            for (const m of team.team_members ?? []) found.add(m.user_id);
          }
          return found;
        }
      ).catch(() => null);
      if (cancelled || !ids) return;
      setLeadableUserIds(ids);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountRole, user?.id]);

  // The 24-hour session window is Meta's rule only: on the Cloud API a
  // business may send free-form text within 24h of the customer's last
  // message, and only a pre-approved template otherwise. Whapi and
  // OpenWA drive a normal WhatsApp account — no window, no template
  // registry, no approval step. An earlier timer here applied the
  // window to every chat, and its `expired` flag disabled the composer
  // on precisely the threads that needed it most: a brand-new Whapi
  // conversation has no customer message yet, so it counted as expired
  // and there was no way to send the first one. So the window below is
  // judged only for a chat whose reply certainly goes out on Meta, and
  // even there it never blocks templates, which is how a Meta chat's
  // first message goes out.

  // Store latest callback in a ref so fetchMessages doesn't need to
  // depend on `onMessagesLoaded` — otherwise parent re-renders cause
  // fetchMessages to change → useEffect re-fires → refetch → realtime
  // UPDATE on conversations.unread_count → parent re-renders → LOOP.
  // The ref is written inside an effect so the mutation doesn't happen
  // during render (React 19 refs rule); consumers only read `.current`
  // inside the async fetch completion, which runs after the render.
  const onMessagesLoadedRef = useRef(onMessagesLoaded);
  useEffect(() => {
    onMessagesLoadedRef.current = onMessagesLoaded;
  });

  const conversationId = conversation?.id;
  const threadKnown = isKnown(threadLoad, conversationId);
  const threadFailed = isFailed(threadLoad, conversationId);
  const unreadKey = unreadResetKey(conversation ?? null);
  const hasOlder =
    !!conversationId &&
    olderState?.conversationId === conversationId &&
    olderState.hasOlder;

  const mediaMessageId =
    openMedia && openMedia.conversationId === conversationId
      ? openMedia.messageId
      : null;
  const handleMediaChange = useCallback(
    (messageId: string | null) => {
      setOpenMedia(
        messageId && conversationId ? { conversationId, messageId } : null
      );
    },
    [conversationId]
  );

  // Mirrors for async completions and stable callbacks, written in an
  // effect per React 19's refs rule.
  const conversationIdRef = useRef(conversationId);
  const messagesRef = useRef(messages);
  // Declared before the page fetch below so that, in the commit that
  // opens a chat, the fetch reads this render's count — the one from
  // before the unread reset zeroes it.
  const unreadCountRef = useRef(conversation?.unread_count ?? 0);
  useEffect(() => {
    conversationIdRef.current = conversationId;
    messagesRef.current = messages;
    unreadCountRef.current = conversation?.unread_count ?? 0;
  });

  // WhatsApp's "N unread messages" divider: how many were unread when
  // this chat was opened, and the message it sits above. Fixed once
  // the first page lands, so replies and new messages arriving while
  // the agent reads do not move it; read back through the
  // conversation check, so another chat never inherits it.
  const [unreadMarker, setUnreadMarker] = useState<{
    conversationId: string;
    count: number;
    messageId: string | null;
  } | null>(null);
  // Which chat the page fetch last ran for, telling a chat opened
  // (again) apart from a refresh of the one already open.
  const lastFetchedConversationRef = useRef<string | null>(null);

  // A draft restored after a failure belongs to its own chat. The
  // composer parks it with that chat on a switch, like anything typed
  // (per-chat drafts), so the thread no longer takes it back out by
  // text: that ran after the composer's switch (a child's layout
  // effects run first) and could erase the next chat's own parked
  // draft when the two texts matched.
  useLayoutEffect(() => {
    // Here too, not only in the passive effect above: when the switch
    // does not come from a click (a deep link, a notification), passive
    // effects run a task later, and a failure landing in that gap would
    // restore the old chat's text into the next one.
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  // The number a reply here goes out on, and whether it has dropped.
  // Re-read on every chat opened (through the cache, so at most once a
  // minute) and after a failed send. A number that dropped after the
  // inbox opened must still warn the next agent who starts typing.
  const accountNumbers = useAccountNumbers(
    true,
    `${conversationId ?? ''}:${numbersRefresh}`
  );
  const threadChannelId = conversation?.channel_id ?? null;
  const threadPin = conversation?.send_channel_id ?? null;
  const disconnectedNumber = useMemo(() => {
    if (!accountNumbers || !conversationId) return null;
    const n = predictSendingNumber(accountNumbers, {
      channel_id: threadChannelId,
      send_channel_id: threadPin,
    });
    // Only a definite 'disconnected'. The status may lag behind the
    // phone, so this warns and never blocks a send.
    return n?.status === 'disconnected' ? n : null;
  }, [accountNumbers, conversationId, threadChannelId, threadPin]);

  // Team activity (migration 068): warnings before the next message on
  // a phone number (Whapi or OpenWA) — today's new-chat limit, a contact who stopped
  // answering. The day's counts are re-read after a send from here that
  // started a chat; the clock ticks each minute so "24 hours since the
  // last message" turns over without a reload.
  const [outreachRefresh, setOutreachRefresh] = useState(0);
  const myOutreach = useMyOutreach(
    accountRole && accountRole !== 'viewer' ? user?.id : null,
    outreachRefresh
  );
  const [outreachNow, setOutreachNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setOutreachNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  // Read by `deliver` before it adds the optimistic bubble, which would
  // otherwise make every send look like a reply.
  const outreachStartingRef = useRef(false);
  useEffect(() => {
    outreachStartingRef.current =
      threadKnown && wouldStartChat(messages, outreachNow);
  }, [messages, outreachNow, threadKnown]);
  const guardNotices = useMemo(() => {
    if (
      !threadKnown ||
      !accountNumbers ||
      !conversationId ||
      !accountRole ||
      accountRole === 'viewer'
    ) {
      return [];
    }
    const n = predictSendingNumber(accountNumbers, {
      channel_id: threadChannelId,
      send_channel_id: threadPin,
    });
    return outreachNotices({
      messages,
      day: myOutreach,
      channelId: n?.id ?? null,
      provider:
        n?.provider === 'whapi' ||
        n?.provider === 'meta' ||
        n?.provider === 'openwa'
          ? n.provider
          : null,
      now: outreachNow,
    });
  }, [
    threadKnown,
    accountNumbers,
    conversationId,
    accountRole,
    threadChannelId,
    threadPin,
    messages,
    myOutreach,
    outreachNow,
  ]);

  // Meta's 24-hour window (lib/inbox/service-window.ts), for a company
  // chat whose next reply certainly goes out on the Cloud API number
  // (`sendsOverMeta`, not `predictSendingNumber`: the latter is a guess
  // good enough for a warning, not for a block). The last customer
  // message comes from the loaded page; a page without one asks for the
  // latest (one row). Until that is known nothing is blocked. Re-judged
  // each minute (`outreachNow`) and on every new message.
  const loadedLastCustomer: LastCustomerMessage | null = useMemo(
    () => latestCustomerMessage(messages, conversationId),
    [messages, conversationId]
  );
  const [lastCustomerLookup, setLastCustomerLookup] = useState<{
    conversationId: string;
    message: LastCustomerMessage | null;
  } | null>(null);
  const needsLastCustomerLookup =
    !!conversation &&
    mayNeedServiceWindow(accountNumbers, conversation) &&
    !loading &&
    !!conversationId &&
    loadedLastCustomer === null &&
    lastCustomerLookup?.conversationId !== conversationId;
  useEffect(() => {
    if (!needsLastCustomerLookup || !conversationId) return;
    let cancelled = false;
    void createClient()
      .from('messages')
      .select('created_at, channel_id, provider')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data, error }) => {
        // A failed read leaves the window unknown: nothing is blocked.
        if (cancelled || error) return;
        setLastCustomerLookup({
          conversationId,
          message: (data as LastCustomerMessage | null) ?? null,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [needsLastCustomerLookup, conversationId]);
  const lastCustomer: LastCustomerMessage | null | undefined =
    loadedLastCustomer ??
    (loading
      ? undefined
      : lastCustomerLookup &&
          lastCustomerLookup.conversationId === conversationId
        ? lastCustomerLookup.message
        : undefined);
  const serviceWindow =
    conversation && sendsOverMeta(accountNumbers, conversation, lastCustomer)
      ? serviceWindowState(
          lastCustomer ? lastCustomer.created_at : lastCustomer,
          outreachNow
        )
      : null;
  const freeTextBlocked = serviceWindow?.kind === 'closed';
  const tWindow = useTranslations('ServiceWindow');
  const windowCountdown = serviceWindowCountdown(serviceWindow);

  // The standing "use the marketing number" reminder (migration 207):
  // shown while the next send would open a chat, on a company chat,
  // not already going out from the marketing number. Its switch is
  // offered on the switcher's terms (numbers the person may use).
  const newChatNotice = useNewChatNotice();
  const numberAllocations = useAllNumberAllocations();
  const startsNewChat = useMemo(
    () => threadKnown && wouldStartChat(messages, outreachNow),
    [messages, outreachNow, threadKnown]
  );
  const showNewChatNotice =
    !!newChatNotice &&
    !!conversation &&
    !!accountNumbers &&
    !!accountRole &&
    canSendMessages(accountRole) &&
    shouldShowNewChatNotice({
      notice: newChatNotice,
      wouldStartChat: startsNewChat,
      isPersonalChat: !!conversation.personal_owner_id,
      sendingChannelId:
        predictSendingNumber(accountNumbers, {
          channel_id: threadChannelId,
          send_channel_id: threadPin,
        })?.id ?? null,
    });
  const offerMarketingSwitch =
    showNewChatNotice &&
    !!newChatNotice &&
    !!conversation &&
    offersMarketingSwitch({
      notice: newChatNotice,
      usableIds:
        accountNumbers && numberAllocations
          ? usableNumbers(
              accountNumbers,
              numberAllocations,
              viewerId,
              !!accountRole && hasMinRole(accountRole, 'admin')
            )
              .filter((n) => !n.is_personal)
              .map((n) => n.id)
          : null,
      locked: isShareOnlyViewer(
        accountRole,
        viewerId,
        conversation,
        !!sharedBank
      ),
    });

  // Fetch the latest page whenever the selected conversation changes.
  // Kept separate from the unread-reset effect so that incoming messages
  // arriving while the thread is open don't trigger a full refetch —
  // they only change unreadKey, which only the reset effect listens to.
  //
  // One page, not the whole history: a long-running customer thread was
  // thousands of rows on the critical path of opening it. Reactions come
  // embedded in the same response.
  useEffect(() => {
    if (!conversationId) {
      setReactions([]);
      // Backing out to the list and into the same chat is an opening.
      lastFetchedConversationRef.current = null;
      return;
    }

    let cancelled = false;
    // Taken now, synchronously: by the time the page arrives the reset
    // effect below has usually zeroed the count.
    const unreadAtOpen = unreadCountRef.current;
    const opened = lastFetchedConversationRef.current !== conversationId;
    lastFetchedConversationRef.current = conversationId;
    // The latest page as last seen this session (lib/inbox/message-cache.ts):
    // an opening shows it at once and still reads the page again. A
    // manual refresh (same chat) reloads from scratch, as before.
    const key = messagesCacheKey(accountId, viewerId, conversationId);
    const cached =
      opened && key
        ? sessionCache.get<CachedMessagePage>(key)?.value
        : undefined;
    // Once per chat opened: a manual refresh of the same chat keeps
    // the divider where the agent first saw it.
    const markUnread = (page: Message[]) =>
      setUnreadMarker((prev) =>
        !opened && prev?.conversationId === conversationId
          ? prev
          : {
              conversationId,
              count: unreadAtOpen,
              messageId: firstUnreadMessageId(page, unreadAtOpen),
            }
      );

    (async () => {
      setThreadLoad((prev) => loadStarted(prev, conversationId, !!cached));
      if (cached) {
        setOlderState({ conversationId, hasOlder: cached.hasOlder });
        setReactions(cached.reactions);
        markUnread(cached.messages);
        onMessagesLoadedRef.current(cached.messages);
        setLoading(false);
      } else {
        setLoading(true);
      }

      const fetcher = () => fetchLatestMessagePage(conversationId);
      let fresh: CachedMessagePage;
      try {
        // Joins a hover prefetch still in flight; a refresh starts anew.
        fresh = key
          ? await prefetchSession(key, fetcher, { force: !opened })
          : await fetcher();
      } catch (error) {
        if (cancelled) return;
        console.error('Failed to fetch messages:', error);
        setThreadLoad((prev) => loadFailed(prev, conversationId));
        setLoading(false);
        return;
      }
      if (cancelled) return;
      setThreadLoad(loadSucceeded(conversationId));

      if (cached) {
        // Folded into what is shown, which realtime and the composer may
        // have added to since the cached page went up. The fresh page has
        // the last word on the cached rows it covers: one it no longer
        // holds was deleted or is no longer ours to see (RLS answers
        // with no rows), so it goes (lib/inbox/pagination.ts).
        const shownBefore = new Set(cached.messages.map((m) => m.id));
        const merged = mergeFreshPage(
          { messages: messagesRef.current, reactions: [], shownBefore },
          fresh
        );
        setOlderState({ conversationId, hasOlder: merged.hasOlder });
        setReactions((prev) =>
          replaceReactionsFor(
            prev,
            fresh.messages.map((m) => m.id),
            fresh.reactions
          )
        );
        markUnread(merged.messages);
        onMessagesLoadedRef.current(
          (prev) =>
            mergeFreshPage(
              { messages: prev, reactions: [], shownBefore, viewerId },
              fresh
            ).messages
        );
      } else {
        setOlderState({ conversationId, hasOlder: fresh.hasOlder });
        setReactions(fresh.reactions);
        markUnread(fresh.messages);
        onMessagesLoadedRef.current((prev) =>
          pageWithUnsettled(prev, fresh.messages, viewerId)
        );
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a full reload
    // (the manual refresh button), `reloadToken` a failed load's Retry.
  }, [conversationId, resyncToken, reloadToken, accountId, viewerId]);

  // Delta resync: re-read the latest page and merge it in, keeping the
  // older pages the user scrolled back through and not flashing the
  // spinner. Keyed on the token alone; the ref remembers which one was
  // handled so a remount-free re-render never re-sends it.
  const resync = useCallback(() => {
    const convId = conversationIdRef.current;
    if (!convId) return;

    // Nothing to merge into: the first read failed, so read it again.
    const load = threadLoadRef.current;
    if (isFailed(load, convId) && !isKnown(load, convId)) {
      setReloadToken((n) => n + 1);
      return;
    }

    (async () => {
      // Retried once; after that what is shown stays.
      const answer = await readTwice(
        () => messagesPageQuery(convId),
        () => conversationIdRef.current === convId
      );
      if (!answer || conversationIdRef.current !== convId) return;
      setThreadLoad((prev) =>
        isFailed(prev, convId) ? loadSucceeded(convId) : prev
      );
      const { messages: pageDesc, reactions: pageReactions } =
        splitEmbeddedReactions((answer.data ?? []) as MessageWithReactions[]);
      const page = toChronological(pageDesc);
      // More arrived than one page: the merge replaces the thread with
      // the page, so there is history above it again.
      if (mergeLatestMessages(messagesRef.current, page).gap) {
        setOlderState({ conversationId: convId, hasOlder: true });
      }
      onMessagesLoadedRef.current(
        (prev) =>
          mergeLatestMessages(prev, page, MESSAGE_PAGE_SIZE, viewerId).messages
      );
      setReactions((prev) =>
        replaceReactionsFor(
          prev,
          page.map((m) => m.id),
          pageReactions
        )
      );
    })();
  }, [viewerId]);
  const handledDeltaTokenRef = useRef(deltaSyncToken);
  useEffect(() => {
    if (deltaSyncToken === handledDeltaTokenRef.current) return;
    handledDeltaTokenRef.current = deltaSyncToken;
    resync();
  }, [deltaSyncToken, resync]);

  // Pull the page before the oldest message held.
  const loadOlder = useCallback(async () => {
    const convId = conversationIdRef.current;
    if (!convId || loadingOlderRef.current) return;
    const oldest = oldestPersisted(messagesRef.current);
    if (!oldest) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    setOlderFailedFor(null);
    try {
      const { data, error } = await createClient()
        .from('messages')
        .select(MESSAGE_PAGE_SELECT)
        .eq('conversation_id', convId)
        .or(olderMessagesGroup(oldest))
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(MESSAGE_PAGE_SIZE);
      if (conversationIdRef.current !== convId) return;
      if (error) {
        console.error('Failed to fetch older messages:', error);
        setOlderFailedFor(convId);
        return;
      }
      const { messages: pageDesc, reactions: pageReactions } =
        splitEmbeddedReactions((data ?? []) as MessageWithReactions[]);
      setOlderState({
        conversationId: convId,
        hasOlder: pageDesc.length >= MESSAGE_PAGE_SIZE,
      });
      setOlderPageCount((n) => n + 1);
      const held = new Set(messagesRef.current.map((m) => m.id));
      if (!pageDesc.some((m) => !held.has(m.id))) return;
      const el = scrollRef.current;
      if (el) {
        prependAnchorRef.current = {
          height: el.scrollHeight,
          top: el.scrollTop,
        };
      }
      setReactions((prev) => {
        const known = new Set(prev.map((r) => r.id));
        const fresh = pageReactions.filter((r) => !known.has(r.id));
        return fresh.length ? [...prev, ...fresh] : prev;
      });
      onMessagesLoadedRef.current((prev) =>
        prependOlderMessages(prev, toChronological(pageDesc))
      );
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, []);

  // Reminder suggestions (migration 197): a chip under a message that
  // names a later time. Only while the account's switch is on and Jev
  // can run, and only for someone who could file the task from the
  // header's "Remind me" (agent and up, not a share-only coordinator).
  const tReminder = useTranslations('Inbox.reminderSuggestion');
  const tRows = useTranslations('InboxRows');
  const { settings: insightSettings, available: insightsAvailable } =
    useInsightSettings();
  const reminderChipsOn =
    insightSettings.reminderSuggestEnabled &&
    insightsAvailable &&
    !!accountRole &&
    canSendMessages(accountRole) &&
    !(
      conversation &&
      isShareOnlyViewer(accountRole, viewerId, conversation, !!sharedBank)
    );
  const {
    byMessageId: suggestionsByMessageId,
    at: suggestionsAt,
    merge: mergeSuggestion,
  } = useReminderSuggestions(conversationId, reminderChipsOn);

  /** POST an action; merges the row it answers with (a 409 silently). */
  const postReminderAction = useCallback(
    async (
      suggestionId: string,
      body:
        | { action: 'added'; taskId: string }
        | { action: 'dismissed' }
        | { action: 'reopen' }
    ): Promise<SuggestionActionOutcome> => {
      const res = await fetch(
        `/api/inbox/reminder-suggestions/${encodeURIComponent(suggestionId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      ).catch(() => null);
      const json = res ? await res.json().catch(() => null) : null;
      const { outcome, suggestion } = suggestionActionResult(
        res?.status ?? null,
        json
      );
      if (suggestion) mergeSuggestion(suggestion);
      return outcome;
    },
    [mergeSuggestion]
  );

  const [addingReminder, setAddingReminder] = useState<{
    conversationId: string;
    message: Message;
    chip: ReminderChip;
  } | null>(null);
  // The dialog unmounts with the chat, not through onClose: drop the
  // prefill so it does not pop up again on returning.
  // The Forward dialog likewise.
  useEffect(() => {
    setAddingReminder(null);
    setForwarding(null);
  }, [conversationId]);

  const handleAddReminder = useCallback(
    (message: Message, chip: ReminderChip) => {
      setAddingReminder({
        conversationId: message.conversation_id,
        message,
        chip,
      });
    },
    []
  );

  const handleDismissReminder = useCallback(
    (suggestionId: string) => {
      void postReminderAction(suggestionId, { action: 'dismissed' }).then(
        (outcome) => {
          if (outcome === 'failed')
            return void toast.error(tReminder('failed'));
          if (outcome === 'conflict') return;
          toast(tReminder('dismissed'), {
            action: {
              label: tReminder('undo'),
              onClick: () =>
                void postReminderAction(suggestionId, {
                  action: 'reopen',
                }).then((again) => {
                  if (again === 'failed') toast.error(tReminder('failed'));
                }),
            },
          });
        }
      );
    },
    [postReminderAction, tReminder]
  );

  // Reactions realtime subscription per conversation. Subscribing here
  // (not at the page level) keeps the channel scoped to the visible
  // conversation and avoids cross-conversation chatter on a busy inbox.
  useEffect(() => {
    if (!conversationId) return;
    const supabase = createClient();
    // Keeps the cached page current, so a revisit shows these too.
    const key = messagesCacheKey(accountId, viewerId, conversationId);
    const patchCache = (event: CacheEvent<MessageReaction>) => {
      if (key) {
        sessionCache.update<CachedMessagePage>(key, (p) =>
          applyReactionEventToPage(p, event)
        );
      }
    };

    const channel = supabase
      .channel(`reactions:${conversationId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'message_reactions',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const row = payload.new as MessageReaction;
          patchCache({ eventType: 'INSERT', new: row, old: {} });
          setReactions((prev) => {
            if (prev.some((r) => r.id === row.id)) return prev;
            // Swap any matching optimistic temp row for the real one so
            // the pill doesn't double up after a successful POST.
            const tempIdx = prev.findIndex(
              (r) =>
                r.id.startsWith('temp-') &&
                r.message_id === row.message_id &&
                r.actor_type === row.actor_type &&
                r.actor_id === row.actor_id
            );
            if (tempIdx >= 0) {
              const copy = prev.slice();
              copy[tempIdx] = row;
              return copy;
            }
            return [...prev, row];
          });
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'message_reactions',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const row = payload.new as MessageReaction;
          patchCache({ eventType: 'UPDATE', new: row, old: {} });
          setReactions((prev) => prev.map((r) => (r.id === row.id ? row : r)));
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'message_reactions',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const old = payload.old as Partial<MessageReaction>;
          if (!old?.id) return;
          patchCache({
            eventType: 'DELETE',
            new: {} as MessageReaction,
            old,
          });
          setReactions((prev) => prev.filter((r) => r.id !== old.id));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversationId, accountId, viewerId]);

  // Clear any in-progress reply draft when the active conversation changes —
  // a quote pulled from conversation A shouldn't bleed into conversation B.
  // Cleared while rendering, not in an effect: the composer's own switch
  // effect (a child's, so it runs first) may put back the quote of a
  // draft parked for this chat, and a later reset here would wipe it.
  const [replyFor, setReplyFor] = useState(conversationId);
  if (replyFor !== conversationId) {
    setReplyFor(conversationId);
    setReplyTo(null);
  }

  // Reset the server-side unread_count to 0 whenever an unread count
  // surfaces on the active conversation — covers both (a) opening a
  // conversation that had unread messages and (b) new messages arriving
  // while the user is already viewing the thread (webhook server-bumps
  // unread_count to N+1; the realtime UPDATE propagates it into the
  // client, which re-runs this effect and flips it back to 0).
  //
  // Guarding on unreadKey prevents the eq-update loop: once unread_count
  // is 0 the condition is false, so no further UPDATE is issued.
  //
  // Only while the tab is on screen, and again when it comes back. A
  // reset that failed is retried once, then with the next resync (hence
  // the tokens) or the next time the tab is shown.
  const pageVisible = usePageVisible();
  useEffect(() => {
    if (!shouldMarkRead({ conversationId, unreadKey, visible: pageVisible })) {
      return;
    }
    return startUnreadReset(async () => {
      const { error } = await createClient()
        .from('conversations')
        .update({ unread_count: 0 })
        .eq('id', conversationId);
      if (error) console.error('Failed to reset unread_count:', error);
      return !error;
    });
  }, [conversationId, unreadKey, pageVisible, resyncToken, deltaSyncToken]);

  // Where the reader last left the thread, in pixels above its end. Read
  // from scroll events, so content growing under someone at the bottom
  // (an image loading) does not count as them having scrolled away.
  const bottomGapRef = useRef(0);
  const settledTopRef = useRef<number | null>(null);
  const scrollSnapshotRef = useRef<ThreadSnapshot | null>(null);
  // Messages that arrived out of sight, for the button over the thread.
  const [below, setBelow] = useState<{
    conversationId: string;
    count: number;
  } | null>(null);
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    settledTopRef.current = el.scrollTop;
    bottomGapRef.current = 0;
    setBelow(null);
  }, []);
  const handleThreadScroll = useCallback(() => {
    const el = scrollRef.current;
    // The event of our own jump may come after an image grew the thread.
    if (!el || el.scrollTop === settledTopRef.current) return;
    settledTopRef.current = null;
    bottomGapRef.current = bottomGap(el);
    if (isNearBottom(bottomGapRef.current)) setBelow(null);
  }, []);
  // An attachment that loads grows the thread: stay at the very end.
  const handleMediaLoaded = useCallback(() => {
    if (bottomGapRef.current <= 1) scrollToBottom();
  }, [scrollToBottom]);

  // Scroll to the bottom when the chat opens, on the person's own send,
  // or on an arrival while they read the newest messages
  // (lib/inbox/thread-scroll.ts); an older page prepended above keeps
  // the reader's position. A layout effect so the jump lands before paint (no flash of
  // the wrong scroll offset) and before the top sentinel's observer is
  // (re)created in the effect below.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const anchor = prependAnchorRef.current;
    if (anchor) {
      prependAnchorRef.current = null;
      el.scrollTop = el.scrollHeight - anchor.height + anchor.top;
    }
    // A (re)load replaces what is on screen, so it counts as an opening.
    if (!conversationId || loading || messages.length === 0) {
      scrollSnapshotRef.current = null;
      return;
    }
    const { toBottom, arrived } = threadScroll(
      scrollSnapshotRef.current,
      conversationId,
      messages,
      bottomGapRef.current,
      viewerId
    );
    scrollSnapshotRef.current = threadSnapshot(conversationId, messages);
    if (toBottom) {
      scrollToBottom();
    } else if (arrived > 0) {
      setBelow((prev) => ({
        conversationId,
        count:
          arrived + (prev?.conversationId === conversationId ? prev.count : 0),
      }));
    }
  }, [messages, loading, conversationId, viewerId, scrollToBottom]);

  // Load older messages as the top sentinel nears the viewport. Rooted
  // on the scroll container so the margin prefetches before the reader
  // actually hits the top. Re-created after every older page so a
  // sentinel still on screen (a short page) keeps pulling.
  const topSentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = topSentinelRef.current;
    const root = scrollRef.current;
    if (
      !el ||
      !root ||
      !hasOlder ||
      loading ||
      typeof IntersectionObserver === 'undefined'
    ) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadOlder();
      },
      { root, rootMargin: '300px 0px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasOlder, loading, olderPageCount, conversationId, loadOlder]);

  // The header names whoever last replied when nobody is assigned —
  // evidence that lives in the messages. With only the latest page
  // loaded, that reply can sit further back; ask for just that one
  // sender id rather than let the header fall back to the owner.
  const [olderReplier, setOlderReplier] = useState<{
    conversationId: string;
    userId: string | null;
  } | null>(null);
  const loadedHasReplier = useMemo(
    () => messages.some((m) => m.sender_type === 'agent' && !!m.sender_id),
    [messages]
  );
  const needsOlderReplier =
    !!conversationId &&
    !conversation?.assigned_agent_id &&
    hasOlder &&
    !loading &&
    !loadedHasReplier &&
    olderReplier?.conversationId !== conversationId;
  useEffect(() => {
    if (!needsOlderReplier || !conversationId) return;
    let cancelled = false;
    (async () => {
      const { data } = await createClient()
        .from('messages')
        .select('sender_id')
        .eq('conversation_id', conversationId)
        .eq('sender_type', 'agent')
        .not('sender_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      setOlderReplier({
        conversationId,
        userId: (data?.sender_id as string | undefined) ?? null,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [needsOlderReplier, conversationId]);

  // One path for every send from this thread, so a Retry takes exactly
  // the route the first attempt took.
  const deliver = useCallback(
    async (attempt: SendAttempt) => {
      const { message } = attempt;
      const failedTitle = (reason: string) =>
        tFailedSend(
          message.content_type === 'template' ? 'toastTemplate' : 'toast',
          { reason }
        );
      const startsChat = outreachStartingRef.current;

      const conversationId = message.conversation_id;
      const sentAfter = newestSavedAt(messagesRef.current, conversationId);
      // Every send that did not certainly succeed ends here: its row, and
      // its words back where the person will look for them.
      const keep = (kind: FailedSendKind, reason: string) => {
        const row: FailedSend = {
          ...attempt,
          sentAfter,
          message: { ...message, status: 'failed' },
          conversationId,
          kind,
          reason,
        };
        // Mark the optimistic bubble as failed; the row is drawn instead.
        onUpdateMessage(message.id, { status: 'failed' });
        setHiddenTempIds((prev) => new Set(prev).add(message.id));
        // Not after a `maybe`: the delivered message may link to it.
        const upload = ownsUpload(kind) ? row.uploadPath : undefined;
        if (!failedSendStore.add(viewerId, row)) {
          // Another login has the tab: nobody can send it any more.
          if (upload) deleteKeptUpload(upload);
          return;
        }
        if (upload) rememberKeptUpload(tabStorage(), upload);
        const place = failedSendPlace(row, {
          leftInbox: failedSendStore.left(),
          openConversationId: conversationIdRef.current,
        });
        if (place === 'row' || !row.restoreText) return;
        // With its origin: a restored missed-call draft is re-checked
        // against the consent register when it is sent again.
        const origin = isSendOrigin(row.body.origin) ? row.body.origin : null;
        if (place === 'parked') {
          parkUnsentText(viewerId, conversationId, {
            text: row.restoreText,
            origin,
            reply: row.quote ?? null,
          });
        } else {
          composerDraftRef.current?.restore(row.restoreText, origin);
        }
      };

      // Optimistic update — shows the message immediately with "sending"
      // status. Only in its own chat: a voice note's upload can end after
      // the person moved on, and it is still sent to the chat it is for.
      if (conversationIdRef.current === conversationId) onNewMessage(message);

      let res: Response;
      let payload: unknown;
      const offlineBefore = isOffline();
      try {
        res = await fetch('/api/whatsapp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(attempt.body),
        });
        payload = await res.json().catch(() => null);
      } catch (err) {
        // No answer at all: unless the device was offline, the send may
        // still have gone out, so there is no Retry. It could reach the
        // customer twice.
        console.error(`Failed to send ${message.content_type}:`, err);
        const kind = thrownSendKind(offlineBefore, isOffline());
        const reason = tFailedSend(kind === 'offline' ? 'offline' : 'noAnswer');
        toast.error(
          failedTitle(reason),
          kind === 'maybe'
            ? { description: tFailedSend('maybeSent') }
            : undefined
        );
        keep(kind, reason);
        return;
      }

      if (res.ok) {
        // Success — the realtime INSERT event will replace the temp bubble
        // with the real DB row. If realtime hasn't arrived yet, at least
        // flip status to 'sent' so the UI stops showing "sending".
        // `sent_row_id` names that row, so the bubble goes when it is here.
        onUpdateMessage(message.id, {
          status: 'sent',
          sent_row_id: sentRowId(payload),
        });
        // It started a chat: today's counts moved.
        if (startsChat) setOutreachRefresh((k) => k + 1);
        return;
      }

      // The consent register's refusal of a missed-call draft is
      // worded here, in the app's language; anything else in the
      // route's own words.
      const refusal = consentRefusalOf(res.status, payload);
      const reason = refusal
        ? tFailedSend(
            refusal === 'do_not_contact' ? 'doNotContact' : 'optedOut'
          )
        : isSharedChatNumberRefusal(res.status, payload)
          ? tFailedSend('sharedChatNumber')
          : isPersonalNumberRefusal(res.status, payload)
            ? tFailedSend('personalNumber')
            : sendFailureReason(res.status, payload);
      console.error(`Failed to send ${message.content_type}:`, reason);
      // A team-activity rule's refusal gets the chat's own card (with
      // the unlock request) instead of a toast; Retry stays below.
      const restriction = parseSendRestriction(res.status, payload);
      if (restriction) {
        setBlockedCards((prev) => ({
          ...prev,
          [message.conversation_id]: {
            restriction,
            state: { phase: 'blocked' },
          },
        }));
        setOutreachRefresh((k) => k + 1);
      } else {
        toast.error(
          failedTitle(reason),
          shouldWarnMaybeSent(res.status, payload)
            ? { description: tFailedSend('maybeSent') }
            : undefined
        );
      }
      // The usual cause is a dropped number. Re-read the numbers now
      // rather than a minute from now, so the warning shows.
      invalidateCached('whatsapp-channels:');
      setNumbersRefresh((n) => n + 1);
      keep(answeredSendKind(res.status, payload), reason);
    },
    [onNewMessage, onUpdateMessage, tFailedSend, viewerId]
  );

  const handleRetry = useCallback(
    (failed: FailedSend) => {
      if (retriedRef.current.has(failed)) return;
      retriedRef.current.add(failed);
      failedSendStore.remove([failed]);
      // Kept past the server's sweep age, the upload may be gone, and a
      // Retry would send a dead link. Dropped instead, like a Discard.
      if (hasExpiredUpload(failed)) {
        if (failed.uploadPath) deleteKeptUpload(failed.uploadPath);
        toast.error(tFailedSend('attachmentExpired'));
        return;
      }
      // The restored draft is what this sends. Left in the composer, it
      // would be one Enter away from going out twice.
      if (failed.restoreText) {
        composerDraftRef.current?.clearIf(failed.restoreText);
      }
      // Off the kept list before it goes out: a reload while the retry
      // is in flight must not sweep an upload it may be delivering. A
      // definite failure lists it again.
      if (failed.uploadPath) forgetKeptUpload(tabStorage(), failed.uploadPath);
      void deliver(retryAttempt(failed, nextTempId()));
    },
    [deliver, tFailedSend]
  );

  const handleCopyFailed = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast.success(tFailedSend('copied'));
      } catch {
        toast.error(tFailedSend('copyFailed'));
      }
    },
    [tFailedSend]
  );

  const handleDiscard = useCallback((failed: FailedSend) => {
    if (retriedRef.current.has(failed)) return;
    retriedRef.current.add(failed);
    failedSendStore.remove([failed]);
    // It never went out, and now nobody will send it.
    if (failed.uploadPath && ownsUpload(failed.kind)) {
      deleteKeptUpload(failed.uploadPath);
    }
  }, []);

  const handleSend = useCallback(
    async (text: string, replyToId?: string, origin?: SendOrigin) => {
      if (!conversation) return;

      // The same words sent again (usually the restored draft) replace
      // a failed attempt. Its Retry would send them a second time.
      const convId = conversation.id;
      failedSendStore.remove(supersededBy(failedSendStore.get(), convId, text));

      const tempId = nextTempId();
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: 'agent',
        content_type: 'text',
        content_text: text,
        status: 'sending',
        created_at: new Date().toISOString(),
        reply_to_message_id: replyToId,
      };
      setReplyTo(null);

      await deliver({
        message: optimisticMsg,
        body: {
          conversation_id: conversation.id,
          message_type: 'text',
          content_text: text,
          reply_to_message_id: replyToId,
          // The missed-call draft: the route re-checks consent for it.
          ...(origin ? { origin } : {}),
        },
        restoreText: text,
        quote: replyTo && replyTo.id === replyToId ? replyTo : null,
      });
    },
    [conversation, deliver, replyTo]
  );

  const handleSendMedia = useCallback(
    async (payload: SendMediaPayload) => {
      if (!conversation) return;

      // Documents show their filename in our own bubble (and to the
      // recipient as the Meta caption when no caption was typed); other
      // kinds use the caption as-is. Audio carries no caption.
      const contentText =
        payload.kind === 'document'
          ? payload.caption || payload.filename || 'Document'
          : payload.caption;

      const tempId = nextTempId();
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: 'agent',
        content_type: payload.kind,
        content_text: contentText,
        media_url: payload.mediaUrl,
        status: 'sending',
        created_at: new Date().toISOString(),
        reply_to_message_id: payload.replyToId,
      };
      // Its own quote only: a voice note is sent once it is uploaded, and
      // by then another message, or another chat's, may be quoted.
      setReplyTo((r) => (r && r.id !== payload.replyToId ? r : null));

      await deliver({
        message: optimisticMsg,
        body: {
          conversation_id: conversation.id,
          message_type: payload.kind,
          media_url: payload.mediaUrl,
          content_text: contentText,
          filename: payload.filename,
          reply_to_message_id: payload.replyToId,
        },
        // Deleted once the send certainly did not go out and nobody will
        // send it again, rather than left in the public bucket forever
        // (see `deliver`, the Discard and the kept list).
        uploadPath: payload.path,
      });
    },
    [conversation, deliver]
  );

  const handleSendInteractive = useCallback(
    async (payload: InteractiveMessagePayload, replyToId?: string) => {
      if (!conversation) return;

      const tempId = nextTempId();
      // Optimistic bubble — renders the buttons/list immediately via the
      // interactive_payload, same as the persisted row will.
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: 'agent',
        content_type: 'interactive',
        content_text: payload.body,
        interactive_payload: payload,
        status: 'sending',
        created_at: new Date().toISOString(),
        reply_to_message_id: replyToId,
      };

      await deliver({
        message: optimisticMsg,
        body: {
          conversation_id: conversation.id,
          message_type: 'interactive',
          interactive_payload: payload,
          reply_to_message_id: replyToId,
        },
      });
    },
    [conversation, deliver]
  );

  const handleOpenTemplates = useCallback(() => {
    setTemplateModalOpen(true);
  }, []);

  const handleSendTemplate = useCallback(
    async (
      template: MessageTemplate,
      values: {
        body: string[];
        headerText?: string;
        buttonParams?: Record<number, string>;
      }
    ) => {
      if (!conversation) return;

      const renderedBody = renderTemplateBody(template.body_text, values.body);
      const tempId = nextTempId();

      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: 'agent',
        content_type: 'template',
        content_text: renderedBody,
        template_name: template.name,
        status: 'sending',
        created_at: new Date().toISOString(),
      };

      await deliver({
        message: optimisticMsg,
        body: {
          conversation_id: conversation.id,
          message_type: 'template',
          template_name: template.name,
          template_language: template.language,
          template_id: template.id,
          // Structured params drive the new send-builder path
          // (header media + URL button substitution). Body values
          // are mirrored under both shapes so the route can fall
          // back if the template row isn't found locally.
          template_message_params: {
            body: values.body,
            headerText: values.headerText,
            buttonParams: values.buttonParams,
          },
          template_params: values.body,
          content_text: renderedBody,
        },
      });
    },
    [conversation, deliver]
  );

  // Build a quick id → Message map so reply quotes can be rendered without
  // an extra fetch — the thread already holds the full conversation.
  const messagesById = useMemo(() => {
    const map = new Map<string, Message>();
    for (const m of messages) map.set(m.id, m);
    return map;
  }, [messages]);

  // Images + videos in the thread, in order — the set the media viewer
  // pages through with ← / →.
  const mediaGallery = useMemo(() => collectMediaGallery(messages), [messages]);

  // Bucket reactions by their target message_id for O(1) per-bubble lookup.
  const reactionsByMessageId = useMemo(() => {
    const map = new Map<string, MessageReaction[]>();
    for (const r of reactions) {
      const bucket = map.get(r.message_id);
      if (bucket) bucket.push(r);
      else map.set(r.message_id, [r]);
    }
    return map;
  }, [reactions]);

  const contactDisplayName = contact?.name || contact?.phone || 'Customer';

  // Who sent each message: the line on its bubble, the author of a quote
  // of it, the Forward preview and the media viewer's title. The user's
  // own name comes from their profile, so their bubbles never wait for
  // the member list.
  const senderNames = useMemo(
    () =>
      memberNames(
        user?.id && profile
          ? [
              {
                user_id: user.id,
                full_name: profile.full_name,
                email: profile.email,
              },
              ...profiles,
            ]
          : profiles
      ),
    [profiles, user?.id, profile]
  );
  const senderLabel = useSenderLabels({
    contactName: contactDisplayName,
    currentUserId: user?.id ?? null,
    names: senderNames,
    namesLoaded: profilesLoaded,
  });
  const authorLabelFor = useCallback(
    (m: Message): string => senderLabel(m).text,
    [senderLabel]
  );

  // Forward is a send, so it follows the composer's role gate (the
  // route re-checks it). Viewers see no button.
  const mayForward = !!accountRole && canSendMessages(accountRole);

  const handleStartReply = useCallback(
    (msg: Message) => {
      setReplyTo({
        id: msg.id,
        authorLabel: authorLabelFor(msg),
        preview: buildReplyPreview(msg, tQuote),
      });
      // The quote lives on the reply composer, hidden in Note mode:
      // show it rather than attach a forgotten quote to a later send.
      setComposerMode((m) => (m.mode === 'note' ? { ...m, mode: 'reply' } : m));
    },
    [authorLabelFor, tQuote]
  );

  // Single reaction-set primitive. emoji === "" removes; otherwise adds/swaps.
  // The "toggle" semantic (pill click) is computed at the call site where the
  // current reactions for the bubble are already in scope — keeps this
  // function dependency-free w.r.t. the reaction list.
  const postReaction = useCallback(
    async (messageId: string, emoji: string) => {
      if (!user?.id || !conversationId) {
        console.warn('[reactions] missing user or conversation');
        return;
      }
      if (messageId.startsWith('temp-')) {
        toast.error(t('reactionWait'));
        return;
      }

      const convId = conversationId;
      const userId = user.id;
      let before: MessageReaction | undefined;

      // Functional updater — captures the freshest reactions list, never a
      // stale closure. What this person had before is kept for rollback
      // on POST failure (lib/inbox/reaction-rollback.ts).
      setReactions((prev) => {
        const own = ownReaction(prev, messageId, userId);
        before = own;
        if (emoji === '') return own ? prev.filter((r) => r !== own) : prev;
        if (own) return prev.map((r) => (r === own ? { ...own, emoji } : r));
        return [
          ...prev,
          {
            id: nextTempId(),
            message_id: messageId,
            conversation_id: convId,
            actor_type: 'agent',
            actor_id: userId,
            emoji,
            created_at: new Date().toISOString(),
          },
        ];
      });

      try {
        const res = await fetch('/api/whatsapp/react', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message_id: messageId, emoji }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload?.error || `HTTP ${res.status}`);
        }
      } catch (err) {
        const reason =
          err instanceof Error ? err.message : t('reactionNetworkError');
        toast.error(t('reactionFailed', { reason }));
        setReactions((prev) =>
          rollbackReaction(
            prev,
            { conversationId: convId, messageId, userId, emoji, before },
            conversationIdRef.current
          )
        );
      }
    },
    // Keyed on the id, not the conversation object: every realtime patch
    // to the conversation replaces the object, and a new identity here
    // would re-render every memoised bubble.
    [conversationId, user?.id, t]
  );

  // Stable Forward opener for the memoised rows.
  const handleForward = useCallback(
    (message: Message) => {
      if (!conversationId) return;
      forwardSeqRef.current += 1;
      setForwarding({
        id: forwardSeqRef.current,
        conversationId,
        message,
        open: true,
      });
    },
    [conversationId]
  );

  // The chat's "sending number switched" notes (migration 061), placed
  // between the messages they happened between.
  const { events: threadEvents, reload: reloadThreadEvents } =
    useConversationEvents(conversationId ?? null);

  // The team's notes in this chat (migration 241), placed by time too,
  // and whether this person may write them (Reply / Note switch).
  const teamNotes = useConversationNotes(conversationId ?? null);
  const mayWriteNotes = !!accountRole && canWriteChatNotes(accountRole);
  const [composerMode, setComposerMode] = useState<ComposerModeState>({
    conversationId: null,
    mode: 'reply',
  });
  // Every chat opens on Reply, however it was opened. Stored while
  // rendering, so leaving a chat forgets its Note: kept beside the chat
  // it was for, it reopened with the note box focused and the customer's
  // answer was saved as a note.
  const openMode = composerModeFor(composerMode, conversationId ?? null);
  if (openMode !== composerMode) setComposerMode(openMode);
  // A recording or staged attachment in the reply composer: Note waits.
  const [composerBusy, setComposerBusy] = useState(false);
  const noteMode = mayWriteNotes && openMode.mode === 'note';

  // Grouping walks and date-formats every message; only redo it when the
  // messages or notes change, not on every header/dropdown re-render.
  const visibleMessages = useMemo(
    () =>
      hiddenTempIds.size === 0
        ? messages
        : messages.filter((m) => !hiddenTempIds.has(m.id)),
    [messages, hiddenTempIds]
  );
  const timelineGroups = useMemo(
    () =>
      buildTimelineGroups(
        visibleMessages,
        threadEvents,
        hasOlder,
        teamNotes.notes
      ),
    [visibleMessages, threadEvents, hasOlder, teamNotes.notes]
  );
  const failedHere = useMemo(
    () => failedSends.filter((f) => f.conversationId === conversationId),
    [failedSends, conversationId]
  );
  // A failed send's row (with its Retry) and the notes drawn between the
  // messages are no `messages`: someone at the end stays there.
  useLayoutEffect(() => {
    if (isNearBottom(bottomGapRef.current)) scrollToBottom();
  }, [
    failedHere.length,
    threadEvents.length,
    teamNotes.notes.length,
    scrollToBottom,
  ]);
  // The AI banner's evidence from the loaded page: whether the bot has
  // answered since its last warned outcome, and whether Resume should
  // also answer a waiting customer message.
  const lastAiReplyAt = useMemo(() => newestAiReplyAt(messages), [messages]);
  const lastMessageFromCustomer = useMemo(
    () => newestIsCustomer(messages),
    [messages]
  );
  const profileName = useCallback(
    (userId: string | null) =>
      (userId && profiles.find((p) => p.user_id === userId)?.full_name) || null,
    [profiles]
  );

  // The chat on screen, for an answer that lands after a switch.
  const openConversationIdRef = useRef<string | null>(null);
  useEffect(() => {
    openConversationIdRef.current = conversation?.id ?? null;
    return () => {
      openConversationIdRef.current = null;
    };
  }, [conversation?.id]);

  const handleAssignChange = useCallback(
    async (
      agentId: string | null,
      expected: string | null,
      askAgain: () => boolean,
      customer: string
    ) => {
      if (!conversation) return;
      const id = conversation.id;
      await assignFromScreen(
        createClient(),
        { conversationId: id, expected, userId: agentId },
        {
          patch: onAssignChange,
          // The question is about the chat it was asked on: once the
          // agent has opened another, say it did not happen instead.
          askAgain: () => openConversationIdRef.current === id && askAgain(),
          fail: (key) => toast.error(tRows(key, { customer })),
        }
      );
    },
    [conversation, onAssignChange, tRows]
  );

  // Empty state — WhatsApp's plain intro panel rather than the chat
  // wallpaper: the doodle belongs to an open chat.
  // Both branches below are rooted in the same <ThreadPresenceScope>, so
  // selecting a conversation keeps the one presence subscription rather
  // than tearing it down and re-reading the snapshot.
  if (!conversation || !contact) {
    return (
      <ThreadPresenceScope>
        <div className="bg-wa-panel-header border-b-wa-green flex flex-1 flex-col items-center justify-center border-b-4 px-6 text-center">
          <div className="bg-wa-panel flex h-20 w-20 items-center justify-center rounded-full">
            <MessageSquare className="text-wa-green h-9 w-9" />
          </div>
          <h2 className="text-wa-text mt-5 text-lg font-light">
            {t('selectConversation')}
          </h2>
          <p className="text-wa-text-secondary mt-1 text-sm">
            {t('selectConversationHint')}
          </p>
        </div>
      </ThreadPresenceScope>
    );
  }

  const displayName = contact.name || contact.phone;
  const view = threadView(threadLoad, conversation.id, {
    loading,
    hasContent:
      visibleMessages.length > 0 ||
      threadEvents.length > 0 ||
      failedHere.length > 0,
    unconfirmed: !fullConversation && !fullRowFailed,
  });
  // This chat's "N unread messages" divider, if it was opened unread.
  const unreadDivider =
    unreadMarker?.conversationId === conversation.id && unreadMarker.messageId
      ? { messageId: unreadMarker.messageId, count: unreadMarker.count }
      : null;
  const assignedAgentId = conversation.assigned_agent_id ?? null;

  // Who the Assign menu offers: admins everyone, anyone else themselves
  // plus the people they lead, never a deactivated member
  // (lib/inbox/assign.ts). Until the role loads, the narrow list.
  const assignableProfiles = assignableMembers({
    accountRole: profileLoading ? null : accountRole,
    myUserId: user?.id,
    profiles,
    leadableUserIds,
  });
  // Who to name in the header. `assigned_agent_id` is only filled in
  // when somebody actually pressed Assign, which on an inbound chat is
  // usually never — so the header used to read a bare "Assign" for most
  // threads even when an agent had been working them for days. The
  // resolver falls back to the last human who replied, then to the row
  // owner; `kind` is what the label leans on to stay honest about which
  // of those it found.
  const handler = resolveConversationHandler(
    conversation,
    // An older reply found by the lookup above counts as the earliest
    // evidence; anything in the loaded page is newer and wins.
    olderReplier?.conversationId === conversation.id && olderReplier.userId
      ? [{ sender_type: 'agent', sender_id: olderReplier.userId }, ...messages]
      : messages
  );
  const handlerProfile = handler
    ? profiles.find((p) => p.user_id === handler.userId)
    : undefined;
  const handlerName = handler
    ? (handlerProfile?.full_name?.trim() ||
        handlerProfile?.email ||
        t('unknownAgent')) + (handler.userId === user?.id ? t('me') : '')
    : null;
  // The pill: "Me" for this user, else the full name, which truncates —
  // the tooltip and the menu keep it whole. Not the first name alone:
  // two agents called Mohammed read the same.
  const handlerPillName = handler
    ? handler.userId === user?.id
      ? t('meShort')
      : handlerProfile?.full_name?.trim() ||
        handlerProfile?.email ||
        t('unknownAgent')
    : null;
  const handlerTitle =
    handler && handlerName
      ? handler.kind === 'assigned'
        ? t('handlerAssigned', { name: handlerName })
        : handler.kind === 'replying'
          ? t('handlerReplying', { name: handlerName })
          : t('handlerOwner', { name: handlerName })
      : t('handlerNobody');

  const assignedProfile = assignedAgentId
    ? profiles.find((p) => p.user_id === assignedAgentId)
    : undefined;
  const assignedAgentName = assignedAgentId
    ? (assignedProfile?.full_name?.trim() ||
        assignedProfile?.email ||
        t('unknownAgent')) + (assignedAgentId === user?.id ? t('me') : '')
    : null;

  const aiAttention = needsAttention(conversation);

  return (
    // `min-w-0` is load-bearing: the page already puts min-w-0 on the
    // thread's flex *wrapper* (issue #165), but this root keeps the
    // default `min-width: auto`, so a single wide message (long unbroken
    // URL/word) expands the whole thread past its flex share and the chat
    // paints on top of the contact sidebar at lg+ — outgoing bubbles get
    // clipped and the hover toolbar overlaps the Tags panel. Letting the
    // root shrink lets the bubbles' break-words / max-w caps apply.
    // Issue #257.
    <ThreadPresenceScope>
      <div className="wa-wallpaper @container/thread flex min-w-0 flex-1 flex-col">
        <ThreadHeader
          conversation={conversation}
          contact={contact}
          fullContact={fullConversation?.contact ?? null}
          displayName={displayName}
          onBack={onBack}
          onChannelSwitched={reloadThreadEvents}
          handler={handler}
          handlerPillName={handlerPillName}
          handlerTitle={handlerTitle}
          assignableProfiles={assignableProfiles}
          assignedAgentId={assignedAgentId}
          assignedAgentName={assignedAgentName}
          currentUserId={user?.id ?? null}
          onAssign={handleAssignChange}
          onChatTagsChange={onChatTagsChange}
          onRefresh={onRefresh ? handleRefreshClick : undefined}
          isRefreshing={isRefreshing}
          contactPanelOpen={contactPanelOpen}
          onToggleContactPanel={onToggleContactPanel}
          sharedBank={sharedBank}
          serviceWindowCountdown={windowCountdown}
        />

        {/* A chat the AI handed to a person (migration 078): its banner
          moves up here, with the red Important label, until someone
          acts — then it goes back above the composer. */}
        {/* Both AI banners wait for the full row: the held draft, the
          hand-off summary and the last outcome are not on the list row,
          and rendering on it would show "no draft" and then flip. */}
        {aiAttention && fullConversation && (
          <AiThreadBanner
            placement="top"
            conversation={fullConversation}
            lastAiReplyAt={lastAiReplyAt}
            lastMessageFromCustomer={lastMessageFromCustomer}
            currentUserId={user?.id}
            onChange={(patch) => onAiChange(conversation.id, patch)}
            memory={draftMemory}
            remember={rememberDraft}
          />
        )}

        {/* Messages Area. `data-inbox-scroll-root` lets the media bubbles
          root their lazy-load observers on this scroller. */}
        <div
          ref={scrollRef}
          data-inbox-scroll-root=""
          onScroll={handleThreadScroll}
          onLoadCapture={handleMediaLoaded}
          onLoadedMetadataCapture={handleMediaLoaded}
          className={cn('flex-1 overflow-y-auto pt-1 pb-3', THREAD_GUTTER)}
        >
          {view === 'loading' ? (
            <MessageSkeleton label={t('loadingMessages')} />
          ) : view === 'error' ? (
            <div className="flex justify-center py-12" role="alert">
              <div
                className={cn(
                  'bg-wa-date-chip flex max-w-sm flex-col items-center gap-2 rounded-lg px-4 py-3 text-center',
                  CHIP_SHADOW
                )}
              >
                <p className="text-wa-text text-sm">{t('loadFailed')}</p>
                <button
                  type="button"
                  onClick={resync}
                  className="border-border bg-card text-foreground hover:bg-muted rounded-md border px-3 py-1 text-xs font-medium"
                >
                  {t('loadRetry')}
                </button>
              </div>
            </div>
          ) : view === 'empty' ? (
            <div className="flex justify-center py-12">
              <div
                className={cn(
                  'bg-wa-date-chip max-w-sm rounded-lg px-4 py-2 text-center',
                  CHIP_SHADOW
                )}
              >
                <p className="text-wa-text text-sm">{t('noMessagesYet')}</p>
                <p className="text-wa-text-secondary text-xs">
                  {t('sendTemplateHint')}
                </p>
              </div>
            </div>
          ) : (
            <div>
              {hasOlder && (
                <div
                  ref={topSentinelRef}
                  className="flex h-6 items-center justify-center"
                  role="status"
                  aria-busy={loadingOlder}
                >
                  {!loadingOlder && olderFailedFor === conversation.id && (
                    <p className="text-wa-text-secondary text-xs">
                      {t('olderFailed')}{' '}
                      <button
                        type="button"
                        onClick={() => void loadOlder()}
                        className="text-wa-text underline underline-offset-2 hover:no-underline"
                      >
                        {t('loadRetry')}
                      </button>
                    </p>
                  )}
                  {loadingOlder && (
                    <div className="border-wa-green h-4 w-4 animate-spin rounded-full border-2 border-t-transparent" />
                  )}
                </div>
              )}
              {timelineGroups.map((group) => (
                <div key={group.date} className="pb-1">
                  {/* Date chip */}
                  <div className="flex justify-center pt-2 pb-1.5">
                    <span
                      className={cn(
                        'bg-wa-date-chip text-wa-date-chip-fg rounded-lg px-3 py-1 text-xs font-medium',
                        CHIP_SHADOW
                      )}
                    >
                      {formatDateSeparator(group.date, t)}
                    </span>
                  </div>
                  {group.items.map((item, index) => {
                    if (item.kind === 'note')
                      return (
                        <ThreadNote
                          key={`note-${item.note.id}`}
                          note={item.note}
                          authorName={profileName(item.note.author_id)}
                          isMine={!!user?.id && item.note.author_id === user.id}
                          canManage={mayWriteNotes}
                          nameOf={profileName}
                          onEdit={teamNotes.edit}
                          onDelete={teamNotes.remove}
                        />
                      );
                    if (item.kind === 'event') {
                      if (item.event.kind === 'chat_tag_auto')
                        return (
                          <ThreadAutoTagNote
                            key={`event-${item.event.id}`}
                            event={item.event}
                          />
                        );
                      if (
                        item.event.kind === 'insight_attention_set' ||
                        item.event.kind === 'insight_attention_cleared'
                      )
                        return (
                          <ThreadPinNote
                            key={`event-${item.event.id}`}
                            event={item.event}
                            actorName={profileName(item.event.actor_user_id)}
                            isMe={item.event.actor_user_id === user?.id}
                          />
                        );
                      // A kind this timeline does not know is never drawn.
                      if (item.event.kind !== 'channel_switched') return null;
                      return (
                        <ThreadChannelNote
                          key={`event-${item.event.id}`}
                          event={item.event}
                          actorName={profileName(item.event.actor_user_id)}
                          isMe={item.event.actor_user_id === user?.id}
                        />
                      );
                    }
                    const msg = item.message;
                    const unreadStartsHere =
                      !!unreadDivider && msg.id === unreadDivider.messageId;
                    return (
                      <Fragment key={msg.id}>
                        {unreadStartsHere && (
                          <div
                            role="separator"
                            className={cn(
                              'bg-wa-unread-band my-3 flex justify-center py-1.5',
                              THREAD_GUTTER_BLEED
                            )}
                          >
                            <span
                              className={cn(
                                'bg-wa-date-chip text-wa-teal rounded-full px-3 py-1 text-xs font-medium',
                                CHIP_SHADOW
                              )}
                            >
                              {t('unreadMessages', {
                                count: unreadDivider.count,
                              })}
                            </span>
                          </div>
                        )}
                        <ThreadMessageRow
                          message={msg}
                          runStart={
                            unreadStartsHere ||
                            startsMessageRun(group.items, index)
                          }
                          parent={
                            msg.reply_to_message_id
                              ? messagesById.get(msg.reply_to_message_id)
                              : undefined
                          }
                          parentMayBeOlder={hasOlder}
                          senderLabel={senderLabel}
                          reactions={reactionsByMessageId.get(msg.id)}
                          currentUserId={user?.id}
                          onReply={handleStartReply}
                          onForward={mayForward ? handleForward : undefined}
                          onSetReaction={postReaction}
                          onOpenMedia={handleMediaChange}
                          reminderSuggestion={
                            reminderChipsOn
                              ? suggestionsByMessageId.get(msg.id)
                              : undefined
                          }
                          onAddReminder={
                            reminderChipsOn ? handleAddReminder : undefined
                          }
                          onDismissReminder={
                            reminderChipsOn ? handleDismissReminder : undefined
                          }
                          reminderNowMs={
                            suggestionsByMessageId.has(msg.id)
                              ? suggestionsAt
                              : undefined
                          }
                        />
                      </Fragment>
                    );
                  })}
                </div>
              ))}
              {failedHere.length > 0 && (
                <div className="mt-3 space-y-2">
                  {failedHere.map((f) => (
                    <FailedSendRow
                      key={f.message.id}
                      failed={f}
                      parent={
                        f.message.reply_to_message_id
                          ? messagesById.get(f.message.reply_to_message_id)
                          : undefined
                      }
                      senderLabel={senderLabel}
                      onRetry={handleRetry}
                      onCopy={handleCopyFailed}
                      onDiscard={handleDiscard}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <NewMessagesButton
          count={
            !loading && below && below.conversationId === conversationId
              ? below.count
              : 0
          }
          onClick={scrollToBottom}
        />

        {/* What is shown may be behind: the last full read failed. */}
        {threadFailed && view === 'messages' && (
          <p
            role="status"
            className="bg-wa-panel text-muted-foreground px-4 py-1.5 text-xs"
          >
            {t('refreshFailed')}{' '}
            <button
              type="button"
              onClick={resync}
              className="text-foreground underline underline-offset-2 hover:no-underline"
            >
              {t('loadRetry')}
            </button>
          </p>
        )}

        {/* AI auto-reply banner (AI agent v2) — a held draft to send,
          edit or discard; why the bot is paused, with Resume; take over
          an active bot, and why it left the last message unanswered.
          Renders nothing unless the account has auto-reply configured. */}
        {!aiAttention && fullConversation && (
          <AiThreadBanner
            conversation={fullConversation}
            lastAiReplyAt={lastAiReplyAt}
            lastMessageFromCustomer={lastMessageFromCustomer}
            currentUserId={user?.id}
            onChange={(patch) => onAiChange(conversation.id, patch)}
            memory={draftMemory}
            remember={rememberDraft}
          />
        )}
        {/* The full row never arrived: the AI banner and the Call button
          cannot show, so say so once, quietly, with a Retry. */}
        {!fullConversation && fullRowFailed && onRetryFullRow && (
          <FullRowRetry
            onRetry={onRetryFullRow}
            className="bg-wa-panel px-4 py-1.5"
          />
        )}

        {/* The number this chat replies from has dropped. Agents kept
          writing replies into a logged-out number for three hours
          because only the admin screen said so, and none of those
          replies were saved. This warns and does not block: the status
          can lag behind the phone. */}
        {disconnectedNumber && (
          <div
            role="status"
            className="bg-wa-panel-header text-wa-warning border-warning/40 flex items-start gap-2 border-t px-3 py-2 text-xs sm:px-4"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {t(
                disconnectedNumber.provider === 'meta'
                  ? 'numberDisconnectedMeta'
                  : 'numberDisconnected',
                { name: channelDisplayName(disconnectedNumber) }
              )}
            </span>
          </div>
        )}

        {/* New-chat limits and unanswered runs (migration 068). Warns;
          the optional block is the server's. */}
        <OutreachBanner notices={guardNotices} />
        {showNewChatNotice && newChatNotice && (
          <NewChatNoticeCard
            notice={newChatNotice}
            conversationId={conversation.id}
            canSwitch={offerMarketingSwitch}
            onSwitched={() => void reloadThreadEvents()}
            className="border-info/30 border-t"
          />
        )}
        {(() => {
          const card = cardFor(blockedCards, conversation.id);
          return card ? (
            <BlockedSendCard
              key={conversation.id}
              restriction={card.restriction}
              state={card.state}
              onEvent={(event) => dispatchBlockedCard(conversation.id, event)}
              onDismiss={() => dismissBlockedCard(conversation.id)}
            />
          ) : null;
        })()}

        {/* Meta's 24-hour window has closed: only a template now. */}
        {serviceWindow?.kind === 'closed' &&
          !!accountRole &&
          canSendMessages(accountRole) && (
            <ServiceWindowBanner
              agoMs={serviceWindow.agoMs}
              onOpenTemplates={handleOpenTemplates}
            />
          )}

        {/* Reply / Note (migration 241). The reply composer stays
            mounted (hidden) in Note mode so its draft survives. */}
        {mayWriteNotes && (
          <div className="bg-wa-panel-header border-wa-divider border-t px-2 pt-1.5 sm:px-4">
            <ComposerModeSwitch
              mode={noteMode ? 'note' : 'reply'}
              onChange={(mode) =>
                setComposerMode({ conversationId: conversation.id, mode })
              }
              noteDisabled={composerBusy}
            />
          </div>
        )}
        {/* Kept mounted (hidden) in Reply mode, like the composer, so a
            half-written note survives a switch; keyed per login and
            chat (its text is parked per chat meanwhile). */}
        {mayWriteNotes && (
          <div
            className={cn(
              'bg-wa-panel-header shrink-0 px-2 pb-2 sm:px-4',
              !noteMode && 'hidden'
            )}
          >
            <NoteComposer
              key={`${viewerId ?? ''}:${conversation.id}`}
              conversationId={conversation.id}
              onSave={teamNotes.add}
              active={noteMode}
            />
          </div>
        )}

        {/* Composer */}
        <div className={cn('contents', noteMode && 'hidden')}>
          <MessageComposer
            conversationId={conversation.id}
            onSend={handleSend}
            onSendMedia={handleSendMedia}
            onSendInteractive={handleSendInteractive}
            onOpenTemplates={handleOpenTemplates}
            replyTo={replyTo}
            onClearReply={() => setReplyTo(null)}
            onRestoreReply={setReplyTo}
            contactName={contact.name || contact.phone || null}
            textControl={composerDraftRef}
            freeTextBlocked={freeTextBlocked}
            freeTextBlockedText={
              serviceWindow?.kind === 'closed'
                ? serviceWindowClosedText(tWindow, serviceWindow.agoMs)
                : null
            }
            onBusyChange={setComposerBusy}
          />
        </div>

        <ForwardDialog
          key={forwardDialogKey(forwarding, conversation.id)}
          message={forwardMessage(forwarding, conversation.id)}
          authorLabel={forwarding ? authorLabelFor(forwarding.message) : ''}
          sourceConversationId={conversation.id}
          onClose={() => {
            // This render's opening: a send may outlive it.
            const id = forwarding?.id;
            if (id !== undefined) setForwarding((f) => closeForward(f, id));
          }}
        />

        {/* A reminder suggestion being added: the header's dialog,
          prefilled. Saving files the task, then marks the suggestion
          added; if that mark fails the task still stands. */}
        {reminderChipsOn &&
          addingReminder?.conversationId === conversation.id && (
            <ReminderDialog
              key={addingReminder.chip.suggestionId}
              conversationId={conversation.id}
              contactId={contact.id}
              customerName={contactDisplayName}
              assignableProfiles={assignableProfiles}
              currentUserId={user?.id ?? null}
              initial={{
                what: tReminder(reminderTitleKey(addingReminder.chip.kind), {
                  name: contactDisplayName,
                }),
                dueAt: addingReminder.chip.dueAt,
                note: reminderNote(addingReminder.message.content_text ?? ''),
              }}
              onSaved={(taskId) => {
                const id = addingReminder.chip.suggestionId;
                void postReminderAction(id, { action: 'added', taskId }).then(
                  (outcome) => {
                    if (outcome === 'failed') toast.error(tReminder('failed'));
                  }
                );
              }}
              onClose={() => setAddingReminder(null)}
            />
          )}

        <TemplatePicker
          open={templateModalOpen}
          onOpenChange={setTemplateModalOpen}
          sendsFrom={
            conversation
              ? chatTemplateSendsFrom(
                  accountNumbers,
                  conversation,
                  lastCustomer
                )
              : 'unknown'
          }
          onSelect={handleSendTemplate}
        />

        {/* Full-size viewer for the thread's images/videos. Renders nothing
          until a bubble opens it. */}
        <MediaLightbox
          items={mediaGallery}
          activeId={mediaMessageId}
          onActiveIdChange={handleMediaChange}
          senderLabel={authorLabelFor}
        />
      </div>
    </ThreadPresenceScope>
  );
}
