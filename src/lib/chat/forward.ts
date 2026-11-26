/**
 * Team chat → "Forward" (156): which channels the dialog offers and what
 * it says is going. The database has the last word (chat_forward_message
 * refuses another workspace's channel and a channel the caller may not
 * post in); this only keeps the picker to places a forward can land.
 */
import {
  canManageMembers,
  isBankGuest,
  type AccountRole,
} from '@/lib/auth/roles';

import { countsAsChannelAdmin } from './composer-gating';
import { newPostId } from './post-id';
import { normalizeDigits } from './search-view';
import { channelDisplayName, dmOthers } from './view';
import type {
  ChannelWithMembership,
  ChatAttachment,
  ChatMessage,
  ChatPerson,
} from './types';

/** How many channels one forward may go to. */
export const FORWARD_MAX_TARGETS = 5;

export interface ForwardTarget {
  id: string;
  kind: 'team' | 'private' | 'dm';
  /** The channel name, or a DM's other members. */
  name: string;
  /** Posting in a team channel you are not in joins it. */
  joined: boolean;
}

/**
 * Open team channels (posting joins them), and the private channels and
 * DMs the viewer belongs to, whose name contains `query`. Never a deal
 * room (its Team notes are reached from the room), an archived channel
 * or the message's own channel (`exclude`), and never an admins-only
 * channel (`posting` 'admins') the viewer is not a channel admin of: a
 * forward is a top-level post, which chat_assert_post_rules refuses there
 * unless the viewer is its channel admin or a workspace owner/admin (never
 * a bank guest), and never a DM where everyone else is deactivated.
 * Channels by name, then DMs by name.
 */
export function forwardTargets(
  channels: readonly ChannelWithMembership[],
  {
    selfId,
    peopleById,
    query = '',
    unknown,
    exclude,
    accountRole,
  }: {
    selfId: string;
    /** The viewer's role in the active workspace. */
    accountRole: AccountRole | null;
    peopleById: ReadonlyMap<
      string,
      Pick<ChatPerson, 'fullName' | 'deactivated'>
    >;
    query?: string;
    unknown: string;
    exclude?: string | null;
  }
): ForwardTarget[] {
  const q = normalizeDigits(query.trim()).toLowerCase().replace(/^[#@]/, '');
  const rank = (k: ForwardTarget['kind']) => (k === 'dm' ? 1 : 0);
  const workspaceAdmin = !!accountRole && canManageMembers(accountRole);
  const bankGuest = isBankGuest(accountRole);
  const mayPost = (c: ChannelWithMembership) =>
    c.posting !== 'admins' ||
    countsAsChannelAdmin({
      workspaceAdmin,
      role: c.membership?.role,
      bankGuest,
    });
  const everyoneLeft = (c: ChannelWithMembership) => {
    if (c.kind !== 'dm') return false;
    const others = dmOthers(c.dmMemberIds, selfId);
    return (
      others.length > 0 &&
      others.every((id) => peopleById.get(id.toLowerCase())?.deactivated)
    );
  };
  return channels
    .filter(
      (c) =>
        c.id !== exclude &&
        !c.archivedAt &&
        (c.kind === 'team' ||
          ((c.kind === 'private' || c.kind === 'dm') && !!c.membership)) &&
        mayPost(c) &&
        !everyoneLeft(c)
    )
    .map((c) => ({
      id: c.id,
      kind: c.kind as ForwardTarget['kind'],
      name: channelDisplayName(c, selfId, peopleById, unknown),
      joined: !!c.membership,
    }))
    .filter(
      (c) =>
        !!c.name && (!q || normalizeDigits(c.name).toLowerCase().includes(q))
    )
    .sort(
      (a, b) => rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name)
    );
}

/**
 * Ticks or unticks `id`; a tick past FORWARD_MAX_TARGETS is ignored.
 * Order is kept, so the forwards go out in the order picked.
 */
export function toggleForwardTarget(
  picked: readonly string[],
  id: string
): string[] {
  if (picked.includes(id)) return picked.filter((p) => p !== id);
  return picked.length >= FORWARD_MAX_TARGETS ? [...picked] : [...picked, id];
}

/**
 * The id each forward carries (307's p_client_id): one per open dialog
 * and target, so a retry after a lost answer gets the copy already made.
 */
export interface ForwardIds {
  idFor(target: string): string | undefined;
  /** Forwarded: the next one there is a new copy. */
  forget(target: string): void;
}

export function createForwardIds(newId = newPostId): ForwardIds {
  const kept = new Map<string, string>();
  return {
    idFor(target) {
      const known = kept.get(target);
      if (known) return known;
      const id = newId();
      if (id) kept.set(target, id);
      return id;
    },
    forget: (target) => void kept.delete(target),
  };
}

/**
 * One forward per target, in the order picked: each copies the files
 * into its own channel's prefix. The files are read first, whatever the
 * row shows (it may not hold them yet), and nothing is sent when that
 * fails, so a message never goes without its file.
 */
export async function forwardToAll(
  targets: readonly string[],
  ids: ForwardIds,
  calls: {
    files: () => Promise<ChatAttachment[]>;
    send: (
      target: string,
      files: ChatAttachment[],
      clientId: string | undefined
    ) => Promise<unknown>;
  }
): Promise<
  | { read: false }
  | { read: true; done: number; failed: { id: string; error: unknown }[] }
> {
  let files: ChatAttachment[];
  try {
    files = await calls.files();
  } catch {
    return { read: false };
  }
  const failed: { id: string; error: unknown }[] = [];
  for (const id of targets) {
    try {
      await calls.send(id, files, ids.idFor(id));
      ids.forget(id);
    } catch (error) {
      failed.push({ id, error });
    }
  }
  return { read: true, done: targets.length - failed.length, failed };
}

/** What the preview line names: the first line of text, else the files. */
export type ForwardPreview =
  | { kind: 'text'; text: string; files: number }
  | { kind: 'voice'; files: number }
  | { kind: 'files'; name: string; files: number }
  | { kind: 'empty' };

export function forwardPreview(
  m: Pick<ChatMessage, 'attachments'>,
  plainBody: string
): ForwardPreview {
  const files = m.attachments.length;
  const line = plainBody
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (line) return { kind: 'text', text: line, files };
  if (m.attachments.some((a) => a.kind === 'voice'))
    return { kind: 'voice', files };
  if (files) return { kind: 'files', name: m.attachments[0].name, files };
  return { kind: 'empty' };
}
