/**
 * Which screen a bell row opens. One case per type in 085's
 * `notifications_type_check` (the latest list), each reading what that
 * type's writer stores:
 *
 * - `conversation_assigned` (027 trigger) and `ai_handoff`
 *   (`lib/ai/auto-reply.ts`): `conversation_id` → the chat.
 * - `task_assigned` (085 trigger) and the reserved `task_due`: the
 *   task's `contact_id` / `conversation_id` columns, no meta. The
 *   customer page lists a contact's tasks; tasks have no screen of
 *   their own, so one without a contact falls back to the chat, then
 *   to /calls (the one other screen that lists tasks, missed-call ones).
 * - `call_missed` (`lib/pbx/process.ts`) and the reserved
 *   `callback_requested`: `contact_id` → the customer page, which shows
 *   the call and its call-back task; an unknown caller → /calls, whose
 *   default tab is Missed calls.
 * - `deal_room_join_request` / `deal_room_update`
 *   (`lib/deal-rooms/webhook.ts`, `shared.ts`): `meta.room_id` → the room.
 * - `channel_disconnected` / `channel_reconnected`
 *   (`lib/whatsapp/channel-health.ts`): the WhatsApp settings tab, for
 *   those who can edit settings.
 * - `team_activity_alert` (the SQL alert sweep): Team activity, for
 *   leaders and up (`TeamLeaderOnlyLayout`); the person over the limit
 *   has the whole message in the row already.
 * - Team chat (087): `chatNotificationHref`.
 *
 * `role` is the reader's role in the row's workspace, which is not the
 * active one for a row from another workspace. A bank guest is only
 * ever sent to team chat, as the dashboard shell would keep them there.
 * Anything malformed, or a type this build does not know, opens nothing.
 * Pure, so every type is tested without a database or a DOM.
 */
import {
  canEditSettings,
  canLeadTeam,
  isBankGuest,
  type AccountRole,
} from '@/lib/auth/roles';
import { isGuestPath } from '@/lib/auth/my-workspaces';
import { chatNotificationHref } from '@/lib/chat/notification-link';
import { isUuid } from '@/lib/chat/mentions';

/** The columns of a `notifications` row this reads. */
export interface NotificationTargetRow {
  type: unknown;
  conversation_id?: unknown;
  contact_id?: unknown;
  meta?: unknown;
}

const chat = (id: unknown) => (isUuid(id) ? `/inbox?c=${id}` : null);
const customer = (id: unknown) => (isUuid(id) ? `/contacts/${id}` : null);

function metaField(meta: unknown, key: string): unknown {
  return meta && typeof meta === 'object' && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)[key]
    : undefined;
}

function hrefFor(
  n: NotificationTargetRow,
  role: AccountRole | null | undefined
): string | null {
  switch (n.type) {
    case 'conversation_assigned':
    case 'ai_handoff':
      return chat(n.conversation_id);
    case 'task_assigned':
    case 'task_due':
      return customer(n.contact_id) ?? chat(n.conversation_id) ?? '/calls';
    case 'call_missed':
    case 'callback_requested':
      return (
        customer(n.contact_id ?? metaField(n.meta, 'contact_id')) ?? '/calls'
      );
    case 'deal_room_join_request':
    case 'deal_room_update': {
      const room = metaField(n.meta, 'room_id');
      return isUuid(room) ? `/chat/rooms/${room}` : null;
    }
    case 'channel_disconnected':
    case 'channel_reconnected':
      return role && canEditSettings(role) ? '/settings?tab=whatsapp' : null;
    case 'team_activity_alert':
      return role && canLeadTeam(role) ? '/team-activity' : null;
    case 'chat_mention':
    case 'chat_dm':
    case 'chat_thread_reply':
    case 'chat_broadcast':
      return chatNotificationHref(n.type, n.meta);
    default:
      return null;
  }
}

/** The in-app path a click on `n` opens, or null to open nothing. */
export function notificationTarget(
  n: NotificationTargetRow,
  role: AccountRole | null | undefined
): string | null {
  const href = hrefFor(n, role);
  if (!href) return null;
  if (isBankGuest(role) && !isGuestPath(href.split('?')[0])) return null;
  return href;
}
