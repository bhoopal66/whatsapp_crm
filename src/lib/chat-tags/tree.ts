import type { ChatTag, Conversation } from '@/types';

/**
 * Chat tags (migration 075) as the screens use them: a flat list of
 * rows folded into main tags with their sub-tags, a chat's two ids
 * resolved against that tree, and the list filter in both its
 * client-side and PostgREST forms.
 *
 * Everything here tolerates stale data. A chat may still carry the id
 * of a tag another admin deleted a moment ago, or a sub-tag that a
 * concurrent write moved — those resolve to nothing rather than throw,
 * because the database (which nulls the ids) is the authority and the
 * screen only has to catch up.
 */

export interface ChatTagNode extends ChatTag {
  subs: ChatTag[];
}

export interface ChatTagTree {
  /** Main tags in display order, each with its sub-tags in display order. */
  mains: ChatTagNode[];
  /**
   * Every row by id, including any left out of `mains`/`subs`. A main
   * tag's entry is its {@link ChatTagNode}.
   */
  byId: Map<string, ChatTag>;
}

function time(ts: string): number | null {
  const n = Date.parse(ts);
  return Number.isNaN(n) ? null : n;
}

/** Display order: position, then created_at, then name, then id. */
function compareChatTags(a: ChatTag, b: ChatTag): number {
  if (a.position !== b.position) return a.position - b.position;
  const ta = time(a.created_at);
  const tb = time(b.created_at);
  if (ta !== null && tb !== null) {
    if (ta !== tb) return ta - tb;
  } else if (a.created_at !== b.created_at) {
    return a.created_at < b.created_at ? -1 : 1;
  }
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) return byName;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Fold the account's rows into main tags and their sub-tags. A sub-tag
 * whose parent is missing, or whose parent is itself a sub-tag, has no
 * place in a one-level tree: it stays in `byId` but out of the lists.
 */
export function buildChatTagTree(tags: readonly ChatTag[]): ChatTagTree {
  const byId = new Map<string, ChatTag>();
  const mainsById = new Map<string, ChatTagNode>();
  for (const tag of tags) {
    if (tag.parent_id === null) {
      const node: ChatTagNode = { ...tag, subs: [] };
      mainsById.set(tag.id, node);
      byId.set(tag.id, node);
    } else {
      byId.set(tag.id, tag);
    }
  }
  for (const tag of tags) {
    if (tag.parent_id === null) continue;
    mainsById.get(tag.parent_id)?.subs.push(tag);
  }
  const mains = [...mainsById.values()].sort(compareChatTags);
  for (const main of mains) main.subs.sort(compareChatTags);
  return { mains, byId };
}

/**
 * The tags a chat shows. `main` only when the id is a known main tag;
 * `sub` only when it is a known tag whose parent is that main tag — a
 * sub-tag without its main tag, or under another one, shows nothing.
 */
export function resolveConversationChatTags(
  conv: Pick<Conversation, 'chat_tag_id' | 'chat_sub_tag_id'>,
  tree: ChatTagTree
): { main: ChatTagNode | null; sub: ChatTag | null } {
  const main = conv.chat_tag_id
    ? (tree.mains.find((m) => m.id === conv.chat_tag_id) ?? null)
    : null;
  if (!main || !conv.chat_sub_tag_id) return { main, sub: null };
  const sub = tree.byId.get(conv.chat_sub_tag_id);
  return { main, sub: sub && sub.parent_id === main.id ? sub : null };
}

/** `"Interested customer · ADCB"`, `"New customer"`, or null. */
export function chatTagLabel(
  main: ChatTag | null,
  sub: ChatTag | null
): string | null {
  if (!main) return null;
  return sub ? `${main.name} · ${sub.name}` : main.name;
}

/**
 * The list filter, client-side. An empty selection matches every chat.
 * Otherwise a chat matches when its main tag or its sub-tag is
 * selected: picking a main tag shows all its chats whatever the
 * sub-tag, picking a sub-tag narrows to that sub-tag.
 */
export function matchesChatTagFilter(
  conv: Pick<Conversation, 'chat_tag_id' | 'chat_sub_tag_id'>,
  selectedIds: readonly string[]
): boolean {
  if (selectedIds.length === 0) return true;
  return (
    (!!conv.chat_tag_id && selectedIds.includes(conv.chat_tag_id)) ||
    (!!conv.chat_sub_tag_id && selectedIds.includes(conv.chat_sub_tag_id))
  );
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Server-side form of {@link matchesChatTagFilter}: the `or` group
 * (without the outer parentheses) for the inbox list query, to be
 * passed to `combineOrGroups`. Null when there is nothing to filter on.
 *
 * The ids are interpolated into an `or=` query parameter, so anything
 * that is not a UUID is dropped first — a stray `,` or `)` would
 * otherwise rewrite the filter. A selection with no UUID left is
 * treated as empty.
 */
export function chatTagFilterOrGroup(
  selectedIds: readonly string[]
): string | null {
  const ids = [...new Set(selectedIds.filter((id) => UUID_RE.test(id)))];
  if (ids.length === 0) return null;
  const list = ids.join(',');
  return `chat_tag_id.in.(${list}),chat_sub_tag_id.in.(${list})`;
}
