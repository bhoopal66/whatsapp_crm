'use client';

import { CircleDot, Lock } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useAuth } from '@/hooks/use-auth';
import type { MeetingCall } from '@/hooks/use-meeting-call';
import { lobbyDeviceLine, lobbyJoinState } from '@/lib/meetings/room-ui/lobby';
import { formatMeetingWhen } from '@/lib/meetings/schedule';

import {
  useMeetingTimeZone,
  useWorkspaceMembers,
} from '../use-workspace-members';
import { BackgroundButton } from './room-background-dialog';
import { DeviceNotices } from './device-notices';
import { LobbyDevicePickers, SpeakerTestButton } from './lobby-device-pickers';
import { LobbyPeople } from './lobby-people';
import { LobbyPreview } from './lobby-preview';

/**
 * Before joining: the self-view and devices on the left, and on the
 * right what this meeting is, who is in it and exactly what pressing
 * Join will do. Join works with no camera and with the permissions
 * denied; the notices say why a device is missing.
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
  const locale = useLocale();
  const timeZone = useMeetingTimeZone();
  const { profile, user } = useAuth();
  const { nameOf } = useWorkspaceMembers();
  const name = profile?.full_name?.trim() ?? '';
  const joining = call.phase === 'joining';
  const { canJoin, blockedBy, recordingNotice } = lobbyJoinState(call);
  const deviceLine = lobbyDeviceLine(
    call.micOn,
    call.cameraOn,
    blockedBy !== null
  );

  const hostId = call.meeting?.host_user_id;
  const hostName = hostId ? nameOf(hostId) : null;
  const organiser =
    hostId && hostId === user?.id
      ? t('organisedByYou')
      : hostName
        ? t('organisedBy', { name: hostName })
        : null;
  const when = formatMeetingWhen(
    {
      scheduledStart: call.meeting?.scheduled_start ?? null,
      scheduledEnd: call.meeting?.scheduled_end ?? null,
    },
    { locale, timeZone }
  );

  return (
    <TooltipProvider>
      <div className="h-full min-h-0 flex-1 overflow-y-auto">
        <div className="flex min-h-full items-center justify-center p-4 sm:p-6">
          <div className="flex w-full max-w-5xl flex-col gap-6 lg:flex-row lg:items-stretch lg:gap-8">
            <div className="flex w-full min-w-0 flex-col gap-3 lg:flex-[3]">
              <LobbyPreview call={call} name={name} userId={user?.id ?? ''} />
              <LobbyDevicePickers call={call} />
              <div className="flex flex-wrap items-center gap-2">
                <SpeakerTestButton call={call} />
                <BackgroundButton
                  call={call}
                  className="border-input h-8 border px-3 text-sm"
                />
              </div>
            </div>

            <section className="bg-card flex w-full min-w-0 flex-col gap-5 rounded-2xl border p-5 shadow-sm sm:p-6 lg:flex-[2]">
              <div className="space-y-2">
                <p className="text-primary text-xs font-semibold tracking-wide uppercase">
                  {t('ready')}
                </p>
                <h1 className="text-2xl font-semibold tracking-tight break-words sm:text-3xl">
                  {title}
                </h1>
                {(organiser || when) && (
                  <div className="text-muted-foreground space-y-0.5 text-sm">
                    {organiser && <p>{organiser}</p>}
                    {when && <p>{when}</p>}
                  </div>
                )}
              </div>

              <LobbyPeople meetingId={meetingId} />

              <div className="mt-auto space-y-3">
                <DeviceNotices devices={call.devices} />
                {blockedBy === 'removed' && (
                  <p role="alert" className="text-destructive text-sm">
                    {t('removed')}
                  </p>
                )}
                {blockedBy === 'locked' && (
                  <p
                    role="status"
                    className="bg-card-2 flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium"
                  >
                    <Lock className="size-4 shrink-0" aria-hidden />
                    {t('locked')}
                  </p>
                )}
                {deviceLine && (
                  <p className="text-muted-foreground text-sm">
                    {t(deviceLine)}
                  </p>
                )}
                {/* Consent to being recorded: never dismissible. */}
                {recordingNotice && (
                  <p
                    role="alert"
                    data-lobby-recording
                    className="border-destructive bg-destructive-soft flex items-start gap-2 rounded-lg border-2 px-3 py-2.5 text-sm font-semibold"
                  >
                    <CircleDot
                      className="fill-destructive text-destructive mt-0.5 size-4 shrink-0 motion-safe:animate-pulse"
                      aria-hidden
                    />
                    {t('recordingNotice')}
                  </p>
                )}
                <Button
                  type="button"
                  size="lg"
                  className="h-11 w-full rounded-full px-8 text-base"
                  disabled={!canJoin}
                  onClick={() => void call.join()}
                >
                  {joining ? t('joining') : t('join')}
                </Button>
              </div>
            </section>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
