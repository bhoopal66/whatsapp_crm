'use client';

import { Copy, Info, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import type { MeetingCall } from '@/hooks/use-meeting-call';
import {
  releasePointerFocus,
  returnFocusOnClose,
} from '@/lib/meetings/room-ui/controls';
import { formatElapsed } from '@/lib/meetings/room-ui/people';
import type { RoomPanel } from '@/lib/meetings/session/room-ui';

import { useWorkspaceMembers } from '../use-workspace-members';
import { RoomStatusChips } from './room-status-chips';
import { QualityBars } from './room-tile';

const CHIP =
  'h-8 rounded-xl bg-card-2 text-foreground transition-colors duration-150 ease-out hover:bg-muted motion-reduce:transition-none dark:hover:bg-muted';

/** Its own component: a tick a second should repaint only these digits. */
function ElapsedTimer({ since }: { since: number }) {
  const t = useTranslations('MeetingRoom.topBar');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span
      className="text-muted-foreground shrink-0 tabular-nums"
      aria-label={t('elapsed')}
    >
      {formatElapsed(now - since)}
    </span>
  );
}

/** Drawn only while the popover is open, so `window` is there. */
function MeetingDetails({
  call,
  meetingId,
}: {
  call: MeetingCall;
  meetingId: string;
}) {
  const t = useTranslations('MeetingRoom.topBar');
  const { nameOf } = useWorkspaceMembers();
  const organiser = call.meeting ? nameOf(call.meeting.host_user_id) : null;
  const url = `${window.location.origin}/meetings/${meetingId}`;
  const copy = () => {
    const copied = navigator.clipboard?.writeText(url);
    if (!copied) {
      toast.error(t('copyFailed'));
      return;
    }
    copied.then(
      () => toast.success(t('copied')),
      () => toast.error(t('copyFailed'))
    );
  };
  return (
    <>
      <p className="truncate font-semibold">{call.meeting?.title}</p>
      {organiser && (
        <div>
          <p className="text-muted-foreground text-xs">{t('organiser')}</p>
          <p className="truncate">{organiser}</p>
        </div>
      )}
      <div className="flex flex-col gap-1">
        <p className="text-muted-foreground text-xs">{t('link')}</p>
        <div className="flex items-center gap-2">
          <span className="bg-card-2 min-w-0 flex-1 truncate rounded-lg px-2 py-1.5 text-xs">
            {url}
          </span>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="rounded-lg"
            onClick={copy}
          >
            <Copy />
            {t('copy')}
          </Button>
        </div>
      </div>
    </>
  );
}

/** Title and timer on the left; connection, people and details on the right. */
export function RoomTopBar({
  call,
  meetingId,
  onOpenPanel,
}: {
  call: MeetingCall;
  meetingId: string;
  onOpenPanel: (panel: RoomPanel) => void;
}) {
  const t = useTranslations('MeetingRoom.topBar');
  const since = call.liveSince ? Date.parse(call.liveSince) : NaN;
  return (
    <header
      className="flex h-12 shrink-0 items-center gap-3 px-3 text-sm"
      onClick={releasePointerFocus}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <h1 className="min-w-0 truncate font-semibold">
          {call.meeting?.title}
        </h1>
        {Number.isFinite(since) && <ElapsedTimer since={since} />}
        <RoomStatusChips call={call} />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <QualityBars quality={call.quality.self} />
        <Button
          type="button"
          variant="ghost"
          className={`${CHIP} gap-1.5 px-2.5`}
          title={t('people')}
          onClick={() => onOpenPanel('people')}
        >
          <Users className="size-4" aria-hidden />
          <span className="tabular-nums">
            {Math.max(1, call.participants.length)}
          </span>
        </Button>
        <Popover>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={CHIP}
                aria-label={t('info')}
                title={t('info')}
              />
            }
          >
            <Info />
          </PopoverTrigger>
          <PopoverContent
            data-mode="dark"
            align="end"
            className="w-80 gap-3 rounded-xl p-3"
            finalFocus={returnFocusOnClose}
          >
            <MeetingDetails call={call} meetingId={meetingId} />
          </PopoverContent>
        </Popover>
      </div>
    </header>
  );
}
