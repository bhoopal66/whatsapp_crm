'use client';

import {
  Ellipsis,
  Hand,
  LayoutGrid,
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
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  useEffect,
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
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
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
  COMPACT_BAR_QUERY,
  reactionMotion,
  unreadBadge,
} from '@/lib/meetings/room-ui/controls';
import { SHORTCUT_KEYS } from '@/lib/meetings/room-ui/keys';
import { reactionOffset } from '@/lib/meetings/room-ui/people';
import type { LayoutMode } from '@/lib/meetings/room-ui/stage';
import { cn } from '@/lib/utils';

import { ConfirmDialog } from './confirm-dialog';
import { DeviceMenu } from './device-menu';
import type { RoomPanel } from './meeting-room';

const BTN = 'size-10 rounded-full bg-white/10 text-white hover:bg-white/20';
const OFF = 'bg-red-600 text-white hover:bg-red-500';
const ON = 'bg-sky-500 text-white hover:bg-sky-400';

/** A media query, read without a hydration mismatch (server: false). */
function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', cb);
      return () => mql.removeEventListener('change', cb);
    },
    () => window.matchMedia(query).matches,
    () => false
  );
}

/** Whether something is fullscreen, and whether this page can be. */
function useFullscreen() {
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
      <TooltipContent>
        {shortcut ? t('withShortcut', { label, key: shortcut }) : label}
      </TooltipContent>
    </Tooltip>
  );
}

export interface ControlBarProps {
  call: MeetingCall;
  layout: LayoutMode;
  onLayout: (mode: LayoutMode) => void;
  chatUnread: number;
  onOpenPanel: (panel: RoomPanel) => void;
  onOpenSettings: () => void;
  /** Offered only when the browser supports it and a tile qualifies. */
  pip: { supported: boolean; active: boolean; available: boolean };
  onPip: () => void;
}

