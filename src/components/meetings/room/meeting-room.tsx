'use client';

import {
  CalendarCheck,
  LogOut,
  MonitorSmartphone,
  SearchX,
  TriangleAlert,
  UserMinus,
  Video,
  VideoOff,
} from 'lucide-react';
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
import { canFullscreen } from '@/lib/meetings/room-ui/controls';
import { shortcutFor } from '@/lib/meetings/room-ui/keys';
import { arrangeStage, type StageTile } from '@/lib/meetings/room-ui/stage';
import { handQueueRank } from '@/lib/meetings/room-ui/tile-view';
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
import { RoomEndScreen, type EndAction } from './room-end-screen';
import { RoomLobby } from './room-lobby';
import { RoomPanels } from './room-side-panel';
import { RoomStage } from './room-stage';
import { RoomTile } from './room-tile';
import { RoomTopBar } from './room-top-bar';
import { ShortcutsDialog } from './shortcuts-dialog';
import { useHoldToTalk } from './use-hold-to-talk';

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
    <RoomEndScreen
      icon={Video}
      title={t('title', { title: held.title })}
      body={t('body')}
      actions={[
        {
          label: t('back', { title: held.title }),
          href: `/meetings/${held.meetingId}/room`,
        },
        {
          label: t('takeOver'),
          disabled: leaving,
          onClick: () => {
            setLeaving(true);
            void onTakeOver();
          },
        },
      ]}
    />
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
  const readMicOn = useCallback(() => engine.getSnapshot().micOn, [engine]);
  const back = `/meetings/${meetingId}`;
  const backToMeeting: EndAction = { label: t('back'), href: back };
  const toMeetings: EndAction = {
    label: t('left.backToMeetings'),
    href: '/meetings',
  };

  if (call.error === 'not_configured') {
    return (
      <RoomEndScreen
        icon={VideoOff}
        tone="warning"
        title={t('notConfigured.title')}
        body={t('notConfigured.body')}
        actions={[backToMeeting]}
      />
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
    return (
      <RoomEndScreen
        icon={UserMinus}
        title={t('removed.title')}
        body={t('removed.body')}
        actions={[toMeetings]}
      />
    );
  }
  if (call.meetingState === 'missing' || call.error === 'forbidden') {
    return (
      <RoomEndScreen
        icon={SearchX}
        title={t('missing.title')}
        actions={[toMeetings]}
      />
    );
  }
  if (
    call.phase === 'ended' ||
    call.error === 'meeting_closed' ||
    (call.phase === 'lobby' && call.meeting?.status !== 'scheduled')
  ) {
    return (
      <RoomEndScreen
        icon={CalendarCheck}
        title={t('ended.title')}
        body={call.meeting?.title}
        actions={[{ label: t('ended.viewSummary'), href: back }, toMeetings]}
      />
    );
  }
  if (call.phase === 'left') {
    const elsewhere = call.error === 'seat_closed';
    return (
      <RoomEndScreen
        icon={elsewhere ? MonitorSmartphone : LogOut}
        title={elsewhere ? t('left.elsewhere') : t('left.title')}
        body={elsewhere ? t('left.elsewhereBody') : call.meeting?.title}
        actions={[
          {
            label: elsewhere ? t('left.rejoinHere') : t('left.rejoin'),
            onClick: () => void call.returnToLobby(),
          },
          toMeetings,
        ]}
      />
    );
  }
  // Removed by the host: the lobby says so, with Join disabled.
  if (call.phase === 'error' && call.error !== 'removed_from_meeting') {
    return (
      <RoomEndScreen
        icon={TriangleAlert}
        tone="warning"
        title={t(`error.${call.error ?? 'join_failed'}`)}
        actions={[
          {
            label: t('error.retry'),
            onClick: () => void call.returnToLobby(),
          },
          backToMeeting,
        ]}
      />
    );
  }
  if (
    call.phase === 'lobby' ||
    call.phase === 'joining' ||
    call.phase === 'error'
  ) {
    return (
      <RoomLobby
        call={call}
        meetingId={meetingId}
        title={call.meeting?.title ?? ''}
      />
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
          readMicOn={readMicOn}
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
  /** The engine's mic state now, for hold-to-talk. Must be stable. */
  readMicOn: () => boolean;
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
  readMicOn,
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
  const { layout: mode, pinnedKey, page, hideSelf, panel } = ui;
  const fullscreen = useFullscreen();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
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

  const toggleFullscreen = useCallback(() => {
    const done = document.fullscreenElement
      ? document.exitFullscreen()
      : document.documentElement.requestFullscreen();
    done.catch(() => toast.error(t('controlBar.fullscreenFailed')));
  }, [t]);

  useHoldToTalk(call.toggleMic, readMicOn);

  // Keyboard: M, V, S, H, F and ? here; C, P and Esc belong to the panels.
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
      else if (s === 'fullscreen') {
        if (canFullscreen(document)) toggleFullscreen();
      } else if (s === 'shortcuts') setShortcutsOpen((open) => !open);
      else if (s === 'chat' || s === 'people' || s === 'closePanel') {
        onTogglePanel(s);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onTogglePanel, toggleFullscreen]);

  const moderate = async (pid: ParticipantId, action: ModerationAction) => {
    if (!(await call.moderate(pid, action)))
      toast.error(t('tile.moderateFailed'));
  };

  const renderTile = (
    tile: StageTile,
    box: { width: number; height: number; compact: boolean }
  ) => {
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
    const cameraOn = tile.isSelf
      ? call.cameraOn
      : !!row && !row.video_off && row.tracks.some((x) => x.kind === 'video');
    return (
      <RoomTile
        participantId={tile.participantId}
        name={name}
        userId={userId}
        isSelf={tile.isSelf}
        kind={tile.kind}
        track={track}
        videoLoading={tile.kind === 'camera' && !track && cameraOn}
        muted={tile.isSelf ? !call.micOn : (row?.audio_muted ?? false)}
        speaking={!!call.speaking[tile.participantId]}
        handRaised={tile.isSelf ? call.handRaised : !!row?.hand_raised_at}
        handRank={handQueueRank(rows, tile.participantId, me, call.handRaised)}
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
        box={box}
        compact={box.compact}
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
      data-mode="dark"
      className={
        fullscreen.active
          ? 'bg-background text-foreground fixed inset-0 z-40 flex flex-col'
          : 'bg-background text-foreground relative flex h-full min-h-0 flex-col'
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
      <RoomTopBar call={call} meetingId={meetingId} onOpenPanel={onOpenPanel} />
      {/* A grid, not a column beside the panel: the panel runs the full
          height and the dock sits under the stage alone, so an open panel
          narrows the dock and the dock's measured width says so. */}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_auto] grid-rows-[minmax(0,1fr)_auto] px-2">
        <div className="relative col-start-1 row-start-1 flex min-h-0 min-w-0">
          <RoomStage
            arrangement={arrangement}
            participantIds={rows.map((r) => r.id)}
            selfId={me}
            meetingId={meetingId}
            selfSharing={call.sharing}
            renderTile={renderTile}
            onPage={roomUi.setPage}
            onStopShare={() => void call.toggleScreen()}
            onTileSizes={call.setTileSizes}
            openToWorkspace={!!call.meeting?.open_to_workspace}
            onInvite={() => onOpenPanel('people')}
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
        {/* On a phone the panel is a sheet in a portal: nothing lands here. */}
        <div className="col-start-2 row-span-2 row-start-1 ml-2 flex min-h-0 empty:hidden">
          {sidePanel}
        </div>
        <div className="col-start-1 row-start-2 min-w-0">
          <div className="px-2">
            <DeviceNotices devices={call.devices} />
          </div>
          <ControlBar
            call={call}
            layout={mode}
            onLayout={roomUi.setLayout}
            recorder={ui.recorder}
            hideSelf={hideSelf}
            onHideSelf={roomUi.setHideSelf}
            chatUnread={chatUnread}
            panel={panel}
            onTogglePanel={onTogglePanel}
            onOpenSettings={onOpenSettings}
            onOpenShortcuts={() => setShortcutsOpen(true)}
            onFullscreen={toggleFullscreen}
            pip={{ ...pip, available: !!pipTile }}
            onPip={togglePip}
            popout={ui.popout}
          />
        </div>
      </div>
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );
}
