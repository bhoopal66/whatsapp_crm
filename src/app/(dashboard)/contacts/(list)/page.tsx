'use client';

import { EmptyState } from '@/components/dashboard/empty-state';
import { ErrorState } from '@/components/dashboard/error-state';
import { LoadingState } from '@/components/dashboard/loading-state';
import { isUuid } from '@/lib/chat/mentions';
import { customerPath } from '@/lib/contacts/customer-links';
import {
  Fragment,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import type { Contact } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Search,
  Plus,
  Upload,
  MoreHorizontal,
  Pencil,
  Trash2,
  Loader2,
  Users,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
  Filter,
  X,
  Copy,
  SquareArrowOutUpRight,
  UserRoundSearch,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ContactForm } from '@/components/contacts/contact-form';
import { ImportModal } from '@/components/contacts/import-modal';
import { CustomFieldsManager } from '@/components/contacts/custom-fields-manager';
import {
  ChatTagChip,
  OptedOutBadge,
} from '@/components/contacts/contact-badges';
import { useCan } from '@/hooks/use-can';
import {
  useContextMenuItems,
  type ContextMenuEntry,
} from '@/components/context-menu/registry';
import { copyWithToast } from '@/components/context-menu/app-context-menu';
import { GatedButton } from '@/components/ui/gated-button';
import { useLocale, useTranslations } from 'next-intl';
import { useAuth } from '@/hooks/use-auth';
import { SavedViewsMenu } from '@/components/saved-views/saved-views-menu';
import { useChatTags } from '@/hooks/use-chat-tags';
import { chatTagFilterOrGroup } from '@/lib/chat-tags/tree';
import { chatTagChipStyle, chatTagColor } from '@/lib/chat-tags/style';
import { recordReplace } from '@/lib/navigation/back-target';
import { useWorkspaceMembers } from '@/components/meetings/use-workspace-members';
import {
  chatTagFilterChip,
  chunkIds,
  contactChatTagChip,
  mapWithConcurrency,
  pageOfContactIds,
  readAllPages,
} from '@/lib/contacts/chat-tag-column';
import {
  buildContactListQuery,
  CONTACT_LIST_CONVERSATION_ORDER,
  CONTACT_LIST_QUESTION_PREFIX,
  CONTACT_LIST_SELECT,
  contactListQuestion,
  contactSearchFilter,
  firstCloseMatchId,
  narrowHits,
  pageOfHits,
  toContactListRows,
  type ContactListRow,
  type ContactWithConversations,
} from '@/lib/contacts/list-query';
import {
  isMissingSearchRpc,
  parseSearchHits,
  rankByHits,
  searchRpcTerm,
  type SearchHit,
} from '@/lib/contacts/fuzzy-search';
import { pruneSelection } from '@/lib/contacts/selection';
import { SortHeader } from '@/components/contacts/sort-header';
import { PhoneCell } from '@/components/contacts/phone-cell';
import { ColumnsMenu } from '@/components/contacts/columns-menu';
import { SourceFilter } from '@/components/contacts/source-filter';
import {
  EMPTY_VIEW_FILTERS,
  fromViewFilters,
  toViewFilters,
  type ContactsViewFilters,
} from '@/lib/contacts/view-filters';
import { LeadSourceBadge } from '@/components/contacts/lead-source-badge';
import {
  LEAD_SOURCE_COLUMN_AVAILABLE,
  leadSourceOf,
  parseLeadSources,
  type LeadSource,
} from '@/lib/contacts/lead-source';
import {
  columnPrefsKey,
  OPTIONAL_COLUMNS,
  DEFAULT_COLUMN_PREFS,
  parseColumnPrefs,
  serializeColumnPrefs,
  visibleColumns,
  type ColumnPresence,
  type ColumnPrefs,
  type OptionalColumn,
} from '@/lib/contacts/columns';
import { BulkBar, type ChatTagChoice } from '@/components/contacts/bulk-bar';
import {
  writeAudienceHandoff,
  AUDIENCE_HANDOFF_URL,
} from '@/lib/broadcasts/audience-handoff';
import {
  DEFAULT_CONTACT_SORT,
  nextContactSort,
  parseContactSort,
  sortToParams,
  type ContactSort,
  type ContactSortKey,
} from '@/lib/contacts/sort';
import { withParams } from '@/lib/contacts/url-state';
import { sessionCache, sessionKey } from '@/lib/session-cache';
import { useSessionQuery } from '@/hooks/use-session-query';
import { TeamViewSwitch } from '@/components/layout/team-view-switch';

const PAGE_SIZE = 25;
/** Typing pause before the search box re-queries. Every keystroke used
 *  to be a round trip (~700ms through the tunnel), racing each other. */
const SEARCH_DEBOUNCE_MS = 300;

/** Rows per conversations read when resolving the chat-tag filter. */
const FILTER_PAGE_SIZE = 1000;
/** `contacts` requests (≤200 ids each) in flight at once for the filter. */
const FILTER_CHUNK_CONCURRENCY = 4;
/** How long one filter's matched contact ids are reused while paging. */
const FILTER_MATCHES_TTL_MS = 30_000;
/** Hits the close-match RPC returns per search. */
// Asked of the RPC before the personal / chat-tag narrowing: a term that
// matches more than this many visible contacts can still lose hits there.
const SEARCH_RPC_LIMIT = 500;
const NO_CHAT_TAGS: readonly string[] = [];

/** Opaque, so scrolled cells never show through; follows the row hover. */
const STICKY_CHECK_CELL =
  'bg-card group-hover/row:bg-accent sticky left-0 z-[5] w-10 min-w-10';
const STICKY_NAME_CELL =
  'bg-card group-hover/row:bg-accent sticky left-10 z-[5] min-w-32';

type ContactRow = ContactListRow;

/** One view of the list as the session cache keeps it. */
interface ContactListPage {
  rows: ContactRow[];
  total: number;
}

