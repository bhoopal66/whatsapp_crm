'use client';

import {
  Hand,
  MessageSquare,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  Video,
  VideoOff,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import type { MeetingCall } from '@/hooks/use-meeting-call';
import { cn } from '@/lib/utils';

/** A round call button. Native title: this also renders in a PiP window. */
export function FloatButton({
  label,
  onClick,
  tone = 'plain',
  children,
}: {
  label: string;
  onClick: () => void;
  tone?: 'plain' | 'on' | 'off' | 'leave';
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        'focus-visible:ring-ring relative grid size-8 shrink-0 place-items-center rounded-full transition-colors outline-none focus-visible:ring-2',
        tone === 'plain' && 'bg-card-2 text-foreground hover:bg-accent',
        tone === 'on' && 'bg-amber-400 text-black hover:bg-amber-300',
        tone === 'off' && 'bg-destructive hover:bg-destructive/85 text-white',
        tone === 'leave' &&
          'bg-destructive hover:bg-destructive/85 w-11 text-white'
      )}
    >
      {children}
    </button>
  );
}

/** Mic, Camera, Hand, Chat, Share, Leave; `width` drops Share, then Hand. */
export function FloatControls({
  call,
  width,
  chatUnread,
  onChat,
}: {
  call: MeetingCall;
  width: number;
  chatUnread: number;
  onChat: () => void;
}) {
  const t = useTranslations('MeetingSession.float');
  return (
    <div className="flex h-12 shrink-0 items-center gap-1.5 px-2.5">
      <FloatButton
        label={t(call.micOn ? 'mute' : 'unmute')}
        tone={call.micOn ? 'plain' : 'off'}
        onClick={() => void call.toggleMic()}
      >
        {call.micOn ? (
          <Mic className="size-4" />
        ) : (
          <MicOff className="size-4" />
        )}
      </FloatButton>
      <FloatButton
        label={t(call.cameraOn ? 'cameraOff' : 'cameraOn')}
        tone={call.cameraOn ? 'plain' : 'off'}
        onClick={() => void call.toggleCamera()}
      >
        {call.cameraOn ? (
          <Video className="size-4" />
        ) : (
          <VideoOff className="size-4" />
        )}
      </FloatButton>
      {width >= 300 && (
        <FloatButton
          label={t(call.handRaised ? 'lowerHand' : 'raiseHand')}
          tone={call.handRaised ? 'on' : 'plain'}
          onClick={() => void call.toggleHand()}
        >
          <Hand className="size-4" />
        </FloatButton>
      )}
      <FloatButton label={t('chat')} onClick={onChat}>
        <MessageSquare className="size-4" />
        {chatUnread > 0 && (
          <span className="bg-destructive absolute -top-1 -right-1 min-w-5 rounded-full px-1 text-center text-xs leading-5 font-semibold text-white">
            {chatUnread > 9 ? '9+' : chatUnread}
          </span>
        )}
      </FloatButton>
      {width >= 340 && (
        <FloatButton
          label={t(call.sharing ? 'stopShare' : 'share')}
          tone={call.sharing ? 'on' : 'plain'}
          onClick={() => void call.toggleScreen()}
        >
          <MonitorUp className="size-4" />
        </FloatButton>
      )}
      <span className="flex-1" />
      <FloatButton
        label={t('leave')}
        tone="leave"
        onClick={() => void call.leave()}
      >
        <PhoneOff className="size-4" />
      </FloatButton>
    </div>
  );
}
