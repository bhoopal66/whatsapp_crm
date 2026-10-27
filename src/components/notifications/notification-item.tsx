'use client';

import { useRef, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  AtSign,
  Bell,
  AlarmClock,
  BellRing,
  Bot,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  CalendarX,
  CheckCheck,
  DoorOpen,
  ExternalLink,
  Handshake,
  UsersRound,
  ListTodo,
  Megaphone,
  MessageCircle,
  MessagesSquare,
  PhoneMissed,
  PhoneOff,
  ClipboardPen,
  PhoneCall,
  PhoneOutgoing,
  Share2,
  ShieldAlert,
  UserPlus,
  Video,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

import { useAuth } from '@/hooks/use-auth';
import type { Notification } from '@/types';
import {
  useContextMenuItems,
  type ContextMenuEntry,
} from '@/components/context-menu/registry';
import { notificationRow } from '@/lib/notifications/target';
import { cn } from '@/lib/utils';
import { useNotifications } from './notifications-provider';

// Icon per notification type — a one-line add per new type.
const TYPE_ICON: Record<Notification['type'], typeof Bell> = {
  conversation_assigned: UserPlus,
  conversation_shared: Share2,
  channel_disconnected: WifiOff,
  channel_reconnected: Wifi,
  team_activity_alert: ShieldAlert,
  ai_handoff: Bot,
  task_assigned: ListTodo,
  task_due: CalendarClock,
  chat_mention: AtSign,
  chat_dm: MessageCircle,
  chat_thread_reply: MessagesSquare,
  chat_broadcast: Megaphone,
  call_missed: PhoneMissed,
  callback_requested: PhoneOutgoing,
  call_outcome_due: ClipboardPen,
  pbx_connection_silent: PhoneOff,
  pbx_connection_restored: PhoneCall,
  deal_room_join_request: DoorOpen,
  deal_room_update: Handshake,
  group_join_request: UsersRound,
  meeting_invite: Video,
  calendar_invite: CalendarDays,
  calendar_update: CalendarClock,
  calendar_cancelled: CalendarX,
  calendar_response: CalendarCheck,
  event_reminder: BellRing,
  meeting_reminder: AlarmClock,
};

// A channel alert's body is the fix (who re-pairs which phone, where),
// so it is shown whole rather than cut to one line like an assignment.
const FULL_BODY: ReadonlySet<Notification['type']> = new Set([
  'channel_disconnected',
  'channel_reconnected',
  'team_activity_alert',
  'pbx_connection_silent',
  'pbx_connection_restored',
]);

/** A list item whose right-click menu leads with `getItems`. */
function MenuRow({
  getItems,
  children,
}: {
  getItems: () => ContextMenuEntry[];
  children: ReactNode;
}) {
  const ref = useRef<HTMLLIElement>(null);
  useContextMenuItems(ref, getItems);
  return <li ref={ref}>{children}</li>;
}

/**
 * One bell row, for the top bar's dropdown (`compact`) and the
 * /notifications page alike: its click marks it read and opens its
 * screen (switching workspace when it is another one's), then calls
 * `onOpened`, which the dropdown uses to close itself.
 */
export function NotificationItem({
  notification: n,
  compact = false,
  onOpened,
}: {
  notification: Notification;
  compact?: boolean;
  onOpened?: () => void;
}) {
  const t = useTranslations('Notifications');
  const tBell = useTranslations('Workspaces.bell');
  const tMenu = useTranslations('ContextMenu');
  const { accountRole, activeWorkspaceId, workspaces } = useAuth();
  const { openNotification, markRead } = useNotifications();

  const Icon = TYPE_ICON[n.type] ?? Bell;
  const isUnread = !n.read_at;
  const plan = notificationRow(n, {
    activeWorkspaceId,
    activeRole: accountRole,
    workspaces,
  });
  const workspaceName = plan.otherWorkspace
    ? (plan.otherWorkspace.name ?? tBell('unknown'))
    : null;
  const open = () => {
    void openNotification(n, plan);
    onOpened?.();
  };
  // The row's own click, and Mark as read while it is unread.
  const menuItems = (): ContextMenuEntry[] => [
    {
      id: 'open',
      label: tMenu('schedule.open'),
      icon: ExternalLink,
      onSelect: open,
    },
    ...(isUnread
      ? [
          {
            id: 'markRead',
            label: tMenu('chat.markRead'),
            icon: CheckCheck,
            onSelect: () => void markRead(n.id),
          },
        ]
      : []),
  ];

  return (
    <MenuRow getItems={menuItems}>
      <button
        type="button"
        onClick={open}
        className={cn(
          'focus-visible:ring-ring flex w-full items-start text-left transition-colors focus-visible:ring-2 focus-visible:outline-none',
          compact
            ? cn(
                'gap-2.5 rounded-lg px-2.5 py-2',
                isUnread
                  ? 'bg-primary-soft hover:bg-primary-soft-2'
                  : 'hover:bg-accent'
              )
            : cn(
                'gap-3 rounded-xl border p-4',
                isUnread
                  ? 'border-primary/40 border-l-primary bg-primary-soft hover:bg-primary-soft-2 border-l-4'
                  : 'border-border bg-card hover:bg-accent'
              )
        )}
      >
        <div
          className={cn(
            'flex flex-shrink-0 items-center justify-center rounded-lg',
            compact ? 'h-8 w-8' : 'h-10 w-10',
            isUnread ? 'bg-primary-soft-2' : 'bg-muted'
          )}
          aria-hidden
        >
          <Icon
            className={cn(
              compact ? 'h-4 w-4' : 'h-5 w-5',
              isUnread ? 'text-primary' : 'text-muted-foreground'
            )}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'truncate text-sm font-semibold',
                isUnread ? 'text-foreground' : 'text-muted-foreground'
              )}
            >
              {n.title}
            </span>
            {workspaceName && (
              <span
                title={tBell('switchHint', { name: workspaceName })}
                className={cn(
                  'border-border bg-muted text-muted-foreground flex-shrink-0 truncate rounded-md border px-1.5 py-0.5 text-[10px] font-medium',
                  compact ? 'max-w-28' : 'max-w-40'
                )}
              >
                {workspaceName}
              </span>
            )}
            {isUnread && (
              <span
                aria-label={t('unread')}
                className="bg-primary ml-auto h-2 w-2 flex-shrink-0 rounded-full"
              />
            )}
          </div>
          {n.body && (
            <p
              className={cn(
                'text-muted-foreground mt-0.5 text-xs',
                FULL_BODY.has(n.type)
                  ? 'whitespace-normal'
                  : compact
                    ? 'line-clamp-2'
                    : 'truncate'
              )}
            >
              {n.body}
            </p>
          )}
          <p className="text-muted-foreground/70 mt-1 text-[11px]">
            {formatDistanceToNow(new Date(n.created_at), {
              addSuffix: true,
            })}
          </p>
        </div>
      </button>
    </MenuRow>
  );
}
