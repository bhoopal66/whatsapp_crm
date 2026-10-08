'use client';

import {
  Fragment,
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useRef,
  useMemo,
} from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  MEMBERS_CACHE_KEY,
  REFERENCE_CACHE_TTL_MS,
  cachedQuery,
  invalidateCached,
  teamRosterCacheKey,
} from '@/lib/client-cache';
import { useAuth } from '@/hooks/use-auth';
import { useAccountNumbers } from '@/hooks/use-whatsapp-numbers';
import { useMyOutreach } from '@/hooks/use-my-outreach';
import {
  outreachNotices,
  wouldStartChat,
} from '@/lib/team-activity/thread-guard';
import { cn } from '@/lib/utils';
import type {
  Conversation,
  Message,
  MessageReaction,
  Contact,
  MessageTemplate,
  Profile,
  InteractiveMessagePayload,
} from '@/types';
import { MessageSquare, AlertTriangle } from 'lucide-react';
import { format, isToday, isYesterday } from 'date-fns';
import { useTranslations } from 'next-intl';
import { MediaLightbox } from './media-lightbox';
import { ThreadMessageRow } from './thread-message-row';
import { ThreadPresenceScope } from './thread-presence';
import { ThreadHeader } from './thread-header';
import type { ChatTagsPatch } from './thread-tag-bar';
import { collectMediaGallery } from '@/lib/media/gallery';
import {
  MessageComposer,
  CHAT_MEDIA_BUCKET,
  type ComposerDraftHandle,
  type SendMediaPayload,
} from './message-composer';
import { FailedSendRow } from './failed-send-row';
import { deleteAccountMedia } from '@/lib/storage/upload-media';
import { TemplatePicker } from './template-picker';
import { AiThreadBanner } from './ai-thread-banner';
import { OutreachBanner } from './outreach-banner';
import {
  ThreadChannelNote,
  useConversationEvents,
} from './thread-channel-switcher';
import { buildTimelineGroups, startsMessageRun } from '@/lib/inbox/timeline';
import { firstUnreadMessageId } from '@/lib/inbox/unread';
import {
  forgetKeptUpload,
  isRetryableSendFailure,
  partitionRestoredDrafts,
  rememberKeptUpload,
  retryAttempt,
  sendFailureReason,
  shouldWarnMaybeSent,
  supersededBy,
  takeKeptUploads,
  type FailedSend,
  type RestoredDraft,
  type SendAttempt,
} from '@/lib/inbox/failed-send';
import { predictSendingNumber } from '@/lib/inbox/sending-number';
import { channelDisplayName } from '@/lib/whatsapp/channel-management';
import { buildReplyPreview } from './reply-quote';
import { ForwardDialog } from './forward-dialog';
import { canSendMessages } from '@/lib/auth/roles';
import { renderTemplateBody } from '@/lib/whatsapp/template-body';
import { toast } from 'sonner';
import { canAssignToOthers } from '@/lib/auth/conversation-visibility';
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

interface ReplyDraft {
  id: string;
  authorLabel: string;
  preview: string;
}

