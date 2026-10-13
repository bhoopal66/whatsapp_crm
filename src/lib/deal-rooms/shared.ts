/**
 * Deal rooms — helpers shared by create, invites and the reconcile
 * (module 014c, migration 088). Server-only: the Meta number comes back
 * with its token decrypted, so never log or return it.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { ACCOUNT_ROLES, hasMinRole } from '@/lib/auth/roles';
import { loadChannels, type WhatsAppChannel } from '@/lib/whatsapp/channels';

/** The columns every deal-room notification needs. */
export interface RoomRef {
  id: string;
  account_id: string;
  channel_id: string;
  created_by: string | null;
  subject: string;
}

/**
 * The account's Meta number — `configId` when given, else the first one
 * — or null when none is connected (or its token will not decrypt).
 * Groups are Cloud-API-only, so a Whapi number never qualifies.
 */
export async function metaChannel(
  db: SupabaseClient,
  accountId: string,
  configId?: string | null
): Promise<WhatsAppChannel | null> {
  const channels = await loadChannels(db, accountId);
  return (
    channels.find(
      (c) => c.provider === 'meta' && (!configId || c.id === configId)
    ) ?? null
  );
}

/** A `deal_room_update` bell notification to the room's creator. */
export async function notifyRoomCreator(
  db: SupabaseClient,
  room: RoomRef,
  title: string,
  meta: Record<string, unknown>
): Promise<void> {
  if (!room.created_by) return;
  const { error } = await db.from('notifications').insert({
    account_id: room.account_id,
    user_id: room.created_by,
    type: 'deal_room_update',
    title,
    body: room.subject,
    meta: { room_id: room.id, channel_id: room.channel_id, ...meta },
  });
  if (error) console.error('[deal-rooms] notification failed:', error.message);
}

/** The workspace roles told when a room fails or is suspended: ops. */
export const ROOM_ALERT_ROLES = ACCOUNT_ROLES.filter((r) =>
  hasMinRole(r, 'admin')
);

/** Each user once, in first-seen order; nulls and blanks dropped. */
export function alertRecipients(
  ...lists: readonly (string | null | undefined)[][]
): string[] {
  return [
    ...new Set(lists.flat().filter((u): u is string => !!u && !!u.trim())),
  ];
}

/**
 * The workspace's live owners and admins (auth user ids). A failed
 * lookup is logged and yields nobody: an alert never stops the caller.
 */
export async function workspaceAdminIds(
  db: SupabaseClient,
  accountId: string
): Promise<string[]> {
  const { data, error } = await db
    .from('profiles')
    .select('user_id')
    .eq('account_id', accountId)
    .in('account_role', ROOM_ALERT_ROLES)
    .is('deactivated_at', null);
  if (error) {
    console.error('[deal-rooms] admin lookup failed:', error.message);
    return [];
  }
  return ((data ?? []) as { user_id: string | null }[])
    .map((p) => p.user_id)
    .filter((u): u is string => !!u);
}

/**
 * A `deal_room_update` bell to the room's creator, `also`, and the
 * workspace's owners and admins, each once: a room that could not be
 * created or was suspended is ops' business too, not only its managers'.
 */
export async function notifyRoomAlert(
  db: SupabaseClient,
  room: RoomRef,
  title: string,
  meta: Record<string, unknown>,
  also: readonly (string | null)[] = []
): Promise<void> {
  const users = alertRecipients(
    [room.created_by],
    [...also],
    await workspaceAdminIds(db, room.account_id)
  );
  if (users.length === 0) return;
  const { error } = await db.from('notifications').insert(
    users.map((user_id) => ({
      account_id: room.account_id,
      user_id,
      type: 'deal_room_update',
      title,
      body: room.subject,
      meta: { room_id: room.id, channel_id: room.channel_id, ...meta },
    }))
  );
  if (error) console.error('[deal-rooms] notification failed:', error.message);
}

/** A database error's own wording, without the functions' prefix. */
export function dbMessage(message: string): string {
  const text = message.replace(/^deal rooms:\s*/i, '').trim();
  return text ? text[0].toUpperCase() + text.slice(1) : 'Request refused';
}
