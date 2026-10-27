'use client';

import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { ChevronsUpDown, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import {
  SECTION_META,
  type SettingsCategory,
  type SettingsSection,
} from './settings-sections';
import {
  normaliseSearch,
  searchSettings,
  type SettingsSearchItem,
} from './settings-search';

export interface SettingsNavGroup {
  id: SettingsCategory;
  sections: SettingsSection[];
}

/** The plain-click test every settings link shares: a modified or
 *  middle click is left to the browser (a new tab, a new window). */
export function isPlainClick(e: MouseEvent): boolean {
  return (
    !e.defaultPrevented &&
    e.button === 0 &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.shiftKey &&
    !e.altKey
  );
}

/** A section's own URL, so a link can be opened in a new tab. */
export function settingsHref(section: SettingsSection): string {
  return `/settings?tab=${section}`;
}

/**
 * The Settings menu: a search box over the groups, each group a
 * heading and its sections. Entries are real links (a new tab works),
 * but a plain click goes through `onSelect`, which switches in place and
 * asks first when AI Agents has unsaved edits. `data-settings-nav` tells
 * the page's leave guard that these links handle that themselves.
 */
export function SettingsNav({
  groups,
  section,
  onSelect,
  searchClassName,
}: {
  groups: SettingsNavGroup[];
  section: SettingsSection;
  onSelect: (section: SettingsSection) => void;
  /** Classes for the pinned search bar: the menu's own background, so
   *  entries scrolling under it are hidden, and any padding. */
  searchClassName: string;
}) {
  const t = useTranslations('Settings');
  // The search belongs to the section it was typed on: opening another
  // section, from here or anywhere else, clears it. Picking a result
  // does not clear it by itself, so "Stay" in the unsaved-AI-edits
  // dialog keeps what was typed.
  const [search, setSearch] = useState({ text: '', section });
  const query = search.section === section ? search.text : '';
  const setQuery = (text: string) => setSearch({ text, section });

  const items = useMemo<SettingsSearchItem[]>(
    () =>
      groups.flatMap((g) =>
        g.sections.map((s) => ({
          section: s,
          label: t(`sections.${s}`),
          terms: [
            g.id === 'overview' ? '' : t(`categories.${g.id}`),
            t(`hints.${s}`),
            t(`keywords.${s}`),
          ].join(' '),
        }))
      ),
    [groups, t]
  );
  const searching = normaliseSearch(query) !== '';
  const results = searching ? searchSettings(query, items) : [];

  // A result is unmounted once its section opens (the groups come
  // back), which would drop keyboard focus on <body>: hand it to the
  // new current entry instead.
  const navRef = useRef<HTMLElement>(null);
  const refocus = useRef<SettingsSection | null>(null);
  const pick = (next: SettingsSection, fromResult = false) => {
    if (next === section) {
      setQuery('');
      if (fromResult) {
        requestAnimationFrame(() => focusCurrentEntry(navRef.current));
      }
    } else if (fromResult) {
      refocus.current = next;
    }
    onSelect(next);
  };
  useEffect(() => {
    const target = refocus.current;
    refocus.current = null;
    if (target === section) focusCurrentEntry(navRef.current);
  }, [section]);

  // Keep the current section in sight inside whatever scrolls the menu
  // (`data-settings-scroll`: the sticky column, or the sheet), so a
  // sheet opened on API keys does not open on My account. Not
  // scrollIntoView: that would scroll the page behind the menu as well.
  // The search box is pinned: focusing it (the sheet does on open)
  // would otherwise scroll the list straight back to the top.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const nav = navRef.current;
      const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
      const box = nav?.closest<HTMLElement>('[data-settings-scroll]');
      if (!active || !box) return;
      const a = active.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      // Zero height: the column is hidden at this width.
      if (b.height === 0) return;
      if (a.top < b.top + a.height * 2 || a.bottom > b.bottom) {
        box.scrollTop += a.top - b.top - (b.height - a.height) / 2;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [section]);
  const resultsRef = useRef<HTMLUListElement>(null);

  return (
    <nav ref={navRef} aria-label={t('nav.label')}>
      <div className={cn('sticky top-0 z-10 pb-1', searchClassName)}>
        <div className="relative">
          <Search
            aria-hidden
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Enter also commits a Hangul syllable in an IME: not a
              // pick.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === 'Enter' && results[0]) {
                e.preventDefault();
                pick(results[0]);
              } else if (e.key === 'ArrowDown' && results[0]) {
                // Into the results; Tab moves on from there.
                e.preventDefault();
                resultsRef.current?.querySelector<HTMLElement>('a')?.focus();
              } else if (e.key === 'Escape' && query) {
                // Clear first; a second Escape reaches the sheet and
                // closes it.
                e.preventDefault();
                e.stopPropagation();
                setQuery('');
              }
            }}
            placeholder={t('nav.search')}
            aria-label={t('nav.search')}
            className="bg-card h-9 pl-8"
          />
        </div>
      </div>

      {searching ? (
        results.length > 0 ? (
          <ul
            ref={resultsRef}
            className="mt-2 space-y-0.5"
            aria-label={t('nav.results')}
          >
            {results.map((s) => {
              const group = SECTION_META[s].category;
              return (
                <NavEntry
                  key={s}
                  section={s}
                  active={s === section}
                  detail={
                    group === 'overview' ? null : t(`categories.${group}`)
                  }
                  onSelect={(next) => pick(next, true)}
                />
              );
            })}
          </ul>
        ) : (
          <p className="text-muted-foreground px-2.5 py-6 text-center text-sm">
            {t('nav.noResults')}
          </p>
        )
      ) : (
        <div className="mt-2">
          {groups.map((g) => (
            <div key={g.id} className="mt-5 first:mt-0">
              {g.id === 'overview' ? null : (
                <p className="text-muted-foreground px-2.5 pb-1.5 text-[11px] font-semibold tracking-wider uppercase">
                  {t(`categories.${g.id}`)}
                </p>
              )}
              <ul className="space-y-0.5">
                {g.sections.map((s) => (
                  <NavEntry
                    key={s}
                    section={s}
                    active={s === section}
                    onSelect={pick}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </nav>
  );
}

function focusCurrentEntry(nav: HTMLElement | null) {
  nav
    ?.querySelector<HTMLElement>('[aria-current="page"]')
    ?.focus({ preventScroll: true });
}

function NavEntry({
  section,
  active,
  detail,
  onSelect,
}: {
  section: SettingsSection;
  active: boolean;
  /** The group, under a search result's label. */
  detail?: string | null;
  onSelect: (section: SettingsSection) => void;
}) {
  const t = useTranslations('Settings');
  const Icon = SECTION_META[section].icon;
  return (
    <li>
      <a
        href={settingsHref(section)}
        data-settings-nav=""
        aria-current={active ? 'page' : undefined}
        onClick={(e) => {
          if (!isPlainClick(e)) return;
          e.preventDefault();
          onSelect(section);
        }}
        className={cn(
          'group flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors',
          'focus-visible:ring-ring/50 outline-none focus-visible:ring-3',
          active
            ? 'bg-primary-soft text-primary font-medium'
            : 'text-foreground/80 hover:bg-muted hover:text-foreground'
        )}
      >
        <Icon
          aria-hidden
          className={cn(
            'size-4 shrink-0',
            active
              ? 'text-primary'
              : 'text-muted-foreground group-hover:text-foreground'
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{t(`sections.${section}`)}</span>
          {detail ? (
            <span className="text-muted-foreground block truncate text-xs font-normal">
              {detail}
            </span>
          ) : null}
        </span>
      </a>
    </li>
  );
}

/**
 * Below the wide layout the menu lives in a sheet, opened from a bar
 * naming where you are (group and section).
 */
export function SettingsMenuButton({
  groups,
  section,
  onSelect,
  className,
}: {
  groups: SettingsNavGroup[];
  section: SettingsSection;
  onSelect: (section: SettingsSection) => void;
  className?: string;
}) {
  const t = useTranslations('Settings');
  const [open, setOpen] = useState(false);
  const { icon: Icon, category } = SECTION_META[section];

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <button
            type="button"
            className={cn(
              'border-border bg-card hover:bg-card-2 flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left shadow-xs transition-colors',
              'focus-visible:ring-ring/50 outline-none focus-visible:ring-3',
              className
            )}
          />
        }
      >
        <span className="bg-primary-soft text-primary flex size-8 shrink-0 items-center justify-center rounded-lg">
          <Icon aria-hidden className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          {category === 'overview' ? null : (
            <span className="text-muted-foreground block truncate text-xs">
              {t(`categories.${category}`)}
            </span>
          )}
          <span className="text-foreground block truncate text-sm font-medium">
            {t(`sections.${section}`)}
          </span>
        </span>
        <span className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs">
          {t('nav.allSettings')}
          <ChevronsUpDown aria-hidden className="size-4" />
        </span>
      </SheetTrigger>
      <SheetContent side="left" className="w-[min(20rem,88vw)] gap-0 p-0">
        <SheetHeader className="border-border border-b">
          <SheetTitle>{t('pageTitle')}</SheetTitle>
        </SheetHeader>
        <div
          data-settings-scroll=""
          className="min-h-0 flex-1 overflow-y-auto px-3 pb-6"
        >
          <SettingsNav
            groups={groups}
            section={section}
            searchClassName="bg-popover pt-3"
            onSelect={(next) => {
              setOpen(false);
              onSelect(next);
            }}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
