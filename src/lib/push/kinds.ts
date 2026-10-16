/**
 * Push kinds — the keys of push_preferences.kinds (migration 109). A
 * kind maps to false to switch it off; a missing key means on.
 *
 * whatsapp_message and chat_message come from the inbound pipeline and
 * the team-chat trigger; the rest are the bell types (notifications.type,
 * 106's CHECK) that push. The four chat_* bell types are left out: their
 * message already pushes once as chat_message. meeting_reminder and
 * event_reminder are the calendar's reminders. 'test' (POST
 * /api/push/test) is not a preference: it cannot be switched off.
 */
export const PUSH_KINDS = [
  'whatsapp_message',
  'chat_message',
  'conversation_assigned',
  'ai_handoff',
  'task_assigned',
  'task_due',
  'call_missed',
  'callback_requested',
  'call_outcome_due',
  'deal_room_join_request',
  'deal_room_update',
  'channel_disconnected',
  'channel_reconnected',
  'pbx_connection_silent',
  'pbx_connection_restored',
  'team_activity_alert',
  'meeting_invite',
  'meeting_reminder',
  'event_reminder',
  'group_join_request',
] as const;

export type PushKind = (typeof PUSH_KINDS)[number];

export function isPushKind(value: string): value is PushKind {
  return (PUSH_KINDS as readonly string[]).includes(value);
}

/** Time-critical: sent during quiet hours too. */
export const QUIET_HOURS_EXEMPT: readonly string[] = [
  'meeting_reminder',
  'event_reminder',
];

const URGENT: readonly string[] = [
  'whatsapp_message',
  'chat_message',
  'meeting_reminder',
  'event_reminder',
];

/** Seconds the push service keeps an undelivered push. */
export function ttlFor(kind: string): number {
  return kind === 'whatsapp_message' || kind === 'chat_message'
    ? 86_400
    : 259_200;
}

export function urgencyFor(kind: string): 'high' | 'normal' {
  return URGENT.includes(kind) ? 'high' : 'normal';
}
