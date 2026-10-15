'use client';

import { Copy, Users } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';

import { Button, buttonVariants } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { useMeetingCall, type MeetingCall } from '@/hooks/use-meeting-call';
import type {
  ModerationAction,
  ParticipantId,
} from '@/lib/meetings/room/contract';
import { shortcutFor } from '@/lib/meetings/room-ui/keys';
import { formatElapsed } from '@/lib/meetings/room-ui/people';
import {
  arrangeStage,
  type LayoutMode,
  type StageTile,
} from '@/lib/meetings/room-ui/stage';
import {
  buildStageTiles,
  nextRemoteSpeaker,
  pipTarget,
} from '@/lib/meetings/room-ui/tiles';

import { useWorkspaceMembers } from '../use-workspace-members';
import { DeviceNotices } from './device-notices';
import {
  ControlBar,
  FloatingReactions,
  usePictureInPicture,
} from './control-bar';
import { RoomLobby } from './room-lobby';
import { RoomStage } from './room-stage';
import { QualityBars, RoomTile } from './room-tile';
import { AudioTrack } from './video-track';

/** The side panels part 2 builds; the room only opens and toggles them. */
export type RoomPanel = 'chat' | 'people';

/** /meetings/[id]/room: lobby, then the call, then whatever ended it. */
export function MeetingRoom({ meetingId }: { meetingId: string }) {
  const t = useTranslations('MeetingRoom');
  const call = useMeetingCall(meetingId);
  const back = `/meetings/${meetingId}`;
  const rejoin = (
    <Button
      type="button"
      className="mt-4"
      onClick={() => void call.returnToLobby()}
    >
      {t('left.rejoin')}
    </Button>
  );

  if (call.error === 'not_configured') {
    return (
      <EndScreen title={t('notConfigured.title')} back={back}>
        {t('notConfigured.body')}
      </EndScreen>
    );
  }
  if (call.meetingState === 'loading') {
    return <p className="text-muted-foreground p-6 text-sm">{t('loading')}</p>;
  }
  if (call.meetingState === 'missing' || call.error === 'forbidden') {
    return <EndScreen title={t('missing.title')} back="/meetings" />;
  }
  if (
    call.phase === 'ended' ||
    call.error === 'meeting_closed' ||
    (call.phase === 'lobby' && call.meeting?.status !== 'scheduled')
  ) {
    return <EndScreen title={t('ended.title')} back={back} />;
  }
  if (call.phase === 'removed') {
    return <EndScreen title={t('removed.title')} back={back} />;
  }
  if (call.phase === 'left') {
    return (
      <EndScreen
        title={
          call.error === 'seat_closed' ? t('left.elsewhere') : t('left.title')
        }
        back={back}
      >
        {rejoin}
      </EndScreen>
    );
  }
  if (call.phase === 'error') {
    return (
      <EndScreen title={t(`error.${call.error ?? 'join_failed'}`)} back={back}>
        <Button
          type="button"
          className="mt-4"
          onClick={() => void call.returnToLobby()}
        >
          {t('error.retry')}
        </Button>
      </EndScreen>
    );
  }
  if (call.phase === 'lobby' || call.phase === 'joining') {
    return (
      <RoomLobby
        call={call}
        meetingId={meetingId}
        title={call.meeting?.title ?? ''}
      />
    );
  }
  // Part 2 replaces these no-ops with its chat/people panels, the
  // settings dialog and the unread count.
  return (
    <LiveRoom
      call={call}
      meetingId={meetingId}
      chatUnread={0}
      onOpenPanel={() => {}}
      onTogglePanel={() => {}}
      onOpenSettings={() => {}}
    />
  );
}

export interface LiveRoomProps {
  call: MeetingCall;
  meetingId: string;
  /** Unread chat lines, for the Chat button's badge. */
  chatUnread: number;
  onOpenPanel: (panel: RoomPanel) => void;
  /** Keyboard: C, P and Esc ('closePanel'). */
  onTogglePanel: (shortcut: RoomPanel | 'closePanel') => void;
  onOpenSettings: () => void;
  /** Rendered beside the stage (part 2's panel). */
  sidePanel?: ReactNode;
}

