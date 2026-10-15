'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import type { MeetingCall } from '@/hooks/use-meeting-call';

import { DeviceToggles } from './room-controls';
import { DeviceNotices } from './device-notices';
import { VideoTrack } from './video-track';

/** Camera and mic preview with their toggles, then Join. */
export function RoomLobby({
  call,
  title,
}: {
  call: MeetingCall;
  title: string;
}) {
  const t = useTranslations('MeetingRoom.lobby');
  const joining = call.phase === 'joining';
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>
      <div className="bg-muted relative flex aspect-video items-center justify-center overflow-hidden rounded-lg border">
        {call.localVideo ? (
          <VideoTrack track={call.localVideo} mirrored />
        ) : (
          <p className="text-muted-foreground text-sm">{t('cameraOff')}</p>
        )}
        <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 gap-2">
          <DeviceToggles
            micOn={call.micOn}
            cameraOn={call.cameraOn}
            onMic={() => void call.toggleMic()}
            onCamera={() => void call.toggleCamera()}
          />
        </div>
      </div>
      <DeviceNotices devices={call.devices} />
      <Button
        type="button"
        size="lg"
        disabled={joining}
        onClick={() => void call.join()}
      >
        {joining ? t('joining') : t('join')}
      </Button>
    </div>
  );
}
