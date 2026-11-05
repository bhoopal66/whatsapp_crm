'use client';

import {
  ChevronUp,
  Ellipsis,
  EyeOff,
  Hand,
  Keyboard,
  Maximize,
  MessageSquare,
  Mic,
  MicOff,
  Minimize,
  MonitorUp,
  MonitorX,
  PhoneOff,
  PictureInPicture2,
  Settings,
  Smile,
  Users,
  Video,
  VideoOff,
  Circle,
} from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { MeetingCall } from '@/hooks/use-meeting-call';
import {
  MEETING_REACTIONS,
  type MeetingReactionEvent,
} from '@/lib/meetings/room/contract';
import {
  canFullscreen,
  canPictureInPicture,
  dockMode,
  handsRaised,
  reactionMotion,
  releasePointerFocus,
  returnFocusOnClose,
  unreadBadge,
  type DockMode,
} from '@/lib/meetings/room-ui/controls';
import { SHORTCUT_KEYS } from '@/lib/meetings/room-ui/keys';
import { reactionOffset } from '@/lib/meetings/room-ui/people';
import type { LayoutMode } from '@/lib/meetings/room-ui/stage';
import { recordEntry } from '@/lib/meetings/recording/plan';
import type { RecorderView, RoomPanel } from '@/lib/meetings/session/room-ui';
import { cn } from '@/lib/utils';

import { ConfirmDialog } from './confirm-dialog';
import { DeviceMenu } from './device-menu';
import { MoreDropdownItems, MoreSheet, type MoreItem } from './dock-more';

const MOTION =
  'transition-colors duration-150 ease-out motion-reduce:transition-none';
const BTN = cn(
  'size-11 rounded-xl bg-card-2 text-foreground hover:bg-muted dark:hover:bg-muted [&_svg:not([class*=size-])]:size-5',
  MOTION
);
// The dark: hover pairs beat the ghost variant's own, the room being dark.
const OFF =
  'bg-destructive text-white hover:bg-destructive/85 hover:text-white aria-expanded:bg-destructive aria-expanded:text-white dark:hover:bg-destructive/85';
const ON =
  'bg-primary text-primary-foreground hover:bg-primary-hover hover:text-primary-foreground aria-expanded:bg-primary aria-expanded:text-primary-foreground dark:hover:bg-primary-hover';
/** The left half of a split button; its caret is the right half. */
const SPLIT = 'rounded-r-none';

/** Whether something is fullscreen, and whether this page can be. */
export function useFullscreen() {
  const active = useSyncExternalStore(
    (cb) => {
      document.addEventListener('fullscreenchange', cb);
      return () => document.removeEventListener('fullscreenchange', cb);
    },
    () => !!document.fullscreenElement,
    () => false
  );
  const supported = useSyncExternalStore(
    () => () => {},
    () => canFullscreen(document),
    () => false
  );
  return { active, supported };
}

/** Whether a video is in picture-in-picture, and whether it can be. */
export function usePictureInPicture() {
  const active = useSyncExternalStore(
    (cb) => {
      // The events fire on the <video>; capture catches every one.
      document.addEventListener('enterpictureinpicture', cb, true);
      document.addEventListener('leavepictureinpicture', cb, true);
      return () => {
        document.removeEventListener('enterpictureinpicture', cb, true);
        document.removeEventListener('leavepictureinpicture', cb, true);
      };
    },
    () => !!document.pictureInPictureElement,
    () => false
  );
  const supported = useSyncExternalStore(
    () => () => {},
    () => canPictureInPicture(document),
    () => false
  );
  return { active, supported };
}

/** An icon button with a tooltip naming it (and its shortcut). */
function BarButton({
  label,
  shortcut,
  className,
  children,
  ...props
}: ComponentProps<typeof Button> & { label: string; shortcut?: string }) {
  const t = useTranslations('MeetingRoom.controlBar');
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={label}
            className={cn(BTN, className)}
            {...props}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent data-mode="dark">
        {shortcut ? t('withShortcut', { label, key: shortcut }) : label}
      </TooltipContent>
    </Tooltip>
  );
}

