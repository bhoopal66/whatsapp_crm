// ============================================================
// Call reviewers (migration 198): a per-person "Review all calls"
// permission (profiles.may_review_all_calls) an owner or admin ticks
// for any staff member. A reviewer is treated like an admin for calls
// only: every call of the workspace, the Team recordings with every
// person, play and download, the Call report for everyone. SQL decides
// the rows (RLS on calls / call_live, pbx_call_stats, pbx_call_report,
// call_access_log's guard); these are the API's gates in front of it.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccountContext } from '@/lib/auth/account';
import { canViewAllCalls } from '@/lib/auth/roles';
import { isMissingFunction } from '@/lib/team-activity/db-errors';
import { pbxServiceDb } from '@/lib/pbx/admin';

/**
 * Does the caller see every call of the active workspace? An owner or
 * admin always (no round trip); anyone else when pbx_sees_all_calls()
 * says so, i.e. a live flagged staff member. Never throws: any RPC
 * failure (198 not applied yet included) is the role's answer, so it
 * fails closed to what the caller had before 198.
 */
export async function seesAllCalls(
  ctx: Pick<AccountContext, 'supabase' | 'role'>
): Promise<boolean> {
  if (canViewAllCalls(ctx.role)) return true;
  try {
    const { data, error } = await ctx.supabase.rpc('pbx_sees_all_calls');
    if (error) {
      if (!isMissingFunction(error))
        console.error('[pbx] pbx_sees_all_calls failed:', error.message);
      return canViewAllCalls(ctx.role);
    }
    return data === true;
  } catch (err) {
    console.error(
      '[pbx] pbx_sees_all_calls threw:',
      err instanceof Error ? err.message : err
    );
    return canViewAllCalls(ctx.role);
  }
}

/**
 * The names of a reviewer's customers that RLS kept from them. The call
 * lists read contacts on the caller's client, which shows a reviewer
 * below admin only the contacts they could see anyway; their calls are
 * all visible, so the rest are named here: exactly `contactIds`, in the
 * workspace, on the service role, the name and nothing else (no
 * do-not-contact stamp, no other column). Best-effort: a failed read is
 * no names, never a failed list.
 */
export async function reviewerContactNames(
  accountId: string,
  contactIds: string[],
  db?: SupabaseClient
): Promise<Map<string, string | null>> {
  const names = new Map<string, string | null>();
  if (!contactIds.length) return names;
  const { data, error } = await (db ?? pbxServiceDb())
    .from('contacts')
    .select('id, name')
    .eq('account_id', accountId)
    .in('id', contactIds);
  if (error) {
    console.error('[pbx] reviewer contact names failed:', error.message);
    return names;
  }
  for (const c of (data ?? []) as { id: string; name: string | null }[])
    names.set(c.id, c.name);
  return names;
}
