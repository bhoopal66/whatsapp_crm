'use client';

import { Maximize2, Mic, MicOff, Minus, PhoneOff } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from 'react';

import { useAuth } from '@/hooks/use-auth';
import {
  floatFocus,
  floatTileSizes,
  speakerLine,
  type FloatView,
} from '@/lib/meetings/float/focus';
import {
  clampFloatSize,
  FLOAT_SIZE_KEY,
  readFloatSize,
  writeFloatSize,
  type FloatCorner,
} from '@/lib/meetings/float/geometry';
import { unreadCount } from '@/lib/meetings/room-ui/chat';
import { formatElapsed } from '@/lib/meetings/room-ui/people';
import { nextRemoteSpeaker } from '@/lib/meetings/room-ui/tiles';
import type { Anchor, Rect, Size } from '@/lib/pbx/call-window';
import { cn } from '@/lib/utils';

import { useFloatingWindow } from '../../pbx/use-floating-window';
import { useWorkspaceMembers } from '../use-workspace-members';
import { FloatButton, FloatControls } from './float-controls';
import { FloatAvatar, FloatStage, type FloatPeople } from './float-stage';
import { useActiveCall, type ActiveCall } from './meeting-session-provider';
import { useResizableWindow } from './use-resizable-window';

const ANCHOR: Anchor = { h: 'right', v: 'bottom', dx: 16, dy: 16 };
/** Header and controls, and the stage's padding: all but the stage. */
const CHROME_HEIGHT = 36 + 48;
const CORNERS: Record<FloatCorner, string> = {
  nw: 'top-0 left-0 cursor-nwse-resize',
  ne: 'top-0 right-0 cursor-nesw-resize',
  sw: 'bottom-0 left-0 cursor-nesw-resize',
  se: 'bottom-0 right-0 cursor-nwse-resize',
};

const callWindowRect = (): Rect | null => {
  const r = document
    .querySelector('[data-call-window]')
    ?.getBoundingClientRect();
  return r
    ? { left: r.left, top: r.top, width: r.width, height: r.height }
    : null;
};

const viewportNow = (): Size => ({
  width: document.documentElement.clientWidth || window.innerWidth,
  height: window.innerHeight,
});

function loadSize(): Size {
  try {
    const raw = window.localStorage.getItem(FLOAT_SIZE_KEY);
    return clampFloatSize(readFloatSize(raw), viewportNow());
  } catch {
    return readFloatSize(null);
  }
}

/** The call, while the person works on another page. */
export function MeetingFloat() {
  const active = useActiveCall();
  return active ? <FloatWindow active={active} /> : null;
}

