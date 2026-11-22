'use client';

import {
  Fragment,
  memo,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  REFERENCE_CACHE_TTL_MS,
  cachedQuery,
  membersCacheKey,
  teamRosterCacheKey,
} from '@/lib/client-cache';
import { useAuth } from '@/hooks/use-auth';
import { messagesCacheKey } from '@/lib/inbox/message-cache';
import { fetchLatestMessagePage } from '@/lib/inbox/message-page-fetch';
import { prefetchSession, sessionCache } from '@/lib/session-cache';
import {
  inboxListCacheKey,
  inboxListRowsKey,
  mayAppendOlderPage,
  writeThroughInboxList,
  type InboxListHandover,
  type InboxListPageOrigin,
  type InboxListSnapshot,
} from '@/lib/inbox/list-cache';
import { useCan } from '@/hooks/use-can';
import { isBankGuest } from '@/lib/auth/roles';
import {
  CONVERSATION_LIST_SELECT,
  UNASSIGNED,
  matchesAssignee,
  matchesContactFilters,
  normalizeConversations,
  type AssigneeFilter,
  type ConversationListItem,
} from '@/lib/inbox/conversations';
import { SavedViewsMenu } from '@/components/saved-views/saved-views-menu';
import {
  isEmptyInboxView,
  parseInboxView,
  type InboxViewFilters,
} from '@/lib/saved-views/inbox-view';
import {
  CAMPAIGN_INBOX_FILTER,
  INBOX_FILTER,
  inCampaignInbox,
} from '@/lib/inbox/campaign-inbox';
import { resolveListHandler } from '@/lib/inbox/handler';
import { ownPersonalChatsGroup } from '@/lib/inbox/personal-chats';
import {
  INBOX_SEARCH_DEBOUNCE_MS,
  INBOX_SEARCH_HIT_LIMIT,
  INBOX_SEARCH_LIMIT,
  INBOX_SEARCH_TEXT_LIMIT,
  mergeSearchRows,
  inboxSearchHits,
  inboxSearchTerm,
  isCloseMatch,
  matchesInboxSearchOrHit,
  sortByRank,
  type InboxSearchHits,
} from '@/lib/inbox/search';
import {
  chunkIds,
  conversationContactGroup,
  conversationTextGroup,
  isMissingSearchRpc,
  parseSearchHits,
  searchRpcTerm,
  type SearchHit,
} from '@/lib/contacts/fuzzy-search';
import { contactSearchFilter } from '@/lib/contacts/search';
import {
  inDepartmentView,
  mainInboxGroup,
  type DepartmentView,
  type InboxDepartment,
} from '@/lib/inbox/departments';
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
import {
  INSIGHT_FILTERS,
  PIN_LIMIT,
  applyHandled,
  hasAttentionPin,
  insightFilterBounds,
  isPinned,
  matchesInsightFilters,
  pinnedSummary,
  rowHasMetaLine,
  rowPinLabel,
  rowSignals,
  sortWithPins,
  type InsightFilter,
} from '@/lib/inbox/insights';
import { paletteFor, swatchOf, type Swatch } from '@/lib/insights/palette';
import { useInsightSettings } from '@/hooks/use-insight-settings';
import { InsightLegend } from '@/components/insights/insight-legend';
import { toast } from 'sonner';
import { ImportantBadge } from './important-badge';
import { InsightChips } from './insight-badge';
import { showsSalesInsights } from '@/lib/hr/sales-only';
import { HrRowTags, HrStaffRing } from '@/components/hr/hr-row';
import { TeamViewSwitch } from '@/components/layout/team-view-switch';
import {
  applyHrQueryOps,
  HR_EMBED,
  HR_LIST_DEFAULTS,
  hrQueryOps,
  hrSelectEmbeds,
  hrChangeAction,
  matchesHrFilters,
  type HrListFilters,
  type HrListRow,
} from '@/lib/hr/list-filters';
import { scopedChangeBindings } from '@/lib/realtime/scoped-changes';
import { formatListTimestamp } from '@/lib/inbox/list-time';
import {
  chatTagFilterOrGroup,
  chatTagLabel,
  matchesChatTagFilter,
  resolveConversationChatTags,
  type ChatTagTree,
} from '@/lib/chat-tags/tree';
import { chatTagColor } from '@/lib/chat-tags/style';
import { useChatTags } from '@/hooks/use-chat-tags';
import { cn } from '@/lib/utils';
import type { Profile } from '@/types';
import {
  Search,
  ChevronDown,
  X,
  UserRound,
  UserPlus,
  Radio,
  Phone,
  Share2,
  Smartphone,
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
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ConfirmDialog } from '@/components/ui-ext/confirm-dialog';
import { MemberPresenceDot } from './thread-presence';
import { RowChatTags } from './row-chat-tags';
import { assignableMembers, assignConversation } from '@/lib/inbox/assign';
import {
  rowAssignee,
  rowHasDetailLine,
  rowOffersAssign,
} from '@/lib/inbox/row-layout';
import { isShareOnlyViewer } from '@/lib/coordinators/ui';
import type { AccountRole } from '@/lib/auth/roles';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useOverflowEnd } from '@/hooks/use-overflow-end';
import { ContactAvatar } from './contact-avatar';
import { NewChatButton } from './new-chat-button';

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
  onSelect: (conversation: ConversationListItem) => void;
  /** Opens a chat by id: the "New chat" button's target. Without it,
   *  or for a viewer or bank guest, there is no button. */
  onOpenConversationById?: (conversationId: string) => void;
  /**
   * A row's Assign wrote a new assignee (the page patches its copy).
   * Without it, rows offer no Assign.
   */
  onAssignChange?: (conversationId: string, userId: string | null) => void;
  conversations: ConversationListItem[];
  onConversationsLoaded: (
    conversations: ConversationListItem[],
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
   * /team-inbox rather than /inbox: part of the list's session-cache
   * key, so the two views never show each other's rows.
   */
  teamView?: boolean;
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
   * /inbox: the viewer, whose list leaves out other people's personal
   * chats (migration 191). `null` (the Team inbox) lists all RLS returns.
   */
  ownPersonalChatsOf?: string | null;
  /**
   * Which department slice the list shows (migration 192): one
   * department's chats, or the main inboxes' (no department chats but
   * the viewer's own). Undefined asks nothing of the column.
   */
  departmentView?: DepartmentView;
  /**
   * The HR inbox's filters (lib/hr/list-filters.ts). Read only in the
   * HR department view; undefined there means HR_LIST_DEFAULTS.
   */
  hrFilters?: HrListFilters;
  /**
   * The HR screens' list header (components/hr/hr-list-header.tsx): the
   * title above the search and the HR filters below it. When set, the
   * generic All/Unread chips and the agent filter, which it replaces,
   * are hidden and do not narrow the list.
   */
  hrHeader?: { title: ReactNode; controls: ReactNode };
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
  /**
   * Seeds the Smart insights filters (`?insight=`); ignored while the
   * workspace has signals off.
   */
  initialInsightFilters?: readonly InsightFilter[];
  /** Seeds the Unread filter (`?filter=unread`). */
  initialUnread?: boolean;
  /** Seeds the Pinned chip (`?pinned=1`). */
  initialPinned?: boolean;
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
const NO_IDS: readonly string[] = [];

/** Everything the server-side query depends on. */
interface ListQueryParams {
  restrictToUserId: string | null;
  restrictToChannelIds: readonly string[];
  restrictToConversationIds: readonly string[];
  ownPersonalChatsOf: string | null;
  /** The department to list, or null for the main inboxes. */
  department: InboxDepartment | null;
  /**
   * Main inboxes: the viewer whose own department chats stay listed
   * ('' while unknown: none do); null asks nothing of the column.
   */
  mainInboxOf: string | null;
  /** Main inboxes: the department whose chats stay listed (below admin). */
  mainInboxDepartment: InboxDepartment | null;
  campaignOnly: boolean;
  aiLive: boolean;
  status: InboxFilter;
  /** Chat tags (main or sub) to narrow to; empty = every chat. */
  chatTagIds: readonly string[];
  assignee: AssigneeFilter;
  campaignId: string | null;
  /** Smart insights filters; always empty while signals are off. */
  insightFilters: readonly InsightFilter[];
  /**
   * The search, debounced and cleaned ('' = no search), and the contacts
   * it found. Pushed into the query so a chat beyond the loaded pages is
   * found (search.ts).
   */
  search: string;
  searchContactIds: readonly string[];
  /** The HR department view's filters and viewer; null in every other view. */
  hr: HrQuery | null;
}

interface HrQuery {
  filters: HrListFilters;
  viewerId: string | null;
}

/** A list row; only the HR view's select carries `hr`. */
type HrConversationRow = ConversationListItem & { hr?: HrListRow | null };

/** Whether the workspace has Smart insights signals on, once known. */
type SignalsMode = 'unknown' | 'on' | 'off';

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
    /**
     * The attention pins (Smart insights, migration 153): chats a signal
     * pinned until handled, under the same filters, read beside the
     * first page like `attention`, longest waiting first.
     */
    pinned?: boolean;
    /**
     * Which half of a search this read is: the chats of the found
     * contacts (`ids`, one chunk of them), or the chats whose last
     * message holds the term. Two reads, merged by `mergeSearchRows`,
     * because in one group ordered by recency the message matches
     * crowded the contact matches out. The attention and pin reads are
     * empty during a search: the merged list is the answer.
     */
    searchPart?:
      { part: 'contacts'; ids: readonly string[] } | { part: 'text' };
  }
) {
  const supabase = createClient();
  // Not on a delta, like the other facets: the held rows are re-matched
  // client-side (matchesInboxSearchOrHit).
  const searching = !opts.since && !!p.search;
  // The HR view adds its embeds; a delta takes the plain one (no
  // `!inner`), so a row that left the filters comes back to be dropped.
  // Typed as the base select: the row type stays ConversationListItem,
  // and the extra `hr` is read through HrConversationRow.
  const select = (
    p.hr
      ? `${CONVERSATION_LIST_SELECT},${opts.since ? HR_EMBED : hrSelectEmbeds(p.hr.filters)}`
      : CONVERSATION_LIST_SELECT
  ) as typeof CONVERSATION_LIST_SELECT;
  let query = supabase.from('conversations').select(select);
  const groups: (string | null)[] = [];
  // One half of the search (see searchPart), beside the view's groups,
  // so every view filter still applies.
  if (searching && opts.searchPart) {
    groups.push(
      opts.searchPart.part === 'contacts'
        ? conversationContactGroup(opts.searchPart.ids)
        : conversationTextGroup(p.search)
    );
  }
  if (searching && (opts.attention || opts.pinned || !opts.searchPart)) {
    query = query.is('id', null);
  }

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
  if (p.ownPersonalChatsOf) {
    groups.push(ownPersonalChatsGroup(p.ownPersonalChatsOf));
  }
  if (p.department) {
    query = query.eq('inbox_department', p.department);
  } else if (p.mainInboxOf !== null) {
    groups.push(
      p.mainInboxOf
        ? mainInboxGroup(p.mainInboxOf, p.mainInboxDepartment)
        : 'inbox_department.is.null'
    );
  }
  // The HR filters are facets: not on a delta (matchesHrFilters re-checks).
  if (p.hr && !opts.since) {
    const hr = applyHrQueryOps(query, hrQueryOps(p.hr.filters, p.hr.viewerId));
    query = hr.query;
    groups.push(...hr.orGroups);
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
    // Smart insights filters, one `column >= min` each (insights.ts).
    for (const { column, min } of insightFilterBounds(p.insightFilters)) {
      query = query.gte(column, min);
    }
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
  if (opts.pinned) {
    return query
      .not('insight_attention_at', 'is', null)
      .order('insight_attention_at', { ascending: true })
      .order('id', { ascending: false })
      .limit(PIN_LIMIT);
  }
  return query
    .order('last_message_at', { ascending: false, nullsFirst: true })
    .order('id', { ascending: false })
    .limit(
      !searching
        ? CONVERSATION_PAGE_SIZE
        : opts.searchPart?.part === 'text'
          ? INBOX_SEARCH_TEXT_LIMIT
          : INBOX_SEARCH_LIMIT
    );
}

/**
 * A search's first page: the chats of the found contacts (the ids in
 * chunks, so the URL stays short) and the chats whose last message holds
 * the term, merged with the contacts first in rank order.
 */
async function searchConversations(p: ListQueryParams) {
  const reads = [
    ...chunkIds(p.searchContactIds).map((ids) =>
      conversationsQuery(p, { searchPart: { part: 'contacts', ids } })
    ),
    conversationsQuery(p, { searchPart: { part: 'text' } }),
  ];
  const results = await Promise.all(reads);
  const failed = results.find((r) => r.error);
  if (failed?.error) return { page: null, error: failed.error };
  const text = results[results.length - 1];
  const contacts = results.slice(0, -1);
  const page = mergeSearchRows(
    contacts.flatMap((r) => normalizeConversations(r.data ?? [])),
    normalizeConversations(text.data ?? []),
    p.searchContactIds
  );
  return { page, error: null };
}

/**
 * The contacts a search term finds, ranked: migration 193's close-match
 * RPC (as the caller, so RLS decides), else, before 193 or for a term
 * too short for it, the plain ilike filter, every row exact.
 */
async function fetchInboxSearchHits(term: string): Promise<SearchHit[]> {
  const supabase = createClient();
  const rpcTerm = searchRpcTerm(term);
  if (rpcTerm) {
    const { data, error } = await supabase.rpc('search_contacts', {
      p_term: rpcTerm,
      p_limit: INBOX_SEARCH_HIT_LIMIT,
    });
    if (!error) return parseSearchHits(data);
    // Any other failure: no contacts, and the message match still runs
    // (the contact picker does the same).
    if (!isMissingSearchRpc(error)) {
      logFetchError('Failed to search contacts:', error);
      return [];
    }
  }
  const or = contactSearchFilter(term);
  if (!or) return [];
  const { data, error } = await supabase
    .from('contacts')
    .select('id')
    .or(or)
    .limit(INBOX_SEARCH_HIT_LIMIT);
  if (error) {
    logFetchError('Failed to search contacts:', error);
    return [];
  }
  return (data ?? []).map((r) => ({ contactId: r.id, score: 1, exact: true }));
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
const NO_INSIGHT_FILTERS: readonly InsightFilter[] = [];

export function ConversationList({
  activeConversationId,
  onSelect,
  onOpenConversationById,
  onAssignChange,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
  deltaSync,
  enabled = true,
  teamView = false,
  restrictToUserId = null,
  restrictToChannelIds = NO_CHANNELS,
  restrictToConversationIds = NO_CHANNELS,
  ownPersonalChatsOf = null,
  departmentView,
  hrFilters,
  hrHeader,
  sharedBanks = null,
  showAssignee: showAssigneeProp = false,
  numberNames = null,
  campaignOnly = false,
  aiLive = false,
  initialAssignee = null,
  initialChatTagIds,
  initialInsightFilters,
  initialUnread = false,
  initialPinned = false,
}: ConversationListProps) {
  const t = useTranslations('Inbox.conversationList');
  const tRowsList = useTranslations('InboxRows');
  const tThread = useTranslations('Inbox.messageThread');
  const tInsights = useTranslations('InsightsUi.list');
  const tSearch = useTranslations('ContactSearch');
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
  // What the server is asked: the box, cleaned, after a pause in typing.
  // Clearing the box returns to the plain list at once.
  const [serverSearch, setServerSearch] = useState('');
  useEffect(() => {
    const term = inboxSearchTerm(search);
    if (!term) {
      setServerSearch('');
      return;
    }
    const id = setTimeout(
      () => setServerSearch(term),
      INBOX_SEARCH_DEBOUNCE_MS
    );
    return () => clearTimeout(id);
  }, [search]);
  // The contacts that term finds; the list is asked for once they are
  // in. A response for a term since replaced is dropped.
  const [searchHits, setSearchHits] = useState<InboxSearchHits | null>(null);
  useEffect(() => {
    if (!serverSearch) {
      setSearchHits(null);
      return;
    }
    let stale = false;
    void fetchInboxSearchHits(serverSearch).then((hits) => {
      if (!stale) setSearchHits(inboxSearchHits(serverSearch, hits));
    });
    return () => {
      stale = true;
    };
  }, [serverSearch]);
  // Hits answering the term in the box right now, for the held rows'
  // match, rank and marks; none while a newer term is on its way.
  const liveHits =
    searchHits && searchHits.term === inboxSearchTerm(search)
      ? searchHits
      : null;
  const [filter, setFilter] = useState<InboxFilter>(
    initialUnread ? 'unread' : 'all'
  );
  // The "Important · N" chip: only the chats the AI handed over.
  const [importantOnly, setImportantOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  // Contact-based filter (issue #272): exact match on the company field.
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);
  // The HR header replaces the All/Unread chips and the agent filter;
  // rows still show who holds each thread (`showAssigneeProp`).
  const hrHeaderOn = hrHeader !== undefined;
  const showAssignee = showAssigneeProp && !hrHeaderOn;
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
  // Smart insights (docs/jev-insights.md): the badge, the three filters
  // and the Urgent pin exist only while the workspace has signals on.
  // Off, the filters read as empty and no Urgent query is made, so the
  // list fetches and renders exactly as it did before.
  const { settings: insightSettings, loading: insightLoadingRaw } =
    useInsightSettings();
  // The HR screens never show them (lead signals are a sales tool):
  // there they read as switched off, filters, chips and pins included.
  const salesInsights = showsSalesInsights({ hrScreen: hrHeaderOn });
  const insightLoading = salesInsights && insightLoadingRaw;
  const signalsOn = salesInsights && !!insightSettings?.signalsEnabled;
  // Handled is the customer card's capability (agents and up): the RPC
  // refuses a viewer, so a viewer is never offered the button.
  const canSendMessages = useCan('send-messages');
  const [selectedInsightFilters, setSelectedInsightFilters] = useState<
    InsightFilter[]
  >(() => [...(initialInsightFilters ?? [])]);
  // Keyed on the joined names (in INSIGHT_FILTERS order) so toggling
  // back to the same set does not refetch. While the settings are still
  // loading the picked filters (a `?insight=hot` deep link) are taken
  // at their word, so the first page need not wait for the settings;
  // a workspace that turns out to have signals off drops them then.
  const insightFilterKey =
    signalsOn || insightLoading
      ? INSIGHT_FILTERS.filter((f) => selectedInsightFilters.includes(f)).join(
          ','
        )
      : '';
  const insightFilters = useMemo<readonly InsightFilter[]>(
    () =>
      insightFilterKey
        ? (insightFilterKey.split(',') as InsightFilter[])
        : NO_INSIGHT_FILTERS,
    [insightFilterKey]
  );
  // The Pinned chip's filter: only pinned chats (client-side, like
  // Important; the pins are always loaded beside the first page).
  const [pinnedOnly, setPinnedOnly] = useState(initialPinned);
  // Handled clicks still waiting for realtime: id -> the stamp handled.
  const [handled, setHandled] = useState<ReadonlyMap<string, string>>(
    () => new Map()
  );
  const toggleInsightFilter = useCallback((f: InsightFilter) => {
    setSelectedInsightFilters((prev) =>
      prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f]
    );
  }, []);
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
  // The filter chip row scrolls sideways; its right edge fades only
  // while chips are hidden past it.
  const [filterChipsRef, filterChipsOverflow] = useOverflowEnd();
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

  // The first page no longer waits for the insight settings (a round
  // trip of its own on a first or stale visit). Only the attention pins
  // need them: the fetch reads them beside the page when the settings
  // are already known, and otherwise appends them once they arrive.
  // Chips, colours and the pin sort follow `signalsOn` on their own.
  const signalsMode: SignalsMode = insightLoading
    ? 'unknown'
    : signalsOn
      ? 'on'
      : 'off';
  const signalsRef = useRef<{
    mode: SignalsMode;
    waiters: Set<(on: boolean) => void>;
  }>({ mode: signalsMode, waiters: new Set() });
  useEffect(() => {
    const s = signalsRef.current;
    s.mode = signalsMode;
    if (signalsMode === 'unknown') return;
    for (const resolve of s.waiters) resolve(signalsMode === 'on');
    s.waiters.clear();
  }, [signalsMode]);
  // Signals switched on or off once known (Settings saved meanwhile):
  // reload the first page with or without the pins, as before. The
  // first answer after loading is not a switch.
  const [lastKnownSignals, setLastKnownSignals] = useState<'on' | 'off' | null>(
    null
  );
  const [signalsEpoch, setSignalsEpoch] = useState(0);
  if (signalsMode !== 'unknown' && signalsMode !== lastKnownSignals) {
    setLastKnownSignals(signalsMode);
    if (lastKnownSignals !== null) setSignalsEpoch((n) => n + 1);
  }

  // What the server-side query asks. Memoised so the fetch effect
  // refires only when one of these actually changes.
  const department =
    departmentView && 'department' in departmentView
      ? departmentView.department
      : null;
  const mainInboxOf =
    departmentView && 'mainFor' in departmentView
      ? (departmentView.mainFor ?? '')
      : null;
  const mainInboxDepartment =
    departmentView && 'mainFor' in departmentView
      ? (departmentView.ownDepartment ?? null)
      : null;
  const { accountId, user, accountRole, profileLoading } = useAuth();
  const viewerId = user?.id ?? null;
  // Keyed by content, so a parent passing a fresh but equal object does
  // not refire the fetch.
  const hrFiltersKey =
    department === 'hr' ? JSON.stringify(hrFilters ?? HR_LIST_DEFAULTS) : null;
  const hrQuery = useMemo<HrQuery | null>(
    () =>
      hrFiltersKey === null
        ? null
        : { filters: JSON.parse(hrFiltersKey) as HrListFilters, viewerId },
    [hrFiltersKey, viewerId]
  );
  const listParams = useMemo<ListQueryParams>(
    () => ({
      restrictToUserId,
      restrictToChannelIds,
      restrictToConversationIds,
      ownPersonalChatsOf,
      department,
      mainInboxOf,
      mainInboxDepartment,
      campaignOnly,
      aiLive,
      status: filter,
      chatTagIds: chatTagFilterIds,
      assignee: assigneeFilter,
      campaignId: campaignOnly ? selectedCampaignId : null,
      insightFilters,
      // Asked only once the term's contacts are in (searchHits), so the
      // query never runs with the previous term's ids.
      search: searchHits?.term ?? '',
      searchContactIds: searchHits?.ids ?? NO_IDS,
      hr: hrQuery,
    }),
    [
      restrictToUserId,
      restrictToChannelIds,
      restrictToConversationIds,
      ownPersonalChatsOf,
      department,
      mainInboxOf,
      mainInboxDepartment,
      campaignOnly,
      aiLive,
      filter,
      chatTagFilterIds,
      assigneeFilter,
      selectedCampaignId,
      insightFilters,
      searchHits,
      hrQuery,
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
  // Ticks on every first-page hand-over (the cached snapshot, then the
  // fresh page, of one generation), so a loadMore started from the
  // cached cursor can't append onto the fresh page (mayAppendOlderPage).
  const deliveryRef = useRef(0);
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

  // HR view realtime (hr_conversations): the latest `hr` of each held
  // chat, laid over the rows. Tied to the params it was received under,
  // so a filter change starts with none.
  const [hrPatches, setHrPatches] = useState<{
    params: ListQueryParams | null;
    byId: ReadonlyMap<string, HrListRow | null>;
  }>({ params: null, byId: new Map() });
  const hrPatchById = hrPatches.params === listParams ? hrPatches.byId : null;
  const heldIdsRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    heldIdsRef.current = new Set(conversations.map((c) => c.id));
  }, [conversations]);
  const hrRefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onHrChange = useCallback(
    (conversationId: string, hr: HrListRow | null) => {
      const params = listParamsRef.current;
      if (!params.hr) return;
      const action = hrChangeAction(
        heldIdsRef.current.has(conversationId),
        hr,
        params.hr.filters,
        params.hr.viewerId
      );
      if (action === 'ignore') return;
      if (action === 'patch') {
        setHrPatches((prev) => {
          const byId = new Map(prev.params === params ? prev.byId : []);
          byId.set(conversationId, hr);
          return { params, byId };
        });
        return;
      }
      // Not held, but it may now belong here: reload the first page
      // (debounced).
      if (hrRefetchTimer.current !== null) return;
      hrRefetchTimer.current = setTimeout(() => {
        hrRefetchTimer.current = null;
        setReloadNonce((n) => n + 1);
      }, 1000);
    },
    []
  );
  const onHrChangeRef = useRef(onHrChange);
  useEffect(() => {
    onHrChangeRef.current = onHrChange;
  });
  const hrView = hrQuery !== null;
  useEffect(() => {
    if (!enabled || !hrView) return;
    const bindings = scopedChangeBindings(
      'hr_conversations',
      'account_id',
      accountId
    );
    if (!bindings) return;
    const supabase = createClient();
    let channel = supabase.channel(`inbox-hr-list:${accountId}`);
    for (const binding of bindings) {
      channel = channel.on('postgres_changes', binding, (payload) => {
        const row = (
          payload.eventType === 'DELETE' ? payload.old : payload.new
        ) as Partial<HrListRow & { conversation_id: string }>;
        if (!row.conversation_id) return;
        if (payload.eventType === 'DELETE') {
          onHrChangeRef.current(row.conversation_id, null);
          return;
        }
        // A partial row (no inbox / reply state) is not one to lay over.
        if (!row.inbox || !row.reply_state) return;
        onHrChangeRef.current(row.conversation_id, {
          inbox: row.inbox,
          stage_key: row.stage_key ?? null,
          topic: row.topic ?? null,
          urgent: !!row.urgent,
          upset: !!row.upset,
          reply_state: row.reply_state,
          outcome: row.outcome ?? null,
          closed_at: row.closed_at ?? null,
        });
      });
    }
    channel.subscribe();
    return () => {
      supabase.removeChannel(channel);
      if (hrRefetchTimer.current !== null) {
        clearTimeout(hrRefetchTimer.current);
        hrRefetchTimer.current = null;
      }
    };
  }, [enabled, hrView, accountId]);

  // The list view's session-cache entry (lib/inbox/list-cache.ts):
  // shown at once on a revisit, always revalidated below.
  // A search's results are not cached: one entry per typed term would
  // pile up, and the plain list's entry must not take search rows.
  const cacheKey = useMemo(
    () =>
      listParams.search
        ? null
        : inboxListCacheKey(accountId, viewerId, {
            ...listParams,
            teamView,
            hrFilters: listParams.hr?.filters ?? null,
          }),
    [accountId, viewerId, listParams, teamView]
  );
  // The last first page handed to the parent: its key, and the rows the
  // parent held then. The write-through below files the rows on screen
  // under that key only once the parent has re-rendered past them
  // (inboxListRowsKey), so it never files the previous view's rows,
  // or the previous cursor, under a new key.
  const handoverRef = useRef<InboxListHandover<ConversationListItem> | null>(
    null
  );
  const conversationsRef = useRef(conversations);
  useEffect(() => {
    conversationsRef.current = conversations;
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const generation = ++generationRef.current;
    const params = listParams;
    const key = cacheKey;
    // Known now: read the pins beside the page. Unknown: append them
    // once the settings arrive, so they never hold the page up.
    const startMode = signalsRef.current.mode;

    const deliver = (snap: InboxListSnapshot<ConversationListItem>) => {
      // A first page is newer than any patch laid over earlier rows.
      setHrPatches({ params: null, byId: new Map() });
      cursorRef.current = snap.cursor;
      setHasMore(snap.cursor !== null);
      setPageCount((n) => n + 1);
      deliveryRef.current += 1;
      handoverRef.current = { key, replaced: conversationsRef.current };
      onConversationsLoadedRef.current(snap.rows, {
        mode: 'replace',
        cursor: snap.cursor,
      });
      setLoading(false);
    };

    const fetchFirstPage = async (): Promise<
      InboxListSnapshot<ConversationListItem>
    > => {
      const [first, attention, pinned] = await Promise.all([
        params.search
          ? searchConversations(params)
          : conversationsQuery(params, {}).then(({ data, error }) => ({
              page: error ? null : normalizeConversations(data ?? []),
              error,
            })),
        // Empty during a search (see searchPart).
        conversationsQuery(params, { attention: true }),
        // Only with signals on: off, the first page is the two reads
        // it always was.
        startMode === 'on'
          ? conversationsQuery(params, { pinned: true })
          : null,
      ]);
      if (first.error || !first.page) {
        logFetchError('Failed to fetch conversations:', first.error!);
        throw new Error('conversations fetch failed');
      }
      const page = first.page;
      // The cursor is the page's alone; the pinned rows ride along. A
      // search is one page: no cursor, so no further pages.
      const cursor = params.search ? null : nextConversationCursor(page);
      if (attention.error) {
        logFetchError(
          'Failed to fetch chats needing attention:',
          attention.error
        );
      }
      if (pinned?.error) {
        logFetchError('Failed to fetch pinned chats:', pinned.error);
      }
      let rows = appendConversationPage(
        page,
        normalizeConversations(attention.data ?? [])
      );
      if (pinned) {
        rows = appendConversationPage(
          rows,
          normalizeConversations(pinned.data ?? [])
        );
      }
      return { rows, cursor };
    };

    (async () => {
      // A revisit: what this view showed last time, at once. The
      // parent already holding this view's rows (a resync) keeps them.
      const cached = key
        ? sessionCache.get<InboxListSnapshot<ConversationListItem>>(key)
        : undefined;
      if (cached && handoverRef.current?.key !== key) deliver(cached.value);

      let snap: InboxListSnapshot<ConversationListItem>;
      try {
        // Stored under its own key even if the view moved on meanwhile.
        snap = key
          ? await prefetchSession(key, fetchFirstPage, { force: true })
          : await fetchFirstPage();
      } catch {
        if (!cancelled && generation === generationRef.current) {
          setLoading(false);
        }
        return;
      }
      if (cancelled || generation !== generationRef.current) return;
      deliver(snap);

      if (startMode !== 'unknown') return;
      const on = await new Promise<boolean>((resolve) => {
        const s = signalsRef.current;
        if (s.mode === 'unknown') s.waiters.add(resolve);
        else resolve(s.mode === 'on');
      });
      if (!on || cancelled || generation !== generationRef.current) return;
      if (params.search) return;
      const pinned = await conversationsQuery(params, { pinned: true });
      if (cancelled || generation !== generationRef.current) return;
      if (pinned.error) {
        logFetchError('Failed to fetch pinned chats:', pinned.error);
        return;
      }
      // Folded in like a further page (de-duplicated, cursor kept);
      // the write-through below stores them with the rest.
      onConversationsLoadedRef.current(
        normalizeConversations(pinned.data ?? []),
        { mode: 'append', cursor: cursorRef.current }
      );
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a full refetch
    // (manual refresh, or a resync with no watermark to delta from).
    // `cacheKey` follows `listParams` (and the view).
  }, [enabled, resyncToken, reloadNonce, signalsEpoch, listParams, cacheKey]);

  // Write-through: every change the Inbox applies to these rows
  // (realtime, unread marks, further pages, deltas, the pins) lands in
  // the view's entry, so a revisit starts from what was last on screen.
  useEffect(() => {
    writeThroughInboxList(
      cacheKey,
      inboxListRowsKey(handoverRef.current, conversations),
      {
        rows: conversations,
        cursor: cursorRef.current,
      }
    );
  }, [conversations, cacheKey]);

  const loadMore = useCallback(async () => {
    const cursor = cursorRef.current;
    if (!cursor || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const origin: InboxListPageOrigin = {
      generation: generationRef.current,
      delivery: deliveryRef.current,
    };
    try {
      const { data, error } = await conversationsQuery(listParamsRef.current, {
        cursor,
      });
      if (
        !mayAppendOlderPage(origin, {
          generation: generationRef.current,
          delivery: deliveryRef.current,
        })
      ) {
        // The first page was replaced meanwhile (the fresh page over the
        // cached one). Its own cursor goes next: re-observe the sentinel,
        // whose fire during this call found loadingMoreRef held.
        if (origin.generation === generationRef.current) {
          setPageCount((n) => n + 1);
        }
        return;
      }
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
  // The HR screens hide the Agent filter (`showAssignee` is off there) but
  // their rows still name each chat's owner, so they need the list too.
  const needMembers = showAssignee || hrHeaderOn;
  useEffect(() => {
    if (!needMembers || !accountId) return;
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
  }, [needMembers, accountId]);

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

  // The rows' Assign menu: the thread header's rule exactly
  // (lib/inbox/assign.ts) — admins everyone, a team leader themselves
  // and the people they lead, never a deactivated member. Only where the
  // rows name who holds each chat (`showAssignee`, not the HR screens:
  // the HR panel assigns there). Who a leader leads shares the thread's
  // cache entry, so this normally costs nothing.
  const rowAssignOn = showAssignee && !!onAssignChange;
  const [leadableUserIds, setLeadableUserIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  useEffect(() => {
    if (!rowAssignOn || accountRole !== 'team_leader' || !viewerId) {
      setLeadableUserIds(new Set());
      return;
    }
    let cancelled = false;
    const leaderId = viewerId;
    (async () => {
      // Same key and same value shape as message-thread.tsx's query:
      // whichever runs first fills the entry for the other.
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
  }, [rowAssignOn, accountRole, viewerId]);
  const rowAssignableProfiles = useMemo<readonly Profile[]>(
    () =>
      rowAssignOn
        ? assignableMembers({
            accountRole: profileLoading ? null : accountRole,
            myUserId: viewerId,
            profiles: members,
            leadableUserIds,
          })
        : [],
    [
      rowAssignOn,
      profileLoading,
      accountRole,
      viewerId,
      members,
      leadableUserIds,
    ]
  );
  // The question the row's Assign asks, remembered with its chat; one
  // answered after the list moved on still writes to that chat only.
  const [pendingRowAssign, setPendingRowAssign] = useState<{
    conversationId: string;
    customer: string;
    userId: string;
    name: string;
  } | null>(null);
  const requestRowAssign = useCallback(
    (conv: ConversationListItem, userId: string, name: string) => {
      setPendingRowAssign({
        conversationId: conv.id,
        customer: conv.contact?.name || conv.contact?.phone || t('unknown'),
        userId,
        name,
      });
    },
    [t]
  );
  const confirmRowAssign = useCallback(async () => {
    const pending = pendingRowAssign;
    setPendingRowAssign(null);
    if (!pending) return;
    const result = await assignConversation(
      createClient(),
      pending.conversationId,
      pending.userId
    );
    if (!result.ok) {
      console.error('Failed to update assignment:', result.error);
      toast.error(tRowsList('assignFailed'));
      return;
    }
    onAssignChange?.(pending.conversationId, pending.userId);
  }, [pendingRowAssign, onAssignChange, tRowsList]);

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
    let result = applyHandled(conversations, handled).filter(hasMessages);
    // The HR view: realtime `hr` patches laid over, then its filters
    // re-checked (a patch can move a chat out of the tab).
    if (hrQuery) {
      result = result
        .map((c): HrConversationRow =>
          hrPatchById?.has(c.id) ? { ...c, hr: hrPatchById.get(c.id) } : c
        )
        .filter((c) => matchesHrFilters(c, hrQuery.filters, hrQuery.viewerId));
    }
    // A realtime patch can move a held chat into or out of a department
    // (migration 192): the list keeps only its own slice.
    if (department) {
      result = result.filter((c) => inDepartmentView(c, { department }));
    } else if (mainInboxOf !== null) {
      result = result.filter((c) =>
        inDepartmentView(c, {
          mainFor: mainInboxOf || null,
          ownDepartment: mainInboxDepartment,
        })
      );
    }

    if (filter === 'unread' && !hrHeaderOn) {
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

    // The text match, or a contact the search found: a close match
    // shares no text with the term and must stay listed.
    if (search.trim()) {
      result = result.filter((c) =>
        matchesInboxSearchOrHit(c, search, liveHits)
      );
    }

    // Smart insights filters (empty while signals are off): realtime
    // patches rows the query picked, so re-check them here.
    if (insightFilters.length > 0) {
      result = result.filter((c) => matchesInsightFilters(c, insightFilters));
    }

    // Signals on: pinned until handled first (urgent › Important ›
    // wants a person › upset › call back, longest waiting first). Off,
    // exactly sortForInbox's order. A search ranks instead: exact
    // matches first, then close ones, best first (sortByRank).
    if (liveHits) return sortByRank(result, liveHits.rank);
    return signalsOn ? sortWithPins(result) : sortForInbox(result);
  }, [
    conversations,
    handled,
    filter,
    hrHeaderOn,
    chatTagFilterIds,
    search,
    liveHits,
    selectedCompany,
    assigneeFilter,
    campaignOnly,
    aiLive,
    selectedCampaignId,
    insightFilters,
    signalsOn,
    department,
    mainInboxOf,
    mainInboxDepartment,
    hrQuery,
    hrPatchById,
  ]);

  // Pinned chats the AI handed over, among those the filters show.
  const importantCount = useMemo(
    () => countNeedingAttention(filtered),
    [filtered]
  );
  // Off by itself once the last one is dealt with, so the list never
  // sits empty behind a chip that is no longer there.
  const showImportantOnly = importantOnly && importantCount > 0;
  // The "N pinned" chip (signals on only); off by itself once the last
  // pin is handled, like Important.
  const pinned = useMemo(
    () => (signalsOn ? pinnedSummary(filtered) : { count: 0, urgent: false }),
    [filtered, signalsOn]
  );
  const showPinnedOnly = pinnedOnly && pinned.count > 0;
  const shown = useMemo(() => {
    let rows = filtered;
    if (showImportantOnly) rows = rows.filter(needsAttention);
    if (showPinnedOnly) rows = rows.filter(isPinned);
    return rows;
  }, [filtered, showImportantOnly, showPinnedOnly]);
  // A search's close matches: the "Similar" chip on each, and the
  // "Close matches" divider above the first (sortByRank puts them last).
  const firstCloseId = useMemo(
    () =>
      liveHits
        ? (shown.find((c) => isCloseMatch(c, liveHits.rank))?.id ?? null)
        : null,
    [shown, liveHits]
  );
  const similarChip = useMemo(
    () => ({ label: tSearch('similar'), hint: tSearch('similarHint') }),
    [tSearch]
  );

  // Handled: clear the attention pin (acknowledge_insight_attention,
  // migration 153) at once and keep the row, unpinned; realtime then
  // brings the cleared row. A failure puts the pin back.
  const tInsightsRef = useRef(tInsights);
  useEffect(() => {
    tInsightsRef.current = tInsights;
  });
  const handleHandled = useCallback(async (conv: ConversationListItem) => {
    const at = conv.insight_attention_at;
    if (!at) return false;
    setHandled((prev) => new Map(prev).set(conv.id, at));
    const { error } = await createClient().rpc(
      'acknowledge_insight_attention',
      { p_conversation_id: conv.id }
    );
    const t = tInsightsRef.current;
    if (error) {
      console.error('Failed to mark chat handled:', error.message);
      setHandled((prev) => {
        const next = new Map(prev);
        next.delete(conv.id);
        return next;
      });
      toast.error(t('handledFailed'));
      return false;
    }
    toast.success(t('handledToast'));
    return true;
  }, []);

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

  // Saved views (migration 250): what the list is narrowed to, as the
  // plain object a view stores, and the way back from one.
  const currentView = useMemo<InboxViewFilters>(
    () => ({
      unread: filter === 'unread',
      important: importantOnly,
      pinned: pinnedOnly,
      assignee: assigneeFilter,
      campaignId: selectedCampaignId,
      chatTagIds: selectedChatTagIds,
      insights: selectedInsightFilters,
      company: selectedCompany,
    }),
    [
      filter,
      importantOnly,
      pinnedOnly,
      assigneeFilter,
      selectedCampaignId,
      selectedChatTagIds,
      selectedInsightFilters,
      selectedCompany,
    ]
  );
  const applyView = useCallback((raw: Record<string, unknown>) => {
    const v = parseInboxView(raw);
    setFilter(v.unread ? 'unread' : 'all');
    setImportantOnly(v.important);
    setPinnedOnly(v.pinned);
    setSelectedAssignee(v.assignee);
    setSelectedCampaignId(v.campaignId);
    setSelectedChatTagIds(v.chatTagIds);
    setSelectedInsightFilters(v.insights);
    setSelectedCompany(v.company);
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
  const handleSelect = useCallback((conv: ConversationListItem) => {
    onSelectRef.current(conv);
  }, []);

  // Hover/focus prefetch of a chat's latest page into the session cache
  // (lib/inbox/message-cache.ts), so the click usually finds it ready.
  // The thread's own read joins one still in flight.
  const prefetchMessages = useCallback(
    (conversationId: string) => {
      const key = messagesCacheKey(accountId, viewerId, conversationId);
      if (!key) return;
      prefetchSession(key, () => fetchLatestMessagePage(conversationId)).catch(
        () => {
          // Best effort: the open reads the page again and reports.
        }
      );
    },
    [accountId, viewerId]
  );

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
    <div className="border-wa-divider bg-wa-panel flex h-full w-full flex-col border-e lg:w-80 2xl:w-96">
      {/* Search + Filter */}
      <div className="space-y-2 px-3 pt-3 pb-2">
        {!hrHeaderOn && <TeamViewSwitch screen="inbox" teamView={teamView} />}
        {hrHeader?.title}
        <div className="flex items-center gap-1">
          <div className="relative min-w-0 flex-1">
            <Search className="text-wa-icon pointer-events-none absolute top-1/2 start-3.5 h-4 w-4 -translate-y-1/2" />
            <Input
              value={search}
              onChange={handleSearchChange}
              placeholder={t('searchPlaceholder')}
              className="bg-wa-search text-wa-text placeholder:text-wa-text-secondary focus-visible:ring-wa-teal/40 h-9 rounded-lg border-0 ps-11 text-sm shadow-none focus-visible:ring-2"
            />
          </div>
          {/* Agents and up (viewers and bank guests never): a chat with
              a number that has none yet, without leaving the inbox. */}
          {canSendMessages && onOpenConversationById && (
            <NewChatButton onOpenConversation={onOpenConversationById} />
          )}
        </div>

        {/* All / Unread as WhatsApp's filter chips — one tap, and "Unread"
            is always in sight rather than behind a dropdown. Scrolls
            sideways when a locale's labels outgrow the column. */}
        <div
          ref={filterChipsRef}
          className={cn(
            '-mx-3 flex [scrollbar-width:none] gap-1 overflow-x-auto px-3 whitespace-nowrap [&::-webkit-scrollbar]:hidden',
            filterChipsOverflow &&
              '[mask-image:linear-gradient(to_right,black_calc(100%_-_2.5rem),transparent)]'
          )}
        >
          {!hrHeaderOn && (
            <SavedViewsMenu
              screen="inbox"
              current={currentView as unknown as Record<string, unknown>}
              hasFilters={!isEmptyInboxView(currentView)}
              onApply={applyView}
              triggerClassName="h-7 rounded-full px-2.5 text-[12.5px]"
            />
          )}
          {!hrHeaderOn && (
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
          )}
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
          {/* Smart insights: the "N pinned" chip (only pinned chats),
              then the filters, which narrow together like the facets
              below, each in its palette colour, and the legend. Only
              while the workspace has signals on. */}
          {signalsOn && pinned.count > 0 && (
            <InsightChip
              active={showPinnedOnly}
              onClick={() => setPinnedOnly((v) => !v)}
              swatch={paletteFor(
                'attention',
                pinned.urgent ? 'urgent' : 'wants_person'
              )}
              label={tInsights('pinnedCount', { count: pinned.count })}
            />
          )}
          {signalsOn && (
            <div
              role="group"
              aria-label={tInsights('filtersLabel')}
              className="flex items-center gap-1"
            >
              {INSIGHT_FILTERS.map((f) => (
                <InsightChip
                  key={f}
                  active={insightFilters.includes(f)}
                  onClick={() => toggleInsightFilter(f)}
                  swatch={INSIGHT_FILTER_SWATCH[f]}
                  label={tInsights(INSIGHT_FILTER_LABEL[f])}
                />
              ))}
              <InsightLegend className="shrink-0 whitespace-nowrap" />
            </div>
          )}
        </div>

        {hrHeader?.controls}

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
                    <span className="bg-wa-green text-wa-green-fg flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-xs font-bold">
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
                        className="text-popover-foreground ps-6 text-sm"
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
              className="text-wa-teal px-1 text-xs font-medium hover:underline"
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
              <Fragment key={conv.id}>
                {conv.id === firstCloseId && (
                  <div
                    role="separator"
                    className="text-muted-foreground border-wa-divider border-b px-4 pt-3 pb-1 text-xs font-medium tracking-wide uppercase"
                  >
                    {tSearch('closeMatches')}
                  </div>
                )}
                <ConversationItem
                  similar={
                    liveHits && isCloseMatch(conv, liveHits.rank)
                      ? similarChip
                      : null
                  }
                  conversation={conv}
                  hrChips={hrQuery !== null}
                  isActive={conv.id === activeConversationId}
                  onSelect={handleSelect}
                  onPrefetch={prefetchMessages}
                  t={t}
                  today={today}
                  locale={locale}
                  // The HR screens name every row's owner, as the inbox
                  // does; the list-level `showAssignee` stays off there
                  // (no Agent filter, no narrowing).
                  showAssignee={showAssigneeProp || hrHeaderOn}
                  assignableProfiles={rowAssignableProfiles}
                  currentUserId={viewerId}
                  viewerRole={accountRole}
                  onRequestAssign={rowAssignOn ? requestRowAssign : undefined}
                  memberName={memberName}
                  chatTagTree={chatTagTree}
                  insights={signalsOn}
                  onHandled={canSendMessages ? handleHandled : undefined}
                  sharedBank={sharedBanks?.get(conv.id) ?? null}
                  personalLabel={
                    // A personal chat (191): "My WhatsApp" for its owner,
                    // else whose WhatsApp it is.
                    conv.personal_owner_id
                      ? conv.personal_owner_id === viewerId
                        ? t('personalMine')
                        : t('personalOf', {
                            name: memberName(conv.personal_owner_id),
                          })
                      : null
                  }
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
              </Fragment>
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

      {/* The row's Assign asks first, in the thread header's words:
          assigning decides who can see the customer's history. */}
      <ConfirmDialog
        open={pendingRowAssign !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRowAssign(null);
        }}
        title={tThread('confirmAssignTitle')}
        description={tThread('confirmAssignBody', {
          customer: pendingRowAssign?.customer ?? '',
          name: pendingRowAssign?.name ?? '',
        })}
        cancelLabel={tThread('confirmAssignCancel')}
        confirmLabel={tThread('assign')}
        onConfirm={() => void confirmRowAssign()}
      />
    </div>
  );
}

const INSIGHT_FILTER_LABEL: Record<
  InsightFilter,
  'filterHot' | 'filterUpset' | 'filterAttention'
> = {
  hot: 'filterHot',
  upset: 'filterUpset',
  // "High priority": priority high or urgent (the key stays for links).
  attention: 'filterAttention',
};

/** Each filter's palette colour (lib/insights/palette.ts). */
const INSIGHT_FILTER_SWATCH: Record<InsightFilter, Swatch> = {
  hot: paletteFor('lead', 'hot'),
  upset: paletteFor('attention', 'upset'),
  attention: paletteFor('urgency', 'soon'),
};

/**
 * A Smart insights header chip: idle it is the list's grey chip with a
 * dot in its colour, active it wears the colour's soft pill.
 */
function InsightChip({
  active,
  onClick,
  swatch,
  label,
}: {
  active: boolean;
  onClick: () => void;
  swatch: Swatch;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] whitespace-nowrap transition-colors',
        active
          ? cn(swatch.chip, 'font-medium')
          : 'bg-wa-search text-wa-text-secondary hover:text-wa-text'
      )}
    >
      {!active && (
        <span
          aria-hidden
          className={cn('h-2 w-2 shrink-0 rounded-full', swatch.dot)}
        />
      )}
      {label}
    </button>
  );
}

/** Pin reasons with a label of their own (Important has ImportantBadge). */
/** Handled's box: shared by the button and the copy that holds its place. */
const HANDLED_CLASS =
  'shrink-0 rounded-full border px-2 text-xs leading-5 font-medium';

/** The row's Assign button and the placeholder that holds its width. */
const ROW_ASSIGN_CLASS =
  'inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 text-xs leading-none font-medium';

const PIN_LABEL = {
  urgent: 'pin.urgent',
  wants_person: 'pin.wants_person',
  upset: 'pin.upset',
  callback: 'pin.callback',
} as const;

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
  'bg-wa-search text-wa-text hover:bg-wa-row-active inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs';

interface ConversationItemProps {
  conversation: ConversationListItem;
  isActive: boolean;
  onSelect: (conversation: ConversationListItem) => void;
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
  /** The personal-chat badge (migration 191), or null on a company chat. */
  personalLabel?: string | null;
  /** Smart insights on: colours, chips, pin labels and Handled. */
  insights?: boolean;
  /** Handled on an attention pin (stable: a useCallback). */
  /** Resolves true once the pin is cleared (the row then takes focus). */
  onHandled?: (conversation: ConversationListItem) => Promise<boolean>;
  /** Warm the chat's messages on hover/focus (stable: a useCallback). */
  onPrefetch?: (conversationId: string) => void;
  /**
   * A search's close match: the "Similar" chip's label and hint, or null
   * on an exact match and outside a search.
   */
  similar?: { label: string; hint: string } | null;
  /** The HR screens: the normal row plus one HR line (`HrRowTags`). */
  hrChips?: boolean;
  /**
   * Who the row's Assign menu offers (`assignableMembers`, stable: a
   * useMemo). Empty: no Assign on the row.
   */
  assignableProfiles?: readonly Profile[];
  /** The viewer, for "(me)" and the share-only check. */
  currentUserId?: string | null;
  viewerRole?: AccountRole | null;
  /**
   * A person was picked in the row's Assign menu; the list asks before
   * it writes (stable: a useCallback). Absent: no Assign on the row.
   */
  onRequestAssign?: (
    conversation: ConversationListItem,
    userId: string,
    name: string
  ) => void;
}

const NO_PROFILES: readonly Profile[] = [];

/** Hover or focus this long before a row's messages are prefetched. */
export const ROW_PREFETCH_DELAY_MS = 100;

// Memoised: a realtime patch to one conversation re-renders that row,
// not all of them. Every prop is stable across unrelated renders
// (`onSelect` via a ref, `memberName` via useCallback, `chatTagTree`
// memoised by useChatTags, `today` changes once a day).
export const ConversationItem = memo(function ConversationItem({
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
  personalLabel = null,
  insights = false,
  onHandled,
  onPrefetch,
  similar = null,
  hrChips = false,
  assignableProfiles = NO_PROFILES,
  currentUserId = null,
  viewerRole = null,
  onRequestAssign,
}: ConversationItemProps) {
  const tRows = useTranslations('InboxRows');
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
  // Smart insights (signals on only): the stripe, chips and pin reason.
  const signals = insights ? rowSignals(conversation, { important }) : null;
  const pinReason = signals?.attention?.reason ?? null;
  // What the top line names: the signal's reason and Important, both
  // when a chat is both ("Urgent · Important").
  const pinLabel = signals ? rowPinLabel(conversation) : null;
  const pinLabelKey = pinLabel?.reason ? PIN_LABEL[pinLabel.reason] : null;
  // The pin's reason is labelled on the top line, so its chip would
  // only repeat it.
  const chips =
    signals?.chips.filter(
      (c) => !(c.family === 'attention' && c.key === pinReason)
    ) ?? [];
  const canHandle = insights && !!onHandled && hasAttentionPin(conversation);
  const tInsights = useTranslations('InsightsUi.list');
  const chatTag = resolveConversationChatTags(conversation, chatTagTree);
  const chatTagText = chatTagLabel(chatTag.main, chatTag.sub);

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  // Debounced so sweeping the pointer down the list fetches nothing;
  // leaving (or blurring) before the delay cancels it.
  const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPrefetch = useCallback(() => {
    if (prefetchTimerRef.current !== null) {
      clearTimeout(prefetchTimerRef.current);
      prefetchTimerRef.current = null;
    }
  }, []);
  const schedulePrefetch = useCallback(() => {
    if (!onPrefetch || isActive) return;
    cancelPrefetch();
    const id = conversation.id;
    prefetchTimerRef.current = setTimeout(() => {
      prefetchTimerRef.current = null;
      onPrefetch(id);
    }, ROW_PREFETCH_DELAY_MS);
  }, [onPrefetch, isActive, conversation.id, cancelPrefetch]);
  useEffect(() => cancelPrefetch, [cancelPrefetch]);

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
  // Chips never earn this line (rowHasMetaLine): they ride on it when
  // it is there and on the top line when it is not, so a row is no
  // taller with signals than without, and the preview line is today's.
  const hrRow = hrChips
    ? ((conversation as HrConversationRow).hr ?? null)
    : null;
  const hasMeta = rowHasMetaLine({
    numberName,
    campaignName,
    sharedBank,
    showAssignee,
    personalLabel,
  });
  // The third line also carries the chat tags now, so a tagged chat
  // gets it even where nothing else would.
  const hasDetail = rowHasDetailLine({
    hasMeta,
    hasChatTag: !!(chatTag.main && chatTagText),
  });
  const assignee = showAssignee ? rowAssignee(handler, handlerName) : null;
  const offersAssign =
    !!onRequestAssign &&
    rowOffersAssign({
      showAssignee,
      assignedAgentId: conversation.assigned_agent_id,
      personalOwnerId: conversation.personal_owner_id,
      hrRow: hrChips,
      assignableCount: assignableProfiles.length,
      shareOnly: isShareOnlyViewer(
        viewerRole,
        currentUserId,
        conversation,
        !!sharedBank
      ),
    });

  const row = (
    <button
      ref={rowRef}
      onClick={handleClick}
      onPointerEnter={schedulePrefetch}
      onPointerLeave={cancelPrefetch}
      onFocus={schedulePrefetch}
      onBlur={cancelPrefetch}
      aria-current={isActive ? 'true' : undefined}
      className={cn(
        // @container: the insight chips size themselves to the row.
        '@container flex w-full items-center gap-3 ps-3 text-start transition-colors',
        isActive ? 'bg-wa-row-active' : 'hover:bg-wa-row-hover',
        // Signals on: the left stripe in the row's colour, transparent
        // when it has none so rows never shift. Off: today's red edge.
        signals
          ? cn(
              'border-s-4',
              signals.stripe
                ? swatchOf(signals.stripe).stripe
                : 'border-s-transparent'
            )
          : important && 'shadow-[inset_3px_0_0_var(--destructive)]'
      )}
    >
      {/* The HR screens: the same row, a Staff ring on a department
      row's avatar, and one HR line at the bottom. */}
      {hrChips ? (
        <HrStaffRing hr={hrRow}>
          <ContactAvatar contact={contact} name={displayName} size={48} />
        </HrStaffRing>
      ) : (
        <ContactAvatar contact={contact} name={displayName} size={48} />
      )}

      {/* The divider runs under the text only, starting past the
          avatar, the way WhatsApp draws it. */}
      <div className="border-wa-divider min-w-0 flex-1 self-stretch border-b py-3 pe-3">
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
            {similar && (
              <span
                title={similar.hint}
                className="bg-info-soft text-info self-center rounded-full px-1.5 py-px text-xs leading-4 font-medium"
              >
                {similar.label}
              </span>
            )}
            {/* No meta line to carry them: the chips ride here, always
                as dots, so the name truncates by a few pixels at most. */}
            {!hasMeta && chips.length > 0 && (
              <InsightChips
                conversation={conversation}
                chips={chips}
                dotsOnly
                className="self-center"
              />
            )}
            {important && (
              <ImportantBadge
                label={
                  pinLabelKey
                    ? `${tInsights(pinLabelKey)} · ${t('important')}`
                    : t('important')
                }
              />
            )}
            {!important && pinLabelKey && pinLabel?.reason && (
              <span
                className={cn(
                  'inline-flex shrink-0 items-center rounded px-1.5 text-xs leading-4 font-semibold',
                  paletteFor('attention', pinLabel.reason).chip
                )}
              >
                {tInsights(pinLabelKey)}
              </span>
            )}
            {canHandle ? (
              // Handled takes the time's place while the chat is pinned.
              // The button itself sits outside the row button (below);
              // this invisible copy holds its width so the name
              // truncates instead of running under it.
              <span aria-hidden className={cn(HANDLED_CLASS, 'invisible')}>
                {tInsights('handled')}
              </span>
            ) : (
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
            )}
          </span>
        </div>
        {/* The preview owns its whole line (the unread count closes
            it), so the narrow desktop column shows a sentence, not two
            words. The tags moved down to the holder's line. */}
        <div className="mt-0.5 flex min-w-0 items-center gap-2">
          <p
            className={cn(
              'min-w-0 flex-1 truncate text-[13.5px] leading-5',
              unread ? 'text-wa-text font-medium' : 'text-wa-text-secondary'
            )}
          >
            {conversation.last_message_text || t('noMessagesYet')}
          </p>
          {unread && (
            <span className="bg-wa-green text-wa-green-fg flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-xs leading-none font-semibold">
              {conversation.unread_count > 99
                ? '99+'
                : conversation.unread_count}
            </span>
          )}
        </div>

        {hasDetail && (
          <div className="text-wa-text-secondary mt-1 flex min-h-5 min-w-0 items-center gap-x-2 text-xs leading-4">
            {personalLabel && (
              <span className="text-info inline-flex shrink-0 items-center gap-1 font-medium">
                <Smartphone className="h-3 w-3 shrink-0" />
                {personalLabel}
              </span>
            )}

            {sharedBank && (
              <span className="text-wa-teal inline-flex shrink-0 items-center gap-1 font-medium">
                <Share2 className="h-3 w-3 shrink-0" />
                {t('sharedWithMe', { bank: sharedBank })}
              </span>
            )}

            {/* The chat tag: the main tag compact, the sub-tag (a bank)
                as a short pill, the full name in the tooltip. */}
            {chatTag.main && chatTagText && (
              <RowChatTags
                main={chatTag.main}
                sub={chatTag.sub}
                label={chatTagText}
              />
            )}

            {/* Who answers for this thread. Only rendered for a viewer
                whose list mixes owners — see `showAssignee`.
                An assigned chat names its assignee. Anything else reads
                "Unassigned" in the muted text: the word is the signal
                (it used to be the owner's name in amber, which read as
                a warning about that person). The owner, when there is
                one, stays in the tooltip. */}
            {assignee && (
              <span
                className={cn(
                  'inline-flex min-w-0 shrink items-center gap-1',
                  assignee.kind === 'assigned' && 'text-wa-text'
                )}
                title={
                  assignee.kind === 'assigned'
                    ? t('assignedTo', { name: assignee.name })
                    : assignee.ownerName
                      ? t('ownedBy', { name: assignee.ownerName })
                      : t('unassigned')
                }
              >
                <UserRound className="h-3 w-3 shrink-0" />
                <span className="truncate">
                  {assignee.kind === 'assigned'
                    ? assignee.name
                    : t('unassigned')}
                </span>
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

            {/* Insight chips close the line, right-aligned: named chips
                on a wide row, coloured dots on a narrow one (a container
                query on the row). They never shrink; the number and the
                name truncate instead. */}
            {chips.length > 0 && hasMeta && (
              <InsightChips
                conversation={conversation}
                chips={chips}
                className="ms-auto"
              />
            )}

            {/* Holds the Assign button's width (the button itself sits
                outside the row button, below). */}
            {offersAssign && (
              <span
                aria-hidden
                className={cn(
                  ROW_ASSIGN_CLASS,
                  'invisible',
                  !(chips.length > 0 && hasMeta) && 'ms-auto'
                )}
              >
                {tRows('assign')}
              </span>
            )}
          </div>
        )}

        {hrChips && <HrRowTags hr={hrRow} />}
      </div>
    </button>
  );

  // One wrapper whether or not Handled shows, so the row keeps its DOM
  // node (and its focus) when the pin clears. Handled sits beside the
  // row, not inside it: the row is a <button>, and a button inside a
  // button is invalid and would select the chat. It takes the time's
  // place on the top line (the row holds its width), clear of the
  // unread count and the tag pill, visible on touch and in the tab
  // order. Once the pin is cleared it goes, so focus moves to the row.
  return (
    <div className="relative">
      {row}
      {canHandle && (
        <button
          type="button"
          onClick={() => {
            void onHandled?.(conversation).then((ok) => {
              if (ok) rowRef.current?.focus();
            });
          }}
          aria-label={tInsights('handledAria', { name: displayName })}
          className={cn(
            HANDLED_CLASS,
            'bg-card text-wa-text border-wa-divider hover:bg-wa-row-hover focus-visible:ring-ring absolute top-2.5 end-3 shadow-sm focus-visible:ring-2 focus-visible:outline-none'
          )}
        >
          {tInsights('handled')}
        </button>
      )}
      {/* Assign, on an unassigned chat, for someone who may assign it.
          Outside the row button for the same reason as Handled, laid
          over the end of the holder's line (the row holds its width).
          Picking a person asks first (the list's confirmation), as the
          thread header does; opening the menu never opens the chat. */}
      {offersAssign && onRequestAssign && (
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={tRows('assignAria', { name: displayName })}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              ROW_ASSIGN_CLASS,
              'bg-card text-wa-text border-wa-divider hover:bg-wa-row-hover focus-visible:ring-ring absolute end-3 bottom-3 focus-visible:ring-2 focus-visible:outline-none'
            )}
          >
            <UserPlus className="h-3 w-3 shrink-0" />
            {tRows('assign')}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel>{tRows('assignTo')}</DropdownMenuLabel>
              {assignableProfiles.map((p) => {
                const name =
                  (p.full_name?.trim() || p.email || tRows('unknownAgent')) +
                  (p.user_id === currentUserId ? tRows('me') : '');
                return (
                  <DropdownMenuItem
                    key={p.id}
                    onClick={() =>
                      onRequestAssign(conversation, p.user_id, name)
                    }
                    className="text-sm"
                  >
                    <MemberPresenceDot userId={p.user_id} className="me-2" />
                    <span className="flex-1 truncate">{name}</span>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
});
