'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import {
  Archive,
  FolderKanban,
  Loader2,
  MessageSquareOff,
  Search,
  UserRound,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { relativeActivity } from '@/lib/groups/ui';
import {
  appendPage,
  avatarTone,
  groupContactName,
  groupTitle,
  initialsOf,
  listUrl,
  onlyMine,
  parseSgList,
  shortRef,
  trackerStatusChip,
  type SgListItem,
  waModeOf,
} from '@/lib/submission-groups/ui';
import { cn } from '@/lib/utils';

import { useSubmissionGroupsList } from './list-context';

type Tab = 'active' | 'ended';

const SEARCH_DEBOUNCE_MS = 300;
/** Focus returns in bursts (alt-tab, devtools): one re-read per burst. */
const FOCUS_REFRESH_MS = 1000;

interface Loaded {
  groups: SgListItem[];
  next: string | null;
  failed: boolean;
}

/**
 * The left pane of /submission-groups: Active and Ended, searched
 * server-side; "My groups" narrows the loaded rows client-side.
 */
export function SubmissionGroupsList({
  selectedId,
}: {
  selectedId: string | null;
}) {
  const t = useTranslations('SubmissionGroups');
  const tl = useTranslations('SubmissionGroups.list');
  const [tab, setTab] = useState<Tab>('active');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [mineOnly, setMineOnly] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const seq = useRef(0);
  const { registerRefresh } = useSubmissionGroupsList();
  const current = useRef({ tab, q: debounced });
  current.current = { tab, q: debounced };

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(async (status: Tab, q: string) => {
    const mine = ++seq.current;
    setLoaded(null);
    try {
      const res = await fetch(listUrl(status, q, null), { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const page = parseSgList(await res.json());
      if (mine === seq.current)
        setLoaded({
          groups: page.groups,
          next: page.next_cursor,
          failed: false,
        });
    } catch {
      if (mine === seq.current)
        setLoaded({ groups: [], next: null, failed: true });
    }
  }, []);

  useEffect(() => {
    void load(tab, debounced);
  }, [load, tab, debounced]);

  // Re-read the current view from the first page without blanking the
  // rows; a failed refresh keeps what is listed. The selection is a prop
  // (the route), so it is untouched.
  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    const { tab: status, q } = current.current;
    try {
      const res = await fetch(listUrl(status, q, null), { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const page = parseSgList(await res.json());
      if (mine === seq.current)
        setLoaded({
          groups: page.groups,
          next: page.next_cursor,
          failed: false,
        });
    } catch {
      // Keep the current rows.
    }
  }, []);

  useEffect(
    () => registerRefresh(() => void refresh()),
    [registerRefresh, refresh]
  );

  useEffect(() => {
    let last = 0;
    const onFocus = () => {
      const at = Date.now();
      if (at - last < FOCUS_REFRESH_MS) return;
      last = at;
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const loadMore = async () => {
    if (!loaded?.next) return;
    const mine = seq.current;
    setLoadingMore(true);
    try {
      const res = await fetch(listUrl(tab, debounced, loaded.next), {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(String(res.status));
      const page = parseSgList(await res.json());
      if (mine === seq.current)
        setLoaded((prev) =>
          prev
            ? {
                groups: appendPage(prev.groups, page.groups),
                next: page.next_cursor,
                failed: false,
              }
            : prev
        );
    } catch {
      // Keep what is listed; the button stays for another try.
    } finally {
      setLoadingMore(false);
    }
  };

  const searching = debounced.trim() !== '';
  const shown = loaded && !loaded.failed ? loaded.groups : null;
  const rows = shown ? (mineOnly ? onlyMine(shown) : shown) : null;
  const now = new Date();

  return (
    <div className="bg-card flex h-full min-h-0 w-full flex-col">
      <div className="border-border shrink-0 space-y-2 border-b px-3 pt-3 pb-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <h1 className="truncate text-base font-semibold">{t('title')}</h1>
          {rows && (
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
              {loaded?.next && !mineOnly
                ? tl('countMore', { count: rows.length })
                : tl('count', { count: rows.length })}
            </span>
          )}
        </div>
        <div className="relative">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tl('search')}
            aria-label={tl('search')}
            className="h-8 pl-8 text-sm"
          />
        </div>
        <div className="flex items-center gap-2">
          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as Tab)}
            className="min-w-0 flex-1"
          >
            <TabsList className="w-full">
              <TabsTrigger value="active" className="flex-1">
                {t('tabs.active')}
              </TabsTrigger>
              <TabsTrigger value="ended" className="flex-1">
                {t('tabs.ended')}
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Button
            variant={mineOnly ? 'secondary' : 'outline'}
            size="sm"
            aria-pressed={mineOnly}
            title={tl('myGroupsHint')}
            onClick={() => setMineOnly((v) => !v)}
            className={cn('shrink-0', mineOnly && 'ring-ring/40 ring-1')}
          >
            <UserRound className="size-3.5" aria-hidden />
            {tl('myGroups')}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!loaded ? (
          <ul aria-hidden>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <li
                key={i}
                className="border-border/60 flex items-center gap-3 border-b px-3 py-3"
              >
                <span className="bg-muted size-10 shrink-0 animate-pulse rounded-full" />
                <span className="flex-1 space-y-2">
                  <span className="bg-muted block h-3.5 w-2/3 animate-pulse rounded" />
                  <span className="bg-muted block h-3 w-1/2 animate-pulse rounded" />
                </span>
              </li>
            ))}
          </ul>
        ) : loaded.failed ? (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <p className="text-destructive text-sm">{t('loadFailed')}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load(tab, debounced)}
            >
              {t('retry')}
            </Button>
          </div>
        ) : rows && rows.length === 0 ? (
          searching && !mineOnly ? (
            <p className="text-muted-foreground px-4 py-10 text-center text-sm">
              {t('noMatches', { query: debounced.trim() })}
            </p>
          ) : (
            <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
              <span className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
                <FolderKanban className="size-5" aria-hidden />
              </span>
              <p className="font-semibold">
                {mineOnly
                  ? tl('emptyMineTitle')
                  : tab === 'active'
                    ? t('emptyActiveTitle')
                    : t('emptyEndedTitle')}
              </p>
              <p className="text-muted-foreground max-w-xs text-sm">
                {mineOnly
                  ? tl('emptyMineBody')
                  : tab === 'active'
                    ? t('emptyActiveBody')
                    : t('emptyEndedBody')}
              </p>
            </div>
          )
        ) : (
          <nav aria-label={tl('navLabel')}>
            <ul>
              {rows?.map((g) => (
                <Row
                  key={g.id}
                  group={g}
                  now={now}
                  selected={g.id === selectedId}
                />
              ))}
            </ul>
          </nav>
        )}
        {loaded && !loaded.failed && loaded.next && (
          <div className="flex justify-center px-3 py-3">
            <Button
              variant="outline"
              size="sm"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore && (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              )}
              {t('loadMore')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

const BADGE = 'shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium';

function Row({
  group: g,
  now,
  selected,
}: {
  group: SgListItem;
  now: Date;
  selected: boolean;
}) {
  const t = useTranslations('SubmissionGroups');
  const tl = useTranslations('SubmissionGroups.list');
  const locale = useLocale();
  const ended = g.status === 'ENDED';
  const activity = relativeActivity(
    ended ? g.ended_at : g.last_activity_at,
    now
  );
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const when =
    activity.unit === 'none'
      ? null
      : activity.unit === 'now'
        ? t('justNow')
        : activity.unit === 'date'
          ? activity.date.toLocaleDateString(locale, {
              day: 'numeric',
              month: 'short',
              year:
                activity.date.getFullYear() === now.getFullYear()
                  ? undefined
                  : 'numeric',
            })
          : rtf.format(-activity.value, activity.unit);
  const named = groupTitle(g);
  const title = named ?? (g.contact ? tl('untitled') : t('contactRemoved'));
  const contactName = groupContactName(g);
  const chip = trackerStatusChip(g.submission_status);
  const noGroup = waModeOf(g) === 'none';
  const pending = g.pending && !ended && !noGroup;
  const archived = ended && g.archive;
  const noGroupBadge = noGroup && !ended;

  return (
    <li>
      <Link
        href={`/submission-groups/${g.id}`}
        aria-current={selected ? 'page' : undefined}
        className={cn(
          'border-border/60 focus-visible:ring-ring flex gap-3 border-b px-3 py-2.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset',
          selected ? 'bg-accent' : 'hover:bg-accent/50'
        )}
      >
        <span
          className={cn(
            'flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold',
            avatarTone(title),
            ended && 'opacity-70'
          )}
          aria-hidden
        >
          {initialsOf(title)}
        </span>
        <span className="min-w-0 flex-1 space-y-0.5">
          <span
            className={cn(
              'block truncate text-sm font-medium',
              !named && 'text-muted-foreground italic'
            )}
            title={title}
          >
            {title}
          </span>
          {contactName && (
            <span
              className="text-muted-foreground block truncate text-xs"
              title={contactName}
            >
              {tl('contactLine', { name: contactName })}
            </span>
          )}
          <span className="flex min-w-0 items-center gap-1.5 text-xs">
            <span
              className="text-muted-foreground shrink-0 font-mono text-[11px]"
              title={g.submission_ref}
            >
              {shortRef(g.submission_ref)}
            </span>
            {chip && (
              <span
                className={cn(
                  'min-w-0 truncate rounded-full px-1.5 py-px text-[10px] font-medium',
                  chip.chipClass
                )}
                title={chip.text}
              >
                {chip.text}
              </span>
            )}
            {when && (
              <span className="text-muted-foreground ml-auto shrink-0 pl-1 text-[11px] whitespace-nowrap">
                {ended ? t('endedAt', { when }) : when}
              </span>
            )}
          </span>
          {(noGroupBadge || pending || archived || g.my_label) && (
            <span className="flex flex-wrap items-center gap-1 pt-0.5">
              {g.my_label && (
                <span className={cn(BADGE, 'bg-success-soft text-success')}>
                  {t(`labels.${g.my_label}`)}
                </span>
              )}
              {pending && (
                <span className={cn(BADGE, 'bg-warning-soft text-warning')}>
                  {t('pendingBadge')}
                </span>
              )}
              {archived && (
                <span
                  className={cn(
                    BADGE,
                    'bg-muted text-muted-foreground inline-flex items-center gap-1'
                  )}
                >
                  <Archive className="size-2.5" aria-hidden />
                  {t('archiveBadge')}
                </span>
              )}
              {noGroupBadge && (
                <span className="text-muted-foreground inline-flex shrink-0 items-center gap-1 text-[10px]">
                  <MessageSquareOff className="size-3" aria-hidden />
                  {t('noWhatsappBadge')}
                </span>
              )}
            </span>
          )}
        </span>
      </Link>
    </li>
  );
}
