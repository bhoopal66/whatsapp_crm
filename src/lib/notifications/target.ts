/**
 * Which screen a bell row opens. One case per type in 108's
 * `notifications_type_check` (the latest list), each reading what that
 * type's writer stores:
 *
 * - `conversation_assigned` (027 trigger) and `ai_handoff`
 *   (`lib/ai/auto-reply.ts`): `conversation_id` → the chat.
 * - `task_assigned` (085 trigger): the task's `contact_id` /
 *   `conversation_id` columns, no meta. The customer page lists a
 *   contact's tasks; tasks have no screen of their own, so one without
 *   a contact falls back to the chat, then to /calls (the one other
 *   screen that lists tasks, missed-call ones).
 * - `task_due` (108's reminder sweep, meta {task_id}): the customer
 *   page, else the calendar, which shows tasks by due date.
 * - `call_missed` (`lib/pbx/process.ts`) and the reserved
 *   `callback_requested`: `contact_id` → the customer page, which shows
 *   the call and its call-back task; an unknown caller → /calls, whose
 *   default tab is Missed calls.
 * - `call_outcome_due` (097's `pbx_outcome_reminders`): the same, the
 *   customer page listing the call whose outcome is owed.
 * - `deal_room_join_request` / `deal_room_update`
 *   (`lib/deal-rooms/webhook.ts`, `shared.ts`): `meta.room_id` → the room.
 * - `channel_disconnected` / `channel_reconnected`
 *   (`lib/whatsapp/channel-health.ts`): the WhatsApp settings tab, for
 *   those who can edit settings.
 * - `pbx_connection_silent` / `pbx_connection_restored` (104's
 *   `pbx_connection_silence`): the Phone system settings tab, the same
 *   way.
 * - `team_activity_alert` (the SQL alert sweep): Team activity, for
 *   leaders and up (`TeamLeaderOnlyLayout`); the person over the limit
 *   has the whole message in the row already.
 * - Team chat (087): `chatNotificationHref`.
 * - `meeting_invite` (106's invitees trigger) and `meeting_reminder`
 *   (108's reminder sweep): `meta.meeting_id` → the meeting's page.
 * - `group_join_request` (the Whapi groups webhook): `meta.group_id` →
 *   the group's requests tab.
 * - `calendar_invite` / `calendar_update` / `calendar_cancelled` /
 *   `calendar_response` (108's triggers) and `event_reminder` (108's
 *   sweep, `calendar_insert_reminder`): `meta.event_id` → the calendar
 *   opened on that event.
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
import { isGuestPath, type Workspace } from '@/lib/auth/my-workspaces';
import { chatNotificationHref } from '@/lib/chat/notification-link';
import { isUuid } from '@/lib/chat/mentions';

/** The columns of a `notifications` row this reads. */
export interface NotificationTargetRow {
  type: unknown;
  account_id?: unknown;
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
      return customer(n.contact_id) ?? chat(n.conversation_id) ?? '/calls';
    case 'task_due':
      return customer(n.contact_id) ?? '/calendar';
    case 'call_missed':
    case 'callback_requested':
    case 'call_outcome_due':
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
    case 'pbx_connection_silent':
    case 'pbx_connection_restored':
      return role && canEditSettings(role)
        ? '/settings?tab=phone-system'
        : null;
    case 'team_activity_alert':
      return role && canLeadTeam(role) ? '/team-activity' : null;
    case 'chat_mention':
    case 'chat_dm':
    case 'chat_thread_reply':
    case 'chat_broadcast':
      return chatNotificationHref(n.type, n.meta);
    case 'calendar_invite':
    case 'calendar_update':
    case 'calendar_cancelled':
    case 'calendar_response':
    case 'event_reminder': {
      const event = metaField(n.meta, 'event_id');
      return isUuid(event) ? `/calendar?event=${event}` : null;
    }
    case 'group_join_request': {
      const group = metaField(n.meta, 'group_id');
      return isUuid(group) ? `/groups/${group}?tab=requests` : null;
    }
    case 'meeting_invite':
    case 'meeting_reminder': {
      const meeting = metaField(n.meta, 'meeting_id');
      return isUuid(meeting) ? `/meetings/${meeting}` : null;
    }
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

/** Where the reader is working, as the bell page knows it. */
export interface BellContext {
  activeWorkspaceId: string | null;
  /** The reader's role in the active workspace. */
  activeRole: AccountRole | null | undefined;
  /** Every workspace the reader belongs to (`my_workspaces()`). */
  workspaces: readonly Pick<
    Workspace,
    'accountId' | 'name' | 'shortName' | 'role'
  >[];
}

/** How the bell page shows and opens one row. */
export interface NotificationRowPlan {
  /** Where a click goes, or null to open nothing (it is still marked read). */
  href: string | null;
  /**
   * Set for a row of another of the reader's workspaces, which the bell
   * lists too (083's `my_live_account_ids()`): the row is labelled with
   * that workspace, and opening it switches there first. `name` is null
   * when the reader's workspace list does not have it (still loading, or
   * joined since the page loaded).
   */
  otherWorkspace: { accountId: string; name: string | null } | null;
}

/**
 * Plan one bell row. Its screen is chosen with the reader's role in the
 * row's OWN workspace: an admin there may be an agent here, and the
 * screen opens there, after the switch. A row is another workspace's
 * only when both ids are known and differ, so a row read before the
 * active workspace is known opens in place, as every row did before.
 */
export function notificationRow(
  n: NotificationTargetRow,
  ctx: BellContext
): NotificationRowPlan {
  const rowAccount =
    typeof n.account_id === 'string' && n.account_id ? n.account_id : null;
  if (
    !rowAccount ||
    !ctx.activeWorkspaceId ||
    rowAccount === ctx.activeWorkspaceId
  ) {
    return {
      href: notificationTarget(n, ctx.activeRole),
      otherWorkspace: null,
    };
  }
  const workspace = ctx.workspaces.find((w) => w.accountId === rowAccount);
  return {
    href: notificationTarget(n, workspace?.role ?? null),
    otherWorkspace: {
      accountId: rowAccount,
      name: workspace ? workspace.name || workspace.shortName || null : null,
    },
  };
}
