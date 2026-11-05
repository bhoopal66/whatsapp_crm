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
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';

import { Button, buttonVariants } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import {
  MeetingCallEngine,
  useCallOf,
  type MeetingCall,
} from '@/hooks/use-meeting-call';
import type {
  ModerationAction,
  ParticipantId,
} from '@/lib/meetings/room/contract';
import { shortcutFor } from '@/lib/meetings/room-ui/keys';
import { formatElapsed } from '@/lib/meetings/room-ui/people';
import { arrangeStage, type StageTile } from '@/lib/meetings/room-ui/stage';
import {
  buildStageTiles,
  nextRemoteSpeaker,
  pipTarget,
} from '@/lib/meetings/room-ui/tiles';
import type { RoomPanel, RoomUi } from '@/lib/meetings/session/room-ui';
import type { HeldMeeting } from '@/lib/meetings/session/session';

import { useMeetingRoomClaim } from '../session/meeting-session-provider';
import { useWorkspaceMembers } from '../use-workspace-members';
import { DeviceNotices } from './device-notices';
import {
  ControlBar,
  FloatingReactions,
  useFullscreen,
  usePictureInPicture,
} from './control-bar';
import { RoomLobby } from './room-lobby';
import { RoomPanels } from './room-side-panel';
import { RoomStage } from './room-stage';
import { QualityBars, RoomTile } from './room-tile';

/** Main has no padding on this path: every screen but the call brings its own. */
function RoomPage({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">{children}</div>
  );
}

/** /meetings/[id]/room: claims the meeting's call from the session. */
export function MeetingRoom({ meetingId }: { meetingId: string }) {
  const t = useTranslations('MeetingRoom');
  const create = useCallback(
    () => new MeetingCallEngine(meetingId),
    [meetingId]
  );
  const claim = useMeetingRoomClaim(meetingId, create);
  if (claim.kind === 'ready') {
    return (
      <ClaimedRoom
        engine={claim.engine}
        roomUi={claim.roomUi}
        meetingId={meetingId}
      />
    );
  }
  if (claim.kind === 'busy') {
    return <BusyScreen held={claim.held} onTakeOver={claim.takeOver} />;
  }
  return (
    <RoomPage>
      <p className="text-muted-foreground text-sm">{t('loading')}</p>
    </RoomPage>
  );
}

/** Another meeting's call is running, and there is one call at a time. */
function BusyScreen({
  held,
  onTakeOver,
}: {
  held: HeldMeeting;
  onTakeOver: () => Promise<void>;
}) {
  const t = useTranslations('MeetingSession.busy');
  const [leaving, setLeaving] = useState(false);
  return (
    <RoomPage>
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 p-10 text-center">
        <h1 className="text-lg font-semibold">
          {t('title', { title: held.title })}
        </h1>
        <p className="text-muted-foreground text-sm">{t('body')}</p>
        <Link
          href={`/meetings/${held.meetingId}/room`}
          className={buttonVariants({ variant: 'default' })}
        >
          {t('back', { title: held.title })}
        </Link>
        <Button
          type="button"
          variant="outline"
          disabled={leaving}
          onClick={() => {
            setLeaving(true);
            void onTakeOver();
          }}
        >
          {t('takeOver')}
        </Button>
      </div>
    </RoomPage>
  );
}

/** Lobby, then the call, then whatever ended it. */
function ClaimedRoom({
  engine,
  roomUi,
  meetingId,
}: {
  engine: MeetingCallEngine;
  roomUi: RoomUi;
  meetingId: string;
}) {
  const t = useTranslations('MeetingRoom');
  const call = useCallOf(engine);
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
    return (
      <RoomPage>
        <p className="text-muted-foreground text-sm">{t('loading')}</p>
      </RoomPage>
    );
  }
  // Before "missing": since 112 a removal hides the meeting too.
  // Back to the list: the meeting's own page is hidden from them too.
  if (call.phase === 'removed') {
    return <EndScreen title={t('removed.title')} back="/meetings" />;
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
  // Removed by the host: the lobby says so, with Join disabled.
  if (call.phase === 'error' && call.error !== 'removed_from_meeting') {
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
  if (
    call.phase === 'lobby' ||
    call.phase === 'joining' ||
    call.phase === 'error'
  ) {
    return (
      <RoomPage>
        <RoomLobby
          call={call}
          meetingId={meetingId}
          title={call.meeting?.title ?? ''}
        />
      </RoomPage>
    );
  }
  // The chat/people panels and the settings dialog.
  return (
    <RoomPanels call={call} roomUi={roomUi}>
      {(seams) => (
        <LiveRoom
          call={call}
          roomUi={roomUi}
          meetingId={meetingId}
          {...seams}
        />
      )}
    </RoomPanels>
  );
}

export interface LiveRoomProps {
  call: MeetingCall;
  roomUi: RoomUi;
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
  roomUi,
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
  const ui = useSyncExternalStore(
    roomUi.subscribe,
    roomUi.getSnapshot,
    roomUi.getSnapshot
  );
  const { layout: mode, pinnedKey, page, hideSelf } = ui;
  const fullscreen = useFullscreen();
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
    hideSelf,
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

  // The room owns fullscreen and picture-in-picture: leave both when it
  // unmounts (Leave, removed, ended, error), or the end screen stays
  // fullscreen and the PiP window shows black.
  useEffect(() => {
    return () => {
      try {
        if (document.fullscreenElement) {
          void document.exitFullscreen().catch(() => {});
        }
        if (document.pictureInPictureElement) {
          void document.exitPictureInPicture().catch(() => {});
        }
      } catch {
        // Unsupported or already exited: nothing to leave.
      }
    };
  }, []);

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
      else if (s === 'chat' || s === 'people' || s === 'closePanel') {
        onTogglePanel(s);
      }
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
          roomUi.setPinnedKey(pinnedKey === tile.key ? null : tile.key)
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
    // Fullscreen stays on the document, not this element: every popover,
    // dropdown and dialog portals to document.body and would vanish
    // under element fullscreen. So the room stretches itself over the
    // shell for as long as the document is fullscreen.
    <div
      className={
        fullscreen.active
          ? 'fixed inset-0 z-40 flex flex-col bg-neutral-950 text-white'
          : 'relative flex h-full min-h-0 flex-col bg-neutral-950 text-white'
      }
    >
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
            onPage={roomUi.setPage}
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
      <div className="px-4">
        <DeviceNotices devices={call.devices} />
      </div>
      <ControlBar
        call={call}
        layout={mode}
        onLayout={roomUi.setLayout}
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
    <RoomPage>
      <div className="mx-auto flex max-w-md flex-col items-center gap-2 p-10 text-center">
        <h1 className="text-lg font-semibold">{title}</h1>
        {children && (
          <div className="text-muted-foreground text-sm">{children}</div>
        )}
        <Link href={back} className={buttonVariants({ variant: 'outline' })}>
          {t('back')}
        </Link>
      </div>
    </RoomPage>
  );
}