/** A dock control, with its caption under it when the dock has room. */
function DockCell({
  caption,
  children,
}: {
  /** null: no caption, but the same height, so a row of cells lines up. */
  caption?: string | null;
  children: ReactNode;
}) {
  if (caption === undefined) return children;
  return (
    <div className="flex flex-col items-center gap-1">
      {children}
      <span
        aria-hidden
        className="text-muted-foreground h-3.5 text-[11px] leading-3.5 whitespace-nowrap"
      >
        {caption}
      </span>
    </div>
  );
}

/** The time on this computer, moving on with each minute. */
function LocalClock() {
  const t = useTranslations('MeetingRoom.controlBar');
  const format = useFormatter();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let id: ReturnType<typeof setTimeout>;
    const next = () => {
      id = setTimeout(
        () => {
          setNow(new Date());
          next();
        },
        60_000 - (Date.now() % 60_000)
      );
    };
    next();
    return () => clearTimeout(id);
  }, []);
  return (
    <span className="tabular-nums" aria-label={t('clock')}>
      {format.dateTime(now, { hour: 'numeric', minute: '2-digit' })}
    </span>
  );
}

export interface ControlBarProps {
  call: MeetingCall;
  layout: LayoutMode;
  onLayout: (mode: LayoutMode) => void;
  hideSelf: boolean;
  onHideSelf: (hide: boolean) => void;
  chatUnread: number;
  /** The open side panel: its button reads as on, and closes it. */
  panel: RoomPanel | null;
  onTogglePanel: (panel: RoomPanel) => void;
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
  onFullscreen: () => void;
  /** Offered only when the browser supports it and a tile qualifies. */
  pip: { supported: boolean; active: boolean; available: boolean };
  onPip: () => void;
  /** The layer's recorder; absent until it has mounted. */
  recorder?: RecorderView | null;
}

type MoreLabels = (key: string, values?: { emoji: string }) => string;

/**
 * The More menu. In the compact dock it also takes what no longer fits
 * on the bar.
 */
export function moreItems(
  p: ControlBarProps,
  o: {
    t: MoreLabels;
    compact: boolean;
    fullscreen: { supported: boolean; active: boolean };
    recordLabels?: { start: string; stop: string; taken: string };
  }
): MoreItem[] {
  const { t, fullscreen } = o;
  const { call, pip } = p;
  const items: MoreItem[] = [];
  if (o.compact) {
    items.push(
      {
        kind: 'reactions',
        id: 'reactions',
        emojis: MEETING_REACTIONS.map((emoji) => ({
          emoji,
          label: t('react', { emoji }),
        })),
        onReact: (emoji) => void call.sendReaction(emoji as never),
      },
      {
        kind: 'action',
        id: 'share',
        label: call.sharing ? t('stopShare') : t('share'),
        icon: call.sharing ? <MonitorX /> : <MonitorUp />,
        pressed: call.sharing,
        onClick: () => void call.toggleScreen(),
      },
      {
        kind: 'action',
        id: 'hand',
        label: call.handRaised ? t('lowerHand') : t('raiseHand'),
        icon: <Hand />,
        pressed: call.handRaised,
        onClick: () => void call.toggleHand(),
      },
      { kind: 'separator', id: 'compact-end' }
    );
  }
  items.push(
    {
      kind: 'radio',
      id: 'layout',
      label: t('layout'),
      value: p.layout,
      options: [
        { value: 'auto', label: t('layoutGallery') },
        { value: 'speaker', label: t('layoutSpeaker') },
        { value: 'focus', label: t('layoutFocus') },
      ],
      onChange: (v) => p.onLayout(v as LayoutMode),
    },
    { kind: 'separator', id: 'layout-end' },
    {
      kind: 'toggle',
      id: 'hideSelf',
      label: t('hideSelf'),
      icon: <EyeOff />,
      checked: p.hideSelf,
      onChange: p.onHideSelf,
    }
  );
  if (fullscreen.supported) {
    items.push({
      kind: 'action',
      id: 'fullscreen',
      label: fullscreen.active ? t('exitFullscreen') : t('fullscreen'),
      icon: fullscreen.active ? <Minimize /> : <Maximize />,
      shortcut: SHORTCUT_KEYS.fullscreen,
      onClick: p.onFullscreen,
    });
  }
  if (pip.supported) {
    items.push({
      kind: 'action',
      id: 'pip',
      label: pip.active ? t('exitPip') : t('pip'),
      icon: <PictureInPicture2 />,
      disabled: !pip.available && !pip.active,
      onClick: p.onPip,
    });
  }
  const { recorder } = p;
  const entry =
    recorder && o.recordLabels
      ? recordEntry({
          canModerate: call.canModerate,
          state: recorder.state,
          recordingBy: call.recording?.userId ?? null,
          // Anyone but us: the recorder is the one that names us.
          selfId: recorder.holderName ? null : (call.recording?.userId ?? null),
        })
      : null;
  if (recorder && o.recordLabels && entry) {
    const stops = entry === 'stop';
    items.push({
      kind: 'action',
      id: 'record',
      label: stops
        ? o.recordLabels.stop
        : entry === 'taken'
          ? o.recordLabels.taken
          : o.recordLabels.start,
      icon: <Circle />,
      pressed: stops,
      disabled: entry === 'taken' || entry === 'stopping',
      onClick: stops ? recorder.stop : recorder.request,
    });
  }
  items.push(
    {
      kind: 'action',
      id: 'settings',
      label: t('settings'),
      icon: <Settings />,
      onClick: p.onOpenSettings,
    },
    {
      kind: 'action',
      id: 'shortcuts',
      label: t('shortcuts'),
      icon: <Keyboard />,
      shortcut: SHORTCUT_KEYS.shortcuts,
      onClick: p.onOpenShortcuts,
    }
  );
  return items;
}

