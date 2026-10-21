'use client';

import { memo, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  REFERENCE_CACHE_TTL_MS,
  cachedQuery,
  membersCacheKey,
} from '@/lib/client-cache';
import { useAuth } from '@/hooks/use-auth';
import { isBankGuest } from '@/lib/auth/roles';
import {
  CONVERSATION_SELECT,
  UNASSIGNED,
  matchesAssignee,
  matchesContactFilters,
  normalizeConversations,
  type AssigneeFilter,
} from '@/lib/inbox/conversations';
import {
  CAMPAIGN_INBOX_FILTER,
  INBOX_FILTER,
  inCampaignInbox,
} from '@/lib/inbox/campaign-inbox';
import { resolveListHandler } from '@/lib/inbox/handler';
import {
  CONVERSATION_PAGE_SIZE,
  assigneeGroup,
  combineOrGroups,
  conversationKeysetGroup,
  hasMessages,
  nextConversationCursor,
  restrictToUserGroup,
  appendConversationPage,
  type ConversationCursor,
} from '@/lib/inbox/pagination';
import {
  ATTENTION_LIMIT,
  countNeedingAttention,
  needsAttention,
  sortForInbox,
} from '@/lib/inbox/attention';
import { ImportantBadge } from './important-badge';
import { formatListTimestamp } from '@/lib/inbox/list-time';
import {
  chatTagFilterOrGroup,
  chatTagLabel,
  matchesChatTagFilter,
  resolveConversationChatTags,
  type ChatTagTree,
} from '@/lib/chat-tags/tree';
import { chatTagColor } from '@/lib/chat-tags/style';
import { ChatTagPill } from '@/components/inbox/chat-tag-pill';
import { useChatTags } from '@/hooks/use-chat-tags';
import { cn } from '@/lib/utils';
import type { Conversation, Profile } from '@/types';
import {
  Search,
  ChevronDown,
  X,
  UserRound,
  Radio,
  Phone,
  Share2,
  MessageSquare,
  SquareArrowOutUpRight,
  UserRoundSearch,
  Copy,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  useContextMenuItems,
  type ContextMenuEntry,
} from '@/components/context-menu/registry';
import { copyWithToast } from '@/components/context-menu/app-context-menu';
import { startOfDay } from 'date-fns';
import { useLocale, useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ContactAvatar } from './contact-avatar';

/**
 * How a batch of rows handed to `onConversationsLoaded` relates to the
 * list the parent holds:
 *  - `replace` — the first page (mount, filter change, full resync).
 *  - `append`  — the next page, from scrolling to the bottom.
 *  - `delta`   — rows whose `updated_at` moved past the resync
 *    watermark; merge, don't replace.
 * `cursor` is where the next page starts, `null` when there is none.
 */
export type ConversationListLoad =
  | { mode: 'replace'; cursor: ConversationCursor | null }
  | { mode: 'append'; cursor: ConversationCursor | null }
  | { mode: 'delta' };

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (
    conversations: Conversation[],
    load: ConversationListLoad
  ) => void;
  /**
   * Increment to force the first page to be refetched from scratch —
   * the manual refresh, or a resync with nothing to anchor a delta on.
   * Optional so existing callers keep working.
   */
  resyncToken?: number;
  /**
   * Bump `token` to re-read just the conversations whose `updated_at`
   * is past `since` (a server-clock watermark) and merge them in — the
   * cheap catch-up after a WS reconnect or a long-hidden tab.
   */
  deltaSync?: { token: number; since: string | null };
  /**
   * Hold the fetch until the caller knows what to ask for — the parent
   * passes `!profileLoading`, because `restrictToUserId` is derived
   * from the role and is null until the profile lands.
   */
  enabled?: boolean;
  /**
   * When set, show only conversations this user owns or is assigned.
   *
   * RLS already limits what comes back; this narrows it further for a
   * viewer who can legitimately see more — a team leader, whose
   * personal inbox would otherwise be identical to their team inbox.
   * `null`/undefined means "whatever RLS returns".
   */
  restrictToUserId?: string | null;
  /**
   * With `restrictToUserId`: the numbers that user works (migration
   * 060), whose chats also belong in their personal inbox.
   */
  restrictToChannelIds?: readonly string[];
  /**
   * With `restrictToUserId`: chats shared with that user as a
   * coordinator (migration 133), which also belong in their personal
   * inbox.
   */
  restrictToConversationIds?: readonly string[];
  /**
   * Conversation id -> bank code, for the chats shared with the viewer
   * as a coordinator. Those rows carry a "Shared · BANK" label.
   */
  sharedBanks?: ReadonlyMap<string, string> | null;
  /**
   * Show who holds each thread, and offer the by-agent filter.
   *
   * On for a viewer whose list mixes other people's chats — an admin
   * on either inbox, a team leader on /team-inbox. Off for everyone
   * else, where every row is already theirs and the name would just
   * repeat down the page. See `viewsOthersConversations`.
   */
  showAssignee?: boolean;
  /**
   * Number id → display name, when the account has more than one
   * WhatsApp number (migration 060). Each row then says which number
   * the customer is writing to. Null hides the label.
   */
  numberNames?: ReadonlyMap<string, string> | null;
  /**
   * The Campaign inbox: only the campaign chats (migration 048) the bot
   * is answering, where the Inbox lists every other chat — each chat is
   * in exactly one of the two (migration 067, `inCampaignInbox`). Adds a
   * per-campaign filter and shows, on each row, which campaign it came
   * from.
   */
  campaignOnly?: boolean;
  /**
   * Whether the AI auto-reply is live on the account. Off, the bot is
   * answering nothing: the Campaign inbox is empty and the Inbox lists
   * every chat.
   */
  aiLive?: boolean;
  /**
   * Seeds the by-agent and chat-tag filters on mount (the `?assignee=` /
   * `?tag=` deep links, lib/inbox/filter-params.ts); the controls then
   * own them as usual.
   */
  initialAssignee?: AssigneeFilter;
  initialChatTagIds?: readonly string[];
}

