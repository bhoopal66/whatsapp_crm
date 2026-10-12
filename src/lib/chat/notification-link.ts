/**
 * The bell rows chat writes (087's chat_notification_to_bell) carry
 * meta = {channel_id, message_id, thread_root_id}; this maps one to the
 * screen it opens. Anything malformed opens nothing.
 */
import { isUuid } from './mentions';

export const CHAT_NOTIFICATION_TYPES = [
  'chat_mention',
  'chat_dm',
  'chat_thread_reply',
  'chat_broadcast',
] as const;

export type ChatBellType = (typeof CHAT_NOTIFICATION_TYPES)[number];

export function isChatNotificationType(type: unknown): type is ChatBellType {
  return (CHAT_NOTIFICATION_TYPES as readonly unknown[]).includes(type);
}

/** `/chat/<channel>`, plus `?thread=<root>` for a thread reply; null for anything else. */
export function chatNotificationHref(
  type: unknown,
  meta: unknown
): string | null {
  if (!isChatNotificationType(type) || !meta || typeof meta !== 'object')
    return null;
  const m = meta as Record<string, unknown>;
  if (!isUuid(m.channel_id)) return null;
  const base = `/chat/${m.channel_id}`;
  return isUuid(m.thread_root_id) ? `${base}?thread=${m.thread_root_id}` : base;
}
