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

import { VideoTrack } from './video-track';

const METER_BARS = 5;

/**
 * The self-view: our camera as a mirror shows it, or our initials when
 * the camera is off or missing, with the mic and camera toggles and the
 * mic meter over it.
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
  const video = call.cameraOn ? call.localVideo : null;
  return (
    <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden bg-neutral-900 text-white sm:rounded-xl">
      {video ? (
        <VideoTrack track={video} mirrored />
      ) : (
        <div className="flex flex-col items-center gap-3">
          <div
            className={cn(
              'flex size-20 items-center justify-center rounded-full text-2xl font-medium sm:size-28 sm:text-4xl',
              avatarColor(userId || name)
            )}
            aria-hidden
          >
            {initials(name) || '?'}
          </div>
          <p className="text-sm text-white/80">{t('cameraOff')}</p>
        </div>
      )}

      <div className="absolute top-3 left-3">
        <MicMeter on={call.micOn} level={call.localAudioLevel} />
      </div>

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
 * Our mic level as bars. It may sit still until the first click: the
 * browser only starts the AudioContext after an interaction.
 */
function MicMeter({ on, level }: { on: boolean; level: number }) {
  const t = useTranslations('MeetingRoom.lobbyV2');
  const lit = on ? meterBars(level, METER_BARS) : 0;
  return (
    <div
      role="meter"
      aria-label={on ? t('micLevel') : t('micOff')}
      aria-valuemin={0}
      aria-valuemax={METER_BARS}
      aria-valuenow={lit}
      className="flex h-8 items-center gap-1.5 rounded-full bg-black/50 px-2.5"
    >
      {on ? (
        <Mic className="size-4" aria-hidden />
      ) : (
        <MicOff className="size-4 text-red-400" aria-hidden />
      )}
      <span className="flex h-4 items-end gap-0.5" aria-hidden>
        {Array.from({ length: METER_BARS }, (_, i) => (
          <span
            key={i}
            className={cn(
              'w-1 rounded-full transition-colors duration-100',
              i < lit ? 'bg-emerald-400' : 'bg-white/30'
            )}
            style={{ height: `${40 + (i * 60) / (METER_BARS - 1)}%` }}
          />
        ))}
      </span>
    </div>
  );
}