/** Just enough of a broadcast to label and filter by. */
interface CampaignOption {
  id: string;
  name: string;
}

type InboxFilter = 'all' | 'unread';

/**
 * Past this many changed rows a delta resync stops being cheaper than
 * reloading the first page, so it does that instead.
 */
const DELTA_LIMIT = 200;

/** Everything the server-side query depends on. */
interface ListQueryParams {
  restrictToUserId: string | null;
  restrictToChannelIds: readonly string[];
  restrictToConversationIds: readonly string[];
  campaignOnly: boolean;
  aiLive: boolean;
  status: InboxFilter;
  /** Chat tags (main or sub) to narrow to; empty = every chat. */
  chatTagIds: readonly string[];
  assignee: AssigneeFilter;
  campaignId: string | null;
}

/**
 * Build the conversations query for a page (`cursor` null → first
 * page) or for a delta resync (`since`).
 *
 * The unread / chat-tag / by-agent / by-campaign filters are pushed into
 * the query so a page holds 50 rows that *match* — filtering 50 loaded
 * rows client-side would show a handful of unread threads while
 * hundreds sat unloaded. The list still re-applies every filter
 * client-side (realtime can add or patch rows that no longer match).
 *
 * A delta deliberately skips those facet filters and keeps only the
 * visibility narrowing: a thread whose chat tag changed must come back
 * so its held copy is corrected, not left showing the old tag.
 */
