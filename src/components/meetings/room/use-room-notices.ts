'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

import type { MeetingCall } from '@/hooks/use-meeting-call';
import {
  batchTone,
  noticeToast,
  showsToast,
  type NoticeToast,
} from '@/lib/meetings/room-ui/panels';

import { useWorkspaceMembers } from '../use-workspace-members';
import { JOIN_TONE, LEAVE_TONE, playTones, RECORD_TONE } from './room-sounds';

const TONES = { join: JOIN_TONE, leave: LEAVE_TONE, record: RECORD_TONE };

/**
 * The engine's one-shot notices as toasts, oldest first, then dismissed.
 * Join and leave also play a soft tone when the switch is on. They wait
 * until the call is live, as they did when the room mounted this. Off
 * the room `quietPresence` drops the join and leave toasts, not the tone.
 * A recording notice is about consent, not a preference: it shows on
 * every page and plays its tone whatever the switch says.
 */
export function useRoomNotices(
  call: MeetingCall,
  sounds: boolean,
  sinkId: string | null,
  quietPresence: boolean
) {
  const t = useTranslations('MeetingRoom');
  const { nameOf } = useWorkspaceMembers();
  const { notices, dismissNotices } = call;
  const live = call.phase === 'live' || call.phase === 'reconnecting';
  // Toast ids dedupe a double effect run (Strict Mode); this set does the
  // same for the tone.
  const shown = useRef(new Set<string>());

  useEffect(() => {
    if (!live || !notices.length) return;
    const batch: NoticeToast[] = [];
    for (const n of notices) {
      if (shown.current.has(n.id)) continue;
      shown.current.add(n.id);
      const nt = noticeToast(n);
      batch.push(nt);
      if (!showsToast(nt, quietPresence)) continue;
      const name = nt.userId ? nameOf(nt.userId) || t('tile.unknown') : '';
      const text = t(`panels.notices.${nt.key}`, { name });
      if (nt.tone === 'warning') toast.warning(text, { id: n.id });
      else toast(text, { id: n.id });
    }
    const tone = batchTone(batch, sounds);
    if (tone) void playTones(TONES[tone], { sinkId });
    dismissNotices(notices.map((n) => n.id));
  }, [live, notices, dismissNotices, nameOf, quietPresence, sounds, sinkId, t]);
}
