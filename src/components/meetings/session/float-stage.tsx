'use client';

import { Eye, EyeOff, Hand, Loader2, MicOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type HTMLAttributes } from 'react';

import type { MeetingCall } from '@/hooks/use-meeting-call';
import {
  otherPeople,
  type FloatFocus,
  type FloatView,
} from '@/lib/meetings/float/focus';
import {
  handRaisedAtOf,
  avatarColor,
  initials,
} from '@/lib/meetings/room-ui/people';
import { cn } from '@/lib/utils';

import { FloatingReactions } from '../room/control-bar';
import { VideoTrack } from '../room/video-track';

const CHIP =
  'flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-xs font-medium text-white backdrop-blur-sm';
const SPEAKING_RING =
  'shadow-[inset_0_0_0_3px_rgb(52_211_153),inset_0_0_18px_rgb(52_211_153/0.45)]';

export interface FloatPeople {
  /** Participant id → display name. */
  nameOf: (id: string) => string;
  /** Participant id → auth user id, for the photo and the colour. */
  userOf: (id: string) => string;
  /** Auth user id → photo. */
  avatarOf: (userId: string) => string | null;
  /** Auth user id → display name, for reactions. */
  userNameOf: (userId: string) => string;
}

/** A person's photo, or initials on their colour. */
export function FloatAvatar({
  id,
  people,
  className,
}: {
  id: string;
  people: FloatPeople;
  className?: string;
}) {
  const user = people.userOf(id);
  const photo = people.avatarOf(user);
  return (
    <span
      className={cn(
        'grid place-items-center overflow-hidden rounded-full font-semibold text-white',
        avatarColor(user),
        className
      )}
    >
      {photo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={photo} alt="" className="size-full object-cover" />
      ) : (
        initials(people.nameOf(id))
      )}
    </span>
  );
}

function SpeakingBars() {
  return (
    <span aria-hidden className="flex h-2.5 items-end gap-px">
      {[0, 0.2, 0.4].map((delay) => (
        <span
          key={delay}
          className="meeting-eq-bar h-full w-0.5 rounded-full bg-emerald-400"
          style={{ animationDelay: `${delay}s` }}
        />
      ))}
    </span>
  );
}

