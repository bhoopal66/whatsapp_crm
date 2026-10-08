'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
} from 'lucide-react';
import { ContactForm } from '@/components/contacts/contact-form';
import { ContactDetailView } from '@/components/contacts/contact-detail-view';
import { ImportModal } from '@/components/contacts/import-modal';
import { CustomFieldsManager } from '@/components/contacts/custom-fields-manager';
import { useCan } from '@/hooks/use-can';
import { GatedButton } from '@/components/ui/gated-button';
import { useLocale, useTranslations } from 'next-intl';
import { useAuth } from '@/hooks/use-auth';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useChatTags } from '@/hooks/use-chat-tags';
import { chatTagFilterOrGroup } from '@/lib/chat-tags/tree';
import { chatTagChipStyle, chatTagColor } from '@/lib/chat-tags/style';
import {
  chatTagFilterChip,
  chatTagsByContact,
  chunkIds,
  contactChatTagChip,
  mapWithConcurrency,
  pageOfContactIds,
  readAllPages,
  type ChatTagIds,
} from '@/lib/contacts/chat-tag-column';

const PAGE_SIZE = 25;
/** Typing pause before the search box re-queries. Every keystroke used
 *  to be a round trip (~700ms through the tunnel), racing each other. */
const SEARCH_DEBOUNCE_MS = 300;

/** Rows per conversations read when resolving the chat-tag filter. */
const FILTER_PAGE_SIZE = 1000;
/** `contacts` requests (≤200 ids each) in flight at once for the filter. */
const FILTER_CHUNK_CONCURRENCY = 4;
const NO_CHAT_TAGS: readonly string[] = [];

interface ContactRow extends Contact {
  /** The chat tag ids on the contact's conversation, kept raw so that
   *  loading the tag DEFINITIONS (names/colours) does not re-run the
   *  contact query — they are resolved against the tree at render. */
  chatTags: ChatTagIds | null;
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
export function ContactsPageInner({ teamView = false }: { teamView?: boolean } = {}) {
  const t = useTranslations('Contacts.page');
  const locale = useLocale();
  const { user, accountRole, profileLoading } = useAuth();

  // `null` = no extra narrowing, leaving RLS to decide — what the team
  // view wants, and what an admin's contact list has always done.
  const personalOnlyUserId =
    !teamView && accountRole === 'team_leader' ? (user?.id ?? null) : null;
  const supabase = createClient();
  const canEdit = useCan('send-messages');
  const canEditSettings = useCan('edit-settings');

  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  // What the query actually uses: `search` after the typing pause.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  // Chat-tag filter — contacts shown have a conversation carrying ANY
  // of these main or sub tags (OR), as in the inbox.
  const [selectedChatTagIds, setSelectedChatTagIds] = useState<string[]>([]);
  const { tree: chatTagTree } = useChatTags();

  // Modals
  const [formOpen, setFormOpen] = useState(false);
  const [editContact, setEditContact] = useState<Contact | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailContactId, setDetailContactId] = useState<string | null>(null);
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

  // Guards against out-of-order fetch responses: each fetchContacts run
  // claims a sequence number and only the latest is allowed to commit its
  // results. Without this, rapidly toggling tag filters could let a slower
  // earlier request resolve last and render stale rows.
  const fetchSeq = useRef(0);

  // The chat-tag filter's matches — every contact id (and created_at)
  // under the current search, tags and owner narrowing — so paging only
  // slices them. Keyed on those inputs; cleared after any change to the
  // contacts themselves (see `refreshContacts`).
  const filterMatches = useRef<{
    key: string;
    rows: { id: string; created_at: string }[];
  } | null>(null);

  const fetchContacts = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    // The visible rows are about to change — drop any selection that
    // referred to the old page/search results so the bulk bar can't
    // act on rows the user can no longer see.
    setSelected(new Set());

    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const term = debouncedSearch.trim();
    const like = term ? `%${term}%` : null;
    const failed = () => {
      toast.error(t('toastFailedLoad'));
      setLoading(false);
    };

    let contactRows: Contact[];
    let count: number;

