'use client';

import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  useCallback,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';

import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useAuth } from '@/hooks/use-auth';
import type { MeetingCall } from '@/hooks/use-meeting-call';
import { unreadCount } from '@/lib/meetings/room-ui/chat';
import { clampPanelWidth } from '@/lib/meetings/room-ui/keys';
import {
  dragPanelWidth,
  latestChatAt,
  nextPanel,
  PANEL_DEFAULT_WIDTH,
  PANEL_KEY_STEP,
  PHONE_MEDIA_QUERY,
} from '@/lib/meetings/room-ui/panels';

import type { LiveRoomProps, RoomPanel } from './meeting-room';
import { RoomChatPanel } from './room-chat-panel';
import { RoomPeoplePanel } from './room-people-panel';
import { RoomSettingsDialog, useJoinLeaveSounds } from './room-settings-dialog';
import { useRoomNotices } from './use-room-notices';

const subscribePhone = (onChange: () => void) => {
  const mq = window.matchMedia(PHONE_MEDIA_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
};

/** Phones (≤640 px) get the panel as a bottom sheet. */
export function useIsPhone(): boolean {
  return useSyncExternalStore(
    subscribePhone,
    () => window.matchMedia(PHONE_MEDIA_QUERY).matches,
    () => false
  );
}

export type RoomPanelSeams = Pick<
  LiveRoomProps,
  | 'chatUnread'
  | 'onOpenPanel'
  | 'onTogglePanel'
  | 'onOpenSettings'
  | 'sidePanel'
>;

/**
 * The live room's panels, settings dialog and notice toasts. It owns
 * which panel is open and hands the room its seams through `children`.
 */
export function RoomPanels({
  call,
  children,
}: {
  call: MeetingCall;
  children: (seams: RoomPanelSeams) => ReactNode;
}) {
  const t = useTranslations('MeetingRoom.panels');
  const { user } = useAuth();
  const phone = useIsPhone();
  const [panel, setPanel] = useState<RoomPanel | null>(null);
  const [width, setWidth] = useState(PANEL_DEFAULT_WIDTH);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sounds, setSounds] = useJoinLeaveSounds();
  useRoomNotices(call, sounds, call.selectedDevices.audiooutput);

  // Everything is read while the chat is open. State adjusted during
  // render, not a ref (refs may not be read while rendering).
  const [seenAt, setSeenAt] = useState<string | null>(null);
  const latest = latestChatAt(call.chat);
  if (panel === 'chat' && latest !== seenAt) setSeenAt(latest);
  const chatUnread =
    panel === 'chat' ? 0 : unreadCount(call.chat, seenAt, user?.id ?? null);

  const onOpenPanel = useCallback((p: RoomPanel) => setPanel(p), []);
  const onTogglePanel = useCallback(
    (s: RoomPanel | 'closePanel') => setPanel((p) => nextPanel(p, s)),
    []
  );
  const onOpenSettings = useCallback(() => setSettingsOpen(true), []);
  const close = useCallback(() => setPanel(null), []);

  const title = panel === 'chat' ? t('chat.title') : t('people.title');
  const body =
    panel === 'chat' ? (
      <RoomChatPanel call={call} onClose={close} autoFocus={!phone} />
    ) : panel === 'people' ? (
      <RoomPeoplePanel call={call} />
    ) : null;

  let sidePanel: ReactNode = null;
  if (body && phone) {
    sidePanel = (
      <Sheet open onOpenChange={(open) => !open && close()}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="h-[80dvh] gap-0"
        >
          <PanelHeader
            title={<SheetTitle>{title}</SheetTitle>}
            onClose={close}
          />
          {body}
        </SheetContent>
      </Sheet>
    );
  } else if (body) {
    sidePanel = (
      <aside
        className="bg-card text-card-foreground relative mb-2 flex shrink-0 flex-col overflow-hidden rounded-lg"
        style={{ width }}
        aria-label={title}
      >
        <ResizeHandle width={width} onWidth={setWidth} />
        <PanelHeader
          title={<h2 className="text-base font-medium">{title}</h2>}
          onClose={close}
        />
        {body}
      </aside>
    );
  }

  return (
    <>
      {children({
        chatUnread,
        onOpenPanel,
        onTogglePanel,
        onOpenSettings,
        sidePanel,
      })}
      <RoomSettingsDialog
        call={call}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        sounds={sounds}
        onSounds={setSounds}
      />
    </>
  );
}

function PanelHeader({
  title,
  onClose,
}: {
  title: ReactNode;
  onClose: () => void;
}) {
  const t = useTranslations('MeetingRoom.panels');
  return (
    <div className="flex items-center gap-2 py-2 pr-2 pl-4">
      <div className="min-w-0 flex-1 truncate">{title}</div>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        onClick={onClose}
        aria-label={t('close')}
        title={t('close')}
      >
        <X />
      </Button>
    </div>
  );
}

/** The panel's left edge: drag it, or focus it and use the arrow keys. */
function ResizeHandle({
  width,
  onWidth,
}: {
  width: number;
  onWidth: (w: number) => void;
}) {
  const t = useTranslations('MeetingRoom.panels');
  const drag = useRef<{ x: number; width: number } | null>(null);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, width };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d) onWidth(dragPanelWidth(d.width, d.x, e.clientX));
  };
  const onPointerEnd = () => {
    drag.current = null;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir = e.key === 'ArrowLeft' ? 1 : e.key === 'ArrowRight' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    onWidth(clampPanelWidth(width + dir * PANEL_KEY_STEP));
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('resize')}
      aria-valuenow={width}
      aria-valuemin={clampPanelWidth(0)}
      aria-valuemax={clampPanelWidth(Infinity)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onKeyDown={onKeyDown}
      className="hover:bg-primary/40 focus-visible:bg-primary/60 absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize touch-none outline-none"
    />
  );
}