export function LiveRoom({
  call,
  meetingId,
  sidePanel,
  chatUnread,
  onOpenPanel,
  onTogglePanel,
  onOpenSettings,
}: LiveRoomProps) {
  const t = useTranslations('MeetingRoom');
  const { nameOf } = useWorkspaceMembers();
  const { profile, user } = useAuth();
  const me = call.participantId;
  const rows = call.participants;
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const [mode, setMode] = useState<LayoutMode>('auto');
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  // The last remote speaker, so Speaker mode keeps them on screen while
  // we talk. State adjusted during render, not a ref: refs may not be
  // read while rendering.
  const [lastRemote, setLastRemote] = useState<ParticipantId | null>(null);
  const remoteSpeaker = nextRemoteSpeaker(lastRemote, call.activeSpeakerId, me);
  if (remoteSpeaker !== lastRemote) setLastRemote(remoteSpeaker);

  const tiles = useMemo(
    () =>
      buildStageTiles({
        selfId: me,
        participants: rows,
        selfSharing: call.sharing,
        receivedScreens: new Set(
          Object.keys(call.remote).filter((id) => !!call.remote[id]?.screen)
        ),
      }),
    [me, rows, call.sharing, call.remote]
  );
  const arrangement = arrangeStage({
    tiles,
    mode,
    pinnedKey,
    activeSpeakerId: call.activeSpeakerId,
    lastRemoteSpeakerId: remoteSpeaker,
    page,
  });

  // Picture-in-picture: every drawn <video>, by tile key, read only when
  // the button is pressed.
  const videos = useRef(new Map<string, HTMLVideoElement>());
  const registerVideo = useCallback(
    (key: string, el: HTMLVideoElement | null) => {
      if (el) videos.current.set(key, el);
      else videos.current.delete(key);
    },
    []
  );
  const pip = usePictureInPicture();
  const pipTile = pipTarget(arrangement, call.activeSpeakerId, remoteSpeaker);
  const togglePip = () => {
    if (document.pictureInPictureElement) {
      void document.exitPictureInPicture().catch(() => {});
      return;
    }
    const video = pipTile ? videos.current.get(pipTile.key) : undefined;
    if (!video) {
      toast.message(t('controlBar.pipNothing'));
      return;
    }
    video.requestPictureInPicture().catch(() => {
      toast.error(t('controlBar.pipFailed'));
    });
  };

  // Keyboard: M, V, S, H here; C, P and Esc belong to the panels.
  const callRef = useRef(call);
  useEffect(() => {
    callRef.current = call;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = shortcutFor(e, e.target as HTMLElement | null);
      if (!s) return;
      const c = callRef.current;
      if (s === 'mic') void c.toggleMic();
      else if (s === 'camera') void c.toggleCamera();
      else if (s === 'share') void c.toggleScreen();
      else if (s === 'hand') void c.toggleHand();
      else onTogglePanel(s);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onTogglePanel]);

  const moderate = async (pid: ParticipantId, action: ModerationAction) => {
    if (!(await call.moderate(pid, action)))
      toast.error(t('tile.moderateFailed'));
  };

  const renderTile = (tile: StageTile) => {
    const row = byId.get(tile.participantId);
    const remote = call.remote[tile.participantId];
    const userId = tile.isSelf ? (user?.id ?? '') : (row?.user_id ?? '');
    const name =
      (tile.isSelf ? profile?.full_name : null) ||
      (userId && nameOf(userId)) ||
      t('tile.unknown');
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
    return (
      <RoomTile
        name={name}
        userId={userId}
        isSelf={tile.isSelf}
        kind={tile.kind}
        track={track}
        muted={tile.isSelf ? !call.micOn : (row?.audio_muted ?? false)}
        speaking={!!call.speaking[tile.participantId]}
        handRaised={tile.isSelf ? call.handRaised : !!row?.hand_raised_at}
        quality={
          tile.isSelf
            ? call.quality.self
            : (call.quality.remote[tile.participantId] ?? 'unknown')
        }
        pinned={pinnedKey === tile.key}
        onTogglePin={() =>
          setPinnedKey((k) => (k === tile.key ? null : tile.key))
        }
        videoRef={(el) => registerVideo(tile.key, el)}
        onModerate={
          call.canModerate && !tile.isSelf && tile.kind === 'camera'
            ? (a) => void moderate(tile.participantId, a)
            : undefined
        }
        className="h-full w-full"
      />
    );
  };

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-neutral-950 text-white">
      {call.phase === 'reconnecting' && (
        <p
          role="status"
          className="bg-amber-500 px-4 py-1.5 text-center text-sm text-black"
        >
          {t('reconnecting')}
        </p>
      )}
      <TopBar call={call} meetingId={meetingId} />
      <div className="flex min-h-0 flex-1 gap-2 px-2">
        <div className="relative flex min-w-0 flex-1">
          <RoomStage
            arrangement={arrangement}
            participantIds={rows.map((r) => r.id)}
            selfId={me}
            renderTile={renderTile}
            onPage={setPage}
            onTileSizes={call.setTileSizes}
          />
          <FloatingReactions
            reactions={call.reactions}
            nameOf={(id) =>
              (id === user?.id ? profile?.full_name : null) ||
              nameOf(id) ||
              t('tile.unknown')
            }
          />
        </div>
        {sidePanel}
      </div>
      {Object.entries(call.remote).map(([pid, tracks]) =>
        tracks.audio ? (
          <AudioTrack
            key={pid}
            track={tracks.audio}
            sinkId={call.selectedDevices.audiooutput}
          />
        ) : null
      )}
      <div className="px-4">
        <DeviceNotices devices={call.devices} />
      </div>
      <ControlBar
        call={call}
        layout={mode}
        onLayout={setMode}
        chatUnread={chatUnread}
        onOpenPanel={onOpenPanel}
        onOpenSettings={onOpenSettings}
        pip={{ ...pip, available: !!pipTile }}
        onPip={togglePip}
      />
    </div>
  );
}

function TopBar({ call, meetingId }: { call: MeetingCall; meetingId: string }) {
  const t = useTranslations('MeetingRoom.topBar');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const copy = useCallback(() => {
    const url = `${window.location.origin}/meetings/${meetingId}`;
    navigator.clipboard?.writeText(url).then(
      () => toast.success(t('copied')),
      () => toast.error(t('copyFailed'))
    );
  }, [meetingId, t]);
  const since = call.liveSince ? Date.parse(call.liveSince) : NaN;
  return (
    <div className="flex items-center gap-3 px-4 py-2 text-sm">
      <h1 className="min-w-0 truncate font-medium">{call.meeting?.title}</h1>
      {Number.isFinite(since) && (
        <span className="text-white/70 tabular-nums" aria-label={t('elapsed')}>
          {formatElapsed(now - since)}
        </span>
      )}
      <span
        className="flex items-center gap-1 text-white/70"
        title={t('people')}
      >
        <Users className="size-4" aria-hidden />
        {Math.max(1, call.participants.length)}
      </span>
      <span className="ml-auto flex items-center gap-2">
        <QualityBars quality={call.quality.self} />
        <Button type="button" size="sm" variant="secondary" onClick={copy}>
          <Copy />
          {t('copyLink')}
        </Button>
      </span>
    </div>
  );
}

function EndScreen({
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
