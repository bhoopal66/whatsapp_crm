// ============================================================
// The optional block on new chats (migration 068,
// team_activity_start_check): with "Block new chats over the limit"
// on, a person's message that would START a chat on a Whapi number is
// refused once they, or the number, are at the day's limit.
//
// A guard rail, not a reason for a message to fail: every error,
// including a database without migration 068, lets the message
// through. The SQL exempts replies, owners and admins.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { isMissingFunction } from './db-errors';

export interface StartCheck {
  blocked: boolean;
  /** Whose limit: the sender's own, or the number's. */
  reason?: 'user' | 'number';
  started?: number;
  limit?: number;
}

const ALLOW: StartCheck = { blocked: false };
let missingLogged = false;

/**
 * Ask the database whether this person may start a chat in this
 * conversation on this number. `db` must be the sender's own client:
 * the check reads `auth.uid()`.
 */
export async function checkNewChatAllowed(
  db: SupabaseClient,
  conversationId: string,
  channelId: string | null
): Promise<StartCheck> {
  try {
    const { data, error } = await db.rpc('team_activity_start_check', {
      p_conversation_id: conversationId,
      p_channel_id: channelId,
    });
    if (error) {
      if (isMissingFunction(error)) {
        if (!missingLogged) {
          missingLogged = true;
          console.warn(
            '[team-activity] team_activity_start_check is missing — apply migration 068.'
          );
        }
      } else {
        console.error('[team-activity] new-chat check failed:', error.message);
      }
      return ALLOW;
    }
    const o = (data ?? {}) as Record<string, unknown>;
    if (o.blocked !== true) return ALLOW;
    return {
      blocked: true,
      reason: o.reason === 'number' ? 'number' : 'user',
      started: typeof o.started === 'number' ? o.started : undefined,
      limit: typeof o.limit === 'number' ? o.limit : undefined,
    };
  } catch (err) {
    console.error(
      '[team-activity] new-chat check failed:',
      err instanceof Error ? err.message : err
    );
    return ALLOW;
  }
}

/** What the sender is told. It reaches the composer's error toast. */
export function newChatLimitMessage(check: StartCheck): string {
  const limit = check.limit ?? check.started;
  if (check.reason === 'number') {
    return `This WhatsApp number has started ${limit} new chats today, its daily limit. New chats on it can start again tomorrow; replies to existing chats still go out.`;
  }
  return `You have started ${limit} new chats today, your daily limit. Reply to the chats you already have, or ask an admin to raise the limit.`;
}
