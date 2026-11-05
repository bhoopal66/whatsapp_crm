'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMemo, useState, useSyncExternalStore } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { floatFocus, type FloatView } from '@/lib/meetings/float/focus';
import { unreadCount } from '@/lib/meetings/room-ui/chat';
import { nextRemoteSpeaker } from '@/lib/meetings/room-ui/tiles';

import { useWorkspaceMembers } from '../use-workspace-members';
import type { FloatPeople } from './float-stage';
import type { ActiveCall } from './meeting-session-provider';

/** Who the small windows show and the way back: the float and the pop-out. */
export function useFloatView({ call, meetingId, roomUi }: ActiveCall) {
  const t = useTranslations('MeetingSession.float');
  const router = useRouter();
  const { user } = useAuth();
  const { nameOf, avatarOf } = useWorkspaceMembers();
  const [view, setView] = useState<FloatView>('speaker');
  const [lastSpeaker, setLastSpeaker] = useState<string | null>(null);
  const self = call.participantId;
  const next = nextRemoteSpeaker(lastSpeaker, call.activeSpeakerId, self);
  if (next !== lastSpeaker) setLastSpeaker(next);

  const { participants, remote, activeSpeakerId } = call;
  const ids = useMemo(() => participants.map((p) => p.id), [participants]);
  const focus = useMemo(() => {
    const receivedScreens = new Set(
      ids.filter(
        (id) =>
          remote[id]?.screen &&
          participants
            .find((p) => p.id === id)
            ?.tracks.some((tr) => tr.kind === 'screen')
      )
    );
    return floatFocus({
      selfId: self,
      participantIds: ids,
      activeSpeakerId,
      lastRemoteSpeakerId: lastSpeaker,
      view,
      receivedScreens,
    });
  }, [ids, participants, remote, self, activeSpeakerId, lastSpeaker, view]);

  const people = useMemo<FloatPeople>(() => {
    const userOf = (id: string) =>
      participants.find((p) => p.id === id)?.user_id ?? id;
    return {
      userOf,
      avatarOf,
      nameOf: (id) => nameOf(userOf(id)) || t('unknown'),
      userNameOf: (userId) => nameOf(userId) || t('unknown'),
    };
  }, [participants, nameOf, avatarOf, t]);

  const openRoom = () => router.push(`/meetings/${meetingId}/room`);
  const openChat = () => {
    roomUi.setPanel('chat');
    openRoom();
  };
  const seenAt = useSyncExternalStore(
    roomUi.subscribe,
    () => roomUi.getSnapshot().chatSeenAt,
    () => null
  );
  const unread = unreadCount(call.chat, seenAt, user?.id ?? null);

  return {
    self,
    ids,
    focus,
    people,
    view,
    setView,
    openRoom,
    openChat,
    unread,
  };
}
