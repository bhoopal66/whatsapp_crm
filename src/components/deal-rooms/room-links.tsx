'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { useScopedDealRooms } from '@/hooks/use-deal-rooms';
import { useAccountNumbers } from '@/hooks/use-whatsapp-numbers';
import {
  dealRoomEntry,
  hasMetaNumber,
  type DealRoomContact,
  type DealRoomDeal,
  type RoomScope,
} from '@/lib/deal-rooms/entry';
import type { RoomSummary } from '@/lib/deal-rooms/reads';
import { roomSubLine } from '@/lib/deal-rooms/view';
import { cn } from '@/lib/utils';

import { CreateDealRoomDialog } from './create-dialog';
import { roomHref } from './rooms-sidebar';

/** `default` on cards and sheets, `wa` in the inbox's WhatsApp panel. */
type Tone = 'default' | 'wa';

const TONES: Record<
  Tone,
  { item: string; title: string; sub: string; action: string }
> = {
  default: {
    item: 'bg-muted/60 hover:bg-muted',
    title: 'text-foreground',
    sub: 'text-muted-foreground',
    action: 'text-muted-foreground hover:text-foreground hover:bg-muted',
  },
  wa: {
    item: 'bg-wa-search hover:bg-wa-row-hover',
    title: 'text-wa-text',
    sub: 'text-wa-text-secondary',
    action: 'text-wa-text-secondary hover:text-wa-text hover:bg-wa-row-hover',
  },
};

function RoomLink({
  room,
  showDeal,
  tone,
}: {
  room: RoomSummary;
  showDeal: boolean;
  tone: Tone;
}) {
  const t = useTranslations('Chat.rooms');
  const sub = roomSubLine(room);
  const c = TONES[tone];
  return (
    <Link
      href={roomHref(room.id)}
      className={cn('block rounded-lg px-3 py-2', c.item)}
    >
      <span className={cn('block truncate text-sm font-medium', c.title)}>
        {room.subject}
      </span>
      <span className={cn('block truncate text-xs', c.sub)}>
        {t('subLine', {
          count: sub.count,
          max: sub.max,
          phase: t(`phase.${sub.phase}`),
        })}
      </span>
      {showDeal && room.dealTitle && (
        <span className={cn('block truncate text-xs', c.sub)}>
          {t('entry.deal', { title: room.dealTitle })}
        </span>
      )}
    </Link>
  );
}

/**
 * A contact's or a deal's deal rooms, each a link into team chat, and
 * "New deal room" with the create dialog prefilled. Renders nothing
 * unless `dealRoomEntry` says so: never for a bank guest, only with a
 * Meta number. `frame` wraps the block in the host screen's own section.
 */
export function DealRoomLinks({
  contact,
  deal = null,
  tone = 'default',
  frame,
}: {
  /** The customer; null for a deal whose contact was deleted. */
  contact: DealRoomContact | null;
  /** Set on a deal: its rooms are listed and it is prefilled. */
  deal?: DealRoomDeal | null;
  tone?: Tone;
  frame: (title: string, body: ReactNode) => ReactNode;
}) {
  const t = useTranslations('Chat.rooms');
  const { accountRole, isBankGuest } = useAuth();
  const [open, setOpen] = useState(false);
  const numbers = useAccountNumbers(!isBankGuest && accountRole !== null);
  const metaNumber = hasMetaNumber(numbers);
  const probe = dealRoomEntry({ accountRole, metaNumber, rooms: null });
  const scope: RoomScope | null = !probe.load
    ? null
    : deal
      ? { dealId: deal.id }
      : contact
        ? { contactId: contact.id }
        : null;
  const { rooms, failed } = useScopedDealRooms(scope);
  const entry = dealRoomEntry({
    accountRole,
    metaNumber,
    rooms: rooms?.length ?? null,
  });
  if (!scope || !entry.show) return null;
  const canCreate = entry.create && contact !== null;
  const c = TONES[tone];

  const body = (
    <div className="space-y-2">
      {rooms === null ? (
        failed ? (
          <p className={cn('text-xs', c.sub)}>{t('entry.failed')}</p>
        ) : (
          <div className="bg-muted h-9 animate-pulse rounded-lg" aria-hidden />
        )
      ) : rooms.length === 0 ? (
        <p className={cn('text-xs', c.sub)}>
          {deal ? t('entry.noneForDeal') : t('entry.none')}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {rooms.map((r) => (
            <li key={r.id}>
              <RoomLink room={r} showDeal={!deal} tone={tone} />
            </li>
          ))}
        </ul>
      )}
      {canCreate && (
        <>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors',
              c.action
            )}
          >
            <Plus className="size-3.5" aria-hidden />
            {t('new')}
          </button>
          <CreateDealRoomDialog
            open={open}
            onOpenChange={setOpen}
            initialContact={contact}
            initialDeal={deal}
          />
        </>
      )}
    </div>
  );
  return <>{frame(t('entry.title'), body)}</>;
}
