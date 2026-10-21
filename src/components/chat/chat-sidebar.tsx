'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  Archive,
  BellOff,
  Bookmark,
  ChevronDown,
  ChevronRight,
  Hash,
  Lock,
  MessageCircle,
  PenSquare,
  Plus,
  Search,
} from 'lucide-react';

import { RoomItem } from '@/components/deal-rooms/rooms-sidebar';
import { useAuth } from '@/hooks/use-auth';
import type { RoomSummary } from '@/lib/deal-rooms/reads';
import { useAccountNumbers } from '@/hooks/use-whatsapp-numbers';
import { useInboxCounts } from '@/hooks/use-chat-workspace';
import {
  combinedPresence,
  dmOthers,
  inboxRows,
  presenceDot,
  sidebarRowEmphasis,
  sidebarSections,
  type SidebarChannelRow,
} from '@/lib/chat/view';
import { isSavedPath, SAVED_PATH } from '@/lib/chat/saved';
import { PERSON_PRESENCE_KEY } from '@/lib/person-presence';
import { channelDisplayName as numberName } from '@/lib/whatsapp/channel-management';
import { cn } from '@/lib/utils';

import { CallsSection } from './calls-section';
import { useChatWorkspaceContext } from './chat-context';
import { PresenceDot } from './presence-dot';
import { useSavedCount } from './saved-items';

const SECTION_LABEL =
  'px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground';
const ROW =
  'flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm text-sidebar-foreground/85 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring';

export interface ChatSidebarProps {
  activeChannelId: string | null;
  /** The deal rooms the viewer can see (null while loading). */
  rooms?: RoomSummary[] | null;
  /** Opens the New-channel dialog; the button is disabled without it. */
  onCompose?: () => void;
  /** Opens the DM picker; no "+" by Direct messages without it. */
  onNewDm?: () => void;
  className?: string;
}