function conversationsQuery(
  p: ListQueryParams,
  opts: {
    cursor?: ConversationCursor | null;
    since?: string;
    /**
     * The chats needing attention (migration 078), under the same
     * filters, read beside the first page so the pinned ones are on
     * screen at once. A separate read rather than a leading
     * `ORDER BY ai_attention_at`: the keyset cursor is on
     * `last_message_at`, and a page ordered by anything else first
     * would make it skip rows.
     */
    attention?: boolean;
  }
) {
  const supabase = createClient();
  let query = supabase.from('conversations').select(CONVERSATION_SELECT);
  const groups: (string | null)[] = [];

  if (p.restrictToUserId) {
    // "I created it OR it was handed to me OR it is on my number", the
    // same grants the database's own visibility rule makes.
    groups.push(
      restrictToUserGroup(
        p.restrictToUserId,
        p.restrictToChannelIds,
        p.restrictToConversationIds
      )
    );
  }
  if (p.campaignOnly) {
    query = query.not('campaign_broadcast_id', 'is', null);
    // With the AI off the bot is answering nothing, so the Campaign
    // inbox is empty: ask for no rows rather than special-case the
    // page, load-more and delta paths.
    if (!p.aiLive) query = query.is('id', null);
  }

  if (opts.since) {
    query = query.gt('updated_at', opts.since);
  } else {
    // A chat is listed once it holds a message (`hasMessages`). Not on a
    // delta: a held row that just got its first message must come back.
    query = query.not('last_message_at', 'is', null);
    if (p.status === 'unread') query = query.gt('unread_count', 0);
    groups.push(chatTagFilterOrGroup(p.chatTagIds));
    if (p.assignee === UNASSIGNED) {
      query = query.is('assigned_agent_id', null);
    } else {
      groups.push(assigneeGroup(p.assignee));
    }
    if (p.campaignId) query = query.eq('campaign_broadcast_id', p.campaignId);
    // Which of the two lists (lib/inbox/campaign-inbox.ts): the chats
    // the bot is answering, or every other one. Not on a delta: a chat
    // that moved between them while we weren't listening has to come
    // back so the held copy can be dropped or added.
    groups.push(
      p.campaignOnly ? CAMPAIGN_INBOX_FILTER : p.aiLive ? INBOX_FILTER : null
    );
    if (opts.cursor) groups.push(conversationKeysetGroup(opts.cursor));
  }

  // One `or=` holding every group (see combineOrGroups).
  const or = combineOrGroups(groups);
  if (or) query = query.or(or);

  if (opts.since) {
    return query.order('updated_at', { ascending: false }).limit(DELTA_LIMIT);
  }
  if (opts.attention) {
    return query
      .not('ai_attention_at', 'is', null)
      .order('ai_attention_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(ATTENTION_LIMIT);
  }
  return query
    .order('last_message_at', { ascending: false, nullsFirst: true })
    .order('id', { ascending: false })
    .limit(CONVERSATION_PAGE_SIZE);
}

function logFetchError(
  label: string,
  error: { message: string; details: string; hint: string; code: string }
) {
  // Supabase errors have non-enumerable properties — log fields explicitly
  console.error(label, {
    message: error.message,
    details: error.details,
    hint: error.hint,
    code: error.code,
  });
}

/** Stable default, so an omitted prop does not refire the fetch. */
const NO_CHANNELS: readonly string[] = [];
const NO_CHAT_TAGS: readonly string[] = [];

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
  deltaSync,
  enabled = true,
  restrictToUserId = null,
  restrictToChannelIds = NO_CHANNELS,
  restrictToConversationIds = NO_CHANNELS,
  sharedBanks = null,
  showAssignee = false,
  numberNames = null,
  campaignOnly = false,
  aiLive = false,
  initialAssignee = null,
  initialChatTagIds,
}: ConversationListProps) {
  const t = useTranslations('Inbox.conversationList');
  const locale = useLocale();

  // The rows' timestamps ("14:05", "Yesterday", "Monday") only depend
  // on which day it is, so this ticks over at midnight and nowhere
  // else: an inbox left open overnight still reads right, and no row
  // re-renders in between.
  const [today, setToday] = useState(() => startOfDay(new Date()).getTime());
  useEffect(() => {
    const id = setInterval(() => {
      const day = startOfDay(new Date()).getTime();
      setToday((prev) => (prev === day ? prev : day));
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  const FILTER_OPTIONS: { label: string; value: InboxFilter }[] = useMemo(
    () => [
      { label: t('filterAll'), value: 'all' },
      { label: t('filterUnread'), value: 'unread' },
    ],
    [t]
  );

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<InboxFilter>('all');
  // The "Important · N" chip: only the chats the AI handed over.
  const [importantOnly, setImportantOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  // Contact-based filter (issue #272): exact match on the company field.
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);
  // Who the list is narrowed to (a user id, UNASSIGNED, or null).
  // Only meaningful when `showAssignee` — read through `assigneeFilter`
  // below so a filter can never survive, invisible, into a view that
  // has no control to clear it with.
  const [selectedAssignee, setSelectedAssignee] =
    useState<AssigneeFilter>(initialAssignee);
  const [members, setMembers] = useState<Profile[]>([]);
  const assigneeFilter: AssigneeFilter = showAssignee ? selectedAssignee : null;
  // Campaign inbox only: the account's broadcasts, for row labels and
  // the by-campaign filter. Null filter = every campaign.
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(
    null
  );
  // Chat tags (migration 075): main tags and sub-tags, OR logic — a chat
  // matches when its main tag or its sub-tag is picked.
  const {
    tags: chatTagRows,
    tree: chatTagTree,
    reload: reloadChatTags,
  } = useChatTags();
  const [selectedChatTagIds, setSelectedChatTagIds] = useState<string[]>(() => [
    ...(initialChatTagIds ?? []),
  ]);
  // Rows tagged with ids the loaded list doesn't have: an admin probably
  // added the tag since the list was cached (up to five minutes ago).
  // Read the list again, once per id, as the chat header does; until
  // then those rows show untagged and the filter lacks the tag.
  const unknownChatTagIds = useMemo(() => {
    if (chatTagRows === null) return '';
    const ids = new Set<string>();
    for (const c of conversations) {
      for (const id of [c.chat_tag_id, c.chat_sub_tag_id]) {
        if (id && !chatTagTree.byId.has(id)) ids.add(id);
      }
    }
    return [...ids].sort().join(',');
  }, [conversations, chatTagRows, chatTagTree]);
  const chatTagsReloadedFor = useRef(new Set<string>());
  useEffect(() => {
    if (!unknownChatTagIds) return;
    const fresh = unknownChatTagIds
      .split(',')
      .filter((id) => !chatTagsReloadedFor.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) chatTagsReloadedFor.current.add(id);
    void reloadChatTags();
  }, [unknownChatTagIds, reloadChatTags]);
  // Only ids still in the tree count: a tag another admin deleted
  // meanwhile would otherwise keep filtering on an id no chat carries,
  // with no chip left to clear it. Keyed on the joined ids so a tag
  // reload with the same selection does not refetch the first page.
  const chatTagFilterKey = useMemo(() => {
    const known = new Set<string>();
    for (const main of chatTagTree.mains) {
      known.add(main.id);
      for (const sub of main.subs) known.add(sub.id);
    }
    return selectedChatTagIds.filter((id) => known.has(id)).join(',');
  }, [selectedChatTagIds, chatTagTree]);
  const chatTagFilterIds = useMemo<readonly string[]>(
    () => (chatTagFilterKey ? chatTagFilterKey.split(',') : NO_CHAT_TAGS),
    [chatTagFilterKey]
  );

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` — so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value — the very next render updates the ref for any
  // subsequent async completion.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  // What the server-side query asks. Memoised so the fetch effect
  // refires only when one of these actually changes.
  const listParams = useMemo<ListQueryParams>(
    () => ({
      restrictToUserId,
      restrictToChannelIds,
      restrictToConversationIds,
      campaignOnly,
      aiLive,
      status: filter,
      chatTagIds: chatTagFilterIds,
      assignee: assigneeFilter,
      campaignId: campaignOnly ? selectedCampaignId : null,
    }),
    [
      restrictToUserId,
      restrictToChannelIds,
      restrictToConversationIds,
      campaignOnly,
      aiLive,
      filter,
      chatTagFilterIds,
      assigneeFilter,
      selectedCampaignId,
    ]
  );
  // Read by loadMore / the delta resync, which must not refire when the
  // params change — the first-page effect below owns that.
  const listParamsRef = useRef(listParams);
  useEffect(() => {
    listParamsRef.current = listParams;
  });

  // Keyset pagination state. `generationRef` ticks on every first-page
  // load so an in-flight loadMore / delta for the previous filters
  // can't append rows that no longer belong.
  const generationRef = useRef(0);
  const cursorRef = useRef<ConversationCursor | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  // Bumped on each successful page so the bottom sentinel re-observes
  // (an IntersectionObserver only reports *changes*; a sentinel still
  // on screen after a short page needs a fresh observer to fire again).
  const [pageCount, setPageCount] = useState(0);
  // Forces a first-page reload when a delta turns out too big.
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const generation = ++generationRef.current;

    (async () => {
      const [{ data, error }, attention] = await Promise.all([
        conversationsQuery(listParams, {}),
        conversationsQuery(listParams, { attention: true }),
      ]);

      if (cancelled || generation !== generationRef.current) return;

      if (error) {
        logFetchError('Failed to fetch conversations:', error);
        setLoading(false);
        return;
      }

      const page = normalizeConversations(data ?? []);
      // The cursor is the page's alone; the pinned rows ride along.
      const cursor = nextConversationCursor(page);
      if (attention.error) {
        logFetchError(
          'Failed to fetch chats needing attention:',
          attention.error
        );
      }
      const rows = appendConversationPage(
        page,
        normalizeConversations(attention.data ?? [])
      );
      cursorRef.current = cursor;
      setHasMore(cursor !== null);
      setPageCount((n) => n + 1);
      onConversationsLoadedRef.current(rows, { mode: 'replace', cursor });
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a full refetch
    // (manual refresh, or a resync with no watermark to delta from).
  }, [enabled, resyncToken, reloadNonce, listParams]);

  const loadMore = useCallback(async () => {
    const cursor = cursorRef.current;
    if (!cursor || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const generation = generationRef.current;
    try {
      const { data, error } = await conversationsQuery(listParamsRef.current, {
        cursor,
      });
      if (generation !== generationRef.current) return;
      if (error) {
        logFetchError('Failed to fetch more conversations:', error);
        return;
      }
      const rows = normalizeConversations(data ?? []);
      const next = nextConversationCursor(rows);
      cursorRef.current = next;
      setHasMore(next !== null);
      setPageCount((n) => n + 1);
      onConversationsLoadedRef.current(rows, { mode: 'append', cursor: next });
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, []);

  // Delta resync: only the rows changed since the watermark. Keyed on
  // the token alone (the ref remembers which one was handled) so a
  // re-render never re-sends it.
  const deltaToken = deltaSync?.token ?? 0;
  const deltaSince = deltaSync?.since ?? null;
  const handledDeltaTokenRef = useRef(deltaToken);
  useEffect(() => {
    if (deltaToken === handledDeltaTokenRef.current) return;
    handledDeltaTokenRef.current = deltaToken;
    if (!enabled || !deltaSince) return;
    const generation = generationRef.current;

    (async () => {
      const { data, error } = await conversationsQuery(listParamsRef.current, {
        since: deltaSince,
      });
      if (generation !== generationRef.current) return;
      if (error) {
        logFetchError('Failed to resync conversations:', error);
        return;
      }
      const rows = normalizeConversations(data ?? []);
      if (rows.length >= DELTA_LIMIT) {
        // Too much changed to merge piecemeal — start over.
        setReloadNonce((n) => n + 1);
        return;
      }
      onConversationsLoadedRef.current(rows, { mode: 'delta' });
    })();
  }, [deltaToken, deltaSince, enabled]);

  // Campaign names for the row label and the filter. Not cached: a
  // campaign is usually created minutes before someone comes here to
  // watch its replies, and the list is small.
  useEffect(() => {
    if (!campaignOnly) return;
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from('broadcasts')
        .select('id, name')
        .order('created_at', { ascending: false });
      if (!cancelled) setCampaigns((data as CampaignOption[] | null) ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [campaignOnly]);

  const campaignsById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of campaigns) m.set(c.id, c.name);
    return m;
  }, [campaigns]);

  // Account members, for the assignee labels and the by-agent filter.
  // Shares its cache entry with the thread's assign dropdown, so on a
  // normal inbox visit this costs nothing — the thread has usually
  // already asked. Only fetched for a viewer who can see other
  // people's chats; nobody else renders either affordance.
  // Scoped to the active workspace (RLS also returns the caller's own row
  // in every other one), and a bank guest is never listed.
  const { accountId } = useAuth();
  useEffect(() => {
    if (!showAssignee || !accountId) return;
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
            return [] as Profile[];
          }
          return ((data as Profile[] | null) ?? []).filter(
            (p) => !isBankGuest(p.account_role)
          );
        }
      ).catch(() => [] as Profile[]);
      if (!cancelled) setMembers(data);
    })();
    return () => {
      cancelled = true;
    };
  }, [showAssignee, accountId]);

  // Keyed by `user_id`, not `id` — `conversations.assigned_agent_id`
  // references auth.users, the same column the assign dropdown matches on.
  const membersByUserId = useMemo(() => {
    const m = new Map<string, Profile>();
    for (const p of members) m.set(p.user_id, p);
    return m;
  }, [members]);

  const memberName = useCallback(
    (userId: string) => {
      const p = membersByUserId.get(userId);
      return p?.full_name?.trim() || p?.email || t('unknown');
    },
    [membersByUserId, t]
  );

  // Company options are derived from the loaded conversations — there's no
  // separate companies table, and only companies with a live conversation
  // are worth offering as an inbox filter.
  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const filtered = useMemo(() => {
    let result = conversations.filter(hasMessages);

    if (filter === 'unread') {
      result = result.filter((c) => c.unread_count > 0);
    }

    if (chatTagFilterIds.length > 0) {
      result = result.filter((c) => matchesChatTagFilter(c, chatTagFilterIds));
    }

    if (assigneeFilter !== null) {
      result = result.filter((c) => matchesAssignee(c, assigneeFilter));
    }

    // Which of the two lists a chat is in. The fetch asked for the
    // right ones, but realtime adds and patches rows — the bot answers,
    // a person steps in — so keep the list honest.
    result = result.filter((c) => inCampaignInbox(c, aiLive) === campaignOnly);
    if (campaignOnly && selectedCampaignId !== null) {
      result = result.filter(
        (c) => c.campaign_broadcast_id === selectedCampaignId
      );
    }

    // Contact-based filter (exact company match).
    if (selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, { company: selectedCompany })
      );
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? '';
        const phone = c.contact?.phone?.toLowerCase() ?? '';
        const lastMsg = c.last_message_text?.toLowerCase() ?? '';
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
      });
    }

    return sortForInbox(result);
  }, [
    conversations,
    filter,
    chatTagFilterIds,
    search,
    selectedCompany,
    assigneeFilter,
    campaignOnly,
    aiLive,
    selectedCampaignId,
  ]);

  // Pinned chats the AI handed over, among those the filters show.
  const importantCount = useMemo(
    () => countNeedingAttention(filtered),
    [filtered]
  );
  // Off by itself once the last one is dealt with, so the list never
  // sits empty behind a chip that is no longer there.
  const showImportantOnly = importantOnly && importantCount > 0;
  const shown = useMemo(
    () => (showImportantOnly ? filtered.filter(needsAttention) : filtered),
    [filtered, showImportantOnly]
  );

  const toggleChatTag = useCallback((id: string) => {
    setSelectedChatTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  const clearAllFilters = useCallback(() => {
    setSelectedChatTagIds([]);
    setSelectedCompany(null);
    setSelectedAssignee(null);
    setSelectedCampaignId(null);
  }, []);

  const hasContactFilters =
    chatTagFilterIds.length > 0 ||
    selectedCompany !== null ||
    assigneeFilter !== null ||
    selectedCampaignId !== null;

  const campaignLabel =
    selectedCampaignId === null
      ? t('campaign')
      : (campaignsById.get(selectedCampaignId) ?? t('campaign'));

  /** Label for the by-agent trigger and its active-filter chip. */
  const assigneeLabel =
    assigneeFilter === null
      ? t('agent')
      : assigneeFilter === UNASSIGNED
        ? t('unassigned')
        : memberName(assigneeFilter);

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  // Stable for the memoised rows: the parent's handler changes identity
  // on every selection, which would otherwise re-render every row.
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  });
  const handleSelect = useCallback((conv: Conversation) => {
    onSelectRef.current(conv);
  }, []);

  // Infinite scroll: load the next page as the bottom sentinel nears
  // the viewport. Re-created after every page (see `pageCount`) so a
  // sentinel still visible — a short list, or client-side filters that
  // hide most of a page — keeps pulling until the list fills or ends.
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      },
      // Rooted on the ScrollArea viewport: a margin on the default
      // (document) root can't reach past the scroller's clipping, so
      // the prefetch distance would silently be zero.
      {
        root: el.closest('[data-slot="scroll-area-viewport"]'),
        rootMargin: '400px 0px',
      }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, pageCount, loading, loadMore]);

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed width on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="border-wa-divider bg-wa-panel flex h-full w-full flex-col border-r lg:w-80 2xl:w-96">
      {/* Search + Filter */}
      <div className="space-y-2 px-3 pt-3 pb-2">
        <div className="relative">
          <Search className="text-wa-icon pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2" />
          <Input
            value={search}
            onChange={handleSearchChange}
            placeholder={t('searchPlaceholder')}
            className="bg-wa-search text-wa-text placeholder:text-wa-text-secondary focus-visible:ring-wa-teal/40 h-9 rounded-lg border-0 pl-11 text-sm shadow-none focus-visible:ring-2"
          />
        </div>

        {/* All / Unread as WhatsApp's filter chips — one tap, and "Unread"
            is always in sight rather than behind a dropdown. Scrolls
            sideways when a locale's labels outgrow the column. */}
        <div className="-mx-3 flex [scrollbar-width:none] gap-1 overflow-x-auto px-3 [&::-webkit-scrollbar]:hidden">
          <div
            role="radiogroup"
            aria-label={t('filterAll')}
            className="flex gap-1"
          >
            {FILTER_OPTIONS.map((opt) => {
              const active = filter === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setFilter(opt.value)}
                  className={cn(
                    'h-7 shrink-0 rounded-full px-2.5 text-[12.5px] whitespace-nowrap transition-colors',
                    active
                      ? 'bg-wa-chip-active text-wa-teal font-medium'
                      : 'bg-wa-search text-wa-text-secondary hover:text-wa-text'
                  )}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          {/* The chats the AI handed to a person, pinned on top: a tap
              narrows the list to them. Only there while there are some. */}
          {importantCount > 0 && (
            <button
              type="button"
              aria-pressed={showImportantOnly}
              onClick={() => setImportantOnly((v) => !v)}
              className={cn(
                'h-7 shrink-0 rounded-full px-2.5 text-[12.5px] font-medium whitespace-nowrap transition-colors',
                showImportantOnly
                  ? 'bg-destructive text-white'
                  : 'border-destructive/40 text-destructive hover:bg-destructive/10 border'
              )}
            >
              {t('importantCount', { count: importantCount })}
            </button>
          )}
        </div>

        {chatTagTree.mains.length > 0 ||
        (campaignOnly && campaigns.length > 0) ||
        showAssignee ||
        companies.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {chatTagTree.mains.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  className={cn(
                    FACET_TRIGGER,
                    chatTagFilterIds.length > 0
                      ? FACET_TRIGGER_ACTIVE
                      : FACET_TRIGGER_IDLE
                  )}
                >
                  {t('chatTag')}
                  {chatTagFilterIds.length > 0 && (
                    <span className="bg-wa-green text-wa-green-fg flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold">
                      {chatTagFilterIds.length}
                    </span>
                  )}
                  <ChevronDown className="h-3 w-3 shrink-0" />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="border-border bg-popover max-h-64 w-56 overflow-y-auto"
                >
                  {chatTagTree.mains.flatMap((main) => [
                    <DropdownMenuCheckboxItem
                      key={main.id}
                      checked={chatTagFilterIds.includes(main.id)}
                      onCheckedChange={() => toggleChatTag(main.id)}
                      className="text-popover-foreground text-sm"
                    >
                      <ChatTagOption color={main.color} name={main.name} />
                    </DropdownMenuCheckboxItem>,
                    // Sub-tags sit indented under their main tag.
                    ...main.subs.map((sub) => (
                      <DropdownMenuCheckboxItem
                        key={sub.id}
                        checked={chatTagFilterIds.includes(sub.id)}
                        onCheckedChange={() => toggleChatTag(sub.id)}
                        className="text-popover-foreground pl-6 text-sm"
                      >
                        <ChatTagOption color={sub.color} name={sub.name} />
                      </DropdownMenuCheckboxItem>
                    )),
                  ])}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {campaignOnly && campaigns.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  className={cn(
                    FACET_TRIGGER,
                    'max-w-48',
                    selectedCampaignId !== null
                      ? FACET_TRIGGER_ACTIVE
                      : FACET_TRIGGER_IDLE
                  )}
                >
                  <Radio className="h-3 w-3 shrink-0" />
                  <span className="truncate">{campaignLabel}</span>
                  <ChevronDown className="h-3 w-3 shrink-0" />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="border-border bg-popover max-h-64 w-64 overflow-y-auto"
                >
                  <DropdownMenuItem
                    onClick={() => setSelectedCampaignId(null)}
                    className={cn(
                      'text-sm',
                      selectedCampaignId === null
                        ? 'text-primary'
                        : 'text-popover-foreground'
                    )}
                  >
                    {t('allCampaigns')}
                  </DropdownMenuItem>
                  {campaigns.map((c) => (
                    <DropdownMenuItem
                      key={c.id}
                      onClick={() => setSelectedCampaignId(c.id)}
                      className={cn(
                        'text-sm',
                        selectedCampaignId === c.id
                          ? 'text-primary'
                          : 'text-popover-foreground'
                      )}
                    >
                      <span className="truncate">{c.name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {showAssignee && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  className={cn(
                    FACET_TRIGGER,
                    'max-w-40',
                    assigneeFilter !== null
                      ? FACET_TRIGGER_ACTIVE
                      : FACET_TRIGGER_IDLE
                  )}
                >
                  <UserRound className="h-3 w-3 shrink-0" />
                  <span className="truncate">{assigneeLabel}</span>
                  <ChevronDown className="h-3 w-3 shrink-0" />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="border-border bg-popover max-h-64 w-56 overflow-y-auto"
                >
                  <DropdownMenuItem
                    onClick={() => setSelectedAssignee(null)}
                    className={cn(
                      'text-sm',
                      assigneeFilter === null
                        ? 'text-primary'
                        : 'text-popover-foreground'
                    )}
                  >
                    {t('allAgents')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => setSelectedAssignee(UNASSIGNED)}
                    className={cn(
                      'text-sm',
                      assigneeFilter === UNASSIGNED
                        ? 'text-primary'
                        : 'text-popover-foreground'
                    )}
                  >
                    {t('unassigned')}
                  </DropdownMenuItem>
                  {members.map((m) => (
                    <DropdownMenuItem
                      key={m.user_id}
                      onClick={() => setSelectedAssignee(m.user_id)}
                      className={cn(
                        'text-sm',
                        assigneeFilter === m.user_id
                          ? 'text-primary'
                          : 'text-popover-foreground'
                      )}
                    >
                      <span className="truncate">{memberName(m.user_id)}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {companies.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  className={cn(
                    FACET_TRIGGER,
                    'max-w-40',
                    selectedCompany ? FACET_TRIGGER_ACTIVE : FACET_TRIGGER_IDLE
                  )}
                >
                  <span className="truncate">
                    {selectedCompany ?? t('company')}
                  </span>
                  <ChevronDown className="h-3 w-3 shrink-0" />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="border-border bg-popover max-h-64 w-56"
                >
                  <DropdownMenuItem
                    onClick={() => setSelectedCompany(null)}
                    className={cn(
                      'text-sm',
                      selectedCompany === null
                        ? 'text-primary'
                        : 'text-popover-foreground'
                    )}
                  >
                    {t('allCompanies')}
                  </DropdownMenuItem>
                  {companies.map((co) => (
                    <DropdownMenuItem
                      key={co}
                      onClick={() => setSelectedCompany(co)}
                      className={cn(
                        'text-sm',
                        selectedCompany === co
                          ? 'text-primary'
                          : 'text-popover-foreground'
                      )}
                    >
                      <span className="truncate">{co}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        ) : null}

        {hasContactFilters && (
          <div className="flex flex-wrap items-center gap-1">
            {chatTagFilterIds.map((id) => {
              const tag = chatTagTree.byId.get(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleChatTag(id)}
                  className={ACTIVE_FILTER_CHIP}
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: chatTagColor(tag?.color) }}
                  />
                  <span className="max-w-24 truncate">
                    {tag?.name ?? t('chatTag')}
                  </span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCampaignId !== null && (
              <button
                onClick={() => setSelectedCampaignId(null)}
                className={ACTIVE_FILTER_CHIP}
              >
                <Radio className="h-3 w-3 shrink-0" />
                <span className="max-w-32 truncate">{campaignLabel}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            {assigneeFilter !== null && (
              <button
                onClick={() => setSelectedAssignee(null)}
                className={ACTIVE_FILTER_CHIP}
              >
                <UserRound className="h-3 w-3 shrink-0" />
                <span className="max-w-24 truncate">{assigneeLabel}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            {selectedCompany && (
              <button
                onClick={() => setSelectedCompany(null)}
                className={ACTIVE_FILTER_CHIP}
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={clearAllFilters}
              className="text-wa-teal px-1 text-[11px] font-medium hover:underline"
            >
              {t('clearAll')}
            </button>
          </div>
        )}
      </div>

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="border-wa-green h-5 w-5 animate-spin rounded-full border-2 border-t-transparent" />
          </div>
        ) : shown.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-wa-text-secondary text-sm">
              {/* An empty Campaign inbox says where the chats went. */}
              {campaignOnly
                ? t(aiLive ? 'campaignEmpty' : 'campaignBotOff')
                : t('noConversations')}
            </p>
          </div>
        ) : (
          <div className="flex flex-col">
            {shown.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={conv.id === activeConversationId}
                onSelect={handleSelect}
                t={t}
                today={today}
                locale={locale}
                showAssignee={showAssignee}
                memberName={memberName}
                chatTagTree={chatTagTree}
                sharedBank={sharedBanks?.get(conv.id) ?? null}
                numberName={
                  // The number the chat sends from: a person's pin
                  // (migration 061), else the one it is on.
                  numberNames && (conv.send_channel_id || conv.channel_id)
                    ? (numberNames.get(
                        (conv.send_channel_id || conv.channel_id) as string
                      ) ?? null)
                    : null
                }
                campaignName={
                  campaignOnly && conv.campaign_broadcast_id
                    ? (campaignsById.get(conv.campaign_broadcast_id) ?? null)
                    : null
                }
              />
            ))}
          </div>
        )}
        {!loading && hasMore && (
          <div
            ref={sentinelRef}
            className="flex items-center justify-center py-4"
            role="status"
            aria-busy={loadingMore}
          >
            {loadingMore && (
              <div className="border-wa-green h-4 w-4 animate-spin rounded-full border-2 border-t-transparent" />
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

/** A chat tag in the filter menu: its colour dot and its name. */
function ChatTagOption({ color, name }: { color: string; name: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: chatTagColor(color) }}
      />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** The chat-tag / campaign / agent / company dropdowns. */
const FACET_TRIGGER =
  'inline-flex h-7 items-center justify-center gap-1 rounded-full border px-2.5 text-xs transition-colors';
const FACET_TRIGGER_IDLE =
  'border-wa-divider text-wa-text-secondary hover:bg-wa-row-hover hover:text-wa-text';
const FACET_TRIGGER_ACTIVE =
  'border-transparent bg-wa-chip-active text-wa-teal font-medium';
/** A removable "this filter is on" chip. */
const ACTIVE_FILTER_CHIP =
  'bg-wa-search text-wa-text hover:bg-wa-row-active inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]';

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  t: ReturnType<typeof useTranslations>;
  /** Local midnight of the current day; the row's timestamp counts from it. */
  today: number;
  /** The app's locale, for the weekday names in the timestamp. */
  locale: string;
  /** Render the "who holds this" line. */
  showAssignee: boolean;
  /** Resolves a user id to a display name against the members list. */
  memberName: (userId: string) => string;
  /** The account's chat tags; changes identity only when they reload. */
  chatTagTree: ChatTagTree;
  /** Campaign inbox: the campaign this thread came from, if known. */
  campaignName?: string | null;
  /** Which WhatsApp number the thread is on, when there are several. */
  numberName?: string | null;
  /** The bank this chat was shared with the viewer under (migration 133). */
  sharedBank?: string | null;
}

// Memoised: a realtime patch to one conversation re-renders that row,
// not all of them. Every prop is stable across unrelated renders
// (`onSelect` via a ref, `memberName` via useCallback, `chatTagTree`
// memoised by useChatTags, `today` changes once a day).
const ConversationItem = memo(function ConversationItem({
  conversation,
  isActive,
  onSelect,
  t,
  today,
  locale,
  showAssignee,
  memberName,
  chatTagTree,
  campaignName = null,
  numberName = null,
  sharedBank = null,
}: ConversationItemProps) {
  const contact = conversation.contact;
  // Who answers for this chat: the assignee, or the owner when nobody
  // has taken it. The thread header runs the same rule with the
  // messages in hand, so the two screens never disagree.
  const handler = showAssignee ? resolveListHandler(conversation) : null;
  const handlerName = handler ? memberName(handler.userId) : null;
  const displayName = contact?.name || contact?.phone || t('unknown');
  // WhatsApp's unread treatment, and the only thing on the row in its
  // green: bold name and preview, a green time and a green count. A
  // read chat is plain. (The status used to be a dot in the accent
  // colour beside the count, so every open chat looked unread; the chat
  // tag pill there now is a tint, not a dot.)
  const unread = conversation.unread_count > 0;
  // The AI handed this chat to a person (migration 078): pinned on top
  // with a red label and a red edge until someone acts.
  const important = needsAttention(conversation);
  const chatTag = resolveConversationChatTags(conversation, chatTagTree);
  const chatTagText = chatTagLabel(chatTag.main, chatTag.sub);

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  // Right-click actions (the app-wide menu). Only what the row already
  // knows and what already exists: selecting, the `?c=` deep link the
  // inbox writes on selection, the customer page, and copying.
  const tMenu = useTranslations('ContextMenu');
  const router = useRouter();
  const rowRef = useRef<HTMLButtonElement>(null);
  useContextMenuItems(rowRef, () => {
    const copied = { copied: tMenu('copied'), failed: tMenu('copyFailed') };
    // Only the contact the RLS read returned: a visible chat whose
    // contact the viewer cannot read embeds none, and offers no link.
    const contactId = contact?.id;
    const items: ContextMenuEntry[] = [
      {
        id: 'open',
        label: tMenu('conversation.open'),
        icon: MessageSquare,
        onSelect: () => onSelect(conversation),
      },
      {
        id: 'openNewTab',
        // The current route, so /team-inbox stays /team-inbox.
        label: tMenu('conversation.openNewTab'),
        icon: SquareArrowOutUpRight,
        onSelect: () =>
          void window.open(
            `${window.location.pathname}?c=${encodeURIComponent(conversation.id)}`,
            '_blank',
            'noopener,noreferrer'
          ),
      },
    ];
    // A chat shared with a coordinator (migration 133) does not extend
    // the customer to them: `can_view_contact` is unchanged by a share.
    if (contactId && !sharedBank) {
      items.push({
        id: 'openCustomer',
        label: tMenu('conversation.openCustomer'),
        icon: UserRoundSearch,
        onSelect: () =>
          router.push(`/contacts/${encodeURIComponent(contactId)}`),
      });
    }
    if (contact?.phone || contact?.name) items.push({ type: 'separator' });
    const phone = contact?.phone;
    if (phone) {
      items.push({
        id: 'copyPhone',
        label: tMenu('conversation.copyPhone'),
        icon: Copy,
        onSelect: () => void copyWithToast(phone, copied),
      });
    }
    const name = contact?.name;
    if (name) {
      items.push({
        id: 'copyName',
        label: tMenu('conversation.copyName'),
        icon: Copy,
        onSelect: () => void copyWithToast(name, copied),
      });
    }
    return items;
  });

  const time = formatListTimestamp(
    conversation.last_message_at,
    new Date(today),
    { locale, yesterday: t('yesterday') }
  );

  // Everything beyond name and preview shares one quiet line, so a row
  // is never more than three lines tall.
  const hasMeta =
    !!numberName || !!campaignName || !!sharedBank || showAssignee;

  return (
    <button
      ref={rowRef}
      onClick={handleClick}
      aria-current={isActive ? 'true' : undefined}
      className={cn(
        'flex w-full items-center gap-3 pl-3 text-left transition-colors',
        isActive ? 'bg-wa-row-active' : 'hover:bg-wa-row-hover',
        important && 'shadow-[inset_3px_0_0_var(--destructive)]'
      )}
    >
      <ContactAvatar contact={contact} name={displayName} size={48} />

      {/* The divider runs under the text only, starting past the
          avatar, the way WhatsApp draws it. */}
      <div className="border-wa-divider @container min-w-0 flex-1 self-stretch border-b py-3 pr-3">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              'text-wa-text truncate text-[15px] leading-5',
              unread ? 'font-semibold' : 'font-normal'
            )}
          >
            {displayName}
          </span>
          <span className="flex shrink-0 items-baseline gap-1.5">
            {important && <ImportantBadge label={t('important')} />}
            <span
              className={cn(
                'text-xs',
                unread
                  ? 'text-wa-green font-semibold'
                  : 'text-wa-text-secondary'
              )}
            >
              {time}
            </span>
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p
            className={cn(
              'truncate text-[13.5px] leading-5',
              unread ? 'text-wa-text font-medium' : 'text-wa-text-secondary'
            )}
          >
            {conversation.last_message_text || t('noMessagesYet')}
          </p>
          {/* The chat tag sits on the right, beside the unread count:
              one pill, the main tag tinted in its colour and its
              sub-tag joined on fainter. It may take most of the line;
              the preview truncates first, and the count never does. */}
          <div className="flex max-w-[65%] min-w-0 shrink-0 items-center justify-end gap-1.5">
            {chatTag.main && chatTagText && (
              <ChatTagPill
                main={chatTag.main}
                sub={chatTag.sub}
                size="sm"
                title={chatTagText}
                className="min-w-0"
              />
            )}
            {unread && (
              <span className="bg-wa-green text-wa-green-fg flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] leading-none font-semibold">
                {conversation.unread_count > 99
                  ? '99+'
                  : conversation.unread_count}
              </span>
            )}
          </div>
        </div>

        {hasMeta && (
          <div className="text-wa-text-secondary mt-1 flex min-w-0 items-center gap-x-2 text-[11.5px] leading-4">
            {sharedBank && (
              <span className="text-wa-teal inline-flex shrink-0 items-center gap-1 font-medium">
                <Share2 className="h-3 w-3 shrink-0" />
                {t('sharedWithMe', { bank: sharedBank })}
              </span>
            )}

            {numberName && (
              <span className="inline-flex min-w-0 shrink items-center gap-1">
                <Phone className="h-3 w-3 shrink-0" />
                <span className="truncate">{numberName}</span>
              </span>
            )}

            {/* Campaign inbox: which campaign the chat came from. No
                bot state: every chat listed there is one the bot is
                answering, and a hand-off moves it to the Inbox. */}
            {campaignName && (
              <span className="inline-flex min-w-0 shrink items-center gap-1">
                <Radio className="h-3 w-3 shrink-0" />
                <span className="truncate">{campaignName}</span>
              </span>
            )}

            {/* Who answers for this thread. Only rendered for a viewer
                whose list mixes owners — see `showAssignee`.
                The name is whoever the row can actually name: the
                assignee, or its owner when nobody pressed Assign. The
                amber icon is the separate signal — it says the chat is
                still nobody's formally, the one thing on this screen
                that needs an action. A row with no name at all falls
                back to the word itself. */}
            {showAssignee && (
              <span
                className="inline-flex min-w-0 shrink items-center gap-1"
                title={
                  handler && handlerName
                    ? handler.kind === 'assigned'
                      ? t('assignedTo', { name: handlerName })
                      : t('ownedBy', { name: handlerName })
                    : t('unassigned')
                }
              >
                <UserRound
                  className={cn(
                    'h-3 w-3 shrink-0',
                    handler?.kind !== 'assigned' && 'text-warning'
                  )}
                />
                <span
                  className={cn(
                    'truncate',
                    handler?.kind !== 'assigned' && 'text-warning'
                  )}
                >
                  {handlerName ?? t('unassigned')}
                </span>
              </span>
            )}
          </div>
        )}
      </div>
    </button>
  );
});
