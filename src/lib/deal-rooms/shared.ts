/**
 * Deal rooms — helpers shared by create, invites and the reconcile
 * (module 014c, migration 088). Server-only: the Meta number comes back
 * with its token decrypted, so never log or return it.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

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

/** A database error's own wording, without the functions' prefix. */
export function dbMessage(message: string): string {
  const text = message.replace(/^deal rooms:\s*/i, '').trim();
  return text ? text[0].toUpperCase() + text.slice(1) : 'Request refused';
}
