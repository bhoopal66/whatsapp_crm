'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Video } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { useNotifications } from '@/components/notifications/notifications-provider';
import { useCalls } from '@/components/pbx/call-provider';
import {
  InviteRinger,
  inviteMeetingId,
  isRingerBusy,
  meetingRoomPath,
  type MeetingRead,
} from '@/lib/meetings/invite-ring';
import { parseMeetingDetail } from '@/lib/meetings/schedule';
import { startCatchUp } from '@/lib/realtime/catch-up';
import { createClient } from '@/lib/supabase/client';
import { notificationRow } from '@/lib/notifications/target';
import type { Notification } from '@/types';

import { holdRingSilent, startRingTone } from './invite-ring-tone';
import { useActiveCall } from './session/meeting-session-provider';
import { useWorkspaceMembers } from './use-workspace-members';

/** An unread invite older than this is never looked at again. */
const MISSED_INVITE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const MISSED_INVITE_LIMIT = 5;

async function readUnreadInvites(userId: string): Promise<Notification[]> {
  const since = new Date(Date.now() - MISSED_INVITE_MAX_AGE_MS).toISOString();
  const { data, error } = await createClient()
    .from('notifications')
    .select('*')
    .eq('user_id', userId)
    .is('read_at', null)
    .eq('type', 'meeting_invite')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(MISSED_INVITE_LIMIT);
  if (error) throw error;
  return (data ?? []) as Notification[];
}

async function readMeeting(meetingId: string): Promise<MeetingRead> {
  try {
    const res = await fetch(`/api/meetings/${meetingId}`);
    if (res.status === 404) return 'gone';
    if (!res.ok) return null;
    return parseMeetingDetail(await res.json());
  } catch {
    return null;
  }
}

export interface MeetingInviteCardViewProps {
  title: string;
  /** The inviter's name; null shows the generic line. */
  inviter: string | null;
  /** The other workspace's name; null when it is the active one. */
  workspace: string | null;
  onJoin: () => void;
  onDismiss: () => void;
}

export function MeetingInviteCardView({
  title,
  inviter,
  workspace,
  onJoin,
  onDismiss,
}: MeetingInviteCardViewProps) {
  const t = useTranslations('MeetingInvite');
  return (
    // Top centre on purpose: the customer ring card and toasts own the top
    // right, the in-call window the bottom right. z-[55] is above dialogs
    // and below the customer ring card. Nothing takes focus: someone
    // typing must not join by pressing Enter.
    <div
      role="alertdialog"
      aria-label={t('title')}
      data-meeting-invite
      className="animate-in fade-in slide-in-from-top-2 fixed top-[68px] left-1/2 z-[55] w-[380px] max-w-[calc(100vw-24px)] -translate-x-1/2 rounded-[18px] bg-[#0f1b2d] p-4 text-white shadow-[0_12px_40px_rgba(0,0,0,0.35)] duration-200 motion-reduce:animate-none max-sm:end-3 max-sm:start-3 max-sm:w-auto max-sm:max-w-none max-sm:translate-x-0 dark:ring-1 dark:ring-white/10"
    >
      <p className="flex items-center gap-2 text-xs text-white/70">
        <span className="size-2 animate-pulse rounded-full bg-emerald-400 motion-reduce:animate-none" />
        <span className="truncate">
          {t('title')}
          {workspace && ` · ${workspace}`}
        </span>
      </p>
      <p className="mt-2 truncate text-xl font-bold">{title}</p>
      <p className="truncate text-sm text-white/70">
        {inviter ? t('byPerson', { name: inviter }) : t('generic')}
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onDismiss}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-white/10 text-sm font-medium hover:bg-white/15"
        >
          {t('notNow')}
        </button>
        <button
          type="button"
          onClick={onJoin}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-emerald-600 text-sm font-medium hover:bg-emerald-500"
        >
          <Video className="size-4" />
          {t('join')}
        </button>
      </div>
    </div>
  );
}

/** Mounted only while ringing, so no page pays for the member list. */
export function RingingCard({
  row,
  onDone,
}: {
  row: Notification;
  onDone: () => void;
}) {
  const tBell = useTranslations('Workspaces.bell');
  const { activeWorkspaceId, accountRole, workspaces } = useAuth();
  const { markRead, openNotification } = useNotifications();
  const { nameOf } = useWorkspaceMembers();
  const plan = notificationRow(row, {
    activeWorkspaceId,
    activeRole: accountRole,
    workspaces,
  });
  const other = plan.otherWorkspace;
  return (
    <MeetingInviteCardView
      title={row.title}
      inviter={!other && row.actor_user_id ? nameOf(row.actor_user_id) : null}
      workspace={other ? (other.name ?? tBell('unknown')) : null}
      onJoin={() => {
        const meetingId = inviteMeetingId(row);
        const href = meetingId ? meetingRoomPath(meetingId) : plan.href;
        void openNotification(row, { ...plan, href });
        onDone();
      }}
      onDismiss={() => {
        // Deliberate: the realtime UPDATE this causes is what closes the
        // card on the person's other tabs and devices.
        void markRead(row.id);
        onDone();
      }}
    />
  );
}

/** The ringing invite, over whatever page of the dashboard is open. */
export function MeetingInviteCard() {
  const { onChange, onStatus } = useNotifications();
  const { user, activeWorkspaceId } = useAuth();
  const userId = user?.id ?? null;
  const pathname = usePathname();
  const active = useActiveCall();
  const calls = useCalls();
  const [ringer] = useState(
    () => new InviteRinger({ readMeeting, startTone: startRingTone })
  );
  const row = useSyncExternalStore(
    ringer.subscribe,
    ringer.getSnapshot,
    () => null
  );

  const heldMeetingId = active?.meetingId ?? null;
  const busy = isRingerBusy(active?.call.phase ?? null, calls);

  useEffect(() => {
    ringer.setContext({ activeWorkspaceId, pathname, heldMeetingId, busy });
  });

  useEffect(() => (busy ? holdRingSilent() : undefined), [busy]);

  useEffect(() => {
    const stopListening = onChange((change) => ringer.handle(change));
    return () => {
      stopListening();
      ringer.close();
    };
  }, [onChange, ringer]);

  // Sleep, a lost connection: an invite missed meanwhile rings if its
  // meeting is still on. Nothing rings on a plain page load.
  useEffect(() => {
    if (!userId) return;
    let stopped = false;
    const live = startCatchUp(async () => {
      const rows = await readUnreadInvites(userId);
      if (!stopped) await ringer.catchUp(rows);
    });
    const stopStatus = onStatus(live.onStatus);
    window.addEventListener('online', live.catchUp);
    return () => {
      stopped = true;
      window.removeEventListener('online', live.catchUp);
      stopStatus();
      live.stop();
    };
  }, [userId, onStatus, ringer]);

  if (!row) return null;
  return <RingingCard row={row} onDone={() => ringer.close()} />;
}
