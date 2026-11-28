'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Columns3, ExternalLink, RotateCcw, Search } from 'lucide-react';

import { useDocTypes } from '@/components/desk/use-doc-types';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/use-auth';
import { docTypeLabel } from '@/lib/desk/doc-types';
import type {
  GroupLink,
  GroupOutcome,
  GroupWallRow,
} from '@/lib/desk/group-intake-store';
import { groupMessageSender } from '@/lib/groups/group-page';
import { groupMediaView } from '@/lib/groups/group-media';
import {
  joinFreshPage,
  messagePageQuery,
  startChatCatchUp,
} from '@/lib/groups/live-chat';
import type { WhatsappGroupMessageRow } from '@/lib/groups/types';
import { parseGroupList, type GroupListItem } from '@/lib/groups/ui';
import {
  WALL_MAX_COLUMNS,
  WALL_PAGE,
  filterWallMessages,
  isAtBottom,
  isWallFile,
  keepLatest,
  pickableGroups,
  resolveWallIds,
  serializeWallIds,
  shouldAutoScroll,
  toggleWallId,
  wallStorageKey,
  wallTimeLabel,
  type WallFilter,
} from '@/lib/groups/wall';
import {
  WALL_BANK_REFRESH_MS,
  WALL_OUTCOME_DEBOUNCE_MS,
  WALL_OUTCOME_FOLLOW_UP_MS,
  WALL_QUEUE_HREF,
  WALL_TONE_CLASS,
  canLinkWallGroup,
  wallFileTag,
  wallNoCoordinator,
  wallOutcomeIds,
  wallQueueChip,
  wallRepliedNote,
  type WallFileTag,
} from '@/lib/groups/wall-desk';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';

import { GroupWallLinkDialog } from './group-wall-link-dialog';

type Msg = Pick<
  WhatsappGroupMessageRow,
  | 'id'
  | 'direction'
  | 'sender_wa_id'
  | 'sender_name'
  | 'type'
  | 'body'
  | 'created_at'
> &
  Partial<WhatsappGroupMessageRow>;

type ListState = { groups: GroupListItem[]; failed: boolean } | null;

type BankState = { rows: Map<string, GroupWallRow>; failed: boolean };

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', ...init });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as T;
}

const fetchLinks = () =>
  fetchJson<{ links: GroupLink[] }>('/api/desk/group-links').then(
    (b) => new Map(b.links.map((l) => [l.groupId, l]))
  );

const fetchBanks = (idsKey: string) =>
  fetchJson<{ banks: GroupWallRow[] }>(
    `/api/desk/group-wall?ids=${encodeURIComponent(idsKey)}`
  ).then((b) => new Map(b.banks.map((r) => [r.groupId, r])));

const fetchOutcomes = (idsKey: string) =>
  fetchJson<{ outcomes: GroupOutcome[] }>('/api/desk/group-wall/outcomes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageIds: idsKey.split(',') }),
  }).then((b) => new Map(b.outcomes.map((o) => [o.groupMessageId, o])));

const KIND_KEYS = [
  'image',
  'video',
  'audio',
  'voice',
  'document',
  'sticker',
  'location',
] as const;

function readStored(key: string | null): string | null {
  if (!key) return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string | null, value: string) {
  if (!key) return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode or a full quota: the wall works without it.
  }
}

/**
 * Several WhatsApp groups side by side, live and read-only. It never
 * marks a group read (only opening the group does, migration 146), and
 * keeps only the chosen ids in localStorage, never messages.
 */
