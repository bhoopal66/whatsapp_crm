/**
 * The workspace's tags and the teammates this caller may hand a chat to,
 * read on the caller's own client, for the "suggest actions" prompt.
 * Who is offered follows the inbox's Assign menu (`assignableMembers`):
 * an admin anyone active, everyone else themselves plus the people they
 * lead. The database still judges the assignment when it runs.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { assignableMembers } from '@/lib/inbox/assign';
import { isBankGuest, type AccountRole } from '@/lib/auth/roles';

import { buildRefs, type MemberRef, type TagRef } from './actions';

/** The prompt names at most this many teammates and main tags. */
export const CHAT_ASSIST_MAX_MEMBERS = 40;
export const CHAT_ASSIST_MAX_TAGS = 40;

export async function loadSuggestRefs(
  rls: SupabaseClient,
  args: { accountId: string; userId: string; role: AccountRole }
): Promise<{ tags: TagRef[]; members: MemberRef[] }> {
  const [tagRes, profileRes, teamRes] = await Promise.all([
    rls
      .from('chat_tags')
      .select('id, name, parent_id, position')
      .eq('account_id', args.accountId)
      .order('position', { ascending: true }),
    rls
      .from('profiles')
      .select('user_id, full_name, account_role, deactivated_at')
      .eq('account_id', args.accountId)
      .order('full_name'),
    args.role === 'team_leader'
      ? rls
          .from('teams')
          .select('team_members(user_id)')
          .eq('leader_user_id', args.userId)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (tagRes.error || profileRes.error || teamRes.error)
    throw new Error('chat assist: reference data could not be read');

  const leadable = new Set<string>();
  for (const team of (teamRes.data ?? []) as {
    team_members: { user_id: string }[] | null;
  }[])
    for (const m of team.team_members ?? []) leadable.add(m.user_id);

  type P = {
    user_id: string;
    full_name: string | null;
    account_role: AccountRole;
    deactivated_at: string | null;
  };
  const profiles = ((profileRes.data ?? []) as P[]).filter(
    (p) => !isBankGuest(p.account_role) && p.account_role !== 'viewer'
  );
  const offered = assignableMembers({
    accountRole: args.role,
    myUserId: args.userId,
    profiles,
    leadableUserIds: leadable,
  }).slice(0, CHAT_ASSIST_MAX_MEMBERS);

  type T = { id: string; name: string; parent_id: string | null };
  const allTags = (tagRes.data ?? []) as T[];
  const mains = new Set(
    allTags
      .filter((t) => t.parent_id === null)
      .slice(0, CHAT_ASSIST_MAX_TAGS)
      .map((t) => t.id)
  );
  return buildRefs({
    tags: allTags.filter(
      (t) => mains.has(t.id) || (t.parent_id !== null && mains.has(t.parent_id))
    ),
    members: offered.map((p) => ({
      userId: p.user_id,
      // Never the email: only a name goes to the model.
      name: p.full_name?.trim() || '(no name)',
    })),
  });
}