/** The large picture and everything over it. Fills its parent. */
export function FloatStage({
  call,
  focus,
  people,
  view,
  onView,
  width,
  height,
  dragProps,
}: {
  call: MeetingCall;
  focus: FloatFocus;
  people: FloatPeople;
  view: FloatView;
  onView: (view: FloatView) => void;
  width: number;
  height: number;
  dragProps?: HTMLAttributes<HTMLDivElement>;
}) {
  const t = useTranslations('MeetingSession.float');
  const [selfHidden, setSelfHidden] = useState(false);
  const self = call.participantId;
  const { mainId, kind, alone } = focus;
  const isSelfMain = mainId === self;
  const row = call.participants.find((p) => p.id === mainId);
  const speaking = (id: string | null) => !!id && !!call.speaking[id];
  // Under a screen the ring follows whoever is talking over it.
  const named = kind === 'screen' ? focus.speakerId : mainId;
  const ringOn = speaking(named);
  const track =
    kind === 'screen'
      ? mainId && call.remote[mainId]?.screen
      : isSelfMain
        ? call.cameraOn && call.localVideo
        : mainId && !row?.video_off && call.remote[mainId]?.video;
  const muted = isSelfMain
    ? !call.micOn
    : !!call.participants.find((p) => p.id === named)?.audio_muted;
  const hands = call.participants.filter(handRaisedAtOf).length;
  const others = otherPeople(
    call.participants.map((p) => ({
      id: p.id,
      speaking: speaking(p.id),
      handRaised: !!handRaisedAtOf(p),
    })),
    [self, kind === 'camera' ? mainId : null]
  );
  const showRow = width >= 340 && height >= 150 && others.shown.length > 0;
  const name = named
    ? isSelfMain
      ? t('you')
      : people.nameOf(named)
    : t('unknown');
  return (
    <div
      {...dragProps}
      data-float-main={mainId ?? ''}
      data-float-speaking={ringOn ? 'true' : 'false'}
      className="bg-card-2 relative min-h-0 flex-1 overflow-hidden rounded-xl"
    >
      {track ? (
        <VideoTrack
          track={track}
          mirrored={isSelfMain}
          fit={kind === 'screen' ? 'contain' : 'cover'}
        />
      ) : (
        <div className="grid size-full place-items-center">
          {mainId && (
            <FloatAvatar
              id={mainId}
              people={people}
              className="size-20 text-2xl"
            />
          )}
        </div>
      )}
      <FloatingReactions
        reactions={call.reactions}
        nameOf={people.userNameOf}
      />
      {call.phase === 'joining' && (
        <div className="absolute inset-0 grid place-items-center bg-black/60 text-xs text-white">
          <span className="flex items-center gap-2">
            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
            {t('joining')}
          </span>
        </div>
      )}
      {call.phase === 'reconnecting' && (
        <div className="absolute inset-x-0 top-0 bg-amber-400 py-0.5 text-center text-xs font-medium text-black">
          {t('reconnecting')}
        </div>
      )}
      <div className="absolute top-2 start-2 flex gap-1">
        {hands > 0 && (
          <span className={CHIP} title={t('hands', { count: hands })}>
            <Hand className="size-3 text-amber-300" />
            {hands}
          </span>
        )}
      </div>
      <div className="absolute top-2 end-2 flex items-center gap-1">
        {focus.screenId && (
          <div data-no-drag className={cn(CHIP, 'p-0.5')}>
            {(['speaker', 'screen'] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => onView(v)}
                className={cn(
                  'rounded-full px-2 py-0.5',
                  view === v && 'bg-white text-black'
                )}
              >
                {t(v === 'speaker' ? 'viewSpeaker' : 'viewScreen')}
              </button>
            ))}
          </div>
        )}
        <span className={CHIP}>
          {t('inCall', { count: call.participants.length })}
        </span>
      </div>
      <div className="absolute bottom-2 start-2 flex max-w-[60%] flex-col items-start gap-1.5">
        {showRow && (
          <div className="flex items-center gap-1">
            {others.shown.map((p) => (
              <span
                key={p.id}
                title={people.nameOf(p.id)}
                className={cn(
                  'rounded-full ring-2 transition-shadow duration-150',
                  p.speaking ? 'ring-emerald-400' : 'ring-black/40'
                )}
              >
                <FloatAvatar
                  id={p.id}
                  people={people}
                  className="size-6 text-xs"
                />
              </span>
            ))}
            {others.extra > 0 && <span className={CHIP}>+{others.extra}</span>}
          </div>
        )}
        <span className={cn(CHIP, 'max-w-full')}>
          {alone && <span className="truncate">{t('waiting')}</span>}
          {!alone && (
            <span className="truncate">
              {kind === 'screen' && ringOn ? t('speaking', { name }) : name}
            </span>
          )}
          {ringOn && <SpeakingBars />}
          {muted && (
            <MicOff aria-label={t('muted')} className="size-3 text-red-400" />
          )}
        </span>
      </div>
      {!alone && (
        <div className="absolute end-2 bottom-2 flex items-end gap-1">
          <button
            type="button"
            title={t(selfHidden ? 'showSelf' : 'hideSelf')}
            aria-label={t(selfHidden ? 'showSelf' : 'hideSelf')}
            onClick={() => setSelfHidden(!selfHidden)}
            className="grid size-6 place-items-center rounded-full bg-black/60 text-white"
          >
            {selfHidden ? (
              <Eye className="size-3" />
            ) : (
              <EyeOff className="size-3" />
            )}
          </button>
          {!selfHidden && (
            <div
              data-float-self-speaking={speaking(self) ? 'true' : 'false'}
              className="relative aspect-[4/3] w-[72px] overflow-hidden rounded-lg bg-black/70 ring-1 ring-white/20"
            >
              {call.cameraOn && call.localVideo ? (
                <VideoTrack track={call.localVideo} mirrored />
              ) : (
                self && (
                  <div className="grid size-full place-items-center">
                    <FloatAvatar
                      id={self}
                      people={people}
                      className="size-8 text-xs"
                    />
                  </div>
                )
              )}
              <span
                className={cn(
                  'pointer-events-none absolute inset-0 rounded-lg opacity-0 transition-opacity duration-150',
                  SPEAKING_RING,
                  speaking(self) && 'opacity-100'
                )}
              />
            </div>
          )}
        </div>
      )}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-0 rounded-xl opacity-0 transition-opacity duration-150 ease-out',
          SPEAKING_RING,
          ringOn && 'opacity-100'
        )}
      />
    </div>
  );
}
