import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The room is on screen: its message bell (274) is seen. While one is
 * unread further messages ring nobody, so a person who opens the room
 * without going through the bell must clear it here or never hear from
 * the room again. RLS keeps it to the reader's own rows. Best effort: a
 * failure leaves the bell, and the next read of the room tries again.
 */
export async function markRoomBellsRead(
  supabase: SupabaseClient,
  roomId: string
): Promise<void> {
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('type', 'deal_room_message')
    .eq('meta->>room_id', roomId)
    .is('read_at', null);
  if (error) console.warn('[deal-rooms] marking the bell read failed:', error);
}