/** Follows the mode: sidebar surface, the app accent on the open row. */
export function ChatSidebar({
  activeChannelId,
  rooms = null,
  onCompose,
  onNewDm,
  className,
}: ChatSidebarProps) {
  const t = useTranslations('Chat');
  const tp = useTranslations('Presence');
  const router = useRouter();
  const savedActive = isSavedPath(usePathname());
  const savedCount = useSavedCount();
  const { account, workspaces, activeWorkspaceId, isBankGuest, accountRole } =
    useAuth();
  const ws = useChatWorkspaceContext();
  const numbers = useAccountNumbers(!isBankGuest);
  const inbox = useInboxCounts(!isBankGuest);
  const [q, setQ] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  // Presence dots go stale by time alone, so the clock ticks.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const wsName =
    workspaces.find((w) => w.accountId === activeWorkspaceId)?.name ??
    account?.name ??
    '';
  const primary = numbers?.find((n) => n.is_primary) ?? numbers?.[0];
  const connected =
    primary && (!primary.status || primary.status === 'connected');

  const sections = useMemo(
    () =>
      sidebarSections(
        ws.channels ?? [],
        ws.unread,
        ws.userId ?? '',
        ws.peopleById,
        t('unknownPerson')
      ),
    [ws.channels, ws.unread, ws.userId, ws.peopleById, t]
  );
  const rows = isBankGuest ? [] : inboxRows({ role: accountRole, ...inbox });
  // Collapsed until asked for, or while one of them is open.
  const archivedOpen =
    showArchived ||
    sections.archived.some((r) => r.channel.id === activeChannelId);

  const channelRow = (r: SidebarChannelRow) => {
    const active = r.channel.id === activeChannelId;
    const e = sidebarRowEmphasis(r, active);
    let icon: React.ReactNode;
    if (r.channel.kind === 'dm') {
      const dots = dmOthers(r.channel.dmMemberIds, ws.userId ?? '').map((id) =>
        presenceDot(
          ws.peopleById.get(id.toLowerCase()),
          now,
          ws.phonePresence[id.toLowerCase()]?.state
        )
      );
      const state = combinedPresence(dots);
      icon = (
        <PresenceDot state={state} label={tp(PERSON_PRESENCE_KEY[state])} />
      );
    } else if (r.channel.kind === 'deal_room') {
      icon = (
        <MessageCircle className="text-warning size-4 shrink-0" aria-hidden />
      );
    } else if (r.channel.kind === 'private') {
      icon = <Lock className="size-3.5 shrink-0" aria-hidden />;
    } else {
      icon = <Hash className="size-3.5 shrink-0" aria-hidden />;
    }
    return (
      <li key={r.channel.id}>
        <Link
          href={`/chat/${r.channel.id}`}
          aria-current={active ? 'page' : undefined}
          className={cn(
            ROW,
            active &&
              'bg-primary-soft text-primary hover:bg-primary-soft hover:text-primary font-semibold',
            e.bold && 'text-foreground font-semibold',
            e.dimmed && 'text-muted-foreground/80'
          )}
        >
          {icon}
          <span className="min-w-0 flex-1 truncate">{r.name}</span>
          {r.muted && (
            <span className="shrink-0" title={t('mute.label')}>
              <BellOff className="size-3 opacity-70" aria-hidden />
              <span className="sr-only">{t('mute.label')}</span>
            </span>
          )}
          {e.badge?.kind === 'mentions' ? (
            <span
              className="bg-primary text-primary-foreground min-w-5 rounded-full px-1.5 text-center text-[11px] font-bold"
              aria-label={t('mentions', { count: e.badge.count })}
            >
              {e.badge.count}
            </span>
          ) : e.badge ? (
            <span
              className={cn(
                'text-xs tabular-nums',
                e.dimmed
                  ? 'text-muted-foreground'
                  : 'bg-secondary text-secondary-foreground min-w-5 rounded-full px-1.5 text-center font-semibold'
              )}
            >
              {e.badge.count}
            </span>
          ) : null}
        </Link>
      </li>
    );
  };

  const section = (
    label: string,
    list: SidebarChannelRow[],
    add?: { label: string; onClick: () => void }
  ) =>
    (list.length > 0 || add) && (
      <div>
        <div className="flex items-center pr-2">
          <p className={cn(SECTION_LABEL, 'min-w-0 flex-1')}>{label}</p>
          {add && (
            <button
              type="button"
              onClick={add.onClick}
              aria-label={add.label}
              title={add.label}
              className="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-sidebar-ring mt-3 flex size-6 items-center justify-center rounded-md focus-visible:ring-2 focus-visible:outline-none"
            >
              <Plus className="size-3.5" />
            </button>
          )}
        </div>
        <ul>{list.map(channelRow)}</ul>
      </div>
    );

  return (
    <aside
      className={cn(
        'bg-card text-sidebar-foreground border-sidebar-border flex h-full min-h-0 flex-col lg:border-r',
        className
      )}
    >
      <div className="flex items-start gap-2 px-4 pt-4 pb-2">
        <div className="min-w-0 flex-1">
          <p className="text-foreground truncate text-[15px] font-bold">
            {wsName}
          </p>
          {!isBankGuest && connected && primary && (
            <p className="text-muted-foreground truncate text-xs">
              {t('whatsappLine', { name: numberName(primary) })}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onCompose}
          disabled={!onCompose || isBankGuest}
          aria-label={t('compose')}
          className="border-input text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring flex size-8 items-center justify-center rounded-lg border bg-transparent focus-visible:ring-2 focus-visible:outline-none disabled:opacity-40"
        >
          <PenSquare className="size-4" />
        </button>
      </div>
      <form
        className="px-3"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          const query = q.trim();
          if (query) router.push(`/chat?search=${encodeURIComponent(query)}`);
        }}
      >
        <label className="border-input bg-background text-muted-foreground focus-within:border-ring focus-within:ring-ring/30 flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm focus-within:ring-2">
          <Search className="size-4 shrink-0" aria-hidden />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
            className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent outline-none"
          />
        </label>
      </form>
      <nav
        className="min-h-0 flex-1 overflow-y-auto px-1 pb-4"
        aria-label={t('title')}
      >
        <Link
          href={SAVED_PATH}
          aria-current={savedActive ? 'page' : undefined}
          className={cn(
            ROW,
            'mt-2',
            savedActive &&
              'bg-primary-soft text-primary hover:bg-primary-soft hover:text-primary font-semibold'
          )}
        >
          <Bookmark className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{t('saved.row')}</span>
          {savedCount ? (
            <span className="text-muted-foreground text-xs tabular-nums">
              {savedCount}
            </span>
          ) : null}
        </Link>
        {rows.length > 0 && (
          <div>
            <p className={SECTION_LABEL}>{t('sections.inbox')}</p>
            <ul>
              {rows.map((r) => (
                <li key={r.id}>
                  <Link href={r.href} className={ROW}>
                    <span className="min-w-0 flex-1 truncate">
                      {r.kind === 'unassigned'
                        ? t('unassigned')
                        : r.kind === 'mine'
                          ? t('assignedToMe')
                          : r.label}
                    </span>
                    <span
                      className={cn(
                        'text-xs',
                        r.kind === 'unassigned' && r.count > 0
                          ? 'min-w-5 rounded-full bg-amber-400 px-1.5 text-center font-bold text-amber-950'
                          : 'text-muted-foreground tabular-nums'
                      )}
                    >
                      {r.count}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!isBankGuest && (
          <CallsSection labelClassName={SECTION_LABEL} rowClassName={ROW} />
        )}
        {section(t('sections.channels'), sections.team)}
        {rooms && rooms.length > 0 && (
          <div>
            <p className={SECTION_LABEL}>{t('sections.dealRooms')}</p>
            <ul className="space-y-0.5">
              {rooms.map((r) => (
                <li key={r.id}>
                  <RoomItem room={r} active={false} />
                </li>
              ))}
            </ul>
          </div>
        )}
        {sections.archived.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setShowArchived(!archivedOpen)}
              aria-expanded={archivedOpen}
              aria-label={t(
                archivedOpen ? 'settings.hideArchived' : 'settings.showArchived'
              )}
              className={cn(
                SECTION_LABEL,
                'hover:text-foreground flex w-full items-center gap-1 text-left'
              )}
            >
              {archivedOpen ? (
                <ChevronDown className="size-3" aria-hidden />
              ) : (
                <ChevronRight className="size-3" aria-hidden />
              )}
              <Archive className="size-3" aria-hidden />
              {t('sections.archived', { count: sections.archived.length })}
            </button>
            {archivedOpen && (
              <ul className="opacity-80">
                {sections.archived.map(channelRow)}
              </ul>
            )}
          </div>
        )}
        {section(
          t('sections.dms'),
          sections.dms,
          onNewDm && !isBankGuest
            ? { label: t('dm.new'), onClick: onNewDm }
            : undefined
        )}
        {ws.channels === null ? (
          <div className="space-y-2 px-3 pt-4" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="bg-muted h-4 animate-pulse rounded" />
            ))}
          </div>
        ) : (
          ws.channels.length === 0 && (
            <p className="text-muted-foreground px-3 pt-4 text-sm">
              {t('noChannels')}
            </p>
          )
        )}
      </nav>
    </aside>
  );
}
