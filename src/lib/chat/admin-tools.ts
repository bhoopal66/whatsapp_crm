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

/** One row of GET /api/chat/admin/private-channels. */
export interface AdminChannelSummary {
  id: string;
  kind: AdminReadableChannel['kind'];
  /** NULL for a DM: label it by `memberNames`. */
  name: string | null;
  /** Unknown people are left out, so this can be shorter than memberCount. */
  memberNames: string[];
  memberCount: number;
  /** The newest message, else when the channel was created. */
  lastActivityAt: string | null;
  archived: boolean;
}

/**
 * privateChannelsNotIn, labelled for the picker. `rows` also embed the
 * newest message (`internal_messages(created_at)`, newest first);
 * `people` are the workspace's profiles, deactivated ones included.
 * DMs, which have no name, sort by their members' names.
 */
export function adminChannelList(
  rows: readonly Record<string, unknown>[],
  viewerId: string,
  people: readonly { user_id: unknown; full_name: unknown }[]
): AdminChannelSummary[] {
  const names = new Map(
    people.map((p) => [String(p.user_id).toLowerCase(), p.full_name])
  );
  const activity = new Map(
    rows.map((r) => {
      const newest = Array.isArray(r.internal_messages)
        ? (r.internal_messages[0] as Record<string, unknown> | undefined)
        : undefined;
      const at = newest?.created_at ?? r.created_at;
      return [String(r.id), at == null ? null : String(at)];
    })
  );
  const list = privateChannelsNotIn(rows, viewerId).map((c) => ({
    id: c.id,
    kind: c.kind,
    name: c.name,
    memberNames: c.memberIds
      .map((id) => names.get(id.toLowerCase()))
      .filter((n): n is string => typeof n === 'string' && n.trim() !== '')
      .sort((a, b) => a.localeCompare(b)),
    memberCount: c.memberIds.length,
    lastActivityAt: activity.get(c.id) ?? null,
    archived: c.archived,
  }));
  const rank = { private: 0, deal_room: 1, dm: 2 } as const;
  const label = (c: AdminChannelSummary) => c.name ?? c.memberNames.join(', ');
  return list.sort(
    (a, b) => rank[a.kind] - rank[b.kind] || label(a).localeCompare(label(b))
  );
}

/**
 * The erased paths that are this workspace's chat files
 * (`account-<ws>/…`, as chatFilePath builds them). The service role
 * deletes them, so nothing outside the workspace may get through.
 */
export function chatFilesOfAccount(
  paths: readonly string[],
  accountId: string
): string[] {
  const prefix = `account-${accountId.toLowerCase()}/`;
  return paths.filter(
    (p) =>
      p.toLowerCase().startsWith(prefix) &&
      !p.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')
  );
}
