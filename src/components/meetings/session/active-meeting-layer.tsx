'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';
import { toast } from 'sonner';

import { useAuth } from '@/hooks/use-auth';
import { meetingRoomIdFrom } from '@/lib/meetings/session/paths';
import {
  endedNotice,
  isInCall,
  offRoomTileSizes,
  REJOIN_MARKER_KEY,
  writeRejoinMarker,
} from '@/lib/meetings/session/session';
import { isLeavingSession } from '@/lib/session-cache';

import { useJoinLeaveSounds } from '../room/use-join-leave-sounds';
import { useRoomNotices } from '../room/use-room-notices';
import { AudioTrack } from '../room/video-track';
import { MeetingFloat } from './meeting-float';
import {
  useActiveCall,
  useMeetingSession,
  type ActiveCall,
} from './meeting-session-provider';
import { RejoinCard } from './rejoin-card';

function clearRejoinMarker() {
  try {
    sessionStorage.removeItem(REJOIN_MARKER_KEY);
  } catch {
    // No storage: there was no marker either.
  }
}

/** Everything of the call that is not the room's picture, on every page. */
export function ActiveMeetingLayer() {
  const active = useActiveCall();
  useEndedToasts();
  return active ? (
    <HeldCall key={active.meetingId} active={active} />
  ) : (
    <RejoinCard />
  );
}

/** A call that finished off the room page has no end screen: say so. */
function useEndedToasts() {
  const t = useTranslations('MeetingSession.ended');
  const router = useRouter();
  const { session } = useMeetingSession();
  useEffect(() => {
    session.setOnEnded((ended) => {
      // The toast carries the Rejoin, so a card would only repeat it.
      clearRejoinMarker();
      const notice = endedNotice(ended);
      const text = t(notice.key, { title: ended.title });
      if (!notice.rejoin) {
        toast(text);
        return;
      }
      toast(text, {
        action: {
          label: t('rejoin'),
          onClick: () => router.push(`/meetings/${ended.meetingId}/room`),
        },
      });
    });
    return () => session.setOnEnded(undefined);
  }, [session, router, t]);
}

function HeldCall({ active }: { active: ActiveCall }) {
  const { call, engine, meetingId } = active;
  const pathname = usePathname();
  const { user } = useAuth();
  const [sounds] = useJoinLeaveSounds();
  const onRoomPage = meetingRoomIdFrom(pathname) === meetingId;
  const inCall = isInCall(call.phase);
  const sinkId = call.selectedDevices.audiooutput;
  useRoomNotices(call, sounds, sinkId, !onRoomPage);

  useEffect(() => {
    if (!inCall) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isLeavingSession()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [inCall]);

  useEffect(() => {
    const onHide = () => engine.leaveQuietly();
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [engine]);

  // Opening a meeting answers any offer to rejoin it. Declared before
  // the write below, so a call already live writes the marker back.
  useEffect(clearRejoinMarker, [meetingId]);

  const userId = user?.id ?? null;
  const title = call.meeting?.title ?? '';
  const { phase } = call;
  useEffect(() => {
    if (phase === 'left' || phase === 'ended' || phase === 'removed') {
      clearRejoinMarker();
      return;
    }
    if (phase !== 'live' || !userId) return;
    try {
      sessionStorage.setItem(
        REJOIN_MARKER_KEY,
        writeRejoinMarker({ meetingId, title, userId, at: Date.now() })
      );
    } catch {
      // No storage: a reload simply offers no rejoin.
    }
  }, [phase, meetingId, title, userId]);

  const { participants, participantId, setTileSizes } = call;
  useEffect(() => {
    if (onRoomPage) return;
    const ids = participants.map((p) => p.id);
    setTileSizes(offRoomTileSizes(ids, participantId));
  }, [onRoomPage, participants, participantId, setTileSizes]);

  return (
    <>
      {Object.entries(call.remote).map(([pid, tracks]) =>
        tracks.audio ? (
          <AudioTrack key={pid} track={tracks.audio} sinkId={sinkId} />
        ) : null
      )}
      {inCall && !onRoomPage && <MeetingFloat />}
    </>
  );
}
