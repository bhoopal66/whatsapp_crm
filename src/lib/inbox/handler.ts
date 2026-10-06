import type { Conversation, Message } from '@/types';

/**
 * Who is holding a conversation, and on what evidence.
 *
 *  - `assigned` — somebody is in `assigned_agent_id`. The only answer
 *    the database itself treats as authoritative (migrations 042/044:
 *    assignment is what grants visibility).
 *  - `replying`  — nobody is assigned, but a human agent has answered
 *    in the thread (`messages.sender_id`). This is the common shape of
 *    an inbound chat that an admin picked up without ever assigning it
 *    to themselves.
 *  - `owner` — nobody is assigned and nobody has replied yet, so the
 *    only name available is the row's `user_id`. On a chat an agent
 *    started that is the agent; on an inbound chat it is whoever
 *    connected the WhatsApp channel (`inbound-pipeline.ts` stamps it),
 *    which is why the UI labels this case differently instead of
 *    passing it off as the handler.
 */
export type ConversationHandlerKind = 'assigned' | 'replying' | 'owner';

export interface ConversationHandler {
  userId: string;
  kind: ConversationHandlerKind;
}

/**
 * Resolve the agent to show in the thread header.
 *
 * Pure so it can be unit-tested without a DOM or a database; the
 * caller passes the rows it has already loaded. Returns `null` when
 * there is genuinely nobody to name — an unassigned, never-answered
 * chat with no resolvable owner.
 *
 * `messages` is scanned newest-first for the last human send:
 * `sender_type === 'agent'` with a `sender_id`. Bot sends (Flows,
 * automations, AI auto-reply) carry `sender_type === 'bot'` and are
 * never a person; agent rows written before sends started recording
 * `sender_id` have none, and fall through to the owner.
 */
export function resolveConversationHandler(
  conversation: Pick<Conversation, 'user_id'> & {
    assigned_agent_id?: string | null;
  },
  messages: Pick<Message, 'sender_type' | 'sender_id'>[]
): ConversationHandler | null {
  const assigned = conversation.assigned_agent_id ?? null;
  if (assigned) return { userId: assigned, kind: 'assigned' };

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.sender_type === 'agent' && msg.sender_id) {
      return { userId: msg.sender_id, kind: 'replying' };
    }
  }

  return conversation.user_id
    ? { userId: conversation.user_id, kind: 'owner' }
    : null;
}

/**
 * The handler of a conversation the caller has no messages for — the
 * Inbox list, which loads conversation rows only.
 *
 * Same rule as {@link resolveConversationHandler} minus its middle
 * step: assignee, then the row owner. Never `replying`, because that
 * evidence lives in the thread.
 */
export function resolveListHandler(
  conversation: Pick<Conversation, 'user_id'> & {
    assigned_agent_id?: string | null;
  }
): ConversationHandler | null {
  return resolveConversationHandler(conversation, []);
}