/**
 * Shared by /contacts and /team-contacts.
 *
 * A team leader can see their team's contacts (migration 044), which
 * would make their personal list identical to the team one — so
 * /contacts narrows them to the contacts they created, and
 * /team-contacts shows everything RLS allows. Admins are unchanged:
 * both views are account-wide for them.
 */
export function ContactsPageInner({
  teamView = false,
  toolbarExtras,
}: {
  teamView?: boolean;
  /**
   * Slot beside the search box (saved views mount here). Receives the
   * current filter state and `applyView`, which restores a saved one.
   */
  toolbarExtras?: (ctx: {
    filters: ContactsViewFilters;
    applyView: (filters: ContactsViewFilters) => void;
  }) => ReactNode;
} = {}) {
  const router = useRouter();
  const t = useTranslations('Contacts.page');
  const tSearch = useTranslations('ContactSearch');
  const tTable = useTranslations('ContactsTable');
  const locale = useLocale();
  const { user, accountId, accountRole, profileLoading } = useAuth();

  // `null` = no extra narrowing, leaving RLS to decide — what the team
  // view wants, and what an admin's contact list has always done.
  const personalOnlyUserId =
    !teamView && accountRole === 'team_leader' ? (user?.id ?? null) : null;
  const supabase = createClient();
  const canEdit = useCan('send-messages');
  const canEditSettings = useCan('edit-settings');
  // Names for the Owner / Assigned to columns, from the members
  // list the inbox and pipelines already cache (no extra round trip).
  const { nameOf } = useWorkspaceMembers();

  const [search, setSearch] = useState('');
  // What the query actually uses: `search` after the typing pause.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [page, setPage] = useState(0);
  // Sort lives in the URL (?sort=name&dir=asc). The list waits for it to
  // be read (`urlReady`) so a reload does not fetch the default first.
  const [sort, setSort] = useState<ContactSort>(DEFAULT_CONTACT_SORT);
  const [urlReady, setUrlReady] = useState(false);
  // Lead-source filter (any of), also in the URL: ?source=ad,web_form.
  const [sources, setSources] = useState<LeadSource[]>([]);
  // Optional columns shown (per user, localStorage; try/catch: it can be
  // blocked or empty in a private window).
  const [columnPrefs, setColumnPrefs] =
    useState<ColumnPrefs>(DEFAULT_COLUMN_PREFS);
  // Chat-tag filter — contacts shown have a conversation carrying ANY
  // of these main or sub tags (OR), as in the inbox.
  const [selectedChatTagIds, setSelectedChatTagIds] = useState<string[]>([]);
  const { tree: chatTagTree } = useChatTags();

  // Modals
  const [formOpen, setFormOpen] = useState(false);
  const [editContact, setEditContact] = useState<Contact | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [customFieldsOpen, setCustomFieldsOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Bulk selection (page-scoped — only the loaded rows are selectable)
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  // Only ids still in the tree count: a tag another admin deleted
  // meanwhile would otherwise keep filtering on an id no chat carries,
  // with no chip left to clear it. Keyed on the joined ids so a tag
  // reload with the same selection does not refetch the page.
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

  // The chat-tag filter's matches — every contact id (and created_at)
  // under the current search, tags and owner narrowing — so paging only
  // slices them. Keyed on those inputs; cleared after any change to the
  // contacts themselves (see `refreshContacts`), and kept for
  // FILTER_MATCHES_TTL_MS only: chats are retagged in the inbox and by
  // automations while this page is open, and a match set that never
  // expired kept a retagged contact under the old filter.
  const filterMatches = useRef<{
    key: string;
    at: number;
    rows: { id: string; created_at: string }[];
  } | null>(null);

  // The close-match search's ranked, narrowed hits, reused while paging
  // (same TTL and reasoning as `filterMatches`).
  const searchMatches = useRef<{
    key: string;
    at: number;
    hits: SearchHit[];
  } | null>(null);

  // One cache entry per view: every filter, the search, the page and
  // which screen (team or personal) is asking. Shown at once on a
  // revisit and always revalidated (`lib/session-cache.ts`).
  //
  // Waits for the role to resolve before asking. `personalOnlyUserId`
  // is derived from `accountRole`, which is null until the profile
  // lands; asking before then asked the wrong question for a team
  // leader — the unnarrowed, account-wide list, which is precisely
  // what /team-contacts is for.
  const listKey =
    profileLoading || !urlReady
      ? null
      : sessionKey(
          accountId,
          user?.id,
          contactListQuestion({
            teamView,
            personalOnlyUserId,
            search: debouncedSearch,
            chatTagIds: chatTagFilterIds,
            sort,
            sources,
            page,
          })
        );

  const fetchList = useCallback(async (): Promise<ContactListPage> => {
    const from = page * PAGE_SIZE;
    const term = debouncedSearch.trim();
    const searchFilter = contactSearchFilter(term);

    const filterGroup = chatTagFilterOrGroup(chatTagFilterIds);
    const sourceList = LEAD_SOURCE_COLUMN_AVAILABLE ? sources : [];

    // Close-match search: the RPC ranks (as the caller, so RLS applies),
    // then the page's own filters narrow its hits. A missing RPC
    // (migration 193 not applied) falls through to the ilike paths.
    const rpcTerm = searchRpcTerm(term);
    if (rpcTerm) {
      const searchKey = JSON.stringify([
        term,
        chatTagFilterKey,
        personalOnlyUserId,
        sources,
      ]);
      const cachedSearch = searchMatches.current;
      let ranked =
        cachedSearch?.key === searchKey &&
        Date.now() - cachedSearch.at < FILTER_MATCHES_TTL_MS
          ? cachedSearch.hits
          : null;
      if (!ranked) {
        const rpc = await supabase.rpc('search_contacts', {
          p_term: rpcTerm,
          p_limit: SEARCH_RPC_LIMIT,
        });
        if (rpc.error && !isMissingSearchRpc(rpc.error)) throw rpc.error;
        if (!rpc.error) {
          const hits = parseSearchHits(rpc.data);
          const ids = hits.map((h) => h.contactId);
          let owned: Set<string> | null = null;
          let tagged: Set<string> | null = null;
          let sourced: Set<string> | null = null;
          // Chunked: 500 UUIDs in one `in.(…)` is ~18 KB of URL, over
          // Cloudflare's ~16 KB limit in front of the tunnelled install.
          if (ids.length > 0 && personalOnlyUserId) {
            const results = await mapWithConcurrency(
              chunkIds(ids),
              FILTER_CHUNK_CONCURRENCY,
              (chunk) =>
                supabase
                  .from('contacts')
                  .select('id')
                  .in('id', chunk)
                  .eq('user_id', personalOnlyUserId)
            );
            const failed = results.find((r) => r.error)?.error;
            if (failed) throw failed;
            owned = new Set(
              results.flatMap((r) => (r.data ?? []).map((x) => x.id as string))
            );
          }
          if (ids.length > 0 && filterGroup) {
            const results = await mapWithConcurrency(
              chunkIds(ids),
              FILTER_CHUNK_CONCURRENCY,
              (chunk) =>
                supabase
                  .from('conversations')
                  .select('contact_id')
                  .in('contact_id', chunk)
                  .or(filterGroup)
                  .is('personal_owner_id', null)
            );
            const failed = results.find((r) => r.error)?.error;
            if (failed) throw failed;
            tagged = new Set(
              results.flatMap((r) =>
                (r.data ?? []).map((x) => x.contact_id as string)
              )
            );
          }
          if (ids.length > 0 && sourceList.length > 0) {
            const results = await mapWithConcurrency(
              chunkIds(ids),
              FILTER_CHUNK_CONCURRENCY,
              (chunk) =>
                supabase
                  .from('contacts')
                  .select('id')
                  .in('id', chunk)
                  .in('lead_source', sourceList)
            );
            const failed = results.find((r) => r.error)?.error;
            if (failed) throw failed;
            sourced = new Set(
              results.flatMap((r) => (r.data ?? []).map((x) => x.id as string))
            );
          }
          ranked = narrowHits(hits, [owned, tagged, sourced]);
          searchMatches.current = {
            key: searchKey,
            at: Date.now(),
            hits: ranked,
          };
        }
      }
      if (ranked) {
        const { hits: pageHits, total } = pageOfHits(ranked, from, PAGE_SIZE);
        if (pageHits.length === 0) return { rows: [], total };
        const { data, error } = await supabase
          .from('contacts')
          .select(CONTACT_LIST_SELECT)
          .in(
            'id',
            pageHits.map((h) => h.contactId)
          )
          .order(
            CONTACT_LIST_CONVERSATION_ORDER.column,
            CONTACT_LIST_CONVERSATION_ORDER.options
          );
        if (error) throw error;
        const ordered = rankByHits(
          (data ?? []) as unknown as ContactWithConversations[],
          pageHits
        );
        // The rows keep `closeMatch` (the embed strip spreads the rest).
        return { rows: toContactListRows(ordered), total };
      }
    }

    if (!filterGroup) {
      // One request: the page, its exact count (the subtitle and the
      // pager show the precise total) and each contact's conversations
      // for the Chat tag and Assigned to columns.
      const { data, count, error } = await buildContactListQuery(
        supabase.from('contacts'),
        { personalOnlyUserId, search: term, page, sort, sources },
        PAGE_SIZE
      );
      if (error) throw error;
      return {
        rows: toContactListRows((data ?? []) as ContactWithConversations[]),
        total: count ?? 0,
      };
    }

    // Chat-tag filter active. The tags live on conversations, so:
    // (1) the contact ids whose conversation carries a picked tag,
    // read in pages; (2) those contacts under the same search and
    // owner narrowing as the plain path, ≤200 ids per `.in()`;
    // (3) the page, sorted like the plain path, read in full with its
    // conversations embedded.
    // (1) and (2) are cached per filter, so turning a page re-reads
    // only (3) instead of every match (~700ms a round trip).
    const filterKey = JSON.stringify([
      term,
      chatTagFilterKey,
      personalOnlyUserId,
      sources,
    ]);
    const cached = filterMatches.current;
    let matchedRows =
      cached?.key === filterKey &&
      Date.now() - cached.at < FILTER_MATCHES_TTL_MS
        ? cached.rows
        : null;
    if (!matchedRows) {
      const conversations = await readAllPages<{ contact_id: string | null }>(
        (rangeFrom, rangeTo) =>
          supabase
            .from('conversations')
            .select('id, contact_id')
            .or(filterGroup)
            .is('personal_owner_id', null)
            .order('id')
            .range(rangeFrom, rangeTo),
        FILTER_PAGE_SIZE
      );
      if (conversations.error) throw conversations.error;
      const matched = new Set<string>();
      for (const row of conversations.data) {
        if (row.contact_id) matched.add(row.contact_id);
      }

      const results = await mapWithConcurrency(
        chunkIds([...matched]),
        FILTER_CHUNK_CONCURRENCY,
        (ids) => {
          let query = supabase
            .from('contacts')
            .select('id, created_at, name')
            .in('id', ids);
          if (personalOnlyUserId)
            query = query.eq('user_id', personalOnlyUserId);
          if (searchFilter) query = query.or(searchFilter);
          if (sourceList.length > 0)
            query = query.in('lead_source', sourceList);
          return query;
        }
      );
      const chunkError = results.find((r) => r.error)?.error;
      if (chunkError) throw chunkError;
      matchedRows = results.flatMap(
        (r) =>
          (r.data ?? []) as {
            id: string;
            created_at: string;
            name: string | null;
          }[]
      );
      filterMatches.current = {
        key: filterKey,
        at: Date.now(),
        rows: matchedRows,
      };
    }
    const { ids: pageIds, total } = pageOfContactIds(
      matchedRows,
      from,
      PAGE_SIZE,
      sort
    );
    if (pageIds.length === 0) return { rows: [], total };

    const { data, error } = await supabase
      .from('contacts')
      .select(CONTACT_LIST_SELECT)
      .in('id', pageIds)
      .order(
        CONTACT_LIST_CONVERSATION_ORDER.column,
        CONTACT_LIST_CONVERSATION_ORDER.options
      );
    if (error) throw error;
    const byId = new Map(
      ((data ?? []) as unknown as ContactWithConversations[]).map((c) => [
        c.id,
        c,
      ])
    );
    const pageRows = pageIds
      .map((id) => byId.get(id))
      .filter((c): c is ContactWithConversations => !!c);
    return { rows: toContactListRows(pageRows), total };
    // The tag tree is deliberately NOT a dependency (only the filter's
    // ids are): the rows keep raw ids and `chatTagTree` resolves them at
    // render, so loading or renaming a tag re-renders without another
    // round trip (~700ms through the tunnel).
  }, [
    supabase,
    page,
    debouncedSearch,
    chatTagFilterIds,
    chatTagFilterKey,
    personalOnlyUserId,
    sort,
    sources,
  ]);

  const list = useSessionQuery(listKey, fetchList);
  const contacts = useMemo(() => list.data?.rows ?? [], [list.data]);
  const totalCount = list.data?.total ?? 0;
  const closeDividerId = firstCloseMatchId(contacts);
  const shownColumns = useMemo(
    () =>
      visibleColumns(
        columnPrefs,
        contacts.map((c): ColumnPresence => ({
          email: !!c.email,
          company: !!c.company,
          chatTag: !!c.chatTags?.chat_tag_id,
          source: leadSourceOf(c) !== null,
          owner: !!c.user_id && !!nameOf(c.user_id),
          assignedTo: !!c.assignedTo && !!nameOf(c.assignedTo),
          createdAt: true,
        }))
      ),
    [columnPrefs, contacts, nameOf]
  );
  // The Source column exists only once migration 249 is applied.
  const optionalColumns = OPTIONAL_COLUMNS.filter(
    (c) => c !== 'source' || LEAD_SOURCE_COLUMN_AVAILABLE
  );
  const show = (column: OptionalColumn) =>
    shownColumns.has(column) && optionalColumns.includes(column);
  // checkbox + name + phone + options, plus the optional ones shown.
  const colCount = 4 + optionalColumns.filter(show).length;
  // A spinner only while nothing is cached for this view: a revisit
  // shows the last answer while the fresh one loads.
  const loading = list.loading;
  const refreshList = list.refresh;

  // A failed load keeps what the view showed before (or nothing).
  useEffect(() => {
    if (list.error) toast.error(t('toastFailedLoad'));
  }, [list.error, t]);

  // The visible rows change with the view: drop any selection that
  // referred to the old page/search results so the bulk bar can't act
  // on rows the user can no longer see. Reset while rendering, keyed
  // on the view, rather than in an effect.
  const [selectionKey, setSelectionKey] = useState(listKey);
  if (selectionKey !== listKey) {
    setSelectionKey(listKey);
    setSelected(new Set());
  }
  // The same view read again (a rename that drops a row out of the
  // search, a row deleted elsewhere) keeps only ticks still shown.
  const [selectionRows, setSelectionRows] = useState(contacts);
  if (selectionRows !== contacts) {
    setSelectionRows(contacts);
    setSelected((prev) =>
      pruneSelection(
        prev,
        contacts.map((c) => c.id)
      )
    );
  }

  // After a create, edit, delete or import every cached view of the
  // list may be wrong (a new contact, a changed name the search
  // matches, a deleted row), and so are the cached filter matches:
  // drop the other views and re-read this one, keeping it on screen
  // meanwhile so the list neither blanks nor shows an edit undone
  // once the fresh answer lands.
  const refreshContacts = useCallback(async () => {
    filterMatches.current = null;
    searchMatches.current = null;
    const prefix = sessionKey(
      accountId,
      user?.id,
      CONTACT_LIST_QUESTION_PREFIX
    );
    if (prefix) {
      const shown = listKey ? sessionCache.peek(listKey) : undefined;
      sessionCache.deletePrefix(prefix);
      if (listKey && shown) sessionCache.set(listKey, shown.value);
    }
    await refreshList();
  }, [accountId, user?.id, listKey, refreshList]);

  // A pending search debounce must not fire into an unmounted page.
  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    },
    []
  );

  function openAddForm() {
    setEditContact(null);
    setFormOpen(true);
  }

  function openEditForm(contact: Contact) {
    setEditContact(contact);
    setFormOpen(true);
  }

  function openDetail(contactId: string) {
    router.push(customerPath(contactId, teamView));
  }

  const columnsKey = columnPrefsKey(user?.id);
  useEffect(() => {
    try {
      setColumnPrefs(parseColumnPrefs(window.localStorage.getItem(columnsKey)));
    } catch {
      setColumnPrefs(DEFAULT_COLUMN_PREFS);
    }
  }, [columnsKey]);

  function changeColumnPrefs(next: ColumnPrefs) {
    setColumnPrefs(next);
    try {
      window.localStorage.setItem(columnsKey, serializeColumnPrefs(next));
    } catch {
      // Not saved; the choice still applies until the tab closes.
    }
  }

  // Restore the sort from the URL once, on mount.
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search);
      setSort(parseContactSort(q.get('sort'), q.get('dir')));
      if (LEAD_SOURCE_COLUMN_AVAILABLE) {
        setSources(parseLeadSources(q.get('source')));
      }
    } catch {
      // No window or malformed URL: keep the default.
    }
    setUrlReady(true);
  }, []);

  function changeSort(key: ContactSortKey) {
    const next = nextContactSort(sort, key);
    setSort(next);
    setPage(0);
    try {
      const qs = withParams(window.location.search, {
        sort: null,
        dir: null,
        ...sortToParams(next),
      });
      window.history.replaceState(
        window.history.state,
        '',
        `${window.location.pathname}${qs}`
      );
    } catch {
      // The URL is a convenience; the in-memory sort still applies.
    }
  }

  // `?c=<id>` deep link — used by "view contact" on a saved contact card
  // in the inbox. Read from the location rather than useSearchParams so
  // this client page needs no Suspense boundary; it runs once on mount.
  useEffect(() => {
    try {
      const id = new URLSearchParams(window.location.search).get('c');
      if (isUuid(id)) {
        // A cross-path replace: keep the Back stack in step with history.
        recordReplace(customerPath(id, teamView));
        router.replace(customerPath(id, teamView));
      }
    } catch {
      // No window (SSR) or malformed URL — nothing to open.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function confirmDelete(contact: Contact) {
    setDeleteTarget(contact);
    setDeleteConfirmOpen(true);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);

    const { error } = await supabase
      .from('contacts')
      .delete()
      .eq('id', deleteTarget.id);

    if (error) {
      toast.error(t('toastFailedDelete'));
    } else {
      toast.success(t('toastDeleted'));
      refreshContacts();
    }

    setDeleting(false);
    setDeleteConfirmOpen(false);
    setDeleteTarget(null);
  }

  const allOnPageSelected =
    contacts.length > 0 && contacts.every((c) => selected.has(c.id));
  const someOnPageSelected = contacts.some((c) => selected.has(c.id));

  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        contacts.forEach((c) => next.delete(c.id));
      } else {
        contacts.forEach((c) => next.add(c.id));
      }
      return next;
    });
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Same server path as the inbox header's tag control, per contact's
  // company chat (compare-and-set, chat_tag_set dispatched once each).
  async function applyBulkTag(choice: ChatTagChoice) {
    const ids = [...selected];
    if (ids.length === 0) return;
    try {
      const res = await fetch('/api/contacts/bulk/chat-tag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contactIds: ids,
          chatTagId: choice.chatTagId,
          ...(choice.subTagId !== undefined && { subTagId: choice.subTagId }),
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        updated?: number;
        unchanged?: number;
        skipped?: number;
        failed?: number;
        error?: string;
      } | null;
      if (!res.ok || !body || body.updated === undefined) {
        toast.error(body?.error ?? tTable('toastTagFailed'));
        return;
      }
      const summary = tTable('toastTagResult', {
        updated: body.updated,
        unchanged: body.unchanged ?? 0,
        skipped: body.skipped ?? 0,
        failed: body.failed ?? 0,
      });
      if ((body.failed ?? 0) > 0) toast.error(summary);
      else toast.success(summary);
      await refreshContacts();
    } catch {
      toast.error(tTable('toastTagFailed'));
    }
  }

  function addSelectedToCampaign() {
    const chosen = contacts.filter((c) => selected.has(c.id));
    let storage: Storage | null = null;
    try {
      storage = window.sessionStorage;
    } catch {
      storage = null;
    }
    if (!writeAudienceHandoff(storage, chosen, 'contacts')) {
      toast.error(tTable('toastCampaignNone'));
      return;
    }
    router.push(AUDIENCE_HANDOFF_URL);
  }

  async function handleBulkDelete() {
    const ids = [...selected];
    if (ids.length === 0) return;
    setDeleting(true);

    const { error } = await supabase.from('contacts').delete().in('id', ids);

    if (error) {
      toast.error(t('toastBulkFailedDelete'));
    } else {
      toast.success(t('toastBulkDeleted', { count: ids.length }));
      setSelected(new Set());
      refreshContacts();
    }

    setDeleting(false);
    setBulkDeleteOpen(false);
  }

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const hasNext = page < totalPages - 1;
  const hasPrev = page > 0;

  // A close-match search is ranked by relevance; sorting does not apply.
  const rankedBySearch = searchRpcTerm(debouncedSearch.trim()) !== null;
  const hasActiveFilters =
    debouncedSearch.trim().length > 0 ||
    chatTagFilterIds.length > 0 ||
    sources.length > 0;

  // Every filter change resets to page 0 — the result set shrinks or
  // grows, so page N may no longer be valid (mirrors the search box).
  function toggleChatTagFilter(id: string) {
    setSelectedChatTagIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
    setPage(0);
  }

  // The state a saved view captures, and how one is put back. Scope
  // (personal / team) is role-derived and never changed by a view.
  const currentViewFilters = toViewFilters({
    search: debouncedSearch,
    chatTagIds: chatTagFilterIds,
    sources,
    sort,
    hiddenColumns: columnPrefs.hidden,
    personalOnly: personalOnlyUserId !== null,
  });

  function applyView(raw: ContactsViewFilters) {
    const v = fromViewFilters(raw);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    setSearch(v.search);
    setDebouncedSearch(v.search);
    setSelectedChatTagIds(v.chatTagIds);
    const nextSort = parseContactSort(v.sort, v.dir);
    setSort(nextSort);
    const nextSources = LEAD_SOURCE_COLUMN_AVAILABLE ? v.sources : [];
    setSources(nextSources);
    if (v.hiddenColumns) {
      changeColumnPrefs({ ...columnPrefs, hidden: v.hiddenColumns });
    }
    setPage(0);
    try {
      const qs = withParams(window.location.search, {
        sort: null,
        dir: null,
        source: nextSources.length > 0 ? nextSources.join(',') : null,
        ...sortToParams(nextSort),
      });
      window.history.replaceState(
        window.history.state,
        '',
        `${window.location.pathname}${qs}`
      );
    } catch {
      // The URL is a convenience only.
    }
  }

  function changeSources(next: LeadSource[]) {
    setSources(next);
    setPage(0);
    try {
      const qs = withParams(window.location.search, {
        source: next.length > 0 ? next.join(',') : null,
      });
      window.history.replaceState(
        window.history.state,
        '',
        `${window.location.pathname}${qs}`
      );
    } catch {
      // The URL is a convenience only.
    }
  }

  function clearChatTagFilters() {
    setSelectedChatTagIds([]);
    setPage(0);
  }

  return (
    <div className="space-y-6">
      {/* Mine / Team: only for people who have a team view. */}
      <TeamViewSwitch
        screen="contacts"
        teamView={teamView}
        className="sm:w-60"
      />
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-foreground text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {totalCount > 0
              ? t('subtitle', { count: totalCount })
              : t('subtitleZero')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canEditSettings && (
            <Button
              variant="outline"
              onClick={() => setCustomFieldsOpen(true)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              <SlidersHorizontal className="size-4" />
              {t('customFieldsBtn')}
            </Button>
          )}
          <GatedButton
            variant="outline"
            canAct={canEdit}
            gateReason="add or import contacts"
            onClick={() => setImportOpen(true)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            <Upload className="size-4" />
            {t('importBtn')}
          </GatedButton>
          <GatedButton
            canAct={canEdit}
            gateReason="add or import contacts"
            onClick={openAddForm}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            <Plus className="size-4" />
            {t('addContactBtn')}
          </GatedButton>
        </div>
      </div>

      {/* Search + chat-tag filter */}
      <div className="space-y-2">
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative w-full max-w-sm">
            <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
            <Input
              value={search}
              onChange={(e) => {
                const value = e.target.value;
                setSearch(value);
                if (searchTimer.current) clearTimeout(searchTimer.current);
                searchTimer.current = setTimeout(() => {
                  setDebouncedSearch(value);
                  // Reset pagination when the query changes — the result
                  // set shrinks/grows, page N may no longer be valid.
                  // Done with the debounced value so the page reset and
                  // the new term land as one fetch, not two.
                  setPage(0);
                }, SEARCH_DEBOUNCE_MS);
              }}
              placeholder={t('searchPlaceholder')}
              className="bg-card border-border text-foreground placeholder:text-muted-foreground pl-8"
            />
          </div>

          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  className="border-border text-muted-foreground hover:bg-muted shrink-0"
                />
              }
            >
              <Filter className="size-4" />
              {t('filterByChatTag')}
              {chatTagFilterIds.length > 0 && (
                <span className="bg-primary text-primary-foreground ml-1 inline-flex items-center justify-center rounded-full px-1.5 text-xs font-semibold">
                  {chatTagFilterIds.length}
                </span>
              )}
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-0">
              <div className="border-border flex items-center justify-between border-b px-3 py-2">
                <span className="text-popover-foreground text-sm font-medium">
                  {t('filterByChatTag')}
                </span>
                {chatTagFilterIds.length > 0 && (
                  <button
                    onClick={clearChatTagFilters}
                    className="text-muted-foreground hover:text-foreground text-xs"
                  >
                    {t('clearAll')}
                  </button>
                )}
              </div>
              {chatTagTree.mains.length === 0 ? (
                <p className="text-muted-foreground px-3 py-4 text-center text-sm">
                  {t('noChatTagsYet')}
                </p>
              ) : (
                <div className="max-h-64 overflow-y-auto py-1">
                  {chatTagTree.mains.flatMap((main) => [
                    <ChatTagFilterOption
                      key={main.id}
                      name={main.name}
                      color={main.color}
                      checked={chatTagFilterIds.includes(main.id)}
                      onToggle={() => toggleChatTagFilter(main.id)}
                    />,
                    // Sub-tags sit indented under their main tag.
                    ...main.subs.map((sub) => (
                      <ChatTagFilterOption
                        key={sub.id}
                        name={sub.name}
                        color={sub.color}
                        indent
                        checked={chatTagFilterIds.includes(sub.id)}
                        onToggle={() => toggleChatTagFilter(sub.id)}
                      />
                    )),
                  ])}
                </div>
              )}
            </PopoverContent>
          </Popover>
          <SavedViewsMenu
            screen="contacts"
            current={currentViewFilters as unknown as Record<string, unknown>}
            hasFilters={
              currentViewFilters.search !== '' ||
              currentViewFilters.chatTagIds.length > 0 ||
              currentViewFilters.sources.length > 0 ||
              currentViewFilters.sort !== EMPTY_VIEW_FILTERS.sort ||
              currentViewFilters.dir !== EMPTY_VIEW_FILTERS.dir
            }
            onApply={(raw) => applyView(fromViewFilters(raw))}
          />
          {toolbarExtras?.({ filters: currentViewFilters, applyView })}
          {LEAD_SOURCE_COLUMN_AVAILABLE && (
            <SourceFilter selected={sources} onChange={changeSources} />
          )}
          <ColumnsMenu
            prefs={columnPrefs}
            onChange={changeColumnPrefs}
            columns={optionalColumns}
          />
        </div>

        {/* Active chat-tag filter chips */}
        {chatTagFilterIds.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {chatTagFilterIds.map((id) => {
              const chip = chatTagFilterChip(id, chatTagTree);
              if (!chip) return null;
              return (
                <span
                  key={id}
                  style={chatTagChipStyle(chip.color)}
                  className="text-foreground inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium"
                >
                  <span
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: chatTagColor(chip.color) }}
                  />
                  <span className="truncate">{chip.label}</span>
                  <button
                    onClick={() => toggleChatTagFilter(id)}
                    aria-label={t('removeChatTagFilter', { name: chip.label })}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              );
            })}
            <button
              onClick={clearChatTagFilters}
              className="text-muted-foreground hover:text-foreground px-1 text-xs"
            >
              {t('clearAll')}
            </button>
          </div>
        )}
      </div>

      {rankedBySearch && (
        <p className="text-muted-foreground text-xs">
          {tTable('sortedByRelevance')}
        </p>
      )}

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <BulkBar
          count={selected.size}
          canAct={canEdit}
          tree={chatTagTree}
          onClear={() => setSelected(new Set())}
          onDelete={() => setBulkDeleteOpen(true)}
          onApplyTag={applyBulkTag}
          onAddToCampaign={addSelectedToCampaign}
        />
      )}

      {/* Table */}
      {/* The table's own container scrolls both ways, with a bounded height,
          so the header sticks (<main> scrolls the page, not the table) and
          the checkbox + name columns stay put on a narrow screen. */}
      <div className="bg-card border-border overflow-hidden rounded-lg border [&_[data-slot=table-container]]:max-h-[calc(100dvh-14rem)] [&_[data-slot=table-container]]:min-h-48 [&_[data-slot=table-container]]:overflow-y-auto">
        <Table>
          <TableHeader className="[&_th]:bg-card-2 [&_th]:sticky [&_th]:top-0 [&_th]:z-10">
            <TableRow className="border-border hover:bg-card-2">
              <TableHead className="sticky left-0 z-20 w-10 min-w-10">
                <Checkbox
                  checked={allOnPageSelected}
                  indeterminate={!allOnPageSelected && someOnPageSelected}
                  onCheckedChange={toggleSelectAll}
                  disabled={contacts.length === 0}
                  aria-label="Select all contacts on this page"
                />
              </TableHead>
              <SortHeader
                sortKey="name"
                current={sort}
                onSort={changeSort}
                disabled={rankedBySearch}
                className="sticky left-10 z-20"
              >
                {t('tableColumns.name')}
              </SortHeader>
              <TableHead className="text-muted-foreground font-semibold">
                {t('tableColumns.phone')}
              </TableHead>
              {show('email') && (
                <TableHead className="text-muted-foreground hidden font-semibold md:table-cell">
                  {t('tableColumns.email')}
                </TableHead>
              )}
              {show('company') && (
                <TableHead className="text-muted-foreground hidden font-semibold xl:table-cell">
                  {t('tableColumns.company')}
                </TableHead>
              )}
              {show('chatTag') && (
                <TableHead className="text-muted-foreground hidden font-semibold md:table-cell">
                  {t('tableColumns.chatTag')}
                </TableHead>
              )}
              {show('source') && (
                <TableHead className="text-muted-foreground hidden font-semibold md:table-cell">
                  {tTable('column.source')}
                </TableHead>
              )}
              {show('owner') && (
                <TableHead className="text-muted-foreground hidden font-semibold lg:table-cell">
                  {t('tableColumns.createdBy')}
                </TableHead>
              )}
              {show('assignedTo') && (
                <TableHead className="text-muted-foreground hidden font-semibold lg:table-cell">
                  {t('tableColumns.assignedTo')}
                </TableHead>
              )}
              {show('createdAt') && (
                <SortHeader
                  sortKey="created"
                  current={sort}
                  onSort={changeSort}
                  disabled={rankedBySearch}
                  className="hidden lg:table-cell"
                >
                  {t('tableColumns.createdAt')}
                </SortHeader>
              )}
              <TableHead className="text-muted-foreground w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow className="border-border">
                <TableCell colSpan={colCount} className="p-0">
                  <LoadingState label={t('loading')} />
                </TableCell>
              </TableRow>
            ) : list.error && contacts.length === 0 ? (
              <TableRow className="border-border">
                <TableCell colSpan={colCount} className="p-3">
                  <ErrorState
                    message={t('toastFailedLoad')}
                    onRetry={() => void refreshList()}
                  />
                </TableCell>
              </TableRow>
            ) : contacts.length === 0 ? (
              <TableRow className="border-border">
                <TableCell colSpan={colCount} className="p-3">
                  <EmptyState
                    icon={Users}
                    title={
                      hasActiveFilters
                        ? t('noContactsMatch')
                        : t('noContactsYet')
                    }
                  >
                    {!hasActiveFilters && (
                      <GatedButton
                        canAct={canEdit}
                        gateReason="add or import contacts"
                        variant="outline"
                        size="sm"
                        onClick={openAddForm}
                        className="border-border text-muted-foreground hover:bg-muted mt-2"
                      >
                        <Plus className="size-3.5" />
                        {t('addFirstContact')}
                      </GatedButton>
                    )}
                  </EmptyState>
                </TableCell>
              </TableRow>
            ) : (
              contacts.map((contact) => (
                <Fragment key={contact.id}>
                  {contact.id === closeDividerId && (
                    <TableRow className="border-border hover:bg-transparent">
                      <TableCell
                        colSpan={colCount}
                        className="bg-card-2 text-muted-foreground py-1.5 text-xs font-medium"
                      >
                        {tSearch('closeMatches')}
                      </TableCell>
                    </TableRow>
                  )}
                  <ContactRow
                    contact={contact}
                    teamView={teamView}
                    onOpen={() => openDetail(contact.id)}
                    onEdit={() => openEditForm(contact)}
                    onDelete={() => confirmDelete(contact)}
                  >
                    <TableCell
                      onClick={(e) => e.stopPropagation()}
                      className={STICKY_CHECK_CELL}
                    >
                      <Checkbox
                        checked={selected.has(contact.id)}
                        onCheckedChange={() => toggleSelect(contact.id)}
                        aria-label={`Select ${contact.name || contact.phone}`}
                      />
                    </TableCell>
                    <TableCell
                      className={`text-foreground max-w-56 font-medium whitespace-normal ${STICKY_NAME_CELL}`}
                    >
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <Link
                          href={customerPath(contact.id, teamView)}
                          onClick={(e) => e.stopPropagation()}
                          className="hover:underline"
                        >
                          {contact.name || (
                            <span className="text-muted-foreground italic">
                              {t('unnamed')}
                            </span>
                          )}
                        </Link>
                        {contact.closeMatch && (
                          <span
                            title={tSearch('similarHint')}
                            className="bg-card-2 text-muted-foreground shrink-0 rounded px-1 text-xs font-medium"
                          >
                            {tSearch('similar')}
                          </span>
                        )}
                        {contact.opted_out_at && (
                          <OptedOutBadge
                            label={t('optedOut')}
                            hint={t('optedOutHint', {
                              date: new Date(
                                contact.opted_out_at
                              ).toLocaleDateString(locale, {
                                month: 'short',
                                day: 'numeric',
                                year: 'numeric',
                              }),
                            })}
                          />
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <PhoneCell
                        phone={contact.phone}
                        label={contact.name || contact.phone}
                      />
                    </TableCell>
                    {show('email') && (
                      <TableCell className="text-muted-foreground hidden max-w-48 truncate text-sm md:table-cell">
                        {contact.email || (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    )}
                    {show('company') && (
                      <TableCell className="text-muted-foreground hidden max-w-40 truncate text-sm xl:table-cell">
                        {contact.company || (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    )}
                    {show('chatTag') && (
                      <TableCell className="hidden md:table-cell">
                        <ChatTagChip
                          chip={contactChatTagChip(
                            contact.chatTags,
                            chatTagTree
                          )}
                        />
                      </TableCell>
                    )}
                    {show('source') && (
                      <TableCell className="hidden md:table-cell">
                        <LeadSourceBadge source={leadSourceOf(contact)} />
                      </TableCell>
                    )}
                    {show('owner') && (
                      <TableCell className="text-muted-foreground hidden max-w-40 truncate text-sm lg:table-cell">
                        {(contact.user_id && nameOf(contact.user_id)) || (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    )}
                    {show('assignedTo') && (
                      <TableCell className="text-muted-foreground hidden max-w-40 truncate text-sm lg:table-cell">
                        {(contact.assignedTo && nameOf(contact.assignedTo)) || (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    )}
                    {show('createdAt') && (
                      <TableCell className="text-muted-foreground hidden text-xs whitespace-nowrap lg:table-cell">
                        {new Date(contact.created_at).toLocaleDateString(
                          'en-US',
                          {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                          }
                        )}
                      </TableCell>
                    )}
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="text-muted-foreground hover:text-foreground"
                              onClick={(e) => e.stopPropagation()}
                            />
                          }
                        >
                          <MoreHorizontal className="size-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className="bg-popover border-border"
                        >
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              openEditForm(contact);
                            }}
                            className="text-popover-foreground focus:bg-muted focus:text-foreground"
                          >
                            <Pencil className="size-4" />
                            {t('editAction')}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator className="bg-border" />
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={(e) => {
                              e.stopPropagation();
                              confirmDelete(contact);
                            }}
                          >
                            <Trash2 className="size-4" />
                            {t('deleteAction')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </ContactRow>
                </Fragment>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-muted-foreground text-xs">
            {t('showingPagination', {
              start: page * PAGE_SIZE + 1,
              end: Math.min((page + 1) * PAGE_SIZE, totalCount),
              total: totalCount,
            })}
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!hasPrev}
              onClick={() => setPage((p) => p - 1)}
              className="border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="text-muted-foreground px-2 text-xs">
              {t('pageCount', { page: page + 1, total: totalPages })}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!hasNext}
              onClick={() => setPage((p) => p + 1)}
              className="border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Contact Form Dialog */}
      <ContactForm
        open={formOpen}
        onOpenChange={setFormOpen}
        contact={editContact}
        onSaved={refreshContacts}
        onViewExisting={(id) => {
          setFormOpen(false);
          openDetail(id);
        }}
      />

      {/* Import Modal */}
      <ImportModal
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={refreshContacts}
      />

      {/* Custom Fields Manager (admin+) */}
      {canEditSettings && (
        <CustomFieldsManager
          open={customFieldsOpen}
          onOpenChange={setCustomFieldsOpen}
        />
      )}

      {/* Delete Confirmation */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('deleteContactTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('deleteContactDesc', {
                name: deleteTarget?.name || deleteTarget?.phone || '',
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setDeleteConfirmOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              {t('deleteBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Delete Confirmation */}
      <Dialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('deleteBulkTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('deleteBulkDesc', { count: selected.size })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setBulkDeleteOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleBulkDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              {t('deleteBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** A chat tag in the filter menu: checkbox, colour dot, name. */
function ChatTagFilterOption({
  name,
  color,
  checked,
  indent = false,
  onToggle,
}: {
  name: string;
  color: string;
  checked: boolean;
  indent?: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      className={`hover:bg-muted/50 flex cursor-pointer items-center gap-2.5 py-1.5 pr-3 ${
        indent ? 'pl-8' : 'pl-3'
      }`}
    >
      <Checkbox checked={checked} onCheckedChange={onToggle} />
      <span
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: chatTagColor(color) }}
      />
      <span className="text-popover-foreground truncate text-sm">{name}</span>
    </label>
  );
}

/** Route entry for /contacts — the personal view. */
export default function ContactsPage() {
  return <ContactsPageInner />;
}

/**
 * One contacts-list row, with its right-click actions: the same open,
 * edit and delete the row and its "…" menu offer, plus copying.
 */
function ContactRow({
  contact,
  teamView,
  onOpen,
  onEdit,
  onDelete,
  children,
}: {
  contact: Contact;
  teamView: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
  children: ReactNode;
}) {
  const tMenu = useTranslations('ContextMenu');
  const rowRef = useRef<HTMLTableRowElement>(null);
  useContextMenuItems(rowRef, (): ContextMenuEntry[] => {
    const copied = { copied: tMenu('copied'), failed: tMenu('copyFailed') };
    const items: ContextMenuEntry[] = [
      {
        id: 'open',
        label: tMenu('conversation.openCustomer'),
        icon: UserRoundSearch,
        onSelect: onOpen,
      },
      {
        id: 'openNewTab',
        label: tMenu('records.openNewTab'),
        icon: SquareArrowOutUpRight,
        onSelect: () =>
          void window.open(
            customerPath(contact.id, teamView),
            '_blank',
            'noopener,noreferrer'
          ),
      },
      { type: 'separator' },
    ];
    const { phone, email } = contact;
    if (phone) {
      items.push({
        id: 'copyPhone',
        label: tMenu('conversation.copyPhone'),
        icon: Copy,
        onSelect: () => void copyWithToast(phone, copied),
      });
    }
    if (email) {
      items.push({
        id: 'copyEmail',
        label: tMenu('records.copyEmail'),
        icon: Copy,
        onSelect: () => void copyWithToast(email, copied),
      });
    }
    items.push(
      { type: 'separator' },
      {
        id: 'edit',
        label: tMenu('records.edit'),
        icon: Pencil,
        onSelect: onEdit,
      },
      {
        id: 'delete',
        label: tMenu('records.delete'),
        icon: Trash2,
        destructive: true,
        onSelect: onDelete,
      }
    );
    return items;
  });
  return (
    <TableRow
      ref={rowRef}
      className="group/row border-border hover:bg-accent cursor-pointer"
      onClick={onOpen}
    >
      {children}
    </TableRow>
  );
}
