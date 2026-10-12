'use client';

import { Suspense } from 'react';
import {
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
} from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Users, X } from 'lucide-react';

import { DealRoomMembersPanel } from '@/components/deal-rooms/members-panel';
import { DealRoomView } from '@/components/deal-rooms/room-view';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * One deal room: the group chat, or (?tab=notes) the Team notes. The
 * Members panel sits beside it on a wide screen; narrower, the header's
 * Members button opens it over the room (?panel=members).
 */
function RoomScreen() {
  const t = useTranslations('Chat.rooms.members');
  const { roomId } = useParams<{ roomId: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const shown = params.get('panel') === 'members';
  const toggle = () => {
    const q = new URLSearchParams(params.toString());
    if (shown) q.delete('panel');
    else q.set('panel', 'members');
    const s = q.toString();
    router.replace(`${pathname}${s ? `?${s}` : ''}`, { scroll: false });
  };
  return (
    <DealRoomView
      key={roomId}
      roomId={roomId}
      headerActions={() => (
        <Button
          variant="outline"
          size="sm"
          className="xl:hidden"
          aria-pressed={shown}
          onClick={toggle}
        >
          <Users className="size-4" aria-hidden />
          {t('open')}
        </Button>
      )}
      membersPanel={(ctx) => (
        <div
          className={cn(
            'min-h-0 flex-col',
            shown
              ? 'bg-background fixed inset-0 z-40 flex xl:static xl:z-auto'
              : 'hidden xl:flex'
          )}
        >
          <div className="flex justify-end border-b p-2 xl:hidden">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('close')}
              onClick={toggle}
            >
              <X className="size-4" />
            </Button>
          </div>
          <DealRoomMembersPanel {...ctx} />
        </div>
      )}
    />
  );
}

export default function DealRoomPage() {
  return (
    <Suspense fallback={null}>
      <RoomScreen />
    </Suspense>
  );
}
