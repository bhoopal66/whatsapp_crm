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
        'hover:bg-sidebar-accent focus-visible:ring-sidebar-ring block rounded-md border border-transparent px-3 py-1.5 transition-colors focus-visible:ring-2 focus-visible:outline-none',
        active && 'border-warning/40 bg-warning-soft hover:bg-warning-soft'
      )}
    >
      <span className="text-foreground block truncate text-sm font-semibold">
        {room.subject}
      </span>
      <span className="text-muted-foreground block truncate text-xs">
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
        'bg-card text-sidebar-foreground border-sidebar-border flex h-full min-h-0 flex-col lg:border-r',
        className
      )}
    >
      <Link
        href="/chat"
        aria-label={t('rooms.back', { name: workspaceName })}
        className="text-foreground hover:text-primary flex items-center gap-1 px-3 pt-4 pb-2 text-[15px] font-bold"
      >
        <ChevronLeft className="size-4 shrink-0" aria-hidden />
        <span className="truncate">{workspaceName}</span>
      </Link>
      <nav
        className="min-h-0 flex-1 overflow-y-auto px-1 pb-4"
        aria-label={t('sections.dealRooms')}
      >
        <p className="text-muted-foreground px-3 pt-3 pb-1 text-[11px] font-semibold tracking-[0.12em] uppercase">
          {t('sections.dealRooms')}
        </p>
        {rooms === null ? (
          <div className="space-y-2 px-3 pt-2" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i} className="bg-muted h-8 animate-pulse rounded" />
            ))}
          </div>
        ) : rooms.length === 0 ? (
          <p className="text-muted-foreground px-3 pt-2 text-sm">
            {t('rooms.empty')}
          </p>
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
            className="border-input text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground mx-2 mt-3 flex w-[calc(100%-1rem)] items-center justify-center gap-1.5 rounded-md border border-dashed py-2 text-sm"
          >
            <Plus className="size-4" aria-hidden />
            {t('rooms.new')}
          </button>
        )}
      </nav>
    </aside>
  );
}
