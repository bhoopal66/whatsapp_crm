// ============================================================
// Which contacts the inbox asks for profile pictures (migration 070).
//
// The inbox posts every loaded contact once per session to
// /api/whatsapp/contacts/avatars — including ones that already have a
// picture, because the server's weekly throttle is what refreshes a
// changed one, and a not-yet-due contact costs it one cheap select.
// Pure, so the batching rules are testable without a DOM.
// ============================================================

import type { Conversation } from '@/types';

/** Matches the route's per-request cap. */
export const AVATAR_REQUEST_BATCH = 50;

/**
 * The contact ids not yet requested, deduplicated and split into
 * batches of `size`. Does not mark them requested; the caller does,
 * when it actually sends.
 */
export function avatarRequestBatches(
  contactIds: Iterable<string | null | undefined>,
  requested: ReadonlySet<string>,
  size: number = AVATAR_REQUEST_BATCH
): string[][] {
  const fresh: string[] = [];
  const seen = new Set<string>();
  for (const id of contactIds) {
    if (!id || requested.has(id) || seen.has(id)) continue;
    seen.add(id);
    fresh.push(id);
  }
  const batches: string[][] = [];
  for (let i = 0; i < fresh.length; i += size) {
    batches.push(fresh.slice(i, i + size));
  }
  return batches;
}

/**
 * Patch the route's answer into the list. A null clears the picture
 * (the contact removed it). Returns the same array when nothing
 * changed, so a no-op answer costs no re-render.
 */
export function applyAvatars(
  conversations: Conversation[],
  avatars: Record<string, string | null>
): Conversation[] {
  let changed = false;
  const next = conversations.map((c) => {
    const id = c.contact?.id;
    if (!c.contact || !id || !(id in avatars)) return c;
    const url = avatars[id] ?? undefined;
    if (c.contact.avatar_url === url) return c;
    changed = true;
    return { ...c, contact: { ...c.contact, avatar_url: url } };
  });
  return changed ? next : conversations;
}
