'use client';

import {
  MessageSquare,
  NotebookPen,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';

import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/hooks/use-auth';
import type { MeetingCall } from '@/hooks/use-meeting-call';
import { unreadCount } from '@/lib/meetings/room-ui/chat';
import { clampPanelWidth } from '@/lib/meetings/room-ui/keys';
import {
  dragPanelWidth,
  latestChatAt,
  nextPanel,
  PANEL_KEY_STEP,
  peopleCount,
  PHONE_MEDIA_QUERY,
} from '@/lib/meetings/room-ui/panels';
import type { RoomPanel, RoomUi } from '@/lib/meetings/session/room-ui';

import type { LiveRoomProps } from './meeting-room';
import { RoomChatPanel } from './room-chat-panel';
import { RoomNotesPanel, useNotesAvailable } from './room-notes-panel';
import { RoomPeoplePanel } from './room-people-panel';
import { RoomSettingsDialog } from './room-settings-dialog';
import { useJoinLeaveSounds } from './use-join-leave-sounds';

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
  | 'notesOn'
  | 'onOpenPanel'
  | 'onTogglePanel'
  | 'onOpenSettings'
  | 'sidePanel'
>;

/**
 * The live room's panels and settings dialog. Which panel is open lives
 * in `roomUi`, so it is still open on the way back from another page;
 * this hands the room its seams through `children`.
 */
export function RoomPanels({
  call,
  roomUi,
  children,
}: {
  call: MeetingCall;
  roomUi: RoomUi;
  children: (seams: RoomPanelSeams) => ReactNode;
}) {
  const t = useTranslations('MeetingRoom.panels');
  const { user } = useAuth();
  const phone = useIsPhone();
  const ui = useSyncExternalStore(
    roomUi.subscribe,
    roomUi.getSnapshot,
    roomUi.getSnapshot
  );
  const { panel, panelWidth: width, chatSeenAt: seenAt } = ui;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sounds, setSounds] = useJoinLeaveSounds();

  // Everything is read while the chat is open. An effect: the store has
  // other subscribers, and they may not be told during this render.
  const latest = latestChatAt(call.chat);
  useEffect(() => {
    if (panel === 'chat') roomUi.setChatSeenAt(latest);
  }, [panel, latest, roomUi]);
  const chatUnread =
    panel === 'chat' ? 0 : unreadCount(call.chat, seenAt, user?.id ?? null);

  const onOpenPanel = useCallback(
    (p: RoomPanel) => roomUi.setPanel(p),
    [roomUi]
  );
  const onOpenSettings = useCallback(() => setSettingsOpen(true), []);
  const close = useCallback(() => roomUi.setPanel(null), [roomUi]);

  const meetingId = call.meeting?.id ?? null;
  const notesAvailable = useNotesAvailable(meetingId);
  const notesOn = notesAvailable !== false && meetingId !== null;
  const onTogglePanel = useCallback(
    (s: RoomPanel | 'closePanel') => {
      if (s === 'notes' && !notesOn) return;
      roomUi.setPanel(nextPanel(roomUi.getSnapshot().panel, s));
    },
    [roomUi, notesOn]
  );

  const title =
    panel === 'chat'
      ? t('chat.title')
      : panel === 'notes'
        ? t('notes.title')
        : t('people.title');
  const body =
    panel === 'chat' ? (
      <RoomChatPanel
        call={call}
        onClose={close}
        autoFocus={!phone}
        seenAt={seenAt}
      />
    ) : panel === 'people' ? (
      <RoomPeoplePanel call={call} />
    ) : panel === 'notes' && notesOn ? (
      <RoomNotesPanel meetingId={meetingId} onClose={close} />
    ) : null;

  const tabs: PanelTab[] = [
    {
      id: 'people',
      label: t('tabs.people'),
      Icon: Users,
      count: peopleCount(call.participants, call.participantId),
    },
    {
      id: 'chat',
      label: t('tabs.chat'),
      Icon: MessageSquare,
      unread: chatUnread,
    },
    ...(notesOn
      ? [
          {
            id: 'notes' as const,
            label: t('tabs.notes'),
            Icon: NotebookPen,
          },
        ]
      : []),
  ];
  const card = panel && (
    <PanelCard
      tabs={tabs}
      active={panel}
      onSelect={onOpenPanel}
      onClose={close}
    >
      {body}
    </PanelCard>
  );

  let sidePanel: ReactNode = null;
  if (body && phone) {
    sidePanel = (
      <Sheet open onOpenChange={(open) => !open && close()}>
        <SheetContent
          data-mode="dark"
          side="bottom"
          showCloseButton={false}
          className="h-[80dvh] gap-0 rounded-t-2xl"
        >
          <SheetTitle className="sr-only">{title}</SheetTitle>
          {card}
        </SheetContent>
      </Sheet>
    );
  } else if (body) {
    sidePanel = (
      <aside
        className="bg-card text-card-foreground animate-in fade-in relative mb-2 flex shrink-0 flex-col overflow-hidden rounded-2xl duration-150 motion-reduce:animate-none"
        style={{ width }}
        aria-label={title}
      >
        <ResizeHandle width={width} onWidth={roomUi.setPanelWidth} />
        {card}
      </aside>
    );
  }

  return (
    <>
      {children({
        chatUnread,
        notesOn,
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

interface PanelTab {
  id: RoomPanel;
  label: string;
  Icon: LucideIcon;
  /** A plain figure beside the label. */
  count?: number;
  /** A badge, shown only above zero. */
  unread?: number;
}

/** The tab strip and the open panel, in the column or the phone sheet. */
function PanelCard({
  tabs,
  active,
  onSelect,
  onClose,
  children,
}: {
  tabs: readonly PanelTab[];
  active: RoomPanel;
  onSelect: (panel: RoomPanel) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const t = useTranslations('MeetingRoom.panels');
  return (
    <Tabs
      value={active}
      onValueChange={(v) => onSelect(v as RoomPanel)}
      className="min-h-0 flex-1 gap-0"
    >
      <div className="flex items-center gap-2 p-2">
        <TabsList className="min-w-0 flex-1">
          {tabs.map(({ id, label, Icon, count, unread = 0 }) => (
            <TabsTrigger
              key={id}
              value={id}
              aria-label={
                unread > 0 ? t('tabs.unread', { label, count: unread }) : label
              }
            >
              <Icon aria-hidden />
              <span className="truncate">{label}</span>
              {count !== undefined && (
                <span className="text-muted-foreground text-xs tabular-nums">
                  {count}
                </span>
              )}
              {unread > 0 && (
                <span className="bg-primary text-primary-foreground rounded-full px-1.5 text-xs font-medium tabular-nums">
                  {unread}
                </span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
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
      <TabsContent value={active} className="flex min-h-0 flex-col">
        {children}
      </TabsContent>
    </Tabs>
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
