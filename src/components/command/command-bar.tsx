'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CornerDownLeft, MessageSquare, Search, UserRound } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { ShortcutsDialog } from '@/components/command/shortcuts-dialog';
import { useModifierKeyName } from '@/components/command/use-modifier-key';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/use-auth';
import { useBrainNav } from '@/hooks/use-brain-nav';
import { useCallsNav } from '@/hooks/use-calls-nav';
import { useHrTeamNav } from '@/hooks/use-hr-team-nav';
import {
  chatHref,
  COMMAND_SEARCH_DEBOUNCE_MS,
  contactHref,
  isSearchable,
  searchContactsForBar,
  type ContactResult,
} from '@/lib/command/contact-search';
import { buildCommandEntries, type CommandEntry } from '@/lib/command/entries';
import { OPEN_COMMAND_BAR_EVENT } from '@/lib/command/events';
import { moveHighlight, rankEntries } from '@/lib/command/filter';
import {
  IDLE_CHORD,
  isOpenShortcut,
  isTypingTarget,
  stepShortcut,
  type ChordState,
} from '@/lib/command/keys';
import { listShortcuts } from '@/lib/command/shortcuts';
import { createClient } from '@/lib/supabase/client';

/** Most page / action / settings rows listed at once. */
const MAX_ENTRY_ROWS = 8;

type Group = 'pages' | 'actions' | 'settings' | 'contacts';

interface Row {
  id: string;
  group: Group;
  icon: LucideIcon;
  label: string;
  caption?: string;
  href?: string;
  run?: 'shortcuts';
}

function anotherDialogIsOpen(): boolean {
  return (
    document.querySelector(
      '[role="dialog"], [role="alertdialog"], [aria-modal="true"]'
    ) !== null
  );
}

/**
 * The Ctrl+K / Cmd+K command bar and the `g`-chord shortcuts. Mounted
 * once in the dashboard shell. It lists only what the person's role can
 * open (the sidebar's own role filter, `lib/command/entries`) and finds
 * contacts through RLS, so it can never offer more than the screens do.
 */
