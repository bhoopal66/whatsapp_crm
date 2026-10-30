/**
 * Seen-by receipts (156) from members' read marks. Shown only where the
 * list is small enough to mean something.
 */
import type { ChannelKind } from './types';

export const RECEIPTS_MAX_MEMBERS = 20;

export function seenBy(i: {
  createdAt: string;
  authorId: string | null;
  members: readonly { userId: string; lastReadAt: string | null }[];
}): { seen: string[]; unseen: string[] } {
  const at = Date.parse(i.createdAt);
  const seen: string[] = [];
  const unseen: string[] = [];
  for (const m of i.members) {
    if (m.userId === i.authorId) continue;
    const read = m.lastReadAt === null ? NaN : Date.parse(m.lastReadAt);
    (read >= at ? seen : unseen).push(m.userId);
  }
  return { seen, unseen };
}

export function showsReceipts(kind: ChannelKind, memberCount: number): boolean {
  if (kind === 'dm') return true;
  if (kind === 'team' || kind === 'private')
    return memberCount <= RECEIPTS_MAX_MEMBERS;
  return false;
}