export function GroupWall({ idsParam }: { idsParam: string | null }) {
  const t = useTranslations('GroupWall');
  const { user, accountId, accountRole } = useAuth();
  // Registers the workspace's document labels for the file tags.
  useDocTypes();
  const userId = user?.id ?? null;
  const storageKey =
    accountId && userId ? wallStorageKey(accountId, userId) : null;
  const [list, setList] = useState<ListState>(null);
  const [ids, setIds] = useState<string[] | null>(null);
  const [filter, setFilter] = useState<WallFilter>('all');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [full, setFull] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const [links, setLinks] = useState<Map<string, GroupLink>>(() => new Map());
  const [linksTick, setLinksTick] = useState(0);
  const [banks, setBanks] = useState<BankState>(() => ({
    rows: new Map(),
    failed: false,
  }));
  // Bumped every minute while the page is visible and by "Refresh all":
  // the bank figures and the files' outcomes are asked again.
  const [bankTick, setBankTick] = useState(0);
  const [linkTarget, setLinkTarget] = useState<GroupListItem | null>(null);
  const canLink = canLinkWallGroup(accountRole);
  const mounted = useRef(true);

  const loadList = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp/groups', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const groups = parseGroupList(await res.json());
      if (mounted.current) setList({ groups, failed: false });
    } catch {
      // Keep what is on screen on a failed refresh; fail only a first load.
      if (mounted.current)
        setList((prev) => prev ?? { groups: [], failed: true });
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void loadList();
    return () => {
      mounted.current = false;
    };
  }, [loadList]);

  // Day labels move on at midnight without a reload.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // The bank figures, every minute while visible and on coming back.
  useEffect(() => {
    const bump = () => {
      if (document.visibilityState === 'visible') setBankTick((n) => n + 1);
    };
    const timer = setInterval(bump, WALL_BANK_REFRESH_MS);
    document.addEventListener('visibilitychange', bump);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', bump);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchLinks().then(
      (map) => {
        if (!cancelled) setLinks(map);
      },
      () => {
        // No links read is no tags and no bank header: the wall still reads.
      }
    );
    return () => {
      cancelled = true;
    };
  }, [linksTick]);

  const pickable = useMemo(
    () => pickableGroups(list?.groups ?? [], ''),
    [list]
  );
  const byId = useMemo(
    () => new Map(pickable.map((g) => [g.id, g])),
    [pickable]
  );

  // The first choice: the URL's ids, else this person's stored ones,
  // each dropped when the list does not hold it.
  const chosen = useMemo(() => {
    if (ids) return ids.filter((id) => byId.has(id));
    if (!list || list.failed || !storageKey) return null;
    return resolveWallIds(
      idsParam,
      readStored(storageKey),
      new Set(byId.keys())
    );
  }, [ids, byId, list, storageKey, idsParam]);

  const choose = (next: string[]) => {
    setIds(next);
    const value = serializeWallIds(next);
    writeStored(storageKey, value);
    // Keep the address in step, so the wall can be bookmarked or shared.
    try {
      const url = new URL(window.location.href);
      if (value) url.searchParams.set('ids', value);
      else url.searchParams.delete('ids');
      window.history.replaceState(window.history.state, '', url);
    } catch {
      // The address is a convenience only.
    }
  };

  const toggle = (id: string) => {
    const result = toggleWallId(chosen ?? [], id);
    setFull(result.full);
    if (!result.full) choose(result.ids);
  };

  const refreshAll = () => {
    void loadList();
    setRefreshTick((n) => n + 1);
    setBankTick((n) => n + 1);
    setLinksTick((n) => n + 1);
  };

  const columns = (chosen ?? [])
    .map((id) => byId.get(id))
    .filter((g): g is GroupListItem => !!g);
  // Only linked columns have bank figures to ask for.
  const linkedKey = columns
    .filter((g) => links.has(g.id))
    .map((g) => g.id)
    .join(',');

  useEffect(() => {
    if (linkedKey === '') return;
    let cancelled = false;
    fetchBanks(linkedKey).then(
      (rows) => {
        if (!cancelled) setBanks({ rows, failed: false });
      },
      () => {
        // Keep the last figures on a failed refresh, and say so.
        if (!cancelled) setBanks((prev) => ({ ...prev, failed: true }));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [linkedKey, bankTick]);
  const offered = pickableGroups(pickable, query);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="bg-card flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <div className="relative">
          <Button
            variant="outline"
            size="sm"
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((o) => !o)}
          >
            <Columns3 />
            {t('choose')}
          </Button>
          {pickerOpen && (
            <div
              className="bg-card absolute start-0 top-full z-20 mt-1 w-80 max-w-[calc(100vw-2rem)] rounded-lg border p-3 shadow-lg"
              onKeyDown={(e) => {
                if (e.key === 'Escape') setPickerOpen(false);
              }}
            >
              <div className="relative mb-2">
                <Search className="text-muted-foreground pointer-events-none absolute start-2 top-1/2 size-4 -translate-y-1/2" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('search')}
                  aria-label={t('search')}
                  className="ps-8"
                  autoFocus
                />
              </div>
              <p className="text-muted-foreground mb-1 text-xs">
                {t('chosenCount', {
                  count: chosen?.length ?? 0,
                  max: WALL_MAX_COLUMNS,
                })}
              </p>
              {full && (
                <p role="alert" className="text-warning mb-1 text-xs">
                  {t('tooMany', { max: WALL_MAX_COLUMNS })}
                </p>
              )}
              <div className="max-h-72 overflow-y-auto">
                {!list ? (
                  <p className="text-muted-foreground py-2 text-sm">
                    {t('listLoading')}
                  </p>
                ) : list.failed ? (
                  <p className="text-destructive py-2 text-sm">
                    {t('listFailed')}
                  </p>
                ) : pickable.length === 0 ? (
                  <p className="text-muted-foreground py-2 text-sm">
                    {t('noGroups')}
                  </p>
                ) : offered.length === 0 ? (
                  <p className="text-muted-foreground py-2 text-sm">
                    {t('noMatches')}
                  </p>
                ) : (
                  <ul className="space-y-0.5">
                    {offered.map((g) => (
                      <li key={g.id}>
                        <label className="hover:bg-muted flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm">
                          <Checkbox
                            checked={chosen?.includes(g.id) ?? false}
                            onCheckedChange={() => toggle(g.id)}
                          />
                          <span className="min-w-0 flex-1 truncate">
                            {g.name}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="mt-2 flex justify-end">
                <Button size="sm" onClick={() => setPickerOpen(false)}>
                  {t('done')}
                </Button>
              </div>
            </div>
          )}
        </div>
        <div
          role="group"
          aria-label={t('filterLabel')}
          className="bg-card-2 inline-flex rounded-lg border p-0.5"
        >
          {(['all', 'files'] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium',
                filter === f
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {t(f === 'all' ? 'filterAll' : 'filterFiles')}
            </button>
          ))}
        </div>
        <Button variant="outline" size="sm" onClick={refreshAll}>
          <RotateCcw />
          {t('refreshAll')}
        </Button>
        <span className="text-muted-foreground ms-auto hidden text-xs md:inline">
          {t('subtitle')}
        </span>
      </div>

      {list?.failed ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <p className="text-destructive text-sm">{t('listFailed')}</p>
          <Button variant="outline" size="sm" onClick={() => void loadList()}>
            {t('retry')}
          </Button>
        </div>
      ) : chosen === null ? (
        <p className="text-muted-foreground p-6 text-sm">{t('listLoading')}</p>
      ) : columns.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <Columns3 className="text-muted-foreground size-10" />
          <p className="font-medium">{t('emptyTitle')}</p>
          <p className="text-muted-foreground text-sm">
            {t('emptyBody', { max: WALL_MAX_COLUMNS })}
          </p>
          <Button size="sm" onClick={() => setPickerOpen(true)}>
            {t('choose')}
          </Button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 sm:flex-row sm:overflow-x-auto sm:overflow-y-hidden">
          {columns.map((g) => (
            <WallColumn
              key={g.id}
              group={g}
              filter={filter}
              refreshTick={refreshTick}
              outcomeTick={bankTick}
              userId={userId}
              now={now}
              link={links.get(g.id)}
              bank={banks.rows.get(g.id)}
              bankFailed={banks.failed}
              onLink={canLink ? () => setLinkTarget(g) : null}
            />
          ))}
        </div>
      )}
      {linkTarget && (
        <GroupWallLinkDialog
          key={linkTarget.id}
          group={linkTarget}
          link={links.get(linkTarget.id)}
          onClose={() => setLinkTarget(null)}
          onSaved={() => {
            setLinksTick((n) => n + 1);
            setBankTick((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

/** One group's latest messages, live. Reads only: never marks read. */
function WallColumn({
  group,
  filter,
  refreshTick,
  outcomeTick,
  userId,
  now,
  link,
  bank,
  bankFailed,
  onLink,
}: {
  group: GroupListItem;
  filter: WallFilter;
  refreshTick: number;
  outcomeTick: number;
  userId: string | null;
  now: Date;
  link: GroupLink | undefined;
  bank: GroupWallRow | undefined;
  bankFailed: boolean;
  /** Set only for team leaders and up. */
  onLink: (() => void) | null;
}) {
  const t = useTranslations('GroupWall');
  const tChat = useTranslations('Groups.page.chat');
  const locale = useLocale();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [status, setStatus] = useState<'loading' | 'failed' | 'ready'>(
    'loading'
  );
  const [attempt, setAttempt] = useState(0);
  const [outcomes, setOutcomes] = useState<Map<string, GroupOutcome>>(
    () => new Map()
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const filledRef = useRef(false);
  const mounted = useRef(true);
  const groupId = group.id;
  const href = `/groups/${groupId}`;
  const linked = !!link;

  const fetchPage = useCallback(
    () =>
      fetchJson<{ messages: Msg[]; hasMore: boolean }>(
        `/api/whatsapp/groups/${groupId}/messages?${messagePageQuery(WALL_PAGE)}`
      ),
    [groupId]
  );

  // The newest page, joined to what is held.
  const mergePage = useCallback(
    (page: { messages: Msg[]; hasMore: boolean }) => {
      setMessages((held) =>
        keepLatest(
          joinFreshPage({ messages: held, hasMore: true }, page).messages
        )
      );
      setStatus('ready');
    },
    []
  );

  // For the live catch-up. Returns false: the wall has nothing to mark
  // read, so the catch-up never settles a read.
  const refresh = useCallback(async (): Promise<boolean> => {
    const page = await fetchPage();
    if (mounted.current) mergePage(page);
    return false;
  }, [fetchPage, mergePage]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The mount's load, "Refresh all" and Retry. State is set only in the
  // answer's callbacks, never in the effect itself.
  useEffect(() => {
    let cancelled = false;
    fetchPage().then(
      (page) => {
        if (!cancelled) mergePage(page);
      },
      () => {
        if (!cancelled) setStatus((s) => (s === 'ready' ? s : 'failed'));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [fetchPage, mergePage, refreshTick, attempt]);

  // Realtime: new and updated rows of this group (RLS applies per user).
  useEffect(() => {
    const supabase = createClient();
    const live = startChatCatchUp({ refresh, settle: () => {} });
    const channel = supabase
      .channel(`group-wall:${groupId}:${Math.random().toString(36).slice(2)}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'whatsapp_group_messages',
          filter: `group_id=eq.${groupId}`,
        },
        (payload) => {
          if (payload.eventType === 'DELETE') return;
          live.changed();
          const row = payload.new as Msg;
          if (row?.id)
            setMessages((m) =>
              keepLatest(
                joinFreshPage(
                  { messages: m, hasMore: true },
                  {
                    messages: [row],
                    hasMore: false,
                  }
                ).messages
              )
            );
        }
      )
      .subscribe(live.onStatus);
    return () => {
      live.stop();
      void supabase.removeChannel(channel);
    };
  }, [groupId, refresh]);

  // What became of the files this column holds (linked groups only):
  // intake runs after the message is stored, so a new file is asked about
  // twice. The tick asks again because the item's current state moves on
  // (a coordinator files a queued one).
  const fileKey = useMemo(
    () => wallOutcomeIds(messages, isWallFile).key,
    [messages]
  );
  const askOutcomes = useCallback((key: string, isCancelled: () => boolean) => {
    fetchOutcomes(key).then(
      (map) => {
        if (!isCancelled()) setOutcomes(map);
      },
      () => {
        // Keep the tags on screen; the next ask may succeed.
      }
    );
  }, []);
  // One effect for both: a new set (or a new tick) is asked about after a
  // short pause; only a new set is asked about once more, later.
  const askedKeyRef = useRef('');
  useEffect(() => {
    if (!linked || fileKey === '') return;
    const fresh = askedKeyRef.current !== fileKey;
    askedKeyRef.current = fileKey;
    let cancelled = false;
    const isCancelled = () => cancelled;
    const first = setTimeout(
      () => askOutcomes(fileKey, isCancelled),
      WALL_OUTCOME_DEBOUNCE_MS
    );
    const again = fresh
      ? setTimeout(
          () => askOutcomes(fileKey, isCancelled),
          WALL_OUTCOME_FOLLOW_UP_MS
        )
      : undefined;
    return () => {
      cancelled = true;
      clearTimeout(first);
      if (again !== undefined) clearTimeout(again);
    };
  }, [linked, fileKey, outcomeTick, askOutcomes]);

  const shown = useMemo(
    () => filterWallMessages(messages, filter),
    [messages, filter]
  );

  // Follow new messages only while the reader is at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || status !== 'ready') return;
    const firstFill = !filledRef.current;
    filledRef.current = true;
    if (shouldAutoScroll({ firstFill, wasAtBottom: stickRef.current }))
      el.scrollTop = el.scrollHeight;
  }, [shown, status]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stickRef.current = isAtBottom(el);
  };

  const retry = () => {
    setStatus('loading');
    setAttempt((n) => n + 1);
  };

  const tagText = (tag: WallFileTag): string => {
    switch (tag.kind) {
      case 'filed': {
        const docType = docTypeLabel(tag.docKey);
        const caseNumber = tag.caseNumber ?? '';
        return docType
          ? t('desk.tags.filed', { caseNumber, docType })
          : t('desk.tags.filedNoDoc', { caseNumber });
      }
      case 'new_case':
        return tag.captionCode
          ? t('desk.tags.newCase', {
              caseNumber: tag.caseNumber ?? '',
              captionCode: tag.captionCode,
            })
          : t('desk.tags.newCaseNoCode', { caseNumber: tag.caseNumber ?? '' });
      case 'queued':
        return t('desk.tags.queued', {
          reason: t(`desk.queueReasons.${tag.reason}`),
        });
      case 'duplicate':
        return t('desk.tags.duplicate');
      case 'refused':
        return t('desk.tags.refused', {
          reason: t(`desk.refusalReasons.${tag.reason}`),
        });
      case 'unknown_sender':
        return t('desk.tags.unknownSender');
      case 'no_copy':
        return t('desk.tags.noCopy');
      case 'file_type':
        return t('desk.tags.fileType');
      default: {
        const unknown: never = tag;
        throw new Error(`Unknown tag: ${String(unknown)}`);
      }
    }
  };

  const lastAt = messages.at(-1)?.created_at ?? group.last_message_at;
  const last = wallTimeLabel(lastAt, now, locale);
  const bankName = bank?.bankName || link?.bankName || link?.bankCode || '';

  return (
    <section
      aria-label={group.name}
      className="bg-card flex h-[28rem] shrink-0 flex-col overflow-hidden rounded-lg border sm:h-full sm:min-w-[300px] sm:flex-1"
    >
      <header className="border-b px-3 py-2">
        <Link
          href={href}
          className="block truncate font-medium hover:underline"
        >
          {group.name}
        </Link>
        <p className="text-muted-foreground truncate text-xs">
          {t('members', { count: group.participants_count })}
          {' · '}
          {last
            ? t('lastAt', {
                time: last.day ? `${last.day} ${last.time}` : last.time,
              })
            : t('noLast')}
        </p>
        {link && (
          <WallBankHeader
            bankName={bankName}
            link={link}
            bank={bank}
            failed={bankFailed && !bank}
          />
        )}
      </header>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="bg-card-2 min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2"
      >
        {status === 'loading' ? (
          <p className="text-muted-foreground p-2 text-sm">{t('loading')}</p>
        ) : status === 'failed' ? (
          <div className="flex flex-col items-start gap-2 p-2">
            <p className="text-destructive text-sm">{t('loadFailed')}</p>
            <Button variant="outline" size="sm" onClick={retry}>
              {t('retry')}
            </Button>
          </div>
        ) : shown.length === 0 ? (
          <p className="text-muted-foreground p-2 text-sm">
            {t(filter === 'files' ? 'emptyFiles' : 'empty')}
          </p>
        ) : (
          shown.map((m) => {
            const out = m.direction === 'out';
            const sender = groupMessageSender(m, userId);
            const at = wallTimeLabel(m.created_at, now, locale);
            const view = groupMediaView(m.type, m.media, m.body);
            const isMedia = !!view || isWallFile(m);
            const kind = (KIND_KEYS as readonly string[]).includes(m.type)
              ? (m.type as (typeof KIND_KEYS)[number])
              : 'other';
            const text = view
              ? (view.caption ?? view.location?.label ?? null)
              : m.body;
            // A file of a linked group: what intake made of it.
            const recorded = linked ? outcomes.get(m.id) : undefined;
            const tag = wallFileTag(recorded);
            return (
              <div
                key={m.id}
                className={cn(
                  'rounded-md px-2.5 py-1.5 text-sm',
                  out
                    ? 'bg-wa-bubble-out border-primary ms-6 border-e-4'
                    : 'bg-wa-bubble-in me-6 border-s-4 border-transparent'
                )}
              >
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">
                    {sender.name
                      ? sender.isMe
                        ? tChat('me', { name: sender.name })
                        : sender.name
                      : tChat(out ? 'yourNumber' : 'someone')}
                  </span>
                  {at && (
                    <time
                      dateTime={m.created_at}
                      className="text-muted-foreground shrink-0 text-xs"
                    >
                      {at.day ? `${at.day} ${at.time}` : at.time}
                    </time>
                  )}
                </div>
                {isMedia && (
                  <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                    <span className="font-medium">{t(`kinds.${kind}`)}</span>
                    {view?.filename && (
                      <span className="min-w-0 truncate">{view.filename}</span>
                    )}
                    <Link
                      href={href}
                      className="text-primary ms-auto inline-flex shrink-0 items-center gap-0.5 hover:underline"
                    >
                      {t('open')}
                      <ExternalLink className="size-3" />
                    </Link>
                  </p>
                )}
                {text ? (
                  <p className="line-clamp-6 break-words whitespace-pre-wrap">
                    {text}
                  </p>
                ) : (
                  !isMedia && (
                    <p className="text-muted-foreground italic">
                      {t('kinds.other')}
                    </p>
                  )
                )}
                {tag && (
                  <p
                    className={cn(
                      'mt-1 inline-block rounded px-1.5 py-0.5 text-xs font-medium',
                      WALL_TONE_CLASS[tag.tone]
                    )}
                  >
                    {tagText(tag)}
                  </p>
                )}
                {wallRepliedNote(recorded) && (
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    {t('desk.replied')}
                  </p>
                )}
              </div>
            );
          })
        )}
      </div>
      {link ? (
        <footer className="flex items-center justify-between gap-2 border-t px-3 py-1.5">
          {bank && bank.toSort > 0 ? (
            <Link
              href={WALL_QUEUE_HREF}
              className="text-primary min-w-0 truncate text-xs font-medium hover:underline"
            >
              {t('desk.openQueue', { bank: bankName, count: bank.toSort })}
            </Link>
          ) : (
            <span className="text-muted-foreground text-xs">
              {bank ? t('desk.allSorted') : t('readOnly')}
            </span>
          )}
          {onLink && (
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              onClick={onLink}
            >
              {t('desk.linkSettings')}
            </Button>
          )}
        </footer>
      ) : (
        <footer className="flex items-center justify-between gap-2 border-t px-3 py-1.5">
          <span className="text-muted-foreground text-xs">
            {t('desk.notLinked')}
          </span>
          {onLink ? (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={onLink}
            >
              {t('desk.linkButton')}
            </Button>
          ) : (
            <Link
              href={href}
              className="text-primary text-xs font-medium hover:underline"
            >
              {t('openToReply')}
            </Link>
          )}
        </footer>
      )}
    </section>
  );
}

const CHIP = 'rounded-full px-2 py-0.5 text-xs font-medium';
const CHIP_NEUTRAL = 'bg-card-2 text-foreground border';

/** A linked group's bank, coordinators, today's filings and its queue. */
function WallBankHeader({
  bankName,
  link,
  bank,
  failed,
}: {
  bankName: string;
  link: GroupLink;
  bank: GroupWallRow | undefined;
  failed: boolean;
}) {
  const t = useTranslations('GroupWall.desk');
  const shortCode = bank?.shortCode ?? null;
  return (
    <div className="mt-1.5 space-y-1">
      <p className="truncate text-xs">
        <span className="font-medium">{bankName}</span>
        {shortCode && (
          <span className="text-muted-foreground">
            {' · '}
            {shortCode}
          </span>
        )}
      </p>
      {!link.intakeEnabled && (
        <p className="text-muted-foreground text-xs">{t('intakeOff')}</p>
      )}
      {failed ? (
        <p className="text-destructive text-xs">{t('bankFailed')}</p>
      ) : bank ? (
        <>
          <p className="text-muted-foreground truncate text-xs">
            {wallNoCoordinator(bank)
              ? t('noCoordinator')
              : t('primarySecond', {
                  primary: bank.primaryName ?? t('notSet'),
                  second: bank.secondName ?? t('notSet'),
                })}
          </p>
          <WallBankChips bank={bank} />
        </>
      ) : null}
    </div>
  );
}

function WallBankChips({ bank }: { bank: GroupWallRow }) {
  const t = useTranslations('GroupWall.desk');
  const queue = wallQueueChip(bank);
  return (
    <div className="flex flex-wrap gap-1">
      <span className={cn(CHIP, CHIP_NEUTRAL)}>
        {t('filedToday', { count: bank.filedToday })}
      </span>
      <span
        className={cn(
          CHIP,
          queue.alert ? WALL_TONE_CLASS.destructive : CHIP_NEUTRAL
        )}
      >
        {queue.age
          ? queue.age.hours > 0
            ? t('toSortOldestHours', {
                count: queue.count,
                hours: queue.age.hours,
                minutes: queue.age.minutes,
              })
            : t('toSortOldestMinutes', {
                count: queue.count,
                minutes: queue.age.minutes,
              })
          : t('toSort', { count: queue.count })}
      </span>
      {bank.alert === 'no_coordinator' && (
        <span className={cn(CHIP, WALL_TONE_CLASS.destructive)}>
          {t('noCoordinator')}
        </span>
      )}
    </div>
  );
}