interface MessageThreadProps {
  conversation: Conversation | null;
  contact: Contact | null;
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
  onChatTagsChange: (conversationId: string, patch: ChatTagsPatch) => void;
  onAssignChange: (
    conversationId: string,
    assignedAgentId: string | null
  ) => void;
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
  contact,
  messages,
  onMessagesLoaded,
  onNewMessage,
  onUpdateMessage,
  onChatTagsChange,
  onAssignChange,
  onBack,
  resyncToken = 0,
  deltaSyncToken = 0,
  onRefresh,
  contactPanelOpen,
  onToggleContactPanel,
}: MessageThreadProps) {
  const t = useTranslations('Inbox.messageThread');
  const tQuote = useTranslations('Inbox.replyQuote');
  const tFailedSend = useTranslations('Inbox.failedSend');

  const { user, profileLoading, accountRole } = useAuth();
  const [loading, setLoading] = useState(false);
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
  const loadingOlderRef = useRef(false);
  // Bumped per older page so the top sentinel re-observes (see below).
  const [olderPageCount, setOlderPageCount] = useState(0);
  // Scroll geometry captured just before an older page is prepended, so
  // the layout effect can keep the same message under the reader's eye
  // instead of jumping to the bottom.
  const prependAnchorRef = useRef<{ height: number; top: number } | null>(null);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
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
  const [forwarding, setForwarding] = useState<{
    conversationId: string;
    message: Message;
  } | null>(null);
  // Which attachment the media viewer is showing. Lives here rather than in
  // the bubble so the viewer can page through every image/video in the
  // thread (issue #373). Paired with the conversation it belongs to and read
  // back through that check below, so switching threads closes the viewer
  // without an effect racing the messages refetch.
  const [openMedia, setOpenMedia] = useState<{
    conversationId: string;
    messageId: string;
  } | null>(null);

  // Replies that certainly did not go out, kept for every chat opened
  // since the inbox loaded, so switching away and back does not lose
  // them. They live only in the browser (lib/inbox/failed-send.ts).
  const [failedSends, setFailedSends] = useState<FailedSend[]>([]);
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
  // Failed texts this thread put back into the composer, so a chat
  // switch can take them back out (see the layout effect below).
  const restoredDraftsRef = useRef<RestoredDraft[]>([]);

  // A media send that failed for certain keeps its upload for a Retry.
  // Once nobody can send it, it is deleted: on Discard, when the inbox
  // unmounts, and when a failure lands after that. React runs no
  // cleanup when the page unloads, so a reload is covered by the tab's
  // kept list instead: this mount deletes what the last page left on it.
  const failedSendsRef = useRef(failedSends);
  const mountedRef = useRef(false);
  useEffect(() => {
    failedSendsRef.current = failedSends;
  });
  useEffect(() => {
    mountedRef.current = true;
    for (const path of takeKeptUploads(tabStorage())) deleteKeptUpload(path);
    return () => {
      mountedRef.current = false;
      for (const f of failedSendsRef.current) {
        if (f.uploadPath) deleteKeptUpload(f.uploadPath);
      }
    };
  }, []);

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
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const data = await cachedQuery(
        MEMBERS_CACHE_KEY,
        REFERENCE_CACHE_TTL_MS,
        async () => {
          const supabase = createClient();
          const { data, error } = await supabase
            .from('profiles')
            .select('*')
            .order('full_name');
          if (error) {
            console.error('Failed to fetch profiles:', error);
            return [] as Profile[];
          }
          return (data as Profile[] | null) ?? [];
        }
      ).catch(() => [] as Profile[]);
      if (!cancelled) setProfiles(data);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  // There is no 24-hour session window any more.
  //
  // That rule was Meta's: a business could only send free-form text
  // within 24h of the customer's last message, and had to re-open the
  // conversation with a pre-approved template otherwise. This app now
  // talks to WhatsApp through Whapi, which drives a normal WhatsApp Web
  // account — no window, no template registry, no approval step. The
  // timer that used to live here therefore measured nothing, and its
  // `expired` flag disabled the composer on precisely the threads that
  // needed it most: a brand-new conversation has no customer message
  // yet, so it counted as expired and there was no way to send the
  // first one. Templates are still available from the composer toolbar
  // as saved canned replies.

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
  const hasUnread = (conversation?.unread_count ?? 0) > 0;
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

  // The composer is shared by every chat and keeps its text across a
  // switch. A draft restored after a failure belongs to its own chat:
  // left there, one Enter sends one customer's words to the next. Take
  // it back when another chat opens, before the frame is painted. The
  // failed row still holds the words, and anything the agent typed
  // since stays.
  useLayoutEffect(() => {
    // Here too, not only in the passive effect above: when the switch
    // does not come from a click (a deep link, a notification), passive
    // effects run a task later, and a failure landing in that gap would
    // restore the old chat's text after this withdrawal already ran.
    conversationIdRef.current = conversationId;
    const { withdraw, keep } = partitionRestoredDrafts(
      restoredDraftsRef.current,
      conversationId ?? null
    );
    if (withdraw.length === 0) return;
    restoredDraftsRef.current = keep;
    for (const d of withdraw) composerDraftRef.current?.clearIf(d.text);
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
  // a Whapi number — today's new-chat limit, a contact who stopped
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
    outreachStartingRef.current = wouldStartChat(messages, outreachNow);
  }, [messages, outreachNow]);
  const guardNotices = useMemo(() => {
    if (!accountNumbers || !conversationId || !accountRole || accountRole === 'viewer') {
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
      provider: n?.provider === 'whapi' || n?.provider === 'meta' ? n.provider : null,
      now: outreachNow,
    });
  }, [
    accountNumbers,
    conversationId,
    accountRole,
    threadChannelId,
    threadPin,
    messages,
    myOutreach,
    outreachNow,
  ]);

  // Fetch the latest page whenever the selected conversation changes.
  // Kept separate from the unread-reset effect so that incoming messages
  // arriving while the thread is open don't trigger a full refetch —
  // they only flip hasUnread, which only the reset effect listens to.
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

    (async () => {
      setLoading(true);

      const { data, error } = await messagesPageQuery(conversationId);

      if (cancelled) return;

      if (error) {
        console.error('Failed to fetch messages:', error);
      } else {
        const { messages: pageDesc, reactions: pageReactions } =
          splitEmbeddedReactions((data ?? []) as MessageWithReactions[]);
        const page = toChronological(pageDesc);
        setOlderState({
          conversationId,
          hasOlder: pageDesc.length >= MESSAGE_PAGE_SIZE,
        });
        setReactions(pageReactions);
        // Once per chat opened: a manual refresh of the same chat keeps
        // the divider where the agent first saw it.
        setUnreadMarker((prev) =>
          !opened && prev?.conversationId === conversationId
            ? prev
            : {
                conversationId,
                count: unreadAtOpen,
                messageId: firstUnreadMessageId(page, unreadAtOpen),
              }
        );
        onMessagesLoadedRef.current(page);
      }

      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a full reload
    // (the manual refresh button).
  }, [conversationId, resyncToken]);

  // Delta resync: re-read the latest page and merge it in, keeping the
  // older pages the user scrolled back through and not flashing the
  // spinner. Keyed on the token alone; the ref remembers which one was
  // handled so a remount-free re-render never re-sends it.
  const handledDeltaTokenRef = useRef(deltaSyncToken);
  useEffect(() => {
    if (deltaSyncToken === handledDeltaTokenRef.current) return;
    handledDeltaTokenRef.current = deltaSyncToken;
    const convId = conversationIdRef.current;
    if (!convId) return;

    (async () => {
      const { data, error } = await messagesPageQuery(convId);
      if (conversationIdRef.current !== convId) return;
      if (error) {
        console.error('Failed to resync messages:', error);
        return;
      }
      const { messages: pageDesc, reactions: pageReactions } =
        splitEmbeddedReactions((data ?? []) as MessageWithReactions[]);
      const page = toChronological(pageDesc);
      // More arrived than one page: the merge replaces the thread with
      // the page, so there is history above it again.
      if (mergeLatestMessages(messagesRef.current, page).gap) {
        setOlderState({ conversationId: convId, hasOlder: true });
      }
      onMessagesLoadedRef.current(
        (prev) => mergeLatestMessages(prev, page).messages
      );
      setReactions((prev) =>
        replaceReactionsFor(
          prev,
          page.map((m) => m.id),
          pageReactions
        )
      );
    })();
  }, [deltaSyncToken]);

  // Pull the page before the oldest message held.
  const loadOlder = useCallback(async () => {
    const convId = conversationIdRef.current;
    if (!convId || loadingOlderRef.current) return;
    const oldest = oldestPersisted(messagesRef.current);
    if (!oldest) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
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

  // Reactions realtime subscription per conversation. Subscribing here
  // (not at the page level) keeps the channel scoped to the visible
  // conversation and avoids cross-conversation chatter on a busy inbox.
  useEffect(() => {
    if (!conversationId) return;
    const supabase = createClient();

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
          setReactions((prev) => prev.filter((r) => r.id !== old.id));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversationId]);

  // Clear any in-progress reply draft when the active conversation changes —
  // a quote pulled from conversation A shouldn't bleed into conversation B.
  useEffect(() => {
    setReplyTo(null);
  }, [conversationId]);

  // Reset the server-side unread_count to 0 whenever an unread count
  // surfaces on the active conversation — covers both (a) opening a
  // conversation that had unread messages and (b) new messages arriving
  // while the user is already viewing the thread (webhook server-bumps
  // unread_count to N+1; the realtime UPDATE propagates it into the
  // client, which re-runs this effect and flips it back to 0).
  //
  // Guarding on hasUnread prevents the eq-update loop: once unread_count
  // is 0 the condition is false, so no further UPDATE is issued.
  useEffect(() => {
    if (!conversationId || !hasUnread) return;
    const supabase = createClient();
    supabase
      .from('conversations')
      .update({ unread_count: 0 })
      .eq('id', conversationId)
      .then(({ error }) => {
        if (error) console.error('Failed to reset unread_count:', error);
      });
  }, [conversationId, hasUnread]);

  // Auto-scroll to bottom on new messages — except when the change was
  // an older page prepended above, where the reader's position is kept
  // instead. A layout effect so the jump lands before paint (no flash of
  // the wrong scroll offset) and before the top sentinel's observer is
  // (re)created in the effect below.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const anchor = prependAnchorRef.current;
    if (anchor) {
      prependAnchorRef.current = null;
      el.scrollTop = el.scrollHeight - anchor.height + anchor.top;
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [messages]);

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
      const toastPrefix =
        message.content_type === 'template'
          ? 'Failed to send template'
          : 'Failed to send';
      const startsChat = outreachStartingRef.current;

      // Optimistic update — shows the message immediately with "sending" status
      onNewMessage(message);

      let res: Response;
      let payload: unknown;
      try {
        res = await fetch('/api/whatsapp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(attempt.body),
        });
        payload = await res.json().catch(() => null);
      } catch (err) {
        // No answer at all: the send may still have gone out, so there
        // is no Retry. It could reach the customer twice. The upload is
        // kept too, since a delivered message may link to it.
        console.error(`Failed to send ${message.content_type}:`, err);
        const reason = err instanceof Error ? err.message : 'network error';
        toast.error(`${toastPrefix}: ${reason}`, {
          description: tFailedSend('maybeSent'),
        });
        onUpdateMessage(message.id, { status: 'failed' });
        return;
      }

      if (res.ok) {
        // Success — the realtime INSERT event will replace the temp bubble
        // with the real DB row. If realtime hasn't arrived yet, at least
        // flip status to 'sent' so the UI stops showing "sending".
        onUpdateMessage(message.id, { status: 'sent' });
        // It started a chat: today's counts moved.
        if (startsChat) setOutreachRefresh((k) => k + 1);
        return;
      }

      const reason = sendFailureReason(res.status, payload);
      console.error(`Failed to send ${message.content_type}:`, reason);
      toast.error(
        `${toastPrefix}: ${reason}`,
        shouldWarnMaybeSent(res.status, payload)
          ? { description: tFailedSend('maybeSent') }
          : undefined
      );
      // Mark the optimistic bubble as failed so the user sees what happened
      onUpdateMessage(message.id, { status: 'failed' });
      // The usual cause is a dropped number. Re-read the numbers now
      // rather than a minute from now, so the warning shows.
      invalidateCached('whatsapp-channels:');
      setNumbersRefresh((n) => n + 1);

      if (!isRetryableSendFailure(res.status, payload)) {
        // It may have gone out: a timeout, a gateway 5xx, a proxy page,
        // or db_error, where it certainly did. So there is no Retry, the
        // text does not go back into the composer, and the upload is
        // kept. On Meta the gateway fetches the link after it answers,
        // and a leaked file costs less than a broken attachment.
        return;
      }

      if (!mountedRef.current) {
        // It certainly did not go out, but the inbox is gone and nobody
        // can Retry it, so its upload is garbage now.
        if (attempt.uploadPath) deleteKeptUpload(attempt.uploadPath);
        return;
      }

      const conversationId = message.conversation_id;
      setHiddenTempIds((prev) => new Set(prev).add(message.id));
      setFailedSends((prev) => [
        ...prev,
        {
          ...attempt,
          message: { ...message, status: 'failed' },
          conversationId,
          reason,
        },
      ]);
      if (attempt.uploadPath) {
        rememberKeptUpload(tabStorage(), attempt.uploadPath);
      }
      // The send cleared the composer, and the words are saved nowhere.
      // Give them back, but only in the chat they were written for: the
      // composer is shared by every chat, and the agent may have moved on.
      if (attempt.restoreText && conversationIdRef.current === conversationId) {
        composerDraftRef.current?.restore(attempt.restoreText);
        restoredDraftsRef.current.push({
          conversationId,
          text: attempt.restoreText,
        });
      }
    },
    [onNewMessage, onUpdateMessage, tFailedSend]
  );

  const handleRetry = useCallback(
    (failed: FailedSend) => {
      if (retriedRef.current.has(failed)) return;
      retriedRef.current.add(failed);
      setFailedSends((prev) => prev.filter((f) => f !== failed));
      // The restored draft is what this sends. Left in the composer, it
      // would be one Enter away from going out twice.
      if (failed.restoreText) {
        composerDraftRef.current?.clearIf(failed.restoreText);
      }
      // Off the kept list before it goes out: a reload while the retry
      // is in flight must not sweep an upload it may be delivering. A
      // definite failure lists it again.
      if (failed.uploadPath) forgetKeptUpload(tabStorage(), failed.uploadPath);
      void deliver(retryAttempt(failed, `temp-${Date.now()}`));
    },
    [deliver]
  );

  const handleDiscard = useCallback((failed: FailedSend) => {
    if (retriedRef.current.has(failed)) return;
    retriedRef.current.add(failed);
    setFailedSends((prev) => prev.filter((f) => f !== failed));
    // It never went out, and now nobody will send it.
    if (failed.uploadPath) deleteKeptUpload(failed.uploadPath);
  }, []);

  const handleSend = useCallback(
    async (text: string, replyToId?: string) => {
      if (!conversation) return;

      // The same words sent again (usually the restored draft) replace
      // a failed attempt. Its Retry would send them a second time.
      const convId = conversation.id;
      setFailedSends((prev) => {
        const stale = supersededBy(prev, convId, text);
        return stale.length ? prev.filter((f) => !stale.includes(f)) : prev;
      });

      const tempId = `temp-${Date.now()}`;
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
        },
        restoreText: text,
      });
    },
    [conversation, deliver]
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

      const tempId = `temp-${Date.now()}`;
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
      setReplyTo(null);

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

      const tempId = `temp-${Date.now()}`;
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
      const tempId = `temp-${Date.now()}`;

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

  // Author label for a quoted message: "You" when we sent the parent,
  // contact name when the customer sent it.
  const authorLabelFor = useCallback(
    (m: Message): string => {
      const isAgentMsg = m.sender_type === 'agent' || m.sender_type === 'bot';
      return isAgentMsg ? 'You' : contactDisplayName;
    },
    [contactDisplayName]
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
        toast.error('Wait for the message to finish sending');
        return;
      }

      const convId = conversationId;
      const userId = user.id;
      let snapshot: MessageReaction[] = [];

      // Functional updater — captures the freshest reactions list, never a
      // stale closure. Snapshot stored for rollback on POST failure.
      setReactions((prev) => {
        snapshot = prev;
        const own = prev.find(
          (r) =>
            r.message_id === messageId &&
            r.actor_type === 'agent' &&
            r.actor_id === userId
        );
        if (emoji === '') return own ? prev.filter((r) => r !== own) : prev;
        if (own) return prev.map((r) => (r === own ? { ...own, emoji } : r));
        return [
          ...prev,
          {
            id: `temp-${Date.now()}`,
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
        const reason = err instanceof Error ? err.message : 'network error';
        toast.error(`Reaction failed: ${reason}`);
        setReactions(snapshot);
      }
    },
    // Keyed on the id, not the conversation object: every realtime patch
    // to the conversation replaces the object, and a new identity here
    // would re-render every memoised bubble.
    [conversationId, user?.id]
  );

  // Stable Forward opener for the memoised rows.
  const handleForward = useCallback(
    (message: Message) => {
      if (!conversationId) return;
      setForwarding({ conversationId, message });
    },
    [conversationId]
  );

  // The chat's "sending number switched" notes (migration 061), placed
  // between the messages they happened between.
  const { events: threadEvents, reload: reloadThreadEvents } =
    useConversationEvents(conversationId ?? null);

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
    () => buildTimelineGroups(visibleMessages, threadEvents, hasOlder),
    [visibleMessages, threadEvents, hasOlder]
  );
  const failedHere = useMemo(
    () => failedSends.filter((f) => f.conversationId === conversationId),
    [failedSends, conversationId]
  );
  const profileName = useCallback(
    (userId: string | null) =>
      (userId && profiles.find((p) => p.user_id === userId)?.full_name) || null,
    [profiles]
  );

  const handleAssignChange = useCallback(
    async (agentId: string | null) => {
      if (!conversation) return;

      const supabase = createClient();
      const { error } = await supabase
        .from('conversations')
        .update({ assigned_agent_id: agentId })
        .eq('id', conversation.id);

      if (error) {
        console.error('Failed to update assignment:', error);
        toast.error('Failed to update assignment');
        return;
      }

      onAssignChange(conversation.id, agentId);
    },
    [conversation, onAssignChange]
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
          <h3 className="text-wa-text mt-5 text-lg font-light">
            {t('selectConversation')}
          </h3>
          <p className="text-wa-text-secondary mt-1 text-sm">
            {t('selectConversationHint')}
          </p>
        </div>
      </ThreadPresenceScope>
    );
  }

  const displayName = contact.name || contact.phone;
  // This chat's "N unread messages" divider, if it was opened unread.
  const unreadDivider =
    unreadMarker?.conversationId === conversation.id && unreadMarker.messageId
      ? { messageId: unreadMarker.messageId, count: unreadMarker.count }
      : null;
  const quoteContactLabel = contact.name || contact.phone || 'Unknown';
  const assignedAgentId = conversation.assigned_agent_id ?? null;

  // Handing a conversation to someone ELSE is an admin power — it
  // decides who can see the chat at all now that visibility follows
  // ownership (migration 042). A non-admin gets only themselves in the
  // list, which keeps the "take this one" path working (and matches
  // what the database will actually accept: the assignment trigger
  // rejects anything else).
  const canAssignOthers = canAssignToOthers(
    profileLoading ? null : accountRole
  );
  // A team leader assigns within their own team. The database has the
  // final say (the assignment trigger, migration 044) — this only
  // decides who is worth offering, so the dropdown never lists someone
  // the save would bounce. Deactivated members (migration 069) can't
  // sign in to work a chat, so they are never offered.
  const assignableProfiles = (
    canAssignOthers
      ? profiles
      : profiles.filter(
          (p) => p.user_id === user?.id || leadableUserIds.has(p.user_id)
        )
  ).filter((p) => !p.deactivated_at);
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
  const handlerTitle =
    handler && handlerName
      ? handler.kind === 'assigned'
        ? t('handlerAssigned', { name: handlerName })
        : handler.kind === 'replying'
          ? t('handlerReplying', { name: handlerName })
          : t('handlerOwner', { name: handlerName })
      : t('handlerNobody');

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
          displayName={displayName}
          onBack={onBack}
          onChannelSwitched={reloadThreadEvents}
          handler={handler}
          handlerName={handlerName}
          handlerTitle={handlerTitle}
          assignableProfiles={assignableProfiles}
          assignedAgentId={assignedAgentId}
          currentUserId={user?.id ?? null}
          onAssign={handleAssignChange}
          onChatTagsChange={onChatTagsChange}
          onRefresh={onRefresh ? handleRefreshClick : undefined}
          isRefreshing={isRefreshing}
          contactPanelOpen={contactPanelOpen}
          onToggleContactPanel={onToggleContactPanel}
        />

        {/* Messages Area. `data-inbox-scroll-root` lets the media bubbles
          root their lazy-load observers on this scroller. */}
        <div
          ref={scrollRef}
          data-inbox-scroll-root=""
          className={cn('flex-1 overflow-y-auto pt-1 pb-3', THREAD_GUTTER)}
        >
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="border-wa-green h-5 w-5 animate-spin rounded-full border-2 border-t-transparent" />
            </div>
          ) : visibleMessages.length === 0 &&
            threadEvents.length === 0 &&
            failedHere.length === 0 ? (
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
                    if (item.kind === 'event') {
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
                          contactLabel={quoteContactLabel}
                          reactions={reactionsByMessageId.get(msg.id)}
                          currentUserId={user?.id}
                          onReply={handleStartReply}
                          onForward={mayForward ? handleForward : undefined}
                          onSetReaction={postReaction}
                          onOpenMedia={handleMediaChange}
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
                      contactLabel={quoteContactLabel}
                      onRetry={handleRetry}
                      onDiscard={handleDiscard}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* AI auto-reply banner — take over an active bot, or resume it
          after a handoff. Renders nothing unless the account has
          auto-reply configured. */}
        <AiThreadBanner
          conversationId={conversation.id}
          disabled={conversation.ai_autoreply_disabled ?? false}
          handoffSummary={conversation.ai_handoff_summary}
          assignedAgentId={assignedAgentId}
          currentUserId={user?.id}
          onChange={(patch) => {
            if ('assigned_agent_id' in patch) {
              onAssignChange(conversation.id, patch.assigned_agent_id ?? null);
            }
          }}
        />

        {/* The number this chat replies from has dropped. Agents kept
          writing replies into a logged-out number for three hours
          because only the admin screen said so, and none of those
          replies were saved. This warns and does not block: the status
          can lag behind the phone. */}
        {disconnectedNumber && (
          <div
            role="status"
            className="bg-wa-panel-header text-wa-warning flex items-start gap-2 border-t border-amber-500/40 px-3 py-2 text-xs sm:px-4"
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

        {/* Composer */}
        <MessageComposer
          conversationId={conversation.id}
          onSend={handleSend}
          onSendMedia={handleSendMedia}
          onSendInteractive={handleSendInteractive}
          onOpenTemplates={handleOpenTemplates}
          replyTo={replyTo}
          onClearReply={() => setReplyTo(null)}
          textControl={composerDraftRef}
        />

        <ForwardDialog
          message={
            forwarding?.conversationId === conversation.id
              ? forwarding.message
              : null
          }
          authorLabel={forwarding ? authorLabelFor(forwarding.message) : ''}
          sourceConversationId={conversation.id}
          onClose={() => setForwarding(null)}
        />

        <TemplatePicker
          open={templateModalOpen}
          onOpenChange={setTemplateModalOpen}
          onSelect={handleSendTemplate}
        />

        {/* Full-size viewer for the thread's images/videos. Renders nothing
          until a bubble opens it. */}
        <MediaLightbox
          items={mediaGallery}
          activeId={mediaMessageId}
          onActiveIdChange={handleMediaChange}
          contactLabel={contactDisplayName}
        />
      </div>
    </ThreadPresenceScope>
  );
}
