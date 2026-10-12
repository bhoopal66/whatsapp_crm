'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronLeft, Plus } from 'lucide-react';

import type { RoomSummary } from '@/lib/deal-rooms/reads';
import { roomSubLine } from '@/lib/deal-rooms/view';
import { cn } from '@/lib/utils';

export const roomHref = (id: string) => `/chat/rooms/${id}`;

/** "<subject>" over "<n> of 8 members · <phase>": both sidebars use it. */
export function RoomItem({
  room,
  active,
}: {
  room: RoomSummary;
  active: boolean;
}) {
  const t = useTranslations('Chat.rooms');
  const sub = roomSubLine(room);
  return (
    <Link
      href={roomHref(room.id)}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'block rounded-md border border-transparent px-3 py-1.5 hover:bg-white/5',
        active && 'border-amber-400 bg-[#3A2A14] hover:bg-[#3A2A14]'
      )}
    >
      <span className="block truncate text-sm font-semibold text-white">
        {room.subject}
      </span>
      <span className="block truncate text-xs text-white/55">
        {t('subLine', {
          count: sub.count,
          max: sub.max,
          phase: t(`phase.${sub.phase}`),
        })}
      </span>
    </Link>
  );
}

export interface DealRoomsSidebarProps {
  rooms: RoomSummary[] | null;
  activeRoomId: string | null;
  workspaceName: string;
  /** The create dialog (a later job); no button without it. */
  onCreateDealRoom?: () => void;
  className?: string;
}

/** The chat sidebar's drill-in list while a deal room is open. */
export function DealRoomsSidebar({
  rooms,
  activeRoomId,
  workspaceName,
  onCreateDealRoom,
  className,
}: DealRoomsSidebarProps) {
  const t = useTranslations('Chat');
  return (
    <aside
      className={cn(
        'flex h-full min-h-0 flex-col bg-[#12201C] text-white',
        className
      )}
    >
      <Link
        href="/chat"
        aria-label={t('rooms.back', { name: workspaceName })}
        className="flex items-center gap-1 px-3 pt-4 pb-2 text-[15px] font-bold hover:text-white/80"
      >
        <ChevronLeft className="size-4 shrink-0" aria-hidden />
        <span className="truncate">{workspaceName}</span>
      </Link>
      <nav
        className="min-h-0 flex-1 overflow-y-auto px-1 pb-4"
        aria-label={t('sections.dealRooms')}
      >
        <p className="px-3 pt-3 pb-1 text-[10px] font-semibold tracking-[0.14em] text-white/45 uppercase">
          {t('sections.dealRooms')}
        </p>
        {rooms === null ? (
          <div className="space-y-2 px-3 pt-2" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-8 animate-pulse rounded bg-white/10" />
            ))}
          </div>
        ) : rooms.length === 0 ? (
          <p className="px-3 pt-2 text-sm text-white/50">{t('rooms.empty')}</p>
        ) : (
          <ul className="space-y-0.5">
            {rooms.map((r) => (
              <li key={r.id}>
                <RoomItem room={r} active={r.id === activeRoomId} />
              </li>
            ))}
          </ul>
        )}
        {onCreateDealRoom && (
          <button
            type="button"
            onClick={onCreateDealRoom}
            className="mx-2 mt-3 flex w-[calc(100%-1rem)] items-center justify-center gap-1.5 rounded-md border border-dashed border-white/30 py-2 text-sm text-white/75 hover:bg-white/5 hover:text-white"
          >
            <Plus className="size-4" aria-hidden />
            {t('rooms.new')}
          </button>
        )}
      </nav>
    </aside>
  );
}
