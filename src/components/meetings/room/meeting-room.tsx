'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import { Button, buttonVariants } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { useMeetingCall, type MeetingCall } from '@/hooks/use-meeting-call';
import { canManageMeeting } from '@/lib/meetings/schedule';
import { tileLayout, type Tile } from '@/lib/meetings/room/layout';

import { DeviceNotices } from './device-notices';
import { RoomControls } from './room-controls';
import { RoomLobby } from './room-lobby';
import { RoomTile } from './room-tile';
import { useWorkspaceMembers } from '../use-workspace-members';
import { AudioTrack } from './video-track';

/** /meetings/[id]/room: lobby, then the call, then whatever ended it. */
export function MeetingRoom({ meetingId }: { meetingId: string }) {
  const t = useTranslations('MeetingRoom');
  const call = useMeetingCall(meetingId);
  const { user, accountRole } = useAuth();
  const back = `/meetings/${meetingId}`;

  // "End for everyone": the host, or an owner/admin (migration 106's
  // meeting_can_manage). UI only; POST /end checks it again.
  const canEnd =
    !!call.meeting &&
    canManageMeeting(accountRole, user?.id, {
      hostUserId: call.meeting.host_user_id,
    });

  if (call.error === 'not_configured') {
    return (
      <Notice title={t('notConfigured.title')} back={back}>
        {t('notConfigured.body')}
      </Notice>
    );
  }
  if (call.meetingState === 'loading') {
    return <p className="text-muted-foreground p-6 text-sm">{t('loading')}</p>;
  }
  if (call.meetingState === 'missing' || call.error === 'forbidden') {
    return <Notice title={t('missing.title')} back="/meetings" />;
  }
  if (
    call.phase === 'ended' ||
    call.error === 'meeting_closed' ||
    (call.phase === 'lobby' && call.meeting?.status !== 'scheduled')
  ) {
    return <Notice title={t('ended.title')} back={back} />;
  }
  if (call.phase === 'left') {
    return (
      <Notice
        title={
          call.error === 'seat_closed' ? t('left.elsewhere') : t('left.title')
        }
        back={back}
      >
        <Button
          type="button"
          className="mt-4"
          onClick={() => void call.returnToLobby()}
        >
          {t('left.rejoin')}
        </Button>
      </Notice>
    );
  }
  if (call.phase === 'error') {
    return (
      <Notice title={t(`error.${call.error ?? 'join_failed'}`)} back={back}>
        <Button
          type="button"
          className="mt-4"
          onClick={() => void call.returnToLobby()}
        >
          {t('error.retry')}
        </Button>
      </Notice>
    );
  }
  if (call.phase === 'lobby' || call.phase === 'joining') {
    return <RoomLobby call={call} title={call.meeting?.title ?? ''} />;
  }
  return <LiveRoom call={call} canEnd={canEnd} />;
}

function LiveRoom({ call, canEnd }: { call: MeetingCall; canEnd: boolean }) {
  const t = useTranslations('MeetingRoom');
  const { nameOf } = useWorkspaceMembers();
  const me = call.participantId;
  const rows = call.participants;
  // Ourselves even before our own row arrives over realtime.
  const sources = [
    ...(me && !rows.some((r) => r.id === me)
      ? [{ participantId: me, userId: '', isSelf: true, sharing: call.sharing }]
      : []),
    ...rows.map((r) => ({
      participantId: r.id,
      userId: r.user_id,
      isSelf: r.id === me,
      sharing:
        r.id === me
          ? call.sharing
          : !!call.remote[r.id]?.screen &&
            r.tracks.some((tr) => tr.kind === 'screen'),
    })),
  ];
  const layout = tileLayout(sources);
  const byId = new Map(rows.map((r) => [r.id, r]));

  const renderTile = (tile: Tile, featured = false) => {
    const row = byId.get(tile.participantId);
    const remote = call.remote[tile.participantId];
    const name = (tile.userId && nameOf(tile.userId)) || t('tile.unknown');
    const track =
      tile.kind === 'screen'
        ? tile.isSelf
          ? call.localScreen
          : (remote?.screen ?? null)
        : tile.isSelf
          ? call.localVideo
          : row?.video_off
            ? null
            : (remote?.video ?? null);
    const muted = tile.isSelf ? !call.micOn : (row?.audio_muted ?? false);
    return (
      <RoomTile
        key={tile.key}
        name={name}
        isSelf={tile.isSelf}
        kind={tile.kind}
        track={track}
        muted={muted}
        featured={featured}
      />
    );
  };

  const confirmEnd = () => {
    if (window.confirm(t('controls.endConfirm'))) void call.end();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {call.phase === 'reconnecting' && (
        <p className="bg-muted text-muted-foreground px-4 py-2 text-center text-sm">
          {t('reconnecting')}
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4 lg:flex-row">
        {layout.featured && (
          <div className="min-h-64 flex-[3]">
            {renderTile(layout.featured, true)}
          </div>
        )}
        <div
          className="grid flex-1 content-start gap-3"
          style={{
            gridTemplateColumns: `repeat(${layout.featured ? 1 : layout.columns}, minmax(0, 1fr))`,
          }}
        >
          {layout.grid.map((tile) => renderTile(tile))}
        </div>
      </div>
      {Object.entries(call.remote).map(([pid, tracks]) =>
        tracks.audio ? <AudioTrack key={pid} track={tracks.audio} /> : null
      )}
      <div className="px-4">
        <DeviceNotices devices={call.devices} />
      </div>
      <RoomControls
        micOn={call.micOn}
        cameraOn={call.cameraOn}
        sharing={call.sharing}
        canEnd={canEnd}
        onMic={() => void call.toggleMic()}
        onCamera={() => void call.toggleCamera()}
        onScreen={() => void call.toggleScreen()}
        onLeave={() => void call.leave()}
        onEnd={confirmEnd}
      />
    </div>
  );
}

function Notice({
  title,
  back,
  children,
}: {
  title: string;
  back: string;
  children?: ReactNode;
}) {
  const t = useTranslations('MeetingRoom');
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-2 p-10 text-center">
      <h1 className="text-lg font-semibold">{title}</h1>
      {children && (
        <div className="text-muted-foreground text-sm">{children}</div>
      )}
      <Link href={back} className={buttonVariants({ variant: 'outline' })}>
        {t('back')}
      </Link>
    </div>
  );
}