function FloatWindow({ active }: { active: ActiveCall }) {
  const { call, meetingId, roomUi } = active;
  const t = useTranslations('MeetingSession.float');
  const router = useRouter();
  const { user } = useAuth();
  const { nameOf, avatarOf } = useWorkspaceMembers();
  const win = useFloatingWindow({
    storageKey: 'meetings:float',
    defaultAnchor: ANCHOR,
    label: t('move'),
    roleDescription: t('draggable'),
    avoid: callWindowRect,
  });
  const { minimized, mobile, handleProps } = win;

  const [size, setSize] = useState(loadSize);
  const [box, setBox] = useState(size);
  const [view, setView] = useState<FloatView>('speaker');
  const [now, setNow] = useState(() => Date.now());
  const [lastSpeaker, setLastSpeaker] = useState<string | null>(null);
  const self = call.participantId;
  const next = nextRemoteSpeaker(lastSpeaker, call.activeSpeakerId, self);
  if (next !== lastSpeaker) setLastSpeaker(next);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const onResize = () => setSize((s) => clampFloatSize(s, viewportNow()));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // The window's real size: the controls and the camera layers follow
  // it, a corner drag included, in 8px steps to spare the renders.
  const root = useRef<HTMLDivElement | null>(null);
  const { attach } = win;
  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      root.current = el;
      attach(el);
    },
    [attach]
  );
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(() =>
      setBox((b) => {
        const width = Math.round(el.offsetWidth / 8) * 8;
        const height = Math.round(el.offsetHeight / 8) * 8;
        return b.width === width && b.height === height ? b : { width, height };
      })
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { settleRect, hold } = win;
  const gripProps = useResizableWindow({
    element: () => root.current,
    hold,
    onResized: (rect) => {
      const sized = { width: rect.width, height: rect.height };
      setSize(sized);
      settleRect(rect);
      try {
        window.localStorage.setItem(FLOAT_SIZE_KEY, writeFloatSize(sized));
      } catch {
        // Blocked storage: the window just forgets its size.
      }
    },
  });

  const { participants, remote, activeSpeakerId, setTileSizes } = call;
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

  // The phone bar shows no video either: it pulls like the pill.
  const collapsed = minimized || mobile;
  const stageHeight = box.height - CHROME_HEIGHT;
  const mainCameraId = focus.kind === 'camera' ? focus.mainId : null;
  useEffect(() => {
    setTileSizes(
      floatTileSizes({
        participantIds: ids,
        selfId: self,
        mainCameraId,
        stageHeight,
        dpr: window.devicePixelRatio,
        minimized: collapsed,
      })
    );
  }, [ids, self, mainCameraId, stageHeight, collapsed, setTileSizes]);

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

  const room = `/meetings/${meetingId}/room`;
  const open = () => router.push(room);
  const openChat = () => {
    roomUi.setPanel('chat');
    open();
  };
  const seenAt = useSyncExternalStore(
    roomUi.subscribe,
    () => roomUi.getSnapshot().chatSeenAt,
    () => null
  );
  const unread = unreadCount(call.chat, seenAt, user?.id ?? null);

  const since = call.liveSince ? Date.parse(call.liveSince) : NaN;
  const elapsed = Number.isFinite(since) ? formatElapsed(now - since) : '';
  const title = call.meeting?.title ?? '';
  const speakerName = speakerLine(
    activeSpeakerId,
    call.speaking,
    self,
    people.nameOf
  );
  const line = speakerName ? t('speaking', { name: speakerName }) : title;

  const dragProps = {
    style: handleProps.style,
    onPointerDown: handleProps.onPointerDown,
    onPointerMove: handleProps.onPointerMove,
    onPointerUp: handleProps.onPointerUp,
    onPointerCancel: handleProps.onPointerCancel,
    onLostPointerCapture: handleProps.onLostPointerCapture,
    onDoubleClick: (e: MouseEvent<HTMLElement>) => {
      if (!(e.target as Element).closest('button, a, [data-no-drag]')) open();
    },
  };
  const micButton = (
    <FloatButton
      label={t(call.micOn ? 'mute' : 'unmute')}
      tone={call.micOn ? 'plain' : 'off'}
      onClick={() => void call.toggleMic()}
    >
      {call.micOn ? <Mic className="size-4" /> : <MicOff className="size-4" />}
    </FloatButton>
  );
  const leaveButton = (
    <FloatButton
      label={t('leave')}
      tone="leave"
      onClick={() => void call.leave()}
    >
      <PhoneOff className="size-4" />
    </FloatButton>
  );
  const returnButton = (
    <FloatButton label={t('return')} onClick={open}>
      <Maximize2 className="size-4" />
    </FloatButton>
  );
  const liveDot = (
    <span className="size-2 shrink-0 rounded-full bg-emerald-400" />
  );
  const mainIdForBar = focus.speakerId ?? self;

  return (
    <div
      ref={setRoot}
      data-meeting-float
      data-mode="dark"
      role="region"
      aria-label={t('region')}
      style={collapsed ? undefined : size}
      className={cn(
        'bg-card text-foreground border-border group fixed z-40 flex flex-col rounded-2xl border shadow-2xl',
        mobile && 'inset-x-2 bottom-2 flex-row items-center gap-2 p-2',
        !mobile && minimized && 'h-11 w-80 flex-row items-center gap-2 px-3'
      )}
    >
      {mobile ? (
        <>
          {mainIdForBar && (
            <span
              data-float-speaking={
                call.speaking[mainIdForBar] ? 'true' : 'false'
              }
              className={cn(
                'rounded-full ring-2 transition-shadow duration-150',
                call.speaking[mainIdForBar]
                  ? 'ring-emerald-400'
                  : 'ring-transparent'
              )}
            >
              <FloatAvatar
                id={mainIdForBar}
                people={people}
                className="size-8 text-xs"
              />
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-sm">{line}</span>
          {micButton}
          {returnButton}
          {leaveButton}
        </>
      ) : minimized ? (
        <>
          <div
            {...handleProps}
            className="flex h-full min-w-0 flex-1 items-center gap-2 text-sm"
          >
            {liveDot}
            <span className="min-w-0 flex-1 truncate">{line}</span>
            <span className="text-muted-foreground text-xs tabular-nums">
              {elapsed}
            </span>
          </div>
          {micButton}
          <FloatButton
            label={t('expand')}
            onClick={() => win.setMinimized(false)}
          >
            <Maximize2 className="size-4" />
          </FloatButton>
          {leaveButton}
        </>
      ) : (
        <>
          <div
            {...handleProps}
            className="flex h-9 shrink-0 items-center gap-2 pr-1.5 pl-3 text-sm"
          >
            {liveDot}
            <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
            <span className="text-muted-foreground text-xs tabular-nums">
              {elapsed}
            </span>
            <button
              type="button"
              title={t('minimise')}
              aria-label={t('minimise')}
              onClick={() => win.setMinimized(true)}
              className="hover:bg-accent grid size-7 place-items-center rounded-full"
            >
              <Minus className="size-4" />
            </button>
            <button
              type="button"
              title={t('return')}
              aria-label={t('return')}
              onClick={open}
              className="hover:bg-accent grid size-7 place-items-center rounded-full"
            >
              <Maximize2 className="size-3.5" />
            </button>
          </div>
          <div className="flex min-h-0 flex-1 px-1.5">
            <FloatStage
              call={call}
              focus={focus}
              people={people}
              view={view}
              onView={setView}
              width={box.width}
              height={stageHeight}
              dragProps={dragProps}
            />
          </div>
          <FloatControls
            call={call}
            width={box.width}
            chatUnread={unread}
            onChat={openChat}
          />
          {(Object.keys(CORNERS) as FloatCorner[]).map((corner) => (
            <span
              key={corner}
              role="button"
              tabIndex={0}
              aria-label={t('resize')}
              {...gripProps(corner)}
              style={{ touchAction: 'none' }}
              className={cn(
                'focus-visible:bg-ring/60 group-hover:bg-foreground/25 absolute size-3.5 rounded-full outline-none',
                CORNERS[corner]
              )}
            />
          ))}
        </>
      )}
    </div>
  );
}
