'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useAuth } from '@/hooks/use-auth';
import type { MeetingCall } from '@/hooks/use-meeting-call';

import { DeviceNotices } from './device-notices';
import { LobbyDevicePickers } from './lobby-device-pickers';
import { LobbyPeople } from './lobby-people';
import { LobbyPreview } from './lobby-preview';

/**
 * Before joining: a large self-view with the mic and camera toggles and
 * the device pickers, then who is already in the call and Join. Join
 * works with no camera and with the permissions denied; the notices say
 * why a device is missing.
 */
export function RoomLobby({
  call,
  meetingId,
  title,
}: {
  call: MeetingCall;
  meetingId: string;
  title: string;
}) {
  const t = useTranslations('MeetingRoom.lobbyV2');
  const { profile, user } = useAuth();
  const name = profile?.full_name?.trim() ?? '';
  const joining = call.phase === 'joining';
  const removed = call.error === 'removed_from_meeting';
  return (
    <TooltipProvider>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 sm:p-6 lg:flex-row lg:items-center lg:gap-10">
        <div className="flex w-full min-w-0 flex-col gap-3 lg:flex-[3]">
          <LobbyPreview call={call} name={name} userId={user?.id ?? ''} />
          <div className="px-4 sm:px-0">
            <LobbyDevicePickers call={call} />
          </div>
        </div>
        <div className="flex w-full flex-col gap-5 px-4 pb-6 sm:px-0 sm:pb-0 lg:flex-[2]">
          <div className="space-y-1">
            <p className="text-muted-foreground text-sm">{t('ready')}</p>
            <h1 className="text-2xl font-semibold break-words">{title}</h1>
            {name && (
              <p className="text-muted-foreground text-sm">
                {t('joiningAs', { name })}
              </p>
            )}
          </div>
          <LobbyPeople meetingId={meetingId} />
          <DeviceNotices devices={call.devices} />
          {removed && (
            <p role="alert" className="text-destructive text-sm">
              {t('removed')}
            </p>
          )}
          <Button
            type="button"
            size="lg"
            className="h-11 w-full rounded-full px-8 text-base sm:w-auto sm:self-start"
            disabled={joining || removed}
            onClick={() => void call.join()}
          >
            {joining ? t('joining') : t('join')}
          </Button>
        </div>
      </div>
    </TooltipProvider>
  );
}
