// ============================================================
// Chat tags in Flows: the pure half of the "Set chat tag" node
// (node type `set_tag`, kept from the contact-tag era because
// `flow_nodes_node_type_check` names it) and the `chat_tag`
// condition subject. Shared by the engine (server) and save-time
// validation (client and server), so it does no I/O.
//
// Stored flows can still carry the contact-tag shapes from before
// chat tags: a `set_tag` config of `{ mode, tag_id }` and a condition
// subject of `"tag"`. Neither may crash a run — the engine logs and
// carries on — and validation names them so the builder shows what to
// fix.
// ============================================================

import type { ChatTagsWrite } from '@/lib/chat-tags/server';
import type { ChatTagsPatch } from '@/types';

/** What a `set_tag` node's stored config asks the engine to do. */
export type SetChatTagPlan =
  /**
   * Write these tags onto the chat (a null main tag clears it). No
   * sub-tag named leaves `chat_sub_tag_id` undefined: the writer keeps
   * the chat's sub-tag if the main tag is unchanged (`ChatTagsWrite`).
   */
  | { kind: 'write'; next: ChatTagsWrite }
  /** A contact-tag config (`mode` / `tag_id`) from before chat tags. */
  | { kind: 'legacy' }
  /** No choice made yet — not even "No tag". */
  | { kind: 'unset' };

/**
 * Read a `set_tag` config. `chat_tag_id` decides: a tag id writes that
 * main tag, `null` clears both. With a tag id, a sub-tag id sets the
 * sub-tag, an explicit `null` clears it, and no sub-tag (absent or
 * empty) keeps the chat's own while the main tag is unchanged — so
 * "Set chat tag: Interested" does not drop a chat's bank. A config
 * without `chat_tag_id` is legacy when it carries the contact-tag keys
 * and unset otherwise; the engine does nothing for either.
 */
export function planSetChatTag(
  config: Record<string, unknown>
): SetChatTagPlan {
  const main = config.chat_tag_id;
  if (main === null) {
    return {
      kind: 'write',
      next: { chat_tag_id: null, chat_sub_tag_id: null },
    };
  }
  if (typeof main === 'string' && main !== '') {
    const sub = config.chat_sub_tag_id;
    if (sub === null) {
      return {
        kind: 'write',
        next: { chat_tag_id: main, chat_sub_tag_id: null },
      };
    }
    if (typeof sub === 'string' && sub !== '') {
      return {
        kind: 'write',
        next: { chat_tag_id: main, chat_sub_tag_id: sub },
      };
    }
    return { kind: 'write', next: { chat_tag_id: main } };
  }
  if ('tag_id' in config || 'mode' in config) return { kind: 'legacy' };
  return { kind: 'unset' };
}

/**
 * A `chat_tag` condition's test: the chat's main tag or its sub-tag is
 * `tagId`. So a condition on a main tag matches whatever the sub-tag,
 * and one on a sub-tag matches only that sub-tag — the inbox filter's
 * rule (`matchesChatTagFilter`).
 */
export function chatHasChatTag(
  chat: ChatTagsPatch | null,
  tagId: string
): boolean {
  if (!chat || !tagId) return false;
  return chat.chat_tag_id === tagId || chat.chat_sub_tag_id === tagId;
}
