import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { canAssignToOthers } from '@/lib/auth/conversation-visibility';
import type { AccountRole } from '@/lib/auth/roles';
import type { Profile } from '@/types';

/**
 * The inbox's "assign this chat" write and its "who can I assign to"
 * list, shared by every screen that offers Assign so they all take the
 * same path. The database has the final say (the assignment triggers,
 * migrations 042 and 044); this only performs the write and decides who
 * is worth offering.
 */

export type AssignResult = { ok: true } | { ok: false; error: PostgrestError };

/**
 * Point a conversation at `userId` (or release it with `null`) through
 * the caller's own client, so RLS and the assignment trigger judge it.
 * Never toasts: the caller words the failure.
 */
export async function assignConversation(
  supabase: SupabaseClient,
  conversationId: string,
  userId: string | null
): Promise<AssignResult> {
  const { error } = await supabase
    .from('conversations')
    .update({ assigned_agent_id: userId })
    .eq('id', conversationId);
  return error ? { ok: false, error } : { ok: true };
}

/**
 * Who the Assign menu offers, in the order `profiles` came in.
 *
 * Handing a chat to someone ELSE is an admin power — it decides who can
 * see the chat at all now that visibility follows ownership (migration
 * 042). Anyone else gets themselves, which keeps the "take this one"
 * path working, plus the people they lead (a team leader assigns within
 * their own team, migration 044), so the list never offers someone the
 * save would bounce. Deactivated members (migration 069) can't sign in
 * to work a chat, so they are never offered.
 */
export function assignableMembers<
  P extends Pick<Profile, 'user_id' | 'deactivated_at'>,
>({
  accountRole,
  myUserId,
  profiles,
  leadableUserIds,
}: {
  /** `null` while the role is still loading: offers only self + led. */
  accountRole: AccountRole | null;
  myUserId: string | null | undefined;
  profiles: readonly P[];
  leadableUserIds: ReadonlySet<string>;
}): P[] {
  const offered = canAssignToOthers(accountRole)
    ? profiles
    : profiles.filter(
        (p) => p.user_id === myUserId || leadableUserIds.has(p.user_id)
      );
  return offered.filter((p) => !p.deactivated_at);
}
