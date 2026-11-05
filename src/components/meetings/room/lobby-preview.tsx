'use client';

import { AlertTriangle, Mic, MicOff, Video, VideoOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { MeetingCall } from '@/hooks/use-meeting-call';
import { meterBars } from '@/lib/meetings/room-ui/lobby';
import { avatarColor, initials } from '@/lib/meetings/room-ui/people';
import { cn } from '@/lib/utils';

import { useWorkspaceMembers } from '../use-workspace-members';
import { VideoTrack } from './video-track';

/** Steps of the slim level bar. */
const METER_STEPS = 20;

/**
 * The self-view: our camera as a mirror shows it, or our photo or
 * initials when the camera is off or missing, with the mic and camera
 * toggles over it and the live mic level under it.
 */
export function LobbyPreview({
  call,
  name,
  userId,
}: {
  call: MeetingCall;
  name: string;
  userId: string;
}) {
  const t = useTranslations('MeetingRoom.lobbyV2');
  const { avatarOf } = useWorkspaceMembers();
  const photo = userId ? avatarOf(userId) : null;
  const video = call.cameraOn ? call.localVideo : null;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-2xl bg-neutral-900 text-white shadow-sm">
        {video ? (
          <VideoTrack track={video} mirrored />
        ) : (
          <div className="flex flex-col items-center gap-3">
            <div
              className={cn(
                'flex size-20 items-center justify-center overflow-hidden rounded-full text-2xl font-medium sm:size-28 sm:text-4xl',
                avatarColor(userId || name)
              )}
              aria-hidden
            >
              {photo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photo} alt="" className="size-full object-cover" />
              ) : (
                initials(name) || '?'
              )}
            </div>
            <p className="text-sm text-white/80">{t('cameraOff')}</p>
          </div>
        )}

        <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 gap-4">
          <PreviewToggle
            on={call.micOn}
            warn={!!call.devices.audio}
            label={call.micOn ? t('turnMicOff') : t('turnMicOn')}
            onClick={() => void call.toggleMic()}
          >
            {call.micOn ? <Mic /> : <MicOff />}
          </PreviewToggle>
          <PreviewToggle
            on={call.cameraOn}
            warn={!!call.devices.video}
            label={call.cameraOn ? t('turnCameraOff') : t('turnCameraOn')}
            onClick={() => void call.toggleCamera()}
          >
            {call.cameraOn ? <Video /> : <VideoOff />}
          </PreviewToggle>
        </div>
      </div>
      <MicMeter on={call.micOn} level={call.localAudioLevel} />
    </div>
  );
}

/** A round toggle; red while off, with a warning badge on a device error. */
function PreviewToggle({
  on,
  warn,
  label,
  onClick,
  children,
}: {
  on: boolean;
  warn: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={label}
            aria-pressed={!on}
            onClick={onClick}
            className={cn(
              'relative size-12 rounded-full border [&_svg:not([class*=size-])]:size-5',
              on
                ? 'border-white/60 bg-black/30 text-white hover:bg-white/20 hover:text-white'
                : 'border-transparent bg-red-600 text-white hover:bg-red-700 hover:text-white'
            )}
          />
        }
      >
        {children}
        {warn && (
          <span className="absolute -top-0.5 -right-0.5 flex size-5 items-center justify-center rounded-full bg-amber-400 text-black">
            <AlertTriangle className="size-3!" aria-hidden />
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Our mic level as a slim bar. It may sit still until the first click:
 * the browser only starts the AudioContext after an interaction.
 */
function MicMeter({ on, level }: { on: boolean; level: number }) {
  const t = useTranslations('MeetingRoom.lobbyV2');
  const lit = on ? meterBars(level, METER_STEPS) : 0;
  return (
    <div
      role="meter"
      aria-label={on ? t('micLevel') : t('micOff')}
      aria-valuemin={0}
      aria-valuemax={METER_STEPS}
      aria-valuenow={lit}
      className="flex h-4 items-center gap-2 px-1"
    >
      {on ? (
        <Mic className="text-muted-foreground size-4 shrink-0" aria-hidden />
      ) : (
        <MicOff className="text-destructive size-4 shrink-0" aria-hidden />
      )}
      {on ? (
        <span className="bg-muted h-1.5 flex-1 overflow-hidden rounded-full">
          <span
            className="bg-success block h-full rounded-full transition-[width] duration-100 ease-out"
            style={{ width: `${(lit / METER_STEPS) * 100}%` }}
          />
        </span>
      ) : (
        <span className="text-muted-foreground text-xs">{t('micOff')}</span>
      )}
    </div>
  );
}