/** The in-call controls, in the form the room's measured width allows. */
export function ControlBar(props: ControlBarProps) {
  const [mode, setMode] = useState<DockMode>('full');
  const ref = useRef<HTMLDivElement>(null);
  // A layout effect: the observer's first report lands before the paint,
  // so a phone never flashes the full dock.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() =>
      setMode(dockMode(el.getBoundingClientRect().width))
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className="min-w-0">
      <Dock {...props} mode={mode} />
    </div>
  );
}

export function Dock({ mode, ...p }: ControlBarProps & { mode: DockMode }) {
  const t = useTranslations('MeetingRoom.controlBar');
  const { call } = p;
  const full = mode === 'full';
  const compact = mode === 'compact';
  const fullscreen = useFullscreen();
  const [sheet, setSheet] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const badge = unreadBadge(p.chatUnread);
  const hands = handsRaised(
    call.participants,
    call.participantId,
    call.handRaised
  );
  const tRec = useTranslations('MeetingRoom.recording');
  const holderName = p.recorder?.holderName;
  const more = moreItems(p, {
    t: t as MoreLabels,
    compact,
    fullscreen,
    recordLabels: {
      start: tRec('record'),
      stop: tRec('stop'),
      taken: holderName
        ? tRec('taken', { name: holderName })
        : tRec('takenNoName'),
    },
  });
  /** A caption, in the one form that shows them. */
  const caption = (text: string | null) => (full ? text : undefined);

  const end = async () => {
    if (!(await call.end())) toast.error(t('endFailed'));
  };

  const mic = (
    <BarButton
      label={call.micOn ? t('mute') : t('unmute')}
      shortcut={SHORTCUT_KEYS.mic}
      className={cn(!call.micOn && OFF, !compact && SPLIT)}
      onClick={() => void call.toggleMic()}
    >
      {call.micOn ? <Mic /> : <MicOff />}
    </BarButton>
  );
  const camera = (
    <BarButton
      label={call.cameraOn ? t('cameraOff') : t('cameraOn')}
      shortcut={SHORTCUT_KEYS.camera}
      className={cn(!call.cameraOn && OFF, !compact && SPLIT)}
      onClick={() => void call.toggleCamera()}
    >
      {call.cameraOn ? <Video /> : <VideoOff />}
    </BarButton>
  );
  const moreButton = compact ? (
    <BarButton label={t('more')} onClick={() => setSheet(true)}>
      <Ellipsis />
    </BarButton>
  ) : (
    <DropdownMenu>
      <DropdownMenuTrigger render={<BarButton label={t('more')} />}>
        <Ellipsis />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        data-mode="dark"
        side="top"
        align="center"
        sideOffset={8}
        className="w-60 rounded-xl"
        finalFocus={returnFocusOnClose}
      >
        <MoreDropdownItems items={more} />
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div
      role="toolbar"
      aria-label={t('bar')}
      className="flex min-h-[72px] items-center gap-2 px-3 py-1"
      onClick={releasePointerFocus}
    >
      {/* Empty in the narrower forms, and still there: the two side
          groups share what is left, which is what centres the middle
          one for as long as the right group's content allows. */}
      <div className="text-muted-foreground flex min-w-0 flex-1 basis-0 items-center gap-3 text-sm">
        {full && (
          <>
            <LocalClock />
            {hands > 0 && (
              <span className="text-foreground flex items-center gap-1.5 truncate">
                <Hand className="size-4 shrink-0" aria-hidden />
                {t('handsRaised', { count: hands })}
              </span>
            )}
          </>
        )}
      </div>

      <div className="flex shrink-0 items-start gap-2">
        <DockCell caption={caption(call.micOn ? t('mute') : t('unmute'))}>
          <span className="flex">
            {mic}
            {!compact && <DeviceMenu call={call} kind="audio" />}
          </span>
        </DockCell>
        <DockCell caption={caption(t('labelCamera'))}>
          <span className="flex">
            {camera}
            {!compact && <DeviceMenu call={call} kind="video" />}
          </span>
        </DockCell>
        {!compact && (
          <>
            <DockCell
              caption={caption(
                call.sharing ? t('labelStopShare') : t('labelShare')
              )}
            >
              <BarButton
                label={call.sharing ? t('stopShare') : t('share')}
                shortcut={SHORTCUT_KEYS.share}
                className={cn(call.sharing && ON)}
                aria-pressed={call.sharing}
                onClick={() => void call.toggleScreen()}
              >
                {call.sharing ? <MonitorX /> : <MonitorUp />}
              </BarButton>
            </DockCell>
            <DockCell caption={caption(t('labelReact'))}>
              <Popover>
                <PopoverTrigger render={<BarButton label={t('reactions')} />}>
                  <Smile />
                </PopoverTrigger>
                <PopoverContent
                  data-mode="dark"
                  side="top"
                  sideOffset={8}
                  className="w-auto flex-row gap-1 rounded-xl p-1.5"
                  finalFocus={returnFocusOnClose}
                >
                  {MEETING_REACTIONS.map((emoji) => (
                    <Button
                      key={emoji}
                      type="button"
                      variant="ghost"
                      size="icon-lg"
                      className="rounded-lg text-xl"
                      aria-label={t('react', { emoji })}
                      onClick={() => void call.sendReaction(emoji)}
                    >
                      {emoji}
                    </Button>
                  ))}
                </PopoverContent>
              </Popover>
            </DockCell>
            <DockCell
              caption={caption(
                call.handRaised ? t('labelLower') : t('labelRaise')
              )}
            >
              <BarButton
                label={call.handRaised ? t('lowerHand') : t('raiseHand')}
                shortcut={SHORTCUT_KEYS.hand}
                className={cn(call.handRaised && ON)}
                aria-pressed={call.handRaised}
                onClick={() => void call.toggleHand()}
              >
                <Hand />
              </BarButton>
            </DockCell>
          </>
        )}
        <DockCell caption={caption(t('labelMore'))}>{moreButton}</DockCell>
      </div>

      <div className="flex flex-1 basis-0 items-start justify-end gap-2">
        <DockCell caption={caption(t('chat'))}>
          <BarButton
            label={badge ? t('chatUnread', { count: p.chatUnread }) : t('chat')}
            shortcut={SHORTCUT_KEYS.chat}
            className={cn('relative', p.panel === 'chat' && ON)}
            aria-pressed={p.panel === 'chat'}
            onClick={() => p.onTogglePanel('chat')}
          >
            <MessageSquare />
            {badge && (
              <span
                aria-hidden
                className="bg-destructive absolute -top-1 -right-1 min-w-5 rounded-full px-1 text-center text-[10px] leading-5 font-semibold text-white"
              >
                {badge}
              </span>
            )}
          </BarButton>
        </DockCell>
        <DockCell caption={caption(t('people'))}>
          <BarButton
            label={t('people')}
            shortcut={SHORTCUT_KEYS.people}
            className={cn(p.panel === 'people' && ON)}
            aria-pressed={p.panel === 'people'}
            onClick={() => p.onTogglePanel('people')}
          >
            <Users />
          </BarButton>
        </DockCell>
        <DockCell caption={caption(null)}>
          <span className="flex">
            <Button
              type="button"
              variant="ghost"
              className={cn(
                'h-11 rounded-xl [&_svg:not([class*=size-])]:size-5',
                compact ? 'w-11 px-0' : 'gap-2 px-4',
                OFF,
                MOTION,
                call.canModerate && SPLIT
              )}
              onClick={() => void call.leave()}
              aria-label={t('leave')}
            >
              <PhoneOff />
              {!compact && t('leave')}
            </Button>
            {call.canModerate && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      aria-label={t('leaveOptions')}
                      title={t('leaveOptions')}
                      className={cn(
                        'h-11 w-6 rounded-l-none rounded-r-xl border-l border-white/20 px-0',
                        OFF,
                        MOTION
                      )}
                    />
                  }
                >
                  <ChevronUp />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  data-mode="dark"
                  side="top"
                  align="end"
                  sideOffset={8}
                  className="w-52 rounded-xl"
                  finalFocus={returnFocusOnClose}
                >
                  <DropdownMenuItem onClick={() => void call.leave()}>
                    <PhoneOff />
                    {t('leaveMeeting')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setConfirmEnd(true)}
                  >
                    <PhoneOff />
                    {t('endForEveryone')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </span>
        </DockCell>
      </div>

      {compact && (
        <MoreSheet
          open={sheet}
          onOpenChange={setSheet}
          title={t('more')}
          items={more}
        />
      )}
      <ConfirmDialog
        open={confirmEnd}
        onOpenChange={setConfirmEnd}
        title={t('endConfirm')}
        description={t('endBody')}
        confirmLabel={t('endForEveryone')}
        destructive
        onConfirm={() => void end()}
      />
    </div>
  );
}

/** Reactions rising over the stage; the engine drops each after a few s. */
export function FloatingReactions({
  reactions,
  nameOf,
}: {
  reactions: readonly MeetingReactionEvent[];
  nameOf: (userId: string) => string;
}) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {reactions.map((r) => (
        <FloatingReaction key={r.id} reaction={r} name={nameOf(r.userId)} />
      ))}
    </div>
  );
}

function FloatingReaction({
  reaction,
  name,
}: {
  reaction: MeetingReactionEvent;
  name: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el?.animate) return;
    const reduced = window.matchMedia(
      '(prefers-reduced-motion: reduce)'
    ).matches;
    const { keyframes, options } = reactionMotion(reaction.id, reduced);
    const anim = el.animate(keyframes, options);
    return () => anim.cancel();
  }, [reaction.id]);
  return (
    <div
      ref={ref}
      className="absolute bottom-4 flex -translate-x-1/2 flex-col items-center opacity-0"
      style={{ left: `${reactionOffset(reaction.id)}%` }}
    >
      <span className="text-4xl">{reaction.emoji}</span>
      <span className="max-w-32 truncate rounded bg-black/60 px-1.5 text-xs text-white">
        {name}
      </span>
    </div>
  );
}