export function CommandBar() {
  const t = useTranslations('CommandBar');
  const tSidebar = useTranslations('Sidebar');
  const tSettings = useTranslations('Settings');
  const router = useRouter();
  const mod = useModifierKeyName();
  const {
    accountRole,
    profileLoading,
    salesRestricted,
    reviewsAllCalls,
    isBankGuest,
  } = useAuth();
  const callsNav = useCallsNav();
  const brainOn = useBrainNav();
  const hrRoles = useHrTeamNav();

  const role = profileLoading ? null : accountRole;
  const entries = useMemo(
    () =>
      buildCommandEntries(
        {
          role,
          nav: {
            pbx: callsNav.visible,
            brain: brainOn,
            salesRestricted,
            callReviewer: reviewsAllCalls,
            hrRoles,
          },
        },
        salesRestricted
      ),
    [role, callsNav.visible, brainOn, salesRestricted, reviewsAllCalls, hrRoles]
  );
  const pageHrefs = useMemo(
    () =>
      new Set(
        entries.filter((e) => e.kind === 'page').map((e) => e.href as string)
      ),
    [entries]
  );

  const [open, setOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [contacts, setContacts] = useState<ContactResult[]>([]);
  const [searching, setSearching] = useState(false);
  const listId = useId();
  const seq = useRef(0);

  // Refs so the one window listener always sees current values.
  const stateRef = useRef({ open, helpOpen, pageHrefs });
  stateRef.current = { open, helpOpen, pageHrefs };
  const chord = useRef<ChordState>(IDLE_CHORD);

  function openBar() {
    setQuery('');
    setActive(0);
    setContacts([]);
    setOpen(true);
  }

  function onKeyDown(e: KeyboardEvent) {
    const {
      open: isOpen,
      helpOpen: isHelp,
      pageHrefs: hrefs,
    } = stateRef.current;
    if (isOpenShortcut(e)) {
      if (isOpen) {
        e.preventDefault();
        setOpen(false);
      } else if (!isHelp && !anotherDialogIsOpen()) {
        e.preventDefault();
        openBar();
      }
      return;
    }
    const el = e.target as HTMLElement | null;
    const result = stepShortcut(chord.current, e, Date.now(), {
      allowedHrefs: hrefs,
      typing: isTypingTarget({
        tagName: el?.tagName,
        isContentEditable: el?.isContentEditable,
        role: el?.getAttribute?.('role'),
      }),
      dialogOpen: isOpen || isHelp || anotherDialogIsOpen(),
    });
    chord.current = result.state;
    if (!result.action) return;
    e.preventDefault();
    if (result.action.type === 'navigate') router.push(result.action.href);
    else setHelpOpen(true);
  }
  const onKeyDownRef = useRef(onKeyDown);
  onKeyDownRef.current = onKeyDown;

  useEffect(() => {
    const keys = (e: KeyboardEvent) => onKeyDownRef.current(e);
    const openEvent = () => {
      if (!anotherDialogIsOpen()) openBar();
    };
    window.addEventListener('keydown', keys);
    window.addEventListener(OPEN_COMMAND_BAR_EVENT, openEvent);
    return () => {
      window.removeEventListener('keydown', keys);
      window.removeEventListener(OPEN_COMMAND_BAR_EVENT, openEvent);
    };
  }, []);

  // Contacts: debounced, 2+ characters, a newer search cancels the older.
  const canSearchContacts = !isBankGuest && !profileLoading;
  useEffect(() => {
    const mine = ++seq.current;
    if (!open || !canSearchContacts || !isSearchable(query)) {
      setContacts([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const found = await searchContactsForBar(
          createClient(),
          query,
          () => mine === seq.current,
          pageHrefs.has('/inbox')
        );
        if (found && mine === seq.current) setContacts(found);
      } catch {
        if (mine === seq.current) setContacts([]);
      } finally {
        if (mine === seq.current) setSearching(false);
      }
    }, COMMAND_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, query, canSearchContacts, pageHrefs]);

  const labelOf = (e: CommandEntry) => {
    switch (e.label.ns) {
      case 'Sidebar':
        return tSidebar(e.label.key);
      case 'Settings':
        return tSettings(e.label.key);
      default:
        return t(e.label.key);
    }
  };
  const keywordsOf = (e: CommandEntry) =>
    e.keywordsKey && e.label.ns === 'Settings' ? tSettings(e.keywordsKey) : '';

  const rows = useMemo<Row[]>(() => {
    const ranked = rankEntries(entries, query, (e) => ({
      label: labelOf(e),
      keywords: keywordsOf(e),
    })).slice(0, MAX_ENTRY_ROWS);
    const out: Row[] = ranked.map((e) => ({
      id: e.id,
      group:
        e.kind === 'page'
          ? 'pages'
          : e.kind === 'action'
            ? 'actions'
            : 'settings',
      icon: e.icon,
      label: labelOf(e),
      caption: e.captionKey ? tSidebar(e.captionKey) : undefined,
      href: e.href,
      run: e.run,
    }));
    for (const c of contacts) {
      const name = c.name?.trim() || t('unnamed');
      out.push({
        id: `contact:${c.id}`,
        group: 'contacts',
        icon: UserRound,
        label: name,
        caption: c.phone ?? undefined,
        href: contactHref(c.id),
      });
      if (c.conversationId) {
        out.push({
          id: `chat:${c.conversationId}`,
          group: 'contacts',
          icon: MessageSquare,
          label: t('chatWith', { name }),
          href: chatHref(c.conversationId),
        });
      }
    }
    return out;
    // labelOf / keywordsOf close over the translators, which are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, query, contacts, t, tSidebar, tSettings]);

  const activeIndex = Math.min(active, Math.max(rows.length - 1, 0));
  const activeId = rows[activeIndex] ? `${listId}-${rows[activeIndex].id}` : '';

  useEffect(() => {
    if (!activeId) return;
    document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  function choose(row: Row) {
    setOpen(false);
    if (row.run === 'shortcuts') setHelpOpen(true);
    else if (row.href) router.push(row.href);
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    // Home and End keep their text-caret meaning in the input.
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(moveHighlight(activeIndex, rows.length, e.key));
    } else if (e.key === 'Enter') {
      const row = rows[activeIndex];
      if (row) {
        e.preventDefault();
        choose(row);
      }
    }
  }

  const groupLabel: Record<Group, string> = {
    pages: t('groups.pages'),
    actions: t('groups.actions'),
    settings: t('groups.settings'),
    contacts: t('groups.contacts'),
  };
  const grouped = (['pages', 'actions', 'settings', 'contacts'] as Group[])
    .map((g) => ({ g, items: rows.filter((r) => r.group === g) }))
    .filter((x) => x.items.length > 0);

  const searchedContacts = canSearchContacts && isSearchable(query);

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          className="top-[12%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-lg"
        >
          <DialogTitle className="sr-only">{t('title')}</DialogTitle>
          <div className="border-border flex items-center gap-2 border-b px-3">
            <Search
              className="text-muted-foreground h-4 w-4 shrink-0"
              aria-hidden="true"
            />
            <Input
              autoFocus
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={activeId || undefined}
              aria-autocomplete="list"
              aria-label={t('inputLabel')}
              placeholder={t('placeholder')}
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onInputKeyDown}
              className="h-11 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
          </div>
          <div
            id={listId}
            role="listbox"
            aria-label={t('results')}
            className="max-h-[min(24rem,55dvh)] overflow-y-auto p-2"
          >
            {grouped.map(({ g, items }) => (
              <div
                key={g}
                role="group"
                aria-label={groupLabel[g]}
                className="pb-1"
              >
                <div
                  aria-hidden="true"
                  className="text-muted-foreground px-2 py-1 text-xs font-medium"
                >
                  {groupLabel[g]}
                </div>
                {items.map((row) => {
                  const isActive = rows[activeIndex]?.id === row.id;
                  const Icon = row.icon;
                  return (
                    <div
                      key={row.id}
                      id={`${listId}-${row.id}`}
                      role="option"
                      aria-selected={isActive}
                      onMouseMove={() => {
                        const i = rows.findIndex((r) => r.id === row.id);
                        if (i !== activeIndex) setActive(i);
                      }}
                      onClick={() => choose(row)}
                      className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm ${
                        isActive
                          ? 'bg-muted text-foreground'
                          : 'text-foreground'
                      }`}
                    >
                      <Icon
                        className="text-muted-foreground h-4 w-4 shrink-0"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{row.label}</span>
                        {row.caption ? (
                          <span className="text-muted-foreground block truncate text-xs">
                            {row.caption}
                          </span>
                        ) : null}
                      </span>
                      {isActive ? (
                        <CornerDownLeft
                          className="text-muted-foreground h-4 w-4 shrink-0"
                          aria-hidden="true"
                        />
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))}
            {rows.length === 0 && !searching ? (
              <p className="text-muted-foreground px-2 py-6 text-center text-sm">
                {query.trim()
                  ? t('noResults', { query: query.trim() })
                  : t('empty')}
              </p>
            ) : null}
            {searching ? (
              <p className="text-muted-foreground px-2 py-2 text-xs">
                {t('searching')}
              </p>
            ) : null}
          </div>
          <div className="border-border text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-3 py-2 text-xs">
            <span>{t('hintMove')}</span>
            <span>{t('hintOpen')}</span>
            <span>{t('hintClose')}</span>
            {query.trim() && !searchedContacts && canSearchContacts ? (
              <span>{t('hintContacts')}</span>
            ) : null}
            <span className="ms-auto">{mod} K</span>
          </div>
          <div aria-live="polite" className="sr-only">
            {t('resultCount', { count: rows.length })}
          </div>
        </DialogContent>
      </Dialog>
      <ShortcutsDialog
        open={helpOpen}
        onOpenChange={setHelpOpen}
        rows={listShortcuts(pageHrefs)}
      />
    </>
  );
}
