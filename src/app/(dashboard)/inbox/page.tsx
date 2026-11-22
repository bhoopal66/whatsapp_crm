'use client';

import {
  Suspense,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import { cachedQuery } from '@/lib/client-cache';
import {
  CONVERSATION_SELECT,
  normalizeConversation,
  type ConversationListItem,
} from '@/lib/inbox/conversations';
import {
  appendConversationPage,
  deltaWatermark,
  isWithinLoadedWindow,
  mergeConversationDelta,
  type ConversationCursor,
} from '@/lib/inbox/pagination';
import { applyAvatars, avatarRequestBatches } from '@/lib/inbox/avatars';
import {
  applyActiveAvatars,
  applyFullRow,
  openConversation,
  patchActiveChat,
  rereadFullRow,
  type ActiveChat,
  type OpenConversationDeps,
  type OpenTicket,
} from '@/lib/inbox/open-conversation';
import type { ConversationListLoad } from '@/components/inbox/conversation-list';
import type { Conversation, Message } from '@/types';
import type { ChatTagRowPatch } from '@/components/inbox/thread-tag-bar';
import { useRealtime } from '@/hooks/use-realtime';
import { ConversationList } from '@/components/inbox/conversation-list';
import { parseInboxFilterParams } from '@/lib/inbox/filter-params';
import { HrListHeader, HrListTitle } from '@/components/hr/hr-list-header';
import type { HrInboxRoute } from '@/lib/hr/routes';
import {
  hrInboxUrl,
  parseHrListParams,
  writeHrListParams,
  type HrListFilters,
} from '@/lib/hr/list-filters';
import { MessageThread } from '@/components/inbox/message-thread';
import type { AiBannerPatch } from '@/components/inbox/ai-thread-banner';
import { needsAttention } from '@/lib/inbox/attention';
import {
  admitsInsertedConversation,
  inPersonalInbox,
  shouldFetchUnloadedPin,
} from '@/lib/inbox/insights';
import type { InboxNarrowing } from '@/lib/inbox/unread-counts';
import {
  viewerInboxDepartment,
  type DepartmentView,
  type InboxDepartment,
} from '@/lib/inbox/departments';
import { useInsightSettings } from '@/hooks/use-insight-settings';
import { ContactSidebar } from '@/components/inbox/contact-sidebar';
import { FullRowRetry } from '@/components/inbox/full-row-retry';
import { BroadcastsTabs } from '@/components/broadcasts/broadcasts-tabs';
import { toast } from 'sonner';
import { WifiOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import {
  applyMessageEventToPage,
  messagesCacheKey,
  type CachedMessagePage,
} from '@/lib/inbox/message-cache';
import { sessionCache } from '@/lib/session-cache';
import {
  forgetFailedChat,
  panelPartKey,
  panelRowKey,
  panelSource,
} from '@/lib/inbox/contact-panel';
import { prefetchContactPanel } from '@/lib/inbox/contact-panel-fetch';
import { warmAiAccountStatus } from '@/lib/inbox/ai-account-status';
import { viewsOthersConversations } from '@/lib/auth/conversation-visibility';
import { channelDisplayName } from '@/lib/whatsapp/channel-management';
import {
  useAccountNumbers,
  useMyNumberIds,
} from '@/hooks/use-whatsapp-numbers';
import { useAiAutoReplyLive } from '@/hooks/use-ai-auto-reply-live';
import { useMyCoordinatorShares } from '@/hooks/use-my-coordinator-shares';

// Remembers the agent's show/hide choice for the desktop contact panel
// across reloads and sessions (device-scoped, like the theme prefs).
const CONTACT_PANEL_STORAGE_KEY = 'taamul:inbox:contact-panel-open';
/** Pre-rebrand key, read-only so a returning browser keeps its choice. */
const LEGACY_CONTACT_PANEL_STORAGE_KEY = 'wacrm:inbox:contact-panel-open';

/**
 * How long the tab must have been hidden before coming back resyncs.
 * An alt-tab and back is not worth a round trip — realtime is still
 * connected and nothing was missed; the resync is for the laptop that
 * slept or the background tab the browser throttled.
 */
const RESYNC_AFTER_HIDDEN_MS = 30_000;

/** Lets a page of conversations (and its realtime churn) settle first. */
const AVATAR_REQUEST_DEBOUNCE_MS = 500;

// `useSearchParams` (the `?c=<id>` deep link below) requires a Suspense
// boundary or the production build bails to CSR and errors out. Thin
// wrapper supplies it; the inner component holds all the inbox state.
export default function InboxPage() {
  return (
    <Suspense fallback={null}>
      <InboxPageInner />
    </Suspense>
  );
}

/**
 * Shared by /inbox and /team-inbox.
 *
 * `teamView` is the only difference between them. A team leader can
 * see their whole team's conversations (migration 044), which would
 * make their personal inbox indistinguishable from the team one — so
 * /inbox narrows back to "mine" for them, and /team-inbox shows
 * everything RLS allows. Admins are left alone: their inbox has always
 * been the account-wide triage view and still is.
 *
 * `departmentView` (the /hr/* inboxes, owners, admins and HR teams)
 * lists one department's chats (migration 192) the way the Team inbox
 * lists everything; the other views leave department chats out except
 * the viewer's own. `hrInbox` fixes the HR view's tab to the route's
 * inbox (/hr/recruiter, /hr/department, /hr/unsorted): the URL's
 * `hrTab` is ignored and never written, the other HR filters still are.
 */
export function InboxPageInner({
  teamView = false,
  campaignView = false,
  departmentView,
  hrInbox,
}: {
  teamView?: boolean;
  campaignView?: boolean;
  departmentView?: InboxDepartment;
  hrInbox?: HrInboxRoute;
} = {}) {
  const t = useTranslations('Inbox.page');
  const {
    user,
    accountId,
    accountRole,
    profileLoading,
    department,
    salesRestricted,
  } = useAuth();

  // Narrow the personal inbox to this user's own threads when they can
  // see more than their own — which today means a team leader. `null`
  // means "no extra filter", leaving RLS to decide, which is what both
  // the team view and an admin's inbox want.
  const wideView = teamView || !!departmentView;
  const personalOnlyUserId =
    !wideView && accountRole === 'team_leader' ? (user?.id ?? null) : null;

  // Whether this list mixes other people's chats. When it does, each row
  // names whoever holds it and the list offers a by-agent filter —
  // without that an admin's inbox is a wall of customer names with no
  // way to tell, or ask, who is dealing with any of them.
  //
  // Several numbers on the account earn each row a label saying which
  // number the customer is writing to. (Allocation to a number grants
  // no visibility since migration 072, so it no longer mixes owners.)
  //
  // Not on the Campaign inbox: it holds only chats nobody has stepped
  // into yet (migration 067), so every row would carry the amber
  // "unassigned" mark and the by-agent filter would have nothing to
  // split.
  const myNumberIds = useMyNumberIds();
  const accountNumbers = useAccountNumbers();
  const showAssignee =
    !campaignView && viewsOthersConversations(accountRole, wideView);
  const numberNames = useMemo(() => {
    if (!accountNumbers || accountNumbers.length < 2) return null;
    return new Map(accountNumbers.map((n) => [n.id, channelDisplayName(n)]));
  }, [accountNumbers]);
  // The Campaign inbox under Broadcasts lists the campaign chats
  // (migration 048) the bot is answering, with a per-campaign filter;
  // this Inbox lists every other chat, so each chat is in exactly one
  // (migration 067, `inCampaignInbox`). Mounted under the admin-only
  // Broadcasts layout. Which list a chat belongs in starts with whether
  // the AI auto-reply is on at all, so both wait for that answer — it
  // is asked from the session, alongside the profile, not after it.
  const campaignOnly = campaignView;
  const aiLive = useAiAutoReplyLive();
  // Which of the two inbox routes we are mounted on. Selecting a thread
  // writes `?c=<id>` back to the URL, and that write has to stay on the
  // CURRENT route: hardcoding "/inbox" navigated a team leader off
  // /team-inbox the moment they opened one of their team's chats, and
  // the personal inbox then filtered that very conversation out of the
  // list — so the thread they clicked never opened.
  const basePath = usePathname();
  const searchParams = useSearchParams();
  /**
   * `?c=<id>` deep-link support. Used when landing here from the
   * dashboard's recent-conversations list so the right thread opens
   * automatically instead of showing the empty center panel.
   */
  const deepLinkConvId = searchParams.get('c');
  // `?assignee=` / `?tag=` (team chat's WHATSAPP INBOX rows): read once,
  // as the list's starting filters.
  const [initialFilters] = useState(() =>
    parseInboxFilterParams(searchParams, user?.id ?? null)
  );
  // The HR view's tabs and filters live in the URL (`hr*` keys, written
  // by the filter bar through the History API like `?c=`). Keyed on
  // their own serialisation so opening a chat (`?c=`) keeps the same
  // object and the list does not refetch.
  const hrView = departmentView === 'hr';
  const hrKey = hrView
    ? writeHrListParams(
        new URLSearchParams(),
        parseHrListParams(searchParams, hrInbox),
        hrInbox
      ).toString()
    : null;
  const hrFilters = useMemo<HrListFilters | undefined>(
    () =>
      hrKey === null
        ? undefined
        : parseHrListParams(new URLSearchParams(hrKey), hrInbox),
    [hrKey, hrInbox]
  );
  const handleHrFiltersChange = useCallback(
    (next: HrListFilters) => {
      const params = writeHrListParams(
        new URLSearchParams(window.location.search),
        next,
        hrInbox
      ).toString();
      window.history.replaceState(
        null,
        '',
        params ? `${basePath}?${params}` : basePath
      );
    },
    [basePath, hrInbox]
  );
  // The thread-selection URL: the HR view keeps its filter keys.
  const selectionUrl = useCallback(
    (convId: string | null) =>
      hrView
        ? hrInboxUrl(basePath, window.location.search, convId, hrInbox)
        : convId
          ? `${basePath}?c=${convId}`
          : basePath,
    [basePath, hrView, hrInbox]
  );

  // List rows hold only the list's columns (CONVERSATION_LIST_SELECT);
  // the open chat is always a full row, read when it is opened.
  const [conversations, setConversations] = useState<ConversationListItem[]>(
    []
  );
  // The open chat: its list row at first, then its full row once read
  // (lib/inbox/open-conversation.ts).
  const [activeChat, setActiveChat] = useState<ActiveChat | null>(null);
  const activeConversation = activeChat?.row ?? null;
  const fullConversation = activeChat?.full ? activeChat.row : null;
  // The chat whose full row could not be read after every retry: the
  // sections waiting for it offer a Retry instead of staying busy.
  const [fullRowFailedId, setFullRowFailedId] = useState<string | null>(null);
  const fullRowFailed =
    !!activeChat && !activeChat.full && fullRowFailedId === activeChat.row.id;
  const [messages, setMessages] = useState<Message[]>([]);
  const [whatsappConnected, setWhatsappConnected] = useState<boolean | null>(
    null
  );
  /**
   * Bumped whenever we want children (ConversationList, MessageThread)
   * to refetch from the DB from scratch — the manual refresh button, or
   * a reconnect/return with nothing to anchor a delta on. The initial
   * mount fetches don't depend on this; they fire once on
   * conversationId-change as usual.
   */
  const [resyncToken, setResyncToken] = useState(0);
  /**
   * The cheaper safety net against missed realtime events: on WS
   * reconnect, or on returning to a tab hidden long enough to matter,
   * the list re-reads only the conversations whose `updated_at` moved
   * past `since` and the thread re-reads its latest page, merging both
   * into what is already on screen instead of reloading everything.
   */
  const [deltaSync, setDeltaSync] = useState<{
    token: number;
    since: string | null;
  }>({ token: 0, since: null });

  // Chats shared with me as a coordinator (migration 133), with the
  // bank each came under: they count as mine on the personal inbox and
  // carry a "Shared" label. Re-read with every resync.
  const sharedBanks = useMyCoordinatorShares(resyncToken + deltaSync.token);
  // Keyed on the ids, so a re-read finding the same shares does not
  // refetch the list.
  const sharedKey = sharedBanks ? [...sharedBanks.keys()].sort().join(',') : '';
  const sharedConversationIds = useMemo(
    () => (sharedKey ? sharedKey.split(',') : []),
    [sharedKey]
  );

  // The personal narrowing the list's query applies (null: none), for
  // rows hydrated outside a page fetch.
  const narrowing = useMemo<InboxNarrowing | null>(
    () =>
      personalOnlyUserId
        ? {
            userId: personalOnlyUserId,
            channelIds: myNumberIds ?? [],
            sharedConversationIds,
          }
        : null,
    [personalOnlyUserId, myNumberIds, sharedConversationIds]
  );
  const narrowingRef = useRef(narrowing);
  // /inbox leaves other people's personal chats (191) to the Team inbox,
  // for every role; `undefined` means no such hiding.
  const hidePersonalFor = wideView ? undefined : (user?.id ?? null);
  const hidePersonalForRef = useRef(hidePersonalFor);
  // Which department slice this list is (192): a department inbox's own
  // chats, else the main inboxes' (no department chat but the viewer's,
  // and below admin their own department's: an HR team leader's Team
  // inbox lists her HR team's chats).
  const viewerId = user?.id ?? null;
  const ownDepartment = viewerInboxDepartment(accountRole, department);
  const deptView = useMemo<DepartmentView>(
    () =>
      departmentView
        ? { department: departmentView }
        : { mainFor: viewerId, ownDepartment },
    [departmentView, viewerId, ownDepartment]
  );
  const deptViewRef = useRef(deptView);
  useEffect(() => {
    narrowingRef.current = narrowing;
    hidePersonalForRef.current = hidePersonalFor;
    deptViewRef.current = deptView;
  });

  /**
   * Keyset cursor of the list's last loaded page (`null` once every
   * page is in). Realtime and delta merges read it to decide whether a
   * conversation we don't hold belongs on screen now or will simply
   * arrive with its page.
   */
  const listCursorRef = useRef<ConversationCursor | null>(null);

  /**
   * Whether the desktop contact sidebar (tags / deals / notes) is shown.
   * Defaults to `true` (the historical behaviour) and is restored from
   * localStorage after mount. We deliberately do NOT read localStorage in
   * the initializer: the server renders with `true`, so reading a stored
   * `false` synchronously would produce a hydration mismatch. The effect
   * below reconciles to the stored value right after mount instead.
   */
  const [contactPanelOpen, setContactPanelOpen] = useState(true);
  useEffect(() => {
    try {
      const stored =
        localStorage.getItem(CONTACT_PANEL_STORAGE_KEY) ??
        localStorage.getItem(LEGACY_CONTACT_PANEL_STORAGE_KEY);
      if (stored !== null) setContactPanelOpen(stored === 'true');
    } catch {
      // localStorage can throw in private-browsing / sandboxed contexts.
    }
  }, []);

  const handleToggleContactPanel = useCallback(() => {
    setContactPanelOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(CONTACT_PANEL_STORAGE_KEY, String(next));
      } catch {
        // Persistence is best-effort; ignore storage failures.
      }
      return next;
    });
  }, []);

  // Fire the deep-link auto-select exactly once per URL — subsequent
  // list refreshes (realtime, manual refetch) must not snap the user
  // back to the deep-linked conversation if they've already clicked
  // elsewhere.
  const autoSelectedForDeepLinkRef = useRef<string | null>(null);

  // Tracks conversations whose hydrate fetch is currently in flight. The
  // conv-INSERT and the first-message-INSERT events both call into
  // hydrateConversation; the dedupe here keeps it at one refetch per
  // new conversation even when both events arrive within milliseconds.
  const hydratingConvIdsRef = useRef<Set<string>>(new Set());

  /**
   * Synchronous mirror of the conversation ids currently in `conversations`
   * state. Event handlers need to know "do we already have this conv?"
   * without waiting for a setState updater to run — updaters fire during
   * reconciliation, *after* the synchronous handler code returns, so a
   * `let foundInList = false; setState(p => { foundInList = ...; return ... })`
   * flag reads as `false` in the same tick (this exact bug shipped in #105
   * and caused #106: every incoming message and every status flip fired a
   * redundant DB hydrate, swamping the supabase client and starving the
   * realtime channel). The ref is kept in sync via the effect below.
   */
  const knownConvIdsRef = useRef<Set<string>>(new Set());
  // Same mirror, whole rows — the delta resync anchors its watermark on
  // the newest `updated_at` we hold.
  const conversationsRef = useRef<ConversationListItem[]>([]);
  useEffect(() => {
    const next = new Set<string>();
    for (const c of conversations) next.add(c.id);
    knownConvIdsRef.current = next;
    conversationsRef.current = conversations;
  }, [conversations]);

  // WhatsApp profile pictures (migration 070). Each loaded contact is
  // asked about once per session; the server decides whether a lookup
  // is due, so this is cheap to over-ask. Fire-and-forget: the list
  // renders the initial meanwhile, and a failure only costs the photo.
  const avatarRequestedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const timer = setTimeout(() => {
      const batches = avatarRequestBatches(
        conversationsRef.current.map((c) => c.contact?.id),
        avatarRequestedRef.current
      );
      // Mark everything requested up front, then send the batches one
      // after another: parallel batches would each probe and look up on
      // the server at once.
      for (const batch of batches) {
        for (const id of batch) avatarRequestedRef.current.add(id);
      }
      void (async () => {
        for (const batch of batches) {
          try {
            const res = await fetch('/api/whatsapp/contacts/avatars', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ contactIds: batch }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const { avatars } = (await res.json()) as {
              avatars?: Record<string, string | null>;
            };
            if (!avatars || Object.keys(avatars).length === 0) continue;
            setConversations((prev) => applyAvatars(prev, avatars));
            setActiveChat((prev) => applyActiveAvatars(prev, avatars));
          } catch (err) {
            console.warn('[inbox] could not load profile pictures:', err);
          }
        }
      })();
    }, AVATAR_REQUEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [conversations]);

  // Pull the conversation row with its `contact` joined and merge it
  // into state. Needed because Supabase Realtime payloads only carry the
  // row's own columns — a brand-new conversation arrives without a
  // contact, which surfaced as "Unknown" names, empty avatars, and
  // (when the conv-INSERT event was delayed past the message-INSERT)
  // conversations stuck on "No messages yet" until the user reloaded.
  // Also self-heals if a realtime event was missed: callers can invoke
  // this whenever they reference a conversation id they don't recognise.
  //
  // A row not yet in the list passes the personal narrowing first
  // (`inPersonalInbox`): the list's query narrows a team leader's Inbox
  // to their own threads, and a hydrated pin or Important chat would
  // otherwise slip a teammate's chat in beside them. Read through a ref
  // so this callback keeps its identity.
  const hydrateConversation = useCallback(async (convId: string) => {
    if (hydratingConvIdsRef.current.has(convId)) return;
    hydratingConvIdsRef.current.add(convId);
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from('conversations')
        .select(CONVERSATION_SELECT)
        .eq('id', convId)
        .maybeSingle();
      if (error) {
        // Supabase errors have non-enumerable properties — log fields
        // explicitly so the console message isn't just `{}`.
        console.error('Failed to hydrate conversation:', {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        return;
      }
      if (!data) return;
      const fetched = normalizeConversation(data);
      const admits = inPersonalInbox(
        fetched,
        narrowingRef.current,
        hidePersonalForRef.current,
        deptViewRef.current
      );
      setConversations((prev) => {
        const existing = prev.find((c) => c.id === fetched.id);
        if (existing) {
          // Already in state — keep its fields (a realtime UPDATE may
          // have landed while the fetch was in flight and patched
          // last_message_text / unread_count to fresher values than
          // the row we just read). Only backfill `contact`, which the
          // realtime payloads never carry.
          return prev.map((c) =>
            c.id === fetched.id
              ? { ...c, contact: c.contact ?? fetched.contact }
              : c
          );
        }
        return admits ? [fetched, ...prev] : prev;
      });
    } finally {
      hydratingConvIdsRef.current.delete(convId);
    }
  }, []);

  // Check WhatsApp connection status on mount.
  //
  // whatsapp_config is one row per account, so this has to be keyed by
  // account_id rather than the current user — a teammate who didn't
  // personally save the config would otherwise see "not connected" in
  // a shared inbox the admin had already set up.
  //
  // `accountId` comes from the AuthProvider, which has already read the
  // profile row. This effect used to re-read it (getSession → profiles
  // → whatsapp_config), a three-deep chain of round trips before the
  // banner could resolve; through the tunnel that is most of a second
  // spent re-asking a question the app had already answered. The status
  // itself changes only when someone reconnects the channel, so it is
  // cached briefly and shared across screens.
  //
  // Staying `null` (rather than false) until the account is known keeps
  // the "not connected" banner from flashing during load; an account
  // that never resolves is reported by <AccountAccessAlert /> instead.
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    (async () => {
      const status = await cachedQuery(
        `whatsapp-status:${accountId}`,
        60_000,
        async () => {
          const supabase = createClient();
          const { data } = await supabase
            .from('whatsapp_config')
            .select('status')
            .eq('account_id', accountId)
            // "Can this account send at all?" — so ANY connected
            // channel counts. Since migration 046 an account can hold
            // both a Whapi and a Meta row; keyed on account_id alone
            // maybeSingle() matches two, errors, and the banner claims
            // WhatsApp is disconnected while both numbers are live.
            .eq('status', 'connected')
            .limit(1)
            .maybeSingle();
          return (data?.status as string | undefined) ?? null;
        }
      ).catch(() => null);
      if (!cancelled) setWhatsappConnected(status === 'connected');
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  // Handle realtime message events
  const handleMessageEvent = useCallback(
    (event: { eventType: string; new: Message; old: Partial<Message> }) => {
      const newMsg = event.new;

      // Every chat's cached latest page, open or not, so a revisit shows
      // what arrived meanwhile (lib/inbox/message-cache.ts). A chat with
      // nothing cached is left alone: its next open reads the page.
      const cacheKey = messagesCacheKey(
        accountId,
        user?.id,
        event.eventType === 'DELETE'
          ? event.old?.conversation_id
          : newMsg?.conversation_id
      );
      if (cacheKey) {
        sessionCache.update<CachedMessagePage>(cacheKey, (p) =>
          applyMessageEventToPage(p, event)
        );
      }

      if (event.eventType === 'INSERT') {
        // Add to messages if it belongs to active conversation
        if (
          activeConversation &&
          newMsg.conversation_id === activeConversation.id
        ) {
          setMessages((prev) => {
            // Avoid duplicates
            if (prev.some((m) => m.id === newMsg.id)) return prev;
            // Replace optimistic message if it exists
            const withoutOptimistic = prev.filter(
              (m) => !m.id.startsWith('temp-')
            );
            return [...withoutOptimistic, newMsg];
          });
        }

        // Update conversation list preview. We need to know *synchronously*
        // whether the conv is already in state to decide between patching
        // the preview and triggering a hydrate — see the comment on
        // knownConvIdsRef for why a closure flag inside the updater would
        // always read false here.
        if (knownConvIdsRef.current.has(newMsg.conversation_id)) {
          setConversations((prev) =>
            prev.map((c) =>
              c.id === newMsg.conversation_id
                ? {
                    ...c,
                    last_message_text: newMsg.content_text ?? '',
                    last_message_at: newMsg.created_at,
                    unread_count:
                      activeConversation?.id === newMsg.conversation_id
                        ? 0
                        : c.unread_count + 1,
                  }
                : c
            )
          );
        } else {
          // First time we're seeing this conv: the conv-INSERT event
          // hasn't landed yet, or was missed. Hydrate from the DB so
          // the row surfaces with its `contact` joined; the conv-UPDATE
          // event the webhook emits right after the message INSERT will
          // converge state when it arrives.
          hydrateConversation(newMsg.conversation_id);
        }
      }

      if (event.eventType === 'UPDATE') {
        // Update message status
        setMessages((prev) =>
          prev.map((m) => (m.id === newMsg.id ? { ...m, ...newMsg } : m))
        );
      }
    },
    [activeConversation, hydrateConversation, accountId, user?.id]
  );

  // Smart insights on (docs/jev-insights.md): a chat a signal just
  // pinned is fetched below even when it is an older thread. Read
  // through a ref so the realtime handler keeps its identity.
  const { settings: insightSettings } = useInsightSettings();
  const signalsOnRef = useRef(false);
  useEffect(() => {
    signalsOnRef.current = !!insightSettings?.signalsEnabled;
  });

  // Handle realtime conversation events
  const handleConversationEvent = useCallback(
    (event: {
      eventType: string;
      new: Conversation;
      old: Partial<Conversation>;
    }) => {
      const conv = event.new;

      if (event.eventType === 'INSERT') {
        // Prepend immediately for snappy UX so the new conv shows in the
        // list right away, then hydrate to fill in the `contact` join
        // (realtime payloads never include joins). Skip both if we
        // already have the row — that shouldn't happen normally, but
        // out-of-order delivery would have us prepending a duplicate —
        // or if the row is outside this list's personal narrowing: a
        // team leader's Inbox is their own threads, while RLS streams
        // them every new chat of their team.
        if (
          admitsInsertedConversation(
            conv,
            knownConvIdsRef.current,
            narrowingRef.current,
            hidePersonalForRef.current,
            deptViewRef.current
          )
        ) {
          setConversations((prev) => {
            if (prev.some((c) => c.id === conv.id)) return prev;
            return [conv, ...prev];
          });
          hydrateConversation(conv.id);
        }
      }

      if (event.eventType === 'UPDATE') {
        if (knownConvIdsRef.current.has(conv.id)) {
          // If this UPDATE is for the conv the user is currently viewing,
          // suppress the incoming unread_count — the user is reading it
          // RIGHT NOW, so any positive value would just flicker the badge
          // back on for the ~100ms it takes for the reset effect's server
          // UPDATE to round-trip. Non-active convs take the value as-is.
          const isActive = activeConversation?.id === conv.id;
          setConversations((prev) =>
            prev.map((c) =>
              c.id === conv.id
                ? {
                    ...c,
                    ...conv,
                    unread_count: isActive ? 0 : conv.unread_count,
                  }
                : c
            )
          );
        } else if (
          // A chat needing attention is pinned at the top, wherever its
          // last message falls (lib/inbox/attention.ts).
          needsAttention(conv) ||
          // So is a chat a signal pinned until handled (migration 153),
          // only with signals on.
          shouldFetchUnloadedPin(conv, signalsOnRef.current) ||
          isWithinLoadedWindow(conv.last_message_at, listCursorRef.current)
        ) {
          // UPDATE arrived before the INSERT (or after a missed INSERT)
          // — fetch the row so it surfaces with its contact joined. The
          // patch contained in `conv` will already be reflected in what
          // the hydrate fetch returns.
          //
          // Only for a row that sorts inside the pages already loaded:
          // the list is paginated, so an UPDATE to an old conversation
          // further down (a status flip, an unread reset) is simply one
          // we haven't reached yet — hydrating it would pull it to the
          // top out of order. It arrives with its page.
          hydrateConversation(conv.id);
        }

        // Update active conversation if it changed
        // Merged, never replaced: the payload has no contact join, and
        // the open chat may already hold its full row.
        if (activeConversation && conv.id === activeConversation.id) {
          setActiveChat((prev) => patchActiveChat(prev, conv.id, conv));
        }
      }
    },
    [activeConversation, hydrateConversation]
  );

  // Subscribe to realtime. The `isConnected` flag below feeds the
  // reconnect resync: realtime is best-effort and events sent while the
  // WS was disconnected (laptop sleep, network blip, background-tab
  // throttle) are simply lost. We need a way to catch up.
  const { isConnected } = useRealtime({
    channelName: 'inbox-realtime',
    onMessageEvent: handleMessageEvent,
    onConversationEvent: handleConversationEvent,
    enabled: true,
  });

  /**
   * Catch up after a window in which realtime events may have been
   * lost. With a watermark (server-clock `updated_at`, taken when the
   * window opened) it's a delta; without one — nothing loaded yet to
   * anchor on — it falls back to the full reload.
   */
  const resyncSince = useCallback((since: string | null) => {
    if (since) {
      setDeltaSync((prev) => ({ token: prev.token + 1, since }));
    } else {
      setResyncToken((n) => n + 1);
    }
  }, []);

  /**
   * Resync whenever the realtime channel transitions from
   * disconnected → connected *after* the initial connect. The initial
   * connect is covered by the children's on-mount fetches; only later
   * reconnects need a refetch to fill the gap. The watermark is taken
   * at the connected → disconnected edge, so the delta asks exactly
   * "what changed while we weren't listening".
   *
   * Tracked via a `was-connected` ref rather than a count so that React
   * strict-mode's dev-only effect double-fire doesn't read as a
   * reconnect.
   */
  const wasConnectedRef = useRef(false);
  const initialConnectDoneRef = useRef(false);
  const disconnectWatermarkRef = useRef<string | null>(null);
  useEffect(() => {
    if (isConnected && !wasConnectedRef.current) {
      // false → true transition
      if (initialConnectDoneRef.current) {
        const since = disconnectWatermarkRef.current;
        disconnectWatermarkRef.current = null;
        resyncSince(since);
      } else {
        initialConnectDoneRef.current = true;
      }
    } else if (!isConnected && wasConnectedRef.current) {
      // true → false: remember where we stopped listening.
      disconnectWatermarkRef.current = deltaWatermark(conversationsRef.current);
    }
    wasConnectedRef.current = isConnected;
  }, [isConnected, resyncSince]);

  /**
   * Resync when the tab comes back after being hidden for a while.
   * Background tabs may have their WS throttled by the browser even
   * without a full disconnect, so a long absence is a reliable signal
   * that we may have missed events.
   *
   * This used to fire a full reload of the list, the thread and its
   * reactions on *every* visibilitychange — every alt-tab — which
   * behind the tunnel was several seconds of round trips for nothing.
   * Now a short absence does nothing (realtime is still connected), and
   * a long one is a delta anchored on the watermark taken as the tab
   * was hidden.
   */
  useEffect(() => {
    let hiddenAt: number | null = null;
    let hiddenWatermark: string | null = null;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        hiddenWatermark = deltaWatermark(conversationsRef.current);
        return;
      }
      if (hiddenAt === null) return;
      const away = Date.now() - hiddenAt;
      hiddenAt = null;
      if (away > RESYNC_AFTER_HIDDEN_MS) resyncSince(hiddenWatermark);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [resyncSince]);

  /**
   * Manual refresh trigger for the thread-header refresh button.
   * Bumps the same resyncToken the reconnect / visibility paths use,
   * so it goes through the existing dedupe & refetch plumbing — no
   * separate code path to keep in sync.
   */
  const handleManualRefresh = useCallback(() => {
    setResyncToken((n) => n + 1);
  }, []);

  /**
   * Open a conversation the list doesn't contain.
   *
   * The personal inbox narrows a team leader to their own threads, but
   * a `?c=` link can legitimately point outside that set — a
   * notification about a chat their team handles, or a bookmark made
   * from /team-inbox. Without this the centre panel just stayed empty:
   * the link looked broken even though the reader is allowed to see
   * the thread. Read the row directly and let RLS answer — if it says
   * no, `data` comes back null and nothing opens, which is correct.
   */
  //
  // It is also the second half of every open: a chat clicked in the list
  // opens on its list row at once (so the thread starts reading its
  // messages straight away) while the full row is read alongside, and
  // the full row replaces the list row when it lands if that chat is
  // still open (lib/inbox/open-conversation.ts). Without a list row
  // (this ?c= case) the chat opens on the full row, unless another chat
  // was asked for in the meantime (`openingIdRef`).
  const openingIdRef = useRef<OpenTicket | null>(null);
  const openDeps = useMemo<OpenConversationDeps>(
    () => ({
      latest: openingIdRef,
      show: (chat) => {
        setActiveChat(chat);
        setMessages([]);
        setFullRowFailedId(null);
      },
      upgrade: (full) => setActiveChat((prev) => applyFullRow(prev, full)),
      fetchFull: async (id) => {
        const supabase = createClient();
        const { data, error } = await supabase
          .from('conversations')
          .select(CONVERSATION_SELECT)
          .eq('id', id)
          .maybeSingle();
        if (error) {
          console.error('Failed to open conversation:', {
            message: error.message,
            details: error.details,
            hint: error.hint,
            code: error.code,
          });
          return null;
        }
        return data ? normalizeConversation(data) : null;
      },
      failed: (id) => setFullRowFailedId(id),
    }),
    []
  );
  const openConversationById = useCallback(
    (convId: string, listRow?: ConversationListItem) => {
      // The contact panel's deals and notes go out in the same wave as
      // the full row, from the list row's contact id, instead of a
      // round trip after it (lib/inbox/contact-panel.ts).
      const contactId = listRow?.contact?.id;
      if (contactId) {
        prefetchContactPanel(
          {
            deals: panelPartKey(
              accountId,
              user?.id,
              convId,
              'deals',
              contactId
            ),
            notes: panelPartKey(
              accountId,
              user?.id,
              convId,
              'notes',
              contactId
            ),
          },
          contactId
        );
      }
      return openConversation(convId, listRow, openDeps);
    },
    [openDeps, accountId, user?.id]
  );
  // A re-click of a chat still on its list row, or the Retry the waiting
  // sections offer once the retries have given up: read it again now.
  const retryFullRow = useCallback(
    (convId: string) => {
      setFullRowFailedId(null);
      return rereadFullRow(convId, openDeps);
    },
    [openDeps]
  );
  // The open chat's full row as it is on screen, cached for the contact
  // panel: a revisit shows it at once (revalidated by the open's own
  // read), and a tag, AI or realtime change made here is never shown
  // undone. The cached copy is only ever what this screen showed.
  useEffect(() => {
    const key = panelRowKey(accountId, user?.id, fullConversation?.id);
    if (key && fullConversation) sessionCache.set(key, fullConversation);
  }, [fullConversation, accountId, user?.id]);
  // An open that failed may be RLS saying no: drop the chat's cached
  // full row and messages so no later visit shows them again.
  const failedChatId = fullRowFailed ? activeConversation?.id : undefined;
  useEffect(() => {
    if (failedChatId) {
      forgetFailedChat(sessionCache, accountId, user?.id, failedChatId);
    }
  }, [failedChatId, accountId, user?.id]);
  const panelKey = panelRowKey(accountId, user?.id, activeConversation?.id);
  const subscribePanel = useCallback(
    (onChange: () => void) =>
      panelKey ? sessionCache.subscribe(panelKey, onChange) : () => {},
    [panelKey]
  );
  const cachedPanelRow = useSyncExternalStore(
    subscribePanel,
    () =>
      panelKey ? sessionCache.peek<Conversation>(panelKey)?.value : undefined,
    () => undefined
  );
  const panel = panelSource({
    open: activeConversation,
    full: fullConversation,
    cached: cachedPanelRow,
    fullRowFailed,
  });

  // The AI banner's account status, read now rather than on the first
  // chat opened (it is cached per account; lib/inbox/ai-account-status.ts).
  useEffect(() => {
    // A department kept out of the sales areas is refused (migration 192).
    if (salesRestricted) return;
    warmAiAccountStatus(accountId);
  }, [accountId, salesRestricted]);

  // Leaving the Inbox stops any retry still waiting.
  useEffect(
    () => () => {
      openingIdRef.current = null;
    },
    []
  );

  const handleConversationsLoaded = useCallback(
    (
      loaded: ConversationListItem[],
      load: ConversationListLoad = { mode: 'replace', cursor: null }
    ) => {
      // A further page, or a delta resync: fold into what's there. The
      // deep-link auto-select below belongs to the first page only.
      if (load.mode === 'append') {
        listCursorRef.current = load.cursor;
        setConversations((prev) => appendConversationPage(prev, loaded));
        return;
      }
      if (load.mode === 'delta') {
        setConversations((prev) =>
          mergeConversationDelta(prev, loaded, listCursorRef.current)
        );
        return;
      }
      listCursorRef.current = load.cursor;
      setConversations(loaded);
      // Resolve a pending deep-link here rather than in an effect — this
      // is an event handler, so the setState calls below are allowed by
      // react-hooks/set-state-in-effect. Runs once per ?c=<id> URL value
      // via the ref, so realtime refreshes of the list can't snap the
      // user back to the deep-linked thread after they've navigated.
      // No `loaded.length` guard: ConversationList only calls this once
      // its fetch has resolved, so an empty array means "this list has
      // no conversations" — which is exactly when a leader's ?c= link
      // into a team thread needs the fallback below.
      if (
        deepLinkConvId &&
        autoSelectedForDeepLinkRef.current !== deepLinkConvId
      ) {
        autoSelectedForDeepLinkRef.current = deepLinkConvId;
        // If the deep-linked conversation is already the active one
        // (e.g. because the user clicked it in the list and we
        // replaced the URL, and the ConversationList then refetched and
        // landed us back here), do NOT re-apply it. Doing so
        // would setMessages([]) on a thread whose messages have
        // already been loaded by MessageThread — and because
        // conversationId didn't change, MessageThread wouldn't
        // refetch. The thread would read "No messages yet" until a
        // full page reload rehydrated state from scratch.
        if (activeConversation?.id === deepLinkConvId) return;
        // Opens on the list row when the list has it, and is filled in
        // with the full row either way (see openConversationById).
        const match = loaded.find((c) => c.id === deepLinkConvId);
        void openConversationById(deepLinkConvId, match);
        if (!match) return;
        // Mirror the optimistic unread reset that handleSelectConversation
        // does — the user just deep-linked into this conv, treat that the
        // same as a click. Leaves activeConversation.unread_count alone so
        // the MessageThread reset effect still fires the server UPDATE.
        if (match.unread_count > 0) {
          setConversations((prev) =>
            prev.map((c) => (c.id === match.id ? { ...c, unread_count: 0 } : c))
          );
        }
      }
    },
    [deepLinkConvId, activeConversation?.id, openConversationById]
  );

  const handleSelectConversation = useCallback(
    (conv: ConversationListItem) => {
      // Re-clicking the already-active conversation would clear the
      // messages array, but the fetch effect in MessageThread only re-runs
      // when conversationId changes — so messages would stay empty until
      // the user navigated away and back. Bail out early instead, but
      // re-read the full row if it never arrived (the click is the
      // agent asking for the rest of the chat).
      if (activeConversation?.id === conv.id) {
        // Only after the retries gave up: while a read is still in
        // flight, a second click (a double-click) would just race it.
        if (fullRowFailed) void retryFullRow(conv.id);
        return;
      }
      // Shows the list row now and reads the full row alongside
      // (openConversationById); clears the messages.
      void openConversationById(conv.id, conv);
      // Optimistically clear the unread badge for this conv. The
      // server-side reset is fired by the unread-reset effect inside
      // MessageThread (which reads activeConversation.unread_count, not
      // the list copy — so we deliberately leave that intact below to
      // keep the effect firing), and the realtime UPDATE that comes
      // back will sync to 0 again as a no-op. Zeroing the list copy
      // here means the user sees the badge disappear the instant they
      // click instead of waiting for the round-trip — and it persists
      // even if the realtime UPDATE is dropped.
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conv.id && c.unread_count > 0 ? { ...c, unread_count: 0 } : c
        )
      );
      // Record the selection on the deep-link ref BEFORE we change the
      // URL. The URL write below flips `deepLinkConvId`, which can
      // in turn cause ConversationList to refetch and eventually call
      // handleConversationsLoaded again. Without this line, the ref
      // still points at the previous value, the auto-select block
      // sees `ref !== deepLinkConvId`, fires a second time, and
      // clobbers the messages MessageThread just fetched.
      autoSelectedForDeepLinkRef.current = conv.id;
      // Reflect the selection in the URL so a refresh lands the user
      // back in the same thread, and so copy-paste links work. Replace,
      // not push, to avoid polluting browser history with every click.
      //
      // The native History API rather than `router.replace`: the inbox
      // is a client component that fetches its own data, so the URL
      // change needs nothing from the server — but `router.replace`
      // still made an RSC round trip on every click, ~600ms behind the
      // tunnel. Next keeps `useSearchParams` in sync with
      // `history.replaceState` (see settings/page.tsx), so `?c=` still
      // reads back on reload and on back/forward.
      window.history.replaceState(null, '', selectionUrl(conv.id));
    },
    [
      activeConversation?.id,
      fullRowFailed,
      selectionUrl,
      openConversationById,
      retryFullRow,
    ]
  );

  // The list's "New chat" button: open a chat by id (one it found or
  // just started), the way a click on its row would.
  const handleOpenConversationById = useCallback(
    (convId: string) => {
      const row = conversationsRef.current.find((c) => c.id === convId);
      if (row) {
        handleSelectConversation(row);
        return;
      }
      if (activeConversation?.id === convId) return;
      void openConversationById(convId);
      autoSelectedForDeepLinkRef.current = convId;
      window.history.replaceState(null, '', selectionUrl(convId));
    },
    [
      activeConversation?.id,
      selectionUrl,
      handleSelectConversation,
      openConversationById,
    ]
  );

  // Mobile "back" — deselect the conversation so the list pane comes
  // back. Also clears the ?c= param so a refresh lands on the list
  // instead of re-opening the thread the user just backed out of.
  const handleCloseConversation = useCallback(() => {
    openingIdRef.current = null;
    setActiveChat(null);
    setMessages([]);
    // Clearing the ref lets the deep-link auto-selector fire again if
    // the user later visits ?c=<same-id> again — desirable UX.
    autoSelectedForDeepLinkRef.current = null;
    window.history.replaceState(null, '', selectionUrl(null));
  }, [selectionUrl]);

  // Accepts an updater too: the thread prepends older pages and merges
  // resyncs against the freshest state, not a render-time snapshot.
  const handleMessagesLoaded = useCallback(
    (loaded: Message[] | ((prev: Message[]) => Message[])) => {
      setMessages(loaded);
    },
    []
  );

  const handleNewMessage = useCallback((msg: Message) => {
    setMessages((prev) => {
      if (prev.some((m) => m.id === msg.id)) return prev;
      return [...prev, msg];
    });
  }, []);

  const handleUpdateMessage = useCallback(
    (id: string, updates: Partial<Message>) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, ...updates } : m))
      );
    },
    []
  );

  // A save's result patches the list row, and the open chat only if it
  // is still the chat it was saved for — checked when the save lands,
  // not against the chat this callback captured: through the tunnel the
  // agent has often moved on (lib/inbox/patch-active.ts).
  // The open chat is patched with patchActiveChat, which keeps a full
  // row full and never lets a patch's contact replace the full contact.
  const patchConversation = useCallback(
    (conversationId: string, patch: Partial<Conversation>) => {
      setConversations((prev) =>
        prev.map((c) => (c.id === conversationId ? { ...c, ...patch } : c))
      );
      setActiveChat((prev) => patchActiveChat(prev, conversationId, patch));
    },
    []
  );

  const handleRetryFullRow = useCallback(() => {
    if (activeConversation) void retryFullRow(activeConversation.id);
  }, [activeConversation, retryFullRow]);

  const handleChatTagsChange = useCallback(
    (conversationId: string, patch: ChatTagRowPatch) =>
      patchConversation(conversationId, patch),
    [patchConversation]
  );

  const handleAssignChange = useCallback(
    (conversationId: string, assignedAgentId: string | null) =>
      patchConversation(conversationId, {
        assigned_agent_id: assignedAgentId ?? undefined,
      }),
    [patchConversation]
  );

  const handleAiChange = useCallback(
    (conversationId: string, patch: AiBannerPatch) =>
      patchConversation(conversationId, patch),
    [patchConversation]
  );

  // On mobile (<lg) we show a SINGLE pane — either the list or the
  // thread — rather than cramming both side-by-side. Selecting a
  // conversation slides the thread in; the thread's back button pops
  // it back to the list. On lg+ both panes render side-by-side as
  // before, unchanged.
  const hasActiveConv = !!activeConversation;

  return (
    // Fills the shell's full-bleed main (lib/layout/full-bleed.ts).
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {campaignView && (
        <div className="shrink-0 px-4 pt-2 sm:px-6">
          <BroadcastsTabs />
        </div>
      )}

      {/* WhatsApp connection banner — in the flex column, not absolute,
          so it pushes the panels down instead of overlapping them. */}
      {whatsappConnected === false && (
        <div className="border-wa-divider bg-wa-panel-header text-wa-warning flex shrink-0 items-center justify-center gap-2 border-b px-4 py-2">
          <WifiOff className="h-4 w-4" />
          <p className="text-xs font-medium">{t('whatsappNotConnected')}</p>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Left panel: Conversation list.
            Hidden on mobile when a conversation is selected so the
            thread can occupy the full width. Always visible on lg+.

            `min-w-0` is load-bearing on mobile, where this panel is the
            whole width: a row's preview is one unbroken (truncated) line,
            and without it that line's full length sets the panel's
            minimum width — the list spilled past the screen and the
            times and unread counts were cut off at the right edge. */}
        <div
          className={cn(
            'flex h-full min-w-0 flex-1 lg:flex-none',
            hasActiveConv ? 'hidden lg:flex' : 'flex'
          )}
        >
          <ConversationList
            hrFilters={hrFilters}
            hrHeader={
              hrFilters && {
                // The HR view's list header (migration 200, package
                // 023d-1), inside the list column.
                title: <HrListTitle tab={hrFilters.tab} />,
                controls: (
                  <HrListHeader
                    filters={hrFilters}
                    onChange={handleHrFiltersChange}
                    fixedTab={!!hrInbox}
                  />
                ),
              }
            }
            initialAssignee={initialFilters.assignee}
            initialChatTagIds={initialFilters.chatTagIds}
            initialInsightFilters={initialFilters.insightFilters}
            initialUnread={initialFilters.unread}
            initialPinned={initialFilters.pinned}
            activeConversationId={activeConversation?.id ?? null}
            onSelect={handleSelectConversation}
            onOpenConversationById={handleOpenConversationById}
            conversations={conversations}
            onConversationsLoaded={handleConversationsLoaded}
            resyncToken={resyncToken}
            deltaSync={deltaSync}
            teamView={teamView}
            // Wait for the role before asking: `personalOnlyUserId` is
            // null until the profile lands, so a team leader's list used
            // to be fetched twice — once account-wide, then again
            // narrowed. Same fix as the contacts page.
            //
            // The allocated numbers only matter when the list is being
            // narrowed (a team leader's personal inbox); only then does
            // it wait for them, so nobody else pays a second fetch when
            // they arrive.
            enabled={
              !profileLoading &&
              aiLive !== null &&
              (!personalOnlyUserId ||
                (myNumberIds !== null && sharedBanks !== null))
            }
            restrictToUserId={personalOnlyUserId}
            restrictToChannelIds={
              personalOnlyUserId ? (myNumberIds ?? undefined) : undefined
            }
            restrictToConversationIds={
              personalOnlyUserId ? sharedConversationIds : undefined
            }
            ownPersonalChatsOf={hidePersonalFor ?? null}
            departmentView={deptView}
            sharedBanks={sharedBanks}
            numberNames={numberNames}
            showAssignee={showAssignee}
            onAssignChange={handleAssignChange}
            campaignOnly={campaignOnly}
            aiLive={aiLive === true}
          />
        </div>

        {/* Center panel: Message thread.
            Hidden on mobile when no conversation is selected so the
            list can occupy the full width. Always visible on lg+
            (shows its own empty-state if no thread is picked yet).

            `min-w-0` is load-bearing: without it, a single wide piece
            of content inside the thread (long quote preview, very
            long URL in a message body) forces the flex child past
            its share and pushes the contact-sidebar panel off-screen
            on the right. Issue #165. */}
        <div
          className={cn(
            'flex h-full min-w-0 flex-1 lg:flex',
            hasActiveConv ? 'flex' : 'hidden lg:flex'
          )}
        >
          <MessageThread
            conversation={activeConversation}
            fullConversation={fullConversation}
            fullRowFailed={fullRowFailed}
            onRetryFullRow={handleRetryFullRow}
            contact={activeConversation?.contact ?? null}
            sharedBank={
              activeConversation
                ? (sharedBanks?.get(activeConversation.id) ?? null)
                : null
            }
            messages={messages}
            onMessagesLoaded={handleMessagesLoaded}
            onNewMessage={handleNewMessage}
            onUpdateMessage={handleUpdateMessage}
            onChatTagsChange={handleChatTagsChange}
            onAssignChange={handleAssignChange}
            onAiChange={handleAiChange}
            onBack={handleCloseConversation}
            resyncToken={resyncToken}
            deltaSyncToken={deltaSync.token}
            onRefresh={handleManualRefresh}
            contactPanelOpen={contactPanelOpen}
            onToggleContactPanel={handleToggleContactPanel}
          />
        </div>

        {/* Right panel: Contact sidebar — desktop only, and only when the
            agent hasn't collapsed it via the thread-header toggle (#258).
            On mobile it's always hidden (the `lg:block` below), so the
            toggle — which is itself desktop-only — never affects it.
            With no chat open there is nothing to show: the thread's own
            empty state already says "Select a conversation", and the
            panel used to say it a second time beside it. */}
        {contactPanelOpen && activeConversation && (
          <div className="hidden lg:block">
            {/* The panel shows what it has: the cached full row on a
                revisit, else the list row's contact while the full row
                is in flight; only a chat with no contact at all waits
                (rather than show "select a conversation"). */}
            {activeConversation && !panel.contact ? (
              <div
                aria-busy={!fullRowFailed}
                className={cn(
                  'border-wa-divider bg-wa-panel h-full border-s',
                  hrView ? 'w-96' : 'w-70'
                )}
              >
                {fullRowFailed && (
                  <FullRowRetry
                    onRetry={handleRetryFullRow}
                    className="p-4"
                    announce={false}
                  />
                )}
              </div>
            ) : (
              <ContactSidebar
                contact={panel.contact}
                conversationId={activeConversation?.id ?? null}
                conversation={panel.conversation}
                inboxDepartment={activeConversation?.inbox_department ?? null}
                assignedAgentId={activeConversation?.assigned_agent_id ?? null}
                onAssignChange={handleAssignChange}
                widthClass={hrView ? 'w-96' : 'w-70'}
                notice={
                  fullRowFailed && !panel.complete ? (
                    <FullRowRetry
                      onRetry={handleRetryFullRow}
                      className="bg-wa-panel p-4"
                      announce={false}
                    />
                  ) : null
                }
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
