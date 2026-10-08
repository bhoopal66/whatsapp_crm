import type { ChatTagTree } from '@/lib/chat-tags/tree';

/**
 * The chat tags a broadcast audience picked, less any that are gone.
 *
 * The wizard keeps the picked ids in its audience config, and a tag
 * another admin deletes meanwhile stays there: the picker no longer
 * draws it, so it cannot be unticked, it keeps Next enabled, and as
 * the only pick it resolves to nobody. So the ids are read through the
 * tree the picker draws — main tags and the sub-tags under them, as the
 * Contacts filter does — before they are validated, counted or sent.
 *
 * Until the tags have loaded (`loaded` false) nothing is known to be
 * gone, so the ids pass through. The same array comes back when
 * nothing was dropped, so a caller's memo or effect keyed on it does
 * not fire again for an unchanged selection.
 */
export function liveChatTagIds(
  ids: string[] | undefined,
  tree: ChatTagTree,
  loaded: boolean
): string[] | undefined {
  if (!ids || !loaded) return ids;
  const known = new Set<string>();
  for (const main of tree.mains) {
    known.add(main.id);
    for (const sub of main.subs) known.add(sub.id);
  }
  const live = ids.filter((id) => known.has(id));
  return live.length === ids.length ? ids : live;
}
