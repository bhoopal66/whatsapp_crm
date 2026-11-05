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
  type MeetingRead,
} from '@/lib/meetings/invite-ring';
import { parseMeetingDetail } from '@/lib/meetings/schedule';
import { isInCall } from '@/lib/meetings/session/session';
import { notificationRow } from '@/lib/notifications/target';
import type { Notification } from '@/types';

import { holdRingSilent, startRingTone } from './invite-ring-tone';
import { useActiveCall } from './session/meeting-session-provider';
import { useWorkspaceMembers } from './use-workspace-members';

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
      className="animate-in fade-in slide-in-from-top-2 fixed top-[68px] left-1/2 z-[55] w-[380px] max-w-[calc(100vw-24px)] -translate-x-1/2 rounded-[18px] bg-[#0f1b2d] p-4 text-white shadow-[0_12px_40px_rgba(0,0,0,0.35)] duration-200 motion-reduce:animate-none max-sm:right-3 max-sm:left-3 max-sm:w-auto max-sm:max-w-none max-sm:translate-x-0 dark:ring-1 dark:ring-white/10"
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
function RingingCard({
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
        const href = `/meetings/${inviteMeetingId(row)}/room`;
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
  const { onChange } = useNotifications();
  const { activeWorkspaceId } = useAuth();
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
  const busy =
    (active !== null && isInCall(active.call.phase)) ||
    !!calls?.ringing ||
    (!!calls?.panel && calls.panel.endedAt === null);

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

  if (!row) return null;
  return <RingingCard row={row} onDone={() => ringer.close()} />;
}
