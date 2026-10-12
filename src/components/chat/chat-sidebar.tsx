'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  Bookmark,
  Hash,
  Lock,
  MessageCircle,
  PenSquare,
  Plus,
  Search,
} from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { useAccountNumbers } from '@/hooks/use-whatsapp-numbers';
import { useInboxCounts } from '@/hooks/use-chat-workspace';
import {
  combinedPresence,
  dmOthers,
  inboxRows,
  presenceDot,
  sidebarSections,
  type SidebarChannelRow,
} from '@/lib/chat/view';
import { isSavedPath, SAVED_PATH } from '@/lib/chat/saved';
import { channelDisplayName as numberName } from '@/lib/whatsapp/channel-management';
import { cn } from '@/lib/utils';

import { useChatWorkspaceContext } from './chat-context';
import { PresenceDot } from './presence-dot';
import { useSavedCount } from './saved-items';

const SECTION_LABEL =
  'px-3 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/45';
const ROW =
  'flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm text-white/75 hover:bg-white/5';

export interface ChatSidebarProps {
  activeChannelId: string | null;
  /** Opens the New-channel dialog; the button is disabled without it. */
  onCompose?: () => void;
  /** Opens the DM picker; no "+" by Direct messages without it. */
  onNewDm?: () => void;
  className?: string;
}

/** Dark green-black in both modes, by design. */
export function ChatSidebar({
  activeChannelId,
  onCompose,
  onNewDm,
  className,
}: ChatSidebarProps) {
  const t = useTranslations('Chat');
  const router = useRouter();
  const savedActive = isSavedPath(usePathname());
  const savedCount = useSavedCount();
  const { account, workspaces, activeWorkspaceId, isBankGuest, accountRole } =
    useAuth();
  const ws = useChatWorkspaceContext();
  const numbers = useAccountNumbers(!isBankGuest);
  const inbox = useInboxCounts(!isBankGuest);
  const [q, setQ] = useState('');
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

  const channelRow = (r: SidebarChannelRow) => {
    const active = r.channel.id === activeChannelId;
    const bold = r.unread > 0 && !active;
    let icon: React.ReactNode;
    if (r.channel.kind === 'dm') {
      const dots = dmOthers(r.channel.dmMemberIds, ws.userId ?? '').map((id) =>
        presenceDot(ws.peopleById.get(id.toLowerCase()), now)
      );
      icon = <PresenceDot state={combinedPresence(dots)} />;
    } else if (r.channel.kind === 'deal_room') {
      icon = (
        <MessageCircle className="size-4 shrink-0 text-amber-400" aria-hidden />
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
              'bg-[#0E7C5A] font-semibold text-white hover:bg-[#0E7C5A]',
            bold && 'font-semibold text-white'
          )}
        >
          {icon}
          <span className="min-w-0 flex-1 truncate">{r.name}</span>
          {r.mentions > 0 && !active ? (
            <span
              className="rounded-full bg-amber-400 px-1.5 text-[11px] font-bold text-black"
              aria-label={t('mentions', { count: r.mentions })}
            >
              {r.mentions}
            </span>
          ) : bold ? (
            <span className="text-xs text-white/70">{r.unread}</span>
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
              className="mt-3 flex size-6 items-center justify-center rounded-md text-white/60 hover:bg-white/10 hover:text-white"
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
        'flex h-full min-h-0 flex-col bg-[#12201C] text-white',
        className
      )}
    >
      <div className="flex items-start gap-2 px-4 pt-4 pb-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-bold">{wsName}</p>
          {!isBankGuest && connected && primary && (
            <p className="truncate text-xs text-white/55">
              {t('whatsappLine', { name: numberName(primary) })}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onCompose}
          disabled={!onCompose || isBankGuest}
          aria-label={t('compose')}
          className="flex size-8 items-center justify-center rounded-lg bg-white/10 text-white hover:bg-white/15 disabled:opacity-40"
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
        <label className="flex items-center gap-2 rounded-md bg-white/10 px-2.5 py-1.5 text-sm text-white/60">
          <Search className="size-4 shrink-0" aria-hidden />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
            className="min-w-0 flex-1 bg-transparent text-white outline-none placeholder:text-white/45"
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
              'bg-[#0E7C5A] font-semibold text-white hover:bg-[#0E7C5A]'
          )}
        >
          <Bookmark className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{t('saved.row')}</span>
          {savedCount ? (
            <span className="text-xs text-white/60">{savedCount}</span>
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
                          ? 'rounded-full bg-amber-400 px-1.5 font-bold text-black'
                          : 'text-white/50'
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
        {section(t('sections.channels'), sections.team)}
        {section(t('sections.dealRooms'), sections.dealRooms)}
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
              <div key={i} className="h-4 animate-pulse rounded bg-white/10" />
            ))}
          </div>
        ) : (
          ws.channels.length === 0 && (
            <p className="px-3 pt-4 text-sm text-white/50">{t('noChannels')}</p>
          )
        )}
      </nav>
    </aside>
  );
}