    const filterGroup = chatTagFilterOrGroup(chatTagFilterIds);
    if (filterGroup) {
      // Chat-tag filter active. The tags live on conversations, so:
      // (1) the contact ids whose conversation carries a picked tag,
      // read in pages; (2) those contacts under the same search and
      // owner narrowing as the plain path, ≤200 ids per `.in()`;
      // (3) the page, sorted like the plain path, read in full.
      // (1) and (2) are cached per filter, so turning a page re-reads
      // only (3) instead of every match (~700ms a round trip).
      const filterKey = JSON.stringify([term, chatTagFilterKey, personalOnlyUserId]);
      let matchedRows = filterMatches.current?.key === filterKey
        ? filterMatches.current.rows
        : null;
      if (!matchedRows) {
        const conversations = await readAllPages<{ contact_id: string | null }>(
          (rangeFrom, rangeTo) =>
            supabase
              .from('conversations')
              .select('id, contact_id')
              .or(filterGroup)
              .order('id')
              .range(rangeFrom, rangeTo),
          FILTER_PAGE_SIZE
        );
        if (seq !== fetchSeq.current) return; // superseded by a newer fetch
        if (conversations.error) return failed();
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
              .select('id, created_at')
              .in('id', ids);
            if (personalOnlyUserId) query = query.eq('user_id', personalOnlyUserId);
            if (like) {
              query = query.or(`name.ilike.${like},phone.ilike.${like},email.ilike.${like}`);
            }
            return query;
          }
        );
        if (seq !== fetchSeq.current) return; // superseded by a newer fetch
        if (results.some((r) => r.error)) return failed();
        matchedRows = results.flatMap(
          (r) => (r.data ?? []) as { id: string; created_at: string }[]
        );
        filterMatches.current = { key: filterKey, rows: matchedRows };
      }
      const { ids: pageIds, total } = pageOfContactIds(
        matchedRows,
        from,
        PAGE_SIZE
      );

      contactRows = [];
      if (pageIds.length > 0) {
        const { data, error } = await supabase
          .from('contacts')
          .select('*')
          .in('id', pageIds);
        if (seq !== fetchSeq.current) return; // superseded by a newer fetch
        if (error) return failed();
        const byId = new Map(
          ((data ?? []) as Contact[]).map((c) => [c.id, c])
        );
        contactRows = pageIds
          .map((id) => byId.get(id))
          .filter((c): c is Contact => !!c);
      }
      count = total;
    } else {
      // `count: 'exact'` stays: the subtitle and the pager show the
      // precise total.
      let query = supabase
        .from('contacts')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to);

      if (personalOnlyUserId) {
        query = query.eq('user_id', personalOnlyUserId);
      }

      if (like) {
        query = query.or(`name.ilike.${like},phone.ilike.${like},email.ilike.${like}`);
      }

      const { data, count: exactCount, error } = await query;
      if (seq !== fetchSeq.current) return; // superseded by a newer fetch
      if (error) return failed();
      contactRows = (data ?? []) as Contact[];
      count = exactCount ?? 0;
    }

    setTotalCount(count);

    if (contactRows.length === 0) {
      setContacts([]);
      setLoading(false);
      return;
    }

    // The chat tag on each contact's conversation, for the column. A
    // failed read leaves the column blank rather than the page.
    const { data: convRows } = await supabase
      .from('conversations')
      .select('contact_id, chat_tag_id, chat_sub_tag_id')
      .in(
        'contact_id',
        contactRows.map((c) => c.id)
      )
      .order('created_at', { ascending: true });
    if (seq !== fetchSeq.current) return; // superseded by a newer fetch
    const tagsByContact = chatTagsByContact(
      (convRows ?? []) as (ChatTagIds & { contact_id: string })[]
    );

    setContacts(
      contactRows.map((c) => ({ ...c, chatTags: tagsByContact.get(c.id) ?? null }))
    );
    setLoading(false);
    // The tag tree is deliberately NOT a dependency (only the filter's
    // ids are): the rows keep raw ids and `chatTagTree` resolves them at
    // render, so loading or renaming a tag re-renders without another
    // round trip (~700ms through the tunnel).
  }, [supabase, page, debouncedSearch, chatTagFilterIds, chatTagFilterKey, personalOnlyUserId, t]);

  // After a create, edit, delete or import the cached filter matches may
  // be wrong (a new contact, a changed name the search matches, a
  // deleted row), so read them again.
  const refreshContacts = useCallback(() => {
    filterMatches.current = null;
    return fetchContacts();
  }, [fetchContacts]);

  // A pending search debounce must not fire into an unmounted page.
  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    },
    []
  );

  // Wait for the role to resolve before asking.
  //
  // `personalOnlyUserId` is derived from `accountRole`, which is null
  // until the profile lands. Fetching before then asked the wrong
  // question for a team leader — the unnarrowed, account-wide list —
  // and, because the value was missing from the deps above, the answer
  // was never corrected: /contacts showed a team leader everything RLS
  // allows, which is precisely what /team-contacts is for.
  //
  // Deferring one tick fixes that AND keeps it to a single request:
  // including the id in the deps without this guard would simply fetch
  // twice, and through the tunnel a wasted round trip is ~700ms.
  useEffect(() => {
    if (profileLoading) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContacts();
  }, [fetchContacts, profileLoading]);

  function openAddForm() {
    setEditContact(null);
    setFormOpen(true);
  }

  function openEditForm(contact: Contact) {
    setEditContact(contact);
    setFormOpen(true);
  }

  function openDetail(contactId: string) {
    setDetailContactId(contactId);
    setDetailOpen(true);
  }

  // `?c=<id>` deep link — used by "view contact" on a saved contact card
  // in the inbox. Read from the location rather than useSearchParams so
  // this client page needs no Suspense boundary; it runs once on mount.
  useEffect(() => {
    try {
      const id = new URLSearchParams(window.location.search).get('c');
      if (id) openDetail(id);
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

  const hasActiveFilters =
    debouncedSearch.trim().length > 0 || chatTagFilterIds.length > 0;

  // Every filter change resets to page 0 — the result set shrinks or
  // grows, so page N may no longer be valid (mirrors the search box).
  function toggleChatTagFilter(id: string) {
    setSelectedChatTagIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
    setPage(0);
  }

  function clearChatTagFilters() {
    setSelectedChatTagIds([]);
    setPage(0);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {totalCount > 0 ? t('subtitle', { count: totalCount }) : t('subtitleZero')}
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
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative w-full max-w-sm">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
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
              className="pl-8 bg-card border-border text-foreground placeholder:text-muted-foreground"
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
                <span className="ml-1 inline-flex items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                  {chatTagFilterIds.length}
                </span>
              )}
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-0">
              <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                <span className="text-sm font-medium text-popover-foreground">
                  {t('filterByChatTag')}
                </span>
                {chatTagFilterIds.length > 0 && (
                  <button
                    onClick={clearChatTagFilters}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    {t('clearAll')}
                  </button>
                )}
              </div>
              {chatTagTree.mains.length === 0 ? (
                <p className="px-3 py-4 text-sm text-muted-foreground text-center">
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
                  className="text-foreground inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium"
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
              className="text-xs text-muted-foreground hover:text-foreground px-1"
            >
              {t('clearAll')}
            </button>
          </div>
        )}
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/40 px-4 py-2">
          <p className="text-sm text-foreground">
            {t('selectedCount', { count: selected.size })}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set())}
              className="text-muted-foreground hover:text-foreground"
            >
              {t('clearSelection')}
            </Button>
            <GatedButton
              variant="destructive"
              size="sm"
              canAct={canEdit}
              gateReason="delete contacts"
              onClick={() => setBulkDeleteOpen(true)}
            >
              <Trash2 className="size-4" />
              {t('deleteSelected')}
            </GatedButton>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="rounded-lg border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="w-10">
                <Checkbox
                  checked={allOnPageSelected}
                  indeterminate={!allOnPageSelected && someOnPageSelected}
                  onCheckedChange={toggleSelectAll}
                  disabled={contacts.length === 0}
                  aria-label="Select all contacts on this page"
                />
              </TableHead>
              <TableHead className="text-muted-foreground">{t('tableColumns.name')}</TableHead>
              <TableHead className="text-muted-foreground">{t('tableColumns.phone')}</TableHead>
              <TableHead className="text-muted-foreground hidden md:table-cell">{t('tableColumns.email')}</TableHead>
              <TableHead className="text-muted-foreground hidden lg:table-cell">{t('tableColumns.company')}</TableHead>
              <TableHead className="text-muted-foreground hidden md:table-cell">{t('tableColumns.chatTag')}</TableHead>
              <TableHead className="text-muted-foreground hidden lg:table-cell">{t('tableColumns.createdAt')}</TableHead>
              <TableHead className="text-muted-foreground w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow className="border-border">
                <TableCell colSpan={8} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="size-6 animate-spin text-primary" />
                    <p className="text-sm text-muted-foreground">{t('loading')}</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : contacts.length === 0 ? (
              <TableRow className="border-border">
                <TableCell colSpan={8} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <Users className="size-8 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      {hasActiveFilters
                        ? t('noContactsMatch')
                        : t('noContactsYet')}
                    </p>
                    {!hasActiveFilters && (
                      <GatedButton
                        canAct={canEdit}
                        gateReason="add or import contacts"
                        variant="outline"
                        size="sm"
                        onClick={openAddForm}
                        className="mt-2 border-border text-muted-foreground hover:bg-muted"
                      >
                        <Plus className="size-3.5" />
                        {t('addFirstContact')}
                      </GatedButton>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              contacts.map((contact) => (
                <TableRow
                  key={contact.id}
                  className="border-border hover:bg-muted/50 cursor-pointer"
                  onClick={() => openDetail(contact.id)}
                >
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selected.has(contact.id)}
                      onCheckedChange={() => toggleSelect(contact.id)}
                      aria-label={`Select ${contact.name || contact.phone}`}
                    />
                  </TableCell>
                  <TableCell className="text-foreground font-medium">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      {contact.name || <span className="text-muted-foreground italic">{t('unnamed')}</span>}
                      {contact.opted_out_at && (
                        <OptedOutBadge
                          label={t('optedOut')}
                          hint={t('optedOutHint', {
                            date: new Date(contact.opted_out_at).toLocaleDateString(
                              locale,
                              { month: 'short', day: 'numeric', year: 'numeric' }
                            ),
                          })}
                        />
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">
                    {contact.phone}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden md:table-cell text-sm">
                    {contact.email || <span className="text-muted-foreground">-</span>}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden lg:table-cell text-sm">
                    {contact.company || <span className="text-muted-foreground">-</span>}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <ChatTagChip
                      chip={contactChatTagChip(contact.chatTags, chatTagTree)}
                    />
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs hidden lg:table-cell">
                    {new Date(contact.created_at).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </TableCell>
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
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {t('showingPagination', {
              start: page * PAGE_SIZE + 1,
              end: Math.min((page + 1) * PAGE_SIZE, totalCount),
              total: totalCount
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
            <span className="text-xs text-muted-foreground px-2">
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

      {/* Contact Detail Sheet */}
      <ContactDetailView
        open={detailOpen}
        onOpenChange={setDetailOpen}
        contactId={detailContactId}
        onUpdated={refreshContacts}
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
            <DialogTitle className="text-popover-foreground">{t('deleteContactTitle')}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('deleteContactDesc', { name: deleteTarget?.name || deleteTarget?.phone || '' })}
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
      className={`flex items-center gap-2.5 py-1.5 pr-3 cursor-pointer hover:bg-muted/50 ${
        indent ? 'pl-8' : 'pl-3'
      }`}
    >
      <Checkbox checked={checked} onCheckedChange={onToggle} />
      <span
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: chatTagColor(color) }}
      />
      <span className="text-sm text-popover-foreground truncate">{name}</span>
    </label>
  );
}

/** A contact's chat tag as the inbox list draws it: dot + label on a
 *  tint of the tag colour, text in the theme's foreground. */
function ChatTagChip({
  chip,
}: {
  chip: { label: string; color: string } | null;
}) {
  if (!chip) return <span className="text-muted-foreground text-xs">-</span>;
  return (
    <span
      title={chip.label}
      style={chatTagChipStyle(chip.color)}
      className="text-foreground inline-flex max-w-[14rem] min-w-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-4 font-medium"
    >
      <span
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: chatTagColor(chip.color) }}
      />
      <span className="truncate">{chip.label}</span>
    </span>
  );
}

/** Set when the customer asked not to be messaged (migration 076).
 *  Focusable, and named by the full hint (date included), so a keyboard
 *  or screen-reader user gets what the tooltip says on hover. */
function OptedOutBadge({ label, hint }: { label: string; hint: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            tabIndex={0}
            aria-label={hint}
            className="border-destructive/40 bg-destructive/10 text-destructive focus-visible:ring-ring/50 inline-flex shrink-0 items-center rounded-full border px-1.5 text-[10px] leading-4 font-medium outline-none focus-visible:ring-2"
          />
        }
      >
        {label}
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

/** Route entry for /contacts — the personal view. */
export default function ContactsPage() {
  return <ContactsPageInner />;
}
