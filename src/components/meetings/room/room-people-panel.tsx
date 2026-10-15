'use client';

import { Hand, Mic, MicOff, MoreVertical, Video, VideoOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAuth } from '@/hooks/use-auth';
import type { MeetingCall } from '@/hooks/use-meeting-call';
import type { ModerationAction } from '@/lib/meetings/room/contract';
import {
  peopleForPanel,
  type PanelPerson,
} from '@/lib/meetings/room-ui/panels';
import { avatarColor, initials } from '@/lib/meetings/room-ui/people';
import { cn } from '@/lib/utils';

import { useWorkspaceMembers } from '../use-workspace-members';
import { ConfirmDialog } from './confirm-dialog';

/** Everyone in the call: raised hands first, with the host's tools. */
export function RoomPeoplePanel({ call }: { call: MeetingCall }) {
  const t = useTranslations('MeetingRoom');
  const { nameOf } = useWorkspaceMembers();
  const { profile, user } = useAuth();
  const [removing, setRemoving] = useState<PanelPerson | null>(null);

  const people = peopleForPanel({
    rows: call.participants,
    self: {
      participantId: call.participantId,
      userId: user?.id ?? null,
      name: profile?.full_name ?? '',
      micOn: call.micOn,
      cameraOn: call.cameraOn,
      handRaised: call.handRaised,
    },
    nameOf,
    unknownName: t('tile.unknown'),
  });

  const moderate = async (p: PanelPerson, action: ModerationAction) => {
    if (!(await call.moderate(p.id, action)))
      toast.error(t('tile.moderateFailed'));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="text-muted-foreground px-4 pb-2 text-xs">
        {t('panels.people.count', { count: people.length })}
      </p>
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {people.map((p) => (
          <li
            key={p.id}
            className="hover:bg-muted/60 flex items-center gap-3 rounded-md px-2 py-1.5"
          >
            <span
              className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-medium text-white',
                avatarColor(p.userId || p.name)
              )}
              aria-hidden
            >
              {initials(p.name) || '?'}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm">
              {p.isSelf ? t('tile.you', { name: p.name }) : p.name}
            </span>
            {p.handRaisedAt && (
              <Hand
                className="size-4 shrink-0 text-amber-500"
                aria-label={t('tile.handRaised')}
              />
            )}
            {p.micOn ? (
              <Mic
                className="text-muted-foreground size-4 shrink-0"
                aria-label={t('panels.people.micOn')}
              />
            ) : (
              <MicOff
                className="size-4 shrink-0 text-red-500"
                aria-label={t('tile.muted')}
              />
            )}
            {p.cameraOn ? (
              <Video
                className="text-muted-foreground size-4 shrink-0"
                aria-label={t('panels.people.cameraOn')}
              />
            ) : (
              <VideoOff
                className="text-muted-foreground size-4 shrink-0"
                aria-label={t('panels.people.cameraOff')}
              />
            )}
            {call.canModerate && !p.isSelf ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t('panels.people.actions', { name: p.name })}
                    />
                  }
                >
                  <MoreVertical />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem
                    disabled={!p.micOn}
                    onClick={() => void moderate(p, 'mute')}
                  >
                    {t('tile.muteThem')}
                  </DropdownMenuItem>
                  {p.handRaisedAt && (
                    <DropdownMenuItem
                      onClick={() => void moderate(p, 'lower_hand')}
                    >
                      {t('tile.lowerHand')}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setRemoving(p)}
                  >
                    {t('tile.remove')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : call.canModerate ? (
              <span className="size-7 shrink-0" aria-hidden />
            ) : null}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t('tile.removeTitle', { name: removing?.name ?? '' })}
        description={t('tile.removeBody')}
        confirmLabel={t('tile.remove')}
        destructive
        onConfirm={() => {
          if (removing) void moderate(removing, 'remove');
        }}
      />
    </div>
  );
}
