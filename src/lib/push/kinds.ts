/**
 * Push kinds — the keys of push_preferences.kinds (migration 109). A
 * kind maps to false to switch it off; a missing key means on.
 *
 * whatsapp_message and chat_message come from the inbound pipeline and
 * the team-chat trigger; the rest are the bell types (notifications.type,
 * 106's CHECK) that push. The four chat_* bell types are left out: their
 * message already pushes once as chat_message (chat_note_mention, a
 * note in a customer chat (241), is not one of them: its bell pushes).
 * meeting_reminder and
 * event_reminder are the calendar's reminders. 'test' (POST
 * /api/push/test) is not a preference: it cannot be switched off.
 */
export const PUSH_KINDS = [
  'whatsapp_message',
  'chat_message',
  'conversation_assigned',
  'conversation_shared',
  'work_handed_over',
  'insight_attention',
  // Response times (237): waiting past the target / twice it / unassigned.
  'response_target_missed',
  'response_escalated',
  'response_unassigned',
  'chat_note_mention',
  'ai_handoff',
  'task_assigned',
  'task_due',
  'call_missed',
  'callback_requested',
  'call_outcome_due',
  'deal_room_join_request',
  'deal_room_update',
  'deal_room_message',
  'channel_disconnected',
  'channel_reconnected',
  'inbound_message_failed',
  'meta_number_alert',
  'pbx_connection_silent',
  'pbx_connection_restored',
  'team_activity_alert',
  'team_activity_unlock_request',
  'team_activity_unlock_decided',
  'meeting_invite',
  'meeting_reminder',
  'event_reminder',
  'group_join_request',
  'submission_group_message',
] as const;

export type PushKind = (typeof PUSH_KINDS)[number];

export function isPushKind(value: string): value is PushKind {
  return (PUSH_KINDS as readonly string[]).includes(value);
}

/**
 * Time-critical: sent during quiet hours too. task_due is deliberately
 * not here: PBX missed-call tasks ring it as well, and must not wake
 * people at night.
 */
export const QUIET_HOURS_EXEMPT: readonly string[] = [
  'meeting_reminder',
  'event_reminder',
];

const URGENT: readonly string[] = [
  'whatsapp_message',
  'submission_group_message',
  'deal_room_message',
  'chat_message',
  'meeting_reminder',
  'event_reminder',
  // The reminder alarm (migration 197): the task falling due.
  'task_due',
];

/**
 * Alarms are worth nothing late: a device that was off for longer must
 * not ring for a meeting that is over.
 */
const ALARM_TTL: readonly string[] = [
  'meeting_reminder',
  'event_reminder',
  'task_due',
];

/** Seconds the push service keeps an undelivered push. */
export function ttlFor(kind: string): number {
  if (ALARM_TTL.includes(kind)) return 1_800;
  return kind === 'whatsapp_message' ||
    kind === 'submission_group_message' ||
    kind === 'deal_room_message' ||
    kind === 'chat_message'
    ? 86_400
    : 259_200;
}

export function urgencyFor(kind: string): 'high' | 'normal' {
  return URGENT.includes(kind) ? 'high' : 'normal';
}
