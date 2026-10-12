/**
 * Settings → Team chat: the owner/admin tools around 087's audited
 * private read and the owner-only erasure. The RPCs enforce every rule;
 * these keep the form honest before it asks.
 */
import type { ChannelKind } from './types';

/** chat_admin_read_private / chat_erase_person want at least 5 characters. */
export const MIN_REASON_CHARS = 5;

export function reasonOk(reason: string): boolean {
  return [...reason.trim()].length >= MIN_REASON_CHARS;
}

/** The typed confirmation matches the word, ignoring case and outer spaces. */
export function confirmationMatches(typed: string, word: string): boolean {
  return (
    !!word && typed.trim().toLocaleUpperCase() === word.toLocaleUpperCase()
  );
}

export interface AdminReadableChannel {
  id: string;
  kind: Extract<ChannelKind, 'private' | 'dm' | 'deal_room'>;
  name: string | null;
  memberIds: string[];
  archived: boolean;
}

const READABLE = new Set(['private', 'dm', 'deal_room']);

/**
 * chat_channels rows with their member ids embedded
 * (`members:chat_channel_members(user_id)`) → the private channels,
 * DMs and deal rooms `viewerId` is NOT a member of, by kind then name.
 */
export function privateChannelsNotIn(
  rows: readonly Record<string, unknown>[],
  viewerId: string
): AdminReadableChannel[] {
  const me = viewerId.toLowerCase();
  const rank = { private: 0, deal_room: 1, dm: 2 } as const;
  return rows
    .filter((r) => READABLE.has(String(r.kind)))
    .map((r) => ({
      id: String(r.id),
      kind: r.kind as AdminReadableChannel['kind'],
      name: r.name == null ? null : String(r.name),
      memberIds: (Array.isArray(r.members) ? r.members : [])
        .map((m) => String((m as Record<string, unknown>)?.user_id ?? ''))
        .filter(Boolean),
      archived: r.archived_at != null,
    }))
    .filter((c) => !c.memberIds.some((id) => id.toLowerCase() === me))
    .sort(
      (a, b) =>
        rank[a.kind] - rank[b.kind] ||
        (a.name ?? '').localeCompare(b.name ?? '')
    );
}

/** `list` in slices of at most `size` (storage removes take a bounded batch). */
export function chunked<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += Math.max(1, size))
    out.push(list.slice(i, i + Math.max(1, size)));
  return out;
}
