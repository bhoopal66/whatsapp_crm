'use client';

import {
  Mic,
  MicOff,
  MonitorUp,
  MonitorX,
  PhoneOff,
  Video,
  VideoOff,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';

/** Mic, camera and share toggles; the lobby uses the first two. */
export function DeviceToggles({
  micOn,
  cameraOn,
  sharing,
  onMic,
  onCamera,
  onScreen,
}: {
  micOn: boolean;
  cameraOn: boolean;
  sharing?: boolean;
  onMic: () => void;
  onCamera: () => void;
  /** Omitted in the lobby: a share starts once you are in the room. */
  onScreen?: () => void;
}) {
  const t = useTranslations('MeetingRoom.controls');
  return (
    <>
      <Button
        type="button"
        size="icon"
        variant={micOn ? 'secondary' : 'destructive'}
        onClick={onMic}
        aria-label={micOn ? t('mute') : t('unmute')}
        title={micOn ? t('mute') : t('unmute')}
      >
        {micOn ? <Mic /> : <MicOff />}
      </Button>
      <Button
        type="button"
        size="icon"
        variant={cameraOn ? 'secondary' : 'destructive'}
        onClick={onCamera}
        aria-label={cameraOn ? t('cameraOff') : t('cameraOn')}
        title={cameraOn ? t('cameraOff') : t('cameraOn')}
      >
        {cameraOn ? <Video /> : <VideoOff />}
      </Button>
      {onScreen && (
        <Button
          type="button"
          size="icon"
          variant={sharing ? 'default' : 'secondary'}
          onClick={onScreen}
          aria-label={sharing ? t('stopShare') : t('share')}
          title={sharing ? t('stopShare') : t('share')}
        >
          {sharing ? <MonitorX /> : <MonitorUp />}
        </Button>
      )}
    </>
  );
}

export function RoomControls({
  micOn,
  cameraOn,
  sharing,
  canEnd,
  onMic,
  onCamera,
  onScreen,
  onLeave,
  onEnd,
}: {
  micOn: boolean;
  cameraOn: boolean;
  sharing: boolean;
  /** The host, an owner or an admin. The server checks again. */
  canEnd: boolean;
  onMic: () => void;
  onCamera: () => void;
  onScreen: () => void;
  onLeave: () => void;
  onEnd: () => void;
}) {
  const t = useTranslations('MeetingRoom.controls');
  return (
    <div className="bg-card flex flex-wrap items-center justify-center gap-2 border-t px-4 py-3">
      <DeviceToggles
        micOn={micOn}
        cameraOn={cameraOn}
        sharing={sharing}
        onMic={onMic}
        onCamera={onCamera}
        onScreen={onScreen}
      />
      <Button type="button" variant="destructive" onClick={onLeave}>
        <PhoneOff />
        {t('leave')}
      </Button>
      {canEnd && (
        <Button type="button" variant="outline" onClick={onEnd}>
          {t('endForEveryone')}
        </Button>
      )}
    </div>
  );
}
