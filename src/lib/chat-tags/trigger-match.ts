// ============================================================
// Does a chat tag change fire a `chat_tag_set` automation?
//
// A trigger fires when the chat ARRIVES at the configured tag, never
// merely because it is there: re-saving the same tags, or changing
// something the trigger doesn't name, fires nothing.
//
// * Main tag only (no `chat_sub_tag_id` in the config): fires when the
//   main tag changes to the configured one. Picking a sub-tag under a
//   main tag the chat already carries is not arriving at the main tag.
// * Main + sub-tag: fires when the chat's main and sub-tag both equal
//   the configured pair and either of them changed.
//
// Pure, so the engine and its tests share one definition.
// ============================================================

import type { ChatTagTriggerConfig, ChatTagsPatch } from '@/types';

export function chatTagTriggerMatches(
  cfg: ChatTagTriggerConfig,
  ev: { previous: ChatTagsPatch; current: ChatTagsPatch }
): boolean {
  const { previous, current } = ev;
  if (!cfg.chat_tag_id || current.chat_tag_id !== cfg.chat_tag_id) {
    return false;
  }
  const mainChanged = previous.chat_tag_id !== current.chat_tag_id;
  if (!cfg.chat_sub_tag_id) return mainChanged;
  if (current.chat_sub_tag_id !== cfg.chat_sub_tag_id) return false;
  return mainChanged || previous.chat_sub_tag_id !== current.chat_sub_tag_id;
}
