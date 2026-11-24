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

export type AssignResult =
  /** The row as the database holds it now. */
  | { ok: true; assignedAgentId: string | null }
  | { ok: false; reason: 'error'; error: PostgrestError }
  /** The chat is gone, or the caller may no longer see it. */
  | { ok: false; reason: 'moved' }
  /** Someone else changed the assignee after the screen read it. */
  | { ok: false; reason: 'changed'; assignedAgentId: string | null }
  /** The caller may read the chat but not change it. */
  | { ok: false; reason: 'refused' };

/**
 * Point a conversation at `userId` (or release it with `null`) through
 * the caller's own client, so RLS and the assignment trigger judge it.
 * Never toasts: the caller words the failure.
 *
 * `expected` is the assignee the screen showed: the write only lands on
 * a row that still has it, so a stale screen cannot undo a handover.
 * RLS answers an update it hides with success and no row, so the
 * returned row, not the missing error, is what says it was written.
 */
export async function assignConversation(
  supabase: SupabaseClient,
  conversationId: string,
  expected: string | null,
  userId: string | null
): Promise<AssignResult> {
  const update = supabase
    .from('conversations')
    .update({ assigned_agent_id: userId })
    .eq('id', conversationId);
  const { data: written, error } = await (
    expected === null
      ? update.is('assigned_agent_id', null)
      : update.eq('assigned_agent_id', expected)
  )
    .select('id, assigned_agent_id')
    .maybeSingle();
  if (error) return { ok: false, reason: 'error', error };
  if (written) {
    return { ok: true, assignedAgentId: written.assigned_agent_id ?? null };
  }

  const { data: row, error: readError } = await supabase
    .from('conversations')
    .select('id, assigned_agent_id')
    .eq('id', conversationId)
    .maybeSingle();
  if (readError) return { ok: false, reason: 'error', error: readError };
  if (!row) return { ok: false, reason: 'moved' };
  const assignedAgentId: string | null = row.assigned_agent_id ?? null;
  // Somebody already did exactly this.
  if (assignedAgentId === userId) return { ok: true, assignedAgentId };
  if (assignedAgentId === expected) return { ok: false, reason: 'refused' };
  return { ok: false, reason: 'changed', assignedAgentId };
}

/** What a screen that offers Assign does with each answer. */
export interface AssignScreen {
  /** Show this assignee: it came from the database's row. */
  patch(conversationId: string, assignedAgentId: string | null): void;
  /**
   * Ask the person again, about the assignee just patched in. False when
   * it cannot be asked: another question is open by now (never replaced
   * in place: its answer would go to the wrong chat), or another chat.
   */
  askAgain(assignedAgentId: string | null): boolean;
  /** Say it did not happen (an `InboxRows` catalogue key). */
  fail(key: 'assignFailed' | 'assignMoved' | 'assignChanged'): void;
}

/**
 * The whole of an answered Assign question, for every screen alike: a
 * screen only ever shows an assignee the database returned.
 */
export async function assignFromScreen(
  supabase: SupabaseClient,
  change: {
    conversationId: string;
    expected: string | null;
    userId: string | null;
  },
  screen: AssignScreen
): Promise<void> {
  const result = await assignConversation(
    supabase,
    change.conversationId,
    change.expected,
    change.userId
  );
  if (result.ok) {
    screen.patch(change.conversationId, result.assignedAgentId);
    return;
  }
  switch (result.reason) {
    case 'changed':
      screen.patch(change.conversationId, result.assignedAgentId);
      if (!screen.askAgain(result.assignedAgentId))
        screen.fail('assignChanged');
      return;
    case 'moved':
      screen.fail('assignMoved');
      return;
    case 'error':
      console.error('Failed to update assignment:', result.error);
      screen.fail('assignFailed');
      return;
    case 'refused':
      screen.fail('assignFailed');
      return;
    default: {
      const never: never = result;
      return never;
    }
  }
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