/** The in-call controls; a short bar plus a sheet on a phone. */
export function ControlBar(p: ControlBarProps) {
  const t = useTranslations('MeetingRoom.controlBar');
  const { call } = p;
  const compact = useMediaQuery(COMPACT_BAR_QUERY);
  const fullscreen = useFullscreen();
  const [sheet, setSheet] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const badge = unreadBadge(p.chatUnread);

  const toggleFullscreen = () => {
    const done = document.fullscreenElement
      ? document.exitFullscreen()
      : document.documentElement.requestFullscreen();
    done.catch(() => toast.error(t('fullscreenFailed')));
  };
  const end = async () => {
    if (!(await call.end())) toast.error(t('endFailed'));
  };
  // Run a sheet entry, closing the sheet first.
  const fromSheet = (fn: () => void) => () => {
    setSheet(false);
    fn();
  };

  const mic = (
    <BarButton
      label={call.micOn ? t('mute') : t('unmute')}
      shortcut={SHORTCUT_KEYS.mic}
      className={cn(!call.micOn && OFF)}
      onClick={() => void call.toggleMic()}
    >
      {call.micOn ? <Mic /> : <MicOff />}
    </BarButton>
  );
  const camera = (
    <BarButton
      label={call.cameraOn ? t('cameraOff') : t('cameraOn')}
      shortcut={SHORTCUT_KEYS.camera}
      className={cn(!call.cameraOn && OFF)}
      onClick={() => void call.toggleCamera()}
    >
      {call.cameraOn ? <Video /> : <VideoOff />}
    </BarButton>
  );
  const hand = (
    <BarButton
      label={call.handRaised ? t('lowerHand') : t('raiseHand')}
      shortcut={SHORTCUT_KEYS.hand}
      className={cn(
        call.handRaised && 'bg-amber-400 text-black hover:bg-amber-300'
      )}
      aria-pressed={call.handRaised}
      onClick={() => void call.toggleHand()}
    >
      <Hand />
    </BarButton>
  );
  const reactions = (
    <Popover>
      <PopoverTrigger render={<BarButton label={t('reactions')} />}>
        <Smile />
      </PopoverTrigger>
      <PopoverContent side="top" className="w-auto flex-row gap-1 p-1.5">
        {MEETING_REACTIONS.map((emoji) => (
          <Button
            key={emoji}
            type="button"
            variant="ghost"
            size="icon-lg"
            className="text-xl"
            aria-label={t('react', { emoji })}
            onClick={() => void call.sendReaction(emoji)}
          >
            {emoji}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
  const leave = (
    <Button
      type="button"
      variant="destructive"
      className="h-10 rounded-full bg-red-600 px-4 text-white hover:bg-red-500"
      onClick={() => void call.leave()}
      aria-label={t('leave')}
    >
      <PhoneOff />
      <span className="max-[640px]:sr-only">{t('leave')}</span>
    </Button>
  );
  const endDialog = (
    <ConfirmDialog
      open={confirmEnd}
      onOpenChange={setConfirmEnd}
      title={t('endConfirm')}
      description={t('endBody')}
      confirmLabel={t('endForEveryone')}
      destructive
      onConfirm={() => void end()}
    />
  );

  if (compact) {
    const row = (
      icon: ReactNode,
      label: string,
      onClick: () => void,
      extra?: ReactNode
    ) => (
      <Button
        type="button"
        variant="ghost"
        className="h-11 w-full justify-start gap-3"
        onClick={fromSheet(onClick)}
      >
        {icon}
        <span className="flex-1 text-left">{label}</span>
        {extra}
      </Button>
    );
    return (
      <div
        role="toolbar"
        aria-label={t('bar')}
        className="flex items-center justify-center gap-2 px-3 py-3"
      >
        {mic}
        {camera}
        {hand}
        {reactions}
        <BarButton
          label={t('more')}
          className="relative"
          onClick={() => setSheet(true)}
        >
          <Ellipsis />
          {badge && <Badge>{badge}</Badge>}
        </BarButton>
        {leave}
        <Sheet open={sheet} onOpenChange={setSheet}>
          <SheetContent side="bottom" className="gap-1 pb-4">
            <SheetHeader>
              <SheetTitle>{t('more')}</SheetTitle>
            </SheetHeader>
            <div className="flex flex-col px-2">
              {row(
                <MessageSquare />,
                t('chat'),
                () => p.onOpenPanel('chat'),
                badge && <Badge inline>{badge}</Badge>
              )}
              {row(<Users />, t('people'), () => p.onOpenPanel('people'))}
              {row(
                call.sharing ? <MonitorX /> : <MonitorUp />,
                call.sharing ? t('stopShare') : t('share'),
                () => void call.toggleScreen()
              )}
              {row(
                <LayoutGrid />,
                `${t('layout')}: ${p.layout === 'auto' ? t('layoutAuto') : t('layoutSpeaker')}`,
                () => p.onLayout(p.layout === 'auto' ? 'speaker' : 'auto')
              )}
              {fullscreen.supported &&
                row(
                  fullscreen.active ? <Minimize /> : <Maximize />,
                  fullscreen.active ? t('exitFullscreen') : t('fullscreen'),
                  toggleFullscreen
                )}
              {p.pip.supported &&
                p.pip.available &&
                row(
                  <PictureInPicture2 />,
                  p.pip.active ? t('exitPip') : t('pip'),
                  p.onPip
                )}
              {row(<Settings />, t('settings'), p.onOpenSettings)}
              {call.canModerate &&
                row(
                  <PhoneOff className="text-red-500" />,
                  t('endForEveryone'),
                  () => setConfirmEnd(true)
                )}
            </div>
          </SheetContent>
        </Sheet>
        {endDialog}
      </div>
    );
  }

  return (
    <div
      role="toolbar"
      aria-label={t('bar')}
      className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
    >
      <div className="flex flex-1 basis-0 items-center gap-2" />
      <div className="flex items-center gap-2">
        <span className="flex items-center rounded-full bg-white/5 pr-1">
          {mic}
          <DeviceMenu call={call} kind="audio" />
        </span>
        <span className="flex items-center rounded-full bg-white/5 pr-1">
          {camera}
          <DeviceMenu call={call} kind="video" />
        </span>
        <BarButton
          label={call.sharing ? t('stopShare') : t('share')}
          shortcut={SHORTCUT_KEYS.share}
          className={cn(call.sharing && ON)}
          aria-pressed={call.sharing}
          onClick={() => void call.toggleScreen()}
        >
          {call.sharing ? <MonitorX /> : <MonitorUp />}
        </BarButton>
        {hand}
        {reactions}
        {leave}
        {call.canModerate && (
          <Button
            type="button"
            variant="outline"
            className="h-10 rounded-full border-red-500/60 bg-transparent px-4 text-red-300 hover:bg-red-500/15 hover:text-red-200"
            onClick={() => setConfirmEnd(true)}
          >
            {t('endForEveryone')}
          </Button>
        )}
      </div>
      <div className="flex flex-1 basis-0 items-center justify-end gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger render={<BarButton label={t('layout')} />}>
            <LayoutGrid />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end" className="w-40">
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t('layout')}</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={p.layout}
                onValueChange={(v) => p.onLayout(v as LayoutMode)}
              >
                <DropdownMenuRadioItem value="auto">
                  {t('layoutAuto')}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="speaker">
                  {t('layoutSpeaker')}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {fullscreen.supported && (
          <BarButton
            label={fullscreen.active ? t('exitFullscreen') : t('fullscreen')}
            onClick={toggleFullscreen}
          >
            {fullscreen.active ? <Minimize /> : <Maximize />}
          </BarButton>
        )}
        {p.pip.supported && (
          <BarButton
            label={p.pip.active ? t('exitPip') : t('pip')}
            className={cn(p.pip.active && ON)}
            disabled={!p.pip.available && !p.pip.active}
            onClick={p.onPip}
          >
            <PictureInPicture2 />
          </BarButton>
        )}
        <BarButton
          label={badge ? t('chatUnread', { count: p.chatUnread }) : t('chat')}
          shortcut={SHORTCUT_KEYS.chat}
          className="relative"
          onClick={() => p.onOpenPanel('chat')}
        >
          <MessageSquare />
          {badge && <Badge>{badge}</Badge>}
        </BarButton>
        <BarButton
          label={t('people')}
          shortcut={SHORTCUT_KEYS.people}
          onClick={() => p.onOpenPanel('people')}
        >
          <Users />
        </BarButton>
        <DropdownMenu>
          <DropdownMenuTrigger render={<BarButton label={t('more')} />}>
            <Ellipsis />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end" className="w-44">
            <DropdownMenuItem onClick={p.onOpenSettings}>
              <Settings />
              {t('settings')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {endDialog}
    </div>
  );
}

function Badge({
  children,
  inline,
}: {
  children: ReactNode;
  inline?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'min-w-5 rounded-full bg-red-500 px-1 text-center text-[10px] leading-5 font-semibold text-white',
        !inline && 'absolute -top-1 -right-1'
      )}
    >
      {children}
    </span>
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
