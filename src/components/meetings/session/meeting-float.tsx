'use client';

import {
  Maximize2,
  Mic,
  MicOff,
  Minus,
  PhoneOff,
  PictureInPicture2,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from 'react';

import { floatTileSizes, speakerLine } from '@/lib/meetings/float/focus';
import {
  clampFloatSize,
  FLOAT_SIZE_KEY,
  readFloatSize,
  writeFloatSize,
  type FloatCorner,
} from '@/lib/meetings/float/geometry';
import { tileReporter } from '@/lib/meetings/float/popout';
import { formatElapsed } from '@/lib/meetings/room-ui/people';
import type { Anchor, Rect, Size } from '@/lib/pbx/call-window';
import { cn } from '@/lib/utils';

import { useFloatingWindow } from '../../pbx/use-floating-window';
import { FloatButton, FloatControls } from './float-controls';
import { FloatAvatar, FloatStage } from './float-stage';
import { useActiveCall, type ActiveCall } from './meeting-session-provider';
import { useFloatView } from './use-float-view';
import { useResizableWindow } from './use-resizable-window';

const ANCHOR: Anchor = { h: 'right', v: 'bottom', dx: 16, dy: 16 };
/** Header and controls, and the stage's padding: all but the stage. */
const CHROME_HEIGHT = 36 + 48;
// Grab areas larger than they look, reaching past the rounded edge: a
// small target missed by a few pixels starts a text selection in the
// page behind instead. Square until focused, because hit-testing honours
// a radius: the very corner, where people aim, would otherwise be dead.
// Corners sit above the edges and take the keyboard.
const CORNERS: Partial<Record<FloatCorner, string>> = {
  nw: '-top-1.5 -start-1.5 cursor-nwse-resize',
  ne: '-top-1.5 -end-1.5 cursor-nesw-resize',
  sw: '-bottom-1.5 -start-1.5 cursor-nesw-resize',
  se: '-end-1.5 -bottom-1.5 cursor-nwse-resize',
};
const EDGES: Partial<Record<FloatCorner, string>> = {
  n: 'inset-x-4 -top-1 h-2 cursor-ns-resize',
  s: 'inset-x-4 -bottom-1 h-2 cursor-ns-resize',
  w: 'inset-y-4 -start-1 w-2 cursor-ew-resize',
  e: 'inset-y-4 -end-1 w-2 cursor-ew-resize',
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
  const { call, roomUi } = active;
  const t = useTranslations('MeetingSession.float');
  const tRec = useTranslations('MeetingRoom.recording');
  const recordingHere = useSyncExternalStore(
    roomUi.subscribe,
    () => roomUi.getSnapshot().recorder?.state === 'recording',
    () => false
  );
  const win = useFloatingWindow({
    storageKey: 'meetings:float',
    defaultAnchor: ANCHOR,
    label: t('move'),
    roleDescription: t('draggable'),
    avoid: callWindowRect,
  });
  const { minimized, mobile, handleProps } = win;
  const {
    self,
    ids,
    focus,
    people,
    view,
    setView,
    openRoom,
    openChat,
    unread,
  } = useFloatView(active);
  const popout = useSyncExternalStore(
    roomUi.subscribe,
    () => roomUi.getSnapshot().popout,
    () => null
  );
  const poppedOut = !!popout?.active;

  const [size, setSize] = useState(loadSize);
  const [box, setBox] = useState(size);
  const [now, setNow] = useState(() => Date.now());
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

  const { activeSpeakerId, setTileSizes } = call;
  // The phone bar shows no video either: it pulls like the pill.
  const collapsed = minimized || mobile;
  // The pill stands in for the window, and the pop-out reports instead.
  const reports = tileReporter(false, poppedOut) === 'float';
  const stageHeight = box.height - CHROME_HEIGHT;
  const mainCameraId = focus.kind === 'camera' ? focus.mainId : null;
  useEffect(() => {
    if (!reports) return;
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
  }, [reports, ids, self, mainCameraId, stageHeight, collapsed, setTileSizes]);

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
      if (!(e.target as Element).closest('button, a, [data-no-drag]'))
        openRoom();
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
    <FloatButton label={t('return')} onClick={openRoom}>
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
      style={collapsed || poppedOut ? undefined : size}
      className={cn(
        'bg-card text-foreground border-border group fixed z-40 flex flex-col rounded-2xl border shadow-2xl select-none',
        mobile && 'inset-x-2 bottom-2 flex-row items-center gap-2 p-2',
        !mobile &&
          (minimized || poppedOut) &&
          'h-11 w-80 flex-row items-center gap-2 px-3'
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
      ) : poppedOut ? (
        <>
          <div
            {...handleProps}
            data-meeting-popout-pill
            className="flex h-full min-w-0 flex-1 items-center gap-2 text-sm"
          >
            {liveDot}
            <span className="min-w-0 flex-1 truncate">{t('poppedOut')}</span>
            <span className="text-muted-foreground text-xs tabular-nums">
              {elapsed}
            </span>
          </div>
          <button
            type="button"
            onClick={popout?.close}
            className="hover:bg-accent shrink-0 rounded-full px-2.5 py-1 text-xs font-medium"
          >
            {t('bringBack')}
          </button>
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
            className="flex h-9 shrink-0 items-center gap-2 pe-1.5 ps-3 text-sm"
          >
            {liveDot}
            <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
            {recordingHere && (
              <span
                data-float-rec
                className="text-destructive text-xs font-semibold"
              >
                {tRec('mark')}
              </span>
            )}
            <span className="text-muted-foreground text-xs tabular-nums">
              {elapsed}
            </span>
            {popout?.supported && (
              <button
                type="button"
                title={t('popOut')}
                aria-label={t('popOut')}
                onClick={popout.open}
                className="hover:bg-accent grid size-7 place-items-center rounded-full"
              >
                <PictureInPicture2 className="size-3.5" />
              </button>
            )}
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
              onClick={openRoom}
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
                'focus-visible:bg-ring/60 absolute z-20 flex size-6 items-center justify-center outline-none focus-visible:rounded-md',
                CORNERS[corner]
              )}
            >
              <span className="group-hover:bg-foreground/30 size-1.5 rounded-full" />
            </span>
          ))}
          {(Object.keys(EDGES) as FloatCorner[]).map((edge) => (
            <span
              key={edge}
              aria-hidden
              {...gripProps(edge)}
              style={{ touchAction: 'none' }}
              className={cn('absolute z-10', EDGES[edge])}
            />
          ))}
        </>
      )}
    </div>
  );
}
