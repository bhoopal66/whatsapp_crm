import type { Message } from '@/types';

/**
 * Who sent a message in a WhatsApp thread: the name on every bubble, on
 * a quote of it and in the media viewer.
 *
 * Read from the row alone:
 *  - `customer`: `sender_type = 'customer'`, the contact.
 *  - `person`: `sender_type = 'agent'` with a `sender_id`, the member
 *    `send-message.ts` recorded as the sender. `name` is null when the
 *    workspace has no member with that id any more.
 *  - `pending`: a person whose name has not loaded yet. The bubble keeps
 *    the line blank, so nothing moves when the name arrives.
 *  - `ai`: the AI auto-reply (`ai_generated`, migration 033).
 *  - `bot`: any other `sender_type = 'bot'` row: a Flow, an automation,
 *    the journey bot.
 *  - `team`: `sender_type = 'agent'` with no `sender_id`. The public API
 *    and the Compass notifications send without a person, and replies
 *    from before sends recorded one have none either, so this names
 *    nobody rather than guess. Team activity counts the same rows as
 *    automatic (migration 068).
 */
export type MessageSender =
  | { kind: 'customer'; name: string }
  | { kind: 'person'; name: string | null; isMe: boolean }
  | { kind: 'pending' }
  | { kind: 'ai' }
  | { kind: 'bot' }
  | { kind: 'team' };

export type MessageSenderKind = MessageSender['kind'];

export interface SenderContext {
  /** The contact's name, else their phone. */
  contactName: string;
  /** The signed-in user. */
  currentUserId: string | null;
  /** user_id → display name, from {@link memberNames}. */
  names: ReadonlyMap<string, string>;
  /** False until the member list has loaded: a missing id is then
   *  `pending`, not a former member. */
  namesLoaded: boolean;
}

export function messageSender(
  message: Pick<Message, 'id' | 'sender_type' | 'sender_id' | 'ai_generated'>,
  ctx: SenderContext
): MessageSender {
  if (message.sender_type === 'customer') {
    return { kind: 'customer', name: ctx.contactName };
  }
  if (message.sender_type === 'bot') {
    return message.ai_generated ? { kind: 'ai' } : { kind: 'bot' };
  }
  // The composer's optimistic bubble (a `temp-` id, also kept for a
  // failed send) is this user's own and has no row, so no sender_id.
  const userId =
    message.sender_id ||
    (message.id.startsWith('temp-') ? ctx.currentUserId : null);
  if (!userId) return { kind: 'team' };
  const name = ctx.names.get(userId);
  if (name === undefined && !ctx.namesLoaded) return { kind: 'pending' };
  return {
    kind: 'person',
    name: name ?? null,
    isMe: userId === ctx.currentUserId,
  };
}

interface MemberName {
  user_id: string;
  full_name?: string | null;
  email?: string | null;
}

/**
 * The names {@link messageSender} looks up: each member's full name,
 * else their email, as the thread header names them.
 */
export function memberNames(
  members: readonly MemberName[]
): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of members) {
    const name = m.full_name?.trim() || m.email?.trim();
    if (m.user_id && name) names.set(m.user_id, name);
  }
  return names;
}
